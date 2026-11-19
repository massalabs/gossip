//! # groups
//!
//! Pure logic of the plausibly deniable group chats protocol
//! (`gossip-sdk/docs/plausibly-deniable-group-chats.md`, wire version 1): identifiers and the
//! hash projection, roots, signed objects, message events, the wire format, and the message
//! state of an epoch with its merge rules and storage records.
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
//! - [`Epoch`]: receiving and merging message events, scheduled versions and deletions,
//!   retention, and local changes (§6.3, §7, §8, §9).
//! - [`store`]: the local records of §14.1 and the storage trait, with an in-memory store.
//! - [`dag`]: tips, the cycle frontier and parent selection (§6.1, §12.1).
//! - [`display`]: visibility, order and the time of a root's line (§7.5).

#![warn(missing_docs)]

pub mod cbor;
pub mod constants;
pub mod dag;
pub mod display;
mod epoch;
mod error;
mod event;
pub mod hash;
mod ids;
mod keys;
pub mod node;
mod redact;
mod rng;
mod root;
mod signed;
pub mod store;
pub mod wire;

#[cfg(test)]
mod sim;
#[cfg(test)]
mod sim_groups;
#[cfg(test)]
mod sim_net;
#[cfg(test)]
mod test_support;

pub use epoch::local::{ChangeError, LocalEdit, Published};
pub use epoch::{
    Epoch, GroupState, MAX_TIMER_WAIT_MS, Merge, Outcome, Received, Rejection, Sender,
};
pub use error::{Error, Result};
pub use event::{
    Body, Content, MessageEvent, MessageType, Payload, ReplyTarget, decode_reply_to,
    encode_reply_to,
};
pub use ids::{
    Challenge, ChatId, DissolveId, EventId, GossipId, GroupSecret, KickId, LeaveId,
    ParentCommitment, RefChatId, RequestId, ScanId, SecretProof, SyncObjId,
};
pub use keys::{
    IdentitySigner, KeySigner, SignatureBytes, Signer, check_key_answer, parse_user_public_keys,
};
pub use rng::Randomness;
pub use root::{ReceiveContext, Root, RootParams, RootType, next_root_created_at};
pub use signed::{Dissolve, Kick, Leave};
pub use wire::EventObject;
