//! Observed behaviour: strikes that scale trust down and lead to bans.

use std::collections::HashMap;

use gossip_wire::{PeerId, UnixMillis};

/// Kinds of misbehaviour the network layer reports.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Misbehaviour {
    /// Sent a blob that fails validation (bad signature, malformed).
    InvalidBlob,
    /// Sent a malformed or oversized message.
    ProtocolViolation,
    /// Exceeded its ingest budget repeatedly.
    Flooding,
    /// Presented a proof that failed verification.
    BadProof,
    /// Tried to reuse an identity already bound to another peer.
    SybilAttempt,
}

impl Misbehaviour {
    /// Strikes charged for this kind.
    pub fn strikes(self) -> u32 {
        match self {
            Misbehaviour::Flooding => 1,
            Misbehaviour::InvalidBlob | Misbehaviour::ProtocolViolation => 2,
            Misbehaviour::BadProof | Misbehaviour::SybilAttempt => 3,
        }
    }
}

#[derive(Clone, Debug, Default)]
struct Entry {
    strikes: u32,
    last: UnixMillis,
}

/// Per-peer strike ledger.
#[derive(Default, Debug)]
pub struct BehaviourLedger {
    entries: HashMap<PeerId, Entry>,
}

impl BehaviourLedger {
    /// Empty ledger.
    pub fn new() -> Self {
        Self::default()
    }

    /// Records a misbehaviour and returns the new strike count.
    pub fn record(
        &mut self,
        peer: &PeerId,
        kind: Misbehaviour,
        now: UnixMillis,
        ttl_ms: u64,
    ) -> u32 {
        let e = self.entries.entry(*peer).or_default();
        if now.0.saturating_sub(e.last.0) > ttl_ms {
            e.strikes = 0;
        }
        e.strikes = e.strikes.saturating_add(kind.strikes());
        e.last = now;
        e.strikes
    }

    /// Current strikes (0 once expired).
    pub fn strikes(&self, peer: &PeerId, now: UnixMillis, ttl_ms: u64) -> u32 {
        match self.entries.get(peer) {
            Some(e) if now.0.saturating_sub(e.last.0) <= ttl_ms => e.strikes,
            _ => 0,
        }
    }

    /// Multiplier applied to trust: `(1 - penalty)^strikes`.
    pub fn multiplier(&self, peer: &PeerId, now: UnixMillis, ttl_ms: u64, penalty: f64) -> f64 {
        (1.0 - penalty.clamp(0.0, 1.0)).powi(self.strikes(peer, now, ttl_ms) as i32)
    }

    /// Forgets a peer (e.g. after a ban is lifted).
    pub fn forget(&mut self, peer: &PeerId) {
        self.entries.remove(peer);
    }

    /// Drops expired entries.
    pub fn prune(&mut self, now: UnixMillis, ttl_ms: u64) {
        self.entries
            .retain(|_, e| now.0.saturating_sub(e.last.0) <= ttl_ms);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use massa_signature::KeyPair;

    #[test]
    fn strikes_accumulate_and_expire() {
        let p = PeerId::from_public_key(KeyPair::generate(0).unwrap().get_public_key());
        let mut l = BehaviourLedger::new();
        assert_eq!(l.record(&p, Misbehaviour::Flooding, UnixMillis(0), 100), 1);
        assert_eq!(
            l.record(&p, Misbehaviour::InvalidBlob, UnixMillis(10), 100),
            3
        );
        assert!((l.multiplier(&p, UnixMillis(10), 100, 0.5) - 0.125).abs() < 1e-9);
        assert_eq!(l.strikes(&p, UnixMillis(500), 100), 0);
        assert_eq!(
            l.record(&p, Misbehaviour::Flooding, UnixMillis(500), 100),
            1
        );
    }
}
