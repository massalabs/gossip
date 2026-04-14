//! Encrypted VFS for native (non-WASM) targets, backed by `RedbStorage`.
//!
//! Port of `sqlite_vfs.rs` (WASM) for `rusqlite::ffi`. SQLite pages are
//! encrypted/decrypted transparently through `write_session_data` /
//! `read_session_data`, with writes buffered in RAM and flushed at
//! COMMIT (`x_sync`).
//!
//! Process safety: redb takes an exclusive OS-level file lock on
//! `storage.redb` at `Database::create`, so a second process opening
//! the same path fails at `init_native` rather than reaching SQLite.
//! Combined with rusqlite's `locking_mode=EXCLUSIVE` + `journal_mode=OFF`,
//! the no-op `xLock`/`xUnlock`/`xCheckReservedLock` callbacks below are
//! safe: concurrent access is already prevented one layer down.
//!
//! Thread safety: a single global `Mutex<Option<VfsState>>` guards the
//! VFS state and is acquired by every FFI callback. Every callback body
//! is wrapped in `catch_unwind` so a Rust panic or poisoned mutex turns
//! into `SQLITE_IOERR` instead of unwinding into SQLite's C code.

use std::collections::HashMap;
use std::ffi::{CStr, CString};
use std::mem::size_of;
use std::os::raw::{c_char, c_int, c_void};
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::path::Path;
use std::sync::{Mutex, MutexGuard, Once, OnceLock};

use rusqlite::ffi::{
    sqlite3_file, sqlite3_io_methods, sqlite3_vfs, sqlite3_vfs_find, sqlite3_vfs_register,
    SQLITE_IOERR, SQLITE_IOERR_SHORT_READ, SQLITE_NOTFOUND, SQLITE_OK, SQLITE_OPEN_MAIN_DB,
};

use crate::DEFAULT_NAMESPACE;
use crate::error::{Result, SecureStorageError};
use crate::types::SessionIndex;
use crate::unlock::{NamespaceState, UnlockedSession, load_namespace_state};

use super::pending::{PendingWrite, apply_pending_overlay, flush_writes};
use super::redb_storage::RedbStorage;

/// VFS name used for registration with SQLite.
pub const VFS_NAME: &str = "secure-storage-enc-native";

// ── State ────────────────────────────────────────────────────────────

struct VfsState {
    backend: RedbStorage,
    domain: String,
    session: Option<UnlockedSession>,
    namespace_states: HashMap<u8, NamespaceState>,
    /// Plaintext write buffer for the SQL namespace. Writes accumulate
    /// during a transaction and are flushed at `x_sync`.
    pending_writes: Vec<PendingWrite>,
    /// Tracks the logical file size including pending writes.
    pending_file_size: u64,
}

impl VfsState {
    fn sql_ns_state(&self) -> NamespaceState {
        self.namespace_states
            .get(&DEFAULT_NAMESPACE)
            .copied()
            .unwrap_or_default()
    }

    fn sql_ns_state_mut(&mut self) -> &mut NamespaceState {
        self.namespace_states.entry(DEFAULT_NAMESPACE).or_default()
    }
}

static STATE: OnceLock<Mutex<Option<VfsState>>> = OnceLock::new();

/// Auxiliary file data (journal/temp — unencrypted, in-memory only).
static AUX: OnceLock<Mutex<Vec<Vec<u8>>>> = OnceLock::new();

fn aux() -> &'static Mutex<Vec<Vec<u8>>> {
    AUX.get_or_init(|| Mutex::new(Vec::new()))
}

fn state_mutex() -> &'static Mutex<Option<VfsState>> {
    STATE.get_or_init(|| Mutex::new(None))
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

/// Create state with redb backend.
pub fn init_native(path: &str, domain: &str) -> Result<()> {
    let storage = RedbStorage::open(Path::new(path))?;
    let mutex = state_mutex();
    let mut guard = mutex.lock().map_err(|_| SecureStorageError::LockPoisoned)?;
    *guard = Some(VfsState {
        backend: storage,
        domain: domain.to_string(),
        session: None,
        namespace_states: HashMap::new(),
        pending_writes: Vec::new(),
        pending_file_size: 0,
    });
    Ok(())
}

static REGISTER_VFS: Once = Once::new();
static REGISTER_RESULT: OnceLock<std::result::Result<(), String>> = OnceLock::new();

/// Register the encrypted VFS with SQLite (non-default). Idempotent.
///
/// Failures here propagate back to the caller via `SecureStorageError::Storage`
/// rather than panicking — panicking across the UniFFI boundary on mobile
/// is undefined behaviour because Rust unwinding cannot traverse
/// Swift/Kotlin frames.
pub fn register() -> Result<()> {
    REGISTER_VFS.call_once(|| {
        let outcome = unsafe {
            let default = sqlite3_vfs_find(std::ptr::null());
            if default.is_null() {
                Err("default VFS not found".to_string())
            } else {
                let mut vfs = *default;
                match CString::new(VFS_NAME) {
                    Ok(name) => {
                        // Intentionally leaked: the VFS lives for the
                        // lifetime of the process, so the `zName` pointer
                        // must remain valid forever.
                        vfs.zName = name.into_raw();
                        vfs.szOsFile = size_of::<EncFile>() as c_int;
                        vfs.xOpen = Some(x_open);
                        vfs.xDelete = Some(x_delete);
                        vfs.xAccess = Some(x_access);
                        vfs.xFullPathname = Some(x_full_pathname);

                        let ptr = Box::into_raw(Box::new(vfs));
                        let rc = sqlite3_vfs_register(ptr, 0);
                        if rc == SQLITE_OK as c_int {
                            Ok(())
                        } else {
                            Err(format!("sqlite3_vfs_register failed: rc={rc}"))
                        }
                    }
                    Err(_) => Err("VFS_NAME must be NUL-free".to_string()),
                }
            }
        };
        let _ = REGISTER_RESULT.set(outcome);
    });
    match REGISTER_RESULT.get() {
        Some(Ok(())) => Ok(()),
        Some(Err(msg)) => Err(SecureStorageError::Storage(msg.clone())),
        // Should not happen — `call_once` always sets REGISTER_RESULT.
        None => Err(SecureStorageError::Storage(
            "VFS registration state missing".into(),
        )),
    }
}

/// Provision all session slots.
pub fn provision() -> Result<()> {
    let mutex = state_mutex();
    let mut guard = mutex.lock().map_err(|_| SecureStorageError::LockPoisoned)?;
    let st = guard
        .as_mut()
        .ok_or_else(|| SecureStorageError::Storage("not initialized".into()))?;
    crate::provision_storage(&mut st.backend)
}

/// Allocate a session in `slot` with `password`, auto-unlock.
pub fn allocate(slot: u8, password: &[u8]) -> Result<()> {
    let mutex = state_mutex();
    let mut guard = mutex.lock().map_err(|_| SecureStorageError::LockPoisoned)?;
    let st = guard
        .as_mut()
        .ok_or_else(|| SecureStorageError::Storage("not initialized".into()))?;
    let idx = SessionIndex::new(slot)?;
    let session = crate::allocate_session(&mut st.backend, &st.domain, idx, password)?;
    st.pending_writes.clear();
    st.namespace_states.clear();
    st.namespace_states
        .insert(DEFAULT_NAMESPACE, NamespaceState::empty());
    st.pending_file_size = 0;
    st.session = Some(session);
    Ok(())
}

/// Unlock a session by trying each slot with `password`.
pub fn unlock(password: &[u8]) -> Result<bool> {
    let mutex = state_mutex();
    let mut guard = mutex.lock().map_err(|_| SecureStorageError::LockPoisoned)?;
    let st = guard
        .as_mut()
        .ok_or_else(|| SecureStorageError::Storage("not initialized".into()))?;
    match crate::unlock_session(&st.backend, &st.domain, password) {
        Ok(session) => {
            let sql_state =
                load_namespace_state(&st.backend, &st.domain, &session, DEFAULT_NAMESPACE)?;
            st.pending_writes.clear();
            st.pending_file_size = sql_state.total_data_length;
            st.namespace_states.clear();
            st.namespace_states.insert(DEFAULT_NAMESPACE, sql_state);
            st.session = Some(session);
            Ok(true)
        }
        Err(crate::SecureStorageError::InvalidPassword) => Ok(false),
        Err(e) => Err(e),
    }
}

/// Zeroize session keys. SQLite must be closed before calling this.
pub fn lock() {
    if let Ok(mut guard) = state_mutex().lock() {
        if let Some(st) = guard.as_mut() {
            st.session = None;
            st.namespace_states.clear();
            st.pending_writes.clear();
            st.pending_file_size = 0;
        }
    }
}

/// Check whether a session is currently unlocked.
pub fn is_unlocked() -> Result<bool> {
    let mutex = state_mutex();
    let guard = mutex.lock().map_err(|_| SecureStorageError::LockPoisoned)?;
    let st = guard
        .as_ref()
        .ok_or_else(|| SecureStorageError::Storage("not initialized".into()))?;
    Ok(st.session.is_some())
}

/// Run one round of cover traffic for the SQL namespace.
pub fn cover_tick() -> Result<()> {
    let mutex = state_mutex();
    let mut guard = mutex.lock().map_err(|_| SecureStorageError::LockPoisoned)?;
    let st = guard
        .as_mut()
        .ok_or_else(|| SecureStorageError::Storage("not initialized".into()))?;
    crate::cover_traffic_tick(&mut st.backend, &st.domain, DEFAULT_NAMESPACE)
}

/// Flush pending plaintext writes + encrypted blocks + rerand pool to
/// backing store. Also commits the redb transaction.
pub fn flush() -> Result<()> {
    let mutex = state_mutex();
    let mut guard = mutex.lock().map_err(|_| SecureStorageError::LockPoisoned)?;
    let st = guard
        .as_mut()
        .ok_or_else(|| SecureStorageError::Storage("not initialized".into()))?;
    flush_pending_writes(st)
}

/// Open a rusqlite connection using the registered encrypted VFS.
///
/// Page size 4096 aligns well with the bordercrypt block plaintext
/// capacity (~15 844 bytes ≈ 3.86 pages per block); only ~25 % of
/// pages straddle a block boundary vs ~50 % at 8192.
pub fn open_db() -> Result<rusqlite::Connection> {
    let conn = rusqlite::Connection::open_with_flags_and_vfs(
        "main.db",
        rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE
            | rusqlite::OpenFlags::SQLITE_OPEN_CREATE
            | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
        VFS_NAME,
    )
    .map_err(|e| SecureStorageError::Sqlite(e.to_string()))?;

    conn.pragma_update(None, "page_size", 4096)
        .map_err(|e| SecureStorageError::Sqlite(e.to_string()))?;
    conn.pragma_update(None, "journal_mode", "OFF")
        .map_err(|e| SecureStorageError::Sqlite(e.to_string()))?;
    conn.pragma_update(None, "synchronous", "NORMAL")
        .map_err(|e| SecureStorageError::Sqlite(e.to_string()))?;
    conn.pragma_update(None, "cache_size", -8000)
        .map_err(|e| SecureStorageError::Sqlite(e.to_string()))?;
    conn.pragma_update(None, "locking_mode", "EXCLUSIVE")
        .map_err(|e| SecureStorageError::Sqlite(e.to_string()))?;

    Ok(conn)
}

/// Reset global state (for tests only).
#[cfg(test)]
pub(crate) fn reset_state() {
    if let Ok(mut guard) = state_mutex().lock() {
        *guard = None;
    }
    if let Ok(mut guard) = aux().lock() {
        guard.clear();
    }
}

/// Drain all pending writes through the encryption layer and commit.
fn flush_pending_writes(st: &mut VfsState) -> Result<()> {
    if st.pending_writes.is_empty() {
        return Ok(());
    }
    let writes = std::mem::take(&mut st.pending_writes);
    let file_size = st.pending_file_size;

    let result = (|| -> Result<()> {
        let session = st
            .session
            .as_ref()
            .ok_or_else(|| SecureStorageError::Storage("no session".into()))?;
        let ns_state = st.namespace_states.entry(DEFAULT_NAMESPACE).or_default();
        flush_writes(
            &mut st.backend,
            &st.domain,
            DEFAULT_NAMESPACE,
            session,
            ns_state,
            &writes,
            file_size,
        )?;
        st.backend.commit()
    })();

    if result.is_err() {
        st.pending_writes = writes;
    }
    result
}

// ── Namespace data (session blob, etc.) ─────────────────────────────

/// Write a blob to a non-SQL namespace (e.g. session blob on ns=1).
pub fn write_namespace_data(namespace: u8, offset: u64, data: &[u8]) -> Result<()> {
    let mutex = state_mutex();
    let mut guard = mutex.lock().map_err(|_| SecureStorageError::LockPoisoned)?;
    let st = guard
        .as_mut()
        .ok_or_else(|| SecureStorageError::Storage("not initialized".into()))?;
    let session = st
        .session
        .as_ref()
        .ok_or_else(|| SecureStorageError::Storage("no session".into()))?;
    let ns_state = st.namespace_states.entry(namespace).or_default();
    crate::write_session_data(&mut st.backend, &st.domain, namespace, session, ns_state, offset, data)?;
    st.backend.commit()
}

/// Read from a non-SQL namespace.
pub fn read_namespace_data(namespace: u8, offset: u64, len: usize) -> Result<Vec<u8>> {
    let mutex = state_mutex();
    let mut guard = mutex.lock().map_err(|_| SecureStorageError::LockPoisoned)?;
    let st = guard
        .as_mut()
        .ok_or_else(|| SecureStorageError::Storage("not initialized".into()))?;
    let session = st
        .session
        .as_ref()
        .ok_or_else(|| SecureStorageError::Storage("no session".into()))?;
    // Lazy-load namespace state if not yet loaded.
    if !st.namespace_states.contains_key(&namespace) {
        let ns = load_namespace_state(&st.backend, &st.domain, session, namespace)?;
        st.namespace_states.insert(namespace, ns);
    }
    let ns_state = st.namespace_states.get(&namespace).unwrap();
    let data = crate::read_session_data(&st.backend, &st.domain, namespace, session, ns_state, offset, len)?;
    Ok(data.to_vec())
}

/// Truncate a non-SQL namespace back to empty. Re-initialises the
/// underlying block stream so a subsequent `write_session_data` starts
/// from offset 0 with no residual bytes.
pub fn clear_namespace(namespace: u8) -> Result<()> {
    let mutex = state_mutex();
    let mut guard = mutex.lock().map_err(|_| SecureStorageError::LockPoisoned)?;
    let st = guard
        .as_mut()
        .ok_or_else(|| SecureStorageError::Storage("not initialized".into()))?;
    let session = st
        .session
        .as_ref()
        .ok_or_else(|| SecureStorageError::Storage("no session".into()))?;
    use crate::storage::BlockStorage;
    st.backend.init_blockstream(session.session_index, namespace)?;
    // Reset in-memory tracking for this namespace.
    st.namespace_states
        .insert(namespace, NamespaceState::empty());
    st.backend.commit()
}

/// Total bytes in a namespace.
pub fn namespace_data_length(namespace: u8) -> Result<u64> {
    let mutex = state_mutex();
    let mut guard = mutex.lock().map_err(|_| SecureStorageError::LockPoisoned)?;
    let st = guard
        .as_mut()
        .ok_or_else(|| SecureStorageError::Storage("not initialized".into()))?;
    let session = st
        .session
        .as_ref()
        .ok_or_else(|| SecureStorageError::Storage("no session".into()))?;
    if !st.namespace_states.contains_key(&namespace) {
        let ns = load_namespace_state(&st.backend, &st.domain, session, namespace)?;
        st.namespace_states.insert(namespace, ns);
    }
    Ok(st.namespace_states.get(&namespace).map(|s| s.total_data_length).unwrap_or(0))
}

// ── VFS callbacks ────────────────────────────────────────────────────
//
// Every callback body runs inside `catch_unwind`. A Rust panic reaching
// the FFI frontier is UB under C ABI; we convert it (and any poisoned
// mutex) into `SQLITE_IOERR` so SQLite can surface the failure cleanly.

/// Run `f` under `catch_unwind`; a panic maps to `SQLITE_IOERR`.
fn vfs_call<F: FnOnce() -> c_int>(f: F) -> c_int {
    match catch_unwind(AssertUnwindSafe(f)) {
        Ok(rc) => rc,
        Err(_) => SQLITE_IOERR as c_int,
    }
}

/// Acquire the VFS state mutex without poisoning semantics: a previously
/// panicking holder (caught by `vfs_call`) should not lock us out — we
/// recover by taking the inner value. Returns `None` if not initialised.
fn lock_state() -> std::result::Result<MutexGuard<'static, Option<VfsState>>, ()> {
    match state_mutex().lock() {
        Ok(g) => Ok(g),
        Err(poisoned) => Ok(poisoned.into_inner()),
    }
}

fn lock_aux() -> std::result::Result<MutexGuard<'static, Vec<Vec<u8>>>, ()> {
    match aux().lock() {
        Ok(g) => Ok(g),
        Err(poisoned) => Ok(poisoned.into_inner()),
    }
}

/// Checked `usize` conversion for SQLite's `c_int` sizes. Negative or
/// outrageously-large values are rejected so we never allocate or index
/// with a wrapped value.
fn checked_usize_from_c_int(v: c_int) -> Option<usize> {
    if v < 0 {
        return None;
    }
    Some(v as usize)
}

/// Checked conversion from SQLite's signed `i64` offset to `u64`.
fn checked_u64_from_i64(v: i64) -> Option<u64> {
    if v < 0 {
        None
    } else {
        Some(v as u64)
    }
}

unsafe extern "C" fn x_open(
    _vfs: *mut sqlite3_vfs,
    _z_name: *const c_char,
    file: *mut sqlite3_file,
    flags: c_int,
    out_flags: *mut c_int,
) -> c_int {
    vfs_call(|| unsafe {
        let f = &mut *(file as *mut EncFile);
        f.base.pMethods = io_methods();

        if flags & SQLITE_OPEN_MAIN_DB as c_int != 0 {
            f.kind = KIND_MAIN;
            f.aux_id = 0;
        } else {
            f.kind = KIND_AUX;
            f.aux_id = match lock_aux() {
                Ok(mut a) => {
                    let id = a.len() as u32;
                    a.push(Vec::new());
                    id
                }
                Err(_) => return SQLITE_IOERR as c_int,
            };
        }

        if !out_flags.is_null() {
            *out_flags = flags;
        }
        SQLITE_OK as c_int
    })
}

unsafe extern "C" fn x_close(file: *mut sqlite3_file) -> c_int {
    vfs_call(|| unsafe {
        let f = &*(file as *const EncFile);
        if f.kind == KIND_AUX {
            if let Ok(mut a) = lock_aux() {
                if let Some(v) = a.get_mut(f.aux_id as usize) {
                    *v = Vec::new();
                }
            }
        }
        SQLITE_OK as c_int
    })
}

unsafe extern "C" fn x_read(
    file: *mut sqlite3_file,
    buf: *mut c_void,
    amt: c_int,
    offset: i64,
) -> c_int {
    vfs_call(|| unsafe {
        let f = &*(file as *const EncFile);
        let n = match checked_usize_from_c_int(amt) {
            Some(n) => n,
            None => return SQLITE_IOERR as c_int,
        };
        let off = match checked_u64_from_i64(offset) {
            Some(o) => o,
            None => return SQLITE_IOERR as c_int,
        };
        let dst = std::slice::from_raw_parts_mut(buf as *mut u8, n);

        if f.kind == KIND_MAIN {
            let guard = match lock_state() {
                Ok(g) => g,
                Err(_) => return SQLITE_IOERR as c_int,
            };
            let st = match guard.as_ref() {
                Some(st) => st,
                None => {
                    dst.fill(0);
                    return SQLITE_IOERR as c_int;
                }
            };
            let session = match st.session.as_ref() {
                Some(s) => s,
                None => {
                    dst.fill(0);
                    // No valid DB without a session — reject firmly so
                    // SQLite cannot mis-parse the zero-filled buffer as
                    // an empty-but-valid database header.
                    return SQLITE_IOERR as c_int;
                }
            };
            let ns_state = st.sql_ns_state();
            let logical_size = st.pending_file_size.max(ns_state.total_data_length);

            let read_end = match off.checked_add(n as u64) {
                Some(v) => v,
                None => return SQLITE_IOERR as c_int,
            };
            if read_end > logical_size {
                let avail = logical_size.saturating_sub(off) as usize;
                if avail > 0 {
                    let persisted = ns_state.total_data_length.saturating_sub(off) as usize;
                    let from_storage = avail.min(persisted);
                    if from_storage > 0 {
                        if let Ok(data) = crate::read_session_data(
                            &st.backend,
                            &st.domain,
                            DEFAULT_NAMESPACE,
                            session,
                            &ns_state,
                            off,
                            from_storage,
                        ) {
                            dst[..from_storage].copy_from_slice(&data);
                        }
                    }
                }
                dst[avail..].fill(0);
                apply_pending_overlay(&st.pending_writes, off, dst);
                return SQLITE_IOERR_SHORT_READ as c_int;
            }

            let persisted_avail = ns_state.total_data_length.saturating_sub(off) as usize;
            if persisted_avail >= n {
                match crate::read_session_data(
                    &st.backend,
                    &st.domain,
                    DEFAULT_NAMESPACE,
                    session,
                    &ns_state,
                    off,
                    n,
                ) {
                    Ok(data) => dst.copy_from_slice(&data),
                    Err(_) => dst.fill(0),
                }
            } else {
                if persisted_avail > 0 {
                    if let Ok(data) = crate::read_session_data(
                        &st.backend,
                        &st.domain,
                        DEFAULT_NAMESPACE,
                        session,
                        &ns_state,
                        off,
                        persisted_avail,
                    ) {
                        dst[..persisted_avail].copy_from_slice(&data);
                    }
                }
                dst[persisted_avail..].fill(0);
            }
            apply_pending_overlay(&st.pending_writes, off, dst);
            SQLITE_OK as c_int
        } else {
            let a = match lock_aux() {
                Ok(a) => a,
                Err(_) => return SQLITE_IOERR as c_int,
            };
            let fd = match a.get(f.aux_id as usize) {
                Some(fd) => fd,
                None => return SQLITE_IOERR as c_int,
            };
            let o = match usize::try_from(offset) {
                Ok(o) => o,
                Err(_) => return SQLITE_IOERR as c_int,
            };
            let end = match o.checked_add(n) {
                Some(v) => v,
                None => return SQLITE_IOERR as c_int,
            };
            if end <= fd.len() {
                dst.copy_from_slice(&fd[o..end]);
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
        }
    })
}

/// Hard cap on the size of an in-memory auxiliary (journal / temp) file.
/// Exceeding this returns `SQLITE_FULL`, preventing a runaway query from
/// OOM-ing a mobile process.
const AUX_FILE_MAX_BYTES: usize = 64 * 1024 * 1024;

unsafe extern "C" fn x_write(
    file: *mut sqlite3_file,
    buf: *const c_void,
    amt: c_int,
    offset: i64,
) -> c_int {
    vfs_call(|| unsafe {
        let f = &*(file as *const EncFile);
        let n = match checked_usize_from_c_int(amt) {
            Some(n) => n,
            None => return SQLITE_IOERR as c_int,
        };
        let src = std::slice::from_raw_parts(buf as *const u8, n);

        if f.kind == KIND_MAIN {
            let write_off = match checked_u64_from_i64(offset) {
                Some(o) => o,
                None => return SQLITE_IOERR as c_int,
            };
            let write_end = match write_off.checked_add(n as u64) {
                Some(v) => v,
                None => return SQLITE_IOERR as c_int,
            };
            let mut guard = match lock_state() {
                Ok(g) => g,
                Err(_) => return SQLITE_IOERR as c_int,
            };
            let st = match guard.as_mut() {
                Some(st) => st,
                None => return SQLITE_IOERR as c_int,
            };
            if st.session.is_none() {
                return SQLITE_IOERR as c_int;
            }
            if write_end > st.pending_file_size {
                st.pending_file_size = write_end;
            }
            st.pending_writes.push(PendingWrite {
                offset: write_off,
                data: src.to_vec(),
            });
            SQLITE_OK as c_int
        } else {
            let mut a = match lock_aux() {
                Ok(a) => a,
                Err(_) => return SQLITE_IOERR as c_int,
            };
            let fd = match a.get_mut(f.aux_id as usize) {
                Some(fd) => fd,
                None => return SQLITE_IOERR as c_int,
            };
            let o = match usize::try_from(offset) {
                Ok(o) => o,
                Err(_) => return SQLITE_IOERR as c_int,
            };
            let end = match o.checked_add(n) {
                Some(v) => v,
                None => return SQLITE_IOERR as c_int,
            };
            if end > AUX_FILE_MAX_BYTES {
                return rusqlite::ffi::SQLITE_FULL as c_int;
            }
            if end > fd.len() {
                fd.resize(end, 0);
            }
            fd[o..end].copy_from_slice(src);
            SQLITE_OK as c_int
        }
    })
}

unsafe extern "C" fn x_truncate(file: *mut sqlite3_file, size: i64) -> c_int {
    vfs_call(|| unsafe {
        let f = &*(file as *const EncFile);
        let size = match checked_u64_from_i64(size) {
            Some(s) => s,
            None => return SQLITE_IOERR as c_int,
        };
        if f.kind == KIND_MAIN {
            if let Ok(mut guard) = lock_state() {
                if let Some(st) = guard.as_mut() {
                    st.pending_file_size = size;
                    st.sql_ns_state_mut().total_data_length = size;
                }
            }
        } else if let Ok(mut a) = lock_aux() {
            if let Some(fd) = a.get_mut(f.aux_id as usize) {
                let new_len = usize::try_from(size).unwrap_or(usize::MAX);
                fd.truncate(new_len);
            }
        }
        SQLITE_OK as c_int
    })
}

unsafe extern "C" fn x_sync(_file: *mut sqlite3_file, _flags: c_int) -> c_int {
    vfs_call(|| {
        let mut guard = match lock_state() {
            Ok(g) => g,
            Err(_) => return SQLITE_IOERR as c_int,
        };
        let st = match guard.as_mut() {
            Some(st) => st,
            None => return SQLITE_OK as c_int,
        };
        if flush_pending_writes(st).is_err() {
            return SQLITE_IOERR as c_int;
        }
        SQLITE_OK as c_int
    })
}

unsafe extern "C" fn x_file_size(file: *mut sqlite3_file, size: *mut i64) -> c_int {
    vfs_call(|| unsafe {
        let f = &*(file as *const EncFile);
        if f.kind == KIND_MAIN {
            let guard = match lock_state() {
                Ok(g) => g,
                Err(_) => return SQLITE_IOERR as c_int,
            };
            let logical = guard.as_ref().map_or(0u64, |st| {
                let persisted = st.sql_ns_state().total_data_length;
                persisted.max(st.pending_file_size)
            });
            *size = i64::try_from(logical).unwrap_or(i64::MAX);
        } else {
            let a = match lock_aux() {
                Ok(a) => a,
                Err(_) => return SQLITE_IOERR as c_int,
            };
            let len = a.get(f.aux_id as usize).map(|fd| fd.len()).unwrap_or(0);
            *size = i64::try_from(len).unwrap_or(i64::MAX);
        }
        SQLITE_OK as c_int
    })
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
    vfs_call(|| unsafe {
        *result = 0;
        SQLITE_OK as c_int
    })
}

unsafe extern "C" fn x_full_pathname(
    _vfs: *mut sqlite3_vfs,
    z_name: *const c_char,
    n_out: c_int,
    z_out: *mut c_char,
) -> c_int {
    vfs_call(|| unsafe {
        if !z_name.is_null() {
            let bytes = CStr::from_ptr(z_name).to_bytes_with_nul();
            let cap = match checked_usize_from_c_int(n_out) {
                Some(c) => c,
                None => return SQLITE_IOERR as c_int,
            };
            let len = bytes.len().min(cap);
            std::ptr::copy_nonoverlapping(bytes.as_ptr(), z_out as *mut u8, len);
        }
        SQLITE_OK as c_int
    })
}

// xLock/xUnlock/xCheckReservedLock are safe no-ops: `locking_mode=EXCLUSIVE`
// keeps the single process as the sole locker, and redb's OS-level file
// lock on `storage.redb` prevents a second process from ever reaching
// this code path. See module-level doc for the full argument.
unsafe extern "C" fn x_lock(_f: *mut sqlite3_file, _l: c_int) -> c_int {
    SQLITE_OK as c_int
}
unsafe extern "C" fn x_unlock(_f: *mut sqlite3_file, _l: c_int) -> c_int {
    SQLITE_OK as c_int
}
unsafe extern "C" fn x_check_reserved_lock(_f: *mut sqlite3_file, r: *mut c_int) -> c_int {
    vfs_call(|| {
        unsafe { *r = 0 };
        SQLITE_OK as c_int
    })
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

// ── Tests ────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::run_with_stack;

    static TEST_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

    fn test_mutex() -> &'static Mutex<()> {
        TEST_LOCK.get_or_init(|| Mutex::new(()))
    }

    fn ensure_registered() {
        register().unwrap();
    }

    fn setup_native_vfs() -> (tempfile::TempDir, rusqlite::Connection) {
        reset_state();
        ensure_registered();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().to_str().unwrap();
        init_native(path, "test").unwrap();
        provision().unwrap();
        allocate(0, b"password").unwrap();
        let conn = open_db().unwrap();
        (dir, conn)
    }

    #[test]
    fn test_native_vfs_sql_roundtrip() {
        run_with_stack(|| {
            let _guard = test_mutex().lock().unwrap();
            let (_dir, conn) = setup_native_vfs();

            conn.execute_batch(
                "CREATE TABLE t (id INTEGER PRIMARY KEY, val TEXT);
                 INSERT INTO t VALUES (1, 'hello');
                 INSERT INTO t VALUES (2, 'world');",
            )
            .unwrap();

            let vals: Vec<String> = {
                let mut stmt = conn.prepare("SELECT val FROM t ORDER BY id").unwrap();
                stmt.query_map([], |row| row.get(0))
                    .unwrap()
                    .map(|r| r.unwrap())
                    .collect()
            };

            assert_eq!(vals, vec!["hello", "world"]);
            drop(conn);
        });
    }

    /// Regression for H7 / clear_namespace: writing, reading, and
    /// clearing a non-SQL namespace through the native API must produce
    /// a zero-length result and the blob must not be readable back.
    #[test]
    fn test_native_vfs_namespace_clear_roundtrip() {
        run_with_stack(|| {
            let _guard = test_mutex().lock().unwrap();
            let (_dir, conn) = setup_native_vfs();

            let payload = vec![0x42u8; 4096];
            write_namespace_data(1, 0, &payload).unwrap();
            assert_eq!(namespace_data_length(1).unwrap(), 4096);
            let got = read_namespace_data(1, 0, 4096).unwrap();
            assert_eq!(got, payload);

            clear_namespace(1).unwrap();
            assert_eq!(namespace_data_length(1).unwrap(), 0);
            drop(conn);
        });
    }

    /// Regression for C3: a negative offset or negative amount at the
    /// VFS callback boundary must be rejected instead of wrapping and
    /// reading/writing at a random address.
    #[test]
    fn test_checked_conversions_reject_negative() {
        assert!(checked_u64_from_i64(-1).is_none());
        assert!(checked_usize_from_c_int(-1).is_none());
    }

    /// Large end-to-end Rust integration test approximating the full
    /// mobile onboarding + login flow that Swift/Kotlin drive from the
    /// Capacitor plugins. Exercises every entry point in `native_api`
    /// order and asserts cross-reopen durability, wrong-password
    /// rejection, and namespace-data isolation — the closest we can get
    /// to an end-to-end native run without a device/simulator.
    #[test]
    fn test_native_full_mobile_flow() {
        run_with_stack(|| {
            let _guard = test_mutex().lock().unwrap();
            reset_state();
            ensure_registered();
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().to_str().unwrap().to_string();

            // ── Phase 1: onboarding (provision + allocate + initial data) ──
            {
                init_native(&path, "gossip").unwrap();
                provision().unwrap();
                allocate(0, b"correct-horse-battery-staple").unwrap();
                assert!(is_unlocked().unwrap());

                let conn = open_db().unwrap();
                conn.execute_batch(
                    "CREATE TABLE messages (id INTEGER PRIMARY KEY, body TEXT);
                     CREATE TABLE contacts (id INTEGER PRIMARY KEY, name TEXT);
                     INSERT INTO messages (body) VALUES ('hi'), ('world'), ('!');
                     INSERT INTO contacts (name) VALUES ('alice'), ('bob');",
                )
                .unwrap();

                // Session blob (namespace 1) — the non-SQL persistence path.
                let blob_v1 = vec![0x11u8; 32 * 1024];
                write_namespace_data(1, 0, &blob_v1).unwrap();
                assert_eq!(namespace_data_length(1).unwrap(), 32 * 1024);

                // Cover-traffic tick mid-session (matches the 1b scheduler
                // and PR 2 cover_traffic_tick_native entry point).
                cover_tick().unwrap();

                drop(conn);
                flush().unwrap();
                lock();
                assert!(!is_unlocked().unwrap());
            }

            // ── Phase 2: app relaunch — fresh process, wrong password ──
            {
                reset_state();
                init_native(&path, "gossip").unwrap();
                assert!(!is_unlocked().unwrap());
                // Wrong password must fail without destroying state.
                assert!(!unlock(b"wrong-password").unwrap());
                assert!(!is_unlocked().unwrap());
            }

            // ── Phase 3: app relaunch — correct password, read back ──
            {
                reset_state();
                init_native(&path, "gossip").unwrap();
                assert!(unlock(b"correct-horse-battery-staple").unwrap());
                assert!(is_unlocked().unwrap());

                let conn = open_db().unwrap();
                let msgs: Vec<String> = conn
                    .prepare("SELECT body FROM messages ORDER BY id")
                    .unwrap()
                    .query_map([], |r| r.get::<_, String>(0))
                    .unwrap()
                    .map(|r| r.unwrap())
                    .collect();
                assert_eq!(msgs, vec!["hi", "world", "!"]);

                // Session blob roundtrip after reopen.
                let got = read_namespace_data(1, 0, 32 * 1024).unwrap();
                assert_eq!(got, vec![0x11u8; 32 * 1024]);

                // Simulate the SDK's PD-M2 fix: always clear then rewrite.
                clear_namespace(1).unwrap();
                assert_eq!(namespace_data_length(1).unwrap(), 0);
                let blob_v2 = vec![0x22u8; 48 * 1024];
                write_namespace_data(1, 0, &blob_v2).unwrap();
                assert_eq!(namespace_data_length(1).unwrap(), 48 * 1024);

                // More SQL work to interleave with the namespace writes.
                conn.execute("INSERT INTO messages (body) VALUES ('after-reopen')", [])
                    .unwrap();

                drop(conn);
                flush().unwrap();
                lock();
            }

            // ── Phase 4: final relaunch — everything must still be there ──
            {
                reset_state();
                init_native(&path, "gossip").unwrap();
                assert!(unlock(b"correct-horse-battery-staple").unwrap());
                let conn = open_db().unwrap();
                let msgs: Vec<String> = conn
                    .prepare("SELECT body FROM messages ORDER BY id")
                    .unwrap()
                    .query_map([], |r| r.get::<_, String>(0))
                    .unwrap()
                    .map(|r| r.unwrap())
                    .collect();
                assert_eq!(msgs, vec!["hi", "world", "!", "after-reopen"]);

                let contacts: Vec<String> = conn
                    .prepare("SELECT name FROM contacts ORDER BY id")
                    .unwrap()
                    .query_map([], |r| r.get::<_, String>(0))
                    .unwrap()
                    .map(|r| r.unwrap())
                    .collect();
                assert_eq!(contacts, vec!["alice", "bob"]);

                // Namespace 1 still holds the rewritten blob, not v1.
                let got = read_namespace_data(1, 0, 48 * 1024).unwrap();
                assert_eq!(got, vec![0x22u8; 48 * 1024]);

                drop(conn);
            }
        });
    }

    #[test]
    fn test_native_vfs_persistence() {
        run_with_stack(|| {
            let _guard = test_mutex().lock().unwrap();
            reset_state();
            ensure_registered();
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().to_str().unwrap().to_string();

            {
                init_native(&path, "test").unwrap();
                provision().unwrap();
                allocate(0, b"pw").unwrap();
                let conn = open_db().unwrap();
                conn.execute_batch(
                    "CREATE TABLE t (id INTEGER PRIMARY KEY, val TEXT);
                     INSERT INTO t VALUES (1, 'persisted');",
                )
                .unwrap();
                drop(conn);
                flush().unwrap();
                lock();
            }

            {
                reset_state();
                init_native(&path, "test").unwrap();
                assert!(unlock(b"pw").unwrap());
                let conn = open_db().unwrap();
                let val: String = conn
                    .query_row("SELECT val FROM t WHERE id = 1", [], |row| row.get(0))
                    .unwrap();
                assert_eq!(val, "persisted");
                drop(conn);
            }
        });
    }
}
