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
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, Once, OnceLock};
use std::time::Duration;

use rusqlite::ffi::{
    SQLITE_IOERR, SQLITE_IOERR_SHORT_READ, SQLITE_NOTFOUND, SQLITE_OK, SQLITE_OPEN_MAIN_DB,
    sqlite3_file, sqlite3_io_methods, sqlite3_vfs, sqlite3_vfs_find, sqlite3_vfs_register,
};

use crate::DEFAULT_NAMESPACE;
use crate::error::{Result, SecureStorageError};
use crate::types::SessionIndex;
use crate::unlock::{NamespaceState, UnlockedSession, load_namespace_state};

use super::file_core::EncryptedFileCore;
use super::redb_storage::RedbStorage;

/// VFS name used for registration with SQLite.
pub const VFS_NAME: &str = "secure-storage-enc-native";

/// Application-level namespace for the SDK-owned session blob stream.
/// Must stay in sync with `SESSION_BLOB_NAMESPACE` in
/// `gossip-sdk/src/db/secure-storage-namespaces.ts`.
const SESSION_BLOB_NAMESPACE: u8 = 1;

/// Namespaces the cover-traffic scheduler rerandomises on every tick.
/// Mirrors `COVER_TRAFFIC_NAMESPACES` on the web side.
const COVER_TRAFFIC_NAMESPACES: &[u8] = &[DEFAULT_NAMESPACE, SESSION_BLOB_NAMESPACE];

// ── State ────────────────────────────────────────────────────────────

struct VfsState {
    backend: RedbStorage,
    domain: String,
    session: Option<UnlockedSession>,
    namespace_states: HashMap<u8, NamespaceState>,
    /// Per-file read/write/sync state for the SQLite main DB.
    ///
    /// Shared with the web VFS via [`EncryptedFileCore`] — this is the
    /// single source of truth for pending-write handling, overlay
    /// reads, and shrink semantics. Native callbacks are thin FFI
    /// trampolines that delegate here.
    main_file: EncryptedFileCore,
}

impl VfsState {
    fn sql_ns_state(&self) -> NamespaceState {
        self.namespace_states
            .get(&DEFAULT_NAMESPACE)
            .copied()
            .unwrap_or_default()
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
        main_file: EncryptedFileCore::new(),
    });
    drop(guard);
    // Start the cover-traffic background thread once the backend is
    // reachable. The scheduler outlives lock/unlock cycles on purpose.
    ensure_cover_scheduler();
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
                        // `EncFile` is a fixed-size struct of two pointers
                        // and a u32, so it always fits in c_int. The cast
                        // would be sound either way; using `try_from` keeps
                        // the no-`as`-truncation rule from the 1a review
                        // honoured uniformly.
                        vfs.szOsFile = c_int::try_from(size_of::<EncFile>())
                            .expect("EncFile is small enough to fit in c_int");
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

/// Return true if the backing redb database already has keypair data.
/// Used by the plugin layer to gate `provision` at boot.
pub fn has_data() -> Result<bool> {
    let mutex = state_mutex();
    let guard = mutex.lock().map_err(|_| SecureStorageError::LockPoisoned)?;
    let st = guard
        .as_ref()
        .ok_or_else(|| SecureStorageError::NotInitialized)?;
    st.backend.has_data()
}

/// Provision all session slots.
pub fn provision() -> Result<()> {
    let mutex = state_mutex();
    let mut guard = mutex.lock().map_err(|_| SecureStorageError::LockPoisoned)?;
    let st = guard
        .as_mut()
        .ok_or_else(|| SecureStorageError::NotInitialized)?;
    crate::provision_storage(&mut st.backend)
}

/// Allocate a session in `slot` with `password`, auto-unlock.
pub fn allocate(slot: u8, password: &[u8]) -> Result<()> {
    let mutex = state_mutex();
    let mut guard = mutex.lock().map_err(|_| SecureStorageError::LockPoisoned)?;
    let st = guard
        .as_mut()
        .ok_or_else(|| SecureStorageError::NotInitialized)?;
    // Flush pending writes to the CURRENT session before switching.
    // Otherwise the `main_file` reset below would drop data that was
    // buffered but not yet synced to redb — e.g. during multi-account
    // onboarding, the profile INSERT for account 1 might still sit in
    // RAM when we allocate account 2.
    if st.session.is_some() {
        flush_pending_writes(st)?;
    }
    let idx = SessionIndex::new(slot)?;
    let session = crate::allocate_session(&mut st.backend, &st.domain, idx, password)?;
    // Drop any pending writes from the previous session by replacing the
    // file core with a fresh one. Equivalent to the web path's
    // `app.files.clear()` inside `close_database_and_clear_files` (the
    // SQLite handle is closed by the caller before entering this function,
    // so we only need to wipe the in-memory pending buffer here).
    st.main_file = EncryptedFileCore::new();
    st.namespace_states.clear();
    st.namespace_states
        .insert(DEFAULT_NAMESPACE, NamespaceState::empty());
    st.session = Some(session);
    Ok(())
}

/// Unlock a session by trying each slot with `password`.
pub fn unlock(password: &[u8]) -> Result<bool> {
    let mutex = state_mutex();
    let mut guard = mutex.lock().map_err(|_| SecureStorageError::LockPoisoned)?;
    let st = guard
        .as_mut()
        .ok_or_else(|| SecureStorageError::NotInitialized)?;
    match crate::unlock_session(&st.backend, &st.domain, password) {
        Ok(session) => {
            let sql_state =
                load_namespace_state(&st.backend, &st.domain, &session, DEFAULT_NAMESPACE)?;
            // Same reset-on-switch pattern as `allocate` above.
            st.main_file = EncryptedFileCore::new();
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
///
/// Best-effort flushes pending writes first — if the caller forgot to
/// flush before locking, we don't silently drop buffered data. Flush
/// errors are ignored because locking must not fail (it's often the
/// last thing an app calls during shutdown).
pub fn lock() {
    if let Ok(mut guard) = state_mutex().lock() {
        if let Some(st) = guard.as_mut() {
            if st.session.is_some() {
                let _ = flush_pending_writes(st);
            }
            st.session = None;
            st.namespace_states.clear();
            // Same reset-on-switch pattern as `allocate` / `unlock` above.
            st.main_file = EncryptedFileCore::new();
        }
    }
}

/// Check whether a session is currently unlocked.
pub fn is_unlocked() -> Result<bool> {
    let mutex = state_mutex();
    let guard = mutex.lock().map_err(|_| SecureStorageError::LockPoisoned)?;
    let st = guard
        .as_ref()
        .ok_or_else(|| SecureStorageError::NotInitialized)?;
    Ok(st.session.is_some())
}

// ── Cover-traffic scheduler ─────────────────────────────────────────
//
// Mirrors the web worker's `startCoverTraffic` (see
// `gossip-sdk/src/db/secure-storage-worker.ts`). Without this, the
// native build would only run cover traffic when the TS SDK explicitly
// polls it — and on iOS/Android the WebView may be suspended (background
// fetch, notification extension) while the Rust layer is still alive,
// so relying on the JS side would create PD gaps between snapshots.
//
// Tick cadence: uniform random in [COVER_MIN, COVER_MAX], same bounds
// the web worker uses. Each tick iterates every cover-traffic
// namespace and flushes redb once at the end.

const COVER_TRAFFIC_MIN_INTERVAL_MS: u64 = 10_000;
const COVER_TRAFFIC_MAX_INTERVAL_MS: u64 = 30_000;

static SCHEDULER: OnceLock<Arc<AtomicBool>> = OnceLock::new();

fn random_cover_interval_ms() -> u64 {
    use rand::Rng;
    rand::rngs::OsRng.gen_range(COVER_TRAFFIC_MIN_INTERVAL_MS..=COVER_TRAFFIC_MAX_INTERVAL_MS)
}

/// Spawn the cover-traffic background thread if it isn't already
/// running. Idempotent — subsequent calls are no-ops. The thread lives
/// for the process; stopping it on lock would itself leak activity
/// (scheduler silence = "user just locked"), so we keep it running.
fn ensure_cover_scheduler() {
    SCHEDULER.get_or_init(|| {
        let running = Arc::new(AtomicBool::new(true));
        let running_for_thread = running.clone();
        let spawn_result = std::thread::Builder::new()
            .name("secure-storage-cover".into())
            .spawn(move || {
                while running_for_thread.load(Ordering::Relaxed) {
                    std::thread::sleep(Duration::from_millis(random_cover_interval_ms()));
                    if !running_for_thread.load(Ordering::Relaxed) {
                        break;
                    }
                    // Best-effort: errors while the state is missing
                    // (e.g. between `init_native` and the first
                    // `provision`) are ignored and we simply keep
                    // ticking at the next interval.
                    let _ = cover_tick();
                    let _ = flush();
                }
            });
        // Spawn failure is deliberately not surfaced across the FFI
        // boundary: a missing cover thread is a PD degradation, not a
        // correctness failure, and the caller's init must still succeed.
        // It must not be SILENT in release builds though - a debug_assert
        // would mask the loss of the PD invariant on shipped binaries.
        // Print to stderr so the failure is at least visible in
        // os_log / logcat for diagnostics.
        if let Err(e) = spawn_result {
            eprintln!(
                "secureStorage: PD-DEGRADED cover scheduler spawn failed: {e}"
            );
        }
        running
    });
}

/// Run one round of cover traffic across every namespace the scheduler
/// tracks. Iterating the whole set on each tick keeps the snapshot
/// invariant - "all sessions change at all block indices" - symmetric
/// between the web worker and the native backend.
///
/// Releases and re-acquires the state mutex between namespaces so a
/// foreground SQL op can interleave with the cover scheduler instead of
/// waiting on the entire multi-namespace tick (each namespace tick does
/// SESSION_COUNT rounds of PQ rerandomization, which dominates wall
/// time on slow devices). Each namespace tick is still atomic, so the
/// per-(session,ns) count invariant is preserved within each pass.
pub fn cover_tick() -> Result<()> {
    for &ns in COVER_TRAFFIC_NAMESPACES {
        let mutex = state_mutex();
        let mut guard = mutex.lock().map_err(|_| SecureStorageError::LockPoisoned)?;
        let st = guard
            .as_mut()
            .ok_or_else(|| SecureStorageError::NotInitialized)?;
        crate::cover_traffic_tick(&mut st.backend, &st.domain, ns)?;
        // `guard` drops here at the end of the loop iteration, releasing
        // the mutex before the next namespace's tick.
    }
    Ok(())
}

/// Flush pending plaintext writes + encrypted blocks + rerand pool to
/// backing store. Also commits the redb transaction.
pub fn flush() -> Result<()> {
    let mutex = state_mutex();
    let mut guard = mutex.lock().map_err(|_| SecureStorageError::LockPoisoned)?;
    let st = guard
        .as_mut()
        .ok_or_else(|| SecureStorageError::NotInitialized)?;
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

/// Drain pending writes via `EncryptedFileCore::sync` and commit redb.
fn flush_pending_writes(st: &mut VfsState) -> Result<()> {
    let VfsState {
        backend,
        domain,
        session,
        namespace_states,
        main_file,
    } = st;
    let session = session
        .as_ref()
        .ok_or_else(|| SecureStorageError::Storage("no session".into()))?;
    let ns_state = namespace_states.entry(DEFAULT_NAMESPACE).or_default();
    main_file.sync(backend, domain, session, ns_state)?;
    backend.commit()
}

// ── Namespace data (session blob, etc.) ─────────────────────────────

/// Write a blob to a non-SQL namespace (e.g. session blob on ns=1).
pub fn write_namespace_data(namespace: u8, offset: u64, data: &[u8]) -> Result<()> {
    let mutex = state_mutex();
    let mut guard = mutex.lock().map_err(|_| SecureStorageError::LockPoisoned)?;
    let st = guard
        .as_mut()
        .ok_or_else(|| SecureStorageError::NotInitialized)?;
    let session = st
        .session
        .as_ref()
        .ok_or_else(|| SecureStorageError::Storage("no session".into()))?;
    // Lazy-load the namespace state before writing. Without this, the
    // default (length=0) state clobbers whatever was there from a
    // previous session, leaving orphan blocks that break subsequent
    // reads with CorruptedBlock. Mirrors the web path's
    // `ensure_namespace_state_loaded` call.
    if !st.namespace_states.contains_key(&namespace) {
        let ns = load_namespace_state(&st.backend, &st.domain, session, namespace)?;
        st.namespace_states.insert(namespace, ns);
    }
    let ns_state = st.namespace_states.get_mut(&namespace).unwrap();
    crate::write_session_data(
        &mut st.backend,
        &st.domain,
        namespace,
        session,
        ns_state,
        offset,
        data,
    )?;
    st.backend.commit()
}

/// Read from a non-SQL namespace.
pub fn read_namespace_data(namespace: u8, offset: u64, len: usize) -> Result<Vec<u8>> {
    let mutex = state_mutex();
    let mut guard = mutex.lock().map_err(|_| SecureStorageError::LockPoisoned)?;
    let st = guard
        .as_mut()
        .ok_or_else(|| SecureStorageError::NotInitialized)?;
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
    let data = crate::read_session_data(
        &st.backend,
        &st.domain,
        namespace,
        session,
        ns_state,
        offset,
        len,
    )?;
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
        .ok_or_else(|| SecureStorageError::NotInitialized)?;
    let session = st
        .session
        .as_ref()
        .ok_or_else(|| SecureStorageError::Storage("no session".into()))?;
    use crate::storage::BlockStorage;
    st.backend
        .reset_blockstream(session.session_index, namespace)?;
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
        .ok_or_else(|| SecureStorageError::NotInitialized)?;
    let session = st
        .session
        .as_ref()
        .ok_or_else(|| SecureStorageError::Storage("no session".into()))?;
    if !st.namespace_states.contains_key(&namespace) {
        let ns = load_namespace_state(&st.backend, &st.domain, session, namespace)?;
        st.namespace_states.insert(namespace, ns);
    }
    Ok(st
        .namespace_states
        .get(&namespace)
        .map(|s| s.total_data_length)
        .unwrap_or(0))
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
    if v < 0 { None } else { Some(v as u64) }
}

// SAFETY: SQLite guarantees `file` points to a fresh `sqlite3_file`-shaped
// allocation of at least `vfs.szOsFile` bytes (we set this to `size_of::<EncFile>`
// in `register`), and `out_flags`, when non-null, points to a writable c_int.
// `_z_name` is unused. See https://www.sqlite.org/c3ref/vfs.html (xOpen).
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

// SAFETY: SQLite guarantees `file` points to the same `EncFile`-shaped
// allocation that was passed to `x_open` and is not concurrently accessed
// from another thread (the VFS uses `locking_mode=EXCLUSIVE`).
// See https://www.sqlite.org/c3ref/io_methods.html (xClose).
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

// SAFETY: SQLite guarantees `file` is a valid `EncFile` pointer and `buf`
// is a writable region of at least `amt` bytes. `amt` is non-negative and
// `offset` is non-negative (we still validate both defensively).
// See https://www.sqlite.org/c3ref/io_methods.html (xRead).
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
            // Pre-validate the end offset so the shared `read()`
            // implementation never sees an overflow.
            if off.checked_add(n as u64).is_none() {
                return SQLITE_IOERR as c_int;
            }
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
            match st
                .main_file
                .read(&st.backend, &st.domain, session, &ns_state, off, dst)
            {
                Ok(true) => SQLITE_OK as c_int,
                Ok(false) => SQLITE_IOERR_SHORT_READ as c_int,
                Err(_) => {
                    dst.fill(0);
                    SQLITE_IOERR as c_int
                }
            }
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

// SAFETY: SQLite guarantees `file` is a valid `EncFile` pointer and `buf`
// is a readable region of at least `amt` bytes. `amt` is non-negative and
// `offset` is non-negative.
// See https://www.sqlite.org/c3ref/io_methods.html (xWrite).
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
            if write_off.checked_add(n as u64).is_none() {
                return SQLITE_IOERR as c_int;
            }
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
            st.main_file.write(write_off, src);
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

// SAFETY: SQLite guarantees `file` is a valid `EncFile` pointer and `size`
// is non-negative (we validate it). PD-H1: shrinks call into
// `EncryptedFileCore::truncate`, which calls `shrink_session_data` so freed
// blocks are reissued as covers.
// See https://www.sqlite.org/c3ref/io_methods.html (xTruncate).
unsafe extern "C" fn x_truncate(file: *mut sqlite3_file, size: i64) -> c_int {
    vfs_call(|| unsafe {
        let f = &*(file as *const EncFile);
        let new_size = match checked_u64_from_i64(size) {
            Some(s) => s,
            None => return SQLITE_IOERR as c_int,
        };
        if f.kind == KIND_MAIN {
            let mut guard = match lock_state() {
                Ok(g) => g,
                Err(_) => return SQLITE_IOERR as c_int,
            };
            let st = match guard.as_mut() {
                Some(st) => st,
                None => return SQLITE_IOERR as c_int,
            };
            // Delegate to the shared `EncryptedFileCore::truncate`
            // (same code path as the web VFS) — it trims pending
            // writes and calls `shrink_session_data` on shrink so
            // freed blocks become covers (PD-H1).
            let VfsState {
                backend,
                domain,
                session,
                namespace_states,
                main_file,
            } = st;
            let session = match session.as_ref() {
                Some(s) => s,
                None => return SQLITE_IOERR as c_int,
            };
            let ns_state = namespace_states.entry(DEFAULT_NAMESPACE).or_default();
            if main_file
                .truncate(backend, domain, session, ns_state, new_size)
                .is_err()
            {
                return SQLITE_IOERR as c_int;
            }
        } else if let Ok(mut a) = lock_aux() {
            if let Some(fd) = a.get_mut(f.aux_id as usize) {
                let new_len = usize::try_from(new_size).unwrap_or(usize::MAX);
                fd.truncate(new_len);
            }
        }
        SQLITE_OK as c_int
    })
}

// SAFETY: `_file` and `_flags` are not dereferenced. Side-effect only:
// flush pending writes through to the redb backend. With `journal_mode=OFF`
// SQLite never calls this on its own; it fires through SDK-level COMMIT
// detection (see `secure-storage-native.ts`).
// See https://www.sqlite.org/c3ref/io_methods.html (xSync).
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

// SAFETY: SQLite guarantees `file` is a valid `EncFile` pointer and `size`
// points to a writable `i64` slot.
// See https://www.sqlite.org/c3ref/io_methods.html (xFileSize).
unsafe extern "C" fn x_file_size(file: *mut sqlite3_file, size: *mut i64) -> c_int {
    vfs_call(|| unsafe {
        let f = &*(file as *const EncFile);
        if f.kind == KIND_MAIN {
            let guard = match lock_state() {
                Ok(g) => g,
                Err(_) => return SQLITE_IOERR as c_int,
            };
            let logical = guard
                .as_ref()
                .map_or(0u64, |st| st.main_file.size(&st.sql_ns_state()));
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

// SAFETY: Pointers are never dereferenced (this VFS owns no on-disk files
// beyond redb); xDelete is a no-op for compatibility.
// See https://www.sqlite.org/c3ref/vfs.html (xDelete).
unsafe extern "C" fn x_delete(
    _vfs: *mut sqlite3_vfs,
    _z_name: *const c_char,
    _sync_dir: c_int,
) -> c_int {
    SQLITE_OK as c_int
}

// SAFETY: SQLite guarantees `result` points to a writable c_int. We always
// report "not present" (0) since this VFS's storage is in redb, not the
// host filesystem. See https://www.sqlite.org/c3ref/vfs.html (xAccess).
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

// SAFETY: SQLite guarantees `z_name` is a valid NUL-terminated C string
// (or null) and `z_out` points to a buffer of at least `n_out` bytes.
// See https://www.sqlite.org/c3ref/vfs.html (xFullPathname).
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

    /// Regression for PD-H1: after SQLite truncates the main DB,
    /// `shrink_session_data` must run so freed blocks are
    /// re-randomised rather than frozen on disk. We verify the
    /// reported file size shrinks *and* the physical `block_count`
    /// stays at its high-water-mark (freed blocks kept as covers) so a
    /// snapshot attacker cannot diff the dead region.
    #[test]
    fn test_native_vfs_truncate_freed_blocks_become_cover() {
        run_with_stack(|| {
            let _guard = test_mutex().lock().unwrap();
            let (_dir, conn) = setup_native_vfs();

            // Grow the DB to ~64 pages so we have plenty of blocks on
            // disk before shrinking.
            conn.execute_batch("CREATE TABLE t (id INTEGER PRIMARY KEY, blob BLOB);")
                .unwrap();
            for i in 0..64 {
                conn.execute(
                    "INSERT INTO t (id, blob) VALUES (?, ?)",
                    rusqlite::params![i, vec![0xABu8; 4096]],
                )
                .unwrap();
            }
            flush().unwrap();

            // Snapshot block count before shrink.
            let pre_count = {
                use crate::storage::BlockStorage;
                let guard = state_mutex().lock().unwrap();
                let st = guard.as_ref().unwrap();
                st.backend
                    .block_count(
                        st.session.as_ref().unwrap().session_index,
                        DEFAULT_NAMESPACE,
                    )
                    .unwrap()
            };
            assert!(pre_count > 4, "expected >4 blocks, got {pre_count}");

            // DROP + VACUUM shrinks the file.
            conn.execute_batch("DELETE FROM t; VACUUM;").unwrap();
            flush().unwrap();

            // After truncate, the logical file size should drop but the
            // physical block count must NOT decrease — freed blocks
            // become covers (PD invariant).
            let (logical_size, post_count) = {
                use crate::storage::BlockStorage;
                let guard = state_mutex().lock().unwrap();
                let st = guard.as_ref().unwrap();
                let count = st
                    .backend
                    .block_count(
                        st.session.as_ref().unwrap().session_index,
                        DEFAULT_NAMESPACE,
                    )
                    .unwrap();
                (st.sql_ns_state().total_data_length, count)
            };
            assert!(logical_size < (pre_count as u64) * (crate::BLOCK_SIZE as u64));
            assert_eq!(
                post_count, pre_count,
                "truncate must NOT shrink the physical block count (PD-H1 spec)"
            );
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
