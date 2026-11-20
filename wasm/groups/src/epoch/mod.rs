//! The message state of one epoch: receiving events (§6.3, §9.5, §9.6), merging results
//! (§7.1), scheduled versions and deletions (§7.3, §7.4), retention and eviction (§8), and
//! the local changes of §9 ([`local`]).
//!
//! Every operation takes the local clock `now` (and, when it creates something, a
//! [`Randomness`](crate::Randomness)) as an argument, first applies what is due at `now`
//! (activations, then retention pruning), and commits all its writes in one
//! [`Changes`](crate::store::Changes) (§15.2).

pub mod local;
#[cfg(test)]
pub(crate) mod tests;

use crate::constants::RETENTION_MS;
use crate::dag;
use crate::error::Error;
use crate::event::{Content, MessageEvent, Payload};
use crate::ids::{ChatId, EventId, GossipId, SyncObjId};
use crate::root::Root;
use crate::store::tx::Tx;
use crate::store::{
    EventRow, ObjectRecord, PendingKind, Role, RowState, Storage, StorageError, StorageRead,
    StoredResult, in_window,
};
use crate::wire::{self, EventObject};

/// The longest wait of a scheduled-deletion timer (§7.4, Appendix B): 2 hours.
pub const MAX_TIMER_WAIT_MS: u64 = 2 * 60 * 60 * 1000;

/// The state of the group an epoch belongs to, as far as incoming events are concerned
/// (§10.4 "Groups in a special state").
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GroupState {
    /// Normal.
    Active,
    /// A read-only archive after a kick (§5.6): deletion events are applied, every other
    /// event is dropped.
    ReadOnlyAfterKick,
    /// Waiting for a kick (§5.4): every event is dropped.
    Waiting,
    /// Dissolved (§5.8): every event is dropped.
    Dissolved,
    /// A superseded chat of two (§5.12): events are received, nothing local is made.
    Superseded,
}

/// Who handed the event to this device.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Sender {
    /// This device created it (§9).
    Local,
    /// The immediate, authenticated Agraphon peer.
    Peer {
        /// Its GossipID.
        id: GossipId,
        /// Whether it is a removed peer for this epoch (§10.4), as computed by the caller from
        /// the device's current epoch.
        removed: bool,
    },
}

/// Why a received message event was dropped.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Rejection {
    /// The epoch is installed but not accepted (§4.8, §6.3).
    NotAccepted,
    /// The immediate peer is not a member of the epoch (§6.2, §6.3).
    PeerNotMember,
    /// The immediate peer is a removed peer for the epoch (§10.4).
    RemovedPeer,
    /// The group's state drops this event (§10.4).
    GroupState,
    /// The blob holds a root or a signed object, not a message event.
    NotAMessageEvent,
    /// The event is invalid: encoding, parents, payload, secret proof or claimed author
    /// (§6.1, §6.2, §4.2, §7.2, §1.1).
    Invalid(Error),
}

/// What merging an event under a new ID did (§7.1, §7.3, §7.4).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Merge {
    /// It replaced the current result (or created it, or deleted the message); the
    /// superseded events were pruned.
    Won,
    /// It lost and was pruned: an older version, or content after a deletion.
    Lost,
    /// It carries the current result and stays available beside the other carriers.
    Identical,
    /// It is kept as a pending future version or as a pending scheduled deletion.
    Pending,
}

/// The outcome of receiving a message event.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    /// Dropped; nothing about the event was stored.
    Rejected(Rejection),
    /// Its timestamp is beyond `now + 5 min`: the content was dropped and a
    /// temporary-rejection marker kept (§7.2, §9.6).
    TemporarilyInvalid,
    /// The ID is already retained: its first valid interpretation is kept and the arrival is
    /// ignored (§7.1).
    Duplicate,
    /// The ID was processed and pruned; the payload equals the current result, the parents
    /// equal the stored parent links and its window is open, so it is available again. It was
    /// not reapplied and is not announced (§9.5, D.33).
    Restored,
    /// The ID was processed and pruned and stays so (§9.5).
    KeptPruned,
    /// A message whose moment, its creation date plus the message timer of the epoch, has
    /// passed (§7.7): dropped, and nothing about it was stored or changed.
    Expired,
    /// Accepted under a new ID and merged.
    Accepted(Merge),
}

/// What receiving a message event did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Received {
    /// The outcome for the event.
    pub outcome: Outcome,
    /// The events this step pruned that were retained before it, ascending: superseded
    /// results, absorbed content, expired carriers (§9.3). Pending outgoing work that refers
    /// to them is to be invalidated.
    pub pruned: Vec<EventId>,
}

impl Received {
    fn nothing(outcome: Outcome) -> Self {
        Self {
            outcome,
            pruned: Vec::new(),
        }
    }
}

/// One epoch, as the engine sees it: its root, whether it was accepted, and the state of its
/// group. Installation, adoption and group states are decided elsewhere.
#[derive(Debug, Clone, Copy)]
pub struct Epoch<'a> {
    root: &'a Root,
    accepted: bool,
    group_state: GroupState,
}

impl<'a> Epoch<'a> {
    /// The epoch founded by `root`.
    #[must_use]
    pub fn new(root: &'a Root, accepted: bool, group_state: GroupState) -> Self {
        Self {
            root,
            accepted,
            group_state,
        }
    }

    /// The epoch's `chat_id`.
    #[must_use]
    pub fn chat_id(&self) -> ChatId {
        self.root.chat_id()
    }

    /// A transaction on this epoch, which knows its message timer (§7.7).
    pub(crate) fn tx<'s, S: StorageRead + ?Sized>(&self, store: &'s S) -> Tx<'s, S> {
        Tx::new(store, self.chat_id()).with_timer(self.root.message_timer())
    }

    /// The root.
    #[must_use]
    pub fn root(&self) -> &'a Root {
        self.root
    }

    /// The acceptance checks of §6.3 that need neither the event nor local state, in the order
    /// listed there: acceptance, membership of the immediate peer, removed peer, and the group
    /// states that drop every event. They run before a blob is decoded, so that what a
    /// non-member sends is classified as such whatever its bytes.
    fn sender_gate(&self, sender: Sender) -> Option<Rejection> {
        if !self.accepted {
            return Some(Rejection::NotAccepted);
        }
        if let Sender::Peer { id, removed } = sender {
            if !self.root.is_member(&id) {
                return Some(Rejection::PeerNotMember);
            }
            if removed {
                return Some(Rejection::RemovedPeer);
            }
        }
        match self.group_state {
            GroupState::Waiting | GroupState::Dissolved => Some(Rejection::GroupState),
            GroupState::Active | GroupState::ReadOnlyAfterKick | GroupState::Superseded => None,
        }
    }

    /// The checks of §6.3 on the decoded event that do not depend on local state: the
    /// read-only archive keeps deletions only, then the event's validity against the root.
    fn event_gate(&self, event: &MessageEvent) -> Option<Rejection> {
        let is_delete = matches!(event.payload(), Payload::Delete { .. });
        if self.group_state == GroupState::ReadOnlyAfterKick && !is_delete {
            return Some(Rejection::GroupState);
        }
        if let Err(e) = event.check_against_root(self.root) {
            return Some(Rejection::Invalid(e));
        }
        None
    }

    /// Receives a message event from `sender` at local time `now` (§6.3, §7, §9.5, §9.6).
    ///
    /// # Errors
    ///
    /// A storage failure; nothing was committed then.
    pub fn receive<S: Storage + ?Sized>(
        &self,
        store: &mut S,
        sender: Sender,
        event: MessageEvent,
        now: u64,
    ) -> Result<Received, StorageError> {
        if let Some(rejection) = self.sender_gate(sender).or_else(|| self.event_gate(&event)) {
            return Ok(Received::nothing(Outcome::Rejected(rejection)));
        }
        let mut tx = self.tx(&*store);
        tick(&mut tx, now)?;
        let outcome = receive_in(&mut tx, event, now)?;
        // An event received after its window is merged, then pruned at once (§8.1).
        expire(&mut tx, now)?;
        let (changes, pruned) = tx.finish()?;
        store.commit(changes)?;
        Ok(Received { outcome, pruned })
    }

    /// Decodes an event blob carried in a plaintext of version `plaintext_version` (§13.1)
    /// and receives it. The checks on the sender and the group state run first, so a blob from
    /// a non-member or a removed peer is rejected as such before it is decoded; then a
    /// malformed blob, or a root or signed object, is rejected.
    ///
    /// # Errors
    ///
    /// A storage failure.
    pub fn receive_blob<S: Storage + ?Sized>(
        &self,
        store: &mut S,
        sender: Sender,
        blob: &[u8],
        plaintext_version: u64,
        now: u64,
    ) -> Result<Received, StorageError> {
        if let Some(rejection) = self.sender_gate(sender) {
            return Ok(Received::nothing(Outcome::Rejected(rejection)));
        }
        match wire::decode_event_blob(blob, plaintext_version) {
            Ok(EventObject::Message(event)) => self.receive(store, sender, event, now),
            Ok(_) => Ok(Received::nothing(Outcome::Rejected(
                Rejection::NotAMessageEvent,
            ))),
            Err(e) => Ok(Received::nothing(Outcome::Rejected(Rejection::Invalid(e)))),
        }
    }

    /// Applies everything due at `now`: pending versions and deletions, in `(due, eventId)`
    /// order (§7.3, §7.4), then retention pruning (§8.1). Callers run it on startup and resume,
    /// from timers ([`Epoch::next_wakeup`]) and before reading the view; every other operation
    /// runs it first. Returns the events it pruned that were retained before (§9.3).
    ///
    /// # Errors
    ///
    /// A storage failure; nothing was committed then.
    pub fn tick<S: Storage + ?Sized>(
        &self,
        store: &mut S,
        now: u64,
    ) -> Result<Vec<EventId>, StorageError> {
        let mut tx = self.tx(&*store);
        tick(&mut tx, now)?;
        let (changes, pruned) = tx.finish()?;
        store.commit(changes)?;
        Ok(pruned)
    }

    /// When the shared apply path should next run: the earliest pending due time, with the
    /// wait clamped to 2 hours (§7.4). `None` when nothing is pending.
    ///
    /// # Errors
    ///
    /// A storage failure.
    pub fn next_wakeup<R: StorageRead + ?Sized>(
        &self,
        store: &R,
        now: u64,
    ) -> Result<Option<u64>, StorageError> {
        let first = store.first_pending(&self.chat_id())?.map(|i| i.due);
        Ok(first.map(|due| match now.checked_add(MAX_TIMER_WAIT_MS) {
            Some(limit) => due.min(limit),
            None => due,
        }))
    }

    /// The tips at `now` (§12.1), which are also the eligible parents (§6.1). Call
    /// [`Epoch::tick`] first so that expired events are pruned.
    ///
    /// # Errors
    ///
    /// A storage failure.
    pub fn tips<R: StorageRead + ?Sized>(
        &self,
        store: &R,
        now: u64,
    ) -> Result<Vec<EventId>, StorageError> {
        dag::tips(store, &self.chat_id(), now)
    }

    /// The event to serve under `event_id` at `now`, under its own version (§13.1): only an
    /// available event. A pending version past its window is retained but not served (§8.1).
    ///
    /// # Errors
    ///
    /// A storage failure.
    pub fn serve<R: StorageRead + ?Sized>(
        &self,
        store: &R,
        event_id: &EventId,
        now: u64,
    ) -> Result<Option<MessageEvent>, StorageError> {
        Ok(store
            .event_row(&self.chat_id(), event_id)?
            .filter(|r| r.available(now))
            .and_then(|r| r.event().cloned()))
    }

    /// Capacity eviction (§8.2): prunes up to `max` available events, oldest event timestamp
    /// first, deletion events included. Pending scheduled events are exempt; current results,
    /// tombstones, stubs and parent links are kept. Returns every ID the operation pruned,
    /// ascending: the evicted events and any that the tick run first pruned (§9.3).
    ///
    /// # Errors
    ///
    /// A storage failure; nothing was committed then.
    pub fn evict<S: Storage + ?Sized>(
        &self,
        store: &mut S,
        now: u64,
        max: usize,
    ) -> Result<Vec<EventId>, StorageError> {
        let mut tx = self.tx(&*store);
        tick(&mut tx, now)?;
        let chat = tx.chat_id();
        // After the tick every carrier is inside its window, hence available.
        let victims: Vec<(EventId, SyncObjId)> = tx
            .carriers(&chat, u64::MAX, max)?
            .into_iter()
            .filter(|r| r.available(now))
            .filter_map(|r| r.event().map(|e| (r.event_id, e.payload().sync_obj_id())))
            .collect();
        for (id, sync) in victims {
            prune_carrier(&mut tx, id, sync)?;
        }
        let (changes, pruned) = tx.finish()?;
        store.commit(changes)?;
        Ok(pruned)
    }

    /// Capacity eviction of temporary-rejection markers (§9.6, D.32): removes up to `max`
    /// markers, oldest event timestamp first. The IDs become unknown again, so a later
    /// advertisement may recreate the retrieval work. Returns the removed IDs.
    ///
    /// # Errors
    ///
    /// A storage failure; nothing was committed then.
    pub fn evict_markers<S: Storage + ?Sized>(
        &self,
        store: &mut S,
        max: usize,
    ) -> Result<Vec<EventId>, StorageError> {
        let mut tx = self.tx(&*store);
        let chat = tx.chat_id();
        let victims = tx.markers(&chat, max)?;
        for id in &victims {
            tx.remove_marker(*id);
        }
        let changes = tx.into_changes();
        store.commit(changes)?;
        Ok(victims)
    }
}

// ── The shared apply path, on a staged transaction ──────────────────────────

/// Activations, then retention pruning.
pub(crate) fn tick<S: StorageRead + ?Sized>(
    tx: &mut Tx<'_, S>,
    now: u64,
) -> Result<(), StorageError> {
    activate_due(tx, now)?;
    expire(tx, now)
}

fn activate_due<S: StorageRead + ?Sized>(tx: &mut Tx<'_, S>, now: u64) -> Result<(), StorageError> {
    let chat = tx.chat_id();
    for item in tx.pending_until(&chat, now)? {
        let Some(mut obj) = tx.object(&item.sync_obj_id)? else {
            continue;
        };
        if item.kind == PendingKind::Expiry {
            // The message timer deletes the message on this device, as a local-only deletion
            // (§7.7, §9.2, §9.3): every device computes the same moment from the dates, so
            // they converge with nothing sent, and what a peer can see afterwards (no event
            // to serve, no tip) is what a local-only deletion leaves.
            if obj.expires_at == Some(item.due) {
                absorb(tx, &mut obj, None)?;
                tx.put_object(obj);
            }
            continue;
        }
        let Some(event) = tx.row(&item.event_id)?.and_then(|r| r.event().cloned()) else {
            continue;
        };
        match item.kind {
            PendingKind::Expiry => {}
            PendingKind::Version => {
                // Skipped if an earlier item of this pass already pruned it.
                if !obj.pending_versions.remove(&(item.due, item.event_id)) {
                    continue;
                }
                // A version that takes effect after the moment of its message is dropped,
                // as it would be on arrival (§7.7).
                if expired(&event, tx.message_timer(), now) {
                    prune(tx, item.event_id);
                } else {
                    merge_effective(tx, &mut obj, event)?;
                }
            }
            PendingKind::Deletion => {
                if !obj.pending_deletions.remove(&(item.due, item.event_id)) {
                    continue;
                }
                absorb(tx, &mut obj, Some(event))?;
            }
        }
        tx.put_object(obj);
    }
    Ok(())
}

/// Prunes every event that carries a current result and whose window has closed (§8.1).
/// Pending events past their window stay, unserved, until they activate.
///
/// Only the carriers whose window has ended are read, through the carriers index: the
/// window of an event ends at `ts + RETENTION`, so they are the carriers with
/// `ts ≤ now − RETENTION`.
pub(crate) fn expire<S: StorageRead + ?Sized>(
    tx: &mut Tx<'_, S>,
    now: u64,
) -> Result<(), StorageError> {
    let chat = tx.chat_id();
    let Some(ts_until) = now.checked_sub(RETENTION_MS) else {
        return Ok(());
    };
    let expired: Vec<(EventId, SyncObjId)> = tx
        .carriers(&chat, ts_until, usize::MAX)?
        .into_iter()
        .filter(|r| !in_window(&r.event_id, now))
        .filter_map(|r| r.event().map(|e| (r.event_id, e.payload().sync_obj_id())))
        .collect();
    for (id, sync) in expired {
        prune_carrier(tx, id, sync)?;
    }
    Ok(())
}

/// Prunes a carrier of the current result and removes it from its object.
fn prune_carrier<S: StorageRead + ?Sized>(
    tx: &mut Tx<'_, S>,
    id: EventId,
    sync: SyncObjId,
) -> Result<(), StorageError> {
    prune(tx, id);
    if let Some(mut obj) = tx.object(&sync)? {
        obj.current_events.remove(&id);
        tx.put_object(obj);
    }
    Ok(())
}

/// Receives an event that passed the gate, after the tick.
pub(crate) fn receive_in<S: StorageRead + ?Sized>(
    tx: &mut Tx<'_, S>,
    event: MessageEvent,
    now: u64,
) -> Result<Outcome, StorageError> {
    let row = tx.row(&event.event_id())?;
    // A message past its moment is refused from its dates alone, whatever this device held
    // (§7.7): nothing is stored, not even a stub or its parent links, so that no parent is
    // looked up for it, and the same arrival always gets the same answer. Every honest device
    // computes the same moment, so none serves it any more either.
    if expired(&event, tx.message_timer(), now) {
        if row.is_some_and(|r| r.state == RowState::TemporarilyInvalid) {
            tx.remove_marker(event.event_id());
        }
        return Ok(Outcome::Expired);
    }
    match row.map(|r| r.state) {
        Some(RowState::Held { .. }) => Ok(Outcome::Duplicate),
        Some(RowState::Pruned) => restore(tx, event, now),
        Some(RowState::TemporarilyInvalid) | None => {
            if event.timestamp_admitted(now) {
                Ok(Outcome::Accepted(apply_new(tx, event, now)?))
            } else {
                tx.put_row(EventRow {
                    event_id: event.event_id(),
                    state: RowState::TemporarilyInvalid,
                });
                Ok(Outcome::TemporarilyInvalid)
            }
        }
    }
}

/// §9.5 for a processed, pruned ID. The event is restored only when its payload projection
/// equals the current result and its parents equal the stored parent links (D.33, choice A:
/// an ID keeps its first valid interpretation entirely, §7.1), while its window is open.
fn restore<S: StorageRead + ?Sized>(
    tx: &mut Tx<'_, S>,
    event: MessageEvent,
    now: u64,
) -> Result<Outcome, StorageError> {
    let chat = tx.chat_id();
    let sync = event.payload().sync_obj_id();
    let Some(mut obj) = tx.object(&sync)? else {
        return Ok(Outcome::KeptPruned);
    };
    let identical = obj
        .current
        .as_ref()
        .is_some_and(|cur| cur.result_hash(&chat, sync) == event.result_hash());
    let same_parents = tx
        .parents(&chat, &event.event_id())?
        .is_some_and(|p| p == event.parents());
    if !identical || !same_parents || !in_window(&event.event_id(), now) {
        return Ok(Outcome::KeptPruned);
    }
    // The same rule as on first arrival (D.31): a scheduled deletion keeps its scheduled form
    // until its own time, beside the tombstone.
    match event.payload() {
        Payload::Delete {
            scheduled_at: Some(due),
            ..
        } if *due > now => {
            let due = *due;
            obj.pending_deletions.insert((due, event.event_id()));
            hold(tx, event, Role::PendingDeletion { due });
        }
        _ => {
            obj.current_events.insert(event.event_id());
            hold(tx, immediate_form(&event), Role::Current);
        }
    }
    tx.put_object(obj);
    Ok(Outcome::Restored)
}

/// Merges an admitted event under a new ID (§7.1, §7.3, §7.4). Its parent links are kept
/// whatever the result.
pub(crate) fn apply_new<S: StorageRead + ?Sized>(
    tx: &mut Tx<'_, S>,
    event: MessageEvent,
    now: u64,
) -> Result<Merge, StorageError> {
    let id = event.event_id();
    tx.put_edges(id, event.parents().to_vec());
    let sync = event.payload().sync_obj_id();
    let mut obj = tx
        .object(&sync)?
        .unwrap_or_else(|| ObjectRecord::empty(sync));
    let merge = match event.payload().clone() {
        Payload::Content(c) => {
            // A deletion has no effect on a reaction (§7.1).
            if obj.is_deleted() && !c.is_reaction() {
                prune(tx, id);
                Merge::Lost
            } else if c.last_modified_at > now {
                obj.pending_versions.insert((c.last_modified_at, id));
                hold(
                    tx,
                    event,
                    Role::PendingVersion {
                        due: c.last_modified_at,
                    },
                );
                Merge::Pending
            } else {
                merge_effective(tx, &mut obj, event)?
            }
        }
        Payload::Delete {
            scheduled_at: Some(due),
            ..
        } if due > now => {
            // Every scheduled deletion is kept in its scheduled form until its own time,
            // whatever the state of the message (D.26, D.31): the earliest one deletes the
            // message, and each is normalised at its own time. Pruning the later ones, as
            // §7.4 says, or normalising them with an earlier one, would make what a device
            // serves depend on arrival timing and local state.
            obj.pending_deletions.insert((due, id));
            hold(tx, event, Role::PendingDeletion { due });
            Merge::Pending
        }
        Payload::Delete { .. } => absorb(tx, &mut obj, Some(event))?,
    };
    tx.put_object(obj);
    Ok(merge)
}

/// Merges an effective non-delete result into the object (§7.1): by [`Content::rank`]; the
/// tombstone absorbs every result but a reaction, which replaces it.
fn merge_effective<S: StorageRead + ?Sized>(
    tx: &mut Tx<'_, S>,
    obj: &mut ObjectRecord,
    event: MessageEvent,
) -> Result<Merge, StorageError> {
    let chat = tx.chat_id();
    let id = event.event_id();
    let Payload::Content(incoming) = event.payload().clone() else {
        unreachable!("only non-delete results are merged here");
    };
    let merge = match &obj.current {
        Some(StoredResult::Tombstone) if !incoming.is_reaction() => {
            prune(tx, id);
            return Ok(Merge::Lost);
        }
        Some(StoredResult::Tombstone) | None => Merge::Won,
        Some(cur @ StoredResult::Content(c)) => {
            let current_key = c.rank(cur.result_hash(&chat, obj.sync_obj_id));
            let incoming_key = incoming.rank(event.result_hash());
            match incoming_key.cmp(&current_key) {
                core::cmp::Ordering::Greater => Merge::Won,
                core::cmp::Ordering::Less => {
                    prune(tx, id);
                    return Ok(Merge::Lost);
                }
                core::cmp::Ordering::Equal => Merge::Identical,
            }
        }
    };
    if merge == Merge::Won {
        for old in core::mem::take(&mut obj.current_events) {
            prune(tx, old);
        }
        obj.expires_at = moment(&incoming, tx.message_timer());
        obj.current = Some(StoredResult::Content(incoming));
    }
    obj.current_events.insert(id);
    hold(tx, event, Role::Current);
    Ok(merge)
}

/// The moment the message timer `timer` deletes the result `content` (§7.7): its creation
/// date plus the timer. `None` with no timer, for a reaction (the timer deletes only what a
/// reaction can point to: a reaction to a deleted message is not shown, §7.6), and when the
/// sum is past the top of the integer range: that moment never comes (exact arithmetic, §1).
pub(crate) fn moment(content: &Content, timer: u64) -> Option<u64> {
    if timer == 0 || content.is_reaction() {
        return None;
    }
    content.created_at.checked_add(timer)
}

/// Whether `event` is a message whose moment has passed at `now` (§7.7).
fn expired(event: &MessageEvent, timer: u64, now: u64) -> bool {
    match event.payload() {
        Payload::Content(c) => moment(c, timer).is_some_and(|m| m <= now),
        Payload::Delete { .. } => false,
    }
}

/// Applies a deletion: the tombstone absorbs the message, and every content event of it
/// (carriers and pending versions) is pruned (§7.1, §7.4). `carrier` is the deletion event,
/// stored in its immediate form; `None` for a local-only deletion.
///
/// A deletion has no effect on a reaction (§7.1, §7.6): when the current result is one, the
/// deletion loses and is pruned; otherwise the tombstone is stored as for any message, but
/// pending versions of a reaction are kept, and a reaction replaces the tombstone when it
/// takes effect ([`merge_effective`]).
///
/// Pending scheduled deletions are left as they are: each keeps its scheduled form until its
/// own time and is normalised then (D.31), so that what a device serves depends only on the
/// event and the clock.
pub(crate) fn absorb<S: StorageRead + ?Sized>(
    tx: &mut Tx<'_, S>,
    obj: &mut ObjectRecord,
    carrier: Option<MessageEvent>,
) -> Result<Merge, StorageError> {
    if matches!(&obj.current, Some(StoredResult::Content(c)) if c.is_reaction()) {
        if let Some(event) = carrier {
            prune(tx, event.event_id());
        }
        return Ok(Merge::Lost);
    }
    let was_deleted = obj.is_deleted();
    if !was_deleted {
        for old in core::mem::take(&mut obj.current_events) {
            prune(tx, old);
        }
        for (due, old) in core::mem::take(&mut obj.pending_versions) {
            if pending_reaction(tx, old)? {
                obj.pending_versions.insert((due, old));
            } else {
                prune(tx, old);
            }
        }
        obj.current = Some(StoredResult::Tombstone);
        obj.expires_at = None;
    }
    if let Some(event) = carrier {
        obj.current_events.insert(event.event_id());
        hold(tx, immediate_form(&event), Role::Current);
    }
    Ok(if was_deleted {
        Merge::Identical
    } else {
        Merge::Won
    })
}

/// Whether the pending version `id` is a reaction.
fn pending_reaction<S: StorageRead + ?Sized>(
    tx: &Tx<'_, S>,
    id: EventId,
) -> Result<bool, StorageError> {
    Ok(tx
        .row(&id)?
        .and_then(|r| r.event().cloned())
        .is_some_and(|e| matches!(e.payload(), Payload::Content(c) if c.is_reaction())))
}

/// The form stored and served once a deletion is applied: without `last_modified_at`, same
/// ID, parents and version (§7.4, §13.1). Any other event is returned unchanged.
pub(crate) fn immediate_form(event: &MessageEvent) -> MessageEvent {
    if !matches!(
        event.payload(),
        Payload::Delete {
            scheduled_at: Some(_),
            ..
        }
    ) {
        return event.clone();
    }
    let mut p = event.to_proto();
    if let Some(payload) = p.payload.as_mut() {
        payload.last_modified_at = None;
    }
    MessageEvent::from_proto(event.version(), p)
        .expect("removing an optional date keeps a valid event valid")
}

pub(crate) fn hold<S: StorageRead + ?Sized>(tx: &mut Tx<'_, S>, event: MessageEvent, role: Role) {
    tx.put_row(EventRow {
        event_id: event.event_id(),
        state: RowState::Held { event, role },
    });
}

/// Removes content access: only the ID stub and its parent links remain (§9.3).
pub(crate) fn prune<S: StorageRead + ?Sized>(tx: &mut Tx<'_, S>, id: EventId) {
    tx.put_row(EventRow {
        event_id: id,
        state: RowState::Pruned,
    });
}

/// Checks that the stored records of an epoch are consistent with each other. Test helper.
#[cfg(test)]
pub(crate) fn check_invariants<R: StorageRead + ?Sized>(
    store: &R,
    chat: &ChatId,
    now: u64,
) -> Result<(), String> {
    use std::collections::{BTreeMap, BTreeSet};
    let rows: BTreeMap<EventId, EventRow> = store
        .event_rows(chat)
        .map_err(|e| e.to_string())?
        .into_iter()
        .map(|r| (r.event_id, r))
        .collect();
    let edges: BTreeSet<EventId> = store
        .edges(chat)
        .map_err(|e| e.to_string())?
        .into_iter()
        .map(|(c, _)| c)
        .collect();
    let mut claimed: BTreeSet<EventId> = BTreeSet::new();
    for obj in store.objects(chat).map_err(|e| e.to_string())? {
        let s = obj.sync_obj_id;
        let mut claim = |id: EventId| {
            if !claimed.insert(id) {
                return Err(format!("{id:?} claimed twice"));
            }
            Ok(())
        };
        for id in &obj.current_events {
            claim(*id)?;
            let row = rows.get(id).ok_or(format!("carrier {id:?} has no row"))?;
            if row.role() != Some(Role::Current) {
                return Err(format!("carrier {id:?} is {:?}", row.state));
            }
            let event = row.event().expect("held");
            let cur = obj.current.as_ref().ok_or("carriers without a result")?;
            if event.result_hash() != cur.result_hash(chat, s) {
                return Err(format!("carrier {id:?} does not carry the current result"));
            }
            if matches!(
                event.payload(),
                Payload::Delete {
                    scheduled_at: Some(_),
                    ..
                }
            ) {
                return Err(format!("carrier {id:?} kept its deletion date"));
            }
            if !in_window(id, now) {
                return Err(format!("carrier {id:?} is past its window"));
            }
        }
        let is_reaction = |id: &EventId| {
            rows.get(id)
                .and_then(EventRow::event)
                .is_some_and(|e| matches!(e.payload(), Payload::Content(c) if c.is_reaction()))
        };
        if obj.is_deleted() && obj.pending_versions.iter().any(|(_, id)| !is_reaction(id)) {
            return Err(format!("{s:?} is deleted but has pending versions"));
        }
        for (due, id) in &obj.pending_versions {
            claim(*id)?;
            let row = rows.get(id).ok_or("pending version without row")?;
            if row.role() != Some(Role::PendingVersion { due: *due }) || *due <= now {
                return Err(format!("pending version {id:?} inconsistent at {now}"));
            }
        }
        for &(due, id) in &obj.pending_deletions {
            claim(id)?;
            let row = rows.get(&id).ok_or("pending deletion without row")?;
            if row.role() != Some(Role::PendingDeletion { due }) || due <= now {
                return Err(format!("pending deletion {id:?} inconsistent at {now}"));
            }
        }
    }
    // A retained event is served with the parents its edges record (D.33).
    let edges_map: BTreeMap<EventId, Vec<EventId>> = store
        .edges(chat)
        .map_err(|e| e.to_string())?
        .into_iter()
        .collect();
    for row in rows.values() {
        if let Some(event) = row.event()
            && edges_map.get(&row.event_id).map(Vec::as_slice) != Some(event.parents())
        {
            return Err(format!("{:?} is held with other parents", row.event_id));
        }
    }
    // Every available event is reachable from the tips through available events (D.27).
    let available: BTreeSet<EventId> = rows
        .values()
        .filter(|r| r.available(now))
        .map(|r| r.event_id)
        .collect();
    let mut reached: BTreeSet<EventId> = BTreeSet::new();
    let mut stack = dag::tips(store, chat, now).map_err(|e| e.to_string())?;
    while let Some(id) = stack.pop() {
        if available.contains(&id) && reached.insert(id) {
            stack.extend(edges_map.get(&id).into_iter().flatten().copied());
        }
    }
    if reached != available {
        return Err("an available event is unreachable from the tips".into());
    }
    // The indexes agree with the records.
    let e = |e: StorageError| e.to_string();
    let held: Vec<EventId> = rows
        .values()
        .filter(|r| matches!(r.state, RowState::Held { .. }))
        .map(|r| r.event_id)
        .collect();
    if store.held_ids(chat).map_err(e)? != held {
        return Err("held index differs".into());
    }
    let carriers: Vec<EventRow> = rows
        .values()
        .filter(|r| r.role() == Some(Role::Current))
        .cloned()
        .collect();
    if store.carriers(chat, u64::MAX, usize::MAX).map_err(e)? != carriers {
        return Err("carriers index differs".into());
    }
    if let Some(mid) = carriers.get(carriers.len() / 2) {
        let ts = mid.event_id.timestamp();
        let until: Vec<EventRow> = carriers
            .iter()
            .filter(|r| r.event_id.timestamp() <= ts)
            .take(3)
            .cloned()
            .collect();
        if store.carriers(chat, ts, 3).map_err(e)? != until {
            return Err("bounded carriers query differs".into());
        }
    }
    let markers: Vec<EventId> = rows
        .values()
        .filter(|r| r.state == RowState::TemporarilyInvalid)
        .map(|r| r.event_id)
        .collect();
    if store.markers(chat, usize::MAX).map_err(e)? != markers {
        return Err("markers index differs".into());
    }
    let mut pending: Vec<crate::store::PendingItem> = store
        .objects(chat)
        .map_err(e)?
        .iter()
        .flat_map(ObjectRecord::pending_items)
        .collect();
    crate::store::sort_pending(&mut pending);
    if store.pending_until(chat, u64::MAX).map_err(e)? != pending
        || store.first_pending(chat).map_err(e)? != pending.first().copied()
    {
        return Err("pending index differs".into());
    }
    for (id, row) in &rows {
        if matches!(row.state, RowState::Held { .. }) && !claimed.contains(id) {
            return Err(format!("held row {id:?} belongs to no object"));
        }
        if row.processed() != edges.contains(id) {
            return Err(format!("{id:?}: processed and edges disagree"));
        }
        if let Some(e) = row.event()
            && e.event_id() != *id
        {
            return Err(format!("{id:?} holds another event"));
        }
    }
    Ok(())
}
