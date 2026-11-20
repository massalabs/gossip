//! The local records of an epoch's message state (§14.1) and the storage abstraction.
//!
//! Three logical records are kept per epoch, all scoped by `chat_id`:
//!
//! - **event rows** keyed by `(chat_id, eventId)`: the event's version and fields while it is
//!   retained, its role (current, pending version, pending deletion), or a pruned stub, or a
//!   temporary-rejection marker (§9.6);
//! - **parent edges** of every processed event, kept after pruning (§9.3, §14.1);
//! - **current objects** keyed by `(chat_id, syncObjId)`: the current result, the retained
//!   events that carry it, the pending future versions and the pending deletions (§7.1, §7.3,
//!   §7.4).
//!
//! In an epoch with a message timer, the timer erases a message with every record of it:
//! its object, the rows and the parent edges of all its events (§7.7). This is the only way
//! a processed row, an edge or an object is ever deleted within a retained group.
//!
//! A device stores an event's version and fields, never the bytes it received, and serves it
//! under its own version (§13.1). Result hashes are recomputed when needed and never stored
//! (§6.2).
//!
//! **Atomicity (§15.2).** Every engine operation ([`crate::Epoch`]) reads through
//! [`StorageRead`], stages all its writes in one [`Changes`] and hands them to
//! [`Storage::commit`] exactly once, at the end. An implementation MUST apply a `Changes` in
//! one transaction: all of it or nothing. An operation that fails commits nothing.

mod memory;
pub(crate) mod overlay;
pub(crate) mod tx;

pub use memory::MemoryStorage;

use std::collections::{BTreeMap, BTreeSet};

use crate::constants::RETENTION_MS;
use crate::event::{Content, MessageEvent, Payload};
use crate::ids::{ChatId, EventId, SyncObjId};

/// Why a retained event is kept.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Role {
    /// It carries the current result of its sync object (§7.1).
    Current,
    /// A pending future version, effective at `due`, its `last_modified_at` (§7.3).
    PendingVersion {
        /// When the version becomes effective.
        due: u64,
    },
    /// The pending scheduled deletion of its sync object, applied at `due` (§7.4).
    PendingDeletion {
        /// When the deletion is applied.
        due: u64,
    },
}

impl Role {
    /// The pending due time, if any.
    #[must_use]
    pub fn due(&self) -> Option<u64> {
        match self {
            Role::Current => None,
            Role::PendingVersion { due } | Role::PendingDeletion { due } => Some(*due),
        }
    }
}

/// The state of an event row.
// A stub is small and a held event large; boxing would only move the size elsewhere.
#[allow(clippy::large_enum_variant)]
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RowState {
    /// A future-time rejection marker (§7.2, §9.6): not processed, no content, no parent
    /// links. Cleared on the first valid acceptance of the event, or removed by capacity
    /// eviction ([`crate::Epoch::evict_markers`]).
    TemporarilyInvalid,
    /// Processed and retained: the event's version and fields (its first valid
    /// interpretation, §7.1).
    Held {
        /// The event, as stored and served.
        event: MessageEvent,
        /// Why it is kept.
        role: Role,
    },
    /// Processed and pruned: a generic ID stub. Its parent links stay in the edges.
    Pruned,
}

/// An event row keyed by `(chat_id, eventId)` (§14.1).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EventRow {
    /// The event ID.
    pub event_id: EventId,
    /// Its state.
    pub state: RowState,
}

impl EventRow {
    /// Whether the event was processed (validated and merged, §9.5).
    #[must_use]
    pub fn processed(&self) -> bool {
        matches!(self.state, RowState::Held { .. } | RowState::Pruned)
    }

    /// The retained event, if any.
    #[must_use]
    pub fn event(&self) -> Option<&MessageEvent> {
        match &self.state {
            RowState::Held { event, .. } => Some(event),
            _ => None,
        }
    }

    /// The role of a retained event.
    #[must_use]
    pub fn role(&self) -> Option<Role> {
        match &self.state {
            RowState::Held { role, .. } => Some(*role),
            _ => None,
        }
    }

    /// Whether the event is available at `now`: retained and inside its window (§1.4, §8.1).
    #[must_use]
    pub fn available(&self, now: u64) -> bool {
        matches!(self.state, RowState::Held { .. }) && in_window(&self.event_id, now)
    }
}

/// The end of an event's availability window, `ts + RETENTION` (§8.1), in 128 bits so that
/// it is exact for every `ts` (§1, D.25).
#[must_use]
pub fn window_end(event_id: &EventId) -> u128 {
    u128::from(event_id.timestamp()) + u128::from(RETENTION_MS)
}

/// Whether `now` is inside the availability window of `event_id`: `now < ts + RETENTION`.
#[must_use]
pub fn in_window(event_id: &EventId, now: u64) -> bool {
    u128::from(now) < window_end(event_id)
}

/// The stored current result of a sync object (§7.1).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StoredResult {
    /// A non-delete result.
    Content(Content),
    /// The tombstone: absorbing.
    Tombstone,
}

impl StoredResult {
    /// The result as a payload of `sync_obj_id` (an immediate delete for the tombstone).
    #[must_use]
    pub fn to_payload(&self, sync_obj_id: SyncObjId) -> Payload {
        match self {
            StoredResult::Content(c) => Payload::Content(c.clone()),
            StoredResult::Tombstone => Payload::Delete {
                sync_obj_id,
                scheduled_at: None,
            },
        }
    }

    /// The result hash in the epoch `chat_id` (§6.2). Computed, never stored.
    #[must_use]
    pub fn result_hash(&self, chat_id: &ChatId, sync_obj_id: SyncObjId) -> [u8; 32] {
        self.to_payload(sync_obj_id).result_hash(chat_id)
    }
}

/// A current object keyed by `(chat_id, syncObjId)` (§14.1).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ObjectRecord {
    /// The sync object.
    pub sync_obj_id: SyncObjId,
    /// The current applied result; `None` while only pending versions are known.
    pub current: Option<StoredResult>,
    /// The retained events that carry the current result (§7.1 "identical").
    pub current_events: BTreeSet<EventId>,
    /// The admitted pending future versions, as `(due, eventId)` (§7.3).
    pub pending_versions: BTreeSet<(u64, EventId)>,
    /// The pending scheduled deletions, as `(due, eventId)` (§7.4). Each is kept in its
    /// scheduled form until its own time, also beside a tombstone, and is then normalised
    /// into one more carrier of the tombstone; the earliest one deletes the message (D.26,
    /// D.31; this departs from "only the earliest is kept").
    pub pending_deletions: BTreeSet<(u64, EventId)>,
    /// The moment the message timer deletes the current result (§7.7): its creation date
    /// plus the timer of the epoch. `None` with no timer, for a tombstone or a reaction, or
    /// when the moment is past the top of the integer range and so never comes.
    pub expires_at: Option<u64>,
    /// When the message timer erases this object and every record of it (§7.7): the latest
    /// moment among the versions this device processed, so that every version offered again
    /// afterwards is refused by its own dates. A reaction's own moment counts too (§7.6).
    /// `None`: never (no timer, a moment past the top of the integer range, or a message
    /// deleted by a deletion event or by hand, whose tombstone is kept as without a timer).
    pub erase_at: Option<u64>,
    /// The pruned events of this object, kept only while `erase_at` is set, so that the
    /// erasure finds their stubs and parent edges. Local bookkeeping: an event pruned by
    /// another device is not in it.
    pub stubs: BTreeSet<EventId>,
}

impl ObjectRecord {
    /// An object with nothing yet.
    #[must_use]
    pub fn empty(sync_obj_id: SyncObjId) -> Self {
        Self {
            sync_obj_id,
            current: None,
            current_events: BTreeSet::new(),
            pending_versions: BTreeSet::new(),
            pending_deletions: BTreeSet::new(),
            expires_at: None,
            erase_at: None,
            stubs: BTreeSet::new(),
        }
    }

    /// Whether the current result is the tombstone.
    #[must_use]
    pub fn is_deleted(&self) -> bool {
        matches!(self.current, Some(StoredResult::Tombstone))
    }

    /// The pending items of this object, unordered.
    pub fn pending_items(&self) -> impl Iterator<Item = PendingItem> + '_ {
        let versions = self.pending_versions.iter().map(|(due, id)| PendingItem {
            due: *due,
            event_id: *id,
            sync_obj_id: self.sync_obj_id,
            kind: PendingKind::Version,
        });
        let deletion = self.pending_deletions.iter().map(|(due, id)| PendingItem {
            due: *due,
            event_id: *id,
            sync_obj_id: self.sync_obj_id,
            kind: PendingKind::Deletion,
        });
        let expiry = self.expires_at.map(|due| PendingItem {
            due,
            event_id: EXPIRY_EVENT_ID,
            sync_obj_id: self.sync_obj_id,
            kind: PendingKind::Expiry,
        });
        let erasure = self.erase_at.map(|due| PendingItem {
            due,
            event_id: EXPIRY_EVENT_ID,
            sync_obj_id: self.sync_obj_id,
            kind: PendingKind::Erasure,
        });
        versions.chain(deletion).chain(expiry).chain(erasure)
    }

    /// The target of the reaction this object holds as its current result, if any (§7.6).
    #[must_use]
    pub fn reaction_target(&self) -> Option<SyncObjId> {
        match &self.current {
            Some(StoredResult::Content(Content {
                body: crate::event::Body::Reaction(r),
                ..
            })) => Some(r.target),
            _ => None,
        }
    }
}

/// What a pending item is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum PendingKind {
    /// A pending future version (§7.3).
    Version,
    /// A pending scheduled deletion (§7.4).
    Deletion,
    /// The deletion of the current result by the message timer (§7.7).
    Expiry,
    /// The erasure of the whole object by the message timer (§7.7). It sorts after the
    /// expiry due at the same time.
    Erasure,
}

/// The event ID of an expiry in the pending index: the deletion by the message timer belongs
/// to the message, not to one of its events. The all-zero ID sorts it first among the items
/// due at the same time, which fixes the order on every device.
pub const EXPIRY_EVENT_ID: EventId = EventId::from_bytes([0; crate::constants::EVENT_ID_SIZE]);

/// An entry of the time-sorted pending index (§7.4 "durable time-sorted index").
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PendingItem {
    /// When it becomes due.
    pub due: u64,
    /// The pending event; [`EXPIRY_EVENT_ID`] for an expiry.
    pub event_id: EventId,
    /// Its sync object.
    pub sync_obj_id: SyncObjId,
    /// Version or deletion.
    pub kind: PendingKind,
}

/// The writes of one logical step on one epoch, committed atomically (§15.2).
///
/// The maps are upserts and the sets are deletions; a key is never in both. Stubs, edges
/// and tombstones are kept until the group is closed (§14.1), with two exceptions: a
/// temporary-rejection marker is removed on acceptance or when capacity forces it out
/// (§9.6), and the message timer erases a message with its object, the rows of all its
/// events and their parent edges (§7.7). Edges are written once per child, when it is
/// first processed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Changes {
    /// The epoch.
    pub chat_id: ChatId,
    /// Event rows to insert or replace.
    pub rows: BTreeMap<EventId, EventRow>,
    /// Parent edges to insert: child → its parents, ascending.
    pub edges: BTreeMap<EventId, Vec<EventId>>,
    /// Current objects to insert or replace.
    pub objects: BTreeMap<SyncObjId, ObjectRecord>,
    /// Event rows to delete: a temporary-rejection marker (§9.6), or a row the message timer
    /// erases (§7.7). Never a row also listed in `rows`.
    pub removed_rows: BTreeSet<EventId>,
    /// Parent edges to delete, by child: those of an event the message timer erases (§7.7).
    /// Never a child also listed in `edges`.
    pub removed_edges: BTreeSet<EventId>,
    /// Objects to delete: those the message timer erases (§7.7). Never one also listed in
    /// `objects`.
    pub removed_objects: BTreeSet<SyncObjId>,
}

impl Changes {
    /// No change in the epoch `chat_id`.
    #[must_use]
    pub fn new(chat_id: ChatId) -> Self {
        Self {
            chat_id,
            rows: BTreeMap::new(),
            edges: BTreeMap::new(),
            objects: BTreeMap::new(),
            removed_rows: BTreeSet::new(),
            removed_edges: BTreeSet::new(),
            removed_objects: BTreeSet::new(),
        }
    }

    /// Whether nothing is to be written.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.rows.is_empty()
            && self.edges.is_empty()
            && self.objects.is_empty()
            && self.removed_rows.is_empty()
            && self.removed_edges.is_empty()
            && self.removed_objects.is_empty()
    }
}

/// A failure of the storage backend.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("storage: {0}")]
pub struct StorageError(pub String);

/// Reads of the records of §14.1, scoped by epoch.
///
/// The engine's operations use only the reads that an index answers in time proportional to
/// what they return: one row, one object, one event's parents, the retained IDs, the oldest
/// carriers, the oldest markers and the due pending items. The whole-epoch reads
/// ([`StorageRead::event_rows`], [`StorageRead::edges`], [`StorageRead::objects`]) serve the
/// view, inspection and tests.
pub trait StorageRead {
    /// The row of `(chat_id, event_id)`.
    ///
    /// # Errors
    ///
    /// A backend failure.
    fn event_row(
        &self,
        chat_id: &ChatId,
        event_id: &EventId,
    ) -> Result<Option<EventRow>, StorageError>;

    /// Every row of the epoch, ascending by event ID (which is event-timestamp order).
    ///
    /// # Errors
    ///
    /// A backend failure.
    fn event_rows(&self, chat_id: &ChatId) -> Result<Vec<EventRow>, StorageError>;

    /// Every parent edge of the epoch: each processed child with its parents, ascending by
    /// child.
    ///
    /// # Errors
    ///
    /// A backend failure.
    fn edges(&self, chat_id: &ChatId) -> Result<Vec<(EventId, Vec<EventId>)>, StorageError>;

    /// The stored parent links of the processed event `event_id`, ascending; `None` when it
    /// was never processed.
    ///
    /// # Errors
    ///
    /// A backend failure.
    fn parents(
        &self,
        chat_id: &ChatId,
        event_id: &EventId,
    ) -> Result<Option<Vec<EventId>>, StorageError>;

    /// The IDs of every retained row (an event held with its content, whatever its role),
    /// ascending. Index: the retained rows.
    ///
    /// # Errors
    ///
    /// A backend failure.
    fn held_ids(&self, chat_id: &ChatId) -> Result<Vec<EventId>, StorageError>;

    /// The retained rows that carry a current result ([`Role::Current`]) and whose event
    /// timestamp is at most `ts_until`, ascending by event ID (oldest first), at most `limit`
    /// of them. Index: the carriers by event ID, which is event-timestamp order; it serves
    /// retention (the carriers whose window has ended) and capacity eviction (the oldest).
    ///
    /// # Errors
    ///
    /// A backend failure.
    fn carriers(
        &self,
        chat_id: &ChatId,
        ts_until: u64,
        limit: usize,
    ) -> Result<Vec<EventRow>, StorageError>;

    /// The IDs of the temporary-rejection markers (§9.6), ascending by event ID (oldest
    /// event timestamp first), at most `limit` of them. Index: the markers.
    ///
    /// # Errors
    ///
    /// A backend failure.
    fn markers(&self, chat_id: &ChatId, limit: usize) -> Result<Vec<EventId>, StorageError>;

    /// The current object of `(chat_id, sync_obj_id)`.
    ///
    /// # Errors
    ///
    /// A backend failure.
    fn object(
        &self,
        chat_id: &ChatId,
        sync_obj_id: &SyncObjId,
    ) -> Result<Option<ObjectRecord>, StorageError>;

    /// Every current object of the epoch, ascending by sync-object ID.
    ///
    /// # Errors
    ///
    /// A backend failure.
    fn objects(&self, chat_id: &ChatId) -> Result<Vec<ObjectRecord>, StorageError>;

    /// The pending index: every pending item of the epoch with `due ≤ until`, ascending by
    /// `(due, event_id, kind, sync_obj_id)`.
    ///
    /// # Errors
    ///
    /// A backend failure.
    fn pending_until(&self, chat_id: &ChatId, until: u64)
    -> Result<Vec<PendingItem>, StorageError>;

    /// The first item of the pending index, by `(due, event_id)`.
    ///
    /// # Errors
    ///
    /// A backend failure.
    fn first_pending(&self, chat_id: &ChatId) -> Result<Option<PendingItem>, StorageError>;

    /// The objects whose current result is a reaction to `target` (§7.6), ascending. Index:
    /// the reactions by target ([`ObjectRecord::reaction_target`]); it serves the erasure of
    /// a message's reactions with it (§7.7).
    ///
    /// # Errors
    ///
    /// A backend failure.
    fn reactions_to(
        &self,
        chat_id: &ChatId,
        target: &SyncObjId,
    ) -> Result<Vec<SyncObjId>, StorageError>;
}

/// A store of the records of §14.1.
pub trait Storage: StorageRead {
    /// Applies `changes` in one transaction: all of it or nothing (§15.2).
    ///
    /// # Errors
    ///
    /// A backend failure, in which case nothing was applied.
    fn commit(&mut self, changes: Changes) -> Result<(), StorageError>;
}

/// Sorts pending items by `(due, event_id)`, then kind and sync object: expiries share one
/// event ID ([`EXPIRY_EVENT_ID`]), and their order must be the same everywhere.
pub(crate) fn sort_pending(items: &mut [PendingItem]) {
    items.sort_unstable_by_key(|i| (i.due, i.event_id, i.kind, i.sync_obj_id));
}
