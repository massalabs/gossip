//! Top-level message envelope handed to PeerNet.
//!
//! Adapted from massa: `massa-protocol-worker/src/messages.rs` (rev d193d9ff89).
//! The async `MessagesHandler` (which dispatches to channels) is left to the network
//! crate; this module only defines the frame layout and the type-id prefix parser.
//!
//! Wire form: `varint(MessageTypeId)` followed by the sub-message, which itself starts
//! with its own varint type id. Both ids are unsigned LEB128 varints, so a frame begins
//! with `0x00` ([`Message::Blob`]) or `0x01` ([`Message::PeerManagement`]).

use std::ops::Bound::Included;

use massa_serialization::{Deserializer, Serializer, U64VarIntDeserializer, U64VarIntSerializer};
use nom::{
    error::{context, ContextError, ParseError},
    IResult, Parser,
};

use crate::error::WireError;

use crate::blob_message::{BlobMessage, BlobMessageDeserializer, BlobMessageSerializer};
use crate::peer_management::{
    PeerManagementMessage, PeerManagementMessageDeserializer, PeerManagementMessageSerializer,
};

/// Every message that can be sent over a PeerNet connection.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Message {
    /// Blob propagation / synchronisation.
    Blob(BlobMessage),
    /// Peer discovery.
    PeerManagement(Box<PeerManagementMessage>),
}

/// Varint type id prefixing each [`Message`].
#[derive(Debug, Clone, Copy, Eq, PartialEq)]
#[repr(u64)]
pub enum MessageTypeId {
    /// [`Message::Blob`]
    Blob = 0,
    /// [`Message::PeerManagement`]
    PeerManagement = 1,
}

impl From<MessageTypeId> for u64 {
    fn from(id: MessageTypeId) -> Self {
        id as u64
    }
}

impl TryFrom<u64> for MessageTypeId {
    type Error = u64;

    fn try_from(raw: u64) -> Result<Self, Self::Error> {
        match raw {
            0 => Ok(Self::Blob),
            1 => Ok(Self::PeerManagement),
            other => Err(other),
        }
    }
}

impl From<&Message> for MessageTypeId {
    fn from(value: &Message) -> Self {
        match value {
            Message::Blob(_) => MessageTypeId::Blob,
            Message::PeerManagement(_) => MessageTypeId::PeerManagement,
        }
    }
}

impl From<BlobMessage> for Message {
    fn from(message: BlobMessage) -> Self {
        Self::Blob(message)
    }
}

impl From<PeerManagementMessage> for Message {
    fn from(message: PeerManagementMessage) -> Self {
        Self::PeerManagement(Box::from(message))
    }
}

/// Serializer for [`Message`], plugged into PeerNet.
///
/// Sub-serializers are opt-in (as in massa): serializing a variant whose serializer was
/// not installed is an error.
#[derive(Clone)]
pub struct MessagesSerializer {
    id_serializer: U64VarIntSerializer,
    blob_message_serializer: Option<BlobMessageSerializer>,
    peer_management_message_serializer: Option<PeerManagementMessageSerializer>,
}

impl Default for MessagesSerializer {
    fn default() -> Self {
        Self::new()
    }
}

impl MessagesSerializer {
    /// Creates a `MessagesSerializer` with no sub-serializer installed.
    pub fn new() -> Self {
        Self {
            id_serializer: U64VarIntSerializer::new(),
            blob_message_serializer: None,
            peer_management_message_serializer: None,
        }
    }

    /// Installs the [`BlobMessage`] serializer.
    pub fn with_blob_message_serializer(
        mut self,
        blob_message_serializer: BlobMessageSerializer,
    ) -> Self {
        self.blob_message_serializer = Some(blob_message_serializer);
        self
    }

    /// Installs the [`PeerManagementMessage`] serializer.
    pub fn with_peer_management_message_serializer(
        mut self,
        peer_management_message_serializer: PeerManagementMessageSerializer,
    ) -> Self {
        self.peer_management_message_serializer = Some(peer_management_message_serializer);
        self
    }
}

impl MessagesSerializer {
    /// Serializes `message` (type id prefix, then the sub-message) into `buffer`.
    ///
    /// This is the transport-independent entry point; the PeerNet impl and the mesh
    /// links both call it.
    pub fn serialize_message(
        &self,
        message: &Message,
        buffer: &mut Vec<u8>,
    ) -> Result<(), WireError> {
        self.id_serializer
            .serialize(&MessageTypeId::from(message).into(), buffer)
            .map_err(|err| WireError::Serialization(format!("Failed to serialize id {}", err)))?;
        match message {
            Message::Blob(message) => match &self.blob_message_serializer {
                Some(serializer) => serializer.serialize(message, buffer).map_err(|err| {
                    WireError::Serialization(format!("Failed to serialize message: {}", err))
                }),
                None => Err(WireError::Serialization(
                    "BlobMessageSerializer not initialized".to_string(),
                )),
            },
            Message::PeerManagement(message) => match &self.peer_management_message_serializer {
                Some(serializer) => serializer.serialize(message, buffer).map_err(|err| {
                    WireError::Serialization(format!("Failed to serialize message: {}", err))
                }),
                None => Err(WireError::Serialization(
                    "PeerManagementMessageSerializer not initialized".to_string(),
                )),
            },
        }
    }
}

/// Reads the varint [`MessageTypeId`] prefix of a frame and returns the rest, which is
/// the sub-message to hand to the matching handler.
#[derive(Clone)]
pub struct MessageTypeIdDeserializer {
    id_deserializer: U64VarIntDeserializer,
}

impl MessageTypeIdDeserializer {
    /// Creates a `MessageTypeIdDeserializer`
    pub const fn new() -> Self {
        Self {
            id_deserializer: U64VarIntDeserializer::new(Included(0), Included(u64::MAX)),
        }
    }
}

impl Default for MessageTypeIdDeserializer {
    fn default() -> Self {
        Self::new()
    }
}

impl Deserializer<MessageTypeId> for MessageTypeIdDeserializer {
    fn deserialize<'a, E: ParseError<&'a [u8]> + ContextError<&'a [u8]>>(
        &self,
        buffer: &'a [u8],
    ) -> IResult<&'a [u8], MessageTypeId, E> {
        context(
            "Failed MessageTypeId deserialization",
            |input: &'a [u8]| {
                let (rest, raw_id) = self.id_deserializer.deserialize(input)?;
                let id = MessageTypeId::try_from(raw_id).map_err(|_| {
                    nom::Err::Error(ParseError::from_error_kind(
                        input,
                        nom::error::ErrorKind::Verify,
                    ))
                })?;
                Ok((rest, id))
            },
        )
        .parse(buffer)
    }
}

/// Deserializer for a whole [`Message`] frame (type id + sub-message).
///
/// The network crate normally dispatches on the id alone (see
/// [`MessageTypeIdDeserializer`]) and lets each handler decode its own bytes; this is
/// the one-shot alternative for tests and tools.
#[derive(Clone)]
pub struct MessageDeserializer {
    id_deserializer: MessageTypeIdDeserializer,
    blob_message_deserializer: BlobMessageDeserializer,
    peer_management_message_deserializer: PeerManagementMessageDeserializer,
}

impl MessageDeserializer {
    /// Creates a `MessageDeserializer` from the bounded sub-deserializers.
    pub fn new(
        blob_message_deserializer: BlobMessageDeserializer,
        peer_management_message_deserializer: PeerManagementMessageDeserializer,
    ) -> Self {
        Self {
            id_deserializer: MessageTypeIdDeserializer::new(),
            blob_message_deserializer,
            peer_management_message_deserializer,
        }
    }
}

impl Deserializer<Message> for MessageDeserializer {
    fn deserialize<'a, E: ParseError<&'a [u8]> + ContextError<&'a [u8]>>(
        &self,
        buffer: &'a [u8],
    ) -> IResult<&'a [u8], Message, E> {
        context("Failed Message deserialization", |input| {
            let (rest, id) = self.id_deserializer.deserialize(input)?;
            match id {
                MessageTypeId::Blob => self
                    .blob_message_deserializer
                    .deserialize(rest)
                    .map(|(rest, message)| (rest, Message::Blob(message))),
                MessageTypeId::PeerManagement => self
                    .peer_management_message_deserializer
                    .deserialize(rest)
                    .map(|(rest, message)| (rest, Message::PeerManagement(Box::new(message)))),
            }
        })
        .parse(buffer)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::blob::BlobId;
    use crate::blob_message::BlobMessageDeserializerArgs;
    use crate::peer_id::PeerId;
    use crate::peer_management::PeerManagementMessageDeserializerArgs;
    use massa_serialization::DeserializeError;
    use std::collections::HashMap;

    fn full_serializer() -> MessagesSerializer {
        MessagesSerializer::new()
            .with_blob_message_serializer(BlobMessageSerializer::new())
            .with_peer_management_message_serializer(PeerManagementMessageSerializer::new())
    }

    fn full_deserializer() -> MessageDeserializer {
        MessageDeserializer::new(
            BlobMessageDeserializer::new(BlobMessageDeserializerArgs {
                max_ids_per_message: 10,
                max_blobs_per_message: 10,
                max_key_len: 128,
                max_payload_len: 1024,
                max_sync_page: 10,
            }),
            PeerManagementMessageDeserializer::new(PeerManagementMessageDeserializerArgs {
                max_listeners_per_peer: 10,
                max_peers_per_announcement: 10,
                max_trust_proof_len: 1024,
            }),
        )
    }

    #[test]
    fn serialize_both_variants_and_decode_type_id() {
        let blob: Message = BlobMessage::Ask(vec![BlobId([1; 32])]).into();
        let peers: Message =
            PeerManagementMessage::NewPeerConnected((PeerId::generate(), HashMap::new())).into();
        let serializer = full_serializer();
        let id_deser = MessageTypeIdDeserializer::new();
        let full_deser = full_deserializer();

        let mut buf = vec![];
        serializer.serialize_message(&blob, &mut buf).unwrap();
        assert_eq!(&buf[..2], &[0, 1]);
        let (rest, id) = id_deser.deserialize::<DeserializeError>(&buf).unwrap();
        assert_eq!(id, MessageTypeId::Blob);
        assert_eq!(rest, &buf[1..]);
        let (rest, back) = full_deser.deserialize::<DeserializeError>(&buf).unwrap();
        assert!(rest.is_empty());
        assert_eq!(back, blob);

        let mut buf = vec![];
        serializer.serialize_message(&peers, &mut buf).unwrap();
        assert_eq!(&buf[..2], &[1, 0]);
        let (rest, id) = id_deser.deserialize::<DeserializeError>(&buf).unwrap();
        assert_eq!(id, MessageTypeId::PeerManagement);
        assert_eq!(rest, &buf[1..]);
        let (rest, back) = full_deser.deserialize::<DeserializeError>(&buf).unwrap();
        assert!(rest.is_empty());
        assert_eq!(back, peers);
    }

    #[test]
    fn unknown_or_missing_type_id() {
        let id_deser = MessageTypeIdDeserializer::new();
        assert!(id_deser.deserialize::<DeserializeError>(&[]).is_err());
        assert!(id_deser.deserialize::<DeserializeError>(&[2]).is_err());
        assert!(id_deser
            .deserialize::<DeserializeError>(&[0x80, 0x01])
            .is_err());
        assert!(full_deserializer()
            .deserialize::<DeserializeError>(&[0])
            .is_err());
    }

    #[test]
    fn missing_sub_serializer_is_an_error() {
        let blob: Message = BlobMessage::Announce(vec![]).into();
        let peers: Message = PeerManagementMessage::ListPeers(vec![]).into();
        let only_blob =
            MessagesSerializer::new().with_blob_message_serializer(BlobMessageSerializer::new());
        let mut buf = vec![];
        assert!(only_blob.serialize_message(&blob, &mut buf).is_ok());
        assert!(only_blob.serialize_message(&peers, &mut buf).is_err());
        assert!(MessagesSerializer::default()
            .serialize_message(&blob, &mut buf)
            .is_err());
    }
}
