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
    AnswerOp, Attempt, Backoff, Candidate, CandidateState, ChangeKind, EpochRecord, EpochStatus,
    FrozenScan, GroupRecord, GroupStatus, GroupSync, HeldRoot, Hint, Invitation, Junction,
    JunctionKind, Lane, Marker, MarkerKind, Meta, PeerRecord, PendingLeave, Purpose, RefEntry,
    RefLookup, RefReply, ReplyCount, RequestRef, Run, ScanAttempt, ScanOp, SignedObject,
    SignedRecord, Target, Task, TaskKey, Trigger, TriggerKind, Work,
};
use groups::node::timing::Bucket;
use groups::node::{
    Change, EpochTimer, GroupChange, GroupSummary, InvitationSummary, LeaveChoice, LookupResult,
    MyStatus, TimelineItem, TimelineLine,
};
use groups::store::{Role, StoredResult};
use groups::wire::{Entry, EntryItem, QueryOp, SignedKind, Status};
use groups::{
    Body, Challenge, ChatId, Content, Dissolve, DissolveId, EventId, GossipId, GroupSecret,
    GroupState, Kick, KickId, Leave, LeaveId, LocalEdit, Media, Merge, MessageType, MetadataPatch,
    ParentCommitment, Payload, Reaction, ReactionAction, RefChatId, RequestId, Root, RootType,
    ScanId, SyncObjId,
};

use groups::ReplyTarget;

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
small_uint!(u8, u16, u32);
impl Elem for u16 {}
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
    DissolveId,
    Challenge
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
    Event(id), SyncObj(id), Root, Parent(commitment), Object(kind, id), Removal(member), Keys(member),
    Ref(reference)
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
record!(Backoff {
    since,
    until,
    wait_ms,
    window
});
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
    Dissolved,
    Superseded
});
record!(Invitation {
    received_at,
    lookups,
    not_available,
    closed_before,
    rejoins,
    fetched_for
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
    Dissolved { epoch, must_delete, at },
    Superseded { by, at }
});
record!(GroupRecord {
    status,
    followed,
    deposed,
    links,
    local_name,
    pending_removals,
    junctions,
    took_part,
    earlier
});
record!(Junction { from, to, kind });
variants!(JunctionKind {
    Removed,
    Left,
    Dissolved
});
variants!(SignedObject { Leave(leave), Kick(kick), Dissolve(dissolve) });
record!(SignedRecord {
    object,
    received_at
});
variants!(MarkerKind { Closed, ClosedFrom(peer), Dissolved });
/// A marker: `{"kind": …, "reference": hex | null}`. A marker stored before the reference was
/// kept is its kind alone (`"Closed"`, `{"t": "ClosedFrom", …}`, `"Dissolved"`): it is read
/// with no reference and stays valid.
impl Codec for Marker {
    fn enc(&self) -> J {
        J::Obj(vec![
            ("kind".to_owned(), self.kind.enc()),
            ("reference".to_owned(), self.reference.enc()),
        ])
    }
    fn dec(j: &J) -> R<Self> {
        if matches!(j, J::Str(_)) || j.field("t").is_ok() {
            return Ok(Marker {
                kind: Codec::dec(j)?,
                reference: None,
            });
        }
        Ok(Marker {
            kind: Codec::dec(j.field("kind")?)?,
            reference: Codec::dec(j.field("reference")?)?,
        })
    }
}
impl Elem for Marker {}
record!(ReplyCount { since, count, owed });
record!(PendingLeave { leave, from, at });
record!(HeldRoot { root, from, at });
record!(RefReply { from, author, at });
record!(RefLookup {
    replies,
    rounds,
    last_round,
    round,
    asked,
    due
});
variants!(ChangeKind {
    Invitation,
    Joined,
    Membership,
    Messages,
    ReadOnly,
    Fork,
    Closed,
    Superseded { by, has_messages },
    Connections
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
variants!(ReactionAction { Add, Remove });
record!(Reaction {
    target,
    emoji,
    action
});
record!(Media { mimetype, data });
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
    Handover { new_owner, leave, name },
    MessageTimer { timer },
    Resolve { members, name }
});
variants!(LeaveChoice {
    Signed,
    AskToBeKicked,
    Silent
});
/// A metadata patch: `{"set": [[name, hex], …], "remove": [name, …]}` (either may be
/// absent). `null` keeps everything, and a bare list of `[name, hex]` pairs, the earlier form,
/// sets those entries and keeps the others: an edit never drops metadata it does not name.
impl Codec for MetadataPatch {
    fn enc(&self) -> J {
        J::Obj(vec![
            ("set".to_owned(), self.set.enc()),
            ("remove".to_owned(), self.remove.enc()),
        ])
    }
    fn dec(j: &J) -> R<Self> {
        Ok(match j {
            J::Null => MetadataPatch::default(),
            J::Arr(_) => MetadataPatch {
                set: Codec::dec(j)?,
                remove: BTreeSet::new(),
            },
            _ => MetadataPatch {
                set: match j.field("set") {
                    Ok(v) => Codec::dec(v)?,
                    Err(_) => BTreeMap::new(),
                },
                remove: match j.field("remove") {
                    Ok(v) => Codec::dec(v)?,
                    Err(_) => BTreeSet::new(),
                },
            },
        })
    }
}

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
variants!(MyStatus { Member, Waiting, Left, Removed, Dissolved { deleted }, Superseded { by } });
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
    former_owner_branches,
    links,
    earlier,
    took_part,
    message_timer,
    timers
});
record!(EpochTimer {
    epoch,
    message_timer,
    started_at
});
record!(InvitationSummary {
    chat_id,
    name,
    members,
    owner,
    received_from,
    closed_before,
    rejoins,
    migrate_from,
    migration_of,
    continues,
    message_timer,
    announced_timer
});
variants!(TimelineLine {
    Founded { epoch, owner },
    Joined { epoch, by },
    EpochChange { epoch, by, added, removed, left, renamed, new_owner },
    YouWereRemoved,
    YouLeft,
    Dissolved,
    NotAMember { from, to },
    AddedBack { epoch, by }
});
record!(VisibleMessage {
    chat_id,
    content,
    result_hash,
    reactions,
    data_len
});
variants!(TimelineItem { Message(message), Line { at, line } });
record!(Change { group, kind });
record!(ReplyTarget {
    ref_chat_id,
    sync_obj_id
});

// ── Roots and signed objects, by their fields ────────────────────────────────

impl Codec for GroupSecret {
    fn enc(&self) -> J {
        J::Str(hex(self.as_bytes()))
    }
    fn dec(j: &J) -> R<Self> {
        GroupSecret::from_slice(&unhex(j.as_str()?)?).map_err(|e| e.to_string())
    }
}

variants!(RootType {
    Successor,
    Handover
});

fn field<T: Codec>(j: &J, name: &str) -> R<T> {
    T::dec(j.field(name)?).map_err(|e| format!("{name}: {e}"))
}

fn sig(j: &J) -> R<Vec<u8>> {
    unhex(j.field("signature")?.as_str()?)
}

/// A root, stored by its version, fields and signature (§14.1), rebuilt with
/// [`Root::from_fields`], which checks it as a received root is checked.
impl Codec for Root {
    fn enc(&self) -> J {
        J::Obj(vec![
            ("version".into(), J::Num(self.version())),
            ("root_type".into(), self.root_type().enc()),
            ("name".into(), J::Str(self.name().to_owned())),
            ("parents".into(), self.parents().to_vec().enc()),
            ("members".into(), self.members().to_vec().enc()),
            ("group_secret".into(), self.group_secret().enc()),
            ("owner".into(), J::Str(hex(self.owner_bytes()))),
            ("epoch_challenge".into(), self.epoch_challenge().enc()),
            (
                "ref_chat_id_challenge".into(),
                self.ref_chat_id_challenge().enc(),
            ),
            ("created_at".into(), J::Num(self.created_at())),
            ("migrate_from".into(), self.migrate_from().enc()),
            ("message_timer".into(), J::Num(self.message_timer())),
            (
                "settings".into(),
                J::Arr(
                    self.settings()
                        .iter()
                        .map(|(k, v)| J::Arr(vec![J::Str(k.clone()), J::Str(hex(v))]))
                        .collect(),
                ),
            ),
            ("signature".into(), J::Str(hex(self.signature().as_bytes()))),
        ])
    }
    fn dec(j: &J) -> R<Self> {
        let parents: Vec<ParentCommitment> = field(j, "parents")?;
        let members: Vec<GossipId> = field(j, "members")?;
        Root::from_fields(
            j.field("version")?.as_u64()?,
            field(j, "root_type")?,
            field(j, "name")?,
            &parents,
            &members,
            &field::<GroupSecret>(j, "group_secret")?,
            unhex(j.field("owner")?.as_str()?)?,
            &field::<Challenge>(j, "epoch_challenge")?,
            &field::<Challenge>(j, "ref_chat_id_challenge")?,
            j.field("created_at")?.as_u64()?,
            // Absent from a root stored before the field existed.
            match j.field("migrate_from") {
                Ok(v) => Codec::dec(v)?,
                Err(_) => None,
            },
            // Absent from a root stored before the fields existed, which had neither.
            match j.field("message_timer") {
                Ok(v) => v.as_u64()?,
                Err(_) => 0,
            },
            &match j.field("settings") {
                Ok(v) => settings(v)?,
                Err(_) => std::collections::BTreeMap::new(),
            },
            &sig(j)?,
        )
        .map_err(|e| format!("root: {e}"))
    }
}

/// The settings map of a root, stored as `[[key, hex], …]` in key order (§4.1).
fn settings(j: &J) -> R<std::collections::BTreeMap<String, Vec<u8>>> {
    let mut out = std::collections::BTreeMap::new();
    for e in j.as_arr()? {
        let pair = e.as_arr()?;
        let [k, v] = pair else {
            return Err("settings: expected [key, hex]".into());
        };
        if out
            .insert(k.as_str()?.to_owned(), unhex(v.as_str()?)?)
            .is_some()
        {
            return Err("settings: a key given twice".into());
        }
    }
    Ok(out)
}

impl Codec for Leave {
    fn enc(&self) -> J {
        J::Obj(vec![
            ("chat_id".into(), self.chat_id().enc()),
            ("leaver".into(), self.leaver().enc()),
            ("signature".into(), J::Str(hex(self.signature().as_bytes()))),
        ])
    }
    fn dec(j: &J) -> R<Self> {
        Leave::from_fields(field(j, "chat_id")?, field(j, "leaver")?, &sig(j)?)
            .map_err(|e| format!("leave: {e}"))
    }
}

impl Codec for Kick {
    fn enc(&self) -> J {
        J::Obj(vec![
            ("chat_id".into(), self.chat_id().enc()),
            ("removed".into(), self.removed().enc()),
            ("signature".into(), J::Str(hex(self.signature().as_bytes()))),
        ])
    }
    fn dec(j: &J) -> R<Self> {
        Kick::from_fields(field(j, "chat_id")?, field(j, "removed")?, &sig(j)?)
            .map_err(|e| format!("kick: {e}"))
    }
}

impl Codec for Dissolve {
    fn enc(&self) -> J {
        J::Obj(vec![
            ("chat_id".into(), self.chat_id().enc()),
            ("must_delete".into(), J::Bool(self.must_delete())),
            ("signature".into(), J::Str(hex(self.signature().as_bytes()))),
        ])
    }
    fn dec(j: &J) -> R<Self> {
        Dissolve::from_fields(field(j, "chat_id")?, field(j, "must_delete")?, &sig(j)?)
            .map_err(|e| format!("dissolve: {e}"))
    }
}

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
            junctions: vec![
                Junction {
                    from: 1,
                    to: 2,
                    kind: JunctionKind::Removed,
                },
                Junction {
                    from: 3,
                    to: 4,
                    kind: JunctionKind::Left,
                },
                Junction {
                    from: 5,
                    to: 6,
                    kind: JunctionKind::Dissolved,
                },
            ],
            took_part: true,
            earlier: vec![chat],
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
    }

    /// A root is stored with `migrate_from`, present or absent, and a root stored before the
    /// field existed reads as one without it.
    #[test]
    fn roots_round_trip_with_and_without_migrate_from() {
        let seed = auth::StaticRootSecret::from_passphrase(b"codec root");
        let (public, secret) = auth::derive_keys_from_static_root_secret(&seed);
        let (_, me) = groups::parse_user_public_keys(&public.to_bytes()).unwrap();
        let other = GossipId::from_bytes([9; 32]);
        let signer = groups::KeySigner {
            public: public.clone(),
            signing_key: &secret.dsa_signing_key,
        };
        let make = |migrate_from| {
            Root::create_founding(
                groups::RootParams {
                    name: "n".into(),
                    members: vec![me, other],
                    group_secret: GroupSecret::from_bytes([1; 32]),
                    owner: public.clone(),
                    epoch_challenge: Challenge::from_bytes([2; 32]),
                    ref_chat_id_challenge: Challenge::from_bytes([3; 32]),
                    created_at: 4,
                    message_timer: 0,
                    settings: std::collections::BTreeMap::new(),
                },
                ChatId::from_bytes([5; 32]),
                migrate_from,
                &signer,
                [6; 32],
            )
            .unwrap()
        };
        for m in [None, Some(0), Some(u64::MAX)] {
            let root = make(m);
            round_trip(root.clone());
            assert_eq!(Root::dec(&root.enc()).unwrap().migrate_from(), m);
        }
        // With a timer and settings, unknown keys included (§4.1).
        let mut p = groups::RootParams {
            name: "n".into(),
            members: vec![me, other],
            group_secret: GroupSecret::from_bytes([1; 32]),
            owner: public.clone(),
            epoch_challenge: Challenge::from_bytes([2; 32]),
            ref_chat_id_challenge: Challenge::from_bytes([3; 32]),
            created_at: 4,
            message_timer: 0,
            settings: std::collections::BTreeMap::new(),
        };
        p.message_timer = u64::MAX;
        p.settings = std::collections::BTreeMap::from([
            ("a".to_owned(), vec![]),
            ("later.key".to_owned(), vec![0, 0xff]),
        ]);
        let timed =
            Root::create_founding(p, ChatId::from_bytes([5; 32]), None, &signer, [6; 32]).unwrap();
        round_trip(timed.clone());
        let back = Root::dec(&timed.enc()).unwrap();
        assert_eq!(back.chat_id(), timed.chat_id());
        assert_eq!(back.settings(), timed.settings());
        let root = make(None);
        let J::Obj(fields) = root.enc() else { panic!() };
        let old = J::Obj(
            fields
                .into_iter()
                .filter(|(k, _)| k != "migrate_from")
                .collect(),
        );
        assert_eq!(Root::dec(&old).unwrap(), root);
    }

    /// One value of every record kind stored in the node tables and the epochs' records,
    /// with every variant of their enums. (Roots and signed objects, kept as the device's
    /// own encoding, are covered by the reopen tests of `tests.rs`.)
    #[test]
    fn every_record_kind_round_trips() {
        let chat = ChatId::from_bytes([1; 32]);
        let peer = GossipId::from_bytes([2; 32]);
        let event = EventId::from_bytes([3; groups::constants::EVENT_ID_SIZE]);
        let sync = SyncObjId::from_bytes([4; 32]);
        let scan = ScanId::from_bytes([5; 32]);
        let request = RequestId::from_bytes([6; groups::constants::REQUEST_ID_SIZE]);
        let commitment = ParentCommitment::from_bytes([7; 32]);
        let items = [
            EntryItem::Event(event),
            EntryItem::Root,
            EntryItem::Leave(LeaveId::from_bytes([8; 32])),
            EntryItem::Kick(KickId::from_bytes([9; 32])),
            EntryItem::Dissolve(DissolveId::from_bytes([10; 32])),
        ];
        for target in [
            Target::Event(event),
            Target::SyncObj(sync),
            Target::Root,
            Target::Parent(commitment),
            Target::Object(SignedKind::Leave, [1; 32]),
            Target::Object(SignedKind::Dissolve, [1; 32]),
            Target::Removal(peer),
            Target::Keys(peer),
            Target::Ref(RefChatId::from_bytes([13; 32])),
        ] {
            round_trip(TaskKey {
                chat_id: chat,
                target,
            });
        }
        for (trigger, state) in [
            (
                Some(Trigger {
                    kind: TriggerKind::Notice,
                    at: 1,
                }),
                CandidateState::Untried,
            ),
            (
                Some(Trigger {
                    kind: TriggerKind::Child,
                    at: 2,
                }),
                CandidateState::NotAvailable,
            ),
            (
                Some(Trigger {
                    kind: TriggerKind::Page,
                    at: 3,
                }),
                CandidateState::Failed,
            ),
            (None, CandidateState::Untried),
        ] {
            for run in [
                Run::Paused,
                Run::Active {
                    stage: 1,
                    ttl: 2,
                    jitter: 3,
                    attempt: Some(Attempt::Queued { peer }),
                    expired_resends: 4,
                },
                Run::Active {
                    stage: 0,
                    ttl: 0,
                    jitter: 0,
                    attempt: None,
                    expired_resends: 0,
                },
            ] {
                round_trip(Task {
                    run,
                    candidates: BTreeMap::from([(
                        peer,
                        Candidate {
                            trigger,
                            state,
                            outstanding_until: Some(9),
                            attempts: 1,
                            busy: 2,
                            unavailable: 3,
                        },
                    )]),
                    runs: 5,
                    created_at: u64::MAX,
                });
            }
        }
        for attempt in [
            ScanAttempt::Queued,
            ScanAttempt::Sent {
                local_deadline: 1,
                sent_at: 2,
            },
            ScanAttempt::Waiting { until: 3 },
        ] {
            round_trip(ScanOp {
                scan_id: scan,
                offset: 1,
                total: Some(2),
                stage: 3,
                ttl: 4,
                jitter: 5,
                attempt,
                restarts: 6,
                expired_resends: 7,
                busy: 8,
                lanes: BTreeSet::from([0, 3]),
            });
        }
        round_trip(FrozenScan {
            list: Some(
                items
                    .iter()
                    .map(|&item| Entry {
                        chat_id: chat,
                        item,
                    })
                    .collect(),
            ),
            live_until: 1,
            forget_at: 2,
        });
        round_trip(FrozenScan {
            list: None,
            live_until: 0,
            forget_at: 0,
        });
        let ops = vec![
            QueryOp::ChatById(chat),
            QueryOp::ChatByRef(RefChatId::from_bytes([11; 32])),
            QueryOp::ChatByParent {
                chat_id: chat,
                commitment,
            },
            QueryOp::SharedChatsScan {
                scan_id: scan,
                offset: 1,
            },
            QueryOp::Event {
                chat_id: chat,
                event_id: event,
            },
            QueryOp::SyncObj {
                chat_id: chat,
                sync_obj_id: sync,
            },
            QueryOp::SignedObject {
                chat_id: chat,
                kind: SignedKind::Kick,
                id: [2; 32],
            },
            QueryOp::Removal {
                chat_id: chat,
                gossip_id: peer,
            },
            QueryOp::TipsScan {
                anchor: chat,
                scan_id: scan,
                offset: 2,
            },
            QueryOp::Keys {
                chat_id: chat,
                gossip_id: peer,
            },
        ];
        round_trip(RequestRef {
            sent_at: 1,
            ttl: 2,
            entries: ops
                .into_iter()
                .enumerate()
                .map(|(i, op)| RefEntry {
                    purpose: if i % 2 == 0 {
                        Purpose::Task(TaskKey {
                            chat_id: chat,
                            target: Target::Root,
                        })
                    } else {
                        Purpose::Scan(chat)
                    },
                    op,
                    answered: i % 3 == 0,
                })
                .collect(),
        });
        let lane = Lane {
            earliest: 1,
            due: Some(2),
            active: Some(peer),
            moved: true,
        };
        round_trip(GroupSync {
            neighbors: BTreeSet::from([peer]),
            asked: BTreeMap::from([(peer, 1)]),
            cooldown: BTreeMap::from([(peer, 2)]),
            suggested: BTreeSet::from([peer]),
            lanes: [lane, Lane::default(), lane, Lane::default()],
            cursor: 3,
            cycle: vec![peer],
            first_online: Some(4),
        });
        round_trip(PeerRecord {
            supplied: 1,
            penalty: 2,
            failures: 3,
            unanswered_ms: 4,
            last_failure: 5,
            last_timeout_query: 6,
            requests: Bucket { level: 7, at: 8 },
            responses: Bucket { level: 9, at: 10 },
            version_notices: BTreeMap::from([(2, 3)]),
            version: Some(1),
            failed_announcements: vec![1, 2],
            paused_until: 11,
            pause_ms: 12,
        });
        round_trip(Hint { first: 1, used: 2 });
        let mut works = vec![
            Work::Full {
                chat_id: chat,
                event_id: event,
            },
            Work::Notice {
                chat_id: chat,
                event_id: event,
            },
            Work::Query {
                purpose: Purpose::Scan(chat),
            },
            Work::NeighborRequest { chat_id: chat },
            Work::NeighborResponse {
                chat_id: chat,
                accepted: true,
                suggestions: vec![peer],
            },
            Work::VersionNotice,
            Work::Object {
                chat_id: chat,
                item: EntryItem::Root,
            },
            Work::ObjectNotice {
                chat_id: chat,
                item: items[2],
            },
            Work::Blob(vec![1, 2]),
            Work::LeaveRequest { chat_id: chat },
        ];
        for op in [
            AnswerOp::Event {
                chat_id: chat,
                event_id: event,
            },
            AnswerOp::SyncObj {
                chat_id: chat,
                sync_obj_id: sync,
            },
            AnswerOp::Page {
                anchor: chat,
                scan_id: scan,
                offset: 3,
            },
            AnswerOp::Status(Status::NotAvailable),
            AnswerOp::Status(Status::Restart),
            AnswerOp::Status(Status::Expired),
            AnswerOp::Status(Status::Malformed),
            AnswerOp::Status(Status::Unsupported),
            AnswerOp::Root { chat_id: chat },
            AnswerOp::Object {
                chat_id: chat,
                item: items[4],
            },
            AnswerOp::Keys { gossip_id: peer },
        ] {
            works.push(Work::Answer {
                request_id: request,
                idx: 1,
                sent_at: 2,
                ttl: 3,
                op,
            });
        }
        for w in works {
            round_trip(w);
        }
        round_trip(Meta { next_seq: 7 });
        round_trip(LookupResult::Found(event));
        round_trip(LookupResult::NotFound);
        for state in [
            GroupState::Active,
            GroupState::ReadOnlyAfterKick,
            GroupState::Waiting,
            GroupState::Dissolved,
            GroupState::Superseded,
        ] {
            round_trip(Some(state));
        }
        round_trip(EpochStatus::Installed);
        round_trip(EpochStatus::Invitation(Invitation {
            received_at: 1,
            lookups: BTreeSet::from([commitment]),
            not_available: BTreeSet::from([peer]),
            closed_before: true,
            rejoins: Some(chat),
            fetched_for: Some((chat, u16::MAX)),
        }));
        round_trip(EpochStatus::Invitation(Invitation {
            received_at: 1,
            lookups: BTreeSet::new(),
            not_available: BTreeSet::new(),
            closed_before: false,
            rejoins: None,
            fetched_for: None,
        }));
        for status in [
            GroupStatus::Active,
            GroupStatus::Removed { epoch: chat, at: 1 },
            GroupStatus::Left { epoch: chat, at: 2 },
            GroupStatus::Waiting {
                since: 3,
                last_request: 4,
            },
            GroupStatus::Dissolved {
                epoch: chat,
                must_delete: false,
                at: 5,
            },
            GroupStatus::Superseded { by: chat, at: 6 },
        ] {
            round_trip(status);
        }
        let reference = RefChatId::from_bytes([16; 32]);
        for kind in [
            MarkerKind::Closed,
            MarkerKind::ClosedFrom(peer),
            MarkerKind::Dissolved,
        ] {
            round_trip(kind);
            for reference in [None, Some(reference)] {
                round_trip(Marker { kind, reference });
            }
            // A marker stored before the reference was kept: its kind alone, read with no
            // reference.
            assert_eq!(
                Marker::dec(&J::parse(&kind.enc().to_text()).unwrap()),
                Ok(Marker {
                    kind,
                    reference: None
                })
            );
        }
        // The key of an unverified leave: epoch, leaver, supplier.
        round_trip((chat, peer, GossipId::from_bytes([12; 32])));
        round_trip(ReplyCount {
            since: 1,
            count: 2,
            owed: true,
        });
        round_trip(Backoff {
            since: 1,
            until: 2,
            wait_ms: 3,
            window: 4,
        });
        // A reference named by replies (§7.6, §12.7), with its key.
        round_trip(RefChatId::from_bytes([13; 32]));
        for round in [None, Some(chat)] {
            round_trip(RefLookup {
                replies: BTreeMap::from([(
                    (chat, sync, SyncObjId::from_bytes([14; 32])),
                    RefReply {
                        from: peer,
                        author: GossipId::from_bytes([15; 32]),
                        at: 7,
                    },
                )]),
                rounds: 2,
                last_round: round.map(|_| 5),
                round,
                asked: vec![peer],
                due: 9,
            });
        }
        // The key of an earlier conversation (§5.12): peer and format version.
        round_trip((peer, 0u64));
        round_trip((peer, u64::MAX));
        for kind in [
            ChangeKind::Invitation,
            ChangeKind::Joined,
            ChangeKind::Membership,
            ChangeKind::Messages,
            ChangeKind::ReadOnly,
            ChangeKind::Fork,
            ChangeKind::Closed,
            ChangeKind::Superseded {
                by: chat,
                has_messages: true,
            },
            ChangeKind::Connections,
        ] {
            round_trip((chat, kind));
        }
        for role in [
            Role::Current,
            Role::PendingVersion { due: 1 },
            Role::PendingDeletion { due: 2 },
        ] {
            round_trip(role);
        }
        round_trip(StoredResult::Tombstone);
        for body in [
            Body::Text("t".into()),
            Body::Forward {
                content_type: MessageType::Media,
                content: Media {
                    mimetype: "image/png".into(),
                    data: vec![1],
                }
                .encode(),
            },
            Body::Reaction(Reaction {
                target: sync,
                emoji: "\u{1f44d}".into(),
                action: ReactionAction::Add,
            }),
            Body::Reaction(Reaction {
                target: sync,
                emoji: "x".into(),
                action: ReactionAction::Remove,
            }),
            Body::Media(Media {
                mimetype: "image/png".into(),
                data: vec![3],
            }),
            Body::Media(Media {
                mimetype: "text/vcard".into(),
                data: vec![],
            }),
        ] {
            round_trip(body);
        }
        round_trip(Payload::Delete {
            sync_obj_id: sync,
            scheduled_at: Some(5),
        });
        round_trip(Payload::Delete {
            sync_obj_id: sync,
            scheduled_at: None,
        });
        round_trip(None::<u64>);
    }

    /// A message of the timeline with its reactions and the length of its media data, and the
    /// JSON the SDK reads: `reactions` as `[[author, emoji], …]`, `data_len` a number or
    /// `null`, a reaction body as `{target, emoji, action}` and a media body as
    /// `{mimetype, data}`.
    #[test]
    fn a_timeline_message_carries_reactions_and_the_data_length() {
        let author = GossipId::from_bytes([2; 32]);
        let m = VisibleMessage {
            chat_id: ChatId::from_bytes([1; 32]),
            content: Content {
                sync_obj_id: SyncObjId::from_bytes([3; 32]),
                author,
                created_at: 1,
                last_modified_at: 1,
                body: Body::Media(Media {
                    mimetype: "image/png".into(),
                    data: vec![],
                }),
                edited: false,
                metadata: BTreeMap::new(),
            },
            result_hash: [4; 32],
            reactions: vec![(author, "\u{1f44d}".into())],
            data_len: Some(1_000),
        };
        round_trip(m.clone());
        round_trip(VisibleMessage {
            reactions: vec![],
            data_len: None,
            ..m.clone()
        });
        let j = m.enc();
        assert_eq!(
            j.field("reactions").unwrap().to_text(),
            format!("[[\"{}\",\"\u{1f44d}\"]]", hex(author.as_bytes()))
        );
        assert_eq!(j.field("data_len").unwrap().as_u64().unwrap(), 1_000);
        let body = j.field("content").unwrap().field("body").unwrap();
        assert_eq!(body.field("t").unwrap().as_str().unwrap(), "Media");
        let media = body.field("media").unwrap();
        assert_eq!(
            media.field("mimetype").unwrap().as_str().unwrap(),
            "image/png"
        );
        assert_eq!(media.field("data").unwrap().as_str().unwrap(), "");
        let reaction = Body::Reaction(Reaction {
            target: SyncObjId::from_bytes([3; 32]),
            emoji: "+".into(),
            action: ReactionAction::Remove,
        })
        .enc();
        let r = reaction.field("reaction").unwrap();
        assert_eq!(r.field("emoji").unwrap().as_str().unwrap(), "+");
        assert_eq!(r.field("action").unwrap().as_str().unwrap(), "Remove");
        assert_eq!(r.field("target").unwrap().as_str().unwrap(), hex(&[3; 32]));
    }

    /// The SDK reads the lines by these names (`gossip-sdk/src/services/groups.ts`).
    #[test]
    fn timeline_lines_name_their_actor() {
        let epoch = ChatId::from_bytes([1; 32]);
        let by = GossipId::from_bytes([2; 32]);
        let lines = [
            TimelineLine::Founded { epoch, owner: by },
            TimelineLine::Joined { epoch, by },
            TimelineLine::EpochChange {
                epoch,
                by,
                added: vec![],
                removed: vec![],
                left: vec![by],
                renamed: None,
                new_owner: Some(by),
            },
            TimelineLine::NotAMember { from: 1, to: 2 },
            TimelineLine::AddedBack { epoch, by },
        ];
        for line in lines {
            round_trip(line);
        }
        let text = TimelineLine::AddedBack { epoch, by }.enc().to_text();
        let j = J::parse(&text).unwrap();
        assert_eq!(j.field("t").unwrap().as_str().unwrap(), "AddedBack");
        assert_eq!(j.field("by").unwrap(), &by.enc());
        let j = TimelineLine::Joined { epoch, by }.enc();
        assert_eq!(j.field("t").unwrap().as_str().unwrap(), "Joined");
        assert_eq!(j.field("epoch").unwrap(), &epoch.enc());
    }
}
