//! Block structures for encrypted storage.
//!
//! Implements the allocation table and block management:
//! - AllocationEntry: 56 bytes, maps logical to physical offsets
//! - AllocationTable: stored in root block
//! - DecryptedBlock: cached plaintext block data
//!
//! # Security Properties
//!
//! - **Zeroize on drop**: `DecryptedBlock` implements `Drop` to securely clear
//!   plaintext data from memory, preventing cold boot attacks
//! - **Random block IDs**: Each block has a cryptographically random 32-byte ID
//!   used for key derivation, ensuring unique encryption per block
//! - **No metadata leakage**: Block structure is fixed-format, revealing no
//!   information about content type or session identity

use zeroize::Zeroize;

// ============================================================
// CONSTANTS
// ============================================================

/// Size of a block ID (random identifier for key derivation)
pub const BLOCK_ID_SIZE: usize = 32;

/// AEAD tag size (AES-256-SIV prepends 16-byte tag)
pub const AEAD_TAG_SIZE: usize = 16;

/// Size of each allocation entry in bytes
pub const ALLOCATION_ENTRY_SIZE: usize = 56;

/// Header size in block plaintext (used_length field)
pub const BLOCK_HEADER_SIZE: usize = 4;

// ============================================================
// BLOCK ID
// ============================================================

/// Random 32-byte identifier for a block (used for key derivation)
pub type BlockId = [u8; BLOCK_ID_SIZE];

/// Generate a random block ID
#[must_use]
pub fn generate_block_id() -> BlockId {
    let mut id = [0u8; BLOCK_ID_SIZE];
    crypto_rng::fill_buffer(&mut id);
    id
}

// ============================================================
// ALLOCATION ENTRY
// ============================================================

/// Single entry in the allocation table (56 bytes)
///
/// Maps a logical byte range to a physical encrypted block
#[derive(Clone, Copy, Debug)]
pub struct AllocationEntry {
    /// Logical byte offset within session data (where SQLite thinks data is)
    pub inner_data_offset: u64,
    /// Usable plaintext space in this block (capacity for data, excluding header)
    pub inner_length: u32,
    /// Physical byte offset in data.bin (where encrypted block starts)
    pub address: u64,
    /// Size of encrypted block on disk (includes AEAD tag)
    pub outer_length: u32,
    /// Random identifier for key derivation (32 bytes)
    pub block_id: BlockId,
}

impl AllocationEntry {
    /// Size of serialized entry in bytes
    pub const SIZE: usize = ALLOCATION_ENTRY_SIZE;

    /// Create a new allocation entry
    pub fn new(
        inner_data_offset: u64,
        inner_length: u32,
        address: u64,
        outer_length: u32,
        block_id: BlockId,
    ) -> Self {
        Self {
            inner_data_offset,
            inner_length,
            address,
            outer_length,
            block_id,
        }
    }

    /// Serialize to bytes (big-endian)
    #[must_use]
    pub fn to_bytes(&self) -> [u8; Self::SIZE] {
        let mut bytes = [0u8; Self::SIZE];
        bytes[0..8].copy_from_slice(&self.inner_data_offset.to_be_bytes());
        bytes[8..12].copy_from_slice(&self.inner_length.to_be_bytes());
        bytes[12..20].copy_from_slice(&self.address.to_be_bytes());
        bytes[20..24].copy_from_slice(&self.outer_length.to_be_bytes());
        bytes[24..56].copy_from_slice(&self.block_id);
        bytes
    }

    /// Deserialize from bytes (big-endian)
    #[must_use]
    pub fn from_bytes(bytes: &[u8]) -> Option<Self> {
        if bytes.len() < Self::SIZE {
            return None;
        }
        let inner_data_offset = u64::from_be_bytes(bytes[0..8].try_into().ok()?);
        let inner_length = u32::from_be_bytes(bytes[8..12].try_into().ok()?);
        let address = u64::from_be_bytes(bytes[12..20].try_into().ok()?);
        let outer_length = u32::from_be_bytes(bytes[20..24].try_into().ok()?);
        let mut block_id = [0u8; BLOCK_ID_SIZE];
        block_id.copy_from_slice(&bytes[24..56]);

        Some(Self {
            inner_data_offset,
            inner_length,
            address,
            outer_length,
            block_id,
        })
    }

    /// Check if this block contains the given logical offset
    #[must_use]
    pub fn contains_offset(&self, logical_offset: u64) -> bool {
        logical_offset >= self.inner_data_offset
            && logical_offset < self.inner_data_offset + self.inner_length as u64
    }

    /// Get the end logical offset (exclusive)
    #[must_use]
    pub fn end_offset(&self) -> u64 {
        self.inner_data_offset + self.inner_length as u64
    }
}

// ============================================================
// ALLOCATION TABLE
// ============================================================

/// Allocation table stored in root block
///
/// Maps logical offsets to physical encrypted blocks
pub struct AllocationTable {
    entries: Vec<AllocationEntry>,
}

impl AllocationTable {
    /// Create empty allocation table
    pub fn new() -> Self {
        Self {
            entries: Vec::new(),
        }
    }

    /// Get number of entries
    #[must_use]
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    /// Check if empty
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// Get all entries
    #[must_use]
    pub fn entries(&self) -> &[AllocationEntry] {
        &self.entries
    }

    /// Find block containing the given logical offset
    #[must_use]
    pub fn find_block(&self, logical_offset: u64) -> Option<&AllocationEntry> {
        self.entries.iter().find(|e| e.contains_offset(logical_offset))
    }

    /// Find mutable reference to entry by block_id
    #[must_use]
    pub fn find_by_id_mut(&mut self, block_id: &BlockId) -> Option<&mut AllocationEntry> {
        self.entries.iter_mut().find(|e| &e.block_id == block_id)
    }

    /// Get the last block (for appending data)
    #[must_use]
    pub fn last_block(&self) -> Option<&AllocationEntry> {
        self.entries.last()
    }

    /// Find block by its block_id
    #[must_use]
    pub fn find_by_id(&self, block_id: &BlockId) -> Option<&AllocationEntry> {
        self.entries.iter().find(|e| &e.block_id == block_id)
    }

    /// Add a new entry to the table
    pub fn add_entry(&mut self, entry: AllocationEntry) {
        self.entries.push(entry);
    }

    /// Get the next logical offset (end of last block or 0 if empty)
    #[must_use]
    pub fn next_logical_offset(&self) -> u64 {
        self.entries.iter().map(|e| e.end_offset()).max().unwrap_or(0)
    }

    /// Serialize for storage in root block
    ///
    /// Format:
    /// - num_entries: u32 BE (4 bytes)
    /// - entries: AllocationEntry × num_entries (56 bytes each)
    #[must_use]
    pub fn to_bytes(&self) -> Vec<u8> {
        let mut bytes = Vec::with_capacity(4 + self.entries.len() * AllocationEntry::SIZE);
        bytes.extend_from_slice(&(self.entries.len() as u32).to_be_bytes());
        for entry in &self.entries {
            bytes.extend_from_slice(&entry.to_bytes());
        }
        bytes
    }

    /// Deserialize from root block data
    #[must_use]
    pub fn from_bytes(bytes: &[u8]) -> Option<Self> {
        if bytes.len() < 4 {
            return None;
        }

        let num_entries = u32::from_be_bytes(bytes[0..4].try_into().ok()?) as usize;
        let expected_size = 4 + num_entries * AllocationEntry::SIZE;

        if bytes.len() < expected_size {
            return None;
        }

        let mut entries = Vec::with_capacity(num_entries);
        for i in 0..num_entries {
            let offset = 4 + i * AllocationEntry::SIZE;
            let entry = AllocationEntry::from_bytes(&bytes[offset..])?;
            entries.push(entry);
        }

        Some(Self { entries })
    }

    /// Calculate minimum root block size needed
    #[must_use]
    pub fn required_size(&self) -> usize {
        4 + self.entries.len() * AllocationEntry::SIZE
    }
}

impl Default for AllocationTable {
    fn default() -> Self {
        Self::new()
    }
}

// ============================================================
// DECRYPTED BLOCK
// ============================================================

/// A decrypted block in memory (cached)
///
/// Block plaintext format:
/// - used_length: u32 BE (4 bytes) - how much data is actually used
/// - data: [used_length bytes] - actual data
/// - padding: random bytes to fill remaining capacity
pub struct DecryptedBlock {
    /// Allocation entry for this block
    pub entry: AllocationEntry,
    /// Plaintext data (full capacity, including unused space)
    pub data: Vec<u8>,
    /// How many bytes are actually used (from the used_length header)
    pub used_length: u32,
    /// Whether this block has been modified since loading
    pub dirty: bool,
}

impl DecryptedBlock {
    /// Create a new decrypted block from plaintext
    ///
    /// Expects plaintext format: used_length (4 bytes BE) + data + padding
    #[must_use]
    pub fn from_plaintext(entry: AllocationEntry, plaintext: &[u8]) -> Option<Self> {
        if plaintext.len() < BLOCK_HEADER_SIZE {
            return None;
        }

        let used_length = u32::from_be_bytes(plaintext[0..4].try_into().ok()?);

        // Validate used_length doesn't exceed capacity
        if used_length as usize > plaintext.len() - BLOCK_HEADER_SIZE {
            return None;
        }

        // Store data portion (after header, full capacity)
        let data = plaintext[BLOCK_HEADER_SIZE..].to_vec();

        Some(Self {
            entry,
            data,
            used_length,
            dirty: false,
        })
    }

    /// Create a new empty block with given capacity
    #[must_use]
    pub fn new_empty(entry: AllocationEntry, capacity: usize) -> Self {
        Self {
            entry,
            data: vec![0u8; capacity],
            used_length: 0,
            dirty: true,
        }
    }

    /// Get usable capacity (excluding header)
    #[must_use]
    pub fn capacity(&self) -> usize {
        self.data.len()
    }

    /// Read bytes at offset within this block
    ///
    /// offset is relative to this block's inner_data_offset
    #[must_use]
    pub fn read(&self, offset_in_block: usize, len: usize) -> Option<&[u8]> {
        let end = offset_in_block.checked_add(len)?;
        if end > self.used_length as usize {
            return None;
        }
        Some(&self.data[offset_in_block..end])
    }

    /// Read bytes, returning zeros for unwritten areas
    #[must_use]
    pub fn read_or_zero(&self, offset_in_block: usize, len: usize) -> Vec<u8> {
        let mut result = vec![0u8; len];
        let used = self.used_length as usize;

        if offset_in_block < used {
            let available = (used - offset_in_block).min(len);
            result[..available].copy_from_slice(&self.data[offset_in_block..offset_in_block + available]);
        }

        result
    }

    /// Write bytes at offset within this block
    ///
    /// offset is relative to this block's data area
    #[must_use]
    pub fn write(&mut self, offset_in_block: usize, data: &[u8]) -> bool {
        let end = match offset_in_block.checked_add(data.len()) {
            Some(e) => e,
            None => return false,
        };

        if end > self.data.len() {
            return false;
        }

        self.data[offset_in_block..end].copy_from_slice(data);

        // Update used_length if we wrote past current end
        if end > self.used_length as usize {
            self.used_length = end as u32;
        }

        self.dirty = true;
        true
    }

    /// Serialize to plaintext format for encryption
    ///
    /// Returns: used_length (4 bytes BE) + data (with random padding to capacity)
    #[must_use]
    pub fn to_plaintext(&self) -> Vec<u8> {
        let total_size = BLOCK_HEADER_SIZE + self.data.len();
        let mut plaintext = Vec::with_capacity(total_size);

        // Header: used_length
        plaintext.extend_from_slice(&self.used_length.to_be_bytes());

        // Data portion (used data + existing content)
        plaintext.extend_from_slice(&self.data);

        // Fill any remaining capacity with random padding
        if plaintext.len() < total_size {
            let padding_needed = total_size - plaintext.len();
            let mut padding = vec![0u8; padding_needed];
            crypto_rng::fill_buffer(&mut padding);
            plaintext.extend_from_slice(&padding);
        }

        plaintext
    }

    /// Zeroize sensitive data
    pub fn zeroize_data(&mut self) {
        self.data.zeroize();
        self.used_length = 0;
    }
}

impl Drop for DecryptedBlock {
    fn drop(&mut self) {
        self.zeroize_data();
    }
}

// ============================================================
// TESTS
// ============================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_allocation_entry_serialization() {
        let block_id = generate_block_id();
        let entry = AllocationEntry::new(
            0x123456789ABCDEF0,
            0x12345678,
            0xFEDCBA9876543210,
            0x87654321,
            block_id,
        );

        let bytes = entry.to_bytes();
        assert_eq!(bytes.len(), AllocationEntry::SIZE);

        let recovered = AllocationEntry::from_bytes(&bytes).unwrap();
        assert_eq!(recovered.inner_data_offset, entry.inner_data_offset);
        assert_eq!(recovered.inner_length, entry.inner_length);
        assert_eq!(recovered.address, entry.address);
        assert_eq!(recovered.outer_length, entry.outer_length);
        assert_eq!(recovered.block_id, entry.block_id);
    }

    #[test]
    fn test_allocation_entry_contains_offset() {
        let entry = AllocationEntry::new(
            100,  // inner_data_offset
            50,   // inner_length (covers offsets 100-149)
            0,
            0,
            [0u8; 32],
        );

        assert!(!entry.contains_offset(99));
        assert!(entry.contains_offset(100));
        assert!(entry.contains_offset(125));
        assert!(entry.contains_offset(149));
        assert!(!entry.contains_offset(150));
    }

    #[test]
    fn test_allocation_table_serialization() {
        let mut table = AllocationTable::new();

        table.add_entry(AllocationEntry::new(0, 1000, 5000, 1016, generate_block_id()));
        table.add_entry(AllocationEntry::new(1000, 2000, 10000, 2016, generate_block_id()));

        let bytes = table.to_bytes();
        let recovered = AllocationTable::from_bytes(&bytes).unwrap();

        assert_eq!(recovered.len(), 2);
        assert_eq!(recovered.entries()[0].inner_data_offset, 0);
        assert_eq!(recovered.entries()[0].inner_length, 1000);
        assert_eq!(recovered.entries()[1].inner_data_offset, 1000);
        assert_eq!(recovered.entries()[1].inner_length, 2000);
    }

    #[test]
    fn test_allocation_table_find_block() {
        let mut table = AllocationTable::new();

        let id1 = generate_block_id();
        let id2 = generate_block_id();

        table.add_entry(AllocationEntry::new(0, 1000, 0, 0, id1));
        table.add_entry(AllocationEntry::new(1000, 500, 0, 0, id2));

        // Find blocks by offset
        let block = table.find_block(500).unwrap();
        assert_eq!(block.block_id, id1);

        let block = table.find_block(1200).unwrap();
        assert_eq!(block.block_id, id2);

        // No block at offset 2000
        assert!(table.find_block(2000).is_none());
    }

    #[test]
    fn test_decrypted_block_read_write() {
        let entry = AllocationEntry::new(0, 100, 0, 0, [0u8; 32]);
        let mut block = DecryptedBlock::new_empty(entry, 100);

        // Write data
        assert!(block.write(0, &[1, 2, 3, 4, 5]));
        assert_eq!(block.used_length, 5);

        // Read data back
        let data = block.read(0, 5).unwrap();
        assert_eq!(data, &[1, 2, 3, 4, 5]);

        // Write more data
        assert!(block.write(10, &[10, 11, 12]));
        assert_eq!(block.used_length, 13);

        // Read with zeros for gap
        let data = block.read_or_zero(0, 15);
        assert_eq!(&data[0..5], &[1, 2, 3, 4, 5]);
        assert_eq!(&data[5..10], &[0, 0, 0, 0, 0]); // Gap filled with zeros
        assert_eq!(&data[10..13], &[10, 11, 12]);
    }

    #[test]
    fn test_decrypted_block_plaintext_roundtrip() {
        let entry = AllocationEntry::new(0, 100, 0, 116, [0u8; 32]);
        let mut block = DecryptedBlock::new_empty(entry, 100);

        block.write(0, &[1, 2, 3, 4, 5]);

        let plaintext = block.to_plaintext();
        assert_eq!(plaintext.len(), 104); // 4-byte header + 100 bytes data

        // Verify header
        let used_len = u32::from_be_bytes(plaintext[0..4].try_into().unwrap());
        assert_eq!(used_len, 5);

        // Parse back
        let recovered = DecryptedBlock::from_plaintext(entry, &plaintext).unwrap();
        assert_eq!(recovered.used_length, 5);
        assert_eq!(recovered.read(0, 5).unwrap(), &[1, 2, 3, 4, 5]);
    }

    #[test]
    fn test_next_logical_offset() {
        let mut table = AllocationTable::new();
        assert_eq!(table.next_logical_offset(), 0);

        table.add_entry(AllocationEntry::new(0, 1000, 0, 0, [0u8; 32]));
        assert_eq!(table.next_logical_offset(), 1000);

        table.add_entry(AllocationEntry::new(1000, 500, 0, 0, [0u8; 32]));
        assert_eq!(table.next_logical_offset(), 1500);
    }
}
