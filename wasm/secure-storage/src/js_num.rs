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
/// 2^53 — one past JS's `Number.MAX_SAFE_INTEGER`. `f64` distinguishes every
/// integer strictly below this bound; at and above, adjacent integers collapse
/// onto the same `f64`, making `v as {u64,i64}` silently lossy.
const MAX_SAFE: f64 = (1u64 << 53) as f64;

pub fn safe_f64_to_u64(v: f64) -> Option<u64> {
    // Accept only finite, non-negative f64 < 2^53 (JS safe integer range).
    (v.is_finite() && (0.0..MAX_SAFE).contains(&v)).then(|| v as u64)
}

/// f64 → i64 for JS `number` params bound as SQLite INTEGER. Accepts only
/// whole integers within JS safe range (|v| < 2^53); non-integers or values
/// beyond safe range are rejected so callers fall back to binding as REAL.
pub fn safe_f64_to_i64(v: f64) -> Option<i64> {
    (v.is_finite() && v.fract() == 0.0 && v.abs() < MAX_SAFE).then(|| v as i64)
}

/// Whether an i64 fits losslessly into a JS `Number` (|v| < 2^53).
/// Matches ECMAScript `Number.isSafeInteger` for integer inputs.
pub fn is_js_safe_integer_i64(v: i64) -> bool {
    v.unsigned_abs() < (1u64 << 53)
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

    // ── safe_f64_to_i64 ──

    #[test]
    fn f64_to_i64_accepts_zero_and_safe_extremes() {
        assert_eq!(safe_f64_to_i64(0.0), Some(0));
        let max_safe = 9_007_199_254_740_991.0_f64; // 2^53 - 1
        assert_eq!(safe_f64_to_i64(max_safe), Some(9_007_199_254_740_991));
        assert_eq!(safe_f64_to_i64(-max_safe), Some(-9_007_199_254_740_991));
    }

    #[test]
    fn f64_to_i64_rejects_non_integer() {
        assert_eq!(safe_f64_to_i64(1.5), None);
        assert_eq!(safe_f64_to_i64(-3.14), None);
    }

    #[test]
    fn f64_to_i64_rejects_non_finite() {
        assert_eq!(safe_f64_to_i64(f64::NAN), None);
        assert_eq!(safe_f64_to_i64(f64::INFINITY), None);
        assert_eq!(safe_f64_to_i64(f64::NEG_INFINITY), None);
    }

    /// Regression: the old `n < i64::MAX as f64 && n >= i64::MIN as f64`
    /// check accepted values beyond 2^53 where f64 already loses integer
    /// precision — a round-trip would silently lose digits. We reject the
    /// whole region beyond 2^53 instead.
    #[test]
    fn f64_to_i64_rejects_beyond_safe_integer() {
        let big = 1e18_f64; // > 2^53, < 2^63 — accepted by old check
        assert_eq!(safe_f64_to_i64(big), None);
        assert_eq!(safe_f64_to_i64(-big), None);

        // Exactly at 2^53: rejected (not safe).
        let at_limit = 9_007_199_254_740_992.0_f64;
        assert_eq!(safe_f64_to_i64(at_limit), None);
        assert_eq!(safe_f64_to_i64(-at_limit), None);
    }

    // ── is_js_safe_integer_i64 ──

    #[test]
    fn i64_safe_integer_accepts_zero_and_max_safe() {
        assert!(is_js_safe_integer_i64(0));
        let max_safe = (1i64 << 53) - 1; // 2^53 - 1
        assert!(is_js_safe_integer_i64(max_safe));
        assert!(is_js_safe_integer_i64(-max_safe));
    }

    #[test]
    fn i64_safe_integer_rejects_at_and_beyond_2_pow_53() {
        // 2^53 itself is representable as f64, but ECMAScript treats it as
        // unsafe because 2^53 + 1 rounds back to 2^53. Reject both signs.
        let at = 1i64 << 53;
        assert!(!is_js_safe_integer_i64(at));
        assert!(!is_js_safe_integer_i64(-at));

        // Extremes
        assert!(!is_js_safe_integer_i64(i64::MAX));
        assert!(!is_js_safe_integer_i64(i64::MIN));
    }
}
