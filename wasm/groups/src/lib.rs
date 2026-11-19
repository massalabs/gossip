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
//! - [`cbor`]: the deterministic CBOR encoding of hash projections (§1.2).

#![warn(missing_docs)]

pub mod cbor;
pub mod constants;
