//! Storage configuration
//!
//! Allows configuring padding values (in test builds).

/// Padding values configuration
#[derive(Clone, Copy, Debug)]
pub struct PaddingValues {
    /// Minimum Pareto padding size in bytes
    pub pareto_min: u64,
    /// Maximum Pareto padding size in bytes
    pub pareto_max: u64,
    /// Minimum block size in bytes
    pub block_size_min: usize,
    /// Maximum block size in bytes
    pub block_size_max: usize,
    /// Log-normal mu parameter for block size distribution
    pub block_size_log_mu: f64,
    /// Log-normal sigma parameter for block size distribution
    pub block_size_log_sigma: f64,
    /// Pareto alpha parameter
    pub pareto_alpha: f64,
}

impl PaddingValues {
    /// Production values (5MB-600MB Pareto, 2MB-256MB blocks)
    pub const PROD: Self = Self {
        pareto_min: 5 * 1024 * 1024,        // 5 MB
        pareto_max: 600 * 1024 * 1024,      // 600 MB
        block_size_min: 2 * 1024 * 1024,    // 2 MB
        block_size_max: 256 * 1024 * 1024,  // 256 MB
        block_size_log_mu: 17.33,           // ln(32 MB) = ln(32 * 1024 * 1024)
        block_size_log_sigma: 0.4,
        pareto_alpha: 1.25,
    };

    /// Test values for fast tests (1KB-10KB)
    pub const TEST: Self = Self {
        pareto_min: 1024,                   // 1 KB
        pareto_max: 10 * 1024,              // 10 KB
        block_size_min: 1024,               // 1 KB
        block_size_max: 10 * 1024,          // 10 KB
        block_size_log_mu: 8.3,             // ln(4 KB)
        block_size_log_sigma: 0.4,
        pareto_alpha: 1.25,
    };

    /// Tiny values for unit tests (very fast)
    pub const TINY: Self = Self {
        pareto_min: 64,                     // 64 bytes
        pareto_max: 256,                    // 256 bytes
        block_size_min: 128,                // 128 bytes
        block_size_max: 512,                // 512 bytes
        block_size_log_mu: 5.5,             // ln(256)
        block_size_log_sigma: 0.3,
        pareto_alpha: 1.25,
    };
}

impl Default for PaddingValues {
    fn default() -> Self {
        #[cfg(any(test, feature = "test-constants"))]
        { Self::TEST }
        #[cfg(not(any(test, feature = "test-constants")))]
        { Self::PROD }
    }
}

/// Storage configuration
#[derive(Clone, Copy, Debug)]
pub struct StorageConfig {
    /// Padding values (only used in test builds; production always uses PROD)
    #[cfg(any(test, feature = "test-constants"))]
    padding_values: PaddingValues,
}

impl StorageConfig {
    /// Create config with default padding values
    pub fn new() -> Self {
        Self::default()
    }

    /// Create config with custom padding values (test builds only)
    /// In production builds, padding values are always PROD
    #[cfg(any(test, feature = "test-constants"))]
    pub fn with_padding(padding: PaddingValues) -> Self {
        Self {
            padding_values: padding,
        }
    }

    /// Get padding values
    /// In production, always returns PROD values regardless of what was set
    pub fn padding(&self) -> &PaddingValues {
        #[cfg(any(test, feature = "test-constants"))]
        { &self.padding_values }
        #[cfg(not(any(test, feature = "test-constants")))]
        { &PaddingValues::PROD }
    }
}

impl Default for StorageConfig {
    fn default() -> Self {
        Self {
            #[cfg(any(test, feature = "test-constants"))]
            padding_values: PaddingValues::default(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_default_config() {
        let config = StorageConfig::default();
        // Default config uses TEST padding values in test builds
        assert_eq!(config.padding().pareto_min, PaddingValues::TEST.pareto_min);
    }

    #[test]
    fn test_custom_padding() {
        let config = StorageConfig::with_padding(PaddingValues::TINY);
        assert_eq!(config.padding().pareto_min, 64);
    }

    /// Verify that log_mu produces a median within the valid block size range
    fn verify_log_mu_in_range(padding: &PaddingValues, name: &str) {
        let median = padding.block_size_log_mu.exp() as usize;
        assert!(
            median >= padding.block_size_min && median <= padding.block_size_max,
            "{}: block_size_log_mu={} produces median={} bytes, which is outside range [{}, {}]",
            name,
            padding.block_size_log_mu,
            median,
            padding.block_size_min,
            padding.block_size_max
        );
    }

    #[test]
    fn test_prod_log_mu_in_valid_range() {
        verify_log_mu_in_range(&PaddingValues::PROD, "PROD");
    }

    #[test]
    fn test_test_log_mu_in_valid_range() {
        verify_log_mu_in_range(&PaddingValues::TEST, "TEST");
    }

    #[test]
    fn test_tiny_log_mu_in_valid_range() {
        verify_log_mu_in_range(&PaddingValues::TINY, "TINY");
    }

    /// Verify PROD constants have expected values
    #[test]
    fn test_prod_constants() {
        let prod = &PaddingValues::PROD;

        // PADDING_MIN = 5 MB
        assert_eq!(prod.pareto_min, 5 * 1024 * 1024, "pareto_min should be 5 MB");

        // PADDING_MAX = 600 MB
        assert_eq!(prod.pareto_max, 600 * 1024 * 1024, "pareto_max should be 600 MB");

        // PADDING_ALPHA = 1.25
        assert!((prod.pareto_alpha - 1.25).abs() < 0.001, "pareto_alpha should be 1.25");

        // BLOCK_MIN = 2 MB
        assert_eq!(prod.block_size_min, 2 * 1024 * 1024, "block_size_min should be 2 MB");

        // BLOCK_MAX = 256 MB
        assert_eq!(prod.block_size_max, 256 * 1024 * 1024, "block_size_max should be 256 MB");

        // BLOCK_MU = ln(32 MB) ≈ 17.33
        let expected_mu = (32.0 * 1024.0 * 1024.0_f64).ln();
        assert!(
            (prod.block_size_log_mu - expected_mu).abs() < 0.1,
            "block_size_log_mu should be ln(32 MB) ≈ {}, got {}",
            expected_mu,
            prod.block_size_log_mu
        );

        // BLOCK_SIGMA = 0.4
        assert!((prod.block_size_log_sigma - 0.4).abs() < 0.001, "block_size_log_sigma should be 0.4");
    }

    /// CRITICAL: Verify PROD sampling is efficient (no infinite loops)
    /// This catches the bug where log_mu=24.5 caused rejection loops
    #[test]
    fn test_prod_block_size_sampling_is_efficient() {
        use crate::blob::draw_block_size_with_config;
        use std::time::Instant;

        let prod = &PaddingValues::PROD;
        let start = Instant::now();

        // Sample 100 block sizes - should complete in <100ms with correct log_mu
        for _ in 0..100 {
            let size = draw_block_size_with_config(prod.block_size_min, prod);
            assert!(size >= prod.block_size_min);
            assert!(size <= prod.block_size_max);
        }

        let elapsed = start.elapsed();
        assert!(
            elapsed.as_millis() < 500,
            "PROD block size sampling took {}ms - log_mu may be misconfigured (should be ~17.33)",
            elapsed.as_millis()
        );
    }

    /// Verify PROD pareto padding values are reasonable for phone storage
    #[test]
    fn test_prod_pareto_distribution_for_phone() {
        use crate::blob::generate_pareto_padding_with_config;

        let prod = &PaddingValues::PROD;

        // Sample 1000 padding sizes
        let samples: Vec<u64> = (0..1000)
            .map(|_| generate_pareto_padding_with_config(prod))
            .collect();

        // All should be within bounds
        for &s in &samples {
            assert!(s >= prod.pareto_min, "Padding {} below min {}", s, prod.pareto_min);
            assert!(s <= prod.pareto_max, "Padding {} above max {}", s, prod.pareto_max);
        }

        // With alpha=1.25, most values cluster near minimum
        // ~80% should be under 20 MB (4x the minimum)
        let under_20mb = samples.iter().filter(|&&s| s < 20 * 1024 * 1024).count();
        assert!(
            under_20mb > 700,
            "Expected >70% of Pareto samples under 20MB, got {}/1000 - check alpha parameter",
            under_20mb
        );

        // Calculate median and mean for phone storage estimation
        let mut sorted = samples.clone();
        sorted.sort();
        let median = sorted[500];
        let mean: u64 = samples.iter().sum::<u64>() / samples.len() as u64;

        // Log for visibility (these values help estimate phone storage needs)
        println!("PROD Pareto distribution (1000 samples):");
        println!("  Min: {} MB", prod.pareto_min / (1024 * 1024));
        println!("  Median: {:.1} MB", median as f64 / (1024.0 * 1024.0));
        println!("  Mean: {:.1} MB", mean as f64 / (1024.0 * 1024.0));
        println!("  Max sampled: {:.1} MB", sorted[999] as f64 / (1024.0 * 1024.0));
    }

    /// Estimate storage cost for typical phone usage
    #[test]
    fn test_estimate_phone_storage_cost() {
        let prod = &PaddingValues::PROD;

        // Typical session: 1 root block + N data blocks
        // Each block has Pareto padding before it

        // Minimum padding per block: 5 MB
        // Median block size: ~32 MB
        // So minimum overhead per block: 5 MB padding + 2 MB min block = 7 MB

        // For a chat app with 10 MB of actual data:
        // - 1 root block (~1 KB actual, but 2 MB min block + 5 MB padding = 7 MB)
        // - ~5 data blocks (10 MB / 2 MB per block)
        // - Each data block: ~7 MB minimum
        // Total: ~7 + 5*7 = 42 MB minimum for 10 MB of chat data

        let min_overhead_per_block = prod.pareto_min + prod.block_size_min as u64;
        let typical_blocks_for_10mb_chat = 5;
        let estimated_storage = min_overhead_per_block * (1 + typical_blocks_for_10mb_chat);

        println!("Estimated phone storage for 10 MB chat data:");
        println!("  Min overhead per block: {} MB", min_overhead_per_block / (1024 * 1024));
        println!("  Estimated total: {} MB", estimated_storage / (1024 * 1024));
        println!("  Overhead ratio: {:.1}x", estimated_storage as f64 / (10.0 * 1024.0 * 1024.0));

        // This is expected - plausible deniability requires significant overhead
        assert!(
            estimated_storage < 100 * 1024 * 1024,
            "Minimum storage estimate seems too high"
        );
    }
}
