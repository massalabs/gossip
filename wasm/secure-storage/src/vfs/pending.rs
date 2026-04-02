//! Shared write-buffering logic for encrypted VFS implementations.
//!
//! Both the WASM and native VFS buffer plaintext writes during a SQLite
//! transaction and flush them in a single coalesced batch at `x_sync`.
//! This module contains the platform-agnostic pieces: the buffer struct,
//! the coalescing flush, and the read-overlay helper.

use crate::error::Result;
use crate::storage::{BlockStorage, KeypairStorage};
use crate::unlock::UnlockedSession;

/// Buffered plaintext write (offset + data), applied at x_sync.
pub(crate) struct PendingWrite {
    pub offset: u64,
    pub data: Vec<u8>,
}

/// Coalesce pending writes by block group and encrypt only dirty blocks.
///
/// Groups writes by contiguous block ranges so that distant pages (e.g.
/// block 0 and block 19) produce separate `write_session_data` calls
/// instead of one giant span that re-encrypts all intermediate blocks.
///
/// Does NOT call `backend.commit()` — the caller handles that
/// (RedbStorage::commit on native, WAL commit on web).
pub(crate) fn flush_writes<S: BlockStorage + KeypairStorage>(
    backend: &mut S,
    domain: &str,
    session: &mut UnlockedSession,
    writes: &[PendingWrite],
    file_size: u64,
) -> Result<()> {
    if writes.is_empty() {
        return Ok(());
    }

    if writes.len() == 1 {
        crate::write_session_data(backend, domain, session, writes[0].offset, &writes[0].data)?;
    } else {
        let groups = group_by_contiguous_blocks(writes);
        for (group_off, group_end) in &groups {
            let off = *group_off;
            let span = (*group_end - off) as usize;

            let mut buf = vec![0u8; span];

            if session.total_data_length > off {
                let readable = (session.total_data_length - off).min(span as u64) as usize;
                if let Ok(existing) =
                    crate::read_session_data(backend, domain, session, off, readable)
                {
                    buf[..readable].copy_from_slice(&existing);
                }
            }

            for pw in writes {
                let pw_end = pw.offset + pw.data.len() as u64;
                if pw.offset < *group_end && pw_end > off {
                    let dst_start = (pw.offset - off) as usize;
                    buf[dst_start..dst_start + pw.data.len()].copy_from_slice(&pw.data);
                }
            }

            crate::write_session_data(backend, domain, session, off, &buf)?;
        }
    }

    if file_size > session.total_data_length {
        session.total_data_length = file_size;
    }
    Ok(())
}

/// Group writes into contiguous block ranges.
fn group_by_contiguous_blocks(writes: &[PendingWrite]) -> Vec<(u64, u64)> {
    use crate::constants::PLAINTEXT_SIZE;
    let block_size = PLAINTEXT_SIZE as u64;

    let mut ranges: Vec<(u64, u64)> = writes
        .iter()
        .map(|pw| {
            let first = (pw.offset / block_size) * block_size;
            let last_byte = pw.offset + pw.data.len() as u64;
            let end = ((last_byte + block_size - 1) / block_size) * block_size;
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

/// Apply pending plaintext writes as an overlay on a read buffer.
///
/// `dst` covers the byte range `[read_off, read_off + dst.len())`.
pub(crate) fn apply_pending_overlay(pending: &[PendingWrite], read_off: u64, dst: &mut [u8]) {
    let read_end = read_off + dst.len() as u64;
    for pw in pending {
        let pw_end = pw.offset + pw.data.len() as u64;
        if pw.offset < read_end && pw_end > read_off {
            let src_start = read_off.saturating_sub(pw.offset) as usize;
            let dst_start = pw.offset.saturating_sub(read_off) as usize;
            let len = (pw_end.min(read_end) - pw.offset.max(read_off)) as usize;
            dst[dst_start..dst_start + len]
                .copy_from_slice(&pw.data[src_start..src_start + len]);
        }
    }
}
