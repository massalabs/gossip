//! Write path: encrypt blocks with snapshot resistance and assemble session data.

use rand::RngCore;
use rand::seq::SliceRandom;
use rayon::prelude::*;
use zeroize::Zeroizing;

use crate::BLOCK_SIZE;
use crate::block::{create_cover_block, encrypt_block, rerandomize_block};
use crate::constants::{LENGTH_HDR_SIZE, PLAINTEXT_SIZE, SESSION_COUNT};
use crate::domain;
use crate::error::{Result, SecureStorageError};
use crate::kdf::derive_block_aead_key;
use crate::keypair::read_session_version_and_pk;
use crate::pq::PqPublicKey;
use crate::read::decrypt_session_data_block;
use crate::storage::{BlockStorage, KeypairStorage};
use crate::types::SessionIndex;
use crate::unlock::{NamespaceState, UnlockedSession};

/// Per-session inputs collected before the parallel compute phase.
struct BlockPrep {
    index: SessionIndex,
    pk: PqPublicKey,
    aad_root: String,
    existing: Option<Box<[u8; BLOCK_SIZE]>>,
}

/// Encrypt and write a single block with snapshot resistance.
///
/// Writes the genuine ciphertext for the target session and
/// rerandomizes (or covers) the same `(namespace, block_index)` in all
/// other sessions, preserving plausible deniability across slots.
///
/// Three phases:
///   1. **Sequential read**: collect each session's pk + existing block.
///   2. **Parallel compute** (rayon `par_iter`): encrypt target,
///      rerandomize/cover others. On native (rayon 4 threads) all ops
///      run in parallel; on WASM (1 thread) they run sequentially —
///      same code, same correctness, different throughput.
///   3. **Sequential write** in randomized order for snapshot resistance.
pub fn encrypt_session_data_block<S: BlockStorage + KeypairStorage>(
    storage: &mut S,
    domain: &str,
    namespace: u8,
    session: &UnlockedSession,
    block_index: u64,
    plaintext: &[u8; PLAINTEXT_SIZE],
) -> Result<()> {
    if session.session_version != 0 {
        return Err(SecureStorageError::UnsupportedVersion(
            session.session_version,
        ));
    }

    let (aead_sk, aad_root) = derive_block_aead_key(
        domain,
        session.session_version,
        session.session_index,
        namespace,
        session.root_aead_key.as_ref(),
        block_index,
    );

    // Phase 1: sequential read — collect pk + existing block per session.
    let mut prep: Vec<BlockPrep> = (0..SESSION_COUNT as u8)
        .map(|i| {
            let idx = SessionIndex::new(i).expect("i in 0..SESSION_COUNT is always a valid SessionIndex");
            let (ver, pk_bytes) = read_session_version_and_pk(storage, idx)?;
            let pk = PqPublicKey::from_bytes(&pk_bytes)?;
            let mut aad = String::new();
            domain::block_scope(&mut aad, domain, ver, idx, namespace, block_index);
            let existing = if idx == session.session_index {
                None
            } else {
                storage.read_block(idx, namespace, block_index).ok()
            };
            Ok(BlockPrep {
                index: idx,
                pk,
                aad_root: aad,
                existing,
            })
        })
        .collect::<Result<_>>()?;

    // Randomize compute order: par_iter runs sequentially on WASM single-thread,
    // which would otherwise pin target's encrypt_block to a fixed position.
    prep.shuffle(&mut rand::rngs::OsRng);

    // Phase 2: parallel compute — all sessions at once.
    let computed: Vec<(SessionIndex, Vec<u8>)> = prep
        .par_iter()
        .map(|p| {
            let ct = if p.index == session.session_index {
                encrypt_block(&session.pq_rerand_pk, &aead_sk, &aad_root, plaintext)
            } else {
                match &p.existing {
                    Some(cur_ct) => rerandomize_block(&p.pk, cur_ct),
                    None => create_cover_block(&p.pk, &p.aad_root),
                }
            };
            (p.index, ct)
        })
        .collect();

    // Phase 3: sequential write in randomized order.
    let mut order: Vec<usize> = (0..computed.len()).collect();
    order.shuffle(&mut rand::rngs::OsRng);
    for i in order {
        let (cur, ref ct) = computed[i];
        let ct_arr: &[u8; BLOCK_SIZE] = ct
            .as_slice()
            .try_into()
            .map_err(|_| SecureStorageError::CorruptedBlock)?;
        storage.write_block(cur, namespace, block_index, ct_arr)?;
        storage.fsync(cur, namespace)?;
    }

    Ok(())
}

/// Returns the global block count (maximum across all sessions) for `namespace`.
pub fn get_global_block_count<S: BlockStorage>(storage: &S, namespace: u8) -> Result<u64> {
    let mut max_count = 0u64;
    for i in 0..SESSION_COUNT as u8 {
        let session =
            SessionIndex::new(i).expect(&format!("{i} >= SESSION_COUNT: {SESSION_COUNT}"));
        let count = storage.block_count(session, namespace)?;
        max_count = max_count.max(count);
    }
    Ok(max_count)
}

/// Repair blockstream length inconsistencies across sessions for a namespace.
///
/// Sessions shorter than the global maximum (in `namespace`) are padded with
/// cover blocks. Called before every extend and every cover_traffic_tick.
pub fn repair_blockstream_lengths<S: BlockStorage + KeypairStorage>(
    storage: &mut S,
    domain: &str,
    namespace: u8,
) -> Result<()> {
    let global_count = get_global_block_count(storage, namespace)?;
    let mut cur_aad_root = String::new();

    for i in 0..SESSION_COUNT as u8 {
        let session =
            SessionIndex::new(i).expect(&format!("{i} >= SESSION_COUNT: {SESSION_COUNT}"));
        let mut count = storage.block_count(session, namespace)?;

        while count < global_count {
            let (version, pk_bytes) = read_session_version_and_pk(storage, session)?;
            let pk = PqPublicKey::from_bytes(&pk_bytes)?;

            domain::block_scope(
                &mut cur_aad_root,
                domain,
                version,
                session,
                namespace,
                count,
            );
            let cover = create_cover_block(&pk, &cur_aad_root);
            let ct_arr: &[u8; BLOCK_SIZE] = cover
                .as_slice()
                .try_into()
                .map_err(|_| SecureStorageError::CorruptedBlock)?;
            storage.append_block(session, namespace, ct_arr)?;
            storage.fsync(session, namespace)?;
            count += 1;
        }
    }

    Ok(())
}

/// Ensure all sessions have at least `required_count` blocks in `namespace`.
pub fn ensure_block_count<S: BlockStorage + KeypairStorage>(
    storage: &mut S,
    domain: &str,
    namespace: u8,
    session: &UnlockedSession,
    ns_state: &NamespaceState,
    required_count: u64,
) -> Result<()> {
    repair_blockstream_lengths(storage, domain, namespace)?;
    while get_global_block_count(storage, namespace)? < required_count {
        extend_blockstream_with_session_block(storage, domain, namespace, session, ns_state)?;
    }
    Ok(())
}

/// Add one block to all sessions in `namespace`.
///
/// The target session gets a genuine block (random padding, with length
/// header if block 0). Other sessions get cover blocks.
fn extend_blockstream_with_session_block<S: BlockStorage + KeypairStorage>(
    storage: &mut S,
    domain: &str,
    namespace: u8,
    session: &UnlockedSession,
    ns_state: &NamespaceState,
) -> Result<()> {
    repair_blockstream_lengths(storage, domain, namespace)?;
    let block_index = get_global_block_count(storage, namespace)?;

    let mut indices: Vec<u8> = (0..SESSION_COUNT as u8).collect();
    indices.shuffle(&mut rand::rngs::OsRng);

    let mut cur_aad_root = String::new();
    for i in indices {
        let cur_session =
            SessionIndex::new(i).expect(&format!("{i} >= SESSION_COUNT: {SESSION_COUNT}"));
        // Read version/pk for ALL sessions (including target) for timing uniformity per spec §12.3
        let (cur_version, cur_pk_bytes) = read_session_version_and_pk(storage, cur_session)?;
        let cur_pk = PqPublicKey::from_bytes(&cur_pk_bytes)?;

        // Compute cur_aad_root unconditionally for timing uniformity per spec §12.3
        domain::block_scope(
            &mut cur_aad_root,
            domain,
            cur_version,
            cur_session,
            namespace,
            block_index,
        );

        if cur_session == session.session_index {
            // Genuine block content is random padding; header is set only for block 0.
            let mut pt = Zeroizing::new(vec![0u8; PLAINTEXT_SIZE]);
            rand::rngs::OsRng.fill_bytes(&mut pt[..]);
            if block_index == 0 {
                pt[..LENGTH_HDR_SIZE].copy_from_slice(&ns_state.total_data_length.to_be_bytes());
            }

            let (aead_sk, aad_root) = derive_block_aead_key(
                domain,
                session.session_version,
                cur_session,
                namespace,
                session.root_aead_key.as_ref(),
                block_index,
            );
            let pt_arr: &[u8; PLAINTEXT_SIZE] = pt
                .as_slice()
                .try_into()
                .expect(&format!("{} != PLAINTEXT_SIZE", pt.len()));
            let ct = encrypt_block(&session.pq_rerand_pk, &aead_sk, &aad_root, pt_arr);
            let ct_arr: &[u8; BLOCK_SIZE] = ct
                .as_slice()
                .try_into()
                .map_err(|_| SecureStorageError::CorruptedBlock)?;
            storage.append_block(cur_session, namespace, ct_arr)?;
        } else {
            let cover = create_cover_block(&cur_pk, &cur_aad_root);
            let ct_arr: &[u8; BLOCK_SIZE] = cover
                .as_slice()
                .try_into()
                .map_err(|_| SecureStorageError::CorruptedBlock)?;
            storage.append_block(cur_session, namespace, ct_arr)?;
        }
        storage.fsync(cur_session, namespace)?;
    }

    Ok(())
}

/// Write session data at an offset, analogous to `pwrite(fd, buf, count, offset)`.
///
/// Handles multi-block writes, partial overwrites, full overwrite optimization,
/// and length header updates in block 0. Updates `ns_state.total_data_length`
/// in place if the write extends past the previous end of the namespace.
pub fn write_session_data<S: BlockStorage + KeypairStorage>(
    storage: &mut S,
    domain: &str,
    namespace: u8,
    session: &UnlockedSession,
    ns_state: &mut NamespaceState,
    offset: u64,
    data: &[u8],
) -> Result<()> {
    if session.session_version != 0 {
        return Err(SecureStorageError::UnsupportedVersion(
            session.session_version,
        ));
    }
    if data.is_empty() {
        return Ok(());
    }

    let data_len = data.len() as u64;
    let old_total = ns_state.total_data_length;
    let new_total = old_total.max(
        offset
            .checked_add(data_len)
            .ok_or(SecureStorageError::Overflow)?,
    );
    ns_state.total_data_length = new_total;

    // Ensure enough blocks exist
    let ps = PLAINTEXT_SIZE as u64;
    let hdr = LENGTH_HDR_SIZE as u64;
    let required_last_block = if new_total == 0 {
        0
    } else {
        hdr.checked_add(new_total - 1)
            .ok_or(SecureStorageError::Overflow)?
            / ps
    };
    ensure_block_count(
        storage,
        domain,
        namespace,
        session,
        ns_state,
        required_last_block + 1,
    )?;

    // Map logical data offset to virtual plaintext stream position
    let start_pos = hdr
        .checked_add(offset)
        .ok_or(SecureStorageError::Overflow)?;
    let end_pos_excl = start_pos
        .checked_add(data_len)
        .ok_or(SecureStorageError::Overflow)?;

    let first_block = start_pos / ps;
    let last_block = end_pos_excl
        .checked_sub(1)
        .ok_or(SecureStorageError::Overflow)?
        / ps;

    for b in first_block..=last_block {
        let block_start_pos = b * ps;
        let block_end_pos = block_start_pos + ps;

        let w_start = start_pos.max(block_start_pos);
        let w_end = end_pos_excl.min(block_end_pos);
        assert!(w_start < w_end);

        // Full overwrite optimization: skip decrypt for non-block-0 fully overwritten blocks
        let full_overwrite = w_start == block_start_pos && w_end == block_end_pos && b != 0;

        let mut pt = Zeroizing::new(vec![0u8; PLAINTEXT_SIZE]);
        if full_overwrite {
            rand::rngs::OsRng.fill_bytes(&mut pt[..]);
        } else {
            match decrypt_session_data_block(storage, domain, namespace, session, b) {
                Ok(existing) => pt.copy_from_slice(existing.as_ref()),
                Err(_) => rand::rngs::OsRng.fill_bytes(&mut pt[..]),
            }
        }

        // Copy data into the plaintext
        let src_off = (w_start - start_pos) as usize;
        let src_len = (w_end - w_start) as usize;
        let dst_off = (w_start - block_start_pos) as usize;
        pt[dst_off..dst_off + src_len].copy_from_slice(&data[src_off..src_off + src_len]);

        // Block 0 always carries the length header
        if b == 0 {
            pt[..LENGTH_HDR_SIZE].copy_from_slice(&new_total.to_be_bytes());
        }

        let pt_arr: &[u8; PLAINTEXT_SIZE] = pt
            .as_slice()
            .try_into()
            .expect(&format!("{} != PLAINTEXT_SIZE", pt.len()));
        encrypt_session_data_block(storage, domain, namespace, session, b, pt_arr)?;
    }

    Ok(())
}

/// Shrink namespace data to `new_total` bytes, converting freed blocks to cover.
///
/// The global blockstream length never decreases. Freed blocks become
/// cover blocks indistinguishable from blocks allocated by other sessions.
/// All touched block indices are updated across ALL sessions in randomized
/// order (snapshot resistance). Updates `ns_state.total_data_length` in place.
pub fn shrink_session_data<S: BlockStorage + KeypairStorage>(
    storage: &mut S,
    domain: &str,
    namespace: u8,
    session: &UnlockedSession,
    ns_state: &mut NamespaceState,
    new_total: u64,
) -> Result<()> {
    if session.session_version != 0 {
        return Err(SecureStorageError::UnsupportedVersion(
            session.session_version,
        ));
    }

    let old_total = ns_state.total_data_length;
    if new_total >= old_total {
        return Ok(());
    }

    ns_state.total_data_length = new_total;

    let ps = PLAINTEXT_SIZE as u64;
    let hdr = LENGTH_HDR_SIZE as u64;

    // Determine old and new last block indices
    let old_last_block = if old_total == 0 {
        0
    } else {
        hdr.checked_add(old_total - 1)
            .ok_or(SecureStorageError::Overflow)?
            / ps
    };
    let new_last_block = if new_total == 0 {
        0
    } else {
        hdr.checked_add(new_total - 1)
            .ok_or(SecureStorageError::Overflow)?
            / ps
    };

    // --- Step 1: Re-encrypt the new last block with updated content ---
    let mut pt = Zeroizing::new(vec![0u8; PLAINTEXT_SIZE]);
    match decrypt_session_data_block(storage, domain, namespace, session, new_last_block) {
        Ok(existing) => pt.copy_from_slice(existing.as_ref()),
        Err(_) => rand::rngs::OsRng.fill_bytes(&mut pt[..]),
    }

    // Update length header if this is block 0
    if new_last_block == 0 {
        pt[..LENGTH_HDR_SIZE].copy_from_slice(&new_total.to_be_bytes());
    }

    // Randomize the unused tail of this block
    let new_data_end_pos = hdr
        .checked_add(new_total)
        .ok_or(SecureStorageError::Overflow)?;
    let block_start_pos = new_last_block
        .checked_mul(ps)
        .ok_or(SecureStorageError::Overflow)?;
    let tail_start = new_data_end_pos
        .checked_sub(block_start_pos)
        .ok_or(SecureStorageError::Overflow)?;
    if tail_start < ps {
        let tail_start_usize =
            usize::try_from(tail_start).map_err(|_| SecureStorageError::Overflow)?;
        rand::rngs::OsRng.fill_bytes(&mut pt[tail_start_usize..]);
    }

    let pt_arr: &[u8; PLAINTEXT_SIZE] = pt
        .as_slice()
        .try_into()
        .expect(&format!("{} != PLAINTEXT_SIZE", pt.len()));
    encrypt_session_data_block(storage, domain, namespace, session, new_last_block, pt_arr)?;

    // If block 0 was not the new last block, also update block 0's length header
    if new_last_block != 0 {
        let mut pt0 = Zeroizing::new(vec![0u8; PLAINTEXT_SIZE]);
        match decrypt_session_data_block(storage, domain, namespace, session, 0) {
            Ok(existing) => pt0.copy_from_slice(existing.as_ref()),
            Err(_) => rand::rngs::OsRng.fill_bytes(&mut pt0[..]),
        }
        pt0[..LENGTH_HDR_SIZE].copy_from_slice(&new_total.to_be_bytes());
        let pt0_arr: &[u8; PLAINTEXT_SIZE] = pt0
            .as_slice()
            .try_into()
            .expect(&format!("{} != PLAINTEXT_SIZE", pt0.len()));
        encrypt_session_data_block(storage, domain, namespace, session, 0, pt0_arr)?;
    }

    // --- Step 2: Convert fully freed blocks into cover blocks ---
    let mut cur_aad_root = String::new();
    for b in (new_last_block + 1)..=old_last_block {
        let mut indices: Vec<u8> = (0..SESSION_COUNT as u8).collect();
        indices.shuffle(&mut rand::rngs::OsRng);

        for i in indices {
            let cur_session =
                SessionIndex::new(i).expect(&format!("{i} >= SESSION_COUNT: {SESSION_COUNT}"));
            let (cur_version, cur_pk_bytes) = read_session_version_and_pk(storage, cur_session)?;
            let cur_pk = PqPublicKey::from_bytes(&cur_pk_bytes)?;

            // Compute cur_aad_root unconditionally for timing uniformity per spec §14.3
            domain::block_scope(
                &mut cur_aad_root,
                domain,
                cur_version,
                cur_session,
                namespace,
                b,
            );

            let new_ct = if cur_session == session.session_index {
                create_cover_block(&cur_pk, &cur_aad_root)
            } else {
                match storage.read_block(cur_session, namespace, b) {
                    Ok(cur_ct) => rerandomize_block(&cur_pk, &cur_ct),
                    Err(_) => create_cover_block(&cur_pk, &cur_aad_root),
                }
            };
            let ct_arr: &[u8; BLOCK_SIZE] = new_ct
                .as_slice()
                .try_into()
                .map_err(|_| SecureStorageError::CorruptedBlock)?;
            storage.write_block(cur_session, namespace, b, ct_arr)?;
            storage.fsync(cur_session, namespace)?;
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::DEFAULT_NAMESPACE;
    use crate::keypair::KeypairFile;
    use crate::pq::{PqPublicKey, PqSecretKey, pq_keygen};
    use crate::read::read_session_data;
    use crate::run_with_stack;
    use crate::storage::MemoryStorage;

    const DOMAIN: &str = "test";
    const NS: u8 = DEFAULT_NAMESPACE;

    /// Provision all session slots with keypair files.
    /// Returns an unlocked session for slot 0 and a fresh empty namespace state.
    fn provision_all_sessions(
        storage: &mut MemoryStorage,
    ) -> (
        UnlockedSession,
        NamespaceState,
        Vec<(PqPublicKey, PqSecretKey)>,
    ) {
        let mut all_keys = Vec::new();
        for i in 0..SESSION_COUNT as u8 {
            let (pk, sk) = pq_keygen();
            let session = SessionIndex::new(i).unwrap();

            let aad = domain::sk_wrap_aad(DOMAIN, 0, session);
            let wrap_key = crypto_aead::Key::from([0xBB; crypto_aead::KEY_SIZE]);

            let kf = KeypairFile::build_wrapped(
                0,
                pk.to_bytes(),
                &wrap_key,
                &sk.to_bytes(),
                aad.as_bytes(),
            );
            storage.write_keypair(session, &kf.serialize()).unwrap();
            all_keys.push((pk, sk));
        }

        let root_aead_key = Zeroizing::new([0xAA; crypto_aead::KEY_SIZE]);
        let (ref pk, ref sk) = all_keys[0];
        let session = UnlockedSession {
            session_index: SessionIndex::new(0).unwrap(),
            session_version: 0,
            pq_rerand_pk: PqPublicKey::from_bytes(&pk.to_bytes()).unwrap(),
            pq_rerand_sk: PqSecretKey::from_bytes(&sk.to_bytes()).unwrap(),
            root_aead_key,
        };

        (session, NamespaceState::empty(), all_keys)
    }

    // --- commit 12: encrypt_session_data_block ---

    #[test]
    fn write_then_read_block() {
        run_with_stack(|| {
            let mut storage = MemoryStorage::new();
            let (session, ns_state, _) = provision_all_sessions(&mut storage);

            // All sessions need at least 1 block
            ensure_block_count(&mut storage, DOMAIN, NS, &session, &ns_state, 1).unwrap();

            let mut pt = [0u8; PLAINTEXT_SIZE];
            pt[0] = 0x42;
            pt[PLAINTEXT_SIZE - 1] = 0xFF;
            encrypt_session_data_block(&mut storage, DOMAIN, NS, &session, 0, &pt).unwrap();

            let decrypted =
                crate::read::decrypt_session_data_block(&storage, DOMAIN, NS, &session, 0).unwrap();
            assert_eq!(*decrypted, pt);
        });
    }

    #[test]
    fn all_sessions_updated() {
        run_with_stack(|| {
            let mut storage = MemoryStorage::new();
            let (session, ns_state, _) = provision_all_sessions(&mut storage);

            ensure_block_count(&mut storage, DOMAIN, NS, &session, &ns_state, 1).unwrap();

            let pt = [0u8; PLAINTEXT_SIZE];
            encrypt_session_data_block(&mut storage, DOMAIN, NS, &session, 0, &pt).unwrap();

            // All sessions should have at least 1 block in the namespace
            for i in 0..SESSION_COUNT as u8 {
                let s = SessionIndex::new(i).unwrap();
                assert!(storage.block_count(s, NS).unwrap() >= 1);
            }
        });
    }

    #[test]
    fn other_sessions_rerandomized() {
        run_with_stack(|| {
            let mut storage = MemoryStorage::new();
            let (session, ns_state, _) = provision_all_sessions(&mut storage);

            // First ensure blocks exist (this creates initial cover blocks for all sessions)
            ensure_block_count(&mut storage, DOMAIN, NS, &session, &ns_state, 1).unwrap();

            // Read original ciphertexts for non-target sessions
            let mut original_cts = Vec::new();
            for i in 1..SESSION_COUNT as u8 {
                let s = SessionIndex::new(i).unwrap();
                original_cts.push(storage.read_block(s, NS, 0).unwrap());
            }

            // Write a block to session 0.
            let pt = [0x42; PLAINTEXT_SIZE];
            encrypt_session_data_block(&mut storage, DOMAIN, NS, &session, 0, &pt).unwrap();

            // Non-target sessions should have different ciphertexts (rerandomized)
            for (idx, i) in (1..SESSION_COUNT as u8).enumerate() {
                let s = SessionIndex::new(i).unwrap();
                let new_ct = storage.read_block(s, NS, 0).unwrap();
                assert_ne!(
                    *new_ct, *original_cts[idx],
                    "session {i} was not rerandomized"
                );
            }
        });
    }

    // --- commit 13: blockstream extension and repair ---

    #[test]
    fn repair_aligns_lengths() {
        run_with_stack(|| {
            let mut storage = MemoryStorage::new();
            let (session, ns_state, _) = provision_all_sessions(&mut storage);

            // Manually create uneven block counts
            ensure_block_count(&mut storage, DOMAIN, NS, &session, &ns_state, 3).unwrap();

            // Manually append extra blocks to session 1
            let s1 = SessionIndex::new(1).unwrap();
            let (_, pk_bytes) = read_session_version_and_pk(&storage, s1).unwrap();
            let pk = PqPublicKey::from_bytes(&pk_bytes).unwrap();
            let cover = create_cover_block(&pk, "dummy");
            let ct_arr: &[u8; BLOCK_SIZE] = cover.as_slice().try_into().unwrap();
            storage.append_block(s1, NS, ct_arr).unwrap();
            storage.append_block(s1, NS, ct_arr).unwrap();

            // Session 1 now has 5, others have 3
            assert_eq!(storage.block_count(s1, NS).unwrap(), 5);

            repair_blockstream_lengths(&mut storage, DOMAIN, NS).unwrap();

            // All sessions should now have 5 blocks
            for i in 0..SESSION_COUNT as u8 {
                let s = SessionIndex::new(i).unwrap();
                assert_eq!(storage.block_count(s, NS).unwrap(), 5);
            }
        });
    }

    #[test]
    fn extend_adds_to_all() {
        run_with_stack(|| {
            let mut storage = MemoryStorage::new();
            let (session, ns_state, _) = provision_all_sessions(&mut storage);

            ensure_block_count(&mut storage, DOMAIN, NS, &session, &ns_state, 1).unwrap();

            for i in 0..SESSION_COUNT as u8 {
                let s = SessionIndex::new(i).unwrap();
                assert_eq!(storage.block_count(s, NS).unwrap(), 1);
            }
        });
    }

    #[test]
    fn ensure_idempotent() {
        run_with_stack(|| {
            let mut storage = MemoryStorage::new();
            let (session, ns_state, _) = provision_all_sessions(&mut storage);

            ensure_block_count(&mut storage, DOMAIN, NS, &session, &ns_state, 3).unwrap();
            let count_before = get_global_block_count(&storage, NS).unwrap();

            ensure_block_count(&mut storage, DOMAIN, NS, &session, &ns_state, 3).unwrap();
            let count_after = get_global_block_count(&storage, NS).unwrap();

            assert_eq!(count_before, count_after);
        });
    }

    // --- commit 14: write_session_data ---

    #[test]
    fn write_then_read_roundtrip() {
        run_with_stack(|| {
            let mut storage = MemoryStorage::new();
            let (session, mut ns_state, _) = provision_all_sessions(&mut storage);

            let data = b"hello, secureStorage!";
            write_session_data(&mut storage, DOMAIN, NS, &session, &mut ns_state, 0, data).unwrap();

            let result =
                read_session_data(&storage, DOMAIN, NS, &session, &ns_state, 0, data.len())
                    .unwrap();
            assert_eq!(&*result, data);
        });
    }

    #[test]
    fn write_extends_storage() {
        run_with_stack(|| {
            let mut storage = MemoryStorage::new();
            let (session, mut ns_state, _) = provision_all_sessions(&mut storage);

            assert_eq!(get_global_block_count(&storage, NS).unwrap(), 0);

            let data = vec![0xAB; 100];
            write_session_data(&mut storage, DOMAIN, NS, &session, &mut ns_state, 0, &data)
                .unwrap();

            assert!(get_global_block_count(&storage, NS).unwrap() >= 1);
        });
    }

    #[test]
    fn write_updates_total_length() {
        run_with_stack(|| {
            let mut storage = MemoryStorage::new();
            let (session, mut ns_state, _) = provision_all_sessions(&mut storage);

            let data = vec![0; 200];
            write_session_data(&mut storage, DOMAIN, NS, &session, &mut ns_state, 0, &data)
                .unwrap();

            assert_eq!(ns_state.total_data_length, 200);
        });
    }

    #[test]
    fn partial_overwrite() {
        run_with_stack(|| {
            let mut storage = MemoryStorage::new();
            let (session, mut ns_state, _) = provision_all_sessions(&mut storage);

            // Write initial data
            let initial = vec![0xAA; 100];
            write_session_data(
                &mut storage,
                DOMAIN,
                NS,
                &session,
                &mut ns_state,
                0,
                &initial,
            )
            .unwrap();

            // Overwrite bytes 25..75
            let patch = vec![0xBB; 50];
            write_session_data(
                &mut storage,
                DOMAIN,
                NS,
                &session,
                &mut ns_state,
                25,
                &patch,
            )
            .unwrap();

            let result =
                read_session_data(&storage, DOMAIN, NS, &session, &ns_state, 0, 100).unwrap();
            assert_eq!(&result[..25], &[0xAA; 25]);
            assert_eq!(&result[25..75], &[0xBB; 50]);
            assert_eq!(&result[75..100], &[0xAA; 25]);
        });
    }

    #[test]
    fn write_block_0_preserves_header() {
        run_with_stack(|| {
            let mut storage = MemoryStorage::new();
            let (session, mut ns_state, _) = provision_all_sessions(&mut storage);

            let data = vec![0xCC; 50];
            write_session_data(&mut storage, DOMAIN, NS, &session, &mut ns_state, 0, &data)
                .unwrap();

            // Read total length from block 0 header
            let total = crate::read::read_total_length(
                &storage,
                DOMAIN,
                session.session_version,
                session.session_index,
                NS,
                &session.pq_rerand_sk,
                session.root_aead_key.as_ref(),
            )
            .unwrap();
            assert_eq!(total, 50);
        });
    }

    #[test]
    fn append_pattern() {
        run_with_stack(|| {
            let mut storage = MemoryStorage::new();
            let (session, mut ns_state, _) = provision_all_sessions(&mut storage);

            write_session_data(
                &mut storage,
                DOMAIN,
                NS,
                &session,
                &mut ns_state,
                0,
                b"hello",
            )
            .unwrap();
            write_session_data(
                &mut storage,
                DOMAIN,
                NS,
                &session,
                &mut ns_state,
                5,
                b" world",
            )
            .unwrap();

            let result =
                read_session_data(&storage, DOMAIN, NS, &session, &ns_state, 0, 11).unwrap();
            assert_eq!(&*result, b"hello world");
        });
    }

    #[test]
    fn write_cross_block() {
        run_with_stack(|| {
            let mut storage = MemoryStorage::new();
            let (session, mut ns_state, _) = provision_all_sessions(&mut storage);

            // Write data that spans multiple blocks
            let data_len = PLAINTEXT_SIZE * 2;
            let data: Vec<u8> = (0..data_len).map(|i| (i % 256) as u8).collect();
            write_session_data(&mut storage, DOMAIN, NS, &session, &mut ns_state, 0, &data)
                .unwrap();

            let result =
                read_session_data(&storage, DOMAIN, NS, &session, &ns_state, 0, data_len).unwrap();
            assert_eq!(&*result, &data);
        });
    }

    // --- Edge cases for required_last_block calculation (review comment #9) ---

    #[test]
    fn write_single_byte() {
        run_with_stack(|| {
            let mut storage = MemoryStorage::new();
            let (session, mut ns_state, _) = provision_all_sessions(&mut storage);

            // 1 byte of data: last byte at virtual pos LENGTH_HDR_SIZE + 0 -> block 0
            write_session_data(
                &mut storage,
                DOMAIN,
                NS,
                &session,
                &mut ns_state,
                0,
                &[0x42],
            )
            .unwrap();
            assert_eq!(ns_state.total_data_length, 1);
            assert_eq!(get_global_block_count(&storage, NS).unwrap(), 1);

            let result =
                read_session_data(&storage, DOMAIN, NS, &session, &ns_state, 0, 1).unwrap();
            assert_eq!(&*result, &[0x42]);
        });
    }

    #[test]
    fn write_fills_block_0_exactly() {
        run_with_stack(|| {
            let mut storage = MemoryStorage::new();
            let (session, mut ns_state, _) = provision_all_sessions(&mut storage);

            // Exactly fill block 0's data area (PLAINTEXT_SIZE - LENGTH_HDR_SIZE bytes)
            let max_b0 = PLAINTEXT_SIZE - LENGTH_HDR_SIZE;
            let data = vec![0xAA; max_b0];
            write_session_data(&mut storage, DOMAIN, NS, &session, &mut ns_state, 0, &data)
                .unwrap();

            assert_eq!(ns_state.total_data_length, max_b0 as u64);
            assert_eq!(get_global_block_count(&storage, NS).unwrap(), 1);

            let result =
                read_session_data(&storage, DOMAIN, NS, &session, &ns_state, 0, max_b0).unwrap();
            assert_eq!(&*result, &data);
        });
    }

    #[test]
    fn write_one_byte_spills_to_block_1() {
        run_with_stack(|| {
            let mut storage = MemoryStorage::new();
            let (session, mut ns_state, _) = provision_all_sessions(&mut storage);

            // One byte past block 0's data area -> must allocate block 1
            let spill = PLAINTEXT_SIZE - LENGTH_HDR_SIZE + 1;
            let data = vec![0xBB; spill];
            write_session_data(&mut storage, DOMAIN, NS, &session, &mut ns_state, 0, &data)
                .unwrap();

            assert_eq!(ns_state.total_data_length, spill as u64);
            assert_eq!(get_global_block_count(&storage, NS).unwrap(), 2);

            let result =
                read_session_data(&storage, DOMAIN, NS, &session, &ns_state, 0, spill).unwrap();
            assert_eq!(&*result, &data);
        });
    }

    #[test]
    fn write_fills_block_1_exactly() {
        run_with_stack(|| {
            let mut storage = MemoryStorage::new();
            let (session, mut ns_state, _) = provision_all_sessions(&mut storage);

            // Fill blocks 0 and 1 exactly: LENGTH_HDR_SIZE + data = 2 * PLAINTEXT_SIZE
            let exact_two = 2 * PLAINTEXT_SIZE - LENGTH_HDR_SIZE;
            let data = vec![0xCC; exact_two];
            write_session_data(&mut storage, DOMAIN, NS, &session, &mut ns_state, 0, &data)
                .unwrap();

            assert_eq!(ns_state.total_data_length, exact_two as u64);
            assert_eq!(get_global_block_count(&storage, NS).unwrap(), 2);

            let result =
                read_session_data(&storage, DOMAIN, NS, &session, &ns_state, 0, exact_two).unwrap();
            assert_eq!(&*result, &data);
        });
    }

    #[test]
    fn write_one_byte_spills_to_block_2() {
        run_with_stack(|| {
            let mut storage = MemoryStorage::new();
            let (session, mut ns_state, _) = provision_all_sessions(&mut storage);

            // One byte past two full blocks -> must allocate block 2
            let spill = 2 * PLAINTEXT_SIZE - LENGTH_HDR_SIZE + 1;
            let data = vec![0xDD; spill];
            write_session_data(&mut storage, DOMAIN, NS, &session, &mut ns_state, 0, &data)
                .unwrap();

            assert_eq!(ns_state.total_data_length, spill as u64);
            assert_eq!(get_global_block_count(&storage, NS).unwrap(), 3);

            let result =
                read_session_data(&storage, DOMAIN, NS, &session, &ns_state, 0, spill).unwrap();
            assert_eq!(&*result, &data);
        });
    }

    #[test]
    fn write_empty_is_always_noop() {
        run_with_stack(|| {
            let mut storage = MemoryStorage::new();
            let (session, mut ns_state, _) = provision_all_sessions(&mut storage);

            // Empty write at offset 0: no-op
            write_session_data(&mut storage, DOMAIN, NS, &session, &mut ns_state, 0, &[]).unwrap();
            assert_eq!(ns_state.total_data_length, 0);
            assert_eq!(get_global_block_count(&storage, NS).unwrap(), 0);

            // Empty write at offset > old_total: still a no-op (no ftruncate semantics)
            write_session_data(&mut storage, DOMAIN, NS, &session, &mut ns_state, 1000, &[])
                .unwrap();
            assert_eq!(ns_state.total_data_length, 0);
            assert_eq!(get_global_block_count(&storage, NS).unwrap(), 0);

            // After real data, empty write at higher offset: no-op
            write_session_data(
                &mut storage,
                DOMAIN,
                NS,
                &session,
                &mut ns_state,
                0,
                &[0xAA; 50],
            )
            .unwrap();
            assert_eq!(ns_state.total_data_length, 50);
            write_session_data(&mut storage, DOMAIN, NS, &session, &mut ns_state, 9999, &[])
                .unwrap();
            assert_eq!(ns_state.total_data_length, 50);
        });
    }

    // --- shrink_session_data ---

    #[test]
    fn shrink_no_op_when_not_smaller() {
        run_with_stack(|| {
            let mut storage = MemoryStorage::new();
            let (session, mut ns_state, _) = provision_all_sessions(&mut storage);

            let data = vec![0xAA; 100];
            write_session_data(&mut storage, DOMAIN, NS, &session, &mut ns_state, 0, &data)
                .unwrap();

            // Same size: no-op
            shrink_session_data(&mut storage, DOMAIN, NS, &session, &mut ns_state, 100).unwrap();
            assert_eq!(ns_state.total_data_length, 100);

            // Larger size: no-op
            shrink_session_data(&mut storage, DOMAIN, NS, &session, &mut ns_state, 200).unwrap();
            assert_eq!(ns_state.total_data_length, 100);
        });
    }

    #[test]
    fn shrink_updates_total_length() {
        run_with_stack(|| {
            let mut storage = MemoryStorage::new();
            let (session, mut ns_state, _) = provision_all_sessions(&mut storage);

            let data = vec![0xAA; 100];
            write_session_data(&mut storage, DOMAIN, NS, &session, &mut ns_state, 0, &data)
                .unwrap();

            shrink_session_data(&mut storage, DOMAIN, NS, &session, &mut ns_state, 50).unwrap();
            assert_eq!(ns_state.total_data_length, 50);

            let total = crate::read::read_total_length(
                &storage,
                DOMAIN,
                session.session_version,
                session.session_index,
                NS,
                &session.pq_rerand_sk,
                session.root_aead_key.as_ref(),
            )
            .unwrap();
            assert_eq!(total, 50);
        });
    }

    #[test]
    fn shrink_preserves_remaining_data() {
        run_with_stack(|| {
            let mut storage = MemoryStorage::new();
            let (session, mut ns_state, _) = provision_all_sessions(&mut storage);

            let data: Vec<u8> = (0..200).map(|i| (i % 256) as u8).collect();
            write_session_data(&mut storage, DOMAIN, NS, &session, &mut ns_state, 0, &data)
                .unwrap();

            shrink_session_data(&mut storage, DOMAIN, NS, &session, &mut ns_state, 100).unwrap();

            let result =
                read_session_data(&storage, DOMAIN, NS, &session, &ns_state, 0, 100).unwrap();
            assert_eq!(&*result, &data[..100]);
        });
    }

    #[test]
    fn shrink_freed_blocks_become_cover() {
        run_with_stack(|| {
            let mut storage = MemoryStorage::new();
            let (session, mut ns_state, _) = provision_all_sessions(&mut storage);

            // Write enough data to span multiple blocks
            let data_len = PLAINTEXT_SIZE * 3;
            let data = vec![0xBB; data_len];
            write_session_data(&mut storage, DOMAIN, NS, &session, &mut ns_state, 0, &data)
                .unwrap();

            // Shrink to fit in 1 block
            shrink_session_data(&mut storage, DOMAIN, NS, &session, &mut ns_state, 10).unwrap();

            // Blocks beyond new_last_block should no longer be decryptable
            // (they are now cover blocks with throwaway AEAD keys)
            let result = decrypt_session_data_block(&storage, DOMAIN, NS, &session, 2);
            assert!(result.is_err());
        });
    }

    #[test]
    fn shrink_all_sessions_updated_at_freed_indices() {
        run_with_stack(|| {
            let mut storage = MemoryStorage::new();
            let (session, mut ns_state, _) = provision_all_sessions(&mut storage);

            let data_len = PLAINTEXT_SIZE * 3;
            let data = vec![0xCC; data_len];
            write_session_data(&mut storage, DOMAIN, NS, &session, &mut ns_state, 0, &data)
                .unwrap();

            // Snapshot block 2 for all sessions before shrink
            let mut before = Vec::new();
            for i in 0..SESSION_COUNT as u8 {
                let s = SessionIndex::new(i).unwrap();
                before.push(storage.read_block(s, NS, 2).unwrap());
            }

            // Shrink to 1 block -- blocks 1 and 2 become freed
            shrink_session_data(&mut storage, DOMAIN, NS, &session, &mut ns_state, 10).unwrap();

            // All sessions should have changed ciphertexts at the freed index
            for i in 0..SESSION_COUNT as u8 {
                let s = SessionIndex::new(i).unwrap();
                let after = storage.read_block(s, NS, 2).unwrap();
                assert_ne!(
                    *after, *before[i as usize],
                    "session {i} block 2 was not updated during shrink"
                );
            }
        });
    }

    #[test]
    fn shrink_to_zero() {
        run_with_stack(|| {
            let mut storage = MemoryStorage::new();
            let (session, mut ns_state, _) = provision_all_sessions(&mut storage);

            let data = vec![0xDD; 100];
            write_session_data(&mut storage, DOMAIN, NS, &session, &mut ns_state, 0, &data)
                .unwrap();

            shrink_session_data(&mut storage, DOMAIN, NS, &session, &mut ns_state, 0).unwrap();
            assert_eq!(ns_state.total_data_length, 0);

            let total = crate::read::read_total_length(
                &storage,
                DOMAIN,
                session.session_version,
                session.session_index,
                NS,
                &session.pq_rerand_sk,
                session.root_aead_key.as_ref(),
            )
            .unwrap();
            assert_eq!(total, 0);

            // Blockstream length unchanged
            assert!(get_global_block_count(&storage, NS).unwrap() >= 1);
        });
    }

    #[test]
    fn shrink_cross_block_boundary() {
        run_with_stack(|| {
            let mut storage = MemoryStorage::new();
            let (session, mut ns_state, _) = provision_all_sessions(&mut storage);

            // Write across 3 blocks
            let data_len = PLAINTEXT_SIZE * 3;
            let data: Vec<u8> = (0..data_len).map(|i| (i % 256) as u8).collect();
            write_session_data(&mut storage, DOMAIN, NS, &session, &mut ns_state, 0, &data)
                .unwrap();

            let blocks_before = get_global_block_count(&storage, NS).unwrap();

            // Shrink to 1.5 blocks worth of data
            let new_size = PLAINTEXT_SIZE + PLAINTEXT_SIZE / 2;
            shrink_session_data(
                &mut storage,
                DOMAIN,
                NS,
                &session,
                &mut ns_state,
                new_size as u64,
            )
            .unwrap();

            // Blockstream length unchanged (blocks never removed)
            assert_eq!(get_global_block_count(&storage, NS).unwrap(), blocks_before);

            // Data in the remaining range is intact
            let result =
                read_session_data(&storage, DOMAIN, NS, &session, &ns_state, 0, new_size).unwrap();
            assert_eq!(&*result, &data[..new_size]);
        });
    }

    #[test]
    fn shrink_partial_block_tail_randomized() {
        run_with_stack(|| {
            let mut storage = MemoryStorage::new();
            let (session, mut ns_state, _) = provision_all_sessions(&mut storage);

            // Fill exactly 1 block worth of data
            let data = vec![0xEE; PLAINTEXT_SIZE - LENGTH_HDR_SIZE];
            write_session_data(&mut storage, DOMAIN, NS, &session, &mut ns_state, 0, &data)
                .unwrap();

            // Read the full plaintext of block 0 before shrink
            let pt_before = decrypt_session_data_block(&storage, DOMAIN, NS, &session, 0).unwrap();

            // Shrink to half the data
            let half = (PLAINTEXT_SIZE - LENGTH_HDR_SIZE) / 2;
            shrink_session_data(
                &mut storage,
                DOMAIN,
                NS,
                &session,
                &mut ns_state,
                half as u64,
            )
            .unwrap();

            // Read the full plaintext of block 0 after shrink
            let pt_after = decrypt_session_data_block(&storage, DOMAIN, NS, &session, 0).unwrap();

            // The data portion should match
            assert_eq!(
                &pt_after[LENGTH_HDR_SIZE..LENGTH_HDR_SIZE + half],
                &pt_before[LENGTH_HDR_SIZE..LENGTH_HDR_SIZE + half]
            );

            // The tail portion should differ (randomized)
            let tail_before = &pt_before[LENGTH_HDR_SIZE + half..];
            let tail_after = &pt_after[LENGTH_HDR_SIZE + half..];
            assert_ne!(
                tail_before, tail_after,
                "tail should be randomized after shrink"
            );
        });
    }
}
