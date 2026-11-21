//! Exposes the redb pools to the replication engine through its [`BlobStore`] trait
//! (feature `blob-store`).

use std::sync::Arc;

use gossip_repl::{BlobInfo, BlobSource, BlobStore, KvSigMaterial, StoreOutcome, ValidateError};
use gossip_wire::{BlobEnvelope, BlobId, Scope};

use crate::{InsertOutcome, Pools, RejectReason, Source};

/// Adapter from [`Pools`] to [`BlobStore`].
pub struct PoolsStore {
    pools: Arc<Pools>,
}

impl PoolsStore {
    /// Wraps the pools.
    pub fn new(pools: Arc<Pools>) -> Self {
        Self { pools }
    }
}

fn map_reject(r: RejectReason) -> ValidateError {
    match r {
        RejectReason::Expired => ValidateError::Expired,
        RejectReason::FutureDated => ValidateError::FutureDated,
        other => ValidateError::Invalid(format!("{other:?}")),
    }
}

impl BlobStore for PoolsStore {
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
        self.pools
            .validate_scoped(env, now_ms, verify_kv_signature, scope)
            .map(|m| {
                m.map(|m| {
                    let (hash, signature, public_key) = m.into_tuple();
                    KvSigMaterial {
                        hash,
                        signature,
                        public_key,
                    }
                })
            })
            .map_err(map_reject)
    }

    fn insert_many_prevalidated(
        &self,
        items: Vec<(BlobEnvelope, BlobSource)>,
        now_ms: u64,
    ) -> Result<Vec<StoreOutcome>, String> {
        let items = items
            .into_iter()
            .map(|(env, src)| {
                let source = match src.peer {
                    Some(peer) => Source::peer(peer.to_bytes(), src.trust_bucket),
                    None => Source::local(src.trust_bucket),
                }
                .with_scope(src.scope);
                (env, source)
            })
            .collect();
        let outcomes = self
            .pools
            .insert_many_prevalidated(items, now_ms)
            .map_err(|e| e.to_string())?;
        Ok(outcomes
            .into_iter()
            .map(|o| match o {
                InsertOutcome::Inserted { id, .. } => StoreOutcome::Inserted(id),
                InsertOutcome::AlreadyPresent { id, .. } => StoreOutcome::AlreadyPresent(id),
                InsertOutcome::Rejected(r) => StoreOutcome::Rejected(format!("{r:?}")),
            })
            .collect())
    }

    fn contains(&self, id: &BlobId) -> bool {
        self.pools.contains(id).unwrap_or_else(|e| {
            tracing::warn!(error = %e, "pool lookup failed");
            false
        })
    }

    fn get_many(&self, ids: &[BlobId], max_total_bytes: usize) -> Vec<BlobEnvelope> {
        self.pools
            .get_many(ids, max_total_bytes)
            .unwrap_or_else(|e| {
                tracing::warn!(error = %e, "pool read failed");
                Vec::new()
            })
    }

    fn ids_by_expiry(
        &self,
        from_expires_at: u64,
        cursor: Option<(u64, BlobId)>,
        max: usize,
    ) -> (Vec<BlobId>, Option<(u64, BlobId)>) {
        self.pools
            .ids_by_expiry(from_expires_at, cursor, max)
            .unwrap_or_else(|e| {
                tracing::warn!(error = %e, "pool expiry scan failed");
                (Vec::new(), None)
            })
    }

    fn retention_ms(&self) -> u64 {
        self.pools.config().retention_ms
    }

    fn scope_of(&self, id: &BlobId) -> Option<(Scope, u32)> {
        self.pools.scope_of(id).unwrap_or_else(|e| {
            tracing::warn!(error = %e, "pool scope lookup failed");
            None
        })
    }

    fn info(&self, id: &BlobId) -> Option<BlobInfo> {
        let meta = self.pools.meta(id).ok().flatten()?;
        Some(BlobInfo {
            scope: meta.scope,
            size: meta.size,
            kind: meta.kind,
            // the index key is the seeker for key-value blobs
            key: if meta.kind == gossip_wire::BlobKind::KeyValue {
                meta.index_key
            } else {
                Vec::new()
            },
            created_at: meta.created_at,
        })
    }

    fn ids_by_expiry_in(
        &self,
        scope: Scope,
        from_expires_at: u64,
        cursor: Option<(u64, BlobId)>,
        max: usize,
    ) -> (Vec<BlobId>, Option<(u64, BlobId)>) {
        self.pools
            .ids_by_expiry_in(scope, from_expires_at, cursor, max)
            .unwrap_or_else(|e| {
                tracing::warn!(error = %e, "pool expiry scan failed");
                (Vec::new(), None)
            })
    }

    fn retention_ms_for(&self, scope: Scope) -> u64 {
        self.pools.config().retention_for(scope)
    }

    fn kv_id(&self, key: &[u8]) -> Option<BlobId> {
        self.pools.kv_id(key).ok().flatten()
    }

    fn update_scope(&self, ids: &[BlobId], add: Scope, remove: Scope) {
        if let Err(e) = self.pools.update_scope(ids, add, remove) {
            tracing::warn!(error = %e, "pool scope update failed");
        }
    }

    fn upload_pending(&self, max: usize) -> Vec<BlobId> {
        self.pools.upload_pending(max).unwrap_or_else(|e| {
            tracing::warn!(error = %e, "pool upload scan failed");
            Vec::new()
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::PoolsConfig;
    use gossip_wire::BlobKind;

    #[test]
    fn adapter_roundtrip_and_kv_material() {
        let dir = tempfile::tempdir().unwrap();
        let pools =
            Pools::open(PoolsConfig::default().with_path(dir.path().join("p.redb"))).unwrap();
        let store = PoolsStore::new(pools.clone());
        let now = crate::now_ms();
        let kp = massa_signature::KeyPair::generate(0).unwrap();
        let (key, value) = gossip_wire::build_kv_entry(&kp, b"msg");
        let env = BlobEnvelope::new(BlobKind::KeyValue, now, key, value);
        let material = store
            .validate(&env, now, false)
            .unwrap()
            .expect("kv material");
        material
            .public_key
            .verify_signature(&material.hash, &material.signature)
            .unwrap();
        let id = env.id();
        let out = store
            .insert_many_prevalidated(
                vec![(
                    env.clone(),
                    BlobSource {
                        peer: None,
                        trust_bucket: 3,
                        scope: Scope::INTERNET,
                    },
                )],
                now,
            )
            .unwrap();
        assert_eq!(out, vec![StoreOutcome::Inserted(id)]);
        assert!(store.contains(&id));
        assert_eq!(store.get_many(&[id], 1 << 20), vec![env]);
        let (ids, _) = store.ids_by_expiry(0, None, 10);
        assert_eq!(ids, vec![id]);
        let old = BlobEnvelope::new(BlobKind::Bulletin, 1, vec![], vec![1]);
        assert!(matches!(
            store.validate(&old, now, true),
            Err(ValidateError::Expired)
        ));
    }
}
