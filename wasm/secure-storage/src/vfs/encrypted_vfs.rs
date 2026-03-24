//! Encrypted VFS backed by bordercrypt block storage.
//!
//! SQLite pages are encrypted/decrypted transparently using
//! `write_session_data` / `read_session_data` from the bordercrypt crate.
//! Persistence to IndexedDB is fire-and-forget on `xSync`, with an
//! explicit `flush_idb()` for durability before lock/close.
//!
//! Lifecycle:
//! 1. `init(domain)` — create state
//! 2. `restore_idb()` — load encrypted blocks from IDB (if any)
//! 3. `provision()` / `allocate(slot, pw)` / `unlock(pw)` — set up keys
//! 4. `register()` + `db::open(VFS_NAME)` — open SQLite
//! 5. `execute(sql, params)` — queries work transparently
//! 6. `lock()` → close SQLite, flush, zeroize

use std::cell::RefCell;
use std::ffi::{CStr, CString};
use std::mem::size_of;
use std::os::raw::{c_char, c_int, c_void};
use std::sync::OnceLock;

use wasm_bindgen::prelude::*;
use sqlite_wasm_rs::{
    sqlite3_file, sqlite3_io_methods, sqlite3_vfs, sqlite3_vfs_find, sqlite3_vfs_register,
    SQLITE_IOERR, SQLITE_IOERR_SHORT_READ, SQLITE_NOTFOUND, SQLITE_OK, SQLITE_OPEN_MAIN_DB,
};

use crate::constants::SESSION_COUNT;
use crate::storage::MemoryStorage;
use crate::types::SessionIndex;
use crate::unlock::UnlockedSession;

/// VFS name used for registration with SQLite.
pub const VFS_NAME: &str = "bordercrypt-enc";

const IDB_NAME: &str = "bordercrypt-storage";
const IDB_VERSION: u32 = 1;
const IDB_STORE: &str = "data";

// ── Inline JS helpers for IndexedDB ──────────────────────────────────

#[wasm_bindgen(inline_js = "
export function encIdbOpen(name, version, storeName) {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(name, version);
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains(storeName)) {
                db.createObjectStore(storeName);
            }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

export function encIdbGet(db, storeName, key) {
    return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readonly');
        const store = tx.objectStore(storeName);
        const req = store.get(key);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

export function encIdbPut(db, storeName, key, value) {
    return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readwrite');
        const store = tx.objectStore(storeName);
        store.put(value, key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}
")]
extern "C" {
    #[wasm_bindgen(catch)]
    async fn encIdbOpen(name: &str, version: u32, store_name: &str) -> Result<JsValue, JsValue>;

    #[wasm_bindgen(catch)]
    async fn encIdbGet(db: &JsValue, store_name: &str, key: &str) -> Result<JsValue, JsValue>;

    #[wasm_bindgen(catch)]
    async fn encIdbPut(
        db: &JsValue,
        store_name: &str,
        key: &str,
        value: &JsValue,
    ) -> Result<JsValue, JsValue>;
}

// ── State ────────────────────────────────────────────────────────────

struct VfsState {
    storage: MemoryStorage,
    domain: String,
    session: Option<UnlockedSession>,
    idb_handle: Option<JsValue>,
}

thread_local! {
    static STATE: RefCell<Option<VfsState>> = RefCell::new(None);
    /// Auxiliary file data (journal/temp — unencrypted, in-memory only).
    static AUX: RefCell<Vec<Vec<u8>>> = RefCell::new(Vec::new());
}

/// File kind stored in the VFS file struct.
const KIND_MAIN: u32 = 1;
const KIND_AUX: u32 = 2;

#[repr(C)]
struct EncFile {
    base: sqlite3_file,
    kind: u32,
    /// For auxiliary files: index into AUX vec.
    aux_id: u32,
}

static IO: OnceLock<sqlite3_io_methods> = OnceLock::new();

fn io_methods() -> &'static sqlite3_io_methods {
    IO.get_or_init(|| sqlite3_io_methods {
        iVersion: 1,
        xClose: Some(x_close),
        xRead: Some(x_read),
        xWrite: Some(x_write),
        xTruncate: Some(x_truncate),
        xSync: Some(x_sync),
        xFileSize: Some(x_file_size),
        xLock: Some(x_lock),
        xUnlock: Some(x_unlock),
        xCheckReservedLock: Some(x_check_reserved_lock),
        xFileControl: Some(x_file_control),
        xSectorSize: Some(x_sector_size),
        xDeviceCharacteristics: Some(x_device_characteristics),
        xShmMap: None,
        xShmLock: None,
        xShmBarrier: None,
        xShmUnmap: None,
        xFetch: None,
        xUnfetch: None,
    })
}

// ── Public: lifecycle ────────────────────────────────────────────────

/// Create the encrypted VFS state with the given domain.
pub fn init(domain: &str) {
    STATE.with(|s| {
        *s.borrow_mut() = Some(VfsState {
            storage: MemoryStorage::new(),
            domain: domain.to_string(),
            session: None,
            idb_handle: None,
        });
    });
}

/// Load encrypted blocks and keypairs from IndexedDB.
pub async fn restore_idb() -> Result<(), JsValue> {
    let db = encIdbOpen(IDB_NAME, IDB_VERSION, IDB_STORE).await?;

    // Read all session data from IDB (async).
    let mut blocks_data = Vec::with_capacity(SESSION_COUNT);
    let mut keypair_data = Vec::with_capacity(SESSION_COUNT);
    for i in 0..SESSION_COUNT {
        blocks_data.push(encIdbGet(&db, IDB_STORE, &format!("blocks_{i}")).await?);
        keypair_data.push(encIdbGet(&db, IDB_STORE, &format!("keypair_{i}")).await?);
    }

    // Import into MemoryStorage (sync).
    STATE.with(|s| {
        let mut s = s.borrow_mut();
        let st = s.as_mut().ok_or_else(|| JsValue::from_str("not initialized"))?;
        for i in 0..SESSION_COUNT {
            let idx = SessionIndex::new(i as u8).unwrap();
            let bv = &blocks_data[i];
            if !bv.is_undefined() && !bv.is_null() {
                let arr = js_sys::Uint8Array::new(bv);
                st.storage
                    .import_blocks(idx, &arr.to_vec())
                    .map_err(|e| JsValue::from_str(&e.to_string()))?;
            }
            let kv = &keypair_data[i];
            if !kv.is_undefined() && !kv.is_null() {
                let arr = js_sys::Uint8Array::new(kv);
                st.storage.import_keypair(idx, &arr.to_vec());
            }
        }
        st.idb_handle = Some(db);
        Ok(())
    })
}

/// Provision all 5 session slots with valid but non-unlockable keypairs.
pub fn provision() -> Result<(), JsValue> {
    STATE.with(|s| {
        let mut s = s.borrow_mut();
        let st = s.as_mut().ok_or_else(|| JsValue::from_str("not initialized"))?;
        crate::provision_storage(&mut st.storage)
            .map_err(|e| JsValue::from_str(&e.to_string()))
    })
}

/// Allocate a session in `slot` with `password`, auto-unlock.
pub fn allocate(slot: u8, password: &[u8]) -> Result<(), JsValue> {
    STATE.with(|s| {
        let mut s = s.borrow_mut();
        let st = s.as_mut().ok_or_else(|| JsValue::from_str("not initialized"))?;
        let idx =
            SessionIndex::new(slot).map_err(|e| JsValue::from_str(&e.to_string()))?;
        let session = crate::allocate_session(&mut st.storage, &st.domain, idx, password)
            .map_err(|e| JsValue::from_str(&e.to_string()))?;
        st.session = Some(session);
        Ok(())
    })
}

/// Unlock a session by trying each slot with `password`.
pub fn unlock(password: &[u8]) -> Result<bool, JsValue> {
    STATE.with(|s| {
        let mut s = s.borrow_mut();
        let st = s.as_mut().ok_or_else(|| JsValue::from_str("not initialized"))?;
        match crate::unlock_session(&st.storage, &st.domain, password) {
            Ok(session) => {
                st.session = Some(session);
                Ok(true)
            }
            Err(crate::BordercryptError::InvalidPassword) => Ok(false),
            Err(e) => Err(JsValue::from_str(&e.to_string())),
        }
    })
}

/// Zeroize session keys. SQLite must be closed before calling this.
pub fn lock() {
    STATE.with(|s| {
        if let Some(st) = s.borrow_mut().as_mut() {
            st.session = None; // Drop → ZeroizeOnDrop
        }
    });
}

/// Run one round of cover traffic (rerandomize a random block).
pub fn cover_tick() -> Result<(), JsValue> {
    STATE.with(|s| {
        let mut s = s.borrow_mut();
        let st = s.as_mut().ok_or_else(|| JsValue::from_str("not initialized"))?;
        crate::cover_traffic_tick(&mut st.storage, &st.domain)
            .map_err(|e| JsValue::from_str(&e.to_string()))
    })
}

/// Register the encrypted VFS with SQLite (non-default).
pub fn register() {
    unsafe {
        let default = sqlite3_vfs_find(std::ptr::null());
        assert!(!default.is_null(), "default VFS not found");

        let mut vfs = *default;
        let name = CString::new(VFS_NAME).unwrap();
        vfs.zName = name.into_raw();
        vfs.szOsFile = size_of::<EncFile>() as c_int;
        vfs.xOpen = Some(x_open);
        vfs.xDelete = Some(x_delete);
        vfs.xAccess = Some(x_access);
        vfs.xFullPathname = Some(x_full_pathname);

        let ptr = Box::into_raw(Box::new(vfs));
        let rc = sqlite3_vfs_register(ptr, 0);
        assert_eq!(rc, SQLITE_OK as c_int, "encrypted VFS registration failed");
    }
}

// ── Public: IDB persistence ──────────────────────────────────────────

/// Flush all encrypted data to IndexedDB (awaitable).
pub async fn flush_idb() -> Result<(), JsValue> {
    // Snapshot synchronously.
    let (db, blocks, keypairs) = STATE.with(|s| {
        let s = s.borrow();
        let st = s.as_ref().ok_or_else(|| JsValue::from_str("not initialized"))?;
        let db = st
            .idb_handle
            .clone()
            .ok_or_else(|| JsValue::from_str("IDB not open"))?;
        let mut bl = Vec::with_capacity(SESSION_COUNT);
        let mut kp = Vec::with_capacity(SESSION_COUNT);
        for i in 0..SESSION_COUNT {
            let idx = SessionIndex::new(i as u8).unwrap();
            bl.push(st.storage.export_blocks(idx));
            kp.push(st.storage.export_keypair(idx).to_vec());
        }
        Ok::<_, JsValue>((db, bl, kp))
    })?;

    // Persist asynchronously.
    for i in 0..SESSION_COUNT {
        let ba = js_sys::Uint8Array::new_with_length(blocks[i].len() as u32);
        ba.copy_from(&blocks[i]);
        encIdbPut(&db, IDB_STORE, &format!("blocks_{i}"), &ba).await?;

        if !keypairs[i].is_empty() {
            let ka = js_sys::Uint8Array::new_with_length(keypairs[i].len() as u32);
            ka.copy_from(&keypairs[i]);
            encIdbPut(&db, IDB_STORE, &format!("keypair_{i}"), &ka).await?;
        }
    }
    Ok(())
}

// ── VFS callbacks ────────────────────────────────────────────────────

unsafe extern "C" fn x_open(
    _vfs: *mut sqlite3_vfs,
    _z_name: *const c_char,
    file: *mut sqlite3_file,
    flags: c_int,
    out_flags: *mut c_int,
) -> c_int {
    unsafe {
        let f = &mut *(file as *mut EncFile);
        f.base.pMethods = io_methods();

        if flags & SQLITE_OPEN_MAIN_DB as c_int != 0 {
            f.kind = KIND_MAIN;
            f.aux_id = 0;
            // Main DB entry is created on-demand by xWrite (no separate file data).
        } else {
            f.kind = KIND_AUX;
            let id = AUX.with(|a| {
                let mut a = a.borrow_mut();
                let id = a.len() as u32;
                a.push(Vec::new());
                id
            });
            f.aux_id = id;
        }

        if !out_flags.is_null() {
            *out_flags = flags;
        }
        SQLITE_OK as c_int
    }
}

unsafe extern "C" fn x_close(file: *mut sqlite3_file) -> c_int {
    // Auxiliary data lives until process end (thread-local); no cleanup needed.
    let _ = file;
    SQLITE_OK as c_int
}

unsafe extern "C" fn x_read(
    file: *mut sqlite3_file,
    buf: *mut c_void,
    amt: c_int,
    offset: i64,
) -> c_int {
    unsafe {
        let f = &*(file as *const EncFile);
        let n = amt as usize;
        let off = offset as u64;
        let dst = std::slice::from_raw_parts_mut(buf as *mut u8, n);

        if f.kind == KIND_MAIN {
            STATE.with(|s| {
                let s = s.borrow();
                let st = match s.as_ref() {
                    Some(st) => st,
                    None => {
                        dst.fill(0);
                        return SQLITE_IOERR_SHORT_READ as c_int;
                    }
                };
                let session = match st.session.as_ref() {
                    Some(session) => session,
                    None => {
                        dst.fill(0);
                        return SQLITE_IOERR_SHORT_READ as c_int;
                    }
                };
                if off + n as u64 > session.total_data_length {
                    // Beyond EOF — short read.
                    let avail = session.total_data_length.saturating_sub(off) as usize;
                    if avail > 0 {
                        match crate::read_session_data(
                            &st.storage,
                            &st.domain,
                            session,
                            off,
                            avail,
                        ) {
                            Ok(data) => dst[..avail].copy_from_slice(&data),
                            Err(_) => {}
                        }
                    }
                    dst[avail..].fill(0);
                    return SQLITE_IOERR_SHORT_READ as c_int;
                }
                match crate::read_session_data(&st.storage, &st.domain, session, off, n) {
                    Ok(data) => {
                        dst.copy_from_slice(&data);
                        SQLITE_OK as c_int
                    }
                    Err(_) => {
                        dst.fill(0);
                        SQLITE_IOERR as c_int
                    }
                }
            })
        } else {
            // Auxiliary file.
            AUX.with(|a| {
                let a = a.borrow();
                let fd = &a[f.aux_id as usize];
                let o = offset as usize;
                if o + n <= fd.len() {
                    dst.copy_from_slice(&fd[o..o + n]);
                    SQLITE_OK as c_int
                } else if o < fd.len() {
                    let avail = fd.len() - o;
                    dst[..avail].copy_from_slice(&fd[o..]);
                    dst[avail..].fill(0);
                    SQLITE_IOERR_SHORT_READ as c_int
                } else {
                    dst.fill(0);
                    SQLITE_IOERR_SHORT_READ as c_int
                }
            })
        }
    }
}

unsafe extern "C" fn x_write(
    file: *mut sqlite3_file,
    buf: *const c_void,
    amt: c_int,
    offset: i64,
) -> c_int {
    unsafe {
        let f = &*(file as *const EncFile);
        let n = amt as usize;
        let src = std::slice::from_raw_parts(buf as *const u8, n);

        if f.kind == KIND_MAIN {
            STATE.with(|s| {
                let mut s = s.borrow_mut();
                let st = match s.as_mut() {
                    Some(st) => st,
                    None => return SQLITE_IOERR as c_int,
                };
                let session = match st.session.as_mut() {
                    Some(session) => session,
                    None => return SQLITE_IOERR as c_int,
                };
                match crate::write_session_data(
                    &mut st.storage,
                    &st.domain,
                    session,
                    offset as u64,
                    src,
                ) {
                    Ok(()) => SQLITE_OK as c_int,
                    Err(_) => SQLITE_IOERR as c_int,
                }
            })
        } else {
            // Auxiliary file.
            AUX.with(|a| {
                let mut a = a.borrow_mut();
                let fd = &mut a[f.aux_id as usize];
                let o = offset as usize;
                if o + n > fd.len() {
                    fd.resize(o + n, 0);
                }
                fd[o..o + n].copy_from_slice(src);
                SQLITE_OK as c_int
            })
        }
    }
}

unsafe extern "C" fn x_truncate(file: *mut sqlite3_file, size: i64) -> c_int {
    let f = unsafe { &*(file as *const EncFile) };
    if f.kind == KIND_MAIN {
        // SQLite truncation on encrypted storage: update total_data_length.
        STATE.with(|s| {
            let mut s = s.borrow_mut();
            if let Some(st) = s.as_mut() {
                if let Some(session) = st.session.as_mut() {
                    session.total_data_length = size as u64;
                }
            }
        });
    } else {
        AUX.with(|a| {
            let mut a = a.borrow_mut();
            a[f.aux_id as usize].truncate(size as usize);
        });
    }
    SQLITE_OK as c_int
}

unsafe extern "C" fn x_sync(_file: *mut sqlite3_file, _flags: c_int) -> c_int {
    // Fire-and-forget: persist encrypted blocks to IDB.
    let snapshot = STATE.with(|s| {
        let s = s.borrow();
        let st = s.as_ref()?;
        let db = st.idb_handle.clone()?;
        let mut bl = Vec::with_capacity(SESSION_COUNT);
        let mut kp = Vec::with_capacity(SESSION_COUNT);
        for i in 0..SESSION_COUNT {
            let idx = SessionIndex::new(i as u8).unwrap();
            bl.push(st.storage.export_blocks(idx));
            kp.push(st.storage.export_keypair(idx).to_vec());
        }
        Some((db, bl, kp))
    });

    if let Some((db, blocks, keypairs)) = snapshot {
        wasm_bindgen_futures::spawn_local(async move {
            for i in 0..SESSION_COUNT {
                let ba = js_sys::Uint8Array::new_with_length(blocks[i].len() as u32);
                ba.copy_from(&blocks[i]);
                let _ = encIdbPut(&db, IDB_STORE, &format!("blocks_{i}"), &ba).await;

                if !keypairs[i].is_empty() {
                    let ka = js_sys::Uint8Array::new_with_length(keypairs[i].len() as u32);
                    ka.copy_from(&keypairs[i]);
                    let _ = encIdbPut(&db, IDB_STORE, &format!("keypair_{i}"), &ka).await;
                }
            }
        });
    }
    SQLITE_OK as c_int
}

unsafe extern "C" fn x_file_size(file: *mut sqlite3_file, size: *mut i64) -> c_int {
    unsafe {
        let f = &*(file as *const EncFile);
        if f.kind == KIND_MAIN {
            *size = STATE.with(|s| {
                let s = s.borrow();
                s.as_ref()
                    .and_then(|st| st.session.as_ref())
                    .map_or(0, |session| session.total_data_length as i64)
            });
        } else {
            *size = AUX.with(|a| a.borrow()[f.aux_id as usize].len() as i64);
        }
        SQLITE_OK as c_int
    }
}

unsafe extern "C" fn x_delete(
    _vfs: *mut sqlite3_vfs,
    _z_name: *const c_char,
    _sync_dir: c_int,
) -> c_int {
    SQLITE_OK as c_int
}

unsafe extern "C" fn x_access(
    _vfs: *mut sqlite3_vfs,
    _z_name: *const c_char,
    _flags: c_int,
    result: *mut c_int,
) -> c_int {
    unsafe {
        // Main DB "exists" if a session is unlocked and has data.
        *result = STATE.with(|s| {
            let s = s.borrow();
            s.as_ref()
                .and_then(|st| st.session.as_ref())
                .map_or(0, |session| {
                    if session.total_data_length > 0 { 1 } else { 0 }
                })
        });
        SQLITE_OK as c_int
    }
}

unsafe extern "C" fn x_full_pathname(
    _vfs: *mut sqlite3_vfs,
    z_name: *const c_char,
    n_out: c_int,
    z_out: *mut c_char,
) -> c_int {
    unsafe {
        if !z_name.is_null() {
            let bytes = CStr::from_ptr(z_name).to_bytes_with_nul();
            let len = bytes.len().min(n_out as usize);
            std::ptr::copy_nonoverlapping(bytes.as_ptr(), z_out as *mut u8, len);
        }
        SQLITE_OK as c_int
    }
}

unsafe extern "C" fn x_lock(_f: *mut sqlite3_file, _l: c_int) -> c_int {
    SQLITE_OK as c_int
}
unsafe extern "C" fn x_unlock(_f: *mut sqlite3_file, _l: c_int) -> c_int {
    SQLITE_OK as c_int
}
unsafe extern "C" fn x_check_reserved_lock(_f: *mut sqlite3_file, r: *mut c_int) -> c_int {
    unsafe { *r = 0 };
    SQLITE_OK as c_int
}
unsafe extern "C" fn x_file_control(_f: *mut sqlite3_file, _o: c_int, _a: *mut c_void) -> c_int {
    SQLITE_NOTFOUND as c_int
}
unsafe extern "C" fn x_sector_size(_f: *mut sqlite3_file) -> c_int {
    4096
}
unsafe extern "C" fn x_device_characteristics(_f: *mut sqlite3_file) -> c_int {
    0
}
