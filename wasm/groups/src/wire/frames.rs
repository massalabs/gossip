//! Typed frames (§13.1 to §13.6) and their structural rules.
//!
//! Decoding checks what a frame carries by itself: identifier lengths, entry counts, byte
//! limits and the consistency rules of pages and neighbor responses. Authorization (§13.7),
//! correlation (§13.4) and scan state need the device's state and are not decided here.

use prost::Message;

use super::proto;
use super::strict;
use crate::constants::{
    MAX_NEIGHBOR_SUGGESTIONS, MAX_NOTICE_BYTES, MAX_NOTICE_ENTRIES, MAX_PAGE_BYTES,
    MAX_PAGE_ENTRIES, MAX_QUERY_ENTRIES,
};
use crate::error::{Error, Result};
use crate::ids::{
    ChatId, DissolveId, EventId, GossipId, KickId, LeaveId, ParentCommitment, RefChatId, RequestId,
    ScanId, SyncObjId,
};

/// One frame of a container; each holds exactly one kind (§13.1).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Frame {
    /// An event blob, decoded separately with [`super::decode_event_blob`] against the
    /// plaintext's version, so that a bad or unsupported event is rejected on its own.
    Event(Vec<u8>),
    /// Queries (§13.3).
    Query(Query),
    /// One response (§13.4).
    Response(Response),
    /// Gossip notices (§13.5).
    Notice(Notice),
    /// §13.6.
    NeighborRequest(NeighborRequest),
    /// §13.6.
    NeighborResponse(NeighborResponse),
    /// The owner-only request (§5.4, §13.6).
    LeaveRequest(LeaveRequest),
}

/// A query frame: at most 16 entries (§13.3).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Query {
    /// 16 random bytes, fresh for every query frame sent.
    pub request_id: RequestId,
    /// The requester's clock at sending.
    pub sent_at: u64,
    /// The time to live.
    pub ttl: u64,
    /// The entries, in their wire positions.
    pub entries: Vec<QueryEntry>,
}

/// One position of a query.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum QueryEntry {
    /// A valid operation.
    Op(QueryOp),
    /// An entry that could not be parsed or breaks a rule; it is answered `malformed` and the
    /// other entries are processed without renumbering (§13.7, §13.8). Never sent.
    Malformed(Error),
}

/// The kind of a signed object (§13.3 signed-object lookup).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum SignedKind {
    /// A signed leave.
    Leave,
    /// A kick.
    Kick,
    /// A dissolve message.
    Dissolve,
}

/// A query operation (§13.3).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum QueryOp {
    /// Chat lookup by ID.
    ChatById(ChatId),
    /// Chat lookup by reference.
    ChatByRef(RefChatId),
    /// Chat lookup by parent: the root whose parent is wanted and one of its commitments.
    ChatByParent {
        /// The root whose parent is wanted.
        chat_id: ChatId,
        /// One of its parent commitments.
        commitment: ParentCommitment,
    },
    /// Shared-chats scan.
    SharedChatsScan {
        /// The scan.
        scan_id: ScanId,
        /// The offset.
        offset: u64,
    },
    /// Event lookup.
    Event {
        /// The epoch.
        chat_id: ChatId,
        /// The event.
        event_id: EventId,
    },
    /// Sync-object lookup.
    SyncObj {
        /// The epoch.
        chat_id: ChatId,
        /// The sync object.
        sync_obj_id: SyncObjId,
    },
    /// Signed-object lookup.
    SignedObject {
        /// The epoch the object names.
        chat_id: ChatId,
        /// Leave, kick or dissolve.
        kind: SignedKind,
        /// Its 32-byte hash ID.
        id: [u8; 32],
    },
    /// Removal lookup.
    Removal {
        /// The epoch.
        chat_id: ChatId,
        /// The removed peer.
        gossip_id: GossipId,
    },
    /// Tips scan.
    TipsScan {
        /// The anchor: the requester's current epoch.
        anchor: ChatId,
        /// The scan.
        scan_id: ScanId,
        /// The offset.
        offset: u64,
    },
    /// Key query.
    Keys {
        /// The epoch shared by requester, responder and subject.
        chat_id: ChatId,
        /// The subject.
        gossip_id: GossipId,
    },
}

/// A response (§13.4).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Response {
    /// The query's `request_id`; `None` only for the version notice of §13.8.
    pub request_id: Option<RequestId>,
    /// The zero-based position of the answered entry.
    pub idx: u32,
    /// The result.
    pub result: ResponseResult,
}

/// The result of a response (§13.4).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ResponseResult {
    /// An event blob, decoded separately with [`super::decode_event_blob`].
    Event(Vec<u8>),
    /// A scan page.
    Page(Page),
    /// A status code.
    Status(Status),
    /// `bincode(UserPublicKeys)`, checked with [`crate::check_key_answer`].
    Keys(Vec<u8>),
}

/// A response status (§13.4). Code 1 is reserved and never sent.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Status {
    /// Authorized, but not available here.
    NotAvailable,
    /// The scan state is gone.
    Restart,
    /// The query was past its receiver deadline.
    Expired,
    /// The entry could not be parsed.
    Malformed,
    /// The plaintext's version is higher than the receiver supports.
    Unsupported,
    /// Refused for resource reasons.
    Busy,
}

/// A scan page: `[scanId, offset, count, entries]` (§12.1).
///
/// An invalid entry is skipped on receipt and the others are kept (§13.7, D.23). The count
/// rules of §12.1 apply to the entries as received, skipped ones included: they still hold
/// their positions in the frozen list.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Page {
    /// The scan.
    pub scan_id: ScanId,
    /// The offset of the first entry.
    pub offset: u64,
    /// The number of entries remaining from `offset`, this page included.
    pub count: u64,
    /// At most 128 entries and 16 KiB, the skipped ones included.
    pub entries: Vec<Entry>,
    /// How many received entries were invalid and skipped; the sender is penalised as for one
    /// malformed item. Always 0 in a page to send.
    pub skipped: usize,
}

/// A notice: at most 128 entries and 16 KiB (§13.5).
///
/// An invalid entry is skipped on receipt and the others are kept (§13.7, D.23).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Notice {
    /// The valid entries; they may mix epochs.
    pub entries: Vec<Entry>,
    /// How many received entries were invalid and skipped; the sender is penalised as for one
    /// malformed item. Always 0 in a notice to send.
    pub skipped: usize,
}

/// A notice or page entry: `[chat_id, kind, id]` (§13.5).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Entry {
    /// The epoch.
    pub chat_id: ChatId,
    /// The announced item.
    pub item: EntryItem,
}

/// What an entry announces (§13.5).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EntryItem {
    /// A message event.
    Event(EventId),
    /// The root whose ID is the entry's `chat_id`; its `id` is empty.
    Root,
    /// A signed leave.
    Leave(LeaveId),
    /// A kick.
    Kick(KickId),
    /// A dissolve message.
    Dissolve(DissolveId),
}

/// `neighbor_request = [chat_id]` (§13.6).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct NeighborRequest {
    /// The requester's current epoch.
    pub chat_id: ChatId,
}

/// `neighbor_response = [chat_id, accepted, suggestions]` (§13.6).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NeighborResponse {
    /// The epoch of the request.
    pub chat_id: ChatId,
    /// Whether the request is accepted.
    pub accepted: bool,
    /// At most ten distinct GossipIDs; empty when accepted.
    pub suggestions: Vec<GossipId>,
}

/// `leave_request = [chat_id]`, the owner-only request (§5.4, §13.6).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LeaveRequest {
    /// The requester's current epoch.
    pub chat_id: ChatId,
}

// ── Status ───────────────────────────────────────────────────────────────────

impl Status {
    fn from_wire(v: i32) -> Result<Self> {
        Ok(match proto::Status::try_from(v) {
            Ok(proto::Status::NotAvailable) => Status::NotAvailable,
            Ok(proto::Status::Restart) => Status::Restart,
            Ok(proto::Status::Expired) => Status::Expired,
            Ok(proto::Status::Malformed) => Status::Malformed,
            Ok(proto::Status::Unsupported) => Status::Unsupported,
            Ok(proto::Status::Busy) => Status::Busy,
            Err(_) => return Err(Error::Malformed("unknown status")),
        })
    }

    fn to_wire(self) -> i32 {
        (match self {
            Status::NotAvailable => proto::Status::NotAvailable,
            Status::Restart => proto::Status::Restart,
            Status::Expired => proto::Status::Expired,
            Status::Malformed => proto::Status::Malformed,
            Status::Unsupported => proto::Status::Unsupported,
            Status::Busy => proto::Status::Busy,
        }) as i32
    }
}

// ── Entries ──────────────────────────────────────────────────────────────────

impl Entry {
    fn from_proto(p: &proto::Entry) -> Result<Self> {
        let chat_id = ChatId::from_slice(&p.chat_id)?;
        let item = match proto::ObjectKind::try_from(p.kind) {
            Ok(proto::ObjectKind::Event) => EntryItem::Event(EventId::from_slice(&p.id)?),
            Ok(proto::ObjectKind::Root) => {
                if !p.id.is_empty() {
                    return Err(Error::BadLength {
                        field: "root entry id",
                        expected: 0,
                        got: p.id.len(),
                    });
                }
                EntryItem::Root
            }
            Ok(proto::ObjectKind::Leave) => EntryItem::Leave(LeaveId::from_slice(&p.id)?),
            Ok(proto::ObjectKind::Kick) => EntryItem::Kick(KickId::from_slice(&p.id)?),
            Ok(proto::ObjectKind::Dissolve) => EntryItem::Dissolve(DissolveId::from_slice(&p.id)?),
            Err(_) => return Err(Error::Malformed("unknown object kind")),
        };
        Ok(Self { chat_id, item })
    }

    pub(super) fn to_proto(self) -> proto::Entry {
        let (kind, id) = match self.item {
            EntryItem::Event(e) => (proto::ObjectKind::Event, e.as_bytes().to_vec()),
            EntryItem::Root => (proto::ObjectKind::Root, Vec::new()),
            EntryItem::Leave(l) => (proto::ObjectKind::Leave, l.as_bytes().to_vec()),
            EntryItem::Kick(k) => (proto::ObjectKind::Kick, k.as_bytes().to_vec()),
            EntryItem::Dissolve(d) => (proto::ObjectKind::Dissolve, d.as_bytes().to_vec()),
        };
        proto::Entry {
            chat_id: self.chat_id.as_bytes().to_vec(),
            kind: kind as i32,
            id,
        }
    }
}

/// On receipt the strict check has already refused too many entries before decoding (see the
/// schemas of `proto`); this repeats it at no cost, and applies it to what is sent.
fn check_entry_list(field: &'static str, n: usize, max: usize) -> Result<()> {
    if n > max {
        return Err(Error::TooMany { field, max, got: n });
    }
    Ok(())
}

/// The valid entries of a notice or page, and how many invalid ones were skipped. An entry
/// is invalid when an ID has the wrong length (a root entry's `id` must be empty); unknown
/// fields or kinds were refused with the whole frame by the strict check (§1).
fn valid_entries(entries: &[proto::Entry]) -> (Vec<Entry>, usize) {
    let valid: Vec<Entry> = entries
        .iter()
        .filter_map(|e| Entry::from_proto(e).ok())
        .collect();
    let skipped = entries.len() - valid.len();
    (valid, skipped)
}

fn check_not_skipped(skipped: usize) -> Result<()> {
    if skipped == 0 {
        Ok(())
    } else {
        Err(Error::NotAllowed("skipped entries"))
    }
}

fn check_bytes(field: &'static str, len: usize, max: usize) -> Result<()> {
    if len > max {
        return Err(Error::TooMany {
            field,
            max,
            got: len,
        });
    }
    Ok(())
}

// ── Pages and notices ────────────────────────────────────────────────────────

impl Page {
    /// `received_len` is the size of the page as received.
    fn from_proto(p: &proto::Page, received_len: usize) -> Result<Self> {
        check_entry_list("page entries", p.entries.len(), MAX_PAGE_ENTRIES)?;
        check_bytes("page bytes", received_len, MAX_PAGE_BYTES)?;
        let scan_id = ScanId::from_slice(&p.scan_id)?;
        let (entries, skipped) = valid_entries(&p.entries);
        let page = Self {
            scan_id,
            offset: p.offset,
            count: p.count,
            entries,
            skipped,
        };
        page.check_count()?;
        Ok(page)
    }

    /// The number of entries the page carried, skipped ones included.
    #[must_use]
    pub fn received(&self) -> u64 {
        (self.entries.len() + self.skipped) as u64
    }

    /// `count` includes this page's entries; an empty page with a positive count is invalid
    /// (§12.1).
    fn check_count(&self) -> Result<()> {
        let n = self.received();
        if self.count < n || (n == 0 && self.count > 0) {
            return Err(Error::NotAllowed("page count"));
        }
        Ok(())
    }

    fn to_proto(&self) -> Result<proto::Page> {
        check_not_skipped(self.skipped)?;
        check_entry_list("page entries", self.entries.len(), MAX_PAGE_ENTRIES)?;
        self.check_count()?;
        let p = proto::Page {
            scan_id: self.scan_id.as_bytes().to_vec(),
            offset: self.offset,
            count: self.count,
            entries: self.entries.iter().map(|e| e.to_proto()).collect(),
        };
        check_bytes("page bytes", p.encoded_len(), MAX_PAGE_BYTES)?;
        Ok(p)
    }

    /// Whether this page ends the scan: `count` equals the number of entries it carried,
    /// skipped ones included (§12.1).
    #[must_use]
    pub fn is_final(&self) -> bool {
        self.count == self.received()
    }
}

impl Notice {
    /// `received_len` is the size of the notice as received.
    fn from_proto(p: &proto::Notice, received_len: usize) -> Result<Self> {
        check_entry_list("notice entries", p.entries.len(), MAX_NOTICE_ENTRIES)?;
        check_bytes("notice bytes", received_len, MAX_NOTICE_BYTES)?;
        let (entries, skipped) = valid_entries(&p.entries);
        Ok(Self { entries, skipped })
    }

    fn to_proto(&self) -> Result<proto::Notice> {
        check_not_skipped(self.skipped)?;
        check_entry_list("notice entries", self.entries.len(), MAX_NOTICE_ENTRIES)?;
        let p = proto::Notice {
            entries: self.entries.iter().map(|e| e.to_proto()).collect(),
        };
        check_bytes("notice bytes", p.encoded_len(), MAX_NOTICE_BYTES)?;
        Ok(p)
    }
}

// ── Queries ──────────────────────────────────────────────────────────────────

impl QueryOp {
    /// Decodes one entry; any failure is isolated to that entry.
    fn decode(bytes: &[u8]) -> Result<Self> {
        let entry: proto::QueryEntry = strict::decode(bytes, &proto::QUERY_ENTRY)?;
        Ok(match entry.op.ok_or(Error::Missing("query operation"))? {
            proto::QueryOp::ChatLookup(c) => match c.by.ok_or(Error::Missing("chat lookup key"))? {
                proto::ChatLookupBy::ChatId(id) => QueryOp::ChatById(ChatId::from_slice(&id)?),
                proto::ChatLookupBy::RefChatId(id) => {
                    QueryOp::ChatByRef(RefChatId::from_slice(&id)?)
                }
                proto::ChatLookupBy::Parent(p) => QueryOp::ChatByParent {
                    chat_id: ChatId::from_slice(&p.chat_id)?,
                    commitment: ParentCommitment::from_slice(&p.commitment)?,
                },
            },
            proto::QueryOp::SharedChatsScan(s) => QueryOp::SharedChatsScan {
                scan_id: ScanId::from_slice(&s.scan_id)?,
                offset: s.offset,
            },
            proto::QueryOp::EventLookup(e) => QueryOp::Event {
                chat_id: ChatId::from_slice(&e.chat_id)?,
                event_id: EventId::from_slice(&e.event_id)?,
            },
            proto::QueryOp::SyncObjLookup(s) => QueryOp::SyncObj {
                chat_id: ChatId::from_slice(&s.chat_id)?,
                sync_obj_id: SyncObjId::from_slice(&s.sync_obj_id)?,
            },
            proto::QueryOp::TipsScan(t) => QueryOp::TipsScan {
                anchor: ChatId::from_slice(&t.chat_id)?,
                scan_id: ScanId::from_slice(&t.scan_id)?,
                offset: t.offset,
            },
            proto::QueryOp::ObjectLookup(o) => {
                let kind = match proto::ObjectKind::try_from(o.kind) {
                    Ok(proto::ObjectKind::Leave) => SignedKind::Leave,
                    Ok(proto::ObjectKind::Kick) => SignedKind::Kick,
                    Ok(proto::ObjectKind::Dissolve) => SignedKind::Dissolve,
                    _ => return Err(Error::NotAllowed("object lookup kind")),
                };
                QueryOp::SignedObject {
                    chat_id: ChatId::from_slice(&o.chat_id)?,
                    kind,
                    id: crate::ids::fixed("object id", &o.id)?,
                }
            }
            proto::QueryOp::KeyQuery(k) => QueryOp::Keys {
                chat_id: ChatId::from_slice(&k.chat_id)?,
                gossip_id: GossipId::from_slice(&k.gossip_id)?,
            },
            proto::QueryOp::RemovalLookup(r) => QueryOp::Removal {
                chat_id: ChatId::from_slice(&r.chat_id)?,
                gossip_id: GossipId::from_slice(&r.gossip_id)?,
            },
        })
    }

    pub(super) fn encode(&self) -> Vec<u8> {
        let b = |x: &[u8]| x.to_vec();
        let op = match self {
            QueryOp::ChatById(id) => proto::QueryOp::ChatLookup(proto::ChatLookup {
                by: Some(proto::ChatLookupBy::ChatId(b(id.as_bytes()))),
            }),
            QueryOp::ChatByRef(id) => proto::QueryOp::ChatLookup(proto::ChatLookup {
                by: Some(proto::ChatLookupBy::RefChatId(b(id.as_bytes()))),
            }),
            QueryOp::ChatByParent {
                chat_id,
                commitment,
            } => proto::QueryOp::ChatLookup(proto::ChatLookup {
                by: Some(proto::ChatLookupBy::Parent(proto::ParentRef {
                    chat_id: b(chat_id.as_bytes()),
                    commitment: b(commitment.as_bytes()),
                })),
            }),
            QueryOp::SharedChatsScan { scan_id, offset } => {
                proto::QueryOp::SharedChatsScan(proto::SharedChatsScan {
                    scan_id: b(scan_id.as_bytes()),
                    offset: *offset,
                })
            }
            QueryOp::Event { chat_id, event_id } => {
                proto::QueryOp::EventLookup(proto::EventLookup {
                    chat_id: b(chat_id.as_bytes()),
                    event_id: b(event_id.as_bytes()),
                })
            }
            QueryOp::SyncObj {
                chat_id,
                sync_obj_id,
            } => proto::QueryOp::SyncObjLookup(proto::SyncObjLookup {
                chat_id: b(chat_id.as_bytes()),
                sync_obj_id: b(sync_obj_id.as_bytes()),
            }),
            QueryOp::SignedObject { chat_id, kind, id } => {
                proto::QueryOp::ObjectLookup(proto::ObjectLookup {
                    chat_id: b(chat_id.as_bytes()),
                    kind: (match kind {
                        SignedKind::Leave => proto::ObjectKind::Leave,
                        SignedKind::Kick => proto::ObjectKind::Kick,
                        SignedKind::Dissolve => proto::ObjectKind::Dissolve,
                    }) as i32,
                    id: b(id),
                })
            }
            QueryOp::Removal { chat_id, gossip_id } => {
                proto::QueryOp::RemovalLookup(proto::RemovalLookup {
                    chat_id: b(chat_id.as_bytes()),
                    gossip_id: b(gossip_id.as_bytes()),
                })
            }
            QueryOp::TipsScan {
                anchor,
                scan_id,
                offset,
            } => proto::QueryOp::TipsScan(proto::TipsScan {
                chat_id: b(anchor.as_bytes()),
                scan_id: b(scan_id.as_bytes()),
                offset: *offset,
            }),
            QueryOp::Keys { chat_id, gossip_id } => proto::QueryOp::KeyQuery(proto::KeyQuery {
                chat_id: b(chat_id.as_bytes()),
                gossip_id: b(gossip_id.as_bytes()),
            }),
        };
        proto::QueryEntry { op: Some(op) }.encode_to_vec()
    }
}

impl Query {
    fn from_proto(p: &proto::Query) -> Result<Self> {
        let request_id = RequestId::from_slice(&p.request_id)?;
        // The entry count belongs to the query itself, so too many rejects the frame.
        check_entry_list("query entries", p.entries.len(), MAX_QUERY_ENTRIES)?;
        let entries = p
            .entries
            .iter()
            .map(|e| match QueryOp::decode(e) {
                Ok(op) => QueryEntry::Op(op),
                Err(err) => QueryEntry::Malformed(err),
            })
            .collect();
        Ok(Self {
            request_id,
            sent_at: p.sent_at,
            ttl: p.ttl,
            entries,
        })
    }

    fn to_proto(&self) -> Result<proto::Query> {
        check_entry_list("query entries", self.entries.len(), MAX_QUERY_ENTRIES)?;
        let entries = self
            .entries
            .iter()
            .map(|e| match e {
                QueryEntry::Op(op) => Ok(op.encode()),
                QueryEntry::Malformed(_) => Err(Error::NotAllowed("malformed query entry")),
            })
            .collect::<Result<_>>()?;
        Ok(proto::Query {
            request_id: self.request_id.as_bytes().to_vec(),
            sent_at: self.sent_at,
            ttl: self.ttl,
            entries,
        })
    }
}

// ── Responses ────────────────────────────────────────────────────────────────

impl Response {
    fn from_proto(p: proto::Response, received_page_len: usize) -> Result<Self> {
        let request_id = if p.request_id.is_empty() {
            None
        } else {
            Some(RequestId::from_slice(&p.request_id)?)
        };
        let result = match p.result.ok_or(Error::Missing("response result"))? {
            proto::ResponseResult::Event(blob) => ResponseResult::Event(blob),
            proto::ResponseResult::Page(page) => {
                ResponseResult::Page(Page::from_proto(&page, received_page_len)?)
            }
            proto::ResponseResult::Status(s) => ResponseResult::Status(Status::from_wire(s)?),
            proto::ResponseResult::Keys(k) => ResponseResult::Keys(k),
        };
        let response = Self {
            request_id,
            idx: p.idx,
            result,
        };
        response.check_version_notice()?;
        Ok(response)
    }

    /// An empty `request_id` is allowed only for the version notice (§13.4, §13.8).
    fn check_version_notice(&self) -> Result<()> {
        if self.request_id.is_none()
            && !(self.idx == 0 && self.result == ResponseResult::Status(Status::Unsupported))
        {
            return Err(Error::BadLength {
                field: "request_id",
                expected: RequestId::SIZE,
                got: 0,
            });
        }
        Ok(())
    }

    fn to_proto(&self) -> Result<proto::Response> {
        self.check_version_notice()?;
        Ok(proto::Response {
            request_id: self
                .request_id
                .map(|r| r.as_bytes().to_vec())
                .unwrap_or_default(),
            idx: self.idx,
            result: Some(match &self.result {
                ResponseResult::Event(blob) => proto::ResponseResult::Event(blob.clone()),
                ResponseResult::Page(page) => proto::ResponseResult::Page(page.to_proto()?),
                ResponseResult::Status(s) => proto::ResponseResult::Status(s.to_wire()),
                ResponseResult::Keys(k) => proto::ResponseResult::Keys(k.clone()),
            }),
        })
    }

    /// Whether this is the version notice of §13.8, which records the peer's highest
    /// supported version (the plaintext's).
    #[must_use]
    pub fn is_version_notice(&self) -> bool {
        self.request_id.is_none()
    }
}

// ── Neighbor frames ──────────────────────────────────────────────────────────

impl NeighborResponse {
    fn check(&self) -> Result<()> {
        check_entry_list(
            "suggestions",
            self.suggestions.len(),
            MAX_NEIGHBOR_SUGGESTIONS,
        )?;
        if self.accepted && !self.suggestions.is_empty() {
            return Err(Error::MustBeAbsent("suggestions"));
        }
        let mut sorted = self.suggestions.clone();
        sorted.sort_unstable();
        if sorted.windows(2).any(|w| w[0] == w[1]) {
            return Err(Error::Duplicate("suggestions"));
        }
        Ok(())
    }

    fn from_proto(p: &proto::NeighborResponse) -> Result<Self> {
        check_entry_list("suggestions", p.suggestions.len(), MAX_NEIGHBOR_SUGGESTIONS)?;
        let r = Self {
            chat_id: ChatId::from_slice(&p.chat_id)?,
            accepted: p.accepted,
            suggestions: p
                .suggestions
                .iter()
                .map(|s| GossipId::from_slice(s))
                .collect::<Result<_>>()?,
        };
        r.check()?;
        Ok(r)
    }
}

// ── Frames ───────────────────────────────────────────────────────────────────

/// Field numbers used to measure received sizes (Appendix C).
const FRAME_RESPONSE: u32 = 3;
const FRAME_NOTICE: u32 = 4;
const RESPONSE_PAGE: u32 = 4;

impl Frame {
    /// Decodes and validates one encoded `Frame`.
    pub(crate) fn decode(bytes: &[u8]) -> Result<Self> {
        let frame: proto::Frame = strict::decode(bytes, &proto::FRAME)?;
        Ok(match frame.kind.ok_or(Error::Missing("frame kind"))? {
            proto::FrameKind::Event(blob) => Frame::Event(blob),
            proto::FrameKind::Query(q) => Frame::Query(Query::from_proto(&q)?),
            proto::FrameKind::Response(r) => Frame::Response(Response::from_proto(
                r,
                strict::raw_len(bytes, &[FRAME_RESPONSE, RESPONSE_PAGE])?,
            )?),
            proto::FrameKind::Notice(n) => Frame::Notice(Notice::from_proto(
                &n,
                strict::raw_len(bytes, &[FRAME_NOTICE])?,
            )?),
            proto::FrameKind::NeighborRequest(n) => Frame::NeighborRequest(NeighborRequest {
                chat_id: ChatId::from_slice(&n.chat_id)?,
            }),
            proto::FrameKind::NeighborResponse(n) => {
                Frame::NeighborResponse(NeighborResponse::from_proto(&n)?)
            }
            proto::FrameKind::LeaveRequest(l) => Frame::LeaveRequest(LeaveRequest {
                chat_id: ChatId::from_slice(&l.chat_id)?,
            }),
        })
    }

    /// Validates and encodes this frame.
    pub(crate) fn encode(&self) -> Result<Vec<u8>> {
        let kind = match self {
            Frame::Event(blob) => proto::FrameKind::Event(blob.clone()),
            Frame::Query(q) => proto::FrameKind::Query(q.to_proto()?),
            Frame::Response(r) => proto::FrameKind::Response(r.to_proto()?),
            Frame::Notice(n) => proto::FrameKind::Notice(n.to_proto()?),
            Frame::NeighborRequest(n) => {
                proto::FrameKind::NeighborRequest(proto::NeighborRequest {
                    chat_id: n.chat_id.as_bytes().to_vec(),
                })
            }
            Frame::NeighborResponse(n) => {
                n.check()?;
                proto::FrameKind::NeighborResponse(proto::NeighborResponse {
                    chat_id: n.chat_id.as_bytes().to_vec(),
                    accepted: n.accepted,
                    suggestions: n
                        .suggestions
                        .iter()
                        .map(|s| s.as_bytes().to_vec())
                        .collect(),
                })
            }
            Frame::LeaveRequest(l) => proto::FrameKind::LeaveRequest(proto::LeaveRequest {
                chat_id: l.chat_id.as_bytes().to_vec(),
            }),
        };
        Ok(proto::Frame { kind: Some(kind) }.encode_to_vec())
    }
}
