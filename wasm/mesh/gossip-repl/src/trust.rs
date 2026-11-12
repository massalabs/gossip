//! How the replication engine reads the trust of its peers.

use std::collections::HashMap;

use gossip_wire::PeerId;
use parking_lot::RwLock;

/// Effective trust of peers, as consumed by the blob handler.
pub trait PeerTrust: Send + Sync {
    /// Effective trust of `peer` now, in `0.0..=1.0` (0 for unknown peers).
    fn trust_of(&self, peer: &PeerId) -> f64;
}

/// [`PeerTrust`] with fixed values (tests, simulation, or a node that assigns trust by
/// configuration).
#[derive(Default)]
pub struct FixedTrust {
    values: RwLock<HashMap<PeerId, f64>>,
    default: f64,
}

impl FixedTrust {
    /// A view where every unknown peer has `default` trust.
    pub fn new(default: f64) -> Self {
        Self {
            values: RwLock::new(HashMap::new()),
            default,
        }
    }

    /// Sets the trust of a peer.
    pub fn set(&self, peer: PeerId, value: f64) {
        self.values.write().insert(peer, value);
    }

    /// Forgets the trust of a peer (it falls back to the default).
    pub fn remove(&self, peer: &PeerId) {
        self.values.write().remove(peer);
    }
}

impl PeerTrust for FixedTrust {
    fn trust_of(&self, peer: &PeerId) -> f64 {
        self.values
            .read()
            .get(peer)
            .copied()
            .unwrap_or(self.default)
    }
}
