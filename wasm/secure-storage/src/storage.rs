//! Storage abstraction for secureStorage.

use std::collections::HashMap;

use zeroize::Zeroizing;

use crate::{BLOCK_SIZE, Result, SESSION_COUNT, SecureStorageError, SessionIndex};

/// Block-level storage for session blockstream files.
///
/// Each session has up to 256 independent blockstreams identified by a
/// `namespace: u8`. A `(session, namespace)` pair owns a contiguous sequence
/// of fixed-size blocks. Block indices are local to each
/// `(session, namespace)` pair — block 0 in `(session=0, namespace=0)` is
/// unrelated to block 0 in `(session=0, namespace=1)`.
pub trait BlockStorage {
    /// Read a block at the given index from a session/namespace's blockstream.
    fn read_block(
        &self,
        session: SessionIndex,
        namespace: u8,
        block: u64,
    ) -> Result<Box<[u8; BLOCK_SIZE]>>;

    /// Write a block at the given index to a session/namespace's blockstream.
    fn write_block(
        &mut self,
        session: SessionIndex,
        namespace: u8,
        block: u64,
        data: &[u8; BLOCK_SIZE],
    ) -> Result<()>;

    /// Append a new block at the end of a session/namespace's blockstream.
    fn append_block(
        &mut self,
        session: SessionIndex,
        namespace: u8,
        data: &[u8; BLOCK_SIZE],
    ) -> Result<()>;

    /// Number of blocks currently in a session/namespace's blockstream.
    fn block_count(&self, session: SessionIndex, namespace: u8) -> Result<u64>;

    /// Notify the backend that a logical write batch is complete.
    ///
    /// On filesystem backends this calls `fsync`. On IDB this is a no-op:
    /// durability is handled by `persist_dirty` (async batch commit).
    fn fsync(&self, session: SessionIndex, namespace: u8) -> Result<()>;

    /// Reset a session/namespace blockstream to empty (length 0).
    ///
    /// If the blockstream already exists, all existing blocks are removed.
    fn init_blockstream(&mut self, session: SessionIndex, namespace: u8) -> Result<()>;
}

/// Keypair file storage for session keypair files.
///
/// Keypair files are session-level (one per session slot), independent of
/// namespaces — the same root keys are shared across every namespace within
/// a session.
pub trait KeypairStorage {
    /// Read the raw keypair file bytes for a session.
    ///
    /// Returns `Zeroizing<Vec<u8>>` so the buffer is zeroized on drop
    /// (keypair files contain encrypted secret key material).
    fn read_keypair(&self, session: SessionIndex) -> Result<Zeroizing<Vec<u8>>>;

    /// Write raw keypair file bytes for a session.
    fn write_keypair(&mut self, session: SessionIndex, data: &[u8]) -> Result<()>;
}

pub struct MemoryStorage {
    keypairs: Vec<Zeroizing<Vec<u8>>>,
    /// `blockstreams[session][namespace] = Vec<block>`. Lazy populated:
    /// only `(session, namespace)` pairs that have been touched get an entry.
    blockstreams: Vec<HashMap<u8, Vec<Box<[u8; BLOCK_SIZE]>>>>,
}

impl Default for MemoryStorage {
    fn default() -> Self {
        Self::new()
    }
}

impl MemoryStorage {
    #[must_use]
    pub fn new() -> Self {
        Self {
            keypairs: (0..SESSION_COUNT).map(|_| Zeroizing::new(Vec::new())).collect(),
            blockstreams: (0..SESSION_COUNT).map(|_| HashMap::new()).collect(),
        }
    }
}

impl BlockStorage for MemoryStorage {
    fn read_block(
        &self,
        session: SessionIndex,
        namespace: u8,
        block: u64,
    ) -> Result<Box<[u8; BLOCK_SIZE]>> {
        let session_blockstreams = &self.blockstreams[session.as_usize()];
        let stream = session_blockstreams
            .get(&namespace)
            .ok_or(SecureStorageError::OutOfBounds)?;
        let idx = usize::try_from(block).map_err(|_| SecureStorageError::Overflow)?;
        stream
            .get(idx)
            .cloned()
            .ok_or(SecureStorageError::OutOfBounds)
    }

    fn write_block(
        &mut self,
        session: SessionIndex,
        namespace: u8,
        block: u64,
        data: &[u8; BLOCK_SIZE],
    ) -> Result<()> {
        let session_blockstreams = &mut self.blockstreams[session.as_usize()];
        let stream = session_blockstreams
            .get_mut(&namespace)
            .ok_or(SecureStorageError::OutOfBounds)?;
        let idx = usize::try_from(block).map_err(|_| SecureStorageError::Overflow)?;
        if idx >= stream.len() {
            return Err(SecureStorageError::OutOfBounds);
        }
        *stream[idx] = *data;
        Ok(())
    }

    fn append_block(
        &mut self,
        session: SessionIndex,
        namespace: u8,
        data: &[u8; BLOCK_SIZE],
    ) -> Result<()> {
        self.blockstreams[session.as_usize()]
            .entry(namespace)
            .or_default()
            .push(Box::new(*data));
        Ok(())
    }

    fn block_count(&self, session: SessionIndex, namespace: u8) -> Result<u64> {
        Ok(self.blockstreams[session.as_usize()]
            .get(&namespace)
            .map(|v| v.len() as u64)
            .unwrap_or(0))
    }

    fn fsync(&self, _session: SessionIndex, _namespace: u8) -> Result<()> {
        Ok(())
    }

    fn init_blockstream(&mut self, session: SessionIndex, namespace: u8) -> Result<()> {
        // Clear any existing blocks (matches IdbStorageState::init_blockstream).
        self.blockstreams[session.as_usize()].insert(namespace, Vec::new());
        Ok(())
    }
}

impl KeypairStorage for MemoryStorage {
    fn read_keypair(&self, session: SessionIndex) -> Result<Zeroizing<Vec<u8>>> {
        let data = &self.keypairs[session.as_usize()];
        if data.is_empty() {
            return Err(SecureStorageError::Storage("keypair not found".into()));
        }
        Ok(Zeroizing::new((**data).clone()))
    }

    fn write_keypair(&mut self, session: SessionIndex, data: &[u8]) -> Result<()> {
        self.keypairs[session.as_usize()] = Zeroizing::new(data.to_vec());
        Ok(())
    }
}

#[cfg(not(target_arch = "wasm32"))]
mod fs_backend {
    use super::*;
    use std::fs::{self, File, OpenOptions};
    use std::io::{Read, Seek, SeekFrom, Write};
    use std::path::{Path, PathBuf};

    pub struct FsStorage {
        base: PathBuf,
    }

    impl FsStorage {
        pub fn new(base: &Path) -> Result<Self> {
            let sessions_dir = base.join("sessions");
            fs::create_dir_all(&sessions_dir)?;

            Ok(Self {
                base: base.to_path_buf(),
            })
        }

        fn blocks_path(&self, session: SessionIndex, namespace: u8) -> PathBuf {
            self.base.join("sessions").join(format!(
                "session_{}_n_{namespace}.blocks",
                session.as_u8()
            ))
        }

        fn keypair_path(&self, session: SessionIndex) -> PathBuf {
            self.base
                .join("sessions")
                .join(format!("session_{}.keypair", session.as_u8()))
        }
    }

    impl BlockStorage for FsStorage {
        fn read_block(
            &self,
            session: SessionIndex,
            namespace: u8,
            block: u64,
        ) -> Result<Box<[u8; BLOCK_SIZE]>> {
            let mut file = File::open(self.blocks_path(session, namespace))
                .map_err(|_| SecureStorageError::OutOfBounds)?;
            let offset = block
                .checked_mul(BLOCK_SIZE as u64)
                .ok_or(SecureStorageError::Overflow)?;
            file.seek(SeekFrom::Start(offset))?;

            let mut buf = Box::new([0u8; BLOCK_SIZE]);
            file.read_exact(buf.as_mut())
                .map_err(|_| SecureStorageError::OutOfBounds)?;
            Ok(buf)
        }

        fn write_block(
            &mut self,
            session: SessionIndex,
            namespace: u8,
            block: u64,
            data: &[u8; BLOCK_SIZE],
        ) -> Result<()> {
            let count = self.block_count(session, namespace)?;
            if block >= count {
                return Err(SecureStorageError::OutOfBounds);
            }

            let mut file = OpenOptions::new()
                .write(true)
                .open(self.blocks_path(session, namespace))?;

            let offset = block
                .checked_mul(BLOCK_SIZE as u64)
                .ok_or(SecureStorageError::Overflow)?;
            file.seek(SeekFrom::Start(offset))?;
            file.write_all(data)?;
            Ok(())
        }

        fn append_block(
            &mut self,
            session: SessionIndex,
            namespace: u8,
            data: &[u8; BLOCK_SIZE],
        ) -> Result<()> {
            let path = self.blocks_path(session, namespace);
            let mut file = OpenOptions::new().create(true).append(true).open(&path)?;
            file.write_all(data)?;
            Ok(())
        }

        fn block_count(&self, session: SessionIndex, namespace: u8) -> Result<u64> {
            let path = self.blocks_path(session, namespace);
            if !path.exists() {
                return Ok(0);
            }
            let metadata = fs::metadata(&path)?;
            let len = metadata.len();
            let block_size = BLOCK_SIZE as u64;
            if len % block_size != 0 {
                return Err(SecureStorageError::CorruptedBlock);
            }
            Ok(len / block_size)
        }

        fn fsync(&self, session: SessionIndex, namespace: u8) -> Result<()> {
            let path = self.blocks_path(session, namespace);
            if !path.exists() {
                return Ok(());
            }
            let file = File::open(&path)?;
            file.sync_all()?;
            Ok(())
        }

        fn init_blockstream(&mut self, session: SessionIndex, namespace: u8) -> Result<()> {
            let path = self.blocks_path(session, namespace);
            // Create or truncate to zero length, matching the trait contract
            // ("reset to empty"). The old code used create_new + AlreadyExists
            // fallback which left existing blocks intact — a data leak.
            OpenOptions::new()
                .create(true)
                .write(true)
                .truncate(true)
                .open(&path)?;
            Ok(())
        }
    }

    impl KeypairStorage for FsStorage {
        fn read_keypair(&self, session: SessionIndex) -> Result<Zeroizing<Vec<u8>>> {
            let data = fs::read(self.keypair_path(session)).map_err(|e| {
                if e.kind() == std::io::ErrorKind::NotFound {
                    SecureStorageError::Storage("keypair not found".into())
                } else {
                    SecureStorageError::Io(e)
                }
            })?;
            Ok(Zeroizing::new(data))
        }

        fn write_keypair(&mut self, session: SessionIndex, data: &[u8]) -> Result<()> {
            fs::write(self.keypair_path(session), data)?;
            Ok(())
        }
    }
}

#[cfg(not(target_arch = "wasm32"))]
pub use fs_backend::FsStorage;

#[cfg(test)]
mod tests {
    use super::*;

    const NS: u8 = 0;

    fn make_block(fill: u8) -> Box<[u8; BLOCK_SIZE]> {
        let mut block = Box::new([0u8; BLOCK_SIZE]);
        block.fill(fill);
        block
    }

    #[test]
    fn test_memory_append_and_read() {
        let mut store = MemoryStorage::new();
        let s0 = SessionIndex::new(0).unwrap();

        let block = make_block(0xAB);
        store.append_block(s0, NS, &block).unwrap();

        let read_back = store.read_block(s0, NS, 0).unwrap();
        assert_eq!(*read_back, *block);
    }

    #[test]
    fn test_memory_block_count() {
        let mut store = MemoryStorage::new();
        let s0 = SessionIndex::new(0).unwrap();

        assert_eq!(store.block_count(s0, NS).unwrap(), 0);

        store.append_block(s0, NS, &make_block(1)).unwrap();
        assert_eq!(store.block_count(s0, NS).unwrap(), 1);

        store.append_block(s0, NS, &make_block(2)).unwrap();
        assert_eq!(store.block_count(s0, NS).unwrap(), 2);
    }

    #[test]
    fn test_memory_write_overwrites() {
        let mut store = MemoryStorage::new();
        let s0 = SessionIndex::new(0).unwrap();

        store.append_block(s0, NS, &make_block(0xAA)).unwrap();

        let new_block = make_block(0xBB);
        store.write_block(s0, NS, 0, &new_block).unwrap();

        let read_back = store.read_block(s0, NS, 0).unwrap();
        assert_eq!(read_back[0], 0xBB);
    }

    #[test]
    fn test_memory_read_oob() {
        let store = MemoryStorage::new();
        let s0 = SessionIndex::new(0).unwrap();

        let result = store.read_block(s0, NS, 0);
        assert!(result.is_err());
    }

    #[test]
    fn test_memory_write_oob() {
        let mut store = MemoryStorage::new();
        let s0 = SessionIndex::new(0).unwrap();

        let result = store.write_block(s0, NS, 0, &make_block(0));
        assert!(result.is_err());
    }

    #[test]
    fn test_memory_sessions_independent() {
        let mut store = MemoryStorage::new();
        let s0 = SessionIndex::new(0).unwrap();
        let s1 = SessionIndex::new(1).unwrap();

        store.append_block(s0, NS, &make_block(0xAA)).unwrap();

        assert_eq!(store.block_count(s0, NS).unwrap(), 1);
        assert_eq!(store.block_count(s1, NS).unwrap(), 0);
    }

    #[test]
    fn test_memory_namespaces_independent() {
        let mut store = MemoryStorage::new();
        let s0 = SessionIndex::new(0).unwrap();

        store.append_block(s0, 0, &make_block(0xAA)).unwrap();
        store.append_block(s0, 1, &make_block(0xBB)).unwrap();
        store.append_block(s0, 1, &make_block(0xCC)).unwrap();

        assert_eq!(store.block_count(s0, 0).unwrap(), 1);
        assert_eq!(store.block_count(s0, 1).unwrap(), 2);
        assert_eq!(store.block_count(s0, 2).unwrap(), 0);

        assert_eq!(store.read_block(s0, 0, 0).unwrap()[0], 0xAA);
        assert_eq!(store.read_block(s0, 1, 0).unwrap()[0], 0xBB);
        assert_eq!(store.read_block(s0, 1, 1).unwrap()[0], 0xCC);
    }

    #[test]
    fn test_memory_init_blockstream_creates_empty() {
        let mut store = MemoryStorage::new();
        let s0 = SessionIndex::new(0).unwrap();

        store.init_blockstream(s0, 7).unwrap();
        assert_eq!(store.block_count(s0, 7).unwrap(), 0);
    }

    #[test]
    fn test_memory_keypair_roundtrip() {
        let mut store = MemoryStorage::new();
        let s0 = SessionIndex::new(0).unwrap();

        let data = b"fake-keypair-data";
        store.write_keypair(s0, data).unwrap();

        let read_back = store.read_keypair(s0).unwrap();
        assert_eq!(&*read_back, data);
    }

    #[test]
    fn test_memory_keypair_not_found() {
        let store = MemoryStorage::new();
        let s0 = SessionIndex::new(0).unwrap();

        let result = store.read_keypair(s0);
        assert!(result.is_err());
    }

    #[test]
    fn test_memory_fsync_is_noop() {
        let store = MemoryStorage::new();
        let s0 = SessionIndex::new(0).unwrap();
        store.fsync(s0, NS).unwrap();
    }

    #[cfg(not(target_arch = "wasm32"))]
    mod fs_tests {
        use super::*;
        use tempfile::TempDir;

        fn make_fs_storage() -> (FsStorage, TempDir) {
            let dir = TempDir::new().unwrap();
            let storage = FsStorage::new(dir.path()).unwrap();
            (storage, dir)
        }

        #[test]
        fn test_fs_append_and_read() {
            let (mut store, _dir) = make_fs_storage();
            let s0 = SessionIndex::new(0).unwrap();

            let block = make_block(0xCD);
            store.append_block(s0, NS, &block).unwrap();

            let read_back = store.read_block(s0, NS, 0).unwrap();
            assert_eq!(*read_back, *block);
        }

        #[test]
        fn test_fs_block_count() {
            let (mut store, _dir) = make_fs_storage();
            let s0 = SessionIndex::new(0).unwrap();

            assert_eq!(store.block_count(s0, NS).unwrap(), 0);

            store.append_block(s0, NS, &make_block(1)).unwrap();
            assert_eq!(store.block_count(s0, NS).unwrap(), 1);
        }

        #[test]
        fn test_fs_write_overwrites() {
            let (mut store, _dir) = make_fs_storage();
            let s0 = SessionIndex::new(0).unwrap();

            store.append_block(s0, NS, &make_block(0xAA)).unwrap();

            let new_block = make_block(0xBB);
            store.write_block(s0, NS, 0, &new_block).unwrap();

            let read_back = store.read_block(s0, NS, 0).unwrap();
            assert_eq!(read_back[0], 0xBB);
        }

        #[test]
        fn test_fs_read_oob() {
            let (store, _dir) = make_fs_storage();
            let s0 = SessionIndex::new(0).unwrap();

            let result = store.read_block(s0, NS, 0);
            assert!(result.is_err());
        }

        #[test]
        fn test_fs_namespaces_independent() {
            let (mut store, _dir) = make_fs_storage();
            let s0 = SessionIndex::new(0).unwrap();

            store.append_block(s0, 0, &make_block(0xAA)).unwrap();
            store.append_block(s0, 1, &make_block(0xBB)).unwrap();

            assert_eq!(store.block_count(s0, 0).unwrap(), 1);
            assert_eq!(store.block_count(s0, 1).unwrap(), 1);
            assert_eq!(store.read_block(s0, 0, 0).unwrap()[0], 0xAA);
            assert_eq!(store.read_block(s0, 1, 0).unwrap()[0], 0xBB);
        }

        #[test]
        fn test_fs_keypair_roundtrip() {
            let (mut store, _dir) = make_fs_storage();
            let s0 = SessionIndex::new(0).unwrap();

            let data = b"fake-keypair-bytes-here";
            store.write_keypair(s0, data).unwrap();

            let read_back = store.read_keypair(s0).unwrap();
            assert_eq!(&*read_back, data);
        }

        #[test]
        fn test_fs_sessions_independent() {
            let (mut store, _dir) = make_fs_storage();
            let s0 = SessionIndex::new(0).unwrap();
            let s1 = SessionIndex::new(1).unwrap();

            store.append_block(s0, NS, &make_block(0xAA)).unwrap();

            assert_eq!(store.block_count(s0, NS).unwrap(), 1);
            assert_eq!(store.block_count(s1, NS).unwrap(), 0);
        }

        #[test]
        fn test_fs_write_oob() {
            let (mut store, _dir) = make_fs_storage();
            let s0 = SessionIndex::new(0).unwrap();

            let result = store.write_block(s0, NS, 0, &make_block(0));
            assert!(result.is_err());
        }

        #[test]
        fn test_fs_keypair_not_found() {
            let (store, _dir) = make_fs_storage();
            let s0 = SessionIndex::new(0).unwrap();

            let result = store.read_keypair(s0);
            assert!(result.is_err());
        }

        #[test]
        fn test_fs_fsync() {
            let (mut store, _dir) = make_fs_storage();
            let s0 = SessionIndex::new(0).unwrap();

            store.append_block(s0, NS, &make_block(0xAB)).unwrap();
            store.fsync(s0, NS).unwrap();
        }
    }
}
