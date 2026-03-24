//! End-to-end integration tests for secureStorage v2.

use secureStorage::storage::{BlockStorage, KeypairStorage, MemoryStorage};
use secureStorage::{
    PLAINTEXT_SIZE, SESSION_COUNT, SessionIndex, allocate_session, cover_traffic_tick,
    get_global_block_count, provision_storage, read_session_data, shrink_session_data,
    unlock_session, write_session_data,
};

const DOMAIN: &str = "e2e-test";

/// PQ crypto operations need large stack frames; run every test on a 4 MiB thread.
fn run<F: FnOnce() + Send + 'static>(f: F) {
    std::thread::Builder::new()
        .stack_size(4 * 1024 * 1024)
        .spawn(f)
        .unwrap()
        .join()
        .unwrap();
}

/// Scenario 1: Complete happy path.
#[test]
fn e2e_provision_allocate_write_read() {
    run(|| {
        let mut storage = MemoryStorage::new();
        provision_storage(&mut storage).unwrap();

        let slot = SessionIndex::new(0).unwrap();
        let mut session = allocate_session(&mut storage, DOMAIN, slot, b"alice").unwrap();

        write_session_data(&mut storage, DOMAIN, &mut session, 0, b"hello world").unwrap();

        let result = read_session_data(&storage, DOMAIN, &session, 0, 11).unwrap();
        assert_eq!(&*result, b"hello world");
    });
}

/// Scenario 2: Two independent sessions with different passwords.
#[test]
fn e2e_two_sessions_isolated() {
    run(|| {
        let mut storage = MemoryStorage::new();
        provision_storage(&mut storage).unwrap();

        let s0 = SessionIndex::new(0).unwrap();
        let s2 = SessionIndex::new(2).unwrap();

        let mut session_a = allocate_session(&mut storage, DOMAIN, s0, b"alice").unwrap();
        let mut session_b = allocate_session(&mut storage, DOMAIN, s2, b"bob").unwrap();

        write_session_data(&mut storage, DOMAIN, &mut session_a, 0, b"secret A").unwrap();
        write_session_data(&mut storage, DOMAIN, &mut session_b, 0, b"secret B").unwrap();

        // Re-unlock and verify isolation
        let unlocked_a = unlock_session(&storage, DOMAIN, b"alice").unwrap();
        let data_a = read_session_data(&storage, DOMAIN, &unlocked_a, 0, 8).unwrap();
        assert_eq!(&*data_a, b"secret A");

        let unlocked_b = unlock_session(&storage, DOMAIN, b"bob").unwrap();
        let data_b = read_session_data(&storage, DOMAIN, &unlocked_b, 0, 8).unwrap();
        assert_eq!(&*data_b, b"secret B");
    });
}

/// Scenario 3: Snapshot resistance — all sessions change at the same indices.
#[test]
fn e2e_snapshot_diff_indistinguishable() {
    run(|| {
        let mut storage = MemoryStorage::new();
        provision_storage(&mut storage).unwrap();

        let slot = SessionIndex::new(2).unwrap();
        let mut session = allocate_session(&mut storage, DOMAIN, slot, b"password").unwrap();

        // Write initial data to create blocks
        write_session_data(&mut storage, DOMAIN, &mut session, 0, b"initial data").unwrap();

        // Snapshot S1: record all block ciphertexts
        let block_count = get_global_block_count(&storage).unwrap();
        let mut snapshot_s1 = Vec::new();
        for i in 0..SESSION_COUNT as u8 {
            let s = SessionIndex::new(i).unwrap();
            let mut session_blocks = Vec::new();
            for b in 0..block_count {
                session_blocks.push(storage.read_block(s, b).unwrap());
            }
            snapshot_s1.push(session_blocks);
        }

        // Write new data (overwrites block 0)
        write_session_data(&mut storage, DOMAIN, &mut session, 0, b"updated data!").unwrap();

        // Snapshot S2: all sessions should have changed at block 0
        for (si, s1_blocks) in snapshot_s1.iter().enumerate() {
            let s = SessionIndex::new(si as u8).unwrap();
            let new_block = storage.read_block(s, 0).unwrap();
            assert_ne!(
                *new_block, *s1_blocks[0],
                "session {si} block 0 should have changed between snapshots"
            );
        }
    });
}

/// Scenario 4: Cover traffic preserves data.
#[test]
fn e2e_cover_traffic_preserves_data() {
    run(|| {
        let mut storage = MemoryStorage::new();
        provision_storage(&mut storage).unwrap();

        let slot = SessionIndex::new(0).unwrap();
        let mut session = allocate_session(&mut storage, DOMAIN, slot, b"pw").unwrap();

        let data = b"important data that must survive cover traffic";
        write_session_data(&mut storage, DOMAIN, &mut session, 0, data).unwrap();

        for _ in 0..20 {
            cover_traffic_tick(&mut storage, DOMAIN).unwrap();
        }

        let result = read_session_data(&storage, DOMAIN, &session, 0, data.len()).unwrap();
        assert_eq!(&*result, data);
    });
}

/// Scenario 5: Corruption heals on write.
#[test]
fn e2e_corruption_heals_on_write() {
    run(|| {
        let mut storage = MemoryStorage::new();
        provision_storage(&mut storage).unwrap();

        let slot = SessionIndex::new(0).unwrap();
        let mut session = allocate_session(&mut storage, DOMAIN, slot, b"pw").unwrap();

        write_session_data(&mut storage, DOMAIN, &mut session, 0, b"hello").unwrap();

        // Corrupt a block of another session (session 1, block 0)
        let s1 = SessionIndex::new(1).unwrap();
        let corrupted = Box::new([0xFF; secureStorage::BLOCK_SIZE]);
        storage.write_block(s1, 0, &corrupted).unwrap();

        // Write at the same block index — should heal the corrupted block via cover
        write_session_data(&mut storage, DOMAIN, &mut session, 0, b"world").unwrap();

        // Our data should still be readable
        let result = read_session_data(&storage, DOMAIN, &session, 0, 5).unwrap();
        assert_eq!(&*result, b"world");

        // Session 1's block should be a valid ciphertext (rerandomized or cover)
        let s1_block = storage.read_block(s1, 0).unwrap();
        assert_ne!(*s1_block, [0xFF; secureStorage::BLOCK_SIZE]);
    });
}

/// Scenario 6: Blockstreams always aligned.
#[test]
fn e2e_blockstreams_always_aligned() {
    run(|| {
        let mut storage = MemoryStorage::new();
        provision_storage(&mut storage).unwrap();

        let slot = SessionIndex::new(0).unwrap();
        let mut session = allocate_session(&mut storage, DOMAIN, slot, b"pw").unwrap();

        // Write increasing amounts of data
        for size in [10, 100, 1000, 5000] {
            let data: Vec<u8> = (0..size).map(|i| (i % 256) as u8).collect();
            write_session_data(&mut storage, DOMAIN, &mut session, 0, &data).unwrap();

            // Verify all sessions have the same block count
            let expected = get_global_block_count(&storage).unwrap();
            for i in 0..SESSION_COUNT as u8 {
                let s = SessionIndex::new(i).unwrap();
                assert_eq!(
                    storage.block_count(s).unwrap(),
                    expected,
                    "session {i} should have {expected} blocks"
                );
            }
        }
    });
}

/// Scenario 7: Wrong passwords never unlock.
#[test]
fn e2e_wrong_password_never_unlocks() {
    run(|| {
        let mut storage = MemoryStorage::new();
        provision_storage(&mut storage).unwrap();

        let slot = SessionIndex::new(0).unwrap();
        allocate_session(&mut storage, DOMAIN, slot, b"correct-password").unwrap();

        for i in 0..10u32 {
            let wrong = format!("wrong-password-{i}");
            assert!(
                unlock_session(&storage, DOMAIN, wrong.as_bytes()).is_err(),
                "password '{wrong}' should not unlock"
            );
        }
    });
}

/// Scenario 8: Multiple writes then full read-back.
#[test]
fn e2e_append_and_overwrite_pattern() {
    run(|| {
        let mut storage = MemoryStorage::new();
        provision_storage(&mut storage).unwrap();

        let slot = SessionIndex::new(3).unwrap();
        let mut session = allocate_session(&mut storage, DOMAIN, slot, b"pw").unwrap();

        // Append pattern
        write_session_data(&mut storage, DOMAIN, &mut session, 0, b"Hello").unwrap();
        write_session_data(&mut storage, DOMAIN, &mut session, 5, b", ").unwrap();
        write_session_data(&mut storage, DOMAIN, &mut session, 7, b"World!").unwrap();

        let result = read_session_data(&storage, DOMAIN, &session, 0, 13).unwrap();
        assert_eq!(&*result, b"Hello, World!");

        // Partial overwrite
        write_session_data(&mut storage, DOMAIN, &mut session, 7, b"Rust!").unwrap();

        let result = read_session_data(&storage, DOMAIN, &session, 0, 13).unwrap();
        assert_eq!(&*result, b"Hello, Rust!!");
    });
}

/// Scenario 9: Re-unlock after cover traffic still works.
#[test]
fn e2e_unlock_after_cover_traffic() {
    run(|| {
        let mut storage = MemoryStorage::new();
        provision_storage(&mut storage).unwrap();

        let slot = SessionIndex::new(1).unwrap();
        let mut session = allocate_session(&mut storage, DOMAIN, slot, b"secret").unwrap();

        write_session_data(&mut storage, DOMAIN, &mut session, 0, b"persistent").unwrap();
        drop(session);

        for _ in 0..50 {
            cover_traffic_tick(&mut storage, DOMAIN).unwrap();
        }

        // Re-unlock from scratch
        let session = unlock_session(&storage, DOMAIN, b"secret").unwrap();
        let result = read_session_data(&storage, DOMAIN, &session, 0, 10).unwrap();
        assert_eq!(&*result, b"persistent");
    });
}

/// Scenario 10: Shrink then read remaining data.
#[test]
fn e2e_shrink_then_read() {
    run(|| {
        let mut storage = MemoryStorage::new();
        provision_storage(&mut storage).unwrap();

        let slot = SessionIndex::new(0).unwrap();
        let mut session = allocate_session(&mut storage, DOMAIN, slot, b"pw").unwrap();

        let data: Vec<u8> = (0..200).map(|i| (i % 256) as u8).collect();
        write_session_data(&mut storage, DOMAIN, &mut session, 0, &data).unwrap();

        shrink_session_data(&mut storage, DOMAIN, &mut session, 100).unwrap();

        let result = read_session_data(&storage, DOMAIN, &session, 0, 100).unwrap();
        assert_eq!(&*result, &data[..100]);

        // Re-unlock and verify
        drop(session);
        let session = unlock_session(&storage, DOMAIN, b"pw").unwrap();
        assert_eq!(session.total_data_length, 100);
        let result = read_session_data(&storage, DOMAIN, &session, 0, 100).unwrap();
        assert_eq!(&*result, &data[..100]);
    });
}

/// Scenario 11: Shrink to zero, then re-write.
#[test]
fn e2e_shrink_to_zero_then_rewrite() {
    run(|| {
        let mut storage = MemoryStorage::new();
        provision_storage(&mut storage).unwrap();

        let slot = SessionIndex::new(1).unwrap();
        let mut session = allocate_session(&mut storage, DOMAIN, slot, b"pw").unwrap();

        write_session_data(&mut storage, DOMAIN, &mut session, 0, b"first").unwrap();
        shrink_session_data(&mut storage, DOMAIN, &mut session, 0).unwrap();
        assert_eq!(session.total_data_length, 0);

        write_session_data(&mut storage, DOMAIN, &mut session, 0, b"second").unwrap();

        let result = read_session_data(&storage, DOMAIN, &session, 0, 6).unwrap();
        assert_eq!(&*result, b"second");
    });
}

/// Scenario 12: Shrink survives cover traffic and re-unlock.
#[test]
fn e2e_shrink_cover_traffic_relock() {
    run(|| {
        let mut storage = MemoryStorage::new();
        provision_storage(&mut storage).unwrap();

        let slot = SessionIndex::new(2).unwrap();
        let mut session = allocate_session(&mut storage, DOMAIN, slot, b"pw").unwrap();

        let data: Vec<u8> = (0..300).map(|i| (i % 256) as u8).collect();
        write_session_data(&mut storage, DOMAIN, &mut session, 0, &data).unwrap();
        shrink_session_data(&mut storage, DOMAIN, &mut session, 150).unwrap();
        drop(session);

        for _ in 0..20 {
            cover_traffic_tick(&mut storage, DOMAIN).unwrap();
        }

        let session = unlock_session(&storage, DOMAIN, b"pw").unwrap();
        assert_eq!(session.total_data_length, 150);
        let result = read_session_data(&storage, DOMAIN, &session, 0, 150).unwrap();
        assert_eq!(&*result, &data[..150]);
    });
}

/// Scenario 13: Cross-block write and read with byte-level verification.
#[test]
fn e2e_cross_block_write_read() {
    run(|| {
        let mut storage = MemoryStorage::new();
        provision_storage(&mut storage).unwrap();

        let slot = SessionIndex::new(0).unwrap();
        let mut session = allocate_session(&mut storage, DOMAIN, slot, b"pw").unwrap();

        let data_len = PLAINTEXT_SIZE * 3;
        let data: Vec<u8> = (0..data_len).map(|i| (i % 256) as u8).collect();
        write_session_data(&mut storage, DOMAIN, &mut session, 0, &data).unwrap();

        let result = read_session_data(&storage, DOMAIN, &session, 0, data_len).unwrap();
        assert_eq!(&*result, &data);

        // Re-unlock and verify
        drop(session);
        let session = unlock_session(&storage, DOMAIN, b"pw").unwrap();
        let result = read_session_data(&storage, DOMAIN, &session, 0, data_len).unwrap();
        assert_eq!(&*result, &data);
    });
}

/// Scenario 14: Interleaved writes and cover traffic from two sessions.
#[test]
fn e2e_interleaved_writes_and_cover() {
    run(|| {
        let mut storage = MemoryStorage::new();
        provision_storage(&mut storage).unwrap();

        let s0 = SessionIndex::new(0).unwrap();
        let s3 = SessionIndex::new(3).unwrap();
        let mut sess_a = allocate_session(&mut storage, DOMAIN, s0, b"alice").unwrap();
        let mut sess_b = allocate_session(&mut storage, DOMAIN, s3, b"bob").unwrap();

        write_session_data(&mut storage, DOMAIN, &mut sess_a, 0, b"A-data-1").unwrap();
        for _ in 0..5 {
            cover_traffic_tick(&mut storage, DOMAIN).unwrap();
        }
        write_session_data(&mut storage, DOMAIN, &mut sess_b, 0, b"B-data-1").unwrap();
        for _ in 0..5 {
            cover_traffic_tick(&mut storage, DOMAIN).unwrap();
        }
        write_session_data(&mut storage, DOMAIN, &mut sess_a, 8, b"-more").unwrap();
        for _ in 0..5 {
            cover_traffic_tick(&mut storage, DOMAIN).unwrap();
        }

        // Re-unlock both and verify
        drop(sess_a);
        drop(sess_b);
        let ua = unlock_session(&storage, DOMAIN, b"alice").unwrap();
        let ub = unlock_session(&storage, DOMAIN, b"bob").unwrap();

        let ra = read_session_data(&storage, DOMAIN, &ua, 0, 13).unwrap();
        assert_eq!(&*ra, b"A-data-1-more");

        let rb = read_session_data(&storage, DOMAIN, &ub, 0, 8).unwrap();
        assert_eq!(&*rb, b"B-data-1");
    });
}

/// Scenario 15: Cover traffic changes blocks across all sessions.
#[test]
fn e2e_cover_traffic_snapshot_resistance() {
    run(|| {
        let mut storage = MemoryStorage::new();
        provision_storage(&mut storage).unwrap();

        let slot = SessionIndex::new(0).unwrap();
        let mut session = allocate_session(&mut storage, DOMAIN, slot, b"pw").unwrap();
        write_session_data(&mut storage, DOMAIN, &mut session, 0, b"data").unwrap();

        // Snapshot before cover traffic
        let mut before = Vec::new();
        for i in 0..SESSION_COUNT as u8 {
            let s = SessionIndex::new(i).unwrap();
            before.push(storage.read_block(s, 0).unwrap());
        }

        // Run enough ticks — with only 1 block, every tick hits block 0
        for _ in 0..10 {
            cover_traffic_tick(&mut storage, DOMAIN).unwrap();
        }

        // All sessions should have changed at block 0
        for i in 0..SESSION_COUNT as u8 {
            let s = SessionIndex::new(i).unwrap();
            let after = storage.read_block(s, 0).unwrap();
            assert_ne!(
                *after, *before[i as usize],
                "session {i} block 0 should change after cover traffic"
            );
        }
    });
}

/// Scenario 16: Allocated-but-unused session survives another session's writes + cover traffic.
#[test]
fn e2e_unused_session_survives_other_writes() {
    run(|| {
        let mut storage = MemoryStorage::new();
        provision_storage(&mut storage).unwrap();

        let s0 = SessionIndex::new(0).unwrap();
        let s2 = SessionIndex::new(2).unwrap();
        let mut sess_a = allocate_session(&mut storage, DOMAIN, s0, b"alice").unwrap();
        allocate_session(&mut storage, DOMAIN, s2, b"bob").unwrap();

        // Only session A writes
        write_session_data(&mut storage, DOMAIN, &mut sess_a, 0, &[0xAB; 500]).unwrap();

        for _ in 0..20 {
            cover_traffic_tick(&mut storage, DOMAIN).unwrap();
        }

        // Session B (never wrote) must still unlock with length 0
        let ub = unlock_session(&storage, DOMAIN, b"bob").unwrap();
        assert_eq!(ub.total_data_length, 0);

        // Session A's data must be intact
        let ua = unlock_session(&storage, DOMAIN, b"alice").unwrap();
        let ra = read_session_data(&storage, DOMAIN, &ua, 0, 500).unwrap();
        assert_eq!(&*ra, &[0xAB; 500]);
    });
}

// --- Plausible deniability & security ---

/// Scenario 17: Provisioned and allocated keypair files must have identical sizes.
///
/// This is the key plausible deniability invariant: an observer with disk
/// access cannot distinguish provisioned (dummy) slots from allocated (real)
/// slots by file size alone.
#[test]
fn e2e_keypair_file_sizes_indistinguishable() {
    run(|| {
        let mut storage = MemoryStorage::new();
        provision_storage(&mut storage).unwrap();

        let provisioned_size = storage
            .read_keypair(SessionIndex::new(0).unwrap())
            .unwrap()
            .len();

        // Allocate one slot
        let slot = SessionIndex::new(2).unwrap();
        allocate_session(&mut storage, DOMAIN, slot, b"pw").unwrap();

        // All keypair files must have the same size
        for i in 0..SESSION_COUNT as u8 {
            let s = SessionIndex::new(i).unwrap();
            let size = storage.read_keypair(s).unwrap().len();
            assert_eq!(
                size, provisioned_size,
                "session {i} keypair file size differs — breaks plausible deniability"
            );
        }
    });
}

/// Scenario 18: Re-allocating a slot invalidates the old password.
#[test]
fn e2e_reallocate_slot_invalidates_old_password() {
    run(|| {
        let mut storage = MemoryStorage::new();
        provision_storage(&mut storage).unwrap();

        let slot = SessionIndex::new(0).unwrap();
        let mut sess = allocate_session(&mut storage, DOMAIN, slot, b"old-pw").unwrap();
        write_session_data(&mut storage, DOMAIN, &mut sess, 0, b"secret").unwrap();

        // Re-allocate same slot with new password
        allocate_session(&mut storage, DOMAIN, slot, b"new-pw").unwrap();

        // Old password must fail
        assert!(unlock_session(&storage, DOMAIN, b"old-pw").is_err());

        // New password works, but old data is gone
        let new_sess = unlock_session(&storage, DOMAIN, b"new-pw").unwrap();
        assert_eq!(new_sess.total_data_length, 0);
    });
}

// --- Robustness ---

/// Scenario 19: Shrink then grow past the original size.
///
/// Freed blocks (now cover) must be correctly overwritten with genuine data.
#[test]
fn e2e_shrink_then_grow_past_original() {
    run(|| {
        let mut storage = MemoryStorage::new();
        provision_storage(&mut storage).unwrap();

        let slot = SessionIndex::new(0).unwrap();
        let mut session = allocate_session(&mut storage, DOMAIN, slot, b"pw").unwrap();

        write_session_data(&mut storage, DOMAIN, &mut session, 0, &[0xAA; 200]).unwrap();
        shrink_session_data(&mut storage, DOMAIN, &mut session, 50).unwrap();

        // Grow past original 200 bytes
        let big_data: Vec<u8> = (0..500).map(|i| (i % 256) as u8).collect();
        write_session_data(&mut storage, DOMAIN, &mut session, 0, &big_data).unwrap();

        let result = read_session_data(&storage, DOMAIN, &session, 0, 500).unwrap();
        assert_eq!(&*result, &big_data);
    });
}

/// Scenario 20: All SESSION_COUNT slots allocated and independently readable.
#[test]
fn e2e_all_slots_allocated() {
    run(|| {
        let mut storage = MemoryStorage::new();
        provision_storage(&mut storage).unwrap();

        let passwords: Vec<Vec<u8>> = (0..SESSION_COUNT)
            .map(|i| format!("password-{i}").into_bytes())
            .collect();

        for i in 0..SESSION_COUNT as u8 {
            let slot = SessionIndex::new(i).unwrap();
            let mut sess =
                allocate_session(&mut storage, DOMAIN, slot, &passwords[i as usize]).unwrap();
            let tag = format!("data-from-session-{i}");
            write_session_data(&mut storage, DOMAIN, &mut sess, 0, tag.as_bytes()).unwrap();
        }

        for i in 0..SESSION_COUNT as u8 {
            let sess = unlock_session(&storage, DOMAIN, &passwords[i as usize]).unwrap();
            assert_eq!(sess.session_index.as_u8(), i);
            let expected = format!("data-from-session-{i}");
            let result =
                read_session_data(&storage, DOMAIN, &sess, 0, expected.len()).unwrap();
            assert_eq!(&*result, expected.as_bytes());
        }
    });
}

/// Scenario 21: Cover traffic eventually touches all sessions.
///
/// The existing test (scenario 15) checks "all changed" after 10 ticks,
/// but this uses 50 ticks to be statistically robust — with 1 block and
/// 5 sessions, each tick rerandomizes ALL sessions, so even 1 tick suffices.
/// We verify no session is ever skipped.
#[test]
fn e2e_cover_traffic_touches_all_sessions() {
    run(|| {
        let mut storage = MemoryStorage::new();
        provision_storage(&mut storage).unwrap();

        let slot = SessionIndex::new(0).unwrap();
        let mut session = allocate_session(&mut storage, DOMAIN, slot, b"pw").unwrap();
        write_session_data(&mut storage, DOMAIN, &mut session, 0, b"x").unwrap();

        let mut before = Vec::new();
        for i in 0..SESSION_COUNT as u8 {
            let s = SessionIndex::new(i).unwrap();
            before.push(storage.read_block(s, 0).unwrap());
        }

        for _ in 0..50 {
            cover_traffic_tick(&mut storage, DOMAIN).unwrap();
        }

        for i in 0..SESSION_COUNT as u8 {
            let s = SessionIndex::new(i).unwrap();
            let after = storage.read_block(s, 0).unwrap();
            assert_ne!(
                *after, *before[i as usize],
                "session {i} was never touched by cover traffic"
            );
        }
    });
}

// ── WAL crash recovery simulation tests ──────────────────────────────
//
// These test the WAL module's crash recovery logic by simulating the
// three-phase flush protocol at the MemoryStorage level. We manually
// build WAL entries, serialize them, simulate a "crash" by dropping
// state, then replay the WAL onto fresh storage.

use secureStorage::wal::Wal;
use secureStorage::constants::BLOCK_SIZE;

/// Helper: export all blocks+keypairs from storage into a flat snapshot
/// that can be loaded into fresh MemoryStorage.
fn snapshot_storage(storage: &MemoryStorage) -> (Vec<Vec<u8>>, Vec<Vec<u8>>) {
    let mut blocks = Vec::with_capacity(SESSION_COUNT);
    let mut keypairs = Vec::with_capacity(SESSION_COUNT);
    for i in 0..SESSION_COUNT as u8 {
        let idx = SessionIndex::new(i).unwrap();
        blocks.push(storage.export_blocks(idx));
        keypairs.push(storage.export_keypair(idx).to_vec());
    }
    (blocks, keypairs)
}

/// Helper: import a snapshot into fresh MemoryStorage.
fn restore_storage(blocks: &[Vec<u8>], keypairs: &[Vec<u8>]) -> MemoryStorage {
    let mut storage = MemoryStorage::new();
    for i in 0..SESSION_COUNT as u8 {
        let idx = SessionIndex::new(i).unwrap();
        if !blocks[i as usize].is_empty() {
            storage.import_blocks(idx, &blocks[i as usize]).unwrap();
        }
        if !keypairs[i as usize].is_empty() {
            storage.import_keypair(idx, &keypairs[i as usize]);
        }
    }
    storage
}

/// Crash scenario A: WAL written to "disk" but DB not updated.
/// Recovery should replay all WAL entries and restore the data.
#[test]
fn e2e_wal_crash_after_wal_write_before_db_apply() {
    run(|| {
        let mut storage = MemoryStorage::new();
        provision_storage(&mut storage).unwrap();

        let slot = SessionIndex::new(0).unwrap();
        let mut session = allocate_session(&mut storage, DOMAIN, slot, b"crash-test-a").unwrap();

        // Write some data
        let data = vec![0xAA; 5000];
        write_session_data(&mut storage, DOMAIN, &mut session, 0, &data).unwrap();

        // Snapshot the DB state BEFORE we write more data
        let (pre_blocks, pre_keypairs) = snapshot_storage(&storage);

        // Write more data (this is the transaction that will "crash")
        let data2 = vec![0xBB; 3000];
        write_session_data(&mut storage, DOMAIN, &mut session, 5000, &data2).unwrap();

        // Build WAL entries: the diff between pre and post storage
        let (post_blocks, _) = snapshot_storage(&storage);
        let mut wal = Wal::new();
        for i in 0..SESSION_COUNT as u8 {
            let idx = SessionIndex::new(i).unwrap();
            let pre_count = pre_blocks[i as usize].len() / BLOCK_SIZE;
            let post_count = post_blocks[i as usize].len() / BLOCK_SIZE;
            for b in 0..post_count {
                let offset = b * BLOCK_SIZE;
                let post_block = &post_blocks[i as usize][offset..offset + BLOCK_SIZE];
                if b >= pre_count
                    || &pre_blocks[i as usize][offset..offset + BLOCK_SIZE] != post_block
                {
                    wal.record_write(
                        (i as u64) * 1_000_000 + b as u64 * BLOCK_SIZE as u64,
                        post_block,
                    );
                }
            }
        }

        // Serialize WAL (this is the "WAL on disk" state)
        let wal_bytes = wal.to_bytes();
        assert!(!wal_bytes.is_empty(), "WAL should have entries");

        // SIMULATE CRASH: restore from pre-crash snapshot (DB not updated)
        let mut recovered = restore_storage(&pre_blocks, &pre_keypairs);

        // Replay WAL entries
        let entries = Wal::parse_wal_bytes(&wal_bytes);
        assert!(!entries.is_empty(), "WAL should parse valid entries");

        // Apply entries to recovered storage
        for entry in &entries {
            // Decode session index and block from our encoding
            let session_idx = (entry.file_offset / 1_000_000) as u8;
            let block_offset = entry.file_offset % 1_000_000;
            let block_idx = block_offset / BLOCK_SIZE as u64;
            let idx = SessionIndex::new(session_idx).unwrap();

            // Ensure block count covers this block
            while recovered.block_count(idx).unwrap() <= block_idx {
                let empty = [0u8; BLOCK_SIZE];
                recovered.append_block(idx, &empty).unwrap();
            }

            let block_arr: &[u8; BLOCK_SIZE] = entry.payload.as_slice().try_into().unwrap();
            recovered.write_block(idx, block_idx, block_arr).unwrap();
        }

        // Verify: unlock should work and data should be complete
        let unlocked = unlock_session(&recovered, DOMAIN, b"crash-test-a").unwrap();
        assert_eq!(unlocked.total_data_length, 8000);
        let read_back = read_session_data(&recovered, DOMAIN, &unlocked, 0, 8000).unwrap();
        assert_eq!(&read_back[..5000], &vec![0xAA; 5000][..]);
        assert_eq!(&read_back[5000..], &vec![0xBB; 3000][..]);
    });
}

/// Crash scenario B: WAL truncated mid-write (partial WAL on disk).
/// Recovery should replay only the valid prefix.
#[test]
fn e2e_wal_truncated_mid_write() {
    run(|| {
        let mut wal = Wal::new();
        let block1 = vec![0x11; BLOCK_SIZE];
        let block2 = vec![0x22; BLOCK_SIZE];
        let block3 = vec![0x33; BLOCK_SIZE];
        wal.record_write(0, &block1);
        wal.record_write(BLOCK_SIZE as u64, &block2);
        wal.record_write(2 * BLOCK_SIZE as u64, &block3);

        let mut bytes = wal.to_bytes();
        // Truncate mid-way through entry 3
        let entry3_start = 2 * (24 + BLOCK_SIZE);
        bytes.truncate(entry3_start + 100); // partial entry 3

        let parsed = Wal::parse_wal_bytes(&bytes);
        assert_eq!(parsed.len(), 2, "only first 2 entries should survive");
        assert_eq!(parsed[0].payload, block1);
        assert_eq!(parsed[1].payload, block2);
    });
}

/// Crash scenario C: CRC corruption in middle of WAL.
/// Entries before corruption are valid, rest discarded.
#[test]
fn e2e_wal_crc_corruption_mid_file() {
    run(|| {
        let mut wal = Wal::new();
        let block1 = vec![0x11; BLOCK_SIZE];
        let block2 = vec![0x22; BLOCK_SIZE];
        let block3 = vec![0x33; BLOCK_SIZE];
        wal.record_write(0, &block1);
        wal.record_write(BLOCK_SIZE as u64, &block2);
        wal.record_write(2 * BLOCK_SIZE as u64, &block3);

        let mut bytes = wal.to_bytes();
        // Corrupt a byte in entry 2's payload
        let entry2_payload_start = 24 + BLOCK_SIZE + 20; // after entry1 + header2
        bytes[entry2_payload_start + 50] ^= 0xFF;

        let parsed = Wal::parse_wal_bytes(&bytes);
        assert_eq!(parsed.len(), 1, "only first entry before corruption");
        assert_eq!(parsed[0].payload, block1);
    });
}

/// Idempotency: replaying the same WAL twice produces identical state.
#[test]
fn e2e_wal_replay_idempotent() {
    run(|| {
        let mut wal = Wal::new();
        let block = vec![0xAA; BLOCK_SIZE];
        wal.record_write(0, &block);
        wal.record_write(BLOCK_SIZE as u64, &block);
        let bytes = wal.to_bytes();

        let entries = Wal::parse_wal_bytes(&bytes);

        // Apply twice to same storage
        let mut storage = MemoryStorage::new();
        let idx = SessionIndex::new(0).unwrap();

        for _ in 0..2 {
            for entry in &entries {
                let block_idx = entry.file_offset / BLOCK_SIZE as u64;
                while storage.block_count(idx).unwrap() <= block_idx {
                    let empty = [0u8; BLOCK_SIZE];
                    storage.append_block(idx, &empty).unwrap();
                }
                let arr: &[u8; BLOCK_SIZE] = entry.payload.as_slice().try_into().unwrap();
                storage.write_block(idx, block_idx, arr).unwrap();
            }
        }

        assert_eq!(storage.block_count(idx).unwrap(), 2);
        let b0 = storage.read_block(idx, 0).unwrap();
        let expected: &[u8; BLOCK_SIZE] = block.as_slice().try_into().unwrap();
        assert_eq!(&*b0, expected);
    });
}

/// Empty WAL: recovery is a no-op.
#[test]
fn e2e_wal_empty_recovery() {
    run(|| {
        let parsed = Wal::parse_wal_bytes(&[]);
        assert!(parsed.is_empty());

        // Fresh storage should be unaffected
        let storage = MemoryStorage::new();
        let idx = SessionIndex::new(0).unwrap();
        assert_eq!(storage.block_count(idx).unwrap(), 0);
    });
}
