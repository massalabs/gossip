//! Blob propagation and synchronisation messages.
//!
//! Written in the style of massa's
//! `massa-protocol-worker/src/handlers/operation_handler/messages.rs` (rev d193d9ff89).
//!
//! Wire form: `varint(type id)` then
//! - `Announce` / `Ask`: `varint(count) ‖ BlobId*` (32 raw bytes each)
//! - `Blobs`: `varint(count) ‖ BlobEnvelope*` (see [`BlobEnvelopeSerializer`])
//! - `SyncRequest`: `varint(since_ms) ‖ Option<cursor> ‖ varint(max)`
//! - `SyncIds`: `varint(count) ‖ BlobId* ‖ Option<cursor>`
//! - `Wanted` (mesh links only, see `docs/MESH.md`): `u8 hops ‖ varint(count ≤ 256) ‖
//!   (seeker (34) ‖ u32 BE lifetime seconds ‖ u8 flags)*`, flags bit 0 local-only
//!   (`GMSH.2.1`), the other bits zero
//! - `HaveSummary` (mesh links, `GMSH.1.1`): `gcs`
//! - `WantedSummary` (mesh links, `GMSH.1.1`): `gcs ‖ u8 hops * n ‖ u8 lifetime * n`
//! - `Beacon` (mesh links, `GMSH.2.0`): `u8 hops ‖ key (33) ‖ u64 BE issued_at ms ‖
//!   u32 BE lifetime seconds ‖ signature (65)`, see [`Beacon`]
//! - `LocalBlobs` (mesh links, `GMSH.2.1`): as `Blobs`, for local-only blobs (never
//!   uploaded, see `docs/MESH.md`, "Local-only blobs and seekers")
//!
//! with `gcs = u8 p ‖ varint(n) ‖ varint(length) ‖ bits` (see [`crate::gcs`]),
//! where `cursor = varint(created_at_ms) ‖ BlobId` and `Option<_>` follows
//! `massa_serialization::OptionSerializer`: one ASCII tag byte, `b'0'` (0x30) for
//! `None`, `b'1'` (0x31) followed by the value for `Some`.

use std::ops::Bound::Included;

use massa_serialization::{
    Deserializer, OptionDeserializer, OptionSerializer, SerializeError, Serializer,
    U32VarIntDeserializer, U32VarIntSerializer, U64VarIntDeserializer, U64VarIntSerializer,
};
use nom::{
    error::{context, ContextError, ParseError},
    multi::length_count,
    sequence::tuple,
    IResult, Parser,
};

use crate::blob::{
    BlobEnvelope, BlobEnvelopeDeserializer, BlobEnvelopeSerializer, BlobId, BlobIdDeserializer,
    BlobIdSerializer,
};
use crate::gcs::{Gcs, GCS_MAX_ITEMS, GCS_MAX_P, GCS_MIN_P};
use crate::peer_id::PeerId;
use crate::primitives::{
    UnixMillis, UnixMillisDeserializer, UnixMillisSerializer, PUBLIC_KEY_DESER_SIZE,
    SIGNATURE_DESER_SIZE,
};
use massa_hash::Hash;
use massa_signature::{KeyPair, PublicKey, Signature};

/// Position in the `(created_at, id)` order used by sync pagination.
pub type SyncCursor = (UnixMillis, BlobId);

/// Messages exchanged by the blob handler.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BlobMessage {
    /// Ids of blobs the sender has and offers to send.
    Announce(Vec<BlobId>),
    /// Ids of blobs the sender wants.
    Ask(Vec<BlobId>),
    /// Full blobs.
    Blobs(Vec<BlobEnvelope>),
    /// Asks for the ids of blobs created since `since`, paginated after `cursor`.
    SyncRequest {
        /// Lower bound (inclusive) on `created_at`.
        since: UnixMillis,
        /// Resume after this position (exclusive); `None` starts from `since`.
        cursor: Option<SyncCursor>,
        /// Maximum number of ids wanted in the reply.
        max: u32,
    },
    /// Reply to a [`BlobMessage::SyncRequest`].
    SyncIds {
        /// Ids in `(created_at, id)` order.
        ids: Vec<BlobId>,
        /// Position to resume from, `None` when the page was the last one.
        next: Option<SyncCursor>,
    },
    /// Seekers somebody in the mesh waits for (mesh links only).
    Wanted {
        /// Hops the entries may still travel after this one.
        hops: u8,
        /// The entries.
        entries: Vec<WantedEntry>,
    },
    /// The mesh blobs the sender holds, sent once when a link comes up (`GMSH.1.1`).
    HaveSummary(Gcs),
    /// The sender's wanted table, sent once when a link comes up (`GMSH.1.1`).
    WantedSummary {
        /// The seekers.
        set: Gcs,
        /// Forwarding hop budget of each value, in sorted value order.
        hops: Vec<u8>,
        /// Remaining lifetime of each value in [`WANTED_SUMMARY_LIFETIME_UNIT_S`]
        /// units, 1 to [`MAX_WANTED_SUMMARY_LIFETIME`].
        lifetimes: Vec<u8>,
    },
    /// A bridge says it reaches the internet (mesh links, `GMSH.2.0`).
    Beacon {
        /// Hops the beacon may still travel after this one.
        hops: u8,
        /// The signed statement of the bridge.
        beacon: Box<Beacon>,
    },
    /// Full local-only blobs: stored without upload by whoever receives them (mesh
    /// links, `GMSH.2.1`).
    LocalBlobs(Vec<BlobEnvelope>),
}

/// Domain of the signature of a [`Beacon`].
pub const BEACON_DOMAIN: &[u8] = b"gossip/mesh/beacon/v1";
/// Longest lifetime a [`Beacon`] may announce, in seconds.
pub const MAX_BEACON_LIFETIME_S: u32 = 3600;

/// A bridge's signed statement that it reaches the internet until
/// `issued_at + lifetime_s`. The hop budget travels outside the signature, since every
/// hop lowers it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Beacon {
    /// The bridge's beacon key.
    pub key: PeerId,
    /// When the bridge signed it, unix ms on the bridge's mesh clock.
    pub issued_at: u64,
    /// Seconds it holds from `issued_at`, at most [`MAX_BEACON_LIFETIME_S`].
    pub lifetime_s: u32,
    /// Signature by `key` over [`Beacon::signed_hash`].
    pub signature: Signature,
}

impl Beacon {
    /// `blake3(BEACON_DOMAIN ‖ key ‖ u64 BE issued_at ‖ u32 BE lifetime_s)`.
    pub fn signed_hash(key: &PeerId, issued_at: u64, lifetime_s: u32) -> Hash {
        let mut data = Vec::with_capacity(BEACON_DOMAIN.len() + PUBLIC_KEY_DESER_SIZE + 12);
        data.extend_from_slice(BEACON_DOMAIN);
        data.extend_from_slice(&key.to_bytes());
        data.extend_from_slice(&issued_at.to_be_bytes());
        data.extend_from_slice(&lifetime_s.to_be_bytes());
        Hash::compute_from(&data)
    }

    /// A beacon signed by `keypair`.
    pub fn sign(keypair: &KeyPair, issued_at: u64, lifetime_s: u32) -> Result<Self, String> {
        let key = PeerId::from_public_key(keypair.get_public_key());
        let lifetime_s = lifetime_s.min(MAX_BEACON_LIFETIME_S);
        let signature = keypair
            .sign(&Self::signed_hash(&key, issued_at, lifetime_s))
            .map_err(|e| e.to_string())?;
        Ok(Self {
            key,
            issued_at,
            lifetime_s,
            signature,
        })
    }

    /// Whether the signature holds.
    pub fn verify(&self) -> bool {
        self.lifetime_s <= MAX_BEACON_LIFETIME_S
            && self
                .key
                .verify_signature(
                    &Self::signed_hash(&self.key, self.issued_at, self.lifetime_s),
                    &self.signature,
                )
                .is_ok()
    }

    /// The tag beacons of this key are known by.
    pub fn tag(&self) -> [u8; 32] {
        *blake3::hash(&self.key.to_bytes()).as_bytes()
    }

    /// When it stops holding, unix ms.
    pub fn expires_at(&self) -> u64 {
        self.issued_at
            .saturating_add(u64::from(self.lifetime_s) * 1000)
    }
}

/// Unit of the lifetimes of a [`BlobMessage::WantedSummary`], in seconds.
pub const WANTED_SUMMARY_LIFETIME_UNIT_S: u32 = 120;
/// Largest lifetime of a [`BlobMessage::WantedSummary`] value, in units (6 hours).
pub const MAX_WANTED_SUMMARY_LIFETIME: u8 =
    (MAX_WANTED_LIFETIME_S / WANTED_SUMMARY_LIFETIME_UNIT_S) as u8;

/// Length of a seeker key, the only key a `Wanted` entry carries.
pub const WANTED_SEEKER_LEN: usize = 34;
/// Most entries in one `Wanted` message.
pub const MAX_WANTED_PER_MESSAGE: u64 = 256;
/// Longest lifetime a `Wanted` entry may announce, in seconds (6 hours).
pub const MAX_WANTED_LIFETIME_S: u32 = 6 * 60 * 60;

/// One entry of a [`BlobMessage::Wanted`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct WantedEntry {
    /// The seeker key (`0x20 ‖ blake3(seeker public key) ‖ 0x01`).
    pub seeker: [u8; WANTED_SEEKER_LEN],
    /// Seconds the entry stays wanted from now, at most [`MAX_WANTED_LIFETIME_S`].
    pub lifetime_s: u32,
    /// Local-only: a bridge must not fetch it upstream (`GMSH.2.1`).
    pub local: bool,
}

/// Flag bit of a `Wanted` entry: local-only.
pub const WANTED_FLAG_LOCAL: u8 = 0b1;
/// Bytes of one `Wanted` entry on the wire.
pub const WANTED_ENTRY_BYTES: usize = WANTED_SEEKER_LEN + 4 + 1;

/// Varint type id prefixing each [`BlobMessage`].
#[derive(Debug, Clone, Copy, Eq, PartialEq)]
#[repr(u64)]
pub enum BlobMessageTypeId {
    /// [`BlobMessage::Announce`]
    Announce = 0,
    /// [`BlobMessage::Ask`]
    Ask = 1,
    /// [`BlobMessage::Blobs`]
    Blobs = 2,
    /// [`BlobMessage::SyncRequest`]
    SyncRequest = 3,
    /// [`BlobMessage::SyncIds`]
    SyncIds = 4,
    /// [`BlobMessage::Wanted`]
    Wanted = 5,
    /// [`BlobMessage::HaveSummary`]
    HaveSummary = 6,
    /// [`BlobMessage::WantedSummary`]
    WantedSummary = 7,
    /// [`BlobMessage::Beacon`]
    Beacon = 8,
    /// [`BlobMessage::LocalBlobs`]
    LocalBlobs = 9,
}

impl From<BlobMessageTypeId> for u64 {
    fn from(id: BlobMessageTypeId) -> Self {
        id as u64
    }
}

impl TryFrom<u64> for BlobMessageTypeId {
    type Error = u64;

    fn try_from(raw: u64) -> Result<Self, Self::Error> {
        match raw {
            0 => Ok(Self::Announce),
            1 => Ok(Self::Ask),
            2 => Ok(Self::Blobs),
            3 => Ok(Self::SyncRequest),
            4 => Ok(Self::SyncIds),
            5 => Ok(Self::Wanted),
            6 => Ok(Self::HaveSummary),
            7 => Ok(Self::WantedSummary),
            8 => Ok(Self::Beacon),
            9 => Ok(Self::LocalBlobs),
            other => Err(other),
        }
    }
}

impl From<&BlobMessage> for BlobMessageTypeId {
    fn from(message: &BlobMessage) -> Self {
        match message {
            BlobMessage::Announce(_) => BlobMessageTypeId::Announce,
            BlobMessage::Ask(_) => BlobMessageTypeId::Ask,
            BlobMessage::Blobs(_) => BlobMessageTypeId::Blobs,
            BlobMessage::SyncRequest { .. } => BlobMessageTypeId::SyncRequest,
            BlobMessage::SyncIds { .. } => BlobMessageTypeId::SyncIds,
            BlobMessage::Wanted { .. } => BlobMessageTypeId::Wanted,
            BlobMessage::HaveSummary(_) => BlobMessageTypeId::HaveSummary,
            BlobMessage::WantedSummary { .. } => BlobMessageTypeId::WantedSummary,
            BlobMessage::Beacon { .. } => BlobMessageTypeId::Beacon,
            BlobMessage::LocalBlobs(_) => BlobMessageTypeId::LocalBlobs,
        }
    }
}

/// Serializer for a [`SyncCursor`]: `varint(created_at_ms) ‖ BlobId`.
#[derive(Clone, Default)]
pub struct SyncCursorSerializer {
    time_serializer: UnixMillisSerializer,
    id_serializer: BlobIdSerializer,
}

impl SyncCursorSerializer {
    /// Creates a `SyncCursorSerializer`
    pub const fn new() -> Self {
        Self {
            time_serializer: UnixMillisSerializer::new(),
            id_serializer: BlobIdSerializer,
        }
    }
}

impl Serializer<SyncCursor> for SyncCursorSerializer {
    fn serialize(&self, value: &SyncCursor, buffer: &mut Vec<u8>) -> Result<(), SerializeError> {
        self.time_serializer.serialize(&value.0, buffer)?;
        self.id_serializer.serialize(&value.1, buffer)
    }
}

/// Deserializer for a [`SyncCursor`]. Fixed size, no bound needed.
#[derive(Clone, Default)]
pub struct SyncCursorDeserializer {
    time_deserializer: UnixMillisDeserializer,
    id_deserializer: BlobIdDeserializer,
}

impl SyncCursorDeserializer {
    /// Creates a `SyncCursorDeserializer`
    pub fn new() -> Self {
        Self::default()
    }
}

impl Deserializer<SyncCursor> for SyncCursorDeserializer {
    fn deserialize<'a, E: ParseError<&'a [u8]> + ContextError<&'a [u8]>>(
        &self,
        buffer: &'a [u8],
    ) -> IResult<&'a [u8], SyncCursor, E> {
        context(
            "Failed SyncCursor deserialization",
            tuple((
                context("Failed created_at deserialization", |input| {
                    self.time_deserializer.deserialize(input)
                }),
                context("Failed BlobId deserialization", |input| {
                    self.id_deserializer.deserialize(input)
                }),
            )),
        )
        .parse(buffer)
    }
}

/// Serializer for [`BlobMessage`].
#[derive(Clone)]
pub struct BlobMessageSerializer {
    id_serializer: U64VarIntSerializer,
    length_serializer: U64VarIntSerializer,
    max_serializer: U32VarIntSerializer,
    blob_id_serializer: BlobIdSerializer,
    envelope_serializer: BlobEnvelopeSerializer,
    time_serializer: UnixMillisSerializer,
    cursor_serializer: OptionSerializer<SyncCursor, SyncCursorSerializer>,
}

impl BlobMessageSerializer {
    /// Creates a `BlobMessageSerializer`
    pub fn new() -> Self {
        Self {
            id_serializer: U64VarIntSerializer::new(),
            length_serializer: U64VarIntSerializer::new(),
            max_serializer: U32VarIntSerializer::new(),
            blob_id_serializer: BlobIdSerializer::new(),
            envelope_serializer: BlobEnvelopeSerializer::new(),
            time_serializer: UnixMillisSerializer::new(),
            cursor_serializer: OptionSerializer::new(SyncCursorSerializer::new()),
        }
    }

    fn serialize_ids(&self, ids: &[BlobId], buffer: &mut Vec<u8>) -> Result<(), SerializeError> {
        let len: u64 = ids
            .len()
            .try_into()
            .map_err(|err| SerializeError::NumberTooBig(format!("too many blob ids: {}", err)))?;
        self.length_serializer.serialize(&len, buffer)?;
        for id in ids {
            self.blob_id_serializer.serialize(id, buffer)?;
        }
        Ok(())
    }

    fn serialize_gcs(&self, gcs: &Gcs, buffer: &mut Vec<u8>) -> Result<(), SerializeError> {
        if !gcs.in_bounds() {
            return Err(SerializeError::NumberTooBig(format!(
                "summary out of bounds: p={} n={} {} bytes",
                gcs.p,
                gcs.n,
                gcs.bits.len()
            )));
        }
        buffer.push(gcs.p);
        self.length_serializer.serialize(&gcs.n, buffer)?;
        self.length_serializer
            .serialize(&(gcs.bits.len() as u64), buffer)?;
        buffer.extend_from_slice(&gcs.bits);
        Ok(())
    }
}

impl Default for BlobMessageSerializer {
    fn default() -> Self {
        Self::new()
    }
}

impl Serializer<BlobMessage> for BlobMessageSerializer {
    fn serialize(&self, value: &BlobMessage, buffer: &mut Vec<u8>) -> Result<(), SerializeError> {
        self.id_serializer
            .serialize(&BlobMessageTypeId::from(value).into(), buffer)?;
        match value {
            BlobMessage::Announce(ids) | BlobMessage::Ask(ids) => {
                self.serialize_ids(ids, buffer)?;
            }
            BlobMessage::Blobs(blobs) | BlobMessage::LocalBlobs(blobs) => {
                let len: u64 = blobs.len().try_into().map_err(|err| {
                    SerializeError::NumberTooBig(format!("too many blobs: {}", err))
                })?;
                self.length_serializer.serialize(&len, buffer)?;
                for blob in blobs {
                    self.envelope_serializer.serialize(blob, buffer)?;
                }
            }
            BlobMessage::SyncRequest { since, cursor, max } => {
                self.time_serializer.serialize(since, buffer)?;
                self.cursor_serializer.serialize(cursor, buffer)?;
                self.max_serializer.serialize(max, buffer)?;
            }
            BlobMessage::SyncIds { ids, next } => {
                self.serialize_ids(ids, buffer)?;
                self.cursor_serializer.serialize(next, buffer)?;
            }
            BlobMessage::Wanted { hops, entries } => {
                if entries.len() as u64 > MAX_WANTED_PER_MESSAGE {
                    return Err(SerializeError::NumberTooBig(format!(
                        "too many wanted entries: {}",
                        entries.len()
                    )));
                }
                buffer.push(*hops);
                self.length_serializer
                    .serialize(&(entries.len() as u64), buffer)?;
                for entry in entries {
                    buffer.extend_from_slice(&entry.seeker);
                    buffer.extend_from_slice(&entry.lifetime_s.to_be_bytes());
                    buffer.push(if entry.local { WANTED_FLAG_LOCAL } else { 0 });
                }
            }
            BlobMessage::HaveSummary(set) => self.serialize_gcs(set, buffer)?,
            BlobMessage::WantedSummary {
                set,
                hops,
                lifetimes,
            } => {
                if hops.len() as u64 != set.n || lifetimes.len() as u64 != set.n {
                    return Err(SerializeError::GeneralError(
                        "one hop and one lifetime byte per summary value".into(),
                    ));
                }
                self.serialize_gcs(set, buffer)?;
                buffer.extend_from_slice(hops);
                buffer.extend_from_slice(lifetimes);
            }
            BlobMessage::Beacon { hops, beacon } => {
                buffer.push(*hops);
                buffer.extend_from_slice(&beacon.key.to_bytes());
                buffer.extend_from_slice(&beacon.issued_at.to_be_bytes());
                buffer.extend_from_slice(&beacon.lifetime_s.to_be_bytes());
                buffer.extend_from_slice(&beacon.signature.to_bytes());
            }
        }
        Ok(())
    }
}

/// Limits used in the deserialization of [`BlobMessage`].
#[derive(Debug, Clone, Copy)]
pub struct BlobMessageDeserializerArgs {
    /// Maximum number of ids in an `Announce` or `Ask`.
    pub max_ids_per_message: u64,
    /// Maximum number of envelopes in a `Blobs`.
    pub max_blobs_per_message: u64,
    /// Maximum key length of one envelope.
    pub max_key_len: u64,
    /// Maximum payload length of one envelope.
    pub max_payload_len: u64,
    /// Maximum number of ids in a `SyncIds` page, and maximum `max` a `SyncRequest`
    /// may ask for.
    pub max_sync_page: u64,
}

/// Bounded deserializer for [`BlobMessage`].
#[derive(Clone)]
pub struct BlobMessageDeserializer {
    id_deserializer: U64VarIntDeserializer,
    ids_length_deserializer: U64VarIntDeserializer,
    blobs_length_deserializer: U64VarIntDeserializer,
    page_length_deserializer: U64VarIntDeserializer,
    max_deserializer: U32VarIntDeserializer,
    blob_id_deserializer: BlobIdDeserializer,
    envelope_deserializer: BlobEnvelopeDeserializer,
    time_deserializer: UnixMillisDeserializer,
    cursor_deserializer: OptionDeserializer<SyncCursor, SyncCursorDeserializer>,
    wanted_length_deserializer: U64VarIntDeserializer,
    gcs_count_deserializer: U64VarIntDeserializer,
    gcs_length_deserializer: U64VarIntDeserializer,
}

impl BlobMessageDeserializer {
    /// Creates a `BlobMessageDeserializer` with the given limits.
    pub fn new(args: BlobMessageDeserializerArgs) -> Self {
        Self {
            id_deserializer: U64VarIntDeserializer::new(Included(0), Included(u64::MAX)),
            ids_length_deserializer: U64VarIntDeserializer::new(
                Included(0),
                Included(args.max_ids_per_message),
            ),
            blobs_length_deserializer: U64VarIntDeserializer::new(
                Included(0),
                Included(args.max_blobs_per_message),
            ),
            page_length_deserializer: U64VarIntDeserializer::new(
                Included(0),
                Included(args.max_sync_page),
            ),
            max_deserializer: U32VarIntDeserializer::new(
                Included(0),
                Included(u32::try_from(args.max_sync_page).unwrap_or(u32::MAX)),
            ),
            blob_id_deserializer: BlobIdDeserializer::new(),
            envelope_deserializer: BlobEnvelopeDeserializer::new(
                args.max_key_len,
                args.max_payload_len,
            ),
            time_deserializer: UnixMillisDeserializer::default(),
            cursor_deserializer: OptionDeserializer::new(SyncCursorDeserializer::new()),
            wanted_length_deserializer: U64VarIntDeserializer::new(
                Included(0),
                Included(MAX_WANTED_PER_MESSAGE),
            ),
            gcs_count_deserializer: U64VarIntDeserializer::new(
                Included(0),
                Included(GCS_MAX_ITEMS),
            ),
            gcs_length_deserializer: U64VarIntDeserializer::new(
                Included(0),
                Included(Gcs::max_len(GCS_MAX_ITEMS, GCS_MAX_P)),
            ),
        }
    }

    /// A summary's header and bits; the bits are only checked against the length
    /// bound here, the receiver decodes them.
    fn deserialize_gcs<'a, E: ParseError<&'a [u8]> + ContextError<&'a [u8]>>(
        &self,
        buffer: &'a [u8],
    ) -> IResult<&'a [u8], Gcs, E> {
        let fail = |input: &'a [u8]| {
            nom::Err::Error(ParseError::from_error_kind(
                input,
                nom::error::ErrorKind::Verify,
            ))
        };
        let (&p, buffer) = buffer.split_first().ok_or_else(|| fail(buffer))?;
        if !(GCS_MIN_P..=GCS_MAX_P).contains(&p) {
            return Err(fail(buffer));
        }
        let (buffer, n) = self.gcs_count_deserializer.deserialize(buffer)?;
        let (buffer, len) = self.gcs_length_deserializer.deserialize(buffer)?;
        if len > Gcs::max_len(n, p) || buffer.len() < len as usize {
            return Err(fail(buffer));
        }
        let (bits, buffer) = buffer.split_at(len as usize);
        Ok((
            buffer,
            Gcs {
                p,
                n,
                bits: bits.to_vec(),
            },
        ))
    }

    fn deserialize_wanted_summary<'a, E: ParseError<&'a [u8]> + ContextError<&'a [u8]>>(
        &self,
        buffer: &'a [u8],
    ) -> IResult<&'a [u8], BlobMessage, E> {
        let fail = |input: &'a [u8]| {
            nom::Err::Error(ParseError::from_error_kind(
                input,
                nom::error::ErrorKind::Verify,
            ))
        };
        let (buffer, set) = self.deserialize_gcs(buffer)?;
        let n = set.n as usize;
        if buffer.len() < 2 * n {
            return Err(fail(buffer));
        }
        let (hops, buffer) = buffer.split_at(n);
        let (lifetimes, buffer) = buffer.split_at(n);
        if lifetimes
            .iter()
            .any(|l| *l == 0 || *l > MAX_WANTED_SUMMARY_LIFETIME)
        {
            return Err(fail(buffer));
        }
        Ok((
            buffer,
            BlobMessage::WantedSummary {
                set,
                hops: hops.to_vec(),
                lifetimes: lifetimes.to_vec(),
            },
        ))
    }

    fn deserialize_beacon<'a, E: ParseError<&'a [u8]> + ContextError<&'a [u8]>>(
        &self,
        buffer: &'a [u8],
    ) -> IResult<&'a [u8], BlobMessage, E> {
        let fail = |input: &'a [u8]| {
            nom::Err::Error(ParseError::from_error_kind(
                input,
                nom::error::ErrorKind::Verify,
            ))
        };
        const LEN: usize = 1 + PUBLIC_KEY_DESER_SIZE + 8 + 4 + SIGNATURE_DESER_SIZE;
        if buffer.len() < LEN {
            return Err(fail(buffer));
        }
        let (body, rest) = buffer.split_at(LEN);
        let hops = body[0];
        let (key, body) = body[1..].split_at(PUBLIC_KEY_DESER_SIZE);
        let key = PublicKey::from_bytes(key)
            .map(PeerId::from_public_key)
            .map_err(|_| fail(buffer))?;
        let issued_at = u64::from_be_bytes(body[..8].try_into().expect("8 bytes"));
        let lifetime_s = u32::from_be_bytes(body[8..12].try_into().expect("4 bytes"));
        if lifetime_s > MAX_BEACON_LIFETIME_S {
            return Err(fail(buffer));
        }
        let signature = Signature::from_bytes(&body[12..]).map_err(|_| fail(buffer))?;
        Ok((
            rest,
            BlobMessage::Beacon {
                hops,
                beacon: Box::new(Beacon {
                    key,
                    issued_at,
                    lifetime_s,
                    signature,
                }),
            },
        ))
    }

    fn deserialize_wanted<'a, E: ParseError<&'a [u8]> + ContextError<&'a [u8]>>(
        &self,
        buffer: &'a [u8],
    ) -> IResult<&'a [u8], BlobMessage, E> {
        let fail = |input: &'a [u8]| {
            nom::Err::Error(ParseError::from_error_kind(
                input,
                nom::error::ErrorKind::Verify,
            ))
        };
        let (&hops, buffer) = buffer.split_first().ok_or_else(|| fail(buffer))?;
        let (mut buffer, count) = self.wanted_length_deserializer.deserialize(buffer)?;
        let mut entries = Vec::with_capacity(count as usize);
        for _ in 0..count {
            if buffer.len() < WANTED_ENTRY_BYTES {
                return Err(fail(buffer));
            }
            let (seeker, rest) = buffer.split_at(WANTED_SEEKER_LEN);
            let (lifetime, rest) = rest.split_at(4);
            let (&flags, rest) = rest.split_first().expect("checked");
            let lifetime_s = u32::from_be_bytes(lifetime.try_into().expect("4 bytes"));
            if lifetime_s > MAX_WANTED_LIFETIME_S || flags & !WANTED_FLAG_LOCAL != 0 {
                return Err(fail(buffer));
            }
            entries.push(WantedEntry {
                seeker: seeker.try_into().expect("34 bytes"),
                lifetime_s,
                local: flags & WANTED_FLAG_LOCAL != 0,
            });
            buffer = rest;
        }
        Ok((buffer, BlobMessage::Wanted { hops, entries }))
    }

    fn deserialize_blobs<'a, E: ParseError<&'a [u8]> + ContextError<&'a [u8]>>(
        &self,
        buffer: &'a [u8],
    ) -> IResult<&'a [u8], Vec<BlobEnvelope>, E> {
        length_count(
            context("Failed length blobs deserialization", |input| {
                self.blobs_length_deserializer.deserialize(input)
            }),
            context("Failed BlobEnvelope deserialization", |input| {
                self.envelope_deserializer.deserialize(input)
            }),
        )(buffer)
    }

    fn deserialize_ids<'a, E: ParseError<&'a [u8]> + ContextError<&'a [u8]>>(
        &self,
        length_deserializer: &U64VarIntDeserializer,
        buffer: &'a [u8],
    ) -> IResult<&'a [u8], Vec<BlobId>, E> {
        length_count(
            context("Failed length ids deserialization", |input| {
                length_deserializer.deserialize(input)
            }),
            context("Failed BlobId deserialization", |input| {
                self.blob_id_deserializer.deserialize(input)
            }),
        )(buffer)
    }
}

impl Deserializer<BlobMessage> for BlobMessageDeserializer {
    fn deserialize<'a, E: ParseError<&'a [u8]> + ContextError<&'a [u8]>>(
        &self,
        buffer: &'a [u8],
    ) -> IResult<&'a [u8], BlobMessage, E> {
        context("Failed BlobMessage deserialization", |buffer| {
            let (buffer, raw_id) = self.id_deserializer.deserialize(buffer)?;
            let id = BlobMessageTypeId::try_from(raw_id).map_err(|_| {
                nom::Err::Error(ParseError::from_error_kind(
                    buffer,
                    nom::error::ErrorKind::Verify,
                ))
            })?;
            match id {
                BlobMessageTypeId::Announce => {
                    context("Failed Announce deserialization", |input| {
                        self.deserialize_ids(&self.ids_length_deserializer, input)
                    })
                    .map(BlobMessage::Announce)
                    .parse(buffer)
                }
                BlobMessageTypeId::Ask => context("Failed Ask deserialization", |input| {
                    self.deserialize_ids(&self.ids_length_deserializer, input)
                })
                .map(BlobMessage::Ask)
                .parse(buffer),
                BlobMessageTypeId::Blobs => context("Failed Blobs deserialization", |input| {
                    self.deserialize_blobs(input)
                })
                .map(BlobMessage::Blobs)
                .parse(buffer),
                BlobMessageTypeId::LocalBlobs => {
                    context("Failed LocalBlobs deserialization", |input| {
                        self.deserialize_blobs(input)
                    })
                    .map(BlobMessage::LocalBlobs)
                    .parse(buffer)
                }
                BlobMessageTypeId::SyncRequest => context(
                    "Failed SyncRequest deserialization",
                    tuple((
                        context("Failed since deserialization", |input| {
                            self.time_deserializer.deserialize(input)
                        }),
                        context("Failed cursor deserialization", |input| {
                            self.cursor_deserializer.deserialize(input)
                        }),
                        context("Failed max deserialization", |input| {
                            self.max_deserializer.deserialize(input)
                        }),
                    )),
                )
                .map(|(since, cursor, max)| BlobMessage::SyncRequest { since, cursor, max })
                .parse(buffer),
                BlobMessageTypeId::SyncIds => context(
                    "Failed SyncIds deserialization",
                    tuple((
                        context("Failed ids deserialization", |input| {
                            self.deserialize_ids(&self.page_length_deserializer, input)
                        }),
                        context("Failed next deserialization", |input| {
                            self.cursor_deserializer.deserialize(input)
                        }),
                    )),
                )
                .map(|(ids, next)| BlobMessage::SyncIds { ids, next })
                .parse(buffer),
                BlobMessageTypeId::Wanted => context("Failed Wanted deserialization", |input| {
                    self.deserialize_wanted(input)
                })
                .parse(buffer),
                BlobMessageTypeId::HaveSummary => {
                    context("Failed HaveSummary deserialization", |input| {
                        self.deserialize_gcs(input)
                    })
                    .map(BlobMessage::HaveSummary)
                    .parse(buffer)
                }
                BlobMessageTypeId::WantedSummary => {
                    context("Failed WantedSummary deserialization", |input| {
                        self.deserialize_wanted_summary(input)
                    })
                    .parse(buffer)
                }
                BlobMessageTypeId::Beacon => context("Failed Beacon deserialization", |input| {
                    self.deserialize_beacon(input)
                })
                .parse(buffer),
            }
        })
        .parse(buffer)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::blob::BlobKind;
    use massa_serialization::DeserializeError;

    #[test]
    fn wanted_round_trips_and_is_bounded() {
        let entry = |n: u8, lifetime_s: u32| WantedEntry {
            seeker: [n; WANTED_SEEKER_LEN],
            lifetime_s,
            local: n.is_multiple_of(2),
        };
        let msg = BlobMessage::Wanted {
            hops: 5,
            entries: vec![entry(1, 3600), entry(2, MAX_WANTED_LIFETIME_S)],
        };
        let mut buf = Vec::new();
        BlobMessageSerializer::new()
            .serialize(&msg, &mut buf)
            .unwrap();
        assert_eq!(buf.len(), 1 + 1 + 1 + 2 * WANTED_ENTRY_BYTES);
        // the flags byte ends each entry: the regular one, then the local-only one
        assert_eq!(buf[3 + WANTED_ENTRY_BYTES - 1], 0);
        assert_eq!(buf[buf.len() - 1], WANTED_FLAG_LOCAL);
        let de = BlobMessageDeserializer::new(args());
        let (rest, back) = de.deserialize::<DeserializeError>(&buf).unwrap();
        assert!(rest.is_empty());
        assert_eq!(back, msg);

        // a lifetime above the cap, an unknown flag, a short entry and too many
        // entries are refused
        let mut long = buf.clone();
        let at = long.len() - 5;
        long[at..at + 4].copy_from_slice(&(MAX_WANTED_LIFETIME_S + 1).to_be_bytes());
        assert!(de.deserialize::<DeserializeError>(&long).is_err());
        let mut flags = buf.clone();
        *flags.last_mut().unwrap() = 0b10;
        assert!(de.deserialize::<DeserializeError>(&flags).is_err());
        assert!(de
            .deserialize::<DeserializeError>(&buf[..buf.len() - 1])
            .is_err());
        let too_many = BlobMessage::Wanted {
            hops: 1,
            entries: vec![entry(0, 1); MAX_WANTED_PER_MESSAGE as usize + 1],
        };
        assert!(BlobMessageSerializer::new()
            .serialize(&too_many, &mut Vec::new())
            .is_err());
    }

    #[test]
    fn beacons_round_trip_verify_and_are_bounded() {
        let kp = KeyPair::generate(0).unwrap();
        let beacon = Beacon::sign(&kp, 1_700_000_000_000, 1200).unwrap();
        assert!(beacon.verify());
        let msg = BlobMessage::Beacon {
            hops: 31,
            beacon: Box::new(beacon),
        };
        let mut buf = Vec::new();
        BlobMessageSerializer::new()
            .serialize(&msg, &mut buf)
            .unwrap();
        assert_eq!(buf.len(), 1 + 1 + 33 + 8 + 4 + 65);
        let de = BlobMessageDeserializer::new(args());
        let (rest, back) = de.deserialize::<DeserializeError>(&buf).unwrap();
        assert!(rest.is_empty());
        assert_eq!(back, msg);
        // the hop budget is outside the signature, the lifetime inside
        let BlobMessage::Beacon { beacon, .. } = back else {
            unreachable!()
        };
        let mut longer = beacon.clone();
        longer.lifetime_s -= 1;
        assert!(!longer.verify());
        // short, and lifetime above the cap
        assert!(de
            .deserialize::<DeserializeError>(&buf[..buf.len() - 1])
            .is_err());
        let mut long = buf.clone();
        long[1 + 1 + 33 + 8..1 + 1 + 33 + 12]
            .copy_from_slice(&(MAX_BEACON_LIFETIME_S + 1).to_be_bytes());
        assert!(de.deserialize::<DeserializeError>(&long).is_err());
    }

    #[test]
    fn summaries_round_trip_and_are_bounded() {
        let set = Gcs::encode(vec![1, 40, 700], 8);
        let have = BlobMessage::HaveSummary(set.clone());
        let wanted = BlobMessage::WantedSummary {
            set: set.clone(),
            hops: vec![0, 12, 32],
            lifetimes: vec![1, 30, MAX_WANTED_SUMMARY_LIFETIME],
        };
        let de = BlobMessageDeserializer::new(args());
        for msg in [&have, &wanted] {
            let mut buf = Vec::new();
            BlobMessageSerializer::new()
                .serialize(msg, &mut buf)
                .unwrap();
            let (rest, back) = de.deserialize::<DeserializeError>(&buf).unwrap();
            assert!(rest.is_empty());
            assert_eq!(&back, msg);
            assert!(de
                .deserialize::<DeserializeError>(&buf[..buf.len() - 1])
                .is_err());
        }
        // header bytes: type, p, n, length
        let mut buf = Vec::new();
        BlobMessageSerializer::new()
            .serialize(&have, &mut buf)
            .unwrap();
        assert_eq!(&buf[..4], &[6, 8, 3, set.bits.len() as u8]);

        // a zero or too long lifetime, a p out of range, a length over the bound
        let mut bad = Vec::new();
        BlobMessageSerializer::new()
            .serialize(&wanted, &mut bad)
            .unwrap();
        let last = bad.len() - 1;
        bad[last] = MAX_WANTED_SUMMARY_LIFETIME + 1;
        assert!(de.deserialize::<DeserializeError>(&bad).is_err());
        bad[last] = 0;
        assert!(de.deserialize::<DeserializeError>(&bad).is_err());
        let mut p = buf.clone();
        p[1] = GCS_MAX_P + 1;
        assert!(de.deserialize::<DeserializeError>(&p).is_err());
        let mut len = buf.clone();
        len[3] = Gcs::max_len(3, 8) as u8 + 1;
        assert!(de.deserialize::<DeserializeError>(&len).is_err());
        // metadata that does not match the set does not serialize
        let short = BlobMessage::WantedSummary {
            set,
            hops: vec![1],
            lifetimes: vec![1],
        };
        assert!(BlobMessageSerializer::new()
            .serialize(&short, &mut Vec::new())
            .is_err());
    }

    fn args() -> BlobMessageDeserializerArgs {
        BlobMessageDeserializerArgs {
            max_ids_per_message: 3,
            max_blobs_per_message: 2,
            max_key_len: 8,
            max_payload_len: 64,
            max_sync_page: 4,
        }
    }

    fn id(n: u8) -> BlobId {
        BlobId([n; 32])
    }

    fn envelope(n: u8) -> BlobEnvelope {
        BlobEnvelope::new(
            BlobKind::KeyValue,
            1_700_000_000_000 + n as u64,
            vec![n; 8],
            vec![n; 64],
        )
    }

    fn all_variants() -> Vec<BlobMessage> {
        vec![
            BlobMessage::Announce(vec![id(1), id(2), id(3)]),
            BlobMessage::Announce(vec![]),
            BlobMessage::Ask(vec![id(9)]),
            BlobMessage::Blobs(vec![envelope(1), envelope(2)]),
            BlobMessage::Blobs(vec![]),
            BlobMessage::LocalBlobs(vec![envelope(3)]),
            BlobMessage::SyncRequest {
                since: UnixMillis(1_700_000_000_000),
                cursor: None,
                max: 4,
            },
            BlobMessage::SyncRequest {
                since: UnixMillis(0),
                cursor: Some((UnixMillis(1_700_000_000_001), id(7))),
                max: 0,
            },
            BlobMessage::SyncIds {
                ids: vec![id(1), id(2), id(3), id(4)],
                next: Some((UnixMillis(u64::MAX), id(4))),
            },
            BlobMessage::SyncIds {
                ids: vec![],
                next: None,
            },
        ]
    }

    #[test]
    fn roundtrip_every_variant() {
        let serializer = BlobMessageSerializer::new();
        let deserializer = BlobMessageDeserializer::new(args());
        for msg in all_variants() {
            let mut buf = vec![];
            serializer.serialize(&msg, &mut buf).unwrap();
            assert_eq!(buf[0], u64::from(BlobMessageTypeId::from(&msg)) as u8);
            let (rest, back) = deserializer
                .deserialize::<DeserializeError>(&buf)
                .unwrap_or_else(|e| panic!("{:?}: {}", msg, e));
            assert!(rest.is_empty(), "{:?}", msg);
            assert_eq!(back, msg);
        }
    }

    #[test]
    fn exact_bytes() {
        let serializer = BlobMessageSerializer::new();
        let mut buf = vec![];
        serializer
            .serialize(&BlobMessage::Ask(vec![id(0xab)]), &mut buf)
            .unwrap();
        let mut expected = vec![1u8, 1];
        expected.extend_from_slice(&[0xab; 32]);
        assert_eq!(buf, expected);

        let mut buf = vec![];
        serializer
            .serialize(
                &BlobMessage::SyncRequest {
                    since: UnixMillis(300),
                    cursor: Some((UnixMillis(1), id(0xcd))),
                    max: 129,
                },
                &mut buf,
            )
            .unwrap();
        let mut expected = vec![3u8, 0xac, 0x02, b'1', 1];
        expected.extend_from_slice(&[0xcd; 32]);
        expected.extend_from_slice(&[0x81, 0x01]);
        assert_eq!(buf, expected);

        let mut buf = vec![];
        serializer
            .serialize(
                &BlobMessage::SyncIds {
                    ids: vec![],
                    next: None,
                },
                &mut buf,
            )
            .unwrap();
        assert_eq!(buf, vec![4u8, 0, b'0']);
    }

    #[test]
    fn bounds_are_enforced() {
        let serializer = BlobMessageSerializer::new();
        let deserializer = BlobMessageDeserializer::new(args());
        let rejected = |msg: &BlobMessage| {
            let mut buf = vec![];
            serializer.serialize(msg, &mut buf).unwrap();
            deserializer.deserialize::<DeserializeError>(&buf).is_err()
        };
        // too many ids
        assert!(rejected(&BlobMessage::Announce(vec![id(1); 4])));
        assert!(rejected(&BlobMessage::Ask(vec![id(1); 4])));
        // too many blobs
        assert!(rejected(&BlobMessage::Blobs(vec![envelope(1); 3])));
        assert!(rejected(&BlobMessage::LocalBlobs(vec![envelope(1); 3])));
        // envelope too big
        let mut big = envelope(1);
        big.payload.push(0);
        assert!(rejected(&BlobMessage::Blobs(vec![big])));
        let mut big = envelope(1);
        big.key.push(0);
        assert!(rejected(&BlobMessage::Blobs(vec![big])));
        // sync page too large
        assert!(rejected(&BlobMessage::SyncIds {
            ids: vec![id(1); 5],
            next: None,
        }));
        assert!(rejected(&BlobMessage::SyncRequest {
            since: UnixMillis(0),
            cursor: None,
            max: 5,
        }));
        // unknown type id
        assert!(deserializer
            .deserialize::<DeserializeError>(&[5u8, 0])
            .is_err());
        // bad option tag
        assert!(deserializer
            .deserialize::<DeserializeError>(&[4u8, 0, 2])
            .is_err());
    }

    #[test]
    fn truncated_input_rejected() {
        let serializer = BlobMessageSerializer::new();
        let deserializer = BlobMessageDeserializer::new(args());
        for msg in all_variants() {
            let mut buf = vec![];
            serializer.serialize(&msg, &mut buf).unwrap();
            for cut in 0..buf.len() {
                assert!(
                    deserializer
                        .deserialize::<DeserializeError>(&buf[..cut])
                        .is_err(),
                    "{:?} accepted truncated at {}",
                    msg,
                    cut
                );
            }
            // trailing bytes are left over, not consumed
            buf.push(0xff);
            let (rest, _) = deserializer.deserialize::<DeserializeError>(&buf).unwrap();
            assert_eq!(rest, &[0xff]);
        }
    }
}
