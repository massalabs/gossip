//! The message event (§6.1, §6.2, §4.2) and its result projection.
//!
//! `Debug` output never shows message content (text, bodies, metadata values), only sizes.

use core::fmt;
use std::collections::BTreeMap;

use crate::cbor::Value;
use crate::constants::{
    DOMAIN_RESULT, EVENT_TIMESTAMP_TOLERANCE_MS, EVENT_VERSION, MAX_EMOJI_BYTES, MAX_EVENT_PARENTS,
    MAX_METADATA_BYTES, MAX_MIMETYPE_BYTES, MAX_REPLY_TARGETS, MAX_SCHEDULE_MS, MAX_TEXT_BYTES,
    METADATA_KEY_REPLY_TO,
};
use crate::error::{Error, Result};
use crate::hash::{h, reaction_sync_obj_id, secret_proof};
use crate::ids::{
    ChatId, EventId, GossipId, RefChatId, SecretProof, SyncObjId, check_sorted_distinct,
};
use crate::redact;
use crate::root::Root;
use crate::wire::{self, proto, strict};

/// The type of a message result (§6.2).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum MessageType {
    /// UTF-8 text.
    Text = 0,
    /// A content-only copy (§7.6).
    Forward = 1,
    /// A reaction to a message (§7.6).
    Reaction = 2,
    /// A media message: a mimetype and opaque data (§7.6).
    Media = 3,
    /// A tombstone.
    Delete = 4,
}

impl MessageType {
    /// The tag hashed and sent on the wire.
    #[must_use]
    pub const fn code(self) -> u64 {
        self as u64
    }

    fn from_wire(value: i32) -> Result<Self> {
        Ok(match proto::MessageType::try_from(value) {
            Ok(proto::MessageType::Text) => Self::Text,
            Ok(proto::MessageType::Forward) => Self::Forward,
            Ok(proto::MessageType::Reaction) => Self::Reaction,
            Ok(proto::MessageType::Media) => Self::Media,
            Ok(proto::MessageType::Delete) => Self::Delete,
            Err(_) => return Err(Error::Malformed("unknown message type")),
        })
    }
}

/// Whether a reaction is added or removed (§7.6).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum ReactionAction {
    /// The reaction is shown.
    Add = 0,
    /// The reaction is withdrawn; on equal dates it wins over an add (§7.1).
    Remove = 1,
}

impl ReactionAction {
    /// The value hashed and sent on the wire.
    #[must_use]
    pub const fn code(self) -> u64 {
        self as u64
    }

    fn from_wire(value: i32) -> Result<Self> {
        Ok(match proto::ReactionAction::try_from(value) {
            Ok(proto::ReactionAction::Add) => Self::Add,
            Ok(proto::ReactionAction::Remove) => Self::Remove,
            Err(_) => return Err(Error::Malformed("unknown reaction action")),
        })
    }
}

/// The body of a reaction (§7.6). The person reacting is the result's author. Its `Debug`
/// output shows only the size of the emoji.
#[derive(Clone, PartialEq, Eq)]
pub struct Reaction {
    /// The `syncObjId` of the message reacted to, in the same epoch.
    pub target: SyncObjId,
    /// UTF-8 text of 1 to [`MAX_EMOJI_BYTES`] bytes; whether it is an emoji is not checked.
    pub emoji: String,
    /// Added or removed.
    pub action: ReactionAction,
}

impl Reaction {
    /// `syncObjId = H("gossip.groups.reaction.1", target, author, emoji)`: the only sync-object
    /// ID a reaction by `author` may have (§7.6).
    #[must_use]
    pub fn sync_obj_id(&self, author: &GossipId) -> SyncObjId {
        reaction_sync_obj_id(&self.target, author, &self.emoji)
    }

    fn check(&self) -> Result<()> {
        let n = self.emoji.len();
        if n == 0 {
            return Err(Error::TooFew {
                field: "emoji",
                min: 1,
                got: 0,
            });
        }
        if n > MAX_EMOJI_BYTES {
            return Err(Error::TooMany {
                field: "emoji",
                max: MAX_EMOJI_BYTES,
                got: n,
            });
        }
        Ok(())
    }

    fn from_proto(p: proto::Reaction) -> Result<Self> {
        Ok(Self {
            target: SyncObjId::from_slice(&p.target)?,
            emoji: p.emoji,
            action: ReactionAction::from_wire(p.action)?,
        })
    }

    fn to_proto(&self) -> proto::Reaction {
        proto::Reaction {
            target: self.target.as_bytes().to_vec(),
            emoji: self.emoji.clone(),
            action: self.action as i32,
        }
    }
}

/// The body of a media message (§7.6). Its `Debug` output shows only sizes.
#[derive(Clone, PartialEq, Eq)]
pub struct Media {
    /// `type/subtype`, at most [`MAX_MIMETYPE_BYTES`] bytes ([`check_mimetype`]).
    pub mimetype: String,
    /// Any bytes, possibly none; opaque to the protocol.
    pub data: Vec<u8>,
}

impl Media {
    /// The canonical protobuf encoding, the `content` of a forwarded media message
    /// (Appendix C).
    #[must_use]
    pub fn encode(&self) -> Vec<u8> {
        prost::Message::encode_to_vec(&self.to_proto())
    }

    /// Decodes the `content` of a forwarded media message: a strict decoding of a valid
    /// `Media` whose encoding is canonical, since those bytes are hashed (§6.2, §7.6).
    ///
    /// # Errors
    ///
    /// [`Error::Malformed`] for an invalid or non-canonical encoding, otherwise the rule
    /// broken.
    pub fn decode(bytes: &[u8]) -> Result<Self> {
        let p: proto::Media = strict::decode(bytes, &proto::MEDIA)?;
        let media = Self {
            mimetype: p.mimetype,
            data: p.data,
        };
        media.check()?;
        if media.encode() != bytes {
            return Err(Error::Malformed("Media: not canonical"));
        }
        Ok(media)
    }

    fn check(&self) -> Result<()> {
        check_mimetype(&self.mimetype)
    }

    fn to_proto(&self) -> proto::Media {
        proto::Media {
            mimetype: self.mimetype.clone(),
            data: self.data.clone(),
        }
    }
}

/// Checks a mimetype (§7.6): `type/subtype`, at most [`MAX_MIMETYPE_BYTES`] bytes in all,
/// where `type` and `subtype` each start with a lowercase ASCII letter or a digit and
/// continue with lowercase letters, digits, `.`, `+` or `-`. Nothing may follow the subtype.
///
/// # Errors
///
/// [`Error::TooMany`] when it is too long, [`Error::NotAllowed`] for any other form.
pub fn check_mimetype(mimetype: &str) -> Result<()> {
    if mimetype.len() > MAX_MIMETYPE_BYTES {
        return Err(Error::TooMany {
            field: "mimetype",
            max: MAX_MIMETYPE_BYTES,
            got: mimetype.len(),
        });
    }
    let token = |t: &str| {
        let b = t.as_bytes();
        let first = |c: &u8| c.is_ascii_lowercase() || c.is_ascii_digit();
        b.first().is_some_and(first)
            && b[1..]
                .iter()
                .all(|c| first(c) || matches!(c, b'.' | b'+' | b'-'))
    };
    match mimetype.split_once('/') {
        Some((t, sub)) if token(t) && token(sub) => Ok(()),
        _ => Err(Error::NotAllowed("mimetype")),
    }
}

/// The type-specific body of a non-delete result (§6.2). Its `Debug` output shows only sizes.
#[derive(Clone, PartialEq, Eq)]
pub enum Body {
    /// `text`: UTF-8 text.
    Text(String),
    /// `forward`: `[content_type, content]`, a content-only copy (§7.6): a text, as UTF-8, or a
    /// media message, as the canonical encoding of a [`Media`] ([`Media::encode`]).
    Forward {
        /// The type of the copied content: [`MessageType::Text`] or [`MessageType::Media`].
        content_type: MessageType,
        /// The copied content.
        content: Vec<u8>,
    },
    /// `reaction`: `[target, emoji, action]` (§7.6).
    Reaction(Reaction),
    /// `media`: `[mimetype, data]` (§7.6).
    Media(Media),
}

impl Body {
    /// The message type this body belongs to.
    #[must_use]
    pub fn message_type(&self) -> MessageType {
        match self {
            Body::Text(_) => MessageType::Text,
            Body::Forward { .. } => MessageType::Forward,
            Body::Reaction(_) => MessageType::Reaction,
            Body::Media(_) => MessageType::Media,
        }
    }

    fn projection(&self) -> Value<'_> {
        match self {
            Body::Text(t) => Value::Text(t),
            Body::Forward {
                content_type,
                content,
            } => Value::Array(vec![
                Value::Uint(content_type.code()),
                Value::Bytes(content),
            ]),
            Body::Reaction(r) => Value::Array(vec![
                Value::Bytes(r.target.as_bytes()),
                Value::Text(&r.emoji),
                Value::Uint(r.action.code()),
            ]),
            Body::Media(m) => Value::Array(vec![Value::Text(&m.mimetype), Value::Bytes(&m.data)]),
        }
    }

    /// The rules of each body that need no author: forward content (a text or a canonical
    /// media message, nothing else), the reaction's emoji, the mimetype, and the text limit
    /// ([`MAX_TEXT_BYTES`]), which does not apply to media data.
    fn check(&self) -> Result<()> {
        let text_len = match self {
            Body::Text(t) => t.len(),
            Body::Forward {
                content_type,
                content,
            } => match content_type {
                MessageType::Text => {
                    if core::str::from_utf8(content).is_err() {
                        return Err(Error::InvalidUtf8("forward content"));
                    }
                    content.len()
                }
                MessageType::Media => {
                    Media::decode(content)?;
                    0
                }
                MessageType::Reaction | MessageType::Forward | MessageType::Delete => {
                    return Err(Error::NotAllowed("forward content_type"));
                }
            },
            Body::Reaction(r) => {
                r.check()?;
                0
            }
            Body::Media(m) => {
                m.check()?;
                0
            }
        };
        if text_len > MAX_TEXT_BYTES {
            return Err(Error::TooMany {
                field: "text",
                max: MAX_TEXT_BYTES,
                got: text_len,
            });
        }
        Ok(())
    }
}

/// A complete non-delete result (§6.2). Its `Debug` output hides the body and the metadata.
#[derive(Clone, PartialEq, Eq)]
pub struct Content {
    /// The sync object.
    pub sync_obj_id: SyncObjId,
    /// The claimed author; MUST be a member of the epoch.
    pub author: GossipId,
    /// Claimed creation time; display ordering key.
    pub created_at: u64,
    /// Claimed modification time; version ranking key.
    pub last_modified_at: u64,
    /// The body, which also gives the message type.
    pub body: Body,
    /// Claimed edited flag.
    pub edited: bool,
    /// Text keys to byte values, preserved exactly.
    pub metadata: BTreeMap<String, Vec<u8>>,
}

/// The rank of a non-delete result among the results of one sync object (§7.1): greater
/// wins. See [`Content::rank`].
pub(crate) type Rank = (bool, u64, bool, [u8; 32]);

impl Content {
    /// Whether this result is a reaction. Its ID was checked against its target, author and
    /// emoji (§7.6), so it is exempt from deletion (§7.1).
    #[must_use]
    pub fn is_reaction(&self) -> bool {
        matches!(self.body, Body::Reaction(_))
    }

    /// The rank of this result, whose result hash is `result_hash`, among the results of its
    /// sync object (§7.1): between versions of a reaction, the greatest `last_modified_at`,
    /// then a *remove* over an *add*, then the greatest result hash; between other results,
    /// the greatest `(last_modified_at, resultHash)`.
    ///
    /// A reaction also outranks every other type under its ID, whatever the dates. A
    /// reaction's ID is the hash of its target, author and emoji, so another type can only
    /// share it when a member chose that ID on purpose; ranking the type first makes every
    /// device end with the reaction, which no deletion removes, while the ordinary rules,
    /// deletion included, still decide between the other results.
    pub(crate) fn rank(&self, result_hash: [u8; 32]) -> Rank {
        match &self.body {
            Body::Reaction(r) => (
                true,
                self.last_modified_at,
                r.action == ReactionAction::Remove,
                result_hash,
            ),
            _ => (false, self.last_modified_at, false, result_hash),
        }
    }
}

impl fmt::Debug for Body {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Body::Text(t) => f
                .debug_tuple("Text")
                .field(&redact::Bytes(t.len()))
                .finish(),
            Body::Forward {
                content_type,
                content,
            } => f
                .debug_struct("Forward")
                .field("content_type", content_type)
                .field("content", &redact::Bytes(content.len()))
                .finish(),
            Body::Reaction(r) => f.debug_tuple("Reaction").field(r).finish(),
            Body::Media(m) => f.debug_tuple("Media").field(m).finish(),
        }
    }
}

impl fmt::Debug for Reaction {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Reaction")
            .field("target", &self.target)
            .field("emoji", &redact::Bytes(self.emoji.len()))
            .field("action", &self.action)
            .finish()
    }
}

impl fmt::Debug for Media {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Media")
            .field("mimetype", &redact::Bytes(self.mimetype.len()))
            .field("data", &redact::Bytes(self.data.len()))
            .finish()
    }
}

impl fmt::Debug for Content {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Content")
            .field("sync_obj_id", &self.sync_obj_id)
            .field("author", &self.author)
            .field("created_at", &self.created_at)
            .field("last_modified_at", &self.last_modified_at)
            .field("body", &self.body)
            .field("edited", &self.edited)
            .field("metadata", &redact::Entries(self.metadata.len()))
            .finish()
    }
}

/// The payload of a message event: a complete result or a delete tombstone (§6.2).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Payload {
    /// A non-delete result.
    Content(Content),
    /// A delete, immediate when `scheduled_at` is `None`, scheduled otherwise (§7.4).
    Delete {
        /// The deleted sync object.
        sync_obj_id: SyncObjId,
        /// `last_modified_at` of a scheduled deletion; outside the result hash.
        scheduled_at: Option<u64>,
    },
}

/// A target of a reply, carried in the metadata key `replyTo` (§7.6).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ReplyTarget {
    /// The reference of the target's epoch.
    pub ref_chat_id: RefChatId,
    /// The target message.
    pub sync_obj_id: SyncObjId,
}

/// Encodes reply targets as the value of the metadata key `replyTo`.
///
/// # Errors
///
/// [`Error::TooFew`] or [`Error::TooMany`] outside 1 to 32 targets.
pub fn encode_reply_to(targets: &[ReplyTarget]) -> Result<Vec<u8>> {
    check_reply_count(targets.len())?;
    Ok(prost::Message::encode_to_vec(&proto::ReplyTo {
        targets: targets
            .iter()
            .map(|t| proto::ReplyTarget {
                ref_chat_id: t.ref_chat_id.as_bytes().to_vec(),
                sync_obj_id: t.sync_obj_id.as_bytes().to_vec(),
            })
            .collect(),
    }))
}

/// Decodes the value of the metadata key `replyTo`: 1 to 32 targets of two 32-byte fields.
///
/// # Errors
///
/// [`Error::Malformed`] for an invalid encoding, otherwise the rule broken.
pub fn decode_reply_to(value: &[u8]) -> Result<Vec<ReplyTarget>> {
    let p: proto::ReplyTo = strict::decode(value, &proto::REPLY_TO)?;
    check_reply_count(p.targets.len())?;
    p.targets
        .iter()
        .map(|t| {
            Ok(ReplyTarget {
                ref_chat_id: RefChatId::from_slice(&t.ref_chat_id)?,
                sync_obj_id: SyncObjId::from_slice(&t.sync_obj_id)?,
            })
        })
        .collect()
}

fn check_reply_count(n: usize) -> Result<()> {
    if n == 0 {
        return Err(Error::TooFew {
            field: "replyTo",
            min: 1,
            got: 0,
        });
    }
    if n > MAX_REPLY_TARGETS {
        return Err(Error::TooMany {
            field: "replyTo",
            max: MAX_REPLY_TARGETS,
            got: n,
        });
    }
    Ok(())
}

impl Payload {
    /// The sync object this payload updates.
    #[must_use]
    pub fn sync_obj_id(&self) -> SyncObjId {
        match self {
            Payload::Content(c) => c.sync_obj_id,
            Payload::Delete { sync_obj_id, .. } => *sync_obj_id,
        }
    }

    /// The message type.
    #[must_use]
    pub fn message_type(&self) -> MessageType {
        match self {
            Payload::Content(c) => c.body.message_type(),
            Payload::Delete { .. } => MessageType::Delete,
        }
    }

    /// The CBOR projection `fullMessage` of §6.2, in the epoch `chat_id`:
    /// `[chat_id, syncObjId, type, author, created_at, last_modified_at, body, edited,
    /// metadata]`, or `[chat_id, syncObjId, 4]` for a delete (without its pending
    /// `last_modified_at`).
    #[must_use]
    pub fn full_message<'a>(&'a self, chat_id: &'a ChatId) -> Value<'a> {
        match self {
            Payload::Delete { sync_obj_id, .. } => Value::Array(vec![
                Value::Bytes(chat_id.as_bytes()),
                Value::Bytes(sync_obj_id.as_bytes()),
                Value::Uint(MessageType::Delete.code()),
            ]),
            Payload::Content(c) => Value::Array(vec![
                Value::Bytes(chat_id.as_bytes()),
                Value::Bytes(c.sync_obj_id.as_bytes()),
                Value::Uint(c.body.message_type().code()),
                Value::Bytes(c.author.as_bytes()),
                Value::Uint(c.created_at),
                Value::Uint(c.last_modified_at),
                c.body.projection(),
                Value::Bool(c.edited),
                Value::Map(
                    c.metadata
                        .iter()
                        .map(|(k, v)| (Value::Text(k), Value::Bytes(v)))
                        .collect(),
                ),
            ]),
        }
    }

    /// `resultHash = H("gossip.groups.message.result.1", fullMessage)` (§6.2). Local only.
    #[must_use]
    pub fn result_hash(&self, chat_id: &ChatId) -> [u8; 32] {
        h(DOMAIN_RESULT, vec![self.full_message(chat_id)])
    }

    /// Structural rules that need only the payload and the event timestamp `ts`: the body
    /// (forward content, reaction, mimetype), the identity of a reaction (§7.6), the text and
    /// metadata limits, the `replyTo` metadata, and `created_at`, `last_modified_at` (including a
    /// scheduled-deletion time) at most `ts + MAX_SCHEDULE` (§7.2).
    ///
    /// The bound is computed in 128 bits, so it is exact for every `ts`: a date is refused
    /// only when it really is beyond it (§1, D.25).
    fn check(&self, ts: u64) -> Result<()> {
        let bound = u128::from(ts) + u128::from(MAX_SCHEDULE_MS);
        let beyond = |t: u64| u128::from(t) > bound;
        match self {
            Payload::Delete { scheduled_at, .. } => {
                if scheduled_at.is_some_and(beyond) {
                    return Err(Error::BeyondSchedule("last_modified_at"));
                }
            }
            Payload::Content(c) => {
                c.body.check()?;
                if let Body::Reaction(r) = &c.body
                    && r.sync_obj_id(&c.author) != c.sync_obj_id
                {
                    return Err(Error::IdMismatch("reaction syncObjId"));
                }
                let metadata_len = wire::metadata_len(&c.metadata);
                if metadata_len > MAX_METADATA_BYTES {
                    return Err(Error::TooMany {
                        field: "metadata",
                        max: MAX_METADATA_BYTES,
                        got: metadata_len,
                    });
                }
                if let Some(value) = c.metadata.get(METADATA_KEY_REPLY_TO) {
                    decode_reply_to(value)?;
                }
                if beyond(c.created_at) {
                    return Err(Error::BeyondSchedule("created_at"));
                }
                if beyond(c.last_modified_at) {
                    return Err(Error::BeyondSchedule("last_modified_at"));
                }
            }
        }
        Ok(())
    }

    fn from_proto(p: proto::MessagePayload) -> Result<Self> {
        let sync_obj_id = SyncObjId::from_slice(&p.sync_obj_id)?;
        let message_type = MessageType::from_wire(p.r#type)?;
        if message_type == MessageType::Delete {
            // A delete carries only syncObjId, type and an optional last_modified_at.
            if !p.author.is_empty() {
                return Err(Error::MustBeAbsent("author"));
            }
            if p.created_at != 0 {
                return Err(Error::MustBeAbsent("created_at"));
            }
            if p.edited {
                return Err(Error::MustBeAbsent("edited"));
            }
            if p.body.is_some() {
                return Err(Error::MustBeAbsent("body"));
            }
            if !p.metadata.is_empty() {
                return Err(Error::MustBeAbsent("metadata"));
            }
            return Ok(Payload::Delete {
                sync_obj_id,
                scheduled_at: p.last_modified_at,
            });
        }
        let author = GossipId::from_slice(&p.author)?;
        let last_modified_at = p
            .last_modified_at
            .ok_or(Error::Missing("last_modified_at"))?;
        let body = match (message_type, p.body) {
            (MessageType::Text, Some(proto::Body::Text(t))) => Body::Text(t),
            (MessageType::Forward, Some(proto::Body::Forward(f))) => Body::Forward {
                content_type: MessageType::from_wire(f.content_type)?,
                content: f.content,
            },
            (MessageType::Reaction, Some(proto::Body::Reaction(r))) => {
                Body::Reaction(Reaction::from_proto(r)?)
            }
            (MessageType::Media, Some(proto::Body::Media(m))) => Body::Media(Media {
                mimetype: m.mimetype,
                data: m.data,
            }),
            (_, None) => return Err(Error::Missing("body")),
            _ => return Err(Error::NotAllowed("body for this message type")),
        };
        Ok(Payload::Content(Content {
            sync_obj_id,
            author,
            created_at: p.created_at,
            last_modified_at,
            body,
            edited: p.edited,
            metadata: p.metadata,
        }))
    }

    fn to_proto(&self) -> proto::MessagePayload {
        match self {
            Payload::Delete {
                sync_obj_id,
                scheduled_at,
            } => proto::MessagePayload {
                sync_obj_id: sync_obj_id.as_bytes().to_vec(),
                r#type: proto::MessageType::Delete as i32,
                last_modified_at: *scheduled_at,
                ..Default::default()
            },
            Payload::Content(c) => proto::MessagePayload {
                sync_obj_id: c.sync_obj_id.as_bytes().to_vec(),
                r#type: c.body.message_type() as i32,
                author: c.author.as_bytes().to_vec(),
                created_at: c.created_at,
                last_modified_at: Some(c.last_modified_at),
                edited: c.edited,
                body: Some(match &c.body {
                    Body::Text(t) => proto::Body::Text(t.clone()),
                    Body::Forward {
                        content_type,
                        content,
                    } => proto::Body::Forward(proto::Forward {
                        content_type: *content_type as i32,
                        content: content.clone(),
                    }),
                    Body::Reaction(r) => proto::Body::Reaction(r.to_proto()),
                    Body::Media(m) => proto::Body::Media(m.to_proto()),
                }),
                metadata: c.metadata.clone(),
            },
        }
    }
}

/// A structurally valid message event (§6.1, §6.2).
///
/// Holding one does not mean it was accepted: [`MessageEvent::check_against_root`] checks the
/// secret proof and the author against the epoch, and [`MessageEvent::timestamp_admitted`] the
/// clock bound of §7.2.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MessageEvent {
    version: u64,
    event_id: EventId,
    chat_id: ChatId,
    secret_proof: SecretProof,
    parents: Vec<EventId>,
    payload: Payload,
}

impl MessageEvent {
    /// Builds a message event of the epoch `root`, computing its secret proof (§4.2).
    ///
    /// `event_id` is `ts ‖ random` built by the caller from its clock and randomness
    /// ([`EventId::new`]); `parents` are the chosen tips, in any order (§6.1).
    ///
    /// # Errors
    ///
    /// Any structural rule, [`Error::Duplicate`] for a repeated parent, and
    /// [`Error::NotMember`] if the author is not a member of `root`.
    pub fn create(
        root: &Root,
        event_id: EventId,
        parents: &[EventId],
        payload: Payload,
    ) -> Result<Self> {
        let mut parents = parents.to_vec();
        parents.sort_unstable();
        if parents.windows(2).any(|w| w[0] == w[1]) {
            return Err(Error::Duplicate("parents"));
        }
        let event = Self {
            version: EVENT_VERSION,
            event_id,
            chat_id: root.chat_id(),
            secret_proof: secret_proof(&root.chat_id(), root.group_secret(), &event_id),
            parents,
            payload,
        };
        event.check()?;
        event.check_against_root(root)?;
        Ok(event)
    }

    fn check(&self) -> Result<()> {
        if self.parents.len() > MAX_EVENT_PARENTS {
            return Err(Error::TooMany {
                field: "parents",
                max: MAX_EVENT_PARENTS,
                got: self.parents.len(),
            });
        }
        check_sorted_distinct("parents", &self.parents)?;
        if self.parents.binary_search(&self.event_id).is_ok() {
            return Err(Error::SelfParent);
        }
        self.payload.check(self.event_id.timestamp())?;
        if !wire::fits_empty_container(wire::event_blob_len(
            self.version,
            prost::Message::encoded_len(&self.to_proto()),
        )) {
            return Err(Error::DoesNotFitContainer);
        }
        Ok(())
    }

    /// Validates a received message event: field lengths, parents (0 to 16 distinct 24-byte
    /// IDs, ascending, not the event itself), the payload and its timestamps (§6.1, §6.2,
    /// §7.2).
    ///
    /// # Errors
    ///
    /// The first rule broken.
    pub(crate) fn from_proto(version: u64, p: proto::GroupMessageEvent) -> Result<Self> {
        if version != EVENT_VERSION {
            return Err(Error::UnsupportedEventVersion(version));
        }
        let event_id = EventId::from_slice(&p.event_id)?;
        let chat_id = ChatId::from_slice(&p.chat_id)?;
        let secret_proof = SecretProof::from_slice(&p.secret_proof)?;
        if p.parents.len() > MAX_EVENT_PARENTS {
            return Err(Error::TooMany {
                field: "parents",
                max: MAX_EVENT_PARENTS,
                got: p.parents.len(),
            });
        }
        let parents = p
            .parents
            .iter()
            .map(|b| EventId::from_slice(b))
            .collect::<Result<Vec<_>>>()?;
        let payload = Payload::from_proto(p.payload.ok_or(Error::Missing("payload"))?)?;
        let event = Self {
            version,
            event_id,
            chat_id,
            secret_proof,
            parents,
            payload,
        };
        event.check()?;
        Ok(event)
    }

    /// The protobuf form.
    #[must_use]
    pub(crate) fn to_proto(&self) -> proto::GroupMessageEvent {
        proto::GroupMessageEvent {
            event_id: self.event_id.as_bytes().to_vec(),
            chat_id: self.chat_id.as_bytes().to_vec(),
            secret_proof: self.secret_proof.as_bytes().to_vec(),
            parents: self.parents.iter().map(|p| p.as_bytes().to_vec()).collect(),
            payload: Some(self.payload.to_proto()),
        }
    }

    /// The checks of §6.3 that need the epoch's root: the event names that epoch, its secret
    /// proof matches (§4.2), and a non-delete's claimed author is a member (§6.2).
    ///
    /// # Errors
    ///
    /// [`Error::IdMismatch`], [`Error::SecretProofMismatch`] or [`Error::NotMember`].
    pub fn check_against_root(&self, root: &Root) -> Result<()> {
        if self.chat_id != root.chat_id() {
            return Err(Error::IdMismatch("chat_id"));
        }
        if secret_proof(&self.chat_id, root.group_secret(), &self.event_id) != self.secret_proof {
            return Err(Error::SecretProofMismatch);
        }
        if let Payload::Content(c) = &self.payload
            && !root.is_member(&c.author)
        {
            return Err(Error::NotMember("the claimed author"));
        }
        Ok(())
    }

    /// Whether the event timestamp passes admission at local time `now`: `ts ≤ now + 5 min`
    /// (§7.2), computed in 128 bits so that it is exact for every `now` (§1, D.25). A received
    /// event that fails is not malformed but temporarily invalid (§9.6).
    #[must_use]
    pub fn timestamp_admitted(&self, now: u64) -> bool {
        u128::from(self.event_id.timestamp())
            <= u128::from(now) + u128::from(EVENT_TIMESTAMP_TOLERANCE_MS)
    }

    /// The result hash of the payload in this event's epoch (§6.2).
    #[must_use]
    pub fn result_hash(&self) -> [u8; 32] {
        self.payload.result_hash(&self.chat_id)
    }

    /// The event's version.
    #[must_use]
    pub fn version(&self) -> u64 {
        self.version
    }

    /// The event ID.
    #[must_use]
    pub fn event_id(&self) -> EventId {
        self.event_id
    }

    /// The event timestamp `ts` (§3).
    #[must_use]
    pub fn timestamp(&self) -> u64 {
        self.event_id.timestamp()
    }

    /// The epoch.
    #[must_use]
    pub fn chat_id(&self) -> ChatId {
        self.chat_id
    }

    /// The secret proof.
    #[must_use]
    pub fn secret_proof(&self) -> SecretProof {
        self.secret_proof
    }

    /// The parents, ascending.
    #[must_use]
    pub fn parents(&self) -> &[EventId] {
        &self.parents
    }

    /// The payload.
    #[must_use]
    pub fn payload(&self) -> &Payload {
        &self.payload
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::root::tests::founding;
    use crate::test_support::identity;

    const TS: u64 = 1_700_000_000_000;

    fn text(author: GossipId, s: &str) -> Payload {
        Payload::Content(Content {
            sync_obj_id: SyncObjId::from_bytes([0x77; 32]),
            author,
            created_at: TS,
            last_modified_at: TS,
            body: Body::Text(s.to_owned()),
            edited: false,
            metadata: BTreeMap::new(),
        })
    }

    fn content(p: &mut Payload) -> &mut Content {
        match p {
            Payload::Content(c) => c,
            Payload::Delete { .. } => panic!("not content"),
        }
    }

    #[test]
    fn create_verify_round_trip() {
        let alice = identity(1);
        let bob = identity(2);
        let root = founding(&alice, &[&alice, &bob]);
        let p1 = EventId::new(TS - 2, [2; 16]);
        let p0 = EventId::new(TS - 1, [1; 16]);
        let event = MessageEvent::create(
            &root,
            EventId::new(TS, [9; 16]),
            &[p0, p1],
            text(bob.id, "hi"),
        )
        .unwrap();
        assert_eq!(event.parents(), &[p1, p0]);
        assert!(event.check_against_root(&root).is_ok());
        let back = MessageEvent::from_proto(1, event.to_proto()).unwrap();
        assert_eq!(back, event);
        assert_eq!(back.result_hash(), event.result_hash());
    }

    #[test]
    fn secret_proof_and_author_checks() {
        let alice = identity(1);
        let bob = identity(2);
        let carol = identity(3);
        let root = founding(&alice, &[&alice, &bob]);
        let other = founding(&alice, &[&alice, &carol]);
        let event = MessageEvent::create(&root, EventId::new(TS, [9; 16]), &[], text(bob.id, "hi"))
            .unwrap();
        assert_eq!(
            event.check_against_root(&other),
            Err(Error::IdMismatch("chat_id"))
        );
        // The proof is tied to the event ID: moving it onto another ID fails.
        let mut p = event.to_proto();
        p.event_id = EventId::new(TS, [8; 16]).as_bytes().to_vec();
        let moved = MessageEvent::from_proto(1, p).unwrap();
        assert_eq!(
            moved.check_against_root(&root),
            Err(Error::SecretProofMismatch)
        );
        // An outsider cannot be the claimed author.
        assert_eq!(
            MessageEvent::create(&root, EventId::new(TS, [9; 16]), &[], text(carol.id, "hi")),
            Err(Error::NotMember("the claimed author"))
        );
        // A delete has no author.
        let delete = Payload::Delete {
            sync_obj_id: SyncObjId::from_bytes([0x77; 32]),
            scheduled_at: None,
        };
        assert!(MessageEvent::create(&root, EventId::new(TS, [9; 16]), &[], delete).is_ok());
    }

    #[test]
    fn parent_rules() {
        let alice = identity(1);
        let root = founding(&alice, &[&alice]);
        let id = EventId::new(TS, [9; 16]);
        let make =
            |parents: &[EventId]| MessageEvent::create(&root, id, parents, text(alice.id, "x"));
        let sixteen: Vec<EventId> = (0u8..16).map(|i| EventId::new(TS - 1, [i; 16])).collect();
        assert!(make(&sixteen).is_ok());
        let mut seventeen = sixteen.clone();
        seventeen.push(EventId::new(TS - 1, [16; 16]));
        assert!(matches!(
            make(&seventeen),
            Err(Error::TooMany {
                field: "parents",
                ..
            })
        ));
        assert_eq!(make(&[id]), Err(Error::SelfParent));
        assert_eq!(
            make(&[sixteen[0], sixteen[0]]),
            Err(Error::Duplicate("parents"))
        );

        // Received: canonical order is required, not restored.
        let event = make(&sixteen[..3]).unwrap();
        let mut p = event.to_proto();
        p.parents.reverse();
        assert_eq!(
            MessageEvent::from_proto(1, p),
            Err(Error::NotSortedDistinct("parents"))
        );
        let mut p = event.to_proto();
        p.parents[1] = p.parents[0].clone();
        assert_eq!(
            MessageEvent::from_proto(1, p),
            Err(Error::NotSortedDistinct("parents"))
        );
        let mut p = event.to_proto();
        p.parents.push(id.as_bytes().to_vec());
        assert_eq!(MessageEvent::from_proto(1, p), Err(Error::SelfParent));
        let mut p = event.to_proto();
        p.parents[0].push(0);
        assert!(matches!(
            MessageEvent::from_proto(1, p),
            Err(Error::BadLength { .. })
        ));
        let mut p = event.to_proto();
        p.parents = (0u8..17)
            .map(|i| EventId::new(1, [i; 16]).as_bytes().to_vec())
            .collect();
        assert!(matches!(
            MessageEvent::from_proto(1, p),
            Err(Error::TooMany {
                field: "parents",
                ..
            })
        ));
    }

    #[test]
    fn text_and_metadata_have_size_limits() {
        let alice = identity(1);
        let root = founding(&alice, &[&alice]);
        let make = |p: Payload| MessageEvent::create(&root, EventId::new(TS, [9; 16]), &[], p);
        let too_long = |field, got| {
            Err(Error::TooMany {
                field,
                max: 16_384,
                got,
            })
        };
        // Text: encoded UTF-8 bytes, not characters.
        assert!(make(text(alice.id, &"x".repeat(16_384))).is_ok());
        assert_eq!(
            make(text(alice.id, &"x".repeat(16_385))),
            too_long("text", 16_385)
        );
        assert!(make(text(alice.id, &"\u{e9}".repeat(8_192))).is_ok());
        assert_eq!(
            make(text(alice.id, &"\u{e9}".repeat(8_193))),
            too_long("text", 16_386)
        );
        // The text of a forward is text too; other content is bounded by the container.
        let body = |b: Body| {
            let mut p = text(alice.id, "");
            content(&mut p).body = b;
            p
        };
        let forward = |content_type, n| Body::Forward {
            content_type,
            content: vec![b'x'; n],
        };
        assert!(make(body(forward(MessageType::Text, 16_384))).is_ok());
        assert_eq!(
            make(body(forward(MessageType::Text, 16_385))),
            too_long("text", 16_385)
        );
        // Media data is not text: no text limit applies to it, forwarded or not.
        let media = Media {
            mimetype: "image/png".into(),
            data: vec![0; 40_000],
        };
        assert!(
            make(body(Body::Forward {
                content_type: MessageType::Media,
                content: media.encode(),
            }))
            .is_ok()
        );
        assert!(make(body(Body::Media(media))).is_ok());
        // Metadata: every key and value together, as encoded. One entry of a 1-byte key and
        // an n-byte value (127 < n < 16,384) is 9 + n bytes: field key, entry length (2),
        // key field (3), value field key and length (3).
        let with = |entries: &[(&str, usize)]| {
            let mut p = text(alice.id, "x");
            content(&mut p).metadata = entries
                .iter()
                .map(|(k, n)| ((*k).to_owned(), vec![0; *n]))
                .collect();
            p
        };
        assert!(make(with(&[("m", 16_375)])).is_ok());
        assert_eq!(make(with(&[("m", 16_376)])), too_long("metadata", 16_385));
        // The framing counts: 2,731 entries of a 2-byte key and no value are 6 bytes each,
        // although their keys hold only 5,462 bytes.
        let keys: Vec<String> = (0..2_731u16)
            .map(|i| {
                format!(
                    "{}{}",
                    char::from(b'0' + (i / 64) as u8),
                    char::from(b'0' + (i % 64) as u8)
                )
            })
            .collect();
        let small: Vec<(&str, usize)> = keys.iter().map(|k| (k.as_str(), 0)).collect();
        assert!(make(with(&small[..2_730])).is_ok());
        assert_eq!(make(with(&small)), too_long("metadata", 16_386));
        // Received events follow the same rules.
        let event = make(text(alice.id, "x")).unwrap();
        let received = |f: &dyn Fn(&mut proto::MessagePayload)| {
            let mut p = event.to_proto();
            f(p.payload.as_mut().unwrap());
            MessageEvent::from_proto(1, p)
        };
        assert_eq!(
            received(&|p| p.body = Some(proto::Body::Text("x".repeat(16_385)))),
            too_long("text", 16_385)
        );
        assert_eq!(
            received(&|p| {
                p.metadata.insert("m".to_owned(), vec![0; 16_376]);
            }),
            too_long("metadata", 16_385)
        );
        assert!(
            received(&|p| {
                p.metadata.insert("m".to_owned(), vec![0; 16_375]);
            })
            .is_ok()
        );
    }

    #[test]
    fn field_rules() {
        let alice = identity(1);
        let root = founding(&alice, &[&alice]);
        let event =
            MessageEvent::create(&root, EventId::new(TS, [9; 16]), &[], text(alice.id, "x"))
                .unwrap();
        let reject = |f: &dyn Fn(&mut proto::GroupMessageEvent)| {
            let mut p = event.to_proto();
            f(&mut p);
            MessageEvent::from_proto(1, p)
        };
        assert!(matches!(
            reject(&|p| {
                p.event_id.pop();
            }),
            Err(Error::BadLength { .. })
        ));
        assert!(matches!(
            reject(&|p| p.chat_id.push(0)),
            Err(Error::BadLength { .. })
        ));
        assert!(matches!(
            reject(&|p| p.secret_proof.clear()),
            Err(Error::BadLength { .. })
        ));
        assert_eq!(
            reject(&|p| p.payload = None),
            Err(Error::Missing("payload"))
        );
        fn pl(p: &mut proto::GroupMessageEvent) -> &mut proto::MessagePayload {
            p.payload.as_mut().unwrap()
        }
        assert!(matches!(
            reject(&|p| {
                pl(p).sync_obj_id.pop();
            }),
            Err(Error::BadLength { .. })
        ));
        assert!(matches!(
            reject(&|p| pl(p).author.clear()),
            Err(Error::BadLength { .. })
        ));
        assert_eq!(
            reject(&|p| pl(p).last_modified_at = None),
            Err(Error::Missing("last_modified_at"))
        );
        assert_eq!(reject(&|p| pl(p).body = None), Err(Error::Missing("body")));
        assert_eq!(
            reject(&|p| pl(p).r#type = proto::MessageType::Media as i32),
            Err(Error::NotAllowed("body for this message type"))
        );
        assert!(matches!(
            reject(&|p| pl(p).r#type = 9),
            Err(Error::Malformed(_))
        ));
        assert_eq!(
            MessageEvent::from_proto(2, event.to_proto()),
            Err(Error::UnsupportedEventVersion(2))
        );
    }

    #[test]
    fn delete_rules() {
        let alice = identity(1);
        let root = founding(&alice, &[&alice]);
        let delete = MessageEvent::create(
            &root,
            EventId::new(TS, [9; 16]),
            &[],
            Payload::Delete {
                sync_obj_id: SyncObjId::from_bytes([0x77; 32]),
                scheduled_at: Some(TS + 10),
            },
        )
        .unwrap();
        assert_eq!(
            MessageEvent::from_proto(1, delete.to_proto()).unwrap(),
            delete
        );
        let reject = |f: &dyn Fn(&mut proto::MessagePayload)| {
            let mut p = delete.to_proto();
            f(p.payload.as_mut().unwrap());
            MessageEvent::from_proto(1, p)
        };
        assert_eq!(
            reject(&|p| p.author = vec![1; 32]),
            Err(Error::MustBeAbsent("author"))
        );
        assert_eq!(
            reject(&|p| p.created_at = 1),
            Err(Error::MustBeAbsent("created_at"))
        );
        assert_eq!(
            reject(&|p| p.edited = true),
            Err(Error::MustBeAbsent("edited"))
        );
        assert_eq!(
            reject(&|p| p.body = Some(proto::Body::Text(String::new()))),
            Err(Error::MustBeAbsent("body"))
        );
        assert_eq!(
            reject(&|p| {
                p.metadata.insert("k".into(), vec![]);
            }),
            Err(Error::MustBeAbsent("metadata"))
        );
        // The pending time is outside the result hash.
        let immediate = Payload::Delete {
            sync_obj_id: SyncObjId::from_bytes([0x77; 32]),
            scheduled_at: None,
        };
        assert_eq!(delete.result_hash(), immediate.result_hash(&root.chat_id()));
    }

    #[test]
    fn schedule_bound() {
        let alice = identity(1);
        let root = founding(&alice, &[&alice]);
        let id = EventId::new(TS, [9; 16]);
        let mut p = text(alice.id, "x");
        content(&mut p).created_at = TS + MAX_SCHEDULE_MS;
        content(&mut p).last_modified_at = TS + MAX_SCHEDULE_MS;
        assert!(MessageEvent::create(&root, id, &[], p.clone()).is_ok());
        content(&mut p).last_modified_at += 1;
        assert_eq!(
            MessageEvent::create(&root, id, &[], p.clone()),
            Err(Error::BeyondSchedule("last_modified_at"))
        );
        content(&mut p).last_modified_at = 0;
        content(&mut p).created_at += 1;
        assert_eq!(
            MessageEvent::create(&root, id, &[], p),
            Err(Error::BeyondSchedule("created_at"))
        );
        let d = Payload::Delete {
            sync_obj_id: SyncObjId::from_bytes([1; 32]),
            scheduled_at: Some(TS + MAX_SCHEDULE_MS + 1),
        };
        assert_eq!(
            MessageEvent::create(&root, id, &[], d),
            Err(Error::BeyondSchedule("last_modified_at"))
        );
        // No lower bound.
        let mut p = text(alice.id, "x");
        content(&mut p).created_at = 0;
        content(&mut p).last_modified_at = 0;
        assert!(MessageEvent::create(&root, id, &[], p).is_ok());
        // Near the top of the range the bound is exact: ts + MAX_SCHEDULE beyond u64::MAX
        // admits every date, as unbounded integers would.
        for ts in [u64::MAX - MAX_SCHEDULE_MS + 1, u64::MAX] {
            let id = EventId::new(ts, [0; 16]);
            let mut p = text(alice.id, "x");
            content(&mut p).created_at = u64::MAX;
            content(&mut p).last_modified_at = u64::MAX;
            assert!(MessageEvent::create(&root, id, &[], p).is_ok());
            let d = Payload::Delete {
                sync_obj_id: SyncObjId::from_bytes([1; 32]),
                scheduled_at: Some(u64::MAX),
            };
            assert!(MessageEvent::create(&root, id, &[], d).is_ok());
        }
        // Just below, the bound is u64::MAX - 1.
        let ts = u64::MAX - MAX_SCHEDULE_MS - 1;
        let mut p = text(alice.id, "x");
        content(&mut p).last_modified_at = u64::MAX;
        assert_eq!(
            MessageEvent::create(&root, EventId::new(ts, [0; 16]), &[], p),
            Err(Error::BeyondSchedule("last_modified_at"))
        );
    }

    #[test]
    fn timestamp_admission() {
        let alice = identity(1);
        let root = founding(&alice, &[&alice]);
        let event =
            MessageEvent::create(&root, EventId::new(TS, [9; 16]), &[], text(alice.id, "x"))
                .unwrap();
        assert!(event.timestamp_admitted(TS - 300_000));
        assert!(!event.timestamp_admitted(TS - 300_001));
        assert!(!event.timestamp_admitted(0));
        // now + 5 min beyond u64::MAX admits every timestamp.
        assert!(event.timestamp_admitted(u64::MAX));
        let last = MessageEvent::create(
            &root,
            EventId::new(u64::MAX, [9; 16]),
            &[],
            text(alice.id, "x"),
        )
        .unwrap();
        assert!(last.timestamp_admitted(u64::MAX - 300_000));
        assert!(!last.timestamp_admitted(u64::MAX - 300_001));
    }

    #[test]
    fn forward_and_reply_rules() {
        let alice = identity(1);
        let root = founding(&alice, &[&alice]);
        let id = EventId::new(TS, [9; 16]);
        let mut p = text(alice.id, "x");
        let media = Media {
            mimetype: "image/png".into(),
            data: vec![1, 2],
        }
        .encode();
        // A forward carries a text or a media message, nothing else (§7.6).
        for (content_type, bytes, ok) in [
            (MessageType::Text, b"ok".to_vec(), true),
            (MessageType::Text, vec![0xff], false),
            (MessageType::Media, media.clone(), true),
            (MessageType::Media, vec![0xff], false),
            (MessageType::Media, vec![], false),
            (MessageType::Reaction, vec![], false),
            (MessageType::Reaction, media, false),
            (MessageType::Forward, vec![], false),
            (MessageType::Delete, vec![], false),
        ] {
            content(&mut p).body = Body::Forward {
                content_type,
                content: bytes,
            };
            assert_eq!(MessageEvent::create(&root, id, &[], p.clone()).is_ok(), ok);
        }

        let target = ReplyTarget {
            ref_chat_id: root.ref_chat_id(),
            sync_obj_id: SyncObjId::from_bytes([1; 32]),
        };
        let mut p = text(alice.id, "x");
        content(&mut p)
            .metadata
            .insert("replyTo".into(), encode_reply_to(&[target; 32]).unwrap());
        content(&mut p)
            .metadata
            .insert("unknown".into(), vec![1, 2]);
        let event = MessageEvent::create(&root, id, &[], p.clone()).unwrap();
        // Unknown metadata is preserved.
        assert_eq!(
            MessageEvent::from_proto(1, event.to_proto()).unwrap(),
            event
        );
        assert!(encode_reply_to(&[target; 33]).is_err());
        assert!(encode_reply_to(&[]).is_err());
        let thirty_three = prost::Message::encode_to_vec(&proto::ReplyTo {
            targets: vec![
                proto::ReplyTarget {
                    ref_chat_id: vec![1; 32],
                    sync_obj_id: vec![2; 32]
                };
                33
            ],
        });
        assert!(matches!(
            decode_reply_to(&thirty_three),
            Err(Error::TooMany {
                field: "replyTo",
                ..
            })
        ));
        content(&mut p)
            .metadata
            .insert("replyTo".into(), thirty_three);
        assert!(MessageEvent::create(&root, id, &[], p.clone()).is_err());
        content(&mut p).metadata.insert("replyTo".into(), vec![]);
        assert!(matches!(
            MessageEvent::create(&root, id, &[], p.clone()),
            Err(Error::TooFew {
                field: "replyTo",
                ..
            })
        ));
        content(&mut p)
            .metadata
            .insert("replyTo".into(), vec![0x0a, 0x00]);
        assert!(matches!(
            MessageEvent::create(&root, id, &[], p.clone()),
            Err(Error::BadLength { .. })
        ));
        content(&mut p)
            .metadata
            .insert("replyTo".into(), vec![0x12, 0x00]);
        assert!(matches!(
            MessageEvent::create(&root, id, &[], p),
            Err(Error::Malformed(_))
        ));
    }

    fn reaction(author: GossipId, emoji: &str, action: ReactionAction) -> Payload {
        let r = Reaction {
            target: SyncObjId::from_bytes([0x77; 32]),
            emoji: emoji.into(),
            action,
        };
        Payload::Content(Content {
            sync_obj_id: r.sync_obj_id(&author),
            author,
            created_at: TS,
            last_modified_at: TS,
            body: Body::Reaction(r),
            edited: false,
            metadata: BTreeMap::new(),
        })
    }

    #[test]
    fn a_reaction_is_named_by_its_target_author_and_emoji() {
        let alice = identity(1);
        let bob = identity(2);
        let root = founding(&alice, &[&alice, &bob]);
        let make = |p: Payload| MessageEvent::create(&root, EventId::new(TS, [9; 16]), &[], p);
        for action in [ReactionAction::Add, ReactionAction::Remove] {
            let p = reaction(bob.id, "\u{1f44d}", action);
            let event = make(p.clone()).unwrap();
            assert_eq!(
                MessageEvent::from_proto(1, event.to_proto()).unwrap(),
                event
            );
            assert_eq!(
                p.sync_obj_id(),
                crate::hash::reaction_sync_obj_id(
                    &SyncObjId::from_bytes([0x77; 32]),
                    &bob.id,
                    "\u{1f44d}"
                )
            );
        }
        // Any other ID is malformed, whoever the author or whatever the emoji: the ID names
        // the author and the emoji.
        let mut p = reaction(bob.id, "\u{1f44d}", ReactionAction::Add);
        content(&mut p).sync_obj_id = SyncObjId::from_bytes([1; 32]);
        assert_eq!(make(p), Err(Error::IdMismatch("reaction syncObjId")));
        let mut p = reaction(bob.id, "\u{1f44d}", ReactionAction::Add);
        content(&mut p).author = alice.id;
        assert_eq!(make(p), Err(Error::IdMismatch("reaction syncObjId")));
        // The same on receipt.
        let event = make(reaction(bob.id, "x", ReactionAction::Add)).unwrap();
        let mut proto = event.to_proto();
        proto.payload.as_mut().unwrap().author = alice.id.as_bytes().to_vec();
        assert_eq!(
            MessageEvent::from_proto(1, proto),
            Err(Error::IdMismatch("reaction syncObjId"))
        );
        // The emoji: 1 to 64 bytes of UTF-8, encoded bytes and not characters; any text.
        assert!(make(reaction(bob.id, &"\u{e9}".repeat(32), ReactionAction::Add)).is_ok());
        assert!(make(reaction(bob.id, "not an emoji", ReactionAction::Add)).is_ok());
        assert_eq!(
            make(reaction(bob.id, &"x".repeat(65), ReactionAction::Add)),
            Err(Error::TooMany {
                field: "emoji",
                max: 64,
                got: 65
            })
        );
        assert_eq!(
            make(reaction(bob.id, "", ReactionAction::Add)),
            Err(Error::TooFew {
                field: "emoji",
                min: 1,
                got: 0
            })
        );
        // The target is 32 bytes, and the action add or remove.
        let mut proto = event.to_proto();
        let body = |p: &mut proto::GroupMessageEvent| match &mut p.payload.as_mut().unwrap().body {
            Some(proto::Body::Reaction(r)) => r.clone(),
            _ => panic!(),
        };
        let mut r = body(&mut proto);
        r.target.pop();
        proto.payload.as_mut().unwrap().body = Some(proto::Body::Reaction(r));
        assert!(matches!(
            MessageEvent::from_proto(1, proto),
            Err(Error::BadLength { .. })
        ));
        let mut proto = event.to_proto();
        let mut r = body(&mut proto);
        r.action = 2;
        proto.payload.as_mut().unwrap().body = Some(proto::Body::Reaction(r));
        assert!(matches!(
            MessageEvent::from_proto(1, proto),
            Err(Error::Malformed(_))
        ));
        // Field 9 no longer exists: an opaque body under the reaction type is refused.
        let mut proto = event.to_proto();
        proto.payload.as_mut().unwrap().body = Some(proto::Body::Text("x".into()));
        assert_eq!(
            MessageEvent::from_proto(1, proto),
            Err(Error::NotAllowed("body for this message type"))
        );
    }

    #[test]
    fn mimetype_rules() {
        for ok in [
            "image/png",
            "text/vcard",
            "application/vnd.gossip.file-ref+json",
            "0/0",
            "a.b/c-d+e",
            &format!("a/{}", "b".repeat(125)),
        ] {
            assert_eq!(check_mimetype(ok), Ok(()), "{ok}");
        }
        for bad in [
            "",
            "image",
            "/png",
            "image/",
            "Image/png",
            "image/PNG",
            ".image/png",
            "image/+png",
            "image/png; charset=utf-8",
            "image/png ",
            " image/png",
            "image/png/x",
            "image/p\u{e9}g",
            "image/p_g",
        ] {
            assert_eq!(
                check_mimetype(bad),
                Err(Error::NotAllowed("mimetype")),
                "{bad}"
            );
        }
        assert_eq!(
            check_mimetype(&format!("a/{}", "b".repeat(126))),
            Err(Error::TooMany {
                field: "mimetype",
                max: 127,
                got: 128
            })
        );
        // On a media message, sent or received, and on a forwarded one.
        let alice = identity(1);
        let root = founding(&alice, &[&alice]);
        let make = |b: Body| {
            let mut p = text(alice.id, "");
            content(&mut p).body = b;
            MessageEvent::create(&root, EventId::new(TS, [9; 16]), &[], p)
        };
        let media = |m: &str| Media {
            mimetype: m.into(),
            data: vec![],
        };
        assert!(make(Body::Media(media("image/png"))).is_ok());
        assert_eq!(
            make(Body::Media(media("image/png;q=1"))),
            Err(Error::NotAllowed("mimetype"))
        );
        assert_eq!(
            make(Body::Forward {
                content_type: MessageType::Media,
                content: media("IMAGE/png").encode(),
            }),
            Err(Error::NotAllowed("mimetype"))
        );
        let event = make(Body::Media(media("image/png"))).unwrap();
        let mut proto = event.to_proto();
        proto.payload.as_mut().unwrap().body = Some(proto::Body::Media(proto::Media {
            mimetype: "image".into(),
            data: vec![1],
        }));
        assert_eq!(
            MessageEvent::from_proto(1, proto),
            Err(Error::NotAllowed("mimetype"))
        );
    }

    #[test]
    fn forwarded_media_is_canonical() {
        let m = Media {
            mimetype: "image/png".into(),
            data: vec![1, 2, 3],
        };
        let canonical = m.encode();
        assert_eq!(Media::decode(&canonical), Ok(m.clone()));
        // Empty data is left out of the canonical encoding.
        let empty = Media {
            mimetype: "image/png".into(),
            data: vec![],
        };
        assert_eq!(empty.encode(), [&[0x0a, 0x09][..], b"image/png"].concat());
        assert_eq!(Media::decode(&empty.encode()), Ok(empty.clone()));
        let not_canonical = Err(Error::Malformed("Media: not canonical"));
        // The same values in another encoding: an empty data field written out, fields in
        // reverse order, a field repeated, a length in a longer varint.
        let written = [empty.encode(), vec![0x12, 0x00]].concat();
        assert_eq!(Media::decode(&written), not_canonical);
        let reversed = [&canonical[11..], &canonical[..11]].concat();
        assert_eq!(Media::decode(&reversed), not_canonical);
        let repeated = [&canonical[..], &canonical[11..]].concat();
        assert_eq!(Media::decode(&repeated), not_canonical);
        let long_len = [&[0x0a, 0x89, 0x00][..], b"image/png", &canonical[11..]].concat();
        assert_eq!(Media::decode(&long_len), not_canonical);
        // Strict: an unknown field, text that is not UTF-8.
        assert_eq!(
            Media::decode(&[canonical.clone(), vec![0x18, 0x00]].concat()),
            Err(Error::Malformed("unknown field"))
        );
        assert_eq!(
            Media::decode(&[0x0a, 0x01, 0xff]),
            Err(Error::InvalidUtf8("Media"))
        );
        // Received in a forward, the bytes are kept as they came: they are hashed.
        let alice = identity(1);
        let root = founding(&alice, &[&alice]);
        let mut p = text(alice.id, "");
        content(&mut p).body = Body::Forward {
            content_type: MessageType::Media,
            content: canonical.clone(),
        };
        let event = MessageEvent::create(&root, EventId::new(TS, [9; 16]), &[], p).unwrap();
        let mut proto = event.to_proto();
        proto.payload.as_mut().unwrap().body = Some(proto::Body::Forward(proto::Forward {
            content_type: MessageType::Media as i32,
            content: reversed,
        }));
        assert_eq!(
            MessageEvent::from_proto(1, proto),
            Err(Error::Malformed("Media: not canonical"))
        );
    }

    #[test]
    fn result_projection_and_vector() {
        let chat = ChatId::from_bytes([0x11; 32]);
        let mut metadata = BTreeMap::new();
        metadata.insert("z".to_owned(), vec![1]);
        metadata.insert("aa".to_owned(), vec![2]);
        let payload = Payload::Content(Content {
            sync_obj_id: SyncObjId::from_bytes([0x77; 32]),
            author: GossipId::from_bytes([0x22; 32]),
            created_at: TS,
            last_modified_at: TS + 1,
            body: Body::Text("hello".into()),
            edited: true,
            metadata,
        });
        let full = payload.full_message(&chat).encode();
        let mut expected = vec![0x89, 0x58, 0x20];
        expected.extend_from_slice(&[0x11; 32]);
        expected.extend_from_slice(&[0x58, 0x20]);
        expected.extend_from_slice(&[0x77; 32]);
        expected.push(0x00);
        expected.extend_from_slice(&[0x58, 0x20]);
        expected.extend_from_slice(&[0x22; 32]);
        expected.push(0x1b);
        expected.extend_from_slice(&TS.to_be_bytes());
        expected.push(0x1b);
        expected.extend_from_slice(&(TS + 1).to_be_bytes());
        expected.extend_from_slice(b"\x65hello");
        expected.push(0xf5);
        // {"z": h'01', "aa": h'02'}: shorter encoded key first.
        expected.extend_from_slice(&[0xa2, 0x61, b'z', 0x41, 0x01, 0x62, b'a', b'a', 0x41, 0x02]);
        assert_eq!(full, expected);
        // resultHash = H(domain, fullMessage): an array of two, the domain as text of 30 bytes,
        // then the nested projection.
        let hashed = [
            &[0x82, 0x78, 0x1e][..],
            b"gossip.groups.message.result.1",
            &expected,
        ]
        .concat();
        assert_eq!(
            &payload.result_hash(&chat),
            blake3::hash(&hashed).as_bytes()
        );
        assert_eq!(
            hex::encode(payload.result_hash(&chat)),
            "2051520f1d0ff2bca88d85b44ec94e3564ad5dad34888a706f35cfea31e59c1d"
        );

        let delete = Payload::Delete {
            sync_obj_id: SyncObjId::from_bytes([0x77; 32]),
            scheduled_at: Some(5),
        };
        let mut expected = vec![0x83, 0x58, 0x20];
        expected.extend_from_slice(&[0x11; 32]);
        expected.extend_from_slice(&[0x58, 0x20]);
        expected.extend_from_slice(&[0x77; 32]);
        expected.push(0x04);
        assert_eq!(delete.full_message(&chat).encode(), expected);
        let hashed = [
            &[0x82, 0x78, 0x1e][..],
            b"gossip.groups.message.result.1",
            &expected,
        ]
        .concat();
        assert_eq!(&delete.result_hash(&chat), blake3::hash(&hashed).as_bytes());
        assert_eq!(
            hex::encode(delete.result_hash(&chat)),
            "201366475cab2e5f66f7e0f7fce0c0edd6f29f37f8bec64d67bae022218ea3dd"
        );

        let forward = Payload::Content(Content {
            sync_obj_id: SyncObjId::from_bytes([0x77; 32]),
            author: GossipId::from_bytes([0x22; 32]),
            created_at: 0,
            last_modified_at: 0,
            body: Body::Forward {
                content_type: MessageType::Media,
                content: vec![9],
            },
            edited: false,
            metadata: BTreeMap::new(),
        });
        let enc = forward.full_message(&chat).encode();
        // ... type 1, author, 0, 0, [3, h'09'], false, {}
        assert!(enc.ends_with(&[0x00, 0x00, 0x82, 0x03, 0x41, 0x09, 0xf4, 0xa0]));
        assert_eq!(enc[1 + 34 + 34], 0x01);

        // A reaction: ... type 2, ..., [h'77..', "👍", 1], ...: a byte string, a text string
        // and an unsigned integer.
        let author = GossipId::from_bytes([0x22; 32]);
        let mut removed = reaction(author, "\u{1f44d}", ReactionAction::Remove);
        content(&mut removed).created_at = 0;
        content(&mut removed).last_modified_at = 0;
        let enc = removed.full_message(&chat).encode();
        assert_eq!(enc[1 + 34 + 34], 0x02);
        let body = [
            &[0x00, 0x00, 0x83, 0x58, 0x20][..],
            &[0x77; 32],
            &[0x64, 0xf0, 0x9f, 0x91, 0x8d, 0x01, 0xf4, 0xa0],
        ]
        .concat();
        assert!(enc.ends_with(&body));
        // A media message: ... type 3, ..., ["image/png", h'0102'], ...: a text string and a
        // byte string.
        let mut media = text(author, "");
        content(&mut media).created_at = 0;
        content(&mut media).last_modified_at = 0;
        content(&mut media).body = Body::Media(Media {
            mimetype: "image/png".into(),
            data: vec![1, 2],
        });
        let enc = media.full_message(&chat).encode();
        assert_eq!(enc[1 + 34 + 34], 0x03);
        let body = [
            &[0x00, 0x00, 0x82, 0x69][..],
            b"image/png",
            &[0x42, 0x01, 0x02, 0xf4, 0xa0],
        ]
        .concat();
        assert!(enc.ends_with(&body));
    }
}
