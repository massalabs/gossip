//! Filesystem + WAL block & keypair storage (native port of `opfs_wal_storage`).
//!
//! Writes are buffered in an in-memory WAL. On `commit` the WAL is flushed
//! to a dedicated file, then applied to the main data file, then the
//! WAL file is truncated. This provides crash-safe persistence: on open we
//! replay any valid WAL entries found on disk.
//!
//! Reads check the WAL first (dirty-block overlay), then fall back to disk.

use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

use zeroize::Zeroizing;

use crate::constants::{BLOCK_SIZE, SESSION_COUNT};
use crate::error::{Result, SecureStorageError};
use crate::storage::{BlockStorage, KeypairStorage};
use crate::types::SessionIndex;
use crate::wal::Wal;

// ── Storage implementation ───────────────────────────────────────────

/// Filesystem backend with WAL-based crash safety.
///
/// Each session has:
/// - A blocks file (`session_N.blocks`) -- the main data file.
/// - A WAL file (`session_N.wal`) -- serialised WAL entries flushed on commit.
/// - A keypair file (`session_N.keypair`) -- written once, no WAL needed.
pub struct FsWalStorage {
    base: PathBuf,
    block_files: Vec<File>,
    wal_files: Vec<File>,
    keypair_files: Vec<File>,
    /// Per-session in-memory WAL buffers.
    wals: Vec<Wal>,
    /// Per-session block counts (tracked in memory to avoid stat() on every op).
    block_counts: Vec<u64>,
}

impl FsWalStorage {
    /// Open (or create) the storage directory, acquire file handles, and run
    /// crash recovery.
    pub fn open(base: &Path) -> Result<Self> {
        fs::create_dir_all(base)?;

        let mut block_files = Vec::with_capacity(SESSION_COUNT);
        let mut wal_files = Vec::with_capacity(SESSION_COUNT);
        let mut keypair_files = Vec::with_capacity(SESSION_COUNT);

        for i in 0..SESSION_COUNT {
            block_files.push(
                OpenOptions::new()
                    .read(true)
                    .write(true)
                    .create(true)
                    .truncate(false)
                    .open(base.join(format!("session_{i}.blocks")))?,
            );
            wal_files.push(
                OpenOptions::new()
                    .read(true)
                    .write(true)
                    .create(true)
                    .truncate(false)
                    .open(base.join(format!("session_{i}.wal")))?,
            );
            keypair_files.push(
                OpenOptions::new()
                    .read(true)
                    .write(true)
                    .create(true)
                    .truncate(false)
                    .open(base.join(format!("session_{i}.keypair")))?,
            );
        }

        let mut storage = Self {
            base: base.to_path_buf(),
            block_files,
            wal_files,
            keypair_files,
            wals: (0..SESSION_COUNT).map(|_| Wal::new()).collect(),
            block_counts: vec![0; SESSION_COUNT],
        };

        // Crash recovery + rebuild block counts for each session.
        for i in 0..SESSION_COUNT {
            storage.recover(i)?;
            storage.block_counts[i] = storage.read_block_count_from_file(i)?;
        }

        Ok(storage)
    }

    /// Read the block count from the file size.
    fn read_block_count_from_file(&self, session_idx: usize) -> Result<u64> {
        let size = self.block_files[session_idx].metadata()?.len();
        Ok(size / BLOCK_SIZE as u64)
    }

    /// Crash recovery for one session: replay valid WAL entries, then truncate WAL.
    fn recover(&mut self, session_idx: usize) -> Result<()> {
        let wal_size = self.wal_files[session_idx].metadata()?.len() as usize;

        if wal_size == 0 {
            return Ok(());
        }

        // Read entire WAL file.
        let mut wal_data = vec![0u8; wal_size];
        self.wal_files[session_idx].seek(SeekFrom::Start(0))?;
        self.wal_files[session_idx].read_exact(&mut wal_data)?;

        // Parse valid entries.
        let entries = Wal::parse_wal_bytes(&wal_data);

        if entries.is_empty() {
            // No valid entries; just truncate WAL.
            self.wal_files[session_idx].set_len(0)?;
            self.wal_files[session_idx].sync_data()?;
            return Ok(());
        }

        // Apply to DB file -- block 0 last (same ordering as flush_session).
        let db = &mut self.block_files[session_idx];
        let mut block0_entry = None;
        for entry in &entries {
            if entry.file_offset == 0 {
                block0_entry = Some(entry);
                continue;
            }
            db.seek(SeekFrom::Start(entry.file_offset))?;
            db.write_all(&entry.payload)?;
        }
        if let Some(entry) = block0_entry {
            db.sync_data()?;
            db.seek(SeekFrom::Start(0))?;
            db.write_all(&entry.payload)?;
        }
        db.sync_data()?;

        // Truncate WAL.
        self.wal_files[session_idx].set_len(0)?;
        self.wal_files[session_idx].sync_data()?;

        Ok(())
    }

    /// Three-phase flush for one session.
    fn flush_session(&mut self, session_idx: usize) -> Result<()> {
        if self.wals[session_idx].is_empty() {
            return Ok(());
        }

        // Phase 1: Write WAL to disk.
        let wal_bytes = self.wals[session_idx].to_bytes();
        let wf = &mut self.wal_files[session_idx];
        wf.set_len(0)?;
        wf.seek(SeekFrom::Start(0))?;
        wf.write_all(&wal_bytes)?;
        wf.sync_data()?;

        // Phase 2: Apply entries to DB file.
        // Write block 0 LAST -- it contains total_data_length and is required
        // for unlock. If we crash mid-apply, the old block 0 remains valid.
        let db = &mut self.block_files[session_idx];
        let mut block0_entry_payload: Option<Vec<u8>> = None;
        for entry in self.wals[session_idx].entries() {
            if entry.file_offset == 0 {
                block0_entry_payload = Some(entry.payload.clone());
                continue;
            }
            db.seek(SeekFrom::Start(entry.file_offset))?;
            db.write_all(&entry.payload)?;
        }
        // Flush non-block-0 writes first, then write block 0.
        if let Some(payload) = &block0_entry_payload {
            db.sync_data()?;
            db.seek(SeekFrom::Start(0))?;
            db.write_all(payload)?;
        }
        db.sync_data()?;

        // Phase 3: Truncate WAL + clear in-memory state.
        let wf = &mut self.wal_files[session_idx];
        wf.set_len(0)?;
        wf.sync_data()?;
        self.wals[session_idx].clear();

        Ok(())
    }

    /// Flush the WAL for a session to disk (three-phase commit).
    /// Called from x_sync and explicit flush, NOT from BlockStorage::fsync.
    pub fn commit(&mut self, session: SessionIndex) -> Result<()> {
        self.flush_session(session.as_usize())
    }

    /// Flush all sessions.
    pub fn commit_all(&mut self) -> Result<()> {
        for i in 0..SESSION_COUNT {
            self.flush_session(i)?;
        }
        Ok(())
    }

    /// Compute the file offset for a block in a given session.
    fn block_offset(block: u64) -> Result<u64> {
        block
            .checked_mul(BLOCK_SIZE as u64)
            .ok_or(SecureStorageError::Overflow)
    }
}

impl BlockStorage for FsWalStorage {
    fn read_block(&self, session: SessionIndex, block: u64) -> Result<Box<[u8; BLOCK_SIZE]>> {
        let si = session.as_usize();
        let offset = Self::block_offset(block)?;

        // Check WAL first (last-write-wins).
        for entry in self.wals[si].entries().iter().rev() {
            if entry.file_offset == offset && entry.payload.len() == BLOCK_SIZE {
                let mut buf = Box::new([0u8; BLOCK_SIZE]);
                buf.copy_from_slice(&entry.payload);
                return Ok(buf);
            }
        }

        // Fall back to disk.
        let file = &self.block_files[si];
        let file_size = file.metadata()?.len();
        if offset + BLOCK_SIZE as u64 > file_size {
            return Err(SecureStorageError::OutOfBounds);
        }

        // We need &mut for seek+read but only have &self. Use a dup'd handle
        // to avoid needing &mut self (matches the trait signature).
        let mut reader = File::open(self.base.join(format!("session_{si}.blocks")))?;
        reader.seek(SeekFrom::Start(offset))?;
        let mut buf = Box::new([0u8; BLOCK_SIZE]);
        reader
            .read_exact(buf.as_mut())
            .map_err(|_| SecureStorageError::OutOfBounds)?;
        Ok(buf)
    }

    fn write_block(
        &mut self,
        session: SessionIndex,
        block: u64,
        data: &[u8; BLOCK_SIZE],
    ) -> Result<()> {
        let si = session.as_usize();
        if block >= self.block_counts[si] {
            return Err(SecureStorageError::OutOfBounds);
        }
        let offset = Self::block_offset(block)?;
        self.wals[si].record_write(offset, data);
        Ok(())
    }

    fn append_block(&mut self, session: SessionIndex, data: &[u8; BLOCK_SIZE]) -> Result<()> {
        let si = session.as_usize();
        let block = self.block_counts[si];
        let offset = Self::block_offset(block)?;
        self.wals[si].record_write(offset, data);
        self.block_counts[si] += 1;
        Ok(())
    }

    fn block_count(&self, session: SessionIndex) -> Result<u64> {
        Ok(self.block_counts[session.as_usize()])
    }

    fn fsync(&self, _session: SessionIndex) -> Result<()> {
        // No-op: writes are buffered in the in-memory WAL.
        // The actual disk flush happens in flush_session(), called
        // from x_sync (at COMMIT) or the explicit flush().
        Ok(())
    }

    fn init_blockstream(&mut self, session: SessionIndex) -> Result<()> {
        let si = session.as_usize();
        self.block_files[si].set_len(0)?;
        self.wal_files[si].set_len(0)?;
        self.wals[si].clear();
        self.block_counts[si] = 0;
        Ok(())
    }
}

impl KeypairStorage for FsWalStorage {
    fn read_keypair(&self, session: SessionIndex) -> Result<Zeroizing<Vec<u8>>> {
        let si = session.as_usize();
        let size = self.keypair_files[si].metadata()?.len() as usize;
        if size == 0 {
            return Err(SecureStorageError::Storage("keypair not found".into()));
        }
        let mut reader = File::open(self.base.join(format!("session_{si}.keypair")))?;
        let mut buf = vec![0u8; size];
        reader.read_exact(&mut buf)?;
        Ok(Zeroizing::new(buf))
    }

    fn write_keypair(&mut self, session: SessionIndex, data: &[u8]) -> Result<()> {
        let si = session.as_usize();
        let kf = &mut self.keypair_files[si];
        kf.set_len(0)?;
        kf.seek(SeekFrom::Start(0))?;
        kf.write_all(data)?;
        kf.sync_data()?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn make_storage() -> (FsWalStorage, TempDir) {
        let dir = TempDir::new().unwrap();
        let storage = FsWalStorage::open(dir.path()).unwrap();
        (storage, dir)
    }

    fn make_block(fill: u8) -> Box<[u8; BLOCK_SIZE]> {
        let mut b = Box::new([0u8; BLOCK_SIZE]);
        b.fill(fill);
        b
    }

    #[test]
    fn test_append_and_read() {
        let (mut s, _dir) = make_storage();
        let si = SessionIndex::new(0).unwrap();
        let block = make_block(0xAB);
        s.append_block(si, &block).unwrap();
        let got = s.read_block(si, 0).unwrap();
        assert_eq!(*got, *block);
    }

    #[test]
    fn test_write_overwrites_in_wal() {
        let (mut s, _dir) = make_storage();
        let si = SessionIndex::new(0).unwrap();
        s.append_block(si, &make_block(0xAA)).unwrap();
        s.write_block(si, 0, &make_block(0xBB)).unwrap();
        let got = s.read_block(si, 0).unwrap();
        assert_eq!(got[0], 0xBB);
    }

    #[test]
    fn test_commit_persists() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().to_path_buf();

        // Write + commit.
        {
            let mut s = FsWalStorage::open(&path).unwrap();
            let si = SessionIndex::new(0).unwrap();
            s.append_block(si, &make_block(0xCD)).unwrap();
            s.commit(si).unwrap();
        }
        // Reopen and verify.
        {
            let s = FsWalStorage::open(&path).unwrap();
            let si = SessionIndex::new(0).unwrap();
            assert_eq!(s.block_count(si).unwrap(), 1);
            let got = s.read_block(si, 0).unwrap();
            assert_eq!(got[0], 0xCD);
        }
    }

    #[test]
    fn test_crash_recovery() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().to_path_buf();

        // Write WAL but do NOT commit (simulate crash after phase 1).
        {
            let mut s = FsWalStorage::open(&path).unwrap();
            let si = SessionIndex::new(0).unwrap();
            s.append_block(si, &make_block(0xEE)).unwrap();
            // Manually write WAL to disk (phase 1 only).
            let wal_bytes = s.wals[0].to_bytes();
            let wf = &mut s.wal_files[0];
            wf.set_len(0).unwrap();
            wf.seek(SeekFrom::Start(0)).unwrap();
            wf.write_all(&wal_bytes).unwrap();
            wf.sync_data().unwrap();
            // Drop without completing phase 2+3 (simulates crash).
        }
        // Reopen -- recovery should replay the WAL.
        {
            let s = FsWalStorage::open(&path).unwrap();
            let si = SessionIndex::new(0).unwrap();
            assert_eq!(s.block_count(si).unwrap(), 1);
            let got = s.read_block(si, 0).unwrap();
            assert_eq!(got[0], 0xEE);
        }
    }

    #[test]
    fn test_keypair_roundtrip() {
        let (mut s, _dir) = make_storage();
        let si = SessionIndex::new(0).unwrap();
        let data = b"test-keypair-data-here";
        s.write_keypair(si, data).unwrap();
        let got = s.read_keypair(si).unwrap();
        assert_eq!(&*got, data);
    }

    #[test]
    fn test_keypair_not_found() {
        let (s, _dir) = make_storage();
        let si = SessionIndex::new(0).unwrap();
        assert!(s.read_keypair(si).is_err());
    }

    #[test]
    fn test_sessions_independent() {
        let (mut s, _dir) = make_storage();
        let s0 = SessionIndex::new(0).unwrap();
        let s1 = SessionIndex::new(1).unwrap();
        s.append_block(s0, &make_block(0xAA)).unwrap();
        assert_eq!(s.block_count(s0).unwrap(), 1);
        assert_eq!(s.block_count(s1).unwrap(), 0);
    }

    #[test]
    fn test_read_oob() {
        let (s, _dir) = make_storage();
        let si = SessionIndex::new(0).unwrap();
        assert!(s.read_block(si, 0).is_err());
    }

    #[test]
    fn test_write_oob() {
        let (mut s, _dir) = make_storage();
        let si = SessionIndex::new(0).unwrap();
        assert!(s.write_block(si, 0, &make_block(0)).is_err());
    }

    #[test]
    fn test_commit_all() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().to_path_buf();

        {
            let mut s = FsWalStorage::open(&path).unwrap();
            let s0 = SessionIndex::new(0).unwrap();
            let s1 = SessionIndex::new(1).unwrap();
            s.append_block(s0, &make_block(0x11)).unwrap();
            s.append_block(s1, &make_block(0x22)).unwrap();
            s.commit_all().unwrap();
        }
        {
            let s = FsWalStorage::open(&path).unwrap();
            let s0 = SessionIndex::new(0).unwrap();
            let s1 = SessionIndex::new(1).unwrap();
            assert_eq!(s.read_block(s0, 0).unwrap()[0], 0x11);
            assert_eq!(s.read_block(s1, 0).unwrap()[0], 0x22);
        }
    }
}
