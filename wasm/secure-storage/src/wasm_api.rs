//! wasm-bindgen exports for secure storage.
//!
//! VFS registration pattern follows sqlite-wasm-rs's official approach:
//! <https://github.com/aspect-build/aspect-cli/tree/main/aspect/workflows/sqlite/sqlite-wasm-vfs/src>
//!
//! Single bridge between the SDK worker and the Rust crate. Two groups:
//!
//!   * **Lifecycle**: `initSecureStorage`, `idbHasData`, `provisionStorage`,
//!     `allocateSession`, `unlockSession`, `lockSession`, `coverTrafficTick`,
//!     `flushEncrypted`, `openDatabase`, `closeDatabase`.
//!   * **SQL exec**: `execSql` runs a single SQL statement against the
//!     embedded sqlite-wasm-rs SQLite, routing main DB I/O through our
//!     custom encrypted VFS (see `vfs::sqlite_vfs`).
//!
//! All raw SQLite C calls are encapsulated in the [`crate::sqlite_handle`]
//! module's RAII wrappers (`SafeDb`, `SafeStmt`); this file uses only safe
//! Rust except for the small block in `with_app_state` that resolves the
//! registered VFS pointer.

use std::cell::RefCell;
use std::ffi::CStr;

use js_sys::{Array, Uint8Array};
use sqlite_wasm_rs::WasmOsCallback;
use sqlite_wasm_rs::utils::{VfsAppData, register_vfs, registered_vfs};
use wasm_bindgen::prelude::*;

// Re-export wasm-bindgen-rayon's `initThreadPool` so it survives DCE and
// shows up in the generated JS bindings. The SDK worker calls it once at
// startup to spin up the rayon Web Worker pool.
#[allow(unused_imports)]
pub use wasm_bindgen_rayon::init_thread_pool;

use crate::DEFAULT_NAMESPACE;
use crate::error::SecureStorageError;
use crate::sqlite_handle::{SafeDb, SafeStmt, SqlResult, SqlValue, StepStatus};
use crate::storage::MemoryStorage;
use crate::types::SessionIndex;
use crate::unlock::{NamespaceState, load_namespace_state};
use crate::vfs::idb_storage::IdbBlockStorage;
use crate::vfs::sqlite_vfs::{AppState, Backend, EncryptedIoMethods, EncryptedVfs, VFS_NAME};

// ── Global state ───────────────────────────────────────────────────

thread_local! {
    /// Pointer to the registered VFS (set in `initSecureStorage`).
    /// `None` until init has been called.
    static VFS_PTR: RefCell<Option<*mut sqlite_wasm_rs::utils::ffi::sqlite3_vfs>> =
        const { RefCell::new(None) };
    /// Open SQLite database handle (RAII — closes on drop).
    static DB: RefCell<Option<SafeDb>> = const { RefCell::new(None) };
}

fn map_err(e: SecureStorageError) -> JsValue {
    JsValue::from_str(&e.to_string())
}

// Shared precision-aware JS `number` <-> Rust integer conversions.
use crate::js_num::{is_js_safe_integer_i64, safe_f64_to_i64, safe_f64_to_u64};

fn not_initialized() -> JsValue {
    JsValue::from_str("secure storage not initialized")
}

/// Resolve the registered VFS pointer to its leaked `&'static AppState`.
///
/// Soundness: only callable after `initSecureStorage` has stored a valid
/// VFS pointer in `VFS_PTR`. The `pAppData` of that VFS was populated by
/// `register_vfs` from a leaked `VfsAppData<AppState>` that lives for the
/// program lifetime.
fn with_app_state<F, R>(f: F) -> Result<R, JsValue>
where
    F: FnOnce(&VfsAppData<AppState>) -> Result<R, JsValue>,
{
    VFS_PTR.with(|p| {
        let p = p.borrow();
        let vfs = p.ok_or_else(not_initialized)?;
        // SAFETY: documented above. Single-threaded WASM rules out tearing.
        let app_data: &VfsAppData<AppState> = unsafe { &*((*vfs).pAppData.cast()) };
        f(app_data)
    })
}

// ── Lifecycle exports ──────────────────────────────────────────────

#[wasm_bindgen(js_name = initSecureStorage)]
pub async fn init_secure_storage(domain: &str, backend: &str) -> Result<(), JsValue> {
    console_error_panic_hook::set_once();

    // Idempotent across hot reloads: if the VFS is already registered,
    // reuse the existing pointer (and the leaked AppState behind it).
    if VFS_PTR.with(|p| p.borrow().is_some()) {
        return Ok(());
    }

    let backend_inst = match backend {
        "memory" => Backend::Memory(MemoryStorage::new()),
        "idb" => Backend::Idb(IdbBlockStorage::open().await?),
        _ => return Err(JsValue::from_str(&format!("unknown backend: {backend}"))),
    };

    let vfs = if let Ok(Some(existing)) = registered_vfs(VFS_NAME) {
        existing
    } else {
        let app_state = AppState::new(backend_inst, domain.to_string());
        register_vfs::<EncryptedIoMethods, EncryptedVfs<WasmOsCallback>>(VFS_NAME, app_state, false)
            .map_err(|e| JsValue::from_str(&format!("register_vfs failed: {e}")))?
    };

    VFS_PTR.with(|p| *p.borrow_mut() = Some(vfs));
    Ok(())
}

#[wasm_bindgen(js_name = idbHasData)]
pub async fn idb_has_data() -> Result<bool, JsValue> {
    IdbBlockStorage::has_data().await
}

#[wasm_bindgen(js_name = provisionStorage)]
pub fn provision_storage() -> Result<(), JsValue> {
    with_app_state(|app| {
        let mut state = app.state.borrow_mut();
        crate::provision_storage(&mut state.backend)
            .map(|_| ())
            .map_err(map_err)
    })
}

#[wasm_bindgen(js_name = allocateSession)]
pub fn allocate_session(slot: u8, password: &[u8]) -> Result<(), JsValue> {
    with_app_state(|app| {
        let mut state = app.state.borrow_mut();
        let idx = SessionIndex::new(slot).map_err(map_err)?;
        let domain = state.domain.clone();
        let session =
            crate::allocate_session(&mut state.backend, &domain, idx, password).map_err(map_err)?;
        state.session = Some(session);
        // allocate_session writes block 0 with length=0 in the default namespace.
        state.namespace_states.clear();
        state
            .namespace_states
            .insert(DEFAULT_NAMESPACE, NamespaceState::empty());
        Ok(())
    })?;
    discard_main_pending()?;
    Ok(())
}

#[wasm_bindgen(js_name = unlockSession)]
pub fn unlock_session(password: &[u8]) -> Result<bool, JsValue> {
    let result = with_app_state(|app| {
        let mut state = app.state.borrow_mut();
        let domain = state.domain.clone();
        match crate::unlock_session(&state.backend, &domain, password) {
            Ok(session) => {
                // Recover total_data_length for the default namespace eagerly so
                // SQLite reads see the right file size before any subsequent
                // namespace activity. Other namespaces are loaded lazily when
                // first accessed by the *NamespaceData exports.
                let sql_state =
                    load_namespace_state(&state.backend, &domain, &session, DEFAULT_NAMESPACE)
                        .map_err(map_err)?;
                state.session = Some(session);
                state.namespace_states.clear();
                state.namespace_states.insert(DEFAULT_NAMESPACE, sql_state);
                Ok(true)
            }
            Err(SecureStorageError::InvalidPassword) => Ok(false),
            Err(e) => Err(map_err(e)),
        }
    })?;
    if result {
        discard_main_pending()?;
    }
    Ok(result)
}

#[wasm_bindgen(js_name = lockSession)]
pub fn lock_session() -> Result<(), JsValue> {
    discard_main_pending()?;
    with_app_state(|app| {
        let mut state = app.state.borrow_mut();
        state.session = None;
        state.namespace_states.clear();
        Ok(())
    })
}

#[wasm_bindgen(js_name = coverTrafficTick)]
pub fn cover_traffic_tick(namespace: u8) -> Result<(), JsValue> {
    with_app_state(|app| {
        let mut state = app.state.borrow_mut();
        let domain = state.domain.clone();
        crate::cover_traffic_tick(&mut state.backend, &domain, namespace).map_err(map_err)
    })
}

// ── Generic namespace data exports ─────────────────────────────────
//
// These let the SDK store arbitrary blobs in any namespace ≠ DEFAULT_NAMESPACE
// (or read what the SQLite VFS persisted). The SDK is responsible for
// choosing namespace bytes (e.g. namespace 1 for the session blob) and
// avoiding conflicts.

fn ensure_namespace_state_loaded(
    state: &mut crate::vfs::sqlite_vfs::EncryptionState,
    namespace: u8,
) -> Result<(), JsValue> {
    if state.namespace_states.contains_key(&namespace) {
        return Ok(());
    }
    let session = state
        .session
        .as_ref()
        .ok_or_else(|| JsValue::from_str("session not unlocked"))?;
    let domain = state.domain.clone();
    let ns_state =
        load_namespace_state(&state.backend, &domain, session, namespace).map_err(map_err)?;
    state.namespace_states.insert(namespace, ns_state);
    Ok(())
}

#[wasm_bindgen(js_name = writeNamespaceData)]
pub fn write_namespace_data(namespace: u8, offset: f64, data: &[u8]) -> Result<(), JsValue> {
    let offset = safe_f64_to_u64(offset).ok_or_else(|| JsValue::from_str("invalid offset"))?;
    with_app_state(|app| {
        let mut state = app.state.borrow_mut();
        ensure_namespace_state_loaded(&mut state, namespace)?;
        let crate::vfs::sqlite_vfs::EncryptionState {
            backend,
            session,
            namespace_states,
            domain,
        } = &mut *state;
        let session = session
            .as_ref()
            .ok_or_else(|| JsValue::from_str("session not unlocked"))?;
        let ns_state = namespace_states.entry(namespace).or_default();
        crate::write_session_data(backend, domain, namespace, session, ns_state, offset, data)
            .map_err(map_err)
    })
}

#[wasm_bindgen(js_name = readNamespaceData)]
pub fn read_namespace_data(namespace: u8, offset: f64, len: usize) -> Result<Vec<u8>, JsValue> {
    let offset = safe_f64_to_u64(offset).ok_or_else(|| JsValue::from_str("invalid offset"))?;
    with_app_state(|app| {
        let mut state = app.state.borrow_mut();
        ensure_namespace_state_loaded(&mut state, namespace)?;
        let session = state
            .session
            .as_ref()
            .ok_or_else(|| JsValue::from_str("session not unlocked"))?;
        let ns_state = state
            .namespace_states
            .get(&namespace)
            .copied()
            .unwrap_or_default();
        let data = crate::read_session_data(
            &state.backend,
            &state.domain,
            namespace,
            session,
            &ns_state,
            offset,
            len,
        )
        .map_err(map_err)?;
        Ok(data.to_vec())
    })
}

#[wasm_bindgen(js_name = namespaceDataLength)]
pub fn namespace_data_length(namespace: u8) -> Result<f64, JsValue> {
    with_app_state(|app| {
        let mut state = app.state.borrow_mut();
        ensure_namespace_state_loaded(&mut state, namespace)?;
        let total = state
            .namespace_states
            .get(&namespace)
            .map(|s| s.total_data_length)
            .unwrap_or(0);
        Ok(total as f64)
    })
}

#[wasm_bindgen(js_name = clearNamespace)]
pub fn clear_namespace(namespace: u8) -> Result<(), JsValue> {
    with_app_state(|app| {
        let mut state = app.state.borrow_mut();
        ensure_namespace_state_loaded(&mut state, namespace)?;
        let crate::vfs::sqlite_vfs::EncryptionState {
            backend,
            session,
            namespace_states,
            domain,
        } = &mut *state;
        let session = session
            .as_ref()
            .ok_or_else(|| JsValue::from_str("session not unlocked"))?;
        let ns_state = namespace_states.entry(namespace).or_default();
        if ns_state.total_data_length > 0 {
            crate::shrink_session_data(backend, domain, namespace, session, ns_state, 0)
                .map_err(map_err)?;
        }
        Ok(())
    })
}

#[wasm_bindgen(js_name = flushEncrypted)]
pub async fn flush_encrypted() -> Result<(), JsValue> {
    // We need a &IdbBlockStorage across the .await of persist_dirty().
    // The IdbBlockStorage lives inside RefCell<EncryptionState>, so we
    // cannot hold a RefCell borrow across .await. Instead we capture a
    // raw pointer under a short borrow.
    //
    // SAFETY INVARIANT: the pointer targets the IdbBlockStorage inside
    // the leaked AppState (program-lifetime, never deallocated). The
    // Backend enum variant is set once in init_secure_storage and never
    // replaced — no code path reassigns or moves the Backend. On
    // single-threaded WASM there is no concurrent mutation; during the
    // .await only JS microtasks run, and none of them replace the
    // Backend.
    //
    // If this invariant is ever broken (e.g. a future "reinit" feature
    // that swaps backends), this code MUST be revisited.
    let idb_ptr: Option<*const IdbBlockStorage> = with_app_state(|app| {
        let state = app.state.borrow();
        Ok(match &state.backend {
            Backend::Idb(idb) => {
                debug_assert!(
                    std::ptr::eq(idb, idb),
                    "Backend::Idb address must be stable"
                );
                Some(idb as *const _)
            }
            Backend::Memory(_) => None,
        })
    })?;

    if let Some(ptr) = idb_ptr {
        // SAFETY: see invariant above.
        unsafe { &*ptr }.persist_dirty().await?;
    }
    Ok(())
}

/// Discard any pending writes on an open main DB file (called when switching
/// sessions). No-op if no main file is open.
fn discard_main_pending() -> Result<(), JsValue> {
    with_app_state(|app| {
        for file in app.files.borrow_mut().values_mut() {
            if let crate::vfs::sqlite_vfs::SqlFile::Main(core) = file {
                core.discard_pending();
            }
        }
        Ok(())
    })
}

// ── Database lifecycle ─────────────────────────────────────────────

const DB_NAME: &CStr = c"secure.db";
const VFS_NAME_C: &CStr = c"secure-storage-enc";
// Page size 4096 maps better onto the bordercrypt block plaintext capacity
// (PLAINTEXT_SIZE ≈ 15 844 bytes ≈ 3.86 pages per block) than 8192, which
// straddles a block boundary every other page (15844 < 2 × 8192). With 4096
// only ~25 % of pages straddle and three pages share one PQ-encrypted block,
// so an INSERT touching N pages dirties fewer underlying blocks.
const PRAGMAS: &CStr = c"\
    PRAGMA page_size = 4096;\
    PRAGMA journal_mode = MEMORY;\
    PRAGMA synchronous = NORMAL;\
    PRAGMA cache_size = -8000;\
    PRAGMA locking_mode = EXCLUSIVE;\
    PRAGMA trusted_schema = OFF;\
";

#[wasm_bindgen(js_name = openDatabase)]
pub fn open_database() -> Result<(), JsValue> {
    DB.with(|db| {
        let mut slot = db.borrow_mut();
        if slot.is_some() {
            return Ok(());
        }
        let handle = SafeDb::open(DB_NAME, VFS_NAME_C)
            .map_err(|e| JsValue::from_str(&format!("SafeDb::open failed: {e}")))?;
        handle
            .exec(PRAGMAS)
            .map_err(|e| JsValue::from_str(&format!("PRAGMA exec failed: {e}")))?;
        *slot = Some(handle);
        Ok(())
    })
}

#[wasm_bindgen(js_name = closeDatabase)]
pub fn close_database() -> Result<(), JsValue> {
    DB.with(|db| {
        // Drop the SafeDb if present; sqlite3_close runs in Drop.
        db.borrow_mut().take();
        Ok(())
    })
}

// ── SQL exec ───────────────────────────────────────────────────────

/// Result of an `execSql` call.
#[wasm_bindgen]
pub struct ExecResult {
    rows: Array,
    last_insert_rowid: f64,
}

#[wasm_bindgen]
impl ExecResult {
    #[wasm_bindgen(getter, js_name = rows)]
    pub fn rows(&self) -> Array {
        self.rows.clone()
    }
    #[wasm_bindgen(getter, js_name = lastInsertRowId)]
    pub fn last_insert_rowid(&self) -> f64 {
        self.last_insert_rowid
    }
}

/// Run a SQL statement with bound parameters.
///
/// `params` is a JS array of values; supported types are number, string,
/// Uint8Array, null, and bigint. Returns rows as a JS array of arrays
/// (positional column values), matching the Drizzle sqlite-proxy contract.
#[wasm_bindgen(js_name = execSql)]
pub fn exec_sql(sql: &str, params: Array) -> Result<ExecResult, JsValue> {
    DB.with(|db| {
        let slot = db.borrow();
        let safe_db = slot
            .as_ref()
            .ok_or_else(|| JsValue::from_str("database not open"))?;
        run_statement(safe_db, sql, &params)
    })
}

fn run_statement(db: &SafeDb, sql: &str, params: &Array) -> Result<ExecResult, JsValue> {
    let stmt_opt = db
        .prepare(sql)
        .map_err(|e| JsValue::from_str(&format!("prepare failed for sql {sql:?}: {e}")))?;

    let Some(stmt) = stmt_opt else {
        // Empty SQL — return empty result.
        return Ok(ExecResult {
            rows: Array::new(),
            last_insert_rowid: 0.0,
        });
    };

    // Bind params 1..=N
    for (i, param) in params.iter().enumerate() {
        let idx = (i + 1) as i32;
        bind_param(&stmt, idx, &param)
            .map_err(|e| JsValue::from_str(&format!("bind param {idx} failed: {e}")))?;
    }

    // Step rows
    let rows = Array::new();
    loop {
        match stmt
            .step()
            .map_err(|e| JsValue::from_str(&format!("sqlite3_step failed: {e}")))?
        {
            StepStatus::Row => rows.push(&read_row(&stmt)),
            StepStatus::Done => break,
        };
    }

    // Safe: SQLite rowids are sequential and won't exceed 2^53 in practice.
    // Beyond that, f64 loses precision — acceptable for our use case.
    let last_insert_rowid = db.last_insert_rowid() as f64;

    // stmt drops here → sqlite3_finalize.
    drop(stmt);

    Ok(ExecResult {
        rows,
        last_insert_rowid,
    })
}

fn bind_param(stmt: &SafeStmt<'_>, idx: i32, value: &JsValue) -> SqlResult<()> {
    if value.is_null() || value.is_undefined() {
        return stmt.bind_null(idx);
    }
    if let Some(n) = value.as_f64() {
        // Whole numbers within JS safe range → INTEGER. Anything else (fraction,
        // NaN, ±Infinity, |v| ≥ 2^53) → REAL, letting SQLite preserve the f64
        // without silent precision loss.
        if let Some(as_i64) = safe_f64_to_i64(n) {
            return stmt.bind_int64(idx, as_i64);
        }
        return stmt.bind_double(idx, n);
    }
    if let Some(s) = value.as_string() {
        return stmt.bind_text(idx, &s);
    }
    if value.is_bigint() {
        if let Ok(n) = i64::try_from(value.clone()) {
            return stmt.bind_int64(idx, n);
        }
        // Bigint outside i64 range: SQLite INTEGER columns can't hold it.
        return Err("bigint value out of i64 range for SQL bind".to_string());
    }
    if value.is_instance_of::<Uint8Array>() {
        let arr = Uint8Array::from(value.clone());
        let bytes = arr.to_vec();
        return stmt.bind_blob(idx, &bytes);
    }
    // Unsupported type: return an error instead of silently binding NULL,
    // which would cause data corruption on INSERT/UPDATE.
    Err("unsupported JS value type for SQL bind".to_string())
}

fn read_row(stmt: &SafeStmt<'_>) -> Array {
    let n = stmt.column_count();
    let row = Array::new_with_length(n as u32);
    for col in 0..n {
        row.set(col as u32, sql_value_to_js(stmt.column(col)));
    }
    row
}

fn sql_value_to_js(value: SqlValue) -> JsValue {
    match value {
        SqlValue::Null => JsValue::NULL,
        SqlValue::Integer(v) => {
            // Within JS safe-integer range → plain Number; otherwise BigInt to
            // preserve the full 64-bit value without precision loss.
            if is_js_safe_integer_i64(v) {
                JsValue::from_f64(v as f64)
            } else {
                JsValue::from(v)
            }
        }
        SqlValue::Float(v) => JsValue::from_f64(v),
        SqlValue::Text(s) => JsValue::from_str(&s),
        SqlValue::Blob(b) => Uint8Array::from(b.as_slice()).into(),
    }
}
