//! The device-level engine: dissemination (§10), retrieval (§11), discovery (§12.1 to §12.5),
//! queries and responses (§13.3 to §13.10) and the transport integration of §15, for the
//! epochs the caller installs.
//!
//! The engine is pure: the transport (one-to-one Agraphon sessions), the clock, randomness and
//! storage are outside. It consumes the plaintexts received from named, authenticated peers
//! and produces plaintexts for named peers.
//!
//! # Driving interface
//!
//! - [`Node::open`] rebuilds the engine from storage (after a start or a crash), then
//!   [`Node::install_epoch`] registers each epoch with its root, acceptance, group state and
//!   removed peers (the epoch records belong to the group layer of milestone 4).
//! - [`Node::handle_plaintext`] processes one received plaintext.
//! - [`Node::tick`] runs everything due at `now`; [`Node::next_wakeup`] says when to call it.
//! - Local actions ([`Node::publish_message`], [`Node::publish_edit`],
//!   [`Node::publish_deletion`], [`Node::retry`], [`Node::local_edit`],
//!   [`Node::local_delete`], [`Node::lookup_sync_object`]) pass through to the epoch and
//!   queue what they disseminate.
//! - [`Node::poll_outbox`] assembles plaintexts from the pending work (deferred assembly,
//!   §15.1). A plaintext counts as sent only once the transport has stored its ciphertext
//!   durably and the caller confirms with [`Node::handed_off`]; until then the work stays
//!   queued and is assembled again after a restart, so a crash can duplicate a plaintext
//!   but never lose one. [`Node::published`] reports the backend's publication
//!   confirmation, which alone creates hints for the full events sent (§10.3).
//! - [`Node::peer_reconnected`] reports a connection reset (§12.3 trigger 2), and
//!   [`Node::set_session`] which peers have a session (§10.1, §11.2, §12.3).
//!
//! # Transport assumptions (§15)
//!
//! Plaintexts may be lost, duplicated, delayed for days and reordered; the peer is
//! authenticated by the session. Nothing here relies on ordering or on delivery: lost work
//! is recovered by retries and scans, duplicates are idempotent.
//!
//! # Atomicity (§15.2)
//!
//! Every method that takes a store is one operation: all epoch writes and all node writes
//! are committed together by one [`NodeStorage::commit_batch`]. On any error nothing is
//! committed and the in-memory copy is reloaded from storage.
//!
//! # Scope
//!
//! Groups of several epochs (§4, §5): the group-level state (neighbors, lanes, scans) is keyed
//! by the group, roots and signed objects are received, verified, stored, applied and
//! relayed ([`group`], [`objects`]), and the owner's and members' actions are in
//! [`actions`]; the state the interface needs is in [`view`].

pub mod conformance;
pub mod records;
pub mod timing;
pub use timing as policy;

mod actions;
mod backoff;
mod direct;
mod group;
mod hints;
mod index;
mod neighbors;
mod objects;
mod outbox;
mod retrieval;
mod scan;
mod serve;
#[cfg(test)]
pub(crate) mod tests;
mod view;

use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;

use crate::epoch::local::{ChangeError, LocalEdit, Published};
use crate::epoch::{Epoch, GroupState, Merge, Outcome, Rejection, Sender};
use crate::error::Error;
use crate::event::{Body, MessageEvent, Payload};
use crate::ids::{ChatId, EventId, GossipId, SyncObjId};
use crate::rng::{Randomness, uniform_below};
use crate::root::Root;
use crate::store::overlay::Overlay;
use crate::store::{Storage, StorageError};
use crate::wire::{self, EventObject, Frame};

pub use actions::{GroupChange, LeaveChoice, SUCCESSOR_MAX_WAIT_MS, SUCCESSOR_QUIET_MS};
pub use direct::{CONSENT_MS, DEVICE, GroupOptions, KNOWN_FORMAT_VERSIONS};
#[cfg(test)]
pub(crate) use index::CREDIBLE;
pub use outbox::Outgoing;
use records::{HintKey, NodeStorage, Tables, Target, TaskKey, TriggerKind, WorkKey};
use timing::EDGES_PER_TURN;
pub use view::{Change, GroupSummary, InvitationSummary, MyStatus, TimelineItem, TimelineLine};

/// Why an engine operation failed. Nothing was committed.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum NodeError {
    /// A storage failure.
    #[error(transparent)]
    Storage(#[from] StorageError),
    /// A local change was refused.
    #[error(transparent)]
    Change(#[from] ChangeError),
    /// The epoch is not installed.
    #[error("unknown epoch")]
    UnknownEpoch,
    /// The handle is not in flight.
    #[error("unknown handle")]
    UnknownHandle,
    /// A root or signed object could not be built.
    #[error(transparent)]
    Root(#[from] Error),
    /// The action needs the owner of the current epoch.
    #[error("not the owner")]
    NotOwner,
    /// The action is not allowed in the group's state.
    #[error("not allowed")]
    NotAllowed,
    /// Competing ends wait for a resolution, or there are none to resolve (§4.9).
    #[error("fork")]
    Fork,
    /// The keys of the identity are not held (§4.3).
    #[error("unknown keys")]
    UnknownKeys,
}

impl From<NodeError> for ChangeError {
    fn from(e: NodeError) -> Self {
        match e {
            NodeError::Storage(s) => ChangeError::Storage(s),
            NodeError::Change(c) => c,
            other => ChangeError::Storage(StorageError(other.to_string())),
        }
    }
}

/// An epoch as the caller installs it.
#[derive(Debug, Clone)]
pub struct EpochConfig {
    /// The root.
    pub root: Root,
    /// Whether the epoch is accepted (§4.8).
    pub accepted: bool,
    /// The state of its group (§10.4).
    pub group_state: GroupState,
    /// Its removed peers (§10.4): members of this epoch that are not members of the
    /// device's current epoch, computed by the group layer. Empty for a current epoch.
    pub removed: BTreeSet<GossipId>,
}

/// Counters of what the engine did, in memory only (for tests and simulations).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Stats {
    /// Plaintexts handed off.
    pub plaintexts: u64,
    /// Their bytes.
    pub bytes: u64,
    /// Lookup entries (event and sync-object) handed off.
    pub lookup_entries: u64,
    /// Tip-scan page requests handed off.
    pub scan_requests: u64,
    /// Full events handed off.
    pub full_events: u64,
    /// Notice entries handed off.
    pub notice_entries: u64,
    /// Answers handed off.
    pub answers: u64,
    /// Answers refused with `busy` (request budget or scan limits).
    pub busy_sent: u64,
    /// Received plaintexts.
    pub received: u64,
    /// Invalid answers and frames received.
    pub invalid: u64,
    /// Events received with a timestamp beyond `now + 5 min` (§9.6).
    pub temporarily_invalid: u64,
    /// Penalties given.
    pub penalties: u64,
    /// Retrieval tasks created.
    pub tasks_created: u64,
    /// Tasks resolved.
    pub tasks_resolved: u64,
    /// Tasks paused.
    pub tasks_paused: u64,
    /// Paused tasks renewed.
    pub tasks_renewed: u64,
    /// Tasks dropped at their lookup deadline.
    pub tasks_expired: u64,
    /// Missing IDs refused because the queue was full.
    pub backpressure: u64,
    /// Stages that timed out (tasks and scans).
    pub timeouts: u64,
    /// Resends after `expired`.
    pub expired_resends: u64,
    /// Scans started (fresh scan IDs included).
    pub scans_started: u64,
    /// Scans completed with a final page.
    pub scans_completed: u64,
    /// Scans that ended otherwise (exhausted, invalid, not available).
    pub scans_ended: u64,
    /// `restart` received.
    pub restarts: u64,
    /// Neighbors replaced for failing to answer.
    pub neighbors_replaced: u64,
    /// Pending work invalidated by pruning or authorization.
    pub invalidated: u64,
    /// Roots created by this device as owner.
    pub roots_created: u64,
    /// Kicks created.
    pub kicks_created: u64,
    /// Members an owner's root dropped from a parent epoch owned by another identity (a
    /// former owner's branch) and from none of its own: no kick can tell them (§5.6).
    pub removed_without_kick: u64,
    /// Signed leaves and declines sent.
    pub leaves_sent: u64,
    /// Signed objects verified and stored.
    pub signed_stored: u64,
    /// Failed root announcements (§11.8).
    pub failed_announcements: u64,
    /// Pauses of a peer's root announcements (§11.8).
    pub announcer_pauses: u64,
    /// Kicks or leaves sent to removed peers (§5.6).
    pub removal_replies: u64,
    /// Handover roots sent to their former owner (§5.6).
    pub handover_replies: u64,
    /// Handover roots of this device's own, in which it is no member, received while it
    /// still owned their line: it learnt that it left.
    pub handovers_learnt: u64,
    /// Owner-only requests processed (§5.4).
    pub leave_requests: u64,
    /// Successors created automatically after leaves or requests (§5.5).
    pub auto_successors: u64,
    /// Key answers that did not hash to the requested identity (§12.9).
    pub wrong_keys: u64,
    /// Edits in an older epoch sent to a member of both epochs for lack of a neighbor
    /// (§10.4, D.8).
    pub old_epoch_fallbacks: u64,
    /// Root notices sent to a scan responder that did not hold the anchor (§12.1).
    pub anchor_notices: u64,
    /// Records refused at a limit (invitations, fetched parents, markers, held roots,
    /// unverified leaves).
    pub capped: u64,
}

/// The result of a sync-object lookup (§12.5).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LookupResult {
    /// An event carrying the responder's current result was received.
    Found(EventId),
    /// No candidate supplied one.
    NotFound,
}

/// The per-operation context: the staged store, the clock, randomness and the traversal
/// budget of the turn (§17.4).
pub(crate) struct Cx<'a> {
    pub(crate) ov: &'a mut dyn Storage,
    pub(crate) now: u64,
    pub(crate) rng: &'a mut dyn Randomness,
    /// Parent edges the traversals of this turn may still examine.
    pub(crate) edges: usize,
}

pub(crate) struct EpochEntry {
    root: Root,
    accepted: bool,
    state: GroupState,
    removed: BTreeSet<GossipId>,
}

impl EpochEntry {
    fn epoch(&self) -> Epoch<'_> {
        Epoch::new(&self.root, self.accepted, self.state)
    }
}

/// How a local publication is disseminated (§10.2).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Form {
    /// The full event to neighbors and extra recipients.
    Full,
    /// Notices only.
    Notice,
}

/// The engine of one device. See the module documentation.
pub struct Node {
    me: GossipId,
    epochs: BTreeMap<ChatId, Arc<EpochEntry>>,
    t: Tables,
    /// Hints by `(used, key)` and by `(first, key)`, derived from the hint records.
    hint_lru: BTreeSet<hints::LruKey>,
    hint_age: BTreeSet<(u64, HintKey)>,
    hint_count: BTreeMap<ChatId, usize>,
    /// Queued full events and notices by event, derived from the queue (§15.1 invalidation).
    work_refs: BTreeMap<(ChatId, EventId), BTreeSet<WorkKey>>,
    outbox: outbox::InFlight,
    sessions: BTreeSet<GossipId>,
    /// The index of the tasks, derived from their records.
    tix: index::TaskIndex,
    stats: Stats,
    /// The groups derived from the epoch records.
    gx: group::GroupIndex,
    /// Epochs whose message records this operation erases.
    erase: BTreeSet<ChatId>,
    /// Which held roots each held root names as a parent, and the reverse (derived).
    ri: group::RootIndex,
    /// What the connection queries answered at the last commit (derived, §5.12).
    conn_view: direct::ConnectionView,
}

impl core::fmt::Debug for Node {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.debug_struct("Node")
            .field("me", &self.me)
            .field("epochs", &self.epochs.keys().collect::<Vec<_>>())
            .field("tasks", &self.t.tasks.len())
            .field("queue", &self.t.queue.len())
            .finish_non_exhaustive()
    }
}

impl Node {
    /// Rebuilds the engine of the device `me` from storage. Epochs are installed afterwards.
    ///
    /// # Errors
    ///
    /// A storage failure.
    pub fn open<S: NodeStorage>(store: &S, me: GossipId) -> Result<Self, NodeError> {
        let mut node = Self {
            me,
            epochs: BTreeMap::new(),
            t: Tables::default(),
            hint_lru: BTreeSet::new(),
            hint_age: BTreeSet::new(),
            hint_count: BTreeMap::new(),
            work_refs: BTreeMap::new(),
            outbox: outbox::InFlight::default(),
            sessions: BTreeSet::new(),
            tix: index::TaskIndex::default(),
            stats: Stats::default(),
            gx: group::GroupIndex::default(),
            erase: BTreeSet::new(),
            ri: group::RootIndex::default(),
            conn_view: direct::ConnectionView::default(),
        };
        node.reload(store)?;
        Ok(node)
    }

    fn reload<S: NodeStorage>(&mut self, store: &S) -> Result<(), NodeError> {
        self.t = Tables::from_records(store.load_node()?);
        self.sanitize_loaded();
        self.erase.clear();
        self.epochs.clear();
        self.rebuild_epochs();
        self.rebuild_root_index();
        self.hint_lru.clear();
        self.hint_age.clear();
        self.hint_count.clear();
        for (k, h) in self.t.hints.iter() {
            self.hint_lru.insert(hints::lru(h.used, *k));
            self.hint_age.insert((h.first, *k));
            *self.hint_count.entry(k.0).or_default() += 1;
        }
        self.tix.clear();
        let keys: Vec<TaskKey> = self.t.tasks.keys().copied().collect();
        for k in keys {
            self.reindex(k);
        }
        self.work_refs.clear();
        let refs: Vec<((ChatId, EventId), WorkKey)> = self
            .t
            .queue
            .iter()
            .filter_map(|(k, w)| outbox::event_ref(w).map(|r| (r, *k)))
            .collect();
        for (r, k) in refs {
            self.work_refs.entry(r).or_default().insert(k);
        }
        self.conn_view = self.connection_view();
        // The plaintexts in flight stay so: a failed operation does not change them, and a
        // fresh engine starts with none, so their work is assembled again.
        Ok(())
    }

    /// Keeps the indices read from storage within their ranges, so that a damaged record
    /// cannot make the engine index out of bounds: lane numbers below 4.
    fn sanitize_loaded(&mut self) {
        let groups: Vec<ChatId> = self
            .t
            .groups
            .iter()
            .filter(|(_, g)| g.cursor >= 4)
            .map(|(k, _)| *k)
            .collect();
        for k in groups {
            if let Some(g) = self.t.groups.get_mut(&k) {
                g.cursor %= 4;
            }
        }
        let scans: Vec<records::ScanKey> = self
            .t
            .scans_out
            .iter()
            .filter(|(_, op)| op.lanes.iter().any(|l| *l >= 4))
            .map(|(k, _)| *k)
            .collect();
        for k in scans {
            if let Some(op) = self.t.scans_out.get_mut(&k) {
                op.lanes.retain(|l| *l < 4);
            }
        }
    }

    /// This device's identity.
    #[must_use]
    pub fn me(&self) -> GossipId {
        self.me
    }

    /// The counters so far (in memory).
    #[must_use]
    pub fn stats(&self) -> &Stats {
        &self.stats
    }

    /// The results of the sync-object lookups completed since the last call.
    ///
    /// The results are stored with the operation that completed the lookup, and removed by
    /// this one: each is reported exactly once, across failed commits and restarts.
    ///
    /// # Errors
    ///
    /// A storage failure; nothing was removed and nothing is returned.
    pub fn take_lookup_results<S: NodeStorage>(
        &mut self,
        store: &mut S,
        now: u64,
        rng: &mut dyn Randomness,
    ) -> Result<Vec<(ChatId, SyncObjId, LookupResult)>, NodeError> {
        if self.t.lookup_results.len() == 0 {
            return Ok(Vec::new());
        }
        self.run(store, now, rng, |n, _cx| {
            let keys: Vec<(ChatId, SyncObjId)> = n.t.lookup_results.keys().copied().collect();
            Ok(keys
                .into_iter()
                .filter_map(|k| n.t.lookup_results.remove(&k).map(|r| (k.0, k.1, r)))
                .collect())
        })
    }

    /// Whether `peer` is currently a neighbor in the group of `chat_id`.
    #[must_use]
    pub fn is_neighbor(&self, chat_id: &ChatId, peer: &GossipId) -> bool {
        self.t
            .groups
            .get(&self.group_of(chat_id))
            .is_some_and(|g| g.neighbors.contains(peer))
    }

    /// The neighbors of the group of `chat_id`.
    #[must_use]
    pub fn neighbors(&self, chat_id: &ChatId) -> Vec<GossipId> {
        self.t
            .groups
            .get(&self.group_of(chat_id))
            .map(|g| g.neighbors.iter().copied().collect())
            .unwrap_or_default()
    }

    /// The number of retrieval tasks and their runs, active and paused.
    #[must_use]
    pub fn task_count(&self) -> (usize, usize) {
        let active = self
            .t
            .tasks
            .iter()
            .filter(|(_, t)| matches!(t.run, records::Run::Active { .. }))
            .count();
        (active, self.t.tasks.len() - active)
    }

    /// The largest number of runs any task has started (1 + renewals).
    #[must_use]
    pub fn max_task_runs(&self) -> u32 {
        self.t.tasks.iter().map(|(_, t)| t.runs).max().unwrap_or(0)
    }

    /// Prints the node records (test debugging).
    #[cfg(test)]
    pub(crate) fn debug_dump(&self, ids: &[EventId]) {
        for (_, g) in self.t.groups.iter() {
            eprintln!(
                "  lanes {:?} cursor {} cycle {}",
                g.lanes,
                g.cursor,
                g.cycle.len()
            );
        }
        for (k, op) in self.t.scans_out.iter() {
            eprintln!("  scan with {:?}: {:?}", k.1, op);
        }
        let mut by_state: BTreeMap<String, usize> = BTreeMap::new();
        for (k, t) in self.t.tasks.iter() {
            let label = match t.run {
                records::Run::Active { attempt, stage, .. } => format!(
                    "active stage {stage} {:?}",
                    attempt.map(|a| matches!(a, records::Attempt::Sent { .. }))
                ),
                records::Run::Paused => "paused".into(),
            };
            *by_state.entry(label).or_default() += 1;
            if let Target::Event(id) = k.target
                && ids.contains(&id)
            {
                eprintln!("  task {:?}: {:?} {:?}", id, t.run, t.candidates);
            }
        }
        eprintln!("  tasks by state {by_state:?}");
        eprintln!("  queue {}", self.t.queue.len());
    }

    /// What is pending, by identity (test checks): outbound scans by scan ID, queued work
    /// items, correlation references. Periodic lanes start new scans for ever; each of
    /// these must end.
    #[cfg(test)]
    pub(crate) fn pending_ids(&self) -> BTreeSet<String> {
        let scans = self
            .t
            .scans_out
            .iter()
            .map(|(_, op)| format!("{:?}", op.scan_id));
        let queue = self.t.queue.keys().map(|k| format!("work {k:?}"));
        let refs = self.t.requests.keys().map(|k| format!("ref {k:?}"));
        scans.chain(queue).chain(refs).collect()
    }

    /// How long the queries of `peer` that timed out in a row waited unanswered (test
    /// checks).
    #[cfg(test)]
    pub(crate) fn unanswered_ms(&self, peer: &GossipId) -> u64 {
        self.t.peers.get(peer).map_or(0, |r| r.unanswered_ms)
    }

    /// The node records (test checks).
    #[cfg(test)]
    pub(crate) fn tables(&self) -> &Tables {
        &self.t
    }

    /// The number of queued work items.
    #[must_use]
    pub fn queued(&self) -> usize {
        self.t.queue.len()
    }

    /// Reports whether a session with `peer` exists, which candidates prefer (§10.1, §11.2,
    /// §12.3). In memory only: the transport reports it again after a restart.
    ///
    /// No plaintext is assembled for a peer reported without a session: its work stays
    /// queued (bounded and expiring as usual) until a session is reported again.
    pub fn set_session(&mut self, peer: GossipId, has_session: bool) {
        if has_session {
            self.sessions.insert(peer);
        } else {
            self.sessions.remove(&peer);
        }
        self.session_changed(peer, has_session);
    }

    // ── Operations ───────────────────────────────────────────────────────────

    /// Runs `f` as one operation: what is due in the epochs is applied first, then `f`, then
    /// the scheduling pass; all their writes are committed together, or not at all.
    fn run<S: NodeStorage, T>(
        &mut self,
        store: &mut S,
        now: u64,
        rng: &mut dyn Randomness,
        f: impl FnOnce(&mut Self, &mut Cx<'_>) -> Result<T, NodeError>,
    ) -> Result<T, NodeError> {
        let result = {
            let mut ov = Overlay::new(&*store);
            let r = {
                let mut cx = Cx {
                    ov: &mut ov,
                    now,
                    rng,
                    edges: EDGES_PER_TURN,
                };
                self.apply_due(&mut cx)
                    .and_then(|()| f(self, &mut cx))
                    .and_then(|v| {
                        self.reconsider(&mut cx)?;
                        self.schedule(&mut cx)?;
                        self.connections_changed(&mut cx);
                        Ok(v)
                    })
            };
            r.map(|v| (v, ov.into_changes()))
        };
        let outcome = result.and_then(|(v, epochs)| {
            let node = self.t.take_changes();
            let erase = core::mem::take(&mut self.erase);
            store
                .commit_batch(records::Batch {
                    epochs,
                    node,
                    erase,
                })
                .map_err(NodeError::from)
                .map(|()| v)
        });
        if outcome.is_err() {
            self.reload(store)?;
        }
        outcome
    }

    /// Applies what is due in every epoch, as every operation does first (§7.4: before any
    /// message access or publication), and invalidates the work of what it pruned.
    fn apply_due(&mut self, cx: &mut Cx<'_>) -> Result<(), NodeError> {
        let entries: Vec<(ChatId, Arc<EpochEntry>)> = self
            .epochs
            .iter()
            .map(|(c, e)| (*c, Arc::clone(e)))
            .collect();
        for (chat, entry) in entries {
            let pruned = entry.epoch().tick(cx.ov, cx.now)?;
            self.invalidate(chat, &pruned);
        }
        Ok(())
    }

    /// Installs (or updates) an epoch. When `newly_adopted`, the device scans two members
    /// of it concurrently, preferring existing sessions (§12.3 trigger 1).
    ///
    /// # Errors
    ///
    /// A storage failure.
    ///
    /// This is the low-level path of milestone 3, kept for tests and tools: the epoch is
    /// stored as installed in its own group (or the group it already belongs to), with the
    /// removed peers and group state given added to what the group layer derives. Roots
    /// received, adopted or created by the engine are installed by it, and every installed
    /// epoch is installed again from its record by [`Node::open`].
    pub fn install_epoch<S: NodeStorage>(
        &mut self,
        store: &mut S,
        config: EpochConfig,
        newly_adopted: bool,
        now: u64,
        rng: &mut dyn Randomness,
    ) -> Result<(), NodeError> {
        let chat = config.root.chat_id();
        self.run(store, now, rng, |n, cx| {
            let group = n.group_of(&chat);
            let previous = n.t.epochs.get(&chat).cloned();
            n.put_record(
                chat,
                records::EpochRecord {
                    root: config.root,
                    status: records::EpochStatus::Installed,
                    group,
                    parents: previous
                        .as_ref()
                        .map(|p| p.parents.clone())
                        .unwrap_or_default(),
                    line_time: previous.as_ref().and_then(|p| p.line_time),
                    received_at: previous.as_ref().map_or(cx.now, |p| p.received_at),
                    from: previous.as_ref().map_or(n.me, |p| p.from),
                    removed_override: config.removed,
                    state_override: (config.group_state != GroupState::Active || !config.accepted)
                        .then_some(config.group_state),
                },
            );
            n.group_rec_mut(group);
            n.rebuild_epochs();
            if n.t.groups.get(&group).is_none() {
                n.t.groups.insert(group, records::GroupSync::default());
            }
            n.drop_ineligible_neighbors(group);
            if newly_adopted {
                n.initial_scans(cx, group);
            }
            Ok(())
        })
    }

    /// Processes a plaintext received from the authenticated peer `from` (§13, §15.2): the
    /// version prefix, then every frame on its own; all accepted entries are committed in
    /// one transaction.
    ///
    /// # Errors
    ///
    /// A storage failure; nothing was committed.
    pub fn handle_plaintext<S: NodeStorage>(
        &mut self,
        store: &mut S,
        from: GossipId,
        bytes: &[u8],
        now: u64,
        rng: &mut dyn Randomness,
    ) -> Result<(), NodeError> {
        self.stats.received += 1;
        self.run(store, now, rng, |n, cx| {
            let pt = match wire::decode_plaintext(bytes) {
                Ok(pt) => pt,
                Err(Error::UnsupportedHigherVersion(v)) => {
                    n.version_notice(cx, from, v);
                    return Ok(());
                }
                Err(_) => return Ok(()),
            };
            for frame in pt.frames() {
                match frame {
                    Ok(frame) => n.handle_frame(cx, from, pt.version, frame)?,
                    Err(_) => {
                        // An unparseable frame is rejected (§13.7); a member is penalised
                        // as for one malformed item.
                        if n.shares_epoch(&from) {
                            n.stats.invalid += 1;
                            n.penalize(&from, PENALTY_MALFORMED);
                        }
                    }
                }
            }
            Ok(())
        })
    }

    fn handle_frame(
        &mut self,
        cx: &mut Cx<'_>,
        from: GossipId,
        version: u64,
        frame: Frame,
    ) -> Result<(), NodeError> {
        match frame {
            Frame::Event(blob) => {
                self.receive_blob(cx, from, &blob, version)?;
            }
            Frame::Query(q) => self.handle_query(cx, from, q)?,
            Frame::Response(r) => self.handle_response(cx, from, version, r)?,
            Frame::Notice(n) => self.handle_notice(cx, from, n)?,
            Frame::NeighborRequest(r) => self.handle_neighbor_request(cx, from, r.chat_id),
            Frame::NeighborResponse(r) => self.handle_neighbor_response(cx, from, r),
            Frame::LeaveRequest(r) => self.handle_leave_request(cx, from, r.chat_id),
        }
        Ok(())
    }

    /// Runs everything due at `now`: the epochs' activations and retention (§7.4, §8.1),
    /// retrieval timeouts and deadlines (§11), scan timeouts, frozen-list lifetimes,
    /// periodic lanes (§12.3), neighbor upkeep (§10.1) and hint expiry (§10.3).
    ///
    /// # Errors
    ///
    /// A storage failure; nothing was committed.
    pub fn tick<S: NodeStorage>(
        &mut self,
        store: &mut S,
        now: u64,
        rng: &mut dyn Randomness,
    ) -> Result<(), NodeError> {
        self.tick_with(store, None, now, rng)
    }

    /// [`Node::tick`], with the signer of this device's identity when it may sign: the
    /// owner's automatic successor after leaves and owner-only requests (§5.5) needs it,
    /// and waits for a tick that has it.
    ///
    /// # Errors
    ///
    /// A storage failure, or a root that could not be built; nothing was committed.
    pub fn tick_with<S: NodeStorage>(
        &mut self,
        store: &mut S,
        signer: Option<&dyn crate::keys::IdentitySigner>,
        now: u64,
        rng: &mut dyn Randomness,
    ) -> Result<(), NodeError> {
        self.run(store, now, rng, |n, cx| {
            n.expire_requests(cx.now);
            n.task_timers(cx);
            n.scan_timers(cx);
            n.expire_frozen(cx.now);
            n.group_timers(cx);
            n.direct_timers(cx);
            if let Some(signer) = signer {
                n.remember_own_keys(cx, signer);
                n.auto_successors(cx, signer)?;
            }
            for group in n.sync_groups() {
                n.maintain_neighbors(cx, group);
                n.run_lanes(cx, group);
            }
            n.expire_hints(cx.now);
            Ok(())
        })
    }

    /// When [`Node::tick`] should next run: the earliest due time among the epochs' pending
    /// items (clamped to 2 hours, §7.4), local query deadlines, lookup deadlines, scan
    /// timers, frozen-list lifetimes, lanes, neighbor requests and hints.
    ///
    /// # Errors
    ///
    /// A storage failure.
    pub fn next_wakeup<S: NodeStorage>(
        &self,
        store: &S,
        now: u64,
    ) -> Result<Option<u64>, NodeError> {
        let mut at: Option<u64> = None;
        let mut add = |t: u64| at = Some(at.map_or(t, |a: u64| a.min(t)));
        for entry in self.epochs.values() {
            if let Some(t) = entry.epoch().next_wakeup(store, now)? {
                add(t);
            }
        }
        self.timer_wakeups(now, &mut add);
        if let Some(t) = self.group_wakeup() {
            add(t);
        }
        if let Some(t) = self.direct_wakeup() {
            add(t);
        }
        // Roots left to adopt by the bounded worklist of the last operation.
        if !self.ri.dirty.is_empty() {
            add(now);
        }
        Ok(at)
    }

    // ── Local actions (§7, §9, §10.2) ─────────────────────────────────────────

    /// Publishes a new message (§7.2) and sends it in full to the neighbors (§10.2).
    ///
    /// # Errors
    ///
    /// [`NodeError`]; nothing was committed.
    #[allow(clippy::too_many_arguments)]
    pub fn publish_message<S: NodeStorage>(
        &mut self,
        store: &mut S,
        chat_id: ChatId,
        body: Body,
        metadata: BTreeMap<String, Vec<u8>>,
        scheduled_for: Option<u64>,
        now: u64,
        rng: &mut dyn Randomness,
    ) -> Result<Published, NodeError> {
        let me = self.me;
        // A new message is published in the current epoch of its group (§10.4).
        if self.current_epoch(&chat_id).is_some_and(|c| c != chat_id) {
            return Err(NodeError::NotAllowed);
        }
        self.publish_with(store, chat_id, now, rng, move |e, ov, now, rng| {
            e.publish_message(ov, now, rng, me, body, metadata, scheduled_for)
        })
    }

    /// Publishes an edit of a message (§7.2).
    ///
    /// # Errors
    ///
    /// [`NodeError`]; nothing was committed.
    #[allow(clippy::too_many_arguments)]
    pub fn publish_edit<S: NodeStorage>(
        &mut self,
        store: &mut S,
        chat_id: ChatId,
        sync_obj_id: SyncObjId,
        body: Body,
        metadata: impl Into<crate::MetadataPatch>,
        scheduled_for: Option<u64>,
        now: u64,
        rng: &mut dyn Randomness,
    ) -> Result<Published, NodeError> {
        let metadata: crate::MetadataPatch = metadata.into();
        self.publish_with(store, chat_id, now, rng, move |e, ov, now, rng| {
            e.publish_edit(ov, now, rng, sync_obj_id, body, metadata, scheduled_for)
        })
    }

    /// Publishes a deletion (§7.4); in an epoch with removed peers it is also pushed to
    /// each of them (§10.4).
    ///
    /// # Errors
    ///
    /// [`NodeError`]; nothing was committed.
    pub fn publish_deletion<S: NodeStorage>(
        &mut self,
        store: &mut S,
        chat_id: ChatId,
        sync_obj_id: SyncObjId,
        scheduled_for: Option<u64>,
        now: u64,
        rng: &mut dyn Randomness,
    ) -> Result<Published, NodeError> {
        self.publish_with(store, chat_id, now, rng, move |e, ov, now, rng| {
            e.publish_deletion(ov, now, rng, sync_obj_id, scheduled_for)
        })
    }

    /// Retry synchronisation of a message (§9.4).
    ///
    /// # Errors
    ///
    /// [`NodeError`]; nothing was committed.
    pub fn retry<S: NodeStorage>(
        &mut self,
        store: &mut S,
        chat_id: ChatId,
        sync_obj_id: SyncObjId,
        now: u64,
        rng: &mut dyn Randomness,
    ) -> Result<Published, NodeError> {
        self.publish_with(store, chat_id, now, rng, move |e, ov, now, rng| {
            e.retry(ov, now, rng, sync_obj_id)
        })
    }

    fn publish_with<S: NodeStorage>(
        &mut self,
        store: &mut S,
        chat_id: ChatId,
        now: u64,
        rng: &mut dyn Randomness,
        op: impl FnOnce(
            Epoch<'_>,
            &mut dyn Storage,
            u64,
            &mut dyn Randomness,
        ) -> Result<Published, ChangeError>,
    ) -> Result<Published, NodeError> {
        let entry = self.entry(&chat_id)?;
        let group = self.group_of(&chat_id);
        // A read-only, waiting or dissolved group has its composer disabled (§5.4, §5.6,
        // §5.8), and the owner sends nothing while competing ends wait for its resolution
        // (§4.9).
        if self.group_status(&group) != records::GroupStatus::Active
            || entry.state != GroupState::Active
        {
            return Err(NodeError::NotAllowed);
        }
        if self
            .current_epoch(&group)
            .and_then(|c| self.epochs.get(&c))
            .is_some_and(|e| e.root.owner_id() == self.me)
            && !self.fork_to_resolve(&group).is_empty()
        {
            return Err(NodeError::Fork);
        }
        self.run(store, now, rng, |n, cx| {
            let published = op(entry.epoch(), cx.ov, cx.now, cx.rng)?;
            n.invalidate(chat_id, &published.pruned);
            n.resolve(TaskKey {
                chat_id,
                target: Target::Event(published.event.event_id()),
            });
            if published.merge != Merge::Lost {
                n.disseminate_own(cx, &entry, &published.event)?;
            }
            Ok(published)
        })
    }

    /// A local-only edit (§9.1, §9.3): nothing is sent, and pending work that refers to the
    /// withdrawn events is invalidated in the same commit.
    ///
    /// # Errors
    ///
    /// [`NodeError`]; nothing was committed.
    pub fn local_edit<S: NodeStorage>(
        &mut self,
        store: &mut S,
        chat_id: ChatId,
        sync_obj_id: SyncObjId,
        edit: LocalEdit,
        now: u64,
        rng: &mut dyn Randomness,
    ) -> Result<Vec<EventId>, NodeError> {
        let entry = self.entry(&chat_id)?;
        self.run(store, now, rng, |n, cx| {
            let pruned = entry.epoch().local_edit(cx.ov, cx.now, sync_obj_id, edit)?;
            n.invalidate(chat_id, &pruned);
            Ok(pruned)
        })
    }

    /// A local-only deletion (§9.2, §9.3).
    ///
    /// # Errors
    ///
    /// [`NodeError`]; nothing was committed.
    pub fn local_delete<S: NodeStorage>(
        &mut self,
        store: &mut S,
        chat_id: ChatId,
        sync_obj_id: SyncObjId,
        now: u64,
        rng: &mut dyn Randomness,
    ) -> Result<Vec<EventId>, NodeError> {
        let entry = self.entry(&chat_id)?;
        self.run(store, now, rng, |n, cx| {
            let pruned = entry.epoch().local_delete(cx.ov, cx.now, sync_obj_id)?;
            n.invalidate(chat_id, &pruned);
            Ok(pruned)
        })
    }

    /// Starts a sync-object lookup (§12.5), or joins the one in progress for the same
    /// target. Its result is reported by [`Node::take_lookup_results`].
    ///
    /// # Errors
    ///
    /// [`NodeError::UnknownEpoch`] or a storage failure.
    pub fn lookup_sync_object<S: NodeStorage>(
        &mut self,
        store: &mut S,
        chat_id: ChatId,
        sync_obj_id: SyncObjId,
        now: u64,
        rng: &mut dyn Randomness,
    ) -> Result<(), NodeError> {
        self.entry(&chat_id)?;
        self.run(store, now, rng, |n, cx| {
            n.trigger(
                cx,
                TaskKey {
                    chat_id,
                    target: Target::SyncObj(sync_obj_id),
                },
                None,
            );
            Ok(())
        })
    }

    /// A connection reset with `peer` (§12.3 trigger 2): scan it immediately in every group
    /// it is eligible in, resend the still-relevant queries outstanding with it, and renew
    /// the paused tasks it can serve (§11.5).
    ///
    /// # Errors
    ///
    /// A storage failure.
    pub fn peer_reconnected<S: NodeStorage>(
        &mut self,
        store: &mut S,
        peer: GossipId,
        now: u64,
        rng: &mut dyn Randomness,
    ) -> Result<(), NodeError> {
        self.session_changed(peer, true);
        self.run(store, now, rng, |n, cx| {
            n.reconnected(cx, peer);
            Ok(())
        })
    }

    // ── Epochs and membership ────────────────────────────────────────────────

    fn entry(&self, chat: &ChatId) -> Result<Arc<EpochEntry>, NodeError> {
        self.epochs
            .get(chat)
            .cloned()
            .ok_or(NodeError::UnknownEpoch)
    }

    /// Whether `peer` is a member of an installed epoch.
    fn shares_epoch(&self, peer: &GossipId) -> bool {
        self.epochs
            .iter()
            .any(|(c, e)| e.root.is_member(peer) && self.serves(c))
    }

    /// Whether this device answers for the installed epoch `chat` like a member: its group
    /// is active. A device that was kicked, left, waits for a kick or saw its group dissolved
    /// answers "not available" for its epochs, as for an epoch it does not hold (§5.4, §5.6,
    /// §5.8; the dissolve message itself stays served, see `serve.rs`).
    pub(crate) fn serves(&self, chat: &ChatId) -> bool {
        self.installed(chat) && self.group_status(chat) == records::GroupStatus::Active
    }

    /// Whether `peer` may receive an event of `chat` (§10.2, §10.4): a member other than
    /// this device, and not a removed peer unless the event is a deletion.
    fn may_receive(&self, chat: &ChatId, peer: &GossipId, deletion: bool) -> bool {
        *peer != self.me
            && self
                .epochs
                .get(chat)
                .is_some_and(|e| e.root.is_member(peer) && (deletion || !e.removed.contains(peer)))
    }

    /// The members of `chat` other than this device and its removed peers: the peers that
    /// may receive anything of it, the candidates of its retrieval and its neighbors.
    fn eligible(&self, chat: &ChatId) -> Vec<GossipId> {
        self.epochs
            .get(chat)
            .map(|e| {
                e.root
                    .members()
                    .iter()
                    .filter(|m| **m != self.me && !e.removed.contains(m))
                    .copied()
                    .collect()
            })
            .unwrap_or_default()
    }

    fn removed_peer(&self, chat: &ChatId, peer: &GossipId) -> bool {
        self.epochs
            .get(chat)
            .is_some_and(|e| e.removed.contains(peer))
    }

    // ── Receiving events (§6.3, §10.3, §11.1) ────────────────────────────────

    /// Receives an event blob from `from` in an event frame (§13.2).
    fn receive_blob(
        &mut self,
        cx: &mut Cx<'_>,
        from: GossipId,
        blob: &[u8],
        version: u64,
    ) -> Result<retrieval::Answer, NodeError> {
        let event = match wire::decode_event_blob(blob, version) {
            Ok(EventObject::Message(e)) => {
                // A message event frame is taking part in a chat of two (§5.12).
                self.note_participation(&e.chat_id(), from);
                e
            }
            Ok(EventObject::Root(r)) => return self.receive_root(cx, from, *r, group::Via::Direct),
            Ok(EventObject::Leave(l)) => {
                return self.receive_signed(cx, from, records::SignedObject::Leave(l), None);
            }
            Ok(EventObject::Kick(k)) => {
                return self.receive_signed(cx, from, records::SignedObject::Kick(k), None);
            }
            Ok(EventObject::Dissolve(d)) => {
                return self.receive_signed(cx, from, records::SignedObject::Dissolve(d), None);
            }
            Err(_) => {
                if self.shares_epoch(&from) {
                    self.stats.invalid += 1;
                    self.penalize(&from, PENALTY_MALFORMED);
                }
                return Ok(retrieval::Answer::Invalid);
            }
        };
        self.receive_event(cx, from, event)
    }

    /// Receives a message event from `from` (§6.3), in an event frame or an answer: hints
    /// (§10.3), the task it resolves (§11.1), retrieval of its unknown parents with `from`
    /// as the triggering candidate, and the relay of a newly accepted, available event by
    /// notices (§10.2). Returns how a task counts it as an answer.
    pub(crate) fn receive_event(
        &mut self,
        cx: &mut Cx<'_>,
        from: GossipId,
        event: MessageEvent,
    ) -> Result<retrieval::Answer, NodeError> {
        let chat = event.chat_id();
        // Frames for unknown epochs are dropped without staging (§13.7).
        let Some(entry) = self.epochs.get(&chat).cloned() else {
            return Ok(retrieval::Answer::Invalid);
        };
        let id = event.event_id();
        let sender = Sender::Peer {
            id: from,
            removed: entry.removed.contains(&from),
        };
        // A removed peer is told of its removal, a former owner of its handover (§5.6).
        self.removed_contact(cx, chat, from);
        let received = entry
            .epoch()
            .receive(cx.ov, sender, event.clone(), cx.now)?;
        self.invalidate(chat, &received.pruned);
        match received.outcome {
            Outcome::Rejected(Rejection::Invalid(_)) => {
                self.stats.invalid += 1;
                self.penalize(&from, PENALTY_MALFORMED);
                // Penalised here once; for its task the peer only fails for the run.
                Ok(retrieval::Answer::Refused)
            }
            // Silently dropped: not a member, removed, not accepted, a group state. Nothing
            // the sender did wrong: the peer fails for the run, without a penalty.
            Outcome::Rejected(_) => Ok(retrieval::Answer::Refused),
            Outcome::TemporarilyInvalid => {
                self.stats.temporarily_invalid += 1;
                Ok(retrieval::Answer::TemporarilyInvalid)
            }
            outcome => {
                // `from` holds E in full (§10.3), and is responsive (§10.1).
                self.answered(&from);
                self.mark_seen(cx, chat, from, id)?;
                self.supplied(&from, chat, Target::Event(id));
                if let Outcome::Accepted(merge) = outcome {
                    // A superseded chat of two takes what its members send it, and fetches
                    // and relays nothing (§5.12).
                    let relays = !matches!(
                        self.group_status(&chat),
                        records::GroupStatus::Superseded { .. }
                    );
                    for parent in event.parents().iter().filter(|_| relays) {
                        self.want_event(cx, chat, *parent, Some(from), TriggerKind::Child)?;
                    }
                    if relays
                        && merge != Merge::Lost
                        && entry.epoch().serve(cx.ov, &id, cx.now)?.is_some()
                    {
                        self.disseminate(cx, &entry, &event, Form::Notice, false)?;
                    }
                    let group = self.group_of(&chat);
                    self.changed(group, records::ChangeKind::Messages, cx.now);
                }
                Ok(retrieval::Answer::Supplied)
            }
        }
    }

    // ── Dissemination (§10.2, §10.4) ─────────────────────────────────────────

    /// Disseminates an event published by this device: in full when it is a deletion or
    /// attributed to this device, by notices otherwise (a fabricated message or an edit of
    /// another member's message looks like a relay, §10.2). A deletion in an epoch with
    /// removed peers is also pushed in full to each of them (§10.4).
    fn disseminate_own(
        &mut self,
        cx: &mut Cx<'_>,
        entry: &EpochEntry,
        event: &MessageEvent,
    ) -> Result<(), NodeError> {
        let form = match event.payload() {
            Payload::Delete { .. } => Form::Full,
            Payload::Content(c) if c.author == self.me => Form::Full,
            Payload::Content(_) => Form::Notice,
        };
        self.disseminate(cx, entry, event, form, true)
    }

    /// Sends `event` to the neighbors that may receive it and to up to
    /// `min(2, eligible − eligible neighbors)` eligible non-neighbors drawn uniformly once
    /// for this dissemination, in `form` (§10.2). Notices are suppressed by hints (§10.3).
    fn disseminate(
        &mut self,
        cx: &mut Cx<'_>,
        entry: &EpochEntry,
        event: &MessageEvent,
        form: Form,
        own: bool,
    ) -> Result<(), NodeError> {
        let chat = entry.root.chat_id();
        let id = event.event_id();
        let deletion = matches!(event.payload(), Payload::Delete { .. });
        let eligible: Vec<GossipId> = entry
            .root
            .members()
            .iter()
            .filter(|m| self.may_receive(&chat, m, deletion))
            .copied()
            .collect();
        let neighbors: Vec<GossipId> = eligible
            .iter()
            .filter(|m| self.is_neighbor(&chat, m))
            .copied()
            .collect();
        let mut others: Vec<GossipId> = eligible
            .iter()
            .filter(|m| !self.is_neighbor(&chat, m))
            .copied()
            .collect();
        let extra = 2.min(others.len());
        let mut recipients = neighbors;
        // §10.4, D.8 (choice A): an edit in an older epoch with no neighbor member of it
        // also goes to one random member of both that epoch and the current one.
        let group = self.group_of(&chat);
        if own
            && !deletion
            && recipients.is_empty()
            && let Some(cur) = self.current_epoch(&group).filter(|c| *c != chat)
            && let Some(cur_root) = self.epochs.get(&cur).map(|e| e.root.clone())
        {
            let both: Vec<GossipId> = others
                .iter()
                .filter(|m| cur_root.is_member(m))
                .copied()
                .collect();
            if !both.is_empty() {
                let pick = both[uniform_below(cx.rng, both.len())];
                others.retain(|m| *m != pick);
                recipients.push(pick);
                self.stats.old_epoch_fallbacks += 1;
            }
        }
        let extra = extra.min(others.len());
        for i in 0..extra {
            let j = i + uniform_below(cx.rng, others.len() - i);
            others.swap(i, j);
            recipients.push(others[i]);
        }
        // §10.4: the author of a deletion pushes it to every removed peer.
        if own && deletion {
            for r in &entry.removed {
                if !recipients.contains(r) && self.may_receive(&chat, r, true) {
                    recipients.push(*r);
                }
            }
        }
        for peer in recipients {
            match form {
                Form::Full => self.queue_full(peer, chat, id),
                Form::Notice => self.queue_notice(cx, peer, chat, id),
            }
        }
        Ok(())
    }

    /// Invalidates the pending work that refers to events just pruned (§9.3, §15.1).
    fn invalidate(&mut self, chat: ChatId, pruned: &[EventId]) {
        if !pruned.is_empty() {
            self.stale_in_flight(chat, pruned);
        }
        for id in pruned {
            if let Some(keys) = self.work_refs.remove(&(chat, *id)) {
                for k in keys {
                    if self.t.queue.remove(&k).is_some() {
                        self.stats.invalidated += 1;
                    }
                }
            }
        }
    }

    // ── Peer score (§11.8) ────────────────────────────────────────────────────

    fn peer_mut(&mut self, peer: &GossipId) -> &mut records::PeerRecord {
        if !self.t.peers.contains(peer) {
            self.t.peers.insert(
                *peer,
                records::PeerRecord {
                    supplied: 0,
                    penalty: 0,
                    failures: 0,
                    unanswered_ms: 0,
                    last_failure: 0,
                    last_timeout_query: 0,
                    requests: timing::Bucket::full(timing::REQUEST_BURST, 0),
                    responses: timing::Bucket::full(timing::RESPONSE_BURST, 0),
                    version_notices: BTreeMap::new(),
                    version: None,
                    failed_announcements: Vec::new(),
                    paused_until: 0,
                    pause_ms: 0,
                },
            );
        }
        self.t.peers.get_mut(peer).expect("inserted")
    }

    /// The score of a peer in millionths: `(supplied + 1) / (supplied + penalty + 2)`, so
    /// that an unmeasured peer scores 0.5 (§10.1). The formula is deferred (§17.5); this one
    /// only keeps the direction and the order of the penalties of §11.8.
    #[must_use]
    pub fn score(&self, peer: &GossipId) -> u64 {
        let (s, p) = self
            .t
            .peers
            .get(peer)
            .map_or((0, 0), |r| (u64::from(r.supplied), u64::from(r.penalty)));
        (s + 1) * 1_000_000 / (s + p + 2)
    }

    fn penalize(&mut self, peer: &GossipId, weight: u32) {
        self.stats.penalties += 1;
        let r = self.peer_mut(peer);
        r.penalty = r.penalty.saturating_add(weight);
        decay(r);
    }

    fn reward(&mut self, peer: &GossipId) {
        let r = self.peer_mut(peer);
        r.supplied = r.supplied.saturating_add(1);
        r.failures = 0;
        r.unanswered_ms = 0;
        decay(r);
    }

    /// Any valid answer: the peer is responsive (§10.1), and not busy any more.
    fn answered(&mut self, peer: &GossipId) {
        self.not_busy(peer);
        if self.t.peers.get(peer).is_some_and(|r| r.failures != 0) {
            let r = self.peer_mut(peer);
            r.failures = 0;
            r.unanswered_ms = 0;
        }
    }
}

/// Penalty of a wrong answer to a key query: the heaviest (§11.8, 1). Unused until key
/// queries exist (milestone 4).
pub const PENALTY_KEY_ANSWER: u32 = 64;
/// Penalty of a failed root announcement: large (§11.8, 2). Unused until roots exist.
pub const PENALTY_ROOT_ANNOUNCEMENT: u32 = 16;
/// Penalty of an invalid answer or frame, or of skipped entries (§11.4, D.23). Not ranked
/// by §11.8; placed between a failed root announcement and an unavailable event.
pub const PENALTY_MALFORMED: u32 = 4;
/// Penalty of an announced event that is then "not available": small (§11.8, 3).
pub const PENALTY_UNAVAILABLE: u32 = 1;

/// Halves both counts once they are large, so that old behavior fades.
fn decay(r: &mut records::PeerRecord) {
    if u64::from(r.supplied) + u64::from(r.penalty) > 1024 {
        r.supplied /= 2;
        r.penalty /= 2;
    }
}
