//! Peer-management messages: who is connected and where peers can be reached.
//!
//! Vendored from massa: `massa-protocol-worker/src/handlers/peer_handler/messages.rs`
//! (rev d193d9ff89). `num_enum` is replaced by hand-written conversions and the
//! listener encoding is shared with [`crate::primitives::ListenersSerializer`].
//!
//! Wire form: `varint(type id)` then
//! - `NewPeerConnected`: `PeerId ‖ listeners`
//! - `ListPeers`: `varint(count) ‖ (PeerId ‖ listeners)*`
//! - `TrustAsk`: nothing
//! - `TrustChallenges`: `round (32 bytes) ‖ TrustOffer`
//! - `TrustProofs`: `round (32 bytes) ‖ TrustProofs`
//! - `TrustVerdict`: `round (32 bytes) ‖ TrustVerdict`
//!
//! The four `Trust*` messages refresh the trust round of a connection that is already
//! up (see the trust refresh worker of the network crate). A build that predates them
//! fails to decode them and drops them, which PeerNet does not treat as an error.

use std::{collections::HashMap, net::SocketAddr, ops::Bound::Included};

use crate::TransportType;
use massa_serialization::{Deserializer, Serializer, U64VarIntDeserializer, U64VarIntSerializer};
use nom::{
    bytes::complete::take,
    error::{context, ContextError, ParseError},
    multi::length_count,
    sequence::tuple,
    IResult, Parser,
};

use crate::peer_id::{PeerId, PeerIdDeserializer, PeerIdSerializer};
use crate::primitives::{ListenersDeserializer, ListenersSerializer};
use crate::trust_message::{
    TrustOffer, TrustOfferDeserializer, TrustOfferSerializer, TrustProofs, TrustProofsDeserializer,
    TrustProofsSerializer, TrustVerdict, TrustVerdictDeserializer, TrustVerdictSerializer,
    MAX_TRUST_CHALLENGES, MAX_TRUST_PARAMS_LEN, MAX_TRUST_PROOFS, TRUST_NONCE_LEN,
};

/// Identifier of one trust refresh round: random, chosen by the verifier, and echoed
/// by the proofs and the verdict that answer it.
pub type TrustRound = [u8; TRUST_NONCE_LEN];

/// Messages exchanged by the peer-management handler.
#[derive(Debug, Clone, PartialEq, Eq)]
// `PeerId` embeds a ~200-byte `VerifyingKey`; boxing would change the vendored shape.
#[allow(clippy::large_enum_variant)]
pub enum PeerManagementMessage {
    /// Receive the ip addresses sent by a peer when connecting.
    NewPeerConnected((PeerId, HashMap<SocketAddr, TransportType>)),
    /// Receive the ip addresses sent by a peer that is already connected.
    ListPeers(Vec<(PeerId, HashMap<SocketAddr, TransportType>)>),
    /// The sender's proofs changed: it asks to be challenged again.
    TrustAsk,
    /// Fresh challenges from a verifier, for a connection that is already up.
    TrustChallenges {
        /// Round id, echoed by the answer.
        round: TrustRound,
        /// The challenges.
        offer: TrustOffer,
    },
    /// Answers to [`PeerManagementMessage::TrustChallenges`].
    TrustProofs {
        /// Round id of the challenges answered.
        round: TrustRound,
        /// The proofs.
        proofs: TrustProofs,
    },
    /// The verifier's decision on [`PeerManagementMessage::TrustProofs`].
    TrustVerdict {
        /// Round id of the proofs judged.
        round: TrustRound,
        /// The verdict, with the limits the verifier now enforces on the prover.
        verdict: TrustVerdict,
    },
}

/// Varint type id prefixing each [`PeerManagementMessage`].
#[derive(Debug, Clone, Copy, Eq, PartialEq)]
#[repr(u64)]
pub enum PeerManagementMessageTypeId {
    /// [`PeerManagementMessage::NewPeerConnected`]
    NewPeerConnected = 0,
    /// [`PeerManagementMessage::ListPeers`]
    ListPeers = 1,
    /// [`PeerManagementMessage::TrustAsk`]
    TrustAsk = 2,
    /// [`PeerManagementMessage::TrustChallenges`]
    TrustChallenges = 3,
    /// [`PeerManagementMessage::TrustProofs`]
    TrustProofs = 4,
    /// [`PeerManagementMessage::TrustVerdict`]
    TrustVerdict = 5,
}

impl From<PeerManagementMessageTypeId> for u64 {
    fn from(id: PeerManagementMessageTypeId) -> Self {
        id as u64
    }
}

impl TryFrom<u64> for PeerManagementMessageTypeId {
    type Error = u64;

    fn try_from(raw: u64) -> Result<Self, Self::Error> {
        match raw {
            0 => Ok(Self::NewPeerConnected),
            1 => Ok(Self::ListPeers),
            2 => Ok(Self::TrustAsk),
            3 => Ok(Self::TrustChallenges),
            4 => Ok(Self::TrustProofs),
            5 => Ok(Self::TrustVerdict),
            other => Err(other),
        }
    }
}

impl From<&PeerManagementMessage> for PeerManagementMessageTypeId {
    fn from(message: &PeerManagementMessage) -> Self {
        match message {
            PeerManagementMessage::NewPeerConnected(_) => {
                PeerManagementMessageTypeId::NewPeerConnected
            }
            PeerManagementMessage::ListPeers(_) => PeerManagementMessageTypeId::ListPeers,
            PeerManagementMessage::TrustAsk => PeerManagementMessageTypeId::TrustAsk,
            PeerManagementMessage::TrustChallenges { .. } => {
                PeerManagementMessageTypeId::TrustChallenges
            }
            PeerManagementMessage::TrustProofs { .. } => PeerManagementMessageTypeId::TrustProofs,
            PeerManagementMessage::TrustVerdict { .. } => PeerManagementMessageTypeId::TrustVerdict,
        }
    }
}

/// Serializer for [`PeerManagementMessage`].
#[derive(Default, Clone)]
pub struct PeerManagementMessageSerializer {
    id_serializer: U64VarIntSerializer,
    length_serializer: U64VarIntSerializer,
    listeners_serializer: ListenersSerializer,
    peer_id_serializer: PeerIdSerializer,
    offer_serializer: TrustOfferSerializer,
    proofs_serializer: TrustProofsSerializer,
    verdict_serializer: TrustVerdictSerializer,
}

impl PeerManagementMessageSerializer {
    /// Creates a `PeerManagementMessageSerializer`
    pub fn new() -> Self {
        Self {
            id_serializer: U64VarIntSerializer::new(),
            length_serializer: U64VarIntSerializer::new(),
            listeners_serializer: ListenersSerializer::new(),
            peer_id_serializer: PeerIdSerializer::new(),
            offer_serializer: TrustOfferSerializer::new(),
            proofs_serializer: TrustProofsSerializer::new(),
            verdict_serializer: TrustVerdictSerializer::new(),
        }
    }
}

impl Serializer<PeerManagementMessage> for PeerManagementMessageSerializer {
    fn serialize(
        &self,
        value: &PeerManagementMessage,
        buffer: &mut Vec<u8>,
    ) -> Result<(), massa_serialization::SerializeError> {
        self.id_serializer
            .serialize(&PeerManagementMessageTypeId::from(value).into(), buffer)?;
        match value {
            PeerManagementMessage::NewPeerConnected((peer_id, listeners)) => {
                self.peer_id_serializer.serialize(peer_id, buffer)?;
                self.listeners_serializer.serialize(listeners, buffer)?;
            }
            PeerManagementMessage::ListPeers(peers) => {
                self.length_serializer
                    .serialize(&(peers.len() as u64), buffer)?;
                for (peer_id, listeners) in peers {
                    self.peer_id_serializer.serialize(peer_id, buffer)?;
                    self.listeners_serializer.serialize(listeners, buffer)?;
                }
            }
            PeerManagementMessage::TrustAsk => {}
            PeerManagementMessage::TrustChallenges { round, offer } => {
                buffer.extend_from_slice(round);
                self.offer_serializer.serialize(offer, buffer)?;
            }
            PeerManagementMessage::TrustProofs { round, proofs } => {
                buffer.extend_from_slice(round);
                self.proofs_serializer.serialize(proofs, buffer)?;
            }
            PeerManagementMessage::TrustVerdict { round, verdict } => {
                buffer.extend_from_slice(round);
                self.verdict_serializer.serialize(verdict, buffer)?;
            }
        }
        Ok(())
    }
}

/// Bounded deserializer for [`PeerManagementMessage`].
#[derive(Clone)]
pub struct PeerManagementMessageDeserializer {
    id_deserializer: U64VarIntDeserializer,
    listeners_deserializer: ListenersDeserializer,
    peers_length_deserializer: U64VarIntDeserializer,
    peer_id_deserializer: PeerIdDeserializer,
    offer_deserializer: TrustOfferDeserializer,
    proofs_deserializer: TrustProofsDeserializer,
    verdict_deserializer: TrustVerdictDeserializer,
}

/// Limits used in the deserialization of [`PeerManagementMessage`].
pub struct PeerManagementMessageDeserializerArgs {
    /// Maximum number of listeners per peer
    pub max_listeners_per_peer: u64,
    /// Maximum number of peers per announcement
    pub max_peers_per_announcement: u64,
    /// Maximum length of one proof in a [`PeerManagementMessage::TrustProofs`]
    pub max_trust_proof_len: u64,
}

impl PeerManagementMessageDeserializer {
    /// Creates a `PeerManagementMessageDeserializer` with the given limits.
    pub fn new(limits: PeerManagementMessageDeserializerArgs) -> Self {
        Self {
            id_deserializer: U64VarIntDeserializer::new(Included(0), Included(u64::MAX)),
            listeners_deserializer: ListenersDeserializer::new(limits.max_listeners_per_peer),
            peers_length_deserializer: U64VarIntDeserializer::new(
                Included(0),
                Included(limits.max_peers_per_announcement),
            ),
            peer_id_deserializer: PeerIdDeserializer::new(),
            offer_deserializer: TrustOfferDeserializer::new(
                MAX_TRUST_CHALLENGES,
                MAX_TRUST_PARAMS_LEN,
            ),
            proofs_deserializer: TrustProofsDeserializer::new(
                MAX_TRUST_PROOFS,
                limits.max_trust_proof_len,
            ),
            verdict_deserializer: TrustVerdictDeserializer::new(),
        }
    }
}

/// Parses the round id that starts every `Trust*` message.
fn round<'a, E: ParseError<&'a [u8]> + ContextError<&'a [u8]>>(
    buffer: &'a [u8],
) -> IResult<&'a [u8], TrustRound, E> {
    context("Failed trust round deserialization", take(TRUST_NONCE_LEN))
        .map(|bytes: &[u8]| {
            let mut round = [0u8; TRUST_NONCE_LEN];
            round.copy_from_slice(bytes);
            round
        })
        .parse(buffer)
}

impl Deserializer<PeerManagementMessage> for PeerManagementMessageDeserializer {
    fn deserialize<'a, E: ParseError<&'a [u8]> + ContextError<&'a [u8]>>(
        &self,
        buffer: &'a [u8],
    ) -> IResult<&'a [u8], PeerManagementMessage, E> {
        context("Failed PeerManagementMessage deserialization", |buffer| {
            let (buffer, raw_id) = self.id_deserializer.deserialize(buffer)?;
            let id = PeerManagementMessageTypeId::try_from(raw_id).map_err(|_| {
                nom::Err::Error(ParseError::from_error_kind(
                    buffer,
                    nom::error::ErrorKind::Verify,
                ))
            })?;
            match id {
                PeerManagementMessageTypeId::NewPeerConnected => context(
                    "Failed NewPeerConnected deserialization",
                    tuple((
                        context("Failed PeerId deserialization", |buffer: &'a [u8]| {
                            self.peer_id_deserializer.deserialize(buffer)
                        }),
                        context("Failed listeners deserialization", |buffer| {
                            self.listeners_deserializer.deserialize(buffer)
                        }),
                    )),
                )
                .map(|(peer_id, listeners)| {
                    PeerManagementMessage::NewPeerConnected((peer_id, listeners))
                })
                .parse(buffer),
                PeerManagementMessageTypeId::ListPeers => context(
                    "Failed ListPeers deserialization",
                    length_count(
                        context(
                            "Failed length peers deserialization",
                            |buffer: &'a [u8]| self.peers_length_deserializer.deserialize(buffer),
                        ),
                        context(
                            "Failed peer deserialization",
                            tuple((
                                context("Failed PeerId deserialization", |buffer: &'a [u8]| {
                                    self.peer_id_deserializer.deserialize(buffer)
                                }),
                                context("Failed listeners deserialization", |buffer| {
                                    self.listeners_deserializer.deserialize(buffer)
                                }),
                            )),
                        ),
                    ),
                )
                .map(PeerManagementMessage::ListPeers)
                .parse(buffer),
                PeerManagementMessageTypeId::TrustAsk => {
                    Ok((buffer, PeerManagementMessage::TrustAsk))
                }
                PeerManagementMessageTypeId::TrustChallenges => context(
                    "Failed TrustChallenges deserialization",
                    tuple((round, |buffer| self.offer_deserializer.deserialize(buffer))),
                )
                .map(|(round, offer)| PeerManagementMessage::TrustChallenges { round, offer })
                .parse(buffer),
                PeerManagementMessageTypeId::TrustProofs => context(
                    "Failed TrustProofs deserialization",
                    tuple((round, |buffer| self.proofs_deserializer.deserialize(buffer))),
                )
                .map(|(round, proofs)| PeerManagementMessage::TrustProofs { round, proofs })
                .parse(buffer),
                PeerManagementMessageTypeId::TrustVerdict => context(
                    "Failed TrustVerdict deserialization",
                    tuple((round, |buffer| {
                        self.verdict_deserializer.deserialize(buffer)
                    })),
                )
                .map(|(round, verdict)| PeerManagementMessage::TrustVerdict { round, verdict })
                .parse(buffer),
            }
        })
        .parse(buffer)
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::{
        PeerManagementMessage, PeerManagementMessageDeserializer,
        PeerManagementMessageDeserializerArgs, PeerManagementMessageSerializer,
    };
    use crate::peer_id::PeerId;
    use crate::TransportType;
    use massa_serialization::{DeserializeError, Deserializer, Serializer};
    use massa_signature::KeyPair;

    #[test]
    fn test_peer_connected() {
        let keypair = KeyPair::generate(0).unwrap();
        let mut listeners = HashMap::new();
        listeners.insert("127.0.0.1:33036".parse().unwrap(), TransportType::Tcp);
        listeners.insert("127.0.0.1:33035".parse().unwrap(), TransportType::Quic);

        let serializer = PeerManagementMessageSerializer::new();
        let mut buffer = vec![];
        let msg = PeerManagementMessage::NewPeerConnected((
            PeerId::from_public_key(keypair.get_public_key()),
            listeners.clone(),
        ));

        serializer.serialize(&msg, &mut buffer).unwrap();
        assert_eq!(buffer[0], 0);

        let deserializer =
            PeerManagementMessageDeserializer::new(PeerManagementMessageDeserializerArgs {
                max_listeners_per_peer: 1000,
                max_peers_per_announcement: 1000,
                max_trust_proof_len: 1024,
            });
        let (rest, message) = deserializer
            .deserialize::<DeserializeError>(&buffer)
            .unwrap();
        assert!(rest.is_empty());
        match message {
            PeerManagementMessage::NewPeerConnected((peer_id, message_listeners)) => {
                assert_eq!(peer_id, PeerId::from_public_key(keypair.get_public_key()));
                assert_eq!(message_listeners.len(), 2);

                for (addr, transport) in listeners.iter() {
                    assert!(message_listeners.contains_key(addr));
                    assert_eq!(message_listeners.get(addr).unwrap(), transport);
                }
            }
            _ => panic!("Bad message deserialized"),
        }
    }

    #[test]
    fn test_list_peers() {
        let keypair1 = KeyPair::generate(0).unwrap();
        let mut listeners = HashMap::new();
        listeners.insert("127.0.0.1:33036".parse().unwrap(), TransportType::Tcp);
        let keypair2 = KeyPair::generate(0).unwrap();
        let message = PeerManagementMessage::ListPeers(vec![
            (
                PeerId::from_public_key(keypair1.get_public_key()),
                listeners.clone(),
            ),
            (
                PeerId::from_public_key(keypair2.get_public_key()),
                listeners.clone(),
            ),
        ]);

        let serializer = PeerManagementMessageSerializer::new();
        let mut buffer = vec![];
        serializer.serialize(&message, &mut buffer).unwrap();
        assert_eq!(buffer[0], 1);
        let deserializer =
            PeerManagementMessageDeserializer::new(PeerManagementMessageDeserializerArgs {
                max_listeners_per_peer: 1000,
                max_peers_per_announcement: 1000,
                max_trust_proof_len: 1024,
            });
        let (rest, message) = deserializer
            .deserialize::<DeserializeError>(&buffer)
            .unwrap();
        assert!(rest.is_empty());
        match message {
            PeerManagementMessage::ListPeers(peers) => {
                assert_eq!(peers.len(), 2);
                let ids_vec = [keypair1.get_public_key(), keypair2.get_public_key()];
                let iter = peers.iter().zip(ids_vec.iter());
                for ((peer_id, message_listeners), public_key) in iter {
                    assert_eq!(peer_id, &PeerId::from_public_key(*public_key));
                    assert_eq!(message_listeners.len(), 1);
                    for (addr, transport) in listeners.iter() {
                        assert!(message_listeners.contains_key(addr));
                        assert_eq!(message_listeners.get(addr).unwrap(), transport);
                    }
                }
            }
            _ => panic!("Bad message deserialized"),
        }
    }

    #[test]
    fn bounds_unknown_id_and_truncation() {
        let mut listeners = HashMap::new();
        listeners.insert("127.0.0.1:1".parse().unwrap(), TransportType::Tcp);
        listeners.insert("127.0.0.1:2".parse().unwrap(), TransportType::Tcp);
        let peer = || PeerId::from_public_key(KeyPair::generate(0).unwrap().get_public_key());
        let list = PeerManagementMessage::ListPeers(vec![
            (peer(), listeners.clone()),
            (peer(), listeners.clone()),
        ]);
        let connected = PeerManagementMessage::NewPeerConnected((peer(), listeners));
        let serializer = PeerManagementMessageSerializer::new();
        let deser = |peers, per_peer| {
            PeerManagementMessageDeserializer::new(PeerManagementMessageDeserializerArgs {
                max_listeners_per_peer: per_peer,
                max_peers_per_announcement: peers,
                max_trust_proof_len: 1024,
            })
        };
        for msg in [&list, &connected] {
            let mut buf = vec![];
            serializer.serialize(msg, &mut buf).unwrap();
            let (rest, back) = deser(2, 2).deserialize::<DeserializeError>(&buf).unwrap();
            assert!(rest.is_empty());
            assert_eq!(&back, msg);
            assert!(deser(2, 1).deserialize::<DeserializeError>(&buf).is_err());
            assert!(deser(2, 2)
                .deserialize::<DeserializeError>(&buf[..buf.len() - 1])
                .is_err());
        }
        let mut buf = vec![];
        serializer.serialize(&list, &mut buf).unwrap();
        assert!(deser(1, 2).deserialize::<DeserializeError>(&buf).is_err());
        buf[0] = 6;
        assert!(deser(2, 2).deserialize::<DeserializeError>(&buf).is_err());
    }

    #[test]
    fn trust_messages_roundtrip_and_are_bounded() {
        use crate::trust_message::{
            PeerLimits, TrustChallenge, TrustOffer, TrustProof, TrustProofs, TrustVerdict,
        };
        let round = [7u8; 32];
        let messages = [
            PeerManagementMessage::TrustAsk,
            PeerManagementMessage::TrustChallenges {
                round,
                offer: TrustOffer {
                    challenges: vec![TrustChallenge {
                        scheme: 16,
                        params: vec![1, 2, 3],
                        nonce: [9; 32],
                    }],
                },
            },
            PeerManagementMessage::TrustProofs {
                round,
                proofs: TrustProofs {
                    proofs: vec![TrustProof {
                        scheme: 16,
                        bytes: vec![5; 100],
                    }],
                },
            },
            PeerManagementMessage::TrustVerdict {
                round,
                verdict: TrustVerdict {
                    admitted: true,
                    trust_hint: 9000,
                    reason: 0,
                    limits: PeerLimits {
                        max_message_size: 1,
                        ingest_bytes_per_min: 2,
                        ..PeerLimits::default()
                    },
                },
            },
        ];
        let serializer = PeerManagementMessageSerializer::new();
        let deser = |max_proof| {
            PeerManagementMessageDeserializer::new(PeerManagementMessageDeserializerArgs {
                max_listeners_per_peer: 10,
                max_peers_per_announcement: 10,
                max_trust_proof_len: max_proof,
            })
        };
        for (id, msg) in messages.iter().enumerate() {
            let mut buf = vec![];
            serializer.serialize(msg, &mut buf).unwrap();
            assert_eq!(buf[0] as usize, id + 2);
            let (rest, back) = deser(100).deserialize::<DeserializeError>(&buf).unwrap();
            assert!(rest.is_empty());
            assert_eq!(&back, msg);
            if buf.len() > 1 {
                assert!(deser(100)
                    .deserialize::<DeserializeError>(&buf[..buf.len() - 1])
                    .is_err());
            }
        }
        let mut buf = vec![];
        serializer.serialize(&messages[2], &mut buf).unwrap();
        assert!(deser(99).deserialize::<DeserializeError>(&buf).is_err());
    }
}
