//! Pool configuration.

use std::path::{Path, PathBuf};
use std::time::Duration;

use gossip_wire::{
    prepare_kv_entry, BlobEnvelope, BlobKind, Scope, MAX_BLOB_KEY_LEN, MAX_BLOB_PAYLOAD_LEN,
};
use serde::{Deserialize, Serialize};

use crate::types::{KvSigMaterial, RejectReason};

/// Default retention: 14 days.
pub const DEFAULT_RETENTION_MS: u64 = 14 * 24 * 60 * 60 * 1000;
/// Default tolerated clock skew for `created_at` in the future: 5 minutes.
pub const DEFAULT_MAX_FUTURE_SKEW_MS: u64 = 5 * 60 * 1000;
/// Default payload cap for the hash pool (published key sets are small): 64 KiB.
pub const DEFAULT_MAX_HASH_PAYLOAD_LEN: usize = 64 * 1024;
/// Default payload cap for the counter pool (announcements): 64 KiB.
///
/// Measured from real client data: the two announcements in
/// `gossip-node/tests/fixtures/client-blobs-v1.json` (produced by
/// `wasm/sessions`, empty `user_data`) are 8,970 bytes each. An announcement is
/// `randomness ‖ KEM ciphertext ‖ AEAD(pk_next ‖ bincode(auth_blob, user_data))` with
/// no padding, so it grows 1:1 with `user_data`. The only producer of non-empty
/// `user_data` is the discussion start flow
/// (`gossip-sdk/src/utils/announcementPayload.ts`): massa-web3 `Args` with two
/// strings, each a `u32` length + UTF-8. The UI caps the username at 35 UTF-16 units
/// (`USERNAME_MAX_LENGTH`, at most 105 UTF-8 bytes) and the message at 500 units
/// (`NewContact.tsx`, at most 1,500 UTF-8 bytes), i.e. at most 1,613 bytes of
/// `user_data` plus 2 more bytes of bincode length varint. The largest realistic
/// announcement is therefore about 10,585 bytes; 4x that is about 42.3 KB, rounded
/// up to a power of two: 64 KiB (about 6x headroom). A 50-item announcement page is
/// then bounded by about 3.2 MiB instead of about 500 MiB with the generic 10 MiB cap.
pub const DEFAULT_MAX_BULLETIN_PAYLOAD_LEN: usize = 64 * 1024;
/// Default retention of mesh-only blobs: 72 hours.
pub const DEFAULT_MESH_RETENTION_MS: u64 = 72 * 60 * 60 * 1000;
/// Default tolerated skew for mesh-only blobs: 6 hours (phones without NTP).
pub const DEFAULT_MESH_MAX_FUTURE_SKEW_MS: u64 = 6 * 60 * 60 * 1000;
/// Default storage cap on mesh-only blobs: 64 MiB.
pub const DEFAULT_MESH_MAX_BYTES: u64 = 64 * 1024 * 1024;
/// Default count cap on mesh-only blobs.
pub const DEFAULT_MESH_MAX_BLOB_COUNT: u64 = 20_000;
/// Default total storage cap: 20 GiB.
pub const DEFAULT_MAX_TOTAL_BYTES: u64 = 20 * 1024 * 1024 * 1024;
/// Default blob count cap.
pub const DEFAULT_MAX_BLOB_COUNT: u64 = 10_000_000;

/// Configuration of a [`crate::Pools`] instance.
///
/// All limits are enforced by [`crate::Pools::validate`] (structural limits and the
/// time window) or by the insert path (storage caps). Every field has a documented
/// default; use [`PoolsConfig::with_path`] to point the store at a file.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct PoolsConfig {
    /// Path of the `redb` file. The parent directory is created on open.
    pub path: PathBuf,
    /// Maximum payload length for every kind (default 10 MiB); `Bulletin` and `Hash`
    /// blobs are further capped by their own limits below.
    pub max_payload_len: usize,
    /// Maximum payload length for `Bulletin` blobs (default 64 KiB, see
    /// [`DEFAULT_MAX_BULLETIN_PAYLOAD_LEN`] for how it was chosen).
    pub max_bulletin_payload_len: usize,
    /// Maximum key length (default 128; the seeker key is 34 bytes).
    pub max_key_len: usize,
    /// Maximum payload length for `Hash` blobs (default 64 KiB).
    pub max_hash_payload_len: usize,
    /// Retention after `created_at`, in milliseconds (default 14 days).
    pub retention_ms: u64,
    /// How far in the future `created_at` may be, in milliseconds (default 5 minutes).
    pub max_future_skew_ms: u64,
    /// Retention of mesh-only blobs (scope `mesh` without `internet`), in milliseconds
    /// (default 72 hours). See `docs/MESH.md`.
    pub mesh_retention_ms: u64,
    /// How far in the future a mesh-only blob's `created_at` may be (default 6 hours).
    pub mesh_max_future_skew_ms: u64,
    /// Storage cap on mesh-only blobs (default 64 MiB). Mesh-only blobs are evicted
    /// among themselves, so mesh traffic never pushes internet blobs out.
    pub mesh_max_bytes: u64,
    /// Count cap on mesh-only blobs (default 20 000).
    pub mesh_max_blob_count: u64,
    /// Storage cap on the sum of blob wire sizes (default 20 GiB).
    pub max_total_bytes: u64,
    /// Storage cap on the number of blobs (default 10 million).
    pub max_blob_count: u64,
    /// When over a cap, eviction runs until usage is at or below
    /// `cap * eviction_low_watermark` (default 0.9).
    pub eviction_low_watermark: f64,
    /// Trust buckets at or above this value (0..=15, default 10) are *protected*: they
    /// are only evicted once every lower-bucket blob is gone, and then by age alone
    /// regardless of their exact bucket.
    pub protected_trust_bucket: u8,
    /// Period of the background sweeper (default 60 s).
    pub sweep_interval: Duration,
    /// Maximum number of expired blobs removed per sweep transaction (default 1000).
    pub sweep_batch: usize,
    /// `true` (default): every write transaction is fsynced before it returns.
    ///
    /// `false`: writes are committed without fsync (`redb` `Durability::None`) and
    /// made durable only by checkpoints: one at the end of every sweeper round
    /// ([`crate::Pools::maintain`]), one on clean drop, and any explicit
    /// [`crate::Pools::checkpoint`]. A crash or power loss loses everything since the
    /// last checkpoint (the file itself stays consistent), and bulletin counters
    /// assigned after it may be re-assigned to different blobs after restart, so
    /// clients paging with `bulletin_after` can miss or repeat entries. Use it only
    /// where that trade-off is acceptable (bulk import, benchmarks).
    pub sync_writes: bool,
    /// `true` (default): every blob records when it was stored and the peer it came
    /// from (`received_at`, `source_peer`). `false` (phones): both are left empty, so
    /// that a blob the local app submitted is stored exactly like one a neighbour
    /// relayed (`docs/MESH.md`, "Plausible deniability").
    pub record_provenance: bool,
}

impl Default for PoolsConfig {
    fn default() -> Self {
        Self {
            path: PathBuf::from("pools.redb"),
            max_payload_len: MAX_BLOB_PAYLOAD_LEN,
            max_bulletin_payload_len: DEFAULT_MAX_BULLETIN_PAYLOAD_LEN,
            max_key_len: MAX_BLOB_KEY_LEN,
            max_hash_payload_len: DEFAULT_MAX_HASH_PAYLOAD_LEN,
            retention_ms: DEFAULT_RETENTION_MS,
            max_future_skew_ms: DEFAULT_MAX_FUTURE_SKEW_MS,
            mesh_retention_ms: DEFAULT_MESH_RETENTION_MS,
            mesh_max_future_skew_ms: DEFAULT_MESH_MAX_FUTURE_SKEW_MS,
            mesh_max_bytes: DEFAULT_MESH_MAX_BYTES,
            mesh_max_blob_count: DEFAULT_MESH_MAX_BLOB_COUNT,
            max_total_bytes: DEFAULT_MAX_TOTAL_BYTES,
            max_blob_count: DEFAULT_MAX_BLOB_COUNT,
            eviction_low_watermark: 0.9,
            protected_trust_bucket: 10,
            sweep_interval: Duration::from_secs(60),
            sweep_batch: 1000,
            sync_writes: true,
            record_provenance: true,
        }
    }
}

impl PoolsConfig {
    /// Default configuration stored at `path`.
    pub fn with_path(mut self, path: impl AsRef<Path>) -> Self {
        self.path = path.as_ref().to_path_buf();
        self
    }

    /// Expiry instant of an envelope under this configuration
    /// (`created_at + retention_ms`, saturating).
    pub fn expires_at(&self, env: &BlobEnvelope) -> u64 {
        env.created_at.saturating_add(self.retention_ms)
    }

    /// Expiry of an envelope stored with `scope`: mesh-only blobs use
    /// `mesh_retention_ms`, every other scope `retention_ms`.
    pub fn expires_at_scoped(&self, env: &BlobEnvelope, scope: Scope) -> u64 {
        env.created_at.saturating_add(self.retention_for(scope))
    }

    /// Retention that applies to a blob of `scope`.
    pub fn retention_for(&self, scope: Scope) -> u64 {
        if scope.is_mesh_only() {
            self.mesh_retention_ms
        } else {
            self.retention_ms
        }
    }

    /// Cap scaled by the low watermark (clamped to `0..=1`).
    pub(crate) fn watermark(&self, cap: u64) -> u64 {
        let f = self.eviction_low_watermark.clamp(0.0, 1.0);
        (cap as f64 * f).floor() as u64
    }

    /// Pure structural validation of an envelope against this configuration: size
    /// caps, key rules per kind, the time window and, for `KeyValue`, the entry
    /// layout and key/public-key match.
    ///
    /// For `KeyValue` blobs the signature material is returned so the caller can
    /// verify many signatures at once (`massa_signature::verify_signature_batch`);
    /// when `verify_kv_signature` is `true` the signature is checked here instead and
    /// `Ok(None)` is returned.
    pub fn validate(
        &self,
        env: &BlobEnvelope,
        now_ms: u64,
        verify_kv_signature: bool,
    ) -> Result<Option<KvSigMaterial>, RejectReason> {
        self.validate_scoped(env, now_ms, verify_kv_signature, Scope::INTERNET)
    }

    /// [`PoolsConfig::validate`] for a blob that will be stored with `scope`: a
    /// mesh-only blob gets the mesh time window (`mesh_max_future_skew_ms`,
    /// `mesh_retention_ms`), with `now_ms` read from the node's mesh clock.
    pub fn validate_scoped(
        &self,
        env: &BlobEnvelope,
        now_ms: u64,
        verify_kv_signature: bool,
        scope: Scope,
    ) -> Result<Option<KvSigMaterial>, RejectReason> {
        let max_skew = if scope.is_mesh_only() {
            self.mesh_max_future_skew_ms
        } else {
            self.max_future_skew_ms
        };
        let max_payload = match env.kind {
            BlobKind::Hash => self.max_hash_payload_len.min(self.max_payload_len),
            BlobKind::Bulletin => self.max_bulletin_payload_len.min(self.max_payload_len),
            BlobKind::KeyValue => self.max_payload_len,
        };
        if env.payload.len() > max_payload {
            return Err(RejectReason::PayloadTooLarge);
        }
        if env.key.len() > self.max_key_len {
            return Err(RejectReason::KeyTooLarge);
        }
        if matches!(env.kind, BlobKind::Bulletin | BlobKind::Hash) && !env.key.is_empty() {
            return Err(RejectReason::KeyNotAllowed);
        }
        if env.created_at > now_ms.saturating_add(max_skew) {
            return Err(RejectReason::FutureDated);
        }
        if self.expires_at_scoped(env, scope) <= now_ms {
            return Err(RejectReason::Expired);
        }
        if env.kind == BlobKind::KeyValue {
            let (entry, hash) =
                prepare_kv_entry(&env.key, &env.payload).map_err(RejectReason::Kv)?;
            let material = KvSigMaterial {
                hash,
                signature: entry.signature,
                public_key: entry.public_key,
            };
            if verify_kv_signature {
                material.verify().map_err(RejectReason::Kv)?;
                return Ok(None);
            }
            return Ok(Some(material));
        }
        Ok(None)
    }
}
