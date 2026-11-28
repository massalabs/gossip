//! An in-memory [`Storage`], for tests and simulations, with the indexes a persistent
//! backend would keep.

use std::collections::{BTreeMap, BTreeSet};

use super::{
    Changes, EventRow, ObjectRecord, PendingItem, PendingKind, Role, RowState, Storage,
    StorageError, StorageRead,
};
use crate::ids::{ChatId, EventId, SyncObjId};
use crate::node::records::{Batch, NodeRecords, NodeStorage};

#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct EpochRecords {
    rows: BTreeMap<EventId, EventRow>,
    edges: BTreeMap<EventId, Vec<EventId>>,
    objects: BTreeMap<SyncObjId, ObjectRecord>,
    // Indexes, derived from the records above.
    held: BTreeSet<EventId>,
    carriers: BTreeSet<EventId>,
    markers: BTreeSet<EventId>,
    pending: BTreeSet<(u64, EventId, PendingKind, SyncObjId)>,
    reactions: BTreeSet<(SyncObjId, SyncObjId)>,
}

impl EpochRecords {
    fn unindex_row(&mut self, row: &EventRow) {
        self.held.remove(&row.event_id);
        self.carriers.remove(&row.event_id);
        self.markers.remove(&row.event_id);
    }

    fn index_row(&mut self, row: &EventRow) {
        match &row.state {
            RowState::Held { role, .. } => {
                self.held.insert(row.event_id);
                if *role == Role::Current {
                    self.carriers.insert(row.event_id);
                }
            }
            RowState::TemporarilyInvalid => {
                self.markers.insert(row.event_id);
            }
            RowState::Pruned => {}
        }
    }

    fn put_row(&mut self, row: EventRow) {
        if let Some(old) = self.rows.remove(&row.event_id) {
            self.unindex_row(&old);
        }
        self.index_row(&row);
        self.rows.insert(row.event_id, row);
    }

    fn remove_row(&mut self, id: &EventId) {
        if let Some(old) = self.rows.remove(id) {
            self.unindex_row(&old);
        }
    }

    fn put_object(&mut self, obj: ObjectRecord) {
        // Only the difference is reindexed: an object can hold many pending items.
        let sync = obj.sync_obj_id;
        let old = self.objects.remove(&sync);
        self.reindex_object(old.as_ref(), Some(&obj), sync);
        self.objects.insert(sync, obj);
    }

    /// Reindexes the object `sync` from `old` to `new` (`None`: no record).
    fn reindex_object(
        &mut self,
        old: Option<&ObjectRecord>,
        new: Option<&ObjectRecord>,
        sync: SyncObjId,
    ) {
        let none = BTreeSet::new();
        let key = |kind| move |(due, id): &(u64, EventId)| (*due, *id, kind, sync);
        for (before, after, kind) in [
            (
                old.map_or(&none, |o| &o.pending_versions),
                new.map_or(&none, |o| &o.pending_versions),
                PendingKind::Version,
            ),
            (
                old.map_or(&none, |o| &o.pending_deletions),
                new.map_or(&none, |o| &o.pending_deletions),
                PendingKind::Deletion,
            ),
        ] {
            for k in before.difference(after).map(key(kind)) {
                self.pending.remove(&k);
            }
            self.pending.extend(after.difference(before).map(key(kind)));
        }
        for (before, after, kind) in [
            (
                old.and_then(|o| o.expires_at),
                new.and_then(|o| o.expires_at),
                PendingKind::Expiry,
            ),
            (
                old.and_then(|o| o.erase_at),
                new.and_then(|o| o.erase_at),
                PendingKind::Erasure,
            ),
        ] {
            if before != after {
                let key = |due| (due, super::EXPIRY_EVENT_ID, kind, sync);
                if let Some(due) = before {
                    self.pending.remove(&key(due));
                }
                if let Some(due) = after {
                    self.pending.insert(key(due));
                }
            }
        }
        if let Some(t) = old.and_then(ObjectRecord::reaction_target) {
            self.reactions.remove(&(t, sync));
        }
        if let Some(t) = new.and_then(ObjectRecord::reaction_target) {
            self.reactions.insert((t, sync));
        }
    }

    fn remove_object(&mut self, sync: &SyncObjId) {
        if let Some(old) = self.objects.remove(sync) {
            self.reindex_object(Some(&old), None, *sync);
        }
    }
}

fn item((due, event_id, kind, sync_obj_id): (u64, EventId, PendingKind, SyncObjId)) -> PendingItem {
    PendingItem {
        due,
        event_id,
        sync_obj_id,
        kind,
    }
}

/// Every record in memory. A commit cannot fail, so it is trivially atomic.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct MemoryStorage {
    epochs: BTreeMap<ChatId, EpochRecords>,
    node: NodeRecords,
    commits: u64,
}

impl MemoryStorage {
    /// An empty store.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// The number of commits so far (one per engine operation that changed something).
    #[must_use]
    pub fn commits(&self) -> u64 {
        self.commits
    }
}

impl StorageRead for MemoryStorage {
    fn event_row(
        &self,
        chat_id: &ChatId,
        event_id: &EventId,
    ) -> Result<Option<EventRow>, StorageError> {
        Ok(self
            .epochs
            .get(chat_id)
            .and_then(|e| e.rows.get(event_id))
            .cloned())
    }

    fn event_rows(&self, chat_id: &ChatId) -> Result<Vec<EventRow>, StorageError> {
        Ok(self
            .epochs
            .get(chat_id)
            .map(|e| e.rows.values().cloned().collect())
            .unwrap_or_default())
    }

    fn edges(&self, chat_id: &ChatId) -> Result<Vec<(EventId, Vec<EventId>)>, StorageError> {
        Ok(self
            .epochs
            .get(chat_id)
            .map(|e| e.edges.iter().map(|(k, v)| (*k, v.clone())).collect())
            .unwrap_or_default())
    }

    fn parents(
        &self,
        chat_id: &ChatId,
        event_id: &EventId,
    ) -> Result<Option<Vec<EventId>>, StorageError> {
        Ok(self
            .epochs
            .get(chat_id)
            .and_then(|e| e.edges.get(event_id))
            .cloned())
    }

    fn held_ids(&self, chat_id: &ChatId) -> Result<Vec<EventId>, StorageError> {
        Ok(self
            .epochs
            .get(chat_id)
            .map(|e| e.held.iter().copied().collect())
            .unwrap_or_default())
    }

    fn carriers(
        &self,
        chat_id: &ChatId,
        ts_until: u64,
        limit: usize,
    ) -> Result<Vec<EventRow>, StorageError> {
        Ok(self
            .epochs
            .get(chat_id)
            .map(|e| {
                e.carriers
                    .iter()
                    .take_while(|id| id.timestamp() <= ts_until)
                    .take(limit)
                    .filter_map(|id| e.rows.get(id).cloned())
                    .collect()
            })
            .unwrap_or_default())
    }

    fn markers(&self, chat_id: &ChatId, limit: usize) -> Result<Vec<EventId>, StorageError> {
        Ok(self
            .epochs
            .get(chat_id)
            .map(|e| e.markers.iter().take(limit).copied().collect())
            .unwrap_or_default())
    }

    fn object(
        &self,
        chat_id: &ChatId,
        sync_obj_id: &SyncObjId,
    ) -> Result<Option<ObjectRecord>, StorageError> {
        Ok(self
            .epochs
            .get(chat_id)
            .and_then(|e| e.objects.get(sync_obj_id))
            .cloned())
    }

    fn objects(&self, chat_id: &ChatId) -> Result<Vec<ObjectRecord>, StorageError> {
        Ok(self
            .epochs
            .get(chat_id)
            .map(|e| e.objects.values().cloned().collect())
            .unwrap_or_default())
    }

    fn pending_until(
        &self,
        chat_id: &ChatId,
        until: u64,
    ) -> Result<Vec<PendingItem>, StorageError> {
        Ok(self
            .epochs
            .get(chat_id)
            .map(|e| {
                e.pending
                    .iter()
                    .take_while(|k| k.0 <= until)
                    .map(|k| item(*k))
                    .collect()
            })
            .unwrap_or_default())
    }

    fn first_pending(&self, chat_id: &ChatId) -> Result<Option<PendingItem>, StorageError> {
        Ok(self
            .epochs
            .get(chat_id)
            .and_then(|e| e.pending.first().map(|k| item(*k))))
    }

    fn reactions_to(
        &self,
        chat_id: &ChatId,
        target: &SyncObjId,
    ) -> Result<Vec<SyncObjId>, StorageError> {
        let first = (*target, SyncObjId::from_bytes([0; 32]));
        Ok(self
            .epochs
            .get(chat_id)
            .map(|e| {
                e.reactions
                    .range(first..)
                    .take_while(|(t, _)| t == target)
                    .map(|(_, r)| *r)
                    .collect()
            })
            .unwrap_or_default())
    }
}

impl MemoryStorage {
    fn apply(&mut self, changes: Changes) {
        if changes.is_empty() {
            return;
        }
        let epoch = self.epochs.entry(changes.chat_id).or_default();
        for row in changes.rows.into_values() {
            epoch.put_row(row);
        }
        for id in &changes.removed_rows {
            epoch.remove_row(id);
        }
        epoch.edges.extend(changes.edges);
        for id in &changes.removed_edges {
            epoch.edges.remove(id);
        }
        for obj in changes.objects.into_values() {
            epoch.put_object(obj);
        }
        for sync in &changes.removed_objects {
            epoch.remove_object(sync);
        }
    }
}

impl Storage for MemoryStorage {
    fn commit(&mut self, changes: Changes) -> Result<(), StorageError> {
        if changes.is_empty() {
            return Ok(());
        }
        self.apply(changes);
        self.commits += 1;
        Ok(())
    }
}

impl NodeStorage for MemoryStorage {
    fn load_node(&self) -> Result<NodeRecords, StorageError> {
        Ok(self.node.clone())
    }

    fn commit_batch(&mut self, batch: Batch) -> Result<(), StorageError> {
        if batch.is_empty() {
            return Ok(());
        }
        for changes in batch.epochs {
            self.apply(changes);
        }
        for chat in &batch.erase {
            self.epochs.remove(chat);
        }
        self.node.apply(batch.node);
        self.commits += 1;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::{PendingKind, RowState};

    fn id(n: u8) -> EventId {
        EventId::new(u64::from(n), [n; 16])
    }

    #[test]
    fn commits_upsert_and_scope_by_epoch() {
        let chat = ChatId::from_bytes([1; 32]);
        let other = ChatId::from_bytes([2; 32]);
        let sync = SyncObjId::from_bytes([3; 32]);
        let mut store = MemoryStorage::new();
        assert!(store.commit(Changes::new(chat)).is_ok());
        assert_eq!(store.commits(), 0);

        let mut c = Changes::new(chat);
        for n in [2u8, 1] {
            c.rows.insert(
                id(n),
                EventRow {
                    event_id: id(n),
                    state: RowState::Pruned,
                },
            );
        }
        c.edges.insert(id(2), vec![id(1)]);
        let mut obj = ObjectRecord::empty(sync, true);
        obj.pending_versions.insert((30, id(2)));
        obj.pending_deletions.insert((20, id(1)));
        c.objects.insert(sync, obj);
        store.commit(c).unwrap();
        assert_eq!(store.commits(), 1);

        let rows = store.event_rows(&chat).unwrap();
        assert_eq!(
            rows.iter().map(|r| r.event_id).collect::<Vec<_>>(),
            [id(1), id(2)]
        );
        assert!(store.event_rows(&other).unwrap().is_empty());
        assert!(store.event_row(&other, &id(1)).unwrap().is_none());
        assert_eq!(store.edges(&chat).unwrap(), vec![(id(2), vec![id(1)])]);
        assert_eq!(store.parents(&chat, &id(2)).unwrap(), Some(vec![id(1)]));
        assert_eq!(store.parents(&chat, &id(1)).unwrap(), None);
        let due = store.pending_until(&chat, 25).unwrap();
        assert_eq!(due.len(), 1);
        assert_eq!((due[0].due, due[0].kind), (20, PendingKind::Deletion));
        let all = store.pending_until(&chat, u64::MAX).unwrap();
        assert_eq!(all.iter().map(|i| i.due).collect::<Vec<_>>(), [20, 30]);

        // Upsert.
        let mut c = Changes::new(chat);
        c.objects.insert(sync, ObjectRecord::empty(sync, true));
        store.commit(c).unwrap();
        assert!(store.pending_until(&chat, u64::MAX).unwrap().is_empty());
        assert_eq!(
            store.objects(&chat).unwrap(),
            vec![ObjectRecord::empty(sync, true)]
        );
    }
}
