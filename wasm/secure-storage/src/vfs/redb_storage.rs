//! redb-backed block & keypair storage for native targets (iOS/Android).
//!
//! All blocks and keypairs are stored in a single `storage.redb` file.
//! Writes are buffered in a RAM buffer. On `commit()` the entire buffer
//! is flushed as a single ACID transaction; redb handles crash safety
//! internally, so no custom WAL is needed.
//!
//! Block keys are 10-byte composites: `[session, namespace, block_id(8)]`.
//! This maps directly to the `(SessionIndex, namespace: u8, block: u64)`
//! tuple in the [`BlockStorage`] trait.

use std::collections::HashMap;
use std::fs;
use std::path::Path;

use redb::{Database, ReadableTable, TableDefinition};
use zeroize::Zeroizing;

use crate::constants::{BLOCK_SIZE, SESSION_COUNT};
use crate::error::{Result, SecureStorageError};
use crate::storage::{BlockStorage, KeypairStorage};
use crate::types::SessionIndex;

// ── redb table definitions ───────────────────────────────────────────

const BLOCKS: TableDefinition<&[u8], &[u8]> = TableDefinition::new("blocks");
const KEYPAIRS: TableDefinition<&[u8], &[u8]> = TableDefinition::new("keypairs");

// ── Buffered write ───────────────────────────────────────────────────

/// Block-key layout: 1 byte session + 1 byte namespace + 8 bytes block_id BE.
const BLOCK_KEY_LEN: usize = 10;
type BlockKey = [u8; BLOCK_KEY_LEN];

/// Closure factory for `.map_err`. Wraps any `Display`-able redb error
/// into a `SecureStorageError::Storage(format!("redb {ctx}: {e}"))`,
/// dropping ~20 characters per call site versus an inline closure.
fn redb_err<E: std::fmt::Display>(ctx: &'static str) -> impl FnOnce(E) -> SecureStorageError {
    move |e| SecureStorageError::Storage(format!("redb {ctx}: {e}"))
}

struct BufferedWrite {
    session: u8,
    namespace: u8,
    block_id: u64,
    data: Box<[u8; BLOCK_SIZE]>,
}

// ── RedbStorage ──────────────────────────────────────────────────────

/// Single-file storage backend using redb.
pub struct RedbStorage {
    db: Database,
    ram_buffer: Vec<BufferedWrite>,
    /// Overlay index: maps a (session, namespace, block_id) key to the
    /// position in `ram_buffer` of the last buffered write at that key.
    ///
    /// Replaces the previous O(buffer_len) linear scan in `read_block`
    /// with an O(1) lookup. Stays in sync with `ram_buffer`: every
    /// `write_block` / `append_block` updates this map; `commit` and
    /// `reset_blockstream` invalidate the affected entries.
    ram_overlay: HashMap<BlockKey, usize>,
    /// `block_counts[session][namespace] = count`. Lazy: only populated
    /// namespaces appear in the inner map.
    block_counts: Vec<HashMap<u8, u64>>,
}

impl RedbStorage {
    /// Open (or create) a redb database at `base/storage.redb`.
    pub fn open(base: &Path) -> Result<Self> {
        fs::create_dir_all(base)?;
        let db_path = base.join("storage.redb");
        let db = Database::create(&db_path)
            .map_err(redb_err("open"))?;

        let mut storage = Self {
            db,
            ram_buffer: Vec::new(),
            ram_overlay: HashMap::new(),
            block_counts: (0..SESSION_COUNT).map(|_| HashMap::new()).collect(),
        };
        storage.rebuild_block_counts()?;
        Ok(storage)
    }

    /// Scan the BLOCKS table and count entries per `(session, namespace)`.
    fn rebuild_block_counts(&mut self) -> Result<()> {
        let txn = self
            .db
            .begin_read()
            .map_err(redb_err("read txn"))?;

        let table = match txn.open_table(BLOCKS) {
            Ok(t) => t,
            Err(redb::TableError::TableDoesNotExist(_)) => return Ok(()),
            Err(e) => return Err(SecureStorageError::Storage(format!("redb open table: {e}"))),
        };

        for counts in &mut self.block_counts {
            counts.clear();
        }

        let iter = table
            .iter()
            .map_err(redb_err("iter"))?;
        for entry in iter {
            let (key, _val) =
                entry.map_err(redb_err("entry"))?;
            let key_bytes = key.value();
            if key_bytes.len() == BLOCK_KEY_LEN {
                let session = key_bytes[0] as usize;
                let namespace = key_bytes[1];
                if session < SESSION_COUNT {
                    *self.block_counts[session].entry(namespace).or_insert(0) += 1;
                }
            }
        }
        Ok(())
    }

    /// Encode `(session, namespace, block_id)` as a 10-byte key.
    fn make_block_key(session: u8, namespace: u8, block_id: u64) -> BlockKey {
        let mut key = [0u8; BLOCK_KEY_LEN];
        key[0] = session;
        key[1] = namespace;
        key[2..10].copy_from_slice(&block_id.to_be_bytes());
        key
    }

    /// Return true if the on-disk database already has any keypair
    /// entries; used to gate `provision` at boot so we don't wipe
    /// existing slots by re-provisioning random throwaway keys.
    pub fn has_data(&self) -> Result<bool> {
        let txn = self
            .db
            .begin_read()
            .map_err(redb_err("read txn"))?;
        let table = match txn.open_table(KEYPAIRS) {
            Ok(t) => t,
            Err(redb::TableError::TableDoesNotExist(_)) => return Ok(false),
            Err(e) => return Err(SecureStorageError::Storage(format!("redb open table: {e}"))),
        };
        let mut iter = table
            .iter()
            .map_err(redb_err("iter"))?;
        Ok(iter.next().is_some())
    }

    /// Batch-insert all buffered writes in a single ACID transaction.
    ///
    /// PD: we always run the redb write transaction, even when the in-memory
    /// buffer is empty. Skipping the empty case would leak "no cover work
    /// this tick" via the absence of an fsync on disk - an attacker watching
    /// I/O timing could distinguish ticks where the scheduler had real work
    /// to do from ticks where it did not. An empty redb txn still produces
    /// a uniform fsync, keeping the on-disk timing pattern indistinguishable.
    pub fn commit(&mut self) -> Result<()> {
        // Dedupe by key using `ram_overlay`: a hot path can buffer multiple
        // writes for the same (session, namespace, block_id) when the SQLite
        // page cache flushes a page that was rewritten in the same txn, when
        // truncate-then-write resequences a block, etc. The overlay map
        // already points each key at the index of its last buffered write,
        // so we re-use it to skip redundant entries instead of paying for
        // them as separate redb inserts.
        let txn = self
            .db
            .begin_write()
            .map_err(redb_err("write txn"))?;
        {
            let mut table = txn
                .open_table(BLOCKS)
                .map_err(redb_err("open table"))?;
            // Iterate in original buffer order so on-disk write order matches
            // the order in which the application made the writes, but using
            // each key's last-buffered value.
            for (i, bw) in self.ram_buffer.iter().enumerate() {
                let key = Self::make_block_key(bw.session, bw.namespace, bw.block_id);
                if self.ram_overlay.get(&key) != Some(&i) {
                    continue;
                }
                table
                    .insert(key.as_slice(), bw.data.as_slice())
                    .map_err(redb_err("insert"))?;
            }
        }
        txn.commit()
            .map_err(redb_err("commit"))?;
        self.ram_buffer.clear();
        self.ram_overlay.clear();
        Ok(())
    }
}

// ── BlockStorage ─────────────────────────────────────────────────────

impl BlockStorage for RedbStorage {
    fn read_block(
        &self,
        session: SessionIndex,
        namespace: u8,
        block: u64,
    ) -> Result<Box<[u8; BLOCK_SIZE]>> {
        let si = session.as_u8();
        let count = self.block_counts[session.as_usize()]
            .get(&namespace)
            .copied()
            .unwrap_or(0);
        if block >= count {
            return Err(SecureStorageError::OutOfBounds);
        }

        // Check RAM buffer first (last-write-wins) via the overlay index.
        let key = Self::make_block_key(si, namespace, block);
        if let Some(&idx) = self.ram_overlay.get(&key) {
            return Ok(self.ram_buffer[idx].data.clone());
        }

        // Fall back to redb.
        let txn = self
            .db
            .begin_read()
            .map_err(redb_err("read txn"))?;
        let table = txn
            .open_table(BLOCKS)
            .map_err(redb_err("open table"))?;
        let entry = table
            .get(key.as_slice())
            .map_err(redb_err("get"))?;
        match entry {
            Some(val) => {
                let val_bytes = val.value();
                if val_bytes.len() != BLOCK_SIZE {
                    return Err(SecureStorageError::CorruptedBlock);
                }
                // SAFETY: `Box::new_uninit` returns a `Box<MaybeUninit<[u8; N]>>`
                // and we initialise every byte via `copy_from_slice` before
                // calling `assume_init`. `val_bytes.len() == BLOCK_SIZE` is
                // checked just above, so the copy fully fills the array.
                // Skipping the `[0u8; BLOCK_SIZE]` zero-init avoids 64 KiB
                // of useless memset per redb read on the hot path.
                let mut buf: Box<std::mem::MaybeUninit<[u8; BLOCK_SIZE]>> = Box::new_uninit();
                let buf_ref: &mut [u8; BLOCK_SIZE] = unsafe { &mut *buf.as_mut_ptr() };
                buf_ref.copy_from_slice(val_bytes);
                Ok(unsafe { buf.assume_init() })
            }
            None => Err(SecureStorageError::OutOfBounds),
        }
    }

    fn write_block(
        &mut self,
        session: SessionIndex,
        namespace: u8,
        block: u64,
        data: &[u8; BLOCK_SIZE],
    ) -> Result<()> {
        let count = self.block_counts[session.as_usize()]
            .get(&namespace)
            .copied()
            .unwrap_or(0);
        if block >= count {
            return Err(SecureStorageError::OutOfBounds);
        }
        let key = Self::make_block_key(session.as_u8(), namespace, block);
        self.ram_buffer.push(BufferedWrite {
            session: session.as_u8(),
            namespace,
            block_id: block,
            data: Box::new(*data),
        });
        self.ram_overlay.insert(key, self.ram_buffer.len() - 1);
        Ok(())
    }

    fn append_block(
        &mut self,
        session: SessionIndex,
        namespace: u8,
        data: &[u8; BLOCK_SIZE],
    ) -> Result<()> {
        let count = self.block_counts[session.as_usize()]
            .entry(namespace)
            .or_insert(0);
        let block_id = *count;
        let key = Self::make_block_key(session.as_u8(), namespace, block_id);
        self.ram_buffer.push(BufferedWrite {
            session: session.as_u8(),
            namespace,
            block_id,
            data: Box::new(*data),
        });
        self.ram_overlay.insert(key, self.ram_buffer.len() - 1);
        *count += 1;
        Ok(())
    }

    fn block_count(&self, session: SessionIndex, namespace: u8) -> Result<u64> {
        Ok(self.block_counts[session.as_usize()]
            .get(&namespace)
            .copied()
            .unwrap_or(0))
    }

    fn fsync(&self, _session: SessionIndex, _namespace: u8) -> Result<()> {
        // No-op: real flush happens via commit().
        Ok(())
    }

    fn reset_blockstream(&mut self, session: SessionIndex, namespace: u8) -> Result<()> {
        let si = session.as_usize();
        let su8 = session.as_u8();

        // Remove buffered writes for this (session, namespace) and the
        // matching overlay entries. The overlay's index values point into
        // ram_buffer, so we must rebuild it after the retain rather than
        // try to fix indices in place.
        self.ram_buffer
            .retain(|bw| !(bw.session == su8 && bw.namespace == namespace));
        self.ram_overlay.clear();
        for (i, bw) in self.ram_buffer.iter().enumerate() {
            let k = Self::make_block_key(bw.session, bw.namespace, bw.block_id);
            self.ram_overlay.insert(k, i);
        }

        // Delete this (session, namespace)'s blocks from redb.
        let txn = self
            .db
            .begin_write()
            .map_err(redb_err("write txn"))?;
        {
            let mut table = txn
                .open_table(BLOCKS)
                .map_err(redb_err("open table"))?;

            // Delete in place via `retain_in`: skips the
            // `Vec<BlockKey>` materialisation of every key in the range
            // before re-walking it for `remove`. Useful for namespaces
            // that have grown to thousands of blocks.
            let prefix_start = Self::make_block_key(su8, namespace, 0);
            let prefix_end = Self::make_block_key(su8, namespace, u64::MAX);
            table
                .retain_in(
                    prefix_start.as_slice()..=prefix_end.as_slice(),
                    |_k, _v| false,
                )
                .map_err(redb_err("retain_in"))?;
        }
        txn.commit()
            .map_err(redb_err("commit"))?;

        self.block_counts[si].remove(&namespace);
        Ok(())
    }

    fn namespaces_with_data(&self, session: SessionIndex) -> Result<Vec<u8>> {
        // `block_counts` is the in-memory authoritative count; entries with
        // count == 0 (which `reset_blockstream` removes) and never-written
        // namespaces both correctly map to "no data". Also account for
        // un-committed writes still in `ram_buffer` for newly-written
        // namespaces that don't yet appear in `block_counts`.
        let si = session.as_usize();
        let su8 = session.as_u8();
        let mut out: Vec<u8> = self.block_counts[si]
            .iter()
            .filter(|(_, count)| **count > 0)
            .map(|(ns, _)| *ns)
            .collect();
        for bw in &self.ram_buffer {
            if bw.session == su8 && !out.contains(&bw.namespace) {
                out.push(bw.namespace);
            }
        }
        Ok(out)
    }
}

// ── KeypairStorage ───────────────────────────────────────────────────

impl KeypairStorage for RedbStorage {
    fn read_keypair(&self, session: SessionIndex) -> Result<Zeroizing<Vec<u8>>> {
        let txn = self
            .db
            .begin_read()
            .map_err(redb_err("read txn"))?;
        let table = match txn.open_table(KEYPAIRS) {
            Ok(t) => t,
            Err(redb::TableError::TableDoesNotExist(_)) => {
                return Err(SecureStorageError::Storage("keypair not found".into()));
            }
            Err(e) => {
                return Err(SecureStorageError::Storage(format!("redb open table: {e}")));
            }
        };
        let key = [session.as_u8()];
        let entry = table
            .get(key.as_slice())
            .map_err(redb_err("get"))?;
        match entry {
            Some(val) => Ok(Zeroizing::new(val.value().to_vec())),
            None => Err(SecureStorageError::Storage("keypair not found".into())),
        }
    }

    fn write_keypair(&mut self, session: SessionIndex, data: &[u8]) -> Result<()> {
        let txn = self
            .db
            .begin_write()
            .map_err(redb_err("write txn"))?;
        {
            let mut table = txn
                .open_table(KEYPAIRS)
                .map_err(redb_err("open table"))?;
            let key = [session.as_u8()];
            table
                .insert(key.as_slice(), data)
                .map_err(redb_err("insert"))?;
        }
        txn.commit()
            .map_err(redb_err("commit"))?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::DEFAULT_NAMESPACE as SQL_NAMESPACE;
    use tempfile::TempDir;

    const NS: u8 = SQL_NAMESPACE;

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
        s.append_block(si, NS, &block).unwrap();
        let got = s.read_block(si, NS, 0).unwrap();
        assert_eq!(*got, *block);
    }

    #[test]
    fn test_write_overwrites() {
        let (mut s, _dir) = make_storage();
        let si = SessionIndex::new(0).unwrap();
        s.append_block(si, NS, &make_block(0xAA)).unwrap();
        s.write_block(si, NS, 0, &make_block(0xBB)).unwrap();
        let got = s.read_block(si, NS, 0).unwrap();
        assert_eq!(got[0], 0xBB);
    }

    #[test]
    fn test_ram_buffer_last_write_wins() {
        let (mut s, _dir) = make_storage();
        let si = SessionIndex::new(0).unwrap();
        s.append_block(si, NS, &make_block(0xAA)).unwrap();
        s.write_block(si, NS, 0, &make_block(0xBB)).unwrap();
        s.write_block(si, NS, 0, &make_block(0xCC)).unwrap();
        let got = s.read_block(si, NS, 0).unwrap();
        assert_eq!(got[0], 0xCC);
    }

    #[test]
    fn test_block_count() {
        let (mut s, _dir) = make_storage();
        let si = SessionIndex::new(0).unwrap();
        assert_eq!(s.block_count(si, NS).unwrap(), 0);
        s.append_block(si, NS, &make_block(1)).unwrap();
        assert_eq!(s.block_count(si, NS).unwrap(), 1);
        s.append_block(si, NS, &make_block(2)).unwrap();
        assert_eq!(s.block_count(si, NS).unwrap(), 2);
    }

    #[test]
    fn test_sessions_independent() {
        let (mut s, _dir) = make_storage();
        let s0 = SessionIndex::new(0).unwrap();
        let s1 = SessionIndex::new(1).unwrap();
        s.append_block(s0, NS, &make_block(0xAA)).unwrap();
        assert_eq!(s.block_count(s0, NS).unwrap(), 1);
        assert_eq!(s.block_count(s1, NS).unwrap(), 0);
    }

    #[test]
    fn test_namespaces_independent() {
        let (mut s, _dir) = make_storage();
        let si = SessionIndex::new(0).unwrap();
        s.append_block(si, 0, &make_block(0xAA)).unwrap();
        s.append_block(si, 1, &make_block(0xBB)).unwrap();
        assert_eq!(s.block_count(si, 0).unwrap(), 1);
        assert_eq!(s.block_count(si, 1).unwrap(), 1);
        assert_eq!(s.read_block(si, 0, 0).unwrap()[0], 0xAA);
        assert_eq!(s.read_block(si, 1, 0).unwrap()[0], 0xBB);
    }

    #[test]
    fn test_read_oob() {
        let (s, _dir) = make_storage();
        let si = SessionIndex::new(0).unwrap();
        assert!(s.read_block(si, NS, 0).is_err());
    }

    #[test]
    fn test_write_oob() {
        let (mut s, _dir) = make_storage();
        let si = SessionIndex::new(0).unwrap();
        assert!(s.write_block(si, NS, 0, &make_block(0)).is_err());
    }

    // ── Keypair ──────────────────────────────────────────────────────

    #[test]
    fn test_keypair_roundtrip() {
        let (mut s, _dir) = make_storage();
        let si = SessionIndex::new(0).unwrap();
        s.write_keypair(si, b"fake-keypair-data").unwrap();
        let got = s.read_keypair(si).unwrap();
        assert_eq!(&*got, b"fake-keypair-data");
    }

    #[test]
    fn test_keypair_not_found() {
        let (s, _dir) = make_storage();
        let si = SessionIndex::new(0).unwrap();
        assert!(s.read_keypair(si).is_err());
    }

    // ── Persistence ──────────────────────────────────────────────────

    #[test]
    fn test_commit_persists_across_reopen() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().to_path_buf();
        {
            let mut s = RedbStorage::open(&path).unwrap();
            let si = SessionIndex::new(0).unwrap();
            s.append_block(si, NS, &make_block(0xCD)).unwrap();
            s.commit().unwrap();
        }
        {
            let s = RedbStorage::open(&path).unwrap();
            let si = SessionIndex::new(0).unwrap();
            assert_eq!(s.block_count(si, NS).unwrap(), 1);
            assert_eq!(s.read_block(si, NS, 0).unwrap()[0], 0xCD);
        }
    }

    #[test]
    fn test_uncommitted_writes_lost_on_reopen() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().to_path_buf();
        {
            let mut s = RedbStorage::open(&path).unwrap();
            let si = SessionIndex::new(0).unwrap();
            s.append_block(si, NS, &make_block(0xEE)).unwrap();
            // No commit: drop.
        }
        {
            let s = RedbStorage::open(&path).unwrap();
            let si = SessionIndex::new(0).unwrap();
            assert_eq!(s.block_count(si, NS).unwrap(), 0);
        }
    }

    #[test]
    fn test_reset_blockstream_clears_namespace() {
        let (mut s, _dir) = make_storage();
        let si = SessionIndex::new(0).unwrap();
        s.append_block(si, NS, &make_block(0xAA)).unwrap();
        s.append_block(si, 1, &make_block(0xBB)).unwrap();
        s.commit().unwrap();

        s.reset_blockstream(si, NS).unwrap();
        assert_eq!(s.block_count(si, NS).unwrap(), 0);
        // Other namespace untouched.
        assert_eq!(s.block_count(si, 1).unwrap(), 1);
    }

    #[test]
    fn test_namespace_persists_across_reopen() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().to_path_buf();
        {
            let mut s = RedbStorage::open(&path).unwrap();
            let si = SessionIndex::new(0).unwrap();
            s.append_block(si, 0, &make_block(0x11)).unwrap();
            s.append_block(si, 1, &make_block(0x22)).unwrap();
            s.commit().unwrap();
        }
        {
            let s = RedbStorage::open(&path).unwrap();
            let si = SessionIndex::new(0).unwrap();
            assert_eq!(s.block_count(si, 0).unwrap(), 1);
            assert_eq!(s.block_count(si, 1).unwrap(), 1);
            assert_eq!(s.read_block(si, 0, 0).unwrap()[0], 0x11);
            assert_eq!(s.read_block(si, 1, 0).unwrap()[0], 0x22);
        }
    }
}
