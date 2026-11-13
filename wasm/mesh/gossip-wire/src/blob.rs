//! Blob model shared by the three pools and by the propagation layer.
//!
//! A [`BlobEnvelope`] is the unit of replication: every node stores and gossips
//! envelopes; the pool a blob belongs to is given by its [`BlobKind`].
//!
//! The canonical encoding is:
//!
//! ```text
//! u8 kind ‖ u64 BE created_at ‖ varint(key.len) ‖ key ‖ varint(payload.len) ‖ payload
//! ```
//!
//! and the [`BlobId`] is the blake3 hash of that encoding. `created_at` is part of
//! the id on purpose: retention (`created_at + retention`) is therefore identical on
//! every node, and an expired blob can never be re-accepted by a lagging peer.

use massa_serialization::{
    Deserializer, SerializeError, Serializer, U64VarIntDeserializer, U64VarIntSerializer,
};
use nom::{
    bytes::complete::take,
    error::{context, ContextError, ParseError},
    number::complete::{be_u64, u8 as nom_u8},
    IResult, Parser,
};
use serde::{Deserialize, Serialize};
use std::fmt;
use std::ops::Bound::Included;

/// Hard cap on a blob payload (the technical paper fixes 10 MB).
pub const MAX_BLOB_PAYLOAD_LEN: usize = 10 * 1024 * 1024;
/// Hard cap on a key-value key (the paper allows 128 bytes; the seeker is 34 bytes).
pub const MAX_BLOB_KEY_LEN: usize = 128;
/// Length of the seeker key used by the session layer (`[32] ‖ blake3(pk) ‖ [1]`).
pub const SEEKER_KEY_LEN: usize = 34;
/// Trailing tag byte of a seeker key (`MESSAGE_SEEKER_DB_KEY` in `wasm/sessions`).
pub const SEEKER_KEY_TAG: u8 = 1;

/// Which pool a blob belongs to.
#[repr(u8)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
pub enum BlobKind {
    /// Counter-indexed pool (announcements). Each node assigns a local counter on insert.
    Bulletin = 0,
    /// Signature-authenticated key-value pool (messages). `key` is the seeker.
    KeyValue = 1,
    /// Hash-indexed pool (published public keys). Key is `blake3(payload)`.
    Hash = 2,
}

impl BlobKind {
    /// Decodes a kind byte.
    pub fn from_u8(v: u8) -> Option<Self> {
        match v {
            0 => Some(Self::Bulletin),
            1 => Some(Self::KeyValue),
            2 => Some(Self::Hash),
            _ => None,
        }
    }
}

/// Content-addressed identifier of a blob: blake3 of its canonical encoding.
#[derive(Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
pub struct BlobId(pub [u8; 32]);

impl BlobId {
    /// Size in bytes.
    pub const SIZE: usize = 32;

    /// Raw bytes.
    pub fn as_bytes(&self) -> &[u8; 32] {
        &self.0
    }

    /// Builds an id from raw bytes.
    pub fn from_bytes(b: [u8; 32]) -> Self {
        Self(b)
    }

    /// Hex encoding (for logs and APIs).
    pub fn to_hex(&self) -> String {
        let mut s = String::with_capacity(64);
        for b in self.0 {
            use std::fmt::Write;
            let _ = write!(s, "{:02x}", b);
        }
        s
    }
}

impl fmt::Debug for BlobId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "BlobId({})", &self.to_hex()[..16])
    }
}

impl fmt::Display for BlobId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.to_hex())
    }
}

/// The replicated unit.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct BlobEnvelope {
    /// Pool.
    pub kind: BlobKind,
    /// Creation time, unix milliseconds, set by the first node that accepted the blob.
    pub created_at: u64,
    /// Pool key (empty for `Bulletin` and `Hash`; the seeker for `KeyValue`).
    pub key: Vec<u8>,
    /// Opaque, client-encrypted bytes.
    pub payload: Vec<u8>,
}

impl BlobEnvelope {
    /// Creates an envelope; does not validate.
    pub fn new(kind: BlobKind, created_at: u64, key: Vec<u8>, payload: Vec<u8>) -> Self {
        Self {
            kind,
            created_at,
            key,
            payload,
        }
    }

    /// Canonical encoding (see module docs). Infallible for envelopes within limits;
    /// panics only if a length exceeds `u64`, which cannot happen in practice.
    pub fn canonical_bytes(&self) -> Vec<u8> {
        let mut buf = Vec::with_capacity(1 + 8 + 10 + self.key.len() + 10 + self.payload.len());
        BlobEnvelopeSerializer::new()
            .serialize(self, &mut buf)
            .expect("blob envelope serialization cannot fail");
        buf
    }

    /// Content id.
    pub fn id(&self) -> BlobId {
        BlobId(*massa_hash::Hash::compute_from(&self.canonical_bytes()).to_bytes())
    }

    /// Size accounted for storage and bandwidth budgets.
    pub fn wire_size(&self) -> usize {
        1 + 8 + 10 + self.key.len() + 10 + self.payload.len()
    }
}

/// Serializer for [`BlobEnvelope`].
#[derive(Clone, Default)]
pub struct BlobEnvelopeSerializer {
    len_ser: U64VarIntSerializer,
}

impl BlobEnvelopeSerializer {
    /// Creates a serializer.
    pub fn new() -> Self {
        Self {
            len_ser: U64VarIntSerializer::new(),
        }
    }
}

impl Serializer<BlobEnvelope> for BlobEnvelopeSerializer {
    fn serialize(&self, value: &BlobEnvelope, buffer: &mut Vec<u8>) -> Result<(), SerializeError> {
        buffer.push(value.kind as u8);
        buffer.extend_from_slice(&value.created_at.to_be_bytes());
        self.len_ser.serialize(&(value.key.len() as u64), buffer)?;
        buffer.extend_from_slice(&value.key);
        self.len_ser
            .serialize(&(value.payload.len() as u64), buffer)?;
        buffer.extend_from_slice(&value.payload);
        Ok(())
    }
}

/// Bounded deserializer for [`BlobEnvelope`].
#[derive(Clone)]
pub struct BlobEnvelopeDeserializer {
    key_len_deser: U64VarIntDeserializer,
    payload_len_deser: U64VarIntDeserializer,
}

impl BlobEnvelopeDeserializer {
    /// Creates a deserializer with explicit bounds on key and payload lengths.
    pub fn new(max_key_len: u64, max_payload_len: u64) -> Self {
        Self {
            key_len_deser: U64VarIntDeserializer::new(Included(0), Included(max_key_len)),
            payload_len_deser: U64VarIntDeserializer::new(Included(0), Included(max_payload_len)),
        }
    }
}

impl Default for BlobEnvelopeDeserializer {
    fn default() -> Self {
        Self::new(MAX_BLOB_KEY_LEN as u64, MAX_BLOB_PAYLOAD_LEN as u64)
    }
}

impl Deserializer<BlobEnvelope> for BlobEnvelopeDeserializer {
    fn deserialize<'a, E: ParseError<&'a [u8]> + ContextError<&'a [u8]>>(
        &self,
        buffer: &'a [u8],
    ) -> IResult<&'a [u8], BlobEnvelope, E> {
        context(
            "Failed BlobEnvelope deserialization",
            |input: &'a [u8]| {
                let (rest, kind_byte) = context("kind", nom_u8)(input)?;
                let kind = BlobKind::from_u8(kind_byte).ok_or_else(|| {
                    nom::Err::Error(ParseError::from_error_kind(
                        input,
                        nom::error::ErrorKind::Verify,
                    ))
                })?;
                let (rest, created_at) = context("created_at", be_u64)(rest)?;
                let (rest, key_len) =
                    context("key length", |i| self.key_len_deser.deserialize(i)).parse(rest)?;
                let (rest, key) = context("key", take(key_len as usize))(rest)?;
                let (rest, payload_len) =
                    context("payload length", |i| self.payload_len_deser.deserialize(i))
                        .parse(rest)?;
                let (rest, payload) = context("payload", take(payload_len as usize))(rest)?;
                Ok((
                    rest,
                    BlobEnvelope {
                        kind,
                        created_at,
                        key: key.to_vec(),
                        payload: payload.to_vec(),
                    },
                ))
            },
        )
        .parse(buffer)
    }
}

/// Serializer for [`BlobId`] (raw 32 bytes).
#[derive(Clone, Default)]
pub struct BlobIdSerializer;

impl BlobIdSerializer {
    /// Creates a serializer.
    pub fn new() -> Self {
        Self
    }
}

impl Serializer<BlobId> for BlobIdSerializer {
    fn serialize(&self, value: &BlobId, buffer: &mut Vec<u8>) -> Result<(), SerializeError> {
        buffer.extend_from_slice(&value.0);
        Ok(())
    }
}

/// Deserializer for [`BlobId`].
#[derive(Clone, Default)]
pub struct BlobIdDeserializer;

impl BlobIdDeserializer {
    /// Creates a deserializer.
    pub fn new() -> Self {
        Self
    }
}

impl Deserializer<BlobId> for BlobIdDeserializer {
    fn deserialize<'a, E: ParseError<&'a [u8]> + ContextError<&'a [u8]>>(
        &self,
        buffer: &'a [u8],
    ) -> IResult<&'a [u8], BlobId, E> {
        context("Failed BlobId deserialization", |input: &'a [u8]| {
            let (rest, bytes) = take(BlobId::SIZE)(input)?;
            let mut id = [0u8; 32];
            id.copy_from_slice(bytes);
            Ok((rest, BlobId(id)))
        })
        .parse(buffer)
    }
}

/// Key of the hash-indexed pool for a payload: `blake3(payload)`.
pub fn hash_pool_key(payload: &[u8]) -> [u8; 32] {
    *blake3::hash(payload).as_bytes()
}

#[cfg(test)]
mod tests {
    use super::*;
    use massa_serialization::DeserializeError;

    fn sample() -> BlobEnvelope {
        BlobEnvelope::new(
            BlobKind::KeyValue,
            1_700_000_000_000,
            vec![1, 2, 3],
            vec![9; 100],
        )
    }

    #[test]
    fn canonical_roundtrip() {
        let env = sample();
        let bytes = env.canonical_bytes();
        let (rest, back) = BlobEnvelopeDeserializer::default()
            .deserialize::<DeserializeError>(&bytes)
            .unwrap();
        assert!(rest.is_empty());
        assert_eq!(back, env);
        assert_eq!(back.id(), env.id());
    }

    #[test]
    fn id_depends_on_every_field() {
        let a = sample();
        let mut b = sample();
        b.created_at += 1;
        assert_ne!(a.id(), b.id());
        let mut c = sample();
        c.kind = BlobKind::Bulletin;
        assert_ne!(a.id(), c.id());
        let mut d = sample();
        d.key.push(0);
        assert_ne!(a.id(), d.id());
    }

    #[test]
    fn bounds_are_enforced() {
        let env = sample();
        let bytes = env.canonical_bytes();
        // key bound too small
        assert!(BlobEnvelopeDeserializer::new(2, 1_000)
            .deserialize::<DeserializeError>(&bytes)
            .is_err());
        // payload bound too small
        assert!(BlobEnvelopeDeserializer::new(10, 50)
            .deserialize::<DeserializeError>(&bytes)
            .is_err());
        // unknown kind
        let mut bad = bytes.clone();
        bad[0] = 7;
        assert!(BlobEnvelopeDeserializer::default()
            .deserialize::<DeserializeError>(&bad)
            .is_err());
        // truncated
        assert!(BlobEnvelopeDeserializer::default()
            .deserialize::<DeserializeError>(&bytes[..bytes.len() - 1])
            .is_err());
    }

    #[test]
    fn hash_pool_key_is_blake3() {
        assert_eq!(hash_pool_key(b"abc"), *blake3::hash(b"abc").as_bytes());
    }
}
