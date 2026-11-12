// Vendored from massa-protocol-worker/src/handlers/operation_handler/propagation.rs and adapted for Gossip.
// Peers are announced to in descending trust order, with a per-round id cap scaled by
// trust; the blob storage reference tracking (`op_storage`) is gone since blobs live
// in the store.

use std::collections::{HashSet, VecDeque};
use std::sync::Arc;
use std::{mem, thread::JoinHandle};

use crossbeam::channel::{Receiver, RecvTimeoutError};
use gossip_wire::{BlobId, BlobMessage, BlobMessageSerializer, MessagesSerializer, PeerId};
use tracing::{debug, info, trace, warn};

use std::collections::HashMap;

use crate::config::PropagationConfig;
use crate::limits::PeerLimitsTable;
use crate::link::Links;
use crate::mesh::MeshParts;
use crate::store::{BlobInfo, BlobStore};
use crate::trust::PeerTrust;
use gossip_wire::{Scope, UnixMillis};

use super::{cache::SharedBlobCache, commands_propagation::PropagationCommand};

// gossip-net blob propagation
const THREAD_NAME: &str = "gn-blob-propag";
static_assertions::const_assert!(THREAD_NAME.len() < 16);

/// Lookups shared by one announcement round.
struct Round {
    memo: HashMap<BlobId, Option<BlobInfo>>,
    bridges: Vec<PeerId>,
    now: UnixMillis,
}

struct PropagationThread {
    internal_receiver: Receiver<PropagationCommand>,
    active_connections: Box<dyn Links>,
    // times at which previous blobs were announced
    stored_for_propagation: VecDeque<(std::time::Instant, HashSet<BlobId>)>,
    // ids of the blobs held in `stored_for_propagation`, maintained incrementally
    // so pruning does not need to scan the whole queue on every call. The queue batches
    // are disjoint, so this is the number of blobs the cache size is capped on.
    stored_blobs: HashSet<BlobId>,
    next_batch: HashSet<BlobId>,
    config: PropagationConfig,
    cache: SharedBlobCache,
    trust: Arc<dyn PeerTrust>,
    /// What each peer accepts in one message: announces never exceed it.
    limits: PeerLimitsTable,
    blob_message_serializer: MessagesSerializer,
    /// Scope lookups, for the per-link filter (only used when the mesh is on).
    store: Arc<dyn BlobStore>,
    mesh: MeshParts,
}

impl PropagationThread {
    /// Time at which the next announcement should happen if the batch is not full before that.
    fn next_batch_deadline(&self) -> std::time::Instant {
        std::time::Instant::now()
            .checked_add(self.config.announcement_interval())
            .expect("Can't init interval blob propagation")
    }

    fn run(&mut self) {
        let mut batch_deadline = self.next_batch_deadline();
        loop {
            match self.internal_receiver.recv_deadline(batch_deadline) {
                Ok(internal_message) => {
                    match internal_message {
                        PropagationCommand::PropagateBlobs(ids) => {
                            // Note blobs as checked.
                            {
                                let mut cache_write = self.cache.write();
                                for id in ids.iter().copied() {
                                    cache_write.insert_checked_blob(id);
                                }
                            }

                            // a blob can be propagated again while it is still
                            // queued: only queue the ones that are not already tracked, so
                            // that duplicates do not consume the cache budget twice
                            let newly_tracked: HashSet<BlobId> = ids
                                .iter()
                                .filter(|id| self.stored_blobs.insert(**id))
                                .copied()
                                .collect();
                            if !newly_tracked.is_empty() {
                                // add to propagation storage
                                self.stored_for_propagation
                                    .push_back((std::time::Instant::now(), newly_tracked));
                            }
                            self.prune_propagation_storage();

                            for id in ids {
                                self.next_batch.insert(id);
                                if self.next_batch.len() >= self.config.announcement_buffer_capacity
                                {
                                    self.announce_blobs();
                                    batch_deadline = self.next_batch_deadline();
                                }
                            }

                            // `recv_deadline` returns immediately whenever a message is ready,
                            // so a continuously non-empty channel would never let the timeout
                            // branch below fire. Enforce the deadline here as well to make sure
                            // announcements keep happening under a constant flow of commands.
                            if std::time::Instant::now() >= batch_deadline {
                                self.announce_blobs();
                                batch_deadline = self.next_batch_deadline();
                            }
                        }
                        PropagationCommand::PropagateWanted(ids) => {
                            self.announce_wanted(ids);
                        }
                        PropagationCommand::Stop => {
                            info!("Stop blob propagation thread");
                            return;
                        }
                    }
                }
                Err(RecvTimeoutError::Timeout) => {
                    self.announce_blobs();
                    batch_deadline = self.next_batch_deadline();
                }
                Err(RecvTimeoutError::Disconnected) => {
                    return;
                }
            }
        }
    }

    /// Prune the list of blobs kept for propagation.
    fn prune_propagation_storage(&mut self) {
        let _removed = Self::prune_stored_for_propagation(
            &mut self.stored_for_propagation,
            &mut self.stored_blobs,
            self.config.max_blob_propagation_time(),
            self.config.max_blobs_kept_for_propagation,
        );
    }

    /// Remove expired and excess blob batches from the propagation queue,
    /// keeping `stored_blobs` in sync with the blobs queued for propagation.
    ///
    /// `stored_blobs` is maintained incrementally (updated here on removal and by the
    /// caller on insertion) so that pruning costs O(number of removed blobs)
    /// instead of scanning the whole queue on every call. This prevents an attacker
    /// from making each propagation command increasingly expensive by flooding the
    /// queue with many tiny batches.
    ///
    /// Because the caller never queues a blob that is already tracked, the queue
    /// batches are disjoint: the cap is enforced on distinct blobs and each removed
    /// id is released exactly once.
    ///
    /// Returns the set of blob ids that were removed from the queue.
    fn prune_stored_for_propagation(
        stored_for_propagation: &mut VecDeque<(std::time::Instant, HashSet<BlobId>)>,
        stored_blobs: &mut HashSet<BlobId>,
        max_blob_propagation_time: std::time::Duration,
        max_blobs_kept_for_propagation: usize,
    ) -> HashSet<BlobId> {
        let mut removed = HashSet::default();

        // remove expired
        while let Some((t, _)) = stored_for_propagation.front() {
            if t.elapsed() > max_blob_propagation_time {
                let (_, ids) = stored_for_propagation
                    .pop_front()
                    .expect("there should be at least one element, checked above");
                for id in ids {
                    stored_blobs.remove(&id);
                    removed.insert(id);
                }
            } else {
                break;
            }
        }

        // Cap cache size
        // Note that we directly remove batches of blobs, not individual blobs
        // to favor simplicity and performance over precision.
        while stored_blobs.len() > max_blobs_kept_for_propagation {
            if let Some((_t, ids)) = stored_for_propagation.pop_front() {
                for id in ids {
                    stored_blobs.remove(&id);
                    removed.insert(id);
                }
            } else {
                break;
            }
        }

        removed
    }

    /// Ids announced to a peer of the given trust in one round.
    fn per_peer_cap(max_ids_per_message: usize, trust: f64) -> usize {
        ((max_ids_per_message as f64) * (0.5 + 0.5 * trust.clamp(0.0, 1.0))).floor() as usize
    }

    /// The link filter for `peer_id`, `None` when the mesh is off.
    fn filter_for(&self, peer_id: &PeerId) -> Option<Scope> {
        if !self.mesh.config.enabled {
            return None;
        }
        let mesh_link = self
            .active_connections
            .link_info(peer_id)
            .is_some_and(|info| info.kind.is_mesh());
        self.mesh.link_filter(mesh_link)
    }

    /// Whether blob `id` may be offered to `peer` on a link with `filter`, with blob
    /// lookups memoised for one round.
    fn allowed(&self, round: &mut Round, filter: Scope, id: &BlobId, peer: &PeerId) -> bool {
        let info = round.memo.entry(*id).or_insert_with(|| {
            self.store.info(id).or_else(|| {
                self.store
                    .scope_of(id)
                    .map(|(scope, size)| BlobInfo::from_scope(scope, size))
            })
        });
        info.as_ref().is_some_and(|info| {
            self.mesh
                .offers(filter, info, peer, &round.bridges, round.now)
        })
    }

    fn round(&self) -> Round {
        let now = self.mesh.clock.now();
        Round {
            memo: HashMap::new(),
            bridges: if self.mesh.config.enabled {
                self.mesh.bridge_direction(now)
            } else {
                Vec::new()
            },
            now,
        }
    }

    /// Announces wanted blobs right away, high priority, to every mesh link that does
    /// not know them yet.
    fn announce_wanted(&mut self, ids: Vec<BlobId>) {
        if ids.is_empty() || !self.mesh.config.enabled {
            return;
        }
        let peers = self.active_connections.get_peer_ids_connected();
        let mut round = self.round();
        let mut cache_write = self.cache.write();
        cache_write.update_cache(&peers);
        for id in &ids {
            cache_write.insert_checked_blob(*id);
        }
        for peer_id in peers {
            if self.filter_for(&peer_id) != Some(Scope::MESH) {
                continue;
            }
            let Some(known) = cache_write.blobs_known_by_peer.get_mut(&peer_id) else {
                continue;
            };
            let new_ids: Vec<BlobId> = ids
                .iter()
                .filter(|id| known.peek(*id).is_none())
                .copied()
                .collect();
            let new_ids: Vec<BlobId> = new_ids
                .into_iter()
                .filter(|id| self.allowed(&mut round, Scope::MESH, id, &peer_id))
                .collect();
            if new_ids.is_empty() {
                continue;
            }
            let chunk_size = self
                .limits
                .ids_cap(&peer_id, self.config.max_ids_per_message);
            for sub_list in new_ids.chunks(chunk_size) {
                if self
                    .active_connections
                    .send_to_peer(
                        &peer_id,
                        &self.blob_message_serializer,
                        BlobMessage::Announce(sub_list.to_vec()).into(),
                        true,
                    )
                    .is_err()
                {
                    break;
                }
                for id in sub_list {
                    known.insert(*id, ());
                }
            }
        }
        // the normal rounds keep them too, for links that come up later
        drop(cache_write);
        for id in ids {
            if self.stored_blobs.insert(id) {
                self.stored_for_propagation
                    .push_back((std::time::Instant::now(), HashSet::from([id])));
            }
            self.next_batch.insert(id);
        }
    }

    fn announce_blobs(&mut self) {
        // Quit if empty  to avoid iterating on nodes
        if self.next_batch.is_empty() {
            return;
        }
        let blob_ids = mem::take(&mut self.next_batch);
        trace!(count = blob_ids.len(), "announce_blobs.begin");
        // Blobs whose announcement could not be delivered to at least one peer, or that
        // exceeded a peer's per-round cap. They are put back into the next batch so that
        // a later round retries them.
        let mut to_retry: HashSet<BlobId> = HashSet::default();
        let mut round = self.round();
        {
            let mut cache_write = self.cache.write();
            let peers_connected = self.active_connections.get_peer_ids_connected();
            cache_write.update_cache(&peers_connected);

            // Propagate to peers, most trusted first
            let mut peers: Vec<(PeerId, f64)> = cache_write
                .blobs_known_by_peer
                .keys()
                .map(|peer_id| (*peer_id, self.trust.trust_of(peer_id)))
                .collect();
            peers.sort_by(|a, b| {
                b.1.partial_cmp(&a.1)
                    .unwrap_or(std::cmp::Ordering::Equal)
                    .then_with(|| a.0.cmp(&b.0))
            });
            'peer_loop: for (peer_id, trust) in peers {
                // an id list longer than the peer's cap is a protocol violation on its
                // side: size the chunks to the stricter of the two configurations
                let chunk_size = self
                    .limits
                    .ids_cap(&peer_id, self.config.max_ids_per_message);
                let known = cache_write
                    .blobs_known_by_peer
                    .get_mut(&peer_id)
                    .expect("peer inserted by update_cache");
                let mut new_ids: Vec<BlobId> = blob_ids
                    .iter()
                    .filter(|id| known.peek(*id).is_none())
                    .copied()
                    .collect();
                if let Some(filter) = self.filter_for(&peer_id) {
                    new_ids.retain(|id| self.allowed(&mut round, filter, id, &peer_id));
                }
                if new_ids.is_empty() {
                    continue;
                }
                let cap = Self::per_peer_cap(chunk_size, trust).max(1);
                if new_ids.len() > cap {
                    to_retry.extend(new_ids.drain(cap..));
                }
                debug!(
                    "Send blobs announcement of len {} to {}",
                    new_ids.len(),
                    peer_id
                );
                for (chunk_index, sub_list) in new_ids.chunks(chunk_size).enumerate() {
                    if let Err(err) = self.active_connections.send_to_peer(
                        &peer_id,
                        &self.blob_message_serializer,
                        BlobMessage::Announce(sub_list.to_vec()).into(),
                        false,
                    ) {
                        warn!("Failed to send Announce message to peer: {}", err);
                        // Nothing was delivered from this chunk on: the peer's cache is left
                        // untouched for those blobs, and they are retried later.
                        to_retry.extend(
                            new_ids[chunk_index.saturating_mul(chunk_size)..]
                                .iter()
                                .copied(),
                        );
                        // this peer is disconnected or congested, try with the next one
                        // (a disconnected peer's cache is removed by the next
                        // cache_write.update_cache call)
                        continue 'peer_loop;
                    }
                    // sent successfully: only now mark the peer as knowing those blobs
                    for id in sub_list {
                        known.insert(*id, ());
                    }
                }
            }
        }

        // Requeue the blobs that still need to be announced. Only the ones we still
        // hold for propagation are worth retrying, and the batch is kept bounded so that a
        // permanently congested peer cannot make it grow without limit.
        if !to_retry.is_empty() {
            let retry: Vec<BlobId> = to_retry
                .into_iter()
                .filter(|id| self.stored_blobs.contains(id))
                .take(
                    self.config
                        .announcement_buffer_capacity
                        .saturating_sub(self.next_batch.len()),
                )
                .collect();
            self.next_batch.extend(retry);
        }
    }
}

#[allow(clippy::too_many_arguments)]
pub fn start_propagation_thread(
    internal_receiver: Receiver<PropagationCommand>,
    active_connections: Box<dyn Links>,
    config: PropagationConfig,
    cache: SharedBlobCache,
    trust: Arc<dyn PeerTrust>,
    limits: PeerLimitsTable,
    store: Arc<dyn BlobStore>,
    mesh: MeshParts,
) -> JoinHandle<()> {
    std::thread::Builder::new()
        .name(THREAD_NAME.to_string())
        .spawn(move || {
            let mut propagation_thread = PropagationThread {
                internal_receiver,
                active_connections,
                stored_for_propagation: VecDeque::with_capacity(
                    config.max_blobs_kept_for_propagation.min(1 << 16),
                ),
                stored_blobs: HashSet::with_capacity(
                    config.max_blobs_kept_for_propagation.min(1 << 16),
                ),
                next_batch: HashSet::with_capacity(
                    config.announcement_buffer_capacity.saturating_add(1),
                ),
                config,
                cache,
                trust,
                limits,
                blob_message_serializer: MessagesSerializer::new()
                    .with_blob_message_serializer(BlobMessageSerializer::new()),
                store,
                mesh,
            };
            propagation_thread.run();
        })
        .expect("OS failed to start blob propagation thread")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::ReplError;
    use crate::link::MockLinks;
    use crate::trust::FixedTrust;
    use crossbeam::channel::unbounded;
    use gossip_wire::Message;
    use massa_signature::KeyPair;
    use parking_lot::RwLock;
    use std::collections::HashSet;
    use std::sync::Arc;
    use std::time::{Duration, Instant};

    use super::super::cache::BlobCache;

    fn blob_id(i: u64) -> BlobId {
        BlobId(*massa_hash::Hash::compute_from(&i.to_be_bytes()).to_bytes())
    }

    /// Push a batch of blobs at the given time, mirroring the accounting done by
    /// the propagation thread on `PropagateBlobs`: only the blobs that are not
    /// already tracked are queued, and an empty batch is not pushed at all.
    fn push_batch_at(
        queue: &mut VecDeque<(Instant, HashSet<BlobId>)>,
        stored_blobs: &mut HashSet<BlobId>,
        time: Instant,
        ids: impl IntoIterator<Item = BlobId>,
    ) {
        let newly_tracked: HashSet<BlobId> = ids
            .into_iter()
            .filter(|id| stored_blobs.insert(*id))
            .collect();
        if !newly_tracked.is_empty() {
            queue.push_back((time, newly_tracked));
        }
    }

    fn push_batch(
        queue: &mut VecDeque<(Instant, HashSet<BlobId>)>,
        stored_blobs: &mut HashSet<BlobId>,
        ids: impl IntoIterator<Item = BlobId>,
    ) {
        push_batch_at(queue, stored_blobs, Instant::now(), ids);
    }

    /// The ground-truth set of queued blobs, computed by scanning the whole queue
    /// (the O(n) operation the incrementally maintained set is meant to replace).
    fn real_stored_blobs(queue: &VecDeque<(Instant, HashSet<BlobId>)>) -> HashSet<BlobId> {
        queue
            .iter()
            .flat_map(|(_, ids)| ids.iter().copied())
            .collect()
    }

    /// A flood of tiny (single-blob) batches must stay bounded by the cap, and the
    /// tracked set must stay exact so pruning never falls back to scanning.
    #[test]
    fn running_count_stays_exact_and_caps_total_blobs() {
        let mut queue = VecDeque::new();
        let mut stored_blobs = HashSet::default();
        let max_blobs = 100;
        let never_expires = Duration::from_secs(3600);

        for i in 0..1000u64 {
            push_batch(&mut queue, &mut stored_blobs, [blob_id(i)]);
            let removed = PropagationThread::prune_stored_for_propagation(
                &mut queue,
                &mut stored_blobs,
                never_expires,
                max_blobs,
            );

            // the tracked set must always match the ground truth
            assert_eq!(stored_blobs, real_stored_blobs(&queue));
            // once the cap is reached, each new 1-blob batch evicts exactly one old batch
            if i >= max_blobs as u64 {
                assert_eq!(removed.len(), 1);
            }
        }

        // stored blobs (== queue length for distinct 1-blob batches) stays bounded by the cap
        assert_eq!(stored_blobs.len(), max_blobs);
        assert_eq!(queue.len(), max_blobs);
    }

    /// Expired batches are dropped and the tracked set is updated accordingly.
    #[test]
    fn prune_removes_expired_batches_and_updates_count() {
        let mut queue = VecDeque::new();
        let mut stored_blobs = HashSet::default();

        // a batch inserted "in the past", already older than the propagation time
        push_batch_at(
            &mut queue,
            &mut stored_blobs,
            Instant::now() - Duration::from_secs(60),
            [blob_id(1), blob_id(2)],
        );

        // a fresh batch that must be kept
        push_batch(&mut queue, &mut stored_blobs, [blob_id(3)]);

        let removed = PropagationThread::prune_stored_for_propagation(
            &mut queue,
            &mut stored_blobs,
            Duration::from_secs(30),
            1_000,
        );

        assert_eq!(removed.len(), 2);
        assert!(removed.contains(&blob_id(1)));
        assert!(removed.contains(&blob_id(2)));
        assert_eq!(queue.len(), 1);
        assert_eq!(stored_blobs, real_stored_blobs(&queue));
        assert!(stored_blobs.contains(&blob_id(3)));
    }

    /// Propagating a blob again while it is still queued must not queue it twice:
    /// it is released exactly once, when its batch is pruned.
    #[test]
    fn repropagated_blob_is_only_queued_once() {
        let mut queue = VecDeque::new();
        let mut stored_blobs = HashSet::default();
        let never_expires = Duration::from_secs(3600);

        push_batch(&mut queue, &mut stored_blobs, [blob_id(1)]);
        for _ in 0..10 {
            push_batch(&mut queue, &mut stored_blobs, [blob_id(1)]);
        }

        // the repropagations added no batch and no extra tracking
        assert_eq!(queue.len(), 1);
        assert_eq!(stored_blobs.len(), 1);

        // the blob is released exactly once, when its only batch is pruned
        let removed = PropagationThread::prune_stored_for_propagation(
            &mut queue,
            &mut stored_blobs,
            never_expires,
            0,
        );
        assert_eq!(removed, [blob_id(1)].into_iter().collect::<HashSet<_>>());
        assert!(queue.is_empty());
        assert!(stored_blobs.is_empty());
    }

    /// Batches sharing blobs, pruned in a single pass, release each blob exactly once
    /// and leave no stale entry behind.
    #[test]
    fn overlapping_batches_pruned_in_one_pass_release_blobs_once() {
        let mut queue = VecDeque::new();
        let mut stored_blobs = HashSet::default();
        let past = Instant::now() - Duration::from_secs(60);

        push_batch_at(
            &mut queue,
            &mut stored_blobs,
            past,
            [blob_id(1), blob_id(2)],
        );
        push_batch_at(
            &mut queue,
            &mut stored_blobs,
            past,
            [blob_id(2), blob_id(3)],
        );

        // blob 2 was only queued by the first batch
        assert_eq!(queue.len(), 2);
        assert_eq!(queue[1].1, [blob_id(3)].into_iter().collect::<HashSet<_>>());

        let removed = PropagationThread::prune_stored_for_propagation(
            &mut queue,
            &mut stored_blobs,
            Duration::from_secs(30),
            1_000,
        );

        assert_eq!(
            removed,
            [blob_id(1), blob_id(2), blob_id(3)]
                .into_iter()
                .collect::<HashSet<_>>()
        );
        assert!(queue.is_empty());
        assert!(stored_blobs.is_empty());
    }

    /// Repeatedly propagating the same blob must not consume the propagation budget
    /// several times and evict unrelated blobs.
    #[test]
    fn duplicate_blobs_do_not_inflate_cache_pressure() {
        let mut queue = VecDeque::new();
        let mut stored_blobs = HashSet::default();
        let max_blobs = 3;
        let never_expires = Duration::from_secs(3600);

        // one honest blob, then many resubmissions of the same other blob
        push_batch(&mut queue, &mut stored_blobs, [blob_id(0)]);
        for _ in 0..100 {
            push_batch(&mut queue, &mut stored_blobs, [blob_id(1)]);
            let removed = PropagationThread::prune_stored_for_propagation(
                &mut queue,
                &mut stored_blobs,
                never_expires,
                max_blobs,
            );
            // only 2 distinct blobs are retained: nothing should ever be evicted
            assert!(removed.is_empty());
            assert_eq!(stored_blobs, real_stored_blobs(&queue));
        }

        // the honest blob is still retained despite the flood of duplicates
        assert_eq!(queue.len(), 2);
        assert_eq!(stored_blobs.len(), 2);
        assert!(stored_blobs.contains(&blob_id(0)));
    }

    /// Build a propagation thread wired to `active_connections`, holding `ids` for
    /// propagation and with them queued in the next announcement batch.
    fn propagation_thread_with_batch(
        active_connections: MockLinks,
        ids: &[BlobId],
        trust: Arc<dyn PeerTrust>,
        config: PropagationConfig,
    ) -> PropagationThread {
        let (_sender, receiver) = unbounded::<PropagationCommand>();
        std::mem::forget(_sender);
        PropagationThread {
            internal_receiver: receiver,
            active_connections: Box::new(active_connections),
            stored_for_propagation: VecDeque::from([(
                Instant::now(),
                ids.iter().copied().collect(),
            )]),
            stored_blobs: ids.iter().copied().collect(),
            limits: PeerLimitsTable::default(),
            next_batch: ids.iter().copied().collect(),
            config,
            cache: Arc::new(RwLock::new(BlobCache::new(1000, 1000))),
            trust,
            blob_message_serializer: MessagesSerializer::new()
                .with_blob_message_serializer(BlobMessageSerializer::new()),
            store: Arc::new(crate::store::MemBlobStore::default()),
            mesh: MeshParts::disabled(),
        }
    }

    fn new_peer_id() -> PeerId {
        PeerId::from_public_key(KeyPair::generate(0).unwrap().get_public_key())
    }

    /// A failed announcement must not mark the peer as knowing the blobs, and the
    /// unsent blobs must be requeued so a later round retries them. Otherwise the
    /// filtering done on the next round would suppress them forever for that peer.
    #[test]
    fn failed_announcement_is_not_cached_and_is_requeued() {
        let peer_id = new_peer_id();
        let ids: Vec<BlobId> = (0..3).map(blob_id).collect();
        let id_set: HashSet<BlobId> = ids.iter().copied().collect();

        let mut active_connections = MockLinks::new();
        active_connections
            .expect_get_peer_ids_connected()
            .returning(move || HashSet::from_iter([peer_id]));
        active_connections
            .expect_send_to_peer()
            .returning(|_, _, _, _| Err(ReplError::SendError("congested".to_string())));

        let mut propagation_thread = propagation_thread_with_batch(
            active_connections,
            &ids,
            Arc::new(FixedTrust::new(1.0)),
            PropagationConfig::default(),
        );
        propagation_thread.announce_blobs();

        // the peer knows none of the blobs, so they will be announced again
        let cache_read = propagation_thread.cache.read();
        let known_by_peer = cache_read.blobs_known_by_peer.get(&peer_id).unwrap();
        for id in &id_set {
            assert!(known_by_peer.peek(id).is_none());
        }
        drop(cache_read);

        // the blobs are queued again for the next announcement round
        assert_eq!(propagation_thread.next_batch, id_set);
    }

    /// On a successful announcement the peer is marked as knowing the blobs and
    /// nothing is requeued.
    #[test]
    fn successful_announcement_is_cached_and_not_requeued() {
        let peer_id = new_peer_id();
        let ids: Vec<BlobId> = (0..3).map(blob_id).collect();
        let id_set: HashSet<BlobId> = ids.iter().copied().collect();

        let mut active_connections = MockLinks::new();
        active_connections
            .expect_get_peer_ids_connected()
            .returning(move || HashSet::from_iter([peer_id]));
        active_connections
            .expect_send_to_peer()
            .returning(|_, _, _, _| Ok(()));

        let mut propagation_thread = propagation_thread_with_batch(
            active_connections,
            &ids,
            Arc::new(FixedTrust::new(1.0)),
            PropagationConfig::default(),
        );
        propagation_thread.announce_blobs();

        let cache_read = propagation_thread.cache.read();
        let known_by_peer = cache_read.blobs_known_by_peer.get(&peer_id).unwrap();
        for id in &id_set {
            assert!(known_by_peer.peek(id).is_some());
        }
        drop(cache_read);

        assert!(propagation_thread.next_batch.is_empty());
    }

    /// A low-trust peer only gets half a message per round; the rest is requeued and
    /// the most trusted peer is served first.
    #[test]
    fn trust_caps_ids_per_round_and_orders_peers() {
        let low = new_peer_id();
        let high = new_peer_id();
        let ids: Vec<BlobId> = (0..10).map(blob_id).collect();
        let sent: Arc<RwLock<Vec<(PeerId, usize)>>> = Arc::new(RwLock::new(Vec::new()));
        let sent_clone = sent.clone();
        let mut active_connections = MockLinks::new();
        active_connections
            .expect_get_peer_ids_connected()
            .returning(move || HashSet::from_iter([low, high]));
        active_connections
            .expect_send_to_peer()
            .returning(move |peer_id, _, message, _| {
                if let Message::Blob(BlobMessage::Announce(ids)) = message {
                    sent_clone.write().push((*peer_id, ids.len()));
                }
                Ok(())
            });
        let trust = FixedTrust::new(0.0);
        trust.set(high, 1.0);
        let config = PropagationConfig {
            max_ids_per_message: 10,
            ..PropagationConfig::default()
        };
        let mut propagation_thread =
            propagation_thread_with_batch(active_connections, &ids, Arc::new(trust), config);
        propagation_thread.announce_blobs();
        let sent = sent.read().clone();
        assert_eq!(sent, vec![(high, 10), (low, 5)]);
        assert_eq!(propagation_thread.next_batch.len(), 5);
        assert_eq!(PropagationThread::per_peer_cap(10, 0.5), 7);
        assert_eq!(PropagationThread::per_peer_cap(10, 2.0), 10);
    }
}
