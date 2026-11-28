// Vendored from massa-protocol-worker/src/handlers/operation_handler/commands_propagation.rs and adapted for Gossip.

use gossip_wire::BlobId;

#[derive(Clone, Debug)]
pub enum PropagationCommand {
    Stop,
    /// Ids of blobs (already in the store) to announce to peers.
    PropagateBlobs(Vec<BlobId>),
    /// Ids of stored blobs somebody in the mesh waits for: announced at once, with high
    /// priority, on mesh links.
    PropagateWanted(Vec<BlobId>),
}
