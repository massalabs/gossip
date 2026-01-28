//! Cryptographic operations for slot encryption/decryption.
//!
//! Uses crypto crates from wasm/ folder:
//! - crypto-password-kdf: Argon2id for password → master key
//! - crypto-kdf: HKDF-SHA256 for key derivation
//! - crypto-aead: AES-256-SIV for authenticated encryption
//! - crypto-rng: Secure random number generation
//!
//! # Security Properties
//!
//! - **Zeroize on drop**: All key types (`MasterKey`, `SlotKey`, `SessionAeadKey`,
//!   `BlockKey`, `SessionKeys`) implement `ZeroizeOnDrop` to securely clear
//!   sensitive material from memory
//! - **Constant-time slot scanning**: `unlock_session` always scans all 46 slots
//!   regardless of success/failure, preventing timing attacks
//! - **Nonce-misuse resistance**: AES-256-SIV mode is safe even with zero nonces
//!   because each slot/block has a unique derived key
//! - **Domain separation**: All key derivations use distinct labels ("slot-{i}",
//!   "addr-key-{i}", "aead") preventing key reuse across different purposes

use zeroize::{Zeroize, ZeroizeOnDrop};

use crate::blob::{SlotContent, SLOT_SIZE, SLOTS_PER_SESSION};

/// Error types for crypto operations
#[derive(Debug, thiserror::Error)]
pub enum CryptoError {
    #[error("Key derivation failed")]
    KeyDerivationFailed,
    #[error("Encryption failed")]
    EncryptionFailed,
    #[error("Decryption failed")]
    DecryptionFailed,
    #[error("Invalid authentication tag")]
    InvalidTag,
    #[error("Invalid ciphertext length")]
    InvalidLength,
}

/// Domain separation constants
const PASSWORD_KDF_SALT: &[u8] = b"gossip-storage-password-v1";
const KEY_DERIVATION_SALT: &[u8] = b"gossip-storage-kdf-v1";

/// Master key derived from password (64 bytes)
/// Used to derive session keys via HKDF
/// Automatically zeroized on drop
#[derive(Zeroize, ZeroizeOnDrop)]
pub struct MasterKey([u8; 64]);

impl MasterKey {
    /// Get the key bytes
    #[must_use]
    pub fn as_bytes(&self) -> &[u8; 64] {
        &self.0
    }
}

/// Per-slot key for AES-256-SIV (64 bytes = two 256-bit keys)
/// Automatically zeroized on drop
#[derive(Zeroize, ZeroizeOnDrop)]
pub struct SlotKey(pub(crate) [u8; 64]);

impl SlotKey {
    /// Get the key bytes
    #[must_use]
    pub fn as_bytes(&self) -> &[u8; 64] {
        &self.0
    }
}

/// Session AEAD key for encrypting data blocks (64 bytes)
/// Automatically zeroized on drop
#[derive(Zeroize, ZeroizeOnDrop)]
pub struct SessionAeadKey([u8; 64]);

impl SessionAeadKey {
    /// Get the key bytes
    #[must_use]
    pub fn as_bytes(&self) -> &[u8; 64] {
        &self.0
    }

    /// Manually zeroize the key
    pub fn zeroize_key(&mut self) {
        self.0.zeroize();
    }
}

impl Clone for SessionAeadKey {
    fn clone(&self) -> Self {
        Self(self.0)
    }
}

/// Block encryption key for data blocks (64 bytes for AES-256-SIV)
/// Automatically zeroized on drop
#[derive(Zeroize, ZeroizeOnDrop)]
pub struct BlockKey([u8; 64]);

impl BlockKey {
    /// Get the key bytes
    #[must_use]
    pub fn as_bytes(&self) -> &[u8; 64] {
        &self.0
    }
}

/// Derive master key from password using Argon2id
///
/// Uses crypto-password-kdf with domain-separated salt
/// Output: 64-byte master key
#[must_use]
pub fn derive_master_key(password: &str) -> Result<MasterKey, CryptoError> {
    let mut key = [0u8; 64];
    crypto_password_kdf::derive(password.as_bytes(), PASSWORD_KDF_SALT, &mut key);
    Ok(MasterKey(key))
}

/// Derive a single slot index from an HKDF expander by position
///
/// Each slot index is derived from label "slot-{i}"
/// Returns the first 2 bytes as a u16
fn derive_slot_index_from_expander(expander: &crypto_kdf::Expand, position: usize) -> u16 {
    let mut bytes = [0u8; 2];
    let label = format!("slot-{}", position);
    expander.expand(label.as_bytes(), &mut bytes);
    u16::from_le_bytes(bytes)
}

/// Derive slot indices from an HKDF expander
///
/// Returns SLOTS_PER_SESSION (46) slot indices
/// Uses labels "slot-0", "slot-1", ..., "slot-45"
/// Note: Indices may collide
/// Internal helper used by SessionKeys::derive()
fn derive_slot_indices_from_expander(expander: &crypto_kdf::Expand) -> [u16; SLOTS_PER_SESSION] {
    std::array::from_fn(|position| derive_slot_index_from_expander(expander, position))
}

/// Derive slot indices from master key using HKDF
///
/// Returns SLOTS_PER_SESSION (46) slot indices
/// Note: For optimized batch derivation, use SessionKeys::derive() instead
#[must_use]
pub fn derive_slot_indices(master: &MasterKey) -> [u16; SLOTS_PER_SESSION] {
    let mut kdf = crypto_kdf::Extract::new(KEY_DERIVATION_SALT);
    kdf.input_item(master.as_bytes());
    let expander = kdf.finalize();
    derive_slot_indices_from_expander(&expander)
}

/// Derive a per-slot key from an HKDF expander by position
///
/// Each slot position (0-45) gets a unique 64-byte key for AES-256-SIV
/// Internal helper used by SessionKeys::derive()
fn derive_slot_key_from_expander(expander: &crypto_kdf::Expand, position: usize) -> SlotKey {
    let mut key = [0u8; 64];
    // Use position-based label for domain separation: "addr-key-0", "addr-key-1", etc.
    let label = format!("addr-key-{}", position);
    expander.expand(label.as_bytes(), &mut key);
    SlotKey(key)
}


/// Derive session AEAD key from master key using HKDF
///
/// Used for encrypting root block directly
/// Uses label "aead"
#[must_use]
pub fn derive_session_aead_key(master: &MasterKey) -> SessionAeadKey {
    let mut kdf = crypto_kdf::Extract::new(KEY_DERIVATION_SALT);
    kdf.input_item(master.as_bytes());
    let expander = kdf.finalize();

    let mut key = [0u8; 64];
    expander.expand(b"aead", &mut key);

    SessionAeadKey(key)
}

/// Derive block-specific key from session AEAD key and block_id
///
/// Each data block has a unique random 32-byte block_id, which is used
/// to derive a unique encryption key via HKDF.
/// kdf(session_key, [block_id]) - block_id is the expand label
///
/// NOTE: Root block does NOT use this - it uses session_aead_key directly
#[must_use]
pub fn derive_block_key(session_key: &SessionAeadKey, block_id: &[u8; 32]) -> BlockKey {
    let mut kdf = crypto_kdf::Extract::new(KEY_DERIVATION_SALT);
    kdf.input_item(session_key.as_bytes());
    let expander = kdf.finalize();

    let mut key = [0u8; 64];
    // Block_id is used as the expand label
    expander.expand(block_id, &mut key);

    BlockKey(key)
}

/// Encrypt a block with AES-256-SIV
///
/// Returns ciphertext with SIV tag prepended (16 bytes tag + plaintext size)
/// Uses zero nonce (safe for SIV with unique key per block)
#[must_use]
pub fn encrypt_block(plaintext: &[u8], key: &BlockKey) -> Vec<u8> {
    let aead_key = crypto_aead::Key::from(*key.as_bytes());
    let nonce = crypto_aead::Nonce::from([0u8; crypto_aead::NONCE_SIZE]);
    crypto_aead::encrypt(&aead_key, &nonce, plaintext, &[])
}

/// Decrypt a block with AES-256-SIV
///
/// Expects SIV tag + ciphertext format
/// Returns plaintext on success, error on authentication failure
#[must_use]
pub fn decrypt_block(ciphertext: &[u8], key: &BlockKey) -> Result<Vec<u8>, CryptoError> {
    let aead_key = crypto_aead::Key::from(*key.as_bytes());
    let nonce = crypto_aead::Nonce::from([0u8; crypto_aead::NONCE_SIZE]);
    crypto_aead::decrypt(&aead_key, &nonce, ciphertext, &[])
        .ok_or(CryptoError::InvalidTag)
}

/// Encrypt root block with session AEAD key directly
///
/// Root block uses session_aead_key directly, NOT a derived block key
#[must_use]
pub fn encrypt_root_block(plaintext: &[u8], session_key: &SessionAeadKey) -> Vec<u8> {
    let aead_key = crypto_aead::Key::from(*session_key.as_bytes());
    let nonce = crypto_aead::Nonce::from([0u8; crypto_aead::NONCE_SIZE]);
    crypto_aead::encrypt(&aead_key, &nonce, plaintext, &[])
}

/// Decrypt root block with session AEAD key directly
///
/// Root block uses session_aead_key directly, NOT a derived block key
#[must_use]
pub fn decrypt_root_block(ciphertext: &[u8], session_key: &SessionAeadKey) -> Result<Vec<u8>, CryptoError> {
    let aead_key = crypto_aead::Key::from(*session_key.as_bytes());
    let nonce = crypto_aead::Nonce::from([0u8; crypto_aead::NONCE_SIZE]);
    crypto_aead::decrypt(&aead_key, &nonce, ciphertext, &[])
        .ok_or(CryptoError::InvalidTag)
}

/// Encrypt slot content with AES-256-SIV
///
/// Input: 12-byte SlotContent
/// Output: 32-byte encrypted slot (16-byte SIV tag + 16-byte ciphertext)
///
/// Note: Uses zero nonce since each slot has a unique key derived from
/// (password, slot_index). SIV mode's nonce-misuse resistance ensures
/// security even with constant nonces when keys are unique.
#[must_use]
pub fn encrypt_slot(content: &SlotContent, key: &SlotKey) -> Result<[u8; SLOT_SIZE], CryptoError> {
    // Pad plaintext to 16 bytes
    let plaintext = content.to_bytes();
    let mut padded = [0u8; 16];
    padded[..SlotContent::SIZE].copy_from_slice(&plaintext);

    // Create key and zero nonce (SIV is nonce-misuse resistant, key is unique per slot)
    let aead_key = crypto_aead::Key::from(*key.as_bytes());
    let nonce = crypto_aead::Nonce::from([0u8; crypto_aead::NONCE_SIZE]);

    // Encrypt with AES-256-SIV
    // Note: crypto-aead adds 16-byte tag, so 16-byte plaintext → 32-byte ciphertext
    let ciphertext = crypto_aead::encrypt(&aead_key, &nonce, &padded, &[]);

    // Result should be 32 bytes: 16-byte tag + 16-byte ciphertext
    if ciphertext.len() != SLOT_SIZE {
        return Err(CryptoError::EncryptionFailed);
    }

    let mut result = [0u8; SLOT_SIZE];
    result.copy_from_slice(&ciphertext);
    Ok(result)
}

/// Decrypt slot content with AES-256-SIV
///
/// Input: 32-byte encrypted slot
/// Output: SlotContent on success, error on authentication failure
///
/// Note: For SIV mode, we use a zero nonce since the tag provides authentication
/// and the key is unique per slot. This is safe for SIV's nonce-misuse resistance.
#[must_use]
pub fn decrypt_slot(encrypted: &[u8; SLOT_SIZE], key: &SlotKey) -> Result<SlotContent, CryptoError> {
    // Create key and zero nonce (SIV is nonce-misuse resistant)
    let aead_key = crypto_aead::Key::from(*key.as_bytes());
    let nonce = crypto_aead::Nonce::from([0u8; crypto_aead::NONCE_SIZE]);

    // Decrypt
    let padded = crypto_aead::decrypt(&aead_key, &nonce, encrypted, &[])
        .ok_or(CryptoError::InvalidTag)?;

    // Parse SlotContent from padded plaintext
    SlotContent::from_bytes(&padded).ok_or(CryptoError::DecryptionFailed)
}

/// Session keys for a single session
/// Contains all 46 slot indices and their corresponding keys
/// Automatically zeroized on drop
#[derive(Zeroize, ZeroizeOnDrop)]
pub struct SessionKeys {
    /// The 46 slot indices this session uses
    #[zeroize(skip)]
    pub indices: [u16; SLOTS_PER_SESSION],
    /// The 46 per-slot keys
    keys: [SlotKey; SLOTS_PER_SESSION],
    /// Session AEAD key for data encryption
    session_key: SessionAeadKey,
}

impl SessionKeys {
    /// Derive all session keys from password
    ///
    /// OPTIMIZED: Uses a single HKDF Extract + multiple Expands
    ///
    /// 1. One Argon2id call: password → master key
    /// 2. One HKDF Extract: master key → expander
    /// 3. Multiple HKDF Expands with labels:
    ///    - "slot-{i}" → 46 slot indices (one per position)
    ///    - "addr-key-{i}" → 46 addressing keys (one per position)
    ///    - "aead" → session AEAD key
    #[must_use]
    pub fn derive(password: &str) -> Result<Self, CryptoError> {
        // Step 1: Argon2id (expensive, only done once)
        let master = derive_master_key(password)?;

        // Step 2: Single HKDF Extract
        let mut kdf = crypto_kdf::Extract::new(KEY_DERIVATION_SALT);
        kdf.input_item(master.as_bytes());
        let expander = kdf.finalize();

        // Step 3a: Derive slot indices (46 expand calls with "slot-{i}" labels)
        let indices = derive_slot_indices_from_expander(&expander);

        // Step 3b: Derive all 46 slot keys (46 expand calls with "addr-key-{i}" labels)
        let keys = std::array::from_fn(|position| {
            derive_slot_key_from_expander(&expander, position)
        });

        // Step 3c: Derive session AEAD key (one expand call with "aead" label)
        let mut session_key_bytes = [0u8; 64];
        expander.expand(b"aead", &mut session_key_bytes);
        let session_key = SessionAeadKey(session_key_bytes);

        Ok(Self {
            indices,
            keys,
            session_key,
        })
    }

    /// Get the key for a specific slot (by position 0-45, not slot index)
    #[must_use]
    pub fn get_key(&self, position: usize) -> Option<&SlotKey> {
        self.keys.get(position)
    }

    /// Get slot index and key together
    #[must_use]
    pub fn get_slot_info(&self, position: usize) -> Option<(u16, &SlotKey)> {
        if position < SLOTS_PER_SESSION {
            Some((self.indices[position], &self.keys[position]))
        } else {
            None
        }
    }

    /// Get the session AEAD key (for BlockManager)
    #[must_use]
    pub fn session_key(&self) -> &SessionAeadKey {
        &self.session_key
    }
}

/// Result of attempting to unlock slots (slot AEAD decryption phase only)
///
/// This is the first phase of unlock. The caller must then:
/// 1. Check bounds for each valid slot (address + length <= data_blob_size)
/// 2. Try to decrypt root block for each valid slot
/// 3. Mark slots as corrupted if either check fails
pub struct UnlockResult {
    /// Successfully decrypted slots: (position, content)
    /// All of these passed slot AEAD decryption
    pub valid_slots: Vec<(usize, SlotContent)>,
    /// Positions (0-45) that failed slot AEAD decryption
    pub slot_decrypt_failed: Vec<usize>,
}

/// Attempt to unlock a session using pre-derived keys (slot AEAD phase)
///
/// CRITICAL: Always scans all 46 slots for constant-time operation
///
/// This performs only slot AEAD decryption.
/// The caller must then verify each valid slot by:
/// 1. Checking bounds (address + length <= data_blob_size)
/// 2. Trying to decrypt the root block
/// Returns None only if get_slot_info fails (should never happen)
#[must_use]
pub fn unlock_with_keys(
    session_keys: &SessionKeys,
    get_slot: impl Fn(u16) -> [u8; SLOT_SIZE],
) -> UnlockResult {
    let mut valid_slots: Vec<(usize, SlotContent)> = Vec::new();
    let mut slot_decrypt_failed: Vec<usize> = Vec::new();

    // ALWAYS iterate all 46 slots - no early exit
    for position in 0..SLOTS_PER_SESSION {
        // get_slot_info should never fail for valid position (0..46)
        let Some((slot_index, key)) = session_keys.get_slot_info(position) else {
            continue;
        };
        let encrypted = get_slot(slot_index);

        // Try to decrypt - continue regardless of success
        if let Ok(decrypted) = decrypt_slot(&encrypted, key) {
            valid_slots.push((position, decrypted));
        } else {
            slot_decrypt_failed.push(position);
        }
    }

    UnlockResult {
        valid_slots,
        slot_decrypt_failed,
    }
}

/// Attempt to unlock a session by scanning all k=46 slots
///
/// CRITICAL: Always scans all 46 slots for constant-time operation
/// Returns the slot content if at least one slot decrypts successfully
#[must_use]
pub fn unlock_session(
    password: &str,
    get_slot: impl Fn(u16) -> [u8; SLOT_SIZE],
) -> Option<UnlockResult> {
    let session_keys = SessionKeys::derive(password).ok()?;
    let result = unlock_with_keys(&session_keys, get_slot);
    // Return None if no slots decrypted (wrong password or all corrupted)
    if result.valid_slots.is_empty() {
        None
    } else {
        Some(result)
    }
}

// ============================================================
// TESTS
// ============================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_master_key_derivation_deterministic() {
        let password = "test_password";

        let key1 = derive_master_key(password).unwrap();
        let key2 = derive_master_key(password).unwrap();

        assert_eq!(key1.as_bytes(), key2.as_bytes());
    }

    #[test]
    fn test_master_key_is_64_bytes() {
        let key = derive_master_key("password").unwrap();
        assert_eq!(key.as_bytes().len(), 64);
    }

    #[test]
    fn test_master_key_different_passwords() {
        let key1 = derive_master_key("password1").unwrap();
        let key2 = derive_master_key("password2").unwrap();

        assert_ne!(key1.as_bytes(), key2.as_bytes());
    }

    #[test]
    fn test_slot_indices_derivation() {
        let master = derive_master_key("password").unwrap();
        let indices = derive_slot_indices(&master);

        // Check we got the right count
        assert_eq!(indices.len(), SLOTS_PER_SESSION);

        // Check all unique
        let unique: std::collections::HashSet<_> = indices.iter().collect();
        assert_eq!(unique.len(), SLOTS_PER_SESSION);

        // Check deterministic
        let indices2 = derive_slot_indices(&master);
        assert_eq!(indices, indices2);
    }

    #[test]
    fn test_session_keys_slot_key_deterministic() {
        // SessionKeys::derive() should be deterministic
        let keys1 = SessionKeys::derive("password").unwrap();
        let keys2 = SessionKeys::derive("password").unwrap();

        // Same password should produce same keys
        for pos in 0..SLOTS_PER_SESSION {
            assert_eq!(
                keys1.get_key(pos).unwrap().as_bytes(),
                keys2.get_key(pos).unwrap().as_bytes()
            );
        }
    }

    #[test]
    fn test_session_keys_different_positions_different_keys() {
        // Different positions should produce different keys
        let keys = SessionKeys::derive("password").unwrap();

        let key0 = keys.get_key(0).unwrap();
        let key1 = keys.get_key(1).unwrap();

        assert_ne!(key0.as_bytes(), key1.as_bytes());
    }

    #[test]
    fn test_encrypt_decrypt_slot_roundtrip() {
        // Test encrypt/decrypt with expected keys
        let keys = SessionKeys::derive("password").unwrap();
        let slot_key = keys.get_key(0).unwrap();

        let content = SlotContent::new(0x123456789ABCDEF0, 0xDEADBEEF);
        let encrypted = encrypt_slot(&content, slot_key).unwrap();

        assert_eq!(encrypted.len(), SLOT_SIZE);

        let decrypted = decrypt_slot(&encrypted, slot_key).unwrap();
        assert_eq!(decrypted.address, content.address);
        assert_eq!(decrypted.length, content.length);
    }

    #[test]
    fn test_decrypt_wrong_key_fails() {
        // Test that wrong key fails decryption
        let keys = SessionKeys::derive("password").unwrap();
        let key0 = keys.get_key(0).unwrap();
        let key1 = keys.get_key(1).unwrap();

        let content = SlotContent::new(100, 200);
        let encrypted = encrypt_slot(&content, key0).unwrap();

        // Should fail with wrong key
        assert!(decrypt_slot(&encrypted, key1).is_err());
    }

    #[test]
    fn test_session_keys_derivation() {
        let keys = SessionKeys::derive("password").unwrap();

        // Should have 46 keys
        assert_eq!(keys.indices.len(), SLOTS_PER_SESSION);

        // All indices should be unique
        let unique: std::collections::HashSet<_> = keys.indices.iter().collect();
        assert_eq!(unique.len(), SLOTS_PER_SESSION);

        // Should be deterministic
        let keys2 = SessionKeys::derive("password").unwrap();
        assert_eq!(keys.indices, keys2.indices);
    }

    #[test]
    fn test_unlock_session_success() {
        let password = "test_password";
        let keys = SessionKeys::derive(password).unwrap();

        // Create encrypted slots
        let content = SlotContent::new(12345, 6789);
        let mut slots: std::collections::HashMap<u16, [u8; SLOT_SIZE]> =
            std::collections::HashMap::new();

        // Encrypt content into all 46 slots
        for position in 0..SLOTS_PER_SESSION {
            let (idx, key) = keys.get_slot_info(position).unwrap();
            let encrypted = encrypt_slot(&content, key).unwrap();
            slots.insert(idx, encrypted);
        }

        // Try to unlock
        let result = unlock_session(password, |idx| {
            slots.get(&idx).copied().unwrap_or([0u8; SLOT_SIZE])
        });

        assert!(result.is_some());
        let result = result.unwrap();
        // All 46 slots should be valid
        assert_eq!(result.valid_slots.len(), SLOTS_PER_SESSION);
        assert!(result.slot_decrypt_failed.is_empty());
        // First valid slot should have correct content
        let (_, first_content) = &result.valid_slots[0];
        assert_eq!(first_content.address, 12345);
        assert_eq!(first_content.length, 6789);
    }

    #[test]
    fn test_unlock_session_wrong_password() {
        let keys = SessionKeys::derive("correct_password").unwrap();

        // Create encrypted slots with correct password
        let content = SlotContent::new(12345, 6789);
        let mut slots: std::collections::HashMap<u16, [u8; SLOT_SIZE]> =
            std::collections::HashMap::new();

        for position in 0..SLOTS_PER_SESSION {
            let (idx, key) = keys.get_slot_info(position).unwrap();
            let encrypted = encrypt_slot(&content, key).unwrap();
            slots.insert(idx, encrypted);
        }

        // Try to unlock with wrong password
        let result = unlock_session("wrong_password", |idx| {
            slots.get(&idx).copied().unwrap_or([0u8; SLOT_SIZE])
        });

        // Should have no valid slots (wrong password = different indices + keys)
        assert!(result.is_some()); // Function returns Some, but with empty valid_slots
        let result = result.unwrap();
        assert!(result.valid_slots.is_empty());
    }

    #[test]
    fn test_block_key_derivation() {
        let master = derive_master_key("password").unwrap();
        let session_key = derive_session_aead_key(&master);

        let block_id1 = [1u8; 32];
        let block_id2 = [2u8; 32];

        let key1 = derive_block_key(&session_key, &block_id1);
        let key2 = derive_block_key(&session_key, &block_id2);

        // Different block IDs should produce different keys
        assert_ne!(key1.as_bytes(), key2.as_bytes());

        // Same block ID should be deterministic
        let key1_again = derive_block_key(&session_key, &block_id1);
        assert_eq!(key1.as_bytes(), key1_again.as_bytes());
    }

    #[test]
    fn test_block_encrypt_decrypt_roundtrip() {
        let master = derive_master_key("password").unwrap();
        let session_key = derive_session_aead_key(&master);
        let block_id = [42u8; 32];
        let block_key = derive_block_key(&session_key, &block_id);

        let plaintext = b"Hello, this is test data for a block!";
        let ciphertext = encrypt_block(plaintext, &block_key);

        // Ciphertext should be 16 bytes larger (SIV tag)
        assert_eq!(ciphertext.len(), plaintext.len() + 16);

        let decrypted = decrypt_block(&ciphertext, &block_key).unwrap();
        assert_eq!(decrypted, plaintext);
    }

    #[test]
    fn test_block_decrypt_wrong_key_fails() {
        let master = derive_master_key("password").unwrap();
        let session_key = derive_session_aead_key(&master);

        let block_id1 = [1u8; 32];
        let block_id2 = [2u8; 32];
        let key1 = derive_block_key(&session_key, &block_id1);
        let key2 = derive_block_key(&session_key, &block_id2);

        let plaintext = b"Secret data";
        let ciphertext = encrypt_block(plaintext, &key1);

        // Should fail with wrong key
        assert!(decrypt_block(&ciphertext, &key2).is_err());
    }

    #[test]
    fn test_root_block_encrypt_decrypt() {
        let master = derive_master_key("password").unwrap();
        let session_key = derive_session_aead_key(&master);

        let plaintext = b"Root block allocation table data";
        let ciphertext = encrypt_root_block(plaintext, &session_key);

        // Should decrypt with same session key
        let decrypted = decrypt_root_block(&ciphertext, &session_key).unwrap();
        assert_eq!(decrypted, plaintext);
    }

    #[test]
    fn test_root_block_different_from_data_block() {
        let master = derive_master_key("password").unwrap();
        let session_key = derive_session_aead_key(&master);
        let block_id = [0u8; 32]; // Even with "zero" block_id
        let block_key = derive_block_key(&session_key, &block_id);

        let plaintext = b"Test data";

        // Encrypt same plaintext with root block method vs data block method
        let root_ciphertext = encrypt_root_block(plaintext, &session_key);
        let data_ciphertext = encrypt_block(plaintext, &block_key);

        // Should be different (different keys)
        assert_ne!(root_ciphertext, data_ciphertext);

        // Cross-decryption should fail
        assert!(decrypt_root_block(&data_ciphertext, &session_key).is_err());
        assert!(decrypt_block(&root_ciphertext, &block_key).is_err());
    }

    #[test]
    fn test_session_keys_provides_session_key() {
        let keys = SessionKeys::derive("password").unwrap();
        let session_key = keys.session_key();

        // Should be able to encrypt/decrypt with it
        let plaintext = b"Test";
        let ciphertext = encrypt_root_block(plaintext, session_key);
        let decrypted = decrypt_root_block(&ciphertext, session_key).unwrap();
        assert_eq!(decrypted, plaintext);
    }
}
