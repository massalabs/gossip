mod common;

use std::time::Duration;

use common::*;
use gossip_pools::{
    now_ms, BlobEnvelope, BlobId, BlobKind, InsertOutcome, KvError, PoolError, Pools, RejectReason,
    Source,
};
use gossip_wire::hash_pool_key;
use massa_signature::verify_signature_batch;

#[test]
fn insert_and_already_present_for_each_kind() {
    let (_d, p) = open(|c| c);
    let kp = keypair();
    let envs = [bulletin(NOW, b"a"), kv(&kp, NOW, b"m"), hash(NOW, b"pk")];
    for env in envs {
        let first = p.insert(env.clone(), src(3), NOW).unwrap();
        let id = inserted(&first);
        assert_eq!(id, env.id());
        let counter = first.counter();
        assert_eq!(counter.is_some(), env.kind == BlobKind::Bulletin);
        let again = p.insert(env.clone(), src(3), NOW).unwrap();
        assert_eq!(again, InsertOutcome::AlreadyPresent { id, counter });
        assert!(p.contains(&id).unwrap());
        assert_eq!(p.get(&id).unwrap().unwrap(), env);
    }
    let s = p.stats().unwrap();
    assert_eq!(
        (s.blob_count, s.bulletin_count, s.kv_count, s.hash_count),
        (3, 1, 1, 1)
    );
    assert!(!p.contains(&BlobId::from_bytes([7; 32])).unwrap());
    assert!(p.get(&BlobId::from_bytes([7; 32])).unwrap().is_none());
}

#[test]
fn bulletin_counter_strictly_increasing_and_stable_on_repost() {
    let (_d, p) = open(|c| c);
    assert_eq!(p.bulletin_counter(), 0);
    let mut last = 0;
    for i in 0..10u32 {
        let o = p
            .insert(bulletin(NOW, i.to_le_bytes()), src(0), NOW)
            .unwrap();
        let c = o.counter().unwrap();
        assert!(c > last);
        last = c;
        assert_eq!(p.bulletin_counter(), c);
    }
    assert_eq!(last, 10);
    // non-bulletin inserts do not consume counters
    p.insert(hash(NOW, b"x"), src(0), NOW).unwrap();
    assert_eq!(p.bulletin_counter(), 10);
    // re-posting an existing bulletin returns its original counter
    let o = p
        .insert(bulletin(NOW, 3u32.to_le_bytes()), src(0), NOW)
        .unwrap();
    assert_eq!(o.counter(), Some(4));
    assert!(matches!(o, InsertOutcome::AlreadyPresent { .. }));
    assert_eq!(p.bulletin_counter(), 10);
}

#[test]
fn bulletin_after_pagination_with_holes() {
    let (_d, p) = open(|c| c);
    // counters 1..=6; number 3 expires first
    let retention = p.config().retention_ms;
    let soon = NOW - retention + 10;
    let mut ids = Vec::new();
    for i in 1..=6u32 {
        let created = if i == 3 { soon } else { NOW };
        ids.push(inserted(
            &p.insert(bulletin(created, i.to_le_bytes()), src(0), NOW)
                .unwrap(),
        ));
    }
    let page = p.bulletin_after(0, 4).unwrap();
    assert_eq!(
        page.iter().map(|(c, _)| *c).collect::<Vec<_>>(),
        vec![1, 2, 3, 4]
    );
    let page = p.bulletin_after(4, 10).unwrap();
    assert_eq!(page.iter().map(|(c, _)| *c).collect::<Vec<_>>(), vec![5, 6]);
    assert!(p.bulletin_after(6, 10).unwrap().is_empty());
    assert!(p.bulletin_after(u64::MAX, 10).unwrap().is_empty());
    assert_eq!(page[0].1, bulletin(NOW, 5u32.to_le_bytes()));

    // sweep number 3 -> hole
    let removed = p.sweep_expired(soon + retention, 100).unwrap();
    assert_eq!(removed, vec![ids[2]]);
    let page = p.bulletin_after(0, 10).unwrap();
    assert_eq!(
        page.iter().map(|(c, _)| *c).collect::<Vec<_>>(),
        vec![1, 2, 4, 5, 6]
    );
    let page = p.bulletin_after(2, 1).unwrap();
    assert_eq!(page.iter().map(|(c, _)| *c).collect::<Vec<_>>(), vec![4]);
    // the counter is not reused
    let o = p.insert(bulletin(NOW, b"new"), src(0), NOW).unwrap();
    assert_eq!(o.counter(), Some(7));
}

#[test]
fn kv_first_writer_wins_and_identical_duplicate() {
    let (_d, p) = open(|c| c);
    let kp = keypair();
    let first = kv(&kp, NOW, b"first");
    let id = inserted(&p.insert(first.clone(), src(0), NOW).unwrap());
    // a different, valid entry for the same seeker key loses
    let second = kv(&kp, NOW + 1, b"second");
    assert_eq!(first.key, second.key);
    assert_eq!(
        p.insert(second.clone(), src(15), NOW).unwrap(),
        InsertOutcome::Rejected(RejectReason::KeyTaken)
    );
    assert!(!p.contains(&second.id()).unwrap());
    // byte-identical re-post is a no-op
    assert_eq!(
        p.insert(first.clone(), src(0), NOW).unwrap(),
        InsertOutcome::AlreadyPresent { id, counter: None }
    );
    assert_eq!(p.kv_get(&first.key).unwrap().unwrap(), first);
    assert!(p.kv_get(b"nope").unwrap().is_none());
    let other = kv(&keypair(), NOW, b"other");
    p.insert(other.clone(), src(0), NOW).unwrap();
    let many = p
        .kv_get_many(&[other.key.clone(), vec![1, 2], first.key.clone()])
        .unwrap();
    assert_eq!(many, vec![other, first]);
    assert_eq!(p.stats().unwrap().kv_count, 2);
}

#[test]
fn hash_index_dedups_by_payload() {
    let (_d, p) = open(|c| c);
    let a = hash(NOW, b"published keys");
    let earlier = hash(NOW - 5, b"published keys");
    let later = hash(NOW + 5, b"published keys");
    assert_ne!(a.id(), earlier.id());
    let id = inserted(&p.insert(a.clone(), src(0), NOW).unwrap());
    // same payload, earlier expiry: the stored blob wins and its id is returned
    assert_eq!(
        p.insert(earlier.clone(), src(0), NOW).unwrap(),
        InsertOutcome::AlreadyPresent { id, counter: None }
    );
    assert!(!p.contains(&earlier.id()).unwrap());
    let key = hash_pool_key(b"published keys");
    assert_eq!(p.hash_get(&key).unwrap().unwrap(), a);
    // same payload, later expiry: replaces the stored copy (see tests/security.rs)
    assert_eq!(
        p.insert(later.clone(), src(0), NOW).unwrap(),
        InsertOutcome::Inserted {
            id: later.id(),
            counter: None
        }
    );
    assert!(!p.contains(&id).unwrap());
    assert_eq!(p.hash_get(&key).unwrap().unwrap(), later);
    assert!(p.hash_get(&[0; 32]).unwrap().is_none());
    assert_eq!(p.stats().unwrap().hash_count, 1);
}

#[test]
fn kv_validation_errors_map_to_rejected_kv() {
    let (_d, p) = open(|c| c);
    let kp = keypair();
    let good = kv(&kp, NOW, b"m");
    let reject = |env: BlobEnvelope| match p.insert(env, src(0), NOW).unwrap() {
        InsertOutcome::Rejected(RejectReason::Kv(e)) => e,
        other => panic!("expected Kv rejection, got {other:?}"),
    };
    let mut malformed_key = good.clone();
    malformed_key.key = vec![1; 34];
    assert_eq!(reject(malformed_key), KvError::MalformedKey);
    let mut short_key = good.clone();
    short_key.key.truncate(10);
    assert_eq!(reject(short_key), KvError::MalformedKey);
    let mut mismatch = good.clone();
    mismatch.key = kv(&keypair(), NOW, b"m").key;
    assert_eq!(reject(mismatch), KvError::KeyMismatch);
    let mut truncated = good.clone();
    truncated.payload.truncate(5);
    assert!(matches!(
        reject(truncated),
        KvError::MalformedValue | KvError::InvalidPublicKey
    ));
    let mut empty = good.clone();
    empty.payload.clear();
    assert_eq!(reject(empty), KvError::MalformedValue);
    assert_eq!(p.stats().unwrap().blob_count, 0);
    // validate() returns batch material for a good entry and verifies it on demand
    let material = p.validate(&good, NOW, false).unwrap().unwrap();
    verify_signature_batch(&[material.into_tuple()]).unwrap();
    material.verify().unwrap();
    assert!(p.validate(&good, NOW, true).unwrap().is_none());
}

#[test]
fn bad_signature_rejected_by_insert_but_stored_prevalidated() {
    let (_d, p) = open(|c| c);
    let kp = keypair();
    let mut env = kv(&kp, NOW, b"m");
    *env.payload.last_mut().unwrap() ^= 1;
    assert_eq!(
        p.insert(env.clone(), src(0), NOW).unwrap(),
        InsertOutcome::Rejected(RejectReason::Kv(KvError::BadSignature))
    );
    assert_eq!(
        p.validate(&env, NOW, true),
        Err(RejectReason::Kv(KvError::BadSignature))
    );
    // the material is returned without verification...
    let m = p.validate(&env, NOW, false).unwrap().unwrap();
    assert_eq!(m.verify(), Err(KvError::BadSignature));
    assert!(verify_signature_batch(&[m.into_tuple()]).is_err());
    // ...and insert_prevalidated trusts the caller: this is documented behaviour.
    let id = inserted(&p.insert_prevalidated(env.clone(), src(0), NOW).unwrap());
    assert_eq!(id, env.id());
    assert!(p.contains(&id).unwrap());
}

#[test]
fn time_window_and_size_rejections() {
    let (_d, p) = open(|c| c);
    let cfg = p.config().clone();
    let reject = |env: BlobEnvelope| match p.insert(env, src(0), NOW).unwrap() {
        InsertOutcome::Rejected(r) => r,
        other => panic!("expected rejection, got {other:?}"),
    };
    assert_eq!(
        reject(bulletin(NOW + cfg.max_future_skew_ms + 1, b"x")),
        RejectReason::FutureDated
    );
    assert!(p
        .insert(bulletin(NOW + cfg.max_future_skew_ms, b"x"), src(0), NOW)
        .unwrap()
        .is_inserted());
    assert_eq!(
        reject(bulletin(NOW - cfg.retention_ms, b"y")),
        RejectReason::Expired
    );
    assert!(p
        .insert(bulletin(NOW - cfg.retention_ms + 1, b"y"), src(0), NOW)
        .unwrap()
        .is_inserted());
    assert_eq!(
        reject(hash(NOW, vec![0; cfg.max_hash_payload_len + 1])),
        RejectReason::PayloadTooLarge
    );
    assert_eq!(
        reject(bulletin(NOW, vec![0; cfg.max_payload_len + 1])),
        RejectReason::PayloadTooLarge
    );
    let mut keyed = bulletin(NOW, b"z");
    keyed.key = vec![1];
    assert_eq!(reject(keyed), RejectReason::KeyNotAllowed);
    let mut keyed_hash = hash(NOW, b"z");
    keyed_hash.key = vec![1];
    assert_eq!(reject(keyed_hash), RejectReason::KeyNotAllowed);
    let mut long_key = kv(&keypair(), NOW, b"m");
    long_key.key = vec![1; cfg.max_key_len + 1];
    assert_eq!(reject(long_key), RejectReason::KeyTooLarge);
    assert_eq!(p.stats().unwrap().blob_count, 2);
}

#[test]
fn ids_by_expiry_paging() {
    let (_d, p) = open(|c| c);
    let retention = p.config().retention_ms;
    let mut expected: Vec<(u64, BlobId)> = Vec::new();
    for i in 0..7u64 {
        let created = NOW - 1000 * (i % 3); // three distinct expiry instants
        let env = bulletin(created, i.to_le_bytes());
        expected.push((created + retention, env.id()));
        p.insert(env, src(0), NOW).unwrap();
    }
    expected.sort();
    let all_ids: Vec<BlobId> = expected.iter().map(|(_, id)| *id).collect();

    let mut got = Vec::new();
    let mut cursor = None;
    let mut pages = 0;
    loop {
        let (ids, next) = p.ids_by_expiry(0, cursor, 3).unwrap();
        pages += 1;
        got.extend(ids);
        match next {
            Some(c) => cursor = Some(c),
            None => break,
        }
    }
    assert_eq!(got, all_ids);
    assert_eq!(pages, 3);
    // exact fit: no cursor when nothing remains
    let (ids, next) = p.ids_by_expiry(0, None, 7).unwrap();
    assert_eq!(ids.len(), 7);
    assert!(next.is_none());
    // from an expiry instant: only the last group
    let last_expiry = expected.last().unwrap().0;
    let (ids, next) = p.ids_by_expiry(last_expiry, None, 100).unwrap();
    assert_eq!(
        ids.len(),
        expected.iter().filter(|(e, _)| *e == last_expiry).count()
    );
    assert!(next.is_none());
    assert_eq!(p.ids_by_expiry(0, None, 0).unwrap(), (vec![], None));
    assert_eq!(p.ids_by_expiry(u64::MAX, None, 5).unwrap(), (vec![], None));
}

#[test]
fn sweep_expired_removes_exactly_the_expired_and_all_indexes() {
    let (_d, p) = open(|c| c);
    let retention = p.config().retention_ms;
    let kp_old = keypair();
    let kp_new = keypair();
    let old_t = NOW - retention + 100; // expires at NOW + 100
    let new_t = NOW; // expires at NOW + retention
    let old = [
        bulletin(old_t, b"ob"),
        kv(&kp_old, old_t, b"om"),
        hash(old_t, b"oh"),
    ];
    let fresh = [
        bulletin(new_t, b"nb"),
        kv(&kp_new, new_t, b"nm"),
        hash(new_t, b"nh"),
    ];
    let old_ids: Vec<BlobId> = old
        .iter()
        .map(|e| inserted(&p.insert(e.clone(), src(0), NOW).unwrap()))
        .collect();
    let fresh_ids: Vec<BlobId> = fresh
        .iter()
        .map(|e| inserted(&p.insert(e.clone(), src(0), NOW).unwrap()))
        .collect();
    let before = p.stats().unwrap();
    assert_eq!(before.blob_count, 6);

    // nothing expired yet
    assert!(p.sweep_expired(NOW + 99, 100).unwrap().is_empty());
    assert_eq!(p.stats().unwrap(), before);
    // batch limit is honoured
    let first = p.sweep_expired(NOW + 100, 1).unwrap();
    assert_eq!(first.len(), 1);
    let mut rest = p.sweep_expired(NOW + 100, 100).unwrap();
    assert_eq!(rest.len(), 2);
    rest.extend(first);
    rest.sort();
    let mut expected = old_ids.clone();
    expected.sort();
    assert_eq!(rest, expected);

    for id in &old_ids {
        assert!(!p.contains(id).unwrap());
        assert!(p.get(id).unwrap().is_none());
    }
    for (id, env) in fresh_ids.iter().zip(&fresh) {
        assert!(p.contains(id).unwrap());
        assert_eq!(p.get(id).unwrap().unwrap(), *env);
    }
    assert!(p.kv_get(&old[1].key).unwrap().is_none());
    assert_eq!(p.kv_get(&fresh[1].key).unwrap().unwrap(), fresh[1]);
    assert!(p.hash_get(&hash_pool_key(b"oh")).unwrap().is_none());
    assert!(p.hash_get(&hash_pool_key(b"nh")).unwrap().is_some());
    let page = p.bulletin_after(0, 10).unwrap();
    assert_eq!(page.iter().map(|(c, _)| *c).collect::<Vec<_>>(), vec![2]);
    let (ids, _) = p.ids_by_expiry(0, None, 100).unwrap();
    assert_eq!(ids.len(), 3);
    assert!(ids.iter().all(|id| fresh_ids.contains(id)));

    let after = p.stats().unwrap();
    let old_bytes: u64 = old.iter().map(|e| e.wire_size() as u64).sum();
    assert_eq!(after.total_bytes, before.total_bytes - old_bytes);
    assert_eq!(after.blob_count, 3);
    assert_eq!(
        (after.bulletin_count, after.kv_count, after.hash_count),
        (1, 1, 1)
    );
    assert_eq!(after.bulletin_counter, 2);
    // the seeker key is free again after expiry
    assert!(p
        .insert(kv(&kp_old, NOW, b"again"), src(0), NOW)
        .unwrap()
        .is_inserted());
    // re-inserting the expired blob itself is refused
    assert_eq!(
        p.insert(old[0].clone(), src(0), NOW + 100).unwrap(),
        InsertOutcome::Rejected(RejectReason::Expired)
    );
}

#[test]
fn evict_under_pressure_ordering() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("pools.redb");
    let base = gossip_pools::PoolsConfig::default().with_path(&path);
    // (bucket, created_at offset) in insertion order; payloads all the same size
    let spec: [(u8, u64); 6] = [(3, 0), (0, 500), (15, 100), (0, 200), (12, 50), (5, 900)];
    let mut ids = Vec::new();
    let size;
    {
        let p = Pools::open(base.clone()).unwrap();
        for (i, (bucket, off)) in spec.iter().enumerate() {
            let env = bulletin(NOW + off, [i as u8; 16]);
            ids.push(inserted(&p.insert(env, src(*bucket), NOW).unwrap()));
        }
        size = p.stats().unwrap().total_bytes / 6;
        assert!(p.evict_under_pressure().unwrap().is_empty());
    }
    // cap so that 4 must go, watermark 1.0 => stop as soon as usage <= cap
    {
        let cfg = base.clone().with_path(&path);
        let cfg = gossip_pools::PoolsConfig {
            max_total_bytes: 2 * size,
            eviction_low_watermark: 1.0,
            protected_trust_bucket: 10,
            ..cfg
        };
        let p = Pools::open(cfg).unwrap();
        let removed = p.evict_under_pressure().unwrap();
        // bucket 0 oldest first (idx 3 then 1), then bucket 3 (idx 0), then bucket 5 (idx 5)
        assert_eq!(removed, vec![ids[3], ids[1], ids[0], ids[5]]);
        let s = p.stats().unwrap();
        assert_eq!(s.blob_count, 2);
        assert_eq!(s.total_bytes, 2 * size);
        assert!(p.evict_under_pressure().unwrap().is_empty());
        assert!(p.contains(&ids[2]).unwrap() && p.contains(&ids[4]).unwrap());
    }
    // protected buckets are evicted last, by age alone (bucket 12 @ +50 before 15 @ +100)
    {
        let cfg = gossip_pools::PoolsConfig {
            max_total_bytes: size - 1,
            eviction_low_watermark: 1.0,
            ..base.clone()
        };
        let p = Pools::open(cfg).unwrap();
        let removed = p.evict_under_pressure().unwrap();
        assert_eq!(removed, vec![ids[4], ids[2]]);
        assert_eq!(p.stats().unwrap().blob_count, 0);
        assert_eq!(p.stats().unwrap().total_bytes, 0);
    }
    // count cap and low watermark
    {
        let cfg = gossip_pools::PoolsConfig {
            max_blob_count: 4,
            eviction_low_watermark: 0.5,
            ..base.clone()
        };
        let p = Pools::open(cfg).unwrap();
        for i in 0..4u8 {
            p.insert(bulletin(NOW + i as u64, [i; 4]), src(i), NOW)
                .unwrap();
        }
        assert!(p.evict_under_pressure().unwrap().is_empty());
        // fifth insert (bucket 15 may evict anything): the watermark target (2)
        // includes the incoming blob, so three oldest-lowest go and two remain
        let (tx, rx) = crossbeam::channel::unbounded();
        p.set_eviction_sink(Some(tx));
        let five = inserted(&p.insert(bulletin(NOW + 9, b"five"), src(15), NOW).unwrap());
        assert_eq!(p.stats().unwrap().blob_count, 2);
        let evicted = rx.try_recv().unwrap();
        assert_eq!(evicted.len(), 3);
        assert!(!evicted.contains(&five));
        assert!(p.contains(&five).unwrap());
        assert!(p.contains(&bulletin(NOW + 3, [3; 4]).id()).unwrap());
    }
}

#[test]
fn insert_only_evicts_lower_or_equal_buckets() {
    let (_d, p) = open(|c| gossip_pools::PoolsConfig {
        max_blob_count: 2,
        eviction_low_watermark: 1.0,
        ..c
    });
    let a = inserted(&p.insert(bulletin(NOW, b"a"), src(5), NOW).unwrap());
    let b = inserted(&p.insert(bulletin(NOW + 1, b"b"), src(5), NOW).unwrap());
    // a low-trust source cannot push out higher-trust blobs
    assert_eq!(
        p.insert(bulletin(NOW, b"spam"), src(0), NOW).unwrap(),
        InsertOutcome::Rejected(RejectReason::PoolFull)
    );
    assert_eq!(p.stats().unwrap().blob_count, 2);
    assert!(p.contains(&a).unwrap() && p.contains(&b).unwrap());
    // an equal-trust source evicts the oldest equal-trust blob
    let (tx, rx) = crossbeam::channel::unbounded();
    p.set_eviction_sink(Some(tx));
    let c = inserted(&p.insert(bulletin(NOW + 2, b"c"), src(5), NOW).unwrap());
    assert_eq!(rx.try_recv().unwrap(), vec![a]);
    assert!(!p.contains(&a).unwrap() && p.contains(&b).unwrap() && p.contains(&c).unwrap());
    // a single blob that can never fit
    let (_d2, tiny) = open(|c| gossip_pools::PoolsConfig {
        max_total_bytes: 10,
        ..c
    });
    assert_eq!(
        tiny.insert(bulletin(NOW, b"too big"), src(15), NOW)
            .unwrap(),
        InsertOutcome::Rejected(RejectReason::PoolFull)
    );
}

#[test]
fn reopen_restores_counter_and_stats() {
    let dir = tempfile::tempdir().unwrap();
    let cfg = gossip_pools::PoolsConfig::default().with_path(dir.path().join("sub/pools.redb"));
    let kp = keypair();
    let (stats, ids) = {
        let p = Pools::open(cfg.clone()).unwrap();
        let ids = vec![
            inserted(&p.insert(bulletin(NOW, b"1"), src(1), NOW).unwrap()),
            inserted(&p.insert(bulletin(NOW, b"2"), src(1), NOW).unwrap()),
            inserted(&p.insert(kv(&kp, NOW, b"m"), src(1), NOW).unwrap()),
            inserted(&p.insert(hash(NOW, b"h"), src(1), NOW).unwrap()),
        ];
        assert_eq!(p.bulletin_counter(), 2);
        (p.stats().unwrap(), ids)
    };
    let p = Pools::open(cfg.clone()).unwrap();
    assert_eq!(p.bulletin_counter(), 2);
    assert_eq!(p.stats().unwrap(), stats);
    for id in &ids {
        assert!(p.contains(id).unwrap());
    }
    assert_eq!(
        p.insert(bulletin(NOW, b"3"), src(1), NOW)
            .unwrap()
            .counter(),
        Some(3)
    );
    assert_eq!(
        p.kv_get(&kv(&kp, NOW, b"m").key).unwrap().unwrap().payload,
        kv(&kp, NOW, b"m").payload
    );
    assert_eq!(
        p.insert(kv(&kp, NOW + 1, b"other"), src(1), NOW).unwrap(),
        InsertOutcome::Rejected(RejectReason::KeyTaken)
    );
    drop(p);

    // a foreign schema version is refused
    {
        let db = redb::Database::open(&cfg.path).unwrap();
        let txn = db.begin_write().unwrap();
        txn.open_table(gossip_pools::schema::COUNTERS)
            .unwrap()
            .insert(gossip_pools::schema::COUNTER_SCHEMA_VERSION, &99u64)
            .unwrap();
        txn.commit().unwrap();
    }
    match Pools::open(cfg) {
        Err(PoolError::SchemaVersion {
            found: 99,
            expected,
        }) => {
            assert_eq!(expected, Pools::SCHEMA_VERSION)
        }
        other => panic!("expected schema version error, got {other:?}"),
    }
}

#[test]
fn get_many_honours_byte_cap() {
    let (_d, p) = open(|c| c);
    let envs: Vec<BlobEnvelope> = (0..5u8).map(|i| bulletin(NOW, vec![i; 100])).collect();
    let ids: Vec<BlobId> = envs
        .iter()
        .map(|e| inserted(&p.insert(e.clone(), src(0), NOW).unwrap()))
        .collect();
    let one = envs[0].wire_size();
    let mut query = ids.clone();
    query.insert(2, BlobId::from_bytes([0; 32])); // unknown ids are skipped
    assert_eq!(p.get_many(&query, usize::MAX).unwrap(), envs);
    assert_eq!(p.get_many(&query, 3 * one).unwrap(), envs[..3]);
    assert_eq!(p.get_many(&query, 3 * one - 1).unwrap(), envs[..2]);
    // at least one is always returned
    assert_eq!(p.get_many(&query, 0).unwrap(), envs[..1]);
    assert!(p
        .get_many(&[BlobId::from_bytes([0; 32])], 0)
        .unwrap()
        .is_empty());
    assert!(p.get_many(&[], usize::MAX).unwrap().is_empty());
}

#[test]
fn insert_many_reports_in_order_and_dedups_within_batch() {
    let (_d, p) = open(|c| c);
    let kp = keypair();
    let b = bulletin(NOW, b"b");
    let k1 = kv(&kp, NOW, b"1");
    let k2 = kv(&kp, NOW + 1, b"2");
    let items = vec![
        (b.clone(), src(0)),
        (k1.clone(), Source::peer(vec![9; 100], 20)), // peer truncated, bucket clamped
        (b.clone(), src(0)),
        (k2.clone(), src(0)),
        (hash(NOW, b"h"), src(0)),
    ];
    let out = p.insert_many_prevalidated(items, NOW).unwrap();
    assert_eq!(
        out[0],
        InsertOutcome::Inserted {
            id: b.id(),
            counter: Some(1)
        }
    );
    assert_eq!(
        out[1],
        InsertOutcome::Inserted {
            id: k1.id(),
            counter: None
        }
    );
    assert_eq!(
        out[2],
        InsertOutcome::AlreadyPresent {
            id: b.id(),
            counter: Some(1)
        }
    );
    assert_eq!(out[3], InsertOutcome::Rejected(RejectReason::KeyTaken));
    assert!(out[4].is_inserted());
    assert_eq!(p.bulletin_counter(), 1);
    assert_eq!(p.stats().unwrap().blob_count, 3);
    assert!(p.insert_many_prevalidated(vec![], NOW).unwrap().is_empty());
}

#[test]
fn sweeper_thread_runs_and_delivers_removed_ids() {
    let (_d, p) = open(|c| gossip_pools::PoolsConfig {
        sweep_interval: Duration::from_millis(20),
        retention_ms: 60_000,
        ..c
    });
    let now = now_ms();
    // expires 150 ms from now
    let soon = bulletin(now - 60_000 + 150, b"soon");
    let later = bulletin(now, b"later");
    let soon_id = inserted(&p.insert(soon, src(0), now).unwrap());
    let later_id = inserted(&p.insert(later, src(0), now).unwrap());
    let (tx, rx) = crossbeam::channel::unbounded();
    let handle = p.start_sweeper(Some(tx));
    let removed = rx
        .recv_timeout(Duration::from_secs(10))
        .expect("sweeper delivered ids");
    assert_eq!(removed, vec![soon_id]);
    assert!(!p.contains(&soon_id).unwrap());
    assert!(p.contains(&later_id).unwrap());
    handle.stop();
    // stopping twice through drop is harmless; the store is still usable
    assert_eq!(p.stats().unwrap().blob_count, 1);
    // a sweeper outliving nothing: dropping the store ends the thread
    let handle = p.start_sweeper(None);
    drop(p);
    std::thread::sleep(Duration::from_millis(60));
    handle.stop();
}

#[test]
fn unsynced_mode_checkpoints_on_drop_and_on_demand() {
    let dir = tempfile::tempdir().unwrap();
    let cfg = gossip_pools::PoolsConfig {
        sync_writes: false,
        ..gossip_pools::PoolsConfig::default().with_path(dir.path().join("pools.redb"))
    };
    // maintain() sweeps with the real clock, so use real time here
    let now = now_ms();
    let (id, stats) = {
        let p = Pools::open(cfg.clone()).unwrap();
        let id = inserted(&p.insert(bulletin(now, b"a"), src(0), now).unwrap());
        p.checkpoint().unwrap();
        p.insert(bulletin(now, b"b"), src(0), now).unwrap();
        // maintain() also checkpoints in this mode
        assert!(p.maintain().unwrap().is_empty());
        p.insert(bulletin(now, b"c"), src(0), now).unwrap();
        (id, p.stats().unwrap())
    };
    let p = Pools::open(cfg).unwrap();
    assert!(p.contains(&id).unwrap());
    assert_eq!(p.stats().unwrap(), stats);
    assert_eq!(p.bulletin_counter(), 3);
}
