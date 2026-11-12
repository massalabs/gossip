//! Validation of entries of the signature-authenticated key-value pool.
//!
//! This mirrors, byte for byte, what the client session layer produces and checks
//! (`wasm/sessions/src/session.rs`, `compute_seeker`, `compute_seeker_data_to_sign`
//! and `try_feed_incoming_message`):
//!
//! ```text
//! key   = [32] ‖ blake3(seeker_public_key_bytes) ‖ [1]
//! value = [pk_len] ‖ seeker_public_key_bytes ‖ [sig_len] ‖ signature_bytes ‖ message_bytes
//! sig   = Sign(seeker_keypair, blake3([key_len as u8] ‖ key ‖ message_bytes))
//! ```
//!
//! A node must refuse to store or relay any entry that fails this check: it is the
//! only defence against index squatting on a seeker.

use massa_hash::Hash;
use massa_signature::{PublicKey, Signature};

use crate::blob::{SEEKER_KEY_LEN, SEEKER_KEY_TAG};

/// Why a key-value entry was rejected.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum KvError {
    /// key does not have the seeker layout
    #[error("malformed seeker key")]
    MalformedKey,
    /// value does not have the `[pk_len] pk [sig_len] sig msg` layout
    #[error("malformed value")]
    MalformedValue,
    /// public key bytes are not a valid Massa public key
    #[error("invalid public key")]
    InvalidPublicKey,
    /// signature bytes are not a valid Massa signature
    #[error("invalid signature encoding")]
    InvalidSignatureEncoding,
    /// blake3(public key) does not match the key
    #[error("public key does not match seeker")]
    KeyMismatch,
    /// the signature does not verify
    #[error("signature verification failed")]
    BadSignature,
}

/// Parsed and verified key-value entry.
#[derive(Debug, Clone)]
pub struct KvEntry<'a> {
    /// Seeker public key.
    pub public_key: PublicKey,
    /// Signature over `blake3([key_len] ‖ key ‖ message)`.
    pub signature: Signature,
    /// The Agraphon message bytes (opaque ciphertext).
    pub message: &'a [u8],
}

/// Splits a value into its parts without verifying anything cryptographic.
pub fn parse_kv_value(value: &[u8]) -> Result<KvEntry<'_>, KvError> {
    let pk_len = *value.first().ok_or(KvError::MalformedValue)? as usize;
    let pk_bytes = value.get(1..1 + pk_len).ok_or(KvError::MalformedValue)?;
    let sig_off = 1 + pk_len;
    let sig_len = *value.get(sig_off).ok_or(KvError::MalformedValue)? as usize;
    let sig_bytes = value
        .get(sig_off + 1..sig_off + 1 + sig_len)
        .ok_or(KvError::MalformedValue)?;
    let message = value
        .get(sig_off + 1 + sig_len..)
        .ok_or(KvError::MalformedValue)?;
    let public_key = PublicKey::from_bytes(pk_bytes).map_err(|_| KvError::InvalidPublicKey)?;
    let signature =
        Signature::from_bytes(sig_bytes).map_err(|_| KvError::InvalidSignatureEncoding)?;
    Ok(KvEntry {
        public_key,
        signature,
        message,
    })
}

/// Checks the seeker key layout: `[32] ‖ 32 bytes ‖ [1]`.
pub fn check_seeker_key_layout(key: &[u8]) -> Result<&[u8], KvError> {
    if key.len() != SEEKER_KEY_LEN || key[0] != 32 || key[SEEKER_KEY_LEN - 1] != SEEKER_KEY_TAG {
        return Err(KvError::MalformedKey);
    }
    Ok(&key[1..33])
}

/// The hash the seeker keypair signs: `blake3([key_len as u8] ‖ key ‖ message)`.
pub fn kv_hash_to_sign(key: &[u8], message: &[u8]) -> Hash {
    let mut data = Vec::with_capacity(1 + key.len() + message.len());
    data.push(key.len() as u8);
    data.extend_from_slice(key);
    data.extend_from_slice(message);
    Hash::compute_from(&data)
}

/// Parses the value and checks that the public key matches the key, but does not
/// verify the signature. Returns the material needed for (batch) verification.
pub fn prepare_kv_entry<'a>(key: &[u8], value: &'a [u8]) -> Result<(KvEntry<'a>, Hash), KvError> {
    let key_hash = check_seeker_key_layout(key)?;
    let entry = parse_kv_value(value)?;
    let expected = Hash::compute_from(&entry.public_key.to_bytes());
    if key_hash != expected.to_bytes().as_slice() {
        return Err(KvError::KeyMismatch);
    }
    let hash = kv_hash_to_sign(key, entry.message);
    Ok((entry, hash))
}

/// Full verification of one entry (parse, key match, signature).
pub fn verify_kv_entry<'a>(key: &[u8], value: &'a [u8]) -> Result<KvEntry<'a>, KvError> {
    let (entry, hash) = prepare_kv_entry(key, value)?;
    entry
        .public_key
        .verify_signature(&hash, &entry.signature)
        .map_err(|_| KvError::BadSignature)?;
    Ok(entry)
}

/// Builds a valid entry with the given seeker keypair (used by tests and tools; the
/// real client does this inside `wasm/sessions`).
pub fn build_kv_entry(keypair: &massa_signature::KeyPair, message: &[u8]) -> (Vec<u8>, Vec<u8>) {
    let pk = keypair.get_public_key();
    let pk_bytes = pk.to_bytes();
    let key_hash = Hash::compute_from(&pk_bytes);
    let mut key = Vec::with_capacity(SEEKER_KEY_LEN);
    key.push(32);
    key.extend_from_slice(key_hash.to_bytes());
    key.push(SEEKER_KEY_TAG);
    let sig = keypair.sign(&kv_hash_to_sign(&key, message)).expect("sign");
    let sig_bytes = sig.to_bytes();
    let mut value = Vec::with_capacity(2 + pk_bytes.len() + sig_bytes.len() + message.len());
    value.push(pk_bytes.len() as u8);
    value.extend_from_slice(&pk_bytes);
    value.push(sig_bytes.len() as u8);
    value.extend_from_slice(&sig_bytes);
    value.extend_from_slice(message);
    (key, value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use massa_signature::KeyPair;

    #[test]
    fn roundtrip_valid_entry() {
        let kp = KeyPair::generate(0).unwrap();
        let (key, value) = build_kv_entry(&kp, b"hello agraphon");
        assert_eq!(key.len(), SEEKER_KEY_LEN);
        let entry = verify_kv_entry(&key, &value).unwrap();
        assert_eq!(entry.message, b"hello agraphon");
    }

    #[test]
    fn rejects_tampering() {
        let kp = KeyPair::generate(0).unwrap();
        let (key, value) = build_kv_entry(&kp, b"m");
        // flip message byte
        let mut v = value.clone();
        *v.last_mut().unwrap() ^= 1;
        assert_eq!(
            verify_kv_entry(&key, &v).unwrap_err(),
            KvError::BadSignature
        );
        // wrong key for this value (squatting attempt)
        let other = KeyPair::generate(0).unwrap();
        let (other_key, _) = build_kv_entry(&other, b"m");
        assert_eq!(
            verify_kv_entry(&other_key, &value).unwrap_err(),
            KvError::KeyMismatch
        );
        // malformed key
        assert_eq!(
            verify_kv_entry(&key[..10], &value).unwrap_err(),
            KvError::MalformedKey
        );
        // truncated value
        assert!(verify_kv_entry(&key, &value[..5]).is_err());
    }
}
