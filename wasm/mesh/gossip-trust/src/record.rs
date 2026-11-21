//! Per-peer trust record.

use gossip_wire::{SchemeId, UnixMillis};
use serde::{Deserialize, Serialize};

use crate::scheme::Tag;

/// Number of discrete trust buckets (used for storage eviction ordering).
pub const TRUST_BUCKETS: u8 = 16;

/// Maps a trust value in `0.0..=1.0` to a bucket `0..TRUST_BUCKETS`.
pub fn trust_bucket(value: f64) -> u8 {
    let v = value.clamp(0.0, 1.0);
    ((v * (TRUST_BUCKETS as f64 - 1.0)).round() as u8).min(TRUST_BUCKETS - 1)
}

/// What a peer proved and when.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Default)]
pub struct TrustRecord {
    /// Folded trust value at proof time, `0.0..=1.0`.
    pub value: f64,
    /// Per-scheme scores that were verified.
    pub proven: Vec<(SchemeId, f64)>,
    /// When the proofs were verified.
    pub last_proof_at: UnixMillis,
    /// Tags claimed by this peer (released when the record is dropped).
    #[serde(default)]
    pub tags: Vec<(SchemeId, Tag)>,
}

impl TrustRecord {
    /// A record for a peer that proved nothing.
    pub fn unproven(now: UnixMillis) -> Self {
        Self {
            value: 0.0,
            proven: Vec::new(),
            last_proof_at: now,
            tags: Vec::new(),
        }
    }

    /// Whether any scheme was proven.
    pub fn is_proven(&self) -> bool {
        !self.proven.is_empty()
    }

    /// Trust value after expiry: 0 once the proof is older than `ttl_ms`.
    pub fn effective(&self, now: UnixMillis, ttl_ms: u64) -> f64 {
        if now.0.saturating_sub(self.last_proof_at.0) > ttl_ms {
            0.0
        } else {
            self.value
        }
    }

    /// Bucket of the effective value.
    pub fn bucket(&self, now: UnixMillis, ttl_ms: u64) -> u8 {
        trust_bucket(self.effective(now, ttl_ms))
    }
}

impl serde::Serialize for Tag {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        (&self.scope, &self.value).serialize(s)
    }
}

impl<'de> serde::Deserialize<'de> for Tag {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let (scope, value): (Vec<u8>, [u8; 32]) = serde::Deserialize::deserialize(d)?;
        Ok(Tag { scope, value })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn buckets_cover_range() {
        assert_eq!(trust_bucket(0.0), 0);
        assert_eq!(trust_bucket(1.0), TRUST_BUCKETS - 1);
        assert_eq!(trust_bucket(-3.0), 0);
        assert_eq!(trust_bucket(9.0), TRUST_BUCKETS - 1);
        assert!(trust_bucket(0.5) > trust_bucket(0.1));
    }

    #[test]
    fn effective_decays_after_ttl() {
        let r = TrustRecord {
            value: 0.8,
            proven: vec![(1, 0.8)],
            last_proof_at: UnixMillis(1000),
            tags: vec![],
        };
        assert_eq!(r.effective(UnixMillis(1500), 1000), 0.8);
        assert_eq!(r.effective(UnixMillis(2500), 1000), 0.0);
    }
}
