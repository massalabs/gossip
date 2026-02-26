//! Read path: decrypt individual blocks and assemble session data.

use zeroize::Zeroizing;

use crate::block::decrypt_block;
use crate::constants::{LENGTH_HDR_SIZE, PLAINTEXT_SIZE};
use crate::domain;
use crate::error::{BordercryptError, Result};
use crate::kdf::derive_block_aead_key;
use crate::storage::BlockStorage;
use crate::unlock::UnlockedSession;

/// Decrypt a single data block from an unlocked session.
pub fn decrypt_session_data_block<S: BlockStorage>(
    storage: &S,
    domain: &str,
    session: &UnlockedSession,
    block_index: u64,
) -> Result<Zeroizing<[u8; PLAINTEXT_SIZE]>> {
    let block_ct = storage.read_block(session.session_index, block_index)?;

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

    decrypt_block(&session.pq_sk, &aead_key, &buf, &block_ct)
}

/// Read total data length from block 0 of an unlocked session.
///
/// Returns 0 if the session has no blocks.
pub fn read_total_length<S: BlockStorage>(
    storage: &S,
    domain: &str,
    session: &UnlockedSession,
) -> Result<u64> {
    crate::unlock::read_total_length(
        storage,
        domain,
        session.session_version,
        session.session_index,
        &session.pq_sk,
        &session.root_aead_key,
    )
}

/// Read session data from an offset for a given length.
///
/// Analogous to `pread(fd, buf, count, offset)` — determines which blocks
/// to read, decrypts them, and assembles the relevant slices.
///
/// Block 0 has an 8-byte length header before data, so logical offset 0
/// maps to position `LENGTH_HDR_SIZE` in block 0's plaintext.
pub fn read_session_data<S: BlockStorage>(
    storage: &S,
    domain: &str,
    session: &UnlockedSession,
    offset: u64,
    length: usize,
) -> Result<Zeroizing<Vec<u8>>> {
    if length == 0 {
        return Ok(Zeroizing::new(Vec::new()));
    }

    // Bounds check
    let end = offset
        .checked_add(length as u64)
        .ok_or(BordercryptError::Overflow)?;
    if end > session.total_data_length {
        return Err(BordercryptError::OutOfBounds);
    }

    let ps = PLAINTEXT_SIZE as u64;
    let hdr = LENGTH_HDR_SIZE as u64;

    // Map logical data offset to virtual plaintext stream position
    let start_pos = hdr.checked_add(offset).ok_or(BordercryptError::Overflow)?;
    let end_pos = hdr.checked_add(end).ok_or(BordercryptError::Overflow)?;

    let first_block = start_pos / ps;
    let last_block = end_pos.checked_sub(1).ok_or(BordercryptError::Overflow)? / ps;

    let mut result = Zeroizing::new(Vec::with_capacity(length));

    let mut buf = String::new();
    for block_idx in first_block..=last_block {
        let block_ct = storage.read_block(session.session_index, block_idx)?;

        let aead_key = derive_block_aead_key(
            &mut buf,
            domain,
            session.session_version,
            session.session_index,
            &*session.root_aead_key,
            block_idx,
        );
        domain::block_aead_aad(
            &mut buf,
            domain,
            session.session_version,
            session.session_index,
            block_idx,
        );

        let plaintext = decrypt_block(&session.pq_sk, &aead_key, &buf, &block_ct)?;

        // Determine the slice within this block's plaintext
        let block_start = block_idx * ps;
        let slice_start = if start_pos > block_start {
            (start_pos - block_start) as usize
        } else {
            0
        };
        let slice_end = if end_pos < block_start + ps {
            (end_pos - block_start) as usize
        } else {
            PLAINTEXT_SIZE
        };

        result.extend_from_slice(&plaintext[slice_start..slice_end]);
    }

    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::block::encrypt_block;
    use crate::pq::pq_keygen;
    use crate::storage::MemoryStorage;
    use crate::types::SessionIndex;

    const DOMAIN: &str = "test";

    /// Build an UnlockedSession for testing (no password KDF, direct key setup).
    fn test_session() -> (UnlockedSession, [u8; crypto_aead::KEY_SIZE]) {
        let (pq_pk, pq_sk) = pq_keygen();
        let root_aead_key = [0xAA; crypto_aead::KEY_SIZE];

        let session = UnlockedSession {
            session_index: SessionIndex::new(0).unwrap(),
            session_version: 0,
            pq_pk,
            pq_sk,
            root_aead_key: Zeroizing::new(root_aead_key),
            total_data_length: 0,
        };
        (session, root_aead_key)
    }

    /// Encrypt and append a block to storage.
    fn write_test_block(
        storage: &mut MemoryStorage,
        session: &UnlockedSession,
        block_index: u64,
        plaintext: &[u8; PLAINTEXT_SIZE],
    ) {
        let mut buf = String::new();
        let aead_key = derive_block_aead_key(
            &mut buf,
            DOMAIN,
            session.session_version,
            session.session_index,
            &*session.root_aead_key,
            block_index,
        );
        domain::block_aead_aad(
            &mut buf,
            DOMAIN,
            session.session_version,
            session.session_index,
            block_index,
        );

        let ct = encrypt_block(&session.pq_pk, &aead_key, &buf, plaintext);
        let ct_arr: &[u8; crate::BLOCK_SIZE] = ct.as_slice().try_into().unwrap();
        storage.append_block(session.session_index, ct_arr).unwrap();
    }

    // --- commit 10: decrypt_session_data_block + read_total_length ---

    #[test]
    fn decrypt_block_roundtrip() {
        let mut storage = MemoryStorage::new();
        let (session, _) = test_session();

        let mut pt = [0u8; PLAINTEXT_SIZE];
        pt[0] = 0x42;
        pt[PLAINTEXT_SIZE - 1] = 0xFF;
        write_test_block(&mut storage, &session, 0, &pt);

        let decrypted = decrypt_session_data_block(&storage, DOMAIN, &session, 0).unwrap();
        assert_eq!(*decrypted, pt);
    }

    #[test]
    fn test_read_total_length() {
        let mut storage = MemoryStorage::new();
        let (mut session, _) = test_session();

        let mut pt = [0u8; PLAINTEXT_SIZE];
        pt[..8].copy_from_slice(&42u64.to_be_bytes());
        write_test_block(&mut storage, &session, 0, &pt);
        session.total_data_length = 42;

        let len = read_total_length(&storage, DOMAIN, &session).unwrap();
        assert_eq!(len, 42);
    }

    #[test]
    fn decrypt_cover_block_fails() {
        let mut storage = MemoryStorage::new();
        let (session, _) = test_session();

        let cover = crate::block::create_cover_block(&session.pq_pk, "some_aad");
        let ct_arr: &[u8; crate::BLOCK_SIZE] = cover.as_slice().try_into().unwrap();
        storage.append_block(session.session_index, ct_arr).unwrap();

        assert!(decrypt_session_data_block(&storage, DOMAIN, &session, 0).is_err());
    }

    // --- commit 11: read_session_data ---

    /// Helper: write data across blocks, with the length header in block 0.
    fn write_session_data_for_test(
        storage: &mut MemoryStorage,
        session: &mut UnlockedSession,
        data: &[u8],
    ) {
        let total = data.len() as u64;
        let hdr = LENGTH_HDR_SIZE;
        let ps = PLAINTEXT_SIZE;

        // Build virtual plaintext stream: [length_header || data]
        let stream_len = hdr + data.len();
        let num_blocks = (stream_len + ps - 1) / ps;

        for b in 0..num_blocks {
            let mut pt = [0u8; PLAINTEXT_SIZE];
            let block_offset = b * ps;
            for (i, byte) in pt.iter_mut().enumerate() {
                let stream_pos = block_offset + i;
                if stream_pos < hdr {
                    *byte = total.to_be_bytes()[stream_pos];
                } else if stream_pos - hdr < data.len() {
                    *byte = data[stream_pos - hdr];
                }
            }
            write_test_block(storage, session, b as u64, &pt);
        }

        session.total_data_length = total;
    }

    #[test]
    fn read_single_block() {
        let mut storage = MemoryStorage::new();
        let (mut session, _) = test_session();

        let data = vec![0xAB; 100];
        write_session_data_for_test(&mut storage, &mut session, &data);

        let result = read_session_data(&storage, DOMAIN, &session, 0, 100).unwrap();
        assert_eq!(*result, data);
    }

    #[test]
    fn read_cross_block() {
        let mut storage = MemoryStorage::new();
        let (mut session, _) = test_session();

        // Data that spans block boundary
        let data_len = PLAINTEXT_SIZE * 2 - LENGTH_HDR_SIZE;
        let data: Vec<u8> = (0..data_len).map(|i| (i % 256) as u8).collect();
        write_session_data_for_test(&mut storage, &mut session, &data);

        let result = read_session_data(&storage, DOMAIN, &session, 0, data_len).unwrap();
        assert_eq!(*result, data);
    }

    #[test]
    fn read_from_offset() {
        let mut storage = MemoryStorage::new();
        let (mut session, _) = test_session();

        let data = vec![0xCD; 200];
        write_session_data_for_test(&mut storage, &mut session, &data);

        let result = read_session_data(&storage, DOMAIN, &session, 50, 100).unwrap();
        assert_eq!(*result, vec![0xCD; 100]);
    }

    #[test]
    fn read_out_of_bounds() {
        let mut storage = MemoryStorage::new();
        let (mut session, _) = test_session();

        let data = vec![0; 100];
        write_session_data_for_test(&mut storage, &mut session, &data);

        assert!(read_session_data(&storage, DOMAIN, &session, 50, 100).is_err());
    }

    #[test]
    fn read_zero_length() {
        let mut storage = MemoryStorage::new();
        let (mut session, _) = test_session();

        let data = vec![0; 100];
        write_session_data_for_test(&mut storage, &mut session, &data);

        let result = read_session_data(&storage, DOMAIN, &session, 0, 0).unwrap();
        assert!(result.is_empty());
    }

    #[test]
    fn read_entire_session() {
        let mut storage = MemoryStorage::new();
        let (mut session, _) = test_session();

        let data: Vec<u8> = (0..500).map(|i| (i % 256) as u8).collect();
        write_session_data_for_test(&mut storage, &mut session, &data);

        let result = read_session_data(&storage, DOMAIN, &session, 0, data.len()).unwrap();
        assert_eq!(*result, data);
    }
}
