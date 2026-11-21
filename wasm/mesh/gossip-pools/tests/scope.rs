//! Blob scope: per-scope retention, time window, caps, indexes and the schema upgrade.

mod common;

use common::*;
use gossip_pools::{InsertOutcome, Pools, PoolsConfig, RejectReason, Scope, Source};

const HOUR: u64 = 60 * 60 * 1000;

fn mesh(bucket: u8) -> Source {
    Source::peer(vec![1; 33], bucket).with_scope(Scope::MESH)
}

#[test]
fn mesh_only_blobs_get_the_mesh_time_window() {
    let (_d, pools) = open(|c| c);
    let cfg = pools.config().clone();
    let kp = keypair();

    // 3 hours ahead: too far for the internet window, fine for the mesh one
    let ahead = kv(&kp, NOW + 3 * HOUR, b"ahead");
    assert_eq!(
        pools.validate(&ahead, NOW, true),
        Err(RejectReason::FutureDated)
    );
    assert!(pools
        .validate_scoped(&ahead, NOW, true, Scope::MESH)
        .is_ok());
    // with internet in the scope, the internet window applies
    assert!(pools
        .validate_scoped(&ahead, NOW, true, Scope::MESH | Scope::INTERNET)
        .is_err());

    // 4 days old: still within the 14-day retention, past the 72-hour mesh one
    let old = kv(&kp, NOW - 96 * HOUR, b"old");
    assert!(pools.validate(&old, NOW, true).is_ok());
    assert_eq!(
        pools.validate_scoped(&old, NOW, true, Scope::MESH),
        Err(RejectReason::Expired)
    );
    assert_eq!(cfg.retention_for(Scope::MESH), cfg.mesh_retention_ms);
    assert_eq!(
        cfg.retention_for(Scope::MESH | Scope::INTERNET),
        cfg.retention_ms
    );
}

#[test]
fn scope_is_stored_merged_and_indexed() {
    let (_d, pools) = open(|c| c);
    let kp = keypair();
    let env = kv(&kp, NOW, b"m");
    let id = inserted(
        &pools
            .insert(
                env.clone(),
                mesh(3).with_scope(Scope::MESH | Scope::UPLOAD),
                NOW,
            )
            .unwrap(),
    );
    let internet = inserted(
        &pools
            .insert(kv(&keypair(), NOW, b"i"), src(3), NOW)
            .unwrap(),
    );

    let (scope, _) = pools.scope_of(&id).unwrap().unwrap();
    assert_eq!(scope, Scope::MESH | Scope::UPLOAD);
    assert_eq!(
        pools.scope_of(&internet).unwrap().unwrap().0,
        Scope::INTERNET
    );
    assert_eq!(pools.kv_id(&env.key).unwrap(), Some(id));

    let stats = pools.stats().unwrap();
    assert_eq!((stats.mesh_count, stats.upload_count), (1, 1));
    assert_eq!(stats.blob_count, 2);

    // only the mesh blob is listed for mesh links, both for internet ones
    let (mesh_ids, _) = pools.ids_by_expiry_in(Scope::MESH, 0, None, 10).unwrap();
    assert_eq!(mesh_ids, vec![id]);
    let (all, _) = pools
        .ids_by_expiry_in(Scope::INTERNET, 0, None, 10)
        .unwrap();
    assert_eq!(all.len(), 2);

    // the bridge uploads it
    assert_eq!(pools.upload_pending(10).unwrap(), vec![id]);
    pools
        .update_scope(&[id], Scope::NONE, Scope::UPLOAD)
        .unwrap();
    assert!(pools.upload_pending(10).unwrap().is_empty());
    assert_eq!(pools.scope_of(&id).unwrap().unwrap().0, Scope::MESH);

    // the same blob arriving over the internet adds the flag and the longer retention
    assert!(matches!(
        pools.insert(env, src(3), NOW).unwrap(),
        InsertOutcome::AlreadyPresent { .. }
    ));
    assert_eq!(
        pools.scope_of(&id).unwrap().unwrap().0,
        Scope::MESH | Scope::INTERNET
    );
    let stats = pools.stats().unwrap();
    assert_eq!(stats.mesh_count, 0, "no longer mesh-only");
    // swept with the internet retention, not the mesh one
    assert!(pools
        .sweep_expired(NOW + 80 * HOUR, 100)
        .unwrap()
        .is_empty());
    assert!(pools.contains(&id).unwrap());
}

#[test]
fn mesh_only_blobs_expire_with_the_mesh_retention() {
    let (_d, pools) = open(|c| c);
    let id = inserted(
        &pools
            .insert(kv(&keypair(), NOW, b"m"), mesh(3), NOW)
            .unwrap(),
    );
    let other = inserted(
        &pools
            .insert(kv(&keypair(), NOW, b"i"), src(3), NOW)
            .unwrap(),
    );
    let swept = pools.sweep_expired(NOW + 73 * HOUR, 100).unwrap();
    assert_eq!(swept, vec![id]);
    assert!(pools.contains(&other).unwrap());
    let stats = pools.stats().unwrap();
    assert_eq!(stats.mesh_count, 0);
    assert_eq!(stats.mesh_bytes, 0);
    assert!(pools
        .ids_by_expiry_in(Scope::MESH, 0, None, 10)
        .unwrap()
        .0
        .is_empty());
}

#[test]
fn mesh_caps_evict_only_mesh_blobs_and_spare_uploads() {
    let (_d, pools) = open(|c| PoolsConfig {
        mesh_max_blob_count: 4,
        eviction_low_watermark: 1.0,
        ..c
    });
    let internet: Vec<_> = (0..5)
        .map(|n| {
            inserted(
                &pools
                    .insert(kv(&keypair(), NOW + n, b"i"), src(1), NOW)
                    .unwrap(),
            )
        })
        .collect();
    let upload = inserted(
        &pools
            .insert(
                kv(&keypair(), NOW, b"u"),
                mesh(1).with_scope(Scope::MESH | Scope::UPLOAD),
                NOW,
            )
            .unwrap(),
    );
    let plain: Vec<_> = (0..3)
        .map(|n| {
            inserted(
                &pools
                    .insert(kv(&keypair(), NOW + 1 + n, b"m"), mesh(1), NOW)
                    .unwrap(),
            )
        })
        .collect();
    // the fifth mesh blob pushes out the oldest plain mesh blob, not the upload one
    let fifth = inserted(
        &pools
            .insert(kv(&keypair(), NOW + 9, b"m"), mesh(1), NOW)
            .unwrap(),
    );
    assert!(!pools.contains(&plain[0]).unwrap());
    assert!(pools.contains(&upload).unwrap());
    assert!(pools.contains(&fifth).unwrap());
    for id in &internet {
        assert!(
            pools.contains(id).unwrap(),
            "internet blobs are never mesh-evicted"
        );
    }
    assert_eq!(pools.stats().unwrap().mesh_count, 4);

    // a mesh blob from a lower bucket cannot evict higher-bucket ones
    assert_eq!(
        pools
            .insert(kv(&keypair(), NOW, b"low"), mesh(0), NOW)
            .unwrap(),
        InsertOutcome::Rejected(RejectReason::PoolFull)
    );
}

#[test]
fn a_schema_1_file_is_upgraded_in_place() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("pools.redb");
    {
        let pools = Pools::open(PoolsConfig::default().with_path(&path)).unwrap();
        pools
            .insert(kv(&keypair(), NOW, b"x"), src(1), NOW)
            .unwrap();
    }
    {
        let db = redb::Database::open(&path).unwrap();
        let txn = db.begin_write().unwrap();
        txn.open_table(gossip_pools::schema::COUNTERS)
            .unwrap()
            .insert(gossip_pools::schema::COUNTER_SCHEMA_VERSION, &1u64)
            .unwrap();
        txn.commit().unwrap();
    }
    let pools = Pools::open(PoolsConfig::default().with_path(&path)).unwrap();
    assert_eq!(pools.stats().unwrap().blob_count, 1);
    drop(pools);
    let db = redb::Database::open(&path).unwrap();
    let txn = db.begin_read().unwrap();
    let v = txn
        .open_table(gossip_pools::schema::COUNTERS)
        .unwrap()
        .get(gossip_pools::schema::COUNTER_SCHEMA_VERSION)
        .unwrap()
        .unwrap()
        .value();
    assert_eq!(v, Pools::SCHEMA_VERSION);
}

#[test]
fn without_provenance_a_local_blob_and_a_relayed_one_are_stored_alike() {
    let (_d, pools) = open(|c| PoolsConfig {
        record_provenance: false,
        ..c
    });
    let kp = keypair();
    let local = inserted(
        &pools
            .insert(
                kv(&kp, NOW, b"a"),
                Source::local(4).with_scope(Scope::MESH),
                NOW,
            )
            .unwrap(),
    );
    let relayed = inserted(
        &pools
            .insert(kv(&keypair(), NOW, b"b"), mesh(4), NOW + 1234)
            .unwrap(),
    );
    let (mut a, b) = (
        pools.meta(&local).unwrap().unwrap(),
        pools.meta(&relayed).unwrap().unwrap(),
    );
    assert_eq!((b.received_at, b.source_peer.len()), (0, 0));
    a.index_key.clone_from(&b.index_key);
    assert_eq!(a, b);
    assert!(!pools.had_own_marks());
}
