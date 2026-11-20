//! The device-level records of §14.1 that milestone 3 adds, and the storage trait that
//! commits them together with the epochs' records.
//!
//! - **Retrieval tasks** with their per-peer candidate rows ([`Task`], [`Candidate`]).
//! - **Scan state**: the requester's scan operations ([`ScanOp`]), the responder's frozen
//!   lists and their tombstones ([`FrozenScan`]), and the **request correlation references**
//!   ([`RequestRef`]).
//! - **Neighbor state** and the periodic lanes of a group ([`GroupSync`]).
//! - **Peer-knowledge hints** ([`Hint`]).
//! - **Peer records**: score, budgets, failures, version notices ([`PeerRecord`]).
//! - **Pending plaintext work** ([`Work`]): scoped references plus the intended kind of
//!   transmission, never result bytes (§15.1). The encrypted outbox itself belongs to the
//!   transport.
//!
//! **Atomicity (§15.2).** An engine operation stages the epochs' [`Changes`] in an overlay
//! and the changes of these records in [`NodeChanges`], and hands both to
//! [`NodeStorage::commit_batch`] once, at its end. An implementation MUST apply a [`Batch`]
//! in one transaction: all of it or nothing.

use std::collections::{BTreeMap, BTreeSet};

use crate::epoch::GroupState;
use crate::ids::{
    ChatId, EventId, GossipId, ParentCommitment, RefChatId, RequestId, ScanId, SyncObjId,
};
use crate::root::Root;
use crate::signed::{Dissolve, Kick, Leave};
use crate::store::{Changes, Storage, StorageError};
use crate::wire::{Entry, EntryItem, QueryOp, SignedKind, Status};

use super::timing::Bucket;

// ── Retrieval (§11) ──────────────────────────────────────────────────────────

/// What a retrieval task looks for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Target {
    /// A missing message event, by ID (§11.1, §12.4).
    Event(EventId),
    /// A sync-object lookup (§12.5).
    SyncObj(SyncObjId),
    /// A root announced or listed by its ID, the task key's `chat_id` (§4.6, §11.8, §12.7).
    Root,
    /// The parent of a held root, the task key's `chat_id`, by one of its commitments (§4.8,
    /// §12.7).
    Parent(ParentCommitment),
    /// A signed object naming the task key's epoch, by kind and ID (§11.8, §12.8).
    Object(SignedKind, [u8; 32]),
    /// The removal records of a member in the task key's epoch (§5.6, §12.8).
    Removal(GossipId),
    /// The keys of a member of the task key's epoch (§4.3, §12.9).
    Keys(GossipId),
    /// The root of the epoch a reply names by this reference, which no root this device
    /// holds matches (§7.6, §12.7). The task key's `chat_id` is the epoch of the reply,
    /// whose members are asked. One task is one round of [`RefLookup`].
    Ref(RefChatId),
}

impl Target {
    /// Whether the target is a root or a signed object, which do not expire (§11.8), or a
    /// key: none of them has a lookup deadline.
    #[must_use]
    pub fn is_membership(&self) -> bool {
        !matches!(self, Target::Event(_) | Target::SyncObj(_))
    }
}

/// The key of a retrieval task: one per `(chat_id, eventId)` or `(chat_id, syncObjId)`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct TaskKey {
    /// The epoch.
    pub chat_id: ChatId,
    /// The target.
    pub target: Target,
}

/// What made a peer a candidate with a trigger (§11.2): it announced the event, delivered a
/// child that references it, or listed it in a tip page.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TriggerKind {
    /// A gossip notice.
    Notice,
    /// A child event referencing the missing parent.
    Child,
    /// A tip page entry.
    Page,
}

/// A trigger of a candidate: its kind and local receipt time (local, never transmitted).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Trigger {
    /// The kind.
    pub kind: TriggerKind,
    /// The local receipt time.
    pub at: u64,
}

/// What the task knows of a candidate in the current run.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CandidateState {
    /// Not asked in this run, or asked without an answer yet.
    Untried,
    /// Answered "not available" in this run.
    NotAvailable,
    /// Gave an invalid answer or refused with `busy`: failed for this pass (§11.4).
    Failed,
}

/// A per-peer candidate row of a task (§14.1).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Candidate {
    /// The latest trigger, if any.
    pub trigger: Option<Trigger>,
    /// The state in this run.
    pub state: CandidateState,
    /// Until when a request sent to it stays valid (its correlation deadline); it is not
    /// reselected before (§11.2).
    pub outstanding_until: Option<u64>,
    /// Requests to it for this task that were answered "not available" since it last
    /// announced the item, or timed out while it has no trigger (§11.2): not `busy` or
    /// `expired`.
    pub attempts: u32,
    /// Kept for the stored record; `busy` is back-pressure per peer now (`node::backoff`)
    /// and leaves it at 0.
    pub busy: u8,
    /// Penalties it got for "not available" after announcing the item: withdrawn if the
    /// item turns up.
    pub unavailable: u8,
}

impl Candidate {
    pub(crate) fn new() -> Self {
        Self {
            trigger: None,
            state: CandidateState::Untried,
            outstanding_until: None,
            attempts: 0,
            busy: 0,
            unavailable: 0,
        }
    }

    /// Whether it announced the item in a notice, which makes a later "not available" a
    /// failed announcement (§11.8, penalty 3). A tip page lists what the peer held when the
    /// scan froze its list, which it may have pruned since: not an announcement.
    #[must_use]
    pub fn announced(&self) -> bool {
        matches!(
            self.trigger,
            Some(Trigger {
                kind: TriggerKind::Notice,
                ..
            })
        )
    }
}

/// The current attempt of an active run.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Attempt {
    /// A query entry for `peer` waits in its queue; the local wait starts when it is sent.
    Queued {
        /// The peer.
        peer: GossipId,
    },
    /// Sent to `peer`; the stage times out locally at `local_deadline`.
    Sent {
        /// The peer.
        peer: GossipId,
        /// `sent_at + floor(ttl × r)`.
        local_deadline: u64,
        /// The `sent_at` of the query first sent for the stage (resends keep it).
        sent_at: u64,
    },
}

impl Attempt {
    /// The peer of the attempt.
    #[must_use]
    pub fn peer(&self) -> GossipId {
        match self {
            Attempt::Queued { peer } | Attempt::Sent { peer, .. } => *peer,
        }
    }
}

/// The run of a task (§11.4, §11.5).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Run {
    /// Asking candidates one at a time.
    Active {
        /// Unanswered stages so far in this run (0-based stage index).
        stage: u8,
        /// The nominal TTL of the stage.
        ttl: u64,
        /// The jitter `r` of the stage, in millionths, kept for its resends.
        jitter: u32,
        /// The current attempt.
        attempt: Option<Attempt>,
        /// Resends caused by `expired` in this stage (bounded, see `retrieval`).
        expired_resends: u8,
    },
    /// Paused after 20 unanswered stages, or with no candidate left; renewed by new
    /// evidence (§11.5).
    Paused,
}

/// A retrieval task (§11.1, §14.1).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Task {
    /// The run.
    pub run: Run,
    /// The candidate rows of the peers the task has seen, by peer.
    pub candidates: BTreeMap<GossipId, Candidate>,
    /// Runs started so far (1 + renewals).
    pub runs: u32,
    /// When the task was created (local time), which bounds its lookup deadline.
    pub created_at: u64,
}

impl Task {
    /// The lookup deadline of an event task (§11.6): `ts + RETENTION` from the ID, but no
    /// later than a retention period after the task was created, so that an ID dated far in
    /// the future is not looked for longer than any real event can be. None for a
    /// sync-object lookup.
    #[must_use]
    pub fn deadline(&self, key: &TaskKey) -> Option<u64> {
        match key.target {
            Target::Event(id) => {
                let by_id = u64::try_from(crate::store::window_end(&id)).unwrap_or(u64::MAX);
                Some(
                    by_id.min(
                        self.created_at
                            .saturating_add(super::timing::TASK_LIFETIME_MS),
                    ),
                )
            }
            _ => None,
        }
    }
}

// ── Scans (§12.1, §12.2) ─────────────────────────────────────────────────────

/// The state of a requester's scan attempt.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScanAttempt {
    /// The page request waits in the peer's queue.
    Queued,
    /// Sent; the stage times out locally at `local_deadline`.
    Sent {
        /// `sent_at + floor(ttl × r)`.
        local_deadline: u64,
        /// The `sent_at` of the request first sent for the stage (resends keep it).
        sent_at: u64,
    },
    /// Waiting before the next request: after `busy`, or while retrieval is backlogged.
    Waiting {
        /// When to request again.
        until: u64,
    },
}

/// The requester's scan of one group with one peer (§12.1, §12.3). Overlapping triggers
/// for the same peer and group share it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScanOp {
    /// The current scan ID (fresh per scan, §12.2).
    pub scan_id: ScanId,
    /// The offset of the next page.
    pub offset: u64,
    /// `offset + count` of the first page, which every later page must repeat.
    pub total: Option<u64>,
    /// Unanswered stages so far.
    pub stage: u8,
    /// The nominal TTL of the stage.
    pub ttl: u64,
    /// The jitter of the stage, in millionths.
    pub jitter: u32,
    /// The attempt.
    pub attempt: ScanAttempt,
    /// Fresh scans started after `restart` since the last page that made progress.
    pub restarts: u8,
    /// Resends caused by `expired` in this stage.
    pub expired_resends: u8,
    /// Kept for the stored record; `busy` is back-pressure per peer now (`node::backoff`)
    /// and leaves it at 0.
    pub busy: u8,
    /// The periodic lanes waiting for its completion.
    pub lanes: BTreeSet<u8>,
}

/// A frozen list kept by the responder, or its tombstone (§12.2).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FrozenScan {
    /// The ordered entries; `None` once dropped (identifier-only tombstone).
    pub list: Option<Vec<Entry>>,
    /// The list is kept until this instant: the deadline of the most recently received
    /// valid request of the scan.
    pub live_until: u64,
    /// The tombstone is forgotten at this instant (24 h after the drop).
    pub forget_at: u64,
}

/// What a query entry was for, kept with its correlation reference.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Purpose {
    /// A retrieval task.
    Task(TaskKey),
    /// The scan of the group with this key with the peer, anchored at its current epoch;
    /// [`SHARED_SCAN`] for a shared-chats scan (§4.11).
    Scan(ChatId),
}

/// The group key of a shared-chats scan (§4.11, §12.6), in the requester's scan table and in
/// the responder's frozen lists: no epoch has an all-zero ID.
pub const SHARED_SCAN: ChatId = ChatId::from_bytes([0; 32]);

/// One entry of a sent query.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RefEntry {
    /// What it was for.
    pub purpose: Purpose,
    /// What was asked; a returned item must match it (§13.4).
    pub op: QueryOp,
    /// Whether a valid answer was already counted (§13.4: only the first counts).
    pub answered: bool,
}

/// A request correlation reference, kept per `(peer, request_id)` until the request's own
/// deadline (§13.4).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RequestRef {
    /// The claimed send time.
    pub sent_at: u64,
    /// The nominal TTL.
    pub ttl: u64,
    /// The entries, by `idx`.
    pub entries: Vec<RefEntry>,
}

// ── Neighbors and periodic recovery (§10.1, §12.3) ───────────────────────────

/// The kind of a periodic lane.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LaneKind {
    /// Visits neighbors in a shuffled cycle.
    Neighbor,
    /// Scans a random member that is not a neighbor.
    Random,
}

/// The kinds of the four lanes, in order (§12.3).
pub const LANE_KINDS: [LaneKind; 4] = [
    LaneKind::Neighbor,
    LaneKind::Random,
    LaneKind::Neighbor,
    LaneKind::Random,
];

/// A periodic recovery lane (§12.3).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Lane {
    /// Completion + 24 h: its earliest next start.
    pub earliest: u64,
    /// When the previous lane's offset makes it due; `None` until then.
    pub due: Option<u64>,
    /// The peer it is scanning, while active.
    pub active: Option<GossipId>,
    /// Whether it already moved to another peer after "not available" in this round.
    pub moved: bool,
}

/// The dissemination and recovery state of a group (§10.1, §12.3). Milestone 3 drives one
/// epoch per group, keyed by that epoch.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct GroupSync {
    /// The neighbors.
    pub neighbors: BTreeSet<GossipId>,
    /// Neighbor requests sent and not answered yet, with their send time.
    pub asked: BTreeMap<GossipId, u64>,
    /// Peers not asked again before the given time (declined, unanswered or replaced).
    pub cooldown: BTreeMap<GossipId, u64>,
    /// Members suggested by declining peers; asked first.
    pub suggested: BTreeSet<GossipId>,
    /// The four lanes.
    pub lanes: [Lane; 4],
    /// The next lane in the order.
    pub cursor: u8,
    /// The unvisited neighbors of the neighbor lanes' shuffled cycle, next last.
    pub cycle: Vec<GossipId>,
    /// The device's first time online for this group: the phase of the lanes.
    pub first_online: Option<u64>,
}

// ── Peers ────────────────────────────────────────────────────────────────────

/// What this device knows of a peer, across groups (§11.8, §13.8, §17.4).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PeerRecord {
    /// Items supplied (raises the score).
    pub supplied: u32,
    /// Weighted penalties (lowers the score).
    pub penalty: u32,
    /// Consecutive local timeouts of queries sent to it; any valid answer resets it.
    pub failures: u32,
    /// How long those timed-out queries waited unanswered, overlaps counted once: the time
    /// it was actually asked without answering.
    pub unanswered_ms: u64,
    /// The latest of those timeouts.
    pub last_failure: u64,
    /// The `sent_at` of the last query whose timeout was counted: the entries of one query
    /// that time out together count once.
    pub last_timeout_query: u64,
    /// Its request budget (entries it may make this device answer).
    pub requests: Bucket,
    /// Its response budget (bytes of answers sent to it).
    pub responses: Bucket,
    /// When a version notice was last sent to it, per received version (§13.8).
    pub version_notices: BTreeMap<u64, u64>,
    /// The highest version it said it supports, from its version notice.
    pub version: Option<u64>,
    /// When its recent failed root announcements happened (§11.8).
    pub failed_announcements: Vec<u64>,
    /// Its root notices and shared-chats pages are not acted on before this instant.
    pub paused_until: u64,
    /// The length of its last pause (it doubles on each repeat, up to 24 h).
    pub pause_ms: u64,
}

/// The back-pressure of a peer that answered `busy` (§13.4, local policy, see
/// `node::backoff`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Backoff {
    /// When its current streak of `busy` started.
    pub since: u64,
    /// It is not asked again before this instant.
    pub until: u64,
    /// The current wait; 0 once a non-`busy` answer ended the streak.
    pub wait_ms: u64,
    /// The lookups this device keeps outstanding with it.
    pub window: u32,
}

// ── Hints (§10.3) ────────────────────────────────────────────────────────────

/// A peer-knowledge hint.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Hint {
    /// When it was first recorded; it expires 28 days later.
    pub first: u64,
    /// When it was last recorded or used (least-recently-used eviction).
    pub used: u64,
}

// ── Pending plaintext work (§15.1) ───────────────────────────────────────────

/// What an answer will carry, decided again at assembly (§15.1).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AnswerOp {
    /// An event lookup.
    Event {
        /// The epoch.
        chat_id: ChatId,
        /// The event.
        event_id: EventId,
    },
    /// A sync-object lookup.
    SyncObj {
        /// The epoch.
        chat_id: ChatId,
        /// The sync object.
        sync_obj_id: SyncObjId,
    },
    /// A page of a frozen list.
    Page {
        /// The anchor.
        anchor: ChatId,
        /// The scan.
        scan_id: ScanId,
        /// The offset.
        offset: u64,
    },
    /// A status decided on receipt.
    Status(Status),
    /// A root (§12.7), resolved on receipt.
    Root {
        /// The root's ID.
        chat_id: ChatId,
    },
    /// A signed object (§12.8).
    Object {
        /// The epoch it names.
        chat_id: ChatId,
        /// The object.
        item: EntryItem,
    },
    /// A key answer (§12.9).
    Keys {
        /// The subject.
        gossip_id: GossipId,
    },
}

/// One item of pending plaintext work for a peer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Work {
    /// A full event: first send or push (§10.2, §10.4).
    Full {
        /// The epoch.
        chat_id: ChatId,
        /// The event.
        event_id: EventId,
    },
    /// A gossip notice entry for an event (§10.2).
    Notice {
        /// The epoch.
        chat_id: ChatId,
        /// The event.
        event_id: EventId,
    },
    /// A query entry; its operation, TTL and request ID are decided at assembly.
    Query {
        /// What it is for.
        purpose: Purpose,
    },
    /// An answer to a received query entry.
    Answer {
        /// The query's `request_id`.
        request_id: RequestId,
        /// The entry's position.
        idx: u32,
        /// The query's `sent_at`.
        sent_at: u64,
        /// The query's `ttl`.
        ttl: u64,
        /// What to answer.
        op: AnswerOp,
    },
    /// A neighbor request (§13.6).
    NeighborRequest {
        /// Our current epoch.
        chat_id: ChatId,
    },
    /// A neighbor response (§13.6).
    NeighborResponse {
        /// The epoch of the request.
        chat_id: ChatId,
        /// Accepted.
        accepted: bool,
        /// Suggestions when declined.
        suggestions: Vec<GossipId>,
    },
    /// The version notice of §13.8.
    VersionNotice,
    /// A root or a signed object sent in full (§4.6, §5.3, §5.6, §5.8), decided again at
    /// assembly from the held record.
    Object {
        /// The epoch it names (the root's own ID for a root).
        chat_id: ChatId,
        /// The object.
        item: EntryItem,
    },
    /// A notice entry of a root or a signed object (§4.6, §10.2).
    ObjectNotice {
        /// The epoch it names.
        chat_id: ChatId,
        /// The object.
        item: EntryItem,
    },
    /// An event blob kept as bytes: the sends that must leave after the group is closed on
    /// this device (a signed leave or decline, a handover before leaving, §5.3, §5.7).
    Blob(Vec<u8>),
    /// The owner-only request (§5.4, §13.6).
    LeaveRequest {
        /// The requester's current epoch.
        chat_id: ChatId,
    },
}

/// Engine-wide counters that must survive restarts.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Meta {
    /// The sequence number of the next queued work item.
    pub next_seq: u64,
}

/// The key of a hint: group, peer, event.
pub type HintKey = (ChatId, GossipId, EventId);
/// The key of a frozen list: authenticated peer, anchor, scan ID (§12.2).
pub type FrozenKey = (GossipId, ChatId, ScanId);
/// The key of a requester's scan: anchor (the group), peer.
pub type ScanKey = (ChatId, GossipId);
/// The key of a queued work item: peer, sequence number.
pub type WorkKey = (GossipId, u64);

macro_rules! tables {
    ($($name:ident : $key:ty => $value:ty),* $(,)?) => {
        /// Every node record, as loaded at startup.
        #[derive(Debug, Clone, Default, PartialEq, Eq)]
        pub struct NodeRecords {
            $(
                #[doc = concat!("The `", stringify!($name), "` table.")]
                pub $name: BTreeMap<$key, $value>,
            )*
        }

        /// The writes of one engine operation to the node records: `Some` upserts, `None`
        /// deletes.
        #[derive(Debug, Clone, Default, PartialEq, Eq)]
        pub struct NodeChanges {
            $(
                #[doc = concat!("Writes to the `", stringify!($name), "` table.")]
                pub $name: BTreeMap<$key, Option<$value>>,
            )*
        }

        impl NodeChanges {
            /// Whether nothing is to be written.
            #[must_use]
            pub fn is_empty(&self) -> bool {
                true $(&& self.$name.is_empty())*
            }
        }

        impl NodeRecords {
            /// Applies `changes`.
            pub fn apply(&mut self, changes: NodeChanges) {
                $(
                    for (k, v) in changes.$name {
                        match v {
                            Some(v) => { self.$name.insert(k, v); }
                            None => { self.$name.remove(&k); }
                        }
                    }
                )*
            }
        }

        /// The in-memory copy of the records, with the keys written since the last commit.
        #[derive(Debug, Clone, Default)]
        pub(crate) struct Tables {
            $( pub(crate) $name: Table<$key, $value>, )*
        }

        impl Tables {
            pub(crate) fn from_records(r: NodeRecords) -> Self {
                Self { $( $name: Table::from_map(r.$name), )* }
            }

            pub(crate) fn take_changes(&mut self) -> NodeChanges {
                NodeChanges { $( $name: self.$name.take_changes(), )* }
            }
        }
    };
}

tables! {
    epochs: ChatId => EpochRecord,
    group_recs: ChatId => GroupRecord,
    signed: SignedKey => SignedRecord,
    keys: GossipId => Vec<u8>,
    markers: ChatId => Marker,
    replies: (ChatId, GossipId) => ReplyCount,
    unverified: (ChatId, GossipId, GossipId) => PendingLeave,
    held_roots: ChatId => HeldRoot,
    events: (ChatId, ChangeKind) => u64,
    peers: GossipId => PeerRecord,
    groups: ChatId => GroupSync,
    tasks: TaskKey => Task,
    scans_out: ScanKey => ScanOp,
    scans_in: FrozenKey => FrozenScan,
    requests: (GossipId, RequestId) => RequestRef,
    hints: HintKey => Hint,
    queue: WorkKey => Work,
    meta: () => Meta,
    lookup_results: (ChatId, SyncObjId) => super::LookupResult,
    earlier: (GossipId, u64) => u64,
    consents: GossipId => u64,
    backoff: GossipId => Backoff,
    contacts: GossipId => u64,
    ref_lookups: RefChatId => RefLookup,
}

/// A table of the in-memory copy: the records and the keys written since the last commit.
#[derive(Debug, Clone)]
pub(crate) struct Table<K: Ord + Clone, V: Clone> {
    map: BTreeMap<K, V>,
    dirty: BTreeSet<K>,
}

impl<K: Ord + Clone, V: Clone> Default for Table<K, V> {
    fn default() -> Self {
        Self {
            map: BTreeMap::new(),
            dirty: BTreeSet::new(),
        }
    }
}

impl<K: Ord + Clone, V: Clone> Table<K, V> {
    fn from_map(map: BTreeMap<K, V>) -> Self {
        Self {
            map,
            dirty: BTreeSet::new(),
        }
    }

    pub(crate) fn get(&self, k: &K) -> Option<&V> {
        self.map.get(k)
    }

    pub(crate) fn contains(&self, k: &K) -> bool {
        self.map.contains_key(k)
    }

    /// The keys written since the last commit (in this operation).
    pub(crate) fn dirty_keys(&self) -> Vec<K> {
        self.dirty.iter().cloned().collect()
    }

    /// A mutable reference; the key is written at the next commit.
    pub(crate) fn get_mut(&mut self, k: &K) -> Option<&mut V> {
        let v = self.map.get_mut(k)?;
        self.dirty.insert(k.clone());
        Some(v)
    }

    pub(crate) fn insert(&mut self, k: K, v: V) {
        self.dirty.insert(k.clone());
        self.map.insert(k, v);
    }

    pub(crate) fn remove(&mut self, k: &K) -> Option<V> {
        let v = self.map.remove(k)?;
        self.dirty.insert(k.clone());
        Some(v)
    }

    pub(crate) fn iter(&self) -> impl Iterator<Item = (&K, &V)> {
        self.map.iter()
    }

    pub(crate) fn keys(&self) -> impl Iterator<Item = &K> {
        self.map.keys()
    }

    pub(crate) fn range<R: core::ops::RangeBounds<K>>(
        &self,
        r: R,
    ) -> impl Iterator<Item = (&K, &V)> {
        self.map.range(r)
    }

    pub(crate) fn len(&self) -> usize {
        self.map.len()
    }

    fn take_changes(&mut self) -> BTreeMap<K, Option<V>> {
        core::mem::take(&mut self.dirty)
            .into_iter()
            .map(|k| {
                let v = self.map.get(&k).cloned();
                (k, v)
            })
            .collect()
    }
}

/// The writes of one engine operation: the epochs' records and the node records.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Batch {
    /// One [`Changes`] per epoch written.
    pub epochs: Vec<Changes>,
    /// The node records.
    pub node: NodeChanges,
    /// Epochs whose message records (rows, edges, objects) are erased, after `epochs` is
    /// applied: a closed group (§14.2), a group waiting for a kick (§5.4) or dissolved with
    /// "Dissolve & Delete" (§5.8).
    pub erase: BTreeSet<ChatId>,
}

impl Batch {
    /// Whether nothing is to be written.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.node.is_empty() && self.epochs.iter().all(Changes::is_empty) && self.erase.is_empty()
    }
}

/// A store of the epochs' records and of the node records (§14.1).
///
/// # Atomicity of a batch, `erase` included
///
/// [`NodeStorage::commit_batch`] MUST apply the whole [`Batch`] in one transaction: the
/// epochs' [`Changes`], then the erasure of every epoch in [`Batch::erase`] (all its rows,
/// edges and objects, whatever the same batch wrote to it), then the node records, all of it
/// or nothing. A batch that erases a closed group's messages and removes its records must
/// never be half applied: a crash in between would leave messages of a group the device
/// shows as closed. [`super::conformance::check_batch_with_erase`] checks this for a
/// backend.
pub trait NodeStorage: Storage {
    /// Every node record.
    ///
    /// # Errors
    ///
    /// A backend failure.
    fn load_node(&self) -> Result<NodeRecords, StorageError>;

    /// Applies `batch` in one transaction: all of it or nothing (§15.2).
    ///
    /// # Errors
    ///
    /// A backend failure, in which case nothing was applied.
    fn commit_batch(&mut self, batch: Batch) -> Result<(), StorageError>;
}

// ── Groups, epochs and signed objects (§4, §5, §14.1) ────────────────────────

/// An invitation not answered yet (§4.8).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Invitation {
    /// When the root was received: the prompt waits at most `PROMPT_DELAY` after it.
    pub received_at: u64,
    /// The commitments still looked up (§4.8 parent lookup).
    pub lookups: BTreeSet<ParentCommitment>,
    /// The members that answered "not available" to the parent lookup.
    pub not_available: BTreeSet<GossipId>,
    /// The epoch was closed on this device before (§14.2): the prompt warns.
    pub closed_before: bool,
    /// The held epoch in a kicked or dissolved group that the root continues, if any: an
    /// invitation to rejoin (§4.8 case 4), accepted into that group (§5.10).
    pub rejoins: Option<ChatId>,
    /// For a root fetched as the parent of another (never prompted on its own): the
    /// invitation the lookup started from, and how many parents away it is.
    pub fetched_for: Option<(ChatId, u16)>,
}

/// The local status of an epoch.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EpochStatus {
    /// Installed: accepted, adopted automatically, or kept in a group waiting for a kick.
    Installed,
    /// An invitation not answered yet; frames for it other than its root are dropped.
    Invitation(Invitation),
}

/// The epoch record of §14.1.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EpochRecord {
    /// The root, with its version, fields and signature.
    pub root: Root,
    /// Installed or an invitation.
    pub status: EpochStatus,
    /// The key of its group: the ID of an epoch of the group (local, never sent).
    pub group: ChatId,
    /// The held epochs this root continues, matched and with verified authority (§4.7).
    pub parents: Vec<ChatId>,
    /// The time `T` of its line, computed once at adoption (§7.5).
    pub line_time: Option<u64>,
    /// When it was received (local).
    pub received_at: u64,
    /// The immediate peer that delivered it ("received from", §4.8).
    pub from: GossipId,
    /// Removed peers set by hand ([`super::Node::install_epoch`]), added to the derived ones.
    pub removed_override: BTreeSet<GossipId>,
    /// A group state set by hand ([`super::Node::install_epoch`]).
    pub state_override: Option<GroupState>,
}

/// The state of a group (§14.1).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GroupStatus {
    /// Normal.
    Active,
    /// Read-only after a kick naming the current epoch (§5.6).
    Removed {
        /// The epoch the kick names.
        epoch: ChatId,
        /// When the kick was received.
        at: u64,
    },
    /// Read-only after receiving its own signed leave for the current epoch (D.2, choice A).
    Left {
        /// The epoch the leave names.
        epoch: ChatId,
        /// When it was received.
        at: u64,
    },
    /// Waiting for a kick after "Ask to be kicked" (§5.4).
    Waiting {
        /// When the request was first sent.
        since: u64,
        /// When it was last sent.
        last_request: u64,
    },
    /// Dissolved by its owner (§5.8).
    Dissolved {
        /// The dissolved epoch.
        epoch: ChatId,
        /// "Dissolve & Delete".
        must_delete: bool,
        /// When the dissolve message was received.
        at: u64,
    },
    /// An automatic chat of two replaced by another chat of the same two (§5.12): kept,
    /// readable, read-only. It still takes the message events its members send it (written
    /// before they switched), sends nothing, and answers about its epochs as a device that
    /// does not hold them.
    Superseded {
        /// The chat that continues it, by its group key.
        by: ChatId,
        /// When it was replaced.
        at: u64,
    },
}

/// The group record of §14.1.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GroupRecord {
    /// Its state.
    pub status: GroupStatus,
    /// The owner whose line the device follows (§5.9): the new owner of the first handover
    /// it adopted from the owner it followed.
    pub followed: Option<GossipId>,
    /// The owners that handed the group over on the followed line (§5.9).
    pub deposed: BTreeSet<GossipId>,
    /// Groups linked by hand (§5.10), by key.
    pub links: BTreeSet<ChatId>,
    /// The local name (§5.11).
    pub local_name: Option<String>,
    /// Owner side: members whose live leave or owner-only request is held, with when it
    /// arrived (§5.5).
    pub pending_removals: BTreeMap<GossipId, u64>,
    /// Junctions after being added back (§5.10).
    pub junctions: Vec<Junction>,
    /// An automatic chat of two this device owns (§5.12): whether this device received from
    /// the other person, inside this chat, a message event, a notice of one or a query about
    /// its messages. A local fact, never sent and compared with no date, kept for good: it is
    /// never recomputed.
    pub took_part: bool,
    /// An automatic chat of two (§5.12): the chats of the same two it superseded, oldest
    /// first, theirs flattened before each. Local, never sent.
    pub earlier: Vec<ChatId>,
}

/// A junction (§5.10): the device was read-only in a group and accepted a root that brought
/// it back.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Junction {
    /// When the group became read-only: the kick, the own leave or the dissolve received.
    pub from: u64,
    /// The time `T` of the root that brought the device back (§7.5).
    pub to: u64,
    /// What made it read-only.
    pub kind: JunctionKind,
}

/// What made a group read-only before a junction (§5.6, D.2, §5.8).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum JunctionKind {
    /// A kick.
    Removed,
    /// The device's own signed leave, sent from another copy of the account (D.2).
    Left,
    /// "Dissolve & Keep archived".
    Dissolved,
}

/// The key of a signed object: the epoch it names, its kind and its ID.
pub type SignedKey = (ChatId, SignedKind, [u8; 32]);

/// A signed object (§5.1).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SignedObject {
    /// A signed leave.
    Leave(Leave),
    /// A kick.
    Kick(Kick),
    /// A dissolve message.
    Dissolve(Dissolve),
}

/// A verified signed object, kept as long as the root it names (§5.3, §5.6, §14.1).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SignedRecord {
    /// The object.
    pub object: SignedObject,
    /// When it was received: where its line is placed (§7.5).
    pub received_at: u64,
}

/// A closed-chat or dissolved marker (§14.2): a chat ID only.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Marker {
    /// A closed epoch: roots that continue it are rejected (§4.8 case 3).
    Closed,
    /// A root rejected because it continues a closed epoch (§4.8 case 3), recorded as
    /// closed too, with the peer that delivered it (for the per-sender limit).
    ClosedFrom(GossipId),
    /// Left by "Dissolve & Delete": every frame of the epoch is dropped (§14.2).
    Dissolved,
}

impl Marker {
    /// Whether it rejects roots that continue the epoch (§4.8 case 3).
    #[must_use]
    pub fn is_closed(&self) -> bool {
        matches!(self, Marker::Closed | Marker::ClosedFrom(_))
    }
}

/// The answers with a removal record sent to a removed peer in an epoch, per day (§5.6).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ReplyCount {
    /// The start of the current day window.
    pub since: u64,
    /// Answers sent in it.
    pub count: u8,
    /// The peer contacted this device since the last answer and is still owed one.
    pub owed: bool,
}

/// A signed leave waiting for the leaver's keys (§5.3: the keys are not carried).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PendingLeave {
    /// The leave.
    pub leave: Leave,
    /// Who supplied it.
    pub from: GossipId,
    /// When.
    pub at: u64,
}

/// A handover root whose parent the device does not hold yet (§4.7), kept while the parent
/// is looked up.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HeldRoot {
    /// The root.
    pub root: Root,
    /// Who delivered it.
    pub from: GossipId,
    /// When.
    pub at: u64,
}

/// A reply held by this device that names a reference (§7.6), kept by [`RefLookup`]: who
/// delivered it, the author it claims, and when it arrived. Local, never sent.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RefReply {
    /// The peer that delivered it to this device.
    pub from: GossipId,
    /// Its author field: an unsigned claim, used only to order the peers asked.
    pub author: GossipId,
    /// When it was received (local time).
    pub at: u64,
}

/// A reference named by replies this device holds, whose target it does not hold yet
/// (§7.6, §12.7): the epoch is unknown and its root is looked up by reference, or the
/// epoch is known (installed, or an invitation not answered yet) and the target is fetched
/// once the device holds the epoch installed. Local, never sent; forgotten once no reply
/// naming it is held.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RefLookup {
    /// The replies that name it, by `(epoch of the reply, its sync object, the target's sync
    /// object)`. Bounded by [`super::timing::REF_REPLIES_KEPT`].
    pub replies: BTreeMap<(ChatId, SyncObjId, SyncObjId), RefReply>,
    /// Rounds of the lookup by reference started so far, at most
    /// [`super::timing::REF_LOOKUP_ROUNDS`]; never reset while the record lasts.
    pub rounds: u8,
    /// When the last round started.
    pub last_round: Option<u64>,
    /// While a round runs: the epoch whose members it asks (the key of its task).
    pub round: Option<ChatId>,
    /// The peers of the running or last round, in the order they are asked.
    pub asked: Vec<GossipId>,
    /// When the record is examined next.
    pub due: u64,
}

/// What changed, for the caller ([`super::Node::take_changes`]): coalesced per group and
/// kind until taken.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum ChangeKind {
    /// An invitation arrived or its prompt became due.
    Invitation,
    /// The group appeared on this device (founded, accepted, or adopted).
    Joined,
    /// Its member list, name or owner changed.
    Membership,
    /// Its messages changed.
    Messages,
    /// The device was removed, left, or the group was dissolved: it is read-only.
    ReadOnly,
    /// The owner holds competing ends to resolve (§4.9).
    Fork,
    /// The group was closed and erased on this device.
    Closed,
    /// This device's automatic chat of two is superseded by `by`, the chat of the same two
    /// that continues it (§5.12): it is kept, read-only.
    Superseded {
        /// The chat that continues it.
        by: ChatId,
        /// The superseded chat holds messages.
        has_messages: bool,
    },
    /// What the connection queries answer may have changed (§5.12), keyed by
    /// [`super::DEVICE`].
    Connections,
}
