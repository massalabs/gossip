//! In-memory links, and a replication node that runs over them.
//!
//! [`MemHub`] connects nodes started with [`MemNode::start`] by plain channels: a sent
//! message is serialized exactly as on a real link, its type id is stripped as the
//! PeerNet dispatcher does, and the rest lands on the receiving node's blob channel. The
//! hub has no handshake and no trust round: the trust of each peer comes from the
//! [`PeerTrust`] the node was started with. Tests and the simulator use it to exercise
//! the replication engine without sockets.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use crossbeam::channel::{bounded, unbounded, Receiver, Sender, TrySendError};
use gossip_trust::TrustRegistry;
use gossip_wire::{
    BlobId, BlobMessageSerializer, Message, MessageTypeId, MessageTypeIdDeserializer,
    MessagesSerializer, PeerId,
};
use massa_serialization::{DeserializeError, Deserializer};
use parking_lot::{Mutex, RwLock};

use crate::config::PropagationConfig;
use crate::error::ReplError;
use crate::events::{NetEvent, PeerManagementCmd, PeerMessageTuple};
use crate::handler::{
    cache::BlobCache, commands_propagation::PropagationCommand,
    commands_retrieval::RetrievalCommand, BlobHandler,
};
use crate::limits::PeerLimitsTable;
use crate::link::{LinkInfo, LinkKind, Links};
use crate::mesh::MeshParts;
use crate::store::BlobStore;
use crate::trust::PeerTrust;

/// Capacity of a node's inbound message channel.
const INBOUND_CHANNEL_SIZE: usize = 10_000;

struct Endpoint {
    inbound: Sender<PeerMessageTuple>,
    retrieval: Sender<RetrievalCommand>,
}

#[derive(Default)]
struct HubInner {
    endpoints: HashMap<PeerId, Endpoint>,
    links: HashMap<PeerId, HashMap<PeerId, LinkInfo>>,
}

/// Bytes and messages carried by a hub, in both directions.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct HubStats {
    /// Messages delivered.
    pub messages: u64,
    /// Bytes delivered (serialized messages, type id included).
    pub bytes: u64,
}

/// A set of in-memory links between [`MemNode`]s.
#[derive(Default)]
pub struct MemHub {
    inner: RwLock<HubInner>,
    messages: AtomicU64,
    bytes: AtomicU64,
}

impl MemHub {
    /// An empty hub.
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    fn register(&self, peer: PeerId, endpoint: Endpoint) {
        self.inner.write().endpoints.insert(peer, endpoint);
    }

    fn unregister(&self, peer: &PeerId) {
        let neighbours: Vec<PeerId> = self
            .inner
            .read()
            .links
            .get(peer)
            .map(|l| l.keys().copied().collect())
            .unwrap_or_default();
        for other in neighbours {
            self.disconnect(peer, &other);
        }
        self.inner.write().endpoints.remove(peer);
    }

    /// Brings a link up between `a` and `b`, of kind [`LinkKind::Mem`]. Both nodes see a
    /// peer connect, which starts anti-entropy as on a real link. Linking two nodes that
    /// are already linked does nothing.
    pub fn connect(&self, a: &PeerId, b: &PeerId) {
        self.connect_with(
            a,
            b,
            LinkInfo {
                kind: LinkKind::Mem,
                max_message_size: usize::MAX,
                bandwidth_bps: 0,
                compact_link_up: None,
            },
        )
    }

    /// Brings a link up between `a` and `b` with the given properties. A
    /// `compact_link_up` of `Some` (any value) is replaced by the key of this link.
    pub fn connect_with(&self, a: &PeerId, b: &PeerId, mut info: LinkInfo) {
        if a == b {
            return;
        }
        if info.compact_link_up.is_some() {
            info.compact_link_up = Some(gossip_wire::gcs::link_key(a, b));
        }
        let (ra, rb) = {
            let mut inner = self.inner.write();
            if inner.links.get(a).is_some_and(|l| l.contains_key(b)) {
                return;
            }
            let (Some(ea), Some(eb)) = (inner.endpoints.get(a), inner.endpoints.get(b)) else {
                return;
            };
            let (ra, rb) = (ea.retrieval.clone(), eb.retrieval.clone());
            inner.links.entry(*a).or_default().insert(*b, info);
            inner.links.entry(*b).or_default().insert(*a, info);
            (ra, rb)
        };
        let _ = ra.try_send(RetrievalCommand::PeerConnected(*b));
        let _ = rb.try_send(RetrievalCommand::PeerConnected(*a));
    }

    /// Takes the link between `a` and `b` down, if it is up.
    pub fn disconnect(&self, a: &PeerId, b: &PeerId) {
        let (ra, rb) = {
            let mut inner = self.inner.write();
            let was_up = inner.links.get_mut(a).and_then(|l| l.remove(b)).is_some();
            inner.links.get_mut(b).and_then(|l| l.remove(a));
            if !was_up {
                return;
            }
            (
                inner.endpoints.get(a).map(|e| e.retrieval.clone()),
                inner.endpoints.get(b).map(|e| e.retrieval.clone()),
            )
        };
        if let Some(ra) = ra {
            let _ = ra.try_send(RetrievalCommand::PeerDisconnected(*b));
        }
        if let Some(rb) = rb {
            let _ = rb.try_send(RetrievalCommand::PeerDisconnected(*a));
        }
    }

    /// Whether a link between `a` and `b` is up.
    pub fn is_linked(&self, a: &PeerId, b: &PeerId) -> bool {
        self.inner
            .read()
            .links
            .get(a)
            .is_some_and(|l| l.contains_key(b))
    }

    /// Peers linked to `peer`.
    pub fn neighbours(&self, peer: &PeerId) -> HashSet<PeerId> {
        self.inner
            .read()
            .links
            .get(peer)
            .map(|l| l.keys().copied().collect())
            .unwrap_or_default()
    }

    /// Traffic carried so far.
    pub fn stats(&self) -> HubStats {
        HubStats {
            messages: self.messages.load(Ordering::Relaxed),
            bytes: self.bytes.load(Ordering::Relaxed),
        }
    }

    fn deliver(&self, from: &PeerId, to: &PeerId, frame: Vec<u8>) -> Result<(), ReplError> {
        let inbound = {
            let inner = self.inner.read();
            if !inner.links.get(from).is_some_and(|l| l.contains_key(to)) {
                return Err(ReplError::PeerDisconnected(to.to_string()));
            }
            match inner.endpoints.get(to) {
                Some(e) => e.inbound.clone(),
                None => return Err(ReplError::PeerDisconnected(to.to_string())),
            }
        };
        let (rest, id) = MessageTypeIdDeserializer::new()
            .deserialize::<DeserializeError>(&frame)
            .map_err(|e| ReplError::SendError(format!("bad type id: {e}")))?;
        if id != MessageTypeId::Blob {
            // peer management does not exist on in-memory links
            return Ok(());
        }
        self.messages.fetch_add(1, Ordering::Relaxed);
        self.bytes.fetch_add(frame.len() as u64, Ordering::Relaxed);
        match inbound.try_send((*from, rest.to_vec())) {
            Ok(()) => Ok(()),
            Err(TrySendError::Full(_)) => Err(ReplError::SendError("inbound full".into())),
            Err(TrySendError::Disconnected(_)) => Err(ReplError::PeerDisconnected(to.to_string())),
        }
    }
}

/// The [`Links`] of one node on a [`MemHub`].
#[derive(Clone)]
pub struct MemLinks {
    me: PeerId,
    hub: Arc<MemHub>,
}

impl MemLinks {
    /// The links of `me` on `hub`.
    pub fn new(me: PeerId, hub: Arc<MemHub>) -> Self {
        Self { me, hub }
    }
}

impl Links for MemLinks {
    fn send_to_peer(
        &self,
        peer_id: &PeerId,
        message_serializer: &MessagesSerializer,
        message: Message,
        _high_priority: bool,
    ) -> Result<(), ReplError> {
        let mut frame = Vec::new();
        message_serializer
            .serialize_message(&message, &mut frame)
            .map_err(|e| ReplError::SendError(e.to_string()))?;
        self.hub.deliver(&self.me, peer_id, frame)
    }

    fn clone_box(&self) -> Box<dyn Links> {
        Box::new(self.clone())
    }

    fn get_peer_ids_connected(&self) -> HashSet<PeerId> {
        self.hub.neighbours(&self.me)
    }

    fn link_info(&self, peer_id: &PeerId) -> Option<LinkInfo> {
        self.hub
            .inner
            .read()
            .links
            .get(&self.me)
            .and_then(|l| l.get(peer_id).copied())
    }
}

/// What a [`MemNode`] needs besides its hub.
pub struct MemNodeParts {
    /// The node's peer id.
    pub peer_id: PeerId,
    /// Blob storage.
    pub store: Arc<dyn BlobStore>,
    /// Replication tuning.
    pub config: PropagationConfig,
    /// Trust of the node's peers.
    pub trust: Arc<dyn PeerTrust>,
    /// Trust registry (strikes are recorded there).
    pub registry: Arc<TrustRegistry>,
    /// Mesh behaviour ([`MeshParts::disabled`] replicates everything, as a server).
    pub mesh: MeshParts,
}

/// A replication engine running over a [`MemHub`].
pub struct MemNode {
    peer_id: PeerId,
    hub: Arc<MemHub>,
    handler: BlobHandler,
    propagation: Sender<PropagationCommand>,
    events: Receiver<NetEvent>,
    peer_cmds: Receiver<PeerManagementCmd>,
    banned: Mutex<HashSet<PeerId>>,
    mesh: MeshParts,
}

impl MemNode {
    /// Starts the retrieval and propagation threads of a node on `hub`.
    pub fn start(hub: Arc<MemHub>, parts: MemNodeParts) -> Self {
        let (inbound_tx, inbound_rx) = bounded(INBOUND_CHANNEL_SIZE);
        let (retrieval_tx, retrieval_rx) = unbounded();
        let (propagation_tx, propagation_rx) = unbounded();
        let (peer_cmd_tx, peer_cmd_rx) = unbounded();
        let (events_tx, events_rx) = unbounded();
        hub.register(
            parts.peer_id,
            Endpoint {
                inbound: inbound_tx,
                retrieval: retrieval_tx.clone(),
            },
        );
        let cache = Arc::new(RwLock::new(BlobCache::new(
            u32::try_from(parts.config.max_known_blobs_size).unwrap_or(u32::MAX),
            u32::try_from(parts.config.max_peer_known_blobs_size).unwrap_or(u32::MAX),
        )));
        let handler = BlobHandler::new(
            parts.store,
            parts.config,
            cache,
            Box::new(MemLinks::new(parts.peer_id, hub.clone())),
            inbound_rx,
            (retrieval_tx, retrieval_rx),
            (propagation_tx.clone(), propagation_rx),
            peer_cmd_tx,
            parts.trust,
            parts.registry,
            events_tx,
            PeerLimitsTable::new(),
            parts.mesh.clone(),
        );
        Self {
            peer_id: parts.peer_id,
            hub,
            handler,
            propagation: propagation_tx,
            events: events_rx,
            peer_cmds: peer_cmd_rx,
            banned: Mutex::new(HashSet::new()),
            mesh: parts.mesh,
        }
    }

    /// The node's peer id.
    pub fn peer_id(&self) -> PeerId {
        self.peer_id
    }

    /// Announces blobs already in the store (a local insert).
    pub fn propagate(&self, ids: Vec<BlobId>) {
        let _ = self
            .propagation
            .try_send(PropagationCommand::PropagateBlobs(ids));
    }

    /// Announces stored blobs that somebody in the mesh waits for, at once.
    pub fn propagate_wanted(&self, ids: Vec<BlobId>) {
        let _ = self
            .propagation
            .try_send(PropagationCommand::PropagateWanted(ids));
    }

    /// The node's mesh parts (clock, wanted table).
    pub fn mesh(&self) -> &MeshParts {
        &self.mesh
    }

    /// Events reported by the engine.
    pub fn events(&self) -> &Receiver<NetEvent> {
        &self.events
    }

    /// Applies the bans the engine asked for: the hub links to banned peers go down.
    /// Returns the peers banned by this call.
    pub fn apply_peer_commands(&self) -> Vec<PeerId> {
        let mut newly = Vec::new();
        while let Ok(cmd) = self.peer_cmds.try_recv() {
            if let PeerManagementCmd::Ban(peers) = cmd {
                for peer in peers {
                    self.hub.disconnect(&self.peer_id, &peer);
                    if self.banned.lock().insert(peer) {
                        newly.push(peer);
                    }
                }
            }
        }
        newly
    }

    /// Stops the threads and leaves the hub.
    pub fn stop(mut self) {
        self.hub.unregister(&self.peer_id);
        self.handler.stop();
    }
}

/// A [`MessagesSerializer`] that serializes blob messages, as the engine installs.
pub fn blob_messages_serializer() -> MessagesSerializer {
    MessagesSerializer::new().with_blob_message_serializer(BlobMessageSerializer::new())
}
