//! Gossip P2P backend: the three replicated message pools every node serves.
//!
//! From the Gossip technical paper, a node stores three pools of opaque,
//! client-encrypted blobs ([`gossip_wire::BlobEnvelope`]):
//!
//! * the **counter-indexed pool** ([`gossip_wire::BlobKind::Bulletin`], announcements):
//!   each node assigns a local, strictly increasing `u64` counter at insert time so
//!   clients can page through everything that arrived after a given point;
//! * the **signature-authenticated key-value pool** ([`gossip_wire::BlobKind::KeyValue`],
//!   messages): the key is a 34-byte seeker, the value carries the seeker public key
//!   and a signature over the entry; the first valid writer of a key wins;
//! * the **hash-indexed pool** ([`gossip_wire::BlobKind::Hash`], published public keys):
//!   the key is `blake3(payload)`.
//!
//! Blobs are retained for a fixed period after their `created_at` (default 14 days),
//! capped in size, and the node never interprets their content. Storage is a single
//! [`redb`] file: ACID, single writer, concurrent readers. See [`schema`] for the
//! on-disk layout.
//!
//! The crate is synchronous by design: every call runs one `redb` transaction on the
//! caller's thread. The only thread it ever spawns is the optional maintenance
//! sweeper ([`Pools::start_sweeper`]).

#![warn(missing_docs)]
#![forbid(unsafe_code)]

mod config;
mod error;
mod pools;
pub mod schema;
#[cfg(feature = "blob-store")]
mod store_adapter;
mod sweeper;
mod types;

pub use config::{
    PoolsConfig, DEFAULT_MAX_BULLETIN_PAYLOAD_LEN, DEFAULT_MAX_HASH_PAYLOAD_LEN,
    DEFAULT_MAX_TOTAL_BYTES, DEFAULT_MESH_MAX_BLOB_COUNT, DEFAULT_MESH_MAX_BYTES,
    DEFAULT_MESH_MAX_FUTURE_SKEW_MS, DEFAULT_MESH_RETENTION_MS, DEFAULT_RETENTION_MS,
};
pub use error::PoolError;
pub use pools::Pools;
#[cfg(feature = "blob-store")]
pub use store_adapter::PoolsStore;
pub use sweeper::SweeperHandle;
pub use types::{ExpiryCursor, InsertOutcome, KvSigMaterial, PoolStats, RejectReason, Source};

pub use gossip_wire::{BlobEnvelope, BlobId, BlobKind, KvError, Scope};

/// Current unix time in milliseconds (0 if the clock is before the epoch).
pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
        .unwrap_or(0)
}
