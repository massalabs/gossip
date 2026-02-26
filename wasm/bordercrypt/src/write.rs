//! Write path: encrypt blocks with snapshot resistance and assemble session data.

use rand::RngCore;
use rand::seq::SliceRandom;
use zeroize::Zeroizing;

use crate::BLOCK_SIZE;
use crate::block::{create_cover_block, encrypt_block, rerandomize_block};
use crate::constants::{LENGTH_HDR_SIZE, PLAINTEXT_SIZE, SESSION_COUNT};
use crate::domain;
use crate::error::{BordercryptError, Result};
use crate::kdf::derive_block_aead_key;
use crate::keypair::read_session_version_and_pk;
use crate::pq::PqPublicKey;
use crate::read::decrypt_session_data_block;
use crate::storage::{BlockStorage, KeypairStorage};
use crate::types::SessionIndex;
use crate::unlock::UnlockedSession;

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
    // Prepare the genuine ciphertext for the target session
    let mut buf = String::new();
    let aead_key = derive_block_aead_key(
        &mut buf,
        domain,
        session.session_version,
        session.session_index,
        &*session.root_aead_key,
        block_index,
    );
    domain::block_aead_aad(
        &mut buf,
        domain,
        session.session_version,
        session.session_index,
        block_index,
    );
    let genuine_ct = encrypt_block(&session.pq_pk, &aead_key, &buf, plaintext);

    // Update all sessions at this block index in randomized order
    let mut indices: Vec<u8> = (0..SESSION_COUNT as u8).collect();
    indices.shuffle(&mut rand::rngs::OsRng);

    for &i in &indices {
        let cur_session = SessionIndex::new(i).expect("index within SESSION_COUNT");

        if cur_session == session.session_index {
            let ct_arr: &[u8; BLOCK_SIZE] = genuine_ct
                .as_slice()
                .try_into()
                .map_err(|_| BordercryptError::CorruptedBlock)?;
            storage.write_block(cur_session, block_index, ct_arr)?;
        } else {
            let (cur_version, cur_pk_bytes) = read_session_version_and_pk(storage, cur_session)?;
            let cur_pk = PqPublicKey::from_bytes(&cur_pk_bytes)?;

            let new_ct = match storage.read_block(cur_session, block_index) {
                Ok(existing_ct) => rerandomize_block(&cur_pk, &existing_ct),
                Err(_) => {
                    domain::block_aead_aad(&mut buf, domain, cur_version, cur_session, block_index);
                    create_cover_block(&cur_pk, &buf)
                }
            };
            let ct_arr: &[u8; BLOCK_SIZE] = new_ct
                .as_slice()
                .try_into()
                .map_err(|_| BordercryptError::CorruptedBlock)?;
            storage.write_block(cur_session, block_index, ct_arr)?;
        }
        storage.fsync(cur_session)?;
    }

    Ok(())
}

/// Returns the global block count (maximum across all sessions).
pub fn get_global_block_count<S: BlockStorage>(storage: &S) -> Result<u64> {
    let mut max_count = 0u64;
    for i in 0..SESSION_COUNT as u8 {
        let session = SessionIndex::new(i).expect("index within SESSION_COUNT");
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
    let mut buf = String::new();

    for i in 0..SESSION_COUNT as u8 {
        let session = SessionIndex::new(i).expect("index within SESSION_COUNT");
        let mut count = storage.block_count(session)?;

        while count < global_count {
            let (version, pk_bytes) = read_session_version_and_pk(storage, session)?;
            let pk = PqPublicKey::from_bytes(&pk_bytes)?;

            domain::block_aead_aad(&mut buf, domain, version, session, count);
            let cover = create_cover_block(&pk, &buf);
            let ct_arr: &[u8; BLOCK_SIZE] = cover
                .as_slice()
                .try_into()
                .map_err(|_| BordercryptError::CorruptedBlock)?;
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

    let mut indices: Vec<u8> = (0..SESSION_COUNT as u8).collect();
    indices.shuffle(&mut rand::rngs::OsRng);

    let mut buf = String::new();
    for &i in &indices {
        let cur_session = SessionIndex::new(i).expect("index within SESSION_COUNT");

        if cur_session == session.session_index {
            // Genuine block: random padding, with length header if block 0
            let mut pt = Zeroizing::new([0u8; PLAINTEXT_SIZE]);
            rand::rngs::OsRng.fill_bytes(pt.as_mut());
            if block_index == 0 {
                pt[..LENGTH_HDR_SIZE].copy_from_slice(&session.total_data_length.to_be_bytes());
            }

            let aead_key = derive_block_aead_key(
                &mut buf,
                domain,
                session.session_version,
                cur_session,
                &*session.root_aead_key,
                block_index,
            );
            domain::block_aead_aad(
                &mut buf,
                domain,
                session.session_version,
                cur_session,
                block_index,
            );
            let ct = encrypt_block(&session.pq_pk, &aead_key, &buf, &pt);
            let ct_arr: &[u8; BLOCK_SIZE] = ct
                .as_slice()
                .try_into()
                .map_err(|_| BordercryptError::CorruptedBlock)?;
            storage.append_block(cur_session, ct_arr)?;
        } else {
            let (cur_version, cur_pk_bytes) = read_session_version_and_pk(storage, cur_session)?;
            let cur_pk = PqPublicKey::from_bytes(&cur_pk_bytes)?;

            domain::block_aead_aad(&mut buf, domain, cur_version, cur_session, block_index);
            let cover = create_cover_block(&cur_pk, &buf);
            let ct_arr: &[u8; BLOCK_SIZE] = cover
                .as_slice()
                .try_into()
                .map_err(|_| BordercryptError::CorruptedBlock)?;
            storage.append_block(cur_session, ct_arr)?;
        }
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
    if data.is_empty() {
        return Ok(());
    }

    let data_len = data.len() as u64;
    let old_total = session.total_data_length;
    let new_total = old_total.max(
        offset
            .checked_add(data_len)
            .ok_or(BordercryptError::Overflow)?,
    );
    session.total_data_length = new_total;

    // Ensure enough blocks exist
    let ps = PLAINTEXT_SIZE as u64;
    let hdr = LENGTH_HDR_SIZE as u64;
    let required_last_block = if new_total == 0 {
        0
    } else {
        hdr.checked_add(new_total - 1)
            .ok_or(BordercryptError::Overflow)?
            / ps
    };
    ensure_block_count(storage, domain, session, required_last_block + 1)?;

    // Map logical data offset to virtual plaintext stream position
    let start_pos = hdr.checked_add(offset).ok_or(BordercryptError::Overflow)?;
    let end_pos = hdr
        .checked_add(offset)
        .ok_or(BordercryptError::Overflow)?
        .checked_add(data_len)
        .ok_or(BordercryptError::Overflow)?;

    let first_block = start_pos / ps;
    let last_block = end_pos.checked_sub(1).ok_or(BordercryptError::Overflow)? / ps;

    for b in first_block..=last_block {
        let block_start = b * ps;
        let block_end = block_start + ps;

        let w_start = start_pos.max(block_start);
        let w_end = end_pos.min(block_end);

        // Full overwrite optimization: skip decrypt for non-block-0 fully overwritten blocks
        let full_overwrite = w_start == block_start && w_end == block_end && b != 0;

        let mut pt = Zeroizing::new([0u8; PLAINTEXT_SIZE]);
        if full_overwrite {
            rand::rngs::OsRng.fill_bytes(pt.as_mut());
        } else {
            match decrypt_session_data_block(storage, domain, session, b) {
                Ok(existing) => pt.copy_from_slice(&*existing),
                Err(_) => rand::rngs::OsRng.fill_bytes(pt.as_mut()),
            }
        }

        // Copy data into the plaintext
        let src_off = (w_start - start_pos) as usize;
        let src_len = (w_end - w_start) as usize;
        let dst_off = (w_start - block_start) as usize;
        pt[dst_off..dst_off + src_len].copy_from_slice(&data[src_off..src_off + src_len]);

        // Block 0 always carries the length header
        if b == 0 {
            pt[..LENGTH_HDR_SIZE].copy_from_slice(&new_total.to_be_bytes());
        }

        encrypt_session_data_block(storage, domain, session, b, &pt)?;
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::keypair::KeypairFile;
    use crate::pq::{PqPublicKey, PqSecretKey, pq_keygen};
    use crate::read::read_session_data;
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

            // Write a dummy keypair file (version 0, no real encryption of sk)
            let aad = domain::sk_wrap_aad(DOMAIN, 0, session);
            let mut nonce_bytes = [0u8; crypto_aead::NONCE_SIZE];
            rand::rngs::OsRng.fill_bytes(&mut nonce_bytes);
            let nonce = crypto_aead::Nonce::from(nonce_bytes);
            // Use a fixed wrap key for testing
            let wrap_key = crypto_aead::Key::from([0xBB; crypto_aead::KEY_SIZE]);
            let sk_ct = crypto_aead::encrypt(&wrap_key, &nonce, &*sk.to_bytes(), aad.as_bytes());

            let kf = KeypairFile {
                version: 0,
                pq_pk: pk.to_bytes(),
                sk_nonce: nonce_bytes,
                sk_ct,
            };
            storage.write_keypair(session, &kf.serialize()).unwrap();
            all_keys.push((pk, sk));
        }

        let root_aead_key = Zeroizing::new([0xAA; crypto_aead::KEY_SIZE]);
        let (ref pk, ref sk) = all_keys[0];
        let session = UnlockedSession {
            session_index: SessionIndex::new(0).unwrap(),
            session_version: 0,
            pq_pk: PqPublicKey::from_bytes(&pk.to_bytes()).unwrap(),
            pq_sk: PqSecretKey::from_bytes(&sk.to_bytes()).unwrap(),
            root_aead_key,
            total_data_length: 0,
        };

        (session, all_keys)
    }

    // --- commit 12: encrypt_session_data_block ---

    #[test]
    fn write_then_read_block() {
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
    }

    #[test]
    fn all_sessions_updated() {
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
    }

    #[test]
    fn other_sessions_rerandomized() {
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
    }

    // --- commit 13: blockstream extension and repair ---

    #[test]
    fn repair_aligns_lengths() {
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
    }

    #[test]
    fn extend_adds_to_all() {
        let mut storage = MemoryStorage::new();
        let (session, _) = provision_all_sessions(&mut storage);

        ensure_block_count(&mut storage, DOMAIN, &session, 1).unwrap();

        for i in 0..SESSION_COUNT as u8 {
            let s = SessionIndex::new(i).unwrap();
            assert_eq!(storage.block_count(s).unwrap(), 1);
        }
    }

    #[test]
    fn ensure_idempotent() {
        let mut storage = MemoryStorage::new();
        let (session, _) = provision_all_sessions(&mut storage);

        ensure_block_count(&mut storage, DOMAIN, &session, 3).unwrap();
        let count_before = get_global_block_count(&storage).unwrap();

        ensure_block_count(&mut storage, DOMAIN, &session, 3).unwrap();
        let count_after = get_global_block_count(&storage).unwrap();

        assert_eq!(count_before, count_after);
    }

    // --- commit 14: write_session_data ---

    #[test]
    fn write_then_read_roundtrip() {
        let mut storage = MemoryStorage::new();
        let (mut session, _) = provision_all_sessions(&mut storage);

        let data = b"hello, bordercrypt!";
        write_session_data(&mut storage, DOMAIN, &mut session, 0, data).unwrap();

        let result = read_session_data(&storage, DOMAIN, &session, 0, data.len()).unwrap();
        assert_eq!(&*result, data);
    }

    #[test]
    fn write_extends_storage() {
        let mut storage = MemoryStorage::new();
        let (mut session, _) = provision_all_sessions(&mut storage);

        assert_eq!(get_global_block_count(&storage).unwrap(), 0);

        let data = vec![0xAB; 100];
        write_session_data(&mut storage, DOMAIN, &mut session, 0, &data).unwrap();

        assert!(get_global_block_count(&storage).unwrap() >= 1);
    }

    #[test]
    fn write_updates_total_length() {
        let mut storage = MemoryStorage::new();
        let (mut session, _) = provision_all_sessions(&mut storage);

        let data = vec![0; 200];
        write_session_data(&mut storage, DOMAIN, &mut session, 0, &data).unwrap();

        assert_eq!(session.total_data_length, 200);
    }

    #[test]
    fn partial_overwrite() {
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
    }

    #[test]
    fn write_block_0_preserves_header() {
        let mut storage = MemoryStorage::new();
        let (mut session, _) = provision_all_sessions(&mut storage);

        let data = vec![0xCC; 50];
        write_session_data(&mut storage, DOMAIN, &mut session, 0, &data).unwrap();

        // Read total length from block 0 header
        let total = crate::read::read_total_length(&storage, DOMAIN, &session).unwrap();
        assert_eq!(total, 50);
    }

    #[test]
    fn append_pattern() {
        let mut storage = MemoryStorage::new();
        let (mut session, _) = provision_all_sessions(&mut storage);

        write_session_data(&mut storage, DOMAIN, &mut session, 0, b"hello").unwrap();
        write_session_data(&mut storage, DOMAIN, &mut session, 5, b" world").unwrap();

        let result = read_session_data(&storage, DOMAIN, &session, 0, 11).unwrap();
        assert_eq!(&*result, b"hello world");
    }

    #[test]
    fn write_cross_block() {
        let mut storage = MemoryStorage::new();
        let (mut session, _) = provision_all_sessions(&mut storage);

        // Write data that spans multiple blocks
        let data_len = PLAINTEXT_SIZE * 2;
        let data: Vec<u8> = (0..data_len).map(|i| (i % 256) as u8).collect();
        write_session_data(&mut storage, DOMAIN, &mut session, 0, &data).unwrap();

        let result = read_session_data(&storage, DOMAIN, &session, 0, data_len).unwrap();
        assert_eq!(&*result, &data);
    }

    #[test]
    fn write_empty_is_noop() {
        let mut storage = MemoryStorage::new();
        let (mut session, _) = provision_all_sessions(&mut storage);

        write_session_data(&mut storage, DOMAIN, &mut session, 0, &[]).unwrap();
        assert_eq!(session.total_data_length, 0);
        assert_eq!(get_global_block_count(&storage).unwrap(), 0);
    }
}
