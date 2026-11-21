//! Operator-tunable trust policy.

use std::collections::HashMap;

use gossip_wire::SchemeId;
use serde::{Deserialize, Serialize};

/// How verified proofs become a trust value and how that value is used.
///
/// All fields have defaults so an operator only sets what they care about.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct TrustPolicy {
    /// Weight of each scheme's score in the folded value (missing = 0, i.e. verified
    /// but ignored). The fold is `min(1, Σ weight × score)`. TOML keys are the scheme
    /// ids as strings (`[weights]\n1 = 0.8`).
    #[serde(with = "weights_serde")]
    pub weights: HashMap<SchemeId, f64>,
    /// Peers at or above this value are never evicted for a newcomer and get reserved
    /// slots first.
    pub protected_trust: f64,
    /// Minimum trust for a known peer to be dialled outside the exploration quota.
    pub min_trust_for_out_slot: f64,
    /// Fraction of outbound slots kept for unproven or low-trust peers (exploration).
    pub unproven_out_slot_fraction: f64,
    /// Proofs older than this are treated as absent.
    pub proof_ttl_ms: u64,
    /// How often a connected peer is challenged again, so its trust follows what it
    /// can prove now and never ages out while connected. 0 = only when something
    /// changes (a peer's proofs, or this node's schemes).
    pub refresh_interval_ms: u64,
    /// Shortest gap between two trust refreshes of the same peer, whatever triggers
    /// them; a peer that challenges us more often than this gets no answer.
    pub refresh_min_interval_ms: u64,
    /// Trust assigned to blobs submitted by local (HTTP) clients.
    pub local_submission_trust: f64,
    /// A tag held by a disconnected peer can be taken over by another peer after this.
    pub nullifier_transfer_grace_ms: u64,
    /// Multiplicative penalty per recorded misbehaviour (value × (1 - penalty)^n).
    pub behaviour_penalty: f64,
    /// Misbehaviour records older than this are forgotten.
    pub behaviour_ttl_ms: u64,
    /// Misbehaviours before the peer is banned.
    pub ban_after_strikes: u32,
    /// Whether a peer that fails a proof it volunteered is refused outright.
    pub reject_on_bad_proof: bool,
    /// Most expensive verifications (ring signatures, zero-knowledge receipts) running at
    /// once across all handshakes. When every slot is busy, expensive proofs are skipped
    /// without penalty, so forged proofs cannot pin every handshake thread.
    pub max_concurrent_expensive_verifications: usize,
    /// Expensive proofs (proof of work, ring signatures) computed at once across all
    /// handshakes. A handshake waits up to `proving_slot_wait_ms` for a slot, then leaves
    /// that challenge unanswered.
    pub max_concurrent_expensive_proofs: usize,
    /// How long a handshake waits for a free proving slot, in milliseconds.
    pub proving_slot_wait_ms: u64,
    /// Wall-clock milliseconds per minute this node may spend computing expensive proofs,
    /// across all peers; up to one minute's worth can be spent in a burst. When used up,
    /// expensive challenges go unanswered until the budget refills. 0 = never answer
    /// expensive challenges.
    pub proving_budget_ms_per_min: u64,
}

/// TOML/JSON map keys are strings; (de)serialize scheme ids through `String`.
mod weights_serde {
    use super::*;
    use serde::de::Error as _;
    use serde::{Deserializer, Serializer};

    pub fn serialize<S: Serializer>(w: &HashMap<SchemeId, f64>, s: S) -> Result<S::Ok, S::Error> {
        let m: std::collections::BTreeMap<String, f64> =
            w.iter().map(|(k, v)| (k.to_string(), *v)).collect();
        serde::Serialize::serialize(&m, s)
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(
        d: D,
    ) -> Result<HashMap<SchemeId, f64>, D::Error> {
        let m: HashMap<String, f64> = serde::Deserialize::deserialize(d)?;
        m.into_iter()
            .map(|(k, v)| {
                k.trim()
                    .parse::<SchemeId>()
                    .map(|k| (k, v))
                    .map_err(|e| D::Error::custom(format!("bad scheme id {k:?}: {e}")))
            })
            .collect()
    }
}

impl Default for TrustPolicy {
    fn default() -> Self {
        Self {
            weights: HashMap::new(),
            protected_trust: 0.6,
            min_trust_for_out_slot: 0.0,
            unproven_out_slot_fraction: 0.3,
            proof_ttl_ms: 24 * 60 * 60 * 1000,
            refresh_interval_ms: 60 * 60 * 1000,
            refresh_min_interval_ms: 30 * 1000,
            local_submission_trust: 0.5,
            nullifier_transfer_grace_ms: 10 * 60 * 1000,
            behaviour_penalty: 0.5,
            behaviour_ttl_ms: 6 * 60 * 60 * 1000,
            ban_after_strikes: 3,
            reject_on_bad_proof: true,
            max_concurrent_expensive_verifications: 4,
            max_concurrent_expensive_proofs: 4,
            proving_slot_wait_ms: 2_000,
            proving_budget_ms_per_min: 20_000,
        }
    }
}

impl TrustPolicy {
    /// Weight for a scheme (0 when unset).
    pub fn weight(&self, scheme: SchemeId) -> f64 {
        self.weights.get(&scheme).copied().unwrap_or(0.0)
    }

    /// Folds per-scheme scores into one value.
    pub fn fold(&self, scores: &[(SchemeId, f64)]) -> f64 {
        scores
            .iter()
            .map(|(id, s)| self.weight(*id) * s.clamp(0.0, 1.0))
            .sum::<f64>()
            .clamp(0.0, 1.0)
    }

    /// Validates ranges.
    pub fn validate(&self) -> Result<(), String> {
        for (k, v) in &self.weights {
            if !(0.0..=1.0).contains(v) || v.is_nan() {
                return Err(format!("weight for scheme {k} must be in 0..=1"));
            }
        }
        for (name, v) in [
            ("protected_trust", self.protected_trust),
            ("min_trust_for_out_slot", self.min_trust_for_out_slot),
            (
                "unproven_out_slot_fraction",
                self.unproven_out_slot_fraction,
            ),
            ("local_submission_trust", self.local_submission_trust),
            ("behaviour_penalty", self.behaviour_penalty),
        ] {
            if !(0.0..=1.0).contains(&v) || v.is_nan() {
                return Err(format!("{name} must be in 0..=1"));
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fold_is_weighted_and_clamped() {
        let mut p = TrustPolicy::default();
        p.weights.insert(1, 0.5);
        p.weights.insert(2, 0.8);
        assert!((p.fold(&[(1, 1.0)]) - 0.5).abs() < 1e-9);
        assert!((p.fold(&[(1, 1.0), (2, 1.0)]) - 1.0).abs() < 1e-9);
        assert_eq!(p.fold(&[(9, 1.0)]), 0.0);
    }

    #[test]
    fn toml_roundtrip_with_defaults() {
        let src = r#"
            protected_trust = 0.7
            [weights]
            1 = 0.6
            16 = 1.0
        "#;
        let p: TrustPolicy = toml::from_str(src).unwrap();
        assert_eq!(p.protected_trust, 0.7);
        assert_eq!(p.weight(16), 1.0);
        assert_eq!(p.ban_after_strikes, 3);
        p.validate().unwrap();
    }
}
