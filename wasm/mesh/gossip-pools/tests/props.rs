//! Model-based property test: random insert / sweep / evict sequences keep the
//! stats, the indexes and the returned ids consistent with a simple in-memory model.
mod common;

use std::collections::HashMap;

use common::*;
use gossip_pools::{
    BlobEnvelope, BlobId, BlobKind, InsertOutcome, Pools, PoolsConfig, RejectReason,
};
use massa_signature::KeyPair;
use proptest::prelude::*;

const RETENTION: u64 = 10_000;
const SKEW: u64 = 1_000;
const MAX_BYTES: u64 = 6_000;
const MAX_COUNT: u64 = 12;

#[derive(Debug, Clone)]
enum Op {
    Insert {
        kind: u8,
        keypair: usize,
        age: u64,
        bucket: u8,
        len: usize,
        salt: u8,
    },
    Sweep {
        ahead: u64,
        batch: usize,
    },
    Evict,
}

fn op() -> impl Strategy<Value = Op> {
    prop_oneof![
        6 => (0u8..3, 0usize..4, 0u64..(RETENTION + SKEW + 200), 0u8..16, 0usize..400, any::<u8>())
            .prop_map(|(kind, keypair, age, bucket, len, salt)| Op::Insert {
                kind, keypair, age, bucket, len, salt
            }),
        2 => (0u64..(RETENTION + 200), 1usize..8).prop_map(|(ahead, batch)| Op::Sweep { ahead, batch }),
        1 => Just(Op::Evict),
    ]
}

#[derive(Debug)]
struct Model {
    live: HashMap<BlobId, (BlobKind, u64, u64)>, // kind, size, expires_at
    counter: u64,
}

impl Model {
    fn check(&self, p: &Pools) {
        let s = p.stats().unwrap();
        assert_eq!(s.blob_count, self.live.len() as u64, "blob_count");
        assert_eq!(
            s.total_bytes,
            self.live.values().map(|v| v.1).sum::<u64>(),
            "total_bytes"
        );
        let count = |k: BlobKind| self.live.values().filter(|v| v.0 == k).count() as u64;
        assert_eq!(s.bulletin_count, count(BlobKind::Bulletin));
        assert_eq!(s.kv_count, count(BlobKind::KeyValue));
        assert_eq!(s.hash_count, count(BlobKind::Hash));
        assert_eq!(s.bulletin_counter, self.counter);
        assert_eq!(p.bulletin_counter(), self.counter);
        assert!(
            s.total_bytes <= MAX_BYTES && s.blob_count <= MAX_COUNT,
            "caps hold"
        );
        for id in self.live.keys() {
            assert!(p.contains(id).unwrap(), "model id present");
        }
        let (ids, _) = p.ids_by_expiry(0, None, usize::MAX).unwrap();
        assert_eq!(ids.len(), self.live.len(), "expiry index size");
        assert_eq!(
            p.bulletin_after(0, usize::MAX).unwrap().len(),
            count(BlobKind::Bulletin) as usize
        );
    }
}

fn run(ops: Vec<Op>, keypairs: &[KeyPair]) {
    let (_d, p) = open(|c| PoolsConfig {
        retention_ms: RETENTION,
        max_future_skew_ms: SKEW,
        max_total_bytes: MAX_BYTES,
        max_blob_count: MAX_COUNT,
        eviction_low_watermark: 0.6,
        protected_trust_bucket: 8,
        sync_writes: false,
        ..c
    });
    let (tx, rx) = crossbeam::channel::unbounded();
    p.set_eviction_sink(Some(tx));
    let mut model = Model {
        live: HashMap::new(),
        counter: 0,
    };
    let mut sweep_now = NOW;
    for op in ops {
        match op {
            Op::Insert {
                kind,
                keypair,
                age,
                bucket,
                len,
                salt,
            } => {
                // created_at spans [NOW + SKEW + 200 - ...]: some are future-dated or expired
                let created_at = NOW + SKEW + 200 - age;
                let payload = vec![salt; len];
                let env = match kind {
                    0 => BlobEnvelope::new(BlobKind::Bulletin, created_at, vec![], payload),
                    1 => kv(&keypairs[keypair], created_at, &payload),
                    _ => BlobEnvelope::new(BlobKind::Hash, created_at, vec![], payload),
                };
                let expires_at = created_at + RETENTION;
                let out = p.insert(env.clone(), src(bucket), NOW).unwrap();
                for evicted in rx.try_iter().flatten() {
                    assert!(model.live.remove(&evicted).is_some(), "evicted id was live");
                }
                match out {
                    InsertOutcome::Inserted { id, counter } => {
                        assert_eq!(id, env.id());
                        if env.kind == BlobKind::Bulletin {
                            model.counter += 1;
                            assert_eq!(counter, Some(model.counter));
                        } else {
                            assert_eq!(counter, None);
                        }
                        assert!(model
                            .live
                            .insert(id, (env.kind, env.wire_size() as u64, expires_at))
                            .is_none());
                    }
                    InsertOutcome::AlreadyPresent { id, .. } => {
                        assert!(model.live.contains_key(&id));
                    }
                    InsertOutcome::Rejected(r) => match r {
                        RejectReason::FutureDated => assert!(created_at > NOW + SKEW),
                        RejectReason::Expired => assert!(expires_at <= NOW),
                        RejectReason::KeyTaken => assert_eq!(env.kind, BlobKind::KeyValue),
                        RejectReason::PoolFull => {}
                        other => panic!("unexpected rejection {other:?}"),
                    },
                }
            }
            Op::Sweep { ahead, batch } => {
                sweep_now = sweep_now.max(NOW + ahead);
                let removed = p.sweep_expired(sweep_now, batch).unwrap();
                let expired: Vec<BlobId> = model
                    .live
                    .iter()
                    .filter(|(_, v)| v.2 <= sweep_now)
                    .map(|(id, _)| *id)
                    .collect();
                assert_eq!(removed.len(), expired.len().min(batch));
                for id in &removed {
                    assert!(expired.contains(id));
                    model.live.remove(id);
                }
            }
            Op::Evict => {
                // never over caps after an insert, so this is a no-op
                assert!(p.evict_under_pressure().unwrap().is_empty());
            }
        }
        model.check(&p);
    }
}

proptest! {
    #![proptest_config(ProptestConfig { cases: 24, .. ProptestConfig::default() })]
    #[test]
    fn random_sequences_keep_stats_consistent(ops in prop::collection::vec(op(), 1..40)) {
        let keypairs: Vec<KeyPair> = (0..4).map(|_| keypair()).collect();
        run(ops, &keypairs);
    }
}
