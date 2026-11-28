//! A staging store for one engine operation that runs several epoch operations: each epoch
//! operation "commits" into the overlay, later reads see those writes, and the engine
//! commits everything at once at the end (§15.2).

use std::collections::BTreeMap;

use super::tx::Tx;
use super::{Changes, EventRow, ObjectRecord, PendingItem, Storage, StorageError, StorageRead};
use crate::ids::{ChatId, EventId, SyncObjId};

/// Reads see `base` plus everything committed to the overlay so far.
pub(crate) struct Overlay<'s, S: StorageRead> {
    base: &'s S,
    epochs: BTreeMap<ChatId, Tx<'s, S>>,
}

impl<'s, S: StorageRead> Overlay<'s, S> {
    pub(crate) fn new(base: &'s S) -> Self {
        Self {
            base,
            epochs: BTreeMap::new(),
        }
    }

    /// The staged writes, one [`Changes`] per epoch written.
    pub(crate) fn into_changes(self) -> Vec<Changes> {
        self.epochs
            .into_values()
            .map(Tx::into_changes)
            .filter(|c| !c.is_empty())
            .collect()
    }

    fn read(&self, chat_id: &ChatId) -> &dyn StorageRead {
        match self.epochs.get(chat_id) {
            Some(tx) => tx,
            None => self.base,
        }
    }
}

impl<S: StorageRead> Storage for Overlay<'_, S> {
    fn commit(&mut self, changes: Changes) -> Result<(), StorageError> {
        let base = self.base;
        let tx = self
            .epochs
            .entry(changes.chat_id)
            .or_insert_with(|| Tx::new(base, changes.chat_id));
        for row in changes.rows.into_values() {
            tx.put_row(row);
        }
        for id in changes.removed_rows {
            tx.remove_marker(id);
        }
        for (child, parents) in changes.edges {
            tx.put_edges(child, parents);
        }
        for id in changes.removed_edges {
            tx.erase_edges(id);
        }
        for obj in changes.objects.into_values() {
            tx.put_object(obj);
        }
        for sync in changes.removed_objects {
            tx.erase_object(sync);
        }
        Ok(())
    }
}

impl<S: StorageRead> StorageRead for Overlay<'_, S> {
    fn event_row(&self, c: &ChatId, e: &EventId) -> Result<Option<EventRow>, StorageError> {
        self.read(c).event_row(c, e)
    }
    fn event_rows(&self, c: &ChatId) -> Result<Vec<EventRow>, StorageError> {
        self.read(c).event_rows(c)
    }
    fn edges(&self, c: &ChatId) -> Result<Vec<(EventId, Vec<EventId>)>, StorageError> {
        self.read(c).edges(c)
    }
    fn parents(&self, c: &ChatId, e: &EventId) -> Result<Option<Vec<EventId>>, StorageError> {
        self.read(c).parents(c, e)
    }
    fn held_ids(&self, c: &ChatId) -> Result<Vec<EventId>, StorageError> {
        self.read(c).held_ids(c)
    }
    fn carriers(&self, c: &ChatId, ts: u64, limit: usize) -> Result<Vec<EventRow>, StorageError> {
        self.read(c).carriers(c, ts, limit)
    }
    fn markers(&self, c: &ChatId, limit: usize) -> Result<Vec<EventId>, StorageError> {
        self.read(c).markers(c, limit)
    }
    fn object(&self, c: &ChatId, s: &SyncObjId) -> Result<Option<ObjectRecord>, StorageError> {
        self.read(c).object(c, s)
    }
    fn objects(&self, c: &ChatId) -> Result<Vec<ObjectRecord>, StorageError> {
        self.read(c).objects(c)
    }
    fn pending_until(&self, c: &ChatId, until: u64) -> Result<Vec<PendingItem>, StorageError> {
        self.read(c).pending_until(c, until)
    }
    fn first_pending(&self, c: &ChatId) -> Result<Option<PendingItem>, StorageError> {
        self.read(c).first_pending(c)
    }
    fn reactions_to(&self, c: &ChatId, t: &SyncObjId) -> Result<Vec<SyncObjId>, StorageError> {
        self.read(c).reactions_to(c, t)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::epoch::tests::{Fixture, T0, text};
    use crate::store::MemoryStorage;

    /// Two epoch operations staged in one overlay give the same records as the same two
    /// operations committed one by one.
    #[test]
    fn staged_operations_equal_sequential_ones() {
        let f = Fixture::new();
        let e1 = f.event(T0, 1, &[], text(1, f.bob.id, T0, T0, "a"));
        let e2 = f.event(
            T0 + 1,
            2,
            &[e1.event_id()],
            text(1, f.bob.id, T0, T0 + 1, "b"),
        );
        let sender = f.bob_sender();

        let mut sequential = MemoryStorage::new();
        f.epoch()
            .receive(&mut sequential, sender, e1.clone(), T0 + 2)
            .unwrap();
        f.epoch()
            .receive(&mut sequential, sender, e2.clone(), T0 + 2)
            .unwrap();

        let base = MemoryStorage::new();
        let mut ov = Overlay::new(&base);
        f.epoch().receive(&mut ov, sender, e1, T0 + 2).unwrap();
        let r = f.epoch().receive(&mut ov, sender, e2, T0 + 2).unwrap();
        // The second operation saw the first one's writes.
        assert_eq!(r.pruned.len(), 1);
        let changes = ov.into_changes();
        assert_eq!(changes.len(), 1);
        let mut staged = MemoryStorage::new();
        for c in changes {
            staged.commit(c).unwrap();
        }
        let chat = f.root.chat_id();
        assert_eq!(staged.event_rows(&chat), sequential.event_rows(&chat));
        assert_eq!(staged.edges(&chat), sequential.edges(&chat));
        assert_eq!(staged.objects(&chat), sequential.objects(&chat));
        assert_eq!(staged.commits(), 1);
    }
}
