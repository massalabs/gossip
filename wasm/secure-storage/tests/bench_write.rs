//! Micro-benchmark for the write path.
//!
//! Profiles individual layers: PQ keygen, PQ encrypt, PQ rerand,
//! full write_session_data (with snapshot resistance).
//!
//! Run with: cargo test --release --features native -p secureStorage -- --ignored --nocapture --test-threads=1

use std::time::Instant;

use secureStorage::constants::{BLOCK_SIZE, PLAINTEXT_SIZE, SESSION_COUNT};
use secureStorage::storage::MemoryStorage;
use secureStorage::{
    SessionIndex, allocate_session, pq_decrypt, pq_encrypt, pq_keygen, pq_rerand,
    provision_storage, write_session_data,
};

const DOMAIN: &str = "bench";

fn run<F: FnOnce() + Send + 'static>(f: F) {
    std::thread::Builder::new()
        .stack_size(8 * 1024 * 1024)
        .spawn(f)
        .unwrap()
        .join()
        .unwrap();
}

/// Bench raw PQ operations (keygen, encrypt, rerand, decrypt).
#[test]
#[ignore]
fn bench_pq_primitives() {
    run(|| {
        const N: usize = 10;

        // --- keygen ---
        let t = Instant::now();
        let mut keys = Vec::with_capacity(N);
        for _ in 0..N {
            keys.push(pq_keygen());
        }
        let keygen_us = t.elapsed().as_micros() / N as u128;

        // --- encrypt ---
        let msg = [0u8; secureStorage::PQ_MSG_SIZE];
        let t = Instant::now();
        let mut cts = Vec::with_capacity(N);
        for i in 0..N {
            cts.push(pq_encrypt(&keys[i].0, &msg));
        }
        let encrypt_us = t.elapsed().as_micros() / N as u128;

        // --- rerand ---
        let t = Instant::now();
        for i in 0..N {
            let ct_arr: &[u8; BLOCK_SIZE] = cts[i].as_slice().try_into().unwrap();
            let _ = pq_rerand(&keys[i].0, ct_arr);
        }
        let rerand_us = t.elapsed().as_micros() / N as u128;

        // --- decrypt ---
        let t = Instant::now();
        for i in 0..N {
            let ct_arr: &[u8; BLOCK_SIZE] = cts[i].as_slice().try_into().unwrap();
            let _ = pq_decrypt(&keys[i].1, ct_arr);
        }
        let decrypt_us = t.elapsed().as_micros() / N as u128;

        eprintln!();
        eprintln!("=== PQ Primitives (avg of {N}, --release) ===");
        eprintln!("  pq_keygen:  {:>8} µs", keygen_us);
        eprintln!("  pq_encrypt: {:>8} µs", encrypt_us);
        eprintln!("  pq_rerand:  {:>8} µs", rerand_us);
        eprintln!("  pq_decrypt: {:>8} µs", decrypt_us);
        eprintln!();
        eprintln!("  Per-block cost (1 encrypt + 4 rerand): {:>8} µs",
            encrypt_us + 4 * rerand_us);
    });
}

/// Bench thread spawn/join overhead.
#[test]
#[ignore]
fn bench_thread_overhead() {
    run(|| {
        const N: usize = 20;
        let t = Instant::now();
        for _ in 0..N {
            let mut handles = Vec::with_capacity(4);
            for _ in 0..4 {
                handles.push(
                    std::thread::Builder::new()
                        .stack_size(4 * 1024 * 1024)
                        .spawn(|| { /* no-op */ })
                        .unwrap()
                );
            }
            for h in handles {
                h.join().unwrap();
            }
        }
        let avg = t.elapsed().as_micros() / N as u128;
        eprintln!();
        eprintln!("=== Thread Overhead (spawn 4 + join, avg of {N}) ===");
        eprintln!("  4 threads spawn+join: {:>8} µs", avg);
    });
}

/// Bench PqPublicKey serialization/deserialization overhead.
#[test]
#[ignore]
fn bench_pk_serde() {
    run(|| {
        const N: usize = 20;
        let (pk, _sk) = pq_keygen();
        let bytes = pk.to_bytes();

        let t = Instant::now();
        for _ in 0..N {
            let _ = secureStorage::PqPublicKey::from_bytes(&bytes).unwrap();
        }
        let from_bytes_us = t.elapsed().as_micros() / N as u128;

        let t = Instant::now();
        for _ in 0..N {
            let _ = pk.to_bytes();
        }
        let to_bytes_us = t.elapsed().as_micros() / N as u128;

        eprintln!();
        eprintln!("=== PK Serialization (avg of {N}) ===");
        eprintln!("  PqPublicKey::from_bytes: {:>8} µs", from_bytes_us);
        eprintln!("  PqPublicKey::to_bytes:   {:>8} µs", to_bytes_us);
        eprintln!("  Per-block overhead (5× from_bytes): {:>8} µs", 5 * from_bytes_us);
    });
}

/// Bench the full write path: provision → allocate → write_session_data.
/// Breaks down first write (block alloc) vs overwrites.
#[test]
#[ignore]
fn bench_write_session_data_breakdown() {
    run(|| {
        let mut storage = MemoryStorage::new();

        // --- provision ---
        let t = Instant::now();
        provision_storage(&mut storage).unwrap();
        let provision_us = t.elapsed().as_micros();

        // --- allocate ---
        let slot = SessionIndex::new(0).unwrap();
        let t = Instant::now();
        let mut session = allocate_session(&mut storage, DOMAIN, slot, b"password").unwrap();
        let allocate_us = t.elapsed().as_micros();

        // --- first write (creates block 0 for all 5 sessions) ---
        let small_data = vec![0xAB; 100];
        let t = Instant::now();
        write_session_data(&mut storage, DOMAIN, &mut session, 0, &small_data).unwrap();
        let first_write_us = t.elapsed().as_micros();

        // --- overwrite same block (no allocation, 1 block) ---
        const OVERWRITES: usize = 10;
        let mut overwrite_times = Vec::with_capacity(OVERWRITES);
        for i in 0..OVERWRITES {
            let data = vec![(i & 0xFF) as u8; 100];
            let t = Instant::now();
            write_session_data(&mut storage, DOMAIN, &mut session, 0, &data).unwrap();
            overwrite_times.push(t.elapsed().as_micros());
        }
        let overwrite_avg = overwrite_times.iter().sum::<u128>() / OVERWRITES as u128;
        let overwrite_min = *overwrite_times.iter().min().unwrap();
        let overwrite_max = *overwrite_times.iter().max().unwrap();

        // --- multi-block write ---
        let big_data: Vec<u8> = (0..PLAINTEXT_SIZE * 3).map(|i| (i & 0xFF) as u8).collect();
        let t = Instant::now();
        write_session_data(&mut storage, DOMAIN, &mut session, 0, &big_data).unwrap();
        let multiblock_us = t.elapsed().as_micros();

        eprintln!();
        eprintln!("=== write_session_data (MemoryStorage, --release) ===");
        eprintln!("  provision ({SESSION_COUNT} keypairs): {:>8} µs", provision_us);
        eprintln!("  allocate (keygen + kdf):              {:>8} µs", allocate_us);
        eprintln!("  first write (100B, alloc blocks):     {:>8} µs", first_write_us);
        eprintln!("  overwrite 1 block (n={OVERWRITES}):");
        eprintln!("    avg: {:>8} µs", overwrite_avg);
        eprintln!("    min: {:>8} µs", overwrite_min);
        eprintln!("    max: {:>8} µs", overwrite_max);
        eprintln!("  3-block write ({}B):              {:>8} µs", big_data.len(), multiblock_us);
        eprintln!();
        eprintln!("  Overwrite 1 block = {SESSION_COUNT} PQ ops (1 encrypt + {} rerand)", SESSION_COUNT - 1);
        eprintln!("  3-block write = 3× that + decrypt for read-modify-write");
    });
}

/// Bench rayon thread count impact on multi-block writes.
/// Tests 1,2,3,4,6,8 threads on a 4-block write (simulates session persist).
#[test]
#[ignore]
fn bench_rayon_thread_scaling() {
    run(|| {
        let thread_counts = [1, 2, 3, 4, 6, 8];
        let blocks = 4; // ~30KB session persist
        let data: Vec<u8> = (0..PLAINTEXT_SIZE * blocks).map(|i| (i & 0xFF) as u8).collect();
        const ROUNDS: usize = 5;

        eprintln!();
        eprintln!("=== Rayon Thread Scaling ({blocks} blocks × {SESSION_COUNT} sessions = {} PQ jobs, avg of {ROUNDS}) ===",
            blocks * SESSION_COUNT);

        for &threads in &thread_counts {
            // Build a custom rayon pool for this test.
            let pool = rayon::ThreadPoolBuilder::new()
                .stack_size(4 * 1024 * 1024)
                .num_threads(threads)
                .build()
                .unwrap();

            let mut times = Vec::with_capacity(ROUNDS);
            for _ in 0..ROUNDS {
                let mut storage = MemoryStorage::new();
                provision_storage(&mut storage).unwrap();
                let slot = SessionIndex::new(0).unwrap();
                let mut session = allocate_session(&mut storage, DOMAIN, slot, b"password").unwrap();

                // Warm up: first write creates blocks
                write_session_data(&mut storage, DOMAIN, &mut session, 0, &data).unwrap();

                // Bench overwrite (no block alloc)
                let t = Instant::now();
                pool.install(|| {
                    write_session_data(&mut storage, DOMAIN, &mut session, 0, &data).unwrap();
                });
                times.push(t.elapsed().as_micros());
            }

            let avg = times.iter().sum::<u128>() / ROUNDS as u128;
            let min = *times.iter().min().unwrap();
            let max = *times.iter().max().unwrap();
            eprintln!("  {threads:>2} threads: avg={avg:>8}µs  min={min:>8}µs  max={max:>8}µs");
        }
    });
}
