//! Session lifecycle: provisioning, allocation, and cover traffic.

use rand::RngCore;
use rand::seq::SliceRandom;
use zeroize::Zeroizing;

use crate::BLOCK_SIZE;
use crate::block::{create_cover_block, rerandomize_block};
use crate::constants::{DEFAULT_NAMESPACE, LENGTH_HDR_SIZE, PLAINTEXT_SIZE, SESSION_COUNT};
use crate::domain;
use crate::error::{Result, SecureStorageError};
use crate::kdf::derive_session_keys;
use crate::keypair::{KeypairFile, read_session_version_and_pk};
use crate::pq::{PqPublicKey, PqSecretKey, pq_keygen};
use crate::storage::{BlockStorage, KeypairStorage};
use crate::types::SessionIndex;
use crate::unlock::{NamespaceState, UnlockedSession};
use crate::write::{encrypt_session_data_block, ensure_block_count, repair_blockstream_lengths};

/// Initialize all session slots with valid but non-unlockable keypairs.
///
/// Each slot gets a real public key (needed for rerand/cover), but the
/// secret key is discarded and `sk_ct` is a valid AEAD ciphertext under
/// a random throwaway key, making the slot impossible to unlock with
/// any password while remaining structurally indistinguishable from
/// an allocated slot's `sk_ct`. Empty default-namespace blockstreams (length 0)
/// are created for each slot; other namespaces are created lazily on
/// first write.
pub fn provision_storage<S: BlockStorage + KeypairStorage>(storage: &mut S) -> Result<()> {
    for i in 0..SESSION_COUNT as u8 {
        let slot = SessionIndex::new(i).unwrap();
        let (pk, _sk) = pq_keygen();
        // _sk is dropped at end of loop iteration; its Drop impl zeroizes

        // Random throwaway key — slot is structurally valid AEAD ciphertext
        // but impossible to unlock with any password.
        let dummy_wrap_key = crypto_aead::Key::from({
            let mut k = Zeroizing::new([0u8; crypto_aead::KEY_SIZE]);
            rand::rngs::OsRng.fill_bytes(k.as_mut());
            *k
        });
        let mut dummy_sk = Zeroizing::new(vec![0u8; PqSecretKey::byte_size()]);
        rand::rngs::OsRng.fill_bytes(dummy_sk.as_mut());

        let kf = KeypairFile::build_wrapped(0, pk.to_bytes(), &dummy_wrap_key, &dummy_sk, b"");
        storage.write_keypair(slot, &kf.serialize())?;
        storage.reset_blockstream(slot, DEFAULT_NAMESPACE)?;
    }

    Ok(())
}

/// Allocate a session in a specific slot with the given password.
///
/// **Not plausibly deniable**: the public key changes in the keypair file,
/// visible when comparing two snapshots.
///
/// The freshly allocated session has its default-namespace block 0 written
/// with a zero-length header so [`crate::unlock::unlock_session`] +
/// [`crate::unlock::load_namespace_state`] can subsequently recover the
/// `total_data_length = 0` for namespace 0.
pub fn allocate_session<S: BlockStorage + KeypairStorage>(
    storage: &mut S,
    domain: &str,
    slot: SessionIndex,
    password: &[u8],
) -> Result<UnlockedSession> {
    let (pq_rerand_pk, pq_rerand_sk) = pq_keygen();

    let keys = derive_session_keys(domain, password);

    let version: u32 = 0;
    let sk_wrap_aad = domain::sk_wrap_aad(domain, version, slot);
    let sk_wrap_aead_key = crypto_aead::Key::from_ref(&keys.sk_wrap_key);
    let sk_bytes = Zeroizing::new(pq_rerand_sk.to_bytes());

    let kf = KeypairFile::build_wrapped(
        version,
        pq_rerand_pk.to_bytes(),
        &sk_wrap_aead_key,
        &sk_bytes,
        sk_wrap_aad.as_bytes(),
    );
    storage.write_keypair(slot, &kf.serialize())?;

    let session = UnlockedSession {
        session_index: slot,
        session_version: version,
        pq_rerand_pk,
        pq_rerand_sk,
        root_aead_key: keys.root_aead_key.clone(),
    };

    // Write a genuine block 0 with a zero-length header in every namespace
    // this slot already has blocks for. The PQ keypair was just rotated,
    // so any block under the slot's *previous* PK no longer decrypts under
    // the freshly-derived session key. Three cases produce such blocks:
    //
    //   * `DEFAULT_NAMESPACE`: `provision_storage` reset the slot to a
    //     length-0 stream under a throwaway PK; `repair_blockstream_lengths`
    //     called from any other slot's first write may also have padded.
    //
    //   * Any other namespace another slot has written to. Cross-slot
    //     padding from `extend_blockstream_with_session_block` populated
    //     this slot with cover blocks built under whatever PK was then in
    //     the keypair file (the throwaway from `provision_storage`).
    //     Without this pass, the next `read_total_length` on this
    //     (session, namespace) pair returns CorruptedBlock - exactly the
    //     two-account onboarding crash the native VFS test reproduces.
    //
    // For each affected namespace, `ensure_block_count(.., 1)` brings
    // global_count to at least 1 (and so does this slot's local count via
    // repair_blockstream_lengths), then we overwrite block 0 with a
    // genuine length-0 ciphertext under the new key. Higher block indices
    // (1..N) keep their old cover ciphertext: we never need to read them
    // because the length header at block 0 says the stream is empty.
    let ns_state = NamespaceState::empty();
    let mut targets = storage.namespaces_with_data(slot)?;
    if !targets.contains(&DEFAULT_NAMESPACE) {
        targets.push(DEFAULT_NAMESPACE);
    }
    let mut pt = Zeroizing::new(vec![0u8; PLAINTEXT_SIZE]);
    for ns in targets {
        ensure_block_count(storage, domain, ns, &session, &ns_state, 1)?;
        rand::rngs::OsRng.fill_bytes(&mut pt[..]);
        pt[..LENGTH_HDR_SIZE].copy_from_slice(&0u64.to_be_bytes());
        let pt_arr: &[u8; PLAINTEXT_SIZE] = pt.as_slice().try_into().unwrap();
        encrypt_session_data_block(storage, domain, ns, &session, 0, pt_arr)?;
    }

    Ok(session)
}

/// Rerandomize a random block across all sessions for `namespace`.
///
/// Called periodically to mask activity patterns. Does not require
/// an unlocked session — only public keys are needed. Each namespace has
/// its own independent global block count, so the SDK should call this
/// once per namespace it wants to keep masked.
pub fn cover_traffic_tick<S: BlockStorage + KeypairStorage>(
    storage: &mut S,
    domain: &str,
    namespace: u8,
) -> Result<()> {
    repair_blockstream_lengths(storage, domain, namespace)?;
    let global_count = crate::write::get_global_block_count(storage, namespace)?;
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
            namespace,
            block_index,
        );

        let new_ct = match storage.read_block(cur_session, namespace, block_index) {
            Ok(cur_ct) => rerandomize_block(&cur_pk, &cur_ct),
            Err(_) => create_cover_block(&cur_pk, &cur_aad_root),
        };
        let ct_arr: &[u8; BLOCK_SIZE] = new_ct
            .as_slice()
            .try_into()
            .map_err(|_| SecureStorageError::CorruptedBlock)?;
        storage.write_block(cur_session, namespace, block_index, ct_arr)?;
        storage.fsync(cur_session, namespace)?;
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::read::read_session_data;
    use crate::run_with_stack;
    use crate::storage::MemoryStorage;
    use crate::unlock::{load_namespace_state, unlock_session};
    use crate::write::write_session_data;

    const DOMAIN: &str = "test";
    const NS: u8 = DEFAULT_NAMESPACE;

    // --- commit 15: provisioning and allocation ---

    #[test]
    fn provision_creates_all_slots() {
        run_with_stack(|| {
            let mut storage = MemoryStorage::new();
            provision_storage(&mut storage).unwrap();

            for i in 0..SESSION_COUNT as u8 {
                let s = SessionIndex::new(i).unwrap();
                let data = storage.read_keypair(s).unwrap();
                let kf = KeypairFile::deserialize(&data).unwrap();
                assert_eq!(kf.version, 0);
                assert_eq!(kf.pq_pk.len(), PqPublicKey::byte_size());
            }
        });
    }

    #[test]
    fn provision_pk_valid() {
        run_with_stack(|| {
            let mut storage = MemoryStorage::new();
            provision_storage(&mut storage).unwrap();

            for i in 0..SESSION_COUNT as u8 {
                let s = SessionIndex::new(i).unwrap();
                let (_, pk_bytes) = read_session_version_and_pk(&storage, s).unwrap();
                let pk = PqPublicKey::from_bytes(&pk_bytes).unwrap();
                let cover = create_cover_block(&pk, "test_aad");
                assert_eq!(cover.len(), BLOCK_SIZE);
            }
        });
    }

    #[test]
    fn provision_not_unlockable() {
        run_with_stack(|| {
            let mut storage = MemoryStorage::new();
            provision_storage(&mut storage).unwrap();

            let result = unlock_session(&storage, DOMAIN, b"any-password");
            assert!(result.is_err());
        });
    }

    #[test]
    fn allocate_then_unlock() {
        run_with_stack(|| {
            let mut storage = MemoryStorage::new();
            provision_storage(&mut storage).unwrap();

            let slot = SessionIndex::new(2).unwrap();
            let password = b"test-password";
            let session = allocate_session(&mut storage, DOMAIN, slot, password).unwrap();
            assert_eq!(session.session_index, slot);

            let unlocked = unlock_session(&storage, DOMAIN, password).unwrap();
            assert_eq!(unlocked.session_index, slot);
        });
    }

    #[test]
    fn allocate_wrong_password_fails() {
        run_with_stack(|| {
            let mut storage = MemoryStorage::new();
            provision_storage(&mut storage).unwrap();

            let slot = SessionIndex::new(0).unwrap();
            allocate_session(&mut storage, DOMAIN, slot, b"correct").unwrap();

            let result = unlock_session(&storage, DOMAIN, b"wrong");
            assert!(result.is_err());
        });
    }

    #[test]
    fn allocate_changes_pk() {
        run_with_stack(|| {
            let mut storage = MemoryStorage::new();
            provision_storage(&mut storage).unwrap();

            let slot = SessionIndex::new(0).unwrap();
            let (_, old_pk) = read_session_version_and_pk(&storage, slot).unwrap();

            allocate_session(&mut storage, DOMAIN, slot, b"password").unwrap();

            let (_, new_pk) = read_session_version_and_pk(&storage, slot).unwrap();
            assert_ne!(old_pk, new_pk);
        });
    }

    #[test]
    fn two_sessions_different_passwords() {
        run_with_stack(|| {
            let mut storage = MemoryStorage::new();
            provision_storage(&mut storage).unwrap();

            let s0 = SessionIndex::new(0).unwrap();
            let s2 = SessionIndex::new(2).unwrap();
            allocate_session(&mut storage, DOMAIN, s0, b"password-one").unwrap();
            allocate_session(&mut storage, DOMAIN, s2, b"password-two").unwrap();

            let u1 = unlock_session(&storage, DOMAIN, b"password-one").unwrap();
            assert_eq!(u1.session_index, s0);

            let u2 = unlock_session(&storage, DOMAIN, b"password-two").unwrap();
            assert_eq!(u2.session_index, s2);
        });
    }

    #[test]
    fn allocate_writes_genuine_block_0() {
        run_with_stack(|| {
            let mut storage = MemoryStorage::new();
            provision_storage(&mut storage).unwrap();

            let slot = SessionIndex::new(0).unwrap();
            allocate_session(&mut storage, DOMAIN, slot, b"pw").unwrap();

            let unlocked = unlock_session(&storage, DOMAIN, b"pw").unwrap();
            let ns_state = load_namespace_state(&storage, DOMAIN, &unlocked, NS).unwrap();
            assert_eq!(ns_state.total_data_length, 0);
        });
    }

    #[test]
    fn allocate_after_other_session_has_blocks() {
        run_with_stack(|| {
            let mut storage = MemoryStorage::new();
            provision_storage(&mut storage).unwrap();

            let s0 = SessionIndex::new(0).unwrap();
            let sess0 = allocate_session(&mut storage, DOMAIN, s0, b"password-one").unwrap();
            let mut ns0 = NamespaceState::empty();
            write_session_data(&mut storage, DOMAIN, NS, &sess0, &mut ns0, 0, &[0xAB; 100])
                .unwrap();

            let s2 = SessionIndex::new(2).unwrap();
            allocate_session(&mut storage, DOMAIN, s2, b"password-two").unwrap();

            let unlocked = unlock_session(&storage, DOMAIN, b"password-two").unwrap();
            assert_eq!(unlocked.session_index, s2);
            let ns2 = load_namespace_state(&storage, DOMAIN, &unlocked, NS).unwrap();
            assert_eq!(ns2.total_data_length, 0);

            let u0 = unlock_session(&storage, DOMAIN, b"password-one").unwrap();
            assert_eq!(u0.session_index, s0);
            let ns0_loaded = load_namespace_state(&storage, DOMAIN, &u0, NS).unwrap();
            assert_eq!(ns0_loaded.total_data_length, 100);
        });
    }

    #[test]
    fn cover_tick_after_allocate_before_write() {
        run_with_stack(|| {
            let mut storage = MemoryStorage::new();
            provision_storage(&mut storage).unwrap();

            let slot = SessionIndex::new(0).unwrap();
            allocate_session(&mut storage, DOMAIN, slot, b"pw").unwrap();

            for _ in 0..10 {
                cover_traffic_tick(&mut storage, DOMAIN, NS).unwrap();
            }

            let unlocked = unlock_session(&storage, DOMAIN, b"pw").unwrap();
            let ns_state = load_namespace_state(&storage, DOMAIN, &unlocked, NS).unwrap();
            assert_eq!(ns_state.total_data_length, 0);
        });
    }

    // --- commit 16: cover_traffic_tick ---

    #[test]
    fn cover_tick_empty_storage() {
        run_with_stack(|| {
            let mut storage = MemoryStorage::new();
            provision_storage(&mut storage).unwrap();

            cover_traffic_tick(&mut storage, DOMAIN, NS).unwrap();
        });
    }

    #[test]
    fn cover_tick_changes_blocks() {
        run_with_stack(|| {
            let mut storage = MemoryStorage::new();
            provision_storage(&mut storage).unwrap();

            let slot = SessionIndex::new(0).unwrap();
            let session = allocate_session(&mut storage, DOMAIN, slot, b"pw").unwrap();
            let mut ns_state = NamespaceState::empty();

            let data = vec![0xAB; 100];
            write_session_data(&mut storage, DOMAIN, NS, &session, &mut ns_state, 0, &data)
                .unwrap();

            let mut before = Vec::new();
            for i in 0..SESSION_COUNT as u8 {
                let s = SessionIndex::new(i).unwrap();
                before.push(storage.read_block(s, NS, 0).unwrap());
            }

            for _ in 0..5 {
                cover_traffic_tick(&mut storage, DOMAIN, NS).unwrap();
            }

            let mut changed = false;
            for i in 0..SESSION_COUNT as u8 {
                let s = SessionIndex::new(i).unwrap();
                let after = storage.read_block(s, NS, 0).unwrap();
                if *after != *before[i as usize] {
                    changed = true;
                }
            }
            assert!(changed, "cover tick should change at least some blocks");
        });
    }

    #[test]
    fn cover_tick_preserves_genuine() {
        run_with_stack(|| {
            let mut storage = MemoryStorage::new();
            provision_storage(&mut storage).unwrap();

            let slot = SessionIndex::new(0).unwrap();
            let session = allocate_session(&mut storage, DOMAIN, slot, b"pw").unwrap();
            let mut ns_state = NamespaceState::empty();

            let data = vec![0xCD; 100];
            write_session_data(&mut storage, DOMAIN, NS, &session, &mut ns_state, 0, &data)
                .unwrap();

            for _ in 0..10 {
                cover_traffic_tick(&mut storage, DOMAIN, NS).unwrap();
            }

            let result =
                read_session_data(&storage, DOMAIN, NS, &session, &ns_state, 0, 100).unwrap();
            assert_eq!(&*result, &data);
        });
    }

    /// Multi-account onboarding scenario:
    ///   1. alice allocate (slot 0)
    ///   2. bob allocate (slot 1)   ← consecutive allocates, no writes between
    ///   3. alice writes namespace=SESSION_BLOB (ns=1)
    ///   4. bob's `load_namespace_state(ns=1)` MUST return length=0
    ///
    /// Without the multi-namespace init in `allocate_session`, step 3's
    /// `extend_blockstream_with_session_block(ns=1)` puts a cover block
    /// in bob's slot under bob's *current* PQ public key. Bob can decrypt
    /// it (AEAD passes) but the plaintext is random, so the length header
    /// at byte 0 is a random u64. `load_namespace_state` then returns
    /// "length = some huge garbage value" instead of 0, and any subsequent
    /// session-blob read either reads gibberish or out-of-bounds errors.
    ///
    /// Bob's slot was never written by bob, so length must be 0 from his
    /// POV regardless of what other slots have done in this namespace.
    #[test]
    fn allocate_isolates_namespace_against_later_cross_slot_writes() {
        const SESSION_BLOB_NS: u8 = 1;
        run_with_stack(|| {
            let mut storage = MemoryStorage::new();
            provision_storage(&mut storage).unwrap();

            // 1. alice allocate
            let alice_slot = SessionIndex::new(0).unwrap();
            let alice_session =
                allocate_session(&mut storage, DOMAIN, alice_slot, b"alice-pw").unwrap();

            // 2. bob allocate, immediately after, no writes between
            let bob_slot = SessionIndex::new(1).unwrap();
            let bob_session = allocate_session(&mut storage, DOMAIN, bob_slot, b"bob-pw").unwrap();

            // 3. alice writes her session blob in ns=1. This is the FIRST
            //    activity in ns=1 across all slots, so it triggers the
            //    cross-slot extend: bob's slot gets a cover block under
            //    bob's CURRENT public key (PK_bob).
            let alice_blob = vec![0xAA; 100];
            let mut alice_ns1 = NamespaceState::empty();
            write_session_data(
                &mut storage,
                DOMAIN,
                SESSION_BLOB_NS,
                &alice_session,
                &mut alice_ns1,
                0,
                &alice_blob,
            )
            .unwrap();

            // PD invariant check: cross-slot counts are equal in ns=1.
            for i in 0..SESSION_COUNT as u8 {
                let s = SessionIndex::new(i).unwrap();
                assert!(
                    storage.block_count(s, SESSION_BLOB_NS).unwrap() >= 1,
                    "slot {i} should have at least 1 block in ns=1 after alice's write"
                );
            }

            // 4. bob's load_namespace_state(ns=1) MUST return length=0.
            //    His slot has 1 block - a cover under his real PK that
            //    decrypts to random bytes. Without proactive init at
            //    allocate, the length header is whatever random bytes
            //    are in that cover, which is essentially never 0.
            let bob_ns1 =
                load_namespace_state(&storage, DOMAIN, &bob_session, SESSION_BLOB_NS).unwrap();
            assert_eq!(
                bob_ns1.total_data_length, 0,
                "bob's ns=1 must look empty: he has never written there. \
                 Reading garbage from alice's cross-slot cover would corrupt \
                 his session-blob load and brick his account."
            );
        });
    }
}
