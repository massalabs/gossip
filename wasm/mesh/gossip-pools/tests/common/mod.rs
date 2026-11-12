//! Shared helpers for the integration tests.
#![allow(dead_code)]

use std::sync::Arc;

use gossip_pools::{BlobEnvelope, BlobKind, InsertOutcome, Pools, PoolsConfig, Source};
use gossip_wire::build_kv_entry;
use massa_signature::KeyPair;
use tempfile::TempDir;

/// A fixed "now" so tests are deterministic.
pub const NOW: u64 = 1_700_000_000_000;

pub fn open(tweak: impl FnOnce(PoolsConfig) -> PoolsConfig) -> (TempDir, Arc<Pools>) {
    let dir = tempfile::tempdir().unwrap();
    let cfg = tweak(PoolsConfig::default().with_path(dir.path().join("pools.redb")));
    let pools = Pools::open(cfg).unwrap();
    (dir, pools)
}

pub fn bulletin(created_at: u64, payload: impl AsRef<[u8]>) -> BlobEnvelope {
    BlobEnvelope::new(
        BlobKind::Bulletin,
        created_at,
        vec![],
        payload.as_ref().to_vec(),
    )
}

pub fn hash(created_at: u64, payload: impl AsRef<[u8]>) -> BlobEnvelope {
    BlobEnvelope::new(
        BlobKind::Hash,
        created_at,
        vec![],
        payload.as_ref().to_vec(),
    )
}

pub fn kv(kp: &KeyPair, created_at: u64, msg: &[u8]) -> BlobEnvelope {
    let (key, value) = build_kv_entry(kp, msg);
    BlobEnvelope::new(BlobKind::KeyValue, created_at, key, value)
}

pub fn keypair() -> KeyPair {
    KeyPair::generate(0).unwrap()
}

pub fn src(bucket: u8) -> Source {
    Source::local(bucket)
}

pub fn inserted(o: &InsertOutcome) -> gossip_pools::BlobId {
    match o {
        InsertOutcome::Inserted { id, .. } => *id,
        other => panic!("expected Inserted, got {other:?}"),
    }
}
