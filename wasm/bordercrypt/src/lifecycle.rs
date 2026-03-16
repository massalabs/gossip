//! Session lifecycle: provisioning, allocation, and cover traffic.

use rand::RngCore;
use rand::seq::SliceRandom;
use zeroize::Zeroizing;

use crate::BLOCK_SIZE;
use crate::block::{create_cover_block, rerandomize_block};
use crate::constants::{LENGTH_HDR_SIZE, PLAINTEXT_SIZE, SESSION_COUNT};
use crate::domain;
use crate::error::{BordercryptError, Result};
use crate::keypair::{KeypairFile, read_session_version_and_pk};
use crate::pq::{PqPublicKey, PqSecretKey, pq_keygen};
use crate::storage::{BlockStorage, KeypairStorage};
use crate::types::SessionIndex;
use crate::unlock::UnlockedSession;
use crate::write::{encrypt_session_data_block, ensure_block_count, repair_blockstream_lengths};

/// Initialize all session slots with valid but non-unlockable keypairs.
///
/// Each slot gets a real public key (needed for rerand/cover), but the
/// secret key is discarded and `sk_ct` is a valid AEAD ciphertext under
/// a random throwaway key, making the slot impossible to unlock with
/// any password while remaining structurally indistinguishable from
/// an allocated slot's `sk_ct`. Empty blockstreams (length 0) are
/// created for each slot.
pub fn provision_storage<S: BlockStorage + KeypairStorage>(storage: &mut S) -> Result<()> {
    for i in 0..SESSION_COUNT as u8 {
        let slot = SessionIndex::new(i).unwrap();
        let (pk, _sk) = pq_keygen();
        // _sk is dropped at end of loop iteration; its Drop impl zeroizes

        let mut sk_nonce = [0u8; crypto_aead::NONCE_SIZE];
        rand::rngs::OsRng.fill_bytes(&mut sk_nonce);

        // Encrypt random plaintext under a random throwaway key so sk_ct
        // is a structurally valid AEAD ciphertext, indistinguishable from
        // an allocated slot's sk_ct.
        let dummy_wrap_key = crypto_aead::Key::from({
            let mut k = Zeroizing::new([0u8; crypto_aead::KEY_SIZE]);
            rand::rngs::OsRng.fill_bytes(k.as_mut());
            *k
        });
        let mut dummy_sk = Zeroizing::new(vec![0u8; PqSecretKey::byte_size()]);
        rand::rngs::OsRng.fill_bytes(dummy_sk.as_mut());
        let nonce = crypto_aead::Nonce::from(sk_nonce);
        let sk_ct = crypto_aead::encrypt(&dummy_wrap_key, &nonce, &dummy_sk, b"");

        let kf = KeypairFile {
            version: 0,
            pq_pk: pk.to_bytes(),
            sk_nonce,
            sk_ct,
        };
        storage.write_keypair(slot, &kf.serialize())?;
        storage.init_blockstream(slot)?;
    }

    Ok(())
}

/// Allocate a session in a specific slot with the given password.
///
/// **Not plausibly deniable**: the public key changes in the keypair file,
/// visible when comparing two snapshots.
pub fn allocate_session<S: BlockStorage + KeypairStorage>(
    storage: &mut S,
    domain: &str,
    slot: SessionIndex,
    password: &[u8],
) -> Result<UnlockedSession> {
    let (pq_rerand_pk, pq_rerand_sk) = pq_keygen();

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

    let root_aead_label = domain::root_aead_key_label(domain);
    let mut root_aead_key = Zeroizing::new([0u8; crypto_aead::KEY_SIZE]);
    expander.expand(root_aead_label.as_bytes(), root_aead_key.as_mut());

    // AEAD-wrap the secret key
    let version: u32 = 0;
    let sk_wrap_aad = domain::sk_wrap_aad(domain, version, slot);

    let mut nonce_bytes = [0u8; crypto_aead::NONCE_SIZE];
    rand::rngs::OsRng.fill_bytes(&mut nonce_bytes);
    let nonce = crypto_aead::Nonce::from(nonce_bytes);
    let sk_wrap_aead_key = crypto_aead::Key::from(*sk_wrap_key);
    let sk_bytes = Zeroizing::new(pq_rerand_sk.to_bytes());
    let sk_ct = crypto_aead::encrypt(&sk_wrap_aead_key, &nonce, &sk_bytes, sk_wrap_aad.as_bytes());

    // Write keypair file
    let kf = KeypairFile {
        version,
        pq_pk: pq_rerand_pk.to_bytes(),
        sk_nonce: nonce_bytes,
        sk_ct,
    };
    storage.write_keypair(slot, &kf.serialize())?;

    let session = UnlockedSession {
        session_index: slot,
        session_version: version,
        pq_rerand_pk,
        pq_rerand_sk,
        root_aead_key,
        total_data_length: 0,
    };

    // Write a genuine block 0 with zero-length header.
    // ensure_block_count alone is insufficient: if another session already
    // has blocks, repair_blockstream_lengths pads this slot with cover
    // blocks and global_count >= 1 skips extend_blockstream_with_session_block.
    // Block 0 would stay a cover block, corrupting unlock_session.
    ensure_block_count(storage, domain, &session, 1)?;
    let mut pt = Zeroizing::new(vec![0u8; PLAINTEXT_SIZE]);
    rand::rngs::OsRng.fill_bytes(&mut pt[..]);
    pt[..LENGTH_HDR_SIZE].copy_from_slice(&0u64.to_be_bytes());
    let pt_arr: &[u8; PLAINTEXT_SIZE] = pt.as_slice().try_into().unwrap();
    encrypt_session_data_block(storage, domain, &session, 0, pt_arr)?;

    Ok(session)
}

/// Rerandomize a random block across all sessions.
///
/// Called periodically to mask activity patterns. Does not require
/// an unlocked session — only public keys are needed.
pub fn cover_traffic_tick<S: BlockStorage + KeypairStorage>(
    storage: &mut S,
    domain: &str,
) -> Result<()> {
    repair_blockstream_lengths(storage, domain)?;
    let global_count = crate::write::get_global_block_count(storage)?;
    if global_count == 0 {
        return Ok(());
    }

    let block_index = rand::Rng::gen_range(&mut rand::rngs::OsRng, 0..global_count);

    let mut indices: Vec<u8> = (0..SESSION_COUNT as u8).collect();
    indices.shuffle(&mut rand::rngs::OsRng);

    let mut cur_aad_root = String::new();
    for i in indices {
        let cur_session = SessionIndex::new(i).unwrap();
        let (cur_version, cur_pk_bytes) = read_session_version_and_pk(storage, cur_session)?;
        let cur_pk = PqPublicKey::from_bytes(&cur_pk_bytes)?;

        // Computed unconditionally for timing uniformity (spec §15).
        domain::block_scope(
            &mut cur_aad_root,
            domain,
            cur_version,
            cur_session,
            block_index,
        );

        let new_ct = match storage.read_block(cur_session, block_index) {
            Ok(cur_ct) => rerandomize_block(&cur_pk, &cur_ct),
            Err(_) => create_cover_block(&cur_pk, &cur_aad_root),
        };
        let ct_arr: &[u8; BLOCK_SIZE] = new_ct
            .as_slice()
            .try_into()
            .map_err(|_| BordercryptError::CorruptedBlock)?;
        storage.write_block(cur_session, block_index, ct_arr)?;
        storage.fsync(cur_session)?;
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::read::read_session_data;
    use crate::storage::MemoryStorage;
    use crate::unlock::unlock_session;
    use crate::write::write_session_data;

    const DOMAIN: &str = "test";

    // --- commit 15: provisioning and allocation ---

    #[test]
    fn provision_creates_all_slots() {
        let mut storage = MemoryStorage::new();
        provision_storage(&mut storage).unwrap();

        for i in 0..SESSION_COUNT as u8 {
            let s = SessionIndex::new(i).unwrap();
            // Each slot should have a readable keypair file
            let data = storage.read_keypair(s).unwrap();
            let kf = KeypairFile::deserialize(&data).unwrap();
            assert_eq!(kf.version, 0);
            assert_eq!(kf.pq_pk.len(), PqPublicKey::byte_size());
        }
    }

    #[test]
    fn provision_pk_valid() {
        let mut storage = MemoryStorage::new();
        provision_storage(&mut storage).unwrap();

        for i in 0..SESSION_COUNT as u8 {
            let s = SessionIndex::new(i).unwrap();
            let (_, pk_bytes) = read_session_version_and_pk(&storage, s).unwrap();
            // Should be parseable as a valid public key
            let pk = PqPublicKey::from_bytes(&pk_bytes).unwrap();
            // Should work for cover block creation
            let cover = create_cover_block(&pk, "test_aad");
            assert_eq!(cover.len(), BLOCK_SIZE);
        }
    }

    #[test]
    fn provision_not_unlockable() {
        let mut storage = MemoryStorage::new();
        provision_storage(&mut storage).unwrap();

        // No password should unlock any slot
        let result = unlock_session(&storage, DOMAIN, b"any-password");
        assert!(result.is_err());
    }

    #[test]
    fn allocate_then_unlock() {
        let mut storage = MemoryStorage::new();
        provision_storage(&mut storage).unwrap();

        let slot = SessionIndex::new(2).unwrap();
        let password = b"test-password";
        let session = allocate_session(&mut storage, DOMAIN, slot, password).unwrap();
        assert_eq!(session.session_index, slot);

        let unlocked = unlock_session(&storage, DOMAIN, password).unwrap();
        assert_eq!(unlocked.session_index, slot);
    }

    #[test]
    fn allocate_wrong_password_fails() {
        let mut storage = MemoryStorage::new();
        provision_storage(&mut storage).unwrap();

        let slot = SessionIndex::new(0).unwrap();
        allocate_session(&mut storage, DOMAIN, slot, b"correct").unwrap();

        let result = unlock_session(&storage, DOMAIN, b"wrong");
        assert!(result.is_err());
    }

    #[test]
    fn allocate_changes_pk() {
        let mut storage = MemoryStorage::new();
        provision_storage(&mut storage).unwrap();

        let slot = SessionIndex::new(0).unwrap();
        let (_, old_pk) = read_session_version_and_pk(&storage, slot).unwrap();

        allocate_session(&mut storage, DOMAIN, slot, b"password").unwrap();

        let (_, new_pk) = read_session_version_and_pk(&storage, slot).unwrap();
        assert_ne!(old_pk, new_pk);
    }

    #[test]
    fn two_sessions_different_passwords() {
        std::thread::Builder::new()
            .stack_size(4 * 1024 * 1024)
            .spawn(|| {
                let mut storage = MemoryStorage::new();
                provision_storage(&mut storage).unwrap();

                let s0 = SessionIndex::new(0).unwrap();
                let s3 = SessionIndex::new(3).unwrap();
                allocate_session(&mut storage, DOMAIN, s0, b"password-one").unwrap();
                allocate_session(&mut storage, DOMAIN, s3, b"password-two").unwrap();

                let u1 = unlock_session(&storage, DOMAIN, b"password-one").unwrap();
                assert_eq!(u1.session_index, s0);

                let u2 = unlock_session(&storage, DOMAIN, b"password-two").unwrap();
                assert_eq!(u2.session_index, s3);
            })
            .unwrap()
            .join()
            .unwrap();
    }

    #[test]
    fn allocate_writes_genuine_block_0() {
        let mut storage = MemoryStorage::new();
        provision_storage(&mut storage).unwrap();

        let slot = SessionIndex::new(0).unwrap();
        allocate_session(&mut storage, DOMAIN, slot, b"pw").unwrap();

        // Block 0 should exist and be decryptable
        let unlocked = unlock_session(&storage, DOMAIN, b"pw").unwrap();
        assert_eq!(unlocked.total_data_length, 0);
    }

    #[test]
    fn allocate_after_other_session_has_blocks() {
        std::thread::Builder::new()
            .stack_size(4 * 1024 * 1024)
            .spawn(|| {
                let mut storage = MemoryStorage::new();
                provision_storage(&mut storage).unwrap();

                // Session 0 allocates and writes data (creates blocks for all sessions)
                let s0 = SessionIndex::new(0).unwrap();
                let mut sess0 =
                    allocate_session(&mut storage, DOMAIN, s0, b"password-one").unwrap();
                write_session_data(&mut storage, DOMAIN, &mut sess0, 0, &[0xAB; 100]).unwrap();

                // Session 2 allocates later — blocks already exist from session 0
                let s2 = SessionIndex::new(2).unwrap();
                allocate_session(&mut storage, DOMAIN, s2, b"password-two").unwrap();

                // Session 2 must still be unlockable (block 0 is genuine, not a cover)
                let unlocked = unlock_session(&storage, DOMAIN, b"password-two").unwrap();
                assert_eq!(unlocked.session_index, s2);
                assert_eq!(unlocked.total_data_length, 0);

                // Session 0 is still unlockable too
                let u0 = unlock_session(&storage, DOMAIN, b"password-one").unwrap();
                assert_eq!(u0.session_index, s0);
                assert_eq!(u0.total_data_length, 100);
            })
            .unwrap()
            .join()
            .unwrap();
    }

    #[test]
    fn cover_tick_after_allocate_before_write() {
        let mut storage = MemoryStorage::new();
        provision_storage(&mut storage).unwrap();

        let slot = SessionIndex::new(0).unwrap();
        allocate_session(&mut storage, DOMAIN, slot, b"pw").unwrap();

        // Cover traffic runs before any user write
        for _ in 0..10 {
            cover_traffic_tick(&mut storage, DOMAIN).unwrap();
        }

        // Session must still be unlockable
        let unlocked = unlock_session(&storage, DOMAIN, b"pw").unwrap();
        assert_eq!(unlocked.total_data_length, 0);
    }

    // --- commit 16: cover_traffic_tick ---

    #[test]
    fn cover_tick_empty_storage() {
        let mut storage = MemoryStorage::new();
        provision_storage(&mut storage).unwrap();

        // No blocks -> should be a no-op
        cover_traffic_tick(&mut storage, DOMAIN).unwrap();
    }

    #[test]
    fn cover_tick_changes_blocks() {
        let mut storage = MemoryStorage::new();
        provision_storage(&mut storage).unwrap();

        let slot = SessionIndex::new(0).unwrap();
        let mut session = allocate_session(&mut storage, DOMAIN, slot, b"pw").unwrap();

        let data = vec![0xAB; 100];
        write_session_data(&mut storage, DOMAIN, &mut session, 0, &data).unwrap();

        // Record ciphertexts before cover tick
        let mut before = Vec::new();
        for i in 0..SESSION_COUNT as u8 {
            let s = SessionIndex::new(i).unwrap();
            before.push(storage.read_block(s, 0).unwrap());
        }

        // Run enough ticks to likely hit block 0 (there's only 1 block)
        for _ in 0..5 {
            cover_traffic_tick(&mut storage, DOMAIN).unwrap();
        }

        // At least some blocks should have changed
        let mut changed = false;
        for i in 0..SESSION_COUNT as u8 {
            let s = SessionIndex::new(i).unwrap();
            let after = storage.read_block(s, 0).unwrap();
            if *after != *before[i as usize] {
                changed = true;
            }
        }
        assert!(changed, "cover tick should change at least some blocks");
    }

    #[test]
    fn cover_tick_preserves_genuine() {
        let mut storage = MemoryStorage::new();
        provision_storage(&mut storage).unwrap();

        let slot = SessionIndex::new(0).unwrap();
        let mut session = allocate_session(&mut storage, DOMAIN, slot, b"pw").unwrap();

        let data = vec![0xCD; 100];
        write_session_data(&mut storage, DOMAIN, &mut session, 0, &data).unwrap();

        // Run many cover ticks
        for _ in 0..10 {
            cover_traffic_tick(&mut storage, DOMAIN).unwrap();
        }

        // Data should still be readable
        let result = read_session_data(&storage, DOMAIN, &session, 0, 100).unwrap();
        assert_eq!(&*result, &data);
    }
}
