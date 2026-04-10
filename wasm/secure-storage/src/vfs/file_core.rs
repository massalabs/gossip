//! Per-file read/write/sync semantics for the encrypted VFS.

use crate::DEFAULT_NAMESPACE;
use crate::error::Result;
use crate::storage::{BlockStorage, KeypairStorage};
use crate::unlock::{NamespaceState, UnlockedSession};
use crate::vfs::pending::{PendingWrite, apply_pending_overlay, flush_writes};

/// Per-file state for the encrypted VFS.
///
/// Operates on [`DEFAULT_NAMESPACE`] — every method passes that constant
/// down to the secure-storage core.
pub(crate) struct EncryptedFileCore {
    pending: Vec<PendingWrite>,
    pending_size: u64,
}

impl EncryptedFileCore {
    pub fn new() -> Self {
        Self {
            pending: Vec::new(),
            pending_size: 0,
        }
    }

    /// Logical file size, reflecting both persisted data and unflushed writes.
    pub fn size(&self, ns_state: &NamespaceState) -> u64 {
        self.pending_size.max(ns_state.total_data_length)
    }

    /// Read `dst.len()` bytes at `offset`. Returns `true` if the entire range
    /// was satisfied, `false` if the read extended beyond the logical file size
    /// (the trailing bytes of `dst` are zero-filled in that case).
    pub fn read<S: BlockStorage>(
        &self,
        backend: &S,
        domain: &str,
        session: &UnlockedSession,
        ns_state: &NamespaceState,
        offset: u64,
        dst: &mut [u8],
    ) -> Result<bool> {
        let n = dst.len();
        if n == 0 {
            return Ok(true);
        }

        let logical_size = self.size(ns_state);
        let read_end = offset.saturating_add(n as u64);
        let is_full = read_end <= logical_size;

        let persisted_avail = ns_state
            .total_data_length
            .saturating_sub(offset)
            .min(n as u64) as usize;
        if persisted_avail > 0 {
            let data = crate::read_session_data(
                backend,
                domain,
                DEFAULT_NAMESPACE,
                session,
                ns_state,
                offset,
                persisted_avail,
            )?;
            dst[..persisted_avail].copy_from_slice(&data);
        }
        dst[persisted_avail..].fill(0);

        apply_pending_overlay(&self.pending, offset, dst);

        Ok(is_full)
    }

    /// Buffer a write. Visible immediately to subsequent `read` calls via the
    /// pending overlay; persisted only when `sync` is called.
    pub fn write(&mut self, offset: u64, data: &[u8]) {
        if data.is_empty() {
            return;
        }
        let end = offset.saturating_add(data.len() as u64);
        if end > self.pending_size {
            self.pending_size = end;
        }
        self.pending.push(PendingWrite {
            offset,
            data: data.to_vec(),
        });
    }

    /// Drain pending writes through the encryption layer.
    pub fn sync<S: BlockStorage + KeypairStorage>(
        &mut self,
        backend: &mut S,
        domain: &str,
        session: &UnlockedSession,
        ns_state: &mut NamespaceState,
    ) -> Result<()> {
        if self.pending.is_empty() {
            return Ok(());
        }
        flush_writes(
            backend,
            domain,
            DEFAULT_NAMESPACE,
            session,
            ns_state,
            &self.pending,
            self.pending_size,
        )?;
        self.pending.clear();
        self.pending_size = 0;
        Ok(())
    }

    /// Truncate the file to `new_size` bytes (grow or shrink).
    pub fn truncate<S: BlockStorage + KeypairStorage>(
        &mut self,
        backend: &mut S,
        domain: &str,
        session: &UnlockedSession,
        ns_state: &mut NamespaceState,
        new_size: u64,
    ) -> Result<()> {
        // Drop or trim pending writes that extend past new_size.
        self.pending.retain_mut(|pw| {
            if pw.offset >= new_size {
                false
            } else if pw.offset.saturating_add(pw.data.len() as u64) > new_size {
                let keep = (new_size - pw.offset) as usize;
                pw.data.truncate(keep);
                true
            } else {
                true
            }
        });

        if new_size < ns_state.total_data_length {
            crate::shrink_session_data(backend, domain, DEFAULT_NAMESPACE, session, ns_state, new_size)?;
        }

        self.pending_size = new_size;
        Ok(())
    }

    /// Drop all buffered writes without persisting.
    pub fn discard_pending(&mut self) {
        self.pending.clear();
        self.pending_size = 0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::MemoryStorage;
    use crate::types::SessionIndex;
    use crate::unlock::{load_namespace_state, NamespaceState};
    use crate::{allocate_session, provision_storage};

    const DOMAIN: &str = "file-core-tests";

    fn fresh_session() -> (MemoryStorage, UnlockedSession, NamespaceState) {
        let mut storage = MemoryStorage::new();
        provision_storage(&mut storage).unwrap();
        let slot = SessionIndex::new(0).unwrap();
        let session = allocate_session(&mut storage, DOMAIN, slot, b"test-pw").unwrap();
        let ns_state = load_namespace_state(&storage, DOMAIN, &session, DEFAULT_NAMESPACE).unwrap();
        (storage, session, ns_state)
    }

    #[test]
    fn new_file_size_is_zero() {
        crate::run_with_stack(|| {
            let (_storage, _session, ns_state) = fresh_session();
            let file = EncryptedFileCore::new();
            assert_eq!(file.size(&ns_state), 0);
        });
    }

    #[test]
    fn read_from_empty_is_short_read_with_zeros() {
        crate::run_with_stack(|| {
            let (storage, session, ns_state) = fresh_session();
            let file = EncryptedFileCore::new();
            let mut buf = vec![0xFFu8; 8];
            let ok = file
                .read(&storage, DOMAIN, &session, &ns_state, 0, &mut buf)
                .unwrap();
            assert!(!ok);
            assert_eq!(buf, vec![0u8; 8]);
        });
    }

    #[test]
    fn read_pending_overlay_visible_before_sync() {
        crate::run_with_stack(|| {
            let (storage, session, ns_state) = fresh_session();
            let mut file = EncryptedFileCore::new();
            file.write(0, b"hello");

            let mut buf = vec![0u8; 5];
            let ok = file
                .read(&storage, DOMAIN, &session, &ns_state, 0, &mut buf)
                .unwrap();
            assert!(ok);
            assert_eq!(&buf, b"hello");
        });
    }

    #[test]
    fn read_after_sync_returns_persisted_data() {
        crate::run_with_stack(|| {
            let (mut storage, session, mut ns_state) = fresh_session();
            let mut file = EncryptedFileCore::new();

            file.write(0, b"hello");
            file.sync(&mut storage, DOMAIN, &session, &mut ns_state).unwrap();

            assert_eq!(file.size(&ns_state), 5);
            let mut buf = vec![0u8; 5];
            let ok = file
                .read(&storage, DOMAIN, &session, &ns_state, 0, &mut buf)
                .unwrap();
            assert!(ok);
            assert_eq!(&buf, b"hello");
        });
    }

    #[test]
    fn read_partial_persisted_partial_pending() {
        crate::run_with_stack(|| {
            let (mut storage, session, mut ns_state) = fresh_session();
            let mut file = EncryptedFileCore::new();

            file.write(0, b"AAAA");
            file.sync(&mut storage, DOMAIN, &session, &mut ns_state).unwrap();

            file.write(4, b"BBBB"); // not synced

            let mut buf = vec![0u8; 8];
            let ok = file
                .read(&storage, DOMAIN, &session, &ns_state, 0, &mut buf)
                .unwrap();
            assert!(ok);
            assert_eq!(&buf, b"AAAABBBB");
        });
    }

    #[test]
    fn read_beyond_logical_size_is_short() {
        crate::run_with_stack(|| {
            let (mut storage, session, mut ns_state) = fresh_session();
            let mut file = EncryptedFileCore::new();

            file.write(0, b"data");
            file.sync(&mut storage, DOMAIN, &session, &mut ns_state).unwrap();

            let mut buf = vec![0xFFu8; 10];
            let ok = file
                .read(&storage, DOMAIN, &session, &ns_state, 0, &mut buf)
                .unwrap();
            assert!(!ok);
            assert_eq!(&buf[..4], b"data");
            assert_eq!(&buf[4..], &[0u8; 6]);
        });
    }

    #[test]
    fn write_updates_pending_size() {
        let mut file = EncryptedFileCore::new();
        file.write(10, b"hello");
        assert_eq!(file.pending_size, 15);
    }

    #[test]
    fn write_keeps_largest_pending_size() {
        let mut file = EncryptedFileCore::new();
        file.write(20, b"X");
        file.write(5, b"Y"); // earlier offset, shouldn't shrink
        assert_eq!(file.pending_size, 21);
    }

    #[test]
    fn sync_persists_and_clears_pending() {
        crate::run_with_stack(|| {
            let (mut storage, session, mut ns_state) = fresh_session();
            let mut file = EncryptedFileCore::new();
            file.write(0, b"data");
            file.sync(&mut storage, DOMAIN, &session, &mut ns_state).unwrap();

            assert!(file.pending.is_empty());
            assert_eq!(file.pending_size, 0);
            assert_eq!(ns_state.total_data_length, 4);
        });
    }

    #[test]
    fn sync_empty_is_noop() {
        crate::run_with_stack(|| {
            let (mut storage, session, mut ns_state) = fresh_session();
            let mut file = EncryptedFileCore::new();
            let total_before = ns_state.total_data_length;
            file.sync(&mut storage, DOMAIN, &session, &mut ns_state).unwrap();
            assert_eq!(ns_state.total_data_length, total_before);
        });
    }

    #[test]
    fn truncate_shrinks_size() {
        crate::run_with_stack(|| {
            let (mut storage, session, mut ns_state) = fresh_session();
            let mut file = EncryptedFileCore::new();

            file.write(0, b"hello world");
            file.sync(&mut storage, DOMAIN, &session, &mut ns_state).unwrap();
            assert_eq!(file.size(&ns_state), 11);

            file.truncate(&mut storage, DOMAIN, &session, &mut ns_state, 5)
                .unwrap();
            assert_eq!(file.size(&ns_state), 5);

            let mut buf = vec![0u8; 5];
            file.read(&storage, DOMAIN, &session, &ns_state, 0, &mut buf)
                .unwrap();
            assert_eq!(&buf, b"hello");
        });
    }

    #[test]
    fn truncate_drops_pending_beyond_new_size() {
        crate::run_with_stack(|| {
            let (mut storage, session, mut ns_state) = fresh_session();
            let mut file = EncryptedFileCore::new();

            file.write(0, b"AAAA");
            file.write(10, b"BBBB"); // pending beyond what we'll keep

            file.truncate(&mut storage, DOMAIN, &session, &mut ns_state, 4)
                .unwrap();

            assert_eq!(file.pending_size, 4);
            // Only the first pending should remain
            assert_eq!(file.pending.len(), 1);
            assert_eq!(file.pending[0].offset, 0);
        });
    }

    #[test]
    fn truncate_trims_pending_that_straddles() {
        crate::run_with_stack(|| {
            let (mut storage, session, mut ns_state) = fresh_session();
            let mut file = EncryptedFileCore::new();

            file.write(0, b"hello world"); // 11 bytes

            file.truncate(&mut storage, DOMAIN, &session, &mut ns_state, 5)
                .unwrap();

            assert_eq!(file.pending.len(), 1);
            assert_eq!(file.pending[0].data, b"hello");
            assert_eq!(file.pending_size, 5);
        });
    }

    #[test]
    fn truncate_grows_size() {
        crate::run_with_stack(|| {
            let (mut storage, session, mut ns_state) = fresh_session();
            let mut file = EncryptedFileCore::new();

            file.write(0, b"data");
            file.sync(&mut storage, DOMAIN, &session, &mut ns_state).unwrap();

            file.truncate(&mut storage, DOMAIN, &session, &mut ns_state, 100)
                .unwrap();
            assert_eq!(file.size(&ns_state), 100);

            let mut buf = vec![0xFFu8; 10];
            let ok = file
                .read(&storage, DOMAIN, &session, &ns_state, 50, &mut buf)
                .unwrap();
            assert!(ok);
            assert_eq!(buf, vec![0u8; 10]);
        });
    }

    #[test]
    fn size_reflects_max_of_persisted_and_pending() {
        crate::run_with_stack(|| {
            let (mut storage, session, mut ns_state) = fresh_session();
            let mut file = EncryptedFileCore::new();

            file.write(0, b"AAAAA");
            file.sync(&mut storage, DOMAIN, &session, &mut ns_state).unwrap();
            assert_eq!(file.size(&ns_state), 5);

            file.write(10, b"BB"); // pending grows logical size to 12
            assert_eq!(file.size(&ns_state), 12);
        });
    }

    #[test]
    fn discard_pending_clears_buffer_only() {
        crate::run_with_stack(|| {
            let (mut storage, session, mut ns_state) = fresh_session();
            let mut file = EncryptedFileCore::new();

            file.write(0, b"persisted");
            file.sync(&mut storage, DOMAIN, &session, &mut ns_state).unwrap();

            file.write(20, b"discarded");
            file.discard_pending();

            assert!(file.pending.is_empty());
            assert_eq!(file.pending_size, 0);

            // Persisted data is untouched
            let mut buf = vec![0u8; 9];
            file.read(&storage, DOMAIN, &session, &ns_state, 0, &mut buf)
                .unwrap();
            assert_eq!(&buf, b"persisted");
        });
    }
}
