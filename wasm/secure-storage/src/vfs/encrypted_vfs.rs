//! Encrypted VFS backed by secure-storage block encryption.
//!
//! SQLite pages are encrypted/decrypted transparently using
//! `write_session_data` / `read_session_data`.
//!
//! Two storage backends:
//! - **Memory**: RAM only, no persistence (tests).
//! - **OPFS + WAL**: crash-safe OPFS with write-ahead log (production).

use std::cell::RefCell;
use std::ffi::{CStr, CString};
use std::mem::size_of;
use std::os::raw::{c_char, c_int, c_void};
use std::sync::OnceLock;

use wasm_bindgen::prelude::*;
use zeroize::Zeroizing;
use sqlite_wasm_rs::{
    sqlite3_file, sqlite3_io_methods, sqlite3_vfs, sqlite3_vfs_find, sqlite3_vfs_register,
    SQLITE_IOERR, SQLITE_IOERR_SHORT_READ, SQLITE_NOTFOUND, SQLITE_OK, SQLITE_OPEN_MAIN_DB,
};

use crate::constants::{BLOCK_SIZE, SESSION_COUNT};
use crate::storage::{BlockStorage, KeypairStorage, MemoryStorage};
use crate::types::SessionIndex;
use crate::unlock::UnlockedSession;

use super::opfs_wal_storage::OpfsWalStorage;

/// VFS name used for registration with SQLite.
pub const VFS_NAME: &str = "secure-storage-enc";

// ── Backend enum ─────────────────────────────────────────────────────

pub(crate) enum Backend {
    Memory(MemoryStorage),
    OpfsWal(OpfsWalStorage),
}

macro_rules! delegate {
    ($self:ident, $method:ident ( $($arg:expr),* )) => {
        match $self {
            Backend::Memory(s) => s.$method($($arg),*),
            Backend::OpfsWal(s) => s.$method($($arg),*),
        }
    };
}

impl BlockStorage for Backend {
    fn read_block(&self, session: SessionIndex, block: u64) -> crate::Result<Box<[u8; BLOCK_SIZE]>> {
        delegate!(self, read_block(session, block))
    }
    fn write_block(&mut self, session: SessionIndex, block: u64, data: &[u8; BLOCK_SIZE]) -> crate::Result<()> {
        delegate!(self, write_block(session, block, data))
    }
    fn append_block(&mut self, session: SessionIndex, data: &[u8; BLOCK_SIZE]) -> crate::Result<()> {
        delegate!(self, append_block(session, data))
    }
    fn block_count(&self, session: SessionIndex) -> crate::Result<u64> {
        delegate!(self, block_count(session))
    }
    fn fsync(&self, session: SessionIndex) -> crate::Result<()> {
        delegate!(self, fsync(session))
    }
    fn init_blockstream(&mut self, session: SessionIndex) -> crate::Result<()> {
        delegate!(self, init_blockstream(session))
    }
}

impl KeypairStorage for Backend {
    fn read_keypair(&self, session: SessionIndex) -> crate::Result<Zeroizing<Vec<u8>>> {
        delegate!(self, read_keypair(session))
    }
    fn write_keypair(&mut self, session: SessionIndex, data: &[u8]) -> crate::Result<()> {
        delegate!(self, write_keypair(session, data))
    }
}

// ── State ────────────────────────────────────────────────────────────

struct VfsState {
    backend: Backend,
    domain: String,
    session: Option<UnlockedSession>,
}

thread_local! {
    static STATE: RefCell<Option<VfsState>> = RefCell::new(None);
    /// Auxiliary file data (journal/temp — unencrypted, in-memory only).
    static AUX: RefCell<Vec<Vec<u8>>> = RefCell::new(Vec::new());
}

const KIND_MAIN: u32 = 1;
const KIND_AUX: u32 = 2;

#[repr(C)]
struct EncFile {
    base: sqlite3_file,
    kind: u32,
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

/// Create state with in-memory backend (no persistence, tests only).
pub fn init_memory(domain: &str) {
    STATE.with(|s| {
        *s.borrow_mut() = Some(VfsState {
            backend: Backend::Memory(MemoryStorage::new()),
            domain: domain.to_string(),
            session: None,
        });
    });
}

/// Create state with OPFS + WAL backend (crash-safe, Worker only).
pub async fn init_opfs_wal(domain: &str) -> Result<(), JsValue> {
    let storage = OpfsWalStorage::open("secureStorage").await?;
    STATE.with(|s| {
        *s.borrow_mut() = Some(VfsState {
            backend: Backend::OpfsWal(storage),
            domain: domain.to_string(),
            session: None,
        });
    });
    Ok(())
}

/// Provision all 5 session slots.
pub fn provision() -> Result<(), JsValue> {
    STATE.with(|s| {
        let mut s = s.borrow_mut();
        let st = s.as_mut().ok_or_else(|| JsValue::from_str("not initialized"))?;
        crate::provision_storage(&mut st.backend)
            .map_err(|e| JsValue::from_str(&e.to_string()))
    })
}

/// Allocate a session in `slot` with `password`, auto-unlock.
pub fn allocate(slot: u8, password: &[u8]) -> Result<(), JsValue> {
    STATE.with(|s| {
        let mut s = s.borrow_mut();
        let st = s.as_mut().ok_or_else(|| JsValue::from_str("not initialized"))?;
        let idx = SessionIndex::new(slot).map_err(|e| JsValue::from_str(&e.to_string()))?;
        let session = crate::allocate_session(&mut st.backend, &st.domain, idx, password)
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
        match crate::unlock_session(&st.backend, &st.domain, password) {
            Ok(session) => {
                st.session = Some(session);
                Ok(true)
            }
            Err(crate::SecureStorageError::InvalidPassword) => Ok(false),
            Err(e) => Err(JsValue::from_str(&e.to_string())),
        }
    })
}

/// Zeroize session keys. SQLite must be closed before calling this.
pub fn lock() {
    STATE.with(|s| {
        if let Some(st) = s.borrow_mut().as_mut() {
            st.session = None;
        }
    });
}

/// Run one round of cover traffic.
pub fn cover_tick() -> Result<(), JsValue> {
    STATE.with(|s| {
        let mut s = s.borrow_mut();
        let st = s.as_mut().ok_or_else(|| JsValue::from_str("not initialized"))?;
        crate::cover_traffic_tick(&mut st.backend, &st.domain)
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
        // Intentional leak -- VFS name must outlive SQLite
        vfs.zName = name.into_raw();
        vfs.szOsFile = size_of::<EncFile>() as c_int;
        vfs.xOpen = Some(x_open);
        vfs.xDelete = Some(x_delete);
        vfs.xAccess = Some(x_access);
        vfs.xFullPathname = Some(x_full_pathname);

        // Intentional leak -- VFS struct must outlive SQLite
        let ptr = Box::into_raw(Box::new(vfs));
        let rc = sqlite3_vfs_register(ptr, 0);
        assert_eq!(rc, SQLITE_OK as c_int, "encrypted VFS registration failed");
    }
}

// ── Public: persistence ──────────────────────────────────────────────

/// Flush encrypted data to backing store (awaitable).
///
/// - Memory backend: no-op (no persistence).
/// - OpfsWal backend: three-phase WAL commit for all sessions.
pub async fn flush() -> Result<(), JsValue> {
    STATE.with(|s| {
        let s = s.borrow();
        let st = s.as_ref().ok_or_else(|| JsValue::from_str("not initialized"))?;
        match &st.backend {
            Backend::OpfsWal(wal) => wal
                .commit_all()
                .map_err(|e| JsValue::from_str(&e.to_string())),
            Backend::Memory(_) => Ok(()),
        }
    })
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
        } else {
            f.kind = KIND_AUX;
            f.aux_id = AUX.with(|a| {
                let mut a = a.borrow_mut();
                let id = a.len() as u32;
                a.push(Vec::new());
                id
            });
        }

        if !out_flags.is_null() {
            *out_flags = flags;
        }
        SQLITE_OK as c_int
    }
}

unsafe extern "C" fn x_close(file: *mut sqlite3_file) -> c_int {
    unsafe {
        let f = &*(file as *const EncFile);
        if f.kind == KIND_AUX {
            AUX.with(|a| {
                let mut a = a.borrow_mut();
                if let Some(v) = a.get_mut(f.aux_id as usize) {
                    // Release memory; the slot stays to preserve aux_id indices.
                    *v = Vec::new();
                }
            });
        }
    }
    SQLITE_OK as c_int
}

unsafe extern "C" fn x_read(
    file: *mut sqlite3_file,
    buf: *mut c_void,
    amt: c_int,
    offset: i64,
) -> c_int {
    unsafe {
        debug_assert!(amt >= 0, "x_read: negative amt");
        debug_assert!(offset >= 0, "x_read: negative offset");
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
                    let avail = session.total_data_length.saturating_sub(off) as usize;
                    if avail > 0 {
                        if let Ok(data) =
                            crate::read_session_data(&st.backend, &st.domain, session, off, avail)
                        {
                            dst[..avail].copy_from_slice(&data);
                        }
                    }
                    dst[avail..].fill(0);
                    return SQLITE_IOERR_SHORT_READ as c_int;
                }
                match crate::read_session_data(&st.backend, &st.domain, session, off, n) {
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
        debug_assert!(amt >= 0, "x_write: negative amt");
        debug_assert!(offset >= 0, "x_write: negative offset");
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
                    &mut st.backend,
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
    debug_assert!(size >= 0, "x_truncate: negative size");
    let f = unsafe { &*(file as *const EncFile) };
    if f.kind == KIND_MAIN {
        STATE.with(|s| {
            let mut s = s.borrow_mut();
            if let Some(st) = s.as_mut() {
                if let Some(session) = st.session.as_mut() {
                    session.total_data_length = size as u64;
                }
            }
        });
    } else {
        AUX.with(|a| a.borrow_mut()[f.aux_id as usize].truncate(size as usize));
    }
    SQLITE_OK as c_int
}

unsafe extern "C" fn x_sync(_file: *mut sqlite3_file, _flags: c_int) -> c_int {
    // For OpfsWal: three-phase WAL commit on the active session.
    // For Memory: no-op (no persistence).
    STATE.with(|s| {
        let s = s.borrow();
        let st = match s.as_ref() {
            Some(st) => st,
            None => return SQLITE_OK as c_int,
        };
        if let Backend::OpfsWal(wal) = &st.backend {
            if let Some(session) = &st.session {
                if wal.commit(session.session_index).is_err() {
                    return SQLITE_IOERR as c_int;
                }
            }
        }
        SQLITE_OK as c_int
    })
}

unsafe extern "C" fn x_file_size(file: *mut sqlite3_file, size: *mut i64) -> c_int {
    unsafe {
        let f = &*(file as *const EncFile);
        if f.kind == KIND_MAIN {
            *size = STATE.with(|s| {
                s.borrow()
                    .as_ref()
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
        // Always report "file does not exist". This prevents SQLite from
        // attempting hot-journal or WAL recovery on auxiliary files that
        // our VFS doesn't actually persist. The main database is opened
        // via xOpen + xFileSize (which returns the correct size), so
        // returning 0 here does not prevent opening existing databases.
        *result = 0;
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
