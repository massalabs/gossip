//! Wrapper around the `pq_rerand` library.
//!
//! Adapts the polynomial-based API to a byte-oriented interface suitable
//! for secure_storage's block-level operations.

use zeroize::{Zeroize, ZeroizeOnDrop, Zeroizing};

use crate::constants::BLOCK_SIZE;
use crate::error::{Result, SecureStorageError};

/// NTT tables computed at compile time — zero runtime cost.
const NTT_CTX: pq_rerand::poly::NttContext = pq_rerand::poly::NttContext::new();

/// Plaintext message size per pq-rerand slot.
pub const PQ_MSG_SIZE: usize = pq_rerand::params::SLOT_BYTES;

/// Ciphertext size per pq-rerand slot.
pub const PQ_CT_SIZE: usize = pq_rerand::serialize::SLOT_CT_BYTES;

const _: () = assert!(
    PQ_CT_SIZE == BLOCK_SIZE,
    "pq-rerand ciphertext slot size must equal secure_storage block size"
);

/// Post-quantum public key for encryption and re-randomization.
pub struct PqPublicKey(pq_rerand::keygen::PublicKey);

impl Zeroize for PqPublicKey {
    fn zeroize(&mut self) {
        self.0.a_ntt_t.zeroize();
        self.0.a_ntt_q2.zeroize();
        self.0.b_ntt_t.zeroize();
        self.0.b_ntt_q2.zeroize();
    }
}

impl Drop for PqPublicKey {
    fn drop(&mut self) {
        self.zeroize();
    }
}

// SAFETY: manual Drop calls zeroize() — satisfies ZeroizeOnDrop contract.
impl ZeroizeOnDrop for PqPublicKey {}

/// Post-quantum secret key for decryption.
pub struct PqSecretKey(pq_rerand::keygen::SecretKey);

impl Zeroize for PqSecretKey {
    fn zeroize(&mut self) {
        self.0.zeroize();
    }
}

impl Drop for PqSecretKey {
    fn drop(&mut self) {
        self.zeroize();
    }
}

// SAFETY: manual Drop calls zeroize() — satisfies ZeroizeOnDrop contract.
impl ZeroizeOnDrop for PqSecretKey {}

/// Generate a fresh pq-rerand keypair.
#[must_use]
pub fn pq_keygen() -> (PqPublicKey, PqSecretKey) {
    let ctx = &NTT_CTX;
    // OsRng because pq-rerand requires `rand::Rng`; same getrandom source as crypto_rng.
    let mut rng = rand::rngs::OsRng;
    let (sk, pk) = pq_rerand::keygen::keygen(&mut rng, ctx);
    (PqPublicKey(pk), PqSecretKey(sk))
}

/// Encrypt a message into a ciphertext block.
#[must_use]
pub fn pq_encrypt(pk: &PqPublicKey, message: &[u8; PQ_MSG_SIZE]) -> Vec<u8> {
    let ctx = &NTT_CTX;
    let mut rng = rand::rngs::OsRng;
    let mut coeffs = Zeroizing::new(pq_rerand::encoding::encode(message));
    let ct = pq_rerand::encrypt::encrypt_slot(
        &mut rng,
        ctx,
        &pk.0,
        &coeffs,
        pq_rerand::params::SIGMA_FLOOD,
    );
    // Explicitly zeroize before serialize_slot allocates, to minimize
    // the window where plaintext polynomials sit in memory.
    coeffs.zeroize();
    pq_rerand::serialize::serialize_slot(&ct)
}

/// Decrypt a ciphertext block back to the original message.
///
/// Rejects ciphertexts whose serialized coefficients are noncanonical.
/// Canonically encoded tampering may still decrypt to arbitrary message
/// bytes; the AEAD layer above authenticates those bytes. Both failures
/// surface as [`SecureStorageError::CorruptedBlock`].
pub fn pq_decrypt(sk: &PqSecretKey, ciphertext: &[u8; PQ_CT_SIZE]) -> Result<Zeroizing<Vec<u8>>> {
    let ctx = &NTT_CTX;
    let ct = pq_rerand::serialize::deserialize_slot(ciphertext)
        .ok_or(SecureStorageError::CorruptedBlock)?;
    let coeffs = Zeroizing::new(pq_rerand::decrypt::decrypt_slot(ctx, &sk.0, &ct));
    Ok(Zeroizing::new(pq_rerand::encoding::decode(&coeffs)))
}

/// Re-randomize a ciphertext block using only the public key.
///
/// The decrypted plaintext is unchanged but the ciphertext bytes differ.
pub fn validate_pq_ciphertext(ciphertext: &[u8]) -> Result<()> {
    pq_rerand::serialize::deserialize_slot(ciphertext)
        .map(|_| ())
        .ok_or(SecureStorageError::CorruptedBlock)
}

pub fn pq_rerand(pk: &PqPublicKey, ciphertext: &[u8; PQ_CT_SIZE]) -> Result<Vec<u8>> {
    let ctx = &NTT_CTX;
    let mut rng = rand::rngs::OsRng;
    let ct = pq_rerand::serialize::deserialize_slot(ciphertext)
        .ok_or(SecureStorageError::CorruptedBlock)?;
    let ct_new = pq_rerand::rerandomize::rerandomize_slot(&mut rng, ctx, &pk.0, &ct);
    Ok(pq_rerand::serialize::serialize_slot(&ct_new))
}

impl PqPublicKey {
    // Persistence compatibility boundary: pq-rerand serializes public keys in
    // its internal NTT representation. Revision 9a5a48b is the baseline for
    // persisted storage; an earlier NTT layout cannot be used directly with it.
    // Before bumping pq-rerand again, verify a persisted 9a5a48b key fixture can
    // still encrypt and rerandomize, or add an explicitly versioned migration.

    /// Serialized byte size of a public key.
    #[must_use]
    pub const fn byte_size() -> usize {
        pq_rerand::keygen::PublicKey::BYTES
    }

    /// Serialize to bytes (little-endian u32 arrays).
    #[must_use]
    pub fn to_bytes(&self) -> Vec<u8> {
        self.0.to_bytes()
    }

    /// Deserialize from bytes.
    pub fn from_bytes(data: &[u8]) -> Result<Self> {
        pq_rerand::keygen::PublicKey::from_bytes(data)
            .map(Self)
            .ok_or(SecureStorageError::CorruptedBlock)
    }
}

impl PqSecretKey {
    /// Serialized byte size of a secret key.
    #[must_use]
    pub const fn byte_size() -> usize {
        pq_rerand::keygen::SecretKey::BYTES
    }

    /// Serialize to bytes (little-endian u32 arrays).
    ///
    /// Returned buffer is zeroized on drop.
    #[must_use]
    pub fn to_bytes(&self) -> Zeroizing<Vec<u8>> {
        self.0.to_bytes()
    }

    /// Deserialize from bytes.
    pub fn from_bytes(data: &[u8]) -> Result<Self> {
        pq_rerand::keygen::SecretKey::from_bytes(data)
            .map(Self)
            .ok_or(SecureStorageError::CorruptedBlock)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encrypt_decrypt_roundtrip() {
        let (pk, sk) = pq_keygen();
        let mut msg = [0u8; PQ_MSG_SIZE];
        for (i, b) in msg.iter_mut().enumerate() {
            *b = (i % 256) as u8;
        }
        let ct = pq_encrypt(&pk, &msg);
        assert_eq!(ct.len(), PQ_CT_SIZE);
        let ct_arr: &[u8; PQ_CT_SIZE] = ct.as_slice().try_into().unwrap();
        let decrypted = pq_decrypt(&sk, ct_arr).unwrap();
        assert_eq!(*decrypted, msg);
    }

    #[test]
    fn rerand_decrypt_roundtrip() {
        let (pk, sk) = pq_keygen();
        let mut msg = [0u8; PQ_MSG_SIZE];
        msg[0] = 42;
        msg[PQ_MSG_SIZE - 1] = 0xFF;
        let ct = pq_encrypt(&pk, &msg);
        let ct_arr: &[u8; PQ_CT_SIZE] = ct.as_slice().try_into().unwrap();
        let ct2 = pq_rerand(&pk, ct_arr).unwrap();
        let ct2_arr: &[u8; PQ_CT_SIZE] = ct2.as_slice().try_into().unwrap();
        let decrypted = pq_decrypt(&sk, ct2_arr).unwrap();
        assert_eq!(*decrypted, msg);
    }

    #[test]
    fn multiple_rerands() {
        let (pk, sk) = pq_keygen();
        let mut msg = [0u8; PQ_MSG_SIZE];
        msg[100] = 0xAB;
        let mut ct = pq_encrypt(&pk, &msg);
        for _ in 0..10 {
            let ct_arr: &[u8; PQ_CT_SIZE] = ct.as_slice().try_into().unwrap();
            ct = pq_rerand(&pk, ct_arr).unwrap();
        }
        let ct_arr: &[u8; PQ_CT_SIZE] = ct.as_slice().try_into().unwrap();
        let decrypted = pq_decrypt(&sk, ct_arr).unwrap();
        assert_eq!(*decrypted, msg);
    }

    #[test]
    fn rerand_changes_ciphertext() {
        let (pk, _sk) = pq_keygen();
        let msg = [0u8; PQ_MSG_SIZE];
        let ct = pq_encrypt(&pk, &msg);
        let ct_arr: &[u8; PQ_CT_SIZE] = ct.as_slice().try_into().unwrap();
        let ct2 = pq_rerand(&pk, ct_arr).unwrap();
        assert_ne!(ct, ct2);
    }

    #[test]
    fn malformed_ciphertext_is_rejected() {
        let (pk, sk) = pq_keygen();
        let ciphertext = [u8::MAX; PQ_CT_SIZE];

        assert!(pq_decrypt(&sk, &ciphertext).is_err());
        assert!(pq_rerand(&pk, &ciphertext).is_err());
    }

    #[test]
    fn pk_serialization_roundtrip() {
        let (pk, _sk) = pq_keygen();
        let bytes = pk.to_bytes();
        let pk2 = PqPublicKey::from_bytes(&bytes).unwrap();
        assert_eq!(pk.to_bytes(), pk2.to_bytes());
    }

    #[test]
    fn sk_serialization_roundtrip() {
        let (_pk, sk) = pq_keygen();
        let bytes = sk.to_bytes();
        let sk2 = PqSecretKey::from_bytes(&bytes).unwrap();
        assert_eq!(*sk.to_bytes(), *sk2.to_bytes());
    }

    #[test]
    fn explicit_sk_zeroize_clears_all_representations() {
        let (_pk, mut sk) = pq_keygen();
        sk.zeroize();

        assert!(sk.0.s_t.iter().all(|&value| value == 0));
        assert!(sk.0.s_q2.iter().all(|&value| value == 0));
        assert!(sk.0.s_ntt_t.iter().all(|&value| value == 0));
        assert!(sk.0.s_ntt_q2.iter().all(|&value| value == 0));
    }

    #[test]
    fn pk_from_invalid_bytes() {
        assert!(PqPublicKey::from_bytes(&[0u8; 10]).is_err());
    }

    #[test]
    fn sk_from_invalid_bytes() {
        assert!(PqSecretKey::from_bytes(&[0u8; 10]).is_err());
    }
}
