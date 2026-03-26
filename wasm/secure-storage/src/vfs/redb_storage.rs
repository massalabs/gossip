//! redb-backed block & keypair storage (replaces `FsWalStorage`).
//!
//! All blocks and keypairs are stored in a single `storage.redb` file.
//! Writes are buffered in a RAM buffer per session. On `commit()` the
//! entire buffer is flushed as a single ACID transaction — redb handles
//! crash safety internally, so no custom WAL is needed.

use std::fs;
use std::path::Path;

use redb::{Database, ReadableTable, ReadableTableMetadata, TableDefinition};
use zeroize::Zeroizing;

use crate::constants::{BLOCK_SIZE, SESSION_COUNT};
use crate::error::{Result, SecureStorageError};
use crate::storage::{BlockStorage, KeypairStorage};
use crate::types::SessionIndex;

// ── redb table definitions ───────────────────────────────────────────

const BLOCKS: TableDefinition<&[u8], &[u8]> = TableDefinition::new("blocks");
const KEYPAIRS: TableDefinition<&[u8], &[u8]> = TableDefinition::new("keypairs");

// ── Buffered write ───────────────────────────────────────────────────

/// A pending write that lives in RAM until `commit()`.
struct BufferedWrite {
    session: u8,
    block_id: u64,
    data: Box<[u8; BLOCK_SIZE]>,
}

// ── RedbStorage ──────────────────────────────────────────────────────

/// Single-file storage backend using redb.
pub struct RedbStorage {
    db: Database,
    ram_buffer: Vec<BufferedWrite>,
    block_counts: Vec<u64>,
}

impl RedbStorage {
    /// Open (or create) a redb database at `base/storage.redb`.
    pub fn open(base: &Path) -> Result<Self> {
        fs::create_dir_all(base)?;
        let db_path = base.join("storage.redb");
        let db = Database::create(&db_path).map_err(|e| {
            SecureStorageError::Storage(format!("redb open: {e}"))
        })?;

        let mut storage = Self {
            db,
            ram_buffer: Vec::new(),
            block_counts: vec![0; SESSION_COUNT],
        };
        storage.rebuild_block_counts()?;
        Ok(storage)
    }

    /// Scan the BLOCKS table and count entries per session.
    fn rebuild_block_counts(&mut self) -> Result<()> {
        let txn = self.db.begin_read().map_err(|e| {
            SecureStorageError::Storage(format!("redb read txn: {e}"))
        })?;

        let table = match txn.open_table(BLOCKS) {
            Ok(t) => t,
            // Table doesn't exist yet — all counts stay 0.
            Err(redb::TableError::TableDoesNotExist(_)) => return Ok(()),
            Err(e) => {
                return Err(SecureStorageError::Storage(format!(
                    "redb open table: {e}"
                )))
            }
        };

        let mut counts = vec![0u64; SESSION_COUNT];
        let iter = table.iter().map_err(|e| {
            SecureStorageError::Storage(format!("redb iter: {e}"))
        })?;
        for entry in iter {
            let (key, _val) = entry.map_err(|e| {
                SecureStorageError::Storage(format!("redb entry: {e}"))
            })?;
            let key_bytes = key.value();
            if key_bytes.len() == 9 {
                let session = key_bytes[0] as usize;
                if session < SESSION_COUNT {
                    counts[session] += 1;
                }
            }
        }
        self.block_counts = counts;
        Ok(())
    }

    /// Check whether the KEYPAIRS table has at least one entry.
    pub fn has_data(&self) -> Result<bool> {
        let txn = self.db.begin_read().map_err(|e| {
            SecureStorageError::Storage(format!("redb read txn: {e}"))
        })?;
        let table = match txn.open_table(KEYPAIRS) {
            Ok(t) => t,
            Err(redb::TableError::TableDoesNotExist(_)) => return Ok(false),
            Err(e) => {
                return Err(SecureStorageError::Storage(format!(
                    "redb open table: {e}"
                )))
            }
        };
        let count = table.len().map_err(|e| {
            SecureStorageError::Storage(format!("redb len: {e}"))
        })?;
        Ok(count > 0)
    }

    /// Encode (session, block_id) as a 9-byte key: `[session_u8, block_id_be_bytes]`.
    fn make_block_key(session: u8, block_id: u64) -> [u8; 9] {
        let mut key = [0u8; 9];
        key[0] = session;
        key[1..9].copy_from_slice(&block_id.to_be_bytes());
        key
    }

    /// Batch-insert all buffered writes into redb in a single ACID transaction,
    /// then clear the RAM buffer.
    pub fn commit(&mut self) -> Result<()> {
        if self.ram_buffer.is_empty() {
            return Ok(());
        }

        let txn = self.db.begin_write().map_err(|e| {
            SecureStorageError::Storage(format!("redb write txn: {e}"))
        })?;
        {
            let mut table = txn.open_table(BLOCKS).map_err(|e| {
                SecureStorageError::Storage(format!("redb open table: {e}"))
            })?;
            for bw in &self.ram_buffer {
                let key = Self::make_block_key(bw.session, bw.block_id);
                table
                    .insert(key.as_slice(), bw.data.as_slice())
                    .map_err(|e| {
                        SecureStorageError::Storage(format!("redb insert: {e}"))
                    })?;
            }
        }
        txn.commit().map_err(|e| {
            SecureStorageError::Storage(format!("redb commit: {e}"))
        })?;
        self.ram_buffer.clear();
        Ok(())
    }
}

// ── BlockStorage ─────────────────────────────────────────────────────

impl BlockStorage for RedbStorage {
    fn read_block(&self, session: SessionIndex, block: u64) -> Result<Box<[u8; BLOCK_SIZE]>> {
        let si = session.as_u8();

        if block >= self.block_counts[session.as_usize()] {
            return Err(SecureStorageError::OutOfBounds);
        }

        // Check RAM buffer first (last-write-wins).
        for bw in self.ram_buffer.iter().rev() {
            if bw.session == si && bw.block_id == block {
                return Ok(bw.data.clone());
            }
        }

        // Fall back to redb.
        let txn = self.db.begin_read().map_err(|e| {
            SecureStorageError::Storage(format!("redb read txn: {e}"))
        })?;
        let table = txn.open_table(BLOCKS).map_err(|e| {
            SecureStorageError::Storage(format!("redb open table: {e}"))
        })?;
        let key = Self::make_block_key(si, block);
        let entry = table.get(key.as_slice()).map_err(|e| {
            SecureStorageError::Storage(format!("redb get: {e}"))
        })?;
        match entry {
            Some(val) => {
                let val_bytes = val.value();
                if val_bytes.len() != BLOCK_SIZE {
                    return Err(SecureStorageError::CorruptedBlock);
                }
                let mut buf = Box::new([0u8; BLOCK_SIZE]);
                buf.copy_from_slice(val_bytes);
                Ok(buf)
            }
            None => Err(SecureStorageError::OutOfBounds),
        }
    }

    fn write_block(
        &mut self,
        session: SessionIndex,
        block: u64,
        data: &[u8; BLOCK_SIZE],
    ) -> Result<()> {
        if block >= self.block_counts[session.as_usize()] {
            return Err(SecureStorageError::OutOfBounds);
        }
        self.ram_buffer.push(BufferedWrite {
            session: session.as_u8(),
            block_id: block,
            data: Box::new(*data),
        });
        Ok(())
    }

    fn append_block(&mut self, session: SessionIndex, data: &[u8; BLOCK_SIZE]) -> Result<()> {
        let si = session.as_usize();
        let block_id = self.block_counts[si];
        self.ram_buffer.push(BufferedWrite {
            session: session.as_u8(),
            block_id,
            data: Box::new(*data),
        });
        self.block_counts[si] += 1;
        Ok(())
    }

    fn block_count(&self, session: SessionIndex) -> Result<u64> {
        Ok(self.block_counts[session.as_usize()])
    }

    fn fsync(&self, _session: SessionIndex) -> Result<()> {
        // No-op: real flush happens via commit().
        Ok(())
    }

    fn init_blockstream(&mut self, session: SessionIndex) -> Result<()> {
        let si = session.as_usize();
        let su8 = session.as_u8();

        // Remove buffered writes for this session.
        self.ram_buffer.retain(|bw| bw.session != su8);

        // Delete this session's blocks from redb.
        let txn = self.db.begin_write().map_err(|e| {
            SecureStorageError::Storage(format!("redb write txn: {e}"))
        })?;
        {
            let mut table = txn.open_table(BLOCKS).map_err(|e| {
                SecureStorageError::Storage(format!("redb open table: {e}"))
            })?;

            // Collect keys to delete (all keys starting with this session byte).
            let prefix_start = Self::make_block_key(su8, 0);
            let prefix_end = Self::make_block_key(su8, u64::MAX);
            let range = table
                .range(prefix_start.as_slice()..=prefix_end.as_slice())
                .map_err(|e| {
                    SecureStorageError::Storage(format!("redb range: {e}"))
                })?;
            let keys: Vec<[u8; 9]> = range
                .filter_map(|entry| {
                    let (k, _) = entry.ok()?;
                    let kb = k.value();
                    if kb.len() == 9 {
                        let mut arr = [0u8; 9];
                        arr.copy_from_slice(kb);
                        Some(arr)
                    } else {
                        None
                    }
                })
                .collect();
            for key in &keys {
                table.remove(key.as_slice()).map_err(|e| {
                    SecureStorageError::Storage(format!("redb remove: {e}"))
                })?;
            }
        }
        txn.commit().map_err(|e| {
            SecureStorageError::Storage(format!("redb commit: {e}"))
        })?;

        self.block_counts[si] = 0;
        Ok(())
    }
}

// ── KeypairStorage ───────────────────────────────────────────────────

impl KeypairStorage for RedbStorage {
    fn read_keypair(&self, session: SessionIndex) -> Result<Zeroizing<Vec<u8>>> {
        let txn = self.db.begin_read().map_err(|e| {
            SecureStorageError::Storage(format!("redb read txn: {e}"))
        })?;
        let table = match txn.open_table(KEYPAIRS) {
            Ok(t) => t,
            Err(redb::TableError::TableDoesNotExist(_)) => {
                return Err(SecureStorageError::Storage("keypair not found".into()));
            }
            Err(e) => {
                return Err(SecureStorageError::Storage(format!(
                    "redb open table: {e}"
                )));
            }
        };
        let key = [session.as_u8()];
        let entry = table.get(key.as_slice()).map_err(|e| {
            SecureStorageError::Storage(format!("redb get: {e}"))
        })?;
        match entry {
            Some(val) => Ok(Zeroizing::new(val.value().to_vec())),
            None => Err(SecureStorageError::Storage("keypair not found".into())),
        }
    }

    fn write_keypair(&mut self, session: SessionIndex, data: &[u8]) -> Result<()> {
        let txn = self.db.begin_write().map_err(|e| {
            SecureStorageError::Storage(format!("redb write txn: {e}"))
        })?;
        {
            let mut table = txn.open_table(KEYPAIRS).map_err(|e| {
                SecureStorageError::Storage(format!("redb open table: {e}"))
            })?;
            let key = [session.as_u8()];
            table.insert(key.as_slice(), data).map_err(|e| {
                SecureStorageError::Storage(format!("redb insert: {e}"))
            })?;
        }
        txn.commit().map_err(|e| {
            SecureStorageError::Storage(format!("redb commit: {e}"))
        })?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn make_storage() -> (RedbStorage, TempDir) {
        let dir = TempDir::new().unwrap();
        let storage = RedbStorage::open(dir.path()).unwrap();
        (storage, dir)
    }

    fn make_block(fill: u8) -> Box<[u8; BLOCK_SIZE]> {
        let mut b = Box::new([0u8; BLOCK_SIZE]);
        b.fill(fill);
        b
    }

    // ── Basics ───────────────────────────────────────────────────────

    #[test]
    fn test_open_creates_db() {
        let dir = TempDir::new().unwrap();
        let _storage = RedbStorage::open(dir.path()).unwrap();
        assert!(dir.path().join("storage.redb").exists());
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
    fn test_write_overwrites() {
        let (mut s, _dir) = make_storage();
        let si = SessionIndex::new(0).unwrap();
        s.append_block(si, &make_block(0xAA)).unwrap();
        s.write_block(si, 0, &make_block(0xBB)).unwrap();
        let got = s.read_block(si, 0).unwrap();
        assert_eq!(got[0], 0xBB);
    }

    #[test]
    fn test_read_from_ram_buffer() {
        let (mut s, _dir) = make_storage();
        let si = SessionIndex::new(0).unwrap();
        s.append_block(si, &make_block(0xCC)).unwrap();
        let got = s.read_block(si, 0).unwrap();
        assert_eq!(got[0], 0xCC);
    }

    #[test]
    fn test_ram_buffer_last_write_wins() {
        let (mut s, _dir) = make_storage();
        let si = SessionIndex::new(0).unwrap();
        s.append_block(si, &make_block(0xAA)).unwrap();
        s.write_block(si, 0, &make_block(0xBB)).unwrap();
        s.write_block(si, 0, &make_block(0xCC)).unwrap();
        let got = s.read_block(si, 0).unwrap();
        assert_eq!(got[0], 0xCC);
    }

    #[test]
    fn test_block_count() {
        let (mut s, _dir) = make_storage();
        let si = SessionIndex::new(0).unwrap();
        assert_eq!(s.block_count(si).unwrap(), 0);
        s.append_block(si, &make_block(1)).unwrap();
        assert_eq!(s.block_count(si).unwrap(), 1);
        s.append_block(si, &make_block(2)).unwrap();
        assert_eq!(s.block_count(si).unwrap(), 2);
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

    // ── Keypair ──────────────────────────────────────────────────────

    #[test]
    fn test_keypair_roundtrip() {
        let (mut s, _dir) = make_storage();
        let si = SessionIndex::new(0).unwrap();
        let data = b"fake-keypair-data";
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
    fn test_keypair_overwrite() {
        let (mut s, _dir) = make_storage();
        let si = SessionIndex::new(0).unwrap();
        s.write_keypair(si, b"first").unwrap();
        s.write_keypair(si, b"second").unwrap();
        let got = s.read_keypair(si).unwrap();
        assert_eq!(&*got, b"second");
    }

    // ── Persistence ──────────────────────────────────────────────────

    #[test]
    fn test_commit_persists_across_reopen() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().to_path_buf();

        {
            let mut s = RedbStorage::open(&path).unwrap();
            let si = SessionIndex::new(0).unwrap();
            s.append_block(si, &make_block(0xCD)).unwrap();
            s.commit().unwrap();
        }
        {
            let s = RedbStorage::open(&path).unwrap();
            let si = SessionIndex::new(0).unwrap();
            assert_eq!(s.block_count(si).unwrap(), 1);
            let got = s.read_block(si, 0).unwrap();
            assert_eq!(got[0], 0xCD);
        }
    }

    #[test]
    fn test_uncommitted_writes_lost_on_reopen() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().to_path_buf();

        {
            let mut s = RedbStorage::open(&path).unwrap();
            let si = SessionIndex::new(0).unwrap();
            s.append_block(si, &make_block(0xEE)).unwrap();
            // No commit — drop.
        }
        {
            let s = RedbStorage::open(&path).unwrap();
            let si = SessionIndex::new(0).unwrap();
            assert_eq!(s.block_count(si).unwrap(), 0);
        }
    }

    #[test]
    fn test_multiple_sessions_persist() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().to_path_buf();

        {
            let mut s = RedbStorage::open(&path).unwrap();
            let s0 = SessionIndex::new(0).unwrap();
            let s1 = SessionIndex::new(1).unwrap();
            s.append_block(s0, &make_block(0x11)).unwrap();
            s.append_block(s1, &make_block(0x22)).unwrap();
            s.commit().unwrap();
        }
        {
            let s = RedbStorage::open(&path).unwrap();
            let s0 = SessionIndex::new(0).unwrap();
            let s1 = SessionIndex::new(1).unwrap();
            assert_eq!(s.block_count(s0).unwrap(), 1);
            assert_eq!(s.block_count(s1).unwrap(), 1);
            assert_eq!(s.read_block(s0, 0).unwrap()[0], 0x11);
            assert_eq!(s.read_block(s1, 0).unwrap()[0], 0x22);
        }
    }

    #[test]
    fn test_init_blockstream_clears_session() {
        let (mut s, _dir) = make_storage();
        let si = SessionIndex::new(0).unwrap();
        s.append_block(si, &make_block(0xAA)).unwrap();
        s.commit().unwrap();
        assert_eq!(s.block_count(si).unwrap(), 1);

        s.init_blockstream(si).unwrap();
        assert_eq!(s.block_count(si).unwrap(), 0);
        assert!(s.read_block(si, 0).is_err());
    }

    #[test]
    fn test_keypair_persists_across_reopen() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().to_path_buf();

        {
            let mut s = RedbStorage::open(&path).unwrap();
            let si = SessionIndex::new(0).unwrap();
            s.write_keypair(si, b"persistent-keypair").unwrap();
        }
        {
            let s = RedbStorage::open(&path).unwrap();
            let si = SessionIndex::new(0).unwrap();
            let got = s.read_keypair(si).unwrap();
            assert_eq!(&*got, b"persistent-keypair");
        }
    }
}
