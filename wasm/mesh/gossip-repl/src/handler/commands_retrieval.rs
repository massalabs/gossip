// Vendored from massa-protocol-worker/src/handlers/operation_handler/commands_retrieval.rs and adapted for Gossip.
// Peer connection events (from the connectivity thread's 1 s diff) drive the
// anti-entropy sync and the trust registry's disconnect hook.

use gossip_wire::PeerId;

#[derive(Clone, Debug)]
pub enum RetrievalCommand {
    Stop,
    /// A peer completed its handshake.
    PeerConnected(PeerId),
    /// A peer is gone.
    PeerDisconnected(PeerId),
}
