//! Quantum-secure Key Derivation Function (KDF)
//!
//! This crate provides a secure key derivation function based on HKDF-SHA256,
//! with additional protections against length extension attacks and input telescoping.
//!
//! # Overview
//!
//! The KDF operates in two phases:
//! - **Extract**: Combines multiple input materials with a salt using [`Extract`]
//! - **Expand**: Derives multiple keys from the extracted material using [`Expand`]
//!
//! # Security Features
//!
//! - **Length extension protection**: Uses markers and length prefixing to prevent attacks
//! - **Input separation**: Each input is marked and length-prefixed to avoid telescoping
//! - **Quantum-resistant design**: Uses SHA256-based HKDF suitable for post-quantum scenarios (128 bit security)
//! - **Memory safety**: Uses external buffers for input and output.
//! - **Panics**: Panics if anything invalid is detected.
//!
//! # Example
//!
//! ```
//! use crypto_kdf::Extract;
//!
//! // Create a KDF with a salt
//! let mut kdf = Extract::new(b"application-salt");
//!
//! // Add multiple input materials
//! kdf.input_item(b"shared-secret");
//! kdf.input_item(b"session-id");
//!
//! // Finalize extraction and expand to derive keys
//! let expander = kdf.finalize();
//!
//! // Derive different keys with different info strings
//! let mut encryption_key = [0u8; 32];
//! expander.expand(b"encryption", &mut encryption_key);
//!
//! let mut mac_key = [0u8; 32];
//! expander.expand(b"mac", &mut mac_key);
//!
//! // The keys are different despite coming from the same source
//! assert_ne!(encryption_key, mac_key);
//! ```

use hkdf::{Hkdf, HkdfExtract};
use sha2::Sha256;

const INPUT_MARKER: [u8; 1] = [1];
const END_MARKER: [u8; 1] = [0];

/// Key derivation function extraction phase.
///
/// `Extract` accumulates multiple input key materials (IKM) along with a salt,
/// and combines them into a pseudorandom key (PRK) when finalized.
///
/// Each input is protected against length extension attacks by using markers
/// and length prefixing.
///
/// # Example
///
/// ```
/// use crypto_kdf::Extract;
///
/// let mut kdf = Extract::new(b"my-salt");
/// kdf.input_item(b"secret1");
/// kdf.input_item(b"secret2");
/// let expander = kdf.finalize();
/// ```
pub struct Extract(HkdfExtract<Sha256>);

impl Extract {
    /// Creates a new KDF extraction context with the given salt.
    ///
    /// # Arguments
    ///
    /// * `salt` - A salt value to provide additional randomness. Should be unique per usage.
    ///
    /// # Example
    ///
    /// ```
    /// use crypto_kdf::Extract;
    ///
    /// let kdf = Extract::new(b"unique-salt");
    /// ```
    #[must_use]
    pub fn new(salt: &[u8]) -> Self {
        Self(HkdfExtract::new(Some(salt)))
    }

    /// Adds an input key material (IKM) to the KDF.
    ///
    /// This method can be called multiple times to add different input materials.
    /// Each input is length-prefixed and marked to prevent length extension attacks
    /// and telescoping between inputs.
    ///
    /// # Arguments
    ///
    /// * `input` - The input key material to add. Must be less than 2^32 bytes.
    ///
    /// # Panics
    ///
    /// Panics if the input length exceeds `u64::MAX` bytes.
    ///
    /// # Example
    ///
    /// ```
    /// use crypto_kdf::Extract;
    ///
    /// let mut kdf = Extract::new(b"salt");
    /// kdf.input_item(b"first-secret");
    /// kdf.input_item(b"second-secret");
    /// ```
    pub fn input_item(&mut self, input: &[u8]) {
        let input_len: u64 = input.len().try_into().expect("Input length too large");

        // Feed INPUT_MARKER indicating there are still entries to feed
        // and at finalization we will feed END_MARKER indicating
        // that there are no more entries to feed.
        // This prevents length extension attacks when we don't know the length of the input in advance.
        self.0.input_ikm(&INPUT_MARKER);

        // Feed the length of this input to avoid length extension attacks
        // as well as telescoping issues between different inputs.
        self.0.input_ikm(&input_len.to_be_bytes());

        // Feed the input itself
        self.0.input_ikm(input);
    }

    /// Finalizes the extraction phase and returns a [`Expand`] for key derivation.
    ///
    /// After calling this method, no more inputs can be added. The returned
    /// [`Expand`] can be used to derive multiple keys with different info strings.
    ///
    /// # Example
    ///
    /// ```
    /// use crypto_kdf::Extract;
    ///
    /// let mut kdf = Extract::new(b"salt");
    /// kdf.input_item(b"secret");
    /// let expander = kdf.finalize();
    ///
    /// let mut key = [0u8; 32];
    /// expander.expand(b"key-id", &mut key);
    /// ```
    #[must_use]
    pub fn finalize(mut self) -> Expand {
        // Input END_MARKER to indicate that there are no more entries to feed.
        // This prevents length extension attacks when we don't know the length of the input in advance.
        self.0.input_ikm(&END_MARKER);

        // Finalize the HKDF-Extract operation
        let (_, kdf) = self.0.finalize();

        // Return the HKDF-Expand operation
        Expand(kdf)
    }
}

/// Key derivation function expansion phase.
///
/// `Expand` derives multiple keys from the pseudorandom key (PRK) produced
/// by [`Extract`]. Each derived key is identified by an "info" string,
/// allowing you to derive different keys for different purposes from the same PRK.
///
/// # Example
///
/// ```
/// use crypto_kdf::Extract;
///
/// let mut kdf = Extract::new(b"salt");
/// kdf.input_item(b"shared-secret");
/// let expander = kdf.finalize();
///
/// // Derive multiple keys
/// let mut key1 = [0u8; 32];
/// let mut key2 = [0u8; 16];
/// expander.expand(b"purpose1", &mut key1);
/// expander.expand(b"purpose2", &mut key2);
/// ```
pub struct Expand(Hkdf<Sha256>);

impl Drop for Expand {
    fn drop(&mut self) {
        // Hkdf<Sha256> does not implement Zeroize, so we overwrite the PRK
        // bytes via its raw memory representation. The struct contains a
        // 32-byte HMAC PRK that is the root secret for all derived keys.
        //
        // SAFETY: we are writing zeroes over our own memory, which is about
        // to be deallocated. The struct is repr(Rust) so we zero the full
        // size to cover padding. This is a best-effort defense — the
        // compiler may have already spilled copies elsewhere.
        let ptr = &mut self.0 as *mut Hkdf<Sha256> as *mut u8;
        let size = core::mem::size_of::<Hkdf<Sha256>>();
        unsafe {
            core::ptr::write_bytes(ptr, 0, size);
        }
    }
}

impl Expand {
    /// Expands the PRK into a derived key of the specified length.
    ///
    /// # Arguments
    ///
    /// * `info` - Application-specific context information to derive a unique key.
    ///   Different info values produce different keys.
    /// * `output_buffer` - The buffer to fill with the derived key material.
    ///   The length determines how much key material is derived.
    ///
    /// # Panics
    ///
    /// Panics if the HKDF expansion fails (e.g., if the output length is too large).
    /// The maximum output length is 255 * 32 = 8160 bytes for SHA256.
    ///
    /// # Example
    ///
    /// ```
    /// use crypto_kdf::Extract;
    ///
    /// let mut kdf = Extract::new(b"salt");
    /// kdf.input_item(b"secret");
    /// let expander = kdf.finalize();
    ///
    /// // Derive a 32-byte key
    /// let mut key = [0u8; 32];
    /// expander.expand(b"encryption-key", &mut key);
    ///
    /// // Derive a different 16-byte key
    /// let mut nonce_key = [0u8; 16];
    /// expander.expand(b"nonce-key", &mut nonce_key);
    /// ```
    pub fn expand(&self, info: &[u8], output_buffer: &mut [u8]) {
        self.0
            .expand(info, output_buffer)
            .expect("HKDF expand failed");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_basic_kdf() {
        let mut kdf = Extract::new(b"test-salt");
        kdf.input_item(b"secret-material");
        let expander = kdf.finalize();

        let mut key = [0u8; 32];
        expander.expand(b"test-info", &mut key);

        // Key should not be all zeros
        assert_ne!(key, [0u8; 32]);
    }

    #[test]
    fn test_different_info_produces_different_keys() {
        let mut kdf = Extract::new(b"salt");
        kdf.input_item(b"secret");
        let expander = kdf.finalize();

        let mut key1 = [0u8; 32];
        let mut key2 = [0u8; 32];
        expander.expand(b"info1", &mut key1);
        expander.expand(b"info2", &mut key2);

        // Different info strings should produce different keys
        assert_ne!(key1, key2);
    }

    #[test]
    fn test_multiple_inputs() {
        let mut kdf = Extract::new(b"salt");
        kdf.input_item(b"first");
        kdf.input_item(b"second");
        kdf.input_item(b"third");
        let expander = kdf.finalize();

        let mut key = [0u8; 32];
        expander.expand(b"test", &mut key);

        assert_ne!(key, [0u8; 32]);
    }

    #[test]
    fn test_input_order_matters() {
        // First KDF with inputs in one order
        let mut kdf1 = Extract::new(b"salt");
        kdf1.input_item(b"first");
        kdf1.input_item(b"second");
        let expander1 = kdf1.finalize();

        // Second KDF with inputs in different order
        let mut kdf2 = Extract::new(b"salt");
        kdf2.input_item(b"second");
        kdf2.input_item(b"first");
        let expander2 = kdf2.finalize();

        let mut key1 = [0u8; 32];
        let mut key2 = [0u8; 32];
        expander1.expand(b"test", &mut key1);
        expander2.expand(b"test", &mut key2);

        // Different input order should produce different keys
        assert_ne!(key1, key2);
    }

    #[test]
    fn test_different_salt_produces_different_keys() {
        let mut kdf1 = Extract::new(b"salt1");
        kdf1.input_item(b"secret");
        let expander1 = kdf1.finalize();

        let mut kdf2 = Extract::new(b"salt2");
        kdf2.input_item(b"secret");
        let expander2 = kdf2.finalize();

        let mut key1 = [0u8; 32];
        let mut key2 = [0u8; 32];
        expander1.expand(b"info", &mut key1);
        expander2.expand(b"info", &mut key2);

        // Different salts should produce different keys
        assert_ne!(key1, key2);
    }

    #[test]
    fn test_variable_length_outputs() {
        let mut kdf = Extract::new(b"salt");
        kdf.input_item(b"secret");
        let expander = kdf.finalize();

        // Test different output sizes
        let mut key16 = [0u8; 16];
        let mut key32 = [0u8; 32];
        let mut key64 = [0u8; 64];

        expander.expand(b"info", &mut key16);
        expander.expand(b"info", &mut key32);
        expander.expand(b"info", &mut key64);

        // All keys should be non-zero
        assert_ne!(key16, [0u8; 16]);
        assert_ne!(key32, [0u8; 32]);
        assert_ne!(key64, [0u8; 64]);

        // First 16 bytes of key32 should match key16 (property of HKDF)
        assert_eq!(&key32[..16], &key16[..]);
        assert_eq!(&key64[..32], &key32[..]);
    }

    #[test]
    fn test_reproducibility() {
        // Same inputs should produce same outputs
        let mut kdf1 = Extract::new(b"salt");
        kdf1.input_item(b"secret");
        let expander1 = kdf1.finalize();

        let mut kdf2 = Extract::new(b"salt");
        kdf2.input_item(b"secret");
        let expander2 = kdf2.finalize();

        let mut key1 = [0u8; 32];
        let mut key2 = [0u8; 32];
        expander1.expand(b"info", &mut key1);
        expander2.expand(b"info", &mut key2);

        assert_eq!(key1, key2);
    }

    #[test]
    fn test_empty_input() {
        let mut kdf = Extract::new(b"salt");
        kdf.input_item(b"");
        let expander = kdf.finalize();

        let mut key = [0u8; 32];
        expander.expand(b"info", &mut key);

        assert_ne!(key, [0u8; 32]);
    }

    #[test]
    fn test_empty_salt() {
        let mut kdf = Extract::new(b"");
        kdf.input_item(b"secret");
        let expander = kdf.finalize();

        let mut key = [0u8; 32];
        expander.expand(b"info", &mut key);

        assert_ne!(key, [0u8; 32]);
    }
}
