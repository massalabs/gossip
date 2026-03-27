//! Write path: encrypt blocks with snapshot resistance and assemble session data.
//!
//! PQ crypto operations are parallelized on native targets via [`execute_pq_jobs`].
//! On WASM (single-threaded), the same function runs sequentially.

use std::collections::HashMap;

use rand::RngCore;
use rand::seq::SliceRandom;
use zeroize::Zeroizing;

use crate::BLOCK_SIZE;
use crate::block::{create_cover_block, encrypt_block, rerandomize_block};
use crate::constants::{LENGTH_HDR_SIZE, PLAINTEXT_SIZE, SESSION_COUNT};
use crate::domain;
use crate::error::{SecureStorageError, Result};
use crate::kdf::derive_block_aead_key;
use crate::keypair::read_session_version_and_pk;
use crate::pq::PqPublicKey;
use crate::read::decrypt_session_data_block;
use crate::storage::{BlockStorage, KeypairStorage};
use crate::types::SessionIndex;
use crate::unlock::UnlockedSession;

// ── Parallel PQ dispatch ─────────────────────────────────────────────

/// Thread stack size for PQ crypto threads (4 MiB).
const PQ_THREAD_STACK: usize = 4 * 1024 * 1024;

/// A single PQ crypto operation to execute.
struct PqJob {
    block_idx: u64,
    session_idx: u8,
    pk_bytes: Vec<u8>,
    op: PqOpKind,
}

/// The kind of PQ operation: genuine encrypt or rerand/cover.
enum PqOpKind {
    Encrypt {
        aead_sk: Zeroizing<[u8; crypto_aead::KEY_SIZE]>,
        aad: String,
        plaintext: [u8; PLAINTEXT_SIZE],
    },
    Rerand {
        aad_root: String,
        existing: Option<Box<[u8; BLOCK_SIZE]>>,
    },
}

/// Execute a single PQ job, returning the ciphertext.
fn run_pq_job(job: PqJob) -> (u64, u8, Vec<u8>) {
    let ct = match job.op {
        PqOpKind::Encrypt { aead_sk, aad, plaintext } => {
            let pk = PqPublicKey::from_bytes(&job.pk_bytes).unwrap();
            encrypt_block(&pk, &*aead_sk, &aad, &plaintext)
        }
        PqOpKind::Rerand { aad_root, existing } => {
            let pk = PqPublicKey::from_bytes(&job.pk_bytes).unwrap();
            match existing {
                Some(ref block) => rerandomize_block(&pk, block),
                None => create_cover_block(&pk, &aad_root),
            }
        }
    };
    (job.block_idx, job.session_idx, ct)
}

/// Execute PQ jobs in parallel (native) or sequentially (WASM).
///
/// Returns a map of `(block_idx, session_idx) → ciphertext` for O(1) lookup.
/// On native targets, jobs are split across 2 worker threads while the calling
/// thread also processes a share of the work.
#[cfg(not(target_arch = "wasm32"))]
fn execute_pq_jobs(mut jobs: Vec<PqJob>) -> Result<HashMap<(u64, u8), Vec<u8>>> {
    if jobs.is_empty() {
        return Ok(HashMap::new());
    }

    // Split into 3 roughly-equal chunks: 2 worker threads + main thread.
    const EXECUTORS: usize = 3;
    let chunk_size = (jobs.len() + EXECUTORS - 1) / EXECUTORS;
    let cs = chunk_size.max(1);

    // Peel off up to 2 chunks for worker threads.
    let mut worker_chunks: Vec<Vec<PqJob>> = Vec::with_capacity(2);
    for _ in 0..2 {
        if jobs.is_empty() {
            break;
        }
        let end = cs.min(jobs.len());
        worker_chunks.push(jobs.drain(..end).collect());
    }
    // Remaining jobs run on the main thread.
    let main_chunk = jobs;

    // Spawn workers.
    let mut handles = Vec::with_capacity(worker_chunks.len());
    for chunk in worker_chunks {
        let handle = std::thread::Builder::new()
            .stack_size(PQ_THREAD_STACK)
            .spawn(move || -> Vec<(u64, u8, Vec<u8>)> {
                chunk.into_iter().map(run_pq_job).collect()
            })
            .map_err(|_| SecureStorageError::ThreadPanic)?;
        handles.push(handle);
    }

    // Main thread processes its share concurrently.
    let mut results = HashMap::with_capacity(main_chunk.len());
    for (bi, si, ct) in main_chunk.into_iter().map(run_pq_job) {
        results.insert((bi, si), ct);
    }

    // Join workers.
    for h in handles {
        let worker_results = h.join().map_err(|_| SecureStorageError::ThreadPanic)?;
        for (bi, si, ct) in worker_results {
            results.insert((bi, si), ct);
        }
    }

    Ok(results)
}

/// Sequential fallback for WASM (single-threaded).
#[cfg(target_arch = "wasm32")]
fn execute_pq_jobs(jobs: Vec<PqJob>) -> Result<HashMap<(u64, u8), Vec<u8>>> {
    let mut results = HashMap::with_capacity(jobs.len());
    for (bi, si, ct) in jobs.into_iter().map(run_pq_job) {
        results.insert((bi, si), ct);
    }
    Ok(results)
}

// ── Block-level encryption with snapshot resistance ──────────────────

/// Build PQ jobs for encrypting one block across all sessions.
///
/// Pre-reads all PKs and existing blocks from storage, then returns
/// the jobs ready for [`execute_pq_jobs`].
fn build_block_jobs<S: BlockStorage + KeypairStorage>(
    storage: &S,
    domain: &str,
    session: &UnlockedSession,
    block_index: u64,
    plaintext: &[u8; PLAINTEXT_SIZE],
) -> Result<Vec<PqJob>> {
    let target_idx = session.session_index.as_u8();
    let (aead_sk, genuine_aad) = derive_block_aead_key(
        domain,
        session.session_version,
        session.session_index,
        session.root_aead_key.as_ref(),
        block_index,
    );

    let mut jobs = Vec::with_capacity(SESSION_COUNT);
    for i in 0..SESSION_COUNT as u8 {
        let cur_session = SessionIndex::new(i).unwrap();
        // Read version/pk for ALL sessions for timing uniformity (spec §11.2).
        let (cur_version, cur_pk_bytes) = read_session_version_and_pk(storage, cur_session)?;
        let _ = PqPublicKey::from_bytes(&cur_pk_bytes)?;

        let op = if i == target_idx {
            PqOpKind::Encrypt {
                aead_sk: aead_sk.clone(),
                aad: genuine_aad.clone(),
                plaintext: *plaintext,
            }
        } else {
            let mut aad_root = String::new();
            domain::block_scope(&mut aad_root, domain, cur_version, cur_session, block_index);
            PqOpKind::Rerand {
                aad_root,
                existing: storage.read_block(cur_session, block_index).ok(),
            }
        };
        jobs.push(PqJob { block_idx: block_index, session_idx: i, pk_bytes: cur_pk_bytes, op });
    }
    Ok(jobs)
}

/// Write ciphertexts from a results map to storage in shuffled order.
fn write_results_shuffled<S: BlockStorage>(
    storage: &mut S,
    block_index: u64,
    results: &mut HashMap<(u64, u8), Vec<u8>>,
) -> Result<()> {
    let mut write_order: Vec<u8> = (0..SESSION_COUNT as u8).collect();
    write_order.shuffle(&mut rand::rngs::OsRng);

    for si in write_order {
        let cur_session = SessionIndex::new(si).unwrap();
        let ct = results
            .remove(&(block_index, si))
            .ok_or(SecureStorageError::CorruptedBlock)?;
        let ct_arr: &[u8; BLOCK_SIZE] = ct
            .as_slice()
            .try_into()
            .map_err(|_| SecureStorageError::CorruptedBlock)?;
        storage.write_block(cur_session, block_index, ct_arr)?;
        storage.fsync(cur_session)?;
    }
    Ok(())
}

/// Encrypt and write a single block with snapshot resistance.
///
/// Writes the genuine ciphertext for the target session and
/// rerandomizes (or covers) the same block index in all other sessions.
/// Session update order is randomized to prevent timing correlation.
pub fn encrypt_session_data_block<S: BlockStorage + KeypairStorage>(
    storage: &mut S,
    domain: &str,
    session: &UnlockedSession,
    block_index: u64,
    plaintext: &[u8; PLAINTEXT_SIZE],
) -> Result<()> {
    if session.session_version != 0 {
        return Err(SecureStorageError::UnsupportedVersion(session.session_version));
    }
    let jobs = build_block_jobs(storage, domain, session, block_index, plaintext)?;
    let mut results = execute_pq_jobs(jobs)?;
    write_results_shuffled(storage, block_index, &mut results)
}

/// Encrypt multiple blocks in one parallel batch.
///
/// Collects all (block × session) PQ operations and dispatches them
/// in a single parallel round for cross-block parallelism.
fn encrypt_session_data_blocks_batch<S: BlockStorage + KeypairStorage>(
    storage: &mut S,
    domain: &str,
    session: &UnlockedSession,
    block_plaintexts: &[(u64, [u8; PLAINTEXT_SIZE])],
) -> Result<()> {
    if block_plaintexts.is_empty() {
        return Ok(());
    }

    // Collect jobs for all blocks.
    let mut all_jobs = Vec::with_capacity(block_plaintexts.len() * SESSION_COUNT);
    for &(bi, ref pt) in block_plaintexts {
        all_jobs.extend(build_block_jobs(storage, domain, session, bi, pt)?);
    }

    let mut results = execute_pq_jobs(all_jobs)?;

    // Write each block's ciphertexts in shuffled order.
    for &(bi, _) in block_plaintexts {
        write_results_shuffled(storage, bi, &mut results)?;
    }
    Ok(())
}

/// Returns the global block count (maximum across all sessions).
pub fn get_global_block_count<S: BlockStorage>(storage: &S) -> Result<u64> {
    let mut max_count = 0u64;
    for i in 0..SESSION_COUNT as u8 {
        let session =
            SessionIndex::new(i).expect(&format!("{i} >= SESSION_COUNT: {SESSION_COUNT}"));
        let count = storage.block_count(session)?;
        max_count = max_count.max(count);
    }
    Ok(max_count)
}

/// Repair blockstream length inconsistencies across sessions.
///
/// Sessions shorter than the global maximum are padded with cover blocks.
/// Called before every extend and every cover_traffic_tick.
pub fn repair_blockstream_lengths<S: BlockStorage + KeypairStorage>(
    storage: &mut S,
    domain: &str,
) -> Result<()> {
    let global_count = get_global_block_count(storage)?;
    let mut cur_aad_root = String::new();

    for i in 0..SESSION_COUNT as u8 {
        let session =
            SessionIndex::new(i).expect(&format!("{i} >= SESSION_COUNT: {SESSION_COUNT}"));
        let mut count = storage.block_count(session)?;

        while count < global_count {
            let (version, pk_bytes) = read_session_version_and_pk(storage, session)?;
            let pk = PqPublicKey::from_bytes(&pk_bytes)?;

            domain::block_scope(&mut cur_aad_root, domain, version, session, count);
            let cover = create_cover_block(&pk, &cur_aad_root);
            let ct_arr: &[u8; BLOCK_SIZE] = cover
                .as_slice()
                .try_into()
                .map_err(|_| SecureStorageError::CorruptedBlock)?;
            storage.append_block(session, ct_arr)?;
            storage.fsync(session)?;
            count += 1;
        }
    }

    Ok(())
}

/// Ensure all sessions have at least `required_count` blocks.
pub fn ensure_block_count<S: BlockStorage + KeypairStorage>(
    storage: &mut S,
    domain: &str,
    session: &UnlockedSession,
    required_count: u64,
) -> Result<()> {
    repair_blockstream_lengths(storage, domain)?;
    while get_global_block_count(storage)? < required_count {
        extend_blockstream_with_session_block(storage, domain, session)?;
    }
    Ok(())
}

/// Add one block to all sessions.
///
/// The target session gets a genuine block (random padding, with length
/// header if block 0). Other sessions get cover blocks.
fn extend_blockstream_with_session_block<S: BlockStorage + KeypairStorage>(
    storage: &mut S,
    domain: &str,
    session: &UnlockedSession,
) -> Result<()> {
    repair_blockstream_lengths(storage, domain)?;
    let block_index = get_global_block_count(storage)?;

    // Prepare genuine plaintext (random padding, length header if block 0).
    let mut pt = Zeroizing::new([0u8; PLAINTEXT_SIZE]);
    rand::rngs::OsRng.fill_bytes(pt.as_mut());
    if block_index == 0 {
        pt[..LENGTH_HDR_SIZE].copy_from_slice(&session.total_data_length.to_be_bytes());
    }

    // Build and execute PQ jobs (genuine encrypt + cover blocks).
    let jobs = build_block_jobs(storage, domain, session, block_index, &pt)?;
    let mut results = execute_pq_jobs(jobs)?;

    // Append in shuffled order.
    let mut write_order: Vec<u8> = (0..SESSION_COUNT as u8).collect();
    write_order.shuffle(&mut rand::rngs::OsRng);

    for si in write_order {
        let cur_session = SessionIndex::new(si).unwrap();
        let ct = results
            .remove(&(block_index, si))
            .ok_or(SecureStorageError::CorruptedBlock)?;
        let ct_arr: &[u8; BLOCK_SIZE] = ct
            .as_slice()
            .try_into()
            .map_err(|_| SecureStorageError::CorruptedBlock)?;
        storage.append_block(cur_session, ct_arr)?;
        storage.fsync(cur_session)?;
    }

    Ok(())
}

/// Write session data at an offset, analogous to `pwrite(fd, buf, count, offset)`.
///
/// Handles multi-block writes, partial overwrites, full overwrite optimization,
/// and length header updates in block 0.
pub fn write_session_data<S: BlockStorage + KeypairStorage>(
    storage: &mut S,
    domain: &str,
    session: &mut UnlockedSession,
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
    let old_total = session.total_data_length;
    let new_total = old_total.max(
        offset
            .checked_add(data_len)
            .ok_or(SecureStorageError::Overflow)?,
    );
    session.total_data_length = new_total;

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
    ensure_block_count(storage, domain, session, required_last_block + 1)?;

    // Map logical data offset to virtual plaintext stream position
    let start_pos = hdr.checked_add(offset).ok_or(SecureStorageError::Overflow)?;
    let end_pos_excl = start_pos
        .checked_add(data_len)
        .ok_or(SecureStorageError::Overflow)?;

    let first_block = start_pos / ps;
    let last_block = end_pos_excl
        .checked_sub(1)
        .ok_or(SecureStorageError::Overflow)?
        / ps;

    // ── Prepare plaintext for all affected blocks ──
    // Also include block 0 length-header update if needed.
    let need_block0_header = new_total > old_total && first_block > 0;

    let mut block_plaintexts: Vec<(u64, [u8; PLAINTEXT_SIZE])> = Vec::new();

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
            match decrypt_session_data_block(storage, domain, session, b) {
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

        let mut arr = [0u8; PLAINTEXT_SIZE];
        arr.copy_from_slice(&pt);
        block_plaintexts.push((b, arr));
    }

    // If total_data_length grew and block 0 wasn't already written above,
    // re-encrypt block 0 to persist the updated length header.
    if need_block0_header {
        let mut pt = Zeroizing::new(vec![0u8; PLAINTEXT_SIZE]);
        match decrypt_session_data_block(storage, domain, session, 0) {
            Ok(existing) => pt.copy_from_slice(existing.as_ref()),
            Err(_) => rand::rngs::OsRng.fill_bytes(&mut pt[..]),
        }
        pt[..LENGTH_HDR_SIZE].copy_from_slice(&new_total.to_be_bytes());
        let mut arr = [0u8; PLAINTEXT_SIZE];
        arr.copy_from_slice(&pt);
        block_plaintexts.push((0, arr));
    }

    // ── Encrypt all blocks with cross-block parallelism ──
    encrypt_session_data_blocks_batch(storage, domain, session, &block_plaintexts)?;

    Ok(())
}

/// Shrink session data to `new_total` bytes, converting freed blocks to cover.
///
/// The global blockstream length never decreases. Freed blocks become
/// cover blocks indistinguishable from blocks allocated by other sessions.
/// All touched block indices are updated across ALL sessions in randomized
/// order (snapshot resistance).
pub fn shrink_session_data<S: BlockStorage + KeypairStorage>(
    storage: &mut S,
    domain: &str,
    session: &mut UnlockedSession,
    new_total: u64,
) -> Result<()> {
    if session.session_version != 0 {
        return Err(SecureStorageError::UnsupportedVersion(
            session.session_version,
        ));
    }

    let old_total = session.total_data_length;
    if new_total >= old_total {
        return Ok(());
    }

    session.total_data_length = new_total;

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
    match decrypt_session_data_block(storage, domain, session, new_last_block) {
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
    encrypt_session_data_block(storage, domain, session, new_last_block, pt_arr)?;

    // If block 0 was not the new last block, also update block 0's length header
    if new_last_block != 0 {
        let mut pt0 = Zeroizing::new(vec![0u8; PLAINTEXT_SIZE]);
        match decrypt_session_data_block(storage, domain, session, 0) {
            Ok(existing) => pt0.copy_from_slice(existing.as_ref()),
            Err(_) => rand::rngs::OsRng.fill_bytes(&mut pt0[..]),
        }
        pt0[..LENGTH_HDR_SIZE].copy_from_slice(&new_total.to_be_bytes());
        let pt0_arr: &[u8; PLAINTEXT_SIZE] = pt0
            .as_slice()
            .try_into()
            .expect(&format!("{} != PLAINTEXT_SIZE", pt0.len()));
        encrypt_session_data_block(storage, domain, session, 0, pt0_arr)?;
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
            domain::block_scope(&mut cur_aad_root, domain, cur_version, cur_session, b);

            let new_ct = if cur_session == session.session_index {
                create_cover_block(&cur_pk, &cur_aad_root)
            } else {
                match storage.read_block(cur_session, b) {
                    Ok(cur_ct) => rerandomize_block(&cur_pk, &cur_ct),
                    Err(_) => create_cover_block(&cur_pk, &cur_aad_root),
                }
            };
            let ct_arr: &[u8; BLOCK_SIZE] = new_ct
                .as_slice()
                .try_into()
                .map_err(|_| SecureStorageError::CorruptedBlock)?;
            storage.write_block(cur_session, b, ct_arr)?;
            storage.fsync(cur_session)?;
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::keypair::KeypairFile;
    use crate::pq::{PqPublicKey, PqSecretKey, pq_keygen};
    use crate::read::read_session_data;
    use crate::run_with_stack;
    use crate::storage::MemoryStorage;

    const DOMAIN: &str = "test";

    /// Provision all 5 sessions with keypair files.
    /// Returns the keys for a specific session index.
    fn provision_all_sessions(
        storage: &mut MemoryStorage,
    ) -> (UnlockedSession, Vec<(PqPublicKey, PqSecretKey)>) {
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
            total_data_length: 0,
        };

        (session, all_keys)
    }

    // --- commit 12: encrypt_session_data_block ---

    #[test]
    fn write_then_read_block() {
        run_with_stack(|| {
            let mut storage = MemoryStorage::new();
            let (session, _) = provision_all_sessions(&mut storage);

            // All sessions need at least 1 block
            ensure_block_count(&mut storage, DOMAIN, &session, 1).unwrap();

            let mut pt = [0u8; PLAINTEXT_SIZE];
            pt[0] = 0x42;
            pt[PLAINTEXT_SIZE - 1] = 0xFF;
            encrypt_session_data_block(&mut storage, DOMAIN, &session, 0, &pt).unwrap();

            let decrypted =
                crate::read::decrypt_session_data_block(&storage, DOMAIN, &session, 0).unwrap();
            assert_eq!(*decrypted, pt);
        });
    }

    #[test]
    fn all_sessions_updated() {
        run_with_stack(|| {
            let mut storage = MemoryStorage::new();
            let (session, _) = provision_all_sessions(&mut storage);

            ensure_block_count(&mut storage, DOMAIN, &session, 1).unwrap();

            let pt = [0u8; PLAINTEXT_SIZE];
            encrypt_session_data_block(&mut storage, DOMAIN, &session, 0, &pt).unwrap();

            // All 5 sessions should have at least 1 block
            for i in 0..SESSION_COUNT as u8 {
                let s = SessionIndex::new(i).unwrap();
                assert!(storage.block_count(s).unwrap() >= 1);
            }
        });
    }

    #[test]
    fn other_sessions_rerandomized() {
        run_with_stack(|| {
            let mut storage = MemoryStorage::new();
            let (session, _) = provision_all_sessions(&mut storage);

            // First ensure blocks exist (this creates initial cover blocks for all sessions)
            ensure_block_count(&mut storage, DOMAIN, &session, 1).unwrap();

            // Read original ciphertexts for non-target sessions
            let mut original_cts = Vec::new();
            for i in 1..SESSION_COUNT as u8 {
                let s = SessionIndex::new(i).unwrap();
                original_cts.push(storage.read_block(s, 0).unwrap());
            }

            // Write a block to session 0
            let pt = [0x42; PLAINTEXT_SIZE];
            encrypt_session_data_block(&mut storage, DOMAIN, &session, 0, &pt).unwrap();

            // Non-target sessions should have different ciphertexts (rerandomized)
            for (idx, i) in (1..SESSION_COUNT as u8).enumerate() {
                let s = SessionIndex::new(i).unwrap();
                let new_ct = storage.read_block(s, 0).unwrap();
                assert_ne!(
                    *new_ct, *original_cts[idx],
                    "session {i} was not rerandomized"
                );
            }

            // But the rerandomized blocks should still be decryptable by their respective sessions
            // (cover blocks from extend aren't decryptable with session 0 keys, and we don't have
            // other sessions' AEAD keys, so we just verify the ciphertexts changed)
        });
    }

    // --- commit 13: blockstream extension and repair ---

    #[test]
    fn repair_aligns_lengths() {
        run_with_stack(|| {
            let mut storage = MemoryStorage::new();
            let (session, _) = provision_all_sessions(&mut storage);

            // Manually create uneven block counts
            ensure_block_count(&mut storage, DOMAIN, &session, 3).unwrap();

            // Manually append extra blocks to session 1
            let s1 = SessionIndex::new(1).unwrap();
            let (_, pk_bytes) = read_session_version_and_pk(&storage, s1).unwrap();
            let pk = PqPublicKey::from_bytes(&pk_bytes).unwrap();
            let cover = create_cover_block(&pk, "dummy");
            let ct_arr: &[u8; BLOCK_SIZE] = cover.as_slice().try_into().unwrap();
            storage.append_block(s1, ct_arr).unwrap();
            storage.append_block(s1, ct_arr).unwrap();

            // Session 1 now has 5, others have 3
            assert_eq!(storage.block_count(s1).unwrap(), 5);

            repair_blockstream_lengths(&mut storage, DOMAIN).unwrap();

            // All sessions should now have 5 blocks
            for i in 0..SESSION_COUNT as u8 {
                let s = SessionIndex::new(i).unwrap();
                assert_eq!(storage.block_count(s).unwrap(), 5);
            }
        });
    }

    #[test]
    fn extend_adds_to_all() {
        run_with_stack(|| {
            let mut storage = MemoryStorage::new();
            let (session, _) = provision_all_sessions(&mut storage);

            ensure_block_count(&mut storage, DOMAIN, &session, 1).unwrap();

            for i in 0..SESSION_COUNT as u8 {
                let s = SessionIndex::new(i).unwrap();
                assert_eq!(storage.block_count(s).unwrap(), 1);
            }
        });
    }

    #[test]
    fn ensure_idempotent() {
        run_with_stack(|| {
            let mut storage = MemoryStorage::new();
            let (session, _) = provision_all_sessions(&mut storage);

            ensure_block_count(&mut storage, DOMAIN, &session, 3).unwrap();
            let count_before = get_global_block_count(&storage).unwrap();

            ensure_block_count(&mut storage, DOMAIN, &session, 3).unwrap();
            let count_after = get_global_block_count(&storage).unwrap();

            assert_eq!(count_before, count_after);
        });
    }

    // --- commit 14: write_session_data ---

    #[test]
    fn write_then_read_roundtrip() {
        run_with_stack(|| {
            let mut storage = MemoryStorage::new();
            let (mut session, _) = provision_all_sessions(&mut storage);

            let data = b"hello, secureStorage!";
            write_session_data(&mut storage, DOMAIN, &mut session, 0, data).unwrap();

            let result = read_session_data(&storage, DOMAIN, &session, 0, data.len()).unwrap();
            assert_eq!(&*result, data);
        });
    }

    #[test]
    fn write_extends_storage() {
        run_with_stack(|| {
            let mut storage = MemoryStorage::new();
            let (mut session, _) = provision_all_sessions(&mut storage);

            assert_eq!(get_global_block_count(&storage).unwrap(), 0);

            let data = vec![0xAB; 100];
            write_session_data(&mut storage, DOMAIN, &mut session, 0, &data).unwrap();

            assert!(get_global_block_count(&storage).unwrap() >= 1);
        });
    }

    #[test]
    fn write_updates_total_length() {
        run_with_stack(|| {
            let mut storage = MemoryStorage::new();
            let (mut session, _) = provision_all_sessions(&mut storage);

            let data = vec![0; 200];
            write_session_data(&mut storage, DOMAIN, &mut session, 0, &data).unwrap();

            assert_eq!(session.total_data_length, 200);
        });
    }

    #[test]
    fn partial_overwrite() {
        run_with_stack(|| {
            let mut storage = MemoryStorage::new();
            let (mut session, _) = provision_all_sessions(&mut storage);

            // Write initial data
            let initial = vec![0xAA; 100];
            write_session_data(&mut storage, DOMAIN, &mut session, 0, &initial).unwrap();

            // Overwrite bytes 25..75
            let patch = vec![0xBB; 50];
            write_session_data(&mut storage, DOMAIN, &mut session, 25, &patch).unwrap();

            let result = read_session_data(&storage, DOMAIN, &session, 0, 100).unwrap();
            assert_eq!(&result[..25], &[0xAA; 25]);
            assert_eq!(&result[25..75], &[0xBB; 50]);
            assert_eq!(&result[75..100], &[0xAA; 25]);
        });
    }

    #[test]
    fn write_block_0_preserves_header() {
        run_with_stack(|| {
            let mut storage = MemoryStorage::new();
            let (mut session, _) = provision_all_sessions(&mut storage);

            let data = vec![0xCC; 50];
            write_session_data(&mut storage, DOMAIN, &mut session, 0, &data).unwrap();

            // Read total length from block 0 header
            let total = crate::read::read_total_length(
                &storage,
                DOMAIN,
                session.session_version,
                session.session_index,
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
            let (mut session, _) = provision_all_sessions(&mut storage);

            write_session_data(&mut storage, DOMAIN, &mut session, 0, b"hello").unwrap();
            write_session_data(&mut storage, DOMAIN, &mut session, 5, b" world").unwrap();

            let result = read_session_data(&storage, DOMAIN, &session, 0, 11).unwrap();
            assert_eq!(&*result, b"hello world");
        });
    }

    #[test]
    fn write_cross_block() {
        run_with_stack(|| {
            let mut storage = MemoryStorage::new();
            let (mut session, _) = provision_all_sessions(&mut storage);

            // Write data that spans multiple blocks
            let data_len = PLAINTEXT_SIZE * 2;
            let data: Vec<u8> = (0..data_len).map(|i| (i % 256) as u8).collect();
            write_session_data(&mut storage, DOMAIN, &mut session, 0, &data).unwrap();

            let result = read_session_data(&storage, DOMAIN, &session, 0, data_len).unwrap();
            assert_eq!(&*result, &data);
        });
    }

    // --- Edge cases for required_last_block calculation (review comment #9) ---

    #[test]
    fn write_single_byte() {
        run_with_stack(|| {
            let mut storage = MemoryStorage::new();
            let (mut session, _) = provision_all_sessions(&mut storage);

            // 1 byte of data: last byte at virtual pos LENGTH_HDR_SIZE + 0 -> block 0
            write_session_data(&mut storage, DOMAIN, &mut session, 0, &[0x42]).unwrap();
            assert_eq!(session.total_data_length, 1);
            assert_eq!(get_global_block_count(&storage).unwrap(), 1);

            let result = read_session_data(&storage, DOMAIN, &session, 0, 1).unwrap();
            assert_eq!(&*result, &[0x42]);
        });
    }

    #[test]
    fn write_fills_block_0_exactly() {
        run_with_stack(|| {
            let mut storage = MemoryStorage::new();
            let (mut session, _) = provision_all_sessions(&mut storage);

            // Exactly fill block 0's data area (PLAINTEXT_SIZE - LENGTH_HDR_SIZE bytes)
            let max_b0 = PLAINTEXT_SIZE - LENGTH_HDR_SIZE;
            let data = vec![0xAA; max_b0];
            write_session_data(&mut storage, DOMAIN, &mut session, 0, &data).unwrap();

            assert_eq!(session.total_data_length, max_b0 as u64);
            assert_eq!(get_global_block_count(&storage).unwrap(), 1);

            let result = read_session_data(&storage, DOMAIN, &session, 0, max_b0).unwrap();
            assert_eq!(&*result, &data);
        });
    }

    #[test]
    fn write_one_byte_spills_to_block_1() {
        run_with_stack(|| {
            let mut storage = MemoryStorage::new();
            let (mut session, _) = provision_all_sessions(&mut storage);

            // One byte past block 0's data area -> must allocate block 1
            let spill = PLAINTEXT_SIZE - LENGTH_HDR_SIZE + 1;
            let data = vec![0xBB; spill];
            write_session_data(&mut storage, DOMAIN, &mut session, 0, &data).unwrap();

            assert_eq!(session.total_data_length, spill as u64);
            assert_eq!(get_global_block_count(&storage).unwrap(), 2);

            let result = read_session_data(&storage, DOMAIN, &session, 0, spill).unwrap();
            assert_eq!(&*result, &data);
        });
    }

    #[test]
    fn write_fills_block_1_exactly() {
        run_with_stack(|| {
            let mut storage = MemoryStorage::new();
            let (mut session, _) = provision_all_sessions(&mut storage);

            // Fill blocks 0 and 1 exactly: LENGTH_HDR_SIZE + data = 2 * PLAINTEXT_SIZE
            let exact_two = 2 * PLAINTEXT_SIZE - LENGTH_HDR_SIZE;
            let data = vec![0xCC; exact_two];
            write_session_data(&mut storage, DOMAIN, &mut session, 0, &data).unwrap();

            assert_eq!(session.total_data_length, exact_two as u64);
            assert_eq!(get_global_block_count(&storage).unwrap(), 2);

            let result = read_session_data(&storage, DOMAIN, &session, 0, exact_two).unwrap();
            assert_eq!(&*result, &data);
        });
    }

    #[test]
    fn write_one_byte_spills_to_block_2() {
        run_with_stack(|| {
            let mut storage = MemoryStorage::new();
            let (mut session, _) = provision_all_sessions(&mut storage);

            // One byte past two full blocks -> must allocate block 2
            let spill = 2 * PLAINTEXT_SIZE - LENGTH_HDR_SIZE + 1;
            let data = vec![0xDD; spill];
            write_session_data(&mut storage, DOMAIN, &mut session, 0, &data).unwrap();

            assert_eq!(session.total_data_length, spill as u64);
            assert_eq!(get_global_block_count(&storage).unwrap(), 3);

            let result = read_session_data(&storage, DOMAIN, &session, 0, spill).unwrap();
            assert_eq!(&*result, &data);
        });
    }

    #[test]
    fn write_empty_is_always_noop() {
        run_with_stack(|| {
            let mut storage = MemoryStorage::new();
            let (mut session, _) = provision_all_sessions(&mut storage);

            // Empty write at offset 0: no-op
            write_session_data(&mut storage, DOMAIN, &mut session, 0, &[]).unwrap();
            assert_eq!(session.total_data_length, 0);
            assert_eq!(get_global_block_count(&storage).unwrap(), 0);

            // Empty write at offset > old_total: still a no-op (no ftruncate semantics)
            write_session_data(&mut storage, DOMAIN, &mut session, 1000, &[]).unwrap();
            assert_eq!(session.total_data_length, 0);
            assert_eq!(get_global_block_count(&storage).unwrap(), 0);

            // After real data, empty write at higher offset: no-op
            write_session_data(&mut storage, DOMAIN, &mut session, 0, &[0xAA; 50]).unwrap();
            assert_eq!(session.total_data_length, 50);
            write_session_data(&mut storage, DOMAIN, &mut session, 9999, &[]).unwrap();
            assert_eq!(session.total_data_length, 50);
        });
    }

    // --- shrink_session_data ---

    #[test]
    fn shrink_no_op_when_not_smaller() {
        run_with_stack(|| {
            let mut storage = MemoryStorage::new();
            let (mut session, _) = provision_all_sessions(&mut storage);

            let data = vec![0xAA; 100];
            write_session_data(&mut storage, DOMAIN, &mut session, 0, &data).unwrap();

            // Same size: no-op
            shrink_session_data(&mut storage, DOMAIN, &mut session, 100).unwrap();
            assert_eq!(session.total_data_length, 100);

            // Larger size: no-op
            shrink_session_data(&mut storage, DOMAIN, &mut session, 200).unwrap();
            assert_eq!(session.total_data_length, 100);
        });
    }

    #[test]
    fn shrink_updates_total_length() {
        run_with_stack(|| {
            let mut storage = MemoryStorage::new();
            let (mut session, _) = provision_all_sessions(&mut storage);

            let data = vec![0xAA; 100];
            write_session_data(&mut storage, DOMAIN, &mut session, 0, &data).unwrap();

            shrink_session_data(&mut storage, DOMAIN, &mut session, 50).unwrap();
            assert_eq!(session.total_data_length, 50);

            let total = crate::read::read_total_length(
                &storage,
                DOMAIN,
                session.session_version,
                session.session_index,
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
            let (mut session, _) = provision_all_sessions(&mut storage);

            let data: Vec<u8> = (0..200).map(|i| (i % 256) as u8).collect();
            write_session_data(&mut storage, DOMAIN, &mut session, 0, &data).unwrap();

            shrink_session_data(&mut storage, DOMAIN, &mut session, 100).unwrap();

            let result = read_session_data(&storage, DOMAIN, &session, 0, 100).unwrap();
            assert_eq!(&*result, &data[..100]);
        });
    }

    #[test]
    fn shrink_freed_blocks_become_cover() {
        run_with_stack(|| {
            let mut storage = MemoryStorage::new();
            let (mut session, _) = provision_all_sessions(&mut storage);

            // Write enough data to span multiple blocks
            let data_len = PLAINTEXT_SIZE * 3;
            let data = vec![0xBB; data_len];
            write_session_data(&mut storage, DOMAIN, &mut session, 0, &data).unwrap();

            // Shrink to fit in 1 block
            shrink_session_data(&mut storage, DOMAIN, &mut session, 10).unwrap();

            // Blocks beyond new_last_block should no longer be decryptable
            // (they are now cover blocks with throwaway AEAD keys)
            let result = decrypt_session_data_block(&storage, DOMAIN, &session, 2);
            assert!(result.is_err());
        });
    }

    #[test]
    fn shrink_all_sessions_updated_at_freed_indices() {
        run_with_stack(|| {
            let mut storage = MemoryStorage::new();
            let (mut session, _) = provision_all_sessions(&mut storage);

            let data_len = PLAINTEXT_SIZE * 3;
            let data = vec![0xCC; data_len];
            write_session_data(&mut storage, DOMAIN, &mut session, 0, &data).unwrap();

            // Snapshot block 2 for all sessions before shrink
            let mut before = Vec::new();
            for i in 0..SESSION_COUNT as u8 {
                let s = SessionIndex::new(i).unwrap();
                before.push(storage.read_block(s, 2).unwrap());
            }

            // Shrink to 1 block -- blocks 1 and 2 become freed
            shrink_session_data(&mut storage, DOMAIN, &mut session, 10).unwrap();

            // All sessions should have changed ciphertexts at the freed index
            for i in 0..SESSION_COUNT as u8 {
                let s = SessionIndex::new(i).unwrap();
                let after = storage.read_block(s, 2).unwrap();
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
            let (mut session, _) = provision_all_sessions(&mut storage);

            let data = vec![0xDD; 100];
            write_session_data(&mut storage, DOMAIN, &mut session, 0, &data).unwrap();

            shrink_session_data(&mut storage, DOMAIN, &mut session, 0).unwrap();
            assert_eq!(session.total_data_length, 0);

            let total = crate::read::read_total_length(
                &storage,
                DOMAIN,
                session.session_version,
                session.session_index,
                &session.pq_rerand_sk,
                session.root_aead_key.as_ref(),
            )
            .unwrap();
            assert_eq!(total, 0);

            // Blockstream length unchanged
            assert!(get_global_block_count(&storage).unwrap() >= 1);
        });
    }

    #[test]
    fn shrink_cross_block_boundary() {
        run_with_stack(|| {
            let mut storage = MemoryStorage::new();
            let (mut session, _) = provision_all_sessions(&mut storage);

            // Write across 3 blocks
            let data_len = PLAINTEXT_SIZE * 3;
            let data: Vec<u8> = (0..data_len).map(|i| (i % 256) as u8).collect();
            write_session_data(&mut storage, DOMAIN, &mut session, 0, &data).unwrap();

            let blocks_before = get_global_block_count(&storage).unwrap();

            // Shrink to 1.5 blocks worth of data
            let new_size = PLAINTEXT_SIZE + PLAINTEXT_SIZE / 2;
            shrink_session_data(&mut storage, DOMAIN, &mut session, new_size as u64).unwrap();

            // Blockstream length unchanged (blocks never removed)
            assert_eq!(get_global_block_count(&storage).unwrap(), blocks_before);

            // Data in the remaining range is intact
            let result = read_session_data(&storage, DOMAIN, &session, 0, new_size).unwrap();
            assert_eq!(&*result, &data[..new_size]);
        });
    }

    #[test]
    fn shrink_partial_block_tail_randomized() {
        run_with_stack(|| {
            let mut storage = MemoryStorage::new();
            let (mut session, _) = provision_all_sessions(&mut storage);

            // Fill exactly 1 block worth of data
            let data = vec![0xEE; PLAINTEXT_SIZE - LENGTH_HDR_SIZE];
            write_session_data(&mut storage, DOMAIN, &mut session, 0, &data).unwrap();

            // Read the full plaintext of block 0 before shrink
            let pt_before = decrypt_session_data_block(&storage, DOMAIN, &session, 0).unwrap();

            // Shrink to half the data
            let half = (PLAINTEXT_SIZE - LENGTH_HDR_SIZE) / 2;
            shrink_session_data(&mut storage, DOMAIN, &mut session, half as u64).unwrap();

            // Read the full plaintext of block 0 after shrink
            let pt_after = decrypt_session_data_block(&storage, DOMAIN, &session, 0).unwrap();

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
