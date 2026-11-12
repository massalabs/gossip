//! Gossip P2P backend: wire types.
//!
//! Everything that crosses a socket or is persisted by a node is defined here with an
//! explicit, bounded (de)serializer following the `massa_serialization` discipline:
//! every length is a varint checked against a maximum given at deserializer
//! construction, so nothing is ever allocated from an unbounded length.
//!
//! Most of this crate is vendored from the Massa node (rev d193d9ff89), see the
//! module headers.

#![warn(missing_docs)]

pub mod announcement;
pub mod blob;
pub mod blob_message;
pub mod error;
pub mod gcs;
pub mod kv;
pub mod message;
pub mod peer_id;
pub mod peer_management;
pub mod primitives;
pub mod scope;
pub mod trust_message;

pub use announcement::{
    Announcement, AnnouncementDeserializer, AnnouncementDeserializerArgs, AnnouncementSerializer,
    MAX_ANNOUNCEMENT_CLOCK_SKEW_MS,
};
pub use blob::*;
pub use blob_message::{
    Beacon, BlobMessage, BlobMessageDeserializer, BlobMessageDeserializerArgs,
    BlobMessageSerializer, BlobMessageTypeId, SyncCursor, SyncCursorDeserializer,
    SyncCursorSerializer, WantedEntry, BEACON_DOMAIN, MAX_BEACON_LIFETIME_S, MAX_WANTED_LIFETIME_S,
    MAX_WANTED_PER_MESSAGE, MAX_WANTED_SUMMARY_LIFETIME, WANTED_ENTRY_BYTES, WANTED_FLAG_LOCAL,
    WANTED_SEEKER_LEN, WANTED_SUMMARY_LIFETIME_UNIT_S,
};
pub use error::WireError;
pub use gcs::Gcs;
pub use kv::*;
pub use message::{
    Message, MessageDeserializer, MessageTypeId, MessageTypeIdDeserializer, MessagesSerializer,
};
pub use peer_id::{PeerId, PeerIdDeserializer, PeerIdSerializer};
pub use peer_management::{
    PeerManagementMessage, PeerManagementMessageDeserializer,
    PeerManagementMessageDeserializerArgs, PeerManagementMessageSerializer,
    PeerManagementMessageTypeId, TrustRound,
};
pub use primitives::{
    IpAddrDeserializer, IpAddrSerializer, Listeners, ListenersDeserializer, ListenersSerializer,
    UnixMillis, UnixMillisDeserializer, UnixMillisSerializer, VecU8Deserializer, VecU8Serializer,
    Version, VersionDeserializer, VersionSerializer, GOSSIP_NET_VERSION, PUBLIC_KEY_DESER_SIZE,
    PUBLIC_KEY_SIZE_BYTES, SIGNATURE_DESER_SIZE,
};
pub use scope::Scope;
pub use trust_message::{
    PeerLimits, SchemeId, TrustChallenge, TrustOffer, TrustOfferDeserializer, TrustOfferSerializer,
    TrustProof, TrustProofs, TrustProofsDeserializer, TrustProofsSerializer, TrustVerdict,
    TrustVerdictDeserializer, TrustVerdictSerializer, DEFAULT_MAX_TRUST_PROOF_LEN,
    MAX_TRUST_CHALLENGES, MAX_TRUST_PARAMS_LEN, MAX_TRUST_PROOFS, PEER_LIMITS_LEN, TRUST_NONCE_LEN,
};

pub use massa_hash::Hash;
pub use massa_signature::{KeyPair, PublicKey, Signature};
pub use transport::TransportType;

mod transport {
    use serde::{Deserialize, Serialize};

    /// Transport of a listener; the same values as PeerNet's type.
    #[derive(Hash, Eq, PartialEq, Debug, Copy, Clone, Serialize, Deserialize)]
    #[repr(u8)]
    pub enum TransportType {
        /// TCP.
        Tcp = 0,
        /// QUIC (reserved, unused).
        Quic = 1,
    }
}
