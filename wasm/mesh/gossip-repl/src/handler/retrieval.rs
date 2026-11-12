// Vendored from massa-protocol-worker/src/handlers/operation_handler/retrieval.rs and adapted for Gossip.
// Adds: trust-scaled deferred asks (a proven announcer wins the first ask), per-peer
// ingest budgets, store validation + batch KV signature verification, and the
// anti-entropy sync messages (see `sync.rs`).

use std::cmp::Reverse;
use std::collections::{BinaryHeap, HashMap, HashSet, VecDeque};
use std::sync::Arc;
use std::{
    thread::JoinHandle,
    time::{Duration, Instant},
};

use crossbeam::channel::{never, tick, Receiver, Sender};
use crossbeam::select;
use gossip_trust::{trust_bucket, Misbehaviour, TrustRegistry};
use gossip_wire::gcs::{
    item_value, summarise, Gcs, GCS_MAX_ITEMS, HAVE_SUMMARY_P, WANTED_SUMMARY_P,
};
use gossip_wire::{
    BlobEnvelope, BlobId, BlobMessage, BlobMessageDeserializer, BlobMessageDeserializerArgs,
    BlobMessageSerializer, MessagesSerializer, PeerId, Scope, UnixMillis, WantedEntry,
};
use massa_serialization::{DeserializeError, Deserializer};
use schnellru::{ByLength, LruMap};
use tracing::{debug, info, trace, warn};

use crate::limits::PeerLimitsTable;
use crate::mesh::{wanted_summary_item, MeshParts};
use crate::{
    config::PropagationConfig,
    error::ReplError,
    events::NetEvent,
    events::{PeerManagementCmd, PeerMessageTuple},
    link::Links,
    sig_verifier::verify_sigs_batch,
    store::{BlobSource, BlobStore, StoreOutcome, ValidateError},
    trust::PeerTrust,
};

use super::{
    cache::SharedBlobCache,
    commands_propagation::PropagationCommand,
    commands_retrieval::RetrievalCommand,
    sync::{SyncState, RESYNC_PEERS},
};

// gossip-net blob retrieval
const THREAD_NAME: &str = "gn-blob-retriev";
/// Longest wait for the peer's `WantedSummary` before sending `Wanted` on a compact
/// link anyway.
const WANTED_SUMMARY_WAIT: Duration = Duration::from_secs(10);

/// The summaries of a compact link-up (see `docs/MESH.md`, "Compact link-up").
struct LinkUp {
    /// Hash key of the link.
    key: [u8; 32],
    /// When the link came up.
    since: Instant,
    have_received: bool,
    wanted_received: bool,
}
static_assertions::const_assert!(THREAD_NAME.len() < 16);

/// Structure containing a Batch of `blob_ids` we would like to ask
/// to a `peer_id` later.
pub struct BlobBatchItem {
    /// instant at which the deferred ask is due
    pub instant: Instant,
    /// node id
    pub peer_id: PeerId,
    /// blob ids
    pub ids: Vec<BlobId>,
}

/// State of a peer with respect to an announced blob.
#[derive(Clone, Copy, Debug)]
enum PeerAskState {
    /// an `Ask` was sent to that peer at that instant
    Asked(Instant),
    /// a deferred ask for that peer is waiting in `blob_batch_buffer`
    Buffered,
}

/// Base delay before an unanswered `Ask` is retried, in `batch_proc_period`s.
const ASK_RETRY_PERIODS: u32 = 10;
/// Longest delay between two retries of an unanswered `Ask`.
const ASK_RETRY_MAX_DELAY: Duration = Duration::from_secs(30);
/// Retries of an unanswered `Ask` before giving up (a later announcement asks again).
const MAX_ASK_RETRIES: u32 = 16;
/// Unsolicited blobs (ids we did not ask that peer for) tolerated per peer per minute.
const UNSOLICITED_BLOBS_PER_MIN: f64 = 8.0;
/// Longest pause of our asks to a peer whose answers exceeded our ingest budget.
const MAX_INGEST_PAUSE: Duration = Duration::from_secs(60);

/// Delay before retry number `attempt` of an unanswered `Ask`.
fn ask_retry_delay(batch_proc_period: Duration, attempt: u32) -> Duration {
    batch_proc_period
        .saturating_mul(ASK_RETRY_PERIODS)
        .saturating_mul(1u32 << attempt.min(16))
        .min(ASK_RETRY_MAX_DELAY)
}

/// Ask state of an announced blob.
struct AskedBlob {
    /// last instant at which that blob was asked to any peer (`None`: announced only by
    /// unproven peers so far, nobody asked yet)
    last_ask: Option<Instant>,
    /// state of the peers that announced that blob.
    /// Kept as a `Vec` because it holds at most one entry per connected peer.
    peers: Vec<(PeerId, PeerAskState)>,
    /// peers an `Ask` for that blob was ever sent to: their `Blobs` are solicited
    asked_peers: Vec<PeerId>,
    /// whether a retry of an unanswered ask is queued in `ask_retries`
    retry_queued: bool,
}

impl AskedBlob {
    fn new(last_ask: Option<Instant>, asked: Option<PeerId>) -> Self {
        let mut blob = Self {
            last_ask,
            peers: Vec::new(),
            asked_peers: Vec::new(),
            retry_queued: false,
        };
        if let (Some(at), Some(peer)) = (last_ask, asked) {
            blob.set_peer_state(&peer, PeerAskState::Asked(at));
        }
        blob
    }

    fn peer_state(&self, peer_id: &PeerId) -> Option<PeerAskState> {
        self.peers
            .iter()
            .find(|(id, _)| id == peer_id)
            .map(|(_, state)| *state)
    }

    fn set_peer_state(&mut self, peer_id: &PeerId, state: PeerAskState) {
        if matches!(state, PeerAskState::Asked(_)) && !self.asked_peers.contains(peer_id) {
            self.asked_peers.push(*peer_id);
        }
        match self.peers.iter_mut().find(|(id, _)| id == peer_id) {
            Some(entry) => entry.1 = state,
            None => self.peers.push((*peer_id, state)),
        }
    }

    /// Drop the `Buffered` marker of a peer, if any, so that a new announcement
    /// of that blob by that peer is processed again.
    fn clear_buffered(&mut self, peer_id: &PeerId) {
        self.peers
            .retain(|(id, state)| id != peer_id || !matches!(state, PeerAskState::Buffered));
    }

    /// Whether we ever asked that peer for that blob.
    fn was_asked(&self, peer_id: &PeerId) -> bool {
        self.asked_peers.contains(peer_id)
    }
}

/// Multiplier of the base ingest / egress budgets for a peer of the given trust.
pub fn ingest_scale(trust: f64) -> f64 {
    crate::limits::ingest_scale(trust)
}

/// Two token buckets (bytes and items per minute) for one peer.
struct IngestBudget {
    bytes: f64,
    blobs: f64,
    last: Instant,
}

impl IngestBudget {
    fn full(cap_bytes: f64, cap_blobs: f64, now: Instant) -> Self {
        Self {
            bytes: cap_bytes,
            blobs: cap_blobs,
            last: now,
        }
    }

    fn refill(&mut self, cap_bytes: f64, cap_blobs: f64, now: Instant) {
        let elapsed_ms = now.saturating_duration_since(self.last).as_secs_f64() * 1000.0;
        self.last = now;
        self.bytes = (self.bytes + elapsed_ms * cap_bytes / 60_000.0).min(cap_bytes);
        self.blobs = (self.blobs + elapsed_ms * cap_blobs / 60_000.0).min(cap_blobs);
    }

    /// Refills then consumes; `false` (and nothing consumed) when over budget.
    fn try_consume(
        &mut self,
        bytes: f64,
        blobs: f64,
        cap_bytes: f64,
        cap_blobs: f64,
        now: Instant,
    ) -> bool {
        self.refill(cap_bytes, cap_blobs, now);
        let fits = |amount: f64, tokens: f64| amount <= 0.0 || amount <= tokens;
        if !(fits(bytes, self.bytes) && fits(blobs, self.blobs)) {
            return false;
        }
        self.bytes -= bytes;
        self.blobs -= blobs;
        true
    }

    /// Like [`Self::try_consume`], but an amount larger than the whole bucket is allowed
    /// when the bucket is full (tokens then go negative), so a single item bigger than
    /// the budget is not refused forever.
    fn try_consume_allow_full(
        &mut self,
        bytes: f64,
        blobs: f64,
        cap_bytes: f64,
        cap_blobs: f64,
        now: Instant,
    ) -> bool {
        self.refill(cap_bytes, cap_blobs, now);
        let fits =
            |amount: f64, tokens: f64, cap: f64| amount <= 0.0 || amount <= tokens || tokens >= cap;
        if !(fits(bytes, self.bytes, cap_bytes) && fits(blobs, self.blobs, cap_blobs)) {
            return false;
        }
        self.bytes -= bytes;
        self.blobs -= blobs;
        true
    }

    /// Time until `bytes` and `blobs` (each capped at its bucket size) fit again.
    fn wait_for(&self, bytes: f64, blobs: f64, cap_bytes: f64, cap_blobs: f64) -> Duration {
        let dim = |amount: f64, tokens: f64, cap: f64| {
            if cap <= 0.0 {
                0.0
            } else {
                (amount.min(cap) - tokens).max(0.0) * 60.0 / cap
            }
        };
        Duration::from_secs_f64(
            dim(bytes, self.bytes, cap_bytes)
                .max(dim(blobs, self.blobs, cap_blobs))
                .min(MAX_INGEST_PAUSE.as_secs_f64()),
        )
    }
}

pub struct RetrievalThread {
    receiver: Receiver<PeerMessageTuple>,
    store: Arc<dyn BlobStore>,
    cache: SharedBlobCache,
    asked_blobs: LruMap<BlobId, AskedBlob>,
    active_connections: Box<dyn Links>,
    blob_batch_buffer: VecDeque<BlobBatchItem>,
    config: PropagationConfig,
    internal_sender: Sender<PropagationCommand>,
    receiver_ext: Receiver<RetrievalCommand>,
    blob_message_serializer: MessagesSerializer,
    peer_cmd_sender: Sender<PeerManagementCmd>,
    trust: Arc<dyn PeerTrust>,
    registry: Arc<TrustRegistry>,
    events: Sender<NetEvent>,
    /// Ingest token buckets per peer (bytes and blobs received)
    budgets: HashMap<PeerId, IngestBudget>,
    /// Allowance of unsolicited blobs per peer (`blobs` dimension only)
    unsolicited: HashMap<PeerId, IngestBudget>,
    /// Peers whose answers exceeded our ingest budget: no new asks to them until then
    ingest_paused_until: HashMap<PeerId, Instant>,
    /// Egress token buckets per peer: bytes served to its asks (`bytes`) and
    /// sync pages answered (`blobs` dimension, one token per `SyncRequest`)
    egress: HashMap<PeerId, IngestBudget>,
    /// Unanswered asks to retry: `(due, blob id, attempt)`, earliest first
    ask_retries: BinaryHeap<Reverse<(Instant, BlobId, u32)>>,
    sync: SyncState,
    /// What each peer accepts from us: message sizes, sync pages and pace.
    limits: PeerLimitsTable,
    /// Mesh behaviour (disabled on servers).
    mesh: MeshParts,
    /// `Wanted` entries accepted per peer (`blobs` dimension only).
    wanted_budgets: HashMap<PeerId, IngestBudget>,
    /// `Wanted` entries accepted from all peers together (`blobs` dimension only).
    wanted_global: IngestBudget,
    /// Mesh links that came up with summaries.
    link_ups: HashMap<PeerId, LinkUp>,
}

impl RetrievalThread {
    fn deserializer(&self) -> BlobMessageDeserializer {
        BlobMessageDeserializer::new(BlobMessageDeserializerArgs {
            max_ids_per_message: self.config.max_ids_per_message as u64,
            max_blobs_per_message: self.config.max_blobs_per_message as u64,
            max_key_len: self.config.max_key_len as u64,
            max_payload_len: self.config.max_payload_len as u64,
            max_sync_page: self.config.sync_page_size as u64,
        })
    }

    fn run(&mut self) {
        let blob_message_deserializer = self.deserializer();
        let tick_ask_blobs = tick(self.config.batch_proc_period());
        let tick_resync = tick(self.config.resync_interval());
        let tick_wanted = if self.mesh.config.enabled {
            tick(self.mesh.config.wanted_forward_interval())
        } else {
            never()
        };
        let receiver = self.receiver.clone();
        let receiver_ext = self.receiver_ext.clone();

        loop {
            select! {
                recv(receiver) -> msg => {
                    match msg {
                        Ok((peer_id, message)) => {
                            self.handle_message(&blob_message_deserializer, peer_id, &message);
                        }
                        Err(_) => {
                            info!("Stop blob retrieval thread");
                            return;
                        }
                    }
                },
                recv(receiver_ext) -> msg => {
                    match msg {
                        Ok(RetrievalCommand::Stop) | Err(_) => {
                            info!("Stop blob retrieval thread");
                            return;
                        }
                        Ok(RetrievalCommand::PeerConnected(peer_id)) => self.on_peer_connected(peer_id),
                        Ok(RetrievalCommand::PeerDisconnected(peer_id)) => self.on_peer_disconnected(&peer_id),
                    }
                }
                recv(tick_ask_blobs) -> _ => {
                    self.update_ask_blobs();
                    self.retry_unanswered_asks();
                    self.flush_sync();
                }
                recv(tick_resync) -> _ => {
                    self.resync();
                }
                recv(tick_wanted) -> _ => {
                    self.forward_wanted();
                }
            }
        }
    }

    fn handle_message(
        &mut self,
        deserializer: &BlobMessageDeserializer,
        peer_id: PeerId,
        message: &[u8],
    ) {
        let (rest, message) = match deserializer.deserialize::<DeserializeError>(message) {
            Ok((rest, message)) => (rest, message),
            Err(err) => {
                // includes a `SyncRequest.max` above our page size and oversized lists
                warn!(
                    "Error when deserializing message from peer {}: Err = {}",
                    peer_id, err
                );
                self.misbehaved(&peer_id, Misbehaviour::ProtocolViolation);
                return;
            }
        };
        if !rest.is_empty() {
            // A valid message prefix followed by trailing bytes must not
            // tear down this long-lived shared retrieval thread (doing so
            // would let a single peer deny blob handling for everyone).
            // A compliant peer never sends trailing bytes, so ban the
            // sender and keep serving other peers.
            warn!(
                "peer {} sent a blob message with {} unexpected trailing byte(s); banning it",
                peer_id,
                rest.len()
            );
            self.ban_node(&peer_id);
            return;
        }
        match message {
            BlobMessage::Blobs(envs) => {
                debug!("Received blob message: Blobs from {}", peer_id);
                if let Err(err) = self.note_blobs_from_peer(envs, &peer_id, false) {
                    warn!(
                        "peer {} sent us incorrect blobs, which may be an attack attempt. Err = {}",
                        peer_id, err
                    );
                }
            }
            BlobMessage::LocalBlobs(envs) => {
                debug!("Received blob message: LocalBlobs from {}", peer_id);
                if !self.is_mesh_peer(&peer_id) {
                    warn!("peer {} sent LocalBlobs on a non-mesh link", peer_id);
                    self.misbehaved(&peer_id, Misbehaviour::ProtocolViolation);
                    return;
                }
                if let Err(err) = self.note_blobs_from_peer(envs, &peer_id, true) {
                    warn!(
                        "peer {} sent us incorrect blobs, which may be an attack attempt. Err = {}",
                        peer_id, err
                    );
                }
            }
            BlobMessage::Announce(ids) => {
                debug!("Received blob message: Announce from {}", peer_id);
                if let Err(err) = self.on_announcements_received(ids, &peer_id, false) {
                    warn!(
                        "error when processing announcement received from peer {}: Err = {}",
                        peer_id, err
                    );
                }
            }
            BlobMessage::Ask(ids) => {
                debug!("Received blob message: Ask from {}", peer_id);
                let ids = self.filter_for_link(&peer_id, ids);
                self.on_asked_blobs_received(&peer_id, ids);
            }
            BlobMessage::Wanted { hops, entries } => {
                debug!("Received blob message: Wanted from {}", peer_id);
                if !self.is_mesh_peer(&peer_id) {
                    warn!("peer {} sent Wanted on a non-mesh link", peer_id);
                    self.misbehaved(&peer_id, Misbehaviour::ProtocolViolation);
                    return;
                }
                self.on_wanted_received(&peer_id, hops, entries);
            }
            BlobMessage::Beacon { hops, beacon } => {
                debug!("Received blob message: Beacon from {}", peer_id);
                if !self.is_mesh_peer(&peer_id) {
                    warn!("peer {} sent Beacon on a non-mesh link", peer_id);
                    self.misbehaved(&peer_id, Misbehaviour::ProtocolViolation);
                    return;
                }
                self.on_beacon_received(&peer_id, hops, beacon);
            }
            BlobMessage::HaveSummary(set) => {
                debug!("Received blob message: HaveSummary from {}", peer_id);
                self.on_have_summary(&peer_id, set);
            }
            BlobMessage::WantedSummary {
                set,
                hops,
                lifetimes,
            } => {
                debug!("Received blob message: WantedSummary from {}", peer_id);
                self.on_wanted_summary(&peer_id, set, hops, lifetimes);
            }
            BlobMessage::SyncRequest { since, cursor, max } => {
                debug!("Received blob message: SyncRequest from {}", peer_id);
                // over budget: dropped without penalty, the requester retries later
                if !self.consume_egress(&peer_id, 0.0, 1.0) {
                    debug!(
                        "sync request budget for {} exhausted: request dropped",
                        peer_id
                    );
                    return;
                }
                let mesh_peer = self.is_mesh_peer(&peer_id);
                let filter = self.mesh.link_filter(mesh_peer);
                let mut reply = self
                    .sync
                    .reply_in(self.store.as_ref(), filter, since, cursor, max);
                if mesh_peer {
                    // a mesh link only lists what guided forwarding would offer it
                    if let BlobMessage::SyncIds { ids, .. } = &mut reply {
                        let now = self.mesh.clock.now();
                        let bridges = self.mesh.bridge_direction(now);
                        ids.retain(|id| {
                            self.store.info(id).is_none_or(|info| {
                                self.mesh
                                    .offers(Scope::MESH, &info, &peer_id, &bridges, now)
                            })
                        });
                    }
                }
                if let Err(err) = self.send(&peer_id, reply) {
                    debug!("Failed to send SyncIds to {}: {}", peer_id, err);
                }
            }
            BlobMessage::SyncIds { ids, next } => {
                debug!("Received blob message: SyncIds from {}", peer_id);
                if !self.sync.has_synced_with(&peer_id) {
                    warn!("peer {} sent SyncIds we never asked for", peer_id);
                    self.misbehaved(&peer_id, Misbehaviour::ProtocolViolation);
                    return;
                }
                if !self.sync.on_page(&peer_id, next) {
                    debug!("ignoring late or duplicate SyncIds from {}", peer_id);
                    return;
                }
                if !ids.is_empty() {
                    if let Err(err) = self.on_announcements_received(ids, &peer_id, false) {
                        warn!("error when processing SyncIds from {}: {}", peer_id, err);
                    }
                }
                self.flush_sync();
            }
        }
    }

    fn send(&self, peer_id: &PeerId, message: BlobMessage) -> Result<(), ReplError> {
        self.active_connections.send_to_peer(
            peer_id,
            &self.blob_message_serializer,
            message.into(),
            false,
        )
    }

    /// Whether the link to `peer_id` is a mesh link (never asks the links when the
    /// mesh is off).
    fn is_mesh_peer(&self, peer_id: &PeerId) -> bool {
        self.mesh.config.enabled
            && self
                .active_connections
                .link_info(peer_id)
                .is_some_and(|info| info.kind.is_mesh())
    }

    /// Keeps the ids the link to `peer_id` may carry (all of them when the mesh is off).
    fn filter_for_link(&self, peer_id: &PeerId, ids: Vec<BlobId>) -> Vec<BlobId> {
        let Some(filter) = self.mesh.link_filter(self.is_mesh_peer(peer_id)) else {
            return ids;
        };
        ids.into_iter()
            .filter(|id| {
                self.store
                    .scope_of(id)
                    .is_some_and(|(scope, size)| self.mesh.allows(filter, scope, size))
            })
            .collect()
    }

    /// Merges a peer's wanted entries (within its budget) and announces at once the
    /// wanted blobs we already hold.
    fn on_wanted_received(&mut self, peer_id: &PeerId, hops: u8, mut entries: Vec<WantedEntry>) {
        let trust = self.trust.trust_of(peer_id);
        let accepted = self.consume_wanted_budget(peer_id, trust, entries.len());
        if accepted < entries.len() {
            debug!(
                "wanted budget of {} exhausted: {} entries dropped",
                peer_id,
                entries.len() - accepted
            );
            entries.truncate(accepted);
        }
        let now = self.mesh.clock.now();
        let fresh = self.mesh.wanted.merge(peer_id, trust, hops, &entries, now);
        let held: Vec<BlobId> = fresh
            .iter()
            .filter_map(|seeker| self.store.kv_id(seeker))
            .collect();
        if !held.is_empty() {
            if let Err(err) = self
                .internal_sender
                .try_send(PropagationCommand::PropagateWanted(held))
            {
                warn!("Error sending wanted blobs to propagation channel: {}", err);
            }
        }
    }

    /// Takes up to `n` entries from the peer's budget and the node-wide one; returns how
    /// many were granted. A device reconnecting under fresh peer ids gets a fresh
    /// per-peer budget each time, but the node-wide budget bounds what any number of
    /// them brings.
    fn consume_wanted_budget(&mut self, peer_id: &PeerId, trust: f64, n: usize) -> usize {
        let cap = f64::from(self.mesh.config.wanted_ingest_per_min) * ingest_scale(trust);
        let global_cap = f64::from(self.mesh.config.wanted_global_ingest_per_min);
        let now_instant = Instant::now();
        let budget = self
            .wanted_budgets
            .entry(*peer_id)
            .or_insert_with(|| IngestBudget::full(0.0, cap, now_instant));
        let mut accepted = 0;
        for _ in 0..n {
            if !budget.try_consume(0.0, 1.0, 0.0, cap, now_instant) {
                break;
            }
            if !self
                .wanted_global
                .try_consume(0.0, 1.0, 0.0, global_cap, now_instant)
            {
                budget.blobs += 1.0;
                break;
            }
            accepted += 1;
        }
        accepted
    }

    /// Checks and merges a bridge beacon (one entry of the wanted budget).
    fn on_beacon_received(&mut self, peer_id: &PeerId, hops: u8, beacon: Box<gossip_wire::Beacon>) {
        let trust = self.trust.trust_of(peer_id);
        if self.consume_wanted_budget(peer_id, trust, 1) == 0 {
            return;
        }
        if !beacon.verify() {
            warn!("peer {} sent a beacon with a bad signature", peer_id);
            self.misbehaved(peer_id, Misbehaviour::ProtocolViolation);
            return;
        }
        let now = self.mesh.clock.now();
        self.mesh.wanted.merge_beacon(
            peer_id,
            trust,
            hops,
            &beacon,
            now,
            crate::mesh::BEACON_MAX_FUTURE_MS,
        );
    }

    /// Sends every mesh link the wanted entries it has not seen yet.
    fn forward_wanted(&mut self) {
        let now = self.mesh.clock.now();
        for peer_id in self.active_connections.get_peer_ids_connected() {
            if !self.is_mesh_peer(&peer_id) {
                continue;
            }
            // a compact link waits for the peer's summary, so as not to resend it all
            if self
                .link_ups
                .get(&peer_id)
                .is_some_and(|l| !l.wanted_received && l.since.elapsed() < WANTED_SUMMARY_WAIT)
            {
                continue;
            }
            for message in self.mesh.wanted.outgoing(&peer_id, now) {
                if let Err(err) = self.send(&peer_id, message) {
                    debug!("Failed to send Wanted to {}: {}", peer_id, err);
                    break;
                }
            }
        }
    }

    /// The summary key of the link to `peer_id` when it came up compact.
    fn compact_key(&self, peer_id: &PeerId) -> Option<[u8; 32]> {
        if !self.mesh.config.enabled {
            return None;
        }
        self.active_connections
            .link_info(peer_id)
            .filter(|info| info.kind.is_mesh())
            .and_then(|info| info.compact_link_up)
    }

    /// Ids of the live mesh blobs we hold, in `(expires_at, id)` order.
    fn mesh_ids(&self, now: UnixMillis) -> Vec<BlobId> {
        let mut ids = Vec::new();
        let mut cursor = None;
        loop {
            let (page, next) = self.store.ids_by_expiry_in(
                Scope::MESH,
                now.as_millis(),
                cursor,
                self.config.sync_page_size.max(1),
            );
            ids.extend(page);
            match next {
                Some(next) => cursor = Some(next),
                None => return ids,
            }
        }
    }

    /// Sends a compact link's two summaries.
    fn send_summaries(&mut self, peer_id: &PeerId, key: &[u8; 32]) {
        let now = self.mesh.clock.now();
        // over the cap, the blobs that expire last
        let ids = self.mesh_ids(now);
        let ids = &ids[ids.len().saturating_sub(GCS_MAX_ITEMS as usize)..];
        let (have, _) = summarise(key, ids.iter().map(|id| id.0.as_slice()), HAVE_SUMMARY_P);
        if let Err(err) = self.send(peer_id, BlobMessage::HaveSummary(have)) {
            debug!("Failed to send HaveSummary to {}: {}", peer_id, err);
        }
        let items = self.mesh.wanted.summary_items(now);
        let item_bytes: Vec<Vec<u8>> = items
            .iter()
            .map(|(seeker, _, _, local)| wanted_summary_item(seeker, *local))
            .collect();
        let (set, values) = summarise(key, item_bytes.iter().map(Vec::as_slice), WANTED_SUMMARY_P);
        // metadata in sorted value order; seekers sharing a value all get the largest
        let mut meta: Vec<(u64, u8, u8)> = values
            .iter()
            .zip(&items)
            .map(|(v, (_, hops, units, _))| (*v, *hops, *units))
            .collect();
        meta.sort_unstable();
        for i in (1..meta.len()).rev() {
            if meta[i - 1].0 == meta[i].0 {
                meta[i - 1].1 = meta[i - 1].1.max(meta[i].1);
                meta[i - 1].2 = meta[i - 1].2.max(meta[i].2);
            }
        }
        for i in 1..meta.len() {
            if meta[i - 1].0 == meta[i].0 {
                meta[i] = meta[i - 1];
            }
        }
        let message = BlobMessage::WantedSummary {
            set,
            hops: meta.iter().map(|m| m.1).collect(),
            lifetimes: meta.iter().map(|m| m.2).collect(),
        };
        if let Err(err) = self.send(peer_id, message) {
            debug!("Failed to send WantedSummary to {}: {}", peer_id, err);
        }
    }

    /// The link-up state of a compact link, for a summary that may arrive only once;
    /// `None` (and a strike) when the summary is out of place.
    fn take_link_up(&mut self, peer_id: &PeerId, wanted: bool) -> Option<[u8; 32]> {
        let state = self.link_ups.get_mut(peer_id).and_then(|l| {
            let seen = if wanted {
                &mut l.wanted_received
            } else {
                &mut l.have_received
            };
            (!std::mem::replace(seen, true)).then_some(l.key)
        });
        if state.is_none() {
            warn!(
                "peer {} sent a summary on a link that does not expect one",
                peer_id
            );
            self.misbehaved(peer_id, Misbehaviour::ProtocolViolation);
        }
        state
    }

    /// Announces what a link-up `SyncRequest` from the peer would have listed, minus
    /// what its summary says it holds.
    fn on_have_summary(&mut self, peer_id: &PeerId, set: Gcs) {
        let Some(key) = self.take_link_up(peer_id, false) else {
            return;
        };
        let Ok(values) = set.decode() else {
            warn!("peer {} sent a malformed HaveSummary", peer_id);
            self.misbehaved(peer_id, Misbehaviour::ProtocolViolation);
            return;
        };
        let now = self.mesh.clock.now();
        let bridges = self.mesh.bridge_direction(now);
        let missing: Vec<BlobId> = self
            .mesh_ids(now)
            .into_iter()
            .filter(|id| {
                values
                    .binary_search(&item_value(&key, &id.0, set.n, set.p))
                    .is_err()
            })
            .filter(|id| {
                self.store
                    .info(id)
                    .is_none_or(|info| self.mesh.offers(Scope::MESH, &info, peer_id, &bridges, now))
            })
            .collect();
        let per_message = self
            .limits
            .ids_cap(peer_id, self.config.max_ids_per_message)
            .max(1);
        for chunk in missing.chunks(per_message) {
            if let Err(err) = self.send(peer_id, BlobMessage::Announce(chunk.to_vec())) {
                debug!("Failed to announce link-up ids to {}: {}", peer_id, err);
                break;
            }
        }
    }

    /// Marks as sent to the peer the wanted entries its summary shows it holds.
    fn on_wanted_summary(&mut self, peer_id: &PeerId, set: Gcs, hops: Vec<u8>, lifetimes: Vec<u8>) {
        let Some(key) = self.take_link_up(peer_id, true) else {
            return;
        };
        let Ok(values) = set.decode() else {
            warn!("peer {} sent a malformed WantedSummary", peer_id);
            self.misbehaved(peer_id, Misbehaviour::ProtocolViolation);
            return;
        };
        let now = self.mesh.clock.now();
        self.mesh
            .wanted
            .apply_summary(peer_id, now, |seeker, local| {
                values
                    .binary_search(&item_value(
                        &key,
                        &wanted_summary_item(seeker, local),
                        set.n,
                        set.p,
                    ))
                    .ok()
                    .map(|i| (hops[i], lifetimes[i]))
            });
    }

    fn on_peer_connected(&mut self, peer_id: PeerId) {
        // a compact mesh link starts with summaries instead of a sync
        if let Some(key) = self.compact_key(&peer_id) {
            self.link_ups.insert(
                peer_id,
                LinkUp {
                    key,
                    since: Instant::now(),
                    have_received: false,
                    wanted_received: false,
                },
            );
            self.send_summaries(&peer_id, &key);
            return;
        }
        let now = UnixMillis::now();
        // on a mesh link the peer may come from another part of the crowd: ask for
        // everything it holds within the mesh retention, not just what is recent here
        let since = if self.is_mesh_peer(&peer_id) {
            self.mesh
                .clock
                .now()
                .saturating_sub(self.store.retention_ms_for(Scope::MESH))
        } else {
            self.sync.initial_since(now)
        };
        {
            // pages and pace the peer said it accepts (its own values when it said nothing)
            let page = self.limits.sync_page(&peer_id, self.config.sync_page_size);
            let pace = self.limits.sync_pace(&peer_id, self.sync.default_pace());
            self.sync.start_within(peer_id, since, now, page, pace);
        }
        self.flush_sync();
    }

    fn on_peer_disconnected(&mut self, peer_id: &PeerId) {
        self.sync.remove(peer_id);
        self.link_ups.remove(peer_id);
        self.wanted_budgets.remove(peer_id);
        self.mesh.wanted.remove_peer(peer_id);
        self.budgets.remove(peer_id);
        self.unsolicited.remove(peer_id);
        self.ingest_paused_until.remove(peer_id);
        self.egress.remove(peer_id);
    }

    /// Sends the sync page requests that are due (new, next page, or retry after a
    /// timeout). A failed send stays "in flight" and is retried after the timeout.
    fn flush_sync(&mut self) {
        for (peer_id, request) in self.sync.poll() {
            if let Err(err) = self.send(&peer_id, request) {
                debug!("Failed to send SyncRequest to {}: {}", peer_id, err);
            }
        }
    }

    /// Consumes egress tokens of `peer_id` (`bytes` served, `sync_requests` answered);
    /// `false` (nothing consumed) when over budget.
    fn consume_egress(&mut self, peer_id: &PeerId, bytes: f64, sync_requests: f64) -> bool {
        let scale = ingest_scale(self.trust.trust_of(peer_id));
        let cap_bytes = self.config.peer_egress_bytes_per_min as f64 * scale;
        let cap_sync = self.config.peer_sync_requests_per_min as f64 * scale;
        let now = Instant::now();
        self.egress
            .entry(*peer_id)
            .or_insert_with(|| IngestBudget::full(cap_bytes, cap_sync, now))
            .try_consume_allow_full(bytes, sync_requests, cap_bytes, cap_sync, now)
    }

    /// Our ingest budget for a peer: `(bytes, blobs)` per minute.
    fn ingest_caps(&self, peer_id: &PeerId) -> (f64, f64) {
        let scale = ingest_scale(self.trust.trust_of(peer_id));
        (
            self.config.peer_ingest_bytes_per_min as f64 * scale,
            self.config.peer_ingest_blobs_per_min as f64 * scale,
        )
    }

    /// Periodic resync with random high-trust peers.
    fn resync(&mut self) {
        let peers: Vec<(PeerId, f64)> = self
            .active_connections
            .get_peer_ids_connected()
            .into_iter()
            .map(|peer_id| (peer_id, self.trust.trust_of(&peer_id)))
            .collect();
        let now = UnixMillis::now();
        for peer_id in self.sync.pick_resync_peers(&peers, RESYNC_PEERS) {
            let since = self.sync.resync_since(now);
            {
                // pages and pace the peer said it accepts (its own values when it said nothing)
                let page = self.limits.sync_page(&peer_id, self.config.sync_page_size);
                let pace = self.limits.sync_pace(&peer_id, self.sync.default_pace());
                self.sync.start_within(peer_id, since, now, page, pace);
            }
        }
        self.flush_sync();
    }

    /// Queues a retry of an unanswered ask of `id` at `at` (at most one per blob).
    fn schedule_ask_retry(&mut self, id: BlobId, attempt: u32, at: Instant) {
        let full = self.ask_retries.len() >= self.config.asked_blobs_buffer_capacity;
        let Some(asked) = self.asked_blobs.get(&id) else {
            return;
        };
        if attempt == 0 && asked.retry_queued {
            return;
        }
        asked.retry_queued = !full;
        if !full {
            self.ask_retries.push(Reverse((at, id, attempt)));
        }
    }

    /// On receive a batch of blob ids `ids` from another `peer_id`
    /// Execute the following algorithm (Massa's, with trust):
    ///
    ///```py
    ///def process_blob_batch(ids, peer_id, from_buffer):
    ///    ask_set = void; future_set = void
    ///    for id in ids:
    ///        if not is_blob_received(id):
    ///            if peer_state(id, peer_id) is Buffered: continue
    ///            if peer_state(id, peer_id) is Asked(t) and t >= now - batch_proc_period: continue
    ///            if id not in asked_blobs:
    ///                ask now if the peer is proven (trust > 0) or the batch was deferred,
    ///                otherwise defer
    ///            elif asked_blobs(id).last_ask is None:
    ///                same rule
    ///            elif asked_blobs(id).last_ask < now - batch_proc_period:
    ///                ask now
    ///            else:
    ///                future_set.add(id)
    ///            (asks to a peer whose answers exceeded our ingest budget are deferred
    ///             until the budget refilled)
    ///    if blob_batch_buf is not full:
    ///        blob_batch_buf.push(now + batch_proc_period × (2 - trust), peer_id, future_set)
    ///        for id in future_set: peer_state(id, peer_id) = Buffered
    ///    ask ask_set to peer_id, and queue a retry for each asked id
    ///```
    ///
    /// Peer states are time-bounded on purpose: an `Asked` entry only silences that
    /// peer for `batch_proc_period`, so a peer that disconnects before answering
    /// and reconnects gets asked again on its next announcement. The `Buffered`
    /// marker prevents repeated announcements from queueing the same deferred ask
    /// several times in `blob_batch_buffer`.
    fn on_announcements_received(
        &mut self,
        mut ids: Vec<BlobId>,
        peer_id: &PeerId,
        from_buffer: bool,
    ) -> Result<(), ReplError> {
        // ignore announcement from disconnected peers
        if !self
            .active_connections
            .get_peer_ids_connected()
            .contains(peer_id)
        {
            return Ok(());
        }

        // mark sender as knowing the blobs
        self.cache.write().insert_peer_known_blobs(peer_id, &ids);

        // filter out the blobs that we already know about
        {
            let cache_read = self.cache.read();
            ids.retain(|id| !cache_read.is_known(id));
        }
        let mut seen = HashSet::with_capacity(ids.len());
        ids.retain(|id| seen.insert(*id) && !self.store.contains(id));

        let trust = self.trust.trust_of(peer_id);
        let proven = trust > 0.0;
        let mut ask_set = Vec::with_capacity(ids.len());
        let mut future_set = Vec::with_capacity(ids.len());
        // exactitude isn't important, we want to have a now for that function call
        let now = Instant::now();
        let proc_period = self.config.batch_proc_period();
        // our ingest budget for that peer is exhausted: ask it nothing until it refills
        let paused_until = self
            .ingest_paused_until
            .get(peer_id)
            .copied()
            .filter(|until| *until > now);
        let may_ask = paused_until.is_none();
        let mut count_reask = 0;
        for id in ids {
            let mut first_announcement = false;
            let ask_now = match self.asked_blobs.get(&id) {
                Some(asked) => {
                    match asked.peer_state(peer_id) {
                        // a deferred ask is already queued for that peer: don't queue it twice
                        Some(PeerAskState::Buffered) => continue,
                        // that peer was asked recently: let the ask time out before asking again.
                        // The check is time-based (and not "was that peer ever asked"), so a peer
                        // that reconnects without having answered is asked again.
                        Some(PeerAskState::Asked(previous_peer_ask_time))
                            if now
                                .checked_duration_since(previous_peer_ask_time)
                                .unwrap_or_default()
                                <= proc_period =>
                        {
                            continue
                        }
                        _ => {}
                    }
                    let ask = may_ask
                        && match asked.last_ask {
                            // only unproven peers announced it so far
                            None => proven || from_buffer,
                            // Ask now if latest ask instant < now - batch_proc_period
                            // otherwise add in future_set
                            Some(last_ask) => {
                                let reask =
                                    now.checked_duration_since(last_ask).unwrap_or_default()
                                        > proc_period;
                                if reask {
                                    count_reask += 1;
                                }
                                reask
                            }
                        };
                    if ask {
                        asked.last_ask = Some(now);
                        asked.set_peer_state(peer_id, PeerAskState::Asked(now));
                    }
                    ask
                }
                None => {
                    // never announced to us before
                    first_announcement = true;
                    may_ask && (proven || from_buffer)
                }
            };
            if first_announcement {
                self.asked_blobs.insert(
                    id,
                    AskedBlob::new(ask_now.then_some(now), ask_now.then_some(*peer_id)),
                );
            }
            if ask_now {
                ask_set.push(id);
            } else {
                future_set.push(id);
            }
        } // EndOf for id in ids:

        if count_reask > 0 {
            trace!(count = count_reask, "re-ask blobs");
        }
        if self.blob_batch_buffer.len() < self.config.batch_buffer_capacity
            && !future_set.is_empty()
        {
            // Record the deferred ask so that repeated announcements of the same
            // ids by the same peer don't fill the buffer with duplicates.
            // Nothing is recorded when the batch is dismissed (buffer full),
            // so the peer is free to announce those ids again.
            for id in future_set.iter() {
                if let Some(asked) = self.asked_blobs.get(id) {
                    asked.set_peer_state(peer_id, PeerAskState::Buffered);
                }
            }
            // a proven announcer of the same id gets the first ask
            let mut delay = proc_period.mul_f64(2.0 - trust.clamp(0.0, 1.0));
            if let Some(until) = paused_until {
                delay = delay.max(until.saturating_duration_since(now));
            }
            self.blob_batch_buffer.push_back(BlobBatchItem {
                instant: now.checked_add(delay).ok_or(ReplError::TimeOverflow)?,
                peer_id: *peer_id,
                ids: future_set,
            });
        }
        if !ask_set.is_empty() {
            let retry_at = now + ask_retry_delay(proc_period, 0);
            for id in ask_set.iter() {
                self.schedule_ask_retry(*id, 0, retry_at);
            }
            debug!("Send ask blobs of len {} to {}", ask_set.len(), peer_id);
            let chunk = self
                .limits
                .ids_cap(peer_id, self.config.max_ids_per_message);
            for sub_list in ask_set.chunks(chunk) {
                if let Err(err) = self.send(peer_id, BlobMessage::Ask(sub_list.to_vec())) {
                    warn!("Failed to send Ask message to peer: {}", err);
                    if let ReplError::PeerDisconnected(_) = err {
                        break;
                    }
                }
            }
        }
        Ok(())
    }

    /// Replays the deferred asks that are due (delays vary with trust, so the buffer
    /// is not ordered: every due item is taken).
    fn update_ask_blobs(&mut self) {
        let now = Instant::now();
        let (due, keep): (VecDeque<BlobBatchItem>, VecDeque<BlobBatchItem>) =
            std::mem::take(&mut self.blob_batch_buffer)
                .into_iter()
                .partition(|item| now >= item.instant);
        self.blob_batch_buffer = keep;
        for item in due {
            // The deferred ask is no longer buffered: drop the markers, otherwise the
            // announcement replayed just below (or any later one from that peer) would
            // be ignored forever.
            for id in item.ids.iter() {
                if let Some(asked) = self.asked_blobs.get(id) {
                    asked.clear_buffered(&item.peer_id);
                }
            }
            if let Err(err) = self.on_announcements_received(item.ids, &item.peer_id, true) {
                warn!("Error in update_ask_blobs: {}", err);
            }
        }
    }

    /// Re-asks the blobs whose asks went unanswered (the peer dropped the ask over its
    /// egress budget, truncated it, or its answer exceeded our ingest budget), with
    /// exponential backoff, from the connected announcer asked longest ago and not
    /// paused by our ingest budget.
    fn retry_unanswered_asks(&mut self) {
        let now = Instant::now();
        let mut due = Vec::new();
        while matches!(self.ask_retries.peek(), Some(Reverse((at, _, _))) if *at <= now) {
            if let Some(Reverse((_, id, attempt))) = self.ask_retries.pop() {
                due.push((id, attempt));
            }
        }
        if due.is_empty() {
            return;
        }
        let connected = self.active_connections.get_peer_ids_connected();
        let proc_period = self.config.batch_proc_period();
        let mut per_peer: HashMap<PeerId, Vec<BlobId>> = HashMap::new();
        let mut requeue: Vec<(BlobId, u32, Instant)> = Vec::new();
        for (id, attempt) in due {
            let received = self.cache.read().is_known(&id) || self.store.contains(&id);
            let Some(asked) = self.asked_blobs.get(&id) else {
                continue;
            };
            asked.retry_queued = false;
            if received || attempt >= MAX_ASK_RETRIES {
                continue;
            }
            let mut best: Option<(PeerId, Instant)> = None;
            let mut earliest_resume: Option<Instant> = None;
            for (peer, state) in asked.peers.iter() {
                let PeerAskState::Asked(asked_at) = state else {
                    continue;
                };
                if !connected.contains(peer) {
                    continue;
                }
                if let Some(until) = self
                    .ingest_paused_until
                    .get(peer)
                    .copied()
                    .filter(|until| *until > now)
                {
                    earliest_resume = Some(earliest_resume.map_or(until, |e| e.min(until)));
                    continue;
                }
                if best.is_none_or(|(_, best_at)| *asked_at < best_at) {
                    best = Some((*peer, *asked_at));
                }
            }
            match (best, earliest_resume) {
                (Some((peer, _)), _) => {
                    asked.last_ask = Some(now);
                    asked.set_peer_state(&peer, PeerAskState::Asked(now));
                    per_peer.entry(peer).or_default().push(id);
                    requeue.push((
                        id,
                        attempt + 1,
                        now + ask_retry_delay(proc_period, attempt + 1),
                    ));
                }
                // only paused announcers: try again once the first one resumes
                (None, Some(resume)) => requeue.push((id, attempt, resume)),
                // nobody to ask: a future announcement asks again
                (None, None) => {}
            }
        }
        for (id, attempt, at) in requeue {
            self.schedule_ask_retry(id, attempt, at);
        }
        for (peer_id, ids) in per_peer {
            debug!("Retry ask of {} blobs to {}", ids.len(), peer_id);
            let chunk = self
                .limits
                .ids_cap(&peer_id, self.config.max_ids_per_message);
            for sub_list in ids.chunks(chunk) {
                if let Err(err) = self.send(&peer_id, BlobMessage::Ask(sub_list.to_vec())) {
                    debug!("Failed to send Ask retry to {}: {}", peer_id, err);
                    break;
                }
            }
        }
    }

    /// Serves the blobs a peer asked for, in `Blobs` messages bounded by
    /// `max_blobs_per_message` and `max_blobs_message_bytes`.
    ///
    /// Ids are de-duplicated and every envelope is charged to the peer's egress budget:
    /// over budget the answer is truncated and the rest of the ask dropped, without
    /// penalty (an honest node catching up asks a lot; it retries later). Serving stops
    /// at the first send error (congested or gone peer).
    fn on_asked_blobs_received(&mut self, peer_id: &PeerId, ids: Vec<BlobId>) {
        let mut seen = HashSet::with_capacity(ids.len());
        let ids: Vec<BlobId> = ids.into_iter().filter(|id| seen.insert(*id)).collect();
        // a `Blobs` message larger than the peer's caps is a protocol violation on its
        // side: size every batch to the stricter of the two configurations
        let (max_blobs, max_bytes) = self.limits.blobs_cap(
            peer_id,
            self.config.max_blobs_per_message.max(1),
            self.config.max_blobs_message_bytes,
        );
        let frame_cap = self.limits.frame_cap(peer_id);
        let mut remaining: &[BlobId] = &ids;
        while !remaining.is_empty() {
            let chunk = &remaining[..remaining.len().min(max_blobs)];
            let mut envs = self.store.get_many(chunk, max_bytes);
            let consumed = match envs.last() {
                Some(last) => {
                    let last_id = last.id();
                    chunk
                        .iter()
                        .position(|id| *id == last_id)
                        .map(|pos| pos + 1)
                        .unwrap_or(chunk.len())
                }
                None => chunk.len(),
            };
            remaining = &remaining[consumed..];
            // a single blob the peer cannot even frame is left out: it would only get
            // us struck, and the peer can fetch it from a node whose frame is larger
            if let Some(cap) = frame_cap {
                let before = envs.len();
                envs.retain(|env| env.wire_size() <= cap);
                if envs.len() < before {
                    debug!(
                        "{} blob(s) too large for {}'s frame cap of {} bytes: not served",
                        before - envs.len(),
                        peer_id,
                        cap
                    );
                }
            }
            if envs.is_empty() {
                continue;
            }
            let mut affordable = 0;
            for env in envs.iter() {
                if !self.consume_egress(peer_id, env.wire_size() as f64, 0.0) {
                    break;
                }
                affordable += 1;
            }
            let truncated = affordable < envs.len();
            envs.truncate(affordable);
            if !envs.is_empty() {
                debug!("Send full blobs of len {} to {}", envs.len(), peer_id);
                // local-only blobs travel as such, so that the peer never uploads them
                let (local, regular): (Vec<_>, Vec<_>) = envs.into_iter().partition(|env| {
                    self.store
                        .scope_of(&env.id())
                        .is_some_and(|(scope, _)| scope.is_local())
                });
                for (envs, local) in [(regular, false), (local, true)] {
                    if envs.is_empty() {
                        continue;
                    }
                    let message = if local {
                        BlobMessage::LocalBlobs(envs)
                    } else {
                        BlobMessage::Blobs(envs)
                    };
                    if let Err(err) = self.send(peer_id, message) {
                        debug!(
                            "Failed to send Blobs message to {}: {}; stop serving",
                            peer_id, err
                        );
                        return;
                    }
                }
            }
            if truncated {
                debug!(
                    "egress budget for {} exhausted: rest of its ask dropped",
                    peer_id
                );
                return;
            }
        }
    }

    /// Ingests blobs delivered by a peer: budget, validation, dedup, batch signature
    /// verification, insertion, propagation.
    ///
    /// Blobs answering our asks to that peer are never a misbehaviour: past our ingest
    /// budget they are dropped and asks to that peer pause until the budget refilled
    /// (the ask retries fetch them later). Unsolicited blobs get a small allowance;
    /// beyond it, or beyond the ingest budget, they are dropped and count as flooding.
    fn note_blobs_from_peer(
        &mut self,
        envs: Vec<BlobEnvelope>,
        peer_id: &PeerId,
        local: bool,
    ) -> Result<(), ReplError> {
        if envs.is_empty() {
            return Ok(());
        }
        let now_instant = Instant::now();
        let mesh_link = self.is_mesh_peer(peer_id);
        let now = self.mesh.now_for(mesh_link);
        let scope = self.mesh.ingest_scope(mesh_link, local);
        let trust = self.trust.trust_of(peer_id);
        let (cap_bytes, cap_blobs) = self.ingest_caps(peer_id);

        let mut all_received_ids = Vec::with_capacity(envs.len());
        let mut accepted: Vec<(BlobEnvelope, BlobId)> = Vec::with_capacity(envs.len());
        let (mut dropped_solicited, mut dropped_solicited_bytes) = (0usize, 0f64);
        let mut flooded = 0usize;
        for env in envs {
            let id = env.id();
            all_received_ids.push(id);
            let size = env.wire_size() as f64;
            let solicited = self
                .asked_blobs
                .peek(&id)
                .map(|asked| asked.was_asked(peer_id))
                .unwrap_or(false);
            let budget = self
                .budgets
                .entry(*peer_id)
                .or_insert_with(|| IngestBudget::full(cap_bytes, cap_blobs, now_instant));
            if solicited {
                if budget.try_consume_allow_full(size, 1.0, cap_bytes, cap_blobs, now_instant) {
                    accepted.push((env, id));
                } else {
                    dropped_solicited += 1;
                    dropped_solicited_bytes += size;
                }
            } else {
                let allowance = self.unsolicited.entry(*peer_id).or_insert_with(|| {
                    IngestBudget::full(0.0, UNSOLICITED_BLOBS_PER_MIN, now_instant)
                });
                if allowance.try_consume(0.0, 1.0, 0.0, UNSOLICITED_BLOBS_PER_MIN, now_instant)
                    && budget.try_consume(size, 1.0, cap_bytes, cap_blobs, now_instant)
                {
                    accepted.push((env, id));
                } else {
                    flooded += 1;
                }
            }
        }
        if dropped_solicited > 0 {
            let wait = self.budgets[peer_id].wait_for(
                dropped_solicited_bytes,
                dropped_solicited as f64,
                cap_bytes,
                cap_blobs,
            );
            let until = now_instant + wait;
            let paused = self.ingest_paused_until.entry(*peer_id).or_insert(until);
            *paused = (*paused).max(until);
            debug!(
                "answers from {} exceed our ingest budget: {} blob(s) dropped, asks paused for {:?}",
                peer_id, dropped_solicited, wait
            );
        }
        if flooded > 0 {
            warn!(
                "peer {} sent {} unsolicited blob(s) beyond its allowance: dropping them",
                peer_id, flooded
            );
            self.misbehaved(peer_id, Misbehaviour::Flooding);
        }

        // mark the sender as knowing the blobs it sent us:
        // this holds regardless of whether we end up retaining them locally
        self.cache
            .write()
            .insert_peer_known_blobs(peer_id, &all_received_ids);

        let mut seen = HashSet::with_capacity(accepted.len());
        let mut pending: Vec<(BlobEnvelope, BlobId)> = Vec::new();
        let mut materials = Vec::new();
        for (env, id) in accepted {
            if !seen.insert(id) || self.cache.read().is_known(&id) {
                continue;
            }
            let material = match self
                .store
                .validate_scoped(&env, now.as_millis(), false, scope)
            {
                Ok(material) => material,
                Err(ValidateError::Expired) => {
                    self.cache.write().insert_expired(id);
                    continue;
                }
                Err(ValidateError::FutureDated) => continue,
                Err(ValidateError::Invalid(reason)) => {
                    self.misbehaved(peer_id, Misbehaviour::InvalidBlob);
                    return Err(ReplError::Store(format!("invalid blob {}: {}", id, reason)));
                }
            };
            if self.store.contains(&id) {
                self.cache.write().insert_checked_blob(id);
                if self.mesh.config.enabled {
                    // held already: record that it also arrived this way
                    self.store.update_scope(&[id], scope, Scope::NONE);
                }
                continue;
            }
            if let Some(material) = material {
                materials.push(material.into_tuple());
            }
            pending.push((env, id));
        }

        if pending.is_empty() {
            return Ok(());
        }

        // optimized signature verification
        if let Err(err) = verify_sigs_batch(&materials) {
            self.registry
                .record_misbehaviour(peer_id, Misbehaviour::InvalidBlob, now);
            self.ban_node(peer_id);
            return Err(err);
        }

        let source = BlobSource {
            peer: Some(*peer_id),
            trust_bucket: trust_bucket(trust),
            scope,
        };
        let ids: Vec<BlobId> = pending.iter().map(|(_, id)| *id).collect();
        let wanted_ids: HashSet<BlobId> = if self.mesh.config.enabled {
            pending
                .iter()
                .filter(|(env, _)| {
                    env.kind == gossip_wire::BlobKind::KeyValue
                        && self.mesh.wanted.contains(&env.key, now)
                })
                .map(|(_, id)| *id)
                .collect()
        } else {
            HashSet::new()
        };
        let items = pending
            .into_iter()
            .map(|(env, _)| (env, source.clone()))
            .collect();
        let outcomes = self
            .store
            .insert_many_prevalidated(items, now.as_millis())
            .map_err(ReplError::Store)?;
        let mut inserted = Vec::new();
        {
            let mut cache_write = self.cache.write();
            for (id, outcome) in ids.into_iter().zip(outcomes) {
                match outcome {
                    // `stored` may differ from `id` (e.g. an identical payload replaced
                    // with a later-expiring copy): propagate what the store now holds
                    StoreOutcome::Inserted(stored) => {
                        cache_write.insert_checked_blob(id);
                        cache_write.insert_checked_blob(stored);
                        inserted.push(stored);
                    }
                    StoreOutcome::AlreadyPresent(stored) => {
                        cache_write.insert_checked_blob(id);
                        cache_write.insert_checked_blob(stored);
                    }
                    // not a permanent verdict: silence the id for a while only
                    StoreOutcome::Rejected(reason) => {
                        cache_write.insert_rejected(id);
                        debug!("blob {} from {} not stored: {}", id, peer_id, reason)
                    }
                }
            }
        }

        if !inserted.is_empty() {
            let (wanted, plain): (Vec<BlobId>, Vec<BlobId>) =
                inserted.iter().partition(|id| wanted_ids.contains(id));
            if !wanted.is_empty() {
                if let Err(err) = self
                    .internal_sender
                    .try_send(PropagationCommand::PropagateWanted(wanted))
                {
                    warn!("Error sending wanted blobs to propagation channel: {}", err);
                }
            }
            if let Err(err) = self
                .internal_sender
                .try_send(PropagationCommand::PropagateBlobs(plain))
            {
                warn!("Error sending blobs to propagation channel: {}", err);
            }
            if let Err(err) = self.events.try_send(NetEvent::BlobsStored(inserted)) {
                debug!("could not emit BlobsStored event: {}", err);
            }
        }
        Ok(())
    }

    /// Records a misbehaviour and bans when the registry says so.
    fn misbehaved(&mut self, peer_id: &PeerId, kind: Misbehaviour) {
        if self
            .registry
            .record_misbehaviour(peer_id, kind, UnixMillis::now())
        {
            self.ban_node(peer_id);
        }
    }

    /// send a ban peer command to the peer handler
    fn ban_node(&mut self, peer_id: &PeerId) {
        trace!(peer = %peer_id, "ban node from retrieval thread");
        if let Err(err) = self
            .peer_cmd_sender
            .try_send(PeerManagementCmd::Ban(vec![*peer_id]))
        {
            warn!("Error when banning node: {}", err);
        }
    }
}

#[allow(clippy::too_many_arguments)]
pub fn start_retrieval_thread(
    receiver: Receiver<PeerMessageTuple>,
    store: Arc<dyn BlobStore>,
    config: PropagationConfig,
    cache: SharedBlobCache,
    active_connections: Box<dyn Links>,
    receiver_ext: Receiver<RetrievalCommand>,
    internal_sender: Sender<PropagationCommand>,
    peer_cmd_sender: Sender<PeerManagementCmd>,
    trust: Arc<dyn PeerTrust>,
    registry: Arc<TrustRegistry>,
    events: Sender<NetEvent>,
    limits: PeerLimitsTable,
    mesh: MeshParts,
) -> JoinHandle<()> {
    std::thread::Builder::new()
        .name(THREAD_NAME.to_string())
        .spawn(move || {
            // paced at the budget any honest peer grants even an untrusted requester
            let sync = SyncState::new(config.sync_page_size, store.retention_ms())
                .with_pacing(config.peer_sync_requests_per_min as f64 * ingest_scale(0.0));
            let mut retrieval_thread = RetrievalThread {
                receiver,
                store,
                internal_sender,
                receiver_ext,
                cache,
                active_connections,
                asked_blobs: LruMap::new(ByLength::new(
                    u32::try_from(config.asked_blobs_buffer_capacity)
                        .unwrap_or(u32::MAX)
                        .max(1),
                )),
                config,
                blob_message_serializer: MessagesSerializer::new()
                    .with_blob_message_serializer(BlobMessageSerializer::new()),
                blob_batch_buffer: VecDeque::new(),
                peer_cmd_sender,
                trust,
                registry,
                events,
                budgets: HashMap::new(),
                egress: HashMap::new(),
                unsolicited: HashMap::new(),
                ingest_paused_until: HashMap::new(),
                ask_retries: BinaryHeap::new(),
                sync,
                limits,
                mesh,
                wanted_budgets: HashMap::new(),
                wanted_global: IngestBudget::full(0.0, f64::MAX, Instant::now()),
                link_ups: HashMap::new(),
            };
            retrieval_thread.run();
        })
        .expect("OS failed to start blob retrieval thread")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::handler::cache::BlobCache;
    use crate::link::MockLinks;
    use crate::store::{MemBlobStore, StoreOutcome};
    use crate::trust::FixedTrust;
    use crossbeam::channel::unbounded;
    use gossip_trust::TrustPolicy;
    use gossip_wire::{build_kv_entry, BlobKind, Message};
    use massa_serialization::Serializer;
    use massa_signature::KeyPair;
    use parking_lot::RwLock;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering as AtomicOrdering};
    use std::time::Duration;

    fn new_peer_id() -> PeerId {
        PeerId::from_public_key(KeyPair::generate(0).unwrap().get_public_key())
    }

    fn new_id(seed: u8) -> BlobId {
        BlobId(*massa_hash::Hash::compute_from(&[seed]).to_bytes())
    }

    fn test_config() -> PropagationConfig {
        PropagationConfig {
            batch_proc_period_ms: 100,
            ..PropagationConfig::default()
        }
    }

    type Sent = Arc<RwLock<Vec<(PeerId, BlobMessage)>>>;

    struct Harness {
        thread: RetrievalThread,
        sent: Sent,
        send_attempts: Arc<AtomicUsize>,
        fail_sends: Arc<AtomicBool>,
        propagation: Receiver<PropagationCommand>,
        peer_cmds: Receiver<PeerManagementCmd>,
        events: Receiver<NetEvent>,
        store: Arc<MemBlobStore>,
    }

    impl Harness {
        fn asks(&self) -> Vec<(PeerId, usize)> {
            self.sent
                .read()
                .iter()
                .filter_map(|(peer, msg)| match msg {
                    BlobMessage::Ask(ids) => Some((*peer, ids.len())),
                    _ => None,
                })
                .collect()
        }

        fn blobs_messages(&self) -> Vec<usize> {
            self.sent
                .read()
                .iter()
                .filter_map(|(_, msg)| match msg {
                    BlobMessage::Blobs(blobs) => Some(blobs.len()),
                    _ => None,
                })
                .collect()
        }

        fn sync_ids_messages(&self) -> usize {
            self.sent
                .read()
                .iter()
                .filter(|(_, msg)| matches!(msg, BlobMessage::SyncIds { .. }))
                .count()
        }
    }

    /// Build a retrieval thread whose peers are all connected, recording every
    /// message sent.
    fn new_retrieval_thread(
        config: PropagationConfig,
        connected: HashSet<PeerId>,
        trust: Arc<FixedTrust>,
    ) -> Harness {
        let store = Arc::new(MemBlobStore::default());
        new_retrieval_thread_with_store(config, connected, trust, store.clone(), store)
    }

    fn new_retrieval_thread_with_store(
        config: PropagationConfig,
        connected: HashSet<PeerId>,
        trust: Arc<FixedTrust>,
        mem: Arc<MemBlobStore>,
        store: Arc<dyn BlobStore>,
    ) -> Harness {
        let sent: Sent = Arc::new(RwLock::new(Vec::new()));
        let send_attempts = Arc::new(AtomicUsize::new(0));
        let fail_sends = Arc::new(AtomicBool::new(false));
        let (sent_clone, attempts_clone, fail_clone) =
            (sent.clone(), send_attempts.clone(), fail_sends.clone());
        let mut active_connections = MockLinks::new();
        active_connections
            .expect_get_peer_ids_connected()
            .returning(move || connected.clone());
        active_connections.expect_send_to_peer().returning(
            move |peer_id, _serializer, message, _high_priority| {
                attempts_clone.fetch_add(1, AtomicOrdering::SeqCst);
                if fail_clone.load(AtomicOrdering::SeqCst) {
                    return Err(ReplError::SendError("congested".into()));
                }
                if let Message::Blob(message) = message {
                    sent_clone.write().push((*peer_id, message));
                }
                Ok(())
            },
        );

        let (_sender, receiver) = unbounded();
        let (_sender_ext, receiver_ext) = unbounded();
        std::mem::forget(_sender);
        std::mem::forget(_sender_ext);
        let (internal_sender, propagation) = unbounded();
        let (peer_cmd_sender, peer_cmds) = unbounded();
        let (events_sender, events) = unbounded();

        let thread = RetrievalThread {
            receiver,
            sync: SyncState::new(config.sync_page_size, store.retention_ms()),
            limits: PeerLimitsTable::default(),
            mesh: MeshParts::disabled(),
            wanted_budgets: HashMap::new(),
            wanted_global: IngestBudget::full(0.0, f64::MAX, Instant::now()),
            link_ups: HashMap::new(),
            store,
            cache: Arc::new(RwLock::new(BlobCache::new(1000, 1000))),
            asked_blobs: LruMap::new(ByLength::new(1000)),
            active_connections: Box::new(active_connections),
            blob_batch_buffer: VecDeque::new(),
            config,
            internal_sender,
            receiver_ext,
            blob_message_serializer: MessagesSerializer::new()
                .with_blob_message_serializer(BlobMessageSerializer::new()),
            peer_cmd_sender,
            trust,
            registry: Arc::new(TrustRegistry::new(TrustPolicy::default())),
            events: events_sender,
            budgets: HashMap::new(),
            egress: HashMap::new(),
            unsolicited: HashMap::new(),
            ingest_paused_until: HashMap::new(),
            ask_retries: BinaryHeap::new(),
        };
        Harness {
            thread,
            sent,
            send_attempts,
            fail_sends,
            propagation,
            peer_cmds,
            events,
            store: mem,
        }
    }

    /// F127: while an announced blob is on cooldown, a peer repeating the same
    /// announcement must not queue several deferred asks in `blob_batch_buffer`.
    #[test]
    fn test_duplicate_announcements_during_cooldown_do_not_grow_the_batch_buffer() {
        let peer_a = new_peer_id();
        let peer_b = new_peer_id();
        let mut h = new_retrieval_thread(
            test_config(),
            HashSet::from([peer_a, peer_b]),
            Arc::new(FixedTrust::new(1.0)),
        );
        let batch = vec![new_id(1)];

        // peer A announces first: asked right away
        h.thread
            .on_announcements_received(batch.clone(), &peer_a, false)
            .unwrap();
        assert_eq!(h.asks().len(), 1);
        assert!(h.thread.blob_batch_buffer.is_empty());

        // peer B announces the same blob during the cooldown: the ask is deferred once
        for _ in 0..10 {
            h.thread
                .on_announcements_received(batch.clone(), &peer_b, false)
                .unwrap();
        }
        assert_eq!(
            h.thread.blob_batch_buffer.len(),
            1,
            "repeated announcements must not queue several deferred asks"
        );
        assert_eq!(h.asks().len(), 1, "peer B must not be asked yet");

        // once the deferred batch is processed, peer B is asked and the buffer is empty
        std::thread::sleep(test_config().batch_proc_period() + Duration::from_millis(20));
        h.thread.update_ask_blobs();
        assert!(h.thread.blob_batch_buffer.is_empty());
        assert_eq!(h.asks().last().unwrap().0, peer_b);
    }

    /// F131: a peer that was asked but never answered (typically because it
    /// disconnected in between) must be asked again when it announces the blob
    /// after the ask cooldown, instead of being ignored forever.
    #[test]
    fn test_peer_is_asked_again_after_cooldown() {
        let peer_a = new_peer_id();
        let mut h = new_retrieval_thread(
            test_config(),
            HashSet::from([peer_a]),
            Arc::new(FixedTrust::new(1.0)),
        );
        let batch = vec![new_id(2)];

        h.thread
            .on_announcements_received(batch.clone(), &peer_a, false)
            .unwrap();
        assert_eq!(h.asks().len(), 1);

        // same peer re-announcing during the cooldown changes nothing
        h.thread
            .on_announcements_received(batch.clone(), &peer_a, false)
            .unwrap();
        assert_eq!(h.asks().len(), 1);
        assert!(h.thread.blob_batch_buffer.is_empty());

        // after the cooldown (peer disconnected and reconnected without answering),
        // its announcement triggers a fresh ask
        std::thread::sleep(test_config().batch_proc_period() + Duration::from_millis(50));
        h.thread
            .on_announcements_received(batch, &peer_a, false)
            .unwrap();
        assert_eq!(h.asks().len(), 2);
        assert_eq!(h.asks().last().unwrap().0, peer_a);
    }

    /// An unproven announcer is not asked right away; a proven announcer of the same
    /// blob gets the first ask, and the unproven one is replayed after `2 × period`.
    #[test]
    fn proven_announcer_wins_the_first_ask() {
        let unproven = new_peer_id();
        let proven = new_peer_id();
        let trust = Arc::new(FixedTrust::new(0.0));
        trust.set(proven, 0.9);
        let mut h = new_retrieval_thread(test_config(), HashSet::from([unproven, proven]), trust);
        let batch = vec![new_id(3)];

        h.thread
            .on_announcements_received(batch.clone(), &unproven, false)
            .unwrap();
        assert!(h.asks().is_empty());
        assert_eq!(h.thread.blob_batch_buffer.len(), 1);

        h.thread
            .on_announcements_received(batch, &proven, false)
            .unwrap();
        assert_eq!(h.asks(), vec![(proven, 1)]);

        // not due before 2 × period for a zero-trust peer
        std::thread::sleep(test_config().batch_proc_period() + Duration::from_millis(20));
        h.thread.update_ask_blobs();
        assert_eq!(h.thread.blob_batch_buffer.len(), 1);
        std::thread::sleep(test_config().batch_proc_period());
        h.thread.update_ask_blobs();
        assert!(h.thread.blob_batch_buffer.is_empty());
        assert_eq!(h.asks().last().unwrap().0, unproven);
    }

    fn now_ms() -> u64 {
        UnixMillis::now().as_millis()
    }

    #[test]
    fn valid_blobs_are_stored_propagated_and_announced_as_events() {
        let peer = new_peer_id();
        let mut h = new_retrieval_thread(
            test_config(),
            HashSet::from([peer]),
            Arc::new(FixedTrust::new(1.0)),
        );
        let kp = KeyPair::generate(0).unwrap();
        let (key, value) = build_kv_entry(&kp, b"hello");
        let envs = vec![
            BlobEnvelope::new(BlobKind::KeyValue, now_ms(), key, value),
            BlobEnvelope::new(BlobKind::Bulletin, now_ms(), vec![], vec![1, 2]),
            // expired: skipped, remembered
            BlobEnvelope::new(BlobKind::Bulletin, 1, vec![], vec![3]),
        ];
        let ids: Vec<BlobId> = envs.iter().map(|e| e.id()).collect();
        h.thread
            .note_blobs_from_peer(envs.clone(), &peer, false)
            .unwrap();
        assert!(h.store.contains(&ids[0]) && h.store.contains(&ids[1]));
        assert!(!h.store.contains(&ids[2]));
        match h.propagation.try_recv().unwrap() {
            PropagationCommand::PropagateBlobs(p) => assert_eq!(p, ids[..2].to_vec()),
            other => panic!("unexpected {:?}", other),
        }
        assert!(matches!(h.events.try_recv().unwrap(), NetEvent::BlobsStored(s) if s.len() == 2));
        {
            let cache = h.thread.cache.read();
            assert!(cache.is_known(&ids[2]));
            let known = cache.blobs_known_by_peer.get(&peer).unwrap();
            assert!(ids.iter().all(|id| known.peek(id).is_some()));
        }
        // re-delivery is a no-op
        h.thread.note_blobs_from_peer(envs, &peer, false).unwrap();
        assert!(h.propagation.try_recv().is_err());
        assert!(h.peer_cmds.try_recv().is_err());
    }

    #[test]
    fn bad_kv_signature_bans_the_sender() {
        let peer = new_peer_id();
        let mut h = new_retrieval_thread(
            test_config(),
            HashSet::from([peer]),
            Arc::new(FixedTrust::new(1.0)),
        );
        let kp = KeyPair::generate(0).unwrap();
        let (key, mut value) = build_kv_entry(&kp, b"hello");
        *value.last_mut().unwrap() ^= 1;
        let env = BlobEnvelope::new(BlobKind::KeyValue, now_ms(), key, value);
        let id = env.id();
        assert!(h
            .thread
            .note_blobs_from_peer(vec![env], &peer, false)
            .is_err());
        assert!(!h.store.contains(&id));
        assert!(matches!(
            h.peer_cmds.try_recv().unwrap(),
            PeerManagementCmd::Ban(p) if p == vec![peer]
        ));
        assert!(h.propagation.try_recv().is_err());
    }

    #[test]
    fn flooding_is_dropped_and_eventually_banned() {
        let peer = new_peer_id();
        let config = PropagationConfig {
            peer_ingest_blobs_per_min: 4,
            ..test_config()
        };
        let mut h = new_retrieval_thread(
            config,
            HashSet::from([peer]),
            Arc::new(FixedTrust::new(0.0)),
        );
        // zero trust: 0.25 × 4 = 1 blob per minute
        let blob = |i: u8| BlobEnvelope::new(BlobKind::Bulletin, now_ms(), vec![], vec![i]);
        h.thread
            .note_blobs_from_peer(vec![blob(1)], &peer, false)
            .unwrap();
        assert!(h.store.contains(&blob(1).id()) || h.store.len() == 1);
        for i in 2..5 {
            h.thread
                .note_blobs_from_peer(vec![blob(i)], &peer, false)
                .unwrap();
        }
        assert_eq!(h.store.len(), 1);
        // three Flooding strikes reach the default ban threshold
        assert!(matches!(
            h.peer_cmds.try_recv().unwrap(),
            PeerManagementCmd::Ban(_)
        ));
        assert!((ingest_scale(1.0) - 1.0).abs() < 1e-9);
    }

    #[test]
    fn asks_are_served_in_byte_bounded_messages_and_trailing_bytes_ban() {
        let peer = new_peer_id();
        let config = PropagationConfig {
            max_blobs_message_bytes: 150,
            ..test_config()
        };
        let mut h = new_retrieval_thread(
            config,
            HashSet::from([peer]),
            Arc::new(FixedTrust::new(1.0)),
        );
        let envs: Vec<BlobEnvelope> = (0..3u8)
            .map(|i| BlobEnvelope::new(BlobKind::Bulletin, now_ms(), vec![], vec![i; 100]))
            .collect();
        let outcomes = h
            .store
            .insert_many_prevalidated(
                envs.iter()
                    .map(|e| {
                        (
                            e.clone(),
                            BlobSource {
                                peer: None,
                                trust_bucket: 0,
                                scope: Scope::INTERNET,
                            },
                        )
                    })
                    .collect(),
                now_ms(),
            )
            .unwrap();
        assert!(outcomes
            .iter()
            .all(|o| matches!(o, StoreOutcome::Inserted(_))));
        let mut ids: Vec<BlobId> = envs.iter().map(|e| e.id()).collect();
        ids.push(new_id(9)); // unknown id is skipped
        h.thread.on_asked_blobs_received(&peer, ids);
        let blobs: Vec<usize> = h
            .sent
            .read()
            .iter()
            .filter_map(|(_, m)| match m {
                BlobMessage::Blobs(b) => Some(b.len()),
                _ => None,
            })
            .collect();
        assert_eq!(blobs, vec![1, 1, 1]);

        // trailing bytes after a valid message: ban
        let mut buf = Vec::new();
        BlobMessageSerializer::new()
            .serialize(&BlobMessage::Announce(vec![]), &mut buf)
            .unwrap();
        buf.push(0);
        let deserializer = h.thread.deserializer();
        h.thread.handle_message(&deserializer, peer, &buf);
        assert!(matches!(
            h.peer_cmds.try_recv().unwrap(),
            PeerManagementCmd::Ban(_)
        ));
    }

    #[test]
    fn sync_request_is_answered_and_pages_are_followed() {
        let peer = new_peer_id();
        let mut h = new_retrieval_thread(
            PropagationConfig {
                sync_page_size: 1,
                ..test_config()
            },
            HashSet::from([peer]),
            Arc::new(FixedTrust::new(1.0)),
        );
        let env = BlobEnvelope::new(BlobKind::Bulletin, now_ms(), vec![], vec![1]);
        h.store.insert_raw(env.clone());
        let deserializer = h.thread.deserializer();
        let serializer = BlobMessageSerializer::new();
        let mut buf = Vec::new();
        serializer
            .serialize(
                &BlobMessage::SyncRequest {
                    since: UnixMillis(0),
                    cursor: None,
                    max: 1,
                },
                &mut buf,
            )
            .unwrap();
        h.thread.handle_message(&deserializer, peer, &buf);
        assert!(matches!(
            h.sent.read().last().unwrap().1,
            BlobMessage::SyncIds { ref ids, next: None } if ids == &vec![env.id()]
        ));

        // our own sync: connected event sends a request, a page with a cursor asks the next
        h.thread.on_peer_connected(peer);
        assert!(matches!(
            h.sent.read().last().unwrap().1,
            BlobMessage::SyncRequest {
                cursor: None,
                max: 1,
                ..
            }
        ));
        let remote_id = new_id(5);
        let mut buf = Vec::new();
        serializer
            .serialize(
                &BlobMessage::SyncIds {
                    ids: vec![remote_id],
                    next: Some((UnixMillis(7), remote_id)),
                },
                &mut buf,
            )
            .unwrap();
        h.thread.handle_message(&deserializer, peer, &buf);
        let sent = h.sent.read().clone();
        assert!(sent
            .iter()
            .any(|(_, m)| matches!(m, BlobMessage::Ask(ids) if ids == &vec![remote_id])));
        assert!(matches!(
            sent.last().unwrap().1,
            BlobMessage::SyncRequest {
                cursor: Some(_),
                ..
            }
        ));
        h.thread.on_peer_disconnected(&peer);
        assert!(!h.thread.sync.is_in_flight(&peer));
    }

    fn plant(h: &Harness, n: u8) -> Vec<BlobId> {
        (0..n)
            .map(|i| {
                h.store.insert_raw(BlobEnvelope::new(
                    BlobKind::Bulletin,
                    now_ms(),
                    vec![],
                    vec![i; 100],
                ))
            })
            .collect()
    }

    /// Finding 2: duplicate ids of an `Ask` are served once, and serving is charged to
    /// the peer's egress budget (129 bytes per blob here, 400 bytes per minute).
    #[test]
    fn duplicate_ask_ids_are_served_once_and_over_budget_asks_are_truncated_without_strike() {
        let peer = new_peer_id();
        let config = PropagationConfig {
            max_blobs_message_bytes: 150,
            peer_egress_bytes_per_min: 400,
            ..test_config()
        };
        let mut h = new_retrieval_thread(
            config,
            HashSet::from([peer]),
            Arc::new(FixedTrust::new(1.0)),
        );
        let ids = plant(&h, 4);
        h.thread.on_asked_blobs_received(&peer, vec![ids[0]; 50]);
        assert_eq!(h.blobs_messages(), vec![1]);
        h.thread.on_asked_blobs_received(&peer, ids[1..].to_vec());
        assert_eq!(h.blobs_messages(), vec![1, 1, 1]);
        // an over-budget ask records zero strikes
        assert_eq!(h.thread.registry.strikes(&peer, UnixMillis::now()), 0);
        // a blob larger than the whole budget is still served once the bucket is full
        let big = h.store.insert_raw(BlobEnvelope::new(
            BlobKind::Bulletin,
            now_ms(),
            vec![],
            vec![1; 1000],
        ));
        h.thread.egress.remove(&peer);
        h.thread.on_asked_blobs_received(&peer, vec![big]);
        assert_eq!(h.blobs_messages(), vec![1, 1, 1, 1]);
        assert!(h.peer_cmds.try_recv().is_err());
    }

    /// Finding 2: a congested (or gone) peer is not served further.
    #[test]
    fn serving_stops_at_the_first_send_error() {
        let peer = new_peer_id();
        let config = PropagationConfig {
            max_blobs_message_bytes: 150,
            ..test_config()
        };
        let mut h = new_retrieval_thread(
            config,
            HashSet::from([peer]),
            Arc::new(FixedTrust::new(1.0)),
        );
        let ids = plant(&h, 3);
        h.fail_sends.store(true, AtomicOrdering::SeqCst);
        h.thread.on_asked_blobs_received(&peer, ids);
        assert_eq!(h.send_attempts.load(AtomicOrdering::SeqCst), 1);
    }

    /// Finding 2: `SyncRequest` pages are budgeted per peer.
    #[test]
    fn sync_requests_are_budgeted() {
        let peer = new_peer_id();
        let config = PropagationConfig {
            peer_sync_requests_per_min: 2,
            ..test_config()
        };
        let mut h = new_retrieval_thread(
            config,
            HashSet::from([peer]),
            Arc::new(FixedTrust::new(1.0)),
        );
        let deserializer = h.thread.deserializer();
        let mut buf = Vec::new();
        BlobMessageSerializer::new()
            .serialize(
                &BlobMessage::SyncRequest {
                    since: UnixMillis(0),
                    cursor: None,
                    max: 1,
                },
                &mut buf,
            )
            .unwrap();
        for _ in 0..3 {
            h.thread.handle_message(&deserializer, peer, &buf);
        }
        assert_eq!(h.sync_ids_messages(), 2);
        assert_eq!(h.thread.registry.strikes(&peer, UnixMillis::now()), 0);
    }

    /// A store whose inserts all return a scripted outcome.
    struct ScriptedStore {
        inner: Arc<MemBlobStore>,
        outcome: StoreOutcome,
    }

    impl BlobStore for ScriptedStore {
        fn validate(
            &self,
            env: &BlobEnvelope,
            now_ms: u64,
            verify_kv_signature: bool,
        ) -> Result<Option<crate::store::KvSigMaterial>, ValidateError> {
            self.inner.validate(env, now_ms, verify_kv_signature)
        }
        fn insert_many_prevalidated(
            &self,
            items: Vec<(BlobEnvelope, BlobSource)>,
            _now_ms: u64,
        ) -> Result<Vec<StoreOutcome>, String> {
            Ok(items.iter().map(|_| self.outcome.clone()).collect())
        }
        fn contains(&self, id: &BlobId) -> bool {
            self.inner.contains(id)
        }
        fn get_many(&self, ids: &[BlobId], max_total_bytes: usize) -> Vec<BlobEnvelope> {
            self.inner.get_many(ids, max_total_bytes)
        }
        fn ids_by_expiry(
            &self,
            from_expires_at: u64,
            cursor: Option<(u64, BlobId)>,
            max: usize,
        ) -> (Vec<BlobId>, Option<(u64, BlobId)>) {
            self.inner.ids_by_expiry(from_expires_at, cursor, max)
        }
        fn retention_ms(&self) -> u64 {
            self.inner.retention_ms()
        }
    }

    /// Finding 5: a blob the store refused is not marked checked: it is silenced for
    /// the rejection TTL only, then asked again.
    #[test]
    fn rejected_blob_is_not_marked_checked_and_is_asked_again_later() {
        let peer = new_peer_id();
        let mem = Arc::new(MemBlobStore::default());
        let store = Arc::new(ScriptedStore {
            inner: mem.clone(),
            outcome: StoreOutcome::Rejected("pool full".into()),
        });
        let mut h = new_retrieval_thread_with_store(
            test_config(),
            HashSet::from([peer]),
            Arc::new(FixedTrust::new(1.0)),
            mem,
            store,
        );
        h.thread.cache.write().rejected_ttl = Duration::from_millis(50);
        let env = BlobEnvelope::new(BlobKind::Bulletin, now_ms(), vec![], vec![7; 10]);
        let id = env.id();
        h.thread
            .note_blobs_from_peer(vec![env], &peer, false)
            .unwrap();
        assert!(h.propagation.try_recv().is_err());
        {
            let cache = h.thread.cache.read();
            assert!(cache.checked_blobs.peek(&id).is_none());
            assert!(cache.is_known(&id));
        }
        h.thread
            .on_announcements_received(vec![id], &peer, false)
            .unwrap();
        assert!(h.asks().is_empty());
        std::thread::sleep(Duration::from_millis(60));
        h.thread
            .on_announcements_received(vec![id], &peer, false)
            .unwrap();
        assert_eq!(h.asks(), vec![(peer, 1)]);
    }

    /// Finding 5: an identical payload stored again with a later expiry is reported
    /// `Inserted` under its new id and must be propagated.
    #[test]
    fn replacement_reported_as_inserted_is_propagated() {
        let peer = new_peer_id();
        let mem = Arc::new(MemBlobStore::default());
        let old = BlobEnvelope::new(BlobKind::Hash, now_ms() - 60_000, vec![], vec![9; 16]);
        mem.insert_raw(old.clone());
        let newer = BlobEnvelope::new(BlobKind::Hash, now_ms(), vec![], vec![9; 16]);
        let new_id = newer.id();
        let store = Arc::new(ScriptedStore {
            inner: mem.clone(),
            outcome: StoreOutcome::Inserted(new_id),
        });
        let mut h = new_retrieval_thread_with_store(
            test_config(),
            HashSet::from([peer]),
            Arc::new(FixedTrust::new(1.0)),
            mem,
            store,
        );
        h.thread.cache.write().insert_checked_blob(old.id());
        h.thread
            .note_blobs_from_peer(vec![newer], &peer, false)
            .unwrap();
        match h.propagation.try_recv().unwrap() {
            PropagationCommand::PropagateBlobs(ids) => assert_eq!(ids, vec![new_id]),
            other => panic!("unexpected {:?}", other),
        }
        assert!(h.thread.cache.read().is_known(&new_id));
    }

    /// Requesting side: an ask nobody answers is retried with backoff, from the
    /// announcer asked longest ago, and stops once the blob is stored.
    #[test]
    fn unanswered_ask_is_retried_from_the_least_recently_asked_announcer() {
        let (peer_a, peer_b) = (new_peer_id(), new_peer_id());
        let config = PropagationConfig {
            batch_proc_period_ms: 20,
            ..PropagationConfig::default()
        };
        let mut h = new_retrieval_thread(
            config,
            HashSet::from([peer_a, peer_b]),
            Arc::new(FixedTrust::new(1.0)),
        );
        let env = BlobEnvelope::new(BlobKind::Bulletin, now_ms(), vec![], vec![3; 10]);
        let id = env.id();
        h.thread
            .on_announcements_received(vec![id], &peer_a, false)
            .unwrap();
        std::thread::sleep(Duration::from_millis(30));
        h.thread
            .on_announcements_received(vec![id], &peer_b, false)
            .unwrap();
        let askers = |h: &Harness| h.asks().iter().map(|(p, _)| *p).collect::<Vec<_>>();
        assert_eq!(askers(&h), vec![peer_a, peer_b]);
        // first retry after 10 periods (200 ms): the least recently asked announcer
        std::thread::sleep(Duration::from_millis(220));
        h.thread.retry_unanswered_asks();
        assert_eq!(askers(&h), vec![peer_a, peer_b, peer_a]);
        // second retry after a doubled delay: the other announcer
        std::thread::sleep(Duration::from_millis(420));
        h.thread.retry_unanswered_asks();
        assert_eq!(askers(&h), vec![peer_a, peer_b, peer_a, peer_b]);
        // once stored, no more retries
        h.store.insert_raw(env);
        std::thread::sleep(Duration::from_millis(820));
        h.thread.retry_unanswered_asks();
        assert_eq!(h.asks().len(), 4);
        assert!(h.thread.ask_retries.is_empty());
    }

    /// Receiving side: blobs answering our asks are never a strike; past our ingest
    /// budget they are dropped and asks to that peer pause until it refills.
    #[test]
    fn solicited_blobs_over_ingest_budget_are_dropped_without_strike() {
        let peer = new_peer_id();
        let config = PropagationConfig {
            peer_ingest_blobs_per_min: 8,
            ..test_config()
        };
        let mut h = new_retrieval_thread(
            config,
            HashSet::from([peer]),
            Arc::new(FixedTrust::new(1.0)),
        );
        let envs: Vec<BlobEnvelope> = (0..12u8)
            .map(|i| BlobEnvelope::new(BlobKind::Bulletin, now_ms(), vec![], vec![i; 10]))
            .collect();
        let ids: Vec<BlobId> = envs.iter().map(|e| e.id()).collect();
        h.thread
            .on_announcements_received(ids.clone(), &peer, false)
            .unwrap();
        assert_eq!(h.asks(), vec![(peer, 12)]);
        h.thread.note_blobs_from_peer(envs, &peer, false).unwrap();
        assert_eq!(h.store.len(), 8);
        assert_eq!(h.thread.registry.strikes(&peer, UnixMillis::now()), 0);
        assert!(h.peer_cmds.try_recv().is_err());
        assert!(h.thread.ingest_paused_until.contains_key(&peer));
        // the dropped blobs are not marked known: they will be asked again
        assert!(!h.thread.cache.read().is_known(&ids[11]));
        // while paused, a new announcement from that peer is deferred, not asked
        let newer = BlobEnvelope::new(BlobKind::Bulletin, now_ms(), vec![], vec![99; 10]);
        h.thread
            .on_announcements_received(vec![newer.id()], &peer, false)
            .unwrap();
        assert_eq!(h.asks().len(), 1);
        assert_eq!(h.thread.blob_batch_buffer.len(), 1);
    }

    /// Receiving side: unsolicited blobs beyond the small allowance are dropped and
    /// counted as flooding.
    #[test]
    fn unsolicited_blobs_beyond_allowance_are_struck() {
        let peer = new_peer_id();
        let mut h = new_retrieval_thread(
            test_config(),
            HashSet::from([peer]),
            Arc::new(FixedTrust::new(1.0)),
        );
        let envs: Vec<BlobEnvelope> = (0..10u8)
            .map(|i| BlobEnvelope::new(BlobKind::Bulletin, now_ms(), vec![], vec![i; 10]))
            .collect();
        h.thread.note_blobs_from_peer(envs, &peer, false).unwrap();
        assert_eq!(h.store.len(), UNSOLICITED_BLOBS_PER_MIN as usize);
        assert_eq!(h.thread.registry.strikes(&peer, UnixMillis::now()), 1);
    }

    /// Unsolicited `SyncIds` (a peer we never synced with) is a protocol violation;
    /// a late page of a finished sync is ignored without penalty.
    #[test]
    fn summaries_outside_a_compact_link_up_are_struck() {
        let peer = new_peer_id();
        let mut h = new_retrieval_thread(
            test_config(),
            HashSet::from([peer]),
            Arc::new(FixedTrust::new(1.0)),
        );
        let deserializer = h.thread.deserializer();
        let mut buf = Vec::new();
        BlobMessageSerializer::new()
            .serialize(&BlobMessage::HaveSummary(Gcs::encode(vec![1], 8)), &mut buf)
            .unwrap();
        h.thread.handle_message(&deserializer, peer, &buf);
        assert_eq!(h.thread.registry.strikes(&peer, UnixMillis::now()), 2);
        // once, and well formed, on a compact link
        h.thread.link_ups.insert(
            peer,
            LinkUp {
                key: [0; 32],
                since: Instant::now(),
                have_received: false,
                wanted_received: false,
            },
        );
        h.thread.handle_message(&deserializer, peer, &buf);
        assert_eq!(h.thread.registry.strikes(&peer, UnixMillis::now()), 2);
        h.thread.handle_message(&deserializer, peer, &buf);
        assert_eq!(h.thread.registry.strikes(&peer, UnixMillis::now()), 4);
        let mut bad = Vec::new();
        BlobMessageSerializer::new()
            .serialize(
                &BlobMessage::WantedSummary {
                    // decodes to a value at or above n × 2^p
                    set: Gcs {
                        n: 1,
                        ..Gcs::encode(vec![1 << 8], 8)
                    },
                    hops: vec![1],
                    lifetimes: vec![1],
                },
                &mut bad,
            )
            .unwrap();
        h.thread.handle_message(&deserializer, peer, &bad);
        assert_eq!(h.thread.registry.strikes(&peer, UnixMillis::now()), 6);
    }

    #[test]
    fn unsolicited_sync_ids_are_struck_but_late_pages_are_not() {
        let (peer, stranger) = (new_peer_id(), new_peer_id());
        let mut h = new_retrieval_thread(
            test_config(),
            HashSet::from([peer, stranger]),
            Arc::new(FixedTrust::new(1.0)),
        );
        let deserializer = h.thread.deserializer();
        let mut buf = Vec::new();
        BlobMessageSerializer::new()
            .serialize(
                &BlobMessage::SyncIds {
                    ids: vec![new_id(1)],
                    next: None,
                },
                &mut buf,
            )
            .unwrap();
        h.thread.handle_message(&deserializer, stranger, &buf);
        assert_eq!(h.thread.registry.strikes(&stranger, UnixMillis::now()), 2);
        h.thread.on_peer_connected(peer);
        h.thread.handle_message(&deserializer, peer, &buf); // completes the sync
        h.thread.handle_message(&deserializer, peer, &buf); // late duplicate
        assert_eq!(h.thread.registry.strikes(&peer, UnixMillis::now()), 0);
    }

    #[test]
    fn budget_buckets_allow_one_oversized_item_when_full_and_compute_waits() {
        let now = Instant::now();
        let mut b = IngestBudget::full(100.0, 10.0, now);
        assert!(!b.try_consume(150.0, 1.0, 100.0, 10.0, now));
        assert!(b.try_consume_allow_full(150.0, 1.0, 100.0, 10.0, now));
        assert!(!b.try_consume_allow_full(1.0, 0.0, 100.0, 10.0, now));
        // 50 bytes missing out of 100 per minute: at least 30 s, capped at the pause
        let wait = b.wait_for(100.0, 0.0, 100.0, 10.0);
        assert!(wait >= Duration::from_secs(59) && wait <= MAX_INGEST_PAUSE);
        assert_eq!(
            ask_retry_delay(Duration::from_millis(500), 0),
            Duration::from_secs(5)
        );
        assert_eq!(
            ask_retry_delay(Duration::from_millis(500), 10),
            ASK_RETRY_MAX_DELAY
        );
    }
}
