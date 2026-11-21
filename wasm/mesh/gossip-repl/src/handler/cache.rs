// Vendored from massa-protocol-worker/src/handlers/operation_handler/cache.rs and adapted for Gossip.
// Blob ids are full 32-byte ids (no prefix map); `expired_recently` is new.

use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
    time::{Duration, Instant},
};

/// How long a blob refused by the store is not asked for again.
pub const REJECTED_TTL: Duration = Duration::from_secs(60);

use gossip_wire::{BlobId, PeerId};
use parking_lot::RwLock;
use schnellru::{ByLength, LruMap};

/// Cache for blobs
pub struct BlobCache {
    /// List of blobs we checked recently
    pub checked_blobs: LruMap<BlobId, ()>,
    /// List of blobs known by peers
    pub blobs_known_by_peer: HashMap<PeerId, LruMap<BlobId, ()>>,
    /// Blobs we recently saw expired (or out of the time window): never ask for them
    pub expired_recently: LruMap<BlobId, ()>,
    /// Blobs the store refused recently (index rule, pressure...), with the refusal
    /// instant: not asked again for `rejected_ttl`, but acceptable afterwards
    pub rejected_recently: LruMap<BlobId, Instant>,
    /// How long `rejected_recently` entries silence an id
    pub rejected_ttl: Duration,
    /// Maximum number of blobs known by a peer
    pub max_known_blobs_by_peer: u32,
}

impl BlobCache {
    /// Create a new BlobCache
    pub fn new(max_known_blobs: u32, max_known_blobs_by_peer: u32) -> Self {
        Self {
            checked_blobs: LruMap::new(ByLength::new(max_known_blobs.max(1))),
            blobs_known_by_peer: HashMap::new(),
            expired_recently: LruMap::new(ByLength::new(max_known_blobs.max(1))),
            rejected_recently: LruMap::new(ByLength::new(max_known_blobs.max(1))),
            rejected_ttl: REJECTED_TTL,
            max_known_blobs_by_peer: max_known_blobs_by_peer.max(1),
        }
    }

    /// Mark a list of blob ids as known by a peer
    pub fn insert_peer_known_blobs(&mut self, peer_id: &PeerId, ids: &[BlobId]) {
        let known = self
            .blobs_known_by_peer
            .entry(*peer_id)
            .or_insert_with(|| LruMap::new(ByLength::new(self.max_known_blobs_by_peer)));
        for id in ids {
            known.insert(*id, ());
        }
    }

    /// Mark a blob id as checked by us
    pub fn insert_checked_blob(&mut self, id: BlobId) {
        self.checked_blobs.insert(id, ());
    }

    /// Mark a blob id as expired / out of window
    pub fn insert_expired(&mut self, id: BlobId) {
        self.expired_recently.insert(id, ());
    }

    /// Mark a blob id as refused by the store just now
    pub fn insert_rejected(&mut self, id: BlobId) {
        self.rejected_recently.insert(id, Instant::now());
    }

    /// Whether we already hold, checked, discarded or recently saw refused that id.
    pub fn is_known(&self, id: &BlobId) -> bool {
        self.checked_blobs.peek(id).is_some()
            || self.expired_recently.peek(id).is_some()
            || self
                .rejected_recently
                .peek(id)
                .map(|at| at.elapsed() < self.rejected_ttl)
                .unwrap_or(false)
    }

    /// Update caches to remove all data from disconnected peers
    pub fn update_cache(&mut self, peers_connected: &HashSet<PeerId>) {
        // Remove disconnected peers from cache
        self.blobs_known_by_peer
            .retain(|peer_id, _| peers_connected.contains(peer_id));

        // Add new connected peers to cache
        for peer_id in peers_connected {
            match self.blobs_known_by_peer.entry(*peer_id) {
                std::collections::hash_map::Entry::Occupied(_) => {}
                std::collections::hash_map::Entry::Vacant(entry) => {
                    entry.insert(LruMap::new(ByLength::new(self.max_known_blobs_by_peer)));
                }
            }
        }
    }
}

pub type SharedBlobCache = Arc<RwLock<BlobCache>>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn known_sets_and_peer_lifecycle() {
        let mut cache = BlobCache::new(10, 2);
        let a = BlobId([1; 32]);
        let b = BlobId([2; 32]);
        let c = BlobId([3; 32]);
        cache.insert_checked_blob(a);
        cache.insert_expired(b);
        assert!(cache.is_known(&a));
        assert!(cache.is_known(&b));
        assert!(!cache.is_known(&c));
        // a rejection silences the id only for the TTL
        cache.rejected_ttl = Duration::from_millis(30);
        cache.insert_rejected(c);
        assert!(cache.is_known(&c));
        std::thread::sleep(Duration::from_millis(40));
        assert!(!cache.is_known(&c));

        let p = PeerId::generate();
        let q = PeerId::generate();
        cache.insert_peer_known_blobs(&p, &[a, b, c]);
        // per-peer LRU bounded to 2
        assert_eq!(cache.blobs_known_by_peer[&p].len(), 2);
        assert!(cache.blobs_known_by_peer[&p].peek(&a).is_none());
        cache.update_cache(&HashSet::from([q]));
        assert!(!cache.blobs_known_by_peer.contains_key(&p));
        assert!(cache.blobs_known_by_peer.contains_key(&q));
    }
}
