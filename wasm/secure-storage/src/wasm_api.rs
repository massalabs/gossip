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
use zeroize::Zeroizing;

// Re-export wasm-bindgen-rayon's `initThreadPool` so it survives DCE and
// shows up in the generated JS bindings. The SDK worker calls it once at
// startup to spin up the rayon Web Worker pool.
#[allow(unused_imports)]
pub use wasm_bindgen_rayon::init_thread_pool;

use crate::DEFAULT_NAMESPACE;
use crate::error::SecureStorageError;
use crate::sqlite_handle::{SafeDb, SafeStmt, SqlResult, SqlValue, StepStatus};
use crate::storage::{BlockStorage, KeypairStorage, MemoryStorage};
use crate::types::SessionIndex;
use crate::unlock::{NamespaceState, load_namespace_state};
use crate::vfs::idb_storage::IdbBlockStorage;
use crate::vfs::sqlite_vfs::{AppState, Backend, EncryptedIoMethods, EncryptedVfs, VFS_NAME};

// ── Global state ───────────────────────────────────────────────────

// One VFS pointer and one open SQLite DB per thread. This is deliberate:
// SQLite is compiled with SQLITE_THREADSAFE=0 and each web worker runs on
// its own JS thread — sharing a `sqlite3*` across workers would race. The
// registered VFS pointer itself is global (registered once per thread via
// `initSecureStorage`); the open `SafeDb` is per-worker. A multi-worker UI
// that wants multiple concurrent DB handles opens one per worker.
thread_local! {
    /// Pointer to the registered VFS (set in `initSecureStorage`).
    /// `None` until init has been called.
    static VFS_PTR: RefCell<Option<*mut sqlite_wasm_rs::utils::ffi::sqlite3_vfs>> =
        const { RefCell::new(None) };
    /// Open SQLite database handle (RAII — closes on drop).
    static DB: RefCell<Option<SafeDb>> = const { RefCell::new(None) };
    /// Password-loaded import migration state. Slot matches and secrets never
    /// cross into JavaScript; only complete all-slot batches are returned.
    static OUTER_MIGRATION_PLAN: RefCell<Option<crate::OuterMigrationPlan>> = const { RefCell::new(None) };
    static OUTER_MIGRATION: RefCell<Option<crate::OuterMigration>> = const { RefCell::new(None) };
}

fn map_err(e: SecureStorageError) -> JsValue {
    let error = js_sys::Error::new(&e.to_string());
    error.set_name(e.code());
    error.into()
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

/// Replace this terminal worker's active backend with an isolated in-memory
/// portable candidate and authenticate its keypairs without exposing the
/// matched slot to JavaScript.
#[wasm_bindgen(js_name = beginCandidatePreview)]
pub fn begin_candidate_preview(
    domain: &str,
    password: Vec<u8>,
    keypairs: &Array,
) -> Result<bool, JsValue> {
    let password = Zeroizing::new(password);
    if keypairs.length() != crate::SESSION_COUNT as u32 {
        return Err(JsValue::from_str("invalid candidate keypair count"));
    }
    close_database_and_clear_files()?;
    with_app_state(|app| {
        let mut memory = MemoryStorage::new();
        for slot in 0..crate::SESSION_COUNT as u8 {
            let value = keypairs.get(u32::from(slot));
            let bytes = Uint8Array::new(&value).to_vec();
            let session = SessionIndex::new(slot).map_err(map_err)?;
            memory.write_keypair(session, &bytes).map_err(map_err)?;
        }
        let mut state = app.state.borrow_mut();
        state.backend = Backend::Memory(memory);
        state.domain = domain.to_string();
        state.session = None;
        state.namespace_states.clear();
        Ok(())
    })?;
    with_app_state(|app| {
        let mut state = app.state.borrow_mut();
        match crate::unlock::unlock_session_unique(&state.backend, domain, &password) {
            Ok(session) => {
                state.session = Some(session);
                Ok(true)
            }
            Err(SecureStorageError::InvalidPassword) => Ok(false),
            Err(error) => Err(map_err(error)),
        }
    })
}

/// Admit one canonical candidate block. Only namespace 0 blocks belonging to
/// the internally authenticated slot are retained; callers never learn which
/// slot matched.
#[wasm_bindgen(js_name = appendCandidatePreviewBlock)]
pub fn append_candidate_preview_block(
    slot: u8,
    namespace: u8,
    block_index: f64,
    data: &[u8],
) -> Result<(), JsValue> {
    let block_index = safe_f64_to_u64(block_index)
        .ok_or_else(|| JsValue::from_str("invalid candidate block index"))?;
    let block: &[u8; crate::BLOCK_SIZE] = data
        .try_into()
        .map_err(|_| JsValue::from_str("invalid candidate block size"))?;
    with_app_state(|app| {
        let mut state = app.state.borrow_mut();
        let matched = state
            .session
            .as_ref()
            .ok_or_else(|| JsValue::from_str("candidate is not authenticated"))?
            .session_index;
        if slot != matched.as_u8() || namespace != DEFAULT_NAMESPACE {
            return Ok(());
        }
        if block_index > 0 {
            let total = state
                .namespace_states
                .get(&DEFAULT_NAMESPACE)
                .ok_or_else(|| JsValue::from_str("candidate length is unavailable"))?
                .total_data_length;
            let required = crate::read::preview_block_count(total).map_err(map_err)?;
            if block_index >= required {
                return Ok(());
            }
        }
        let count = state
            .backend
            .block_count(matched, namespace)
            .map_err(map_err)?;
        if block_index != count {
            return Err(JsValue::from_str("noncontiguous candidate block"));
        }
        state
            .backend
            .append_block(matched, namespace, block)
            .map_err(map_err)?;
        if block_index == 0 {
            let domain = state.domain.clone();
            let session = state
                .session
                .as_ref()
                .ok_or_else(|| JsValue::from_str("candidate is not authenticated"))?;
            let total = crate::read::preview_total_length_from_block_zero(
                &state.backend,
                &domain,
                DEFAULT_NAMESPACE,
                session,
            )
            .map_err(map_err)?;
            crate::read::preview_block_count(total).map_err(map_err)?;
            state.namespace_states.insert(
                DEFAULT_NAMESPACE,
                NamespaceState {
                    total_data_length: total,
                },
            );
        }
        Ok(())
    })
}

/// Load the candidate namespace length and open SQLite without write authority.
#[wasm_bindgen(js_name = finishCandidatePreview)]
pub fn finish_candidate_preview() -> Result<(), JsValue> {
    close_database_and_clear_files()?;
    with_app_state(|app| {
        let state = app.state.borrow();
        let sql_state = state
            .namespace_states
            .get(&DEFAULT_NAMESPACE)
            .ok_or_else(|| JsValue::from_str("candidate length is unavailable"))?;
        let required =
            crate::read::preview_block_count(sql_state.total_data_length).map_err(map_err)?;
        let session = state
            .session
            .as_ref()
            .ok_or_else(|| JsValue::from_str("candidate is not authenticated"))?;
        if state
            .backend
            .block_count(session.session_index, DEFAULT_NAMESPACE)
            .map_err(map_err)?
            != required
        {
            return Err(JsValue::from_str("candidate database is truncated"));
        }
        Ok(())
    })?;
    open_database_readonly()
}

/// Project only bounded public profile fields inside WASM. The security JSON
/// is validated and zeroized in Rust and never crosses the worker bridge.
#[wasm_bindgen(js_name = queryCandidatePreview)]
pub fn query_candidate_preview() -> Result<JsValue, JsValue> {
    DB.with(|cell| {
        let db = cell.borrow();
        let db = db.as_ref().ok_or_else(not_initialized)?;
        let statement = db
            .prepare(
                "SELECT userId, username, avatar, createdAt, security \
                 FROM userProfile ORDER BY rowid LIMIT 2",
            )
            .map_err(|error| JsValue::from_str(&error))?
            .ok_or_else(|| JsValue::from_str("imported account profile is unavailable"))?;
        if !matches!(
            statement
                .step()
                .map_err(|error| JsValue::from_str(&error))?,
            StepStatus::Row
        ) {
            return Err(JsValue::from_str("imported account profile is unavailable"));
        }
        let user_id = match statement.column(0) {
            SqlValue::Text(value) => value,
            _ => return Err(JsValue::from_str("imported account profile is invalid")),
        };
        let username = match statement.column(1) {
            SqlValue::Text(value) => value,
            _ => return Err(JsValue::from_str("imported account profile is invalid")),
        };
        let avatar = match statement.column(2) {
            SqlValue::Null => None,
            SqlValue::Text(value) => Some(value),
            _ => return Err(JsValue::from_str("imported account profile is invalid")),
        };
        let created_at_ms = match statement.column(3) {
            SqlValue::Integer(value) => value,
            _ => return Err(JsValue::from_str("imported account profile is invalid")),
        };
        let security = match statement.column(4) {
            SqlValue::Text(value) => Zeroizing::new(value),
            _ => return Err(JsValue::from_str("imported account profile is invalid")),
        };
        if !matches!(
            statement
                .step()
                .map_err(|error| JsValue::from_str(&error))?,
            StepStatus::Done
        ) || !crate::preview::valid_user_id(&user_id)
            || username.is_empty()
            || username.len() > 128
            || avatar
                .as_ref()
                .is_some_and(|value| value.len() > 1024 * 1024)
            || !(0..=9_007_199_254_740_991).contains(&created_at_ms)
        {
            return Err(JsValue::from_str("imported account profile is invalid"));
        }
        crate::preview::validate_security(&security).map_err(map_err)?;

        let result = js_sys::Object::new();
        js_sys::Reflect::set(
            &result,
            &JsValue::from_str("userId"),
            &JsValue::from_str(&user_id),
        )?;
        js_sys::Reflect::set(
            &result,
            &JsValue::from_str("username"),
            &JsValue::from_str(&username),
        )?;
        js_sys::Reflect::set(
            &result,
            &JsValue::from_str("avatar"),
            &avatar.map_or(JsValue::NULL, |value| JsValue::from_str(&value)),
        )?;
        js_sys::Reflect::set(
            &result,
            &JsValue::from_str("createdAtMs"),
            &JsValue::from_f64(created_at_ms as f64),
        )?;
        Ok(result.into())
    })
}

#[wasm_bindgen(js_name = endCandidatePreview)]
pub async fn end_candidate_preview() -> Result<(), JsValue> {
    close_database_and_clear_files()?;
    with_app_state(|app| {
        let mut state = app.state.borrow_mut();
        state.backend = Backend::Memory(MemoryStorage::new());
        state.session = None;
        state.namespace_states.clear();
        Ok(())
    })?;
    let active_backend = IdbBlockStorage::open().await?;
    with_app_state(|app| {
        app.state.borrow_mut().backend = Backend::Idb(active_backend);
        Ok(())
    })
}

/// Begin password admission for one validated candidate. Only opaque plan
/// state is retained; no transformed/mixed-version generation is emitted.
#[wasm_bindgen(js_name = beginOuterMigration)]
pub fn begin_outer_migration(domain: &str, keypairs: &Array) -> Result<(), JsValue> {
    if keypairs.length() != crate::SESSION_COUNT as u32 {
        return Err(JsValue::from_str("invalid outer migration keypairs"));
    }
    let mut values: [Vec<u8>; crate::SESSION_COUNT] = std::array::from_fn(|_| Vec::new());
    for slot in 0..crate::SESSION_COUNT {
        let value = Uint8Array::new(&keypairs.get(slot as u32));
        values[slot] = value.to_vec();
    }
    let plan = crate::OuterMigrationPlan::new(domain, values).map_err(map_err)?;
    OUTER_MIGRATION.with(|migration| migration.borrow_mut().take());
    OUTER_MIGRATION_PLAN.with(|state| {
        *state.borrow_mut() = Some(plan);
    });
    Ok(())
}

/// Admit one password with all-slot constant work. The owned WASM copy is
/// zeroized before return and a generic false discloses no matched slot.
#[wasm_bindgen(js_name = admitOuterMigrationPassword)]
pub fn admit_outer_migration_password(password: Vec<u8>) -> Result<bool, JsValue> {
    let password = Zeroizing::new(password);
    OUTER_MIGRATION_PLAN.with(|state| {
        let mut state = state.borrow_mut();
        let plan = state
            .as_mut()
            .ok_or_else(|| JsValue::from_str("outer migration is not active"))?;
        match plan.admit_password(&password) {
            Ok(()) => Ok(true),
            Err(SecureStorageError::InvalidPassword) => Ok(false),
            Err(error) => Err(map_err(error)),
        }
    })
}

/// Generate fresh current-suite keypairs for all slots at once. Every public
/// key changes, so comparing source and destination cannot reveal selection.
#[wasm_bindgen(js_name = finalizeOuterMigration)]
pub fn finalize_outer_migration() -> Result<Array, JsValue> {
    let plan = OUTER_MIGRATION_PLAN
        .with(|state| state.borrow_mut().take())
        .ok_or_else(|| JsValue::from_str("outer migration is not active"))?;
    let migration = plan.finalize().map_err(map_err)?;
    let result = Array::new();
    for keypair in migration.keypairs() {
        result.push(&Uint8Array::from(keypair).into());
    }
    OUTER_MIGRATION.with(|state| *state.borrow_mut() = Some(migration));
    Ok(result)
}

/// Transform one complete fixed-slot block coordinate.
#[wasm_bindgen(js_name = migrateOuterBlockBatch)]
pub fn migrate_outer_block_batch(
    namespace: u8,
    block_index: f64,
    values: &Array,
) -> Result<Array, JsValue> {
    let block_index = safe_f64_to_u64(block_index)
        .ok_or_else(|| JsValue::from_str("invalid outer migration block index"))?;
    if values.length() != crate::SESSION_COUNT as u32 {
        return Err(JsValue::from_str("invalid outer migration block batch"));
    }
    let inputs: [Zeroizing<Vec<u8>>; crate::SESSION_COUNT] = std::array::from_fn(|slot| {
        Zeroizing::new(Uint8Array::new(&values.get(slot as u32)).to_vec())
    });
    let mut refs = Vec::with_capacity(crate::SESSION_COUNT);
    for input in &inputs {
        refs.push(
            <&[u8; crate::BLOCK_SIZE]>::try_from(input.as_slice())
                .map_err(|_| JsValue::from_str("invalid outer migration block"))?,
        );
    }
    let refs: [&[u8; crate::BLOCK_SIZE]; crate::SESSION_COUNT] = refs
        .try_into()
        .map_err(|_| JsValue::from_str("invalid outer migration block batch"))?;
    let migrated = OUTER_MIGRATION.with(|state| {
        let mut state = state.borrow_mut();
        state
            .as_mut()
            .ok_or_else(|| JsValue::from_str("outer migration is not finalized"))?
            .migrate_block_batch(namespace, block_index, refs)
            .map_err(map_err)
    })?;
    let result = Array::new();
    for value in &migrated {
        result.push(&Uint8Array::from(value.as_slice()).into());
    }
    Ok(result)
}

#[wasm_bindgen(js_name = finishOuterMigrationNamespace)]
pub fn finish_outer_migration_namespace(
    namespace: u8,
    source_block_count: f64,
) -> Result<(), JsValue> {
    let source_block_count = safe_f64_to_u64(source_block_count)
        .ok_or_else(|| JsValue::from_str("invalid outer migration block count"))?;
    OUTER_MIGRATION.with(|state| {
        state
            .borrow_mut()
            .as_mut()
            .ok_or_else(|| JsValue::from_str("outer migration is not finalized"))?
            .finish_namespace(namespace, source_block_count)
            .map_err(map_err)
    })
}

#[wasm_bindgen(js_name = endOuterMigration)]
pub fn end_outer_migration() {
    OUTER_MIGRATION_PLAN.with(|state| state.borrow_mut().take());
    OUTER_MIGRATION.with(|state| state.borrow_mut().take());
}

#[wasm_bindgen(js_name = idbHasData)]
pub async fn idb_has_data() -> Result<bool, JsValue> {
    IdbBlockStorage::has_data().await
}

#[wasm_bindgen(js_name = provisionStorage)]
pub fn provision_storage() -> Result<(), JsValue> {
    close_database_and_clear_files()?;
    with_app_state(|app| {
        let mut state = app.state.borrow_mut();
        let domain = state.domain.clone();
        crate::lifecycle::provision_storage_for_domain(&mut state.backend, &domain)
            .map_err(map_err)?;
        state.session = None;
        state.namespace_states.clear();
        Ok(())
    })
}

#[wasm_bindgen(js_name = allocateSession)]
pub fn allocate_session(slot: u8, password: &[u8]) -> Result<(), JsValue> {
    let idx = SessionIndex::new(slot).map_err(map_err)?;
    close_database_and_clear_files()?;
    with_app_state(|app| {
        let mut state = app.state.borrow_mut();
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
    })
}

#[wasm_bindgen(js_name = unlockSession)]
pub fn unlock_session(password: &[u8]) -> Result<bool, JsValue> {
    let unlock_result = with_app_state(|app| {
        let state = app.state.borrow();
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
                Ok(Some((session, sql_state)))
            }
            Err(SecureStorageError::InvalidPassword) => Ok(None),
            Err(e) => Err(map_err(e)),
        }
    })?;
    let Some((session, sql_state)) = unlock_result else {
        return Ok(false);
    };

    close_database_and_clear_files()?;
    with_app_state(|app| {
        let mut state = app.state.borrow_mut();
        state.session = Some(session);
        // Clear any stale namespace state from a prior session. Only
        // one session can be unlocked at a time (`Option<UnlockedSession>`),
        // so there are never two concurrent namespace maps to reconcile.
        state.namespace_states.clear();
        state.namespace_states.insert(DEFAULT_NAMESPACE, sql_state);
        Ok(())
    })?;
    Ok(true)
}

#[wasm_bindgen(js_name = lockSession)]
pub fn lock_session() -> Result<(), JsValue> {
    close_database_and_clear_files()?;
    with_app_state(|app| {
        let mut state = app.state.borrow_mut();
        state.session = None;
        state.namespace_states.clear();
        Ok(())
    })
}

/// Permanently destroy the data of the currently unlocked slot.
///
/// The actual writes (new dummy keypair + cover blocks) land in
/// IdbBlockStorage's in-memory pending state. Durability comes from
/// the caller's subsequent `flushEncrypted()` await — same pattern
/// the worker uses for `lockSession`. A process crash before that
/// flush rolls everything back: the IDB on-disk state is unchanged,
/// the slot is left exactly as it was.
///
/// **The caller must `closeDatabase()` first** so SQLite's xWrite
/// flush on close lands in the buffer before destroy_session truncates
/// the namespace. Mirrors `lockSession`'s contract.
#[wasm_bindgen(js_name = destroySession)]
pub fn destroy_session(namespaces: &[u8]) -> Result<(), JsValue> {
    with_app_state(|app| {
        let mut state = app.state.borrow_mut();
        let slot = state
            .session
            .as_ref()
            .ok_or_else(|| {
                JsValue::from_str(
                    "destroySession: secure storage is locked — no session to destroy. \
                     Call unlockSession first.",
                )
            })?
            .session_index;
        let domain = state.domain.clone();
        crate::destroy_session(&mut state.backend, &domain, slot, namespaces).map_err(map_err)?;
        // Match lockSession post-conditions: zeroize the in-memory
        // session. The new dummy keypair has no recoverable secret
        // so there is nothing meaningful to keep.
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

/// Strictly validate one version-1 logical keypair record without unlocking it.
/// Browser streaming export/import uses this bounded bridge so TypeScript never
/// reimplements pq-rerand's canonical parser.
#[wasm_bindgen(js_name = validatePortableKeypair)]
pub fn validate_portable_keypair(value: &[u8]) -> Result<(), JsValue> {
    crate::portable::validate_portable_keypair_value(value).map_err(map_err)
}

/// Strictly validate one version-1 encrypted block record.
#[wasm_bindgen(js_name = validatePortableBlock)]
pub fn validate_portable_block(value: &[u8]) -> Result<(), JsValue> {
    crate::portable::validate_portable_block_value(value).map_err(map_err)
}

// ── Generic namespace data exports ─────────────────────────────────
//
// These let the SDK store arbitrary blobs in namespaces != DEFAULT_NAMESPACE.
// DEFAULT_NAMESPACE is reserved for the SQLite VFS backing stream and must not
// be accessed through these generic namespace APIs.

fn reject_default_namespace(namespace: u8) -> Result<(), JsValue> {
    if namespace == DEFAULT_NAMESPACE {
        return Err(JsValue::from_str(
            "DEFAULT_NAMESPACE is reserved for SQLite VFS access",
        ));
    }
    Ok(())
}

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
    reject_default_namespace(namespace)?;
    let offset = safe_f64_to_u64(offset).ok_or_else(|| JsValue::from_str("invalid offset"))?;
    with_app_state(|app| {
        let mut state = app.state.borrow_mut();
        ensure_namespace_state_loaded(&mut state, namespace)?;
        // Split borrow: reborrow `state` and destructure to get &mut to each
        // field independently. Sound because EncryptionState is NOT Copy —
        // see the same pattern in vfs/sqlite_vfs.rs for the full argument.
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
    reject_default_namespace(namespace)?;
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
    reject_default_namespace(namespace)?;
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
    reject_default_namespace(namespace)?;
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

/// Verify that this worker still owns the active IndexedDB generation.
#[wasm_bindgen(js_name = verifyStorageGeneration)]
pub async fn verify_storage_generation() -> Result<(), JsValue> {
    let idb_ptr: Option<*const IdbBlockStorage> = with_app_state(|app| {
        let state = app.state.borrow();
        Ok(match &state.backend {
            Backend::Idb(idb) => Some(idb as *const _),
            Backend::Memory(_) => None,
        })
    })?;
    let Some(ptr) = idb_ptr else {
        return Err(JsValue::from_str(
            "generation verification is only available for IndexedDB storage",
        ));
    };
    // SAFETY: the backend lives in the leaked AppState and is never moved.
    unsafe { &*ptr }.verify_generation().await
}

/// Discard pending IDB mutations and reload the last committed snapshot.
///
async fn reload_idb_backend() -> Result<(), JsValue> {
    // Same program-lifetime pointer invariant as `flush_encrypted` below: the
    // backend is initialized once and never moved or replaced.
    let idb_ptr: Option<*const IdbBlockStorage> = with_app_state(|app| {
        let state = app.state.borrow();
        Ok(match &state.backend {
            Backend::Idb(idb) => Some(idb as *const _),
            Backend::Memory(_) => None,
        })
    })?;

    let Some(ptr) = idb_ptr else {
        return Err(JsValue::from_str(
            "durable reload is only available for IndexedDB storage",
        ));
    };

    // SAFETY: the backend lives in the leaked AppState and is never moved.
    unsafe { &*ptr }.reload_durable().await
}

/// Called by the worker when an allocation or destruction transaction rejects.
/// This prevents a later cover-traffic flush from durably carrying the failed
/// lifecycle operation. The recovered state is always locked.
#[wasm_bindgen(js_name = reloadDurableStorage)]
pub async fn reload_durable_storage() -> Result<(), JsValue> {
    close_database_and_clear_files()?;
    reload_idb_backend().await?;

    with_app_state(|app| {
        let mut state = app.state.borrow_mut();
        state.session = None;
        state.namespace_states.clear();
        Ok(())
    })
}

/// Abandon a poisoned SQLite transaction and restore its last durable image
/// while retaining the current unlocked session keys. No pending VFS bytes are
/// flushed: closing SQLite rolls back its in-memory journal, then the IndexedDB
/// cache is reloaded before a fresh database handle is opened.
#[wasm_bindgen(js_name = resetSqlDatabaseToDurable)]
pub async fn reset_sql_database_to_durable() -> Result<(), JsValue> {
    with_app_state(|app| {
        if app.state.borrow().session.is_none() {
            return Err(JsValue::from_str(
                "resetSqlDatabaseToDurable requires an unlocked session",
            ));
        }
        Ok(())
    })?;

    close_database_and_clear_files()?;
    reload_idb_backend().await?;
    let sql_state = with_app_state(|app| {
        let state = app.state.borrow();
        let session = state.session.as_ref().ok_or_else(|| {
            JsValue::from_str("resetSqlDatabaseToDurable lost the unlocked session")
        })?;
        load_namespace_state(&state.backend, &state.domain, session, DEFAULT_NAMESPACE)
            .map_err(map_err)
    })?;
    with_app_state(|app| {
        let mut state = app.state.borrow_mut();
        state.namespace_states.clear();
        state.namespace_states.insert(DEFAULT_NAMESPACE, sql_state);
        Ok(())
    })?;
    open_database()
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
        let out = match &state.backend {
            Backend::Idb(idb) => Some(idb as *const _),
            Backend::Memory(_) => None,
        };
        Ok(out)
    })?;

    if let Some(ptr) = idb_ptr {
        // SAFETY: see invariant above.
        unsafe { &*ptr }.persist_dirty().await?;
    }
    Ok(())
}

// ── Database lifecycle ─────────────────────────────────────────────

const DB_NAME: &CStr = c"secure.db";
const VFS_NAME_C: &CStr = c"secure-storage-enc";
// Page size 4096 maps better onto the bordercrypt block plaintext capacity
// (PLAINTEXT_SIZE ≈ 15 844 bytes ≈ 3.86 pages per block) than 8192, which
// straddles a block boundary every other page (15844 < 2 × 8192). With 4096
// only ~25 % of pages straddle and three pages share one PQ-encrypted block,
// so an INSERT touching N pages dirties fewer underlying blocks.
const READONLY_PRAGMAS: &CStr = c"\
    PRAGMA query_only = ON;\
    PRAGMA trusted_schema = OFF;\
";
const PRAGMAS: &CStr = c"\
    PRAGMA page_size = 4096;\
    PRAGMA journal_mode = MEMORY;\
    PRAGMA synchronous = NORMAL;\
    PRAGMA cache_size = -32000;\
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

fn open_database_readonly() -> Result<(), JsValue> {
    DB.with(|db| {
        let mut slot = db.borrow_mut();
        if slot.is_some() {
            return Ok(());
        }
        // This in-memory VFS has no filesystem xAccess signal, so SQLite
        // cannot discover it with SQLITE_OPEN_READONLY. Open only the
        // isolated candidate and enable query-only mode before any candidate
        // SQL is admitted. No active backend or migration is bound.
        let handle = SafeDb::open(DB_NAME, VFS_NAME_C)
            .map_err(|e| JsValue::from_str(&format!("candidate SQLite open failed: {e}")))?;
        handle
            .exec(READONLY_PRAGMAS)
            .map_err(|e| JsValue::from_str(&format!("read-only PRAGMA exec failed: {e}")))?;
        *slot = Some(handle);
        Ok(())
    })
}

#[wasm_bindgen(js_name = closeDatabase)]
pub fn close_database() -> Result<(), JsValue> {
    close_database_and_clear_files()
}

fn close_database_and_clear_files() -> Result<(), JsValue> {
    DB.with(|db| {
        // `.take()` replaces the slot with None and drops the old SafeDb
        // synchronously on this line (not at the end of the closure). The
        // Drop impl runs sqlite3_close before we return.
        db.borrow_mut().take();
        Ok::<(), JsValue>(())
    })?;
    with_app_state(|app| {
        app.files.borrow_mut().clear();
        Ok(())
    })
}

// ── SQL exec ───────────────────────────────────────────────────────

/// Result of an `execSql` call.
///
/// `last_insert_rowid` is `f64` (not `i64`) because it crosses the JS bridge
/// and JS has no native i64 — its `Number` type is f64. SQLite rowids are
/// sequential and stay within JS's safe integer range (2^53) in practice,
/// so the conversion is lossless.
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
    if value.is_undefined() {
        // Reject `undefined` explicitly. Treating it as SQL NULL silently
        // masks programmer typos (`obj.usrname` → undefined → NULL row
        // instead of the intended value). Callers that want NULL must
        // pass `null` explicitly. The SDK side (gossip-sdk/src/db/sqlite.ts
        // execRaw) also rejects undefined at the boundary; this is the
        // last line of defence for callers that bypass the SDK.
        return Err(
            "undefined is not a valid SQL bind value; pass null explicitly if NULL is intended"
                .to_string(),
        );
    }
    if value.is_null() {
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
