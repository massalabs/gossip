//! Encrypted VFS for native (non-WASM) targets, backed by `RedbStorage`.
//!
//! Port of `sqlite_vfs.rs` (WASM) for `rusqlite::ffi`. SQLite pages are
//! encrypted/decrypted transparently through `write_session_data` /
//! `read_session_data`, with writes buffered in RAM and flushed at
//! COMMIT (`x_sync`).
//!
//! Uses a global `Mutex` instead of `thread_local!` for thread safety.

use std::collections::HashMap;
use std::ffi::{CStr, CString};
use std::mem::size_of;
use std::os::raw::{c_char, c_int, c_void};
use std::path::Path;
use std::sync::{Mutex, Once, OnceLock};

use rusqlite::ffi::{
    sqlite3_file, sqlite3_io_methods, sqlite3_vfs, sqlite3_vfs_find, sqlite3_vfs_register,
    SQLITE_IOERR, SQLITE_IOERR_SHORT_READ, SQLITE_NOTFOUND, SQLITE_OK, SQLITE_OPEN_MAIN_DB,
};

use crate::constants::SQL_NAMESPACE;
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
            .get(&SQL_NAMESPACE)
            .copied()
            .unwrap_or_default()
    }

    fn sql_ns_state_mut(&mut self) -> &mut NamespaceState {
        self.namespace_states.entry(SQL_NAMESPACE).or_default()
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

/// Register the encrypted VFS with SQLite (non-default). Idempotent.
pub fn register() -> Result<()> {
    REGISTER_VFS.call_once(|| unsafe {
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
    });
    Ok(())
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
        .insert(SQL_NAMESPACE, NamespaceState::empty());
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
                load_namespace_state(&st.backend, &st.domain, &session, SQL_NAMESPACE)?;
            st.pending_writes.clear();
            st.pending_file_size = sql_state.total_data_length;
            st.namespace_states.clear();
            st.namespace_states.insert(SQL_NAMESPACE, sql_state);
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
    crate::cover_traffic_tick(&mut st.backend, &st.domain, SQL_NAMESPACE)
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
        let ns_state = st.namespace_states.entry(SQL_NAMESPACE).or_default();
        flush_writes(
            &mut st.backend,
            &st.domain,
            SQL_NAMESPACE,
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
            f.aux_id = {
                let mut a = aux().lock().unwrap();
                let id = a.len() as u32;
                a.push(Vec::new());
                id
            };
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
            let mut a = aux().lock().unwrap();
            if let Some(v) = a.get_mut(f.aux_id as usize) {
                *v = Vec::new();
            }
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
        let f = &*(file as *const EncFile);
        let n = amt as usize;
        let off = offset as u64;
        let dst = std::slice::from_raw_parts_mut(buf as *mut u8, n);

        if f.kind == KIND_MAIN {
            let guard = state_mutex().lock().unwrap();
            let st = match guard.as_ref() {
                Some(st) => st,
                None => {
                    dst.fill(0);
                    return SQLITE_IOERR_SHORT_READ as c_int;
                }
            };
            let session = match st.session.as_ref() {
                Some(s) => s,
                None => {
                    dst.fill(0);
                    return SQLITE_IOERR_SHORT_READ as c_int;
                }
            };
            let ns_state = st.sql_ns_state();
            let logical_size = st.pending_file_size.max(ns_state.total_data_length);

            if off + n as u64 > logical_size {
                let avail = logical_size.saturating_sub(off) as usize;
                if avail > 0 {
                    let persisted = ns_state.total_data_length.saturating_sub(off) as usize;
                    let from_storage = avail.min(persisted);
                    if from_storage > 0 {
                        if let Ok(data) = crate::read_session_data(
                            &st.backend,
                            &st.domain,
                            SQL_NAMESPACE,
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
                    SQL_NAMESPACE,
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
                        SQL_NAMESPACE,
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
            let a = aux().lock().unwrap();
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
            let mut guard = state_mutex().lock().unwrap();
            let st = match guard.as_mut() {
                Some(st) => st,
                None => return SQLITE_IOERR as c_int,
            };
            if st.session.is_none() {
                return SQLITE_IOERR as c_int;
            }
            let write_off = offset as u64;
            let write_end = write_off + n as u64;
            if write_end > st.pending_file_size {
                st.pending_file_size = write_end;
            }
            st.pending_writes.push(PendingWrite {
                offset: write_off,
                data: src.to_vec(),
            });
            SQLITE_OK as c_int
        } else {
            let mut a = aux().lock().unwrap();
            let fd = &mut a[f.aux_id as usize];
            let o = offset as usize;
            if o + n > fd.len() {
                fd.resize(o + n, 0);
            }
            fd[o..o + n].copy_from_slice(src);
            SQLITE_OK as c_int
        }
    }
}

unsafe extern "C" fn x_truncate(file: *mut sqlite3_file, size: i64) -> c_int {
    let f = unsafe { &*(file as *const EncFile) };
    if f.kind == KIND_MAIN {
        let mut guard = state_mutex().lock().unwrap();
        if let Some(st) = guard.as_mut() {
            st.pending_file_size = size as u64;
            st.sql_ns_state_mut().total_data_length = size as u64;
        }
    } else {
        let mut a = aux().lock().unwrap();
        a[f.aux_id as usize].truncate(size as usize);
    }
    SQLITE_OK as c_int
}

unsafe extern "C" fn x_sync(_file: *mut sqlite3_file, _flags: c_int) -> c_int {
    let mut guard = state_mutex().lock().unwrap();
    let st = match guard.as_mut() {
        Some(st) => st,
        None => return SQLITE_OK as c_int,
    };
    if flush_pending_writes(st).is_err() {
        return SQLITE_IOERR as c_int;
    }
    SQLITE_OK as c_int
}

unsafe extern "C" fn x_file_size(file: *mut sqlite3_file, size: *mut i64) -> c_int {
    unsafe {
        let f = &*(file as *const EncFile);
        if f.kind == KIND_MAIN {
            let guard = state_mutex().lock().unwrap();
            *size = guard.as_ref().map_or(0, |st| {
                let persisted = st.sql_ns_state().total_data_length;
                persisted.max(st.pending_file_size) as i64
            });
        } else {
            let a = aux().lock().unwrap();
            *size = a[f.aux_id as usize].len() as i64;
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
