//! Storage abstraction for bordercrypt.

use zeroize::Zeroizing;

use crate::{BLOCK_SIZE, BordercryptError, Result, SESSION_COUNT, SessionIndex};

/// Block-level storage for session blockstream files.
///
/// Each session has a contiguous sequence of fixed-size blocks.
pub trait BlockStorage {
    /// Read a block at the given index from a session's blockstream.
    fn read_block(&self, session: SessionIndex, block: u64) -> Result<Box<[u8; BLOCK_SIZE]>>;

    /// Write a block at the given index to a session's blockstream.
    fn write_block(
        &mut self,
        session: SessionIndex,
        block: u64,
        data: &[u8; BLOCK_SIZE],
    ) -> Result<()>;

    /// Append a new block at the end of a session's blockstream.
    fn append_block(&mut self, session: SessionIndex, data: &[u8; BLOCK_SIZE]) -> Result<()>;

    /// Number of blocks currently in a session's blockstream.
    fn block_count(&self, session: SessionIndex) -> Result<u64>;

    /// Flush writes to durable storage for a session.
    fn fsync(&self, session: SessionIndex) -> Result<()>;

    /// Create an empty blockstream for a session (length 0).
    ///
    /// Called during provisioning. No-op if the blockstream already exists.
    fn init_blockstream(&mut self, session: SessionIndex) -> Result<()>;
}

/// Keypair file storage for session keypair files.
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
    keypairs: Vec<Vec<u8>>,
    blockstreams: Vec<Vec<Box<[u8; BLOCK_SIZE]>>>,
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
            keypairs: (0..SESSION_COUNT).map(|_| Vec::new()).collect(),
            blockstreams: (0..SESSION_COUNT).map(|_| Vec::new()).collect(),
        }
    }
}

impl BlockStorage for MemoryStorage {
    fn read_block(&self, session: SessionIndex, block: u64) -> Result<Box<[u8; BLOCK_SIZE]>> {
        let session_blockstreams = &self.blockstreams[session.as_usize()];
        let idx = usize::try_from(block).map_err(|_| BordercryptError::Overflow)?;
        session_blockstreams
            .get(idx)
            .cloned()
            .ok_or(BordercryptError::OutOfBounds)
    }

    fn write_block(
        &mut self,
        session: SessionIndex,
        block: u64,
        data: &[u8; BLOCK_SIZE],
    ) -> Result<()> {
        let session_blockstreams = &mut self.blockstreams[session.as_usize()];
        let idx = usize::try_from(block).map_err(|_| BordercryptError::Overflow)?;
        if idx >= session_blockstreams.len() {
            return Err(BordercryptError::OutOfBounds);
        }
        *session_blockstreams[idx] = *data;
        Ok(())
    }

    fn append_block(&mut self, session: SessionIndex, data: &[u8; BLOCK_SIZE]) -> Result<()> {
        self.blockstreams[session.as_usize()].push(Box::new(*data));
        Ok(())
    }

    fn block_count(&self, session: SessionIndex) -> Result<u64> {
        Ok(self.blockstreams[session.as_usize()].len() as u64)
    }

    fn fsync(&self, _session: SessionIndex) -> Result<()> {
        Ok(())
    }

    fn init_blockstream(&mut self, session: SessionIndex) -> Result<()> {
        Ok(())
    }
}

impl KeypairStorage for MemoryStorage {
    fn read_keypair(&self, session: SessionIndex) -> Result<Zeroizing<Vec<u8>>> {
        let data = &self.keypairs[session.as_usize()];
        if data.is_empty() {
            return Err(BordercryptError::Storage("keypair not found".into()));
        }
        Ok(Zeroizing::new(data.clone()))
    }

    fn write_keypair(&mut self, session: SessionIndex, data: &[u8]) -> Result<()> {
        self.keypairs[session.as_usize()] = data.to_vec();
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

            for i in 0..SESSION_COUNT as u8 {
                let idx = SessionIndex::new(i)?;
                let blocks_path = sessions_dir.join(format!("session_{}.blocks", idx.as_u8()));
                if !blocks_path.exists() {
                    File::create(&blocks_path)?;
                }
            }

            Ok(Self {
                base: base.to_path_buf(),
            })
        }

        fn blocks_path(&self, session: SessionIndex) -> PathBuf {
            self.base
                .join("sessions")
                .join(format!("session_{}.blocks", session.as_u8()))
        }

        fn keypair_path(&self, session: SessionIndex) -> PathBuf {
            self.base
                .join("sessions")
                .join(format!("session_{}.keypair", session.as_u8()))
        }
    }

    impl BlockStorage for FsStorage {
        fn read_block(&self, session: SessionIndex, block: u64) -> Result<Box<[u8; BLOCK_SIZE]>> {
            let mut file = File::open(self.blocks_path(session))?;
            let offset = block
                .checked_mul(BLOCK_SIZE as u64)
                .ok_or(BordercryptError::Overflow)?;
            file.seek(SeekFrom::Start(offset))?;

            let mut buf = Box::new([0u8; BLOCK_SIZE]);
            file.read_exact(buf.as_mut())
                .map_err(|_| BordercryptError::OutOfBounds)?;
            Ok(buf)
        }

        fn write_block(
            &mut self,
            session: SessionIndex,
            block: u64,
            data: &[u8; BLOCK_SIZE],
        ) -> Result<()> {
            let count = self.block_count(session)?;
            if block >= count {
                return Err(BordercryptError::OutOfBounds);
            }

            let mut file = OpenOptions::new()
                .write(true)
                .open(self.blocks_path(session))?;

            let offset = block
                .checked_mul(BLOCK_SIZE as u64)
                .ok_or(BordercryptError::Overflow)?;
            file.seek(SeekFrom::Start(offset))?;
            file.write_all(data)?;
            Ok(())
        }

        fn append_block(&mut self, session: SessionIndex, data: &[u8; BLOCK_SIZE]) -> Result<()> {
            let mut file = OpenOptions::new()
                .append(true)
                .open(self.blocks_path(session))?;
            file.write_all(data)?;
            Ok(())
        }

        fn block_count(&self, session: SessionIndex) -> Result<u64> {
            let metadata = fs::metadata(self.blocks_path(session))?;
            let len = metadata.len();
            let block_size = BLOCK_SIZE as u64;
            if len % block_size != 0 {
                return Err(BordercryptError::CorruptedBlock);
            }
            Ok(len / block_size)
        }

        fn fsync(&self, session: SessionIndex) -> Result<()> {
            let file = File::open(self.blocks_path(session))?;
            file.sync_all()?;
            Ok(())
        }

        fn init_blockstream(&mut self, session: SessionIndex) -> Result<()> {
            let path = self.blocks_path(session);
            match OpenOptions::new().create_new(true).write(true).open(&path) {
                Ok(_) => Ok(()),
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => Ok(()),
                Err(e) => Err(e.into()),
            }
        }
    }

    impl KeypairStorage for FsStorage {
        fn read_keypair(&self, session: SessionIndex) -> Result<Zeroizing<Vec<u8>>> {
            let data = fs::read(self.keypair_path(session)).map_err(|e| {
                if e.kind() == std::io::ErrorKind::NotFound {
                    BordercryptError::Storage("keypair not found".into())
                } else {
                    BordercryptError::Io(e)
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

#[cfg(target_arch = "wasm32")]
mod wasm_backend {
    use wasm_bindgen::prelude::*;

    use super::*;

    #[wasm_bindgen]
    extern "C" {
        #[wasm_bindgen(js_name = "bordercryptReadBlock")]
        fn js_read_block(session: u8, block: u32) -> Vec<u8>;

        #[wasm_bindgen(js_name = "bordercryptWriteBlock")]
        fn js_write_block(session: u8, block: u32, data: &[u8]);

        #[wasm_bindgen(js_name = "bordercryptAppendBlock")]
        fn js_append_block(session: u8, data: &[u8]);

        #[wasm_bindgen(js_name = "bordercryptBlockCount")]
        fn js_block_count(session: u8) -> u32;

        #[wasm_bindgen(js_name = "bordercryptFsync")]
        fn js_fsync(session: u8);

        #[wasm_bindgen(js_name = "bordercryptReadKeypair")]
        fn js_read_keypair(session: u8) -> Vec<u8>;

        #[wasm_bindgen(js_name = "bordercryptWriteKeypair")]
        fn js_write_keypair(session: u8, data: &[u8]);
    }

    /// Storage backend for WASM — delegates to JS callbacks for OPFS I/O.
    pub struct WasmStorage;

    impl WasmStorage {
        #[must_use]
        pub fn new() -> Self {
            Self
        }
    }

    impl Default for WasmStorage {
        fn default() -> Self {
            Self::new()
        }
    }

    impl BlockStorage for WasmStorage {
        fn read_block(&self, session: SessionIndex, block: u64) -> Result<Box<[u8; BLOCK_SIZE]>> {
            let block_u32 = u32::try_from(block).map_err(|_| BordercryptError::Overflow)?;
            let data = js_read_block(session.as_u8(), block_u32);
            if data.len() != BLOCK_SIZE {
                return Err(BordercryptError::CorruptedBlock);
            }
            let mut buf = Box::new([0u8; BLOCK_SIZE]);
            buf.copy_from_slice(&data);
            Ok(buf)
        }

        fn write_block(
            &mut self,
            session: SessionIndex,
            block: u64,
            data: &[u8; BLOCK_SIZE],
        ) -> Result<()> {
            let block_u32 = u32::try_from(block).map_err(|_| BordercryptError::Overflow)?;
            js_write_block(session.as_u8(), block_u32, data);
            Ok(())
        }

        fn append_block(&mut self, session: SessionIndex, data: &[u8; BLOCK_SIZE]) -> Result<()> {
            js_append_block(session.as_u8(), data);
            Ok(())
        }

        fn block_count(&self, session: SessionIndex) -> Result<u64> {
            Ok(u64::from(js_block_count(session.as_u8())))
        }

        fn fsync(&self, session: SessionIndex) -> Result<()> {
            js_fsync(session.as_u8());
            Ok(())
        }

        fn init_blockstream(&mut self, _session: SessionIndex) -> Result<()> {
            // JS backends (OPFS/IDB) create blockstreams during worker init.
            Ok(())
        }
    }

    impl KeypairStorage for WasmStorage {
        fn read_keypair(&self, session: SessionIndex) -> Result<Zeroizing<Vec<u8>>> {
            let data = js_read_keypair(session.as_u8());
            if data.is_empty() {
                return Err(BordercryptError::Storage("keypair not found".into()));
            }
            Ok(Zeroizing::new(data))
        }

        fn write_keypair(&mut self, session: SessionIndex, data: &[u8]) -> Result<()> {
            js_write_keypair(session.as_u8(), data);
            Ok(())
        }
    }
}

#[cfg(target_arch = "wasm32")]
pub use wasm_backend::WasmStorage;

#[cfg(test)]
mod tests {
    use super::*;

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
        store.append_block(s0, &block).unwrap();

        let read_back = store.read_block(s0, 0).unwrap();
        assert_eq!(*read_back, *block);
    }

    #[test]
    fn test_memory_block_count() {
        let mut store = MemoryStorage::new();
        let s0 = SessionIndex::new(0).unwrap();

        assert_eq!(store.block_count(s0).unwrap(), 0);

        store.append_block(s0, &make_block(1)).unwrap();
        assert_eq!(store.block_count(s0).unwrap(), 1);

        store.append_block(s0, &make_block(2)).unwrap();
        assert_eq!(store.block_count(s0).unwrap(), 2);
    }

    #[test]
    fn test_memory_write_overwrites() {
        let mut store = MemoryStorage::new();
        let s0 = SessionIndex::new(0).unwrap();

        store.append_block(s0, &make_block(0xAA)).unwrap();

        let new_block = make_block(0xBB);
        store.write_block(s0, 0, &new_block).unwrap();

        let read_back = store.read_block(s0, 0).unwrap();
        assert_eq!(read_back[0], 0xBB);
    }

    #[test]
    fn test_memory_read_oob() {
        let store = MemoryStorage::new();
        let s0 = SessionIndex::new(0).unwrap();

        let result = store.read_block(s0, 0);
        assert!(result.is_err());
    }

    #[test]
    fn test_memory_write_oob() {
        let mut store = MemoryStorage::new();
        let s0 = SessionIndex::new(0).unwrap();

        let result = store.write_block(s0, 0, &make_block(0));
        assert!(result.is_err());
    }

    #[test]
    fn test_memory_sessions_independent() {
        let mut store = MemoryStorage::new();
        let s0 = SessionIndex::new(0).unwrap();
        let s1 = SessionIndex::new(1).unwrap();

        store.append_block(s0, &make_block(0xAA)).unwrap();

        assert_eq!(store.block_count(s0).unwrap(), 1);
        assert_eq!(store.block_count(s1).unwrap(), 0);
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
        store.fsync(s0).unwrap();
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
            store.append_block(s0, &block).unwrap();

            let read_back = store.read_block(s0, 0).unwrap();
            assert_eq!(*read_back, *block);
        }

        #[test]
        fn test_fs_block_count() {
            let (mut store, _dir) = make_fs_storage();
            let s0 = SessionIndex::new(0).unwrap();

            assert_eq!(store.block_count(s0).unwrap(), 0);

            store.append_block(s0, &make_block(1)).unwrap();
            assert_eq!(store.block_count(s0).unwrap(), 1);
        }

        #[test]
        fn test_fs_write_overwrites() {
            let (mut store, _dir) = make_fs_storage();
            let s0 = SessionIndex::new(0).unwrap();

            store.append_block(s0, &make_block(0xAA)).unwrap();

            let new_block = make_block(0xBB);
            store.write_block(s0, 0, &new_block).unwrap();

            let read_back = store.read_block(s0, 0).unwrap();
            assert_eq!(read_back[0], 0xBB);
        }

        #[test]
        fn test_fs_read_oob() {
            let (store, _dir) = make_fs_storage();
            let s0 = SessionIndex::new(0).unwrap();

            let result = store.read_block(s0, 0);
            assert!(result.is_err());
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

            store.append_block(s0, &make_block(0xAA)).unwrap();

            assert_eq!(store.block_count(s0).unwrap(), 1);
            assert_eq!(store.block_count(s1).unwrap(), 0);
        }

        #[test]
        fn test_fs_write_oob() {
            let (mut store, _dir) = make_fs_storage();
            let s0 = SessionIndex::new(0).unwrap();

            let result = store.write_block(s0, 0, &make_block(0));
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

            store.append_block(s0, &make_block(0xAB)).unwrap();
            store.fsync(s0).unwrap();
        }
    }
}
