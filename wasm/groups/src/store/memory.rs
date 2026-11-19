//! An in-memory [`Storage`], for tests and simulations.

use std::collections::BTreeMap;

use super::{
    Changes, EventRow, ObjectRecord, PendingItem, Storage, StorageError, StorageRead, sort_pending,
};
use crate::ids::{ChatId, EventId, SyncObjId};

#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct EpochRecords {
    rows: BTreeMap<EventId, EventRow>,
    edges: BTreeMap<EventId, Vec<EventId>>,
    objects: BTreeMap<SyncObjId, ObjectRecord>,
}

/// Every record in memory. A commit cannot fail, so it is trivially atomic.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct MemoryStorage {
    epochs: BTreeMap<ChatId, EpochRecords>,
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
        let mut items: Vec<PendingItem> = self
            .epochs
            .get(chat_id)
            .map(|e| {
                e.objects
                    .values()
                    .flat_map(ObjectRecord::pending_items)
                    .filter(|i| i.due <= until)
                    .collect()
            })
            .unwrap_or_default();
        sort_pending(&mut items);
        Ok(items)
    }
}

impl Storage for MemoryStorage {
    fn commit(&mut self, changes: Changes) -> Result<(), StorageError> {
        if changes.is_empty() {
            return Ok(());
        }
        let epoch = self.epochs.entry(changes.chat_id).or_default();
        epoch.rows.extend(changes.rows);
        epoch.edges.extend(changes.edges);
        epoch.objects.extend(changes.objects);
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
        let mut obj = ObjectRecord::empty(sync);
        obj.pending_versions.insert((30, id(2)));
        obj.pending_deletion = Some((20, id(1)));
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
        let due = store.pending_until(&chat, 25).unwrap();
        assert_eq!(due.len(), 1);
        assert_eq!((due[0].due, due[0].kind), (20, PendingKind::Deletion));
        let all = store.pending_until(&chat, u64::MAX).unwrap();
        assert_eq!(all.iter().map(|i| i.due).collect::<Vec<_>>(), [20, 30]);

        // Upsert.
        let mut c = Changes::new(chat);
        c.objects.insert(sync, ObjectRecord::empty(sync));
        store.commit(c).unwrap();
        assert!(store.pending_until(&chat, u64::MAX).unwrap().is_empty());
        assert_eq!(
            store.objects(&chat).unwrap(),
            vec![ObjectRecord::empty(sync)]
        );
    }
}
