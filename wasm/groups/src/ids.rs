//! Identifier types (§3).
//!
//! Every identifier travels as a protobuf `bytes` field of an exact length; any other length is
//! malformed (§1.1). Identifiers compare as unsigned big-endian integers, which is the
//! lexicographic byte order used by the derived `Ord` (§1.2).

use core::fmt;

use zeroize::{Zeroize, ZeroizeOnDrop};

use crate::constants::{EVENT_ID_RANDOM_SIZE, EVENT_ID_SIZE, ID_SIZE, REQUEST_ID_SIZE};
use crate::error::{Error, Result};

/// Copies `bytes` into a fixed-size array, or reports a length error naming `field`.
pub(crate) fn fixed<const N: usize>(field: &'static str, bytes: &[u8]) -> Result<[u8; N]> {
    <[u8; N]>::try_from(bytes).map_err(|_| Error::BadLength {
        field,
        expected: N,
        got: bytes.len(),
    })
}

macro_rules! byte_id {
    ($(#[$doc:meta])* $name:ident, $size:expr, $field:literal) => {
        $(#[$doc])*
        #[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
        pub struct $name([u8; $size]);

        impl $name {
            /// Size in bytes.
            pub const SIZE: usize = $size;

            /// Wraps raw bytes.
            #[must_use]
            pub const fn from_bytes(bytes: [u8; $size]) -> Self {
                Self(bytes)
            }

            /// Parses a field of exactly [`Self::SIZE`] bytes.
            ///
            /// # Errors
            ///
            /// [`Error::BadLength`] for any other length.
            pub fn from_slice(bytes: &[u8]) -> Result<Self> {
                fixed($field, bytes).map(Self)
            }

            /// The raw bytes.
            #[must_use]
            pub const fn as_bytes(&self) -> &[u8; $size] {
                &self.0
            }
        }

        impl AsRef<[u8]> for $name {
            fn as_ref(&self) -> &[u8] {
                &self.0
            }
        }

        impl fmt::Debug for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                write!(f, concat!(stringify!($name), "("))?;
                for b in &self.0 {
                    write!(f, "{b:02x}")?;
                }
                write!(f, ")")
            }
        }
    };
}

byte_id!(
    /// The root ID, which is also the epoch ID (§4.1).
    ChatId, ID_SIZE, "chat_id"
);
byte_id!(
    /// A member's identity: `BLAKE3(bincode(UserPublicKeys))` (§3).
    GossipId, ID_SIZE, "gossip_id"
);
byte_id!(
    /// A parent commitment of a root (§4.5).
    ParentCommitment, ID_SIZE, "parent commitment"
);
byte_id!(
    /// The opaque self-reference of an epoch (§4.5).
    RefChatId, ID_SIZE, "ref_chat_id"
);
byte_id!(
    /// The proof of knowledge of the group secret carried by every message event (§4.2).
    SecretProof, ID_SIZE, "secret_proof"
);
byte_id!(
    /// A root's `epoch_challenge` or `ref_chat_id_challenge` (§4.5).
    Challenge, ID_SIZE, "challenge"
);
byte_id!(
    /// The ID of a signed leave (§5.3).
    LeaveId, ID_SIZE, "leaveId"
);
byte_id!(
    /// The ID of a kick (§5.6).
    KickId, ID_SIZE, "kickId"
);
byte_id!(
    /// The ID of a dissolve message (§5.8).
    DissolveId, ID_SIZE, "dissolveId"
);
byte_id!(
    /// The ID of a sync object within an epoch (§3).
    SyncObjId, ID_SIZE, "syncObjId"
);
byte_id!(
    /// A scan identifier chosen by the requester (§3).
    ScanId, ID_SIZE, "scanId"
);
byte_id!(
    /// A query's `request_id` (§3, §13.3).
    RequestId, REQUEST_ID_SIZE, "request_id"
);
byte_id!(
    /// A message event's ID: 8-byte big-endian timestamp ‖ 16 random bytes (§3).
    EventId, EVENT_ID_SIZE, "eventId"
);

impl EventId {
    /// Builds an event ID from its event timestamp `ts` (the creator's clock, Unix
    /// milliseconds) and 16 fresh random bytes supplied by the caller.
    #[must_use]
    pub fn new(ts: u64, random: [u8; EVENT_ID_RANDOM_SIZE]) -> Self {
        let mut bytes = [0u8; EVENT_ID_SIZE];
        bytes[..8].copy_from_slice(&ts.to_be_bytes());
        bytes[8..].copy_from_slice(&random);
        Self(bytes)
    }

    /// The event timestamp `ts`: the first 8 bytes, big-endian (§3).
    #[must_use]
    pub fn timestamp(&self) -> u64 {
        let mut ts = [0u8; 8];
        ts.copy_from_slice(&self.0[..8]);
        u64::from_be_bytes(ts)
    }

    /// The 16 random bytes.
    #[must_use]
    pub fn random(&self) -> [u8; EVENT_ID_RANDOM_SIZE] {
        let mut r = [0u8; EVENT_ID_RANDOM_SIZE];
        r.copy_from_slice(&self.0[8..]);
        r
    }
}

impl GossipId {
    /// The GossipID of a set of keys, computed by the identity code (`auth`), never here.
    #[must_use]
    pub fn of_keys(keys: &auth::UserPublicKeys) -> Self {
        let id = keys.derive_id();
        let mut bytes = [0u8; ID_SIZE];
        bytes.copy_from_slice(id.as_bytes());
        Self(bytes)
    }

    /// Whether every byte is zero (§4.7 step 1 refuses such a member).
    #[must_use]
    pub fn is_zero(&self) -> bool {
        self.0.iter().all(|b| *b == 0)
    }
}

/// An epoch's group secret (§3). Zeroed on drop; its `Debug` output hides the value.
#[derive(Clone, PartialEq, Eq, Zeroize, ZeroizeOnDrop)]
pub struct GroupSecret([u8; ID_SIZE]);

impl GroupSecret {
    /// Size in bytes.
    pub const SIZE: usize = ID_SIZE;

    /// Wraps 32 fresh random bytes supplied by the caller.
    #[must_use]
    pub const fn from_bytes(bytes: [u8; ID_SIZE]) -> Self {
        Self(bytes)
    }

    /// Parses a field of exactly 32 bytes.
    ///
    /// # Errors
    ///
    /// [`Error::BadLength`] for any other length.
    pub fn from_slice(bytes: &[u8]) -> Result<Self> {
        fixed("group_secret", bytes).map(Self)
    }

    /// The raw bytes.
    #[must_use]
    pub const fn as_bytes(&self) -> &[u8; ID_SIZE] {
        &self.0
    }
}

impl fmt::Debug for GroupSecret {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("GroupSecret(..)")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn event_id_layout_is_big_endian_timestamp_then_random() {
        let id = EventId::new(0x0102_0304_0506_0708, [0xaa; 16]);
        assert_eq!(
            hex::encode(id.as_bytes()),
            "0102030405060708aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        );
        assert_eq!(id.timestamp(), 0x0102_0304_0506_0708);
        assert_eq!(id.random(), [0xaa; 16]);
    }

    #[test]
    fn event_ids_order_chronologically_then_randomly() {
        let early = EventId::new(1_000, [0xff; 16]);
        let late = EventId::new(1_001, [0x00; 16]);
        assert!(early < late);
        let a = EventId::new(1_000, [0x00; 16]);
        assert!(a < early);
        // Byte order equals big-endian integer order for timestamps across byte boundaries.
        assert!(EventId::new(255, [0; 16]) < EventId::new(256, [0; 16]));
    }

    #[test]
    fn identifiers_require_their_exact_length() {
        assert!(ChatId::from_slice(&[0; 32]).is_ok());
        assert_eq!(
            ChatId::from_slice(&[0; 31]),
            Err(Error::BadLength {
                field: "chat_id",
                expected: 32,
                got: 31
            })
        );
        assert!(ChatId::from_slice(&[0; 33]).is_err());
        assert!(EventId::from_slice(&[0; 24]).is_ok());
        assert!(EventId::from_slice(&[0; 32]).is_err());
        assert!(RequestId::from_slice(&[0; 16]).is_ok());
        assert!(RequestId::from_slice(&[]).is_err());
        assert!(GroupSecret::from_slice(&[0; 32]).is_ok());
        assert!(GroupSecret::from_slice(&[0; 16]).is_err());
    }

    #[test]
    fn group_secret_debug_hides_the_value() {
        let s = GroupSecret::from_bytes([7; 32]);
        assert_eq!(format!("{s:?}"), "GroupSecret(..)");
    }

    #[test]
    fn zero_gossip_id() {
        assert!(GossipId::from_bytes([0; 32]).is_zero());
        let mut b = [0; 32];
        b[31] = 1;
        assert!(!GossipId::from_bytes(b).is_zero());
    }
}
