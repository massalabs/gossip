//! Pending write buffer for the encrypted VFS.

use zeroize::Zeroize;

use crate::error::Result;
use crate::storage::{BlockStorage, KeypairStorage};
use crate::unlock::{NamespaceState, UnlockedSession};

/// A buffered plaintext write at a given offset.
pub(crate) struct PendingWrite {
    pub offset: u64,
    pub data: Vec<u8>,
}

impl Drop for PendingWrite {
    fn drop(&mut self) {
        self.data.zeroize();
    }
}

/// Coalesce pending writes by block group and encrypt only the affected blocks.
///
/// Grows the stream to `file_size` if it is shorter after the writes, by
/// writing the missing zeros: the length is persisted by `write_session_data`
/// only (see its "Length header" section), never by setting it in `ns_state`.
/// Does not commit the backend; the caller is responsible for that.
///
/// # A flush that fails is not rolled back
///
/// This function writes block after block into the backend, where the
/// blocks are staged until the backend is committed. When a write fails
/// midway it returns the error, and the blocks written so far stay staged:
/// nothing takes them back. `EncryptedFileCore::sync` keeps its pending
/// writes in that case, so the next flush writes all of them again and
/// completes the change.
///
/// Until that next flush the staged blocks hold a half-applied change. The
/// simplest form: a flush that only rewrites bytes inside the file (same
/// length before and after) has updated some of its blocks and not the
/// others. The length is right, the content is a mix of old and new pages.
///
/// The backend has one set of staged blocks and one commit for everything.
/// A commit made for another reason therefore persists the half-applied
/// change with it:
///
/// * in the browser, `IdbBlockStorage::persist_dirty`, which the worker
///   runs after a cover traffic tick and after a write to another namespace
///   (`flushEncrypted` in `secure-storage-worker-api.ts`);
/// * on iOS and Android, `RedbStorage::commit`, which
///   `run_cover_scheduler_tick` and `write_namespace_data` call in
///   `native_vfs.rs`.
///
/// If the process stops after such a commit and before the next successful
/// flush, the half-applied change is what the next unlock finds. SQLite
/// cannot repair it: its rollback journal is kept in memory
/// (`journal_mode = MEMORY`) and is gone with the process.
///
/// This needs a flush to fail first. Both backends stage block writes in
/// memory, so in practice that is a block of this session that cannot be
/// read back or does not decrypt. Closing the gap would take a way to
/// discard the blocks one flush staged without touching the others; neither
/// backend offers one today (`RedbStorage::discard_pending` drops
/// everything staged, cover blocks included).
///
/// Each call to `write_session_data` drains its own rerand pool entries
/// before returning, so this function does not need an additional flush
/// — the pool is empty for `namespace` by the time we exit.
pub(crate) fn flush_writes<S: BlockStorage + KeypairStorage>(
    backend: &mut S,
    domain: &str,
    namespace: u8,
    session: &UnlockedSession,
    ns_state: &mut NamespaceState,
    writes: &[PendingWrite],
    file_size: u64,
) -> Result<()> {
    if writes.is_empty() {
        // No bytes to write, but the file may have been grown (a truncate to
        // a larger size with no write after it).
        return grow_with_zeros(
            backend,
            domain,
            namespace,
            session,
            ns_state,
            file_size,
            ZERO_FILL_CHUNK,
        );
    }

    if writes.len() == 1 {
        crate::write_session_data(
            backend,
            domain,
            namespace,
            session,
            ns_state,
            writes[0].offset,
            &writes[0].data,
        )?;
    } else {
        let groups = group_by_contiguous_blocks(writes);
        // Groups are rounded up to whole blocks; the file ends where its
        // content does, not at the end of the last block.
        let content_end = file_size.max(ns_state.total_data_length);
        for &(group_off, group_end) in &groups {
            let span = (group_end.min(content_end) - group_off) as usize;
            let mut buf = vec![0u8; span];

            // Seed buf with persisted bytes that fall inside this group; the
            // rest stays zero-filled and will be overwritten by apply_pending_overlay.
            if ns_state.total_data_length > group_off {
                let readable = ((ns_state.total_data_length - group_off) as usize).min(span);
                let existing = crate::read_session_data(
                    backend, domain, namespace, session, ns_state, group_off, readable,
                )?;
                buf[..readable].copy_from_slice(&existing);
            }

            // Overlay pending writes in buffering order (last-write-wins) —
            // same helper used by the read path, so read and flush agree by
            // construction.
            apply_pending_overlay(writes, group_off, &mut buf);

            crate::write_session_data(
                backend, domain, namespace, session, ns_state, group_off, &buf,
            )?;
        }
    }

    // A file grown past its last write (truncate to a larger size) reads as
    // zeros there. Write them, so the length is persisted with the bytes.
    grow_with_zeros(
        backend,
        domain,
        namespace,
        session,
        ns_state,
        file_size,
        ZERO_FILL_CHUNK,
    )
}

/// Largest run of zeros written at once when a file is grown.
const ZERO_FILL_CHUNK: usize = 64 * crate::constants::PLAINTEXT_SIZE;

/// Grow the stream to `file_size` by writing zeros, at most `chunk` bytes per
/// write. Does nothing when the stream is already that long.
///
/// The zeros are written in chunks so that neither the buffer nor a length
/// has to hold the whole growth: `file_size` is a `u64` and may exceed what a
/// `usize` holds on a 32-bit target. Each chunk is a complete write, with its
/// length persisted, so a failure leaves a shorter but consistent stream.
fn grow_with_zeros<S: BlockStorage + KeypairStorage>(
    backend: &mut S,
    domain: &str,
    namespace: u8,
    session: &UnlockedSession,
    ns_state: &mut NamespaceState,
    file_size: u64,
    chunk: usize,
) -> Result<()> {
    if file_size <= ns_state.total_data_length {
        return Ok(());
    }
    let zeros = vec![0u8; chunk];
    while ns_state.total_data_length < file_size {
        let from = ns_state.total_data_length;
        // bounded by `chunk`, so the conversion cannot truncate
        let len = usize::try_from(file_size - from).map_or(chunk, |left| left.min(chunk));
        crate::write_session_data(
            backend,
            domain,
            namespace,
            session,
            ns_state,
            from,
            &zeros[..len],
        )?;
    }
    Ok(())
}

/// Group writes into contiguous block-aligned ranges.
fn group_by_contiguous_blocks(writes: &[PendingWrite]) -> Vec<(u64, u64)> {
    use crate::constants::PLAINTEXT_SIZE;
    let block_size = PLAINTEXT_SIZE as u64;

    let mut ranges: Vec<(u64, u64)> = writes
        .iter()
        .map(|pw| {
            let first = (pw.offset / block_size) * block_size;
            let last_byte = pw.offset.saturating_add(pw.data.len() as u64);
            let end = last_byte.saturating_add(block_size - 1) / block_size * block_size;
            (first, end)
        })
        .collect();

    ranges.sort_unstable();

    let mut merged: Vec<(u64, u64)> = Vec::with_capacity(ranges.len());
    for (start, end) in ranges {
        if let Some(last) = merged.last_mut() {
            if start <= last.1 {
                last.1 = last.1.max(end);
                continue;
            }
        }
        merged.push((start, end));
    }
    merged
}

/// Apply pending writes as an overlay onto `dst`, which covers the byte range
/// `[dst_base, dst_base + dst.len())`. Later writes in `pending` overwrite
/// earlier ones on any byte they both cover (last-write-wins).
pub(crate) fn apply_pending_overlay(pending: &[PendingWrite], dst_base: u64, dst: &mut [u8]) {
    let dst_end = dst_base.saturating_add(dst.len() as u64);
    for pw in pending {
        let pw_end = pw.offset.saturating_add(pw.data.len() as u64);
        // Intersect the pending write's range with the dst range.
        let overlap_start = pw.offset.max(dst_base);
        let overlap_end = pw_end.min(dst_end);
        if overlap_start >= overlap_end {
            continue;
        }
        // Offsets into the source (pw.data) and destination (dst) buffers.
        // Non-negative by construction: overlap_start >= both bases.
        let src_off = (overlap_start - pw.offset) as usize;
        let dst_off = (overlap_start - dst_base) as usize;
        let len = (overlap_end - overlap_start) as usize;
        dst[dst_off..dst_off + len].copy_from_slice(&pw.data[src_off..src_off + len]);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::DEFAULT_NAMESPACE;
    use crate::constants::PLAINTEXT_SIZE;
    use crate::storage::MemoryStorage;
    use crate::types::SessionIndex;
    use crate::unlock::{NamespaceState, load_namespace_state};
    use crate::{allocate_session, provision_storage, read_session_data};

    const DOMAIN: &str = "pending-tests";
    const NS: u8 = DEFAULT_NAMESPACE;

    fn pw(offset: u64, data: &[u8]) -> PendingWrite {
        PendingWrite {
            offset,
            data: data.to_vec(),
        }
    }

    // ── apply_pending_overlay ──

    #[test]
    fn overlay_no_pending_leaves_dst_unchanged() {
        let mut dst = vec![1u8; 16];
        apply_pending_overlay(&[], 0, &mut dst);
        assert_eq!(dst, vec![1u8; 16]);
    }

    #[test]
    fn overlay_full_overwrite() {
        let mut dst = vec![0u8; 8];
        apply_pending_overlay(&[pw(0, &[9; 8])], 0, &mut dst);
        assert_eq!(dst, vec![9u8; 8]);
    }

    #[test]
    fn overlay_partial_overwrite_at_start() {
        let mut dst = vec![0u8; 8];
        apply_pending_overlay(&[pw(0, &[9, 9, 9, 9])], 0, &mut dst);
        assert_eq!(dst, vec![9, 9, 9, 9, 0, 0, 0, 0]);
    }

    #[test]
    fn overlay_partial_overwrite_in_middle() {
        let mut dst = vec![0u8; 8];
        apply_pending_overlay(&[pw(2, &[9, 9, 9])], 0, &mut dst);
        assert_eq!(dst, vec![0, 0, 9, 9, 9, 0, 0, 0]);
    }

    #[test]
    fn overlay_pending_outside_read_range_is_ignored() {
        let mut dst = vec![0u8; 8];
        apply_pending_overlay(&[pw(100, &[9; 4])], 0, &mut dst);
        assert_eq!(dst, vec![0u8; 8]);
    }

    #[test]
    fn overlay_pending_starts_before_read_range() {
        let mut dst = vec![0u8; 8];
        // Pending [4..12), read window [8..16): overlap is [8..12)
        apply_pending_overlay(&[pw(4, &[9; 8])], 8, &mut dst);
        assert_eq!(dst, vec![9, 9, 9, 9, 0, 0, 0, 0]);
    }

    #[test]
    fn overlay_pending_ends_after_read_range() {
        let mut dst = vec![0u8; 8];
        // Pending [4..16), read window [0..8): overlap is [4..8)
        apply_pending_overlay(&[pw(4, &[9; 12])], 0, &mut dst);
        assert_eq!(dst, vec![0, 0, 0, 0, 9, 9, 9, 9]);
    }

    #[test]
    fn overlay_multiple_pending_last_wins() {
        let mut dst = vec![0u8; 8];
        apply_pending_overlay(
            &[pw(0, &[1, 1, 1, 1, 1, 1, 1, 1]), pw(2, &[2, 2, 2, 2])],
            0,
            &mut dst,
        );
        // The second pending overwrites bytes 2..6
        assert_eq!(dst, vec![1, 1, 2, 2, 2, 2, 1, 1]);
    }

    // ── group_by_contiguous_blocks ──

    #[test]
    fn group_single_write_one_range() {
        let writes = vec![pw(0, &[0; 10])];
        let groups = group_by_contiguous_blocks(&writes);
        assert_eq!(groups.len(), 1);
    }

    #[test]
    fn group_two_adjacent_writes_merge() {
        let bs = PLAINTEXT_SIZE as u64;
        // Both writes fall into the same first block
        let writes = vec![pw(0, &[0; 10]), pw(20, &[0; 10])];
        let groups = group_by_contiguous_blocks(&writes);
        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0], (0, bs));
    }

    #[test]
    fn group_two_far_writes_stay_separate() {
        let bs = PLAINTEXT_SIZE as u64;
        // Block 0 vs block 19 — far apart
        let writes = vec![pw(0, &[0; 10]), pw(19 * bs, &[0; 10])];
        let groups = group_by_contiguous_blocks(&writes);
        assert_eq!(groups.len(), 2);
        assert_eq!(groups[0], (0, bs));
        assert_eq!(groups[1], (19 * bs, 20 * bs));
    }

    #[test]
    fn group_unsorted_writes_get_sorted() {
        let bs = PLAINTEXT_SIZE as u64;
        let writes = vec![pw(19 * bs, &[0; 10]), pw(0, &[0; 10])];
        let groups = group_by_contiguous_blocks(&writes);
        assert_eq!(groups.len(), 2);
        assert!(groups[0].0 < groups[1].0);
    }

    // ── flush_writes (end-to-end with MemoryStorage) ──

    fn fresh_session() -> (MemoryStorage, UnlockedSession, NamespaceState) {
        let mut storage = MemoryStorage::new();
        provision_storage(&mut storage).unwrap();
        let slot = SessionIndex::new(0).unwrap();
        let session = allocate_session(&mut storage, DOMAIN, slot, b"test-pw").unwrap();
        let ns_state = load_namespace_state(&storage, DOMAIN, &session, NS).unwrap();
        (storage, session, ns_state)
    }

    #[test]
    fn flush_empty_is_noop() {
        crate::run_with_stack(|| {
            let (mut storage, session, mut ns_state) = fresh_session();
            let total_before = ns_state.total_data_length;
            flush_writes(&mut storage, DOMAIN, NS, &session, &mut ns_state, &[], 0).unwrap();
            assert_eq!(ns_state.total_data_length, total_before);
        });
    }

    #[test]
    fn flush_single_write_persists() {
        crate::run_with_stack(|| {
            let (mut storage, session, mut ns_state) = fresh_session();
            let writes = vec![pw(0, b"hello")];
            flush_writes(
                &mut storage,
                DOMAIN,
                NS,
                &session,
                &mut ns_state,
                &writes,
                5,
            )
            .unwrap();

            let read = read_session_data(&storage, DOMAIN, NS, &session, &ns_state, 0, 5).unwrap();
            assert_eq!(&*read, b"hello");
        });
    }

    #[test]
    fn flush_multiple_adjacent_writes_persist() {
        crate::run_with_stack(|| {
            let (mut storage, session, mut ns_state) = fresh_session();
            let writes = vec![pw(0, b"hello"), pw(5, b" world")];
            flush_writes(
                &mut storage,
                DOMAIN,
                NS,
                &session,
                &mut ns_state,
                &writes,
                11,
            )
            .unwrap();

            let read = read_session_data(&storage, DOMAIN, NS, &session, &ns_state, 0, 11).unwrap();
            assert_eq!(&*read, b"hello world");
        });
    }

    #[test]
    fn flush_overlapping_writes_last_wins() {
        crate::run_with_stack(|| {
            let (mut storage, session, mut ns_state) = fresh_session();
            let writes = vec![pw(0, b"AAAAAAAA"), pw(2, b"BB")];
            flush_writes(
                &mut storage,
                DOMAIN,
                NS,
                &session,
                &mut ns_state,
                &writes,
                8,
            )
            .unwrap();

            let read = read_session_data(&storage, DOMAIN, NS, &session, &ns_state, 0, 8).unwrap();
            assert_eq!(&*read, b"AABBAAAA");
        });
    }

    /// Two partially-overlapping writes: first covers offsets 1-4, second covers
    /// 3-5. Last-write-wins on the intersection (3-4), first write owns 1-2,
    /// second write owns 5.
    #[test]
    fn flush_partial_overlap_second_wins_on_intersection() {
        crate::run_with_stack(|| {
            let (mut storage, session, mut ns_state) = fresh_session();
            let writes = vec![pw(1, &[1, 2, 3, 4]), pw(3, &[5, 6, 7])];
            flush_writes(
                &mut storage,
                DOMAIN,
                NS,
                &session,
                &mut ns_state,
                &writes,
                6,
            )
            .unwrap();

            let read = read_session_data(&storage, DOMAIN, NS, &session, &ns_state, 0, 6).unwrap();
            // Expected: offset 0 untouched (0), 1-2 from first write, 3-5 from second.
            assert_eq!(&*read, &[0, 1, 2, 5, 6, 7]);
        });
    }

    /// Two writes to the exact same offset and length: the second must fully
    /// override the first (models SQLite rewriting the same page twice in a
    /// transaction).
    #[test]
    fn flush_same_offset_second_fully_overrides() {
        crate::run_with_stack(|| {
            let (mut storage, session, mut ns_state) = fresh_session();
            let writes = vec![pw(0, b"firstpass"), pw(0, b"secondpas")];
            flush_writes(
                &mut storage,
                DOMAIN,
                NS,
                &session,
                &mut ns_state,
                &writes,
                9,
            )
            .unwrap();

            let read = read_session_data(&storage, DOMAIN, NS, &session, &ns_state, 0, 9).unwrap();
            assert_eq!(&*read, b"secondpas");
        });
    }

    /// Writes buffered in descending offset order still apply in buffering
    /// order, not sorted order — the internal sort_unstable is used only for
    /// contiguous-block grouping, not for ordering the application of writes.
    #[test]
    fn flush_applies_in_buffering_order_regardless_of_offset() {
        crate::run_with_stack(|| {
            let (mut storage, session, mut ns_state) = fresh_session();
            // Insertion order: high offset first, then low offset. They overlap.
            let writes = vec![pw(2, &[9, 9, 9, 9, 9]), pw(0, &[1, 1, 1, 1, 1, 1])];
            flush_writes(
                &mut storage,
                DOMAIN,
                NS,
                &session,
                &mut ns_state,
                &writes,
                7,
            )
            .unwrap();

            let read = read_session_data(&storage, DOMAIN, NS, &session, &ns_state, 0, 7).unwrap();
            // pw(2, [9,9,9,9,9]) fills offsets 2-6 with 9
            // pw(0, [1,1,1,1,1,1]) fills offsets 0-5 with 1 — applied AFTER,
            // so 0-5 become 1, and only offset 6 stays 9.
            assert_eq!(&*read, &[1, 1, 1, 1, 1, 1, 9]);
        });
    }

    #[test]
    fn flush_far_writes_persist_independently() {
        crate::run_with_stack(|| {
            let (mut storage, session, mut ns_state) = fresh_session();
            let bs = PLAINTEXT_SIZE as u64;
            let writes = vec![pw(0, b"start"), pw(10 * bs, b"end")];
            flush_writes(
                &mut storage,
                DOMAIN,
                NS,
                &session,
                &mut ns_state,
                &writes,
                10 * bs + 3,
            )
            .unwrap();

            let r1 = read_session_data(&storage, DOMAIN, NS, &session, &ns_state, 0, 5).unwrap();
            assert_eq!(&*r1, b"start");
            let r2 =
                read_session_data(&storage, DOMAIN, NS, &session, &ns_state, 10 * bs, 3).unwrap();
            assert_eq!(&*r2, b"end");
        });
    }

    #[test]
    fn flush_grows_total_data_length() {
        crate::run_with_stack(|| {
            let (mut storage, session, mut ns_state) = fresh_session();
            let writes = vec![pw(0, b"data")];
            flush_writes(
                &mut storage,
                DOMAIN,
                NS,
                &session,
                &mut ns_state,
                &writes,
                100,
            )
            .unwrap();
            assert_eq!(ns_state.total_data_length, 100);
        });
    }

    // ── the length header in block 0 must follow every flush ──

    fn persisted_length(storage: &MemoryStorage, session: &UnlockedSession) -> u64 {
        load_namespace_state(storage, DOMAIN, session, NS)
            .unwrap()
            .total_data_length
    }

    #[test]
    fn flush_single_write_past_block_zero_persists_the_length() {
        crate::run_with_stack(|| {
            let (mut storage, session, mut ns_state) = fresh_session();
            let bs = PLAINTEXT_SIZE as u64;
            let first = vec![pw(0, b"start")];
            flush_writes(&mut storage, DOMAIN, NS, &session, &mut ns_state, &first, 5).unwrap();

            // grows the stream without touching block 0
            let far = vec![pw(3 * bs, b"end")];
            flush_writes(
                &mut storage,
                DOMAIN,
                NS,
                &session,
                &mut ns_state,
                &far,
                3 * bs + 3,
            )
            .unwrap();

            assert_eq!(ns_state.total_data_length, 3 * bs + 3);
            assert_eq!(persisted_length(&storage, &session), 3 * bs + 3);
        });
    }

    #[test]
    fn flush_far_groups_persist_the_length() {
        crate::run_with_stack(|| {
            let (mut storage, session, mut ns_state) = fresh_session();
            let bs = PLAINTEXT_SIZE as u64;
            // block 0 is written first, the group that grows the stream after it
            let writes = vec![pw(0, b"start"), pw(10 * bs, b"end")];
            flush_writes(
                &mut storage,
                DOMAIN,
                NS,
                &session,
                &mut ns_state,
                &writes,
                10 * bs + 3,
            )
            .unwrap();

            assert_eq!(persisted_length(&storage, &session), 10 * bs + 3);
            let read = read_session_data(&storage, DOMAIN, NS, &session, &ns_state, 0, 5).unwrap();
            assert_eq!(&*read, b"start");
        });
    }

    #[test]
    fn flush_persists_a_file_size_past_the_last_write() {
        crate::run_with_stack(|| {
            let (mut storage, session, mut ns_state) = fresh_session();
            let writes = vec![pw(0, b"data")];
            flush_writes(
                &mut storage,
                DOMAIN,
                NS,
                &session,
                &mut ns_state,
                &writes,
                100,
            )
            .unwrap();

            assert_eq!(persisted_length(&storage, &session), 100);
        });
    }

    #[test]
    fn flush_persists_a_file_size_with_no_write() {
        crate::run_with_stack(|| {
            let (mut storage, session, mut ns_state) = fresh_session();
            flush_writes(
                &mut storage,
                DOMAIN,
                NS,
                &session,
                &mut ns_state,
                &[pw(0, b"data")],
                4,
            )
            .unwrap();

            flush_writes(&mut storage, DOMAIN, NS, &session, &mut ns_state, &[], 100).unwrap();

            assert_eq!(ns_state.total_data_length, 100);
            assert_eq!(persisted_length(&storage, &session), 100);
        });
    }

    #[test]
    fn grow_writes_zeros_in_several_chunks() {
        crate::run_with_stack(|| {
            let (mut storage, session, mut ns_state) = fresh_session();
            crate::write_session_data(
                &mut storage,
                DOMAIN,
                NS,
                &session,
                &mut ns_state,
                0,
                b"data",
            )
            .unwrap();

            // a chunk that is not a whole number of blocks, and a size that
            // is not a whole number of chunks
            let chunk = PLAINTEXT_SIZE + 7;
            let file_size = 4 + 2 * chunk as u64 + 100;
            grow_with_zeros(
                &mut storage,
                DOMAIN,
                NS,
                &session,
                &mut ns_state,
                file_size,
                chunk,
            )
            .unwrap();

            assert_eq!(ns_state.total_data_length, file_size);
            assert_eq!(persisted_length(&storage, &session), file_size);
            let read = read_session_data(
                &storage,
                DOMAIN,
                NS,
                &session,
                &ns_state,
                0,
                file_size as usize,
            )
            .unwrap();
            assert_eq!(&read[..4], b"data");
            assert!(read[4..].iter().all(|&b| b == 0));
        });
    }

    #[test]
    fn grow_does_nothing_when_the_stream_is_long_enough() {
        crate::run_with_stack(|| {
            let (mut storage, session, mut ns_state) = fresh_session();
            crate::write_session_data(
                &mut storage,
                DOMAIN,
                NS,
                &session,
                &mut ns_state,
                0,
                b"data",
            )
            .unwrap();

            grow_with_zeros(&mut storage, DOMAIN, NS, &session, &mut ns_state, 3, 16).unwrap();
            assert_eq!(ns_state.total_data_length, 4);
            assert_eq!(persisted_length(&storage, &session), 4);
        });
    }
}
