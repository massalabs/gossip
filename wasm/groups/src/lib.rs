//! # groups
//!
//! Pure logic of the plausibly deniable group chats protocol
//! (`gossip-sdk/docs/plausibly-deniable-group-chats.md`, wire version 1): identifiers and the
//! hash projection, roots, signed objects, message events and the wire format.
//!
//! The crate does no I/O: no network, no clock, no randomness source and no storage.
//! Randomness (secrets, challenges, event IDs, signing randomness) and the current time are
//! arguments.
//!
//! - [`hash`]: `H(domain, ...) = BLAKE3(CBOR([domain, ...]))` and every derived ID (§1.2, §3).

#![warn(missing_docs)]

pub mod cbor;
pub mod constants;
mod error;
pub mod hash;
mod ids;
mod keys;

#[cfg(test)]
mod test_support;

pub use error::{Error, Result};
pub use ids::{
    Challenge, ChatId, DissolveId, EventId, GossipId, GroupSecret, KickId, LeaveId,
    ParentCommitment, RefChatId, RequestId, ScanId, SecretProof, SyncObjId,
};
pub use keys::{SignatureBytes, check_key_answer, parse_user_public_keys};
