//! Throughput measurement. Run with:
//! `cargo test -p gossip-pools --release --test throughput -- --ignored --nocapture`
mod common;

use std::time::Instant;

use common::*;
use gossip_pools::{now_ms, PoolsConfig, Source};

fn rate(n: usize, started: Instant) -> String {
    let secs = started.elapsed().as_secs_f64();
    format!("{n} blobs in {secs:.2} s = {:.0} blobs/s", n as f64 / secs)
}

#[test]
#[ignore = "throughput measurement; run with --ignored --nocapture"]
fn insert_100k_small_blobs() {
    let now = now_ms();
    let total = 100_000usize;
    let batch = 1_000usize;

    // 1. Batched, fsync per batch (the network path).
    let (_d, p) = open(|c| c);
    let started = Instant::now();
    for b in 0..total / batch {
        let items: Vec<_> = (0..batch)
            .map(|i| {
                let n = (b * batch + i) as u64;
                let mut payload = vec![0u8; 64];
                payload[..8].copy_from_slice(&n.to_le_bytes());
                (bulletin(now, payload), Source::local(3))
            })
            .collect();
        let out = p.insert_many_prevalidated(items, now).unwrap();
        assert!(out.iter().all(|o| o.is_inserted()));
    }
    println!(
        "batched insert_many_prevalidated (batch {batch}, fsync): {}",
        rate(total, started)
    );
    let s = p.stats().unwrap();
    assert_eq!(s.blob_count, total as u64);
    let started = Instant::now();
    let page = p.bulletin_after(0, total).unwrap();
    assert_eq!(page.len(), total);
    println!("bulletin_after full scan: {}", rate(total, started));
    let started = Instant::now();
    let mut cursor = None;
    let mut seen = 0;
    loop {
        let (ids, next) = p.ids_by_expiry(0, cursor, 5_000).unwrap();
        seen += ids.len();
        match next {
            Some(c) => cursor = Some(c),
            None => break,
        }
    }
    assert_eq!(seen, total);
    println!("ids_by_expiry full paging: {}", rate(total, started));
    let started = Instant::now();
    let removed = p
        .sweep_expired(now + p.config().retention_ms, total)
        .unwrap();
    assert_eq!(removed.len(), total);
    println!("sweep_expired all: {}", rate(total, started));

    // 2. One transaction per insert, fsync each (the HTTP client path).
    let single = 5_000usize;
    let (_d2, p) = open(|c| c);
    let started = Instant::now();
    for n in 0..single as u64 {
        assert!(p
            .insert(bulletin(now, n.to_le_bytes()), Source::local(3), now)
            .unwrap()
            .is_inserted());
    }
    println!("single insert (fsync each): {}", rate(single, started));

    // 3. One transaction per insert, no fsync.
    let single = 20_000usize;
    let (_d3, p) = open(|c| PoolsConfig {
        sync_writes: false,
        ..c
    });
    let started = Instant::now();
    for n in 0..single as u64 {
        assert!(p
            .insert(bulletin(now, n.to_le_bytes()), Source::local(3), now)
            .unwrap()
            .is_inserted());
    }
    println!("single insert (no fsync): {}", rate(single, started));
}
