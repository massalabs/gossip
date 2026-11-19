//! Query timing (§11.3, §12.2, Appendix B) and the provisional resource limits of §17.4.
//!
//! Every bound is computed exactly in 128 bits (§1, D.25).

use crate::rng::{Randomness, uniform_below};

/// One minute, in milliseconds.
pub const MINUTE_MS: u64 = 60_000;
/// One hour, in milliseconds.
pub const HOUR_MS: u64 = 60 * MINUTE_MS;
/// One day, in milliseconds.
pub const DAY_MS: u64 = 24 * HOUR_MS;

// ── Query timing (§11.3, Appendix B) ─────────────────────────────────────────

/// The first nominal TTL of a query: 60 s.
pub const FIRST_TTL_MS: u64 = 60_000;
/// The largest nominal TTL: 24 h. A received query with a larger `ttl` is ignored.
pub const MAX_TTL_MS: u64 = DAY_MS;
/// The clock tolerance of a query: `sent_at ≤ now + 5 min`.
pub const QUERY_CLOCK_TOLERANCE_MS: u64 = 5 * MINUTE_MS;
/// Unanswered stages of a logical query before it pauses (§11.4).
pub const MAX_UNANSWERED_STAGES: u8 = 20;
/// The jitter factor `r`, in millionths: uniform in `[0.95, 1.05]`.
pub const JITTER_MIN_PPM: u32 = 950_000;
/// See [`JITTER_MIN_PPM`].
pub const JITTER_MAX_PPM: u32 = 1_050_000;

// ── Scans and periodic recovery (§12.2, §12.3) ───────────────────────────────

/// How long the identifier-only tombstone of a dropped frozen list is kept: 24 h.
pub const SCAN_TOMBSTONE_MS: u64 = DAY_MS;
/// The period of each periodic recovery lane: one scan per 24 h, from its completion.
pub const LANE_PERIOD_MS: u64 = DAY_MS;
/// The nominal offset between two consecutive lanes: 6 h, jittered like a TTL.
pub const LANE_OFFSET_MS: u64 = 6 * HOUR_MS;

// ── Hints (§10.3) ────────────────────────────────────────────────────────────

/// A hint expires 28 days after it is first recorded.
pub const HINT_EXPIRY_MS: u64 = 28 * DAY_MS;
/// Hints per group, shared across its peers, with least-recently-used eviction.
pub const HINT_CAPACITY: usize = 65_536;

// ── Version notices (§13.8) ──────────────────────────────────────────────────

/// At most one version notice per peer and received version per 24 h.
pub const VERSION_NOTICE_INTERVAL_MS: u64 = DAY_MS;

// ── Provisional resource limits (§17.4) ──────────────────────────────────────

/// Live scans a device serves to one peer.
pub const LIVE_SCANS_PER_PEER: usize = 4;
/// Live scans a device serves in total.
pub const LIVE_SCANS_PER_DEVICE: usize = 64;
/// Bytes of frozen IDs a device keeps in total for the scans it serves.
pub const FROZEN_ID_BYTES: usize = 16 * 1024 * 1024;
/// Lookup entries outstanding with one peer.
pub const ACTIVE_LOOKUPS_PER_PEER: usize = 16;
/// Lookup entries outstanding in total.
pub const ACTIVE_LOOKUPS_PER_DEVICE: usize = 64;
/// Missing IDs queued for retrieval in one group; beyond it, paging pauses.
pub const QUEUED_MISSING_PER_GROUP: usize = 65_536;
/// Missing IDs queued for retrieval in total.
pub const QUEUED_MISSING_PER_DEVICE: usize = 262_144;
/// The per-peer request budget: query entries a peer may make this device answer, burst.
pub const REQUEST_BURST: u64 = 128;
/// Its refill, entries per minute.
pub const REQUEST_REFILL_PER_MIN: u64 = 16;
/// The per-peer response budget: bytes of answers this device sends a peer, burst.
pub const RESPONSE_BURST: u64 = 1024 * 1024;
/// Its refill, bytes per minute.
pub const RESPONSE_REFILL_PER_MIN: u64 = 256 * 1024;
/// Parent edges examined per scheduling turn by the traversals this layer runs (§17.4).
pub const EDGES_PER_TURN: usize = 4_096;
/// The device-wide ceiling of plaintexts assembled per call, rotated fairly across peers.
/// §17.4 leaves its value to profiling; this one is provisional.
pub const PLAINTEXTS_PER_POLL: usize = 64;

/// The next nominal TTL after an unanswered timeout: `min(24 h, ceil(current × 3142 / 1000))`.
#[must_use]
pub fn next_ttl(current: u64) -> u64 {
    let grown = (u128::from(current) * 3142).div_ceil(1000);
    u64::try_from(grown.min(u128::from(MAX_TTL_MS))).unwrap_or(MAX_TTL_MS)
}

/// The nominal TTL of stage `stage` (0-based).
#[must_use]
pub fn ttl_of_stage(stage: u8) -> u64 {
    (0..stage).fold(FIRST_TTL_MS, |t, _| next_ttl(t))
}

/// Whether a received query is ignored as a whole: `ttl = 0`, `ttl` over 24 h, or `sent_at`
/// more than 5 minutes in the receiver's future (§11.3).
#[must_use]
pub fn ignored_query(sent_at: u64, ttl: u64, now: u64) -> bool {
    ttl == 0
        || ttl > MAX_TTL_MS
        || u128::from(sent_at) > u128::from(now) + u128::from(QUERY_CLOCK_TOLERANCE_MS)
}

/// Whether a receiver may still answer: `20 × now ≤ 20 × sent_at + 21 × ttl + 6,000,000`,
/// which is `now ≤ sent_at + 1.05 × ttl + 5 min` computed exactly (§11.3).
#[must_use]
pub fn may_answer(sent_at: u64, ttl: u64, now: u64) -> bool {
    20 * u128::from(now) <= 20 * u128::from(sent_at) + 21 * u128::from(ttl) + 6_000_000
}

/// The last instant at which [`may_answer`] holds: `floor(sent_at + 1.05 × ttl + 5 min)`.
/// Correlation references, frozen lists and scan references live until it (§12.2, §13.4).
#[must_use]
pub fn deadline(sent_at: u64, ttl: u64) -> u64 {
    let d = (20 * u128::from(sent_at) + 21 * u128::from(ttl) + 6_000_000) / 20;
    u64::try_from(d).unwrap_or(u64::MAX)
}

/// A jitter factor `r` drawn uniformly from `[0.95, 1.05]`, in millionths.
pub fn draw_jitter(rng: &mut dyn Randomness) -> u32 {
    let span = (JITTER_MAX_PPM - JITTER_MIN_PPM + 1) as usize;
    JITTER_MIN_PPM + uniform_below(rng, span) as u32
}

/// `floor(duration × r)` milliseconds, `r` in millionths (§11.3, §12.3).
#[must_use]
pub fn jittered(duration: u64, r_ppm: u32) -> u64 {
    let v = u128::from(duration) * u128::from(r_ppm) / 1_000_000;
    u64::try_from(v).unwrap_or(u64::MAX)
}

/// `a + b`, saturating: used only for local wake-up times, never for a protocol bound.
#[must_use]
pub fn later(a: u64, b: u64) -> u64 {
    a.saturating_add(b)
}

/// A token bucket of §17.4, in scaled units so that the refill is exact per millisecond:
/// a level of `tokens × 60,000`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Bucket {
    /// The scaled level at `at`.
    pub level: u64,
    /// When the level was last computed.
    pub at: u64,
}

impl Bucket {
    /// A full bucket of `burst` tokens at `now`.
    #[must_use]
    pub fn full(burst: u64, now: u64) -> Self {
        Self {
            level: burst.saturating_mul(MINUTE_MS),
            at: now,
        }
    }

    fn refill(&mut self, burst: u64, per_min: u64, now: u64) {
        let cap = burst.saturating_mul(MINUTE_MS);
        let elapsed = now.saturating_sub(self.at);
        self.level = self
            .level
            .saturating_add(elapsed.saturating_mul(per_min))
            .min(cap);
        self.at = self.at.max(now);
    }

    /// Takes `n` tokens if available.
    pub fn take(&mut self, n: u64, burst: u64, per_min: u64, now: u64) -> bool {
        self.refill(burst, per_min, now);
        let need = n.saturating_mul(MINUTE_MS);
        if self.level >= need {
            self.level -= need;
            true
        } else {
            false
        }
    }

    /// The tokens available at `now`, rounded down.
    #[must_use]
    pub fn available(&self, burst: u64, per_min: u64, now: u64) -> u64 {
        let mut b = *self;
        b.refill(burst, per_min, now);
        b.level / MINUTE_MS
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rng::TestRng;

    #[test]
    fn ttl_grows_by_pi_and_caps_at_a_day() {
        assert_eq!(next_ttl(60_000), 188_520);
        assert_eq!(next_ttl(188_520), 592_330); // ceil(592,329.84)
        assert_eq!(next_ttl(80_000_000), MAX_TTL_MS);
        assert_eq!(next_ttl(MAX_TTL_MS), MAX_TTL_MS);
        assert_eq!(ttl_of_stage(0), FIRST_TTL_MS);
        assert_eq!(ttl_of_stage(1), 188_520);
        assert_eq!(ttl_of_stage(19), MAX_TTL_MS);
    }

    #[test]
    fn receiver_bounds_are_exact() {
        let ttl = 60_000;
        // 1.05 × 60 s + 5 min = 363 s.
        assert!(may_answer(1_000, ttl, 1_000 + 363_000));
        assert!(!may_answer(1_000, ttl, 1_000 + 363_001));
        assert_eq!(deadline(1_000, ttl), 364_000);
        // An odd TTL: 1.05 × 1 ms = 1.05 ms; the deadline is floored.
        assert_eq!(deadline(0, 1), 300_001);
        assert!(may_answer(0, 1, 300_001));
        assert!(!may_answer(0, 1, 300_002));
        assert!(may_answer(u64::MAX - 1, MAX_TTL_MS, u64::MAX));
        assert_eq!(deadline(u64::MAX, MAX_TTL_MS), u64::MAX);
    }

    #[test]
    fn queries_with_bad_timing_are_ignored() {
        let now = 10 * HOUR_MS;
        assert!(ignored_query(now, 0, now));
        assert!(ignored_query(now, MAX_TTL_MS + 1, now));
        assert!(!ignored_query(now, MAX_TTL_MS, now));
        assert!(!ignored_query(now + 5 * MINUTE_MS, 1, now));
        assert!(ignored_query(now + 5 * MINUTE_MS + 1, 1, now));
        assert!(!ignored_query(u64::MAX, 1, u64::MAX));
    }

    #[test]
    fn jitter_stays_within_five_percent() {
        let mut rng = TestRng::new(3);
        let (mut lo, mut hi) = (u32::MAX, 0);
        for _ in 0..2_000 {
            let r = draw_jitter(&mut rng);
            lo = lo.min(r);
            hi = hi.max(r);
        }
        assert!((JITTER_MIN_PPM..960_000).contains(&lo));
        assert!(hi <= JITTER_MAX_PPM && hi > 1_040_000);
        assert_eq!(jittered(60_000, 950_000), 57_000);
        assert_eq!(jittered(60_001, 950_000), 57_000); // floored
        assert_eq!(jittered(LANE_OFFSET_MS, 1_050_000), 22_680_000);
    }

    #[test]
    fn buckets_refill_per_millisecond_and_cap_at_the_burst() {
        let mut b = Bucket::full(REQUEST_BURST, 0);
        assert!(b.take(128, REQUEST_BURST, REQUEST_REFILL_PER_MIN, 0));
        assert!(!b.take(1, REQUEST_BURST, REQUEST_REFILL_PER_MIN, 0));
        // 16 per minute: one entry every 3,750 ms.
        assert!(!b.take(1, REQUEST_BURST, REQUEST_REFILL_PER_MIN, 3_749));
        assert!(b.take(1, REQUEST_BURST, REQUEST_REFILL_PER_MIN, 3_750));
        assert_eq!(
            b.available(REQUEST_BURST, REQUEST_REFILL_PER_MIN, 100 * HOUR_MS),
            REQUEST_BURST
        );
    }
}
