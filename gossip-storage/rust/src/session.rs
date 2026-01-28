//! Session management for plausible deniability storage.
//!
//! Manages the lifecycle of an encrypted session:
//! - Create new session (writes to addressing blob with Pareto padding)
//! - Unlock existing session (scans addressing blob, self-heals corrupted slots)
//! - Lock session (zeroizes all sensitive data)
//! - VFS operations (read/write via BlockManager)
//!
//! # Security Properties
//!
//! - **Zeroize on lock**: All sensitive data (keys, decrypted blocks, buffers)
//!   is securely cleared when `lock()` is called
//! - **Self-healing slots**: On unlock, corrupted slots are automatically
//!   repaired without user intervention (Fix 4)
//! - **Constant-time unlock**: All 46 slots are scanned regardless of which
//!   slot decrypts first, preventing timing attacks
//! - **Pareto padding**: Random padding before root block hides session boundaries

// Note: Session keys use ZeroizeOnDrop automatically

use crate::blob::{
    AddressingBlob, SlotContent, generate_pareto_padding_with_config, write_random_padding,
    ADDRESSING_BLOB_SIZE, SLOT_SIZE, SLOTS_PER_SESSION,
};
use crate::block_manager::{BlockManager, BlockError};
use crate::config::StorageConfig;
use crate::crypto::{encrypt_slot, unlock_with_keys, SessionKeys, CryptoError};
use crate::fs::{FileSystem, FILE_ADDRESSING, FILE_DATA};

/// Session state
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionState {
    /// No session active
    Locked,
    /// Session is active with decrypted access
    Unlocked,
}

/// Error types for session operations
#[derive(Debug, thiserror::Error)]
pub enum SessionError {
    #[error("Session is locked")]
    SessionLocked,
    #[error("Session already unlocked")]
    AlreadyUnlocked,
    #[error("Invalid password")]
    InvalidPassword,
    #[error("Crypto error: {0}")]
    Crypto(#[from] CryptoError),
    #[error("Block error: {0}")]
    Block(#[from] BlockError),
    #[error("Storage error: {0}")]
    Storage(String),
    #[error("Corrupted data")]
    CorruptedData,
}

/// Active session with decrypted keys and block manager
pub struct Session<F: FileSystem> {
    /// Session keys for slot encryption (zeroized on drop)
    keys: SessionKeys,
    /// Block manager for encrypted data operations
    block_manager: BlockManager<F>,
    /// Last flushed root block address (to avoid unnecessary rewrites)
    last_flushed_root_address: u64,
    /// Last flushed root block length (to avoid unnecessary rewrites)
    last_flushed_root_length: u32,
}

impl<F: FileSystem> Session<F> {
    /// Get the root block address in data blob
    #[must_use]
    pub fn root_address(&self) -> u64 {
        self.block_manager.root_address()
    }

    /// Get the root block length (encrypted size)
    #[must_use]
    pub fn root_length(&self) -> u32 {
        self.block_manager.root_outer_length()
    }

    /// Get the logical data size
    #[must_use]
    pub fn logical_size(&self) -> u64 {
        self.block_manager.logical_size()
    }

    /// Get debug info about allocation table
    #[must_use]
    pub fn debug_allocation_info(&self) -> String {
        self.block_manager.debug_allocation_info()
    }

    /// Get session keys (for internal use)
    #[allow(dead_code)]
    pub(crate) fn keys(&self) -> &SessionKeys {
        &self.keys
    }
}

/// Session manager - handles create/unlock/lock lifecycle
pub struct SessionManager<F: FileSystem> {
    /// Filesystem backend
    fs: F,
    /// Storage configuration
    config: StorageConfig,
    /// Current active session (if any)
    session: Option<Session<F>>,
}

impl<F: FileSystem + Clone> SessionManager<F> {
    /// Create a new session manager with the given filesystem and default config
    pub fn new(fs: F) -> Self {
        Self::with_config(fs, StorageConfig::default())
    }

    /// Create a new session manager with custom configuration
    pub fn with_config(fs: F, config: StorageConfig) -> Self {
        Self { fs, config, session: None }
    }

    /// Get current session state
    #[must_use]
    pub fn state(&self) -> SessionState {
        if self.session.is_some() {
            SessionState::Unlocked
        } else {
            SessionState::Locked
        }
    }

    /// Check if a session is active
    #[must_use]
    pub fn is_unlocked(&self) -> bool {
        self.session.is_some()
    }

    /// Get the active session (if any)
    #[must_use]
    pub fn session(&self) -> Option<&Session<F>> {
        self.session.as_ref()
    }

    /// Initialize storage with random data (first-time setup)
    /// Creates addressing.bin (2MB random) and data.bin (empty)
    pub fn init_storage(&mut self) {
        // Check if addressing blob already exists
        let size = self.fs.get_size(FILE_ADDRESSING);
        if size == ADDRESSING_BLOB_SIZE as u64 {
            // Already initialized
            return;
        }

        // Create 2MB random addressing blob
        let blob = AddressingBlob::new_random();
        self.fs.write_bytes(FILE_ADDRESSING, 0, blob.as_bytes());
        self.fs.flush(FILE_ADDRESSING);
    }

    /// Create a new session with the given password
    ///
    /// This:
    /// 1. Generates Pareto padding before the root block
    /// 2. Creates a BlockManager for encrypted data storage
    /// 3. Writes encrypted slot pointers to the addressing blob
    pub fn create_session(&mut self, password: &str) -> Result<(), SessionError> {
        if self.session.is_some() {
            return Err(SessionError::AlreadyUnlocked);
        }

        // Derive session keys
        let keys = SessionKeys::derive(password)?;

        // Generate Pareto padding before root block
        let pareto_padding = generate_pareto_padding_with_config(self.config.padding());
        let current_size = self.fs.get_size(FILE_DATA);
        write_random_padding(
            &mut self.fs,
            FILE_DATA,
            current_size,
            pareto_padding,
        );

        // Root block starts after padding
        let root_address = current_size
            .checked_add(pareto_padding)
            .ok_or_else(|| SessionError::Storage("Root address overflow".to_string()))?;

        // Create BlockManager (creates initial empty root block)
        let block_manager = BlockManager::new(
            self.fs.clone(),
            keys.session_key().clone(),
            root_address,
            self.config,
        );

        // Get root block length after creation
        let root_length = block_manager.root_outer_length();

        // Create slot content pointing to root block
        let content = SlotContent::new(root_address, root_length);

        // Encrypt and write to all 46 slots
        for position in 0..SLOTS_PER_SESSION {
            let (slot_index, key) = keys.get_slot_info(position)
                .ok_or(SessionError::CorruptedData)?;

            let encrypted = encrypt_slot(&content, key)?;

            // Write to addressing blob
            let offset = slot_index as u64 * SLOT_SIZE as u64;
            self.fs.write_bytes(FILE_ADDRESSING, offset, &encrypted);
        }

        self.fs.flush(FILE_ADDRESSING);

        // Store session with initial tracking values
        self.session = Some(Session {
            keys,
            block_manager,
            last_flushed_root_address: root_address,
            last_flushed_root_length: root_length,
        });

        Ok(())
    }


/// Unlock an existing session with the given password
///
/// 1. Scans all 46 slots (constant-time AEAD decryption)
/// 2. For each valid slot, verifies:
///    - Bounds check: address + length <= data_blob_size
///    - Root block decryption succeeds (only once, then compare)
/// 3. Uses first successful candidate
/// 4. Self-heals ONLY corrupted slots
pub fn unlock_session(&mut self, password: &str) -> Result<(), SessionError> {
    if self.session.is_some() {
        return Err(SessionError::AlreadyUnlocked);
    }

    let keys = SessionKeys::derive(password)?;
    let unlock = unlock_with_keys(&keys, |slot_index| {
        let offset = slot_index as u64 * SLOT_SIZE as u64;
        let encrypted_bytes = self.fs.read_bytes(FILE_ADDRESSING, offset, SLOT_SIZE as u32);
        let mut encrypted = [0u8; SLOT_SIZE];
        if encrypted_bytes.len() == SLOT_SIZE {
            encrypted.copy_from_slice(&encrypted_bytes);
        }
        encrypted
    });

    if unlock.valid_slots.is_empty() {
        return Err(SessionError::InvalidPassword);
    }

    // Start with slots that failed AEAD decryption
    let mut corrupted_positions: Vec<usize> = unlock.slot_decrypt_failed;

    // Get data blob size for bounds checking
    let data_blob_size = self.fs.get_size(FILE_DATA);

    // Verify each valid slot and track corrupted ones
    // Continue through ALL candidates even after finding success (timing-safe)
    let mut successful_result: Option<(u64, u32)> = None;

    for (position, content) in &unlock.valid_slots {
        // Check 1: Bounds check (address + length <= data_blob_size)
        let end = content.address.checked_add(content.length as u64);
        if end.map_or(true, |end| end > data_blob_size) {
            corrupted_positions.push(*position);
            continue;
        }

        // Check 2: Verify slot content
        if let Some((verified_addr, verified_len)) = successful_result {
            // Already have a successful decrypt — just compare address/length
            // All valid slots should point to the same root block
            if content.address != verified_addr || content.length != verified_len {
                corrupted_positions.push(*position);
            }
            // Matching address/length = valid, no action needed
        } else {
            // First valid slot with valid bounds — try to decrypt root block
            let encrypted_root = self.fs.read_bytes(
                FILE_DATA,
                content.address,
                content.length,
            );

            if crate::crypto::decrypt_root_block(&encrypted_root, keys.session_key()).is_ok() {
                successful_result = Some((content.address, content.length));
            } else {
                // Root block decryption failed
                corrupted_positions.push(*position);
            }
        }
    }

    // If no valid candidate found, wrong password or all data corrupted
    let (root_address, root_length) = successful_result
        .ok_or(SessionError::InvalidPassword)?;

    // Now load BlockManager with the verified address/length
    let block_manager = BlockManager::load(
        self.fs.clone(),
        keys.session_key().clone(),
        root_address,
        root_length,
        self.config,
    )?;

    // Get current root block info (should match what we verified)
    let current_address = block_manager.root_address();
    let current_length = block_manager.root_outer_length();

    // Self-healing: rewrite ONLY corrupted slots
    if !corrupted_positions.is_empty() {
        let content = SlotContent::new(current_address, current_length);

        // Rewrite ONLY corrupted slots, not all 46
        for position in &corrupted_positions {
            if let Some((slot_index, key)) = keys.get_slot_info(*position) {
                if let Ok(encrypted) = encrypt_slot(&content, key) {
                    let offset = slot_index as u64 * SLOT_SIZE as u64;
                    self.fs.write_bytes(FILE_ADDRESSING, offset, &encrypted);
                }
            }
        }
        self.fs.flush(FILE_ADDRESSING);
    }

    // Store session with tracking values set to current root block
    self.session = Some(Session {
        keys,
        block_manager,
        last_flushed_root_address: current_address,
        last_flushed_root_length: current_length,
    });

    Ok(())
}

    /// Lock the current session
    ///
    /// This zeroizes all sensitive data (Fixes 5 & 7):
    /// - Session keys (via ZeroizeOnDrop)
    /// - BlockManager cache and buffers
    pub fn lock(&mut self) {
        if let Some(mut session) = self.session.take() {
            // Flush pending writes first
            let _ = session.block_manager.flush();

            // Get current root block info
            let root_address = session.block_manager.root_address();
            let root_length = session.block_manager.root_outer_length();

            // Only rewrite slots if root block changed since last flush 
            if root_address != session.last_flushed_root_address
                || root_length != session.last_flushed_root_length
            {
                let content = SlotContent::new(root_address, root_length);

                for position in 0..SLOTS_PER_SESSION {
                    if let Some((slot_index, key)) = session.keys.get_slot_info(position) {
                        if let Ok(encrypted) = encrypt_slot(&content, key) {
                            let offset = slot_index as u64 * SLOT_SIZE as u64;
                            self.fs.write_bytes(FILE_ADDRESSING, offset, &encrypted);
                        }
                    }
                }
                self.fs.flush(FILE_ADDRESSING);
            }

            // Zero block manager sensitive data
            session.block_manager.zeroize_sensitive();

            // Session keys are automatically zeroized when dropped
            // (SessionKeys derives ZeroizeOnDrop)
        }
    }

    /// Read bytes from session data (for VFS)
    ///
    /// Delegates to BlockManager for decryption and caching
    #[must_use]
    pub fn read_data(&mut self, offset: u64, len: u32) -> Result<Vec<u8>, SessionError> {
        let session = self.session.as_mut().ok_or(SessionError::SessionLocked)?;
        session.block_manager.read(offset, len)
            .map_err(SessionError::from)
    }

    /// Write bytes to session data (for VFS)
    ///
    /// Delegates to BlockManager for encryption and block management
    pub fn write_data(&mut self, offset: u64, data: &[u8]) -> Result<(), SessionError> {
        let session = self.session.as_mut().ok_or(SessionError::SessionLocked)?;
        session.block_manager.write(offset, data)
            .map_err(SessionError::from)
    }

    /// Flush all pending writes to disk
    ///
    /// Updates root block and addressing slots only if root block changed
    pub fn flush_data(&mut self) -> Result<(), SessionError> {
        let session = self.session.as_mut().ok_or(SessionError::SessionLocked)?;

        // Flush block manager (finalizes blocks, updates root block)
        session.block_manager.flush()?;

        // Get current root block info
        let root_address = session.block_manager.root_address();
        let root_length = session.block_manager.root_outer_length();

        // Only rewrite slots if root block changed 
        if root_address != session.last_flushed_root_address
            || root_length != session.last_flushed_root_length
        {
            let content = SlotContent::new(root_address, root_length);

            // Update all 46 slots
            for position in 0..SLOTS_PER_SESSION {
                if let Some((slot_index, key)) = session.keys.get_slot_info(position) {
                    if let Ok(encrypted) = encrypt_slot(&content, key) {
                        let offset = slot_index as u64 * SLOT_SIZE as u64;
                        self.fs.write_bytes(FILE_ADDRESSING, offset, &encrypted);
                    }
                }
            }
            self.fs.flush(FILE_ADDRESSING);

            // Update tracking values
            session.last_flushed_root_address = root_address;
            session.last_flushed_root_length = root_length;
        }

        Ok(())
    }

    /// Get logical data size (what SQLite thinks the file size is)
    #[must_use]
    pub fn data_size(&self) -> Result<u64, SessionError> {
        let session = self.session.as_ref().ok_or(SessionError::SessionLocked)?;
        Ok(session.block_manager.logical_size())
    }
}

// ============================================================
// TESTS
// ============================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fs::InMemoryFs;

    #[test]
    fn test_session_lifecycle() {
        let fs = InMemoryFs::new();
        let mut manager = SessionManager::new(fs);

        // Initialize storage
        manager.init_storage();

        // Should be locked initially
        assert_eq!(manager.state(), SessionState::Locked);

        // Create a new session
        manager.create_session("my_password").unwrap();
        assert_eq!(manager.state(), SessionState::Unlocked);

        // Lock the session
        manager.lock();
        assert_eq!(manager.state(), SessionState::Locked);

        // Unlock with correct password
        manager.unlock_session("my_password").unwrap();
        assert_eq!(manager.state(), SessionState::Unlocked);
    }

    #[test]
    fn test_unlock_wrong_password() {
        let fs = InMemoryFs::new();
        let mut manager = SessionManager::new(fs);

        manager.init_storage();
        manager.create_session("correct_password").unwrap();
        manager.lock();

        // Try to unlock with wrong password
        let result = manager.unlock_session("wrong_password");
        assert!(result.is_err());
        assert_eq!(manager.state(), SessionState::Locked);
    }

    #[test]
    fn test_read_write_data() {
        let fs = InMemoryFs::new();
        let mut manager = SessionManager::new(fs);

        manager.init_storage();
        manager.create_session("password").unwrap();

        // Write some data at offset 0
        let test_data = vec![1, 2, 3, 4, 5];
        manager.write_data(0, &test_data).unwrap();

        // Read it back (before flush - should be in write buffer)
        let read_data = manager.read_data(0, 5).unwrap();
        assert_eq!(read_data, test_data);

        // Flush and read again
        manager.flush_data().unwrap();
        let read_data = manager.read_data(0, 5).unwrap();
        assert_eq!(read_data, test_data);
    }

    #[test]
    fn test_read_write_requires_session() {
        let fs = InMemoryFs::new();
        let mut manager = SessionManager::new(fs);

        manager.init_storage();

        // Should fail without session
        assert!(manager.read_data(0, 10).is_err());
        assert!(manager.write_data(0, &[1, 2, 3]).is_err());
    }

    #[test]
    fn test_data_persists_after_lock_unlock() {
        let fs = InMemoryFs::new();
        let mut manager = SessionManager::new(fs);

        manager.init_storage();
        manager.create_session("password").unwrap();

        // Write and flush
        manager.write_data(0, b"Hello, World!").unwrap();
        manager.flush_data().unwrap();

        // Lock
        manager.lock();
        assert_eq!(manager.state(), SessionState::Locked);

        // Unlock and verify data
        manager.unlock_session("password").unwrap();
        let data = manager.read_data(0, 13).unwrap();
        assert_eq!(data, b"Hello, World!");
    }

    #[test]
    fn test_multiple_sessions_different_passwords() {
        let fs = InMemoryFs::new();
        let mut manager = SessionManager::new(fs);

        manager.init_storage();

        // Create session with password A
        manager.create_session("password_a").unwrap();
        // Write some data
        manager.write_data(0, &[1, 2, 3, 4, 5]).unwrap();
        manager.flush_data().unwrap();
        // Capture address AFTER flush (root block may have moved)
        let addr_a = manager.session().unwrap().root_address();
        manager.lock();

        // Create another session with password B
        manager.create_session("password_b").unwrap();
        manager.flush_data().unwrap();
        let addr_b = manager.session().unwrap().root_address();
        manager.lock();

        // Both sessions should exist at different addresses
        // (due to Pareto padding + data from session A)
        assert_ne!(addr_a, addr_b);

        // Can unlock either session and verify data persists
        manager.unlock_session("password_a").unwrap();
        let data = manager.read_data(0, 5).unwrap();
        assert_eq!(data, vec![1, 2, 3, 4, 5]);
        manager.lock();

        // Password B session should also work
        manager.unlock_session("password_b").unwrap();
        assert!(manager.is_unlocked());
    }

    #[test]
    fn test_large_write_creates_blocks() {
        use crate::config::PaddingValues;

        let padding = &PaddingValues::TEST;
        let fs = InMemoryFs::new();
        let mut manager = SessionManager::new(fs);

        manager.init_storage();
        manager.create_session("password").unwrap();

        // Write more than block_size_min
        let large_data = vec![42u8; padding.block_size_min + 1000];
        manager.write_data(0, &large_data).unwrap();
        manager.flush_data().unwrap();

        // Read back
        let read_data = manager.read_data(0, large_data.len() as u32).unwrap();
        assert_eq!(read_data, large_data);
    }

    #[test]
    fn test_pareto_padding_applied() {
        use crate::config::PaddingValues;

        let padding = &PaddingValues::TEST;
        let fs = InMemoryFs::new();
        let mut manager = SessionManager::new(fs.clone());

        manager.init_storage();

        // Check data blob size before session
        let size_before = fs.get_size(FILE_DATA);
        assert_eq!(size_before, 0);

        // Create session (should add Pareto padding)
        manager.create_session("password").unwrap();

        // Root address should be >= pareto_min due to Pareto padding
        let root_addr = manager.session().unwrap().root_address();
        assert!(root_addr >= padding.pareto_min, "Root address {} should be >= {} (Pareto min)", root_addr, padding.pareto_min);
    }

    #[test]
    fn test_self_healing_only_corrupted_slots() {
        use crate::blob::SLOT_SIZE;

        let fs = InMemoryFs::new();
        let mut manager = SessionManager::new(fs.clone());

        manager.init_storage();
        manager.create_session("password").unwrap();
        manager.flush_data().unwrap();

        // Get slot indices BEFORE lock (to avoid extra Argon2id)
        let corrupted_positions = [5usize, 17, 42];
        let slot_indices: Vec<u16> = corrupted_positions
            .iter()
            .map(|&pos| manager.session().unwrap().keys().indices[pos])
            .collect();

        manager.lock();

        // Corrupt 3 specific slots using pre-captured indices
        for (i, &slot_index) in slot_indices.iter().enumerate() {
            let offset = slot_index as u64 * SLOT_SIZE as u64;
            // Write garbage data to corrupt the slot
            let mut garbage = [0xFFu8; SLOT_SIZE];
            garbage[0] = i as u8; // Make each corruption unique
            fs.clone().write_bytes(FILE_ADDRESSING, offset, &garbage);
        }

        // Reset write counter to track only healing writes
        fs.reset_write_count(FILE_ADDRESSING);

        // Unlock should self-heal only corrupted slots
        manager.unlock_session("password").unwrap();

        let writes = fs.write_count(FILE_ADDRESSING);

        // Should have written only 3 slots (corrupted ones)
        assert_eq!(writes, 3,
            "Should rewrite only 3 corrupted slots, not all 46. Got {} writes", writes);
    }

    #[test]
    fn test_flush_no_rewrite_if_unchanged() {
        let fs = InMemoryFs::new();
        let mut manager = SessionManager::new(fs.clone());

        manager.init_storage();
        manager.create_session("password").unwrap();
        manager.write_data(0, b"test").unwrap();
        manager.flush_data().unwrap();

        // Reset counter after initial flush
        fs.reset_write_count(FILE_ADDRESSING);

        // Flush again without changes
        manager.flush_data().unwrap();

        let writes = fs.write_count(FILE_ADDRESSING);

        assert_eq!(writes, 0,
            "flush_data() should not rewrite slots if root unchanged. Got {} writes", writes);
    }

    #[test]
    fn test_lock_no_double_rewrite() {
        let fs = InMemoryFs::new();
        let mut manager = SessionManager::new(fs.clone());

        manager.init_storage();
        manager.create_session("password").unwrap();
        manager.write_data(0, b"test").unwrap();
        manager.flush_data().unwrap();

        // Reset counter after flush
        fs.reset_write_count(FILE_ADDRESSING);

        // Lock should not rewrite (already flushed, no changes)
        manager.lock();

        let writes = fs.write_count(FILE_ADDRESSING);

        assert_eq!(writes, 0,
            "lock() should not rewrite slots if already flushed. Got {} writes", writes);
    }

    #[test]
    fn test_lock_rewrites_if_changes_after_flush() {
        let fs = InMemoryFs::new();
        let mut manager = SessionManager::new(fs.clone());

        manager.init_storage();
        manager.create_session("password").unwrap();
        manager.flush_data().unwrap();

        // Write more data AFTER flush
        manager.write_data(0, b"more data").unwrap();

        // Reset counter
        fs.reset_write_count(FILE_ADDRESSING);

        // Lock should rewrite because there are unflushed changes
        manager.lock();

        let writes = fs.write_count(FILE_ADDRESSING);

        // Should have written all 46 slots
        assert_eq!(writes, SLOTS_PER_SESSION,
            "lock() should rewrite all 46 slots when there are unflushed changes. Got {} writes", writes);
    }

    #[test]
    fn test_self_healing_detects_out_of_bounds_address() {
        //  slots pointing to address + length > data_blob_size
        // should be marked as corrupted and healed
        use crate::blob::SLOT_SIZE;
        use crate::crypto::{encrypt_slot, SessionKeys};

        let fs = InMemoryFs::new();
        let mut manager = SessionManager::new(fs.clone());

        manager.init_storage();
        manager.create_session("password").unwrap();
        manager.flush_data().unwrap();

        // Get valid root address/length and slot indices BEFORE lock
        let root_address = manager.session().unwrap().root_address();
        let root_length = manager.session().unwrap().root_length();
        let bad_position = 10usize;
        let slot_index = manager.session().unwrap().keys().indices[bad_position];

        manager.lock();

        // Re-derive keys to write a bad slot (points to out-of-bounds address)
        let keys = SessionKeys::derive("password").unwrap();
        let bad_content = SlotContent::new(u64::MAX - 100, root_length); // Way out of bounds
        let key = keys.get_key(bad_position).unwrap();
        let encrypted = encrypt_slot(&bad_content, key).unwrap();
        let offset = slot_index as u64 * SLOT_SIZE as u64;
        fs.clone().write_bytes(FILE_ADDRESSING, offset, &encrypted);

        // Reset write counter
        fs.reset_write_count(FILE_ADDRESSING);

        // Unlock should detect the out-of-bounds slot and heal it
        manager.unlock_session("password").unwrap();

        let writes = fs.write_count(FILE_ADDRESSING);

        // Should have healed the one bad slot
        assert_eq!(writes, 1,
            "Should heal 1 out-of-bounds slot. Got {} writes", writes);

        // Verify the session works correctly (uses valid slots)
        assert_eq!(manager.session().unwrap().root_address(), root_address);
    }

    #[test]
    fn test_self_healing_detects_corrupted_root_block() {
        //  slots pointing to corrupted root block data
        // should be marked as corrupted and healed
        use crate::blob::SLOT_SIZE;
        use crate::crypto::{encrypt_slot, SessionKeys};

        let fs = InMemoryFs::new();
        let mut manager = SessionManager::new(fs.clone());

        manager.init_storage();
        manager.create_session("password").unwrap();
        manager.write_data(0, b"test data").unwrap();
        manager.flush_data().unwrap();

        // Get slot index BEFORE lock (to avoid extra Argon2id)
        let bad_position = 20usize;
        let slot_index = manager.session().unwrap().keys().indices[bad_position];

        manager.lock();

        // Write garbage where a fake "root block" would be
        let fake_address = fs.get_size(FILE_DATA); // Just past current data
        let fake_length = 64u32;
        fs.clone().write_bytes(FILE_DATA, fake_address, &[0xDE; 64]); // Garbage

        // Re-derive keys to write a slot pointing to the garbage
        let keys = SessionKeys::derive("password").unwrap();
        let bad_content = SlotContent::new(fake_address, fake_length);
        let key = keys.get_key(bad_position).unwrap();
        let encrypted = encrypt_slot(&bad_content, key).unwrap();
        let offset = slot_index as u64 * SLOT_SIZE as u64;
        fs.clone().write_bytes(FILE_ADDRESSING, offset, &encrypted);

        // Reset write counter
        fs.reset_write_count(FILE_ADDRESSING);

        // Unlock should detect the bad root block and heal the slot
        manager.unlock_session("password").unwrap();

        let writes = fs.write_count(FILE_ADDRESSING);

        // Should have healed the one bad slot
        assert_eq!(writes, 1,
            "Should heal 1 slot with corrupted root block. Got {} writes", writes);

        // Verify data is intact (used valid slots)
        let data = manager.read_data(0, 9).unwrap();
        assert_eq!(data, b"test data");
    }
}
