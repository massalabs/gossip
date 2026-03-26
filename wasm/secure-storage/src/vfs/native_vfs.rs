//! Encrypted VFS for native (non-WASM) targets, backed by `RedbStorage`.
//!
//! Port of `encrypted_vfs.rs` (WASM) for `rusqlite::ffi`. SQLite pages are
//! encrypted/decrypted transparently using `write_session_data` /
//! `read_session_data`.
//!
//! Uses a global `Mutex` instead of `thread_local!` for thread safety.

use std::ffi::{CStr, CString};
use std::mem::size_of;
use std::os::raw::{c_char, c_int, c_void};
use std::path::Path;
use std::sync::{Mutex, Once, OnceLock};

use rusqlite::ffi::{
    sqlite3_file, sqlite3_io_methods, sqlite3_vfs, sqlite3_vfs_find, sqlite3_vfs_register,
    SQLITE_IOERR, SQLITE_IOERR_SHORT_READ, SQLITE_NOTFOUND, SQLITE_OK, SQLITE_OPEN_MAIN_DB,
};

use crate::error::{Result, SecureStorageError};
use crate::types::SessionIndex;
use crate::unlock::UnlockedSession;

use super::redb_storage::RedbStorage;

/// VFS name used for registration with SQLite.
pub const VFS_NAME: &str = "secure-storage-enc-native";

// ── State ────────────────────────────────────────────────────────────

struct VfsState {
    backend: RedbStorage,
    domain: String,
    session: Option<UnlockedSession>,
}

static STATE: OnceLock<Mutex<Option<VfsState>>> = OnceLock::new();

/// Auxiliary file data (journal/temp -- unencrypted, in-memory only).
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

/// Create state with filesystem + WAL backend.
pub fn init_native(path: &str, domain: &str) -> Result<()> {
    let storage = RedbStorage::open(Path::new(path))?;
    let mutex = state_mutex();
    let mut guard = mutex.lock().map_err(|_| SecureStorageError::LockPoisoned)?;
    *guard = Some(VfsState {
        backend: storage,
        domain: domain.to_string(),
        session: None,
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
    });
    Ok(())
}

/// Provision all 5 session slots. Returns true if fresh, false if already provisioned.
pub fn provision() -> Result<bool> {
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

/// Run one round of cover traffic.
pub fn cover_tick() -> Result<()> {
    let mutex = state_mutex();
    let mut guard = mutex.lock().map_err(|_| SecureStorageError::LockPoisoned)?;
    let st = guard
        .as_mut()
        .ok_or_else(|| SecureStorageError::Storage("not initialized".into()))?;
    crate::cover_traffic_tick(&mut st.backend, &st.domain)
}

/// Flush encrypted data to backing store.
pub fn flush() -> Result<()> {
    let mutex = state_mutex();
    let mut guard = mutex.lock().map_err(|_| SecureStorageError::LockPoisoned)?;
    let st = guard
        .as_mut()
        .ok_or_else(|| SecureStorageError::Storage("not initialized".into()))?;
    st.backend.commit()
}

/// Open a rusqlite connection using the registered encrypted VFS.
///
/// Sets `PRAGMA journal_mode=OFF` to prevent SQLite from using its own
/// WAL/journal (we use our custom WAL instead).
pub fn open_db() -> Result<rusqlite::Connection> {
    let vfs_name = VFS_NAME;
    let conn = rusqlite::Connection::open_with_flags_and_vfs(
        "main.db",
        rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE
            | rusqlite::OpenFlags::SQLITE_OPEN_CREATE
            | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
        vfs_name,
    )
    .map_err(|e| SecureStorageError::Sqlite(e.to_string()))?;
    conn.pragma_update(None, "journal_mode", "OFF")
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
                // Release memory; the slot stays to preserve aux_id indices.
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
        debug_assert!(amt >= 0, "x_read: negative amt");
        debug_assert!(offset >= 0, "x_read: negative offset");
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
        debug_assert!(amt >= 0, "x_write: negative amt");
        debug_assert!(offset >= 0, "x_write: negative offset");
        let f = &*(file as *const EncFile);
        let n = amt as usize;
        let src = std::slice::from_raw_parts(buf as *const u8, n);

        if f.kind == KIND_MAIN {
            let mut guard = state_mutex().lock().unwrap();
            let st = match guard.as_mut() {
                Some(st) => st,
                None => return SQLITE_IOERR as c_int,
            };
            let (backend, domain, session) = match st.session.as_mut() {
                Some(session) => (&mut st.backend, st.domain.as_str(), session),
                None => return SQLITE_IOERR as c_int,
            };
            match crate::write_session_data(backend, domain, session, offset as u64, src) {
                Ok(()) => SQLITE_OK as c_int,
                Err(_) => SQLITE_IOERR as c_int,
            }
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
    debug_assert!(size >= 0, "x_truncate: negative size");
    let f = unsafe { &*(file as *const EncFile) };
    if f.kind == KIND_MAIN {
        let mut guard = state_mutex().lock().unwrap();
        if let Some(st) = guard.as_mut() {
            if let Some(session) = st.session.as_mut() {
                session.total_data_length = size as u64;
            }
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
    if st.session.is_some() {
        if st.backend.commit().is_err() {
            return SQLITE_IOERR as c_int;
        }
    }
    SQLITE_OK as c_int
}

unsafe extern "C" fn x_file_size(file: *mut sqlite3_file, size: *mut i64) -> c_int {
    unsafe {
        let f = &*(file as *const EncFile);
        if f.kind == KIND_MAIN {
            let guard = state_mutex().lock().unwrap();
            *size = guard
                .as_ref()
                .and_then(|st| st.session.as_ref())
                .map_or(0, |session| session.total_data_length as i64);
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
        // Always report "file does not exist". This prevents SQLite from
        // attempting hot-journal or WAL recovery on auxiliary files that
        // our VFS doesn't actually persist.
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
    use crate::storage::BlockStorage;

    /// Serialise tests that share global VFS state.
    static TEST_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

    fn test_mutex() -> &'static Mutex<()> {
        TEST_LOCK.get_or_init(|| Mutex::new(()))
    }

    fn ensure_registered() {
        // register() is idempotent (uses std::sync::Once internally)
        register().unwrap();
    }

    /// Full setup: init, register VFS, provision, allocate, open DB.
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

            // Write data.
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
                // Explicit flush to ensure WAL is committed.
                drop(conn);
                flush().unwrap();
                lock();
            }

            // Reopen and verify.
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

    #[test]
    fn test_native_vfs_crash_recovery() {
        run_with_stack(|| {
            let _guard = test_mutex().lock().unwrap();
            reset_state();
            ensure_registered();
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().to_str().unwrap().to_string();

            // Write data and commit.
            {
                init_native(&path, "test").unwrap();
                provision().unwrap();
                allocate(0, b"pw").unwrap();
                let conn = open_db().unwrap();
                conn.execute_batch(
                    "CREATE TABLE t (id INTEGER PRIMARY KEY, val TEXT);
                     INSERT INTO t VALUES (1, 'committed');",
                )
                .unwrap();
                drop(conn);
                flush().unwrap();
                lock();
            }

            // Write more data WITHOUT flushing (simulate crash).
            {
                reset_state();
                init_native(&path, "test").unwrap();
                assert!(unlock(b"pw").unwrap());
                let conn = open_db().unwrap();
                conn.execute_batch("INSERT INTO t VALUES (2, 'uncommitted');")
                    .unwrap();
                // Drop connection but do NOT flush.
                // x_sync was called during the INSERT (since journal_mode=OFF,
                // SQLite calls sync after each statement), but let's verify
                // the committed data survives a re-open.
                drop(conn);
                lock();
            }

            // Reopen and verify committed data is there.
            {
                reset_state();
                init_native(&path, "test").unwrap();
                assert!(unlock(b"pw").unwrap());
                let conn = open_db().unwrap();
                let val: String = conn
                    .query_row("SELECT val FROM t WHERE id = 1", [], |row| row.get(0))
                    .unwrap();
                assert_eq!(val, "committed");
                drop(conn);
            }
        });
    }

    #[test]
    fn test_native_vfs_multiple_lock_unlock_cycles() {
        run_with_stack(|| {
            let _guard = test_mutex().lock().unwrap();
            reset_state();
            ensure_registered();
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().to_str().unwrap().to_string();

            // Initial write.
            {
                init_native(&path, "test").unwrap();
                provision().unwrap();
                allocate(0, b"pw").unwrap();
                let conn = open_db().unwrap();
                conn.execute_batch(
                    "CREATE TABLE t (id INTEGER PRIMARY KEY, val TEXT);
                     INSERT INTO t VALUES (1, 'cycle_data');",
                )
                .unwrap();
                drop(conn);
                flush().unwrap();
                lock();
            }

            // Repeat lock/unlock 3 times.
            for i in 0..3 {
                reset_state();
                init_native(&path, "test").unwrap();
                assert!(unlock(b"pw").unwrap(), "unlock failed on cycle {i}");
                let conn = open_db().unwrap();
                let val: String = conn
                    .query_row("SELECT val FROM t WHERE id = 1", [], |row| row.get(0))
                    .unwrap();
                assert_eq!(val, "cycle_data", "data mismatch on cycle {i}");
                drop(conn);
                flush().unwrap();
                lock();
            }
        });
    }

    #[test]
    fn test_native_vfs_cover_traffic_preserves_data() {
        run_with_stack(|| {
            let _guard = test_mutex().lock().unwrap();
            reset_state();
            ensure_registered();
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().to_str().unwrap().to_string();

            // Write data.
            init_native(&path, "test").unwrap();
            provision().unwrap();
            allocate(0, b"pw").unwrap();
            let conn = open_db().unwrap();
            conn.execute_batch(
                "CREATE TABLE t (id INTEGER PRIMARY KEY, val TEXT);
                 INSERT INTO t VALUES (1, 'cover_ok');",
            )
            .unwrap();
            drop(conn);
            flush().unwrap();

            // Run cover traffic 5 times.
            for _ in 0..5 {
                cover_tick().unwrap();
            }

            flush().unwrap();
            lock();

            // Reopen and verify.
            reset_state();
            init_native(&path, "test").unwrap();
            assert!(unlock(b"pw").unwrap());
            let conn = open_db().unwrap();
            let val: String = conn
                .query_row("SELECT val FROM t WHERE id = 1", [], |row| row.get(0))
                .unwrap();
            assert_eq!(val, "cover_ok");
            drop(conn);
        });
    }

    #[test]
    fn test_native_vfs_provision_idempotent() {
        run_with_stack(|| {
            let _guard = test_mutex().lock().unwrap();
            reset_state();
            ensure_registered();
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().to_str().unwrap().to_string();

            // First provision + write data.
            {
                init_native(&path, "test").unwrap();
                let fresh = provision().unwrap();
                assert!(fresh, "first provision should return true (fresh)");
                allocate(0, b"pw").unwrap();
                let conn = open_db().unwrap();
                conn.execute_batch(
                    "CREATE TABLE t (id INTEGER PRIMARY KEY, val TEXT);
                     INSERT INTO t VALUES (1, 'idempotent');",
                )
                .unwrap();
                drop(conn);
                flush().unwrap();
                lock();
            }

            // Re-init and provision again — should be no-op.
            {
                reset_state();
                init_native(&path, "test").unwrap();
                let fresh = provision().unwrap();
                assert!(!fresh, "second provision should return false (already provisioned)");
                assert!(unlock(b"pw").unwrap());
                let conn = open_db().unwrap();
                let val: String = conn
                    .query_row("SELECT val FROM t WHERE id = 1", [], |row| row.get(0))
                    .unwrap();
                assert_eq!(val, "idempotent");
                drop(conn);
            }
        });
    }

    #[test]
    fn test_native_vfs_large_data_persistence() {
        run_with_stack(|| {
            let _guard = test_mutex().lock().unwrap();
            reset_state();
            ensure_registered();
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().to_str().unwrap().to_string();

            // Write 20 rows with 1KB BLOBs.
            {
                init_native(&path, "test").unwrap();
                provision().unwrap();
                allocate(0, b"pw").unwrap();
                let conn = open_db().unwrap();
                conn.execute_batch("CREATE TABLE blobs (id INTEGER PRIMARY KEY, data BLOB);")
                    .unwrap();
                for i in 0..20 {
                    let blob = vec![(i & 0xFF) as u8; 1024];
                    conn.execute("INSERT INTO blobs VALUES (?1, ?2)", rusqlite::params![i, blob])
                        .unwrap();
                }
                drop(conn);
                flush().unwrap();
                lock();
            }

            // Reopen and verify all 20 rows.
            {
                reset_state();
                init_native(&path, "test").unwrap();
                assert!(unlock(b"pw").unwrap());
                let conn = open_db().unwrap();
                let count: i64 = conn
                    .query_row("SELECT COUNT(*) FROM blobs", [], |row| row.get(0))
                    .unwrap();
                assert_eq!(count, 20);

                for i in 0..20_i64 {
                    let blob: Vec<u8> = conn
                        .query_row(
                            "SELECT data FROM blobs WHERE id = ?1",
                            rusqlite::params![i],
                            |row| row.get(0),
                        )
                        .unwrap();
                    assert_eq!(blob.len(), 1024, "row {i}: wrong blob length");
                    assert!(
                        blob.iter().all(|&b| b == (i & 0xFF) as u8),
                        "row {i}: blob content mismatch"
                    );
                }
                drop(conn);
            }
        });
    }

    /// Find the exact row count where persistence breaks.
    #[test]
    fn test_native_vfs_persistence_threshold() {
        run_with_stack(|| {
            let _guard = test_mutex().lock().unwrap();

            for num_rows in [10, 50, 100] {
                reset_state();
                ensure_registered();
                let dir = tempfile::tempdir().unwrap();
                let path = dir.path().to_str().unwrap().to_string();

                // Write
                {
                    init_native(&path, "test").unwrap();
                    provision().unwrap();
                    allocate(0, b"pw").unwrap();
                    let conn = open_db().unwrap();
                    conn.execute_batch(
                        "CREATE TABLE t (id INTEGER PRIMARY KEY, data BLOB)",
                    )
                    .unwrap();
                    for i in 0..num_rows {
                        let blob = vec![0xABu8; 1024];
                        conn.execute(
                            "INSERT INTO t VALUES (?1, ?2)",
                            rusqlite::params![i, blob],
                        )
                        .unwrap();
                    }
                    // Check file_size as seen by SQLite
                    let page_count: i64 = conn
                        .query_row("PRAGMA page_count", [], |r| r.get(0))
                        .unwrap();
                    let page_size: i64 = conn
                        .query_row("PRAGMA page_size", [], |r| r.get(0))
                        .unwrap();
                    eprintln!(
                        "rows={num_rows}: page_count={page_count}, page_size={page_size}, \
                         db_size={}KB, blocks_needed={}",
                        page_count * page_size / 1024,
                        (8 + page_count * page_size + 15839) as u64 / 15840
                    );
                    drop(conn);
                    flush().unwrap();
                    lock();
                }

                // Reopen and verify
                {
                    reset_state();
                    init_native(&path, "test").unwrap();

                    // Check what's in redb before unlock
                    {
                        let guard = state_mutex().lock().unwrap();
                        let st = guard.as_ref().unwrap();
                        for s in 0..5u8 {
                            let si = crate::types::SessionIndex::new(s).unwrap();
                            let bc = st.backend.block_count(si).unwrap();
                            eprintln!("  redb session {s}: {bc} blocks");
                        }
                    }

                    match unlock(b"pw") {
                        Ok(true) => {
                            // Check total_data_length
                            {
                                let guard = state_mutex().lock().unwrap();
                                let st = guard.as_ref().unwrap();
                                let sess = st.session.as_ref().unwrap();
                                eprintln!(
                                    "  unlocked: session={}, total_data_length={}",
                                    sess.session_index.as_u8(),
                                    sess.total_data_length
                                );
                            }

                            let conn = open_db().unwrap();
                            // Try a simple integrity check
                            match conn.query_row(
                                "PRAGMA integrity_check",
                                [],
                                |r| r.get::<_, String>(0),
                            ) {
                                Ok(s) => eprintln!("  integrity_check: {s}"),
                                Err(e) => eprintln!("  integrity_check FAILED: {e}"),
                            }
                            match conn.query_row(
                                "SELECT COUNT(*) FROM t",
                                [],
                                |r| r.get::<_, i64>(0),
                            ) {
                                Ok(count) => {
                                    eprintln!("  → reopen OK, count={count}");
                                    assert_eq!(count, num_rows as i64);
                                }
                                Err(e) => {
                                    eprintln!("  → SELECT FAILED: {e}");
                                    panic!("SELECT failed at {num_rows} rows: {e}");
                                }
                            }
                            drop(conn);
                        }
                        Ok(false) => panic!("unlock returned false at {num_rows} rows"),
                        Err(e) => panic!("unlock error at {num_rows} rows: {e}"),
                    }
                }
            }
        });
    }

    #[test]
    fn test_native_vfs_wrong_password_after_lock() {
        run_with_stack(|| {
            let _guard = test_mutex().lock().unwrap();
            reset_state();
            ensure_registered();
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().to_str().unwrap().to_string();

            // Write data.
            {
                init_native(&path, "test").unwrap();
                provision().unwrap();
                allocate(0, b"pw").unwrap();
                let conn = open_db().unwrap();
                conn.execute_batch(
                    "CREATE TABLE t (id INTEGER PRIMARY KEY, val TEXT);
                     INSERT INTO t VALUES (1, 'secret');",
                )
                .unwrap();
                drop(conn);
                flush().unwrap();
                lock();
            }

            // Wrong password should fail.
            {
                reset_state();
                init_native(&path, "test").unwrap();
                let ok = unlock(b"wrong").unwrap();
                assert!(!ok, "wrong password should return false");
            }

            // Correct password should succeed.
            {
                let ok = unlock(b"pw").unwrap();
                assert!(ok, "correct password should return true");
                let conn = open_db().unwrap();
                let val: String = conn
                    .query_row("SELECT val FROM t WHERE id = 1", [], |row| row.get(0))
                    .unwrap();
                assert_eq!(val, "secret");
                drop(conn);
            }
        });
    }
}
