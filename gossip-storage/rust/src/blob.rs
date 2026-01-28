//! Addressing blob format for plausible deniability storage.
//!
//! The addressing blob is a fixed 2 MB file containing 65,536 slots of 32 bytes each.
//! Each session writes to k=46 pseudo-random slots for redundancy.
//! Slot positions are derived from password via KDF.
//!
//! # Security Properties
//!
//! - All slots are indistinguishable from random data
//! - No metadata reveals which slots are in use
//! - Constant-time slot scanning prevents timing attacks

use zeroize::Zeroize;
use std::f64::consts::PI;

use crate::config::PaddingValues;

// ============================================================
// ADDRESSING BLOB CONSTANTS
// ============================================================

/// Number of slots in the addressing blob
pub const SLOT_COUNT: usize = 65_536;

/// Size of each slot in bytes
/// Contains: SIV tag (16 bytes) + padded ciphertext (16 bytes) = 32 bytes
/// Plaintext: address (u64, 8 bytes) + length (u32, 4 bytes) = 12 bytes
pub const SLOT_SIZE: usize = 32;

/// Total size of addressing blob: 65,536 × 32 = 2 MB
pub const ADDRESSING_BLOB_SIZE: usize = SLOT_COUNT * SLOT_SIZE;

/// Number of slots each session writes to (redundancy factor)
pub const SLOTS_PER_SESSION: usize = 46;

// ============================================================
// RANDOM DISTRIBUTION HELPERS
// ============================================================

/// Generate a random u64 using crypto_rng
fn random_u64() -> u64 {
    let mut bytes = [0u8; 8];
    crypto_rng::fill_buffer(&mut bytes);
    u64::from_le_bytes(bytes)
}

/// Generate a random f64 in (0, 1] using crypto_rng
/// Excludes zero to avoid log(0) in distributions
fn random_f64_nonzero() -> f64 {
    let r = random_u64();
    (r as f64 + 1.0) / (u64::MAX as f64 + 1.0)
}

/// Generate a random f64 in [0, 1)
fn random_f64() -> f64 {
    random_u64() as f64 / (u64::MAX as f64 + 1.0)
}

// ============================================================
// PARETO PADDING
// ============================================================

/// Generate random padding size from truncated Pareto distribution.
/// Uses default padding values based on build configuration.
#[must_use]
pub fn generate_pareto_padding() -> u64 {
    generate_pareto_padding_with_config(&PaddingValues::default())
}

/// Generate random padding size with custom configuration.
#[must_use]
pub fn generate_pareto_padding_with_config(padding: &PaddingValues) -> u64 {
    let u = random_f64_nonzero();
    let raw = (padding.pareto_min as f64) / u.powf(1.0 / padding.pareto_alpha);
    raw.min(padding.pareto_max as f64) as u64
}

// ============================================================
// BLOCK SIZE SELECTION
// ============================================================

/// Draw block size from log-normal distribution.
/// Uses default padding values based on build configuration.
#[must_use]
pub fn draw_block_size(min_capacity_needed: usize) -> usize {
    draw_block_size_with_config(min_capacity_needed, &PaddingValues::default())
}

/// Maximum iterations for rejection sampling (safety limit).
///
/// With correct log_mu (median within [block_size_min, block_size_max]),
/// acceptance rate is ~99.99%, so each sample needs 1-2 iterations on average.
/// P(needing > 100 iterations) ≈ 0 with correct config.
///
/// 10,000 is chosen to:
/// - Never trigger with correct configuration (even 100 would be safe)
/// - Fail fast (~1ms) if misconfigured, rather than spinning forever
/// - Provide clear error message pointing to the root cause (wrong log_mu)
const MAX_SAMPLING_ITERATIONS: usize = 10_000;

/// Draw block size with custom configuration.
///
/// # Panics
///
/// Panics if `min_capacity_needed > block_size_max` (impossible to satisfy)
/// or if sampling fails after MAX_SAMPLING_ITERATIONS (misconfigured distribution).
#[must_use]
pub fn draw_block_size_with_config(min_capacity_needed: usize, padding: &PaddingValues) -> usize {
    // Safety check: impossible to satisfy if min_capacity > max_block
    assert!(
        min_capacity_needed <= padding.block_size_max,
        "min_capacity_needed ({}) > block_size_max ({}) - impossible to allocate block",
        min_capacity_needed,
        padding.block_size_max
    );

    for iteration in 0..MAX_SAMPLING_ITERATIONS {
        // Box-Muller transform for standard normal
        let u1 = random_f64_nonzero();
        let u2 = random_f64();
        let normal = (-2.0 * u1.ln()).sqrt() * (2.0 * PI * u2).cos();

        // Convert to log-normal
        let size = (padding.block_size_log_mu + padding.block_size_log_sigma * normal).exp() as usize;

        // Must be within bounds AND fit the required data
        if size >= padding.block_size_min
            && size <= padding.block_size_max
            && size >= min_capacity_needed
        {
            return size;
        }

        // Log warning if taking too long (likely misconfigured)
        if iteration == 1000 {
            #[cfg(debug_assertions)]
            eprintln!(
                "WARNING: block size sampling took >1000 iterations. \
                Check log_mu={} is within [{}, {}]",
                padding.block_size_log_mu,
                (padding.block_size_min as f64).ln(),
                (padding.block_size_max as f64).ln()
            );
        }
    }

    // If we get here, distribution is misconfigured
    panic!(
        "Block size sampling failed after {} iterations. \
        Distribution is misconfigured: log_mu={}, expected range [{:.2}, {:.2}]",
        MAX_SAMPLING_ITERATIONS,
        padding.block_size_log_mu,
        (padding.block_size_min as f64).ln(),
        (padding.block_size_max as f64).ln()
    );
}

/// Page size for aligned writes (matches filesystem/SQLite page size)
const PAGE_SIZE: usize = 4096;

/// Write random padding bytes to filesystem using crypto RNG
/// Uses a reusable buffer to avoid allocations per chunk
pub fn write_random_padding<F: crate::fs::FileSystem>(
    fs: &mut F,
    file_id: u32,
    offset: u64,
    size: u64,
) {
    // 16 pages = 64 KB - balances iteration count vs cache efficiency
    const CHUNK_SIZE: usize = PAGE_SIZE * 16;

    // Allocate buffer ONCE, reuse for all iterations
    let mut chunk = vec![0u8; CHUNK_SIZE];
    let mut remaining = size as usize;
    let mut current_offset = offset;

    while remaining > 0 {
        let chunk_len = remaining.min(CHUNK_SIZE);
        crypto_rng::fill_buffer(&mut chunk[..chunk_len]);
        fs.write_bytes(file_id, current_offset, &chunk[..chunk_len]);
        current_offset += chunk_len as u64;
        remaining -= chunk_len;
    }
}

// ============================================================
// SLOT DATA STRUCTURES
// ============================================================

/// Plaintext content of a slot (before encryption)
/// Points to the session's root block in the data blob
#[derive(Clone, Copy, Zeroize)]
pub struct SlotContent {
    /// Byte offset in data blob where session's root block starts
    pub address: u64,
    /// Length of the root block in bytes
    pub length: u32,
}

impl SlotContent {
    /// Size of plaintext content (8 + 4 = 12 bytes)
    pub const SIZE: usize = 12;

    /// Create new slot content
    pub fn new(address: u64, length: u32) -> Self {
        Self { address, length }
    }

    /// Serialize to bytes (big-endian)
    pub fn to_bytes(&self) -> [u8; Self::SIZE] {
        let mut bytes = [0u8; Self::SIZE];
        bytes[0..8].copy_from_slice(&self.address.to_be_bytes());
        bytes[8..12].copy_from_slice(&self.length.to_be_bytes());
        bytes
    }

    /// Deserialize from bytes (big-endian)
    pub fn from_bytes(bytes: &[u8]) -> Option<Self> {
        if bytes.len() < Self::SIZE {
            return None;
        }
        let address = u64::from_be_bytes(bytes[0..8].try_into().ok()?);
        let length = u32::from_be_bytes(bytes[8..12].try_into().ok()?);
        Some(Self { address, length })
    }
}

/// A single encrypted slot in the addressing blob (32 bytes)
#[derive(Clone)]
pub struct EncryptedSlot {
    /// Raw encrypted data (SIV tag + ciphertext)
    pub data: [u8; SLOT_SIZE],
}

impl EncryptedSlot {
    /// Create a slot filled with random data (indistinguishable from encrypted)
    pub fn new_random() -> Self {
        let mut data = [0u8; SLOT_SIZE];
        crypto_rng::fill_buffer(&mut data);
        Self { data }
    }

    /// Create from raw bytes
    pub fn from_bytes(bytes: &[u8]) -> Option<Self> {
        if bytes.len() != SLOT_SIZE {
            return None;
        }
        let mut data = [0u8; SLOT_SIZE];
        data.copy_from_slice(bytes);
        Some(Self { data })
    }

    /// Get raw bytes
    pub fn as_bytes(&self) -> &[u8; SLOT_SIZE] {
        &self.data
    }
}

// ============================================================
// ADDRESSING BLOB
// ============================================================

/// The addressing blob containing all 65,536 slots
/// Initialized with random data
pub struct AddressingBlob {
    /// Raw blob data (2 MB)
    data: Vec<u8>,
}

impl AddressingBlob {
    /// Create a new addressing blob filled with random data
    pub fn new_random() -> Self {
        let mut data = vec![0u8; ADDRESSING_BLOB_SIZE];
        crypto_rng::fill_buffer(&mut data);
        Self { data }
    }

    /// Create from existing data (e.g., loaded from file)
    pub fn from_bytes(bytes: Vec<u8>) -> Option<Self> {
        if bytes.len() != ADDRESSING_BLOB_SIZE {
            return None;
        }
        Some(Self { data: bytes })
    }

    /// Get the entire blob as bytes (for writing to file)
    pub fn as_bytes(&self) -> &[u8] {
        &self.data
    }

    /// Get a slot by index
    pub fn get_slot(&self, index: usize) -> Option<EncryptedSlot> {
        if index >= SLOT_COUNT {
            return None;
        }
        let offset = index * SLOT_SIZE;
        EncryptedSlot::from_bytes(&self.data[offset..offset + SLOT_SIZE])
    }

    /// Set a slot by index
    pub fn set_slot(&mut self, index: usize, slot: &EncryptedSlot) -> bool {
        if index >= SLOT_COUNT {
            return false;
        }
        let offset = index * SLOT_SIZE;
        self.data[offset..offset + SLOT_SIZE].copy_from_slice(slot.as_bytes());
        true
    }
}

// ============================================================
// TESTS
// ============================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_addressing_blob_size() {
        assert_eq!(ADDRESSING_BLOB_SIZE, 2 * 1024 * 1024); // 2 MB
        assert_eq!(SLOT_COUNT, 65536);
        assert_eq!(SLOT_SIZE, 32);
    }

    #[test]
    fn test_slot_content_serialization() {
        let content = SlotContent::new(0x123456789ABCDEF0, 0xDEADBEEF);
        let bytes = content.to_bytes();
        let recovered = SlotContent::from_bytes(&bytes).unwrap();

        assert_eq!(recovered.address, content.address);
        assert_eq!(recovered.length, content.length);
    }

    #[test]
    fn test_slot_content_big_endian_format() {
        // Format: address (u64 BE) + length (u32 BE)
        let content = SlotContent::new(0x0102030405060708, 0x090A0B0C);
        let bytes = content.to_bytes();

        // Verify big-endian byte order for address (bytes 0-7)
        assert_eq!(bytes[0], 0x01);
        assert_eq!(bytes[1], 0x02);
        assert_eq!(bytes[2], 0x03);
        assert_eq!(bytes[3], 0x04);
        assert_eq!(bytes[4], 0x05);
        assert_eq!(bytes[5], 0x06);
        assert_eq!(bytes[6], 0x07);
        assert_eq!(bytes[7], 0x08);

        // Verify big-endian byte order for length (bytes 8-11)
        assert_eq!(bytes[8], 0x09);
        assert_eq!(bytes[9], 0x0A);
        assert_eq!(bytes[10], 0x0B);
        assert_eq!(bytes[11], 0x0C);
    }

    #[test]
    fn test_addressing_blob_slots() {
        let mut blob = AddressingBlob::new_random();

        // Test get/set slot
        let slot = EncryptedSlot::new_random();
        assert!(blob.set_slot(1000, &slot));

        let retrieved = blob.get_slot(1000).unwrap();
        assert_eq!(retrieved.data, slot.data);

        // Test out of bounds
        assert!(blob.get_slot(SLOT_COUNT).is_none());
        assert!(!blob.set_slot(SLOT_COUNT, &slot));
    }

    #[test]
    fn test_pareto_padding_bounds() {
        let padding = &PaddingValues::TEST;
        // Generate many samples and verify bounds
        for _ in 0..100 {
            let size = generate_pareto_padding();
            assert!(size >= padding.pareto_min, "Pareto padding {} below min {}", size, padding.pareto_min);
            assert!(size <= padding.pareto_max, "Pareto padding {} above max {}", size, padding.pareto_max);
        }
    }

    #[test]
    fn test_pareto_padding_distribution() {
        let padding = &PaddingValues::TEST;
        // Most values should be near the minimum (heavy-tailed distribution)
        let samples: Vec<u64> = (0..1000).map(|_| generate_pareto_padding()).collect();

        // Calculate what fraction is below 5x the minimum (should be majority)
        let threshold = padding.pareto_min * 5;
        let below_threshold = samples.iter().filter(|&&x| x < threshold).count();
        assert!(below_threshold > 500, "Expected majority of Pareto samples below {}KB, got {}/1000", threshold / 1024, below_threshold);
    }

    #[test]
    fn test_block_size_bounds() {
        let padding = &PaddingValues::TEST;
        // Test with minimum capacity
        for _ in 0..100 {
            let size = draw_block_size(padding.block_size_min);
            assert!(size >= padding.block_size_min, "Block size {} below min {}", size, padding.block_size_min);
            assert!(size <= padding.block_size_max, "Block size {} above max {}", size, padding.block_size_max);
        }
    }

    #[test]
    fn test_block_size_respects_min_capacity() {
        let padding = &PaddingValues::TEST;
        // When min capacity is half of max, all blocks should be at least that
        let min_needed = padding.block_size_max / 2;
        for _ in 0..50 {
            let size = draw_block_size(min_needed);
            assert!(size >= min_needed, "Block size {} below required capacity {}", size, min_needed);
        }
    }

    #[test]
    fn test_block_size_distribution() {
        let padding = &PaddingValues::TEST;
        // Block sizes should cluster around exp(BLOCK_SIZE_LOG_MU)
        let samples: Vec<usize> = (0..100).map(|_| draw_block_size(padding.block_size_min)).collect();

        // Calculate average
        let avg: f64 = samples.iter().map(|&x| x as f64).sum::<f64>() / samples.len() as f64;

        // Average should be within the valid range
        assert!(avg >= padding.block_size_min as f64 && avg <= padding.block_size_max as f64,
            "Average block size {} seems off (range: {} - {})", avg, padding.block_size_min, padding.block_size_max);
    }

    #[test]
    fn test_write_random_padding() {
        use crate::fs::{InMemoryFs, FileSystem, FILE_DATA};

        let mut fs = InMemoryFs::new();
        write_random_padding(&mut fs, FILE_DATA, 0, 1024);

        assert_eq!(fs.get_size(FILE_DATA), 1024);

        // Data should be random (not all zeros)
        let data = fs.read_bytes(FILE_DATA, 0, 1024);
        let zeros = data.iter().filter(|&&b| b == 0).count();
        assert!(zeros < 100, "Too many zeros in random padding: {}/1024", zeros);
    }

    /// Performance guard: ensure block size sampling is efficient.
    /// This catches misconfigurations where log_mu is outside the valid range,
    /// which would cause the rejection loop to spin excessively.
    #[test]
    fn test_block_size_sampling_efficiency() {
        use std::time::Instant;
        use crate::config::PaddingValues;

        // Test all padding configurations
        for (name, padding) in [
            ("PROD", &PaddingValues::PROD),
            ("TEST", &PaddingValues::TEST),
            ("TINY", &PaddingValues::TINY),
        ] {
            let start = Instant::now();
            for _ in 0..100 {
                let _ = draw_block_size_with_config(padding.block_size_min, padding);
            }
            let elapsed = start.elapsed();

            // 100 samples should complete in well under 1 second
            // (with correct log_mu, each sample takes ~1-5 iterations on average)
            assert!(
                elapsed.as_millis() < 1000,
                "{}: block size sampling took {}ms for 100 samples - log_mu may be misconfigured",
                name,
                elapsed.as_millis()
            );
        }
    }

    /// Verify that impossible capacity triggers panic (not infinite loop)
    #[test]
    #[should_panic(expected = "impossible to allocate block")]
    fn test_block_size_impossible_capacity_panics() {
        use crate::config::PaddingValues;

        // Request more capacity than max block size - impossible!
        let impossible_capacity = PaddingValues::TEST.block_size_max + 1;
        let _ = draw_block_size_with_config(impossible_capacity, &PaddingValues::TEST);
    }

    /// Verify that misconfigured distribution triggers panic (not infinite loop)
    #[test]
    #[should_panic(expected = "sampling failed")]
    fn test_block_size_misconfigured_distribution_panics() {
        // Create a broken config where log_mu is way outside valid range
        let broken = PaddingValues {
            pareto_min: 1024,
            pareto_max: 10 * 1024,
            block_size_min: 1024,
            block_size_max: 10 * 1024,
            block_size_log_mu: 30.0,  // e^30 ≈ 10^13 - way above max!
            block_size_log_sigma: 0.1,
            pareto_alpha: 1.25,
        };

        // This should panic after MAX_SAMPLING_ITERATIONS, not loop forever
        let _ = draw_block_size_with_config(broken.block_size_min, &broken);
    }
}
