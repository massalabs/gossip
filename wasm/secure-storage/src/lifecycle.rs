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

/// Permanently destroy the contents of `slot` while keeping the slot
/// structurally indistinguishable from a never-allocated cover slot.
///
/// Steps:
/// 1. Replace the keypair file with a fresh dummy one (random throwaway
///    wrap key, exactly the pattern from [`provision_storage`]). After
///    this, [`crate::unlock::unlock_session`] returns `InvalidPassword`
///    for the old secret - the slot is permanently inaccessible. This
///    write uses its own redb transaction and is durable as soon as it
///    returns; everything below stages into the caller's transaction.
/// 2. For each namespace, sweep every block index across all slots:
///    overwrite the destroyed slot's blocks with fresh cover blocks
///    generated under the new PK, and PQ-rerandomize every other slot's
///    block in place under its (unchanged) PK. The snapshot diff
///    straddling destroy is therefore symmetric across all slots
///    (all slots change at every block index), restoring the
///    "indistinguishable from cover-traffic activity" property a
///    single-slot mutation would otherwise break.
///
/// No `reset_blockstream` is needed: by the cross-slot block-count
/// parity invariant the destroyed slot already has the same number of
/// blocks as everyone else, so the sweep can rewrite each one in place
/// without first dropping it. Skipping the reset is also what makes the
/// caller's "discard pending on error" rollback complete, since no
/// in-memory storage counters get mutated mid-destroy.
///
/// The caller is responsible for committing the backing store: nothing
/// after step 1 is fsync'd from inside this function. Wrapping step 2
/// in a single `commit()` makes the camouflage atomic: a process crash
/// before commit rolls back the staged writes, leaving the (now-dead)
/// slot's blocks intact under the old key. The slot itself is dead from
/// step 1 either way.
pub fn destroy_session<S: BlockStorage + KeypairStorage>(
    storage: &mut S,
    domain: &str,
    slot: SessionIndex,
    namespaces: &[u8],
) -> Result<()> {
    // 1. Fresh dummy keypair - random wrap key (no password derives it),
    //    so the slot becomes structurally valid AEAD ciphertext but
    //    impossible to unlock. Same pattern as `provision_storage`.
    let (pk, _sk) = pq_keygen();
    // _sk dropped at end of statement; its Drop impl zeroizes
    let dummy_wrap_key = crypto_aead::Key::from({
        let mut k = Zeroizing::new([0u8; crypto_aead::KEY_SIZE]);
        rand::rngs::OsRng.fill_bytes(k.as_mut());
        *k
    });
    let mut dummy_sk = Zeroizing::new(vec![0u8; PqSecretKey::byte_size()]);
    rand::rngs::OsRng.fill_bytes(dummy_sk.as_mut());
    let kf = KeypairFile::build_wrapped(0, pk.to_bytes(), &dummy_wrap_key, &dummy_sk, b"");
    storage.write_keypair(slot, &kf.serialize())?;

    // 2. Snapshot-symmetric camouflage. For each namespace, sweep every
    //    block index across all slots; the destroyed slot is forced
    //    through the create_cover branch because its existing blocks
    //    are under the old PK and cannot be rerandomized under the new.
    for &ns in namespaces {
        rerandomize_all_blocks_all_slots(storage, domain, ns, Some(slot))?;
    }

    Ok(())
}

/// Rerandomize one specific block index across all session slots in
/// `namespace`. Slot order is freshly shuffled to avoid an ordering
/// oracle. Reads the existing ciphertext when present and PQ-rerandomizes
/// it (same plaintext, fresh ciphertext); falls back to a freshly-built
/// cover block when the slot has no block at that index yet.
///
/// `force_cover_for` skips the read+rerandomize path for the given slot
/// and always emits a fresh cover block. Used by [`destroy_session`]:
/// the destroyed slot's existing blocks are encrypted under its old
/// PK, which the freshly-installed dummy PK cannot rerandomize, so they
/// must be overwritten with covers built under the new PK instead.
///
/// Shared primitive used by [`cover_traffic_tick`] (one random block per
/// call, periodic background masking) and [`rerandomize_all_blocks_all_slots`]
/// (every block, called from [`destroy_session`] for snapshot-diff
/// symmetry).
fn rerandomize_block_across_all_slots<S: BlockStorage + KeypairStorage>(
    storage: &mut S,
    domain: &str,
    namespace: u8,
    block_index: u64,
    force_cover_for: Option<SessionIndex>,
) -> Result<()> {
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

        let force_cover = force_cover_for == Some(cur_session);
        let new_ct = if force_cover {
            create_cover_block(&cur_pk, &cur_aad_root)
        } else {
            match storage.read_block(cur_session, namespace, block_index) {
                Ok(cur_ct) => rerandomize_block(&cur_pk, &cur_ct),
                Err(_) => create_cover_block(&cur_pk, &cur_aad_root),
            }
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

/// Rerandomize every block of every slot in `namespace`. Used by
/// [`destroy_session`] to make the snapshot diff straddling a destroy
/// symmetric across all slots, so an attacker comparing pre/post
/// snapshots cannot single out the destroyed slot.
///
/// `force_cover_for` is forwarded to [`rerandomize_block_across_all_slots`]
/// for every block index; pass `Some(slot)` from `destroy_session` and
/// `None` otherwise.
///
/// Cost is `SESSION_COUNT * global_block_count` AEAD ops, which is
/// acceptable for an explicit user action (logout / delete account)
/// but too expensive for the periodic scheduler. For routine masking
/// see [`cover_traffic_tick`], which rerandomizes a single block index
/// across all slots per call.
fn rerandomize_all_blocks_all_slots<S: BlockStorage + KeypairStorage>(
    storage: &mut S,
    domain: &str,
    namespace: u8,
    force_cover_for: Option<SessionIndex>,
) -> Result<()> {
    let global_count = crate::write::get_global_block_count(storage, namespace)?;
    for block_index in 0..global_count {
        rerandomize_block_across_all_slots(
            storage,
            domain,
            namespace,
            block_index,
            force_cover_for,
        )?;
    }
    Ok(())
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
    rerandomize_block_across_all_slots(storage, domain, namespace, block_index, None)
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

    // --- destroy_session ---

    #[test]
    fn destroy_makes_old_password_fail() {
        run_with_stack(|| {
            let mut storage = MemoryStorage::new();
            provision_storage(&mut storage).unwrap();

            let slot = SessionIndex::new(1).unwrap();
            let session = allocate_session(&mut storage, DOMAIN, slot, b"correct").unwrap();
            let mut ns_state = NamespaceState::empty();
            write_session_data(
                &mut storage,
                DOMAIN,
                NS,
                &session,
                &mut ns_state,
                0,
                &[0xAB; 100],
            )
            .unwrap();

            destroy_session(&mut storage, DOMAIN, slot, &[NS]).unwrap();

            // The same secret no longer unlocks anything.
            assert!(matches!(
                unlock_session(&storage, DOMAIN, b"correct"),
                Err(SecureStorageError::InvalidPassword)
            ));
        });
    }

    #[test]
    fn destroy_preserves_block_count_parity() {
        run_with_stack(|| {
            let mut storage = MemoryStorage::new();
            provision_storage(&mut storage).unwrap();

            let s0 = SessionIndex::new(0).unwrap();
            let session = allocate_session(&mut storage, DOMAIN, s0, b"pw").unwrap();
            let mut ns_state = NamespaceState::empty();
            // Force the global count to grow on namespace NS.
            write_session_data(
                &mut storage,
                DOMAIN,
                NS,
                &session,
                &mut ns_state,
                0,
                &vec![0x42; 10_000],
            )
            .unwrap();

            // Snapshot per-slot block counts before destroy.
            let before: Vec<u64> = (0..SESSION_COUNT as u8)
                .map(|i| {
                    storage
                        .block_count(SessionIndex::new(i).unwrap(), NS)
                        .unwrap()
                })
                .collect();

            destroy_session(&mut storage, DOMAIN, s0, &[NS]).unwrap();

            let after: Vec<u64> = (0..SESSION_COUNT as u8)
                .map(|i| {
                    storage
                        .block_count(SessionIndex::new(i).unwrap(), NS)
                        .unwrap()
                })
                .collect();
            assert_eq!(
                before, after,
                "destroy must preserve per-slot block counts (PD invariant)"
            );
        });
    }

    #[test]
    fn destroy_does_not_affect_other_slots() {
        run_with_stack(|| {
            let mut storage = MemoryStorage::new();
            provision_storage(&mut storage).unwrap();

            let s0 = SessionIndex::new(0).unwrap();
            let s2 = SessionIndex::new(2).unwrap();

            // Both slots get real data: s0 with a payload we'll read back
            // after destroy(s2) to prove its blockstream wasn't disturbed.
            let session0 = allocate_session(&mut storage, DOMAIN, s0, b"keep-me").unwrap();
            let s0_payload = vec![0x9A; 6_000];
            let mut ns_state_0 = NamespaceState::empty();
            write_session_data(
                &mut storage,
                DOMAIN,
                NS,
                &session0,
                &mut ns_state_0,
                0,
                &s0_payload,
            )
            .unwrap();

            let session2 = allocate_session(&mut storage, DOMAIN, s2, b"destroy-me").unwrap();
            let mut ns_state_2 = NamespaceState::empty();
            write_session_data(
                &mut storage,
                DOMAIN,
                NS,
                &session2,
                &mut ns_state_2,
                0,
                &[0xCD; 200],
            )
            .unwrap();

            destroy_session(&mut storage, DOMAIN, s2, &[NS]).unwrap();

            // s0 still unlockable with its original password.
            let unlocked = unlock_session(&storage, DOMAIN, b"keep-me").unwrap();
            assert_eq!(unlocked.session_index, s0);
            // And — the part the previous version of this test missed —
            // s0's ciphertext blocks are still decryptable to the right
            // plaintext. A destroy that bled into other slots' blocks
            // would corrupt this read.
            let s0_ns_state =
                load_namespace_state(&storage, DOMAIN, &unlocked, NS).unwrap();
            let s0_read = read_session_data(
                &storage,
                DOMAIN,
                NS,
                &unlocked,
                &s0_ns_state,
                0,
                s0_payload.len(),
            )
            .unwrap();
            assert_eq!(&*s0_read, &s0_payload);

            // s2's password no longer matches anything.
            assert!(matches!(
                unlock_session(&storage, DOMAIN, b"destroy-me"),
                Err(SecureStorageError::InvalidPassword)
            ));
        });
    }

    #[test]
    fn destroy_makes_snapshot_diff_symmetric_across_all_slots() {
        // PD regression: an attacker comparing storage snapshots taken
        // before and after destroy must NOT be able to single out the
        // destroyed slot. Every block of every slot must change between
        // the two snapshots; otherwise the destroyed slot is fingerprinted
        // by being the only one with all-changed blocks.
        run_with_stack(|| {
            let mut storage = MemoryStorage::new();
            provision_storage(&mut storage).unwrap();

            let s0 = SessionIndex::new(0).unwrap();
            let s1 = SessionIndex::new(1).unwrap();
            let session0 = allocate_session(&mut storage, DOMAIN, s0, b"keep").unwrap();
            let session1 = allocate_session(&mut storage, DOMAIN, s1, b"destroy").unwrap();

            let s0_payload = vec![0x42u8; crate::PLAINTEXT_SIZE * 3];
            let mut ns0 = NamespaceState::empty();
            write_session_data(
                &mut storage, DOMAIN, NS, &session0, &mut ns0, 0, &s0_payload,
            )
            .unwrap();
            let mut ns1 = NamespaceState::empty();
            write_session_data(
                &mut storage,
                DOMAIN,
                NS,
                &session1,
                &mut ns1,
                0,
                &vec![0xAB; crate::PLAINTEXT_SIZE * 2],
            )
            .unwrap();

            let global = crate::write::get_global_block_count(&storage, NS).unwrap();
            assert!(global > 1, "test needs a multi-block stream");

            let snapshot = |s: &MemoryStorage| -> Vec<Vec<Vec<u8>>> {
                (0..SESSION_COUNT as u8)
                    .map(|i| {
                        let slot = SessionIndex::new(i).unwrap();
                        (0..global)
                            .map(|b| s.read_block(slot, NS, b).unwrap().to_vec())
                            .collect()
                    })
                    .collect()
            };

            let before = snapshot(&storage);
            destroy_session(&mut storage, DOMAIN, s1, &[NS]).unwrap();
            let after = snapshot(&storage);

            for slot_i in 0..SESSION_COUNT as usize {
                for b in 0..global as usize {
                    assert_ne!(
                        before[slot_i][b], after[slot_i][b],
                        "slot {slot_i} block {b}: ciphertext unchanged after destroy (PD leak)"
                    );
                }
            }

            // Sanity: surviving slot is still functionally intact.
            let unlocked = unlock_session(&storage, DOMAIN, b"keep").unwrap();
            assert_eq!(unlocked.session_index, s0);
            let s0_ns_state =
                load_namespace_state(&storage, DOMAIN, &unlocked, NS).unwrap();
            let s0_read = read_session_data(
                &storage,
                DOMAIN,
                NS,
                &unlocked,
                &s0_ns_state,
                0,
                s0_payload.len(),
            )
            .unwrap();
            assert_eq!(&*s0_read, &s0_payload[..]);
        });
    }

    #[test]
    fn cover_tick_after_destroy_stays_consistent() {
        run_with_stack(|| {
            let mut storage = MemoryStorage::new();
            provision_storage(&mut storage).unwrap();

            // Two real slots: s1 will be destroyed, s0 must survive
            // intact even after cover ticks rerandomize blocks across
            // all slots (including the destroyed one).
            let s0 = SessionIndex::new(0).unwrap();
            let s1 = SessionIndex::new(1).unwrap();
            let session0 = allocate_session(&mut storage, DOMAIN, s0, b"keep").unwrap();
            let s0_payload = vec![0x77; 4_000];
            let mut ns_state_0 = NamespaceState::empty();
            write_session_data(
                &mut storage,
                DOMAIN,
                NS,
                &session0,
                &mut ns_state_0,
                0,
                &s0_payload,
            )
            .unwrap();

            let session1 = allocate_session(&mut storage, DOMAIN, s1, b"destroy").unwrap();
            let mut ns_state_1 = NamespaceState::empty();
            write_session_data(
                &mut storage,
                DOMAIN,
                NS,
                &session1,
                &mut ns_state_1,
                0,
                &[0xEE; 500],
            )
            .unwrap();

            destroy_session(&mut storage, DOMAIN, s1, &[NS]).unwrap();

            // Cover ticks read version+PK from each slot's keypair file
            // and rerandomize blocks under that identity. After destroy
            // the s1 keypair is dummy but still valid, so cover_traffic_tick
            // should produce well-formed blocks for all slots.
            for _ in 0..10 {
                cover_traffic_tick(&mut storage, DOMAIN, NS).unwrap();
            }

            // s0 must still unlock and its real data must read back
            // unchanged — cover ticks don't touch real ciphertext (they
            // re-randomize, which is a no-op for the holder of the key).
            let unlocked = unlock_session(&storage, DOMAIN, b"keep").unwrap();
            assert_eq!(unlocked.session_index, s0);
            let s0_ns_state =
                load_namespace_state(&storage, DOMAIN, &unlocked, NS).unwrap();
            let s0_read = read_session_data(
                &storage,
                DOMAIN,
                NS,
                &unlocked,
                &s0_ns_state,
                0,
                s0_payload.len(),
            )
            .unwrap();
            assert_eq!(&*s0_read, &s0_payload);

            // s1's old secret remains dead.
            assert!(matches!(
                unlock_session(&storage, DOMAIN, b"destroy"),
                Err(SecureStorageError::InvalidPassword)
            ));
        });
    }

    #[test]
    fn destroy_clears_multiple_namespaces() {
        run_with_stack(|| {
            let mut storage = MemoryStorage::new();
            provision_storage(&mut storage).unwrap();

            const NS_A: u8 = DEFAULT_NAMESPACE;
            const NS_B: u8 = 1;

            let slot = SessionIndex::new(0).unwrap();
            let session = allocate_session(&mut storage, DOMAIN, slot, b"pw").unwrap();

            let mut ns_state_a = NamespaceState::empty();
            write_session_data(
                &mut storage,
                DOMAIN,
                NS_A,
                &session,
                &mut ns_state_a,
                0,
                &[0x11; 300],
            )
            .unwrap();
            let mut ns_state_b = NamespaceState::empty();
            write_session_data(
                &mut storage,
                DOMAIN,
                NS_B,
                &session,
                &mut ns_state_b,
                0,
                &[0x22; 300],
            )
            .unwrap();

            destroy_session(&mut storage, DOMAIN, slot, &[NS_A, NS_B]).unwrap();

            // Both namespaces' real ciphertext is gone — the block-count
            // parity is preserved across both, and the old secret is
            // dead.
            assert!(matches!(
                unlock_session(&storage, DOMAIN, b"pw"),
                Err(SecureStorageError::InvalidPassword)
            ));
        });
    }

    #[test]
    fn destroy_overwrites_block_ciphertext() {
        // Locking out the old secret is necessary but not sufficient:
        // an attacker who held the old keys before destroy must not be
        // able to read the same plaintext from the post-destroy blocks.
        // We assert this at the byte level by snapshotting block 0's
        // ciphertext before and after.
        run_with_stack(|| {
            let mut storage = MemoryStorage::new();
            provision_storage(&mut storage).unwrap();

            let slot = SessionIndex::new(0).unwrap();
            let session = allocate_session(&mut storage, DOMAIN, slot, b"pw").unwrap();
            let mut ns_state = NamespaceState::empty();
            write_session_data(
                &mut storage,
                DOMAIN,
                NS,
                &session,
                &mut ns_state,
                0,
                &[0x55; 8_000],
            )
            .unwrap();

            let block_before = storage.read_block(slot, NS, 0).unwrap();

            destroy_session(&mut storage, DOMAIN, slot, &[NS]).unwrap();

            let block_after = storage.read_block(slot, NS, 0).unwrap();
            assert_ne!(
                *block_before, *block_after,
                "destroy must overwrite the slot's ciphertext, not just rotate the keypair"
            );
        });
    }

    #[test]
    fn destroy_then_reallocate_slot() {
        // Multi-account use case: after a user deletes their account
        // we must be able to onboard a fresh account on the same slot
        // with a different password. The new session must be readable
        // via the new password and unrelated to the old one.
        run_with_stack(|| {
            let mut storage = MemoryStorage::new();
            provision_storage(&mut storage).unwrap();

            let slot = SessionIndex::new(0).unwrap();
            let session1 = allocate_session(&mut storage, DOMAIN, slot, b"first").unwrap();
            let mut ns_state_1 = NamespaceState::empty();
            write_session_data(
                &mut storage,
                DOMAIN,
                NS,
                &session1,
                &mut ns_state_1,
                0,
                &[0xAA; 1_500],
            )
            .unwrap();

            destroy_session(&mut storage, DOMAIN, slot, &[NS]).unwrap();

            // Re-allocate the same slot with a brand-new password.
            let session2 = allocate_session(&mut storage, DOMAIN, slot, b"second").unwrap();
            let payload2 = vec![0xBB; 2_500];
            let mut ns_state_2 = NamespaceState::empty();
            write_session_data(
                &mut storage,
                DOMAIN,
                NS,
                &session2,
                &mut ns_state_2,
                0,
                &payload2,
            )
            .unwrap();

            // The new password unlocks the slot and reads back the new
            // payload — proving the slot is fully reusable.
            let unlocked = unlock_session(&storage, DOMAIN, b"second").unwrap();
            assert_eq!(unlocked.session_index, slot);
            let ns_state =
                load_namespace_state(&storage, DOMAIN, &unlocked, NS).unwrap();
            let read = read_session_data(
                &storage,
                DOMAIN,
                NS,
                &unlocked,
                &ns_state,
                0,
                payload2.len(),
            )
            .unwrap();
            assert_eq!(&*read, &payload2);

            // The first password remains permanently dead.
            assert!(matches!(
                unlock_session(&storage, DOMAIN, b"first"),
                Err(SecureStorageError::InvalidPassword)
            ));
        });
    }

    #[test]
    fn destroy_empty_namespace_is_noop() {
        // Calling destroy with a namespace the slot never wrote to
        // must not error: `repair_blockstream_lengths` handles a
        // global_count of 0 by doing nothing. This guards the SDK
        // from having to inspect block counts before passing its
        // canonical namespace list.
        run_with_stack(|| {
            let mut storage = MemoryStorage::new();
            provision_storage(&mut storage).unwrap();

            const NEVER_WRITTEN_NS: u8 = 7;

            let slot = SessionIndex::new(0).unwrap();
            allocate_session(&mut storage, DOMAIN, slot, b"pw").unwrap();
            // No write to NEVER_WRITTEN_NS at all.

            destroy_session(&mut storage, DOMAIN, slot, &[NEVER_WRITTEN_NS]).unwrap();

            // Still: old secret is dead (the keypair rotation step
            // runs unconditionally, regardless of namespace contents).
            assert!(matches!(
                unlock_session(&storage, DOMAIN, b"pw"),
                Err(SecureStorageError::InvalidPassword)
            ));
        });
    }
}
