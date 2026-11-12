//! Public value types of the pools API.

use gossip_wire::{BlobId, KvError, Scope};
use massa_hash::Hash;
use massa_signature::{PublicKey, Signature};

/// Where a blob came from, for eviction ordering and audit.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Source {
    /// Serialized peer id of the sender (at most [`Source::MAX_PEER_LEN`] bytes; longer
    /// values are truncated when stored). `None` means a local HTTP client.
    pub peer: Option<Vec<u8>>,
    /// Trust bucket of the sender, `0..=15` (clamped). Higher buckets are evicted later.
    pub trust_bucket: u8,
    /// Scope the blob gets (merged into the stored scope when it is already held).
    /// [`Scope::INTERNET`] for every constructor; see `docs/MESH.md`.
    pub scope: Scope,
}

impl Source {
    /// Maximum stored length of a peer id.
    pub const MAX_PEER_LEN: usize = 64;
    /// Highest trust bucket.
    pub const MAX_TRUST_BUCKET: u8 = 15;

    /// A local client (no peer id) with the given trust bucket.
    pub fn local(trust_bucket: u8) -> Self {
        Self {
            peer: None,
            trust_bucket,
            scope: Scope::INTERNET,
        }
    }

    /// A remote peer.
    pub fn peer(peer: impl Into<Vec<u8>>, trust_bucket: u8) -> Self {
        Self {
            peer: Some(peer.into()),
            trust_bucket,
            scope: Scope::INTERNET,
        }
    }

    /// The same source, giving the blob `scope` instead.
    pub fn with_scope(mut self, scope: Scope) -> Self {
        self.scope = scope;
        self
    }

    /// Bucket clamped to the valid range.
    pub fn bucket(&self) -> u8 {
        self.trust_bucket.min(Self::MAX_TRUST_BUCKET)
    }
}

/// Why a blob was not stored. Never a storage failure (see [`crate::PoolError`]).
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum RejectReason {
    /// Payload longer than the cap for its kind.
    #[error("payload too large")]
    PayloadTooLarge,
    /// Key longer than the cap.
    #[error("key too large")]
    KeyTooLarge,
    /// Non-empty key on a `Bulletin` or `Hash` blob.
    #[error("key not allowed for this kind")]
    KeyNotAllowed,
    /// `KeyValue` entry failed layout, key/public-key or signature checks.
    #[error("key-value entry rejected: {0}")]
    Kv(#[source] KvError),
    /// `created_at + retention` is already in the past.
    #[error("expired")]
    Expired,
    /// `created_at` is further in the future than the tolerated skew.
    #[error("created_at is in the future")]
    FutureDated,
    /// A `KeyValue` blob with a different payload already owns this key (first writer
    /// wins).
    #[error("key already taken")]
    KeyTaken,
    /// Storage caps reached and eviction could not make room.
    #[error("pool full")]
    PoolFull,
}

/// Result of an insert.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InsertOutcome {
    /// Stored now. `counter` is the local bulletin counter for `Bulletin` blobs.
    ///
    /// Also returned when a `KeyValue` blob (same key) or `Hash` blob (same content
    /// hash) with a byte-identical payload but a later expiry replaces the stored
    /// copy; the replaced id is reported through [`crate::Pools::set_eviction_sink`].
    Inserted {
        /// Content id.
        id: BlobId,
        /// Bulletin counter (`Bulletin` kind only).
        counter: Option<u64>,
    },
    /// Already stored: same id, or a `KeyValue` / `Hash` blob with a byte-identical
    /// payload under the same key / content hash that expires no earlier; in that case
    /// `id` is the id of the stored blob.
    AlreadyPresent {
        /// Content id of the blob that is in the store.
        id: BlobId,
        /// Bulletin counter (`Bulletin` kind only).
        counter: Option<u64>,
    },
    /// Not stored.
    Rejected(RejectReason),
}

impl InsertOutcome {
    /// Id of the stored blob, if any.
    pub fn id(&self) -> Option<BlobId> {
        match self {
            Self::Inserted { id, .. } | Self::AlreadyPresent { id, .. } => Some(*id),
            Self::Rejected(_) => None,
        }
    }

    /// Bulletin counter, if any.
    pub fn counter(&self) -> Option<u64> {
        match self {
            Self::Inserted { counter, .. } | Self::AlreadyPresent { counter, .. } => *counter,
            Self::Rejected(_) => None,
        }
    }

    /// `true` for [`InsertOutcome::Inserted`].
    pub fn is_inserted(&self) -> bool {
        matches!(self, Self::Inserted { .. })
    }
}

/// Material for (batch) signature verification of a `KeyValue` blob, as consumed by
/// `massa_signature::verify_signature_batch`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct KvSigMaterial {
    /// Signed hash: `blake3([key_len] ‖ key ‖ message)`.
    pub hash: Hash,
    /// Signature carried by the value.
    pub signature: Signature,
    /// Seeker public key carried by the value (already matched against the key).
    pub public_key: PublicKey,
}

impl KvSigMaterial {
    /// Tuple form accepted by `massa_signature::verify_signature_batch`.
    pub fn into_tuple(self) -> (Hash, Signature, PublicKey) {
        (self.hash, self.signature, self.public_key)
    }

    /// Verifies this single signature.
    pub fn verify(&self) -> Result<(), KvError> {
        self.public_key
            .verify_signature(&self.hash, &self.signature)
            .map_err(|_| KvError::BadSignature)
    }
}

/// Position in the `(expires_at, id)` order used by [`crate::Pools::ids_by_expiry`].
pub type ExpiryCursor = (u64, BlobId);

/// Store-wide counters.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct PoolStats {
    /// Sum of the wire sizes of all stored blobs.
    pub total_bytes: u64,
    /// Number of stored blobs (all kinds).
    pub blob_count: u64,
    /// Last bulletin counter assigned (0 if none ever was).
    pub bulletin_counter: u64,
    /// Number of stored `Bulletin` blobs.
    pub bulletin_count: u64,
    /// Number of stored `KeyValue` blobs.
    pub kv_count: u64,
    /// Number of stored `Hash` blobs.
    pub hash_count: u64,
    /// Sum of the wire sizes of mesh-only blobs (scope `mesh` without `internet`).
    pub mesh_bytes: u64,
    /// Number of mesh-only blobs.
    pub mesh_count: u64,
    /// Number of blobs waiting for a bridge upload.
    pub upload_count: u64,
}
