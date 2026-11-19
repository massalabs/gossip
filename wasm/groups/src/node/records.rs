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

use crate::ids::{ChatId, EventId, GossipId, RequestId, ScanId, SyncObjId};
use crate::store::{Changes, Storage, StorageError};
use crate::wire::{Entry, QueryOp, Status};

use super::timing::Bucket;

// ── Retrieval (§11) ──────────────────────────────────────────────────────────

/// What a retrieval task looks for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Target {
    /// A missing message event, by ID (§11.1, §12.4).
    Event(EventId),
    /// A sync-object lookup (§12.5).
    SyncObj(SyncObjId),
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
    /// Requests sent to it for this task.
    pub attempts: u32,
    /// `busy` answers in a row in this run.
    pub busy: u8,
}

impl Candidate {
    pub(crate) fn new() -> Self {
        Self {
            trigger: None,
            state: CandidateState::Untried,
            outstanding_until: None,
            attempts: 0,
            busy: 0,
        }
    }

    /// Whether it announced the item (notice or page), which makes a later "not available"
    /// a failed announcement (§11.8, penalty 3).
    #[must_use]
    pub fn announced(&self) -> bool {
        matches!(
            self.trigger,
            Some(Trigger {
                kind: TriggerKind::Notice | TriggerKind::Page,
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
    /// Fresh scans started after `restart`.
    pub restarts: u8,
    /// Resends caused by `expired` in this stage.
    pub expired_resends: u8,
    /// `busy` answers in a row in this stage.
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
    /// The scan of the group anchored at this epoch with the peer.
    Scan(ChatId),
}

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
    /// When the first of those timeouts happened.
    pub first_failure: u64,
    /// Its request budget (entries it may make this device answer).
    pub requests: Bucket,
    /// Its response budget (bytes of answers sent to it).
    pub responses: Bucket,
    /// When a version notice was last sent to it, per received version (§13.8).
    pub version_notices: BTreeMap<u64, u64>,
    /// The highest version it said it supports, from its version notice.
    pub version: Option<u64>,
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
    peers: GossipId => PeerRecord,
    groups: ChatId => GroupSync,
    tasks: TaskKey => Task,
    scans_out: ScanKey => ScanOp,
    scans_in: FrozenKey => FrozenScan,
    requests: (GossipId, RequestId) => RequestRef,
    hints: HintKey => Hint,
    queue: WorkKey => Work,
    meta: () => Meta,
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
}

impl Batch {
    /// Whether nothing is to be written.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.node.is_empty() && self.epochs.iter().all(Changes::is_empty)
    }
}

/// A store of the epochs' records and of the node records (§14.1).
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
