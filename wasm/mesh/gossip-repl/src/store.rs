//! Blob storage as seen by the network layer.
//!
//! The node implements [`BlobStore`] on top of the pools crate; [`MemBlobStore`] is an
//! in-memory implementation for tests and tools.

use std::collections::{BTreeSet, HashMap};
use std::fmt;

use gossip_wire::{prepare_kv_entry, BlobEnvelope, BlobId, BlobKind, Scope};
use massa_hash::Hash;
use massa_signature::{PublicKey, Signature};
use parking_lot::RwLock;

use gossip_wire::PeerId;

/// Material for (batch) signature verification of a `KeyValue` blob, as consumed by
/// `massa_signature::verify_signature_batch`.
#[derive(Clone, Copy, Debug)]
pub struct KvSigMaterial {
    /// Signed hash: `blake3([key_len] ‖ key ‖ message)`.
    pub hash: Hash,
    /// Signature carried by the value.
    pub signature: Signature,
    /// Seeker public key carried by the value (already matched against the key).
    pub public_key: PublicKey,
}

impl KvSigMaterial {
    /// Tuple form accepted by `massa_signature::verify_signature_batch`.
    pub fn into_tuple(self) -> (Hash, Signature, PublicKey) {
        (self.hash, self.signature, self.public_key)
    }
}

/// Where a blob came from.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BlobSource {
    /// Delivering peer; `None` for a local client.
    pub peer: Option<PeerId>,
    /// Trust bucket of the source (see [`gossip_trust::trust_bucket`]).
    pub trust_bucket: u8,
    /// Scope the blob gets, merged into the stored scope when it is already held
    /// (see `docs/MESH.md`, "Blob scope").
    pub scope: Scope,
}

/// Per-item result of [`BlobStore::insert_many_prevalidated`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum StoreOutcome {
    /// Stored now.
    Inserted(BlobId),
    /// Already stored (the id is the one in the store, which for `Hash` blobs may
    /// differ from the submitted one).
    AlreadyPresent(BlobId),
    /// Not stored (index rule, storage pressure...). Not a misbehaviour of the sender.
    Rejected(String),
}

/// Why [`BlobStore::validate`] refused an envelope.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ValidateError {
    /// `created_at + retention` is already in the past: skipped, not a misbehaviour.
    Expired,
    /// `created_at` is beyond the tolerated clock skew: skipped, not a misbehaviour.
    FutureDated,
    /// Structurally invalid (size, key rules, KV layout / key mismatch): the sender
    /// misbehaved.
    Invalid(String),
}

impl fmt::Display for ValidateError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Expired => f.write_str("expired"),
            Self::FutureDated => f.write_str("created_at is in the future"),
            Self::Invalid(reason) => write!(f, "invalid: {reason}"),
        }
    }
}

impl std::error::Error for ValidateError {}

/// What the mesh forwarding rules need to know about a stored blob.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BlobInfo {
    /// Where it may be replicated.
    pub scope: Scope,
    /// Envelope wire size.
    pub size: u32,
    /// Pool.
    pub kind: BlobKind,
    /// The seeker key of a key-value blob, empty otherwise.
    pub key: Vec<u8>,
    /// Envelope `created_at` (unix ms).
    pub created_at: u64,
}

impl BlobInfo {
    /// What a store that only knows scope and size can say (never guided).
    pub fn from_scope(scope: Scope, size: u32) -> Self {
        Self {
            scope,
            size,
            kind: BlobKind::Bulletin,
            key: Vec::new(),
            created_at: 0,
        }
    }
}

/// Blob storage the network replicates into and serves from.
pub trait BlobStore: Send + Sync + 'static {
    /// Structural validation (sizes, key rules, time window, KV layout / key match).
    /// For `KeyValue` blobs returns the signature material so the caller can
    /// batch-verify; `verify_kv_signature = true` verifies inline and returns
    /// `Ok(None)`.
    fn validate(
        &self,
        env: &BlobEnvelope,
        now_ms: u64,
        verify_kv_signature: bool,
    ) -> Result<Option<KvSigMaterial>, ValidateError>;
    /// Inserts blobs already fully validated; returns per-item outcomes in order.
    fn insert_many_prevalidated(
        &self,
        items: Vec<(BlobEnvelope, BlobSource)>,
        now_ms: u64,
    ) -> Result<Vec<StoreOutcome>, String>;
    /// Whether the blob is stored.
    fn contains(&self, id: &BlobId) -> bool;
    /// The stored envelopes among `ids`, stopping once `max_total_bytes` of wire size
    /// would be exceeded (the first envelope is always returned).
    fn get_many(&self, ids: &[BlobId], max_total_bytes: usize) -> Vec<BlobEnvelope>;
    /// Ids ordered by `(expires_at, id)` from `from_expires_at` (inclusive) or strictly
    /// after `cursor`; returns the next cursor when more remain.
    fn ids_by_expiry(
        &self,
        from_expires_at: u64,
        cursor: Option<(u64, BlobId)>,
        max: usize,
    ) -> (Vec<BlobId>, Option<(u64, BlobId)>);
    /// Retention after `created_at`, in milliseconds.
    fn retention_ms(&self) -> u64;

    // ---- scope (mesh). The defaults describe a store that only knows internet
    // blobs, which is what every server is.

    /// [`BlobStore::validate`] for a blob that will be stored with `scope`; a mesh-only
    /// blob gets the mesh time window, with `now_ms` read from the mesh clock.
    fn validate_scoped(
        &self,
        env: &BlobEnvelope,
        now_ms: u64,
        verify_kv_signature: bool,
        scope: Scope,
    ) -> Result<Option<KvSigMaterial>, ValidateError> {
        let _ = scope;
        self.validate(env, now_ms, verify_kv_signature)
    }
    /// Scope and wire size of a stored blob.
    fn scope_of(&self, id: &BlobId) -> Option<(Scope, u32)> {
        self.contains(id).then_some((Scope::INTERNET, 0))
    }
    /// Scope, size, kind, key and age of a stored blob (mesh forwarding). `None` when
    /// the store cannot tell, which makes the blob follow the scope filter only.
    fn info(&self, id: &BlobId) -> Option<BlobInfo> {
        let _ = id;
        None
    }
    /// [`BlobStore::ids_by_expiry`] restricted to blobs whose scope has every flag of
    /// `scope`.
    fn ids_by_expiry_in(
        &self,
        scope: Scope,
        from_expires_at: u64,
        cursor: Option<(u64, BlobId)>,
        max: usize,
    ) -> (Vec<BlobId>, Option<(u64, BlobId)>) {
        if scope.contains(Scope::MESH) {
            return (Vec::new(), None);
        }
        self.ids_by_expiry(from_expires_at, cursor, max)
    }
    /// Retention of a blob of `scope`.
    fn retention_ms_for(&self, scope: Scope) -> u64 {
        let _ = scope;
        self.retention_ms()
    }
    /// Id of the key-value entry stored under `key`.
    fn kv_id(&self, key: &[u8]) -> Option<BlobId> {
        let _ = key;
        None
    }
    /// Adds the flags of `add` and removes those of `remove` on stored blobs.
    fn update_scope(&self, ids: &[BlobId], add: Scope, remove: Scope) {
        let _ = (ids, add, remove);
    }
    /// Up to `max` blobs waiting for a bridge upload.
    fn upload_pending(&self, max: usize) -> Vec<BlobId> {
        let _ = max;
        Vec::new()
    }
}

/// Limits of a [`MemBlobStore`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MemStoreConfig {
    /// Retention after `created_at` (default 14 days).
    pub retention_ms: u64,
    /// Tolerated clock skew for `created_at` in the future (default 5 minutes).
    pub max_future_skew_ms: u64,
    /// Payload cap (default 10 MiB).
    pub max_payload_len: usize,
    /// Key cap (default 128).
    pub max_key_len: usize,
    /// Retention of mesh-only blobs (default 72 hours).
    pub mesh_retention_ms: u64,
    /// Tolerated skew for mesh-only blobs (default 6 hours).
    pub mesh_max_future_skew_ms: u64,
}

impl Default for MemStoreConfig {
    fn default() -> Self {
        Self {
            retention_ms: 14 * 24 * 60 * 60 * 1000,
            max_future_skew_ms: 5 * 60 * 1000,
            max_payload_len: gossip_wire::MAX_BLOB_PAYLOAD_LEN,
            max_key_len: gossip_wire::MAX_BLOB_KEY_LEN,
            mesh_retention_ms: 72 * 60 * 60 * 1000,
            mesh_max_future_skew_ms: 6 * 60 * 60 * 1000,
        }
    }
}

#[derive(Default)]
struct MemInner {
    blobs: HashMap<BlobId, BlobEnvelope>,
    expiry: BTreeSet<(u64, BlobId)>,
    kv_keys: HashMap<Vec<u8>, BlobId>,
    hash_keys: HashMap<[u8; 32], BlobId>,
    scopes: HashMap<BlobId, Scope>,
    retention_ms: u64,
    mesh_retention_ms: u64,
}

/// In-memory [`BlobStore`] (tests and tools).
pub struct MemBlobStore {
    cfg: MemStoreConfig,
    inner: RwLock<MemInner>,
}

impl Default for MemBlobStore {
    fn default() -> Self {
        Self::new(MemStoreConfig::default())
    }
}

impl MemBlobStore {
    /// Empty store with the given limits.
    pub fn new(cfg: MemStoreConfig) -> Self {
        let inner = MemInner {
            retention_ms: cfg.retention_ms,
            mesh_retention_ms: cfg.mesh_retention_ms,
            ..MemInner::default()
        };
        Self {
            cfg,
            inner: RwLock::new(inner),
        }
    }

    /// Limits.
    pub fn config(&self) -> &MemStoreConfig {
        &self.cfg
    }

    /// Number of stored blobs.
    pub fn len(&self) -> usize {
        self.inner.read().blobs.len()
    }

    /// Whether the store is empty.
    pub fn is_empty(&self) -> bool {
        self.inner.read().blobs.is_empty()
    }

    /// One stored envelope.
    pub fn get(&self, id: &BlobId) -> Option<BlobEnvelope> {
        self.inner.read().blobs.get(id).cloned()
    }

    /// All stored ids.
    pub fn ids(&self) -> Vec<BlobId> {
        self.inner.read().blobs.keys().copied().collect()
    }

    /// Inserts without any validation (tests: e.g. to plant a blob with a bad
    /// signature that a peer must refuse). Returns the id.
    pub fn insert_raw(&self, env: BlobEnvelope) -> BlobId {
        self.insert_raw_scoped(env, Scope::INTERNET)
    }

    /// [`MemBlobStore::insert_raw`] with a scope.
    pub fn insert_raw_scoped(&self, env: BlobEnvelope, scope: Scope) -> BlobId {
        let id = env.id();
        self.inner
            .write()
            .insert_unchecked(id, env, scope, &self.cfg);
        id
    }

    /// Expiry instant of an envelope.
    pub fn expires_at(&self, env: &BlobEnvelope) -> u64 {
        env.created_at.saturating_add(self.cfg.retention_ms)
    }

    /// Removes every blob whose expiry, under its scope's retention, is at or before
    /// `now_ms` (the pools sweeper's job, for the simulator). Returns how many.
    pub fn sweep(&self, now_ms: u64) -> usize {
        let mut inner = self.inner.write();
        let expired: Vec<(u64, BlobId)> = inner
            .expiry
            .range(..=(now_ms, BlobId([0xff; 32])))
            .copied()
            .collect();
        for (e, id) in &expired {
            inner.expiry.remove(&(*e, *id));
            inner.scopes.remove(id);
            if let Some(env) = inner.blobs.remove(id) {
                match env.kind {
                    BlobKind::KeyValue => {
                        inner.kv_keys.remove(&env.key);
                    }
                    BlobKind::Hash => {
                        inner
                            .hash_keys
                            .remove(&gossip_wire::hash_pool_key(&env.payload));
                    }
                    BlobKind::Bulletin => {}
                }
            }
        }
        expired.len()
    }

    fn retention_for(&self, scope: Scope) -> u64 {
        if scope.is_mesh_only() {
            self.cfg.mesh_retention_ms
        } else {
            self.cfg.retention_ms
        }
    }
}

impl MemInner {
    fn merge_scope(&mut self, id: &BlobId, add: Scope) {
        if let Some(scope) = self.scopes.get(id).copied() {
            self.set_scope(id, scope.union(add));
        }
    }

    /// Changes a blob's scope; a blob entering or leaving mesh-only changes retention.
    fn set_scope(&mut self, id: &BlobId, scope: Scope) {
        let Some(old) = self.scopes.insert(*id, scope) else {
            return;
        };
        if old.is_mesh_only() == scope.is_mesh_only() {
            return;
        }
        let Some(created_at) = self.blobs.get(id).map(|e| e.created_at) else {
            return;
        };
        if let Some(entry) = self.expiry.iter().find(|(_, i)| i == id).copied() {
            self.expiry.remove(&entry);
        }
        let retention = if scope.is_mesh_only() {
            self.mesh_retention_ms
        } else {
            self.retention_ms
        };
        self.expiry
            .insert((created_at.saturating_add(retention), *id));
    }

    fn insert_unchecked(
        &mut self,
        id: BlobId,
        env: BlobEnvelope,
        scope: Scope,
        cfg: &MemStoreConfig,
    ) {
        let retention = if scope.is_mesh_only() {
            cfg.mesh_retention_ms
        } else {
            cfg.retention_ms
        };
        let expires_at = env.created_at.saturating_add(retention);
        self.scopes.insert(id, scope);
        match env.kind {
            BlobKind::KeyValue => {
                self.kv_keys.insert(env.key.clone(), id);
            }
            BlobKind::Hash => {
                self.hash_keys
                    .insert(gossip_wire::hash_pool_key(&env.payload), id);
            }
            BlobKind::Bulletin => {}
        }
        self.expiry.insert((expires_at, id));
        self.blobs.insert(id, env);
    }
}

impl BlobStore for MemBlobStore {
    fn validate(
        &self,
        env: &BlobEnvelope,
        now_ms: u64,
        verify_kv_signature: bool,
    ) -> Result<Option<KvSigMaterial>, ValidateError> {
        self.validate_scoped(env, now_ms, verify_kv_signature, Scope::INTERNET)
    }

    fn validate_scoped(
        &self,
        env: &BlobEnvelope,
        now_ms: u64,
        verify_kv_signature: bool,
        scope: Scope,
    ) -> Result<Option<KvSigMaterial>, ValidateError> {
        let max_skew = if scope.is_mesh_only() {
            self.cfg.mesh_max_future_skew_ms
        } else {
            self.cfg.max_future_skew_ms
        };
        if env.payload.len() > self.cfg.max_payload_len {
            return Err(ValidateError::Invalid("payload too large".into()));
        }
        if env.key.len() > self.cfg.max_key_len {
            return Err(ValidateError::Invalid("key too large".into()));
        }
        if matches!(env.kind, BlobKind::Bulletin | BlobKind::Hash) && !env.key.is_empty() {
            return Err(ValidateError::Invalid(
                "key not allowed for this kind".into(),
            ));
        }
        if env.created_at > now_ms.saturating_add(max_skew) {
            return Err(ValidateError::FutureDated);
        }
        if env.created_at.saturating_add(self.retention_for(scope)) <= now_ms {
            return Err(ValidateError::Expired);
        }
        if env.kind == BlobKind::KeyValue {
            let (entry, hash) = prepare_kv_entry(&env.key, &env.payload)
                .map_err(|err| ValidateError::Invalid(err.to_string()))?;
            let material = KvSigMaterial {
                hash,
                signature: entry.signature,
                public_key: entry.public_key,
            };
            if verify_kv_signature {
                material
                    .public_key
                    .verify_signature(&material.hash, &material.signature)
                    .map_err(|_| ValidateError::Invalid("bad signature".into()))?;
                return Ok(None);
            }
            return Ok(Some(material));
        }
        Ok(None)
    }

    fn insert_many_prevalidated(
        &self,
        items: Vec<(BlobEnvelope, BlobSource)>,
        _now_ms: u64,
    ) -> Result<Vec<StoreOutcome>, String> {
        let mut inner = self.inner.write();
        let mut outcomes = Vec::with_capacity(items.len());
        for (env, src) in items {
            let id = env.id();
            if inner.blobs.contains_key(&id) {
                inner.merge_scope(&id, src.scope);
                outcomes.push(StoreOutcome::AlreadyPresent(id));
                continue;
            }
            match env.kind {
                BlobKind::KeyValue => {
                    if let Some(existing) = inner.kv_keys.get(&env.key).copied() {
                        if existing != id {
                            // the same payload re-dated is the same entry; another is not
                            let same = inner
                                .blobs
                                .get(&existing)
                                .is_some_and(|e| e.payload == env.payload);
                            if same {
                                inner.merge_scope(&existing, src.scope);
                                outcomes.push(StoreOutcome::AlreadyPresent(existing));
                            } else {
                                outcomes.push(StoreOutcome::Rejected("key already taken".into()));
                            }
                            continue;
                        }
                    }
                }
                BlobKind::Hash => {
                    if let Some(existing) = inner
                        .hash_keys
                        .get(&gossip_wire::hash_pool_key(&env.payload))
                        .copied()
                    {
                        inner.merge_scope(&existing, src.scope);
                        outcomes.push(StoreOutcome::AlreadyPresent(existing));
                        continue;
                    }
                }
                BlobKind::Bulletin => {}
            }
            inner.insert_unchecked(id, env, src.scope, &self.cfg);
            outcomes.push(StoreOutcome::Inserted(id));
        }
        Ok(outcomes)
    }

    fn contains(&self, id: &BlobId) -> bool {
        self.inner.read().blobs.contains_key(id)
    }

    fn get_many(&self, ids: &[BlobId], max_total_bytes: usize) -> Vec<BlobEnvelope> {
        let inner = self.inner.read();
        let mut out = Vec::new();
        let mut total = 0usize;
        for id in ids {
            if let Some(env) = inner.blobs.get(id) {
                let size = env.wire_size();
                if !out.is_empty() && total.saturating_add(size) > max_total_bytes {
                    break;
                }
                total = total.saturating_add(size);
                out.push(env.clone());
            }
        }
        out
    }

    fn ids_by_expiry(
        &self,
        from_expires_at: u64,
        cursor: Option<(u64, BlobId)>,
        max: usize,
    ) -> (Vec<BlobId>, Option<(u64, BlobId)>) {
        if max == 0 {
            return (Vec::new(), cursor);
        }
        let inner = self.inner.read();
        let iter: Box<dyn Iterator<Item = &(u64, BlobId)>> = match cursor {
            Some(c) => Box::new(
                inner
                    .expiry
                    .range((std::ops::Bound::Excluded(c), std::ops::Bound::Unbounded)),
            ),
            None => Box::new(inner.expiry.range((from_expires_at, BlobId([0; 32]))..)),
        };
        let mut ids = Vec::new();
        let mut last = None;
        let mut more = false;
        for (e, id) in iter.take(max + 1) {
            if ids.len() == max {
                more = true;
                break;
            }
            ids.push(*id);
            last = Some((*e, *id));
        }
        (ids, if more { last } else { None })
    }

    fn retention_ms(&self) -> u64 {
        self.cfg.retention_ms
    }

    fn scope_of(&self, id: &BlobId) -> Option<(Scope, u32)> {
        let inner = self.inner.read();
        let env = inner.blobs.get(id)?;
        let scope = inner.scopes.get(id).copied().unwrap_or(Scope::INTERNET);
        Some((scope, u32::try_from(env.wire_size()).unwrap_or(u32::MAX)))
    }

    fn info(&self, id: &BlobId) -> Option<BlobInfo> {
        let inner = self.inner.read();
        let env = inner.blobs.get(id)?;
        Some(BlobInfo {
            scope: inner.scopes.get(id).copied().unwrap_or(Scope::INTERNET),
            size: u32::try_from(env.wire_size()).unwrap_or(u32::MAX),
            kind: env.kind,
            key: env.key.clone(),
            created_at: env.created_at,
        })
    }

    fn ids_by_expiry_in(
        &self,
        scope: Scope,
        from_expires_at: u64,
        cursor: Option<(u64, BlobId)>,
        max: usize,
    ) -> (Vec<BlobId>, Option<(u64, BlobId)>) {
        if max == 0 {
            return (Vec::new(), cursor);
        }
        let inner = self.inner.read();
        let iter: Box<dyn Iterator<Item = &(u64, BlobId)>> = match cursor {
            Some(c) => Box::new(
                inner
                    .expiry
                    .range((std::ops::Bound::Excluded(c), std::ops::Bound::Unbounded)),
            ),
            None => Box::new(inner.expiry.range((from_expires_at, BlobId([0; 32]))..)),
        };
        let mut ids = Vec::new();
        let mut last = None;
        let mut more = false;
        for (e, id) in iter.filter(|(_, id)| {
            inner
                .scopes
                .get(id)
                .copied()
                .unwrap_or(Scope::INTERNET)
                .contains(scope)
        }) {
            if ids.len() == max {
                more = true;
                break;
            }
            ids.push(*id);
            last = Some((*e, *id));
        }
        (ids, if more { last } else { None })
    }

    fn retention_ms_for(&self, scope: Scope) -> u64 {
        self.retention_for(scope)
    }

    fn kv_id(&self, key: &[u8]) -> Option<BlobId> {
        self.inner.read().kv_keys.get(key).copied()
    }

    fn update_scope(&self, ids: &[BlobId], add: Scope, remove: Scope) {
        let mut inner = self.inner.write();
        for id in ids {
            if let Some(scope) = inner.scopes.get(id).copied() {
                inner.set_scope(id, scope.union(add).without(remove));
            }
        }
    }

    fn upload_pending(&self, max: usize) -> Vec<BlobId> {
        let inner = self.inner.read();
        let mut ids: Vec<BlobId> = inner
            .scopes
            .iter()
            .filter(|(_, s)| s.contains(Scope::UPLOAD))
            .map(|(id, _)| *id)
            .collect();
        ids.sort();
        ids.truncate(max);
        ids
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use gossip_wire::build_kv_entry;
    use massa_signature::KeyPair;

    fn src() -> BlobSource {
        BlobSource {
            peer: None,
            trust_bucket: 0,
            scope: Scope::INTERNET,
        }
    }

    #[test]
    fn validate_enforces_window_and_kv_rules() {
        let store = MemBlobStore::default();
        let now = 1_700_000_000_000u64;
        let ok = BlobEnvelope::new(BlobKind::Bulletin, now, vec![], vec![1, 2, 3]);
        assert!(store.validate(&ok, now, true).unwrap().is_none());
        let keyed = BlobEnvelope::new(BlobKind::Bulletin, now, vec![1], vec![]);
        assert!(matches!(
            store.validate(&keyed, now, true),
            Err(ValidateError::Invalid(_))
        ));
        let old = BlobEnvelope::new(
            BlobKind::Bulletin,
            now - store.retention_ms() - 1,
            vec![],
            vec![],
        );
        assert!(matches!(
            store.validate(&old, now, true),
            Err(ValidateError::Expired)
        ));
        let future = BlobEnvelope::new(BlobKind::Bulletin, now + 10 * 60 * 1000, vec![], vec![]);
        assert!(matches!(
            store.validate(&future, now, true),
            Err(ValidateError::FutureDated)
        ));
        let kp = KeyPair::generate(0).unwrap();
        let (key, value) = build_kv_entry(&kp, b"hello");
        let kv = BlobEnvelope::new(BlobKind::KeyValue, now, key.clone(), value.clone());
        let material = store.validate(&kv, now, false).unwrap().unwrap();
        assert!(material
            .public_key
            .verify_signature(&material.hash, &material.signature)
            .is_ok());
        assert!(store.validate(&kv, now, true).unwrap().is_none());
        let mut bad = value.clone();
        *bad.last_mut().unwrap() ^= 1;
        let bad_kv = BlobEnvelope::new(BlobKind::KeyValue, now, key, bad);
        assert!(store.validate(&bad_kv, now, false).is_ok());
        assert!(matches!(
            store.validate(&bad_kv, now, true),
            Err(ValidateError::Invalid(_))
        ));
    }

    #[test]
    fn insert_dedup_and_paging() {
        let store = MemBlobStore::default();
        let now = 1_700_000_000_000u64;
        let a = BlobEnvelope::new(BlobKind::Bulletin, now, vec![], vec![1]);
        let b = BlobEnvelope::new(BlobKind::Hash, now + 1, vec![], vec![2]);
        let b2 = BlobEnvelope::new(BlobKind::Hash, now + 2, vec![], vec![2]);
        let outcomes = store
            .insert_many_prevalidated(
                vec![
                    (a.clone(), src()),
                    (a.clone(), src()),
                    (b.clone(), src()),
                    (b2, src()),
                ],
                now,
            )
            .unwrap();
        assert_eq!(
            outcomes,
            vec![
                StoreOutcome::Inserted(a.id()),
                StoreOutcome::AlreadyPresent(a.id()),
                StoreOutcome::Inserted(b.id()),
                StoreOutcome::AlreadyPresent(b.id()),
            ]
        );
        assert_eq!(store.len(), 2);
        assert!(store.contains(&a.id()));
        let got = store.get_many(&[b.id(), a.id(), BlobId([9; 32])], usize::MAX);
        assert_eq!(got, vec![b.clone(), a.clone()]);
        assert_eq!(store.get_many(&[a.id(), b.id()], 1).len(), 1);

        let (page, next) = store.ids_by_expiry(0, None, 1);
        assert_eq!(page, vec![a.id()]);
        let next = next.unwrap();
        assert_eq!(next, (store.expires_at(&a), a.id()));
        let (page, next) = store.ids_by_expiry(0, Some(next), 1);
        assert_eq!(page, vec![b.id()]);
        assert!(next.is_none());
        let (page, _) = store.ids_by_expiry(store.expires_at(&b), None, 10);
        assert_eq!(page, vec![b.id()]);

        let kp = KeyPair::generate(0).unwrap();
        let (key, value) = build_kv_entry(&kp, b"first");
        let (_, value2) = build_kv_entry(&kp, b"second");
        let kv1 = BlobEnvelope::new(BlobKind::KeyValue, now, key.clone(), value);
        let kv2 = BlobEnvelope::new(BlobKind::KeyValue, now, key, value2);
        let outcomes = store
            .insert_many_prevalidated(vec![(kv1.clone(), src()), (kv2, src())], now)
            .unwrap();
        assert_eq!(outcomes[0], StoreOutcome::Inserted(kv1.id()));
        assert!(matches!(outcomes[1], StoreOutcome::Rejected(_)));
    }
}
