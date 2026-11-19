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
//! - [`Root`]: the signed root of an epoch, its validation and verification (§4).
//! - [`Leave`], [`Kick`], [`Dissolve`]: the signed objects (§5.3, §5.6, §5.8).
//! - [`MessageEvent`]: the message event and its result projection (§6).
//! - [`wire`]: the plaintext, container, frames and event blobs (§13, Appendix C).

#![warn(missing_docs)]

pub mod cbor;
pub mod constants;
mod error;
mod event;
pub mod hash;
mod ids;
mod keys;
mod root;
mod signed;
pub mod wire;

#[cfg(test)]
mod test_support;

pub use error::{Error, Result};
pub use event::{
    Body, Content, MessageEvent, MessageType, Payload, ReplyTarget, decode_reply_to,
    encode_reply_to,
};
pub use ids::{
    Challenge, ChatId, DissolveId, EventId, GossipId, GroupSecret, KickId, LeaveId,
    ParentCommitment, RefChatId, RequestId, ScanId, SecretProof, SyncObjId,
};
pub use keys::{SignatureBytes, check_key_answer, parse_user_public_keys};
pub use root::{ReceiveContext, Root, RootParams, RootType, next_root_created_at};
pub use signed::{Dissolve, Kick, Leave};
pub use wire::EventObject;
