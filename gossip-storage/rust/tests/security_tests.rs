//! Comprehensive tests for the Plausible Deniability Storage
//!
//! Test categories:
//! 1. Cryptographic Primitives
//! 2. Key Derivation
//! 3. Addressing Blob
//! 4. Constant-Time Security
//! 5. Session Operations
//! 6. Data Operations
//! 7. Slot Content Format
//! 8. Error Handling
//! 9. Integration Tests
//!
//! ## Running tests
//!
//! ```bash
//! cargo test --features test-constants --test security_tests -- --test-threads=1
//! ```
//!
//! **Why `--test-threads=1`?**
//! Argon2id (password KDF) uses 32 MiB memory and takes 1-3 seconds per call.
//! Parallel tests cause CPU contention. Single-threaded is faster overall.
//!
//! **Why `--features test-constants`?**
//! Uses small padding values (1-10 KB) instead of PROD (5-600 MB).

use gossip_storage::*;
use std::collections::{HashMap, HashSet};

// ============================================================
// 1. CRYPTOGRAPHIC PRIMITIVES
// ============================================================

mod crypto_primitives {
    use super::*;

    /// password_kdf(password) → 64 bytes master key
    #[test]
    fn master_key_is_64_bytes() {
        let key = derive_master_key("test_password").unwrap();
        assert_eq!(key.as_bytes().len(), 64, "Master key must be 64 bytes per spec");
    }

    /// password_kdf must be deterministic
    #[test]
    fn master_key_derivation_is_deterministic() {
        let key1 = derive_master_key("password").unwrap();
        let key2 = derive_master_key("password").unwrap();
        assert_eq!(key1.as_bytes(), key2.as_bytes());
    }

    /// Different passwords produce different master keys
    #[test]
    fn different_passwords_produce_different_master_keys() {
        let key1 = derive_master_key("password1").unwrap();
        let key2 = derive_master_key("password2").unwrap();
        assert_ne!(key1.as_bytes(), key2.as_bytes());
    }

    /// AEAD encryption produces authenticated ciphertext
    #[test]
    fn aead_encrypt_decrypt_roundtrip() {
        let keys = SessionKeys::derive("password").unwrap();
        let slot_key = keys.get_key(0).unwrap();
        let content = SlotContent::new(0x123456789ABCDEF0, 0xDEADBEEF);

        let encrypted = encrypt_slot(&content, slot_key).unwrap();
        assert_eq!(encrypted.len(), SLOT_SIZE, "Encrypted slot must be 32 bytes");

        let decrypted = decrypt_slot(&encrypted, slot_key).unwrap();
        assert_eq!(decrypted.address, content.address);
        assert_eq!(decrypted.length, content.length);
    }

    /// AEAD decryption fails if tampered
    #[test]
    fn aead_decryption_fails_with_wrong_key() {
        let keys = SessionKeys::derive("password").unwrap();
        let key0 = keys.get_key(0).unwrap();
        let key1 = keys.get_key(1).unwrap();

        let content = SlotContent::new(100, 200);
        let encrypted = encrypt_slot(&content, key0).unwrap();

        // Wrong key should fail authentication
        assert!(decrypt_slot(&encrypted, key1).is_err());
    }

    /// AEAD decryption fails if ciphertext tampered
    #[test]
    fn aead_decryption_fails_with_tampered_ciphertext() {
        let keys = SessionKeys::derive("password").unwrap();
        let slot_key = keys.get_key(0).unwrap();
        let content = SlotContent::new(12345, 6789);

        let mut encrypted = encrypt_slot(&content, slot_key).unwrap();

        // Tamper with ciphertext
        encrypted[0] ^= 0xFF;

        // Decryption should fail
        assert!(decrypt_slot(&encrypted, slot_key).is_err());
    }

    /// Empty password should still produce valid key
    #[test]
    fn empty_password_produces_valid_key() {
        let key = derive_master_key("").unwrap();
        assert_eq!(key.as_bytes().len(), 64);
        // Key should not be all zeros
        assert!(key.as_bytes().iter().any(|&b| b != 0));
    }

    /// Long password should work
    #[test]
    fn long_password_works() {
        let long_password = "a".repeat(1000);
        let key = derive_master_key(&long_password).unwrap();
        assert_eq!(key.as_bytes().len(), 64);
    }

    /// Unicode password should work
    #[test]
    fn unicode_password_works() {
        let key = derive_master_key("密码🔐пароль").unwrap();
        assert_eq!(key.as_bytes().len(), 64);
    }
}

// ============================================================
// 2. KEY DERIVATION
// ============================================================

mod key_derivation {
    use super::*;

    /// kdf derives 46 unique slot indices
    #[test]
    fn derives_46_unique_slot_indices() {
        let master = derive_master_key("password").unwrap();
        let indices = derive_slot_indices(&master);

        assert_eq!(indices.len(), SLOTS_PER_SESSION);

        let unique: HashSet<_> = indices.iter().collect();
        assert_eq!(unique.len(), SLOTS_PER_SESSION, "All 46 indices must be unique");
    }

    /// Slot indices must be in valid range [0, 65535]
    #[test]
    fn slot_indices_in_valid_range() {
        let master = derive_master_key("password").unwrap();
        let indices = derive_slot_indices(&master);

        for idx in indices.iter() {
            // u16 can only hold values 0-65535, so all are valid for SLOT_COUNT=65536
            assert!((*idx as usize) < SLOT_COUNT, "Slot index {} out of range", idx);
        }
    }

    /// Slot index derivation is deterministic
    #[test]
    fn slot_index_derivation_is_deterministic() {
        let master = derive_master_key("password").unwrap();
        let indices1 = derive_slot_indices(&master);
        let indices2 = derive_slot_indices(&master);
        assert_eq!(indices1, indices2);
    }

    /// Different passwords produce different slot indices
    #[test]
    fn different_passwords_produce_different_slot_indices() {
        let master1 = derive_master_key("password1").unwrap();
        let master2 = derive_master_key("password2").unwrap();
        let indices1 = derive_slot_indices(&master1);
        let indices2 = derive_slot_indices(&master2);
        assert_ne!(indices1, indices2);
    }

    /// Slot key derivation is deterministic
    #[test]
    fn slot_key_derivation_is_deterministic() {
        let keys1 = SessionKeys::derive("password").unwrap();
        let keys2 = SessionKeys::derive("password").unwrap();
        // Same password, same position should give same key
        assert_eq!(keys1.get_key(0).unwrap().as_bytes(), keys2.get_key(0).unwrap().as_bytes());
    }

    /// Different positions produce different keys
    #[test]
    fn different_positions_produce_different_keys() {
        let keys = SessionKeys::derive("password").unwrap();
        let key0 = keys.get_key(0).unwrap();
        let key1 = keys.get_key(1).unwrap();
        assert_ne!(key0.as_bytes(), key1.as_bytes());
    }

    /// Slot keys are 64 bytes (AES-256-SIV requires 512-bit key)
    #[test]
    fn slot_keys_are_64_bytes() {
        let keys = SessionKeys::derive("password").unwrap();
        let slot_key = keys.get_key(0).unwrap();
        assert_eq!(slot_key.as_bytes().len(), 64);
    }

    /// SessionKeys contains all required components
    #[test]
    fn session_keys_contains_all_components() {
        let keys = SessionKeys::derive("password").unwrap();

        // 46 indices
        assert_eq!(keys.indices.len(), SLOTS_PER_SESSION);

        // Can get all 46 slot infos
        for i in 0..SLOTS_PER_SESSION {
            let (idx, key) = keys.get_slot_info(i).expect("Should have slot info");
            // u16 values are always < 65536
            assert!((idx as usize) < SLOT_COUNT);
            assert_eq!(key.as_bytes().len(), 64);
        }

        // Position 46 should return None
        assert!(keys.get_slot_info(SLOTS_PER_SESSION).is_none());
    }

    /// SessionKeys derivation is deterministic
    #[test]
    fn session_keys_derivation_is_deterministic() {
        let keys1 = SessionKeys::derive("password").unwrap();
        let keys2 = SessionKeys::derive("password").unwrap();
        assert_eq!(keys1.indices, keys2.indices);
    }
}

// ============================================================
// 3. ADDRESSING BLOB
// ============================================================

mod addressing_blob {
    use super::*;

    /// Addressing blob is exactly 2 MB
    #[test]
    fn addressing_blob_is_2mb() {
        assert_eq!(ADDRESSING_BLOB_SIZE, 2 * 1024 * 1024);
        assert_eq!(ADDRESSING_BLOB_SIZE, 2_097_152);
    }

    /// 65,536 slots
    #[test]
    fn slot_count_is_65536() {
        assert_eq!(SLOT_COUNT, 65_536);
    }

    /// Each slot is 32 bytes
    #[test]
    fn slot_size_is_32_bytes() {
        assert_eq!(SLOT_SIZE, 32);
    }

    /// SLOT_COUNT × SLOT_SIZE = ADDRESSING_BLOB_SIZE
    #[test]
    fn slot_math_is_consistent() {
        assert_eq!(SLOT_COUNT * SLOT_SIZE, ADDRESSING_BLOB_SIZE);
    }

    /// Addressing blob initialized with random data
    #[test]
    fn addressing_blob_initialized_with_random_data() {
        let blob = AddressingBlob::new_random();
        let bytes = blob.as_bytes();

        assert_eq!(bytes.len(), ADDRESSING_BLOB_SIZE);

        // Should not be all zeros (statistically impossible)
        assert!(bytes.iter().any(|&b| b != 0));

        // Should not be all same value
        let first = bytes[0];
        assert!(bytes.iter().any(|&b| b != first));
    }

    /// Can get/set individual slots
    #[test]
    fn addressing_blob_get_set_slot() {
        let mut blob = AddressingBlob::new_random();
        let slot = EncryptedSlot::new_random();

        // Set slot
        assert!(blob.set_slot(1000, &slot));

        // Get slot back
        let retrieved = blob.get_slot(1000).unwrap();
        assert_eq!(retrieved.as_bytes(), slot.as_bytes());
    }

    /// Out of bounds access returns None/false
    #[test]
    fn addressing_blob_bounds_checking() {
        let mut blob = AddressingBlob::new_random();
        let slot = EncryptedSlot::new_random();

        assert!(blob.get_slot(SLOT_COUNT).is_none());
        assert!(!blob.set_slot(SLOT_COUNT, &slot));
        assert!(blob.get_slot(SLOT_COUNT - 1).is_some());
    }

    /// Slots at different positions are independent
    #[test]
    fn slots_are_independent() {
        let mut blob = AddressingBlob::new_random();

        let slot1 = EncryptedSlot::new_random();
        let slot2 = EncryptedSlot::new_random();

        blob.set_slot(100, &slot1);
        blob.set_slot(200, &slot2);

        let retrieved1 = blob.get_slot(100).unwrap();
        let retrieved2 = blob.get_slot(200).unwrap();

        assert_eq!(retrieved1.as_bytes(), slot1.as_bytes());
        assert_eq!(retrieved2.as_bytes(), slot2.as_bytes());
        assert_ne!(retrieved1.as_bytes(), retrieved2.as_bytes());
    }
}

// ============================================================
// 4. CONSTANT-TIME SECURITY
// ============================================================

mod constant_time_security {
    use super::*;

    /// Unlock must scan all 46 slots (no early exit)
    #[test]
    fn unlock_scans_all_46_slots() {
        let password = "test_password";
        let keys = SessionKeys::derive(password).unwrap();

        let content = SlotContent::new(12345, 6789);
        let mut slots: HashMap<u16, [u8; SLOT_SIZE]> = HashMap::new();
        let access_count = std::cell::Cell::new(0);

        // Encrypt content into all 46 slots
        for position in 0..SLOTS_PER_SESSION {
            let (idx, key) = keys.get_slot_info(position).unwrap();
            let encrypted = encrypt_slot(&content, key).unwrap();
            slots.insert(idx, encrypted);
        }

        // Track how many slots are accessed
        let result = unlock_session(password, |idx| {
            access_count.set(access_count.get() + 1);
            slots.get(&idx).copied().unwrap_or([0u8; SLOT_SIZE])
        });

        assert!(result.is_some());
        assert_eq!(access_count.get(), SLOTS_PER_SESSION, "Must access all 46 slots");
    }

    /// Wrong password still scans all 46 slots
    #[test]
    fn wrong_password_scans_all_46_slots() {
        let keys = SessionKeys::derive("correct_password").unwrap();

        let content = SlotContent::new(12345, 6789);
        let mut slots: HashMap<u16, [u8; SLOT_SIZE]> = HashMap::new();

        for position in 0..SLOTS_PER_SESSION {
            let (idx, key) = keys.get_slot_info(position).unwrap();
            let encrypted = encrypt_slot(&content, key).unwrap();
            slots.insert(idx, encrypted);
        }

        let access_count = std::cell::Cell::new(0);
        let _result = unlock_session("wrong_password", |_idx| {
            access_count.set(access_count.get() + 1);
            [0u8; SLOT_SIZE] // Return garbage for wrong password's slot indices
        });

        assert_eq!(access_count.get(), SLOTS_PER_SESSION, "Must access all 46 slots even with wrong password");
    }

    /// Unlock returns valid_count of successful decryptions
    #[test]
    fn unlock_returns_valid_count() {
        let password = "test_password";
        let keys = SessionKeys::derive(password).unwrap();

        let content = SlotContent::new(12345, 6789);
        let mut slots: HashMap<u16, [u8; SLOT_SIZE]> = HashMap::new();

        // Encrypt all 46 slots
        for position in 0..SLOTS_PER_SESSION {
            let (idx, key) = keys.get_slot_info(position).unwrap();
            let encrypted = encrypt_slot(&content, key).unwrap();
            slots.insert(idx, encrypted);
        }

        let result = unlock_session(password, |idx| {
            slots.get(&idx).copied().unwrap_or([0u8; SLOT_SIZE])
        });

        let result = result.unwrap();
        assert_eq!(result.valid_slots.len(), SLOTS_PER_SESSION);
    }

    /// Partial corruption still unlocks (redundancy)
    #[test]
    fn partial_corruption_still_unlocks() {
        let password = "test_password";
        let keys = SessionKeys::derive(password).unwrap();

        let content = SlotContent::new(12345, 6789);
        let mut slots: HashMap<u16, [u8; SLOT_SIZE]> = HashMap::new();

        // Encrypt all 46 slots
        for position in 0..SLOTS_PER_SESSION {
            let (idx, key) = keys.get_slot_info(position).unwrap();
            let encrypted = encrypt_slot(&content, key).unwrap();
            slots.insert(idx, encrypted);
        }

        // Corrupt 45 of 46 slots (keep only the first one)
        let _first_idx = keys.indices[0];
        for &idx in keys.indices.iter().skip(1) {
            slots.insert(idx, [0u8; SLOT_SIZE]); // Corrupt with zeros
        }

        let result = unlock_session(password, |idx| {
            slots.get(&idx).copied().unwrap_or([0u8; SLOT_SIZE])
        });

        // Should still unlock with just 1 valid slot
        let result = result.unwrap();
        assert_eq!(result.valid_slots.len(), 1); // Only 1 valid slot
        let (_, first_content) = &result.valid_slots[0];
        assert_eq!(first_content.address, 12345);
        assert_eq!(first_content.length, 6789);
    }
}

// ============================================================
// 5. SESSION OPERATIONS
// ============================================================

mod session_operations {
    use super::*;

    /// Session starts in Locked state
    #[test]
    fn session_starts_locked() {
        let fs = InMemoryFs::new();
        let manager = SessionManager::new(fs);
        assert_eq!(manager.state(), SessionState::Locked);
        assert!(!manager.is_unlocked());
    }

    /// Create session transitions to Unlocked
    #[test]
    fn create_session_transitions_to_unlocked() {
        let fs = InMemoryFs::new();
        let mut manager = SessionManager::new(fs);
        manager.init_storage();

        manager.create_session("password").unwrap();
        assert_eq!(manager.state(), SessionState::Unlocked);
        assert!(manager.is_unlocked());
    }

    /// Lock transitions back to Locked
    #[test]
    fn lock_transitions_to_locked() {
        let fs = InMemoryFs::new();
        let mut manager = SessionManager::new(fs);
        manager.init_storage();

        manager.create_session("password").unwrap();
        assert_eq!(manager.state(), SessionState::Unlocked);

        manager.lock();
        assert_eq!(manager.state(), SessionState::Locked);
        assert!(!manager.is_unlocked());
    }

    /// Unlock with correct password succeeds
    #[test]
    fn unlock_with_correct_password_succeeds() {
        let fs = InMemoryFs::new();
        let mut manager = SessionManager::new(fs);
        manager.init_storage();

        manager.create_session("my_password").unwrap();
        manager.lock();

        manager.unlock_session("my_password").unwrap();
        assert_eq!(manager.state(), SessionState::Unlocked);
    }

    /// Unlock with wrong password fails
    #[test]
    fn unlock_with_wrong_password_fails() {
        let fs = InMemoryFs::new();
        let mut manager = SessionManager::new(fs);
        manager.init_storage();

        manager.create_session("correct_password").unwrap();
        manager.lock();

        let result = manager.unlock_session("wrong_password");
        assert!(result.is_err());
        assert_eq!(manager.state(), SessionState::Locked);
    }

    /// Cannot create session when already unlocked
    #[test]
    fn cannot_create_when_already_unlocked() {
        let fs = InMemoryFs::new();
        let mut manager = SessionManager::new(fs);
        manager.init_storage();

        manager.create_session("password1").unwrap();

        let result = manager.create_session("password2");
        assert!(result.is_err());
    }

    /// Cannot unlock when already unlocked
    #[test]
    fn cannot_unlock_when_already_unlocked() {
        let fs = InMemoryFs::new();
        let mut manager = SessionManager::new(fs);
        manager.init_storage();

        manager.create_session("password").unwrap();

        let result = manager.unlock_session("password");
        assert!(result.is_err());
    }

    /// Multiple sessions with different passwords can coexist
    #[test]
    fn multiple_sessions_coexist() {
        let fs = InMemoryFs::new();
        let mut manager = SessionManager::new(fs);
        manager.init_storage();

        // Create session A
        manager.create_session("password_a").unwrap();
        manager.write_data(0, &[1, 2, 3, 4, 5]).unwrap();
        manager.flush_data().unwrap();
        // Capture address AFTER flush (root block may move)
        let addr_a = manager.session().unwrap().root_address();
        manager.lock();

        // Create session B
        manager.create_session("password_b").unwrap();
        manager.flush_data().unwrap();
        let addr_b = manager.session().unwrap().root_address();
        manager.lock();

        // Both sessions exist at different addresses
        assert_ne!(addr_a, addr_b);

        // Can unlock either
        manager.unlock_session("password_a").unwrap();
        assert_eq!(manager.session().unwrap().root_address(), addr_a);
        manager.lock();

        manager.unlock_session("password_b").unwrap();
        assert_eq!(manager.session().unwrap().root_address(), addr_b);
    }

    /// Session provides root block info
    #[test]
    fn session_provides_root_info() {
        let fs = InMemoryFs::new();
        let mut manager = SessionManager::new(fs);
        manager.init_storage();

        manager.create_session("password").unwrap();
        let session = manager.session().unwrap();

        // Root address is after Pareto padding (>= pareto_min)
        let padding = &PaddingValues::TEST;
        assert!(session.root_address() >= padding.pareto_min,
            "Root address {} should be >= pareto_min {}", session.root_address(), padding.pareto_min);
        // Root length > 0 (initial root block has allocation table header)
        assert!(session.root_length() > 0, "Root block should have non-zero length");
    }
}

// ============================================================
// 6. DATA OPERATIONS
// ============================================================

mod data_operations {
    use super::*;

    /// Read/write data roundtrip
    #[test]
    fn read_write_roundtrip() {
        let fs = InMemoryFs::new();
        let mut manager = SessionManager::new(fs);
        manager.init_storage();
        manager.create_session("password").unwrap();

        let test_data = vec![1, 2, 3, 4, 5, 6, 7, 8];
        manager.write_data(0, &test_data).unwrap();

        let read_data = manager.read_data(0, 8).unwrap();
        assert_eq!(read_data, test_data);
    }

    /// Write at arbitrary offset
    #[test]
    fn write_at_arbitrary_offset() {
        let fs = InMemoryFs::new();
        let mut manager = SessionManager::new(fs);
        manager.init_storage();
        manager.create_session("password").unwrap();

        // Write at offset 100
        let test_data = vec![0xAA, 0xBB, 0xCC];
        manager.write_data(100, &test_data).unwrap();

        let read_data = manager.read_data(100, 3).unwrap();
        assert_eq!(read_data, test_data);
    }

    /// Multiple writes at different offsets
    #[test]
    fn multiple_writes_at_different_offsets() {
        let fs = InMemoryFs::new();
        let mut manager = SessionManager::new(fs);
        manager.init_storage();
        manager.create_session("password").unwrap();

        manager.write_data(0, &[1, 2, 3]).unwrap();
        manager.write_data(10, &[4, 5, 6]).unwrap();
        manager.write_data(20, &[7, 8, 9]).unwrap();

        assert_eq!(manager.read_data(0, 3).unwrap(), vec![1, 2, 3]);
        assert_eq!(manager.read_data(10, 3).unwrap(), vec![4, 5, 6]);
        assert_eq!(manager.read_data(20, 3).unwrap(), vec![7, 8, 9]);
    }

    /// Read requires unlocked session
    #[test]
    fn read_requires_unlocked_session() {
        let fs = InMemoryFs::new();
        let mut manager = SessionManager::new(fs);
        manager.init_storage();

        // Not unlocked
        let result = manager.read_data(0, 10);
        assert!(result.is_err());
    }

    /// Write requires unlocked session
    #[test]
    fn write_requires_unlocked_session() {
        let fs = InMemoryFs::new();
        let mut manager = SessionManager::new(fs);
        manager.init_storage();

        // Not unlocked
        let result = manager.write_data(0, &[1, 2, 3]);
        assert!(result.is_err());
    }

    /// Data persists across lock/unlock cycle
    #[test]
    fn data_persists_across_lock_unlock() {
        let fs = InMemoryFs::new();
        let mut manager = SessionManager::new(fs);
        manager.init_storage();

        manager.create_session("password").unwrap();
        let test_data = vec![0xDE, 0xAD, 0xBE, 0xEF];
        manager.write_data(0, &test_data).unwrap();
        manager.lock();

        manager.unlock_session("password").unwrap();
        let read_data = manager.read_data(0, 4).unwrap();
        assert_eq!(read_data, test_data);
    }

    /// Flush commits data
    #[test]
    fn flush_commits_data() {
        let fs = InMemoryFs::new();
        let mut manager = SessionManager::new(fs);
        manager.init_storage();
        manager.create_session("password").unwrap();

        manager.write_data(0, &[1, 2, 3]).unwrap();
        manager.flush_data().unwrap();

        // Data should still be readable
        let read = manager.read_data(0, 3).unwrap();
        assert_eq!(read, vec![1, 2, 3]);
    }

    /// Flush requires unlocked session
    #[test]
    fn flush_requires_unlocked_session() {
        let fs = InMemoryFs::new();
        let mut manager = SessionManager::new(fs);
        manager.init_storage();

        let result = manager.flush_data();
        assert!(result.is_err());
    }

    /// Data size tracking
    #[test]
    fn data_size_tracking() {
        let fs = InMemoryFs::new();
        let mut manager = SessionManager::new(fs);
        manager.init_storage();
        manager.create_session("password").unwrap();

        let _initial_size = manager.data_size().unwrap();

        manager.write_data(100, &[1, 2, 3, 4, 5]).unwrap();

        let new_size = manager.data_size().unwrap();
        assert!(new_size >= 105); // At least 100 offset + 5 bytes
    }
}

// ============================================================
// 7. SLOT CONTENT FORMAT
// ============================================================

mod slot_content_format {
    use super::*;

    /// SlotContent is 12 bytes (u64 + u32)
    #[test]
    fn slot_content_is_12_bytes() {
        assert_eq!(SlotContent::SIZE, 12);
    }

    /// SlotContent serialization roundtrip
    #[test]
    fn slot_content_serialization_roundtrip() {
        let content = SlotContent::new(0x123456789ABCDEF0, 0xDEADBEEF);
        let bytes = content.to_bytes();

        assert_eq!(bytes.len(), SlotContent::SIZE);

        let recovered = SlotContent::from_bytes(&bytes).unwrap();
        assert_eq!(recovered.address, content.address);
        assert_eq!(recovered.length, content.length);
    }

    /// Full u64 address range supported
    #[test]
    fn slot_content_full_u64_address() {
        let content = SlotContent::new(u64::MAX, 0);
        let bytes = content.to_bytes();
        let recovered = SlotContent::from_bytes(&bytes).unwrap();
        assert_eq!(recovered.address, u64::MAX);
    }

    /// Full u32 length range supported
    #[test]
    fn slot_content_full_u32_length() {
        let content = SlotContent::new(0, u32::MAX);
        let bytes = content.to_bytes();
        let recovered = SlotContent::from_bytes(&bytes).unwrap();
        assert_eq!(recovered.length, u32::MAX);
    }

    /// Big-endian encoding (network byte order)
    #[test]
    fn slot_content_big_endian() {
        let content = SlotContent::new(0x0102030405060708, 0x090A0B0C);
        let bytes = content.to_bytes();

        // Address: 0x0102030405060708 in BE (most significant byte first)
        assert_eq!(bytes[0], 0x01);
        assert_eq!(bytes[1], 0x02);
        assert_eq!(bytes[7], 0x08);

        // Length: 0x090A0B0C in BE
        assert_eq!(bytes[8], 0x09);
        assert_eq!(bytes[9], 0x0A);
        assert_eq!(bytes[11], 0x0C);
    }

    /// Deserialization fails with insufficient bytes
    #[test]
    fn slot_content_fails_with_insufficient_bytes() {
        let bytes = [0u8; 11]; // Only 11 bytes, need 12
        assert!(SlotContent::from_bytes(&bytes).is_none());
    }

    /// Zero values work
    #[test]
    fn slot_content_zero_values() {
        let content = SlotContent::new(0, 0);
        let bytes = content.to_bytes();
        let recovered = SlotContent::from_bytes(&bytes).unwrap();
        assert_eq!(recovered.address, 0);
        assert_eq!(recovered.length, 0);
    }
}

// ============================================================
// 8. ERROR HANDLING
// ============================================================

mod error_handling {
    use super::*;

    /// Wrong password returns None
    #[test]
    fn wrong_password_returns_none() {
        let keys = SessionKeys::derive("correct_password").unwrap();

        let content = SlotContent::new(12345, 6789);
        let mut slots: HashMap<u16, [u8; SLOT_SIZE]> = HashMap::new();

        for position in 0..SLOTS_PER_SESSION {
            let (idx, key) = keys.get_slot_info(position).unwrap();
            let encrypted = encrypt_slot(&content, key).unwrap();
            slots.insert(idx, encrypted);
        }

        // Wrong password
        let result = unlock_session("wrong_password", |idx| {
            slots.get(&idx).copied().unwrap_or([0u8; SLOT_SIZE])
        });

        assert!(result.is_none());
    }

    /// All corrupted slots returns None
    #[test]
    fn all_corrupted_returns_none() {
        let result = unlock_session("password", |_idx| {
            [0u8; SLOT_SIZE] // All garbage
        });

        assert!(result.is_none());
    }

    /// SessionError types are defined
    #[test]
    fn session_error_types_defined() {
        // Just verify the error types exist and can be created
        let _err1 = SessionError::SessionLocked;
        let _err2 = SessionError::AlreadyUnlocked;
        let _err3 = SessionError::InvalidPassword;
        let _err4 = SessionError::CorruptedData;
    }

    /// CryptoError types are defined
    #[test]
    fn crypto_error_types_defined() {
        let _err1 = CryptoError::KeyDerivationFailed;
        let _err2 = CryptoError::EncryptionFailed;
        let _err3 = CryptoError::DecryptionFailed;
        let _err4 = CryptoError::InvalidTag;
        let _err5 = CryptoError::InvalidLength;
    }
}

// ============================================================
// 9. INTEGRATION TESTS
// ============================================================

mod integration {
    use super::*;

    /// Full create → lock → unlock → verify flow
    #[test]
    fn full_session_lifecycle() {
        let fs = InMemoryFs::new();
        let mut manager = SessionManager::new(fs);

        // Initialize
        manager.init_storage();
        assert_eq!(manager.state(), SessionState::Locked);

        // Create session
        manager.create_session("my_secure_password").unwrap();
        assert_eq!(manager.state(), SessionState::Unlocked);

        // Write some data
        let test_data = b"Hello, encrypted world!";
        manager.write_data(0, test_data).unwrap();
        manager.flush_data().unwrap();

        // Lock
        manager.lock();
        assert_eq!(manager.state(), SessionState::Locked);

        // Unlock
        manager.unlock_session("my_secure_password").unwrap();
        assert_eq!(manager.state(), SessionState::Unlocked);

        // Verify data
        let read_data = manager.read_data(0, test_data.len() as u32).unwrap();
        assert_eq!(read_data, test_data);
    }

    /// Storage initialization creates 2MB addressing blob
    #[test]
    fn storage_initialization() {
        let fs = InMemoryFs::new();
        let mut manager = SessionManager::new(fs);

        manager.init_storage();

        // Create session to verify storage works
        manager.create_session("password").unwrap();
        assert!(manager.is_unlocked());
    }

    /// Re-initialization is idempotent
    #[test]
    fn reinitialization_is_idempotent() {
        let fs = InMemoryFs::new();
        let mut manager = SessionManager::new(fs);

        manager.init_storage();
        manager.create_session("password").unwrap();
        let addr1 = manager.session().unwrap().root_address();
        manager.lock();

        // Re-init should not overwrite existing data
        manager.init_storage();

        manager.unlock_session("password").unwrap();
        let addr2 = manager.session().unwrap().root_address();
        assert_eq!(addr1, addr2);
    }

    /// Sessions have different root addresses (data blob grows)
    /// With BlockManager, each session gets Pareto padding before its root block.
    #[test]
    fn sessions_have_different_root_addresses() {
        let fs = InMemoryFs::new();
        let mut manager = SessionManager::new(fs);
        manager.init_storage();

        // Create session A
        manager.create_session("password_a").unwrap();
        // Write some data to grow the blob
        manager.write_data(0, b"Session A data").unwrap();
        manager.flush_data().unwrap();
        // Capture root_a AFTER flush
        let root_a = manager.session().unwrap().root_address();
        manager.lock();

        // Create session B - should start at a different address
        manager.create_session("password_b").unwrap();
        manager.flush_data().unwrap();
        let root_b = manager.session().unwrap().root_address();
        manager.lock();

        // Root addresses should be different (session B has its own Pareto padding)
        assert_ne!(root_a, root_b);
        assert!(root_b > root_a, "Session B should start after Session A");

        // Both sessions should still be unlockable
        manager.unlock_session("password_a").unwrap();
        assert_eq!(manager.session().unwrap().root_address(), root_a);
        manager.lock();

        manager.unlock_session("password_b").unwrap();
        assert_eq!(manager.session().unwrap().root_address(), root_b);
    }

    /// EncryptedSlot is indistinguishable from random
    #[test]
    fn encrypted_slot_indistinguishable_from_random() {
        let keys = SessionKeys::derive("password").unwrap();
        let slot_key = keys.get_key(0).unwrap();
        let content = SlotContent::new(12345, 6789);

        let encrypted = encrypt_slot(&content, slot_key).unwrap();
        let random_slot = EncryptedSlot::new_random();

        // Both should be 32 bytes
        assert_eq!(encrypted.len(), SLOT_SIZE);
        assert_eq!(random_slot.as_bytes().len(), SLOT_SIZE);

        // Both should have similar entropy (not all zeros or same value)
        assert!(encrypted.iter().any(|&b| b != 0));
        assert!(random_slot.as_bytes().iter().any(|&b| b != 0));

        // Both should have different bytes (high probability)
        assert!(encrypted.iter().zip(encrypted.iter().skip(1)).any(|(a, b)| a != b));
        assert!(random_slot.as_bytes().iter().zip(random_slot.as_bytes().iter().skip(1)).any(|(a, b)| a != b));
    }

    /// 46 copies provide redundancy (COPIES_PER_SESSION = 46)
    #[test]
    fn copies_per_session_is_46() {
        assert_eq!(SLOTS_PER_SESSION, 46);
    }

    /// Collision probability is negligible
    /// For 1024 sessions: P(any lost) < 10^-12
    #[test]
    fn slot_collision_analysis() {
        // Verify the math: (46/65536)^46 is astronomically small
        // We can't test probability directly, but we can verify constants
        let k = SLOTS_PER_SESSION as f64;
        let n = SLOT_COUNT as f64;

        // P(one session loses all copies) ≈ (k/n)^k
        let p_one = (k / n).powf(k);
        assert!(p_one < 1e-50, "Probability should be astronomically small");

        // Even for 1024 sessions
        let p_any = 1024.0 * p_one;
        assert!(p_any < 1e-12, "Should be less than 10^-12 for 1024 sessions");
    }
}

// ============================================================
// 10. FILESYSTEM TRAIT TESTS
// ============================================================

mod filesystem_trait {
    use super::*;

    /// InMemoryFs implements FileSystem trait
    #[test]
    fn in_memory_fs_read_write() {
        let mut fs = InMemoryFs::new();

        fs.write_bytes(FILE_DATA, 0, &[1, 2, 3, 4, 5]);
        let data = fs.read_bytes(FILE_DATA, 0, 5);
        assert_eq!(data, vec![1, 2, 3, 4, 5]);
    }

    /// File size tracking
    #[test]
    fn in_memory_fs_size_tracking() {
        let mut fs = InMemoryFs::new();

        assert_eq!(fs.get_size(FILE_DATA), 0);

        fs.write_bytes(FILE_DATA, 0, &[1, 2, 3, 4, 5]);
        assert_eq!(fs.get_size(FILE_DATA), 5);

        fs.write_bytes(FILE_DATA, 10, &[6, 7, 8]);
        assert_eq!(fs.get_size(FILE_DATA), 13);
    }

    /// Different file IDs are independent
    #[test]
    fn in_memory_fs_file_independence() {
        let mut fs = InMemoryFs::new();

        fs.write_bytes(FILE_ADDRESSING, 0, &[1, 2, 3]);
        fs.write_bytes(FILE_DATA, 0, &[4, 5, 6]);

        assert_eq!(fs.read_bytes(FILE_ADDRESSING, 0, 3), vec![1, 2, 3]);
        assert_eq!(fs.read_bytes(FILE_DATA, 0, 3), vec![4, 5, 6]);
    }

    /// Reading beyond file returns zeros
    #[test]
    fn in_memory_fs_read_beyond() {
        let mut fs = InMemoryFs::new();

        fs.write_bytes(FILE_DATA, 0, &[1, 2, 3]);

        // Reading beyond should return available data + zeros
        let data = fs.read_bytes(FILE_DATA, 0, 10);
        assert_eq!(data.len(), 10);
        assert_eq!(&data[0..3], &[1, 2, 3]);
    }

    /// FILE_ADDRESSING = 0, FILE_DATA = 1
    #[test]
    fn file_id_constants() {
        assert_eq!(FILE_ADDRESSING, 0);
        assert_eq!(FILE_DATA, 1);
    }
}

// ============================================================
// 11. CRUD OPERATIONS (Create, Read, Update, Delete patterns)
// ============================================================

mod crud_operations {
    use super::*;

    /// Test: Create session and verify initial state
    #[test]
    fn create_session_initial_state() {
        let fs = InMemoryFs::new();
        let mut manager = SessionManager::new(fs);
        manager.init_storage();

        manager.create_session("password").unwrap();

        // Session should be active
        assert!(manager.is_unlocked());
        assert_eq!(manager.state(), SessionState::Unlocked);

        // Root info should be valid
        let session = manager.session().unwrap();
        // Root block contains allocation table header, so length > 0
        assert!(session.root_length() > 0, "Root block should have non-zero length");
    }

    /// Test: Read empty data returns zeros
    #[test]
    fn read_empty_data() {
        let fs = InMemoryFs::new();
        let mut manager = SessionManager::new(fs);
        manager.init_storage();
        manager.create_session("password").unwrap();

        // Read from empty blob
        let data = manager.read_data(0, 100).unwrap();
        assert_eq!(data.len(), 100);
        // Should be zeros (uninitialized)
        assert!(data.iter().all(|&b| b == 0));
    }

    /// Test: Write then read roundtrip (basic CRUD)
    #[test]
    fn write_read_roundtrip() {
        let fs = InMemoryFs::new();
        let mut manager = SessionManager::new(fs);
        manager.init_storage();
        manager.create_session("password").unwrap();

        let test_data = b"Hello, World!";
        manager.write_data(0, test_data).unwrap();

        let read_back = manager.read_data(0, test_data.len() as u32).unwrap();
        assert_eq!(read_back, test_data);
    }

    /// Test: Update existing data (overwrite)
    #[test]
    fn update_data_overwrite() {
        let fs = InMemoryFs::new();
        let mut manager = SessionManager::new(fs);
        manager.init_storage();
        manager.create_session("password").unwrap();

        // Write initial data
        manager.write_data(0, b"AAAAAAAAAA").unwrap();

        // Overwrite part of it
        manager.write_data(3, b"BBB").unwrap();

        // Verify the update
        let data = manager.read_data(0, 10).unwrap();
        assert_eq!(data, b"AAABBBAAAA");
    }

    /// Test: Update extends data if needed
    #[test]
    fn update_extends_data() {
        let fs = InMemoryFs::new();
        let mut manager = SessionManager::new(fs);
        manager.init_storage();
        manager.create_session("password").unwrap();

        // Write at offset 0
        manager.write_data(0, b"START").unwrap();
        assert_eq!(manager.data_size().unwrap(), 5);

        // Write at offset 100 (should extend)
        manager.write_data(100, b"END").unwrap();
        assert!(manager.data_size().unwrap() >= 103);

        // Verify both writes
        assert_eq!(manager.read_data(0, 5).unwrap(), b"START");
        assert_eq!(manager.read_data(100, 3).unwrap(), b"END");
    }

    /// Test: Simulated delete (overwrite with zeros)
    #[test]
    fn simulated_delete() {
        let fs = InMemoryFs::new();
        let mut manager = SessionManager::new(fs);
        manager.init_storage();
        manager.create_session("password").unwrap();

        // Write sensitive data
        manager.write_data(0, b"SECRET_DATA").unwrap();

        // "Delete" by overwriting with zeros
        manager.write_data(0, &[0u8; 11]).unwrap();

        // Verify deletion
        let data = manager.read_data(0, 11).unwrap();
        assert!(data.iter().all(|&b| b == 0));
    }

    /// Test: Multiple sequential writes
    #[test]
    fn multiple_sequential_writes() {
        let fs = InMemoryFs::new();
        let mut manager = SessionManager::new(fs);
        manager.init_storage();
        manager.create_session("password").unwrap();

        // Write multiple chunks sequentially
        for i in 0..10 {
            let offset = i * 10;
            let data = format!("CHUNK_{:03}", i);
            manager.write_data(offset as u64, data.as_bytes()).unwrap();
        }

        // Verify all chunks
        for i in 0..10 {
            let offset = i * 10;
            let expected = format!("CHUNK_{:03}", i);
            let data = manager.read_data(offset as u64, expected.len() as u32).unwrap();
            assert_eq!(data, expected.as_bytes(), "Chunk {} mismatch", i);
        }
    }

    /// Test: Random access pattern
    #[test]
    fn random_access_pattern() {
        let fs = InMemoryFs::new();
        let mut manager = SessionManager::new(fs);
        manager.init_storage();
        manager.create_session("password").unwrap();

        // Write at various offsets (not sequential)
        let writes = vec![
            (100u64, b"first".to_vec()),
            (50u64, b"second".to_vec()),
            (200u64, b"third".to_vec()),
            (0u64, b"fourth".to_vec()),
        ];

        for (offset, data) in &writes {
            manager.write_data(*offset, data).unwrap();
        }

        // Verify all writes
        for (offset, data) in &writes {
            let read = manager.read_data(*offset, data.len() as u32).unwrap();
            assert_eq!(read, *data);
        }
    }

    /// Test: Large data write/read
    #[test]
    #[ignore] // Slow with test-constants (creates ~1000 blocks) - run with: cargo test -- --ignored
    fn large_data_write_read() {
        let fs = InMemoryFs::new();
        let mut manager = SessionManager::new(fs);
        manager.init_storage();
        manager.create_session("password").unwrap();

        // Write 1 MB of data
        let large_data: Vec<u8> = (0..1_000_000).map(|i| (i % 256) as u8).collect();
        manager.write_data(0, &large_data).unwrap();

        // Read it back in chunks
        let chunk_size = 100_000;
        for i in 0..10 {
            let offset = i * chunk_size;
            let chunk = manager.read_data(offset as u64, chunk_size as u32).unwrap();
            assert_eq!(chunk.len(), chunk_size);
            assert_eq!(chunk, large_data[offset..offset + chunk_size]);
        }
    }
}

// ============================================================
// 12. MULTI-SESSION SCENARIOS (Alice, Bob, Charlie pattern)
// ============================================================

mod multi_session {
    use super::*;

    /// Test: Three users with independent sessions
    #[test]
    #[ignore] // Slow due to Argon2id - run with: cargo test -- --ignored
    fn three_users_independent_sessions() {
        let fs = InMemoryFs::new();
        let mut manager = SessionManager::new(fs);
        manager.init_storage();

        // Alice creates session
        manager.create_session("alice_password").unwrap();
        let alice_root = manager.session().unwrap().root_address();
        manager.write_data(0, b"Alice's data").unwrap();
        manager.lock();

        // Bob creates session
        manager.create_session("bob_password").unwrap();
        let bob_root = manager.session().unwrap().root_address();
        manager.write_data(0, b"Bob's data").unwrap();
        manager.lock();

        // Charlie creates session
        manager.create_session("charlie_password").unwrap();
        let charlie_root = manager.session().unwrap().root_address();
        manager.write_data(0, b"Charlie's data").unwrap();
        manager.lock();

        // All roots should be different
        assert_ne!(alice_root, bob_root);
        assert_ne!(bob_root, charlie_root);
        assert_ne!(alice_root, charlie_root);

        // Each user can unlock independently
        manager.unlock_session("alice_password").unwrap();
        assert_eq!(manager.session().unwrap().root_address(), alice_root);
        manager.lock();

        manager.unlock_session("bob_password").unwrap();
        assert_eq!(manager.session().unwrap().root_address(), bob_root);
        manager.lock();

        manager.unlock_session("charlie_password").unwrap();
        assert_eq!(manager.session().unwrap().root_address(), charlie_root);
    }

    /// Test: Sessions don't interfere with each other's slot indices
    #[test]
    fn sessions_use_different_slot_indices() {
        let alice_keys = SessionKeys::derive("alice").unwrap();
        let bob_keys = SessionKeys::derive("bob").unwrap();

        // Count overlapping indices
        let alice_set: HashSet<_> = alice_keys.indices.iter().collect();
        let bob_set: HashSet<_> = bob_keys.indices.iter().collect();
        let overlap_count = alice_set.intersection(&bob_set).count();

        // With 46 slots out of 65536, expected overlap is very small
        // P(any overlap) ≈ 1 - (65490/65536)^46 ≈ 3%
        // But some overlap is statistically normal
        assert!(
            overlap_count < 10,
            "Too much overlap: {} indices", overlap_count
        );
    }

    /// Test: Many sessions can coexist (stress test)
    #[test]
    #[ignore] // Slow due to Argon2id - run with: cargo test -- --ignored
    fn many_sessions_coexist() {
        let fs = InMemoryFs::new();
        let mut manager = SessionManager::new(fs);
        manager.init_storage();

        let num_sessions = 20;
        let mut roots = Vec::new();

        // Create many sessions
        for i in 0..num_sessions {
            let password = format!("password_{}", i);
            manager.create_session(&password).unwrap();
            roots.push(manager.session().unwrap().root_address());
            manager.write_data(0, format!("Data for session {}", i).as_bytes()).unwrap();
            manager.lock();
        }

        // Verify all sessions still accessible
        for i in 0..num_sessions {
            let password = format!("password_{}", i);
            manager.unlock_session(&password).unwrap();
            assert_eq!(manager.session().unwrap().root_address(), roots[i]);
            manager.lock();
        }
    }

    /// Test: Session unlock order doesn't matter
    #[test]
    #[ignore] // Slow due to Argon2id - run with: cargo test -- --ignored
    fn unlock_order_independent() {
        let fs = InMemoryFs::new();
        let mut manager = SessionManager::new(fs);
        manager.init_storage();

        // Create A, B, C
        manager.create_session("A").unwrap();
        manager.lock();
        manager.create_session("B").unwrap();
        manager.lock();
        manager.create_session("C").unwrap();
        manager.lock();

        // Unlock in different order: B, C, A
        manager.unlock_session("B").unwrap();
        manager.lock();
        manager.unlock_session("C").unwrap();
        manager.lock();
        manager.unlock_session("A").unwrap();
        manager.lock();

        // Should all still work
        assert!(manager.unlock_session("A").is_ok());
        manager.lock();
        assert!(manager.unlock_session("B").is_ok());
        manager.lock();
        assert!(manager.unlock_session("C").is_ok());
    }
}

// ============================================================
// 13. EDGE CASES & BOUNDARY CONDITIONS
// ============================================================

mod edge_cases {
    use super::*;

    /// Test: Empty password
    #[test]
    fn empty_password_works() {
        let fs = InMemoryFs::new();
        let mut manager = SessionManager::new(fs);
        manager.init_storage();

        manager.create_session("").unwrap();
        manager.write_data(0, b"data").unwrap();
        manager.lock();

        manager.unlock_session("").unwrap();
        assert_eq!(manager.read_data(0, 4).unwrap(), b"data");
    }

    /// Test: Very long password
    #[test]
    fn very_long_password() {
        let fs = InMemoryFs::new();
        let mut manager = SessionManager::new(fs);
        manager.init_storage();

        let long_password = "a".repeat(10_000);
        manager.create_session(&long_password).unwrap();
        manager.write_data(0, b"secure").unwrap();
        manager.lock();

        manager.unlock_session(&long_password).unwrap();
        assert_eq!(manager.read_data(0, 6).unwrap(), b"secure");
    }

    /// Test: Special characters in password
    #[test]
    fn special_characters_password() {
        let fs = InMemoryFs::new();
        let mut manager = SessionManager::new(fs);
        manager.init_storage();

        let special_password = "!@#$%^&*()_+-=[]{}|;':\",./<>?`~\n\t\r\0";
        manager.create_session(special_password).unwrap();
        manager.lock();

        manager.unlock_session(special_password).unwrap();
        assert!(manager.is_unlocked());
    }

    /// Test: Unicode password with emojis
    #[test]
    fn unicode_emoji_password() {
        let fs = InMemoryFs::new();
        let mut manager = SessionManager::new(fs);
        manager.init_storage();

        let emoji_password = "🔐🔑🗝️密码пароль";
        manager.create_session(emoji_password).unwrap();
        manager.lock();

        manager.unlock_session(emoji_password).unwrap();
        assert!(manager.is_unlocked());
    }

    /// Test: Write at offset 0
    #[test]
    fn write_at_offset_zero() {
        let fs = InMemoryFs::new();
        let mut manager = SessionManager::new(fs);
        manager.init_storage();
        manager.create_session("password").unwrap();

        manager.write_data(0, b"start").unwrap();
        assert_eq!(manager.read_data(0, 5).unwrap(), b"start");
    }

    /// Test: Write at very large offset
    #[test]
    fn write_at_large_offset() {
        let fs = InMemoryFs::new();
        let mut manager = SessionManager::new(fs);
        manager.init_storage();
        manager.create_session("password").unwrap();

        let large_offset = 10_000_000u64; // 10 MB
        manager.write_data(large_offset, b"far away").unwrap();

        let read = manager.read_data(large_offset, 8).unwrap();
        assert_eq!(read, b"far away");
    }

    /// Test: Zero-length write is no-op
    #[test]
    fn zero_length_write() {
        let fs = InMemoryFs::new();
        let mut manager = SessionManager::new(fs);
        manager.init_storage();
        manager.create_session("password").unwrap();

        let size_before = manager.data_size().unwrap();
        manager.write_data(0, &[]).unwrap();
        let size_after = manager.data_size().unwrap();

        assert_eq!(size_before, size_after);
    }

    /// Test: Zero-length read returns empty
    #[test]
    fn zero_length_read() {
        let fs = InMemoryFs::new();
        let mut manager = SessionManager::new(fs);
        manager.init_storage();
        manager.create_session("password").unwrap();

        let data = manager.read_data(0, 0).unwrap();
        assert!(data.is_empty());
    }

    /// Test: Repeated lock/unlock cycles
    #[test]
    #[ignore] // Slow due to Argon2id - run with: cargo test -- --ignored
    fn repeated_lock_unlock_cycles() {
        let fs = InMemoryFs::new();
        let mut manager = SessionManager::new(fs);
        manager.init_storage();
        manager.create_session("password").unwrap();
        manager.write_data(0, b"persistent").unwrap();

        // Lock and unlock many times
        for _ in 0..100 {
            manager.lock();
            manager.unlock_session("password").unwrap();
        }

        // Data should still be there
        assert_eq!(manager.read_data(0, 10).unwrap(), b"persistent");
    }

    /// Test: SlotContent at boundary values
    #[test]
    fn slot_content_boundary_values() {
        // Max u64 address
        let max_addr = SlotContent::new(u64::MAX, 0);
        let bytes = max_addr.to_bytes();
        let recovered = SlotContent::from_bytes(&bytes).unwrap();
        assert_eq!(recovered.address, u64::MAX);

        // Max u32 length
        let max_len = SlotContent::new(0, u32::MAX);
        let bytes = max_len.to_bytes();
        let recovered = SlotContent::from_bytes(&bytes).unwrap();
        assert_eq!(recovered.length, u32::MAX);

        // Both max
        let both_max = SlotContent::new(u64::MAX, u32::MAX);
        let bytes = both_max.to_bytes();
        let recovered = SlotContent::from_bytes(&bytes).unwrap();
        assert_eq!(recovered.address, u64::MAX);
        assert_eq!(recovered.length, u32::MAX);
    }
}

// ============================================================
// 14. DATA INTEGRITY TESTS
// ============================================================

mod data_integrity {
    use super::*;

    /// Test: Data persists across lock/unlock
    #[test]
    fn data_persists_across_lock_unlock() {
        let fs = InMemoryFs::new();
        let mut manager = SessionManager::new(fs);
        manager.init_storage();
        manager.create_session("password").unwrap();

        // Write test pattern
        let test_data: Vec<u8> = (0..1000).map(|i| (i % 256) as u8).collect();
        manager.write_data(0, &test_data).unwrap();
        manager.lock();

        // Unlock and verify
        manager.unlock_session("password").unwrap();
        let read_data = manager.read_data(0, 1000).unwrap();
        assert_eq!(read_data, test_data);
    }

    /// Test: Multiple writes don't corrupt each other
    #[test]
    fn multiple_writes_no_corruption() {
        let fs = InMemoryFs::new();
        let mut manager = SessionManager::new(fs);
        manager.init_storage();
        manager.create_session("password").unwrap();

        // Write pattern: A at 0, B at 100, C at 200
        manager.write_data(0, &vec![b'A'; 50]).unwrap();
        manager.write_data(100, &vec![b'B'; 50]).unwrap();
        manager.write_data(200, &vec![b'C'; 50]).unwrap();

        // Verify each region
        let a_region = manager.read_data(0, 50).unwrap();
        let b_region = manager.read_data(100, 50).unwrap();
        let c_region = manager.read_data(200, 50).unwrap();

        assert!(a_region.iter().all(|&b| b == b'A'));
        assert!(b_region.iter().all(|&b| b == b'B'));
        assert!(c_region.iter().all(|&b| b == b'C'));
    }

    /// Test: Overlapping writes apply correctly
    #[test]
    fn overlapping_writes_apply_correctly() {
        let fs = InMemoryFs::new();
        let mut manager = SessionManager::new(fs);
        manager.init_storage();
        manager.create_session("password").unwrap();

        // Write AAAAAAAAAA at 0
        manager.write_data(0, &vec![b'A'; 10]).unwrap();
        // Write BBBBB at 5 (overlaps)
        manager.write_data(5, &vec![b'B'; 5]).unwrap();

        // Result should be AAAAABBBBB
        let data = manager.read_data(0, 10).unwrap();
        assert_eq!(&data[0..5], &[b'A'; 5]);
        assert_eq!(&data[5..10], &[b'B'; 5]);
    }

    /// Test: Data checksum verification
    #[test]
    fn data_checksum_verification() {
        use std::collections::hash_map::DefaultHasher;
        use std::hash::{Hash, Hasher};

        let fs = InMemoryFs::new();
        let mut manager = SessionManager::new(fs);
        manager.init_storage();
        manager.create_session("password").unwrap();

        // Write random data
        let mut test_data = vec![0u8; 10000];
        crypto_rng::fill_buffer(&mut test_data);

        // Compute checksum
        let mut hasher = DefaultHasher::new();
        test_data.hash(&mut hasher);
        let original_hash = hasher.finish();

        manager.write_data(0, &test_data).unwrap();
        manager.lock();

        // Read back and verify checksum
        manager.unlock_session("password").unwrap();
        let read_data = manager.read_data(0, 10000).unwrap();

        let mut hasher = DefaultHasher::new();
        read_data.hash(&mut hasher);
        let read_hash = hasher.finish();

        assert_eq!(original_hash, read_hash, "Data checksum mismatch");
    }

    /// Test: Session keys are deterministic
    #[test]
    fn session_keys_deterministic() {
        let keys1 = SessionKeys::derive("test_password").unwrap();
        let keys2 = SessionKeys::derive("test_password").unwrap();

        // Indices should match
        assert_eq!(keys1.indices, keys2.indices);

        // Keys for same positions should match
        for i in 0..SLOTS_PER_SESSION {
            let key1 = keys1.get_key(i).unwrap();
            let key2 = keys2.get_key(i).unwrap();
            assert_eq!(key1.as_bytes(), key2.as_bytes());
        }
    }

    /// Test: Encryption is deterministic for same inputs
    #[test]
    fn encryption_deterministic_with_same_key() {
        let keys = SessionKeys::derive("password").unwrap();
        let slot_key = keys.get_key(0).unwrap();
        let content = SlotContent::new(12345, 6789);

        // Note: AES-SIV with same key and plaintext produces same ciphertext
        // (when using zero nonce as we do for slots)
        let encrypted1 = encrypt_slot(&content, slot_key).unwrap();
        let encrypted2 = encrypt_slot(&content, slot_key).unwrap();

        assert_eq!(encrypted1, encrypted2, "Same inputs should produce same output in SIV mode");
    }
}

// ============================================================
// 15. STRESS TESTS
// ============================================================

mod stress_tests {
    use super::*;

    /// Test: Many small writes
    #[test]
    fn many_small_writes() {
        let fs = InMemoryFs::new();
        let mut manager = SessionManager::new(fs);
        manager.init_storage();
        manager.create_session("password").unwrap();

        // 1000 small writes of 10 bytes each
        for i in 0..1000 {
            let offset = i * 10;
            manager.write_data(offset as u64, &[i as u8; 10]).unwrap();
        }

        // Verify random samples
        for i in [0, 100, 500, 999] {
            let offset = i * 10;
            let data = manager.read_data(offset as u64, 10).unwrap();
            assert!(data.iter().all(|&b| b == i as u8), "Mismatch at offset {}", offset);
        }
    }

    /// Test: Rapid lock/unlock
    #[test]
    #[ignore] // Slow due to Argon2id - run with: cargo test -- --ignored
    fn rapid_lock_unlock() {
        let fs = InMemoryFs::new();
        let mut manager = SessionManager::new(fs);
        manager.init_storage();
        manager.create_session("password").unwrap();

        for i in 0..50 {
            manager.lock();
            manager.unlock_session("password").unwrap();

            // Verify session still works
            manager.write_data(i as u64, &[i as u8]).unwrap();
        }
    }

    /// Test: Alternating sessions
    #[test]
    #[ignore] // Slow due to Argon2id - run with: cargo test -- --ignored
    fn alternating_sessions() {
        let fs = InMemoryFs::new();
        let mut manager = SessionManager::new(fs);
        manager.init_storage();

        manager.create_session("A").unwrap();
        manager.lock();
        manager.create_session("B").unwrap();
        manager.lock();

        // Alternate between sessions
        for _ in 0..20 {
            manager.unlock_session("A").unwrap();
            manager.lock();
            manager.unlock_session("B").unwrap();
            manager.lock();
        }

        // Both should still work
        assert!(manager.unlock_session("A").is_ok());
        manager.lock();
        assert!(manager.unlock_session("B").is_ok());
    }

    /// Test: Fill addressing blob usage
    #[test]
    fn addressing_blob_fill_test() {
        // Verify addressing blob can handle the slot allocations
        let mut blob = AddressingBlob::new_random();

        // Write to many slots
        for i in 0..1000 {
            let slot = EncryptedSlot::new_random();
            assert!(blob.set_slot(i, &slot));
        }

        // Read them back
        for i in 0..1000 {
            assert!(blob.get_slot(i).is_some());
        }
    }

    /// Test: Session key derivation performance (ensure it completes)
    #[test]
    fn key_derivation_completes() {
        // Argon2id can be slow; ensure it completes in reasonable time
        let start = std::time::Instant::now();

        let _keys = SessionKeys::derive("test_password").unwrap();

        let elapsed = start.elapsed();
        // Should complete within 30 seconds (Argon2id is intentionally slow)
        assert!(elapsed.as_secs() < 30, "Key derivation took too long: {:?}", elapsed);
    }

    /// Test: Large number of slot indices remain unique
    #[test]
    #[ignore] // Slow due to Argon2id - run with: cargo test -- --ignored
    fn slot_indices_uniqueness_across_passwords() {
        let mut all_indices: HashSet<u16> = HashSet::new();

        // Generate indices for 100 different passwords
        for i in 0..100 {
            let password = format!("password_{}", i);
            let master = derive_master_key(&password).unwrap();
            let indices = derive_slot_indices(&master);

            // Each password's indices should be unique within themselves
            let unique: HashSet<_> = indices.iter().cloned().collect();
            assert_eq!(unique.len(), SLOTS_PER_SESSION);

            // Track all indices seen
            all_indices.extend(indices.iter().cloned());
        }

        // With 100 passwords × 46 indices = 4600 indices
        // Expected unique: ~4600 (very few collisions expected)
        // Actual unique will be slightly less due to some overlap
        assert!(
            all_indices.len() > 4000,
            "Too many collisions: only {} unique indices from 4600",
            all_indices.len()
        );
    }
}
