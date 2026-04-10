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
/// Updates `ns_state.total_data_length` if `file_size` exceeds it.
/// Does not commit the backend; the caller is responsible for that.
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
        return Ok(());
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
        for &(group_off, group_end) in &groups {
            let span = (group_end.saturating_sub(group_off)) as usize;

            let mut buf = vec![0u8; span];

            if ns_state.total_data_length > group_off {
                let readable =
                    (ns_state.total_data_length.saturating_sub(group_off)).min(span as u64) as usize;
                let existing = crate::read_session_data(
                    backend, domain, namespace, session, ns_state, group_off, readable,
                )?;
                buf[..readable].copy_from_slice(&existing);
            }

            for pw in writes {
                let pw_end = pw.offset.saturating_add(pw.data.len() as u64);
                if pw.offset < group_end && pw_end > group_off {
                    let src_start = group_off.saturating_sub(pw.offset) as usize;
                    let dst_start = pw.offset.saturating_sub(group_off) as usize;
                    let copy_len = pw_end.min(group_end).saturating_sub(pw.offset.max(group_off)) as usize;
                    buf[dst_start..dst_start + copy_len]
                        .copy_from_slice(&pw.data[src_start..src_start + copy_len]);
                }
            }

            crate::write_session_data(
                backend, domain, namespace, session, ns_state, group_off, &buf,
            )?;
        }
    }

    if file_size > ns_state.total_data_length {
        ns_state.total_data_length = file_size;
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
            let end = last_byte
                .saturating_add(block_size - 1)
                / block_size
                * block_size;
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

/// Apply pending writes as an overlay onto a read buffer.
///
/// `dst` covers the byte range `[read_off, read_off + dst.len())`.
pub(crate) fn apply_pending_overlay(pending: &[PendingWrite], read_off: u64, dst: &mut [u8]) {
    let read_end = read_off.saturating_add(dst.len() as u64);
    for pw in pending {
        let pw_end = pw.offset.saturating_add(pw.data.len() as u64);
        if pw.offset < read_end && pw_end > read_off {
            let src_start = read_off.saturating_sub(pw.offset) as usize;
            let dst_start = pw.offset.saturating_sub(read_off) as usize;
            let len = (pw_end.min(read_end).saturating_sub(pw.offset.max(read_off))) as usize;
            dst[dst_start..dst_start + len]
                .copy_from_slice(&pw.data[src_start..src_start + len]);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::DEFAULT_NAMESPACE;
    use crate::constants::PLAINTEXT_SIZE;
    use crate::storage::MemoryStorage;
    use crate::types::SessionIndex;
    use crate::unlock::{load_namespace_state, NamespaceState};
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
            flush_writes(&mut storage, DOMAIN, NS, &session, &mut ns_state, &writes, 5).unwrap();

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

            let read =
                read_session_data(&storage, DOMAIN, NS, &session, &ns_state, 0, 11).unwrap();
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

            let read =
                read_session_data(&storage, DOMAIN, NS, &session, &ns_state, 0, 8).unwrap();
            assert_eq!(&*read, b"AABBAAAA");
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
}
