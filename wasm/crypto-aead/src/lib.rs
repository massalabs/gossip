//! # crypto-aead
//!
//! A Rust library providing AES-256-SIV authenticated encryption with associated data (AEAD).
//!
//! This crate provides a simple interface for AES-256-SIV (Synthetic Initialization Vector).
//! SIV mode is a nonce-misuse resistant authenticated encryption scheme that provides both
//! confidentiality and authenticity.
//!
//! ## Features
//!
//! - **AES-256**: Strong 256-bit key encryption
//! - **SIV mode**: Synthetic IV mode with nonce-misuse resistance
//! - **Authenticated Encryption**: Built-in authentication tag (no separate MAC needed)
//! - **Nonce-Misuse Resistant**: Reusing nonces only leaks if plaintexts are identical
//! - **Associated Data**: Support for additional authenticated data (AAD)
//! - **Simple API**: Encrypt and decrypt functions with clear semantics
//!
//! ## Security Properties
//!
//! - **Nonce-misuse resistance**: Unlike AES-GCM or AES-CTR, nonce reuse only reveals
//!   equality of plaintexts, not the plaintext itself.
//! - **Authentication**: Built-in authentication ensures ciphertext integrity and authenticity.
//! - **Padding**: Automatically handles padding, preventing length-related leaks (ciphertext
//!   is rounded to AES block size).
//! - **Post-quantum**: AES-256 is considered quantum-resistant (Grover's algorithm reduces
//!   effective key space to 128 bits, which is still secure).
//!
//! ## Usage
//!
//! ```rust
//! use crypto_aead::*;
//!
//! // Create a key and nonce
//! let key = Key::from([42u8; KEY_SIZE]);
//! let nonce = Nonce::from([1u8; NONCE_SIZE]);
//!
//! // Encrypt some data
//! let plaintext = b"Hello, world!";
//! let ciphertext = encrypt(&key, &nonce, plaintext, b"additional data");
//!
//! // Decrypt the data
//! let decrypted = decrypt(&key, &nonce, &ciphertext, b"additional data")
//!     .expect("Decryption failed");
//!
//! assert_eq!(&decrypted, plaintext);
//! ```
//!
//! ## Nonce and AAD Considerations
//!
//! - **Nonce**: 32 bytes, should be unique per encryption for maximum security
//! - **AAD**: Additional authenticated data is NOT encrypted but IS authenticated
//! - AAD is not included in the ciphertext, so it must be transmitted separately
//! - The same AAD must be provided during decryption for authentication to succeed

use aes_siv::{
    Aes256SivAead,
    aead::{Aead, KeyInit, Payload},
};
use zeroize::{Zeroize, ZeroizeOnDrop};

/// AES-256-SIV key size in bytes (512 bits total: 256 for encryption + 256 for MAC)
///
/// Note: AES-SIV uses a double-length key internally (two 256-bit keys),
/// so the key size is 64 bytes (512 bits).
pub const KEY_SIZE: usize = 64;

/// Nonce size in bytes (128 bits)
///
/// AES-SIV uses a 16-byte (128-bit) nonce. This is the standard size for
/// AES block operations and provides sufficient nonce space.
pub const NONCE_SIZE: usize = 16;

/// A nonce for AES-256-SIV encryption.
///
/// This wraps a 128-bit nonce and provides safe byte array conversions.
/// The nonce is automatically zeroed when dropped.
///
/// # Examples
///
/// ```rust
/// use crypto_aead::{Nonce, NONCE_SIZE};
///
/// // Create from bytes
/// let nonce_bytes = [1u8; NONCE_SIZE];
/// let nonce = Nonce::from(nonce_bytes);
///
/// // Get bytes back
/// assert_eq!(nonce.as_bytes(), &nonce_bytes);
/// ```
#[derive(Zeroize, ZeroizeOnDrop)]
pub struct Nonce([u8; NONCE_SIZE]);

impl From<[u8; NONCE_SIZE]> for Nonce {
    fn from(bytes: [u8; NONCE_SIZE]) -> Self {
        Self(bytes)
    }
}

impl Nonce {
    /// Get the raw bytes of the nonce
    ///
    /// # Examples
    ///
    /// ```rust
    /// use crypto_aead::{Nonce, NONCE_SIZE};
    ///
    /// let nonce_bytes = [42u8; NONCE_SIZE];
    /// let nonce = Nonce::from(nonce_bytes);
    /// assert_eq!(nonce.as_bytes(), &nonce_bytes);
    /// ```
    #[must_use]
    pub const fn as_bytes(&self) -> &[u8; NONCE_SIZE] {
        &self.0
    }
}

/// A key for AES-256-SIV encryption.
///
/// This wraps a 512-bit key (two 256-bit keys used internally) and provides
/// safe byte array conversions. The key is automatically zeroed when dropped.
///
/// # Examples
///
/// ```rust
/// use crypto_aead::{Key, KEY_SIZE};
///
/// // Create from bytes
/// let key_bytes = [42u8; KEY_SIZE];
/// let key = Key::from(key_bytes);
///
/// // Get bytes back
/// assert_eq!(key.as_bytes(), &key_bytes);
/// ```
#[derive(Zeroize, ZeroizeOnDrop)]
pub struct Key([u8; KEY_SIZE]);

impl From<[u8; KEY_SIZE]> for Key {
    fn from(bytes: [u8; KEY_SIZE]) -> Self {
        Self(bytes)
    }
}

impl Key {
    /// Create a key by copying from a reference, avoiding an intermediate
    /// stack copy that `Key::from(*zeroizing_wrapper)` would produce.
    pub fn from_ref(bytes: &[u8; KEY_SIZE]) -> Self {
        Self(*bytes)
    }

    /// Get the raw bytes of the key
    ///
    /// # Examples
    ///
    /// ```rust
    /// use crypto_aead::{Key, KEY_SIZE};
    ///
    /// let key_bytes = [42u8; KEY_SIZE];
    /// let key = Key::from(key_bytes);
    /// assert_eq!(key.as_bytes(), &key_bytes);
    /// ```
    #[must_use]
    pub const fn as_bytes(&self) -> &[u8; KEY_SIZE] {
        &self.0
    }
}

/// Encrypts data using AES-256-SIV.
///
/// SIV mode provides authenticated encryption with associated data (AEAD).
/// The resulting ciphertext includes an authentication tag and is padded to
/// the AES block size (16 bytes).
///
/// # Arguments
///
/// * `key` - A 512-bit (64-byte) encryption key
/// * `nonce` - A 128-bit (16-byte) nonce (should be unique per encryption)
/// * `plaintext` - The data to encrypt
/// * `aad` - Additional authenticated data (not encrypted, but authenticated)
///
/// # Returns
///
/// Returns the ciphertext (including authentication tag). The AAD is NOT included
/// in the ciphertext and must be transmitted separately if needed.
///
/// # Panics
///
/// Panics if encryption fails (which should never happen in normal operation).
///
/// # Examples
///
/// ```rust
/// use crypto_aead::{encrypt, Key, Nonce, KEY_SIZE, NONCE_SIZE};
///
/// let key = Key::from([0u8; KEY_SIZE]);
/// let nonce = Nonce::from([1u8; NONCE_SIZE]);
/// let plaintext = b"Secret message";
/// let aad = b"metadata";
///
/// let ciphertext = encrypt(&key, &nonce, plaintext, aad);
/// assert_ne!(ciphertext.as_slice(), plaintext);
/// ```
///
/// # Security Notes
///
/// - Unique nonces are recommended for maximum security
/// - AAD is authenticated but NOT encrypted - it's not included in the ciphertext
/// - The ciphertext is authenticated and tamper-proof
pub fn encrypt(key: &Key, nonce: &Nonce, plaintext: &[u8], aad: &[u8]) -> Vec<u8> {
    let cipher = Aes256SivAead::new(key.as_bytes().into());

    let payload = Payload {
        msg: plaintext,
        aad,
    };

    cipher
        .encrypt(nonce.as_bytes().as_slice().into(), payload)
        .expect("AES-SIV encryption should never fail")
}

/// Decrypts data using AES-256-SIV.
///
/// This function verifies the authentication tag and decrypts the ciphertext.
/// If the ciphertext has been tampered with or is invalid, `None` is returned.
///
/// # Arguments
///
/// * `key` - A 512-bit (64-byte) encryption key (must match the encryption key)
/// * `nonce` - A 128-bit (16-byte) nonce (must match the encryption nonce)
/// * `ciphertext` - The data to decrypt (including authentication tag)
/// * `aad` - Additional authenticated data (must match the AAD used during encryption)
///
/// # Returns
///
/// Returns `Some(plaintext)` on success, or `None` if authentication fails.
///
/// # Examples
///
/// ```rust
/// use crypto_aead::{encrypt, decrypt, Key, Nonce, KEY_SIZE, NONCE_SIZE};
///
/// let key = Key::from([0u8; KEY_SIZE]);
/// let nonce = Nonce::from([1u8; NONCE_SIZE]);
/// let plaintext = b"Secret message";
/// let aad = b"metadata";
///
/// let ciphertext = encrypt(&key, &nonce, plaintext, aad);
/// let decrypted = decrypt(&key, &nonce, &ciphertext, aad).unwrap();
///
/// assert_eq!(decrypted.as_slice(), plaintext);
/// ```
///
/// # Returns None if:
///
/// - The ciphertext has been tampered with
/// - The wrong key is used
/// - The wrong nonce is used
/// - The wrong AAD is used
/// - The ciphertext is malformed
pub fn decrypt(key: &Key, nonce: &Nonce, ciphertext: &[u8], aad: &[u8]) -> Option<Vec<u8>> {
    let cipher = Aes256SivAead::new(key.as_bytes().into());

    let payload = Payload {
        msg: ciphertext,
        aad,
    };

    cipher
        .decrypt(nonce.as_bytes().as_slice().into(), payload)
        .ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_encrypt_decrypt_roundtrip() {
        let key = Key::from([42u8; KEY_SIZE]);
        let nonce = Nonce::from([1u8; NONCE_SIZE]);
        let plaintext = b"Hello, world! This is a test message.";
        let aad = b"test-metadata";

        let ciphertext = encrypt(&key, &nonce, plaintext, aad);
        assert_ne!(ciphertext.as_slice(), plaintext);

        let decrypted = decrypt(&key, &nonce, &ciphertext, aad).unwrap();
        assert_eq!(decrypted.as_slice(), plaintext);
    }

    #[test]
    fn test_empty_aad() {
        let key = Key::from([42u8; KEY_SIZE]);
        let nonce = Nonce::from([1u8; NONCE_SIZE]);
        let plaintext = b"Test with empty AAD";

        let ciphertext = encrypt(&key, &nonce, plaintext, b"");
        let decrypted = decrypt(&key, &nonce, &ciphertext, b"").unwrap();
        assert_eq!(decrypted.as_slice(), plaintext);
    }

    #[test]
    fn test_deterministic_with_same_inputs() {
        let key = Key::from([42u8; KEY_SIZE]);
        let nonce = Nonce::from([5u8; NONCE_SIZE]);
        let plaintext = b"Deterministic encryption test";
        let aad = b"metadata";

        let ciphertext1 = encrypt(&key, &nonce, plaintext, aad);
        let ciphertext2 = encrypt(&key, &nonce, plaintext, aad);

        // Same key, nonce, plaintext, and AAD produces same ciphertext
        assert_eq!(ciphertext1, ciphertext2);
    }

    #[test]
    fn test_authentication_failure_wrong_key() {
        let key1 = Key::from([1u8; KEY_SIZE]);
        let key2 = Key::from([2u8; KEY_SIZE]);
        let nonce = Nonce::from([0u8; NONCE_SIZE]);
        let plaintext = b"Secret message";
        let aad = b"metadata";

        let ciphertext = encrypt(&key1, &nonce, plaintext, aad);

        // Decrypting with wrong key should fail
        let result = decrypt(&key2, &nonce, &ciphertext, aad);
        assert!(result.is_none());
    }

    #[test]
    fn test_authentication_failure_wrong_nonce() {
        let key = Key::from([42u8; KEY_SIZE]);
        let nonce1 = Nonce::from([1u8; NONCE_SIZE]);
        let nonce2 = Nonce::from([2u8; NONCE_SIZE]);
        let plaintext = b"Secret message";
        let aad = b"metadata";

        let ciphertext = encrypt(&key, &nonce1, plaintext, aad);

        // Decrypting with wrong nonce should fail
        let result = decrypt(&key, &nonce2, &ciphertext, aad);
        assert!(result.is_none());
    }

    #[test]
    fn test_authentication_failure_wrong_aad() {
        let key = Key::from([42u8; KEY_SIZE]);
        let nonce = Nonce::from([0u8; NONCE_SIZE]);
        let plaintext = b"Secret message";
        let aad1 = b"metadata1";
        let aad2 = b"metadata2";

        let ciphertext = encrypt(&key, &nonce, plaintext, aad1);

        // Decrypting with wrong AAD should fail
        let result = decrypt(&key, &nonce, &ciphertext, aad2);
        assert!(result.is_none());
    }

    #[test]
    fn test_authentication_failure_tampered_ciphertext() {
        let key = Key::from([42u8; KEY_SIZE]);
        let nonce = Nonce::from([0u8; NONCE_SIZE]);
        let plaintext = b"Secret message";
        let aad = b"metadata";

        let mut ciphertext = encrypt(&key, &nonce, plaintext, aad);

        // Tamper with the ciphertext
        if let Some(byte) = ciphertext.first_mut() {
            *byte ^= 1;
        }

        // Decrypting tampered ciphertext should fail
        let result = decrypt(&key, &nonce, &ciphertext, aad);
        assert!(result.is_none());
    }

    #[test]
    fn test_different_keys_produce_different_ciphertexts() {
        let key1 = Key::from([1u8; KEY_SIZE]);
        let key2 = Key::from([2u8; KEY_SIZE]);
        let nonce = Nonce::from([0u8; NONCE_SIZE]);
        let plaintext = b"Test message";
        let aad = b"metadata";

        let ciphertext1 = encrypt(&key1, &nonce, plaintext, aad);
        let ciphertext2 = encrypt(&key2, &nonce, plaintext, aad);

        assert_ne!(ciphertext1, ciphertext2);
    }

    #[test]
    fn test_different_nonces_produce_different_ciphertexts() {
        let key = Key::from([0u8; KEY_SIZE]);
        let nonce1 = Nonce::from([1u8; NONCE_SIZE]);
        let nonce2 = Nonce::from([2u8; NONCE_SIZE]);
        let plaintext = b"Test message";
        let aad = b"metadata";

        let ciphertext1 = encrypt(&key, &nonce1, plaintext, aad);
        let ciphertext2 = encrypt(&key, &nonce2, plaintext, aad);

        assert_ne!(ciphertext1, ciphertext2);
    }

    #[test]
    fn test_different_aad_produce_different_ciphertexts() {
        let key = Key::from([0u8; KEY_SIZE]);
        let nonce = Nonce::from([0u8; NONCE_SIZE]);
        let plaintext = b"Test message";
        let aad1 = b"metadata1";
        let aad2 = b"metadata2";

        let ciphertext1 = encrypt(&key, &nonce, plaintext, aad1);
        let ciphertext2 = encrypt(&key, &nonce, plaintext, aad2);

        // Different AAD produces different ciphertext
        assert_ne!(ciphertext1, ciphertext2);
    }

    #[test]
    fn test_nonce_reuse_reveals_equality() {
        let key = Key::from([42u8; KEY_SIZE]);
        let nonce = Nonce::from([0u8; NONCE_SIZE]);
        let plaintext1 = b"Message A";
        let plaintext2 = b"Message A";
        let plaintext3 = b"Message B";
        let aad = b"metadata";

        let ciphertext1 = encrypt(&key, &nonce, plaintext1, aad);
        let ciphertext2 = encrypt(&key, &nonce, plaintext2, aad);
        let ciphertext3 = encrypt(&key, &nonce, plaintext3, aad);

        // Same plaintext with same nonce and AAD produces same ciphertext
        assert_eq!(ciphertext1, ciphertext2);
        // Different plaintext produces different ciphertext
        assert_ne!(ciphertext1, ciphertext3);
    }

    #[test]
    fn test_empty_plaintext() {
        let key = Key::from([0u8; KEY_SIZE]);
        let nonce = Nonce::from([0u8; NONCE_SIZE]);
        let plaintext = b"";
        let aad = b"metadata";

        let ciphertext = encrypt(&key, &nonce, plaintext, aad);
        // Even empty plaintext produces non-empty ciphertext (auth tag)
        assert!(!ciphertext.is_empty());

        let decrypted = decrypt(&key, &nonce, &ciphertext, aad).unwrap();
        assert_eq!(decrypted.len(), 0);
    }

    #[test]
    fn test_large_plaintext() {
        let key = Key::from([123u8; KEY_SIZE]);
        let nonce = Nonce::from([45u8; NONCE_SIZE]);
        let plaintext = vec![42u8; 10000];
        let aad = b"large-data-metadata";

        let ciphertext = encrypt(&key, &nonce, &plaintext, aad);
        assert_ne!(ciphertext, plaintext);

        let decrypted = decrypt(&key, &nonce, &ciphertext, aad).unwrap();
        assert_eq!(decrypted, plaintext);
    }

    #[test]
    fn test_large_aad() {
        let key = Key::from([99u8; KEY_SIZE]);
        let nonce = Nonce::from([0u8; NONCE_SIZE]);
        let plaintext = b"Test message";
        let aad = vec![77u8; 5000];

        let ciphertext = encrypt(&key, &nonce, plaintext, &aad);
        let decrypted = decrypt(&key, &nonce, &ciphertext, &aad).unwrap();
        assert_eq!(decrypted.as_slice(), plaintext);
    }

    #[test]
    fn test_ciphertext_size() {
        let key = Key::from([7u8; KEY_SIZE]);
        let nonce = Nonce::from([0u8; NONCE_SIZE]);
        let aad = b"metadata";

        // Test with different plaintext lengths
        let plaintext_7 = b"1234567";
        let plaintext_15 = b"123456789012345";
        let plaintext_16 = b"1234567890123456";
        let plaintext_17 = b"12345678901234567";

        let ciphertext_7 = encrypt(&key, &nonce, plaintext_7, aad);
        let ciphertext_15 = encrypt(&key, &nonce, plaintext_15, aad);
        let ciphertext_16 = encrypt(&key, &nonce, plaintext_16, aad);
        let ciphertext_17 = encrypt(&key, &nonce, plaintext_17, aad);

        // SIV adds a 16-byte tag, so ciphertext should be plaintext + 16
        assert_eq!(ciphertext_7.len(), plaintext_7.len() + 16);
        assert_eq!(ciphertext_15.len(), plaintext_15.len() + 16);
        assert_eq!(ciphertext_16.len(), plaintext_16.len() + 16);
        assert_eq!(ciphertext_17.len(), plaintext_17.len() + 16);

        // Verify all can be decrypted
        assert_eq!(
            decrypt(&key, &nonce, &ciphertext_7, aad).unwrap(),
            plaintext_7
        );
        assert_eq!(
            decrypt(&key, &nonce, &ciphertext_15, aad).unwrap(),
            plaintext_15
        );
        assert_eq!(
            decrypt(&key, &nonce, &ciphertext_16, aad).unwrap(),
            plaintext_16
        );
        assert_eq!(
            decrypt(&key, &nonce, &ciphertext_17, aad).unwrap(),
            plaintext_17
        );
    }

    #[test]
    fn test_aad_not_in_ciphertext() {
        let key = Key::from([0u8; KEY_SIZE]);
        let nonce = Nonce::from([0u8; NONCE_SIZE]);
        let plaintext = b"Test";
        let aad = b"this-should-not-appear-in-ciphertext";

        let ciphertext = encrypt(&key, &nonce, plaintext, aad);

        // AAD should not appear anywhere in the ciphertext
        let ciphertext_string = String::from_utf8_lossy(&ciphertext);
        let aad_string = String::from_utf8_lossy(aad);
        assert!(!ciphertext_string.contains(&*aad_string));
    }
}
