//! What each connected peer told us it accepts, and how we stay under it.
//!
//! During the trust round a node's verdict carries its [`PeerLimits`]: the message size
//! caps it enforces and the per-minute budgets it grants us, scaled by the trust it gave
//! us. Sending more than that is either a protocol violation (an oversized list is
//! two strikes, three strikes a ban) or wasted bandwidth (answers past the budget are
//! dropped). This table keeps every connected peer's limits, and the propagation,
//! retrieval and sync code size and pace what they send to a peer from it.
//!
//! A peer that advertised nothing (zeros, or an older build) gets our own configuration
//! as the assumption, which is how the node behaved before limits were exchanged.

use std::collections::HashMap;
use std::sync::Arc;

use gossip_wire::{PeerId, PeerLimits};
use parking_lot::RwLock;

/// Multiplier of the base ingest / egress budgets for a peer of the given trust.
/// Mirrors the retrieval thread's scaling exactly, so the advertised budget is the
/// enforced one.
pub fn ingest_scale(trust: f64) -> f64 {
    0.25 + 0.75 * trust.clamp(0.0, 1.0)
}

/// Whether an unsolicited blob is tolerated: the allowance the retrieval thread grants
/// before counting flooding, per minute per peer.
pub const UNSOLICITED_BLOBS_PER_MIN: u32 = 8;

/// Limits advertised by connected peers. Cheap to clone: it is a shared handle.
#[derive(Clone, Default)]
pub struct PeerLimitsTable {
    inner: Arc<RwLock<HashMap<PeerId, PeerLimits>>>,
}

impl PeerLimitsTable {
    /// Empty table.
    pub fn new() -> Self {
        Self::default()
    }

    /// Records what `peer` accepts from us (after its verdict admitted us).
    pub fn set(&self, peer: PeerId, limits: PeerLimits) {
        self.inner.write().insert(peer, limits);
    }

    /// Forgets a peer (it disconnected).
    pub fn remove(&self, peer: &PeerId) {
        self.inner.write().remove(peer);
    }

    /// What `peer` advertised, if anything.
    pub fn get(&self, peer: &PeerId) -> Option<PeerLimits> {
        self.inner.read().get(peer).copied()
    }

    /// Most ids we may put in one list message to `peer`: the smaller of our own cap and
    /// the peer's, ignoring an unknown (zero) one.
    pub fn ids_cap(&self, peer: &PeerId, ours: usize) -> usize {
        narrow(ours, self.get(peer).map(|l| l.max_ids_per_message))
    }

    /// `(blobs, bytes)` caps of one `Blobs` message to `peer`.
    pub fn blobs_cap(&self, peer: &PeerId, ours_blobs: usize, ours_bytes: usize) -> (usize, usize) {
        let theirs = self.get(peer);
        (
            narrow(ours_blobs, theirs.map(|l| l.max_blobs_per_message)),
            narrow(ours_bytes, theirs.map(|l| l.max_blobs_message_bytes)),
        )
    }

    /// Largest single frame `peer` reads, when it said.
    pub fn frame_cap(&self, peer: &PeerId) -> Option<usize> {
        self.get(peer)
            .map(|l| l.max_message_size as usize)
            .filter(|v| *v > 0)
    }

    /// The `SyncRequest.max` we may send `peer`.
    pub fn sync_page(&self, peer: &PeerId, ours: usize) -> usize {
        narrow(ours, self.get(peer).map(|l| l.max_sync_page))
    }

    /// Sync requests per minute `peer` answers for us, or `floor` when it did not say.
    /// The floor is what any honest peer grants an untrusted requester.
    pub fn sync_pace(&self, peer: &PeerId, floor: f64) -> f64 {
        match self.get(peer).map(|l| l.sync_requests_per_min) {
            Some(v) if v > 0 => f64::from(v),
            _ => floor,
        }
    }
}

/// `min(ours, theirs)`, treating an absent or zero `theirs` as unknown.
fn narrow(ours: usize, theirs: Option<u32>) -> usize {
    match theirs {
        Some(v) if v > 0 => ours.min(v as usize).max(1),
        _ => ours.max(1),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use massa_signature::KeyPair;

    fn peer() -> PeerId {
        PeerId::from_public_key(KeyPair::generate(0).unwrap().get_public_key())
    }

    #[test]
    fn caps_are_the_smaller_side_and_unknown_means_ours() {
        let table = PeerLimitsTable::new();
        let p = peer();
        // nothing advertised: our own caps apply
        assert_eq!(table.ids_cap(&p, 5000), 5000);
        assert_eq!(table.blobs_cap(&p, 64, 2_000_000), (64, 2_000_000));
        assert_eq!(table.sync_page(&p, 5000), 5000);
        assert_eq!(table.sync_pace(&p, 1.5), 1.5);
        assert_eq!(table.frame_cap(&p), None);

        table.set(
            p,
            PeerLimits {
                max_message_size: 1_000_000,
                max_ids_per_message: 100,
                max_blobs_per_message: 8,
                max_blobs_message_bytes: 500_000,
                max_sync_page: 250,
                ingest_blobs_per_min: 10,
                ingest_bytes_per_min: 10,
                unsolicited_blobs_per_min: 8,
                sync_requests_per_min: 6,
            },
        );
        assert_eq!(table.ids_cap(&p, 5000), 100, "the peer is stricter");
        assert_eq!(table.ids_cap(&p, 50), 50, "we are stricter");
        assert_eq!(table.blobs_cap(&p, 64, 2_000_000), (8, 500_000));
        assert_eq!(table.sync_page(&p, 5000), 250);
        assert_eq!(table.sync_pace(&p, 1.5), 6.0);
        assert_eq!(table.frame_cap(&p), Some(1_000_000));

        // zeros mean unknown, not "nothing allowed"
        table.set(p, PeerLimits::default());
        assert_eq!(table.ids_cap(&p, 5000), 5000);
        assert_eq!(table.sync_pace(&p, 1.5), 1.5);

        table.remove(&p);
        assert!(table.get(&p).is_none());
    }
}
