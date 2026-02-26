//! End-to-end integration tests for bordercrypt v2.

use bordercrypt::storage::{BlockStorage, MemoryStorage};
use bordercrypt::{
    SESSION_COUNT, SessionIndex, allocate_session, cover_traffic_tick, get_global_block_count,
    provision_storage, read_session_data, unlock_session, write_session_data,
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

/// Scenario: Multiple writes then full read-back.
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

/// Scenario: Re-unlock after cover traffic still works.
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
