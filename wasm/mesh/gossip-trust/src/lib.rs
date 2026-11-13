//! Trust-proof protocol for the Gossip P2P backend.
//!
//! When two nodes connect, each side advertises the *trust schemes* it accepts, each
//! with a fresh challenge; the other side answers with proofs for the schemes it can
//! satisfy; the verifier folds what it could verify into one scalar *trust value* in
//! `0.0..=1.0` that the network layer uses to allocate connection slots, bandwidth and
//! storage. A peer that proves nothing is still served, at the lowest priority.
//!
//! This crate fixes the interface ([`TrustScheme`]), the policy that folds proofs into
//! a value ([`TrustPolicy`], [`TrustRegistry`]), the anti-Sybil [`NullifierRegistry`]
//! (one peer per underlying identity per scope), and one small built-in scheme
//! ([`schemes::pow`]). Substantive schemes (keyring membership, Massa stake) live in
//! their own crates and only implement the trait.
//!
//! Nothing here is specific to messaging: any application that must prioritise peers
//! under Sybil and spam pressure can use it with its own schemes.

#![warn(missing_docs)]

pub mod behaviour;
pub mod nullifier;
pub mod policy;
pub mod record;
pub mod registry;
pub mod scheme;
pub mod schemes;

pub use behaviour::{BehaviourLedger, Misbehaviour};
pub use nullifier::{NullifierCollision, NullifierRegistry};
pub use policy::TrustPolicy;
pub use record::{trust_bucket, TrustRecord, TRUST_BUCKETS};
pub use registry::{TrustRegistry, VerifyFailure};
pub use scheme::{
    binding_message, ids, Role, SessionCtx, Tag, TrustError, TrustScheme, Verified,
    EXPENSIVE_PROVE_COST, EXPENSIVE_VERIFY_COST,
};

pub use gossip_wire::{PeerId, SchemeId, TrustChallenge, TrustProof, TrustVerdict, UnixMillis};
