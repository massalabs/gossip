//! Custom SQLite VFS implementation for sqlite-wasm-rs that routes the main
//! database file through the encrypted block storage layer.
//!
//! Implements the rsqlite-vfs traits (`VfsFile`, `VfsStore`, `SQLiteIoMethods`,
//! `SQLiteVfs`). The main DB file is encrypted via [`EncryptedFileCore`] and
//! persisted to IndexedDB via [`IdbBlockStorage`]; temp files are kept in
//! memory via the upstream [`MemChunksFile`] helper.
//!
//! Read/write/sync/truncate/file_size require access to the unlocked session
//! and the IDB-backed backend, both of which live alongside the open file
//! map inside [`AppState`]. The four io_methods extern shims that need state
//! are overridden in [`EncryptedIoMethods`] so they can borrow the state
//! and the file separately (each behind its own `RefCell`).

use std::cell::RefCell;
use std::collections::HashMap;
use std::ffi::c_int;
use std::marker::PhantomData;
use std::time::Duration;

use sqlite_wasm_rs::utils::ffi::{
    SQLITE_IOERR, SQLITE_IOERR_SHORT_READ, SQLITE_OK, SQLITE_OPEN_MAIN_DB, sqlite3_file,
    sqlite3_int64, sqlite3_vfs,
};
use sqlite_wasm_rs::utils::{
    MemChunksFile, OsCallback, SQLiteIoMethods, SQLiteVfs, SQLiteVfsFile, VfsAppData, VfsError,
    VfsFile, VfsResult, VfsStore,
};

use crate::BLOCK_SIZE;
use crate::DEFAULT_NAMESPACE;
use crate::storage::{BlockStorage, KeypairStorage, MemoryStorage};
use crate::types::SessionIndex;
use crate::unlock::{NamespaceState, UnlockedSession};
use crate::vfs::file_core::EncryptedFileCore;
use crate::vfs::idb_storage::IdbBlockStorage;

// ── Backend ────────────────────────────────────────────────────────

/// Backend used by the encrypted VFS. `Memory` is for tests, `Idb` for the
/// production WASM path.
pub enum Backend {
    Memory(MemoryStorage),
    Idb(IdbBlockStorage),
}

impl BlockStorage for Backend {
    fn read_block(
        &self,
        session: SessionIndex,
        namespace: u8,
        block: u64,
    ) -> crate::error::Result<Box<[u8; BLOCK_SIZE]>> {
        match self {
            Backend::Memory(s) => s.read_block(session, namespace, block),
            Backend::Idb(s) => s.read_block(session, namespace, block),
        }
    }
    fn write_block(
        &mut self,
        session: SessionIndex,
        namespace: u8,
        block: u64,
        data: &[u8; BLOCK_SIZE],
    ) -> crate::error::Result<()> {
        match self {
            Backend::Memory(s) => s.write_block(session, namespace, block, data),
            Backend::Idb(s) => s.write_block(session, namespace, block, data),
        }
    }
    fn append_block(
        &mut self,
        session: SessionIndex,
        namespace: u8,
        data: &[u8; BLOCK_SIZE],
    ) -> crate::error::Result<()> {
        match self {
            Backend::Memory(s) => s.append_block(session, namespace, data),
            Backend::Idb(s) => s.append_block(session, namespace, data),
        }
    }
    fn block_count(&self, session: SessionIndex, namespace: u8) -> crate::error::Result<u64> {
        match self {
            Backend::Memory(s) => s.block_count(session, namespace),
            Backend::Idb(s) => s.block_count(session, namespace),
        }
    }
    fn fsync(&self, session: SessionIndex, namespace: u8) -> crate::error::Result<()> {
        match self {
            Backend::Memory(s) => s.fsync(session, namespace),
            Backend::Idb(s) => s.fsync(session, namespace),
        }
    }
    fn reset_blockstream(
        &mut self,
        session: SessionIndex,
        namespace: u8,
    ) -> crate::error::Result<()> {
        match self {
            Backend::Memory(s) => s.reset_blockstream(session, namespace),
            Backend::Idb(s) => s.reset_blockstream(session, namespace),
        }
    }
}

impl KeypairStorage for Backend {
    fn read_keypair(
        &self,
        session: SessionIndex,
    ) -> crate::error::Result<zeroize::Zeroizing<Vec<u8>>> {
        match self {
            Backend::Memory(s) => s.read_keypair(session),
            Backend::Idb(s) => s.read_keypair(session),
        }
    }
    fn write_keypair(&mut self, session: SessionIndex, data: &[u8]) -> crate::error::Result<()> {
        match self {
            Backend::Memory(s) => s.write_keypair(session, data),
            Backend::Idb(s) => s.write_keypair(session, data),
        }
    }
}

// ── App state ──────────────────────────────────────────────────────

/// Shared encryption state, owned by the VFS app data and accessed by the
/// io_methods overrides via a separate `RefCell` from the file map.
///
/// `namespace_states` is keyed by `namespace: u8` and lazy-populated. The
/// SQLite VFS overrides borrow the entry for [`DEFAULT_NAMESPACE`] when reading
/// or writing the main DB; other namespaces are touched only via the
/// `*NamespaceData` exports in `wasm_api`.
pub struct EncryptionState {
    pub(crate) backend: Backend,
    pub(crate) session: Option<UnlockedSession>,
    pub(crate) namespace_states: HashMap<u8, NamespaceState>,
    pub(crate) domain: String,
}

/// Files opened by SQLite. We expect at most one main DB plus a few temp
/// files for journals/sorters.
pub enum SqlFile {
    /// Main encrypted DB. Pending writes buffered in `EncryptedFileCore`,
    /// flushed on `xSync` through pq-rerand encryption to the backend.
    Main(EncryptedFileCore),
    /// Temp/journal/etc. — plaintext, lives only in memory for the session.
    Temp(MemChunksFile),
}

impl SqlFile {
    fn new(flags: i32) -> Self {
        if flags & SQLITE_OPEN_MAIN_DB != 0 {
            SqlFile::Main(EncryptedFileCore::new())
        } else {
            SqlFile::Temp(MemChunksFile::default())
        }
    }
}

/// VFS application data: the open file map and the encryption state, behind
/// independent `RefCell`s so the io_methods overrides can borrow them at the
/// same time without nested-borrow panics.
pub struct AppState {
    pub files: RefCell<HashMap<String, SqlFile>>,
    pub state: RefCell<EncryptionState>,
}

impl AppState {
    pub fn new(backend: Backend, domain: String) -> Self {
        Self {
            files: RefCell::new(HashMap::new()),
            state: RefCell::new(EncryptionState {
                backend,
                session: None,
                namespace_states: HashMap::new(),
                domain,
            }),
        }
    }
}

// ── Safe FFI helpers (concentrate `unsafe` here, callers stay safe) ─
//
// Every raw-pointer dereference required by the rsqlite-vfs C interface is
// wrapped in a private function below. Each helper documents the soundness
// contract that holds because it is *only* called from inside one of our
// io-method callbacks (which SQLite invokes with valid pointers).
//
// Module visibility (these are not `pub`) is the soundness boundary: callers
// outside this module cannot reach them, so the contract cannot be violated
// from elsewhere. Override bodies and store impl methods then look like
// ordinary safe Rust.

/// Per-callback context: the leaked `VfsAppData<AppState>` wrapper (for
/// `store_err`), the deref'd `AppState` (for our own logic), and the file
/// name, all extracted from the raw `sqlite3_file*` SQLite passes to every
/// io method.
struct VfsCtx {
    wrapped: &'static VfsAppData<AppState>,
    app_data: &'static AppState,
    name: &'static str,
}

impl VfsCtx {
    /// Soundness: `p_file` is the `sqlite3_file*` SQLite passes into one of
    /// our io_methods callbacks. SQLite only passes pointers to files we
    /// opened via `xOpen`, so:
    ///   * `SQLiteVfsFile::from_file` casts a valid `sqlite3_file*` to a
    ///     `&'static SQLiteVfsFile` (rsqlite-vfs guarantees the layout).
    ///   * `name_ptr`/`name_length` are populated by `xOpen` via `Box::leak`
    ///     and live until `xClose` calls `Box::from_raw` on them.
    ///   * `pAppData` is set by our `register_vfs` call to a leaked
    ///     `VfsAppData<AppState>` that lives for the program lifetime.
    fn from_file(p_file: *mut sqlite3_file) -> Self {
        // SAFETY: documented above. Single-threaded WASM rules out tearing.
        unsafe {
            let vfs_file = SQLiteVfsFile::from_file(p_file);
            let wrapped = <EncryptedStore as VfsStore<SqlFile, AppState>>::app_data(vfs_file.vfs);
            VfsCtx {
                wrapped,
                app_data: &**wrapped,
                name: vfs_file.name(),
            }
        }
    }

    fn store_err(&self, err: VfsError) -> c_int {
        self.wrapped.store_err(err)
    }
}

/// Build a mutable byte slice from a SQLite-supplied `void*` + length.
///
/// Soundness: only ever called with the `(zBuf, iAmt)` pair SQLite passes to
/// `xRead`, which it guarantees to be a writable buffer of at least `iAmt`
/// bytes valid until the call returns.
fn read_buffer<'a>(ptr: *mut core::ffi::c_void, len: c_int) -> &'a mut [u8] {
    debug_assert!(len >= 0, "SQLite passed negative iAmt to xRead");
    let len = len.max(0) as usize;
    // SAFETY: documented above.
    unsafe { core::slice::from_raw_parts_mut(ptr.cast::<u8>(), len) }
}

/// Write a 64-bit size through a SQLite-supplied output pointer.
///
/// Soundness: only ever called with the `pSize` pointer SQLite passes to
/// `xFileSize`, which it guarantees to be a writable `sqlite3_int64*`.
fn write_size(out: *mut sqlite3_int64, value: usize) {
    // SAFETY: documented above. On WASM32, usize fits in i64.
    unsafe { *out = sqlite3_int64::try_from(value).unwrap_or(sqlite3_int64::MAX) }
}

/// Resolve `pAppData` to our `&'static AppState` for the safe store callbacks.
///
/// Soundness: only ever called from inside one of the `VfsStore` trait
/// methods, which SQLite (via the default `xOpen`/`xAccess`/`xDelete` shims
/// in rsqlite-vfs) invokes with the same `vfs` pointer we registered, whose
/// `pAppData` is a leaked `VfsAppData<AppState>`.
fn store_app_data(vfs: *mut sqlite3_vfs) -> &'static AppState {
    // SAFETY: documented above.
    unsafe {
        let wrapped = <EncryptedStore as VfsStore<SqlFile, AppState>>::app_data(vfs);
        &**wrapped
    }
}

/// Resolve the file name for a `with_file*` callback.
///
/// Soundness: only ever called from inside one of the `VfsStore::with_file*`
/// trait methods, which receive a `SQLiteVfsFile` whose `name_ptr` was set
/// by our `xOpen` via `Box::leak`.
fn store_name(vfs_file: &SQLiteVfsFile) -> &'static str {
    // SAFETY: documented above.
    unsafe { vfs_file.name() }
}

// ── VfsFile ────────────────────────────────────────────────────────

impl VfsFile for SqlFile {
    fn read(&self, buf: &mut [u8], offset: usize) -> VfsResult<bool> {
        match self {
            SqlFile::Temp(f) => f.read(buf, offset),
            SqlFile::Main(_) => {
                // Main file reads are handled by the EncryptedIoMethods xRead
                // override (which has access to the encryption state). This
                // path should not be reached via the default shim.
                Err(VfsError::new(
                    SQLITE_IOERR,
                    "main file read must go through xRead override".into(),
                ))
            }
        }
    }

    fn write(&mut self, buf: &[u8], offset: usize) -> VfsResult<()> {
        match self {
            SqlFile::Temp(f) => f.write(buf, offset),
            SqlFile::Main(core) => {
                // Buffer the write; the actual encryption happens at xSync.
                core.write(offset as u64, buf);
                Ok(())
            }
        }
    }

    fn truncate(&mut self, size: usize) -> VfsResult<()> {
        match self {
            SqlFile::Temp(f) => f.truncate(size),
            SqlFile::Main(_) => Err(VfsError::new(
                SQLITE_IOERR,
                "main file truncate must go through xTruncate override".into(),
            )),
        }
    }

    fn flush(&mut self) -> VfsResult<()> {
        match self {
            SqlFile::Temp(f) => f.flush(),
            SqlFile::Main(_) => Err(VfsError::new(
                SQLITE_IOERR,
                "main file sync must go through xSync override".into(),
            )),
        }
    }

    fn size(&self) -> VfsResult<usize> {
        match self {
            SqlFile::Temp(f) => f.size(),
            SqlFile::Main(_) => Err(VfsError::new(
                SQLITE_IOERR,
                "main file size must go through xFileSize override".into(),
            )),
        }
    }
}

// ── VfsStore ───────────────────────────────────────────────────────

#[derive(Copy, Clone, Default)]
pub struct EncryptedStore;

impl VfsStore<SqlFile, AppState> for EncryptedStore {
    fn add_file(vfs: *mut sqlite3_vfs, file: &str, flags: i32) -> VfsResult<()> {
        store_app_data(vfs)
            .files
            .borrow_mut()
            .insert(file.into(), SqlFile::new(flags));
        Ok(())
    }

    fn contains_file(vfs: *mut sqlite3_vfs, file: &str) -> VfsResult<bool> {
        Ok(store_app_data(vfs).files.borrow().contains_key(file))
    }

    fn delete_file(vfs: *mut sqlite3_vfs, file: &str) -> VfsResult<()> {
        if store_app_data(vfs)
            .files
            .borrow_mut()
            .remove(file)
            .is_none()
        {
            return Err(VfsError::new(SQLITE_IOERR, format!("{file} not found")));
        }
        Ok(())
    }

    fn with_file<F: Fn(&SqlFile) -> VfsResult<i32>>(
        vfs_file: &SQLiteVfsFile,
        f: F,
    ) -> VfsResult<i32> {
        let name = store_name(vfs_file);
        let app_data = store_app_data(vfs_file.vfs);
        match app_data.files.borrow().get(name) {
            Some(file) => f(file),
            None => Err(VfsError::new(SQLITE_IOERR, format!("{name} not found"))),
        }
    }

    fn with_file_mut<F: Fn(&mut SqlFile) -> VfsResult<i32>>(
        vfs_file: &SQLiteVfsFile,
        f: F,
    ) -> VfsResult<i32> {
        let name = store_name(vfs_file);
        let app_data = store_app_data(vfs_file.vfs);
        match app_data.files.borrow_mut().get_mut(name) {
            Some(file) => f(file),
            None => Err(VfsError::new(SQLITE_IOERR, format!("{name} not found"))),
        }
    }
}

// ── SQLiteIoMethods (with overrides for state-needing ops) ─────────

#[derive(Copy, Clone, Default)]
pub struct EncryptedIoMethods;

impl SQLiteIoMethods for EncryptedIoMethods {
    type File = SqlFile;
    type AppData = AppState;
    type Store = EncryptedStore;

    const VERSION: c_int = 1;

    /// Override `xRead`: main DB reads must consult the encryption state.
    unsafe extern "C" fn xRead(
        p_file: *mut sqlite3_file,
        z_buf: *mut core::ffi::c_void,
        i_amt: c_int,
        i_ofst: sqlite3_int64,
    ) -> c_int {
        let ctx = VfsCtx::from_file(p_file);
        let buf = read_buffer(z_buf, i_amt);
        let result = read_main_or_temp(ctx.app_data, ctx.name, i_ofst as u64, buf);
        match result {
            Ok(code) => code,
            Err(err) => ctx.store_err(err),
        }
    }

    /// Override `xSync`: main DB flush encrypts pending writes.
    unsafe extern "C" fn xSync(p_file: *mut sqlite3_file, _flags: c_int) -> c_int {
        let ctx = VfsCtx::from_file(p_file);
        let result = sync_main_or_temp(ctx.app_data, ctx.name);
        match result {
            Ok(code) => code,
            Err(err) => ctx.store_err(err),
        }
    }

    /// Override `xTruncate`: main DB truncate may shrink encrypted blocks.
    unsafe extern "C" fn xTruncate(p_file: *mut sqlite3_file, size: sqlite3_int64) -> c_int {
        let ctx = VfsCtx::from_file(p_file);
        let result = truncate_main_or_temp(ctx.app_data, ctx.name, size as u64);
        match result {
            Ok(code) => code,
            Err(err) => ctx.store_err(err),
        }
    }

    /// Override `xFileSize`: main DB size depends on session metadata.
    unsafe extern "C" fn xFileSize(p_file: *mut sqlite3_file, p_size: *mut sqlite3_int64) -> c_int {
        let ctx = VfsCtx::from_file(p_file);
        let result = file_size_main_or_temp(ctx.app_data, ctx.name);
        match result {
            Ok(size) => {
                write_size(p_size, size);
                SQLITE_OK
            }
            Err(err) => ctx.store_err(err),
        }
    }
}

// ── Override bodies (safe Rust, no raw pointers) ───────────────────

fn read_main_or_temp(
    app_data: &AppState,
    name: &str,
    offset: u64,
    buf: &mut [u8],
) -> VfsResult<i32> {
    let files = app_data.files.borrow();
    let file = files
        .get(name)
        .ok_or_else(|| VfsError::new(SQLITE_IOERR, format!("{name} not found")))?;
    match file {
        SqlFile::Temp(temp) => Ok(if temp.read(buf, offset as usize)? {
            SQLITE_OK
        } else {
            SQLITE_IOERR_SHORT_READ
        }),
        SqlFile::Main(core) => {
            let state = app_data.state.borrow();
            let session = state
                .session
                .as_ref()
                .ok_or_else(|| VfsError::new(SQLITE_IOERR, "session not unlocked".into()))?;
            let ns_state = state
                .namespace_states
                .get(&DEFAULT_NAMESPACE)
                .copied()
                .unwrap_or_default();
            let full = core
                .read(
                    &state.backend,
                    &state.domain,
                    session,
                    &ns_state,
                    offset,
                    buf,
                )
                .map_err(|e| VfsError::new(SQLITE_IOERR, e.to_string()))?;
            Ok(if full {
                SQLITE_OK
            } else {
                SQLITE_IOERR_SHORT_READ
            })
        }
    }
}

fn sync_main_or_temp(app_data: &AppState, name: &str) -> VfsResult<i32> {
    let mut files = app_data.files.borrow_mut();
    let file = files
        .get_mut(name)
        .ok_or_else(|| VfsError::new(SQLITE_IOERR, format!("{name} not found")))?;
    match file {
        SqlFile::Temp(_) => Ok(SQLITE_OK),
        SqlFile::Main(core) => {
            let mut state = app_data.state.borrow_mut();
            // Split borrows: we need a &mut to backend and to the SQL
            // namespace state simultaneously, but the session is &.
            let EncryptionState {
                backend,
                session,
                namespace_states,
                domain,
            } = &mut *state;
            let session = session
                .as_ref()
                .ok_or_else(|| VfsError::new(SQLITE_IOERR, "session not unlocked".into()))?;
            let ns_state = namespace_states.entry(DEFAULT_NAMESPACE).or_default();
            core.sync(backend, domain, session, ns_state)
                .map_err(|e| VfsError::new(SQLITE_IOERR, e.to_string()))?;
            Ok(SQLITE_OK)
        }
    }
}

fn truncate_main_or_temp(app_data: &AppState, name: &str, new_size: u64) -> VfsResult<i32> {
    let mut files = app_data.files.borrow_mut();
    let file = files
        .get_mut(name)
        .ok_or_else(|| VfsError::new(SQLITE_IOERR, format!("{name} not found")))?;
    match file {
        SqlFile::Temp(temp) => {
            temp.truncate(new_size as usize)?;
            Ok(SQLITE_OK)
        }
        SqlFile::Main(core) => {
            let mut state = app_data.state.borrow_mut();
            let EncryptionState {
                backend,
                session,
                namespace_states,
                domain,
            } = &mut *state;
            let session = session
                .as_ref()
                .ok_or_else(|| VfsError::new(SQLITE_IOERR, "session not unlocked".into()))?;
            let ns_state = namespace_states.entry(DEFAULT_NAMESPACE).or_default();
            core.truncate(backend, domain, session, ns_state, new_size)
                .map_err(|e| VfsError::new(SQLITE_IOERR, e.to_string()))?;
            Ok(SQLITE_OK)
        }
    }
}

fn file_size_main_or_temp(app_data: &AppState, name: &str) -> VfsResult<usize> {
    let files = app_data.files.borrow();
    let file = files
        .get(name)
        .ok_or_else(|| VfsError::new(SQLITE_IOERR, format!("{name} not found")))?;
    match file {
        SqlFile::Temp(temp) => temp.size(),
        SqlFile::Main(core) => {
            let state = app_data.state.borrow();
            let _session = state
                .session
                .as_ref()
                .ok_or_else(|| VfsError::new(SQLITE_IOERR, "session not unlocked".into()))?;
            let ns_state = state
                .namespace_states
                .get(&DEFAULT_NAMESPACE)
                .copied()
                .unwrap_or_default();
            Ok(core.size(&ns_state) as usize)
        }
    }
}

// ── SQLiteVfs ──────────────────────────────────────────────────────

#[derive(Clone, Copy, Default)]
pub struct EncryptedVfs<C>(PhantomData<C>);

impl<C: OsCallback> SQLiteVfs<EncryptedIoMethods> for EncryptedVfs<C> {
    const VERSION: c_int = 1;

    fn sleep(dur: Duration) {
        C::sleep(dur);
    }

    fn random(buf: &mut [u8]) {
        C::random(buf);
    }

    fn epoch_timestamp_in_ms() -> i64 {
        C::epoch_timestamp_in_ms()
    }
}

/// VFS name registered with SQLite.
pub const VFS_NAME: &str = "secure-storage-enc";
