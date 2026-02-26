//! Wrapper around the `pq_rerand` library.
//!
//! Adapts the polynomial-based API to a byte-oriented interface suitable
//! for bordercrypt's block-level operations.

use zeroize::{Zeroize, Zeroizing};

use crate::constants::BLOCK_SIZE;
use crate::error::{BordercryptError, Result};

/// NTT tables computed at compile time — zero runtime cost.
const NTT_CTX: pq_rerand::poly::NttContext = pq_rerand::poly::NttContext::new();

/// Plaintext message size per pq-rerand slot.
pub const PQ_MSG_SIZE: usize = pq_rerand::params::SLOT_BYTES;

/// Ciphertext size per pq-rerand slot.
pub const PQ_CT_SIZE: usize = pq_rerand::serialize::SLOT_CT_BYTES;

const _: () = assert!(PQ_CT_SIZE == BLOCK_SIZE);

/// Byte size of a serialized public key (4 arrays of 4096 little-endian u32s).
const PK_BYTE_SIZE: usize = 4 * pq_rerand::params::N * 4;

/// Byte size of a serialized secret key (2 arrays of 4096 little-endian u32s).
const SK_BYTE_SIZE: usize = 2 * pq_rerand::params::N * 4;

/// Post-quantum public key for encryption and re-randomization.
pub struct PqPublicKey(pq_rerand::keygen::PublicKey);

/// Post-quantum secret key for decryption.
///
/// Does not implement `Debug` or `Clone` to prevent accidental leakage.
/// Zeroized on drop.
pub struct PqSecretKey(Option<pq_rerand::keygen::SecretKey>);

impl Drop for PqSecretKey {
    fn drop(&mut self) {
        if let Some(ref mut sk) = self.0 {
            sk.s_t.zeroize();
            sk.s_q2.zeroize();
        }
    }
}

/// Generate a fresh pq-rerand keypair.
pub fn pq_keygen() -> (PqPublicKey, PqSecretKey) {
    let ctx = &NTT_CTX;
    let mut rng = rand::rngs::OsRng;
    let (sk, pk) = pq_rerand::keygen::keygen(&mut rng, ctx);
    (PqPublicKey(pk), PqSecretKey(Some(sk)))
}

/// Encrypt a message into a ciphertext block.
///
/// `message` must be exactly `PQ_MSG_SIZE` bytes.
/// Returns a boxed ciphertext of exactly `PQ_CT_SIZE` bytes.
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
/// `ciphertext` must be exactly `PQ_CT_SIZE` bytes.
///
/// Ring-LWE always decrypts — it is the AEAD layer above that detects
/// tampering. The returned bytes may be garbage if the ciphertext was
/// modified.
pub fn pq_decrypt(sk: &PqSecretKey, ciphertext: &[u8; PQ_CT_SIZE]) -> Zeroizing<Vec<u8>> {
    let ctx = &NTT_CTX;
    let ct = pq_rerand::serialize::deserialize_slot(ciphertext);
    let sk_inner = sk.0.as_ref().expect("secret key consumed");
    let coeffs = Zeroizing::new(pq_rerand::decrypt::decrypt_slot(ctx, sk_inner, &ct));
    Zeroizing::new(pq_rerand::encoding::decode(&coeffs))
}

/// Re-randomize a ciphertext block using only the public key.
///
/// The decrypted plaintext is unchanged but the ciphertext bytes differ.
/// `ciphertext` must be exactly `PQ_CT_SIZE` bytes.
pub fn pq_rerand(pk: &PqPublicKey, ciphertext: &[u8; PQ_CT_SIZE]) -> Vec<u8> {
    let ctx = &NTT_CTX;
    let mut rng = rand::rngs::OsRng;
    let ct = pq_rerand::serialize::deserialize_slot(ciphertext);
    let ct_new = pq_rerand::rerandomize::rerandomize_slot(&mut rng, ctx, &pk.0, &ct);
    pq_rerand::serialize::serialize_slot(&ct_new)
}

impl PqPublicKey {
    /// Serialized byte size of a public key.
    #[must_use]
    pub const fn byte_size() -> usize {
        PK_BYTE_SIZE
    }

    /// Serialize to bytes (little-endian u32 arrays).
    #[must_use]
    pub fn to_bytes(&self) -> Vec<u8> {
        let mut buf = Vec::with_capacity(PK_BYTE_SIZE);
        for arr in [
            &self.0.a_ntt_t,
            &self.0.a_ntt_q2,
            &self.0.b_ntt_t,
            &self.0.b_ntt_q2,
        ] {
            for &val in arr.iter() {
                buf.extend_from_slice(&val.to_le_bytes());
            }
        }
        buf
    }

    /// Deserialize from bytes.
    pub fn from_bytes(data: &[u8]) -> Result<Self> {
        if data.len() != PK_BYTE_SIZE {
            return Err(BordercryptError::CorruptedBlock);
        }
        let mut pk = pq_rerand::keygen::PublicKey {
            a_ntt_t: [0u32; pq_rerand::params::N],
            a_ntt_q2: [0u32; pq_rerand::params::N],
            b_ntt_t: [0u32; pq_rerand::params::N],
            b_ntt_q2: [0u32; pq_rerand::params::N],
        };
        let arrays: [&mut [u32; pq_rerand::params::N]; 4] = [
            &mut pk.a_ntt_t,
            &mut pk.a_ntt_q2,
            &mut pk.b_ntt_t,
            &mut pk.b_ntt_q2,
        ];
        let mut offset = 0;
        for arr in arrays {
            for val in arr.iter_mut() {
                let bytes: [u8; 4] = data[offset..offset + 4]
                    .try_into()
                    .map_err(|_| BordercryptError::CorruptedBlock)?;
                *val = u32::from_le_bytes(bytes);
                offset += 4;
            }
        }
        Ok(Self(pk))
    }
}

impl PqSecretKey {
    /// Serialize to bytes (little-endian u32 arrays).
    ///
    /// Returned buffer is zeroized on drop.
    #[must_use]
    pub fn to_bytes(&self) -> Zeroizing<Vec<u8>> {
        let sk = self.0.as_ref().expect("secret key consumed");
        let mut buf = Vec::with_capacity(SK_BYTE_SIZE);
        for arr in [&sk.s_t, &sk.s_q2] {
            for &val in arr.iter() {
                buf.extend_from_slice(&val.to_le_bytes());
            }
        }
        Zeroizing::new(buf)
    }

    /// Deserialize from bytes.
    pub fn from_bytes(data: &[u8]) -> Result<Self> {
        if data.len() != SK_BYTE_SIZE {
            return Err(BordercryptError::CorruptedBlock);
        }
        let mut sk = pq_rerand::keygen::SecretKey {
            s_t: [0u32; pq_rerand::params::N],
            s_q2: [0u32; pq_rerand::params::N],
        };
        let arrays: [&mut [u32; pq_rerand::params::N]; 2] = [&mut sk.s_t, &mut sk.s_q2];
        let mut offset = 0;
        for arr in arrays {
            for val in arr.iter_mut() {
                let bytes: [u8; 4] = data[offset..offset + 4]
                    .try_into()
                    .map_err(|_| BordercryptError::CorruptedBlock)?;
                *val = u32::from_le_bytes(bytes);
                offset += 4;
            }
        }
        Ok(Self(Some(sk)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keygen_produces_valid_keys() {
        let (pk, sk) = pq_keygen();
        assert_eq!(pk.to_bytes().len(), PK_BYTE_SIZE);
        assert_eq!(sk.to_bytes().len(), SK_BYTE_SIZE);
    }

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
        let decrypted = pq_decrypt(&sk, ct_arr);
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
        let ct2 = pq_rerand(&pk, ct_arr);
        let ct2_arr: &[u8; PQ_CT_SIZE] = ct2.as_slice().try_into().unwrap();
        let decrypted = pq_decrypt(&sk, ct2_arr);
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
            ct = pq_rerand(&pk, ct_arr);
        }
        let ct_arr: &[u8; PQ_CT_SIZE] = ct.as_slice().try_into().unwrap();
        let decrypted = pq_decrypt(&sk, ct_arr);
        assert_eq!(*decrypted, msg);
    }

    #[test]
    fn rerand_changes_ciphertext() {
        let (pk, _sk) = pq_keygen();
        let msg = [0u8; PQ_MSG_SIZE];
        let ct = pq_encrypt(&pk, &msg);
        let ct_arr: &[u8; PQ_CT_SIZE] = ct.as_slice().try_into().unwrap();
        let ct2 = pq_rerand(&pk, ct_arr);
        assert_ne!(ct, ct2);
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
    fn pk_from_invalid_bytes() {
        assert!(PqPublicKey::from_bytes(&[0u8; 10]).is_err());
    }

    #[test]
    fn sk_from_invalid_bytes() {
        assert!(PqSecretKey::from_bytes(&[0u8; 10]).is_err());
    }
}
