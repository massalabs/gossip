//! Regression tests for the security review findings.
mod common;

use common::*;
use gossip_pools::schema::{Meta, META};
use gossip_pools::{
    BlobEnvelope, BlobId, InsertOutcome, Pools, PoolsConfig, RejectReason,
    DEFAULT_MAX_BULLETIN_PAYLOAD_LEN,
};
use gossip_wire::hash_pool_key;
use redb::ReadableTable;

fn rewrapped(env: &BlobEnvelope, created_at: u64) -> BlobEnvelope {
    BlobEnvelope {
        created_at,
        ..env.clone()
    }
}

// ---- 1. expiry downgrade by re-wrapping -------------------------------------------

#[test]
fn kv_rewrap_with_earlier_expiry_cannot_shadow_genuine_entry() {
    let (_d, p) = open(|c| c);
    let retention = p.config().retention_ms;
    let kp = keypair();
    let genuine = kv(&kp, NOW, b"hello");
    // the attacker's copy arrives first and would expire in 60 s
    let downgraded = rewrapped(&genuine, NOW - retention + 60_000);
    let (tx, rx) = crossbeam::channel::unbounded();
    p.set_eviction_sink(Some(tx));
    let bad_id = inserted(&p.insert(downgraded.clone(), src(0), NOW).unwrap());
    let before = p.stats().unwrap();

    // the genuine copy replaces it
    assert_eq!(
        p.insert(genuine.clone(), src(0), NOW).unwrap(),
        InsertOutcome::Inserted {
            id: genuine.id(),
            counter: None
        }
    );
    assert_eq!(rx.try_recv().unwrap(), vec![bad_id]);
    assert!(!p.contains(&bad_id).unwrap());
    assert_eq!(p.kv_get(&genuine.key).unwrap().unwrap(), genuine);
    assert_eq!(
        p.stats().unwrap(),
        before,
        "replacement is size and count neutral"
    );
    let (ids, _) = p.ids_by_expiry(0, None, 10).unwrap();
    assert_eq!(ids, vec![genuine.id()]);

    // the entry survives the attacker's expiry instant
    assert!(p.sweep_expired(NOW + 60_000, 100).unwrap().is_empty());
    assert_eq!(p.kv_get(&genuine.key).unwrap().unwrap(), genuine);

    // re-posting the downgraded copy (or an equal-expiry one) is a no-op
    let already = InsertOutcome::AlreadyPresent {
        id: genuine.id(),
        counter: None,
    };
    assert_eq!(p.insert(downgraded, src(0), NOW).unwrap(), already);
    assert_eq!(p.insert(genuine.clone(), src(0), NOW).unwrap(), already);
    assert!(rx.try_recv().is_err());

    // a different payload under the taken key is still refused
    assert_eq!(
        p.insert(kv(&kp, NOW + 1, b"other"), src(15), NOW).unwrap(),
        InsertOutcome::Rejected(RejectReason::KeyTaken)
    );
    assert_eq!(p.kv_get(&genuine.key).unwrap().unwrap(), genuine);
}

#[test]
fn hash_rewrap_with_earlier_expiry_cannot_shadow_genuine_entry() {
    let (_d, p) = open(|c| c);
    let retention = p.config().retention_ms;
    let genuine = hash(NOW, b"published key set");
    let downgraded = rewrapped(&genuine, NOW - retention + 60_000);
    let (tx, rx) = crossbeam::channel::unbounded();
    p.set_eviction_sink(Some(tx));
    let bad_id = inserted(&p.insert(downgraded.clone(), src(0), NOW).unwrap());

    assert_eq!(
        p.insert(genuine.clone(), src(0), NOW).unwrap(),
        InsertOutcome::Inserted {
            id: genuine.id(),
            counter: None
        }
    );
    assert_eq!(rx.try_recv().unwrap(), vec![bad_id]);
    assert!(!p.contains(&bad_id).unwrap());
    let key = hash_pool_key(b"published key set");
    assert_eq!(p.hash_get(&key).unwrap().unwrap(), genuine);
    assert_eq!(p.stats().unwrap().hash_count, 1);
    assert_eq!(p.stats().unwrap().blob_count, 1);
    assert!(p.sweep_expired(NOW + 60_000, 100).unwrap().is_empty());
    assert_eq!(p.hash_get(&key).unwrap().unwrap(), genuine);
    assert_eq!(
        p.insert(downgraded, src(0), NOW).unwrap(),
        InsertOutcome::AlreadyPresent {
            id: genuine.id(),
            counter: None
        }
    );
}

#[test]
fn replacement_works_in_batches_and_when_pool_is_full() {
    // exactly full: a replacement must not be refused (it is size neutral)
    let kp = keypair();
    let genuine = kv(&kp, NOW, b"m");
    let early = rewrapped(&genuine, NOW - 1_000);
    let (_d, p) = open(|c| PoolsConfig {
        max_blob_count: 1,
        eviction_low_watermark: 1.0,
        ..c
    });
    inserted(&p.insert(early.clone(), src(0), NOW).unwrap());
    assert!(p
        .insert(genuine.clone(), src(0), NOW)
        .unwrap()
        .is_inserted());
    assert_eq!(p.stats().unwrap().blob_count, 1);

    // in one batch: early, then genuine (replaces), then early again (no-op)
    let (_d2, p) = open(|c| c);
    let out = p
        .insert_many_prevalidated(
            vec![
                (early.clone(), src(0)),
                (genuine.clone(), src(0)),
                (early, src(0)),
            ],
            NOW,
        )
        .unwrap();
    assert!(out[0].is_inserted());
    assert_eq!(
        out[1],
        InsertOutcome::Inserted {
            id: genuine.id(),
            counter: None
        }
    );
    assert_eq!(
        out[2],
        InsertOutcome::AlreadyPresent {
            id: genuine.id(),
            counter: None
        }
    );
    assert_eq!(p.stats().unwrap().blob_count, 1);
}

// ---- 2. unbounded reads ----------------------------------------------------------

/// Rewrites the recorded size of `id` so a test can tell whether a read consulted
/// `meta` (cheap) or the envelope (expensive) to enforce the byte budget.
fn fake_meta_size(path: &std::path::Path, id: &BlobId, size: u32) {
    let db = redb::Database::open(path).unwrap();
    let txn = db.begin_write().unwrap();
    {
        let mut meta = txn.open_table(META).unwrap();
        let mut m = Meta::decode(meta.get(id.as_bytes()).unwrap().unwrap().value()).unwrap();
        m.size = size;
        meta.insert(id.as_bytes(), m.encode().as_slice()).unwrap();
    }
    txn.commit().unwrap();
}

#[test]
fn bounded_reads_use_meta_size_before_loading() {
    let dir = tempfile::tempdir().unwrap();
    let cfg = PoolsConfig::default().with_path(dir.path().join("pools.redb"));
    let kps: Vec<_> = (0..3).map(|_| keypair()).collect();
    let bulletins: Vec<_> = (0..3u8).map(|i| bulletin(NOW, [i; 32])).collect();
    let kvs: Vec<_> = kps.iter().map(|kp| kv(kp, NOW, b"m")).collect();
    {
        let p = Pools::open(cfg.clone()).unwrap();
        for e in bulletins.iter().chain(&kvs) {
            inserted(&p.insert(e.clone(), src(0), NOW).unwrap());
        }
    }
    // the middle item of each kind claims to be enormous
    fake_meta_size(&cfg.path, &bulletins[1].id(), u32::MAX);
    fake_meta_size(&cfg.path, &kvs[1].id(), u32::MAX);
    let p = Pools::open(cfg).unwrap();
    let cap = 1 << 20;

    let ids: Vec<BlobId> = bulletins.iter().map(|e| e.id()).collect();
    assert_eq!(
        p.get_many(&ids, cap).unwrap(),
        vec![bulletins[0].clone(), bulletins[2].clone()]
    );
    // first found is always served, even when alone it exceeds the budget
    assert_eq!(
        p.get_many(&ids[1..], cap).unwrap(),
        vec![bulletins[1].clone()]
    );

    let keys: Vec<Vec<u8>> = kvs.iter().map(|e| e.key.clone()).collect();
    assert_eq!(
        p.kv_get_many_bounded(&keys, cap).unwrap(),
        vec![kvs[0].clone(), kvs[2].clone()]
    );
    assert_eq!(
        p.kv_get_many_bounded(&keys[1..], cap).unwrap(),
        vec![kvs[1].clone()]
    );
    // the unbounded variant still returns everything
    assert_eq!(p.kv_get_many(&keys).unwrap(), kvs);

    // bulletin pages stop (never skip) at the first entry over budget
    let page = p.bulletin_after_bounded(0, 10, cap).unwrap();
    assert_eq!(page, vec![(1, bulletins[0].clone())]);
    let page = p.bulletin_after_bounded(1, 10, cap).unwrap();
    assert_eq!(page, vec![(2, bulletins[1].clone())]);
    assert_eq!(p.bulletin_after(0, 10).unwrap().len(), 3);
}

#[test]
fn bounded_reads_honour_real_sizes() {
    let (_d, p) = open(|c| c);
    let small: Vec<_> = (0..4u8).map(|i| bulletin(NOW, vec![i; 100])).collect();
    let big = bulletin(NOW, vec![9; 4_000]);
    let one = small[0].wire_size();
    for e in [&small[0], &big, &small[1], &small[2], &small[3]] {
        inserted(&p.insert(e.clone(), src(0), NOW).unwrap());
    }
    // get_many skips the big one and keeps filling with small ones
    let ids = [small[0].id(), big.id(), small[1].id(), small[2].id()];
    assert_eq!(p.get_many(&ids, 2 * one).unwrap(), small[..2]);
    assert_eq!(p.get_many(&ids, 0).unwrap(), small[..1]);
    // bulletin_after_bounded: counters 1 small, 2 big, 3..5 small
    let counters = |v: Vec<(u64, BlobEnvelope)>| v.into_iter().map(|(c, _)| c).collect::<Vec<_>>();
    assert_eq!(
        counters(p.bulletin_after_bounded(0, 10, 2 * one).unwrap()),
        vec![1]
    );
    assert_eq!(
        counters(p.bulletin_after_bounded(1, 10, 2 * one).unwrap()),
        vec![2]
    );
    assert_eq!(
        counters(p.bulletin_after_bounded(2, 10, 2 * one).unwrap()),
        vec![3, 4]
    );
    assert_eq!(
        counters(p.bulletin_after_bounded(2, 1, usize::MAX).unwrap()),
        vec![3]
    );
    assert_eq!(
        counters(p.bulletin_after_bounded(0, 10, usize::MAX).unwrap()),
        vec![1, 2, 3, 4, 5]
    );
    assert!(p.bulletin_after_bounded(5, 10, 0).unwrap().is_empty());

    let kps: Vec<_> = (0..3).map(|_| keypair()).collect();
    let kvs = [
        kv(&kps[0], NOW, &[1; 50]),
        kv(&kps[1], NOW, &[2; 3_000]),
        kv(&kps[2], NOW, &[3; 50]),
    ];
    for e in &kvs {
        inserted(&p.insert(e.clone(), src(0), NOW).unwrap());
    }
    let keys: Vec<Vec<u8>> = [
        kvs[0].key.clone(),
        vec![0; 34],
        kvs[1].key.clone(),
        kvs[2].key.clone(),
    ]
    .to_vec();
    let budget = kvs[0].wire_size() + kvs[2].wire_size();
    assert_eq!(
        p.kv_get_many_bounded(&keys, budget).unwrap(),
        vec![kvs[0].clone(), kvs[2].clone()]
    );
    assert_eq!(
        p.kv_get_many_bounded(&keys[1..], 0).unwrap(),
        vec![kvs[1].clone()]
    );
    assert!(p.kv_get_many_bounded(&[vec![0; 34]], 0).unwrap().is_empty());
}

// ---- 3. bulletin payload cap ----------------------------------------------------

#[test]
fn bulletin_payload_cap_is_enforced() {
    let (_d, p) = open(|c| c);
    let cap = p.config().max_bulletin_payload_len;
    assert_eq!(cap, DEFAULT_MAX_BULLETIN_PAYLOAD_LEN);
    assert_eq!(cap, 64 * 1024);
    assert!(p
        .insert(bulletin(NOW, vec![0; cap]), src(0), NOW)
        .unwrap()
        .is_inserted());
    assert_eq!(
        p.insert(bulletin(NOW, vec![1; cap + 1]), src(0), NOW)
            .unwrap(),
        InsertOutcome::Rejected(RejectReason::PayloadTooLarge)
    );
    assert_eq!(
        p.validate(&bulletin(NOW, vec![1; cap + 1]), NOW, true),
        Err(RejectReason::PayloadTooLarge)
    );
    // other kinds keep their own caps
    assert!(p
        .insert(kv(&keypair(), NOW, &vec![0; cap * 2]), src(0), NOW)
        .unwrap()
        .is_inserted());

    // configurable, and never above max_payload_len
    let (_d2, p) = open(|c| PoolsConfig {
        max_bulletin_payload_len: 10,
        ..c
    });
    assert_eq!(
        p.insert(bulletin(NOW, [0; 11]), src(0), NOW).unwrap(),
        InsertOutcome::Rejected(RejectReason::PayloadTooLarge)
    );
    let (_d3, p) = open(|c| PoolsConfig {
        max_payload_len: 10,
        ..c
    });
    assert_eq!(
        p.insert(bulletin(NOW, [0; 11]), src(0), NOW).unwrap(),
        InsertOutcome::Rejected(RejectReason::PayloadTooLarge)
    );
}

#[test]
fn real_client_announcements_fit_with_4x_headroom() {
    // resolved at run time: a checkout that moved does not need a rebuild first
    let manifest = std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR");
    let path = std::path::Path::new(&manifest).join("tests/fixtures/client-blobs-v1.json");
    let text = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("client fixture at {}: {e}", path.display()));
    let fixture: serde_json::Value = serde_json::from_str(&text).unwrap();
    let anns = fixture["announcements_hex"].as_array().unwrap();
    assert!(!anns.is_empty());
    let largest = anns
        .iter()
        .map(|a| a.as_str().unwrap().len() / 2)
        .max()
        .unwrap();
    // worst-case optional user_data on top: Args(u32 + 35 chars * 3 bytes, u32 + 500 * 3)
    // plus 2 bytes of bincode length varint growth
    let realistic = largest + (4 + 35 * 3) + (4 + 500 * 3) + 2;
    assert!(
        4 * realistic <= DEFAULT_MAX_BULLETIN_PAYLOAD_LEN,
        "{realistic} bytes"
    );
    let (_d, p) = open(|c| c);
    for a in anns {
        let bytes: Vec<u8> = (0..a.as_str().unwrap().len() / 2)
            .map(|i| u8::from_str_radix(&a.as_str().unwrap()[2 * i..2 * i + 2], 16).unwrap())
            .collect();
        let mut padded = bytes.clone();
        padded.resize(realistic, 0);
        assert!(p
            .insert(bulletin(NOW, bytes), src(0), NOW)
            .unwrap()
            .is_inserted());
        assert!(p
            .insert(bulletin(NOW, padded), src(0), NOW)
            .unwrap()
            .is_inserted());
    }
}
