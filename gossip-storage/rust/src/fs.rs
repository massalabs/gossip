//! FileSystem trait for abstracting storage operations.
//!
//! This trait allows the storage layer to work with different backends:
//! - OPFS (via JS imports in WASM)
//! - Native fs (via WASI)
//! - In-memory (for testing)
//!
//! # Security Notes
//!
//! - The FileSystem trait itself has no security logic - all encryption
//!   happens at higher layers (BlockManager, Session)
//! - `InMemoryFs` is for testing only and stores data in plaintext
//! - Production uses OPFS via JS imports with encrypted data only

use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

/// File identifiers for the two blobs
pub const FILE_ADDRESSING: u32 = 0;
pub const FILE_DATA: u32 = 1;

/// Abstract filesystem operations
pub trait FileSystem {
    /// Read bytes from a file at the given offset
    fn read_bytes(&self, file_id: u32, offset: u64, len: u32) -> Vec<u8>;

    /// Write bytes to a file at the given offset
    fn write_bytes(&mut self, file_id: u32, offset: u64, data: &[u8]);

    /// Get the current size of a file
    fn get_size(&self, file_id: u32) -> u64;

    /// Flush pending writes to disk
    fn flush(&mut self, file_id: u32);
}

/// In-memory filesystem for testing
/// Uses Rc<RefCell<...>> so clones share the same underlying storage
#[derive(Default, Clone)]
pub struct InMemoryFs {
    files: Rc<RefCell<HashMap<u32, Vec<u8>>>>,
    /// Write counters per file (for testing write optimization)
    write_counts: Rc<RefCell<HashMap<u32, usize>>>,
}

impl InMemoryFs {
    #[must_use]
    pub fn new() -> Self {
        Self {
            files: Rc::new(RefCell::new(HashMap::new())),
            write_counts: Rc::new(RefCell::new(HashMap::new())),
        }
    }

    /// Get a copy of file contents (for testing)
    #[must_use]
    pub fn get_file(&self, file_id: u32) -> Option<Vec<u8>> {
        self.files.borrow().get(&file_id).cloned()
    }

    /// Get write count for a file (for testing write optimization)
    #[must_use]
    pub fn write_count(&self, file_id: u32) -> usize {
        *self.write_counts.borrow().get(&file_id).unwrap_or(&0)
    }

    /// Reset write count for a file (for testing)
    pub fn reset_write_count(&self, file_id: u32) {
        self.write_counts.borrow_mut().insert(file_id, 0);
    }
}

impl FileSystem for InMemoryFs {
    fn read_bytes(&self, file_id: u32, offset: u64, len: u32) -> Vec<u8> {
        let offset = offset as usize;
        let len = len as usize;

        let end = match offset.checked_add(len) {
            Some(end) => end,
            None => return vec![0u8; len],
        };

        let files = self.files.borrow();
        match files.get(&file_id) {
            Some(data) => {
                if offset >= data.len() {
                    vec![0u8; len]
                } else {
                    let end = end.min(data.len());
                    let mut result = data[offset..end].to_vec();
                    // Pad with zeros if reading beyond file end
                    result.resize(len, 0);
                    result
                }
            }
            None => vec![0u8; len],
        }
    }

    fn write_bytes(&mut self, file_id: u32, offset: u64, data: &[u8]) {
        let offset = offset as usize;
        let mut files = self.files.borrow_mut();
        let file = files.entry(file_id).or_default();

        // Extend file if necessary
        let required_size = match offset.checked_add(data.len()) {
            Some(size) => size,
            None => return,
        };
        if file.len() < required_size {
            file.resize(required_size, 0);
        }

        let end = offset + data.len();
        file[offset..end].copy_from_slice(data);

        // Increment write counter
        *self.write_counts.borrow_mut().entry(file_id).or_insert(0) += 1;
    }

    fn get_size(&self, file_id: u32) -> u64 {
        self.files.borrow().get(&file_id).map(|f| f.len() as u64).unwrap_or(0)
    }

    fn flush(&mut self, _file_id: u32) {
        // No-op for in-memory
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_in_memory_fs_read_write() {
        let mut fs = InMemoryFs::new();

        // Write some data
        fs.write_bytes(FILE_ADDRESSING, 0, &[1, 2, 3, 4, 5]);

        // Read it back
        let data = fs.read_bytes(FILE_ADDRESSING, 0, 5);
        assert_eq!(data, vec![1, 2, 3, 4, 5]);

        // Read with offset
        let data = fs.read_bytes(FILE_ADDRESSING, 2, 3);
        assert_eq!(data, vec![3, 4, 5]);
    }

    #[test]
    fn test_in_memory_fs_size() {
        let mut fs = InMemoryFs::new();

        assert_eq!(fs.get_size(FILE_ADDRESSING), 0);

        fs.write_bytes(FILE_ADDRESSING, 0, &[1, 2, 3]);
        assert_eq!(fs.get_size(FILE_ADDRESSING), 3);

        // Write at offset extends file
        fs.write_bytes(FILE_ADDRESSING, 10, &[1]);
        assert_eq!(fs.get_size(FILE_ADDRESSING), 11);
    }

    #[test]
    fn test_in_memory_fs_read_beyond_end() {
        let mut fs = InMemoryFs::new();
        fs.write_bytes(FILE_ADDRESSING, 0, &[1, 2, 3]);

        // Reading beyond end returns zeros
        let data = fs.read_bytes(FILE_ADDRESSING, 0, 10);
        assert_eq!(data, vec![1, 2, 3, 0, 0, 0, 0, 0, 0, 0]);
    }
}
