//! Session unlock: password → keys → try decrypt each session slot.

use rand::seq::SliceRandom;
use zeroize::{Zeroize, ZeroizeOnDrop, Zeroizing};

use crate::domain;
use crate::error::{Result, SecureStorageError};
use crate::kdf::derive_session_keys;
use crate::keypair::read_session_keypair;
use crate::pq::{PqPublicKey, PqSecretKey};
use crate::read::read_total_length;
use crate::storage::{BlockStorage, KeypairStorage};
use crate::types::SessionIndex;

/// A successfully unlocked session with cached keys.
///
/// **Namespace independence**: an unlocked session shares its root keys
/// (`root_aead_key`, `pq_rerand_pk`, `pq_rerand_sk`) across every namespace.
/// Per-namespace metadata such as `total_data_length` lives in
/// [`NamespaceState`], not on the session.
#[derive(Zeroize, ZeroizeOnDrop)]
pub struct UnlockedSession {
    pub session_index: SessionIndex,
    pub session_version: u32,
    pub pq_rerand_pk: PqPublicKey,
    pub pq_rerand_sk: PqSecretKey,
    pub root_aead_key: Zeroizing<[u8; crate::ROOT_BLOCK_KEY_SIZE]>,
}

/// Per-namespace mutable metadata for an unlocked session.
///
/// Each `(session, namespace)` pair owns one `NamespaceState`. The SDK is
/// responsible for keeping it in sync with the underlying blockstream and
/// passing it through every read/write call. The state can be loaded from
/// storage with [`load_namespace_state`] (decrypts block 0 to recover the
/// length header) or constructed empty for a freshly initialized namespace.
#[derive(Debug, Clone, Copy, Default)]
pub struct NamespaceState {
    /// Total bytes of user-visible data stored in this namespace.
    pub total_data_length: u64,
}

impl NamespaceState {
    #[must_use]
    pub fn empty() -> Self {
        Self {
            total_data_length: 0,
        }
    }
}

/// Load a [`NamespaceState`] from storage by decrypting the namespace's
/// length header (block 0). Returns an empty state if the namespace has no
/// blocks yet.
pub fn load_namespace_state<S: BlockStorage>(
    storage: &S,
    domain: &str,
    session: &UnlockedSession,
    namespace: u8,
) -> Result<NamespaceState> {
    let total_data_length = read_total_length(
        storage,
        domain,
        session.session_version,
        session.session_index,
        namespace,
        &session.pq_rerand_sk,
        session.root_aead_key.as_ref(),
    )?;
    Ok(NamespaceState { total_data_length })
}

/// Unlock a session by trying each slot with the given password.
///
/// All slots are tried regardless of whether a match is found,
/// to prevent timing side-channels from revealing which slot is active.
///
/// Per-namespace state (e.g. `total_data_length`) is **not** loaded by this
/// function — call [`load_namespace_state`] for each namespace the caller
/// intends to use.
pub fn unlock_session<S: BlockStorage + KeypairStorage>(
    storage: &S,
    domain: &str,
    password: &[u8],
) -> Result<UnlockedSession> {
    let keys = derive_session_keys(domain, password);

    let mut indices: Vec<u8> = (0..crate::SESSION_COUNT as u8).collect();
    indices.shuffle(&mut rand::rngs::OsRng);

    let sk_wrap_aead_key = crypto_aead::Key::from_ref(&keys.sk_wrap_key);

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

        let decrypt_result = crypto_aead::decrypt(
            &sk_wrap_aead_key,
            &nonce,
            &kf.sk_ct,
            sk_wrap_aad.as_bytes(),
        )
        .map(Zeroizing::new);

        // Always parse pk/sk regardless of AEAD result to equalize timing.
        let sk_parse = decrypt_result
            .as_ref()
            .and_then(|bytes| PqSecretKey::from_bytes(bytes).ok());
        let pk_parse = PqPublicKey::from_bytes(&kf.pq_pk).ok();

        if result.is_none() {
            if let (Some(pq_rerand_sk), Some(pq_rerand_pk)) = (sk_parse, pk_parse) {
                result = Some(UnlockedSession {
                    session_index: session,
                    session_version: kf.version,
                    pq_rerand_pk,
                    pq_rerand_sk,
                    root_aead_key: keys.root_aead_key.clone(),
                });
            }
        }
    }

    result.ok_or(SecureStorageError::InvalidPassword)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::DEFAULT_NAMESPACE;
    use crate::block::encrypt_block;
    use crate::constants::LENGTH_HDR_SIZE;
    use crate::kdf::{derive_block_aead_key, derive_session_keys};
    use crate::keypair::KeypairFile;
    use crate::pq::pq_keygen;
    use crate::run_with_stack;
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

        let keys = derive_session_keys(domain, password);
        let aad = domain::sk_wrap_aad(domain, version, session);
        let wrap_key = crypto_aead::Key::from_ref(&keys.sk_wrap_key);

        let kf = KeypairFile::build_wrapped(
            version,
            pq_pk.to_bytes(),
            &wrap_key,
            &pq_sk.to_bytes(),
            aad.as_bytes(),
        );
        storage.write_keypair(session, &kf.serialize()).unwrap();

        (pq_pk, pq_sk)
    }

    /// Write a block 0 with the given total_data_length to namespace 0.
    fn write_block_0(
        storage: &mut MemoryStorage,
        domain: &str,
        version: u32,
        session: SessionIndex,
        password: &[u8],
        pq_pk: &PqPublicKey,
        total_data_length: u64,
    ) {
        let keys = derive_session_keys(domain, password);

        let mut plaintext = Box::new([0u8; crate::PLAINTEXT_SIZE]);
        plaintext[..LENGTH_HDR_SIZE].copy_from_slice(&total_data_length.to_be_bytes());

        let (aead_key, aad_root) = derive_block_aead_key(
            domain,
            version,
            session,
            DEFAULT_NAMESPACE,
            &*keys.root_aead_key,
            0,
        );

        let ct = encrypt_block(pq_pk, &aead_key, &aad_root, &plaintext);
        let ct_arr: &[u8; crate::BLOCK_SIZE] = ct.as_slice().try_into().unwrap();
        storage.append_block(session, DEFAULT_NAMESPACE, ct_arr).unwrap();
    }

    #[test]
    fn unlock_success() {
        run_with_stack(|| {
            let mut storage = MemoryStorage::new();
            let session = SessionIndex::new(0).unwrap();
            let (pq_pk, _) = provision_test_session(&mut storage, DOMAIN, PASSWORD, session, 0);
            write_block_0(&mut storage, DOMAIN, 0, session, PASSWORD, &pq_pk, 0);

            let unlocked = unlock_session(&storage, DOMAIN, PASSWORD).unwrap();
            assert_eq!(unlocked.session_index, session);
            assert_eq!(unlocked.session_version, 0);
            let ns_state =
                load_namespace_state(&storage, DOMAIN, &unlocked, DEFAULT_NAMESPACE).unwrap();
            assert_eq!(ns_state.total_data_length, 0);
        });
    }

    #[test]
    fn unlock_wrong_password() {
        run_with_stack(|| {
            let mut storage = MemoryStorage::new();
            let session = SessionIndex::new(0).unwrap();
            let (pq_pk, _) = provision_test_session(&mut storage, DOMAIN, PASSWORD, session, 0);
            write_block_0(&mut storage, DOMAIN, 0, session, PASSWORD, &pq_pk, 0);

            let result = unlock_session(&storage, DOMAIN, b"wrong-password");
            assert!(result.is_err());
        });
    }

    #[test]
    fn unlock_finds_correct_slot() {
        run_with_stack(|| {
            let mut storage = MemoryStorage::new();
            let session = SessionIndex::new(2).unwrap();
            let (pq_pk, _) = provision_test_session(&mut storage, DOMAIN, PASSWORD, session, 0);
            write_block_0(&mut storage, DOMAIN, 0, session, PASSWORD, &pq_pk, 0);

            let unlocked = unlock_session(&storage, DOMAIN, PASSWORD).unwrap();
            assert_eq!(unlocked.session_index.as_u8(), 2);
        });
    }

    #[test]
    fn unlock_multiple_sessions() {
        run_with_stack(|| {
            let mut storage = MemoryStorage::new();
            let s1 = SessionIndex::new(1).unwrap();
            let s2 = SessionIndex::new(2).unwrap();
            let pw1 = b"password-one";
            let pw2 = b"password-two";

            let (pk1, _) = provision_test_session(&mut storage, DOMAIN, pw1, s1, 0);
            write_block_0(&mut storage, DOMAIN, 0, s1, pw1, &pk1, 0);
            let (pk4, _) = provision_test_session(&mut storage, DOMAIN, pw2, s2, 0);
            write_block_0(&mut storage, DOMAIN, 0, s2, pw2, &pk4, 0);

            let u1 = unlock_session(&storage, DOMAIN, pw1).unwrap();
            assert_eq!(u1.session_index.as_u8(), 1);

            let u2 = unlock_session(&storage, DOMAIN, pw2).unwrap();
            assert_eq!(u2.session_index.as_u8(), 2);
        });
    }

    #[test]
    fn unlock_empty_storage() {
        run_with_stack(|| {
            let storage = MemoryStorage::new();
            let result = unlock_session(&storage, DOMAIN, PASSWORD);
            assert!(result.is_err());
        });
    }

    #[test]
    fn unlock_then_load_namespace_state_reads_total_length() {
        run_with_stack(|| {
            let mut storage = MemoryStorage::new();
            let session = SessionIndex::new(0).unwrap();
            let (pq_pk, _) = provision_test_session(&mut storage, DOMAIN, PASSWORD, session, 0);
            write_block_0(&mut storage, DOMAIN, 0, session, PASSWORD, &pq_pk, 42);

            let unlocked = unlock_session(&storage, DOMAIN, PASSWORD).unwrap();
            let ns_state =
                load_namespace_state(&storage, DOMAIN, &unlocked, DEFAULT_NAMESPACE).unwrap();
            assert_eq!(ns_state.total_data_length, 42);
        });
    }
}
