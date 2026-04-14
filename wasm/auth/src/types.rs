//! Core authentication types for user key management.
//!
//! This module provides the fundamental types for managing user authentication keys
//! in a hierarchical key derivation scheme. All user keys are derived from a single
//! root secret, ensuring deterministic key generation.

use alloy_primitives::Address;
use serde::{Deserialize, Serialize};
use sha3::{Digest, Keccak256};
use zeroize::{Zeroize, ZeroizeOnDrop, Zeroizing};

/// Size of the user ID in bytes.
pub const USER_ID_SIZE: usize = 32;

/// Size of the static root secret in bytes.
pub const STATIC_ROOT_SECRET_SIZE: usize = 32;

/// A unique identifier for a user, derived from their public keys.
///
/// The user ID is deterministically computed from all public keys using a KDF,
/// ensuring that the same key material always produces the same ID.
#[derive(Debug, Clone, Hash, Zeroize, ZeroizeOnDrop, Serialize, Deserialize, PartialEq, Eq)]
pub struct UserId([u8; USER_ID_SIZE]);

impl UserId {
    /// Returns the user ID as a byte slice.
    #[must_use]
    pub const fn as_bytes(&self) -> &[u8] {
        &self.0
    }

    /// Creates a `UserId` from a byte array.
    #[must_use]
    pub const fn from_bytes(bytes: [u8; USER_ID_SIZE]) -> Self {
        Self(bytes)
    }
}

impl AsRef<[u8]> for UserId {
    fn as_ref(&self) -> &[u8] {
        &self.0
    }
}

/// A collection of all public keys associated with a user.
///
/// This structure contains four types of public keys:
/// - DSA verification key for digital signatures
/// - KEM public key for key encapsulation
/// - Massa blockchain public key
/// - EVM public key (compressed SEC1, 33 bytes)
#[derive(Clone, Zeroize, ZeroizeOnDrop, Serialize, Deserialize)]
pub struct UserPublicKeys {
    /// Digital Signature Algorithm verification key.
    pub dsa_verification_key: crypto_dsa::VerificationKey,
    /// Key Encapsulation Mechanism public key.
    pub kem_public_key: crypto_kem::PublicKey,
    /// Massa blockchain public key.
    #[zeroize(skip)] // TODO: add zeroization to massa pubkeys
    pub massa_public_key: massa_signature::PublicKey,
    /// EVM public key (compressed, secp256k1).
    pub evm_public_key: Vec<u8>,
}

impl UserPublicKeys {
    /// Serializes the public keys to bytes using bincode.
    ///
    /// # Returns
    ///
    /// A vector of bytes representing the serialized public keys.
    ///
    /// # Panics
    ///
    /// Panics if serialization fails (should never happen in practice).
    #[must_use]
    pub fn to_bytes(&self) -> Vec<u8> {
        bincode::serde::encode_to_vec(self, bincode::config::standard())
            .expect("Failed to serialize UserPublicKeys")
    }

    /// Deserializes public keys from bytes using bincode.
    ///
    /// # Arguments
    ///
    /// * `bytes` - A byte slice containing the serialized public keys
    ///
    /// # Returns
    ///
    /// A `Result` containing the deserialized `UserPublicKeys` or an error.
    pub fn from_bytes(bytes: &[u8]) -> Result<Self, bincode::error::DecodeError> {
        bincode::serde::decode_from_slice(bytes, bincode::config::standard())
            .map(|(result, _)| result)
    }

    /// Derives a unique user ID from the public keys.
    ///
    /// The ID is computed as the BLAKE3 hash of the serialized public keys.
    ///
    /// This ensures that the user ID is:
    /// - Deterministic (same keys always produce the same ID)
    /// - Unique (different key combinations produce different IDs)
    /// - One-way (cannot reverse engineer keys from the ID)
    ///
    /// # Returns
    ///
    /// A `UserId` uniquely identifying this set of public keys.
    #[must_use]
    pub fn derive_id(&self) -> UserId {
        let serialized = Zeroizing::new(self.to_bytes());
        let hash = blake3::hash(&serialized);
        UserId(hash.into())
    }

    /// Address version — matches `UserAddressV0::VERSION` in massa-models.
    const ADDRESS_VERSION: u64 = 0;

    /// Derives the Massa address (AU…) from the stored public key.
    ///
    /// Replicates the logic from `massa-models` `Address::from_public_key`:
    /// `"AU" + bs58check(varint(version) + blake3(public_key_bytes))`
    #[must_use]
    pub fn massa_address(&self) -> String {
        let hash = massa_hash::Hash::compute_from(&self.massa_public_key.to_bytes());
        let mut payload = Vec::with_capacity(10 + 32);
        // Encode version as unsigned LEB128 varint (same as unsigned-varint crate)
        let mut version = Self::ADDRESS_VERSION;
        loop {
            let byte = (version & 0x7F) as u8;
            version >>= 7;
            if version == 0 {
                payload.push(byte);
                break;
            }
            payload.push(byte | 0x80);
        }
        payload.extend_from_slice(hash.to_bytes());
        format!("AU{}", bs58::encode(payload).with_check().into_string())
    }

    /// Derives the EIP-55 checksummed EVM address from the stored public key.
    #[must_use]
    pub fn evm_address(&self) -> String {
        let verifying_key = k256::ecdsa::VerifyingKey::from_sec1_bytes(&self.evm_public_key)
            .expect("Invalid EVM public key stored in UserPublicKeys");
        let uncompressed = verifying_key.to_encoded_point(false);
        let hash = Keccak256::digest(&uncompressed.as_bytes()[1..]);
        let addr_bytes: [u8; 20] = hash[12..].try_into().expect("Keccak output is 32 bytes");
        Address::from(addr_bytes).to_checksum(None)
    }
}

/// A root secret from which all user keys are derived.
///
/// The static root secret is the foundation of the key hierarchy. It is typically
/// derived from a user's passphrase using a password-based KDF. All user keys
/// are deterministically derived from this root secret.
///
/// # Security
///
/// This type is marked with `ZeroizeOnDrop` to ensure the secret is securely
/// erased from memory when the value is dropped.
#[derive(Zeroize, ZeroizeOnDrop, Serialize, Deserialize)]
pub struct StaticRootSecret([u8; STATIC_ROOT_SECRET_SIZE]);

impl StaticRootSecret {
    /// Returns the root secret as a byte slice.
    #[must_use]
    pub const fn as_slice(&self) -> &[u8] {
        &self.0
    }

    /// Derives a static root secret from a passphrase.
    ///
    /// Uses a password-based key derivation function to convert a user's passphrase
    /// into a 32-byte root secret. The derivation is deterministic, so the same
    /// passphrase will always produce the same root secret.
    ///
    /// # Arguments
    ///
    /// * `passphrase` - The user's passphrase as a byte slice
    ///
    /// # Returns
    ///
    /// A `StaticRootSecret` derived from the passphrase.
    ///
    /// # Example
    ///
    /// ```ignore
    /// let passphrase = b"my secure passphrase";
    /// let root_secret = StaticRootSecret::from_passphrase(passphrase);
    /// ```
    #[must_use]
    pub fn from_passphrase(passphrase: &[u8]) -> Self {
        let mut output = [0u8; STATIC_ROOT_SECRET_SIZE];
        crypto_password_kdf::derive(passphrase, b"auth.pwd.kdf.salt---------------", &mut output);
        Self(output)
    }

    /// Creates a `StaticRootSecret` from raw bytes.
    ///
    /// # Arguments
    ///
    /// * `bytes` - A 32-byte array containing the root secret
    ///
    /// # Returns
    ///
    /// A `StaticRootSecret` wrapping the provided bytes.
    #[must_use]
    pub const fn from_bytes(bytes: [u8; STATIC_ROOT_SECRET_SIZE]) -> Self {
        Self(bytes)
    }
}

/// A collection of all secret keys associated with a user.
///
/// This structure contains three different types of secret keys that correspond
/// to the public keys in `UserPublicKeys`. All keys in this structure are
/// zeroized when dropped to prevent memory leakage of sensitive data.
#[derive(Zeroize, ZeroizeOnDrop, Serialize, Deserialize)]
pub struct UserSecretKeys {
    /// Digital Signature Algorithm signing key.
    pub dsa_signing_key: crypto_dsa::SigningKey,
    /// Key Encapsulation Mechanism secret key.
    pub kem_secret_key: crypto_kem::SecretKey,
    /// Massa blockchain keypair.
    #[zeroize(skip)] // TODO: add zeroization to massa keypair
    pub massa_keypair: massa_signature::KeyPair,
    /// EVM secret key (raw 32-byte scalar).
    pub evm_secret_key: [u8; 32],
}

/// Derives all user keys from a static root secret.
///
/// This function implements a hierarchical deterministic key derivation scheme.
/// Given a root secret, it derives:
/// - DSA signing/verification keypair
/// - KEM secret/public keypair
/// - Massa blockchain keypair
/// - EVM keypair (secp256k1)
///
/// The derivation is deterministic, meaning the same inputs will always produce
/// the same output keys. This allows users to recover their keys from their
/// passphrase.
///
/// # Arguments
///
/// * `static_root_secret` - The root secret from which to derive keys
///
/// # Returns
///
/// A tuple containing:
/// - `UserPublicKeys` - All derived public keys
/// - `UserSecretKeys` - All derived secret keys
///
/// # Panics
///
/// Panics if the derived Massa keypair bytes are invalid. In practice, this should
/// never happen as the KDF output is always valid key material.
///
/// # Example
///
/// ```ignore
/// use auth::{StaticRootSecret, derive_keys_from_static_root_secret};
///
/// let passphrase = b"my secure passphrase";
/// let root_secret = StaticRootSecret::from_passphrase(passphrase);
///
/// let (public_keys, secret_keys) = derive_keys_from_static_root_secret(&root_secret);
/// ```
#[must_use]
pub fn derive_keys_from_static_root_secret(
    static_root_secret: &StaticRootSecret,
) -> (UserPublicKeys, UserSecretKeys) {
    // Extract entropy from the root secret
    let mut kdf = crypto_kdf::Extract::new(b"auth.keypairs.kdf.salt----------");
    kdf.input_item(static_root_secret.as_slice());
    let expander = kdf.finalize();

    // Derive randomness for DSA key generation
    let mut dsa_randomness = [0u8; crypto_dsa::KEY_GENERATION_RANDOMNESS_SIZE];
    expander.expand(b"auth.keypairs.kdf.dsa_randomness", &mut dsa_randomness);

    // Derive randomness for KEM key generation
    let mut kem_randomness = [0u8; crypto_kem::KEY_GENERATION_RANDOMNESS_SIZE];
    expander.expand(b"auth.keypairs.kdf.kem_randomness", &mut kem_randomness);

    // Derive Massa keypair bytes (33 bytes, first byte is version)
    let mut massa_keypair_bytes = Zeroizing::new([0u8; 33]);
    expander.expand(
        "auth.keypairs.kdf.massa_keypair_bytes".as_bytes(),
        &mut massa_keypair_bytes[1..],
    );

    // Derive EVM secret key (32-byte secp256k1 scalar)
    let mut evm_secret_key = [0u8; 32];
    expander.expand(b"auth.keypairs.kdf.evm_secret_key", &mut evm_secret_key);

    // Generate keypairs from derived randomness
    let (dsa_signing_key, dsa_verification_key) = crypto_dsa::generate_key_pair(dsa_randomness);
    let (kem_secret_key, kem_public_key) = crypto_kem::generate_key_pair(kem_randomness);

    let massa_keypair = massa_signature::KeyPair::from_bytes(massa_keypair_bytes.as_slice())
        .expect("Invalid massa keypair bytes");
    let massa_public_key = massa_keypair.get_public_key();

    let evm_signing_key = k256::ecdsa::SigningKey::from_bytes(&evm_secret_key.into())
        .expect("Invalid EVM key material from KDF");
    let evm_public_key = evm_signing_key
        .verifying_key()
        .to_encoded_point(true)
        .as_bytes()
        .to_vec();

    (
        UserPublicKeys {
            dsa_verification_key,
            kem_public_key,
            massa_public_key,
            evm_public_key,
        },
        UserSecretKeys {
            dsa_signing_key,
            kem_secret_key,
            massa_keypair,
            evm_secret_key,
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_user_id_from_bytes() {
        let bytes = [42u8; USER_ID_SIZE];
        let user_id = UserId::from_bytes(bytes);
        assert_eq!(user_id.as_bytes(), &bytes);
    }

    #[test]
    fn test_user_id_as_ref() {
        let bytes = [42u8; USER_ID_SIZE];
        let user_id = UserId::from_bytes(bytes);
        let as_ref: &[u8] = user_id.as_ref();
        assert_eq!(as_ref, &bytes);
    }

    #[test]
    fn test_user_id_equality() {
        let user_id1 = UserId::from_bytes([1u8; USER_ID_SIZE]);
        let user_id2 = UserId::from_bytes([1u8; USER_ID_SIZE]);
        let user_id3 = UserId::from_bytes([2u8; USER_ID_SIZE]);

        assert_eq!(user_id1, user_id2);
        assert_ne!(user_id1, user_id3);
    }

    #[test]
    fn test_static_root_secret_from_passphrase() {
        let passphrase = b"test passphrase 123";
        let root_secret = StaticRootSecret::from_passphrase(passphrase);
        assert_eq!(root_secret.as_slice().len(), STATIC_ROOT_SECRET_SIZE);
    }

    #[test]
    fn test_static_root_secret_deterministic() {
        let passphrase = b"deterministic test";
        let root_secret1 = StaticRootSecret::from_passphrase(passphrase);
        let root_secret2 = StaticRootSecret::from_passphrase(passphrase);
        assert_eq!(root_secret1.as_slice(), root_secret2.as_slice());
    }

    #[test]
    fn test_static_root_secret_different_passphrases() {
        let root_secret1 = StaticRootSecret::from_passphrase(b"passphrase1");
        let root_secret2 = StaticRootSecret::from_passphrase(b"passphrase2");
        assert_ne!(root_secret1.as_slice(), root_secret2.as_slice());
    }

    #[test]
    fn test_static_root_secret_from_bytes() {
        let bytes = [99u8; STATIC_ROOT_SECRET_SIZE];
        let root_secret = StaticRootSecret::from_bytes(bytes);
        assert_eq!(root_secret.as_slice(), &bytes);
    }

    #[test]
    fn test_derive_keys_deterministic() {
        let passphrase = b"my secure passphrase";
        let root_secret = StaticRootSecret::from_passphrase(passphrase);

        let (pub_keys1, _) = derive_keys_from_static_root_secret(&root_secret);
        let (pub_keys2, _) = derive_keys_from_static_root_secret(&root_secret);

        // Verify deterministic key derivation
        assert_eq!(
            pub_keys1.dsa_verification_key.as_bytes(),
            pub_keys2.dsa_verification_key.as_bytes()
        );
        assert_eq!(
            pub_keys1.kem_public_key.as_bytes(),
            pub_keys2.kem_public_key.as_bytes()
        );
        assert_eq!(
            pub_keys1.massa_public_key.to_bytes(),
            pub_keys2.massa_public_key.to_bytes()
        );
    }

    #[test]
    fn test_derive_keys_different_roots() {
        let root_secret1 = StaticRootSecret::from_passphrase(b"passphrase1");
        let root_secret2 = StaticRootSecret::from_passphrase(b"passphrase2");

        let (pub_keys1, _) = derive_keys_from_static_root_secret(&root_secret1);
        let (pub_keys2, _) = derive_keys_from_static_root_secret(&root_secret2);

        // Verify different root secrets produce different keys
        assert_ne!(
            pub_keys1.dsa_verification_key.as_bytes(),
            pub_keys2.dsa_verification_key.as_bytes()
        );
    }

    #[test]
    fn test_user_id_derivation_deterministic() {
        let passphrase = b"test user id derivation";
        let root_secret = StaticRootSecret::from_passphrase(passphrase);

        let (pub_keys, _) = derive_keys_from_static_root_secret(&root_secret);

        let user_id1 = pub_keys.derive_id();
        let user_id2 = pub_keys.derive_id();

        assert_eq!(user_id1, user_id2);
    }

    #[test]
    fn test_user_id_unique_for_different_keys() {
        let root_secret1 = StaticRootSecret::from_passphrase(b"user1");
        let root_secret2 = StaticRootSecret::from_passphrase(b"user2");

        let (pub_keys1, _) = derive_keys_from_static_root_secret(&root_secret1);
        let (pub_keys2, _) = derive_keys_from_static_root_secret(&root_secret2);

        let user_id1 = pub_keys1.derive_id();
        let user_id2 = pub_keys2.derive_id();

        assert_ne!(user_id1, user_id2);
    }

    #[test]
    fn test_derived_keys_structure() {
        let passphrase = b"structure test";
        let root_secret = StaticRootSecret::from_passphrase(passphrase);

        let (pub_keys, _secret_keys) = derive_keys_from_static_root_secret(&root_secret);

        // Verify keys are not all zeros (they have been properly generated)
        assert_ne!(pub_keys.dsa_verification_key.as_bytes(), &[0u8; 1952]);
        assert_ne!(pub_keys.kem_public_key.as_bytes(), &[0u8; 1184]);
    }

    #[test]
    fn test_massa_address() {
        let root_secret = StaticRootSecret::from_passphrase(b"massa address test");
        let (pub_keys, _) = derive_keys_from_static_root_secret(&root_secret);

        let addr = pub_keys.massa_address();
        assert!(addr.starts_with("AU"), "Massa address must start with AU");
        // AU + bs58check(1 byte version + 32 bytes hash) → typically ~50 chars
        assert!(addr.len() > 40, "Massa address seems too short: {}", addr);
    }

    #[test]
    fn test_massa_address_deterministic() {
        let root_secret = StaticRootSecret::from_passphrase(b"deterministic massa");
        let (pub1, _) = derive_keys_from_static_root_secret(&root_secret);
        let (pub2, _) = derive_keys_from_static_root_secret(&root_secret);

        assert_eq!(pub1.massa_address(), pub2.massa_address());
    }

    #[test]
    fn test_massa_address_matches_web3() {
        // Cross-checked: massa-web3 (TS) produces the same address for this passphrase
        let root_secret = StaticRootSecret::from_passphrase(b"cross chain test 123");
        let (pub_keys, _) = derive_keys_from_static_root_secret(&root_secret);

        assert_eq!(
            pub_keys.massa_address(),
            "AU1CKrPb3a1Aj3JJkeTuHJoMswGVDSdgg1ynK7QMMMKHVYjinBfq"
        );
    }

    #[test]
    fn test_evm_keypair_populated() {
        let root_secret = StaticRootSecret::from_passphrase(b"evm test");
        let (pub_keys, sec_keys) = derive_keys_from_static_root_secret(&root_secret);

        // Verify EVM keypair is non-zero
        assert_ne!(pub_keys.evm_public_key, vec![0u8; 33]);
        assert_ne!(sec_keys.evm_secret_key, [0u8; 32]);

        // Verify the public key is a valid SEC1 compressed point
        k256::ecdsa::VerifyingKey::from_sec1_bytes(&pub_keys.evm_public_key)
            .expect("EVM public key should be a valid SEC1 point");

        // Verify evm_address() returns a valid EIP-55 address
        let addr = pub_keys.evm_address();
        assert!(addr.starts_with("0x"));
        assert_eq!(addr.len(), 42);
    }

    #[test]
    fn test_evm_keypair_deterministic() {
        let root_secret = StaticRootSecret::from_passphrase(b"deterministic evm");
        let (pub1, sec1) = derive_keys_from_static_root_secret(&root_secret);
        let (pub2, sec2) = derive_keys_from_static_root_secret(&root_secret);

        assert_eq!(pub1.evm_public_key, pub2.evm_public_key);
        assert_eq!(sec1.evm_secret_key, sec2.evm_secret_key);
    }

    #[test]
    fn test_evm_keypair_any_passphrase() {
        // EVM keys are now derived via HKDF, so any passphrase works
        let root_secret = StaticRootSecret::from_passphrase(b"not a mnemonic at all");
        let (pub_keys, sec_keys) = derive_keys_from_static_root_secret(&root_secret);

        assert_ne!(pub_keys.evm_public_key, vec![0u8; 33]);
        assert_ne!(sec_keys.evm_secret_key, [0u8; 32]);
    }

    #[test]
    fn test_user_public_keys_serialization() {
        let root_secret = StaticRootSecret::from_passphrase(b"serialization test");
        let (pub_keys, _) = derive_keys_from_static_root_secret(&root_secret);

        // Test to_bytes and from_bytes
        let bytes = pub_keys.to_bytes();
        let deserialized =
            UserPublicKeys::from_bytes(&bytes).expect("Failed to deserialize UserPublicKeys");

        // Verify the deserialized keys match the original
        assert_eq!(
            pub_keys.dsa_verification_key.as_bytes(),
            deserialized.dsa_verification_key.as_bytes()
        );
        assert_eq!(
            pub_keys.kem_public_key.as_bytes(),
            deserialized.kem_public_key.as_bytes()
        );
        assert_eq!(
            pub_keys.massa_public_key.to_bytes(),
            deserialized.massa_public_key.to_bytes()
        );
        assert_eq!(pub_keys.evm_public_key, deserialized.evm_public_key);
    }
}
