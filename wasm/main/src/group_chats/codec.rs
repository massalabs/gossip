//! The field encoding of the engine's records for the SDK's database.
//!
//! Every record is written field by field as JSON ([`J`]): identifiers and byte fields as
//! lowercase hex, integers exactly. The engine keeps no serialization of its records (§14.1:
//! "only explicit protocol projections are serialized, never a whole stored record" is about
//! what is sent), so this module is the one place that maps them to storable fields.
//!
//! Two kinds of objects cannot be rebuilt from their fields through the engine's public
//! interface: roots and signed objects (leaves, kicks, dissolve messages) have private fields
//! and no constructor from fields. They are stored as the device's own encoding of their
//! fields under their own version ([`groups::wire::encode_event_blob`]), which is what §13.1
//! allows ("it may store the version and the fields in any layout and encode them again"):
//! never the bytes received. A message event is stored by its fields and rebuilt with
//! [`MessageEvent::create`] against its epoch's root, so its secret proof is not stored.

use std::collections::{BTreeMap, BTreeSet};

use groups::display::VisibleMessage;
use groups::node::records::{
    AnswerOp, Attempt, Candidate, CandidateState, ChangeKind, EpochRecord, EpochStatus, FrozenScan,
    GroupRecord, GroupStatus, GroupSync, HeldRoot, Hint, Invitation, Lane, Marker, Meta,
    PeerRecord, PendingLeave, Purpose, RefEntry, ReplyCount, RequestRef, Run, ScanAttempt, ScanOp,
    SignedObject, SignedRecord, Target, Task, TaskKey, Trigger, TriggerKind, Work,
};
use groups::node::timing::Bucket;
use groups::node::{
    Change, GroupChange, GroupSummary, InvitationSummary, LeaveChoice, LookupResult, MyStatus,
    TimelineItem, TimelineLine,
};
use groups::store::{Role, StoredResult};
use groups::wire::{self, Entry, EntryItem, EventObject, QueryOp, SignedKind, Status};
use groups::{
    Body, ChatId, Content, Dissolve, DissolveId, EventId, GossipId, GroupState, Kick, KickId,
    Leave, LeaveId, LocalEdit, Merge, MessageType, ParentCommitment, Payload, RefChatId, RequestId,
    Root, ScanId, SyncObjId,
};

use super::json::J;

pub type R<T> = Result<T, String>;

/// A record field that can be written to and read from JSON.
pub trait Codec: Sized {
    fn enc(&self) -> J;
    fn dec(j: &J) -> R<Self>;
}

/// A type that is written as one JSON value inside an array (every codec type but `u8`,
/// whose vectors are byte strings written as hex).
pub trait Elem: Codec {}

// ── Hex ──────────────────────────────────────────────────────────────────────

pub fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push(DIGITS[(b >> 4) as usize] as char);
        s.push(DIGITS[(b & 0xf) as usize] as char);
    }
    s
}

pub fn unhex(s: &str) -> R<Vec<u8>> {
    fn nibble(c: u8) -> R<u8> {
        match c {
            b'0'..=b'9' => Ok(c - b'0'),
            b'a'..=b'f' => Ok(c - b'a' + 10),
            _ => Err("invalid hex".into()),
        }
    }
    let b = s.as_bytes();
    if !b.len().is_multiple_of(2) {
        return Err("odd hex length".into());
    }
    b.chunks(2)
        .map(|p| Ok((nibble(p[0])? << 4) | nibble(p[1])?))
        .collect()
}

// ── Primitives and containers ───────────────────────────────────────────────

impl Codec for u64 {
    fn enc(&self) -> J {
        J::Num(*self)
    }
    fn dec(j: &J) -> R<Self> {
        j.as_u64()
    }
}
impl Elem for u64 {}

macro_rules! small_uint {
    ($($t:ty),*) => {$(
        impl Codec for $t {
            fn enc(&self) -> J {
                J::Num(u64::from(*self))
            }
            fn dec(j: &J) -> R<Self> {
                <$t>::try_from(j.as_u64()?).map_err(|_| "integer out of range".into())
            }
        }
    )*};
}
small_uint!(u8, u32);
impl Elem for u32 {}

impl Codec for bool {
    fn enc(&self) -> J {
        J::Bool(*self)
    }
    fn dec(j: &J) -> R<Self> {
        j.as_bool()
    }
}
impl Elem for bool {}

impl Codec for String {
    fn enc(&self) -> J {
        J::Str(self.clone())
    }
    fn dec(j: &J) -> R<Self> {
        Ok(j.as_str()?.to_owned())
    }
}
impl Elem for String {}

impl Codec for () {
    fn enc(&self) -> J {
        J::Null
    }
    fn dec(j: &J) -> R<Self> {
        match j {
            J::Null => Ok(()),
            _ => Err("expected null".into()),
        }
    }
}
impl Elem for () {}

impl Codec for Vec<u8> {
    fn enc(&self) -> J {
        J::Str(hex(self))
    }
    fn dec(j: &J) -> R<Self> {
        unhex(j.as_str()?)
    }
}
impl Elem for Vec<u8> {}

impl Codec for [u8; 32] {
    fn enc(&self) -> J {
        J::Str(hex(self))
    }
    fn dec(j: &J) -> R<Self> {
        unhex(j.as_str()?)?
            .try_into()
            .map_err(|_| "expected 32 bytes".into())
    }
}
impl Elem for [u8; 32] {}

impl<T: Elem> Codec for Vec<T> {
    fn enc(&self) -> J {
        J::Arr(self.iter().map(Codec::enc).collect())
    }
    fn dec(j: &J) -> R<Self> {
        j.as_arr()?.iter().map(T::dec).collect()
    }
}
impl<T: Elem> Elem for Vec<T> {}

impl<T: Codec + Ord> Codec for BTreeSet<T> {
    fn enc(&self) -> J {
        J::Arr(self.iter().map(Codec::enc).collect())
    }
    fn dec(j: &J) -> R<Self> {
        j.as_arr()?.iter().map(T::dec).collect()
    }
}
impl<T: Codec + Ord> Elem for BTreeSet<T> {}

impl<K: Codec + Ord, V: Codec> Codec for BTreeMap<K, V> {
    fn enc(&self) -> J {
        J::Arr(
            self.iter()
                .map(|(k, v)| J::Arr(vec![k.enc(), v.enc()]))
                .collect(),
        )
    }
    fn dec(j: &J) -> R<Self> {
        j.as_arr()?
            .iter()
            .map(|p| match p.as_arr()? {
                [k, v] => Ok((K::dec(k)?, V::dec(v)?)),
                _ => Err("expected a pair".into()),
            })
            .collect()
    }
}

/// `null` or the value: no record nests an option directly in an option, and no value
/// written as `null` (`()`) is ever optional.
impl<T: Codec> Codec for Option<T> {
    fn enc(&self) -> J {
        match self {
            None => J::Null,
            Some(v) => v.enc(),
        }
    }
    fn dec(j: &J) -> R<Self> {
        match j {
            J::Null => Ok(None),
            j => Ok(Some(T::dec(j)?)),
        }
    }
}
impl<T: Codec> Elem for Option<T> {}

impl<A: Codec, B: Codec> Codec for (A, B) {
    fn enc(&self) -> J {
        J::Arr(vec![self.0.enc(), self.1.enc()])
    }
    fn dec(j: &J) -> R<Self> {
        match j.as_arr()? {
            [a, b] => Ok((A::dec(a)?, B::dec(b)?)),
            _ => Err("expected a pair".into()),
        }
    }
}
impl<A: Codec, B: Codec> Elem for (A, B) {}

impl<A: Codec, B: Codec, C: Codec> Codec for (A, B, C) {
    fn enc(&self) -> J {
        J::Arr(vec![self.0.enc(), self.1.enc(), self.2.enc()])
    }
    fn dec(j: &J) -> R<Self> {
        match j.as_arr()? {
            [a, b, c] => Ok((A::dec(a)?, B::dec(b)?, C::dec(c)?)),
            _ => Err("expected a triple".into()),
        }
    }
}
impl<A: Codec, B: Codec, C: Codec> Elem for (A, B, C) {}

impl Codec for [Lane; 4] {
    fn enc(&self) -> J {
        J::Arr(self.iter().map(Codec::enc).collect())
    }
    fn dec(j: &J) -> R<Self> {
        let v: Vec<Lane> = j.as_arr()?.iter().map(Lane::dec).collect::<R<_>>()?;
        v.try_into().map_err(|_| "expected 4 lanes".into())
    }
}

// ── Identifiers ──────────────────────────────────────────────────────────────

macro_rules! ids {
    ($($t:ident),*) => {$(
        impl Codec for $t {
            fn enc(&self) -> J {
                J::Str(hex(self.as_bytes()))
            }
            fn dec(j: &J) -> R<Self> {
                $t::from_slice(&unhex(j.as_str()?)?).map_err(|e| e.to_string())
            }
        }
        impl Elem for $t {}
    )*};
}
ids!(
    ChatId,
    RefChatId,
    EventId,
    GossipId,
    SyncObjId,
    ScanId,
    RequestId,
    ParentCommitment,
    LeaveId,
    KickId,
    DissolveId
);

// ── Records ──────────────────────────────────────────────────────────────────

/// A struct with named public fields, every one listed (a missing one does not compile).
macro_rules! record {
    ($t:ident { $($f:ident),* $(,)? }) => {
        impl Codec for $t {
            fn enc(&self) -> J {
                J::Obj(vec![$((stringify!($f).to_owned(), self.$f.enc())),*])
            }
            fn dec(j: &J) -> R<Self> {
                let _ = j;
                Ok($t { $($f: Codec::dec(j.field(stringify!($f))?)
                    .map_err(|e| format!("{}.{}: {e}", stringify!($t), stringify!($f)))?),* })
            }
        }
        impl Elem for $t {}
    };
}

/// An enum, written `"Variant"` for a unit variant and `{"t": "Variant", field: …}`
/// otherwise; a tuple variant names its fields with the bindings given, `Variant(name)`.
macro_rules! variants {
    ($t:ident { $($body:tt)* }) => {
        variants!(@go $t j [] [] $($body)*);
    };
    (@go $t:ident $j:ident [$($enc:tt)*] [$($dec:tt)*] $v:ident ( $($b:ident),* ) $(, $($rest:tt)*)?) => {
        variants!(@go $t $j
            [$($enc)* $t::$v($($b),*) => J::Obj(vec![
                ("t".to_owned(), J::Str(stringify!($v).to_owned())),
                $((stringify!($b).to_owned(), $b.enc())),*
            ]),]
            [$($dec)* stringify!($v) => $t::$v($(Codec::dec($j.field(stringify!($b))?)?),*),]
            $($($rest)*)?);
    };
    (@go $t:ident $j:ident [$($enc:tt)*] [$($dec:tt)*] $v:ident { $($f:ident),* } $(, $($rest:tt)*)?) => {
        variants!(@go $t $j
            [$($enc)* $t::$v { $($f),* } => J::Obj(vec![
                ("t".to_owned(), J::Str(stringify!($v).to_owned())),
                $((stringify!($f).to_owned(), $f.enc())),*
            ]),]
            [$($dec)* stringify!($v) => $t::$v { $($f: Codec::dec($j.field(stringify!($f))?)?),* },]
            $($($rest)*)?);
    };
    (@go $t:ident $j:ident [$($enc:tt)*] [$($dec:tt)*] $v:ident $(, $($rest:tt)*)?) => {
        variants!(@go $t $j
            [$($enc)* $t::$v => J::Str(stringify!($v).to_owned()),]
            [$($dec)* stringify!($v) => $t::$v,]
            $($($rest)*)?);
    };
    (@go $t:ident $j:ident [$($enc:tt)*] [$($dec:tt)*]) => {
        impl Codec for $t {
            #[allow(unused_variables)]
            fn enc(&self) -> J {
                match self { $($enc)* }
            }
            fn dec($j: &J) -> R<Self> {
                let tag = match $j {
                    J::Str(s) => s.as_str(),
                    _ => $j.field("t")?.as_str()?,
                };
                Ok(match tag {
                    $($dec)*
                    other => return Err(format!("unknown {} variant {other}", stringify!($t))),
                })
            }
        }
        impl Elem for $t {}
    };
}

// Retrieval.
variants!(Target {
    Event(id), SyncObj(id), Root, Parent(commitment), Object(kind, id), Removal(member), Keys(member)
});
record!(TaskKey { chat_id, target });
variants!(TriggerKind {
    Notice,
    Child,
    Page
});
record!(Trigger { kind, at });
variants!(CandidateState {
    Untried,
    NotAvailable,
    Failed
});
record!(Candidate {
    trigger,
    state,
    outstanding_until,
    attempts,
    busy,
    unavailable
});
variants!(Attempt { Queued { peer }, Sent { peer, local_deadline, sent_at } });
variants!(Run { Active { stage, ttl, jitter, attempt, expired_resends }, Paused });
record!(Task {
    run,
    candidates,
    runs,
    created_at
});

// Scans and requests.
variants!(ScanAttempt { Queued, Sent { local_deadline, sent_at }, Waiting { until } });
record!(ScanOp {
    scan_id,
    offset,
    total,
    stage,
    ttl,
    jitter,
    attempt,
    restarts,
    expired_resends,
    busy,
    lanes
});
variants!(EntryItem { Event(id), Root, Leave(id), Kick(id), Dissolve(id) });
record!(Entry { chat_id, item });
record!(FrozenScan {
    list,
    live_until,
    forget_at
});
variants!(Purpose { Task(key), Scan(chat) });
variants!(SignedKind {
    Leave,
    Kick,
    Dissolve
});
variants!(QueryOp {
    ChatById(chat),
    ChatByRef(reference),
    ChatByParent { chat_id, commitment },
    SharedChatsScan { scan_id, offset },
    Event { chat_id, event_id },
    SyncObj { chat_id, sync_obj_id },
    SignedObject { chat_id, kind, id },
    Removal { chat_id, gossip_id },
    TipsScan { anchor, scan_id, offset },
    Keys { chat_id, gossip_id }
});
record!(RefEntry {
    purpose,
    op,
    answered
});
record!(RequestRef {
    sent_at,
    ttl,
    entries
});

// Neighbors, peers, hints, work.
record!(Lane {
    earliest,
    due,
    active,
    moved
});
record!(GroupSync {
    neighbors,
    asked,
    cooldown,
    suggested,
    lanes,
    cursor,
    cycle,
    first_online
});
record!(Bucket { level, at });
record!(PeerRecord {
    supplied,
    penalty,
    failures,
    unanswered_ms,
    last_failure,
    last_timeout_query,
    requests,
    responses,
    version_notices,
    version,
    failed_announcements,
    paused_until,
    pause_ms
});
record!(Hint { first, used });
variants!(Status {
    NotAvailable,
    Restart,
    Expired,
    Malformed,
    Unsupported,
    Busy
});
variants!(AnswerOp {
    Event { chat_id, event_id },
    SyncObj { chat_id, sync_obj_id },
    Page { anchor, scan_id, offset },
    Status(status),
    Root { chat_id },
    Object { chat_id, item },
    Keys { gossip_id }
});
variants!(Work {
    Full { chat_id, event_id },
    Notice { chat_id, event_id },
    Query { purpose },
    Answer { request_id, idx, sent_at, ttl, op },
    NeighborRequest { chat_id },
    NeighborResponse { chat_id, accepted, suggestions },
    VersionNotice,
    Object { chat_id, item },
    ObjectNotice { chat_id, item },
    Blob(blob),
    LeaveRequest { chat_id }
});
record!(Meta { next_seq });
variants!(LookupResult { Found(event_id), NotFound });

// Groups, epochs and signed objects.
variants!(GroupState {
    Active,
    ReadOnlyAfterKick,
    Waiting,
    Dissolved
});
record!(Invitation {
    received_at,
    lookups,
    not_available,
    closed_before,
    rejoins
});
variants!(EpochStatus { Installed, Invitation(invitation) });
record!(EpochRecord {
    root,
    status,
    group,
    parents,
    line_time,
    received_at,
    from,
    removed_override,
    state_override
});
variants!(GroupStatus {
    Active,
    Removed { epoch, at },
    Left { epoch, at },
    Waiting { since, last_request },
    Dissolved { epoch, must_delete, at }
});
record!(GroupRecord {
    status,
    followed,
    deposed,
    links,
    local_name,
    pending_removals,
    junctions
});
variants!(SignedObject { Leave(leave), Kick(kick), Dissolve(dissolve) });
record!(SignedRecord {
    object,
    received_at
});
variants!(Marker { Closed, Dissolved });
record!(ReplyCount { since, count, owed });
record!(PendingLeave { leave, from, at });
record!(HeldRoot { root, from, at });
variants!(ChangeKind {
    Invitation,
    Joined,
    Membership,
    Messages,
    ReadOnly,
    Fork,
    Closed
});

// Message state.
variants!(MessageType {
    Text,
    Forward,
    Reaction,
    Media,
    Delete
});
variants!(Body {
    Text(text), Forward { content_type, content }, Reaction(reaction), Media(media)
});
record!(Content {
    sync_obj_id,
    author,
    created_at,
    last_modified_at,
    body,
    edited,
    metadata
});
variants!(Role { Current, PendingVersion { due }, PendingDeletion { due } });
variants!(StoredResult { Content(content), Tombstone });
variants!(Payload { Content(content), Delete { sync_obj_id, scheduled_at } });

// What the bindings take and give.
variants!(GroupChange {
    Successor { add, remove, name },
    Handover { new_owner, leave, remove, name },
    Resolve { members, name }
});
variants!(LeaveChoice {
    Signed,
    AskToBeKicked,
    Silent
});
record!(LocalEdit {
    body,
    author,
    created_at,
    last_modified_at,
    metadata,
    edited
});
variants!(Merge {
    Won,
    Lost,
    Identical,
    Pending
});
variants!(MyStatus { Member, Waiting, Left, Removed, Dissolved { deleted } });
record!(GroupSummary {
    group,
    current,
    name,
    local_name,
    members,
    owner,
    status,
    side_branches,
    must_resolve,
    links
});
record!(InvitationSummary {
    chat_id,
    name,
    members,
    owner,
    received_from,
    closed_before,
    rejoins
});
variants!(TimelineLine {
    Founded { epoch, owner },
    EpochChange { epoch, owner, added, removed, left, renamed, new_owner },
    YouWereRemoved,
    YouLeft,
    Dissolved,
    NotAMember { from, to }
});
record!(VisibleMessage {
    chat_id,
    content,
    result_hash
});
variants!(TimelineItem { Message(message), Line { at, line } });
record!(Change { group, kind });

// ── Objects kept as the device's own encoding ────────────────────────────────

fn enc_object(object: EventObject) -> J {
    // A held object was decoded or built under the limits, so it encodes again.
    J::Str(hex(
        &wire::encode_event_blob(&object).expect("a held object encodes")
    ))
}

fn dec_object(j: &J) -> R<EventObject> {
    wire::decode_event_blob(&unhex(j.as_str()?)?, groups::constants::PROTOCOL_VERSION)
        .map_err(|e| e.to_string())
}

impl Codec for Root {
    fn enc(&self) -> J {
        enc_object(EventObject::Root(Box::new(self.clone())))
    }
    fn dec(j: &J) -> R<Self> {
        match dec_object(j)? {
            EventObject::Root(r) => Ok(*r),
            _ => Err("expected a root".into()),
        }
    }
}

macro_rules! signed {
    ($($t:ident),*) => {$(
        impl Codec for $t {
            fn enc(&self) -> J {
                enc_object(EventObject::$t(self.clone()))
            }
            fn dec(j: &J) -> R<Self> {
                match dec_object(j)? {
                    EventObject::$t(o) => Ok(o),
                    _ => Err(concat!("expected a ", stringify!($t)).into()),
                }
            }
        }
    )*};
}
signed!(Leave, Kick, Dissolve);

#[cfg(test)]
mod tests {
    use super::*;

    fn round_trip<T: Codec + PartialEq + std::fmt::Debug>(v: T) {
        let text = v.enc().to_text();
        let back = T::dec(&J::parse(&text).unwrap()).unwrap();
        assert_eq!(back, v, "{text}");
    }

    #[test]
    fn hex_round_trips_and_refuses_uppercase() {
        assert_eq!(
            unhex(&hex(&[0, 1, 0xab, 0xff])).unwrap(),
            vec![0, 1, 0xab, 0xff]
        );
        assert!(unhex("AB").is_err());
        assert!(unhex("abc").is_err());
    }

    #[test]
    fn records_round_trip() {
        let chat = ChatId::from_bytes([7; 32]);
        let peer = GossipId::from_bytes([9; 32]);
        round_trip(TaskKey {
            chat_id: chat,
            target: Target::Object(SignedKind::Kick, [3; 32]),
        });
        round_trip(Run::Active {
            stage: 2,
            ttl: u64::MAX,
            jitter: 5,
            attempt: Some(Attempt::Sent {
                peer,
                local_deadline: 1,
                sent_at: 2,
            }),
            expired_resends: 0,
        });
        round_trip(Work::Answer {
            request_id: RequestId::from_bytes([1; groups::constants::REQUEST_ID_SIZE]),
            idx: 3,
            sent_at: 4,
            ttl: 5,
            op: AnswerOp::Status(Status::Busy),
        });
        round_trip(Work::Blob(vec![1, 2, 3]));
        round_trip(Work::VersionNotice);
        round_trip(GroupRecord {
            status: GroupStatus::Dissolved {
                epoch: chat,
                must_delete: true,
                at: 3,
            },
            followed: Some(peer),
            deposed: BTreeSet::from([peer]),
            links: BTreeSet::new(),
            local_name: Some("ü \"x\"".into()),
            pending_removals: BTreeMap::from([(peer, 4)]),
            junctions: vec![(1, 2)],
        });
        round_trip(StoredResult::Content(Content {
            sync_obj_id: SyncObjId::from_bytes([4; 32]),
            author: peer,
            created_at: 1,
            last_modified_at: 2,
            body: Body::Forward {
                content_type: MessageType::Text,
                content: b"hi".to_vec(),
            },
            edited: true,
            metadata: BTreeMap::from([("k".to_owned(), vec![0xff])]),
        }));
        round_trip(Some(3u64));
        round_trip(None::<u64>);
    }
}
