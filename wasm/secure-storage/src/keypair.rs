//! Versioned keypair-envelope serialization.
//!
//! Legacy v0 (frozen decoder):
//! ```text
//! [version: u32 BE] [pq_pk] [sk_nonce: 16] [sk_ct]
//! ```
//!
//! Current v1:
//! ```text
//! [version: u32 BE] [pk_len: u32 BE] [nonce_len: u32 BE]
//! [sk_ct_len: u32 BE] [pq_pk] [sk_nonce] [sk_ct]
//! ```

use crate::constants::AEAD_TAG_SIZE;
use crate::error::{Result, SecureStorageError};
use crate::pq::{PqPublicKey, PqSecretKey};
use crate::storage::KeypairStorage;
use crate::types::SessionIndex;

pub const LEGACY_SESSION_VERSION: u32 = 0;
pub const CURRENT_SESSION_VERSION: u32 = 1;

const VERSION_SIZE: usize = 4;
const V1_LENGTHS_SIZE: usize = 12;
const V1_HEADER_SIZE: usize = VERSION_SIZE + V1_LENGTHS_SIZE;
const EXPECTED_SECRET_CIPHERTEXT_SIZE: usize = PqSecretKey::byte_size() + AEAD_TAG_SIZE;
const LEGACY_VALUE_SIZE: usize = VERSION_SIZE
    + PqPublicKey::byte_size()
    + crypto_aead::NONCE_SIZE
    + EXPECTED_SECRET_CIPHERTEXT_SIZE;
const CURRENT_VALUE_SIZE: usize = V1_HEADER_SIZE
    + PqPublicKey::byte_size()
    + crypto_aead::NONCE_SIZE
    + EXPECTED_SECRET_CIPHERTEXT_SIZE;
const V1_AAD_MAGIC: &[u8; 8] = b"GOSSIPKP";

#[must_use]
pub fn is_supported_session_version(version: u32) -> bool {
    matches!(version, LEGACY_SESSION_VERSION | CURRENT_SESSION_VERSION)
}

#[cfg(feature = "native")]
#[must_use]
pub const fn serialized_keypair_size(version: u32) -> Option<usize> {
    match version {
        LEGACY_SESSION_VERSION => Some(LEGACY_VALUE_SIZE),
        CURRENT_SESSION_VERSION => Some(CURRENT_VALUE_SIZE),
        _ => None,
    }
}

/// Serialized keypair file for a session.
pub struct KeypairFile {
    pub version: u32,
    pub pq_pk: Vec<u8>,
    pub sk_nonce: [u8; crypto_aead::NONCE_SIZE],
    pub sk_ct: Vec<u8>,
}

impl KeypairFile {
    /// Build a keypair file by AEAD-wrapping a secret key.
    pub fn build_wrapped(
        version: u32,
        pq_pk_bytes: Vec<u8>,
        wrap_key: &crypto_aead::Key,
        sk_plaintext: &[u8],
        aad: &[u8],
    ) -> Self {
        let mut sk_nonce = [0u8; crypto_aead::NONCE_SIZE];
        rand::RngCore::fill_bytes(&mut rand::rngs::OsRng, &mut sk_nonce);
        let nonce = crypto_aead::Nonce::from(sk_nonce);
        let sk_ct = crypto_aead::encrypt(wrap_key, &nonce, sk_plaintext, aad);
        Self {
            version,
            pq_pk: pq_pk_bytes,
            sk_nonce,
            sk_ct,
        }
    }

    /// Build the current envelope and bind its suite header, domain, slot,
    /// lengths, and complete public key into the wrapping AEAD.
    pub fn build_current_wrapped(
        domain: &str,
        slot: SessionIndex,
        pq_pk_bytes: Vec<u8>,
        wrap_key: &crypto_aead::Key,
        sk_plaintext: &[u8],
    ) -> Result<Self> {
        if pq_pk_bytes.len() != PqPublicKey::byte_size()
            || sk_plaintext.len() != PqSecretKey::byte_size()
        {
            return Err(SecureStorageError::CorruptedBlock);
        }
        let aad = current_wrap_aad(domain, slot, &pq_pk_bytes)?;
        Ok(Self::build_wrapped(
            CURRENT_SESSION_VERSION,
            pq_pk_bytes,
            wrap_key,
            sk_plaintext,
            &aad,
        ))
    }

    /// Reconstruct the exact wrapping AAD selected by the envelope version.
    pub fn wrap_aad(&self, domain: &str, slot: SessionIndex) -> Result<Vec<u8>> {
        match self.version {
            LEGACY_SESSION_VERSION => {
                Ok(crate::domain::sk_wrap_aad(domain, LEGACY_SESSION_VERSION, slot).into_bytes())
            }
            CURRENT_SESSION_VERSION => current_wrap_aad(domain, slot, &self.pq_pk),
            version => Err(SecureStorageError::UnsupportedVersion(version)),
        }
    }

    /// Serialize using the version-selected frozen layout.
    #[must_use]
    pub fn serialize(&self) -> Vec<u8> {
        if self.version == CURRENT_SESSION_VERSION {
            let mut buf = Vec::with_capacity(CURRENT_VALUE_SIZE);
            buf.extend_from_slice(&self.version.to_be_bytes());
            buf.extend_from_slice(&(self.pq_pk.len() as u32).to_be_bytes());
            buf.extend_from_slice(&(self.sk_nonce.len() as u32).to_be_bytes());
            buf.extend_from_slice(&(self.sk_ct.len() as u32).to_be_bytes());
            buf.extend_from_slice(&self.pq_pk);
            buf.extend_from_slice(&self.sk_nonce);
            buf.extend_from_slice(&self.sk_ct);
            return buf;
        }

        let mut buf = Vec::with_capacity(LEGACY_VALUE_SIZE);
        buf.extend_from_slice(&self.version.to_be_bytes());
        buf.extend_from_slice(&self.pq_pk);
        buf.extend_from_slice(&self.sk_nonce);
        buf.extend_from_slice(&self.sk_ct);
        buf
    }

    /// Deserialize only after dispatching on the leading version.
    pub fn deserialize(data: &[u8]) -> Result<Self> {
        if data.len() < VERSION_SIZE {
            return Err(SecureStorageError::CorruptedBlock);
        }
        let version = u32::from_be_bytes(
            data[..VERSION_SIZE]
                .try_into()
                .map_err(|_| SecureStorageError::CorruptedBlock)?,
        );
        match version {
            LEGACY_SESSION_VERSION => Self::deserialize_legacy(data),
            CURRENT_SESSION_VERSION => Self::deserialize_current(data),
            version => Err(SecureStorageError::UnsupportedVersion(version)),
        }
    }

    fn deserialize_legacy(data: &[u8]) -> Result<Self> {
        if data.len() != LEGACY_VALUE_SIZE {
            return Err(SecureStorageError::CorruptedBlock);
        }
        Self::from_parts(LEGACY_SESSION_VERSION, data, VERSION_SIZE)
    }

    fn deserialize_current(data: &[u8]) -> Result<Self> {
        if data.len() < V1_HEADER_SIZE {
            return Err(SecureStorageError::CorruptedBlock);
        }
        let read_len = |offset: usize| -> Result<usize> {
            Ok(u32::from_be_bytes(
                data[offset..offset + 4]
                    .try_into()
                    .map_err(|_| SecureStorageError::CorruptedBlock)?,
            ) as usize)
        };
        let pk_len = read_len(4)?;
        let nonce_len = read_len(8)?;
        let ciphertext_len = read_len(12)?;
        if pk_len != PqPublicKey::byte_size()
            || nonce_len != crypto_aead::NONCE_SIZE
            || ciphertext_len != EXPECTED_SECRET_CIPHERTEXT_SIZE
            || V1_HEADER_SIZE
                .checked_add(pk_len)
                .and_then(|value| value.checked_add(nonce_len))
                .and_then(|value| value.checked_add(ciphertext_len))
                != Some(data.len())
        {
            return Err(SecureStorageError::CorruptedBlock);
        }
        Self::from_parts(CURRENT_SESSION_VERSION, data, V1_HEADER_SIZE)
    }

    fn from_parts(version: u32, data: &[u8], mut offset: usize) -> Result<Self> {
        let public_key_end = offset
            .checked_add(PqPublicKey::byte_size())
            .ok_or(SecureStorageError::Overflow)?;
        let pq_pk = data
            .get(offset..public_key_end)
            .ok_or(SecureStorageError::CorruptedBlock)?
            .to_vec();
        PqPublicKey::from_bytes(&pq_pk)?;
        offset = public_key_end;
        let nonce_end = offset
            .checked_add(crypto_aead::NONCE_SIZE)
            .ok_or(SecureStorageError::Overflow)?;
        let sk_nonce = data
            .get(offset..nonce_end)
            .ok_or(SecureStorageError::CorruptedBlock)?
            .try_into()
            .map_err(|_| SecureStorageError::CorruptedBlock)?;
        let sk_ct = data
            .get(nonce_end..)
            .ok_or(SecureStorageError::CorruptedBlock)?
            .to_vec();
        if sk_ct.len() != EXPECTED_SECRET_CIPHERTEXT_SIZE {
            return Err(SecureStorageError::CorruptedBlock);
        }
        Ok(Self {
            version,
            pq_pk,
            sk_nonce,
            sk_ct,
        })
    }
}

fn current_wrap_aad(domain: &str, slot: SessionIndex, public_key: &[u8]) -> Result<Vec<u8>> {
    if public_key.len() != PqPublicKey::byte_size() {
        return Err(SecureStorageError::CorruptedBlock);
    }
    let domain_len = u64::try_from(domain.len()).map_err(|_| SecureStorageError::Overflow)?;
    let mut aad = Vec::with_capacity(
        V1_AAD_MAGIC.len() + 8 + domain.len() + 1 + V1_HEADER_SIZE + public_key.len(),
    );
    aad.extend_from_slice(V1_AAD_MAGIC);
    aad.extend_from_slice(&domain_len.to_be_bytes());
    aad.extend_from_slice(domain.as_bytes());
    aad.push(slot.as_u8());
    aad.extend_from_slice(&CURRENT_SESSION_VERSION.to_be_bytes());
    aad.extend_from_slice(&(PqPublicKey::byte_size() as u32).to_be_bytes());
    aad.extend_from_slice(&(crypto_aead::NONCE_SIZE as u32).to_be_bytes());
    aad.extend_from_slice(&(EXPECTED_SECRET_CIPHERTEXT_SIZE as u32).to_be_bytes());
    aad.extend_from_slice(public_key);
    Ok(aad)
}

pub fn read_session_keypair<S: KeypairStorage>(
    storage: &S,
    session: SessionIndex,
) -> Result<KeypairFile> {
    let data = storage.read_keypair(session)?;
    KeypairFile::deserialize(&data)
}

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
    use crate::pq::pq_keygen;
    use zeroize::Zeroizing;

    fn current_file() -> KeypairFile {
        let (pk, sk) = pq_keygen();
        let wrap = crypto_aead::Key::from([7; crypto_aead::KEY_SIZE]);
        KeypairFile::build_current_wrapped(
            "test",
            SessionIndex::new(1).unwrap(),
            pk.to_bytes(),
            &wrap,
            &sk.to_bytes(),
        )
        .unwrap()
    }

    #[test]
    fn frozen_current_fixture_opens_and_binds_its_keypair() {
        let bytes = include_bytes!("../tests/fixtures/keypair-v1.bin");
        let parsed = KeypairFile::deserialize(bytes).unwrap();
        assert_eq!(parsed.version, CURRENT_SESSION_VERSION);
        assert_eq!(parsed.serialize(), bytes);
        let slot = SessionIndex::new(1).unwrap();
        let keys = crate::kdf::derive_session_keys("keypair-v1-fixture", b"keypair-v1-password");
        let aad = parsed.wrap_aad("keypair-v1-fixture", slot).unwrap();
        let plaintext = Zeroizing::new(
            crypto_aead::decrypt(
                &crypto_aead::Key::from_ref(&keys.sk_wrap_key),
                &crypto_aead::Nonce::from(parsed.sk_nonce),
                &parsed.sk_ct,
                &aad,
            )
            .unwrap(),
        );
        let public = PqPublicKey::from_bytes(&parsed.pq_pk).unwrap();
        let secret = PqSecretKey::from_bytes(&plaintext).unwrap();
        assert!(crate::pq::keypair_matches(&public, &secret));
    }

    #[test]
    #[ignore = "fixture generation is an explicit compatibility-baseline operation"]
    fn generate_current_fixture() {
        let (public, secret) = pq_keygen();
        let slot = SessionIndex::new(1).unwrap();
        let keys = crate::kdf::derive_session_keys("keypair-v1-fixture", b"keypair-v1-password");
        let keypair = KeypairFile::build_current_wrapped(
            "keypair-v1-fixture",
            slot,
            public.to_bytes(),
            &crypto_aead::Key::from_ref(&keys.sk_wrap_key),
            &secret.to_bytes(),
        )
        .unwrap();
        let path =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/keypair-v1.bin");
        std::fs::write(path, keypair.serialize()).unwrap();
    }

    #[test]
    fn current_roundtrip_and_aad_open() {
        let file = current_file();
        let bytes = file.serialize();
        assert_eq!(bytes.len(), CURRENT_VALUE_SIZE);
        let parsed = KeypairFile::deserialize(&bytes).unwrap();
        let aad = parsed
            .wrap_aad("test", SessionIndex::new(1).unwrap())
            .unwrap();
        let wrap = crypto_aead::Key::from([7; crypto_aead::KEY_SIZE]);
        let plaintext = Zeroizing::new(
            crypto_aead::decrypt(
                &wrap,
                &crypto_aead::Nonce::from(parsed.sk_nonce),
                &parsed.sk_ct,
                &aad,
            )
            .unwrap(),
        );
        assert_eq!(plaintext.len(), PqSecretKey::byte_size());
    }

    #[test]
    fn current_aad_rejects_public_key_substitution() {
        let file = current_file();
        let mut bytes = file.serialize();
        let (other_pk, _other_sk) = pq_keygen();
        bytes[V1_HEADER_SIZE..V1_HEADER_SIZE + PqPublicKey::byte_size()]
            .copy_from_slice(&other_pk.to_bytes());
        let parsed = KeypairFile::deserialize(&bytes).unwrap();
        let aad = parsed
            .wrap_aad("test", SessionIndex::new(1).unwrap())
            .unwrap();
        let wrap = crypto_aead::Key::from([7; crypto_aead::KEY_SIZE]);
        assert!(
            crypto_aead::decrypt(
                &wrap,
                &crypto_aead::Nonce::from(parsed.sk_nonce),
                &parsed.sk_ct,
                &aad,
            )
            .is_none()
        );
    }

    #[test]
    fn legacy_decoder_roundtrip() {
        let (pk, sk) = pq_keygen();
        let wrap = crypto_aead::Key::from([3; crypto_aead::KEY_SIZE]);
        let aad = crate::domain::sk_wrap_aad(
            "test",
            LEGACY_SESSION_VERSION,
            SessionIndex::new(0).unwrap(),
        );
        let file = KeypairFile::build_wrapped(
            LEGACY_SESSION_VERSION,
            pk.to_bytes(),
            &wrap,
            &sk.to_bytes(),
            aad.as_bytes(),
        );
        let parsed = KeypairFile::deserialize(&file.serialize()).unwrap();
        assert_eq!(parsed.version, LEGACY_SESSION_VERSION);
        assert_eq!(parsed.serialize().len(), LEGACY_VALUE_SIZE);
    }

    #[test]
    fn rejects_unknown_version_before_layout() {
        assert!(matches!(
            KeypairFile::deserialize(&2_u32.to_be_bytes()),
            Err(SecureStorageError::UnsupportedVersion(2))
        ));
    }

    #[test]
    fn rejects_current_length_mismatch() {
        let mut bytes = current_file().serialize();
        bytes[4..8].copy_from_slice(&1_u32.to_be_bytes());
        assert!(KeypairFile::deserialize(&bytes).is_err());
    }

    #[test]
    fn deserialize_truncated() {
        assert!(KeypairFile::deserialize(&[0, 0, 0]).is_err());
    }
}
