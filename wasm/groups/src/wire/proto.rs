//! Protobuf messages of Appendix C, written by hand with the `prost` derive macros.
//!
//! The structs mirror the schema of Appendix C field for field, with three wire-compatible
//! differences that let a receiver isolate failures as §13.1 and §13.7 require:
//!
//! - [`Container::frames`] holds each `Frame` as opaque bytes, so that one bad frame does not
//!   reject the others;
//! - [`Query::entries`] holds each `QueryEntry` as opaque bytes, so that a bad entry is answered
//!   `malformed` on its own;
//! - event blobs (`Frame.event`, `Response.event`) are `bytes`, as in the schema, because they
//!   carry their own version prefix.
//!
//! A length-delimited `bytes` field and an embedded message have the same encoding, so these
//! structs read and write exactly the bytes of the schema.
//!
//! `Debug` output never shows the group secret or message content (text, bodies, metadata
//! values, encoded frames and event blobs): only their sizes. A decoded or encoded
//! `GroupRoot` zeroes its group secret when dropped.
//!
//! `prost` ignores unknown fields, truncates out-of-range `uint32` and enum values and reads
//! any nonzero `bool` as true, while the protocol rejects all of these (§1.1, §13.8). Every
//! decode therefore runs the strict check of the `strict` module first, against the schemas
//! defined at the end of this file.

#![allow(missing_docs)]

use core::fmt;
use std::collections::BTreeMap;

use zeroize::Zeroize;

use super::strict::{Kind, Limit, Schema};
use crate::constants::{
    MAX_EVENT_PARENTS, MAX_MEMBERS, MAX_NEIGHBOR_SUGGESTIONS, MAX_NOTICE_ENTRIES, MAX_PAGE_ENTRIES,
    MAX_QUERY_ENTRIES, MAX_REPLY_TARGETS, MAX_ROOT_PARENTS,
};

#[derive(Clone, PartialEq, ::prost::Message)]
#[prost(skip_debug)]
pub struct Container {
    /// Each element is one encoded `Frame`.
    #[prost(bytes = "vec", repeated, tag = "1")]
    pub frames: Vec<Vec<u8>>,
}

#[derive(Clone, PartialEq, ::prost::Message)]
pub struct Frame {
    #[prost(oneof = "FrameKind", tags = "1, 2, 3, 4, 5, 6, 7")]
    pub kind: Option<FrameKind>,
}

#[derive(Clone, PartialEq, ::prost::Oneof)]
#[prost(skip_debug)]
pub enum FrameKind {
    /// An event blob: `varint(eventVersion) ‖ Event`.
    #[prost(bytes = "vec", tag = "1")]
    Event(Vec<u8>),
    #[prost(message, tag = "2")]
    Query(Query),
    #[prost(message, tag = "3")]
    Response(Response),
    #[prost(message, tag = "4")]
    Notice(Notice),
    #[prost(message, tag = "5")]
    NeighborRequest(NeighborRequest),
    #[prost(message, tag = "6")]
    NeighborResponse(NeighborResponse),
    #[prost(message, tag = "7")]
    LeaveRequest(LeaveRequest),
}

#[derive(Clone, PartialEq, ::prost::Message)]
pub struct Event {
    #[prost(oneof = "EventKind", tags = "1, 2, 3, 4, 5")]
    pub kind: Option<EventKind>,
}

#[derive(Clone, PartialEq, ::prost::Oneof)]
pub enum EventKind {
    #[prost(message, tag = "1")]
    GroupRoot(GroupRoot),
    #[prost(message, tag = "2")]
    GroupMessageEvent(GroupMessageEvent),
    #[prost(message, tag = "3")]
    Leave(Leave),
    #[prost(message, tag = "4")]
    Kick(Kick),
    #[prost(message, tag = "5")]
    Dissolve(Dissolve),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, ::prost::Enumeration)]
#[repr(i32)]
pub enum RootType {
    Successor = 0,
    Handover = 1,
}

#[derive(Clone, PartialEq, ::prost::Message)]
#[prost(skip_debug)]
pub struct GroupRoot {
    #[prost(enumeration = "RootType", tag = "1")]
    pub r#type: i32,
    #[prost(string, tag = "2")]
    pub name: String,
    #[prost(bytes = "vec", repeated, tag = "3")]
    pub parents: Vec<Vec<u8>>,
    #[prost(bytes = "vec", repeated, tag = "4")]
    pub members: Vec<Vec<u8>>,
    #[prost(bytes = "vec", tag = "5")]
    pub group_secret: Vec<u8>,
    #[prost(bytes = "vec", tag = "6")]
    pub owner: Vec<u8>,
    #[prost(bytes = "vec", tag = "7")]
    pub epoch_challenge: Vec<u8>,
    #[prost(bytes = "vec", tag = "8")]
    pub ref_chat_id_challenge: Vec<u8>,
    #[prost(uint64, tag = "9")]
    pub created_at: u64,
    #[prost(bytes = "vec", tag = "10")]
    pub signature: Vec<u8>,
}

#[derive(Clone, PartialEq, ::prost::Message)]
pub struct Leave {
    #[prost(bytes = "vec", tag = "1")]
    pub chat_id: Vec<u8>,
    #[prost(bytes = "vec", tag = "2")]
    pub gossip_id: Vec<u8>,
    #[prost(bytes = "vec", tag = "3")]
    pub signature: Vec<u8>,
}

#[derive(Clone, PartialEq, ::prost::Message)]
pub struct Kick {
    #[prost(bytes = "vec", tag = "1")]
    pub chat_id: Vec<u8>,
    #[prost(bytes = "vec", tag = "2")]
    pub gossip_id: Vec<u8>,
    #[prost(bytes = "vec", tag = "3")]
    pub signature: Vec<u8>,
}

#[derive(Clone, PartialEq, ::prost::Message)]
pub struct Dissolve {
    #[prost(bytes = "vec", tag = "1")]
    pub chat_id: Vec<u8>,
    #[prost(bool, tag = "2")]
    pub must_delete: bool,
    #[prost(bytes = "vec", tag = "3")]
    pub signature: Vec<u8>,
}

#[derive(Clone, PartialEq, ::prost::Message)]
pub struct GroupMessageEvent {
    #[prost(bytes = "vec", tag = "1")]
    pub event_id: Vec<u8>,
    #[prost(bytes = "vec", tag = "2")]
    pub chat_id: Vec<u8>,
    #[prost(bytes = "vec", tag = "3")]
    pub secret_proof: Vec<u8>,
    #[prost(bytes = "vec", repeated, tag = "4")]
    pub parents: Vec<Vec<u8>>,
    #[prost(message, optional, tag = "5")]
    pub payload: Option<MessagePayload>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, ::prost::Enumeration)]
#[repr(i32)]
pub enum MessageType {
    Text = 0,
    Forward = 1,
    Reaction = 2,
    Media = 3,
    Delete = 4,
}

#[derive(Clone, PartialEq, ::prost::Message)]
#[prost(skip_debug)]
pub struct MessagePayload {
    #[prost(bytes = "vec", tag = "1")]
    pub sync_obj_id: Vec<u8>,
    #[prost(enumeration = "MessageType", tag = "2")]
    pub r#type: i32,
    #[prost(bytes = "vec", tag = "3")]
    pub author: Vec<u8>,
    #[prost(uint64, tag = "4")]
    pub created_at: u64,
    #[prost(uint64, optional, tag = "5")]
    pub last_modified_at: Option<u64>,
    #[prost(bool, tag = "6")]
    pub edited: bool,
    #[prost(oneof = "Body", tags = "7, 8, 9")]
    pub body: Option<Body>,
    #[prost(btree_map = "string, bytes", tag = "10")]
    pub metadata: BTreeMap<String, Vec<u8>>,
}

#[derive(Clone, PartialEq, ::prost::Oneof)]
#[prost(skip_debug)]
pub enum Body {
    #[prost(string, tag = "7")]
    Text(String),
    #[prost(message, tag = "8")]
    Forward(Forward),
    #[prost(bytes = "vec", tag = "9")]
    Content(Vec<u8>),
}

#[derive(Clone, PartialEq, ::prost::Message)]
#[prost(skip_debug)]
pub struct Forward {
    #[prost(enumeration = "MessageType", tag = "1")]
    pub content_type: i32,
    #[prost(bytes = "vec", tag = "2")]
    pub content: Vec<u8>,
}

#[derive(Clone, PartialEq, ::prost::Message)]
pub struct ReplyTo {
    #[prost(message, repeated, tag = "1")]
    pub targets: Vec<ReplyTarget>,
}

#[derive(Clone, PartialEq, ::prost::Message)]
pub struct ReplyTarget {
    #[prost(bytes = "vec", tag = "1")]
    pub ref_chat_id: Vec<u8>,
    #[prost(bytes = "vec", tag = "2")]
    pub sync_obj_id: Vec<u8>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, ::prost::Enumeration)]
#[repr(i32)]
pub enum ObjectKind {
    Event = 0,
    Root = 1,
    Leave = 2,
    Kick = 3,
    Dissolve = 4,
}

#[derive(Clone, PartialEq, ::prost::Message)]
pub struct Query {
    #[prost(bytes = "vec", tag = "1")]
    pub request_id: Vec<u8>,
    #[prost(uint64, tag = "2")]
    pub sent_at: u64,
    #[prost(uint64, tag = "3")]
    pub ttl: u64,
    /// Each element is one encoded `QueryEntry`.
    #[prost(bytes = "vec", repeated, tag = "4")]
    pub entries: Vec<Vec<u8>>,
}

#[derive(Clone, PartialEq, ::prost::Message)]
pub struct QueryEntry {
    #[prost(oneof = "QueryOp", tags = "1, 2, 3, 4, 5, 6, 7, 8")]
    pub op: Option<QueryOp>,
}

#[derive(Clone, PartialEq, ::prost::Oneof)]
pub enum QueryOp {
    #[prost(message, tag = "1")]
    ChatLookup(ChatLookup),
    #[prost(message, tag = "2")]
    SharedChatsScan(SharedChatsScan),
    #[prost(message, tag = "3")]
    EventLookup(EventLookup),
    #[prost(message, tag = "4")]
    SyncObjLookup(SyncObjLookup),
    #[prost(message, tag = "5")]
    TipsScan(TipsScan),
    #[prost(message, tag = "6")]
    ObjectLookup(ObjectLookup),
    #[prost(message, tag = "7")]
    KeyQuery(KeyQuery),
    #[prost(message, tag = "8")]
    RemovalLookup(RemovalLookup),
}

#[derive(Clone, PartialEq, ::prost::Message)]
pub struct ChatLookup {
    #[prost(oneof = "ChatLookupBy", tags = "1, 2, 3")]
    pub by: Option<ChatLookupBy>,
}

#[derive(Clone, PartialEq, ::prost::Oneof)]
pub enum ChatLookupBy {
    #[prost(bytes = "vec", tag = "1")]
    ChatId(Vec<u8>),
    #[prost(bytes = "vec", tag = "2")]
    RefChatId(Vec<u8>),
    #[prost(message, tag = "3")]
    Parent(ParentRef),
}

#[derive(Clone, PartialEq, ::prost::Message)]
pub struct ParentRef {
    #[prost(bytes = "vec", tag = "1")]
    pub chat_id: Vec<u8>,
    #[prost(bytes = "vec", tag = "2")]
    pub commitment: Vec<u8>,
}

#[derive(Clone, PartialEq, ::prost::Message)]
pub struct SharedChatsScan {
    #[prost(bytes = "vec", tag = "1")]
    pub scan_id: Vec<u8>,
    #[prost(uint64, tag = "2")]
    pub offset: u64,
}

#[derive(Clone, PartialEq, ::prost::Message)]
pub struct EventLookup {
    #[prost(bytes = "vec", tag = "1")]
    pub chat_id: Vec<u8>,
    #[prost(bytes = "vec", tag = "2")]
    pub event_id: Vec<u8>,
}

#[derive(Clone, PartialEq, ::prost::Message)]
pub struct SyncObjLookup {
    #[prost(bytes = "vec", tag = "1")]
    pub chat_id: Vec<u8>,
    #[prost(bytes = "vec", tag = "2")]
    pub sync_obj_id: Vec<u8>,
}

#[derive(Clone, PartialEq, ::prost::Message)]
pub struct TipsScan {
    #[prost(bytes = "vec", tag = "1")]
    pub chat_id: Vec<u8>,
    #[prost(bytes = "vec", tag = "2")]
    pub scan_id: Vec<u8>,
    #[prost(uint64, tag = "3")]
    pub offset: u64,
}

#[derive(Clone, PartialEq, ::prost::Message)]
pub struct ObjectLookup {
    #[prost(bytes = "vec", tag = "1")]
    pub chat_id: Vec<u8>,
    #[prost(enumeration = "ObjectKind", tag = "2")]
    pub kind: i32,
    #[prost(bytes = "vec", tag = "3")]
    pub id: Vec<u8>,
}

#[derive(Clone, PartialEq, ::prost::Message)]
pub struct RemovalLookup {
    #[prost(bytes = "vec", tag = "1")]
    pub chat_id: Vec<u8>,
    #[prost(bytes = "vec", tag = "2")]
    pub gossip_id: Vec<u8>,
}

#[derive(Clone, PartialEq, ::prost::Message)]
pub struct KeyQuery {
    #[prost(bytes = "vec", tag = "1")]
    pub chat_id: Vec<u8>,
    #[prost(bytes = "vec", tag = "2")]
    pub gossip_id: Vec<u8>,
}

#[derive(Clone, PartialEq, ::prost::Message)]
pub struct Response {
    #[prost(bytes = "vec", tag = "1")]
    pub request_id: Vec<u8>,
    #[prost(uint32, tag = "2")]
    pub idx: u32,
    #[prost(oneof = "ResponseResult", tags = "3, 4, 5, 6")]
    pub result: Option<ResponseResult>,
}

#[derive(Clone, PartialEq, ::prost::Oneof)]
#[prost(skip_debug)]
pub enum ResponseResult {
    /// An event blob; its version is at most the plaintext's.
    #[prost(bytes = "vec", tag = "3")]
    Event(Vec<u8>),
    #[prost(message, tag = "4")]
    Page(Page),
    #[prost(enumeration = "Status", tag = "5")]
    Status(i32),
    /// `bincode(UserPublicKeys)`.
    #[prost(bytes = "vec", tag = "6")]
    Keys(Vec<u8>),
}

#[derive(Clone, PartialEq, ::prost::Message)]
pub struct Page {
    #[prost(bytes = "vec", tag = "1")]
    pub scan_id: Vec<u8>,
    #[prost(uint64, tag = "2")]
    pub offset: u64,
    #[prost(uint64, tag = "3")]
    pub count: u64,
    #[prost(message, repeated, tag = "4")]
    pub entries: Vec<Entry>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, ::prost::Enumeration)]
#[repr(i32)]
pub enum Status {
    NotAvailable = 0,
    Restart = 2,
    Expired = 3,
    Malformed = 4,
    Unsupported = 5,
    Busy = 6,
}

#[derive(Clone, PartialEq, ::prost::Message)]
pub struct Notice {
    #[prost(message, repeated, tag = "1")]
    pub entries: Vec<Entry>,
}

#[derive(Clone, PartialEq, ::prost::Message)]
pub struct Entry {
    #[prost(bytes = "vec", tag = "1")]
    pub chat_id: Vec<u8>,
    #[prost(enumeration = "ObjectKind", tag = "2")]
    pub kind: i32,
    #[prost(bytes = "vec", tag = "3")]
    pub id: Vec<u8>,
}

#[derive(Clone, PartialEq, ::prost::Message)]
pub struct NeighborRequest {
    #[prost(bytes = "vec", tag = "1")]
    pub chat_id: Vec<u8>,
}

#[derive(Clone, PartialEq, ::prost::Message)]
pub struct NeighborResponse {
    #[prost(bytes = "vec", tag = "1")]
    pub chat_id: Vec<u8>,
    #[prost(bool, tag = "2")]
    pub accepted: bool,
    #[prost(bytes = "vec", repeated, tag = "3")]
    pub suggestions: Vec<Vec<u8>>,
}

#[derive(Clone, PartialEq, ::prost::Message)]
pub struct LeaveRequest {
    #[prost(bytes = "vec", tag = "1")]
    pub chat_id: Vec<u8>,
}

// ── Debug without secrets or content, and zeroing ───────────────────────────────────────

use crate::redact;

impl fmt::Debug for Container {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Container")
            .field(
                "frames",
                &self
                    .frames
                    .iter()
                    .map(|b| redact::Bytes(b.len()))
                    .collect::<Vec<_>>(),
            )
            .finish()
    }
}

impl fmt::Debug for FrameKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            FrameKind::Event(blob) => f
                .debug_tuple("Event")
                .field(&redact::Bytes(blob.len()))
                .finish(),
            FrameKind::Query(q) => f.debug_tuple("Query").field(q).finish(),
            FrameKind::Response(r) => f.debug_tuple("Response").field(r).finish(),
            FrameKind::Notice(n) => f.debug_tuple("Notice").field(n).finish(),
            FrameKind::NeighborRequest(n) => f.debug_tuple("NeighborRequest").field(n).finish(),
            FrameKind::NeighborResponse(n) => f.debug_tuple("NeighborResponse").field(n).finish(),
            FrameKind::LeaveRequest(l) => f.debug_tuple("LeaveRequest").field(l).finish(),
        }
    }
}

impl fmt::Debug for GroupRoot {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("GroupRoot")
            .field("type", &self.r#type)
            .field("name", &self.name)
            .field("parents", &self.parents.len())
            .field("members", &self.members.len())
            .field("group_secret", &redact::Bytes(self.group_secret.len()))
            .field("owner", &redact::Bytes(self.owner.len()))
            .field("created_at", &self.created_at)
            .finish_non_exhaustive()
    }
}

/// The encoded frames of a plaintext being built may hold a root, with its group secret.
impl Drop for Container {
    fn drop(&mut self) {
        self.frames.zeroize();
    }
}

/// An event blob being encoded may be a root, with its group secret. A decoded frame has its
/// kind taken out first, so nothing is copied or zeroed then.
impl Drop for Frame {
    fn drop(&mut self) {
        match &mut self.kind {
            Some(FrameKind::Event(blob)) => blob.zeroize(),
            Some(FrameKind::Response(Response {
                result: Some(ResponseResult::Event(blob)),
                ..
            })) => blob.zeroize(),
            _ => {}
        }
    }
}

impl Drop for GroupRoot {
    fn drop(&mut self) {
        self.group_secret.zeroize();
    }
}

impl fmt::Debug for MessagePayload {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("MessagePayload")
            .field("sync_obj_id", &redact::Bytes(self.sync_obj_id.len()))
            .field("type", &self.r#type)
            .field("author", &redact::Bytes(self.author.len()))
            .field("created_at", &self.created_at)
            .field("last_modified_at", &self.last_modified_at)
            .field("edited", &self.edited)
            .field("body", &self.body)
            .field("metadata", &redact::Entries(self.metadata.len()))
            .finish()
    }
}

impl fmt::Debug for Body {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Body::Text(t) => f
                .debug_tuple("Text")
                .field(&redact::Bytes(t.len()))
                .finish(),
            Body::Forward(fw) => f.debug_tuple("Forward").field(fw).finish(),
            Body::Content(b) => f
                .debug_tuple("Content")
                .field(&redact::Bytes(b.len()))
                .finish(),
        }
    }
}

impl fmt::Debug for Forward {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Forward")
            .field("content_type", &self.content_type)
            .field("content", &redact::Bytes(self.content.len()))
            .finish()
    }
}

impl fmt::Debug for ResponseResult {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ResponseResult::Event(blob) => f
                .debug_tuple("Event")
                .field(&redact::Bytes(blob.len()))
                .finish(),
            ResponseResult::Page(p) => f.debug_tuple("Page").field(p).finish(),
            ResponseResult::Status(s) => f.debug_tuple("Status").field(s).finish(),
            ResponseResult::Keys(k) => f
                .debug_tuple("Keys")
                .field(&redact::Bytes(k.len()))
                .finish(),
        }
    }
}

// ── Strict schemas (field numbers, wire types and enum values of Appendix C) ─────────────────

const OBJECT_KINDS: &[u64] = &[0, 1, 2, 3, 4];

/// Status 1 is reserved and never sent, so it is not a known value.
const STATUSES: &[u64] = &[0, 2, 3, 4, 5, 6];

pub(crate) static CONTAINER: Schema = Schema {
    name: "Container",
    fields: &[(1, Kind::Opaque)],
    oneofs: &[],
    limits: &[],
};

pub(crate) static FRAME: Schema = Schema {
    name: "Frame",
    fields: &[
        (1, Kind::Opaque),
        (2, Kind::Msg(&QUERY)),
        (3, Kind::Msg(&RESPONSE)),
        (4, Kind::Msg(&NOTICE)),
        (5, Kind::Msg(&NEIGHBOR_REQUEST)),
        (6, Kind::Msg(&NEIGHBOR_RESPONSE)),
        (7, Kind::Msg(&LEAVE_REQUEST)),
    ],
    oneofs: &[&[1, 2, 3, 4, 5, 6, 7]],
    limits: &[],
};

static QUERY: Schema = Schema {
    name: "Query",
    fields: &[
        (1, Kind::Bytes),
        (2, Kind::Uint64),
        (3, Kind::Uint64),
        // Entries are checked one by one, so that a bad entry is isolated (§13.7).
        (4, Kind::Opaque),
    ],
    oneofs: &[],
    limits: &[Limit {
        field: 4,
        max: MAX_QUERY_ENTRIES,
        name: "query entries",
    }],
};

pub(crate) static QUERY_ENTRY: Schema = Schema {
    name: "QueryEntry",
    fields: &[
        (1, Kind::Msg(&CHAT_LOOKUP)),
        (2, Kind::Msg(&SHARED_CHATS_SCAN)),
        (3, Kind::Msg(&TWO_IDS)),
        (4, Kind::Msg(&TWO_IDS)),
        (5, Kind::Msg(&TIPS_SCAN)),
        (6, Kind::Msg(&OBJECT_LOOKUP)),
        (7, Kind::Msg(&TWO_IDS)),
        (8, Kind::Msg(&TWO_IDS)),
    ],
    oneofs: &[&[1, 2, 3, 4, 5, 6, 7, 8]],
    limits: &[],
};

static CHAT_LOOKUP: Schema = Schema {
    name: "ChatLookup",
    fields: &[(1, Kind::Bytes), (2, Kind::Bytes), (3, Kind::Msg(&TWO_IDS))],
    oneofs: &[&[1, 2, 3]],
    limits: &[],
};

/// `ParentRef`, `EventLookup`, `SyncObjLookup`, `KeyQuery` and `RemovalLookup`: two `bytes`.
static TWO_IDS: Schema = Schema {
    name: "two-identifier message",
    fields: &[(1, Kind::Bytes), (2, Kind::Bytes)],
    oneofs: &[],
    limits: &[],
};

static SHARED_CHATS_SCAN: Schema = Schema {
    name: "SharedChatsScan",
    fields: &[(1, Kind::Bytes), (2, Kind::Uint64)],
    oneofs: &[],
    limits: &[],
};

static TIPS_SCAN: Schema = Schema {
    name: "TipsScan",
    fields: &[(1, Kind::Bytes), (2, Kind::Bytes), (3, Kind::Uint64)],
    oneofs: &[],
    limits: &[],
};

static OBJECT_LOOKUP: Schema = Schema {
    name: "ObjectLookup",
    fields: &[
        (1, Kind::Bytes),
        (2, Kind::Enum(OBJECT_KINDS)),
        (3, Kind::Bytes),
    ],
    oneofs: &[],
    limits: &[],
};

static RESPONSE: Schema = Schema {
    name: "Response",
    fields: &[
        (1, Kind::Bytes),
        (2, Kind::Uint32),
        (3, Kind::Opaque),
        (4, Kind::Msg(&PAGE)),
        (5, Kind::Enum(STATUSES)),
        (6, Kind::Bytes),
    ],
    oneofs: &[&[3, 4, 5, 6]],
    limits: &[],
};

static PAGE: Schema = Schema {
    name: "Page",
    fields: &[
        (1, Kind::Bytes),
        (2, Kind::Uint64),
        (3, Kind::Uint64),
        (4, Kind::RepeatedMsg(&ENTRY)),
    ],
    oneofs: &[],
    limits: &[Limit {
        field: 4,
        max: MAX_PAGE_ENTRIES,
        name: "page entries",
    }],
};

static NOTICE: Schema = Schema {
    name: "Notice",
    fields: &[(1, Kind::RepeatedMsg(&ENTRY))],
    oneofs: &[],
    limits: &[Limit {
        field: 1,
        max: MAX_NOTICE_ENTRIES,
        name: "notice entries",
    }],
};

static ENTRY: Schema = Schema {
    name: "Entry",
    fields: &[
        (1, Kind::Bytes),
        (2, Kind::Enum(OBJECT_KINDS)),
        (3, Kind::Bytes),
    ],
    oneofs: &[],
    limits: &[],
};

static NEIGHBOR_REQUEST: Schema = Schema {
    name: "NeighborRequest",
    fields: &[(1, Kind::Bytes)],
    oneofs: &[],
    limits: &[],
};

static NEIGHBOR_RESPONSE: Schema = Schema {
    name: "NeighborResponse",
    fields: &[(1, Kind::Bytes), (2, Kind::Bool), (3, Kind::Bytes)],
    oneofs: &[],
    limits: &[Limit {
        field: 3,
        max: MAX_NEIGHBOR_SUGGESTIONS,
        name: "suggestions",
    }],
};

static LEAVE_REQUEST: Schema = Schema {
    name: "LeaveRequest",
    fields: &[(1, Kind::Bytes)],
    oneofs: &[],
    limits: &[],
};

// Metadata values (§7.6).

pub(crate) static REPLY_TO: Schema = Schema {
    name: "ReplyTo",
    fields: &[(1, Kind::RepeatedMsg(&REPLY_TARGET))],
    oneofs: &[],
    limits: &[Limit {
        field: 1,
        max: MAX_REPLY_TARGETS,
        name: "replyTo",
    }],
};

static REPLY_TARGET: Schema = Schema {
    name: "ReplyTarget",
    fields: &[(1, Kind::Bytes), (2, Kind::Bytes)],
    oneofs: &[],
    limits: &[],
};

// Event blobs (§13.1).

const ROOT_TYPES: &[u64] = &[0, 1];

const MESSAGE_TYPES: &[u64] = &[0, 1, 2, 3, 4];

pub(crate) static EVENT: Schema = Schema {
    name: "Event",
    fields: &[
        (1, Kind::Msg(&GROUP_ROOT)),
        (2, Kind::Msg(&GROUP_MESSAGE_EVENT)),
        (3, Kind::Msg(&SIGNED_OBJECT)),
        (4, Kind::Msg(&SIGNED_OBJECT)),
        (5, Kind::Msg(&DISSOLVE)),
    ],
    oneofs: &[&[1, 2, 3, 4, 5]],
    limits: &[],
};

static GROUP_ROOT: Schema = Schema {
    name: "GroupRoot",
    fields: &[
        (1, Kind::Enum(ROOT_TYPES)),
        (2, Kind::Str),
        (3, Kind::Bytes),
        (4, Kind::Bytes),
        (5, Kind::Bytes),
        (6, Kind::Bytes),
        (7, Kind::Bytes),
        (8, Kind::Bytes),
        (9, Kind::Uint64),
        (10, Kind::Bytes),
    ],
    oneofs: &[],
    limits: &[
        Limit {
            field: 3,
            max: MAX_ROOT_PARENTS,
            name: "parents",
        },
        Limit {
            field: 4,
            max: MAX_MEMBERS,
            name: "members",
        },
    ],
};

/// `Leave` and `Kick` have the same fields.
static SIGNED_OBJECT: Schema = Schema {
    name: "Leave/Kick",
    fields: &[(1, Kind::Bytes), (2, Kind::Bytes), (3, Kind::Bytes)],
    oneofs: &[],
    limits: &[],
};

static DISSOLVE: Schema = Schema {
    name: "Dissolve",
    fields: &[(1, Kind::Bytes), (2, Kind::Bool), (3, Kind::Bytes)],
    oneofs: &[],
    limits: &[],
};

static GROUP_MESSAGE_EVENT: Schema = Schema {
    name: "GroupMessageEvent",
    fields: &[
        (1, Kind::Bytes),
        (2, Kind::Bytes),
        (3, Kind::Bytes),
        (4, Kind::Bytes),
        (5, Kind::Msg(&MESSAGE_PAYLOAD)),
    ],
    oneofs: &[],
    limits: &[Limit {
        field: 4,
        max: MAX_EVENT_PARENTS,
        name: "parents",
    }],
};

static MESSAGE_PAYLOAD: Schema = Schema {
    name: "MessagePayload",
    fields: &[
        (1, Kind::Bytes),
        (2, Kind::Enum(MESSAGE_TYPES)),
        (3, Kind::Bytes),
        (4, Kind::Uint64),
        (5, Kind::Uint64),
        (6, Kind::Bool),
        (7, Kind::Str),
        (8, Kind::Msg(&FORWARD)),
        (9, Kind::Bytes),
        (10, Kind::RepeatedMsg(&METADATA_ENTRY)),
    ],
    oneofs: &[&[7, 8, 9]],
    limits: &[],
};

/// The implicit entry message of `map<string, bytes>`.
static METADATA_ENTRY: Schema = Schema {
    name: "MetadataEntry",
    fields: &[(1, Kind::Str), (2, Kind::Bytes)],
    oneofs: &[],
    limits: &[],
};

static FORWARD: Schema = Schema {
    name: "Forward",
    fields: &[(1, Kind::Enum(MESSAGE_TYPES)), (2, Kind::Bytes)],
    oneofs: &[],
    limits: &[],
};
