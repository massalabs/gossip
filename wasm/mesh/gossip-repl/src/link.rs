//! What the replication engine needs from the links to its peers.
//!
//! A link is a bidirectional, ordered, reliable channel to one authenticated peer: a
//! PeerNet TCP connection (`gossip-net`), a BLE connection (`gossip-mobile`), or an
//! in-memory channel ([`crate::mem`]). The engine sends whole network messages through
//! [`Links`] and receives them, already reassembled, on the `PeerMessageTuple` channel
//! it was started with. See `docs/MESH.md`, "Link abstraction".

use std::collections::HashSet;

use gossip_wire::{Message, MessagesSerializer, PeerId};

use crate::error::ReplError;

/// How a link carries bytes.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum LinkKind {
    /// A PeerNet TCP connection between internet nodes.
    Tcp,
    /// A Bluetooth Low Energy connection between phones.
    Ble,
    /// An in-memory channel (tests and simulation).
    Mem,
}

impl LinkKind {
    /// Whether this is a mesh link (anything but TCP).
    pub fn is_mesh(self) -> bool {
        !matches!(self, LinkKind::Tcp)
    }
}

/// Properties of one link.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LinkInfo {
    /// How the link carries bytes.
    pub kind: LinkKind,
    /// Largest network message the link accepts in one send.
    pub max_message_size: usize,
    /// Bytes per second the link sustains (estimate; 0 = unknown).
    pub bandwidth_bps: u64,
    /// The summary key of the link when both ends exchange summaries as it comes up
    /// instead of a full sync and wanted table (`GMSH.1.1` mesh links, see
    /// `docs/MESH.md`, "Compact link-up"); see [`gossip_wire::gcs::link_key`].
    pub compact_link_up: Option<[u8; 32]>,
}

/// The set of links of a node, as seen by the replication engine.
#[cfg_attr(test, mockall::automock)]
pub trait Links: Send + Sync {
    /// Enqueues one message to `peer_id`. Never blocks: a full queue is an error and the
    /// message is dropped.
    fn send_to_peer(
        &self,
        peer_id: &PeerId,
        message_serializer: &MessagesSerializer,
        message: Message,
        high_priority: bool,
    ) -> Result<(), ReplError>;
    /// A boxed clone sharing the same links.
    fn clone_box(&self) -> Box<dyn Links>;
    /// Peers with a link up (handshake done).
    fn get_peer_ids_connected(&self) -> HashSet<PeerId>;
    /// Properties of the link to `peer_id`, if it is up.
    fn link_info(&self, peer_id: &PeerId) -> Option<LinkInfo>;
}

impl Clone for Box<dyn Links> {
    fn clone(&self) -> Box<dyn Links> {
        self.clone_box()
    }
}
