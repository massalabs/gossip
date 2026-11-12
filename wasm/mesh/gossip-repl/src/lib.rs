//! Gossip P2P backend: blob replication over any link.
//!
//! This crate holds the part of the network layer that does not depend on how bytes
//! travel: blob announcement, asks with fallbacks, delivery, anti-entropy
//! synchronisation, per-neighbour known sets and trust-scaled budgets. It runs over
//! [`Links`], which `gossip-net` implements for PeerNet TCP connections, the mobile node
//! for BLE connections, and [`mem`] in memory for tests.
//!
//! The code comes from `massa-protocol-worker`'s operation handler, by way of
//! `gossip-net`, where it lived before the mesh work (see `docs/MESH.md`).
//!
//! * [`handler::BlobHandler`]: the retrieval and propagation threads;
//! * [`BlobStore`]: what the engine needs as blob storage;
//! * [`Links`] / [`LinkInfo`] / [`LinkKind`]: what it needs from the links;
//! * [`PeerTrust`]: how it reads the trust of a peer;
//! * [`NetEvent`] / [`PeerManagementCmd`]: what it reports and asks for.

#![warn(missing_docs)]

pub mod config;
pub mod error;
pub mod events;
#[allow(missing_docs)]
pub mod handler;
pub mod limits;
pub mod link;
pub mod mem;
pub mod mesh;
pub mod sig_verifier;
pub mod store;
pub mod trust;

pub use config::PropagationConfig;
pub use error::ReplError;
pub use events::{NetEvent, PeerManagementCmd, PeerMessageTuple};
pub use limits::{ingest_scale, PeerLimitsTable, UNSOLICITED_BLOBS_PER_MIN};
pub use link::{LinkInfo, LinkKind, Links};
pub use mesh::{MeshClock, MeshConfig, MeshParts, WantedTable};
pub use store::{
    BlobInfo, BlobSource, BlobStore, KvSigMaterial, MemBlobStore, MemStoreConfig, StoreOutcome,
    ValidateError,
};
pub use trust::{FixedTrust, PeerTrust};
