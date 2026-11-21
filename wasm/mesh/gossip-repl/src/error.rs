//! Error type of the replication engine.

use thiserror::Error;

/// Errors produced by the replication engine and by links.
#[non_exhaustive]
#[derive(Error, Debug)]
pub enum ReplError {
    /// Sending to a peer failed (congested or gone).
    #[error("send error: {0}")]
    SendError(String),
    /// The peer is not connected.
    #[error("peer disconnected: {0}")]
    PeerDisconnected(String),
    /// A signature did not verify.
    #[error("wrong signature")]
    WrongSignature,
    /// Blob store failure.
    #[error("store error: {0}")]
    Store(String),
    /// Time computation overflowed.
    #[error("time overflow")]
    TimeOverflow,
}
