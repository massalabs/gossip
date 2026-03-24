//! IndexedDB-backed VFS for web browsers.
//!
//! All file data lives in thread-local RAM for synchronous VFS access.
//! IndexedDB is the persistent backing store, flushed asynchronously.
//!
//! Boot: `restore()` loads IDB → RAM (async, once).
//! Runtime: `xRead`/`xWrite` operate on RAM (sync).
//! Sync: `xSync` spawns fire-and-forget IDB persist via `spawn_local`.

use std::cell::{Cell, RefCell};
use std::collections::{HashMap, HashSet};
use std::ffi::{CStr, CString};
use std::mem::size_of;
use std::os::raw::{c_char, c_int, c_void};
use std::sync::OnceLock;

use wasm_bindgen::prelude::*;
use sqlite_wasm_rs::{
    sqlite3_file, sqlite3_io_methods, sqlite3_vfs, sqlite3_vfs_find, sqlite3_vfs_register,
    SQLITE_IOERR_SHORT_READ, SQLITE_NOTFOUND, SQLITE_OK, SQLITE_OPEN_CREATE,
};

const IDB_NAME: &str = "bordercrypt-vfs";
const IDB_VERSION: u32 = 1;
const IDB_STORE: &str = "files";

/// VFS name used for registration with SQLite.
pub const VFS_NAME: &str = "bordercrypt-idb";

// ── Inline JS helpers for IndexedDB ──────────────────────────────────

#[wasm_bindgen(inline_js = "
export function idbOpen(name, version, storeName) {
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

export function idbGetAllKeys(db, storeName) {
    return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readonly');
        const store = tx.objectStore(storeName);
        const req = store.getAllKeys();
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

export function idbGet(db, storeName, key) {
    return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readonly');
        const store = tx.objectStore(storeName);
        const req = store.get(key);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

export function idbPut(db, storeName, key, value) {
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
    async fn idbOpen(name: &str, version: u32, store_name: &str) -> Result<JsValue, JsValue>;

    #[wasm_bindgen(catch)]
    async fn idbGetAllKeys(db: &JsValue, store_name: &str) -> Result<JsValue, JsValue>;

    #[wasm_bindgen(catch)]
    async fn idbGet(db: &JsValue, store_name: &str, key: &str) -> Result<JsValue, JsValue>;

    #[wasm_bindgen(catch)]
    async fn idbPut(
        db: &JsValue,
        store_name: &str,
        key: &str,
        value: &JsValue,
    ) -> Result<JsValue, JsValue>;
}

// ── Thread-local state ───────────────────────────────────────────────

thread_local! {
    static NEXT_ID: Cell<u32> = const { Cell::new(0) };
    static NAMES: RefCell<HashMap<u32, String>> = RefCell::new(HashMap::new());
    static DATA: RefCell<HashMap<String, Vec<u8>>> = RefCell::new(HashMap::new());
    static DIRTY: RefCell<HashSet<String>> = RefCell::new(HashSet::new());
    /// Cached IDB database handle (avoids re-opening on every persist).
    static IDB_HANDLE: RefCell<Option<JsValue>> = RefCell::new(None);
}

#[repr(C)]
struct IdbFile {
    base: sqlite3_file,
    id: u32,
}

fn file_name(file: *const IdbFile) -> String {
    let id = unsafe { (*file).id };
    NAMES.with(|n| n.borrow().get(&id).cloned().unwrap_or_default())
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

// ── Public API ───────────────────────────────────────────────────────

/// Load all stored file data from IndexedDB into RAM.
///
/// Must be called (and awaited) before [`register`].
pub async fn restore() -> Result<(), JsValue> {
    let db = idbOpen(IDB_NAME, IDB_VERSION, IDB_STORE).await?;

    let keys_val = idbGetAllKeys(&db, IDB_STORE).await?;
    let keys = js_sys::Array::from(&keys_val);
    for i in 0..keys.length() {
        if let Some(key) = keys.get(i).as_string() {
            let val = idbGet(&db, IDB_STORE, &key).await?;
            if !val.is_undefined() && !val.is_null() {
                let arr = js_sys::Uint8Array::new(&val);
                DATA.with(|d| {
                    d.borrow_mut().insert(key, arr.to_vec());
                });
            }
        }
    }

    IDB_HANDLE.with(|cell| *cell.borrow_mut() = Some(db));
    Ok(())
}

/// Register the IDB-backed VFS with SQLite (non-default).
pub fn register() {
    unsafe {
        let default = sqlite3_vfs_find(std::ptr::null());
        assert!(!default.is_null(), "default VFS not found");

        let mut vfs = *default;
        let name = CString::new(VFS_NAME).unwrap();
        vfs.zName = name.into_raw();
        vfs.szOsFile = size_of::<IdbFile>() as c_int;
        vfs.xOpen = Some(x_open);
        vfs.xDelete = Some(x_delete);
        vfs.xAccess = Some(x_access);
        vfs.xFullPathname = Some(x_full_pathname);

        let ptr = Box::into_raw(Box::new(vfs));
        let rc = sqlite3_vfs_register(ptr, 0);
        assert_eq!(rc, SQLITE_OK as c_int, "IDB VFS registration failed");
    }
}

/// Flush all dirty files to IndexedDB (awaitable).
///
/// Called explicitly before lock / close. Unlike `xSync` (fire-and-forget),
/// this blocks until the IDB writes complete.
pub async fn flush() -> Result<(), JsValue> {
    let snapshot = take_dirty_snapshot();
    persist_snapshot(snapshot).await
}

// ── Internal: IDB persistence ────────────────────────────────────────

/// Drain the dirty set and return (name, data) pairs to persist.
fn take_dirty_snapshot() -> Vec<(String, Vec<u8>)> {
    DIRTY.with(|dirty| {
        let names: Vec<String> = dirty.borrow_mut().drain().collect();
        DATA.with(|data| {
            let data = data.borrow();
            names
                .into_iter()
                .filter_map(|name| data.get(&name).map(|bytes| (name, bytes.clone())))
                .collect()
        })
    })
}

async fn persist_snapshot(files: Vec<(String, Vec<u8>)>) -> Result<(), JsValue> {
    if files.is_empty() {
        return Ok(());
    }
    let db = IDB_HANDLE
        .with(|cell| cell.borrow().clone())
        .ok_or_else(|| JsValue::from_str("IDB not open"))?;

    for (name, bytes) in files {
        let arr = js_sys::Uint8Array::new_with_length(bytes.len() as u32);
        arr.copy_from(&bytes);
        idbPut(&db, IDB_STORE, &name, &arr).await?;
    }
    Ok(())
}

// ── VFS-level callbacks ──────────────────────────────────────────────

unsafe extern "C" fn x_open(
    _vfs: *mut sqlite3_vfs,
    z_name: *const c_char,
    file: *mut sqlite3_file,
    flags: c_int,
    out_flags: *mut c_int,
) -> c_int {
    unsafe {
        let name = if z_name.is_null() {
            format!("__anon_{}", NEXT_ID.with(|id| id.get()))
        } else {
            CStr::from_ptr(z_name).to_string_lossy().into_owned()
        };

        let id = NEXT_ID.with(|next| {
            let v = next.get();
            next.set(v + 1);
            v
        });
        NAMES.with(|n| n.borrow_mut().insert(id, name.clone()));

        if flags & SQLITE_OPEN_CREATE as c_int != 0 {
            DATA.with(|d| {
                d.borrow_mut().entry(name).or_default();
            });
        }

        let f = &mut *(file as *mut IdbFile);
        f.base.pMethods = io_methods();
        f.id = id;

        if !out_flags.is_null() {
            *out_flags = flags;
        }
        SQLITE_OK as c_int
    }
}

unsafe extern "C" fn x_delete(
    _vfs: *mut sqlite3_vfs,
    z_name: *const c_char,
    _sync_dir: c_int,
) -> c_int {
    unsafe {
        if !z_name.is_null() {
            let name = CStr::from_ptr(z_name).to_string_lossy().into_owned();
            DATA.with(|d| d.borrow_mut().remove(&name));
            DIRTY.with(|d| d.borrow_mut().remove(&name));
        }
        SQLITE_OK as c_int
    }
}

unsafe extern "C" fn x_access(
    _vfs: *mut sqlite3_vfs,
    z_name: *const c_char,
    _flags: c_int,
    result: *mut c_int,
) -> c_int {
    unsafe {
        if z_name.is_null() {
            *result = 0;
        } else {
            let name = CStr::from_ptr(z_name).to_string_lossy().into_owned();
            *result = DATA.with(|d| if d.borrow().contains_key(&name) { 1 } else { 0 });
        }
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

// ── File-level callbacks ─────────────────────────────────────────────

unsafe extern "C" fn x_close(file: *mut sqlite3_file) -> c_int {
    unsafe {
        let id = (*(file as *const IdbFile)).id;
        NAMES.with(|n| n.borrow_mut().remove(&id));
        SQLITE_OK as c_int
    }
}

unsafe extern "C" fn x_read(
    file: *mut sqlite3_file,
    buf: *mut c_void,
    amt: c_int,
    offset: i64,
) -> c_int {
    unsafe {
        let name = file_name(file as *const IdbFile);
        let off = offset as usize;
        let n = amt as usize;
        let dst = std::slice::from_raw_parts_mut(buf as *mut u8, n);

        DATA.with(|d| {
            let data = d.borrow();
            match data.get(&name) {
                Some(fd) if off + n <= fd.len() => {
                    dst.copy_from_slice(&fd[off..off + n]);
                    SQLITE_OK as c_int
                }
                Some(fd) if off < fd.len() => {
                    let avail = fd.len() - off;
                    dst[..avail].copy_from_slice(&fd[off..]);
                    dst[avail..].fill(0);
                    SQLITE_IOERR_SHORT_READ as c_int
                }
                _ => {
                    dst.fill(0);
                    SQLITE_IOERR_SHORT_READ as c_int
                }
            }
        })
    }
}

unsafe extern "C" fn x_write(
    file: *mut sqlite3_file,
    buf: *const c_void,
    amt: c_int,
    offset: i64,
) -> c_int {
    unsafe {
        let name = file_name(file as *const IdbFile);
        let off = offset as usize;
        let n = amt as usize;
        let src = std::slice::from_raw_parts(buf as *const u8, n);

        DATA.with(|d| {
            let mut data = d.borrow_mut();
            let fd = data.entry(name.clone()).or_default();
            if off + n > fd.len() {
                fd.resize(off + n, 0);
            }
            fd[off..off + n].copy_from_slice(src);
        });

        // Mark file as dirty for next persist.
        DIRTY.with(|d| d.borrow_mut().insert(name));

        SQLITE_OK as c_int
    }
}

unsafe extern "C" fn x_truncate(file: *mut sqlite3_file, size: i64) -> c_int {
    let name = file_name(file as *const IdbFile);
    DATA.with(|d| {
        if let Some(v) = d.borrow_mut().get_mut(&name) {
            v.truncate(size as usize);
        }
    });
    DIRTY.with(|d| d.borrow_mut().insert(name));
    SQLITE_OK as c_int
}

unsafe extern "C" fn x_sync(_file: *mut sqlite3_file, _flags: c_int) -> c_int {
    // Fire-and-forget: snapshot dirty files, persist asynchronously.
    let snapshot = take_dirty_snapshot();
    if !snapshot.is_empty() {
        wasm_bindgen_futures::spawn_local(async move {
            if let Err(e) = persist_snapshot(snapshot).await {
                web_sys::console::error_1(&e);
            }
        });
    }
    SQLITE_OK as c_int
}

unsafe extern "C" fn x_file_size(file: *mut sqlite3_file, size: *mut i64) -> c_int {
    let name = file_name(file as *const IdbFile);
    unsafe {
        *size = DATA.with(|d| d.borrow().get(&name).map_or(0, |v| v.len() as i64));
    }
    SQLITE_OK as c_int
}

unsafe extern "C" fn x_lock(_file: *mut sqlite3_file, _lock: c_int) -> c_int {
    SQLITE_OK as c_int
}

unsafe extern "C" fn x_unlock(_file: *mut sqlite3_file, _lock: c_int) -> c_int {
    SQLITE_OK as c_int
}

unsafe extern "C" fn x_check_reserved_lock(
    _file: *mut sqlite3_file,
    result: *mut c_int,
) -> c_int {
    unsafe { *result = 0 };
    SQLITE_OK as c_int
}

unsafe extern "C" fn x_file_control(
    _file: *mut sqlite3_file,
    _op: c_int,
    _arg: *mut c_void,
) -> c_int {
    SQLITE_NOTFOUND as c_int
}

unsafe extern "C" fn x_sector_size(_file: *mut sqlite3_file) -> c_int {
    4096
}

unsafe extern "C" fn x_device_characteristics(_file: *mut sqlite3_file) -> c_int {
    0
}
