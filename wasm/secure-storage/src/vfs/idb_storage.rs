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

use indexed_db_futures::prelude::*;
use js_sys::Uint8Array;
use wasm_bindgen::prelude::*;
use zeroize::Zeroizing;

use crate::constants::BLOCK_SIZE;
use crate::error::Result;
use crate::storage::{BlockStorage, KeypairStorage};
use crate::types::SessionIndex;
use crate::vfs::idb_state::{IdbKey, IdbStorageState};

const DB_NAME: &str = "secureStorage";
const STORE_NAME: &str = "blocks";
const DB_VERSION: u32 = 1;

// ── Low-level IDB helpers ───────────────────────────────────────────

/// Open (or create) the secureStorage IndexedDB database.
async fn open_db() -> std::result::Result<IdbDatabase, JsValue> {
    let mut req = IdbDatabase::open_u32(DB_NAME, DB_VERSION)?;
    req.set_on_upgrade_needed(Some(|evt: &IdbVersionChangeEvent| -> std::result::Result<(), JsValue> {
        let db = evt.db();
        if !db.object_store_names().any(|n| n == STORE_NAME) {
            db.create_object_store(STORE_NAME)?;
        }
        Ok(())
    }));
    Ok(req.into_future().await?)
}

/// Load every (key, value) pair currently in the store.
///
/// IDB transactions in some browsers commit as soon as the microtask
/// queue runs empty, which can happen at any `.await` boundary. To
/// keep both `getAllKeys` and `getAll` inside the same transaction we
/// register both requests synchronously *before* awaiting either, then
/// await them in order.
async fn load_all_entries(
    db: &IdbDatabase,
) -> std::result::Result<Vec<(String, Vec<u8>)>, JsValue> {
    let tx = db.transaction_on_one(STORE_NAME)?;
    let store = tx.object_store(STORE_NAME)?;

    let keys_req = store.get_all_keys()?;
    let vals_req = store.get_all()?;

    let keys_js = keys_req.await?;
    let vals_js = vals_req.await?;
    tx.await.into_result()?;

    let len = keys_js.length() as usize;
    let mut out = Vec::with_capacity(len);
    for i in 0..len {
        let key_js = keys_js.get(i as u32);
        let val_js = vals_js.get(i as u32);
        let key = key_js.as_string().unwrap_or_default();
        let val = Uint8Array::new(&val_js);
        let mut buf = vec![0u8; val.length() as usize];
        val.copy_to(&mut buf);
        out.push((key, buf));
    }
    Ok(out)
}

/// True if the store contains at least one entry.
async fn has_any_data(db: &IdbDatabase) -> std::result::Result<bool, JsValue> {
    let tx = db.transaction_on_one(STORE_NAME)?;
    let store = tx.object_store(STORE_NAME)?;
    let n = store.count()?.await?;
    Ok(n > 0)
}

/// Apply puts and deletes in a single atomic readwrite transaction.
async fn batch_update(
    db: &IdbDatabase,
    puts: &[(String, Uint8Array)],
    deletes: &[String],
) -> std::result::Result<(), JsValue> {
    if puts.is_empty() && deletes.is_empty() {
        return Ok(());
    }
    let tx = db.transaction_on_one_with_mode(STORE_NAME, IdbTransactionMode::Readwrite)?;
    let store = tx.object_store(STORE_NAME)?;
    for (k, v) in puts {
        store.put_key_val(&JsValue::from_str(k), v)?;
    }
    for k in deletes {
        store.delete(&JsValue::from_str(k))?;
    }
    Ok(tx.await.into_result()?)
}

// ── Storage type ────────────────────────────────────────────────────

/// IndexedDB-backed block storage for secureStorage.
///
/// All in-memory state lives in [`IdbStorageState`] behind a single
/// `RefCell` (single-threaded WASM, no `Mutex` needed).
pub struct IdbBlockStorage {
    db: IdbDatabase,
    state: RefCell<IdbStorageState>,
}

impl IdbBlockStorage {
    /// Open IDB and load all entries into the in-memory state.
    ///
    /// NOTE: loads the entire DB eagerly. Acceptable for typical DB sizes
    /// (< 10 MB) but will need demand-paging for large databases.
    pub async fn open() -> std::result::Result<Self, JsValue> {
        let db = open_db().await?;
        let entries = load_all_entries(&db).await?;
        let entries_iter = entries.iter().map(|(k, v)| (k.as_str(), v.as_slice()));
        let (state, _skipped) = IdbStorageState::from_entries(entries_iter);
        Ok(Self {
            db,
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

    /// Persist all pending puts and deletes to IDB in a single atomic
    /// transaction.
    ///
    /// Uses the drain/restore pattern: phase 1 atomically drains the
    /// dirty/tombstone sets into a snapshot (state becomes clean).
    /// Phase 2 commits the snapshot to IDB. On success, the snapshot
    /// is dropped. On failure, [`IdbStorageState::restore_pending`]
    /// puts the entries back so the next flush retries.
    ///
    /// New writes that arrive while phase 2 is in flight are
    /// re-marked dirty naturally and captured at the next drain —
    /// no race, no data loss, even when overwriting the same block.
    pub async fn persist_dirty(&self) -> std::result::Result<(), JsValue> {
        // Phase 1: drain (sync, under borrow_mut). Atomically empties
        // the dirty/tombstone sets and captures their contents.
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
        let mut puts: Vec<(String, Uint8Array)> =
            Vec::with_capacity(snapshot.block_puts.len() + snapshot.keypair_puts.len());
        for ((session, namespace, idx), data) in &snapshot.block_puts {
            let key = IdbKey::Block {
                session: *session,
                namespace: *namespace,
                idx: *idx,
            }
            .encode();
            puts.push((key, Uint8Array::from(&data[..])));
        }
        for (session, data) in &snapshot.keypair_puts {
            let key = IdbKey::Keypair { session: *session }.encode();
            puts.push((key, Uint8Array::from(data.as_slice())));
        }
        let deletes: Vec<String> = snapshot
            .deletes
            .iter()
            .map(|(session, namespace, idx)| {
                IdbKey::Block {
                    session: *session,
                    namespace: *namespace,
                    idx: *idx,
                }
                .encode()
            })
            .collect();

        // Phase 2: atomic commit to IDB. On failure, restore the
        // snapshot so the next flush will retry.
        if let Err(e) = batch_update(&self.db, &puts, &deletes).await {
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

    fn init_blockstream(&mut self, session: SessionIndex, namespace: u8) -> Result<()> {
        self.state
            .get_mut()
            .init_blockstream(session.as_u8(), namespace);
        Ok(())
    }
}

// ── KeypairStorage ──────────────────────────────────────────────────

impl KeypairStorage for IdbBlockStorage {
    fn read_keypair(&self, session: SessionIndex) -> Result<Zeroizing<Vec<u8>>> {
        self.state.borrow().read_keypair(session.as_u8())
    }

    fn write_keypair(&mut self, session: SessionIndex, data: &[u8]) -> Result<()> {
        self.state.get_mut().write_keypair(session.as_u8(), data);
        Ok(())
    }
}
