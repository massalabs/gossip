//! Password-loaded outer-cryptography migration.
//!
//! Match state, source secrets, destination keypairs, and slot selection stay
//! inside Rust. Callers submit and receive complete fixed three-slot batches;
//! no bridge result identifies which slot a password unlocked.

use rand::RngCore;
use zeroize::Zeroizing;

use crate::block::{create_cover_block, decrypt_block, encrypt_block, rerandomize_block};
use crate::constants::{BLOCK_SIZE, LENGTH_HDR_SIZE, PLAINTEXT_SIZE, SESSION_COUNT};
use crate::domain;
use crate::error::{Result, SecureStorageError};
use crate::kdf::{derive_block_aead_key, derive_session_keys};
use crate::keypair::{CURRENT_SESSION_VERSION, KeypairFile};
use crate::pq::{PqPublicKey, PqSecretKey, pq_keygen};
use crate::storage::{KeypairStorage, MemoryStorage};
use crate::types::SessionIndex;
use crate::unlock::{UnlockedSession, unlock_session_unique};

const SUPPORTED_NAMESPACES: usize = 2;

struct LoadedSlot {
    source: UnlockedSession,
    wrap_key: Zeroizing<[u8; crypto_aead::KEY_SIZE]>,
}

/// Password-admission state. It emits no transformed records, so cleartext
/// nested versions and public keys cannot reveal intermediate matches.
pub struct OuterMigrationPlan {
    domain: String,
    source_keypairs: [Zeroizing<Vec<u8>>; SESSION_COUNT],
    loaded: [Option<LoadedSlot>; SESSION_COUNT],
}

impl OuterMigrationPlan {
    pub fn new(domain: &str, keypairs: [Vec<u8>; SESSION_COUNT]) -> Result<Self> {
        for keypair in &keypairs {
            KeypairFile::deserialize(keypair)?;
        }
        Ok(Self {
            domain: domain.to_owned(),
            source_keypairs: keypairs.map(Zeroizing::new),
            loaded: std::array::from_fn(|_| None),
        })
    }

    /// Admit one password with all-slot work. Duplicate slot admission and
    /// ambiguous duplicate-password envelopes use the same generic failure.
    pub fn admit_password(&mut self, password: &[u8]) -> Result<()> {
        let mut keypair_storage = MemoryStorage::new();
        for (slot, value) in self.source_keypairs.iter().enumerate() {
            keypair_storage.write_keypair(SessionIndex::new(slot as u8)?, value)?;
        }
        let session = unlock_session_unique(&keypair_storage, &self.domain, password)?;
        let slot = usize::from(session.session_index.as_u8());
        if self.loaded[slot].is_some() {
            return Err(SecureStorageError::InvalidPassword);
        }
        let keys = derive_session_keys(&self.domain, password);
        self.loaded[slot] = Some(LoadedSlot {
            source: session,
            wrap_key: keys.sk_wrap_key.clone(),
        });
        Ok(())
    }

    /// Seal match state and generate fresh current-suite keypairs for all
    /// destination slots. Selected and dummy public keys therefore change
    /// uniformly across the final snapshot.
    pub fn finalize(self) -> Result<OuterMigration> {
        let mut loaded = self.loaded;
        let mut destinations = Vec::with_capacity(SESSION_COUNT);
        let mut keypairs: [Zeroizing<Vec<u8>>; SESSION_COUNT] =
            std::array::from_fn(|_| Zeroizing::new(Vec::new()));

        for slot_index in 0..SESSION_COUNT {
            let slot = SessionIndex::new(slot_index as u8)?;
            let (destination_pk, destination_sk) = pq_keygen();
            let public_key_bytes = destination_pk.to_bytes();
            if let Some(source) = loaded[slot_index].take() {
                let wrap = crypto_aead::Key::from_ref(&source.wrap_key);
                let secret_bytes = destination_sk.to_bytes();
                let keypair = KeypairFile::build_current_wrapped(
                    &self.domain,
                    slot,
                    public_key_bytes,
                    &wrap,
                    &secret_bytes,
                )?;
                keypairs[slot_index] = Zeroizing::new(keypair.serialize());
                destinations.push(DestinationSlot {
                    public_key: destination_pk,
                    selected: Some(SelectedDestination {
                        source: source.source,
                    }),
                    required_blocks: [None, None],
                });
            } else {
                let dummy_wrap_key = crypto_aead::Key::from({
                    let mut key = Zeroizing::new([0_u8; crypto_aead::KEY_SIZE]);
                    rand::rngs::OsRng.fill_bytes(key.as_mut());
                    *key
                });
                let mut dummy_secret = Zeroizing::new(vec![0_u8; PqSecretKey::byte_size()]);
                rand::rngs::OsRng.fill_bytes(dummy_secret.as_mut());
                let keypair = KeypairFile::build_current_wrapped(
                    &self.domain,
                    slot,
                    public_key_bytes,
                    &dummy_wrap_key,
                    &dummy_secret,
                )?;
                keypairs[slot_index] = Zeroizing::new(keypair.serialize());
                destinations.push(DestinationSlot {
                    public_key: destination_pk,
                    selected: None,
                    required_blocks: [Some(0), Some(0)],
                });
                drop(destination_sk);
            }
        }

        let destinations: [DestinationSlot; SESSION_COUNT] = destinations
            .try_into()
            .map_err(|_| SecureStorageError::CorruptedBlock)?;
        Ok(OuterMigration {
            domain: self.domain,
            keypairs,
            destinations,
            next_block: [0, 0],
        })
    }
}

struct SelectedDestination {
    source: UnlockedSession,
}

struct DestinationSlot {
    public_key: PqPublicKey,
    selected: Option<SelectedDestination>,
    required_blocks: [Option<u64>; SUPPORTED_NAMESPACES],
}

/// Final one-pass transformer. All methods consume or return complete slot
/// batches and never expose match state.
pub struct OuterMigration {
    domain: String,
    keypairs: [Zeroizing<Vec<u8>>; SESSION_COUNT],
    destinations: [DestinationSlot; SESSION_COUNT],
    next_block: [u64; SUPPORTED_NAMESPACES],
}

impl OuterMigration {
    #[must_use]
    pub fn keypairs(&self) -> [&[u8]; SESSION_COUNT] {
        std::array::from_fn(|slot| self.keypairs[slot].as_slice())
    }

    /// Transform one canonical `(namespace, block index)` three-slot batch.
    /// Every output is freshly encrypted and then explicitly rerandomized.
    pub fn migrate_block_batch(
        &mut self,
        namespace: u8,
        block_index: u64,
        source_blocks: [&[u8; BLOCK_SIZE]; SESSION_COUNT],
    ) -> Result<[Zeroizing<Vec<u8>>; SESSION_COUNT]> {
        let namespace_index = usize::from(namespace);
        if namespace_index >= SUPPORTED_NAMESPACES
            || self.next_block[namespace_index] != block_index
        {
            return Err(SecureStorageError::CorruptedBlock);
        }

        let mut outputs: [Zeroizing<Vec<u8>>; SESSION_COUNT] =
            std::array::from_fn(|_| Zeroizing::new(Vec::new()));
        for slot_index in 0..SESSION_COUNT {
            let slot = SessionIndex::new(slot_index as u8)?;
            let destination = &mut self.destinations[slot_index];
            let plaintext = if let Some(selected) = destination.selected.as_ref() {
                let plaintext = if block_index == 0 {
                    match decrypt_source_block(
                        &self.domain,
                        namespace,
                        block_index,
                        &selected.source,
                        source_blocks[slot_index],
                    ) {
                        Ok(plaintext) => {
                            let total = u64::from_be_bytes(
                                plaintext[..LENGTH_HDR_SIZE]
                                    .try_into()
                                    .map_err(|_| SecureStorageError::CorruptedBlock)?,
                            );
                            let required = required_block_count(total)?;
                            destination.required_blocks[namespace_index] = Some(required);
                            Some(plaintext)
                        }
                        Err(_) if namespace != crate::DEFAULT_NAMESPACE => {
                            destination.required_blocks[namespace_index] = Some(0);
                            None
                        }
                        Err(error) => return Err(error),
                    }
                } else {
                    let required = destination.required_blocks[namespace_index]
                        .ok_or(SecureStorageError::CorruptedBlock)?;
                    if block_index < required {
                        Some(decrypt_source_block(
                            &self.domain,
                            namespace,
                            block_index,
                            &selected.source,
                            source_blocks[slot_index],
                        )?)
                    } else {
                        None
                    }
                };
                plaintext
            } else {
                None
            };

            let mut aad_root = String::new();
            domain::block_scope(
                &mut aad_root,
                &self.domain,
                CURRENT_SESSION_VERSION,
                slot,
                namespace,
                block_index,
            );
            let encrypted = if let Some(plaintext) = plaintext {
                let selected = destination
                    .selected
                    .as_ref()
                    .ok_or(SecureStorageError::CorruptedBlock)?;
                let (aead_key, aad_root) = derive_block_aead_key(
                    &self.domain,
                    CURRENT_SESSION_VERSION,
                    slot,
                    namespace,
                    selected.source.root_aead_key.as_ref(),
                    block_index,
                );
                encrypt_block(&destination.public_key, &aead_key, &aad_root, &plaintext)
            } else {
                create_cover_block(&destination.public_key, &aad_root)
            };
            let encrypted: &[u8; BLOCK_SIZE] = encrypted
                .as_slice()
                .try_into()
                .map_err(|_| SecureStorageError::CorruptedBlock)?;
            outputs[slot_index] =
                Zeroizing::new(rerandomize_block(&destination.public_key, encrypted)?);
        }
        self.next_block[namespace_index] = block_index
            .checked_add(1)
            .ok_or(SecureStorageError::Overflow)?;
        Ok(outputs)
    }

    /// Verify that every authenticated logical range fit inside the complete
    /// source coordinate set before a destination can be sealed.
    pub fn finish_namespace(&mut self, namespace: u8, source_block_count: u64) -> Result<()> {
        let namespace_index = usize::from(namespace);
        if namespace_index >= SUPPORTED_NAMESPACES
            || self.next_block[namespace_index] != source_block_count
        {
            return Err(SecureStorageError::CorruptedBlock);
        }
        for destination in &mut self.destinations {
            if source_block_count == 0 && namespace != crate::DEFAULT_NAMESPACE {
                destination.required_blocks[namespace_index].get_or_insert(0);
            }
            let required = destination.required_blocks[namespace_index]
                .ok_or(SecureStorageError::CorruptedBlock)?;
            if required > source_block_count {
                return Err(SecureStorageError::CorruptedBlock);
            }
        }
        Ok(())
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
    use crate::block::rerandomize_block;
    use crate::kdf::derive_session_keys;
    use crate::keypair::{LEGACY_SESSION_VERSION, read_session_keypair};
    use crate::pq::pq_keygen;
    use crate::read::read_session_data;
    use crate::run_with_stack;
    use crate::storage::{BlockStorage, KeypairStorage, MemoryStorage};
    use crate::unlock::{NamespaceState, unlock_session};
    use crate::write::write_session_data;

    const DOMAIN: &str = "migration-test";
    const PASSWORD: &[u8] = b"selected-password";
    const OMITTED_PASSWORD: &[u8] = b"omitted-hidden-password";

    fn legacy_source() -> (MemoryStorage, [Vec<u8>; SESSION_COUNT]) {
        let mut storage = MemoryStorage::new();
        crate::lifecycle::provision_storage_for_domain(&mut storage, DOMAIN).unwrap();
        let slot = SessionIndex::new(1).unwrap();
        let (pk, sk) = pq_keygen();
        let keys = derive_session_keys(DOMAIN, PASSWORD);
        let aad = crate::domain::sk_wrap_aad(DOMAIN, LEGACY_SESSION_VERSION, slot);
        let keypair = KeypairFile::build_wrapped(
            LEGACY_SESSION_VERSION,
            pk.to_bytes(),
            &crypto_aead::Key::from_ref(&keys.sk_wrap_key),
            &sk.to_bytes(),
            aad.as_bytes(),
        );
        storage.write_keypair(slot, &keypair.serialize()).unwrap();
        let session = UnlockedSession {
            session_index: slot,
            session_version: LEGACY_SESSION_VERSION,
            pq_rerand_pk: pk,
            pq_rerand_sk: sk,
            root_aead_key: keys.root_aead_key.clone(),
        };
        for (namespace, value) in [(0, b"sqlite-v0".as_slice()), (1, b"session-v0".as_slice())] {
            let mut state = NamespaceState::empty();
            write_session_data(
                &mut storage,
                DOMAIN,
                namespace,
                &session,
                &mut state,
                0,
                value,
            )
            .unwrap();
        }
        let omitted_slot = SessionIndex::new(2).unwrap();
        let omitted =
            crate::allocate_session(&mut storage, DOMAIN, omitted_slot, OMITTED_PASSWORD).unwrap();
        let mut omitted_state = NamespaceState::empty();
        write_session_data(
            &mut storage,
            DOMAIN,
            0,
            &omitted,
            &mut omitted_state,
            0,
            b"must-be-discarded",
        )
        .unwrap();

        let keypairs = std::array::from_fn(|index| {
            storage
                .read_keypair(SessionIndex::new(index as u8).unwrap())
                .unwrap()
                .to_vec()
        });
        (storage, keypairs)
    }

    #[test]
    fn migrates_selected_legacy_data_and_rotates_every_slot() {
        run_with_stack(|| {
            let (source, source_keypairs) = legacy_source();
            let source_public_keys = source_keypairs
                .each_ref()
                .map(|bytes| KeypairFile::deserialize(bytes).unwrap().pq_pk);
            let mut plan = OuterMigrationPlan::new(DOMAIN, source_keypairs).unwrap();
            assert!(plan.admit_password(b"wrong").is_err());
            plan.admit_password(PASSWORD).unwrap();
            assert!(plan.admit_password(PASSWORD).is_err());
            let mut migration = plan.finalize().unwrap();
            let mut destination = MemoryStorage::new();
            for (index, keypair) in migration.keypairs().into_iter().enumerate() {
                let parsed = KeypairFile::deserialize(keypair).unwrap();
                assert_eq!(parsed.version, CURRENT_SESSION_VERSION);
                assert_ne!(parsed.pq_pk, source_public_keys[index]);
                destination
                    .write_keypair(SessionIndex::new(index as u8).unwrap(), keypair)
                    .unwrap();
            }

            for namespace in [0_u8, 1] {
                let count = source
                    .block_count(SessionIndex::new(0).unwrap(), namespace)
                    .unwrap();
                for block_index in 0..count {
                    let source_batch = std::array::from_fn(|index| {
                        source
                            .read_block(
                                SessionIndex::new(index as u8).unwrap(),
                                namespace,
                                block_index,
                            )
                            .unwrap()
                    });
                    let source_refs = source_batch.each_ref().map(Box::as_ref);
                    let migrated = migration
                        .migrate_block_batch(namespace, block_index, source_refs)
                        .unwrap();
                    for index in 0..SESSION_COUNT {
                        assert_ne!(migrated[index].as_slice(), source_batch[index].as_slice());
                        destination
                            .append_block(
                                SessionIndex::new(index as u8).unwrap(),
                                namespace,
                                migrated[index].as_slice().try_into().unwrap(),
                            )
                            .unwrap();
                    }
                }
                migration.finish_namespace(namespace, count).unwrap();
            }

            let selected = unlock_session(&destination, DOMAIN, PASSWORD).unwrap();
            assert_eq!(selected.session_version, CURRENT_SESSION_VERSION);
            for (namespace, expected) in
                [(0, b"sqlite-v0".as_slice()), (1, b"session-v0".as_slice())]
            {
                let state =
                    crate::unlock::load_namespace_state(&destination, DOMAIN, &selected, namespace)
                        .unwrap();
                let value = read_session_data(
                    &destination,
                    DOMAIN,
                    namespace,
                    &selected,
                    &state,
                    0,
                    expected.len(),
                )
                .unwrap();
                assert_eq!(value.as_slice(), expected);
            }
            assert!(unlock_session(&destination, DOMAIN, b"wrong").is_err());
            assert!(unlock_session(&destination, DOMAIN, OMITTED_PASSWORD).is_err());

            // A second public-only rerandomization still preserves selected data.
            let block = destination
                .read_block(SessionIndex::new(1).unwrap(), 0, 0)
                .unwrap();
            let pk = read_session_keypair(&destination, SessionIndex::new(1).unwrap())
                .and_then(|keypair| PqPublicKey::from_bytes(&keypair.pq_pk))
                .unwrap();
            assert_ne!(rerandomize_block(&pk, &block).unwrap(), block.to_vec());
        });
    }

    fn migrate_without_admission(
        source: &MemoryStorage,
        keypairs: &[Vec<u8>; SESSION_COUNT],
    ) -> MemoryStorage {
        let plan = OuterMigrationPlan::new(DOMAIN, keypairs.clone()).unwrap();
        let mut migration = plan.finalize().unwrap();
        let mut destination = MemoryStorage::new();
        for (index, keypair) in migration.keypairs().into_iter().enumerate() {
            let parsed = KeypairFile::deserialize(keypair).unwrap();
            assert_eq!(parsed.version, CURRENT_SESSION_VERSION);
            destination
                .write_keypair(SessionIndex::new(index as u8).unwrap(), keypair)
                .unwrap();
        }
        for namespace in [0_u8, 1] {
            let count = source
                .block_count(SessionIndex::new(0).unwrap(), namespace)
                .unwrap();
            for block_index in 0..count {
                let source_batch = std::array::from_fn(|index| {
                    source
                        .read_block(
                            SessionIndex::new(index as u8).unwrap(),
                            namespace,
                            block_index,
                        )
                        .unwrap()
                });
                let migrated = migration
                    .migrate_block_batch(
                        namespace,
                        block_index,
                        source_batch.each_ref().map(Box::as_ref),
                    )
                    .unwrap();
                for index in 0..SESSION_COUNT {
                    assert_ne!(migrated[index].as_slice(), source_batch[index].as_slice());
                    destination
                        .append_block(
                            SessionIndex::new(index as u8).unwrap(),
                            namespace,
                            migrated[index].as_slice().try_into().unwrap(),
                        )
                        .unwrap();
                }
            }
            migration.finish_namespace(namespace, count).unwrap();
        }
        destination
    }

    #[test]
    fn replaces_every_unadmitted_slot_with_fresh_current_cover() {
        run_with_stack(|| {
            let (mut source, keypairs) = legacy_source();
            // Canonical PQ cover with invalid account AEAD proves omitted
            // payloads are never decrypted after archive validation.
            let slot = SessionIndex::new(1).unwrap();
            let keypair = read_session_keypair(&source, slot).unwrap();
            let public = PqPublicKey::from_bytes(&keypair.pq_pk).unwrap();
            let mut aad_root = String::new();
            crate::domain::block_scope(&mut aad_root, DOMAIN, LEGACY_SESSION_VERSION, slot, 0, 0);
            let cover = create_cover_block(&public, &aad_root);
            source
                .write_block(slot, 0, 0, cover.as_slice().try_into().unwrap())
                .unwrap();

            let first = migrate_without_admission(&source, &keypairs);
            let second = migrate_without_admission(&source, &keypairs);
            for index in 0..SESSION_COUNT {
                let slot = SessionIndex::new(index as u8).unwrap();
                let source_keypair = source.read_keypair(slot).unwrap();
                let first_keypair = first.read_keypair(slot).unwrap();
                let second_keypair = second.read_keypair(slot).unwrap();
                assert_ne!(first_keypair.as_slice(), source_keypair.as_slice());
                assert_ne!(second_keypair.as_slice(), source_keypair.as_slice());
                assert_ne!(first_keypair.as_slice(), second_keypair.as_slice());
                for namespace in [0_u8, 1] {
                    let count = source.block_count(slot, namespace).unwrap();
                    assert_eq!(first.block_count(slot, namespace).unwrap(), count);
                    assert_eq!(second.block_count(slot, namespace).unwrap(), count);
                    for block_index in 0..count {
                        assert_ne!(
                            first.read_block(slot, namespace, block_index).unwrap(),
                            second.read_block(slot, namespace, block_index).unwrap()
                        );
                    }
                }
            }
            for password in [PASSWORD, OMITTED_PASSWORD] {
                assert!(unlock_session(&first, DOMAIN, password).is_err());
                assert!(unlock_session(&second, DOMAIN, password).is_err());
            }
        });
    }

    #[test]
    fn rejects_corruption_inside_authenticated_logical_range() {
        run_with_stack(|| {
            let (mut source, keypairs) = legacy_source();
            let mut plan = OuterMigrationPlan::new(DOMAIN, keypairs).unwrap();
            plan.admit_password(PASSWORD).unwrap();
            let mut migration = plan.finalize().unwrap();
            let selected = SessionIndex::new(1).unwrap();
            let keypair = read_session_keypair(&source, selected).unwrap();
            let pk = PqPublicKey::from_bytes(&keypair.pq_pk).unwrap();
            let mut aad_root = String::new();
            crate::domain::block_scope(
                &mut aad_root,
                DOMAIN,
                LEGACY_SESSION_VERSION,
                selected,
                0,
                0,
            );
            let corrupt = create_cover_block(&pk, &aad_root);
            source
                .write_block(selected, 0, 0, corrupt.as_slice().try_into().unwrap())
                .unwrap();
            // Canonical PQ bytes with invalid AEAD must fail for namespace 0.
            let batch = std::array::from_fn(|index| {
                source
                    .read_block(SessionIndex::new(index as u8).unwrap(), 0, 0)
                    .unwrap()
            });
            assert!(
                migration
                    .migrate_block_batch(0, 0, batch.each_ref().map(Box::as_ref))
                    .is_err()
            );
        });
    }
}
