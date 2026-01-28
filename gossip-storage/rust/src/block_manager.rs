//! Block Manager for encrypted storage.
//!
//! Manages the translation between logical offsets (what SQLite sees)
//! and physical encrypted blocks on disk.
//!
//! # Architecture
//!
//! - Allocation table maps logical → physical offsets
//! - Blocks have CAPACITY (inner_length) vs USED (used_length)
//! - Writes go directly into existing blocks with spare capacity
//! - New blocks (+ Pareto padding) only allocated when capacity exhausted
//! - Flush = re-encrypt dirty blocks at SAME address (fast)
//!
//! # Security Properties
//!
//! - All blocks encrypted with per-block keys derived from session key
//! - Pareto padding before each block hides block boundaries
//! - Sensitive data zeroized on lock via `zeroize_sensitive()`

use std::collections::HashMap;

use crate::block::{
    AllocationEntry, AllocationTable, DecryptedBlock, BlockId,
    generate_block_id, BLOCK_HEADER_SIZE,
};
use crate::blob::{
    generate_pareto_padding_with_config, draw_block_size_with_config,
    write_random_padding,
};
use crate::config::StorageConfig;
use crate::crypto::{
    SessionAeadKey, derive_block_key, encrypt_block, decrypt_block,
    encrypt_root_block, decrypt_root_block,
};
use crate::fs::{FileSystem, FILE_DATA};

/// Errors from block operations
#[derive(Debug, thiserror::Error)]
pub enum BlockError {
    #[error("Block not found")]
    BlockNotFound,
    #[error("Decryption failed")]
    DecryptionFailed,
    #[error("Invalid block format")]
    InvalidFormat,
    #[error("Block capacity exceeded")]
    CapacityExceeded,
    #[error("IO error: {0}")]
    Io(String),
}

/// Manages encrypted blocks for a session
///
/// Provides a logical byte stream view over encrypted variable-size blocks.
///
/// Key concepts:
/// - `inner_length` = block CAPACITY (how much it CAN hold, ~35 MB)
/// - `used_length` = actual data in block (tracked in DecryptedBlock)
/// - Writes go directly into blocks with spare capacity
/// - New block + Pareto padding only when capacity exhausted
pub struct BlockManager<F: FileSystem> {
    /// Filesystem backend
    fs: F,
    /// Session AEAD key (for root block encryption)
    session_key: SessionAeadKey,
    /// Storage configuration (padding values)
    config: StorageConfig,
    /// Allocation table (loaded from root block)
    allocation_table: AllocationTable,
    /// Physical address of root block in data.bin
    root_address: u64,
    /// Current size of root block on disk
    root_outer_length: u32,

    /// Cache of decrypted blocks (block_id → block)
    cache: HashMap<BlockId, DecryptedBlock>,

    /// Whether allocation table has changed (needs root block update)
    allocation_table_dirty: bool,

    /// Total logical size of session data (highest offset written)
    logical_size: u64,
}

impl<F: FileSystem> BlockManager<F> {
    /// Create a new BlockManager for a new session
    ///
    /// Creates initial empty root block at the given address.
    /// First data block is allocated lazily on first write.
    pub fn new(mut fs: F, session_key: SessionAeadKey, root_address: u64, config: StorageConfig) -> Self {
        // Create empty allocation table
        let allocation_table = AllocationTable::new();

        // Write initial root block
        let root_plaintext = allocation_table.to_bytes();
        let root_ciphertext = encrypt_root_block(&root_plaintext, &session_key);
        let root_outer_length = root_ciphertext.len() as u32;

        fs.write_bytes(FILE_DATA, root_address, &root_ciphertext);

        Self {
            fs,
            session_key,
            config,
            allocation_table,
            root_address,
            root_outer_length,
            cache: HashMap::new(),
            allocation_table_dirty: false,
            logical_size: 0,
        }
    }

    /// Load existing BlockManager from root block
    ///
    /// Reads and decrypts root block to recover allocation table
    pub fn load(
        fs: F,
        session_key: SessionAeadKey,
        root_address: u64,
        root_outer_length: u32,
        config: StorageConfig,
    ) -> Result<Self, BlockError> {
        // Handle case where root_length is 0 (new session, no data yet)
        if root_outer_length == 0 {
            return Ok(Self {
                fs,
                session_key,
                config,
                allocation_table: AllocationTable::new(),
                root_address,
                root_outer_length: 0,
                cache: HashMap::new(),
                allocation_table_dirty: false,
                logical_size: 0,
            });
        }

        // Read encrypted root block from disk
        let ciphertext = fs.read_bytes(FILE_DATA, root_address, root_outer_length);
        if ciphertext.len() != root_outer_length as usize {
            return Err(BlockError::Io("Failed to read root block".into()));
        }

        // Decrypt root block with session key
        let plaintext = decrypt_root_block(&ciphertext, &session_key)
            .map_err(|_| BlockError::DecryptionFailed)?;

        // Parse allocation table
        let allocation_table = AllocationTable::from_bytes(&plaintext)
            .ok_or(BlockError::InvalidFormat)?;

        // Calculate logical size from allocation table
        // This is the highest offset covered by any block
        let logical_size = allocation_table.next_logical_offset();

        Ok(Self {
            fs,
            session_key,
            config,
            allocation_table,
            root_address,
            root_outer_length,
            cache: HashMap::new(),
            allocation_table_dirty: false,
            logical_size,
        })
    }

    /// Get debug info about allocation table.
    #[must_use]
    pub fn debug_allocation_info(&self) -> String {
        let mut info = format!(
            "AllocationTable: {} entries, logical_size={}\n",
            self.allocation_table.len(),
            self.logical_size
        );
        for (i, entry) in self.allocation_table.entries().iter().enumerate() {
            // Check if block is cached and get used_length
            let used_info = if let Some(block) = self.cache.get(&entry.block_id) {
                format!(", used={}", block.used_length)
            } else {
                String::new()
            };
            info.push_str(&format!(
                "  [{}] offset={}, capacity={}, addr={}, outer_len={}{}\n",
                i, entry.inner_data_offset, entry.inner_length, entry.address, entry.outer_length, used_info
            ));
        }
        info
    }

    /// Get the current root block address.
    #[must_use]
    pub fn root_address(&self) -> u64 {
        self.root_address
    }

    /// Get the current root block length (encrypted size).
    #[must_use]
    pub fn root_outer_length(&self) -> u32 {
        self.root_outer_length
    }

    /// Get the logical size (what SQLite thinks the file size is).
    #[must_use]
    pub fn logical_size(&self) -> u64 {
        self.logical_size
    }

    // ============================================================
    // BLOCK ALLOCATION
    // ============================================================

    /// Allocate a new block with Pareto padding
    ///
    /// This is the ONLY place where Pareto padding is generated.
    /// Called when:
    /// - First write to an empty session
    /// - Writing beyond capacity of all existing blocks
    fn allocate_new_block(&mut self, logical_offset: u64) -> Result<BlockId, BlockError> {
        let padding = self.config.padding();

        // 1. Generate random block_id
        let block_id = generate_block_id();

        // 2. Determine block capacity (log-normal distribution)
        let block_capacity = draw_block_size_with_config(padding.block_size_min, padding);
        let data_capacity = block_capacity - BLOCK_HEADER_SIZE;

        // 3. Generate Pareto padding before the block
        let pareto_padding = generate_pareto_padding_with_config(padding);
        let current_disk_size = self.fs.get_size(FILE_DATA);

        // 4. Write Pareto padding
        write_random_padding(
            &mut self.fs,
            FILE_DATA,
            current_disk_size,
            pareto_padding,
        );

        // 5. Create empty block with capacity
        let block_address = current_disk_size + pareto_padding;

        // Create allocation entry with CAPACITY as inner_length
        let entry = AllocationEntry::new(
            logical_offset,
            data_capacity as u32,  // This is CAPACITY, not used length
            block_address,
            0,  // outer_length set after encryption
            block_id,
        );

        // 6. Create empty decrypted block
        let block = DecryptedBlock::new_empty(entry, data_capacity);

        // 7. Encrypt and write initial block
        let plaintext = block.to_plaintext();
        let block_key = derive_block_key(&self.session_key, &block_id);
        let ciphertext = encrypt_block(&plaintext, &block_key);

        self.fs.write_bytes(FILE_DATA, block_address, &ciphertext);

        // 8. Update entry with actual outer_length
        let mut final_entry = entry;
        final_entry.outer_length = ciphertext.len() as u32;

        // 9. Add to allocation table and cache
        self.allocation_table.add_entry(final_entry);
        self.allocation_table_dirty = true;

        // Update cached block with correct entry
        let mut cached_block = block;
        cached_block.entry = final_entry;
        self.cache.insert(block_id, cached_block);

        Ok(block_id)
    }

    /// Find or allocate a block for writing at the given offset
    ///
    /// Returns the block_id of a block that can accept data at this offset
    fn ensure_block_for_offset(&mut self, offset: u64) -> Result<BlockId, BlockError> {
        // First, check if any existing block covers this offset
        if let Some(entry) = self.allocation_table.find_block(offset) {
            return Ok(entry.block_id);
        }

        // Check if we can use the last block (if offset is within its capacity)
        // Copy the data we need to avoid borrow issues
        let last_block_info = self.allocation_table.last_block().map(|e| {
            (e.block_id, e.inner_data_offset, e.inner_length)
        });

        if let Some((block_id, inner_data_offset, inner_length)) = last_block_info {
            let last_end = inner_data_offset + inner_length as u64;

            // If writing within the last block's capacity range
            // Must also check offset >= inner_data_offset to avoid underflow
            if offset >= inner_data_offset && offset < last_end {
                return Ok(block_id);
            }
        }

        // No existing block covers this offset - allocate new block
        self.allocate_new_block(offset)
    }

    // ============================================================
    // READ/WRITE OPERATIONS
    // ============================================================

    /// Read bytes at logical offset
    ///
    /// Translates logical offset to physical block, decrypts if needed
    pub fn read(&mut self, logical_offset: u64, len: u32) -> Result<Vec<u8>, BlockError> {
        let mut result = Vec::with_capacity(len as usize);
        let mut remaining = len as usize;
        let mut current_offset = logical_offset;

        while remaining > 0 {
            // Find block containing this offset
            if let Some(entry) = self.allocation_table.find_block(current_offset) {
                let entry = *entry; // Copy to avoid borrow issues

                // Load block into cache if not present
                self.ensure_block_cached(&entry.block_id)?;

                // Read from cached block
                let block = self.cache.get(&entry.block_id)
                    .ok_or(BlockError::BlockNotFound)?;

                let offset_in_block = (current_offset - entry.inner_data_offset) as usize;
                let available = (block.used_length as usize).saturating_sub(offset_in_block);
                let to_read = remaining.min(available.max(0));

                if to_read > 0 {
                    let data = block.read_or_zero(offset_in_block, to_read);
                    result.extend_from_slice(&data);
                    current_offset += to_read as u64;
                    remaining -= to_read;
                } else {
                    // Beyond used data in this block, return zeros
                    let capacity_remaining = (entry.inner_length as usize).saturating_sub(offset_in_block);
                    let to_fill = remaining.min(capacity_remaining);
                    if to_fill > 0 {
                        result.extend(std::iter::repeat(0u8).take(to_fill));
                        current_offset += to_fill as u64;
                        remaining -= to_fill;
                    } else {
                        // Beyond this block entirely
                        break;
                    }
                }
            } else {
                // No block at this offset - return zeros (unwritten area)
                let to_fill = remaining.min(4096);
                result.extend(std::iter::repeat(0u8).take(to_fill));
                current_offset += to_fill as u64;
                remaining -= to_fill;
            }
        }

        // Fill any remaining with zeros
        while result.len() < len as usize {
            result.push(0);
        }

        Ok(result)
    }

    /// Write bytes at logical offset
    ///
    /// Writes directly into existing blocks with spare capacity.
    /// Only allocates new block (with Pareto padding) when necessary.
    pub fn write(&mut self, logical_offset: u64, data: &[u8]) -> Result<(), BlockError> {
        if data.is_empty() {
            return Ok(());
        }

        let mut offset = logical_offset;
        let mut remaining = data;

        while !remaining.is_empty() {
            // Ensure we have a block for this offset
            let block_id = self.ensure_block_for_offset(offset)?;

            // Load block into cache
            self.ensure_block_cached(&block_id)?;

            // Get the block and its entry
            let block = self.cache.get_mut(&block_id)
                .ok_or(BlockError::BlockNotFound)?;

            let offset_in_block = (offset - block.entry.inner_data_offset) as usize;
            let capacity = block.capacity();
            let available = capacity.saturating_sub(offset_in_block);
            let to_write = remaining.len().min(available);

            if to_write > 0 {
                // Write directly into the block
                block.write(offset_in_block, &remaining[..to_write]);

                offset += to_write as u64;
                remaining = &remaining[to_write..];

                // Update logical size if we extended
                if offset > self.logical_size {
                    self.logical_size = offset;
                }
            } else {
                // Block is full, need a new one
                // This shouldn't happen often since ensure_block_for_offset
                // allocates a new block when needed
                let new_block_id = self.allocate_new_block(offset)?;

                // Continue loop to write to new block
                let new_block = self.cache.get_mut(&new_block_id)
                    .ok_or(BlockError::BlockNotFound)?;

                let new_offset_in_block = (offset - new_block.entry.inner_data_offset) as usize;
                let new_available = new_block.capacity().saturating_sub(new_offset_in_block);
                let new_to_write = remaining.len().min(new_available);

                if new_to_write > 0 {
                    new_block.write(new_offset_in_block, &remaining[..new_to_write]);
                    offset += new_to_write as u64;
                    remaining = &remaining[new_to_write..];

                    if offset > self.logical_size {
                        self.logical_size = offset;
                    }
                }
            }
        }

        Ok(())
    }

    // ============================================================
    // FLUSH - Re-encrypt dirty blocks at SAME address
    // ============================================================

    /// Flush all changes to disk
    ///
    /// This is FAST because:
    /// 1. Dirty blocks are re-encrypted at their SAME address (no new padding)
    /// 2. Root block only updated if allocation table changed
    pub fn flush(&mut self) -> Result<(), BlockError> {
        // 1. Write back all dirty blocks at SAME address (no new padding!)
        for (block_id, block) in &self.cache {
            if block.dirty {
                let block_key = derive_block_key(&self.session_key, block_id);
                let plaintext = block.to_plaintext();
                let ciphertext = encrypt_block(&plaintext, &block_key);

                // Write at SAME address - no Pareto padding!
                self.fs.write_bytes(FILE_DATA, block.entry.address, &ciphertext);
            }
        }

        // 2. Update root block only if allocation table changed
        if self.allocation_table_dirty {
            self.write_root_block()?;
            self.allocation_table_dirty = false;
        }

        // 3. Flush filesystem
        self.fs.flush(FILE_DATA);

        // 4. Clear dirty flags
        for block in self.cache.values_mut() {
            block.dirty = false;
        }

        Ok(())
    }

    /// Write the root block (allocation table) to disk
    ///
    /// If allocation table grew beyond current root block size,
    /// writes new root block with Pareto padding.
    /// Otherwise updates in place.
    fn write_root_block(&mut self) -> Result<(), BlockError> {
        let table_bytes = self.allocation_table.to_bytes();
        let ciphertext = encrypt_root_block(&table_bytes, &self.session_key);
        let new_length = ciphertext.len() as u32;

        // If root block grew, we need to write to a new location with Pareto padding
        if new_length > self.root_outer_length || self.root_outer_length == 0 {
            // Generate Pareto padding
            let pareto_padding = generate_pareto_padding_with_config(self.config.padding());
            let current_disk_size = self.fs.get_size(FILE_DATA);

            // Write padding
            write_random_padding(
                &mut self.fs,
                FILE_DATA,
                current_disk_size,
                pareto_padding,
            );

            // Write new root block
            let new_root_address = current_disk_size + pareto_padding;
            self.fs.write_bytes(FILE_DATA, new_root_address, &ciphertext);

            self.root_address = new_root_address;
            self.root_outer_length = new_length;
        } else {
            // Can update in place (same or smaller size)
            self.fs.write_bytes(FILE_DATA, self.root_address, &ciphertext);
            self.root_outer_length = new_length;
        }

        Ok(())
    }

    /// Load a block into cache if not already present
    fn ensure_block_cached(&mut self, block_id: &BlockId) -> Result<(), BlockError> {
        if self.cache.contains_key(block_id) {
            return Ok(());
        }

        // Find entry in allocation table
        let entry = self.allocation_table.find_by_id(block_id)
            .ok_or(BlockError::BlockNotFound)?;
        let entry = *entry;

        // Read encrypted block from disk
        let ciphertext = self.fs.read_bytes(FILE_DATA, entry.address, entry.outer_length);
        if ciphertext.len() != entry.outer_length as usize {
            return Err(BlockError::Io("Failed to read block".into()));
        }

        // Derive key and decrypt
        let block_key = derive_block_key(&self.session_key, block_id);
        let plaintext = decrypt_block(&ciphertext, &block_key)
            .map_err(|_| BlockError::DecryptionFailed)?;

        // Parse and cache
        let block = DecryptedBlock::from_plaintext(entry, &plaintext)
            .ok_or(BlockError::InvalidFormat)?;

        self.cache.insert(*block_id, block);

        Ok(())
    }

    /// Zero all sensitive data (for lock operation)
    pub fn zeroize_sensitive(&mut self) {
        // Zero session key
        self.session_key.zeroize_key();

        // Zero all cached decrypted blocks
        for block in self.cache.values_mut() {
            block.zeroize_data();
        }
        self.cache.clear();
    }

    /// Consume the BlockManager and return the filesystem (for testing)
    #[cfg(test)]
    pub fn into_fs(self) -> F {
        self.fs
    }
}

// ============================================================
// TESTS
// ============================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fs::InMemoryFs;
    use crate::crypto::derive_master_key;

    fn create_test_session_key() -> SessionAeadKey {
        let master = derive_master_key("test_password").unwrap();
        crate::crypto::derive_session_aead_key(&master)
    }

    fn test_config() -> StorageConfig {
        StorageConfig::default()
    }

    #[test]
    fn test_block_manager_new() {
        let fs = InMemoryFs::new();
        let session_key = create_test_session_key();

        let manager = BlockManager::new(fs, session_key, 0, test_config());

        assert_eq!(manager.logical_size(), 0);
        assert!(manager.allocation_table.is_empty());
    }

    #[test]
    fn test_block_manager_write_allocates_block() {
        let fs = InMemoryFs::new();
        let session_key = create_test_session_key();

        let mut manager = BlockManager::new(fs, session_key, 0, test_config());

        // First write should allocate a block
        manager.write(0, &[1, 2, 3, 4, 5]).unwrap();

        // Should have one block in allocation table
        assert_eq!(manager.allocation_table.len(), 1);

        // Block should be in cache and dirty
        assert_eq!(manager.cache.len(), 1);

        // Read it back
        let data = manager.read(0, 5).unwrap();
        assert_eq!(data, vec![1, 2, 3, 4, 5]);
    }

    #[test]
    fn test_block_manager_multiple_writes_same_block() {
        let fs = InMemoryFs::new();
        let session_key = create_test_session_key();

        let mut manager = BlockManager::new(fs, session_key, 0, test_config());

        // Multiple writes should go to same block (within capacity)
        manager.write(0, &[1, 2, 3]).unwrap();
        manager.write(100, &[4, 5, 6]).unwrap();
        manager.write(1000, &[7, 8, 9]).unwrap();

        // Should still have only one block
        assert_eq!(manager.allocation_table.len(), 1);

        // Verify data
        let data1 = manager.read(0, 3).unwrap();
        assert_eq!(data1, vec![1, 2, 3]);

        let data2 = manager.read(100, 3).unwrap();
        assert_eq!(data2, vec![4, 5, 6]);

        let data3 = manager.read(1000, 3).unwrap();
        assert_eq!(data3, vec![7, 8, 9]);
    }

    #[test]
    fn test_block_manager_flush_is_fast() {
        let fs = InMemoryFs::new();
        let session_key = create_test_session_key();

        let mut manager = BlockManager::new(fs, session_key, 0, test_config());

        // Write data
        manager.write(0, &[1, 2, 3, 4, 5]).unwrap();

        // Flush - this should be fast (no new padding)
        manager.flush().unwrap();

        // Still one block
        assert_eq!(manager.allocation_table.len(), 1);

        // Write more data to same block
        manager.write(10, &[10, 11, 12]).unwrap();

        // Flush again - still fast
        manager.flush().unwrap();

        // Still one block (no new allocations)
        assert_eq!(manager.allocation_table.len(), 1);
    }

    #[test]
    fn test_block_manager_load_existing() {
        let fs = InMemoryFs::new();
        let session_key = create_test_session_key();
        let config = test_config();

        // Create and write data
        let root_address;
        let root_length;
        let fs = {
            let mut manager = BlockManager::new(fs, session_key.clone(), 0, config);
            manager.write(0, b"Hello, World!").unwrap();
            manager.flush().unwrap();
            root_address = manager.root_address();
            root_length = manager.root_outer_length();
            manager.into_fs()
        };

        // Load from existing
        let mut manager2 = BlockManager::load(fs, session_key, root_address, root_length, config).unwrap();

        // Read back data
        let data = manager2.read(0, 13).unwrap();
        assert_eq!(data, b"Hello, World!");
    }

    #[test]
    fn test_block_manager_read_zeros_for_unwritten() {
        let fs = InMemoryFs::new();
        let session_key = create_test_session_key();

        let mut manager = BlockManager::new(fs, session_key, 0, test_config());

        // Read from offset 0 without writing anything
        let data = manager.read(0, 10).unwrap();
        assert_eq!(data, vec![0u8; 10]);
    }

    #[test]
    fn test_block_manager_overwrite_existing() {
        let fs = InMemoryFs::new();
        let session_key = create_test_session_key();

        let mut manager = BlockManager::new(fs, session_key, 0, test_config());

        // Write initial data
        manager.write(0, b"Hello, World!").unwrap();
        manager.flush().unwrap();

        // Overwrite part of it
        manager.write(7, b"Rust!").unwrap();
        manager.flush().unwrap();

        // Read back
        let data = manager.read(0, 13).unwrap();
        assert_eq!(&data[0..7], b"Hello, ");
        assert_eq!(&data[7..12], b"Rust!");
    }

    #[test]
    fn test_block_manager_zeroize() {
        let fs = InMemoryFs::new();
        let session_key = create_test_session_key();

        let mut manager = BlockManager::new(fs, session_key, 0, test_config());
        manager.write(0, b"Secret data").unwrap();

        // Zeroize
        manager.zeroize_sensitive();

        // Cache should be cleared
        assert!(manager.cache.is_empty());
    }

    #[test]
    fn test_flush_without_changes_is_noop() {
        let fs = InMemoryFs::new();
        let session_key = create_test_session_key();

        let mut manager = BlockManager::new(fs, session_key, 0, test_config());

        // Write and flush
        manager.write(0, &[1, 2, 3]).unwrap();
        manager.flush().unwrap();

        let root_addr_1 = manager.root_address();

        // Flush again without changes - should not move root block
        manager.flush().unwrap();

        let root_addr_2 = manager.root_address();
        assert_eq!(root_addr_1, root_addr_2, "Root block should not move on no-op flush");
    }
}
