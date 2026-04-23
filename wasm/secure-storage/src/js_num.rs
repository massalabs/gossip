//! Precision-aware numeric conversions between JS `number` (`f64`) and Rust
//! integer types. Values beyond JS's safe integer range (2^53) lose precision
//! in `f64`, so we reject them here rather than letting a silent round-trip
//! happen at a far-away call site.

/// Convert a JS `number` offset to `u64`, rejecting values that cannot be
/// represented precisely in `f64`.
///
/// Returns `None` for:
///   - non-finite inputs (`NaN`, `+/-Infinity`),
///   - negative values,
///   - values that exceed JS's `Number.MAX_SAFE_INTEGER` (2^53 − 1) — above
///     this threshold, an `f64` rounds to the nearest 2-power multiple, so
///     `v as u64` would silently lose user intent (e.g. `u64::MAX as f64`
///     rounds up to `2^64`, which is not a valid `u64` at all).
pub fn safe_f64_to_u64(v: f64) -> Option<u64> {
    // Accept only finite, non-negative f64 < 2^53 (JS safe integer range).
    // Above 2^53, f64 loses integer precision and `v as u64` rounds silently.
    const MAX_SAFE: f64 = (1u64 << 53) as f64;
    (v.is_finite() && (0.0..MAX_SAFE).contains(&v)).then(|| v as u64)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_zero() {
        assert_eq!(safe_f64_to_u64(0.0), Some(0));
    }

    #[test]
    fn accepts_max_safe_integer() {
        // MAX_SAFE_INTEGER = 2^53 − 1 = 9_007_199_254_740_991.
        let v = 9_007_199_254_740_991.0_f64;
        assert_eq!(safe_f64_to_u64(v), Some(9_007_199_254_740_991));
    }

    #[test]
    fn rejects_negative() {
        assert_eq!(safe_f64_to_u64(-1.0), None);
    }

    #[test]
    fn rejects_nan() {
        assert_eq!(safe_f64_to_u64(f64::NAN), None);
    }

    #[test]
    fn rejects_infinity() {
        assert_eq!(safe_f64_to_u64(f64::INFINITY), None);
        assert_eq!(safe_f64_to_u64(f64::NEG_INFINITY), None);
    }

    /// Regression: `u64::MAX as f64` rounds up to 2^64, so comparing
    /// `v <= u64::MAX as f64` accepts values that exceed `u64::MAX`.
    /// The f64 → u64 cast then saturates silently. We reject the whole
    /// region beyond 2^53 instead.
    #[test]
    fn rejects_values_beyond_safe_integer() {
        let at_limit = 9_007_199_254_740_992.0_f64; // 2^53
        assert_eq!(safe_f64_to_u64(at_limit), None);

        let u64_max_as_f64 = u64::MAX as f64;
        assert_eq!(safe_f64_to_u64(u64_max_as_f64), None);
    }
}
