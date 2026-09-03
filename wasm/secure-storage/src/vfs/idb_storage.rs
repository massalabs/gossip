//! IndexedDB-backed block storage for secure-storage (WASM).
//!
//! Thin async wrapper around [`IdbStorageState`] (see `idb_state.rs`).
//! All in-memory state lives behind a single `RefCell`; this layer:
//!
//!   * loads IDB contents at construction time (see [`Self::open`]),
//!   * bridges sync VFS callbacks to async IDB I/O via the
//!     drain/restore pattern (see [`Self::persist_dirty`]),
//!   * implements the [`BlockStorage`] / [`KeypairStorage`] traits by
//!     delegating to the state.

use std::cell::RefCell;

// `IdbDatabase`, `IdbTransactionMode`, `IdbVersionChangeEvent`, and the
// `IdbDatabaseExt`/`IdbObjectStoreExt` traits are pulled in via the prelude.
use indexed_db_futures::prelude::*;
use js_sys::Uint8Array;
use wasm_bindgen::prelude::*;
use zeroize::Zeroizing;

use crate::constants::BLOCK_SIZE;
use crate::error::Result;
use crate::storage::{BlockStorage, KeypairStorage};
use crate::types::SessionIndex;
use crate::vfs::idb_state::{IdbKey, IdbStorageState};

const DB_NAME: &str = "secure_storage";
const STORE_NAME: &str = "blocks";
const DB_VERSION: u32 = 1;
const ACTIVE_GENERATION_KEY: &str = "m:active-generation";
const LEGACY_GENERATION: &str = "legacy";

// ── Low-level IDB helpers ───────────────────────────────────────────

/// Open (or create) the secure_storage IndexedDB database.
async fn open_db() -> std::result::Result<IdbDatabase, JsValue> {
    let mut req = IdbDatabase::open_u32(DB_NAME, DB_VERSION)?;
    req.set_on_upgrade_needed(Some(
        |evt: &IdbVersionChangeEvent| -> std::result::Result<(), JsValue> {
            let db = evt.db();
            if !db.object_store_names().any(|n| n == STORE_NAME) {
                db.create_object_store(STORE_NAME)?;
            }
            Ok(())
        },
    ));
    Ok(req.into_future().await?)
}

fn valid_generation(generation: &str) -> bool {
    generation == LEGACY_GENERATION
        || (generation.len() == 32
            && generation
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)))
}

fn generation_prefix(generation: &str) -> String {
    if generation == LEGACY_GENERATION {
        String::new()
    } else {
        format!("g:{generation}:")
    }
}

/// Load every active logical secure-storage entry.
///
/// Browser export spools share this physical object store under an `x:`
/// prefix so one IDB transaction can snapshot all active `s:` records. Never
/// fetch spool values into the WASM cache: an interrupted large export must
/// not double startup memory before the worker gets a chance to reclaim it.
fn active_key_range(generation: &str) -> std::result::Result<web_sys::IdbKeyRange, JsValue> {
    let prefix = generation_prefix(generation);
    // `s;` is the exclusive lexical successor of the ASCII `s:` prefix.
    // Malformed/future active records stay in scope for strict rejection.
    web_sys::IdbKeyRange::bound_with_lower_open_and_upper_open(
        &JsValue::from_str(&format!("{prefix}s:")),
        &JsValue::from_str(&format!("{prefix}s;")),
        false,
        true,
    )
}

async fn load_all_entries(
    db: &IdbDatabase,
    generation: &str,
) -> std::result::Result<Vec<(String, Vec<u8>)>, JsValue> {
    let tx = db.transaction_on_one(STORE_NAME)?;
    let store = tx.object_store(STORE_NAME)?;
    let range = active_key_range(generation)?;
    // Register both requests before either await so keys and values come from
    // one IndexedDB snapshot, while the range excludes export-owned `x:` data.
    let keys_req = store.get_all_keys_with_key(&range)?;
    let values_req = store.get_all_with_key(&range)?;
    let keys = keys_req.await?;
    let values = values_req.await?;
    tx.await.into_result()?;

    if keys.length() != values.length() {
        return Err(JsValue::from_str(
            "secure-storage key/value snapshot mismatch",
        ));
    }
    let mut out = Vec::with_capacity(keys.length() as usize);
    for index in 0..keys.length() {
        let physical_key = keys
            .get(index)
            .as_string()
            .ok_or_else(|| JsValue::from_str("invalid secure-storage key"))?;
        let prefix = generation_prefix(generation);
        let key = physical_key
            .strip_prefix(&prefix)
            .ok_or_else(|| JsValue::from_str("invalid secure-storage generation key"))?
            .to_owned();
        let val = Uint8Array::new(&values.get(index));
        let mut buf = vec![0u8; val.length() as usize];
        val.copy_to(&mut buf);
        out.push((key, buf));
    }
    Ok(out)
}

/// True if the store contains at least one active logical record. Export
/// spools alone never turn a fresh installation into a locked one.
async fn has_any_data(db: &IdbDatabase) -> std::result::Result<bool, JsValue> {
    let generation = read_active_generation(db).await?;
    let tx = db.transaction_on_one(STORE_NAME)?;
    let store = tx.object_store(STORE_NAME)?;
    let count = store
        .count_with_key(&active_key_range(&generation)?)?
        .await?;
    tx.await.into_result()?;
    Ok(count > 0)
}

async fn read_active_generation(db: &IdbDatabase) -> std::result::Result<String, JsValue> {
    let read_tx = db.transaction_on_one(STORE_NAME)?;
    let value = read_tx
        .object_store(STORE_NAME)?
        .get_owned(ACTIVE_GENERATION_KEY)?
        .await?;
    read_tx.await.into_result()?;
    match value {
        Some(value) => value
            .as_string()
            .filter(|value| valid_generation(value))
            .ok_or_else(|| JsValue::from_str("invalid secure-storage generation marker")),
        None => Ok(LEGACY_GENERATION.to_owned()),
    }
}

async fn assert_active_generation(
    db: &IdbDatabase,
    expected: &str,
) -> std::result::Result<(), JsValue> {
    let tx = db.transaction_on_one(STORE_NAME)?;
    let store = tx.object_store(STORE_NAME)?;
    let value = store.get_owned(ACTIVE_GENERATION_KEY)?.await?;
    tx.await.into_result()?;
    let current = value
        .and_then(|value| value.as_string())
        .unwrap_or_else(|| LEGACY_GENERATION.to_owned());
    if current != expected {
        return Err(JsValue::from_str(
            "secure-storage generation changed; reload required",
        ));
    }
    Ok(())
}

/// Apply puts and deletes in a single atomic readwrite transaction, fenced by
/// the generation captured when this worker loaded its in-memory state.
async fn batch_apply(
    db: &IdbDatabase,
    expected_generation: &str,
    puts: &[(String, Uint8Array)],
    deletes: &[String],
) -> std::result::Result<(), JsValue> {
    if puts.is_empty() && deletes.is_empty() {
        return Ok(());
    }
    // The worker holds the portable-storage Web Lock across this check and
    // commit. Import uses the same exclusive lock for its generation switch,
    // so the two IndexedDB transactions form one fenced logical boundary.
    assert_active_generation(db, expected_generation).await?;
    let tx = db.transaction_on_one_with_mode(STORE_NAME, IdbTransactionMode::Readwrite)?;
    let store = tx.object_store(STORE_NAME)?;
    for k in deletes {
        store.delete(&JsValue::from_str(k))?;
    }
    for (k, v) in puts {
        store.put_key_val(&JsValue::from_str(k), v)?;
    }
    Ok(tx.await.into_result()?)
}

// ── Storage type ────────────────────────────────────────────────────

/// IndexedDB-backed block storage for secure_storage.
///
/// All in-memory state lives in [`IdbStorageState`] behind a single
/// `RefCell` (single-threaded WASM, no `Mutex` needed).
pub struct IdbBlockStorage {
    db: IdbDatabase,
    generation: String,
    state: RefCell<IdbStorageState>,
}

impl IdbBlockStorage {
    /// Open IDB and load all entries into the in-memory state.
    ///
    /// NOTE: loads the entire DB eagerly into RAM (see `load_all_entries`).
    /// This caps the practical DB size at the device's available memory —
    /// acceptable for typical secure-storage payloads (< 10 MB) but a future
    /// large-DB use case would need demand-paging on top of this layer.
    /// The planned migration to JSPI removes the eager-load need entirely.
    ///
    /// Skipped entries (malformed keys or block data with unexpected size)
    /// are intentionally dropped here — they represent forward-compat noise
    /// from a future schema version, or corruption that we can't meaningfully
    /// surface at open time. If diagnosing a lost-entry issue, check
    /// `IdbStorageState::from_entries` for the exact rejection predicates.
    pub async fn open() -> std::result::Result<Self, JsValue> {
        let db = open_db().await?;
        let generation = read_active_generation(&db).await?;
        let entries = load_all_entries(&db, &generation).await?;
        let entries_iter = entries.iter().map(|(k, v)| (k.as_str(), v.as_slice()));
        let (state, _skipped) = IdbStorageState::from_entries(entries_iter);
        Ok(Self {
            db,
            generation,
            state: RefCell::new(state),
        })
    }

    /// Check if IDB has any data (used for needsUnlock detection at boot).
    /// Static helper that opens the DB independently — used before an
    /// `IdbBlockStorage` instance exists.
    pub async fn has_data() -> std::result::Result<bool, JsValue> {
        let db = open_db().await?;
        has_any_data(&db).await
    }

    /// Reject when another tab selected a different active generation.
    pub async fn verify_generation(&self) -> std::result::Result<(), JsValue> {
        assert_active_generation(&self.db, &self.generation).await
    }

    /// Discard every pending in-memory mutation and reload the last durable
    /// IndexedDB snapshot. Lifecycle operations use this after a rejected
    /// transaction so cover traffic cannot later commit a failed allocation or
    /// destruction.
    pub async fn reload_durable(&self) -> std::result::Result<(), JsValue> {
        assert_active_generation(&self.db, &self.generation).await?;
        let entries = load_all_entries(&self.db, &self.generation).await?;
        let entries_iter = entries.iter().map(|(k, v)| (k.as_str(), v.as_slice()));
        let (state, _skipped) = IdbStorageState::from_entries(entries_iter);
        *self.state.borrow_mut() = state;
        Ok(())
    }

    /// Persist all pending puts and deletes to IDB in a single atomic
    /// transaction.
    ///
    /// Uses the drain/restore pattern: phase 1 atomically drains pending puts
    /// and deletes into a snapshot (state becomes clean). Phase 2 commits the
    /// snapshot to IDB. On success, the snapshot is dropped. On failure,
    /// [`IdbStorageState::restore_pending`] restores the puts/deletes so the
    /// next flush retries.
    ///
    /// New writes that arrive while phase 2 is in flight are
    /// re-marked dirty naturally and captured at the next drain —
    /// no race, no data loss, even when overwriting the same block.
    pub async fn persist_dirty(&self) -> std::result::Result<(), JsValue> {
        // Even a clean durable boundary fences stale workers immediately.
        // The worker holds the installation Web Lock across this check.
        assert_active_generation(&self.db, &self.generation).await?;

        // Phase 1: drain (sync, under borrow_mut). Atomically empties
        // the dirty sets and captures their contents.
        let snapshot = {
            let mut state = self.state.borrow_mut();
            let snap = state.drain_pending();
            if snap.is_empty() {
                return Ok(());
            }
            snap
        };

        // Convert the snapshot to JS-friendly types for the IDB call.
        // We do this outside the borrow so any writes that arrive
        // during the await below don't deadlock on the RefCell.
        //
        // Capacity = block_puts.len() + keypair_puts.len() because the two
        // sets are disjoint (different IdbKey variants encode to distinct
        // string prefixes) — every entry in either contributes exactly one
        // put, so the total is the sum.
        let mut puts: Vec<(String, Uint8Array)> =
            Vec::with_capacity(snapshot.block_puts.len() + snapshot.keypair_puts.len());
        let mut deletes: Vec<String> = Vec::with_capacity(snapshot.block_deletes.len());
        let generation_prefix = generation_prefix(&self.generation);
        for ((session, namespace, idx), data) in &snapshot.block_puts {
            let key = format!(
                "{generation_prefix}{}",
                IdbKey::Block {
                    session: *session,
                    namespace: *namespace,
                    idx: *idx,
                }
                .encode()
            );
            puts.push((key, Uint8Array::from(&data[..])));
        }
        for (session, data) in &snapshot.keypair_puts {
            let key = format!(
                "{generation_prefix}{}",
                IdbKey::Keypair { session: *session }.encode()
            );
            puts.push((key, Uint8Array::from(data.as_slice())));
        }
        for (session, namespace, idx) in &snapshot.block_deletes {
            let key = format!(
                "{generation_prefix}{}",
                IdbKey::Block {
                    session: *session,
                    namespace: *namespace,
                    idx: *idx,
                }
                .encode()
            );
            deletes.push(key);
        }

        // Phase 2: atomic commit to IDB. On failure, restore the
        // snapshot so the next flush will retry.
        if let Err(e) = batch_apply(&self.db, &self.generation, &puts, &deletes).await {
            self.state.borrow_mut().restore_pending(snapshot);
            return Err(e);
        }

        // Phase 3: success. Snapshot is dropped naturally — drain
        // already cleaned the dirty sets in phase 1.
        Ok(())
    }
}

// ── BlockStorage ────────────────────────────────────────────────────

impl BlockStorage for IdbBlockStorage {
    fn read_block(
        &self,
        session: SessionIndex,
        namespace: u8,
        block: u64,
    ) -> Result<Box<[u8; BLOCK_SIZE]>> {
        self.state
            .borrow()
            .read_block(session.as_u8(), namespace, block)
    }

    fn write_block(
        &mut self,
        session: SessionIndex,
        namespace: u8,
        block: u64,
        data: &[u8; BLOCK_SIZE],
    ) -> Result<()> {
        self.state
            .get_mut()
            .write_block(session.as_u8(), namespace, block, data);
        Ok(())
    }

    fn append_block(
        &mut self,
        session: SessionIndex,
        namespace: u8,
        data: &[u8; BLOCK_SIZE],
    ) -> Result<()> {
        self.state
            .get_mut()
            .append_block(session.as_u8(), namespace, data);
        Ok(())
    }

    fn block_count(&self, session: SessionIndex, namespace: u8) -> Result<u64> {
        Ok(self.state.borrow().block_count(session.as_u8(), namespace))
    }

    fn fsync(&self, _session: SessionIndex, _namespace: u8) -> Result<()> {
        Ok(())
    }

    fn reset_blockstream(&mut self, session: SessionIndex, namespace: u8) -> Result<()> {
        self.state
            .get_mut()
            .reset_blockstream(session.as_u8(), namespace);
        Ok(())
    }

    fn namespaces_with_data(&self, session: SessionIndex) -> Result<Vec<u8>> {
        Ok(self.state.borrow().namespaces_with_data(session.as_u8()))
    }
}

// ── KeypairStorage ──────────────────────────────────────────────────

impl KeypairStorage for IdbBlockStorage {
    fn read_keypair(&self, session: SessionIndex) -> Result<Zeroizing<Vec<u8>>> {
        self.state.borrow().read_keypair(session.as_u8())
    }

    fn write_keypair(&mut self, session: SessionIndex, data: &[u8]) -> Result<()> {
        self.state.get_mut().write_keypair(session.as_u8(), data)
    }
}
