//! Errors of the group protocol logic.

use thiserror::Error;

/// Why an object, frame or plaintext was refused.
///
/// Every variant means the input is invalid and is discarded, except
/// [`Error::HandoverParentMissing`], which means the input cannot be checked yet (§4.7).
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum Error {
    // ── Structure ────────────────────────────────────────────────────────────
    /// A fixed-size field has the wrong length (§1.1, §3).
    #[error("{field}: expected {expected} bytes, got {got}")]
    BadLength {
        /// The field.
        field: &'static str,
        /// The required length.
        expected: usize,
        /// The length received.
        got: usize,
    },
    /// A list has fewer items than its minimum.
    #[error("{field}: at least {min} items required, got {got}")]
    TooFew {
        /// The list.
        field: &'static str,
        /// The minimum.
        min: usize,
        /// The number received.
        got: usize,
    },
    /// A list or a size exceeds its maximum.
    #[error("{field}: at most {max} allowed, got {got}")]
    TooMany {
        /// The list or the size.
        field: &'static str,
        /// The maximum.
        max: usize,
        /// The number received.
        got: usize,
    },
    /// A list that must be sorted ascending with distinct items is not (§4.1, §6.1).
    #[error("{0}: items must be distinct and sorted ascending")]
    NotSortedDistinct(&'static str),
    /// A list holds the same item twice.
    #[error("{0}: items must be distinct")]
    Duplicate(&'static str),
    /// A GossipID of a member list is all zero (§4.7 step 1).
    #[error("{0}: an all-zero identifier is not allowed")]
    ZeroId(&'static str),
    /// A text field is not valid UTF-8 (§1.1).
    #[error("{0}: not valid UTF-8")]
    InvalidUtf8(&'static str),
    /// A field that the rules require to be absent holds a value (§1.1).
    #[error("{0}: must be absent")]
    MustBeAbsent(&'static str),
    /// A field that the rules require is missing.
    #[error("{0}: missing")]
    Missing(&'static str),
    /// An enumeration holds a value the rules forbid here.
    #[error("{0}: value not allowed here")]
    NotAllowed(&'static str),
    /// Integer arithmetic on a field overflowed (§1.1).
    #[error("{0}: arithmetic overflow")]
    Overflow(&'static str),
    /// A message event names itself as a parent (§6.1).
    #[error("an event cannot be its own parent")]
    SelfParent,
    /// A timestamp of a payload is beyond `ts + MAX_SCHEDULE` (§7.2).
    #[error("{0}: beyond the event timestamp plus MAX_SCHEDULE")]
    BeyondSchedule(&'static str),

    // ── Keys and signatures ──────────────────────────────────────────────────
    /// The owner field, a key answer or a key argument is not a valid bincode `UserPublicKeys`.
    #[error("invalid UserPublicKeys encoding")]
    InvalidKeys,
    /// Keys parse, but their bincode encoding is not the canonical one, so their bytes do not
    /// hash to the GossipID of the keys (§3, §4.3).
    #[error("UserPublicKeys encoding is not canonical")]
    NonCanonicalKeys,
    /// The keys given do not hash to the expected GossipID.
    #[error("keys do not match the expected GossipID")]
    KeysMismatch,
    /// The ML-DSA-65 signature does not verify.
    #[error("invalid signature")]
    InvalidSignature,

    // ── Root and object rules ────────────────────────────────────────────────
    /// The owner of a root is not one of its members (§4.3).
    #[error("the owner is not a member")]
    OwnerNotMember,
    /// A GossipID that must be a member of the epoch is not (§4.7, §5.3, §5.6, §6.2).
    #[error("{0} is not a member of the epoch")]
    NotMember(&'static str),
    /// The computed ID differs from the announced or expected one (§4.7 step 2, §13.4).
    #[error("{0}: ID mismatch")]
    IdMismatch(&'static str),
    /// A handover root does not have exactly one parent (§4.7).
    #[error("a handover root must have exactly one parent")]
    HandoverParentCount,
    /// The parent root given does not match the parent commitment of the root (§4.5).
    #[error("the given parent does not match the parent commitment")]
    ParentMismatch,
    /// A handover root keeps the parent's owner (§4.7, D.7).
    #[error("a handover root must name a new owner")]
    HandoverSameOwner,
    /// A handover root lists someone who is not a member of the parent (§4.7).
    #[error("a handover root cannot add members")]
    HandoverAddsMember,
    /// A handover root whose parent the device does not hold: discarded without penalty, and
    /// the parent is looked up (§4.7, §4.8).
    #[error("the parent of a handover root is not held")]
    HandoverParentMissing,
    /// The secret proof of a message event does not match (§4.2).
    #[error("secret proof mismatch")]
    SecretProofMismatch,
    /// An object does not fit one empty container (§4.6, §13.10).
    #[error("does not fit one empty container")]
    DoesNotFitContainer,

    // ── Wire ─────────────────────────────────────────────────────────────────
    /// A plaintext exceeds the container limit (§13.10).
    #[error("plaintext of {0} bytes exceeds the container limit")]
    PlaintextTooLarge(usize),
    /// The varint version prefix is missing or invalid (§13.1).
    #[error("invalid version prefix")]
    InvalidVersionPrefix,
    /// The plaintext version is higher than the receiver supports: answer with the version
    /// notice of §13.8.
    #[error("plaintext version {0} is higher than supported")]
    UnsupportedHigherVersion(u64),
    /// The plaintext version is lower than the receiver supports: drop silently (§13.8).
    #[error("plaintext version {0} is lower than supported")]
    UnsupportedLowerVersion(u64),
    /// The event version is higher than the plaintext version (§13.1).
    #[error("event version {event} is higher than the plaintext version {plaintext}")]
    EventVersionAbovePlaintext {
        /// The event's version.
        event: u64,
        /// The plaintext's version.
        plaintext: u64,
    },
    /// The event version is not supported by this receiver (§13.1).
    #[error("unsupported event version {0}")]
    UnsupportedEventVersion(u64),
    /// The protobuf encoding is malformed, or holds an unknown field, enum value or `oneof`
    /// case (§1.1, §13.8).
    #[error("malformed protobuf: {0}")]
    Malformed(&'static str),
}

/// Result alias of this crate.
pub type Result<T> = core::result::Result<T, Error>;
