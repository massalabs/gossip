//! The [`Pools`] store.

use std::ops::Bound;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use crossbeam::channel::Sender;
use gossip_wire::{hash_pool_key, BlobEnvelope, BlobEnvelopeDeserializer, BlobId, BlobKind, Scope};
use massa_serialization::{DeserializeError, Deserializer};
use parking_lot::Mutex;
use redb::{
    Database, Durability, ReadTransaction, ReadableTable, ReadableTableMetadata, Table,
    WriteTransaction,
};

use crate::config::PoolsConfig;
use crate::error::PoolError;
use crate::schema::{
    self, Meta, BLOBS, BULLETIN, BULLETIN_BY_ID, BY_TRUST, COUNTERS, COUNTER_BLOB_COUNT,
    COUNTER_BULLETIN_COUNTER, COUNTER_CHECKPOINT_MS, COUNTER_MESH_BYTES, COUNTER_MESH_COUNT,
    COUNTER_SCHEMA_VERSION, COUNTER_TOTAL_BYTES, EXPIRY, HASH, KV, LEGACY_OWN_UPLOAD,
    MAX_INDEX_KEY_LEN, MAX_PEER_LEN, MESH_EXPIRY, META, MIN_SCHEMA_VERSION, SCHEMA_VERSION, UPLOAD,
};
use crate::sweeper::SweeperHandle;
use crate::types::{ExpiryCursor, InsertOutcome, KvSigMaterial, PoolStats, RejectReason, Source};

/// Number of index keys collected per scan step while evicting or sweeping.
const SCAN_CHUNK: usize = 256;

/// The three pools on one `redb` file.
///
/// Cheap to share: every method takes `&self`; reads run concurrently, writes are
/// serialized by `redb`. Open with [`Pools::open`].
pub struct Pools {
    cfg: PoolsConfig,
    db: Database,
    bulletin_counter: AtomicU64,
    eviction_sink: Mutex<Option<Sender<Vec<BlobId>>>>,
    had_own_marks: bool,
}

impl std::fmt::Debug for Pools {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Pools")
            .field("path", &self.cfg.path)
            .field(
                "bulletin_counter",
                &self.bulletin_counter.load(Ordering::Relaxed),
            )
            .finish_non_exhaustive()
    }
}

/// In-memory copy of the `counters` table for the duration of a write transaction.
#[derive(Clone, Copy, Debug, Default)]
struct Counters {
    total_bytes: u64,
    blob_count: u64,
    bulletin_counter: u64,
    mesh_bytes: u64,
    mesh_count: u64,
}

/// Every table, opened once per write transaction.
struct Tables<'txn> {
    blobs: Table<'txn, [u8; 32], &'static [u8]>,
    meta: Table<'txn, [u8; 32], &'static [u8]>,
    bulletin: Table<'txn, u64, [u8; 32]>,
    bulletin_by_id: Table<'txn, [u8; 32], u64>,
    kv: Table<'txn, &'static [u8], [u8; 32]>,
    hash: Table<'txn, [u8; 32], [u8; 32]>,
    expiry: Table<'txn, (u64, [u8; 32]), ()>,
    by_trust: Table<'txn, (u8, u64, [u8; 32]), ()>,
    mesh_expiry: Table<'txn, (u64, [u8; 32]), ()>,
    upload: Table<'txn, [u8; 32], ()>,
    counters: Table<'txn, &'static str, u64>,
    c: Counters,
    dirty: bool,
}

impl<'txn> Tables<'txn> {
    fn open(txn: &'txn WriteTransaction) -> Result<Self, PoolError> {
        let counters = txn.open_table(COUNTERS)?;
        let read = |k: &str| -> Result<u64, PoolError> {
            Ok(counters.get(k)?.map(|g| g.value()).unwrap_or(0))
        };
        let c = Counters {
            total_bytes: read(COUNTER_TOTAL_BYTES)?,
            blob_count: read(COUNTER_BLOB_COUNT)?,
            bulletin_counter: read(COUNTER_BULLETIN_COUNTER)?,
            mesh_bytes: read(COUNTER_MESH_BYTES)?,
            mesh_count: read(COUNTER_MESH_COUNT)?,
        };
        Ok(Self {
            blobs: txn.open_table(BLOBS)?,
            meta: txn.open_table(META)?,
            bulletin: txn.open_table(BULLETIN)?,
            bulletin_by_id: txn.open_table(BULLETIN_BY_ID)?,
            kv: txn.open_table(KV)?,
            hash: txn.open_table(HASH)?,
            expiry: txn.open_table(EXPIRY)?,
            by_trust: txn.open_table(BY_TRUST)?,
            mesh_expiry: txn.open_table(MESH_EXPIRY)?,
            upload: txn.open_table(UPLOAD)?,
            counters,
            c,
            dirty: false,
        })
    }

    /// Writes the counters back. Returns whether anything changed in this transaction.
    fn save(&mut self) -> Result<bool, PoolError> {
        if self.dirty {
            self.counters
                .insert(COUNTER_TOTAL_BYTES, &self.c.total_bytes)?;
            self.counters
                .insert(COUNTER_BLOB_COUNT, &self.c.blob_count)?;
            self.counters
                .insert(COUNTER_BULLETIN_COUNTER, &self.c.bulletin_counter)?;
            self.counters
                .insert(COUNTER_MESH_BYTES, &self.c.mesh_bytes)?;
            self.counters
                .insert(COUNTER_MESH_COUNT, &self.c.mesh_count)?;
        }
        Ok(self.dirty)
    }

    /// Removes a blob and all its index entries. `Ok(None)` if it was not stored.
    fn remove(&mut self, id: &BlobId) -> Result<Option<Meta>, PoolError> {
        let idb = *id.as_bytes();
        let meta = match self.meta.remove(&idb)? {
            Some(guard) => Meta::decode(guard.value())?,
            None => return Ok(None),
        };
        self.dirty = true;
        self.blobs.remove(&idb)?;
        self.expiry.remove(&meta.expiry_key(id))?;
        self.by_trust.remove(&meta.trust_key(id))?;
        self.unindex_scope(id, &meta)?;
        match meta.kind {
            BlobKind::Bulletin => {
                let counter = self.bulletin_by_id.remove(&idb)?.map(|g| g.value());
                if let Some(counter) = counter {
                    self.bulletin.remove(&counter)?;
                }
            }
            BlobKind::KeyValue => {
                let key = meta.index_key.as_slice();
                let owner = self.kv.get(key)?.map(|g| g.value());
                if owner == Some(idb) {
                    self.kv.remove(key)?;
                }
            }
            BlobKind::Hash => {
                let hk: [u8; 32] = meta
                    .index_key
                    .as_slice()
                    .try_into()
                    .map_err(|_| PoolError::corrupted("hash index key length"))?;
                let owner = self.hash.get(&hk)?.map(|g| g.value());
                if owner == Some(idb) {
                    self.hash.remove(&hk)?;
                }
            }
        }
        self.c.total_bytes = self.c.total_bytes.saturating_sub(u64::from(meta.size));
        self.c.blob_count = self.c.blob_count.saturating_sub(1);
        Ok(Some(meta))
    }

    /// Adds the scope indexes and counters of a stored blob.
    fn index_scope(&mut self, id: &BlobId, meta: &Meta) -> Result<(), PoolError> {
        if meta.scope.contains(Scope::MESH) {
            self.mesh_expiry.insert(&meta.expiry_key(id), ())?;
        }
        if meta.scope.contains(Scope::UPLOAD) {
            self.upload.insert(id.as_bytes(), ())?;
        }
        if meta.scope.is_mesh_only() {
            self.c.mesh_bytes = self.c.mesh_bytes.saturating_add(u64::from(meta.size));
            self.c.mesh_count += 1;
        }
        Ok(())
    }

    /// Removes the scope indexes and counters of a stored blob.
    fn unindex_scope(&mut self, id: &BlobId, meta: &Meta) -> Result<(), PoolError> {
        if meta.scope.contains(Scope::MESH) {
            self.mesh_expiry.remove(&meta.expiry_key(id))?;
        }
        if meta.scope.contains(Scope::UPLOAD) {
            self.upload.remove(id.as_bytes())?;
        }
        if meta.scope.is_mesh_only() {
            self.c.mesh_bytes = self.c.mesh_bytes.saturating_sub(u64::from(meta.size));
            self.c.mesh_count = self.c.mesh_count.saturating_sub(1);
        }
        Ok(())
    }

    /// Gives a stored blob the scope `scope`: rewrites its meta and its scope and expiry
    /// indexes (a mesh-only blob that gains `internet` takes the internet retention).
    /// Returns whether anything changed.
    fn set_scope(
        &mut self,
        id: &BlobId,
        meta: Meta,
        scope: Scope,
        cfg: &PoolsConfig,
    ) -> Result<bool, PoolError> {
        // a local-only blob never waits for an upload
        let scope = scope.normalized();
        if meta.scope == scope {
            return Ok(false);
        }
        let mut new = meta.clone();
        new.scope = scope;
        // the retention class changes only when the blob enters or leaves mesh-only
        if meta.scope.is_mesh_only() != scope.is_mesh_only() {
            new.expires_at = meta.created_at.saturating_add(cfg.retention_for(scope));
        }
        self.unindex_scope(id, &meta)?;
        if new.expires_at != meta.expires_at {
            self.expiry.remove(&meta.expiry_key(id))?;
            self.expiry.insert(&new.expiry_key(id), ())?;
        }
        self.index_scope(id, &new)?;
        self.meta.insert(id.as_bytes(), new.encode().as_slice())?;
        self.dirty = true;
        Ok(true)
    }

    /// Meta of a blob an index points at; a dangling index is corruption.
    fn meta_indexed(&self, id: &BlobId, index: &str) -> Result<Meta, PoolError> {
        self.read_meta(id)?
            .ok_or_else(|| PoolError::corrupted(format!("{index} index points at a missing meta")))
    }

    /// Envelope a write-transaction index points at; a dangling index is corruption.
    fn load_indexed(&self, id: &BlobId, index: &str) -> Result<BlobEnvelope, PoolError> {
        match self.blobs.get(id.as_bytes())? {
            Some(guard) => decode_envelope(guard.value()),
            None => Err(PoolError::corrupted(format!(
                "{index} index points at a missing blob"
            ))),
        }
    }

    fn read_meta(&self, id: &BlobId) -> Result<Option<Meta>, PoolError> {
        match self.meta.get(id.as_bytes())? {
            Some(guard) => Ok(Some(Meta::decode(guard.value())?)),
            None => Ok(None),
        }
    }
}

/// Decodes canonical envelope bytes read back from the store.
fn decode_envelope(bytes: &[u8]) -> Result<BlobEnvelope, PoolError> {
    let (rest, env) = BlobEnvelopeDeserializer::new(u64::MAX, u64::MAX)
        .deserialize::<DeserializeError>(bytes)
        .map_err(|_| PoolError::corrupted("blob envelope"))?;
    if !rest.is_empty() {
        return Err(PoolError::corrupted("blob envelope trailing bytes"));
    }
    Ok(env)
}

/// Loads and decodes one envelope in a read transaction.
fn load_envelope(
    blobs: &redb::ReadOnlyTable<[u8; 32], &'static [u8]>,
    id: &[u8; 32],
) -> Result<Option<BlobEnvelope>, PoolError> {
    match blobs.get(id)? {
        Some(guard) => Ok(Some(decode_envelope(guard.value())?)),
        None => Ok(None),
    }
}

/// Loads an envelope that an index points at; a dangling index is corruption.
fn load_indexed(
    blobs: &redb::ReadOnlyTable<[u8; 32], &'static [u8]>,
    id: &[u8; 32],
    index: &str,
) -> Result<BlobEnvelope, PoolError> {
    load_envelope(blobs, id)?
        .ok_or_else(|| PoolError::corrupted(format!("{index} index points at a missing blob")))
}

/// Wire size recorded in a blob's `meta` record, without loading the envelope.
fn stored_size(
    meta: &redb::ReadOnlyTable<[u8; 32], &'static [u8]>,
    id: &BlobId,
) -> Result<Option<usize>, PoolError> {
    match meta.get(id.as_bytes())? {
        Some(guard) => Ok(Some(Meta::decode(guard.value())?.size as usize)),
        None => Ok(None),
    }
}

/// Cumulative byte budget for bounded reads: admits an item if it fits, and always
/// admits the first one.
struct ByteBudget {
    max: usize,
    used: usize,
    admitted: usize,
}

impl ByteBudget {
    fn new(max: usize) -> Self {
        Self {
            max,
            used: 0,
            admitted: 0,
        }
    }

    fn admit(&mut self, size: usize) -> bool {
        let next = self.used.saturating_add(size);
        if self.admitted > 0 && next > self.max {
            return false;
        }
        self.used = next;
        self.admitted += 1;
        true
    }
}

impl Pools {
    /// Opens (or creates) the store at `cfg.path`, creating every table, checking the
    /// schema version and restoring the bulletin counter.
    pub fn open(cfg: PoolsConfig) -> Result<Arc<Pools>, PoolError> {
        if let Some(parent) = cfg.path.parent() {
            if !parent.as_os_str().is_empty() {
                std::fs::create_dir_all(parent)?;
            }
        }
        let db = Database::builder().create(&cfg.path)?;
        Self::from_db(cfg, db)
    }

    /// Opens (or creates) the store on a custom `redb` storage backend, for example one
    /// that encrypts the file (the mobile node). `cfg.path` is only used in logs.
    pub fn open_with_backend(
        cfg: PoolsConfig,
        backend: impl redb::StorageBackend,
    ) -> Result<Arc<Pools>, PoolError> {
        let db = Database::builder().create_with_backend(backend)?;
        Self::from_db(cfg, db)
    }

    fn from_db(cfg: PoolsConfig, db: Database) -> Result<Arc<Pools>, PoolError> {
        let txn = db.begin_write()?;
        // written by development builds only: the scope bit it went with reads as unset
        let had_own_marks = txn.delete_table(LEGACY_OWN_UPLOAD)?;
        let bulletin_counter = {
            let mut t = Tables::open(&txn)?;
            let version = t.counters.get(COUNTER_SCHEMA_VERSION)?.map(|g| g.value());
            match version {
                Some(found) if !(MIN_SCHEMA_VERSION..=SCHEMA_VERSION).contains(&found) => {
                    return Err(PoolError::SchemaVersion {
                        found,
                        expected: SCHEMA_VERSION,
                    })
                }
                Some(found) if found < SCHEMA_VERSION => {
                    // schema 1 records read as internet scope: only the version moves
                    t.counters.insert(COUNTER_SCHEMA_VERSION, &SCHEMA_VERSION)?;
                    t.dirty = true;
                    t.save()?;
                    tracing::info!(from = found, to = SCHEMA_VERSION, "pools schema upgraded");
                }
                Some(_) => {}
                None => {
                    t.counters.insert(COUNTER_SCHEMA_VERSION, &SCHEMA_VERSION)?;
                    t.dirty = true;
                    t.save()?;
                }
            }
            t.c.bulletin_counter
        };
        txn.commit()?;
        tracing::info!(path = %cfg.path.display(), bulletin_counter, "pools opened");
        Ok(Arc::new(Pools {
            cfg,
            db,
            bulletin_counter: AtomicU64::new(bulletin_counter),
            eviction_sink: Mutex::new(None),
            had_own_marks,
        }))
    }

    /// Whether the file was written by a development build that marked the local app's
    /// blobs (an `own_upload` table, now deleted). Their old scope bytes read as
    /// unset, but older copies of those pages may survive in free space: a phone
    /// discards such a store (see `gossip-mobile`).
    pub fn had_own_marks(&self) -> bool {
        self.had_own_marks
    }

    /// Configuration this store was opened with.
    pub fn config(&self) -> &PoolsConfig {
        &self.cfg
    }

    /// Receives the ids of blobs removed as a side effect of inserts: pressure
    /// eviction inside [`Pools::insert`] and friends, and stored `KeyValue` / `Hash`
    /// copies replaced by an identical copy that expires later. Removals performed by
    /// [`Pools::sweep_expired`], [`Pools::evict_under_pressure`] and the sweeper are
    /// returned to their callers instead and never go through this channel.
    pub fn set_eviction_sink(&self, sink: Option<Sender<Vec<BlobId>>>) {
        *self.eviction_sink.lock() = sink;
    }

    /// Pure structural validation (size, key rules, time window, KV layout and
    /// key/public-key match). See [`PoolsConfig::validate`].
    ///
    /// For `KeyValue` blobs the signature material is returned for batch verification;
    /// when `verify_kv_signature` is `true` the signature is verified here and
    /// `Ok(None)` is returned.
    pub fn validate(
        &self,
        env: &BlobEnvelope,
        now_ms: u64,
        verify_kv_signature: bool,
    ) -> Result<Option<KvSigMaterial>, RejectReason> {
        self.cfg.validate(env, now_ms, verify_kv_signature)
    }

    /// Validation for a blob that will be stored with `scope`. See
    /// [`PoolsConfig::validate_scoped`].
    pub fn validate_scoped(
        &self,
        env: &BlobEnvelope,
        now_ms: u64,
        verify_kv_signature: bool,
        scope: Scope,
    ) -> Result<Option<KvSigMaterial>, RejectReason> {
        self.cfg
            .validate_scoped(env, now_ms, verify_kv_signature, scope)
    }

    /// Validates (including the KV signature) then inserts.
    pub fn insert(
        &self,
        env: BlobEnvelope,
        src: Source,
        now_ms: u64,
    ) -> Result<InsertOutcome, PoolError> {
        if let Err(reason) = self.validate(&env, now_ms, true) {
            return Ok(InsertOutcome::Rejected(reason));
        }
        self.insert_prevalidated(env, src, now_ms)
    }

    /// Inserts a blob the caller has already fully validated with [`Pools::validate`]
    /// (the network batch path, after `verify_signature_batch`).
    ///
    /// No structural or cryptographic check is repeated here: **the caller is
    /// responsible for it**; a `KeyValue` blob with a bad signature is stored as is.
    /// Index rules (first writer wins, hash de-duplication, later-expiry replacement),
    /// the `AlreadyPresent` check and storage pressure are still enforced.
    pub fn insert_prevalidated(
        &self,
        env: BlobEnvelope,
        src: Source,
        now_ms: u64,
    ) -> Result<InsertOutcome, PoolError> {
        let mut outcomes = self.insert_many_prevalidated(vec![(env, src)], now_ms)?;
        Ok(outcomes.pop().expect("one outcome per item"))
    }

    /// One write transaction for many prevalidated blobs; outcomes are in input order.
    /// A duplicate inside the batch is reported `AlreadyPresent` for its later copies.
    pub fn insert_many_prevalidated(
        &self,
        items: Vec<(BlobEnvelope, Source)>,
        now_ms: u64,
    ) -> Result<Vec<InsertOutcome>, PoolError> {
        if items.is_empty() {
            return Ok(Vec::new());
        }
        let mut evicted = Vec::new();
        let mut outcomes = Vec::with_capacity(items.len());
        let txn = self.begin_write()?;
        let (changed, bulletin_counter) = {
            let mut t = Tables::open(&txn)?;
            for (env, src) in &items {
                outcomes.push(self.insert_in_txn(&mut t, env, src, now_ms, &mut evicted)?);
            }
            (t.save()?, t.c.bulletin_counter)
        };
        if changed {
            txn.commit()?;
            self.bulletin_counter
                .fetch_max(bulletin_counter, Ordering::AcqRel);
        } else {
            txn.abort()?;
        }
        self.report_evicted(evicted);
        Ok(outcomes)
    }

    fn insert_in_txn(
        &self,
        t: &mut Tables<'_>,
        env: &BlobEnvelope,
        src: &Source,
        now_ms: u64,
        evicted: &mut Vec<BlobId>,
    ) -> Result<InsertOutcome, PoolError> {
        let id = env.id();
        let idb = *id.as_bytes();
        if t.blobs.get(&idb)?.is_some() {
            let counter = match env.kind {
                BlobKind::Bulletin => t.bulletin_by_id.get(&idb)?.map(|g| g.value()),
                _ => None,
            };
            self.merge_scope(t, &id, src.scope)?;
            return Ok(InsertOutcome::AlreadyPresent { id, counter });
        }
        if env.key.len() > MAX_INDEX_KEY_LEN {
            return Ok(InsertOutcome::Rejected(RejectReason::KeyTooLarge));
        }
        let expires_at = self.cfg.expires_at_scoped(env, src.scope);
        let mut scope = src.scope.normalized();
        // `created_at` is not signed, so anyone can re-wrap a stored entry with an
        // earlier `created_at` and race it to nodes. Same key (KV) or same content
        // hash (Hash) with a byte-identical payload is the same data: keep whichever
        // copy expires last, so a downgraded copy can never shadow the genuine one.
        let mut replaces: Option<(BlobId, Meta)> = None;
        let index_key: Vec<u8> = match env.kind {
            BlobKind::Bulletin => Vec::new(),
            BlobKind::KeyValue => {
                let owner = t.kv.get(env.key.as_slice())?.map(|g| g.value());
                if let Some(owner) = owner {
                    let owner = BlobId::from_bytes(owner);
                    let stored = t.load_indexed(&owner, "kv")?;
                    if stored.payload != env.payload {
                        return Ok(InsertOutcome::Rejected(RejectReason::KeyTaken));
                    }
                    let meta = t.meta_indexed(&owner, "kv")?;
                    if expires_at <= meta.expires_at {
                        self.merge_scope(t, &owner, src.scope)?;
                        return Ok(InsertOutcome::AlreadyPresent {
                            id: owner,
                            counter: None,
                        });
                    }
                    scope = meta.scope.merged(scope);
                    replaces = Some((owner, meta));
                }
                env.key.clone()
            }
            BlobKind::Hash => {
                let hk = hash_pool_key(&env.payload);
                let owner = t.hash.get(&hk)?.map(|g| g.value());
                if let Some(owner) = owner {
                    let owner = BlobId::from_bytes(owner);
                    let meta = t.meta_indexed(&owner, "hash")?;
                    if expires_at <= meta.expires_at {
                        self.merge_scope(t, &owner, src.scope)?;
                        return Ok(InsertOutcome::AlreadyPresent {
                            id: owner,
                            counter: None,
                        });
                    }
                    scope = meta.scope.merged(scope);
                    replaces = Some((owner, meta));
                }
                hk.to_vec()
            }
        };

        let size = env.wire_size() as u64;
        // A replacement has the same key and payload, hence the same wire size: it is
        // neutral for both caps, so it skips the pressure check (and can never be
        // refused with `PoolFull` after the old copy was removed). It keeps the higher
        // of the two trust buckets so a low-trust re-wrap cannot strip eviction
        // protection from the stored copy.
        let mut trust_bucket = src.bucket();
        if let Some((old_id, old)) = replaces {
            t.remove(&old_id)?;
            evicted.push(old_id);
            trust_bucket = trust_bucket.max(old.trust_bucket);
        } else {
            if self.over_caps(&t.c, size, 1) {
                let removed = self.evict_in_txn(t, size, 1, Some(src.bucket()))?;
                evicted.extend(removed);
                if self.over_caps(&t.c, size, 1) {
                    return Ok(InsertOutcome::Rejected(RejectReason::PoolFull));
                }
            }
            if scope.is_mesh_only() && self.over_mesh_caps(&t.c, size, 1) {
                let removed = self.evict_mesh_in_txn(t, size, 1, src.bucket())?;
                evicted.extend(removed);
                if self.over_mesh_caps(&t.c, size, 1) {
                    return Ok(InsertOutcome::Rejected(RejectReason::PoolFull));
                }
            }
        }

        let counter = match env.kind {
            BlobKind::Bulletin => {
                t.c.bulletin_counter += 1;
                Some(t.c.bulletin_counter)
            }
            _ => None,
        };
        let (received_at, source_peer) = if self.cfg.record_provenance {
            let mut peer = src.peer.clone().unwrap_or_default();
            peer.truncate(MAX_PEER_LEN);
            (now_ms, peer)
        } else {
            (0, Vec::new())
        };
        let meta = Meta {
            received_at,
            expires_at,
            created_at: env.created_at,
            size: u32::try_from(size).unwrap_or(u32::MAX),
            trust_bucket,
            kind: env.kind,
            index_key,
            source_peer,
            scope,
        };
        let bytes = env.canonical_bytes();
        t.blobs.insert(&idb, bytes.as_slice())?;
        t.meta.insert(&idb, meta.encode().as_slice())?;
        t.expiry.insert(&meta.expiry_key(&id), ())?;
        t.by_trust.insert(&meta.trust_key(&id), ())?;
        t.index_scope(&id, &meta)?;
        match env.kind {
            BlobKind::Bulletin => {
                let c = counter.expect("bulletin counter assigned");
                t.bulletin.insert(&c, &idb)?;
                t.bulletin_by_id.insert(&idb, &c)?;
            }
            BlobKind::KeyValue => {
                t.kv.insert(env.key.as_slice(), &idb)?;
            }
            BlobKind::Hash => {
                let hk: [u8; 32] = meta.index_key.as_slice().try_into().expect("32 bytes");
                t.hash.insert(&hk, &idb)?;
            }
        }
        t.c.total_bytes = t.c.total_bytes.saturating_add(size);
        t.c.blob_count += 1;
        t.dirty = true;
        Ok(InsertOutcome::Inserted { id, counter })
    }

    /// Adds the flags of `add` to the scope of a stored blob.
    fn merge_scope(&self, t: &mut Tables<'_>, id: &BlobId, add: Scope) -> Result<(), PoolError> {
        if let Some(meta) = t.read_meta(id)? {
            let scope = meta.scope.merged(add);
            t.set_scope(id, meta, scope, &self.cfg)?;
        }
        Ok(())
    }

    fn over_mesh_caps(&self, c: &Counters, extra_bytes: u64, extra_count: u64) -> bool {
        c.mesh_bytes.saturating_add(extra_bytes) > self.cfg.mesh_max_bytes
            || c.mesh_count.saturating_add(extra_count) > self.cfg.mesh_max_blob_count
    }

    /// Evicts mesh-only blobs until mesh usage plus `extra` is at or below the low
    /// watermark of the mesh caps, never removing a blob whose trust bucket is above
    /// `max_bucket`. Order: lowest bucket first, oldest first; blobs waiting for an
    /// upload only once no other candidate is left. Internet blobs are never touched.
    fn evict_mesh_in_txn(
        &self,
        t: &mut Tables<'_>,
        extra_bytes: u64,
        extra_count: u64,
        max_bucket: u8,
    ) -> Result<Vec<BlobId>, PoolError> {
        let target_bytes = self.cfg.watermark(self.cfg.mesh_max_bytes);
        let target_count = self.cfg.watermark(self.cfg.mesh_max_blob_count);
        let need_more = |c: &Counters| {
            c.mesh_bytes.saturating_add(extra_bytes) > target_bytes
                || c.mesh_count.saturating_add(extra_count) > target_count
        };
        let mut removed = Vec::new();
        for spare_uploads in [true, false] {
            let mut cursor: Option<(u8, u64, [u8; 32])> = None;
            'scan: loop {
                if !need_more(&t.c) {
                    return Ok(removed);
                }
                let lower = cursor.map_or(Bound::Unbounded, Bound::Excluded);
                let upper = Bound::Included((max_bucket, u64::MAX, [0xff; 32]));
                let mut chunk = Vec::with_capacity(SCAN_CHUNK);
                for item in t.by_trust.range((lower, upper))?.take(SCAN_CHUNK) {
                    chunk.push(item?.0.value());
                }
                if chunk.is_empty() {
                    break;
                }
                for key in chunk {
                    cursor = Some(key);
                    let id = BlobId::from_bytes(key.2);
                    let Some(meta) = t.read_meta(&id)? else {
                        continue;
                    };
                    if !meta.scope.is_mesh_only()
                        || (spare_uploads && meta.scope.contains(Scope::UPLOAD))
                    {
                        continue;
                    }
                    if t.remove(&id)?.is_some() {
                        removed.push(id);
                    }
                    if !need_more(&t.c) {
                        break 'scan;
                    }
                }
            }
        }
        Ok(removed)
    }

    fn over_caps(&self, c: &Counters, extra_bytes: u64, extra_count: u64) -> bool {
        c.total_bytes.saturating_add(extra_bytes) > self.cfg.max_total_bytes
            || c.blob_count.saturating_add(extra_count) > self.cfg.max_blob_count
    }

    /// Evicts until `usage + extra <= watermark` (both caps), never removing a blob
    /// whose trust bucket is above `max_bucket`. Order: buckets below
    /// `protected_trust_bucket` ascending, oldest `created_at` first within a bucket;
    /// then, only if that was not enough, protected blobs by age alone.
    fn evict_in_txn(
        &self,
        t: &mut Tables<'_>,
        extra_bytes: u64,
        extra_count: u64,
        max_bucket: Option<u8>,
    ) -> Result<Vec<BlobId>, PoolError> {
        let mut removed = Vec::new();
        if !self.over_caps(&t.c, extra_bytes, extra_count) {
            return Ok(removed);
        }
        let target_bytes = self.cfg.watermark(self.cfg.max_total_bytes);
        let target_count = self.cfg.watermark(self.cfg.max_blob_count);
        let need_more = |c: &Counters| {
            c.total_bytes.saturating_add(extra_bytes) > target_bytes
                || c.blob_count.saturating_add(extra_count) > target_count
        };
        let protected = self.cfg.protected_trust_bucket;
        let highest = max_bucket.unwrap_or(Source::MAX_TRUST_BUCKET);

        // Pass 1: unprotected buckets, lowest first, oldest first.
        if protected > 0 {
            let hi = (protected - 1).min(highest);
            let mut cursor: Option<(u8, u64, [u8; 32])> = None;
            'pass1: loop {
                let lower = cursor.map_or(Bound::Unbounded, Bound::Excluded);
                let upper = Bound::Included((hi, u64::MAX, [0xff; 32]));
                let mut chunk = Vec::with_capacity(SCAN_CHUNK);
                for item in t.by_trust.range((lower, upper))?.take(SCAN_CHUNK) {
                    chunk.push(item?.0.value());
                }
                if chunk.is_empty() {
                    break;
                }
                for key in chunk {
                    cursor = Some(key);
                    let id = BlobId::from_bytes(key.2);
                    if t.remove(&id)?.is_some() {
                        removed.push(id);
                    }
                    if !need_more(&t.c) {
                        break 'pass1;
                    }
                }
            }
        }

        // Pass 2: protected buckets by age (expiry order == created_at order).
        if need_more(&t.c) && highest >= protected {
            let mut cursor: Option<(u64, [u8; 32])> = None;
            'pass2: loop {
                let lower = cursor.map_or(Bound::Unbounded, Bound::Excluded);
                let mut chunk = Vec::with_capacity(SCAN_CHUNK);
                for item in t.expiry.range((lower, Bound::Unbounded))?.take(SCAN_CHUNK) {
                    chunk.push(item?.0.value());
                }
                if chunk.is_empty() {
                    break;
                }
                for key in chunk {
                    cursor = Some(key);
                    let id = BlobId::from_bytes(key.1);
                    if max_bucket.is_some() {
                        match t.read_meta(&id)? {
                            Some(m) if m.trust_bucket > highest => continue,
                            _ => {}
                        }
                    }
                    if t.remove(&id)?.is_some() {
                        removed.push(id);
                    }
                    if !need_more(&t.c) {
                        break 'pass2;
                    }
                }
            }
        }
        Ok(removed)
    }

    fn report_evicted(&self, evicted: Vec<BlobId>) {
        if evicted.is_empty() {
            return;
        }
        tracing::debug!(count = evicted.len(), "pools evicted blobs under pressure");
        if let Some(tx) = self.eviction_sink.lock().as_ref() {
            let _ = tx.send(evicted);
        }
    }

    fn begin_write(&self) -> Result<WriteTransaction, PoolError> {
        let mut txn = self.db.begin_write()?;
        if !self.cfg.sync_writes {
            txn.set_durability(Durability::None);
        }
        Ok(txn)
    }

    /// Makes every committed write durable now (fsync). A no-op in effect when
    /// `sync_writes` is on, since each commit is already durable; with it off this is
    /// the only way data reaches disk, and it also lets `redb` reclaim freed pages.
    pub fn checkpoint(&self) -> Result<(), PoolError> {
        let txn = self.db.begin_write()?; // default durability: Immediate
        txn.open_table(COUNTERS)?
            .insert(COUNTER_CHECKPOINT_MS, &crate::now_ms())?;
        txn.commit()?;
        Ok(())
    }

    fn begin_read(&self) -> Result<ReadTransaction, PoolError> {
        Ok(self.db.begin_read()?)
    }

    /// Envelope by id.
    pub fn get(&self, id: &BlobId) -> Result<Option<BlobEnvelope>, PoolError> {
        let txn = self.begin_read()?;
        let blobs = txn.open_table(BLOBS)?;
        load_envelope(&blobs, id.as_bytes())
    }

    /// Envelopes for the ids found, in input order, with a cumulative wire size of at
    /// most `max_total_bytes`: a found blob that would exceed the budget is skipped
    /// (callers re-request what they did not get), except that the first found blob
    /// is always returned so a single large blob can still be served.
    ///
    /// Sizes come from the small `meta` record; an envelope is only loaded once it is
    /// known to fit, so the memory used is bounded by the budget (plus one blob).
    pub fn get_many(
        &self,
        ids: &[BlobId],
        max_total_bytes: usize,
    ) -> Result<Vec<BlobEnvelope>, PoolError> {
        let txn = self.begin_read()?;
        let blobs = txn.open_table(BLOBS)?;
        let meta = txn.open_table(META)?;
        let mut budget = ByteBudget::new(max_total_bytes);
        let mut out = Vec::new();
        for id in ids {
            let Some(size) = stored_size(&meta, id)? else {
                continue;
            };
            if !budget.admit(size) {
                continue;
            }
            out.push(load_indexed(&blobs, id.as_bytes(), "meta")?);
        }
        Ok(out)
    }

    /// Whether a blob is stored.
    pub fn contains(&self, id: &BlobId) -> Result<bool, PoolError> {
        let txn = self.begin_read()?;
        let blobs = txn.open_table(BLOBS)?;
        Ok(blobs.get(id.as_bytes())?.is_some())
    }

    /// Counter pool: `(counter, envelope)` for counters `> after`, ascending, at most
    /// `limit`. Counters of swept blobs are holes and are skipped.
    ///
    /// Unbounded in bytes: prefer [`Pools::bulletin_after_bounded`] for anything that
    /// serves remote clients.
    pub fn bulletin_after(
        &self,
        after: u64,
        limit: usize,
    ) -> Result<Vec<(u64, BlobEnvelope)>, PoolError> {
        self.bulletin_after_bounded(after, limit, usize::MAX)
    }

    /// Like [`Pools::bulletin_after`] with a cumulative wire-size budget. The page
    /// **stops** before the first entry that would exceed `max_total_bytes` (it never
    /// skips: clients page with the last counter returned, so a skipped entry would be
    /// missed forever); the first entry is always returned so paging always progresses.
    /// Sizes are read from `meta` before any envelope is loaded.
    pub fn bulletin_after_bounded(
        &self,
        after: u64,
        limit: usize,
        max_total_bytes: usize,
    ) -> Result<Vec<(u64, BlobEnvelope)>, PoolError> {
        let txn = self.begin_read()?;
        let bulletin = txn.open_table(BULLETIN)?;
        let blobs = txn.open_table(BLOBS)?;
        let meta = txn.open_table(META)?;
        let mut budget = ByteBudget::new(max_total_bytes);
        let mut out = Vec::new();
        for item in bulletin
            .range((Bound::Excluded(after), Bound::Unbounded))?
            .take(limit)
        {
            let (k, v) = item?;
            let id = BlobId::from_bytes(v.value());
            let size = stored_size(&meta, &id)?
                .ok_or_else(|| PoolError::corrupted("bulletin index points at a missing meta"))?;
            if !budget.admit(size) {
                break;
            }
            out.push((k.value(), load_indexed(&blobs, id.as_bytes(), "bulletin")?));
        }
        Ok(out)
    }

    /// Last assigned bulletin counter (0 if none). Cached; restored on open.
    pub fn bulletin_counter(&self) -> u64 {
        self.bulletin_counter.load(Ordering::Acquire)
    }

    /// Key-value pool lookup.
    pub fn kv_get(&self, key: &[u8]) -> Result<Option<BlobEnvelope>, PoolError> {
        let txn = self.begin_read()?;
        let kv = txn.open_table(KV)?;
        let blobs = txn.open_table(BLOBS)?;
        match kv.get(key)?.map(|g| g.value()) {
            Some(id) => Ok(Some(load_indexed(&blobs, &id, "kv")?)),
            None => Ok(None),
        }
    }

    /// Key-value pool lookup of many keys; only the found entries are returned, in
    /// input order. Unbounded in bytes: prefer [`Pools::kv_get_many_bounded`] for
    /// anything that serves remote clients.
    pub fn kv_get_many(&self, keys: &[Vec<u8>]) -> Result<Vec<BlobEnvelope>, PoolError> {
        self.kv_get_many_bounded(keys, usize::MAX)
    }

    /// Like [`Pools::kv_get_many`] with a cumulative wire-size budget: a found entry
    /// that would exceed `max_total_bytes` is skipped (keys are a set; callers
    /// re-request what they did not get), except that the first found entry is always
    /// returned. Sizes are read from `meta` before any envelope is loaded.
    pub fn kv_get_many_bounded(
        &self,
        keys: &[Vec<u8>],
        max_total_bytes: usize,
    ) -> Result<Vec<BlobEnvelope>, PoolError> {
        let txn = self.begin_read()?;
        let kv = txn.open_table(KV)?;
        let blobs = txn.open_table(BLOBS)?;
        let meta = txn.open_table(META)?;
        let mut budget = ByteBudget::new(max_total_bytes);
        let mut out = Vec::new();
        for key in keys {
            let Some(id) = kv.get(key.as_slice())?.map(|g| g.value()) else {
                continue;
            };
            let id = BlobId::from_bytes(id);
            let size = stored_size(&meta, &id)?
                .ok_or_else(|| PoolError::corrupted("kv index points at a missing meta"))?;
            if !budget.admit(size) {
                continue;
            }
            out.push(load_indexed(&blobs, id.as_bytes(), "kv")?);
        }
        Ok(out)
    }

    /// Hash pool lookup by `blake3(payload)`.
    pub fn hash_get(&self, key: &[u8; 32]) -> Result<Option<BlobEnvelope>, PoolError> {
        let txn = self.begin_read()?;
        let hash = txn.open_table(HASH)?;
        let blobs = txn.open_table(BLOBS)?;
        match hash.get(key)?.map(|g| g.value()) {
            Some(id) => Ok(Some(load_indexed(&blobs, &id, "hash")?)),
            None => Ok(None),
        }
    }

    /// Anti-entropy paging: ids ordered by `(expires_at, id)`, starting at
    /// `(from_expires_at, 0...)` inclusive, or strictly after `cursor` when given.
    /// Returns at most `max` ids and the cursor to continue from when more remain.
    pub fn ids_by_expiry(
        &self,
        from_expires_at: u64,
        cursor: Option<ExpiryCursor>,
        max: usize,
    ) -> Result<(Vec<BlobId>, Option<ExpiryCursor>), PoolError> {
        if max == 0 {
            return Ok((Vec::new(), cursor));
        }
        let txn = self.begin_read()?;
        let expiry = txn.open_table(EXPIRY)?;
        let lower = match cursor {
            Some((e, id)) => Bound::Excluded((e, *id.as_bytes())),
            None => Bound::Included((from_expires_at, [0u8; 32])),
        };
        let mut ids = Vec::with_capacity(max.min(SCAN_CHUNK));
        let mut last = None;
        let mut more = false;
        for item in expiry
            .range((lower, Bound::Unbounded))?
            .take(max.saturating_add(1))
        {
            let (k, _) = item?;
            if ids.len() == max {
                more = true;
                break;
            }
            let (e, id) = k.value();
            let id = BlobId::from_bytes(id);
            ids.push(id);
            last = Some((e, id));
        }
        Ok((ids, if more { last } else { None }))
    }

    /// Earliest and latest expiry timestamps held in the store, or `None` when it is
    /// empty. With a fixed retention this is the age range of the stored blobs.
    pub fn expiry_bounds(&self) -> Result<Option<(u64, u64)>, PoolError> {
        let txn = self.begin_read()?;
        let expiry = txn.open_table(EXPIRY)?;
        let first = expiry.first()?.map(|(k, _)| k.value().0);
        let last = expiry.last()?.map(|(k, _)| k.value().0);
        Ok(match (first, last) {
            (Some(first), Some(last)) => Some((first, last)),
            _ => None,
        })
    }

    /// Deletes at most `batch` blobs with `expires_at <= now_ms`, together with all
    /// their index entries; returns the removed ids.
    pub fn sweep_expired(&self, now_ms: u64, batch: usize) -> Result<Vec<BlobId>, PoolError> {
        if batch == 0 {
            return Ok(Vec::new());
        }
        let txn = self.begin_write()?;
        let (changed, removed) = {
            let mut t = Tables::open(&txn)?;
            let mut keys = Vec::new();
            let upper = Bound::Included((now_ms, [0xff; 32]));
            for item in t.expiry.range((Bound::Unbounded, upper))?.take(batch) {
                keys.push(item?.0.value().1);
            }
            let mut removed = Vec::with_capacity(keys.len());
            for idb in keys {
                let id = BlobId::from_bytes(idb);
                if t.remove(&id)?.is_some() {
                    removed.push(id);
                }
            }
            (t.save()?, removed)
        };
        if changed {
            txn.commit()?;
        } else {
            txn.abort()?;
        }
        Ok(removed)
    }

    /// If usage is over `max_total_bytes` or `max_blob_count`, evicts down to the low
    /// watermark: lowest trust bucket first, oldest `created_at` first, buckets at or
    /// above `protected_trust_bucket` last (by age alone). Returns the removed ids.
    pub fn evict_under_pressure(&self) -> Result<Vec<BlobId>, PoolError> {
        let stats = self.stats()?;
        let c = Counters {
            total_bytes: stats.total_bytes,
            blob_count: stats.blob_count,
            bulletin_counter: stats.bulletin_counter,
            mesh_bytes: stats.mesh_bytes,
            mesh_count: stats.mesh_count,
        };
        if !self.over_caps(&c, 0, 0) {
            return Ok(Vec::new());
        }
        let txn = self.begin_write()?;
        let (changed, removed) = {
            let mut t = Tables::open(&txn)?;
            let removed = self.evict_in_txn(&mut t, 0, 0, None)?;
            (t.save()?, removed)
        };
        if changed {
            txn.commit()?;
        } else {
            txn.abort()?;
        }
        Ok(removed)
    }

    /// One maintenance round, as run by the sweeper: sweeps every expired blob (in
    /// transactions of `sweep_batch`), evicts under pressure and, when `sync_writes`
    /// is off, checkpoints. Returns all removed ids.
    pub fn maintain(&self) -> Result<Vec<BlobId>, PoolError> {
        let mut removed = Vec::new();
        let batch = self.cfg.sweep_batch.max(1);
        loop {
            let now = crate::now_ms();
            let swept = self.sweep_expired(now, batch)?;
            let n = swept.len();
            removed.extend(swept);
            if n < batch {
                break;
            }
        }
        removed.extend(self.evict_under_pressure()?);
        if !self.cfg.sync_writes {
            self.checkpoint()?;
        }
        Ok(removed)
    }

    /// Store-wide counters.
    pub fn stats(&self) -> Result<PoolStats, PoolError> {
        let txn = self.begin_read()?;
        let counters = txn.open_table(COUNTERS)?;
        let read = |k: &str| -> Result<u64, PoolError> {
            Ok(counters.get(k)?.map(|g| g.value()).unwrap_or(0))
        };
        Ok(PoolStats {
            total_bytes: read(COUNTER_TOTAL_BYTES)?,
            blob_count: read(COUNTER_BLOB_COUNT)?,
            bulletin_counter: read(COUNTER_BULLETIN_COUNTER)?,
            bulletin_count: txn.open_table(BULLETIN)?.len()?,
            kv_count: txn.open_table(KV)?.len()?,
            hash_count: txn.open_table(HASH)?.len()?,
            mesh_bytes: read(COUNTER_MESH_BYTES)?,
            mesh_count: read(COUNTER_MESH_COUNT)?,
            upload_count: txn.open_table(UPLOAD)?.len()?,
        })
    }

    /// The metadata record of a stored blob (scope, size, kind, index key, times).
    pub fn meta(&self, id: &BlobId) -> Result<Option<Meta>, PoolError> {
        let txn = self.begin_read()?;
        let meta = txn.open_table(META)?;
        let m = match meta.get(id.as_bytes())? {
            Some(guard) => Some(Meta::decode(guard.value())?),
            None => None,
        };
        Ok(m)
    }

    /// Scope and wire size of a stored blob.
    pub fn scope_of(&self, id: &BlobId) -> Result<Option<(Scope, u32)>, PoolError> {
        let txn = self.begin_read()?;
        let meta = txn.open_table(META)?;
        let x = match meta.get(id.as_bytes())? {
            Some(guard) => {
                let m = Meta::decode(guard.value())?;
                Some((m.scope, m.size))
            }
            None => None,
        };
        Ok(x)
    }

    /// Adds the flags of `add` and removes those of `remove` on stored blobs (missing
    /// ids are skipped). A bridge clears `upload` this way once a blob is uploaded.
    pub fn update_scope(&self, ids: &[BlobId], add: Scope, remove: Scope) -> Result<(), PoolError> {
        let txn = self.begin_write()?;
        let changed = {
            let mut t = Tables::open(&txn)?;
            for id in ids {
                if let Some(meta) = t.read_meta(id)? {
                    let scope = meta.scope.union(add).without(remove);
                    t.set_scope(id, meta, scope, &self.cfg)?;
                }
            }
            t.save()?
        };
        if changed {
            txn.commit()?;
        } else {
            txn.abort()?;
        }
        Ok(())
    }

    /// Up to `max` blobs waiting for a bridge upload, in id order.
    pub fn upload_pending(&self, max: usize) -> Result<Vec<BlobId>, PoolError> {
        let txn = self.begin_read()?;
        let upload = txn.open_table(UPLOAD)?;
        let mut ids = Vec::new();
        for item in upload.iter()?.take(max) {
            ids.push(BlobId::from_bytes(item?.0.value()));
        }
        Ok(ids)
    }

    /// Deletes stored blobs with all their index entries (missing ids are skipped);
    /// returns the removed ids.
    pub fn remove(&self, ids: &[BlobId]) -> Result<Vec<BlobId>, PoolError> {
        let txn = self.begin_write()?;
        let (changed, removed) = {
            let mut t = Tables::open(&txn)?;
            let mut removed = Vec::new();
            for id in ids {
                if t.remove(id)?.is_some() {
                    removed.push(*id);
                }
            }
            (t.save()?, removed)
        };
        if changed {
            txn.commit()?;
        } else {
            txn.abort()?;
        }
        Ok(removed)
    }

    /// Id of the entry stored under a seeker key, if any.
    pub fn kv_id(&self, key: &[u8]) -> Result<Option<BlobId>, PoolError> {
        let txn = self.begin_read()?;
        let kv = txn.open_table(KV)?;
        let id = kv.get(key)?.map(|g| BlobId::from_bytes(g.value()));
        Ok(id)
    }

    /// [`Pools::ids_by_expiry`] restricted to blobs whose scope has every flag of
    /// `scope`: [`Scope::MESH`] pages the mesh index, anything else the full one.
    pub fn ids_by_expiry_in(
        &self,
        scope: Scope,
        from_expires_at: u64,
        cursor: Option<ExpiryCursor>,
        max: usize,
    ) -> Result<(Vec<BlobId>, Option<ExpiryCursor>), PoolError> {
        if !scope.contains(Scope::MESH) {
            return self.ids_by_expiry(from_expires_at, cursor, max);
        }
        if max == 0 {
            return Ok((Vec::new(), cursor));
        }
        let txn = self.begin_read()?;
        let index = txn.open_table(MESH_EXPIRY)?;
        let lower = match cursor {
            Some((e, id)) => Bound::Excluded((e, *id.as_bytes())),
            None => Bound::Included((from_expires_at, [0u8; 32])),
        };
        let mut ids = Vec::with_capacity(max.min(SCAN_CHUNK));
        let mut last = None;
        let mut more = false;
        for item in index
            .range((lower, Bound::Unbounded))?
            .take(max.saturating_add(1))
        {
            let (k, _) = item?;
            if ids.len() == max {
                more = true;
                break;
            }
            let (e, id) = k.value();
            let id = BlobId::from_bytes(id);
            ids.push(id);
            last = Some((e, id));
        }
        Ok((ids, if more { last } else { None }))
    }

    /// Starts the background sweeper: every `sweep_interval` it runs
    /// [`Pools::maintain`] and sends the removed ids (if any) on `on_removed`; send
    /// errors are ignored. The thread holds only a weak reference and exits when the
    /// store is dropped or the handle is stopped.
    pub fn start_sweeper(
        self: &Arc<Self>,
        on_removed: Option<Sender<Vec<BlobId>>>,
    ) -> SweeperHandle {
        SweeperHandle::spawn(Arc::downgrade(self), self.cfg.sweep_interval, on_removed)
    }

    /// Schema version this crate writes.
    pub const SCHEMA_VERSION: u64 = schema::SCHEMA_VERSION;
}

impl Drop for Pools {
    /// With `sync_writes` off, a clean drop checkpoints so nothing is lost on a
    /// normal shutdown.
    fn drop(&mut self) {
        if self.cfg.sync_writes || std::thread::panicking() {
            return;
        }
        if let Err(e) = self.checkpoint() {
            tracing::warn!(error = %e, "pools: final checkpoint failed");
        }
    }
}
