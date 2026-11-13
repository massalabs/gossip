//! The phone's blob store: the pools, plus the other values seen under a seeker that
//! already had one.
//!
//! The pools keep the first valid value stored under a seeker (`key_taken` for the
//! others), which is the rule that settles the fork hazard across the mesh. The app
//! still wants to see every distinct value that reached the phone, in arrival order, so
//! that its session layer can pick the one that decrypts: they are kept here, bounded,
//! and never replicated.

use std::collections::{HashMap, VecDeque};
use std::sync::Arc;

use gossip_pools::{Pools, PoolsStore};
use gossip_repl::{BlobInfo, BlobSource, BlobStore, KvSigMaterial, StoreOutcome, ValidateError};
use gossip_wire::{BlobEnvelope, BlobId, BlobKind, Scope};
use parking_lot::Mutex;

/// Most distinct extra values kept per seeker.
const MAX_ALTERNATES: usize = 4;
/// Most seekers with extra values.
const MAX_ALTERNATE_KEYS: usize = 1024;

/// Extra values by seeker, and the seekers in insertion order (oldest evicted first).
type Alternates = (HashMap<Vec<u8>, Vec<Vec<u8>>>, VecDeque<Vec<u8>>);

/// Called with `(seeker, value)` when another value of a seeker arrives.
pub type AlternateSink = Box<dyn Fn(&[u8], &[u8]) + Send + Sync>;

/// [`PoolsStore`] plus alternate values.
pub struct MobileStore {
    inner: PoolsStore,
    pools: Arc<Pools>,
    alternates: Mutex<Alternates>,
    on_alternate: Mutex<Option<AlternateSink>>,
}

impl MobileStore {
    /// Wraps the pools.
    pub fn new(pools: Arc<Pools>) -> Self {
        Self {
            inner: PoolsStore::new(pools.clone()),
            pools,
            alternates: Mutex::new((HashMap::new(), VecDeque::new())),
            on_alternate: Mutex::new(None),
        }
    }

    /// Sets the callback for alternate values.
    pub fn set_on_alternate(&self, sink: Option<AlternateSink>) {
        *self.on_alternate.lock() = sink;
    }

    /// The pools.
    pub fn pools(&self) -> &Arc<Pools> {
        &self.pools
    }

    /// Every distinct value seen under `key`, first stored first.
    pub fn values(&self, key: &[u8]) -> Vec<Vec<u8>> {
        let mut out = Vec::new();
        if let Ok(Some(env)) = self.pools.kv_get(key) {
            out.push(env.payload);
        }
        if let Some(alts) = self.alternates.lock().0.get(key) {
            out.extend(alts.iter().cloned());
        }
        out
    }

    /// Records another value of `key`; returns whether it was new.
    pub fn note_alternate(&self, key: &[u8], value: &[u8]) -> bool {
        let fresh = {
            let mut guard = self.alternates.lock();
            let (map, order) = &mut *guard;
            if !map.contains_key(key) {
                if map.len() >= MAX_ALTERNATE_KEYS {
                    if let Some(old) = order.pop_front() {
                        map.remove(&old);
                    }
                }
                order.push_back(key.to_vec());
            }
            let list = map.entry(key.to_vec()).or_default();
            if list.iter().any(|v| v == value) || list.len() >= MAX_ALTERNATES {
                false
            } else {
                list.push(value.to_vec());
                true
            }
        };
        if fresh {
            if let Some(cb) = self.on_alternate.lock().as_ref() {
                cb(key, value);
            }
        }
        fresh
    }
}

impl BlobStore for MobileStore {
    fn validate(
        &self,
        env: &BlobEnvelope,
        now_ms: u64,
        verify_kv_signature: bool,
    ) -> Result<Option<KvSigMaterial>, ValidateError> {
        self.inner.validate(env, now_ms, verify_kv_signature)
    }

    fn validate_scoped(
        &self,
        env: &BlobEnvelope,
        now_ms: u64,
        verify_kv_signature: bool,
        scope: Scope,
    ) -> Result<Option<KvSigMaterial>, ValidateError> {
        self.inner
            .validate_scoped(env, now_ms, verify_kv_signature, scope)
    }

    fn insert_many_prevalidated(
        &self,
        items: Vec<(BlobEnvelope, BlobSource)>,
        now_ms: u64,
    ) -> Result<Vec<StoreOutcome>, String> {
        let kv: Vec<Option<(Vec<u8>, Vec<u8>)>> = items
            .iter()
            .map(|(env, _)| {
                (env.kind == BlobKind::KeyValue).then(|| (env.key.clone(), env.payload.clone()))
            })
            .collect();
        let outcomes = self.inner.insert_many_prevalidated(items, now_ms)?;
        for (outcome, kv) in outcomes.iter().zip(kv) {
            if let (StoreOutcome::Rejected(reason), Some((key, value))) = (outcome, kv) {
                if reason.contains("KeyTaken") {
                    self.note_alternate(&key, &value);
                }
            }
        }
        Ok(outcomes)
    }

    fn contains(&self, id: &BlobId) -> bool {
        self.inner.contains(id)
    }

    fn get_many(&self, ids: &[BlobId], max_total_bytes: usize) -> Vec<BlobEnvelope> {
        self.inner.get_many(ids, max_total_bytes)
    }

    fn ids_by_expiry(
        &self,
        from_expires_at: u64,
        cursor: Option<(u64, BlobId)>,
        max: usize,
    ) -> (Vec<BlobId>, Option<(u64, BlobId)>) {
        self.inner.ids_by_expiry(from_expires_at, cursor, max)
    }

    fn retention_ms(&self) -> u64 {
        self.inner.retention_ms()
    }

    fn scope_of(&self, id: &BlobId) -> Option<(Scope, u32)> {
        self.inner.scope_of(id)
    }

    fn info(&self, id: &BlobId) -> Option<BlobInfo> {
        self.inner.info(id)
    }

    fn ids_by_expiry_in(
        &self,
        scope: Scope,
        from_expires_at: u64,
        cursor: Option<(u64, BlobId)>,
        max: usize,
    ) -> (Vec<BlobId>, Option<(u64, BlobId)>) {
        self.inner
            .ids_by_expiry_in(scope, from_expires_at, cursor, max)
    }

    fn retention_ms_for(&self, scope: Scope) -> u64 {
        self.inner.retention_ms_for(scope)
    }

    fn kv_id(&self, key: &[u8]) -> Option<BlobId> {
        self.inner.kv_id(key)
    }

    fn update_scope(&self, ids: &[BlobId], add: Scope, remove: Scope) {
        self.inner.update_scope(ids, add, remove)
    }

    fn upload_pending(&self, max: usize) -> Vec<BlobId> {
        self.inner.upload_pending(max)
    }
}
