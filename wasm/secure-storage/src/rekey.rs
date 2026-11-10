//! In-place re-encryption of the whole store ("rekey").
//!
//! Used to set or change an account password, or to refresh every key
//! without changing any password. The source is the live store; the result is
//! a complete in-memory replacement store that the caller installs as a new
//! generation through the same candidate path onboarding uses.
//!
//! Properties the callers rely on:
//!
//! * Every slot gets a fresh public keypair, admitted or not, so the set of
//!   changed public keys never depends on how many accounts exist.
//! * An admitted slot keeps its data. Its blocks are decrypted with the source
//!   keys and encrypted again under keys derived from its destination
//!   password, then rerandomized.
//! * A slot that was not admitted becomes a dummy slot holding cover blocks.
//!   Any account it held is gone: a slot cannot be given a new keypair without
//!   its password.
//! * Block counts are copied exactly. Nothing grows and nothing is compacted.
//! * Match state stays inside this module. No call reports which slot a
//!   password opened, and every admission failure is the same error.
//!
//! This module is deliberately independent of the portable import/export
//! code. It depends only on the block, key-derivation, keypair, unlock and
//! storage primitives.

use rand::RngCore;
use zeroize::Zeroizing;

use crate::block::{create_cover_block, decrypt_block, encrypt_block, rerandomize_block};
use crate::constants::{
    BLOCK_SIZE, DEFAULT_NAMESPACE, LENGTH_HDR_SIZE, PLAINTEXT_SIZE, SESSION_COUNT,
};
use crate::domain;
use crate::error::{Result, SecureStorageError};
use crate::kdf::{derive_block_aead_key, derive_session_keys};
use crate::keypair::{CURRENT_SESSION_VERSION, KeypairFile};
use crate::pq::{PqSecretKey, pq_keygen};
use crate::storage::{BlockStorage, KeypairStorage, MemoryStorage};
use crate::types::SessionIndex;
use crate::unlock::{UnlockedSession, unlock_session_unique};

struct AdmittedSlot {
    source: UnlockedSession,
    destination_wrap_key: Zeroizing<[u8; crypto_aead::KEY_SIZE]>,
    destination_root_key: Zeroizing<[u8; crypto_aead::KEY_SIZE]>,
}

/// Password admission for one rekey operation.
pub struct RekeyPlan {
    domain: String,
    admitted: [Option<AdmittedSlot>; SESSION_COUNT],
}

fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    let mut difference = 0_u8;
    for (a, b) in left.iter().zip(right) {
        difference |= a ^ b;
    }
    difference == 0
}

impl RekeyPlan {
    #[must_use]
    pub fn new(domain: &str) -> Self {
        Self {
            domain: domain.to_owned(),
            admitted: std::array::from_fn(|_| None),
        }
    }

    /// Admit an account that keeps its password.
    pub fn admit_keep<S: BlockStorage + KeypairStorage>(
        &mut self,
        source: &S,
        password: &[u8],
    ) -> Result<()> {
        self.admit(source, password, password)
    }

    /// Admit an account whose password changes from `old` to `new`.
    pub fn admit_change<S: BlockStorage + KeypairStorage>(
        &mut self,
        source: &S,
        old: &[u8],
        new: &[u8],
    ) -> Result<()> {
        self.admit(source, old, new)
    }

    /// Every outcome that depends on secrets is the same generic error: no
    /// match, an ambiguous match, a slot admitted twice, or a destination
    /// password already claimed by another admitted account. Each admission
    /// does the same all-slot unlock work and one destination derivation.
    fn admit<S: BlockStorage + KeypairStorage>(
        &mut self,
        source: &S,
        old: &[u8],
        new: &[u8],
    ) -> Result<()> {
        if old.is_empty() || new.is_empty() {
            return Err(SecureStorageError::InvalidPassword);
        }
        let unlocked = unlock_session_unique(source, &self.domain, old);
        let destination = derive_session_keys(&self.domain, new);
        let session = unlocked?;
        let slot = usize::from(session.session_index.as_u8());

        let mut rejected = self.admitted[slot].is_some();
        for other in self.admitted.iter().flatten() {
            rejected |= constant_time_eq(
                other.destination_wrap_key.as_ref(),
                destination.sk_wrap_key.as_ref(),
            );
        }
        if rejected {
            return Err(SecureStorageError::InvalidPassword);
        }

        self.admitted[slot] = Some(AdmittedSlot {
            source: session,
            destination_wrap_key: destination.sk_wrap_key.clone(),
            destination_root_key: destination.root_aead_key.clone(),
        });
        Ok(())
    }

    /// Build the complete replacement store from `source`.
    ///
    /// `source` is only read. The returned store shares no key material with
    /// it except what the admitted passwords derive.
    pub fn build<S: BlockStorage + KeypairStorage>(self, source: &S) -> Result<MemoryStorage> {
        if self.admitted.iter().all(Option::is_none) {
            return Err(SecureStorageError::InvalidPassword);
        }

        let mut destination = MemoryStorage::new();
        let mut public_keys = Vec::with_capacity(SESSION_COUNT);
        for slot_index in 0..SESSION_COUNT {
            let slot = SessionIndex::new(slot_index as u8)?;
            let (public_key, secret_key) = pq_keygen();
            let keypair = if let Some(admitted) = self.admitted[slot_index].as_ref() {
                let wrap = crypto_aead::Key::from_ref(&admitted.destination_wrap_key);
                let secret_bytes = Zeroizing::new(secret_key.to_bytes());
                KeypairFile::build_current_wrapped(
                    &self.domain,
                    slot,
                    public_key.to_bytes(),
                    &wrap,
                    &secret_bytes,
                )?
            } else {
                // Same construction as `provision_storage`: a structurally
                // valid envelope under a throwaway key that no password opens.
                let dummy_wrap_key = crypto_aead::Key::from({
                    let mut key = Zeroizing::new([0_u8; crypto_aead::KEY_SIZE]);
                    rand::rngs::OsRng.fill_bytes(key.as_mut());
                    *key
                });
                let mut dummy_secret = Zeroizing::new(vec![0_u8; PqSecretKey::byte_size()]);
                rand::rngs::OsRng.fill_bytes(dummy_secret.as_mut());
                KeypairFile::build_current_wrapped(
                    &self.domain,
                    slot,
                    public_key.to_bytes(),
                    &dummy_wrap_key,
                    &dummy_secret,
                )?
            };
            drop(secret_key);
            destination.write_keypair(slot, &keypair.serialize()?)?;
            destination.reset_blockstream(slot, DEFAULT_NAMESPACE)?;
            public_keys.push(public_key);
        }

        let mut namespaces = vec![DEFAULT_NAMESPACE];
        for slot_index in 0..SESSION_COUNT {
            let slot = SessionIndex::new(slot_index as u8)?;
            for namespace in source.namespaces_with_data(slot)? {
                if !namespaces.contains(&namespace) {
                    namespaces.push(namespace);
                }
            }
        }
        namespaces.sort_unstable();

        for namespace in namespaces {
            let mut source_counts = [0_u64; SESSION_COUNT];
            for (slot_index, count) in source_counts.iter_mut().enumerate() {
                *count = source.block_count(SessionIndex::new(slot_index as u8)?, namespace)?;
            }
            let block_count = source_counts.iter().copied().max().unwrap_or(0);
            // Number of leading blocks that carry real data, per admitted slot.
            let mut required: [Option<u64>; SESSION_COUNT] = [None; SESSION_COUNT];

            for block_index in 0..block_count {
                for slot_index in 0..SESSION_COUNT {
                    let slot = SessionIndex::new(slot_index as u8)?;
                    let plaintext = match self.admitted[slot_index].as_ref() {
                        Some(admitted) if block_index < source_counts[slot_index] => {
                            let source_block = source.read_block(slot, namespace, block_index)?;
                            if block_index == 0 {
                                match decrypt_source_block(
                                    &self.domain,
                                    namespace,
                                    block_index,
                                    &admitted.source,
                                    &source_block,
                                ) {
                                    Ok(plaintext) => {
                                        let total = u64::from_be_bytes(
                                            plaintext[..LENGTH_HDR_SIZE]
                                                .try_into()
                                                .map_err(|_| SecureStorageError::CorruptedBlock)?,
                                        );
                                        required[slot_index] = Some(required_block_count(total)?);
                                        Some(plaintext)
                                    }
                                    // The account never wrote this namespace:
                                    // its stream there is cross-slot padding.
                                    Err(_) if namespace != DEFAULT_NAMESPACE => {
                                        required[slot_index] = Some(0);
                                        None
                                    }
                                    Err(error) => return Err(error),
                                }
                            } else if block_index
                                < required[slot_index].ok_or(SecureStorageError::CorruptedBlock)?
                            {
                                Some(decrypt_source_block(
                                    &self.domain,
                                    namespace,
                                    block_index,
                                    &admitted.source,
                                    &source_block,
                                )?)
                            } else {
                                None
                            }
                        }
                        _ => None,
                    };

                    let public_key = &public_keys[slot_index];
                    let encrypted = match (plaintext, self.admitted[slot_index].as_ref()) {
                        (Some(plaintext), Some(admitted)) => {
                            let (aead_key, aad_root) = derive_block_aead_key(
                                &self.domain,
                                CURRENT_SESSION_VERSION,
                                slot,
                                namespace,
                                admitted.destination_root_key.as_ref(),
                                block_index,
                            );
                            encrypt_block(public_key, &aead_key, &aad_root, &plaintext)
                        }
                        _ => {
                            let mut aad_root = String::new();
                            domain::block_scope(
                                &mut aad_root,
                                &self.domain,
                                CURRENT_SESSION_VERSION,
                                slot,
                                namespace,
                                block_index,
                            );
                            create_cover_block(public_key, &aad_root)
                        }
                    };
                    let encrypted: &[u8; BLOCK_SIZE] = encrypted
                        .as_slice()
                        .try_into()
                        .map_err(|_| SecureStorageError::CorruptedBlock)?;
                    let output = Zeroizing::new(rerandomize_block(public_key, encrypted)?);
                    let output: &[u8; BLOCK_SIZE] = output
                        .as_slice()
                        .try_into()
                        .map_err(|_| SecureStorageError::CorruptedBlock)?;
                    destination.append_block(slot, namespace, output)?;
                }
            }

            for (slot_index, admitted) in self.admitted.iter().enumerate() {
                if admitted.is_none() || source_counts[slot_index] == 0 {
                    continue;
                }
                let needed = required[slot_index].ok_or(SecureStorageError::CorruptedBlock)?;
                if needed > source_counts[slot_index] {
                    return Err(SecureStorageError::CorruptedBlock);
                }
            }
        }

        Ok(destination)
    }
}

fn decrypt_source_block(
    domain: &str,
    namespace: u8,
    block_index: u64,
    source: &UnlockedSession,
    ciphertext: &[u8; BLOCK_SIZE],
) -> Result<Zeroizing<[u8; PLAINTEXT_SIZE]>> {
    let (aead_key, aad_root) = derive_block_aead_key(
        domain,
        source.session_version,
        source.session_index,
        namespace,
        source.root_aead_key.as_ref(),
        block_index,
    );
    decrypt_block(&source.pq_rerand_sk, &aead_key, &aad_root, ciphertext)
}

fn required_block_count(total_length: u64) -> Result<u64> {
    let occupied = total_length
        .checked_add(LENGTH_HDR_SIZE as u64)
        .ok_or(SecureStorageError::Overflow)?;
    Ok(occupied.max(1).div_ceil(PLAINTEXT_SIZE as u64))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::keypair::read_session_keypair;
    use crate::read::read_session_data;
    use crate::run_with_stack;
    use crate::unlock::{NamespaceState, load_namespace_state, unlock_session};
    use crate::write::write_session_data;

    const DOMAIN: &str = "rekey-test";
    const ALICE: &[u8] = b"alice-password";
    const BOB: &[u8] = b"bob-password";
    const NEW: &[u8] = b"brand-new-password";

    const ALICE_SQL: &[u8] = b"alice sqlite bytes";
    const ALICE_SESSION: &[u8] = b"alice session blob";
    const BOB_SQL: &[u8] = b"bob sqlite bytes, somewhat longer than alice's";

    /// Slot 0 = Alice (both namespaces), slot 2 = Bob (namespace 0 only),
    /// slot 1 unused.
    fn source() -> MemoryStorage {
        let mut storage = MemoryStorage::new();
        crate::lifecycle::provision_storage_for_domain(&mut storage, DOMAIN).unwrap();
        let alice =
            crate::allocate_session(&mut storage, DOMAIN, SessionIndex::new(0).unwrap(), ALICE)
                .unwrap();
        for (namespace, value) in [(0_u8, ALICE_SQL), (1, ALICE_SESSION)] {
            let mut state = NamespaceState::empty();
            write_session_data(
                &mut storage,
                DOMAIN,
                namespace,
                &alice,
                &mut state,
                0,
                value,
            )
            .unwrap();
        }
        let bob = crate::allocate_session(&mut storage, DOMAIN, SessionIndex::new(2).unwrap(), BOB)
            .unwrap();
        let mut state = NamespaceState::empty();
        write_session_data(&mut storage, DOMAIN, 0, &bob, &mut state, 0, BOB_SQL).unwrap();
        storage
    }

    fn read_all(storage: &MemoryStorage, password: &[u8], namespace: u8, len: usize) -> Vec<u8> {
        let session = unlock_session(storage, DOMAIN, password).unwrap();
        let state = load_namespace_state(storage, DOMAIN, &session, namespace).unwrap();
        assert_eq!(state.total_data_length, len as u64);
        read_session_data(storage, DOMAIN, namespace, &session, &state, 0, len)
            .unwrap()
            .to_vec()
    }

    fn public_keys(storage: &MemoryStorage) -> Vec<Vec<u8>> {
        (0..SESSION_COUNT as u8)
            .map(|slot| {
                read_session_keypair(storage, SessionIndex::new(slot).unwrap())
                    .unwrap()
                    .pq_pk
            })
            .collect()
    }

    fn assert_layout_copied_and_all_blocks_differ(before: &MemoryStorage, after: &MemoryStorage) {
        for namespace in [0_u8, 1] {
            for slot in 0..SESSION_COUNT as u8 {
                let slot = SessionIndex::new(slot).unwrap();
                let count = before.block_count(slot, namespace).unwrap();
                assert_eq!(after.block_count(slot, namespace).unwrap(), count);
                for block in 0..count {
                    assert_ne!(
                        before.read_block(slot, namespace, block).unwrap(),
                        after.read_block(slot, namespace, block).unwrap()
                    );
                }
            }
        }
        for (old, new) in public_keys(before).iter().zip(public_keys(after)) {
            assert_ne!(old, &new);
        }
    }

    #[test]
    fn changes_one_password_keeps_another_and_erases_the_omitted_account() {
        run_with_stack(|| {
            let before = source();
            let mut plan = RekeyPlan::new(DOMAIN);
            plan.admit_change(&before, ALICE, NEW).unwrap();
            let after = plan.build(&before).unwrap();

            assert!(unlock_session(&after, DOMAIN, ALICE).is_err());
            assert_eq!(read_all(&after, NEW, 0, ALICE_SQL.len()), ALICE_SQL);
            assert_eq!(read_all(&after, NEW, 1, ALICE_SESSION.len()), ALICE_SESSION);
            // Bob was not admitted: his slot is now a dummy.
            assert!(unlock_session(&after, DOMAIN, BOB).is_err());
            assert_layout_copied_and_all_blocks_differ(&before, &after);
        });
    }

    #[test]
    fn keeps_every_admitted_account_readable() {
        run_with_stack(|| {
            let before = source();
            let mut plan = RekeyPlan::new(DOMAIN);
            plan.admit_keep(&before, BOB).unwrap();
            plan.admit_change(&before, ALICE, NEW).unwrap();
            let after = plan.build(&before).unwrap();

            assert_eq!(read_all(&after, NEW, 0, ALICE_SQL.len()), ALICE_SQL);
            assert_eq!(read_all(&after, BOB, 0, BOB_SQL.len()), BOB_SQL);
            // Accounts stay in their slots.
            assert_eq!(
                unlock_session(&after, DOMAIN, NEW)
                    .unwrap()
                    .session_index
                    .as_u8(),
                0
            );
            assert_eq!(
                unlock_session(&after, DOMAIN, BOB)
                    .unwrap()
                    .session_index
                    .as_u8(),
                2
            );
            assert_layout_copied_and_all_blocks_differ(&before, &after);
        });
    }

    #[test]
    fn refresh_without_any_password_change_rotates_everything() {
        run_with_stack(|| {
            let before = source();
            let mut plan = RekeyPlan::new(DOMAIN);
            plan.admit_keep(&before, ALICE).unwrap();
            plan.admit_keep(&before, BOB).unwrap();
            let after = plan.build(&before).unwrap();

            assert_eq!(read_all(&after, ALICE, 0, ALICE_SQL.len()), ALICE_SQL);
            assert_eq!(
                read_all(&after, ALICE, 1, ALICE_SESSION.len()),
                ALICE_SESSION
            );
            assert_eq!(read_all(&after, BOB, 0, BOB_SQL.len()), BOB_SQL);
            assert_layout_copied_and_all_blocks_differ(&before, &after);

            // The result can be rekeyed again and written to normally.
            let mut plan = RekeyPlan::new(DOMAIN);
            plan.admit_change(&after, BOB, NEW).unwrap();
            plan.admit_keep(&after, ALICE).unwrap();
            let mut third = plan.build(&after).unwrap();
            let bob = unlock_session(&third, DOMAIN, NEW).unwrap();
            let mut state = load_namespace_state(&third, DOMAIN, &bob, 0).unwrap();
            write_session_data(&mut third, DOMAIN, 0, &bob, &mut state, 0, b"BOB").unwrap();
            assert_eq!(&read_all(&third, NEW, 0, BOB_SQL.len())[..3], b"BOB");
            assert_eq!(read_all(&third, ALICE, 0, ALICE_SQL.len()), ALICE_SQL);
        });
    }

    #[test]
    fn accounts_may_take_over_a_password_another_account_gives_up() {
        run_with_stack(|| {
            let before = source();
            let mut plan = RekeyPlan::new(DOMAIN);
            plan.admit_change(&before, BOB, NEW).unwrap();
            plan.admit_change(&before, ALICE, BOB).unwrap();
            let after = plan.build(&before).unwrap();
            assert_eq!(read_all(&after, BOB, 0, ALICE_SQL.len()), ALICE_SQL);
            assert_eq!(read_all(&after, NEW, 0, BOB_SQL.len()), BOB_SQL);
        });
    }

    #[test]
    fn every_admission_failure_is_the_same_error() {
        run_with_stack(|| {
            let before = source();
            let invalid = |result: Result<()>| {
                assert!(matches!(result, Err(SecureStorageError::InvalidPassword)));
            };

            let mut plan = RekeyPlan::new(DOMAIN);
            invalid(plan.admit_keep(&before, b"wrong"));
            invalid(plan.admit_keep(&before, b""));
            invalid(plan.admit_change(&before, ALICE, b""));
            plan.admit_keep(&before, BOB).unwrap();
            // Same slot twice.
            invalid(plan.admit_keep(&before, BOB));
            invalid(plan.admit_change(&before, BOB, NEW));
            // New password already claimed by an admitted account.
            invalid(plan.admit_change(&before, ALICE, BOB));
            // The rejected admissions left the plan usable.
            plan.admit_change(&before, ALICE, NEW).unwrap();
            let after = plan.build(&before).unwrap();
            assert_eq!(read_all(&after, NEW, 0, ALICE_SQL.len()), ALICE_SQL);
            assert_eq!(read_all(&after, BOB, 0, BOB_SQL.len()), BOB_SQL);
        });
    }

    #[test]
    fn refuses_to_build_without_an_admitted_account() {
        run_with_stack(|| {
            let before = source();
            assert!(matches!(
                RekeyPlan::new(DOMAIN).build(&before),
                Err(SecureStorageError::InvalidPassword)
            ));
        });
    }
}
