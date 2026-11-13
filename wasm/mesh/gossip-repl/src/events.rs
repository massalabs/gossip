//! What the replication engine reports and asks for outside itself.

use gossip_wire::{BlobId, PeerId};

/// A message received from a peer, still serialized, without its type id prefix.
pub type PeerMessageTuple = (PeerId, Vec<u8>);

/// Something that happened on the network.
#[derive(Clone, Debug, PartialEq)]
pub enum NetEvent {
    /// Blobs received from peers were validated and stored.
    BlobsStored(Vec<BlobId>),
    /// A peer completed its handshake.
    PeerConnected {
        /// The peer.
        peer: PeerId,
        /// Its effective trust at connection time.
        trust: f64,
    },
    /// A peer is gone.
    PeerDisconnected(PeerId),
    /// A peer was banned (misbehaviour or operator request).
    PeerBanned(PeerId),
}

/// Commands to whatever manages the peers (the PeerNet peer handler, or the mesh link
/// manager).
#[derive(Clone, Debug)]
pub enum PeerManagementCmd {
    /// Disconnect these peers and refuse them.
    Ban(Vec<PeerId>),
    /// Lift the ban on these peers.
    Unban(Vec<PeerId>),
    /// Stop the peer manager.
    Stop,
}
