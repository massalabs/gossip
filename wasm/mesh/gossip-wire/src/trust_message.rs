//! Trust handshake messages: challenge offers, proofs and verdicts.
//!
//! These are exchanged once per connection, right after the transport handshake,
//! and are not part of [`crate::Message`].
//!
//! Wire form:
//! - `TrustChallenge`: `be_u16 scheme ‖ varint(params.len) ‖ params ‖ nonce (32 bytes)`
//! - `TrustOffer`: `varint(count) ‖ TrustChallenge*`
//! - `TrustProof`: `be_u16 scheme ‖ varint(bytes.len) ‖ bytes`
//! - `TrustProofs`: `varint(count) ‖ TrustProof*`
//! - `TrustVerdict`: `u8 admitted (0/1) ‖ be_u16 trust_hint ‖ u8 reason`

use std::ops::Bound::Included;

use massa_serialization::{
    BoolDeserializer, BoolSerializer, Deserializer, SerializeError, Serializer,
    U64VarIntDeserializer, U64VarIntSerializer,
};
use nom::{
    bytes::complete::take,
    error::{context, ContextError, ParseError},
    multi::length_count,
    number::complete::{be_u16, be_u32, be_u64, u8 as nom_u8},
    sequence::tuple,
    IResult, Parser,
};
use serde::{Deserialize, Serialize};

use crate::primitives::{VecU8Deserializer, VecU8Serializer};

/// Identifier of a trust scheme (proof of work, stake, social...).
pub type SchemeId = u16;

/// Size of a challenge nonce.
pub const TRUST_NONCE_LEN: usize = 32;
/// Maximum number of challenges in a [`TrustOffer`].
pub const MAX_TRUST_CHALLENGES: u64 = 16;
/// Maximum length of the scheme parameters of one [`TrustChallenge`] (4 KiB).
pub const MAX_TRUST_PARAMS_LEN: u64 = 4 * 1024;
/// Maximum number of proofs in a [`TrustProofs`].
pub const MAX_TRUST_PROOFS: u64 = 16;
/// Default maximum length of one [`TrustProof`] (1 MiB; stake proofs are ~300 KiB).
pub const DEFAULT_MAX_TRUST_PROOF_LEN: u64 = 1024 * 1024;

/// One challenge of a [`TrustOffer`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TrustChallenge {
    /// Scheme the challenge belongs to.
    pub scheme: SchemeId,
    /// Scheme-specific parameters (difficulty, epoch, ...).
    pub params: Vec<u8>,
    /// Fresh random nonce the proof must bind to.
    pub nonce: [u8; TRUST_NONCE_LEN],
}

/// The set of challenges a node offers to a connecting peer.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct TrustOffer {
    /// Challenges, one per accepted scheme.
    pub challenges: Vec<TrustChallenge>,
}

/// A proof answering one [`TrustChallenge`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TrustProof {
    /// Scheme the proof belongs to.
    pub scheme: SchemeId,
    /// Scheme-specific proof bytes.
    pub bytes: Vec<u8>,
}

/// The proofs a connecting peer sends back.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct TrustProofs {
    /// Proofs, at most one per scheme.
    pub proofs: Vec<TrustProof>,
}

/// What a node will accept from the peer it is admitting: message size caps and the
/// per-minute budgets it enforces on that peer, already scaled by the trust it granted.
///
/// A sender that stays under these numbers is never struck for a protocol violation
/// (oversized list or frame) and never has its answers dropped for want of ingest
/// budget. Every field is a hard fact about the receiver's own configuration, so a
/// dishonest value only hurts the node that advertises it. A zero means "unknown",
/// and the sender then falls back to its own configuration.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct PeerLimits {
    /// Largest frame the node reads.
    pub max_message_size: u32,
    /// Most ids in one `Announce`, `Ask` or `SyncIds`.
    pub max_ids_per_message: u32,
    /// Most blobs in one `Blobs` message.
    pub max_blobs_per_message: u32,
    /// Most cumulative blob bytes in one `Blobs` message.
    pub max_blobs_message_bytes: u32,
    /// Largest `SyncRequest.max` it answers.
    pub max_sync_page: u32,
    /// Blobs per minute it takes from this peer.
    pub ingest_blobs_per_min: u32,
    /// Bytes per minute it takes from this peer.
    pub ingest_bytes_per_min: u64,
    /// Unsolicited blobs per minute it tolerates before counting flooding.
    pub unsolicited_blobs_per_min: u32,
    /// `SyncRequest`s per minute it answers for this peer.
    pub sync_requests_per_min: u32,
}

/// Encoded size of [`PeerLimits`]: eight `u32` and one `u64`.
pub const PEER_LIMITS_LEN: usize = 8 * 4 + 8;

/// The node's decision after checking the proofs.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct TrustVerdict {
    /// Whether the peer is admitted.
    pub admitted: bool,
    /// Application-defined trust level hint (higher is more trusted).
    pub trust_hint: u16,
    /// Application-defined reason code (`0` = none).
    pub reason: u8,
    /// What the node will accept from the peer (zeros when refusing it).
    pub limits: PeerLimits,
}

// ---------------------------------------------------------------------------
// TrustOffer
// ---------------------------------------------------------------------------

/// Serializer for [`TrustOffer`].
#[derive(Clone, Default)]
pub struct TrustOfferSerializer {
    length_serializer: U64VarIntSerializer,
    params_serializer: VecU8Serializer,
}

impl TrustOfferSerializer {
    /// Creates a `TrustOfferSerializer`
    pub fn new() -> Self {
        Self::default()
    }
}

impl Serializer<TrustOffer> for TrustOfferSerializer {
    fn serialize(&self, value: &TrustOffer, buffer: &mut Vec<u8>) -> Result<(), SerializeError> {
        let len: u64 =
            value.challenges.len().try_into().map_err(|err| {
                SerializeError::NumberTooBig(format!("too many challenges: {}", err))
            })?;
        self.length_serializer.serialize(&len, buffer)?;
        for challenge in &value.challenges {
            buffer.extend_from_slice(&challenge.scheme.to_be_bytes());
            self.params_serializer
                .serialize(&challenge.params, buffer)?;
            buffer.extend_from_slice(&challenge.nonce);
        }
        Ok(())
    }
}

/// Bounded deserializer for [`TrustOffer`].
#[derive(Clone)]
pub struct TrustOfferDeserializer {
    length_deserializer: U64VarIntDeserializer,
    params_deserializer: VecU8Deserializer,
}

impl TrustOfferDeserializer {
    /// Creates a `TrustOfferDeserializer` accepting at most `max_challenges`
    /// challenges of at most `max_params_len` parameter bytes each.
    pub const fn new(max_challenges: u64, max_params_len: u64) -> Self {
        Self {
            length_deserializer: U64VarIntDeserializer::new(Included(0), Included(max_challenges)),
            params_deserializer: VecU8Deserializer::new(Included(0), Included(max_params_len)),
        }
    }
}

impl Default for TrustOfferDeserializer {
    /// Uses [`MAX_TRUST_CHALLENGES`] and [`MAX_TRUST_PARAMS_LEN`].
    fn default() -> Self {
        Self::new(MAX_TRUST_CHALLENGES, MAX_TRUST_PARAMS_LEN)
    }
}

impl Deserializer<TrustOffer> for TrustOfferDeserializer {
    fn deserialize<'a, E: ParseError<&'a [u8]> + ContextError<&'a [u8]>>(
        &self,
        buffer: &'a [u8],
    ) -> IResult<&'a [u8], TrustOffer, E> {
        context(
            "Failed TrustOffer deserialization",
            length_count(
                context("Failed length challenges deserialization", |input| {
                    self.length_deserializer.deserialize(input)
                }),
                context(
                    "Failed TrustChallenge deserialization",
                    tuple((
                        context("Failed scheme deserialization", be_u16),
                        context("Failed params deserialization", |input| {
                            self.params_deserializer.deserialize(input)
                        }),
                        context("Failed nonce deserialization", |input: &'a [u8]| {
                            let (rest, nonce) = take(TRUST_NONCE_LEN)(input)?;
                            let mut out = [0u8; TRUST_NONCE_LEN];
                            out.copy_from_slice(nonce);
                            Ok((rest, out))
                        }),
                    ))
                    .map(|(scheme, params, nonce)| TrustChallenge {
                        scheme,
                        params,
                        nonce,
                    }),
                ),
            ),
        )
        .map(|challenges| TrustOffer { challenges })
        .parse(buffer)
    }
}

// ---------------------------------------------------------------------------
// TrustProofs
// ---------------------------------------------------------------------------

/// Serializer for [`TrustProofs`].
#[derive(Clone, Default)]
pub struct TrustProofsSerializer {
    length_serializer: U64VarIntSerializer,
    bytes_serializer: VecU8Serializer,
}

impl TrustProofsSerializer {
    /// Creates a `TrustProofsSerializer`
    pub fn new() -> Self {
        Self::default()
    }
}

impl Serializer<TrustProofs> for TrustProofsSerializer {
    fn serialize(&self, value: &TrustProofs, buffer: &mut Vec<u8>) -> Result<(), SerializeError> {
        let len: u64 = value
            .proofs
            .len()
            .try_into()
            .map_err(|err| SerializeError::NumberTooBig(format!("too many proofs: {}", err)))?;
        self.length_serializer.serialize(&len, buffer)?;
        for proof in &value.proofs {
            buffer.extend_from_slice(&proof.scheme.to_be_bytes());
            self.bytes_serializer.serialize(&proof.bytes, buffer)?;
        }
        Ok(())
    }
}

/// Bounded deserializer for [`TrustProofs`].
#[derive(Clone)]
pub struct TrustProofsDeserializer {
    length_deserializer: U64VarIntDeserializer,
    bytes_deserializer: VecU8Deserializer,
}

impl TrustProofsDeserializer {
    /// Creates a `TrustProofsDeserializer` accepting at most `max_proofs` proofs of at
    /// most `max_proof_len` bytes each.
    pub const fn new(max_proofs: u64, max_proof_len: u64) -> Self {
        Self {
            length_deserializer: U64VarIntDeserializer::new(Included(0), Included(max_proofs)),
            bytes_deserializer: VecU8Deserializer::new(Included(0), Included(max_proof_len)),
        }
    }
}

impl Default for TrustProofsDeserializer {
    /// Uses [`MAX_TRUST_PROOFS`] and [`DEFAULT_MAX_TRUST_PROOF_LEN`].
    fn default() -> Self {
        Self::new(MAX_TRUST_PROOFS, DEFAULT_MAX_TRUST_PROOF_LEN)
    }
}

impl Deserializer<TrustProofs> for TrustProofsDeserializer {
    fn deserialize<'a, E: ParseError<&'a [u8]> + ContextError<&'a [u8]>>(
        &self,
        buffer: &'a [u8],
    ) -> IResult<&'a [u8], TrustProofs, E> {
        context(
            "Failed TrustProofs deserialization",
            length_count(
                context("Failed length proofs deserialization", |input| {
                    self.length_deserializer.deserialize(input)
                }),
                context(
                    "Failed TrustProof deserialization",
                    tuple((
                        context("Failed scheme deserialization", be_u16),
                        context("Failed bytes deserialization", |input| {
                            self.bytes_deserializer.deserialize(input)
                        }),
                    ))
                    .map(|(scheme, bytes)| TrustProof { scheme, bytes }),
                ),
            ),
        )
        .map(|proofs| TrustProofs { proofs })
        .parse(buffer)
    }
}

// ---------------------------------------------------------------------------
// TrustVerdict
// ---------------------------------------------------------------------------

/// Serializer for [`TrustVerdict`].
#[derive(Clone, Default)]
pub struct TrustVerdictSerializer {
    bool_serializer: BoolSerializer,
}

impl TrustVerdictSerializer {
    /// Creates a `TrustVerdictSerializer`
    pub fn new() -> Self {
        Self::default()
    }
}

impl Serializer<TrustVerdict> for TrustVerdictSerializer {
    fn serialize(&self, value: &TrustVerdict, buffer: &mut Vec<u8>) -> Result<(), SerializeError> {
        self.bool_serializer.serialize(&value.admitted, buffer)?;
        buffer.extend_from_slice(&value.trust_hint.to_be_bytes());
        buffer.push(value.reason);
        let l = &value.limits;
        for v in [
            l.max_message_size,
            l.max_ids_per_message,
            l.max_blobs_per_message,
            l.max_blobs_message_bytes,
            l.max_sync_page,
            l.ingest_blobs_per_min,
        ] {
            buffer.extend_from_slice(&v.to_be_bytes());
        }
        buffer.extend_from_slice(&l.ingest_bytes_per_min.to_be_bytes());
        buffer.extend_from_slice(&l.unsolicited_blobs_per_min.to_be_bytes());
        buffer.extend_from_slice(&l.sync_requests_per_min.to_be_bytes());
        Ok(())
    }
}

/// Deserializer for [`TrustVerdict`]. Fixed size, no bound needed.
#[derive(Clone, Default)]
pub struct TrustVerdictDeserializer {
    bool_deserializer: BoolDeserializer,
}

impl TrustVerdictDeserializer {
    /// Creates a `TrustVerdictDeserializer`
    pub fn new() -> Self {
        Self::default()
    }
}

impl Deserializer<TrustVerdict> for TrustVerdictDeserializer {
    fn deserialize<'a, E: ParseError<&'a [u8]> + ContextError<&'a [u8]>>(
        &self,
        buffer: &'a [u8],
    ) -> IResult<&'a [u8], TrustVerdict, E> {
        context(
            "Failed TrustVerdict deserialization",
            tuple((
                context("Failed admitted deserialization", |input| {
                    self.bool_deserializer.deserialize(input)
                }),
                context("Failed trust_hint deserialization", be_u16),
                context("Failed reason deserialization", nom_u8),
                context(
                    "Failed limits deserialization",
                    tuple((
                        be_u32, be_u32, be_u32, be_u32, be_u32, be_u32, be_u64, be_u32, be_u32,
                    )),
                ),
            )),
        )
        .map(
            |(
                admitted,
                trust_hint,
                reason,
                (
                    max_message_size,
                    max_ids_per_message,
                    max_blobs_per_message,
                    max_blobs_message_bytes,
                    max_sync_page,
                    ingest_blobs_per_min,
                    ingest_bytes_per_min,
                    unsolicited_blobs_per_min,
                    sync_requests_per_min,
                ),
            )| TrustVerdict {
                admitted,
                trust_hint,
                reason,
                limits: PeerLimits {
                    max_message_size,
                    max_ids_per_message,
                    max_blobs_per_message,
                    max_blobs_message_bytes,
                    max_sync_page,
                    ingest_blobs_per_min,
                    ingest_bytes_per_min,
                    unsolicited_blobs_per_min,
                    sync_requests_per_min,
                },
            },
        )
        .parse(buffer)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use massa_serialization::DeserializeError;

    fn challenge(scheme: u16, params_len: usize) -> TrustChallenge {
        TrustChallenge {
            scheme,
            params: vec![scheme as u8; params_len],
            nonce: [scheme as u8; TRUST_NONCE_LEN],
        }
    }

    #[test]
    fn offer_roundtrip_and_bytes() {
        let offer = TrustOffer {
            challenges: vec![challenge(1, 3), challenge(0x0102, 0)],
        };
        let mut buf = vec![];
        TrustOfferSerializer::new()
            .serialize(&offer, &mut buf)
            .unwrap();
        let mut expected = vec![2u8, 0, 1, 3, 1, 1, 1];
        expected.extend_from_slice(&[1; 32]);
        expected.extend_from_slice(&[1, 2, 0]);
        expected.extend_from_slice(&[2; 32]);
        assert_eq!(buf, expected);
        let (rest, back) = TrustOfferDeserializer::default()
            .deserialize::<DeserializeError>(&buf)
            .unwrap();
        assert!(rest.is_empty());
        assert_eq!(back, offer);

        let empty = TrustOffer::default();
        let mut buf = vec![];
        TrustOfferSerializer::new()
            .serialize(&empty, &mut buf)
            .unwrap();
        assert_eq!(buf, vec![0]);
        assert_eq!(
            TrustOfferDeserializer::default()
                .deserialize::<DeserializeError>(&buf)
                .unwrap()
                .1,
            empty
        );
    }

    #[test]
    fn offer_bounds() {
        let ser = TrustOfferSerializer::new();
        let too_many = TrustOffer {
            challenges: vec![challenge(1, 1); 17],
        };
        let mut buf = vec![];
        ser.serialize(&too_many, &mut buf).unwrap();
        assert!(TrustOfferDeserializer::default()
            .deserialize::<DeserializeError>(&buf)
            .is_err());
        assert!(TrustOfferDeserializer::new(17, 1)
            .deserialize::<DeserializeError>(&buf)
            .is_ok());

        let big_params = TrustOffer {
            challenges: vec![challenge(1, 4097)],
        };
        let mut buf = vec![];
        ser.serialize(&big_params, &mut buf).unwrap();
        assert!(TrustOfferDeserializer::default()
            .deserialize::<DeserializeError>(&buf)
            .is_err());
        assert!(TrustOfferDeserializer::new(1, 4097)
            .deserialize::<DeserializeError>(&buf)
            .is_ok());
        for cut in 0..buf.len() {
            assert!(TrustOfferDeserializer::new(1, 4097)
                .deserialize::<DeserializeError>(&buf[..cut])
                .is_err());
        }
    }

    #[test]
    fn proofs_roundtrip_and_bounds() {
        let proofs = TrustProofs {
            proofs: vec![
                TrustProof {
                    scheme: 7,
                    bytes: vec![1, 2, 3],
                },
                TrustProof {
                    scheme: 0xffff,
                    bytes: vec![],
                },
            ],
        };
        let mut buf = vec![];
        TrustProofsSerializer::new()
            .serialize(&proofs, &mut buf)
            .unwrap();
        assert_eq!(buf, vec![2, 0, 7, 3, 1, 2, 3, 0xff, 0xff, 0]);
        let (rest, back) = TrustProofsDeserializer::default()
            .deserialize::<DeserializeError>(&buf)
            .unwrap();
        assert!(rest.is_empty());
        assert_eq!(back, proofs);
        assert!(TrustProofsDeserializer::new(1, 10)
            .deserialize::<DeserializeError>(&buf)
            .is_err());
        assert!(TrustProofsDeserializer::new(2, 2)
            .deserialize::<DeserializeError>(&buf)
            .is_err());
        for cut in 0..buf.len() {
            assert!(TrustProofsDeserializer::default()
                .deserialize::<DeserializeError>(&buf[..cut])
                .is_err());
        }

        let big = TrustProofs {
            proofs: vec![TrustProof {
                scheme: 1,
                bytes: vec![0; DEFAULT_MAX_TRUST_PROOF_LEN as usize + 1],
            }],
        };
        let mut buf = vec![];
        TrustProofsSerializer::new()
            .serialize(&big, &mut buf)
            .unwrap();
        assert!(TrustProofsDeserializer::default()
            .deserialize::<DeserializeError>(&buf)
            .is_err());
    }

    #[test]
    fn verdict_roundtrip_and_bad_bool() {
        for verdict in [
            TrustVerdict {
                admitted: true,
                trust_hint: 0x1234,
                reason: 0,
                limits: PeerLimits::default(),
            },
            TrustVerdict {
                admitted: false,
                trust_hint: 0,
                reason: 42,
                limits: PeerLimits::default(),
            },
            TrustVerdict {
                admitted: true,
                trust_hint: 9_999,
                reason: 0,
                limits: PeerLimits {
                    max_message_size: 11_534_336,
                    max_ids_per_message: 5000,
                    max_blobs_per_message: 64,
                    max_blobs_message_bytes: 2_097_152,
                    max_sync_page: 5000,
                    ingest_blobs_per_min: 1500,
                    ingest_bytes_per_min: 26_214_400,
                    unsolicited_blobs_per_min: 8,
                    sync_requests_per_min: 1,
                },
            },
        ] {
            let mut buf = vec![];
            TrustVerdictSerializer::new()
                .serialize(&verdict, &mut buf)
                .unwrap();
            assert_eq!(buf.len(), 4 + PEER_LIMITS_LEN);
            assert_eq!(buf[0], verdict.admitted as u8);
            let (rest, back) = TrustVerdictDeserializer::new()
                .deserialize::<DeserializeError>(&buf)
                .unwrap();
            assert!(rest.is_empty());
            assert_eq!(back, verdict);
            assert!(TrustVerdictDeserializer::new()
                .deserialize::<DeserializeError>(&buf[..3])
                .is_err());
        }
        assert!(TrustVerdictDeserializer::new()
            .deserialize::<DeserializeError>(&[2, 0, 0, 0])
            .is_err());
    }
}
