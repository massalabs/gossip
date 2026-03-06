//! Session unlock: password → keys → try decrypt each session slot.

use rand::seq::SliceRandom;
use zeroize::{Zeroize, ZeroizeOnDrop, Zeroizing};

use crate::block::decrypt_block;
use crate::constants::LENGTH_HDR_SIZE;
use crate::domain;
use crate::error::{BordercryptError, Result};
use crate::kdf::derive_block_aead_key;
use crate::keypair::read_session_keypair;
use crate::pq::{PqPublicKey, PqSecretKey};
use crate::storage::{BlockStorage, KeypairStorage};
use crate::types::SessionIndex;

/// A successfully unlocked session with cached keys and metadata.
#[derive(Zeroize, ZeroizeOnDrop)]
pub struct UnlockedSession {
    pub session_index: SessionIndex,
    pub session_version: u32,
    pub pq_rerand_pk: PqPublicKey,
    pub pq_rerand_sk: PqSecretKey,
    pub root_aead_key: Zeroizing<[u8; crate::ROOT_BLOCK_KEY_SIZE]>,
    pub total_data_length: u64,
}

/// Unlock a session by trying each slot with the given password.
///
/// All slots are tried regardless of whether a match is found,
/// to prevent timing side-channels from revealing which slot is active.
pub fn unlock_session<S: BlockStorage + KeypairStorage>(
    storage: &S,
    domain: &str,
    password: &[u8],
) -> Result<UnlockedSession> {
    let salt = domain::password_kdf_salt(domain);
    let mut root_key = Zeroizing::new([0u8; 32]);
    crypto_password_kdf::derive(password, salt.as_bytes(), root_key.as_mut());

    let root_kdf_salt = domain::root_kdf_salt(domain);
    let expander = {
        let mut extract = crypto_kdf::Extract::new(root_kdf_salt.as_bytes());
        extract.input_item(root_key.as_ref());
        extract.finalize()
    };

    let sk_wrap_label = domain::sk_wrap_key_label(domain);
    let mut sk_wrap_key = Zeroizing::new([0u8; crypto_aead::KEY_SIZE]);
    expander.expand(sk_wrap_label.as_bytes(), sk_wrap_key.as_mut());

    let root_aead_label = domain::root_aead_key_label(domain);
    let mut root_aead_key = Zeroizing::new([0u8; crate::ROOT_BLOCK_KEY_SIZE]);
    expander.expand(root_aead_label.as_bytes(), root_aead_key.as_mut());

    let mut indices: Vec<u8> = (0..crate::SESSION_COUNT as u8).collect();
    indices.shuffle(&mut rand::rngs::OsRng);

    let sk_wrap_aead_key = crypto_aead::Key::from(*sk_wrap_key);

    let mut result: Option<UnlockedSession> = None;

    for i in indices {
        let Ok(session) = SessionIndex::new(i) else {
            continue;
        };

        let Ok(kf) = read_session_keypair(storage, session) else {
            continue;
        };

        let sk_wrap_aad = domain::sk_wrap_aad(domain, kf.version, session);
        let nonce = crypto_aead::Nonce::from(kf.sk_nonce);

        let sk_bytes = match crypto_aead::decrypt(
            &sk_wrap_aead_key,
            &nonce,
            &kf.sk_ct,
            sk_wrap_aad.as_bytes(),
        ) {
            Some(bytes) => Zeroizing::new(bytes),
            None => continue,
        };

        let Ok(pq_rerand_sk) = PqSecretKey::from_bytes(&sk_bytes) else {
            continue;
        };

        let Ok(pq_rerand_pk) = PqPublicKey::from_bytes(&kf.pq_pk) else {
            continue;
        };

        if result.is_none() {
            let total_data_length = read_total_length(
                storage,
                domain,
                kf.version,
                session,
                &pq_rerand_sk,
                &root_aead_key,
            )?;

            result = Some(UnlockedSession {
                session_index: session,
                session_version: kf.version,
                pq_rerand_pk,
                pq_rerand_sk,
                root_aead_key: root_aead_key.clone(),
                total_data_length,
            });
        }
    }

    result.ok_or(BordercryptError::InvalidPassword)
}

/// Read total data length from block 0 of a session.
///
/// Returns 0 if no blocks exist yet (freshly allocated session).
pub(crate) fn read_total_length<S: BlockStorage>(
    storage: &S,
    domain: &str,
    version: u32,
    session: SessionIndex,
    pq_rerand_sk: &PqSecretKey,
    root_aead_key: &[u8; crate::ROOT_BLOCK_KEY_SIZE],
) -> Result<u64> {
    if storage.block_count(session)? == 0 {
        return Ok(0);
    }
    if version != 0 {
        return Err(BordercryptError::UnsupportedVersion(version));
    }

    let block_ct = storage.read_block(session, 0)?;
    let (aead_sk, aad_root) =
        derive_block_aead_key(domain, version, session, root_aead_key, 0);
    let plaintext = decrypt_block(pq_rerand_sk, &aead_sk, &aad_root, &block_ct)?;

    let length_bytes: [u8; 8] = plaintext[..LENGTH_HDR_SIZE]
        .try_into()
        .map_err(|_| BordercryptError::CorruptedBlock)?;
    Ok(u64::from_be_bytes(length_bytes))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::block::encrypt_block;
    use crate::keypair::KeypairFile;
    use crate::pq::pq_keygen;
    use crate::storage::MemoryStorage;

    const DOMAIN: &str = "test";
    const PASSWORD: &[u8] = b"correct-horse-battery-staple";

    /// Provision a session in storage for testing: generate keypair,
    /// encrypt sk with password-derived wrap key, write keypair file.
    fn provision_test_session(
        storage: &mut MemoryStorage,
        domain: &str,
        password: &[u8],
        session: SessionIndex,
        version: u32,
    ) -> (PqPublicKey, PqSecretKey) {
        let (pq_pk, pq_sk) = pq_keygen();

        // Derive keys from password (same flow as unlock)
        let salt = domain::password_kdf_salt(domain);
        let mut root_key = Zeroizing::new([0u8; 32]);
        crypto_password_kdf::derive(password, salt.as_bytes(), root_key.as_mut());

        let root_kdf_salt = domain::root_kdf_salt(domain);
        let expander = {
            let mut extract = crypto_kdf::Extract::new(root_kdf_salt.as_bytes());
            extract.input_item(root_key.as_ref());
            extract.finalize()
        };

        let sk_wrap_label = domain::sk_wrap_key_label(domain);
        let mut sk_wrap_key = Zeroizing::new([0u8; crypto_aead::KEY_SIZE]);
        expander.expand(sk_wrap_label.as_bytes(), sk_wrap_key.as_mut());

        // AEAD-wrap the secret key
        let aad = domain::sk_wrap_aad(domain, version, session);
        let mut nonce_bytes = [0u8; crypto_aead::NONCE_SIZE];
        rand::RngCore::fill_bytes(&mut rand::rngs::OsRng, &mut nonce_bytes);
        let nonce = crypto_aead::Nonce::from(nonce_bytes);
        let wrap_key = crypto_aead::Key::from(*sk_wrap_key);
        let sk_ct = crypto_aead::encrypt(&wrap_key, &nonce, &pq_sk.to_bytes(), aad.as_bytes());

        // Write keypair file
        let kf = KeypairFile {
            version,
            pq_pk: pq_pk.to_bytes(),
            sk_nonce: nonce_bytes,
            sk_ct,
        };
        storage.write_keypair(session, &kf.serialize()).unwrap();

        (pq_pk, pq_sk)
    }

    /// Write a block 0 with the given total_data_length.
    fn write_block_0(
        storage: &mut MemoryStorage,
        domain: &str,
        version: u32,
        session: SessionIndex,
        password: &[u8],
        pq_pk: &PqPublicKey,
        total_data_length: u64,
    ) {
        let salt = domain::password_kdf_salt(domain);
        let mut root_key = Zeroizing::new([0u8; 32]);
        crypto_password_kdf::derive(password, salt.as_bytes(), root_key.as_mut());

        let root_kdf_salt = domain::root_kdf_salt(domain);
        let expander = {
            let mut extract = crypto_kdf::Extract::new(root_kdf_salt.as_bytes());
            extract.input_item(root_key.as_ref());
            extract.finalize()
        };

        let root_aead_label = domain::root_aead_key_label(domain);
        let mut root_aead_key = Zeroizing::new([0u8; crypto_aead::KEY_SIZE]);
        expander.expand(root_aead_label.as_bytes(), root_aead_key.as_mut());

        let mut plaintext = Box::new([0u8; crate::PLAINTEXT_SIZE]);
        plaintext[..LENGTH_HDR_SIZE].copy_from_slice(&total_data_length.to_be_bytes());

        let (aead_key, aad_root) =
            derive_block_aead_key(domain, version, session, &*root_aead_key, 0);

        let ct = encrypt_block(pq_pk, &aead_key, &aad_root, &plaintext);
        let ct_arr: &[u8; crate::BLOCK_SIZE] = ct.as_slice().try_into().unwrap();
        storage.append_block(session, ct_arr).unwrap();
    }

    #[test]
    fn unlock_success() {
        let mut storage = MemoryStorage::new();
        let session = SessionIndex::new(0).unwrap();
        let (pq_pk, _) = provision_test_session(&mut storage, DOMAIN, PASSWORD, session, 0);
        write_block_0(&mut storage, DOMAIN, 0, session, PASSWORD, &pq_pk, 0);

        let unlocked = unlock_session(&storage, DOMAIN, PASSWORD).unwrap();
        assert_eq!(unlocked.session_index, session);
        assert_eq!(unlocked.session_version, 0);
        assert_eq!(unlocked.total_data_length, 0);
    }

    #[test]
    fn unlock_wrong_password() {
        let mut storage = MemoryStorage::new();
        let session = SessionIndex::new(0).unwrap();
        let (pq_pk, _) = provision_test_session(&mut storage, DOMAIN, PASSWORD, session, 0);
        write_block_0(&mut storage, DOMAIN, 0, session, PASSWORD, &pq_pk, 0);

        let result = unlock_session(&storage, DOMAIN, b"wrong-password");
        assert!(result.is_err());
    }

    #[test]
    fn unlock_finds_correct_slot() {
        let mut storage = MemoryStorage::new();
        let session = SessionIndex::new(3).unwrap();
        let (pq_pk, _) = provision_test_session(&mut storage, DOMAIN, PASSWORD, session, 0);
        write_block_0(&mut storage, DOMAIN, 0, session, PASSWORD, &pq_pk, 0);

        let unlocked = unlock_session(&storage, DOMAIN, PASSWORD).unwrap();
        assert_eq!(unlocked.session_index.as_u8(), 3);
    }

    #[test]
    fn unlock_multiple_sessions() {
        std::thread::Builder::new()
            .stack_size(4 * 1024 * 1024)
            .spawn(|| {
                let mut storage = MemoryStorage::new();
                let s1 = SessionIndex::new(1).unwrap();
                let s4 = SessionIndex::new(4).unwrap();
                let pw1 = b"password-one";
                let pw2 = b"password-two";

                let (pk1, _) = provision_test_session(&mut storage, DOMAIN, pw1, s1, 0);
                write_block_0(&mut storage, DOMAIN, 0, s1, pw1, &pk1, 0);
                let (pk4, _) = provision_test_session(&mut storage, DOMAIN, pw2, s4, 0);
                write_block_0(&mut storage, DOMAIN, 0, s4, pw2, &pk4, 0);

                let u1 = unlock_session(&storage, DOMAIN, pw1).unwrap();
                assert_eq!(u1.session_index.as_u8(), 1);

                let u2 = unlock_session(&storage, DOMAIN, pw2).unwrap();
                assert_eq!(u2.session_index.as_u8(), 4);
            })
            .unwrap()
            .join()
            .unwrap();
    }

    #[test]
    fn unlock_empty_storage() {
        let storage = MemoryStorage::new();
        let result = unlock_session(&storage, DOMAIN, PASSWORD);
        assert!(result.is_err());
    }

    #[test]
    fn unlock_reads_total_length() {
        let mut storage = MemoryStorage::new();
        let session = SessionIndex::new(0).unwrap();
        let (pq_pk, _) = provision_test_session(&mut storage, DOMAIN, PASSWORD, session, 0);
        write_block_0(&mut storage, DOMAIN, 0, session, PASSWORD, &pq_pk, 42);

        let unlocked = unlock_session(&storage, DOMAIN, PASSWORD).unwrap();
        assert_eq!(unlocked.total_data_length, 42);
    }
}
