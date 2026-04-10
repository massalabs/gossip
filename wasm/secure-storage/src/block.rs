//! Block-level encrypt, decrypt, cover, and re-randomize operations.
//!
//! Each block goes through two encryption layers:
//! 1. AEAD (AES-SIV) for integrity and authentication
//! 2. pq-rerand for post-quantum deniability and re-randomization

use rand::RngCore;
use zeroize::Zeroizing;

use crate::constants::{AEAD_TAG_SIZE, BLOCK_SIZE, PLAINTEXT_SIZE};
use crate::error::{SecureStorageError, Result};
use crate::pq::{PQ_MSG_SIZE, PqPublicKey, PqSecretKey, pq_decrypt, pq_encrypt, pq_rerand};

const BLOCK_AEAD_SUFFIX: &str = ":block_aead";

/// Encrypt a plaintext block into an on-disk ciphertext block.
///
/// Flow: random nonce -> AEAD encrypt -> pq-rerand encrypt.
#[must_use]
pub fn encrypt_block(
    pq_pk: &PqPublicKey,
    aead_key: &[u8; crypto_aead::KEY_SIZE],
    aad_root: &str,
    plaintext: &[u8; PLAINTEXT_SIZE],
) -> Vec<u8> {
    let aad = format!("{aad_root}{BLOCK_AEAD_SUFFIX}");
    let mut nonce_bytes = [0u8; crypto_aead::NONCE_SIZE];
    rand::rngs::OsRng.fill_bytes(&mut nonce_bytes);
    let nonce = crypto_aead::Nonce::from(nonce_bytes);
    let key = crypto_aead::Key::from_ref(aead_key);

    let aead_ct = crypto_aead::encrypt(&key, &nonce, plaintext, aad.as_bytes());

    let mut msg = Zeroizing::new([0u8; PQ_MSG_SIZE]);
    msg[..crypto_aead::NONCE_SIZE].copy_from_slice(&nonce_bytes);
    msg[crypto_aead::NONCE_SIZE..].copy_from_slice(&aead_ct);

    pq_encrypt(pq_pk, &msg)
}

/// Decrypt an on-disk ciphertext block back to plaintext.
///
/// Flow: pq-rerand decrypt -> split nonce || aead_ct -> AEAD decrypt.
pub fn decrypt_block(
    pq_sk: &PqSecretKey,
    aead_key: &[u8; crypto_aead::KEY_SIZE],
    aad_root: &str,
    block_ct: &[u8; BLOCK_SIZE],
) -> Result<Zeroizing<[u8; PLAINTEXT_SIZE]>> {
    let aad = format!("{aad_root}{BLOCK_AEAD_SUFFIX}");
    let msg = pq_decrypt(pq_sk, block_ct);

    let nonce = crypto_aead::Nonce::from(
        <[u8; crypto_aead::NONCE_SIZE]>::try_from(&msg[..crypto_aead::NONCE_SIZE])
            .map_err(|_| SecureStorageError::CorruptedBlock)?,
    );
    let aead_ct = &msg[crypto_aead::NONCE_SIZE..];
    let key = crypto_aead::Key::from_ref(aead_key);

    let plaintext_vec = Zeroizing::new(
        crypto_aead::decrypt(&key, &nonce, aead_ct, aad.as_bytes())
            .ok_or(SecureStorageError::CorruptedBlock)?,
    );

    let mut plaintext = Zeroizing::new([0u8; PLAINTEXT_SIZE]);
    if plaintext_vec.len() != PLAINTEXT_SIZE {
        return Err(SecureStorageError::CorruptedBlock);
    }
    plaintext.copy_from_slice(&plaintext_vec);
    Ok(plaintext)
}

/// Create a cover block indistinguishable from a genuine encrypted block.
///
/// Uses a throwaway AEAD key so the block looks structurally valid
/// under pq-rerand decryption but fails AEAD authentication.
#[must_use]
pub fn create_cover_block(pq_pk: &PqPublicKey, aad_root: &str) -> Vec<u8> {
    let aad = format!("{aad_root}{BLOCK_AEAD_SUFFIX}");
    let mut rng = rand::rngs::OsRng;

    let mut tmp_key_bytes = Zeroizing::new([0u8; crypto_aead::KEY_SIZE]);
    rng.fill_bytes(tmp_key_bytes.as_mut());
    let tmp_key = crypto_aead::Key::from_ref(&tmp_key_bytes);

    let mut nonce_bytes = [0u8; crypto_aead::NONCE_SIZE];
    rng.fill_bytes(&mut nonce_bytes);
    let nonce = crypto_aead::Nonce::from(nonce_bytes);

    let mut plaintext = Zeroizing::new([0u8; PLAINTEXT_SIZE]);
    rng.fill_bytes(plaintext.as_mut());

    let aead_ct = crypto_aead::encrypt(&tmp_key, &nonce, plaintext.as_ref(), aad.as_bytes());

    let mut msg = Zeroizing::new([0u8; PQ_MSG_SIZE]);
    msg[..crypto_aead::NONCE_SIZE].copy_from_slice(&nonce_bytes);
    msg[crypto_aead::NONCE_SIZE..].copy_from_slice(&aead_ct);

    pq_encrypt(pq_pk, &msg)
}

/// Re-randomize a ciphertext block using only the public key.
///
/// The decrypted plaintext is unchanged but the ciphertext bytes differ.
#[must_use]
pub fn rerandomize_block(pq_pk: &PqPublicKey, block_ct: &[u8; BLOCK_SIZE]) -> Vec<u8> {
    pq_rerand(pq_pk, block_ct)
}

// Compile-time check: nonce + AEAD output = PQ_MSG_SIZE.
const _: () = assert!(
    crypto_aead::NONCE_SIZE + PLAINTEXT_SIZE + AEAD_TAG_SIZE == PQ_MSG_SIZE,
    "nonce + AEAD ciphertext must fill exactly one pq-rerand slot"
);

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pq::pq_keygen;

    fn test_aead_key() -> [u8; crypto_aead::KEY_SIZE] {
        let mut key = [0u8; crypto_aead::KEY_SIZE];
        for (i, b) in key.iter_mut().enumerate() {
            *b = i as u8;
        }
        key
    }

    const AAD_ROOT: &str = "test:secureStorage:session:v0:i0:b0";

    // --- encrypt / decrypt ---

    #[test]
    fn encrypt_decrypt_roundtrip() {
        let (pk, sk) = pq_keygen();
        let key = test_aead_key();
        let mut pt = [0u8; PLAINTEXT_SIZE];
        pt[0] = 42;
        pt[PLAINTEXT_SIZE - 1] = 0xFF;

        let ct = encrypt_block(&pk, &key, AAD_ROOT, &pt);
        let ct_arr: &[u8; BLOCK_SIZE] = ct.as_slice().try_into().unwrap();
        let decrypted = decrypt_block(&sk, &key, AAD_ROOT, ct_arr).unwrap();
        assert_eq!(*decrypted, pt);
    }

    #[test]
    fn wrong_aead_key_fails() {
        let (pk, sk) = pq_keygen();
        let key = test_aead_key();
        let pt = [0u8; PLAINTEXT_SIZE];

        let ct = encrypt_block(&pk, &key, AAD_ROOT, &pt);
        let ct_arr: &[u8; BLOCK_SIZE] = ct.as_slice().try_into().unwrap();

        let mut wrong_key = test_aead_key();
        wrong_key[0] ^= 0xFF;
        assert!(decrypt_block(&sk, &wrong_key, AAD_ROOT, ct_arr).is_err());
    }

    #[test]
    fn wrong_pq_sk_fails() {
        let (pk, _sk) = pq_keygen();
        let (_pk2, sk2) = pq_keygen();
        let key = test_aead_key();
        let pt = [0u8; PLAINTEXT_SIZE];

        let ct = encrypt_block(&pk, &key, AAD_ROOT, &pt);
        let ct_arr: &[u8; BLOCK_SIZE] = ct.as_slice().try_into().unwrap();
        assert!(decrypt_block(&sk2, &key, AAD_ROOT, ct_arr).is_err());
    }

    #[test]
    fn output_sizes() {
        let (pk, sk) = pq_keygen();
        let key = test_aead_key();
        let pt = [0u8; PLAINTEXT_SIZE];

        let ct = encrypt_block(&pk, &key, AAD_ROOT, &pt);
        assert_eq!(ct.len(), BLOCK_SIZE);

        let ct_arr: &[u8; BLOCK_SIZE] = ct.as_slice().try_into().unwrap();
        let decrypted = decrypt_block(&sk, &key, AAD_ROOT, ct_arr).unwrap();
        assert_eq!(decrypted.len(), PLAINTEXT_SIZE);
    }

    #[test]
    fn different_nonces() {
        let (pk, _sk) = pq_keygen();
        let key = test_aead_key();
        let pt = [0u8; PLAINTEXT_SIZE];

        let ct1 = encrypt_block(&pk, &key, AAD_ROOT, &pt);
        let ct2 = encrypt_block(&pk, &key, AAD_ROOT, &pt);
        assert_ne!(ct1, ct2);
    }

    #[test]
    fn aad_binding() {
        let (pk, sk) = pq_keygen();
        let key = test_aead_key();
        let pt = [0u8; PLAINTEXT_SIZE];

        let ct = encrypt_block(&pk, &key, "aad_A", &pt);
        let ct_arr: &[u8; BLOCK_SIZE] = ct.as_slice().try_into().unwrap();
        assert!(decrypt_block(&sk, &key, "aad_B", ct_arr).is_err());
    }

    // --- cover ---

    #[test]
    fn cover_block_size() {
        let (pk, _sk) = pq_keygen();
        let ct = create_cover_block(&pk, AAD_ROOT);
        assert_eq!(ct.len(), BLOCK_SIZE);
    }

    #[test]
    fn cover_block_not_decryptable() {
        let (pk, sk) = pq_keygen();
        let key = test_aead_key();
        let ct = create_cover_block(&pk, AAD_ROOT);
        let ct_arr: &[u8; BLOCK_SIZE] = ct.as_slice().try_into().unwrap();
        assert!(decrypt_block(&sk, &key, AAD_ROOT, ct_arr).is_err());
    }

    #[test]
    fn cover_block_valid_inner_structure() {
        let (pk, sk) = pq_keygen();
        let ct = create_cover_block(&pk, AAD_ROOT);
        let ct_arr: &[u8; BLOCK_SIZE] = ct.as_slice().try_into().unwrap();
        let msg = pq_decrypt(&sk, ct_arr);
        // Inner message should be exactly PQ_MSG_SIZE bytes with
        // nonce (16) + AEAD ciphertext (PLAINTEXT_SIZE + AEAD_TAG_SIZE).
        assert_eq!(msg.len(), PQ_MSG_SIZE);
    }

    #[test]
    fn two_cover_blocks_different() {
        let (pk, _sk) = pq_keygen();
        let ct1 = create_cover_block(&pk, AAD_ROOT);
        let ct2 = create_cover_block(&pk, AAD_ROOT);
        assert_ne!(ct1, ct2);
    }

    // --- rerand ---

    #[test]
    fn rerand_preserves_plaintext() {
        let (pk, sk) = pq_keygen();
        let key = test_aead_key();
        let mut pt = [0u8; PLAINTEXT_SIZE];
        pt[100] = 0xAB;

        let ct = encrypt_block(&pk, &key, AAD_ROOT, &pt);
        let ct_arr: &[u8; BLOCK_SIZE] = ct.as_slice().try_into().unwrap();
        let ct2 = rerandomize_block(&pk, ct_arr);
        let ct2_arr: &[u8; BLOCK_SIZE] = ct2.as_slice().try_into().unwrap();
        let decrypted = decrypt_block(&sk, &key, AAD_ROOT, ct2_arr).unwrap();
        assert_eq!(*decrypted, pt);
    }

    #[test]
    fn rerand_changes_ciphertext() {
        let (pk, _sk) = pq_keygen();
        let key = test_aead_key();
        let pt = [0u8; PLAINTEXT_SIZE];

        let ct = encrypt_block(&pk, &key, AAD_ROOT, &pt);
        let ct_arr: &[u8; BLOCK_SIZE] = ct.as_slice().try_into().unwrap();
        let ct2 = rerandomize_block(&pk, ct_arr);
        assert_ne!(ct, ct2);
    }

    #[test]
    fn multiple_rerands() {
        let (pk, sk) = pq_keygen();
        let key = test_aead_key();
        let mut pt = [0u8; PLAINTEXT_SIZE];
        pt[0] = 0xDE;

        let mut ct = encrypt_block(&pk, &key, AAD_ROOT, &pt);
        for _ in 0..10 {
            let ct_arr: &[u8; BLOCK_SIZE] = ct.as_slice().try_into().unwrap();
            ct = rerandomize_block(&pk, ct_arr);
        }
        let ct_arr: &[u8; BLOCK_SIZE] = ct.as_slice().try_into().unwrap();
        let decrypted = decrypt_block(&sk, &key, AAD_ROOT, ct_arr).unwrap();
        assert_eq!(*decrypted, pt);
    }

    #[test]
    fn rerand_output_size() {
        let (pk, _sk) = pq_keygen();
        let key = test_aead_key();
        let pt = [0u8; PLAINTEXT_SIZE];

        let ct = encrypt_block(&pk, &key, AAD_ROOT, &pt);
        let ct_arr: &[u8; BLOCK_SIZE] = ct.as_slice().try_into().unwrap();
        let ct2 = rerandomize_block(&pk, ct_arr);
        assert_eq!(ct2.len(), BLOCK_SIZE);
    }
}
