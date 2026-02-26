//! End-to-end integration tests for bordercrypt v2.

use bordercrypt::storage::{BlockStorage, MemoryStorage};
use bordercrypt::{
    PLAINTEXT_SIZE, SESSION_COUNT, SessionIndex, allocate_session, cover_traffic_tick,
    get_global_block_count, provision_storage, read_session_data, shrink_session_data,
    unlock_session, write_session_data,
};

const DOMAIN: &str = "e2e-test";

/// Scenario 1: Complete happy path.
#[test]
fn e2e_provision_allocate_write_read() {
    let mut storage = MemoryStorage::new();
    provision_storage(&mut storage).unwrap();

    let slot = SessionIndex::new(0).unwrap();
    let mut session = allocate_session(&mut storage, DOMAIN, slot, b"alice").unwrap();

    write_session_data(&mut storage, DOMAIN, &mut session, 0, b"hello world").unwrap();

    let result = read_session_data(&storage, DOMAIN, &session, 0, 11).unwrap();
    assert_eq!(&*result, b"hello world");
}

/// Scenario 2: Two independent sessions with different passwords.
#[test]
fn e2e_two_sessions_isolated() {
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
}

/// Scenario 3: Snapshot resistance — all sessions change at the same indices.
#[test]
fn e2e_snapshot_diff_indistinguishable() {
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
}

/// Scenario 4: Cover traffic preserves data.
#[test]
fn e2e_cover_traffic_preserves_data() {
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
}

/// Scenario 5: Corruption heals on write.
#[test]
fn e2e_corruption_heals_on_write() {
    let mut storage = MemoryStorage::new();
    provision_storage(&mut storage).unwrap();

    let slot = SessionIndex::new(0).unwrap();
    let mut session = allocate_session(&mut storage, DOMAIN, slot, b"pw").unwrap();

    write_session_data(&mut storage, DOMAIN, &mut session, 0, b"hello").unwrap();

    // Corrupt a block of another session (session 1, block 0)
    let s1 = SessionIndex::new(1).unwrap();
    let corrupted = Box::new([0xFF; bordercrypt::BLOCK_SIZE]);
    storage.write_block(s1, 0, &corrupted).unwrap();

    // Write at the same block index — should heal the corrupted block via cover
    write_session_data(&mut storage, DOMAIN, &mut session, 0, b"world").unwrap();

    // Our data should still be readable
    let result = read_session_data(&storage, DOMAIN, &session, 0, 5).unwrap();
    assert_eq!(&*result, b"world");

    // Session 1's block should be a valid ciphertext (rerandomized or cover)
    let s1_block = storage.read_block(s1, 0).unwrap();
    assert_ne!(*s1_block, [0xFF; bordercrypt::BLOCK_SIZE]);
}

/// Scenario 6: Blockstreams always aligned.
#[test]
fn e2e_blockstreams_always_aligned() {
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
}

/// Scenario 7: Wrong passwords never unlock.
#[test]
fn e2e_wrong_password_never_unlocks() {
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
}

/// Scenario 8: Multiple writes then full read-back.
#[test]
fn e2e_append_and_overwrite_pattern() {
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
}

/// Scenario 9: Re-unlock after cover traffic still works.
#[test]
fn e2e_unlock_after_cover_traffic() {
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
}

/// Scenario 10: Shrink then read remaining data.
#[test]
fn e2e_shrink_then_read() {
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
}

/// Scenario 11: Shrink to zero, then re-write.
#[test]
fn e2e_shrink_to_zero_then_rewrite() {
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
}

/// Scenario 12: Shrink survives cover traffic and re-unlock.
#[test]
fn e2e_shrink_cover_traffic_relock() {
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
}

/// Scenario 13: Cross-block write and read with byte-level verification.
#[test]
fn e2e_cross_block_write_read() {
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
}

/// Scenario 14: Interleaved writes and cover traffic from two sessions.
#[test]
fn e2e_interleaved_writes_and_cover() {
    std::thread::Builder::new()
        .stack_size(4 * 1024 * 1024)
        .spawn(|| {
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
        })
        .unwrap()
        .join()
        .unwrap();
}

/// Scenario 15: Cover traffic changes blocks across all sessions.
#[test]
fn e2e_cover_traffic_snapshot_resistance() {
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
}

/// Scenario 16: Allocated-but-unused session survives another session's writes + cover traffic.
#[test]
fn e2e_unused_session_survives_other_writes() {
    std::thread::Builder::new()
        .stack_size(4 * 1024 * 1024)
        .spawn(|| {
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
        })
        .unwrap()
        .join()
        .unwrap();
}
