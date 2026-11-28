//! On-disk layout: `redb` tables and the per-blob metadata record.
//!
//! All tables live in one `redb` file. Ids are the 32-byte [`BlobId`]; `expires_at`
//! and `created_at` are unix milliseconds; `trust_bucket` is `0..=15`.
//!
//! | table            | key                              | value       | purpose |
//! |------------------|----------------------------------|-------------|---------|
//! | `blobs`          | `[u8; 32]` id                    | `&[u8]`     | canonical envelope bytes |
//! | `meta`           | `[u8; 32]` id                    | `&[u8]`     | [`Meta`] record (see below) |
//! | `bulletin`       | `u64` counter                    | `[u8; 32]`  | counter pool, ascending counters |
//! | `bulletin_by_id` | `[u8; 32]` id                    | `u64`       | reverse of `bulletin` |
//! | `kv`             | `&[u8]` seeker key               | `[u8; 32]`  | key-value pool index (first writer wins) |
//! | `hash`           | `[u8; 32]` blake3(payload)       | `[u8; 32]`  | hash pool index |
//! | `expiry`         | `(u64 expires_at, [u8; 32] id)`  | `()`        | sweep order and anti-entropy paging |
//! | `by_trust`       | `(u8 bucket, u64 created_at, [u8; 32] id)` | `()` | eviction order (low bucket, then oldest) |
//! | `mesh_expiry`    | `(u64 expires_at, [u8; 32] id)`  | `()`        | blobs with the `mesh` scope flag: mesh anti-entropy paging |
//! | `upload`         | `[u8; 32]` id                    | `()`        | blobs with the `upload` scope flag, waiting for a bridge |
//! | `counters`       | `&str`                           | `u64`       | `schema_version`, `total_bytes`, `blob_count`, `bulletin_counter`, `checkpoint_ms`, `mesh_bytes`, `mesh_count` |
//!
//! The [`Meta`] record is a fixed-layout big-endian encoding, no serde:
//!
//! ```text
//! received_at u64 ‖ expires_at u64 ‖ created_at u64 ‖ size u32 ‖ trust_bucket u8 ‖ kind u8
//! ‖ index_key_len u8 ‖ index_key ‖ source_peer_len u8 ‖ source_peer ‖ scope u8
//! ```
//!
//! `received_at` is 0 and `source_peer` empty on a store opened without
//! `record_provenance` (phones), so that a blob says nothing of how it reached the node.
//!
//! The trailing `scope` byte holds the [`Scope`] flags. Records written by schema 1
//! have no such byte and read as [`Scope::INTERNET`], so a schema 1 file is opened as
//! is and only its version counter is raised to 2.
//!
//! `index_key` is empty for `Bulletin`, the seeker key for `KeyValue` and
//! `blake3(payload)` for `Hash`; storing it (together with `expires_at` and
//! `created_at`) lets removal touch every index without decoding the envelope, and
//! keeps index removal correct even if `retention_ms` changes between runs.
//! `size` is the envelope wire size ([`gossip_wire::BlobEnvelope::wire_size`]) and is
//! what `total_bytes` accounts.

use gossip_wire::{BlobId, BlobKind, Scope};
use redb::TableDefinition;

use crate::error::PoolError;

/// Version of this layout, stored under `counters["schema_version"]`.
pub const SCHEMA_VERSION: u64 = 2;
/// Oldest layout this crate opens (and upgrades in place).
pub const MIN_SCHEMA_VERSION: u64 = 1;

/// Canonical envelope bytes by id.
pub const BLOBS: TableDefinition<[u8; 32], &[u8]> = TableDefinition::new("blobs");
/// [`Meta`] record by id.
pub const META: TableDefinition<[u8; 32], &[u8]> = TableDefinition::new("meta");
/// Counter pool: counter to id.
pub const BULLETIN: TableDefinition<u64, [u8; 32]> = TableDefinition::new("bulletin");
/// Counter pool: id to counter.
pub const BULLETIN_BY_ID: TableDefinition<[u8; 32], u64> = TableDefinition::new("bulletin_by_id");
/// Key-value pool: seeker key to id.
pub const KV: TableDefinition<&[u8], [u8; 32]> = TableDefinition::new("kv");
/// Hash pool: `blake3(payload)` to id.
pub const HASH: TableDefinition<[u8; 32], [u8; 32]> = TableDefinition::new("hash");
/// `(expires_at, id)` set.
pub const EXPIRY: TableDefinition<(u64, [u8; 32]), ()> = TableDefinition::new("expiry");
/// `(trust_bucket, created_at, id)` set.
pub const BY_TRUST: TableDefinition<(u8, u64, [u8; 32]), ()> = TableDefinition::new("by_trust");
/// `(expires_at, id)` set of blobs whose scope has `mesh`.
pub const MESH_EXPIRY: TableDefinition<(u64, [u8; 32]), ()> = TableDefinition::new("mesh_expiry");
/// Ids of blobs whose scope has `upload`.
pub const UPLOAD: TableDefinition<[u8; 32], ()> = TableDefinition::new("upload");
/// Ids of blobs the local app sent, in development builds of schema 2. No longer
/// written: [`crate::Pools`] deletes it on open (see [`crate::Pools::had_own_marks`]).
pub const LEGACY_OWN_UPLOAD: TableDefinition<[u8; 32], ()> = TableDefinition::new("own_upload");
/// Named `u64` counters.
pub const COUNTERS: TableDefinition<&str, u64> = TableDefinition::new("counters");

/// `counters` key: schema version.
pub const COUNTER_SCHEMA_VERSION: &str = "schema_version";
/// `counters` key: sum of blob wire sizes.
pub const COUNTER_TOTAL_BYTES: &str = "total_bytes";
/// `counters` key: number of blobs.
pub const COUNTER_BLOB_COUNT: &str = "blob_count";
/// `counters` key: last assigned bulletin counter.
pub const COUNTER_BULLETIN_COUNTER: &str = "bulletin_counter";
/// `counters` key: unix ms of the last durable checkpoint (only written when
/// `sync_writes` is off; see [`crate::Pools::checkpoint`]).
pub const COUNTER_CHECKPOINT_MS: &str = "checkpoint_ms";
/// `counters` key: sum of the wire sizes of mesh-only blobs.
pub const COUNTER_MESH_BYTES: &str = "mesh_bytes";
/// `counters` key: number of mesh-only blobs.
pub const COUNTER_MESH_COUNT: &str = "mesh_count";

/// Hard cap on the stored index key (one length byte).
pub const MAX_INDEX_KEY_LEN: usize = u8::MAX as usize;
/// Hard cap on the stored peer id (one length byte; [`crate::Source::MAX_PEER_LEN`]).
pub const MAX_PEER_LEN: usize = crate::Source::MAX_PEER_LEN;

const META_FIXED_LEN: usize = 8 + 8 + 8 + 4 + 1 + 1;

/// Per-blob metadata record (see the module docs for the encoding).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Meta {
    /// When this node stored the blob (unix ms).
    pub received_at: u64,
    /// `created_at + retention` at insert time (unix ms).
    pub expires_at: u64,
    /// Envelope `created_at` (unix ms).
    pub created_at: u64,
    /// Envelope wire size.
    pub size: u32,
    /// Trust bucket of the source, `0..=15`.
    pub trust_bucket: u8,
    /// Pool of the blob.
    pub kind: BlobKind,
    /// Index key (empty, seeker key, or `blake3(payload)` depending on `kind`).
    pub index_key: Vec<u8>,
    /// Serialized peer id of the source (empty for local clients).
    pub source_peer: Vec<u8>,
    /// Where the blob may be replicated.
    pub scope: Scope,
}

impl Meta {
    /// Encodes the record. `index_key` and `source_peer` must be at most 255 bytes;
    /// the insert path guarantees it.
    pub fn encode(&self) -> Vec<u8> {
        debug_assert!(self.index_key.len() <= MAX_INDEX_KEY_LEN);
        debug_assert!(self.source_peer.len() <= MAX_PEER_LEN);
        let mut out = Vec::with_capacity(
            META_FIXED_LEN + 1 + self.index_key.len() + 1 + self.source_peer.len() + 1,
        );
        out.extend_from_slice(&self.received_at.to_be_bytes());
        out.extend_from_slice(&self.expires_at.to_be_bytes());
        out.extend_from_slice(&self.created_at.to_be_bytes());
        out.extend_from_slice(&self.size.to_be_bytes());
        out.push(self.trust_bucket);
        out.push(self.kind as u8);
        out.push(self.index_key.len() as u8);
        out.extend_from_slice(&self.index_key);
        out.push(self.source_peer.len() as u8);
        out.extend_from_slice(&self.source_peer);
        out.push(self.scope.0);
        out
    }

    /// Decodes a record written by [`Meta::encode`].
    pub fn decode(bytes: &[u8]) -> Result<Self, PoolError> {
        let bad = || PoolError::corrupted("meta record");
        if bytes.len() < META_FIXED_LEN + 2 {
            return Err(bad());
        }
        let u64_at =
            |off: usize| u64::from_be_bytes(bytes[off..off + 8].try_into().expect("8 bytes"));
        let received_at = u64_at(0);
        let expires_at = u64_at(8);
        let created_at = u64_at(16);
        let size = u32::from_be_bytes(bytes[24..28].try_into().expect("4 bytes"));
        let trust_bucket = bytes[28];
        let kind = BlobKind::from_u8(bytes[29]).ok_or_else(bad)?;
        let mut off = META_FIXED_LEN;
        let ik_len = bytes[off] as usize;
        off += 1;
        let index_key = bytes.get(off..off + ik_len).ok_or_else(bad)?.to_vec();
        off += ik_len;
        let peer_len = *bytes.get(off).ok_or_else(bad)? as usize;
        off += 1;
        let source_peer = bytes.get(off..off + peer_len).ok_or_else(bad)?.to_vec();
        off += peer_len;
        // schema 1 records end here; schema 2 adds the scope byte
        let scope = match bytes.len() - off {
            0 => Scope::INTERNET,
            1 => Scope::from_byte(bytes[off]),
            _ => return Err(bad()),
        };
        Ok(Self {
            received_at,
            expires_at,
            created_at,
            size,
            trust_bucket,
            kind,
            index_key,
            source_peer,
            scope,
        })
    }

    /// Key of this blob in the `expiry` table.
    pub fn expiry_key(&self, id: &BlobId) -> (u64, [u8; 32]) {
        (self.expires_at, *id.as_bytes())
    }

    /// Key of this blob in the `by_trust` table.
    pub fn trust_key(&self, id: &BlobId) -> (u8, u64, [u8; 32]) {
        (self.trust_bucket, self.created_at, *id.as_bytes())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn meta_roundtrip() {
        let m = Meta {
            received_at: 1,
            expires_at: 2,
            created_at: 3,
            size: 4,
            trust_bucket: 5,
            kind: BlobKind::KeyValue,
            index_key: vec![7; 34],
            source_peer: vec![9; 64],
            scope: Scope::MESH | Scope::UPLOAD,
        };
        let bytes = m.encode();
        assert_eq!(Meta::decode(&bytes).unwrap(), m);
        // a schema 1 record (no scope byte) reads as internet
        let v1 = Meta::decode(&bytes[..bytes.len() - 1]).unwrap();
        assert_eq!(v1.scope, Scope::INTERNET);
        assert_eq!(v1.source_peer, m.source_peer);
        // truncated / trailing garbage / bad kind
        assert!(Meta::decode(&bytes[..bytes.len() - 2]).is_err());
        let mut longer = bytes.clone();
        longer.push(0);
        assert!(Meta::decode(&longer).is_err());
        let mut bad_kind = bytes.clone();
        bad_kind[29] = 9;
        assert!(Meta::decode(&bad_kind).is_err());
        assert!(Meta::decode(&[]).is_err());
    }
}
