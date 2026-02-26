//! Keypair file serialization.
//!
//! Binary format:
//! ```text
//! [version: u32 BE] [pq_pk: PK_SIZE bytes] [sk_nonce: 16 bytes] [sk_ct: remaining]
//! ```

use crate::error::{BordercryptError, Result};
use crate::pq::PqPublicKey;
use crate::storage::KeypairStorage;
use crate::types::SessionIndex;

/// Minimum byte size of a valid keypair file (header only, no `sk_ct`).
const MIN_SIZE: usize = 4 + PqPublicKey::byte_size() + crypto_aead::NONCE_SIZE;

/// Serialized keypair file for a session.
pub struct KeypairFile {
    pub version: u32,
    pub pq_pk: Vec<u8>,
    pub sk_nonce: [u8; crypto_aead::NONCE_SIZE],
    pub sk_ct: Vec<u8>,
}

impl KeypairFile {
    /// Serialize to binary format.
    #[must_use]
    pub fn serialize(&self) -> Vec<u8> {
        let mut buf = Vec::with_capacity(MIN_SIZE + self.sk_ct.len());
        buf.extend_from_slice(&self.version.to_be_bytes());
        buf.extend_from_slice(&self.pq_pk);
        buf.extend_from_slice(&self.sk_nonce);
        buf.extend_from_slice(&self.sk_ct);
        buf
    }

    /// Deserialize from binary format.
    pub fn deserialize(data: &[u8]) -> Result<Self> {
        if data.len() < MIN_SIZE {
            return Err(BordercryptError::CorruptedBlock);
        }

        let mut offset = 0;

        let version = u32::from_be_bytes(
            data[offset..offset + 4]
                .try_into()
                .map_err(|_| BordercryptError::CorruptedBlock)?,
        );
        offset += 4;

        let pk_size = PqPublicKey::byte_size();
        let pq_pk = data[offset..offset + pk_size].to_vec();
        offset += pk_size;

        let sk_nonce: [u8; crypto_aead::NONCE_SIZE] = data
            [offset..offset + crypto_aead::NONCE_SIZE]
            .try_into()
            .map_err(|_| BordercryptError::CorruptedBlock)?;
        offset += crypto_aead::NONCE_SIZE;

        let sk_ct = data[offset..].to_vec();

        Ok(Self {
            version,
            pq_pk,
            sk_nonce,
            sk_ct,
        })
    }
}

/// Read and deserialize a session's keypair file from storage.
pub fn read_session_keypair<S: KeypairStorage>(
    storage: &S,
    session: SessionIndex,
) -> Result<KeypairFile> {
    let data = storage.read_keypair(session)?;
    KeypairFile::deserialize(&data)
}

/// Read only the version and public key from a session's keypair file.
pub fn read_session_version_and_pk<S: KeypairStorage>(
    storage: &S,
    session: SessionIndex,
) -> Result<(u32, Vec<u8>)> {
    let kf = read_session_keypair(storage, session)?;
    Ok((kf.version, kf.pq_pk))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_keypair_file() -> KeypairFile {
        KeypairFile {
            version: 1,
            pq_pk: vec![0xAA; PqPublicKey::byte_size()],
            sk_nonce: [0xBB; crypto_aead::NONCE_SIZE],
            sk_ct: vec![0xCC; 100],
        }
    }

    #[test]
    fn serialize_deserialize_roundtrip() {
        let kf = make_keypair_file();
        let bytes = kf.serialize();
        let kf2 = KeypairFile::deserialize(&bytes).unwrap();
        assert_eq!(kf.version, kf2.version);
        assert_eq!(kf.pq_pk, kf2.pq_pk);
        assert_eq!(kf.sk_nonce, kf2.sk_nonce);
        assert_eq!(kf.sk_ct, kf2.sk_ct);
    }

    #[test]
    fn version_big_endian() {
        let kf = KeypairFile {
            version: 0x01020304,
            pq_pk: vec![0; PqPublicKey::byte_size()],
            sk_nonce: [0; crypto_aead::NONCE_SIZE],
            sk_ct: vec![],
        };
        let bytes = kf.serialize();
        assert_eq!(&bytes[..4], &[0x01, 0x02, 0x03, 0x04]);
    }

    #[test]
    fn deserialize_truncated() {
        let data = vec![0u8; MIN_SIZE - 1];
        assert!(KeypairFile::deserialize(&data).is_err());
    }

    #[test]
    fn deserialize_empty() {
        assert!(KeypairFile::deserialize(&[]).is_err());
    }

    #[test]
    fn pk_size_matches_pq_rerand() {
        assert_eq!(PqPublicKey::byte_size(), 4 * pq_rerand::params::N * 4);
    }
}
