//! Custom Write-Ahead Log (WAL) for crash-safe OPFS writes.
//!
//! Layout per entry:
//!   [8: seq_no][8: file_offset][4: length][N: payload][4: crc32]
//!
//! Total entry size = 24 + payload_length bytes.
//!
//! Recovery: replay from the beginning, applying each entry whose CRC
//! validates. Stop at first invalid/truncated entry.

/// Header size: seq(8) + offset(8) + length(4) = 20 bytes
const ENTRY_HEADER_SIZE: usize = 20;

/// CRC32 trailer size
const ENTRY_TRAILER_SIZE: usize = 4;

/// A single WAL entry: one contiguous write to a file offset.
#[derive(Debug, Clone)]
pub struct WalEntry {
    pub seq: u64,
    pub file_offset: u64,
    pub length: u32,
    pub payload: Vec<u8>,
    pub crc32: u32,
}

impl WalEntry {
    /// Serialize this entry to bytes for append to the WAL file.
    pub fn to_bytes(&self) -> Vec<u8> {
        let total = ENTRY_HEADER_SIZE + self.payload.len() + ENTRY_TRAILER_SIZE;
        let mut buf = Vec::with_capacity(total);
        buf.extend_from_slice(&self.seq.to_le_bytes());
        buf.extend_from_slice(&self.file_offset.to_le_bytes());
        buf.extend_from_slice(&self.length.to_le_bytes());
        buf.extend_from_slice(&self.payload);
        buf.extend_from_slice(&self.crc32.to_le_bytes());
        buf
    }

    /// Compute CRC32 over the header + payload (everything except the trailing CRC).
    pub fn compute_crc32(seq: u64, file_offset: u64, length: u32, payload: &[u8]) -> u32 {
        let mut hasher = crc32fast::Hasher::new();
        hasher.update(&seq.to_le_bytes());
        hasher.update(&file_offset.to_le_bytes());
        hasher.update(&length.to_le_bytes());
        hasher.update(payload);
        hasher.finalize()
    }
}

/// In-memory WAL state: buffered entries not yet flushed to the DB file.
///
/// Single-copy design: page data lives only in `WalEntry.payload`.
/// Serialized bytes for OPFS are built on-demand at flush time.
pub struct Wal {
    /// Next sequence number
    next_seq: u64,
    /// Entries buffered in memory during a transaction
    entries: Vec<WalEntry>,
}

impl Default for Wal {
    fn default() -> Self {
        Self::new()
    }
}

impl Wal {
    pub fn new() -> Self {
        Self {
            next_seq: 0,
            entries: Vec::new(),
        }
    }

    /// Record a write: buffer in memory during the transaction.
    pub fn record_write(&mut self, file_offset: u64, data: &[u8]) {
        let seq = self.next_seq;
        self.next_seq += 1;
        let length = data.len() as u32;
        let crc32 = WalEntry::compute_crc32(seq, file_offset, length, data);
        self.entries.push(WalEntry {
            seq,
            file_offset,
            length,
            payload: data.to_vec(),
            crc32,
        });
    }

    /// Get the buffered entries for replay into the main DB file.
    pub fn entries(&self) -> &[WalEntry] {
        &self.entries
    }

    /// Serialize all buffered entries to bytes for writing to the OPFS WAL file.
    /// Built on-demand to avoid keeping a second copy in memory.
    pub fn to_bytes(&self) -> Vec<u8> {
        let total: usize = self
            .entries
            .iter()
            .map(|e| ENTRY_HEADER_SIZE + e.payload.len() + ENTRY_TRAILER_SIZE)
            .sum();
        let mut buf = Vec::with_capacity(total);
        for entry in &self.entries {
            buf.extend_from_slice(&entry.to_bytes());
        }
        buf
    }

    /// Clear all buffered entries after a successful flush.
    pub fn clear(&mut self) {
        self.entries.clear();
    }

    /// Check if there are pending entries.
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// Parse WAL entries from raw bytes (for crash recovery).
    ///
    /// Reads entries sequentially. Stops at the first truncated or
    /// CRC-invalid entry. Returns all valid entries found.
    pub fn parse_wal_bytes(data: &[u8]) -> Vec<WalEntry> {
        let mut entries = Vec::new();
        let mut pos = 0;

        while pos + ENTRY_HEADER_SIZE <= data.len() {
            let seq = u64::from_le_bytes(data[pos..pos + 8].try_into().unwrap());
            let file_offset = u64::from_le_bytes(data[pos + 8..pos + 16].try_into().unwrap());
            let length = u32::from_le_bytes(data[pos + 16..pos + 20].try_into().unwrap());

            let payload_end = pos + ENTRY_HEADER_SIZE + length as usize;
            let entry_end = payload_end + ENTRY_TRAILER_SIZE;

            // Truncated entry — stop
            if entry_end > data.len() {
                break;
            }

            let payload = &data[pos + ENTRY_HEADER_SIZE..payload_end];
            let stored_crc = u32::from_le_bytes(data[payload_end..entry_end].try_into().unwrap());

            let computed_crc = WalEntry::compute_crc32(seq, file_offset, length, payload);
            if stored_crc != computed_crc {
                // Corrupted entry — stop
                break;
            }

            entries.push(WalEntry {
                seq,
                file_offset,
                length,
                payload: payload.to_vec(),
                crc32: stored_crc,
            });

            pos = entry_end;
        }

        entries
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_single_entry() {
        let mut wal = Wal::new();
        wal.record_write(1024, &[0xAA; 100]);
        let bytes = wal.to_bytes();
        let parsed = Wal::parse_wal_bytes(&bytes);
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].seq, 0);
        assert_eq!(parsed[0].file_offset, 1024);
        assert_eq!(parsed[0].length, 100);
        assert_eq!(parsed[0].payload, vec![0xAA; 100]);
    }

    #[test]
    fn roundtrip_multiple_entries() {
        let mut wal = Wal::new();
        wal.record_write(0, &[1; 50]);
        wal.record_write(4096, &[2; 200]);
        wal.record_write(8192, &[3; 10]);
        let bytes = wal.to_bytes();
        let parsed = Wal::parse_wal_bytes(&bytes);
        assert_eq!(parsed.len(), 3);
        assert_eq!(parsed[0].seq, 0);
        assert_eq!(parsed[1].seq, 1);
        assert_eq!(parsed[2].seq, 2);
        assert_eq!(parsed[1].payload, vec![2; 200]);
    }

    #[test]
    fn truncated_entry_stops_parsing() {
        let mut wal = Wal::new();
        wal.record_write(0, &[1; 50]);
        wal.record_write(4096, &[2; 200]);
        let mut bytes = wal.to_bytes();
        // Truncate in the middle of entry 2
        bytes.truncate(ENTRY_HEADER_SIZE + 50 + ENTRY_TRAILER_SIZE + 10);
        let parsed = Wal::parse_wal_bytes(&bytes);
        assert_eq!(parsed.len(), 1);
    }

    #[test]
    fn corrupted_crc_stops_parsing() {
        let mut wal = Wal::new();
        wal.record_write(0, &[1; 50]);
        wal.record_write(4096, &[2; 200]);
        let mut bytes = wal.to_bytes();
        // Corrupt the CRC of entry 2
        let entry2_crc_offset =
            ENTRY_HEADER_SIZE + 50 + ENTRY_TRAILER_SIZE + ENTRY_HEADER_SIZE + 200;
        bytes[entry2_crc_offset] ^= 0xFF;
        let parsed = Wal::parse_wal_bytes(&bytes);
        assert_eq!(parsed.len(), 1);
    }

    #[test]
    fn empty_wal() {
        let parsed = Wal::parse_wal_bytes(&[]);
        assert!(parsed.is_empty());
    }

    #[test]
    fn clear_resets_state() {
        let mut wal = Wal::new();
        wal.record_write(0, &[1; 10]);
        assert!(!wal.is_empty());
        wal.clear();
        assert!(wal.is_empty());
        assert!(wal.to_bytes().is_empty());
    }

    #[test]
    fn roundtrip_large_block_entry() {
        use crate::constants::BLOCK_SIZE;
        let mut wal = Wal::new();
        let block = vec![0xCD; BLOCK_SIZE];
        wal.record_write(0, &block);
        wal.record_write(BLOCK_SIZE as u64, &block);
        let bytes = wal.to_bytes();
        let parsed = Wal::parse_wal_bytes(&bytes);
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[0].payload.len(), BLOCK_SIZE);
        assert_eq!(parsed[1].file_offset, BLOCK_SIZE as u64);
    }

    // ── Edge-case tests ──────────────────────────────────────────────

    #[test]
    fn seq_numbers_monotonic() {
        let mut wal = Wal::new();
        wal.record_write(0, &[1]);
        wal.record_write(0, &[2]);
        wal.record_write(0, &[3]);
        let bytes = wal.to_bytes();
        let parsed = Wal::parse_wal_bytes(&bytes);
        assert_eq!(parsed[0].seq, 0);
        assert_eq!(parsed[1].seq, 1);
        assert_eq!(parsed[2].seq, 2);
    }

    #[test]
    fn corrupted_first_entry_returns_empty() {
        let mut wal = Wal::new();
        wal.record_write(0, &[1; 50]);
        let mut bytes = wal.to_bytes();
        // Corrupt CRC of entry 0
        let crc_offset = ENTRY_HEADER_SIZE + 50;
        bytes[crc_offset] ^= 0xFF;
        let parsed = Wal::parse_wal_bytes(&bytes);
        assert!(parsed.is_empty());
    }

    #[test]
    fn header_only_no_payload_or_crc() {
        // Just 20 bytes of header, no payload or CRC
        let bytes = vec![0u8; ENTRY_HEADER_SIZE];
        let parsed = Wal::parse_wal_bytes(&bytes);
        // Length field is 0, so payload is 0 bytes, needs 4 more for CRC
        // 20 + 0 + 4 = 24 > 20 → truncated → empty
        assert!(parsed.is_empty());
    }

    #[test]
    fn zero_length_payload_valid() {
        let mut wal = Wal::new();
        wal.record_write(42, &[]);
        let bytes = wal.to_bytes();
        let parsed = Wal::parse_wal_bytes(&bytes);
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].file_offset, 42);
        assert!(parsed[0].payload.is_empty());
        assert_eq!(parsed[0].length, 0);
    }

    #[test]
    fn partial_header_returns_empty() {
        let parsed = Wal::parse_wal_bytes(&[0u8; 10]);
        assert!(parsed.is_empty());
    }

    #[test]
    fn one_byte_short_of_complete_entry() {
        let mut wal = Wal::new();
        wal.record_write(0, &[0xAB; 32]);
        let mut bytes = wal.to_bytes();
        // Remove 1 byte from the end (CRC is incomplete)
        bytes.pop();
        let parsed = Wal::parse_wal_bytes(&bytes);
        assert!(parsed.is_empty());
    }

    #[test]
    fn corrupted_payload_detected_by_crc() {
        let mut wal = Wal::new();
        wal.record_write(0, &[0xAA; 100]);
        let mut bytes = wal.to_bytes();
        // Flip a byte in the payload (not the CRC)
        bytes[ENTRY_HEADER_SIZE + 50] ^= 0xFF;
        let parsed = Wal::parse_wal_bytes(&bytes);
        assert!(parsed.is_empty());
    }

    #[test]
    fn valid_prefix_survives_truncation_mid_second_entry() {
        let mut wal = Wal::new();
        wal.record_write(0, &[1; 100]);
        wal.record_write(1000, &[2; 200]);
        wal.record_write(2000, &[3; 50]);
        let mut bytes = wal.to_bytes();
        // Truncate in the middle of entry 3's payload
        let entry3_start = (ENTRY_HEADER_SIZE + 100 + ENTRY_TRAILER_SIZE)
            + (ENTRY_HEADER_SIZE + 200 + ENTRY_TRAILER_SIZE);
        bytes.truncate(entry3_start + ENTRY_HEADER_SIZE + 25); // mid-payload
        let parsed = Wal::parse_wal_bytes(&bytes);
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[0].payload, vec![1; 100]);
        assert_eq!(parsed[1].payload, vec![2; 200]);
    }

    #[test]
    fn overwrite_same_offset_last_write_wins() {
        let mut wal = Wal::new();
        wal.record_write(0, &[1; 10]);
        wal.record_write(0, &[2; 10]);
        wal.record_write(0, &[3; 10]);
        let bytes = wal.to_bytes();
        let parsed = Wal::parse_wal_bytes(&bytes);
        assert_eq!(parsed.len(), 3);
        // All three are valid — consumer must pick last write per offset
        assert_eq!(parsed[2].payload, vec![3; 10]);
    }

    #[test]
    fn crc32_not_trivially_zero() {
        let mut wal = Wal::new();
        wal.record_write(0, &[0; 100]);
        let entries = wal.entries();
        // CRC of all-zero data should not be zero
        assert_ne!(entries[0].crc32, 0);
    }

    #[test]
    fn max_u64_offset_and_seq() {
        let crc = WalEntry::compute_crc32(u64::MAX, u64::MAX, 0, &[]);
        let entry = WalEntry {
            seq: u64::MAX,
            file_offset: u64::MAX,
            length: 0,
            payload: vec![],
            crc32: crc,
        };
        let bytes = entry.to_bytes();
        let parsed = Wal::parse_wal_bytes(&bytes);
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].seq, u64::MAX);
        assert_eq!(parsed[0].file_offset, u64::MAX);
    }

    #[test]
    fn clear_then_reuse() {
        let mut wal = Wal::new();
        wal.record_write(0, &[1; 10]);
        wal.record_write(100, &[2; 20]);
        wal.clear();
        assert!(wal.is_empty());
        // Seq continues from where it left off
        wal.record_write(200, &[3; 30]);
        let bytes = wal.to_bytes();
        let parsed = Wal::parse_wal_bytes(&bytes);
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].seq, 2); // seq 0, 1 were used before clear
        assert_eq!(parsed[0].file_offset, 200);
    }
}
