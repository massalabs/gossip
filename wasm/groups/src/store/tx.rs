//! One logical step: reads see the store plus the writes staged so far, and the writes are
//! committed together at the end (§15.2).

use std::collections::BTreeMap;

use super::{
    Changes, EventRow, ObjectRecord, PendingItem, StorageError, StorageRead, sort_pending,
};
use crate::ids::{ChatId, EventId, SyncObjId};

/// A read-your-writes overlay over a store, for one epoch.
pub(crate) struct Tx<'s, S: StorageRead + ?Sized> {
    store: &'s S,
    changes: Changes,
}

impl<'s, S: StorageRead + ?Sized> Tx<'s, S> {
    pub(crate) fn new(store: &'s S, chat_id: ChatId) -> Self {
        Self {
            store,
            changes: Changes::new(chat_id),
        }
    }

    pub(crate) fn chat_id(&self) -> ChatId {
        self.changes.chat_id
    }

    pub(crate) fn row(&self, id: &EventId) -> Result<Option<EventRow>, StorageError> {
        match self.changes.rows.get(id) {
            Some(r) => Ok(Some(r.clone())),
            None => self.store.event_row(&self.changes.chat_id, id),
        }
    }

    pub(crate) fn put_row(&mut self, row: EventRow) {
        self.changes.rows.insert(row.event_id, row);
    }

    pub(crate) fn put_edges(&mut self, child: EventId, parents: Vec<EventId>) {
        self.changes.edges.insert(child, parents);
    }

    pub(crate) fn object(&self, id: &SyncObjId) -> Result<Option<ObjectRecord>, StorageError> {
        match self.changes.objects.get(id) {
            Some(o) => Ok(Some(o.clone())),
            None => self.store.object(&self.changes.chat_id, id),
        }
    }

    pub(crate) fn put_object(&mut self, object: ObjectRecord) {
        self.changes.objects.insert(object.sync_obj_id, object);
    }

    pub(crate) fn into_changes(self) -> Changes {
        self.changes
    }
}

impl<S: StorageRead + ?Sized> StorageRead for Tx<'_, S> {
    fn event_row(
        &self,
        chat_id: &ChatId,
        event_id: &EventId,
    ) -> Result<Option<EventRow>, StorageError> {
        if *chat_id == self.changes.chat_id {
            self.row(event_id)
        } else {
            self.store.event_row(chat_id, event_id)
        }
    }

    fn event_rows(&self, chat_id: &ChatId) -> Result<Vec<EventRow>, StorageError> {
        let base = self.store.event_rows(chat_id)?;
        if *chat_id != self.changes.chat_id || self.changes.rows.is_empty() {
            return Ok(base);
        }
        let mut merged: BTreeMap<EventId, EventRow> =
            base.into_iter().map(|r| (r.event_id, r)).collect();
        merged.extend(self.changes.rows.iter().map(|(k, v)| (*k, v.clone())));
        Ok(merged.into_values().collect())
    }

    fn edges(&self, chat_id: &ChatId) -> Result<Vec<(EventId, Vec<EventId>)>, StorageError> {
        let base = self.store.edges(chat_id)?;
        if *chat_id != self.changes.chat_id || self.changes.edges.is_empty() {
            return Ok(base);
        }
        let mut merged: BTreeMap<EventId, Vec<EventId>> = base.into_iter().collect();
        merged.extend(self.changes.edges.iter().map(|(k, v)| (*k, v.clone())));
        Ok(merged.into_iter().collect())
    }

    fn object(
        &self,
        chat_id: &ChatId,
        sync_obj_id: &SyncObjId,
    ) -> Result<Option<ObjectRecord>, StorageError> {
        if *chat_id == self.changes.chat_id {
            Tx::object(self, sync_obj_id)
        } else {
            self.store.object(chat_id, sync_obj_id)
        }
    }

    fn objects(&self, chat_id: &ChatId) -> Result<Vec<ObjectRecord>, StorageError> {
        let base = self.store.objects(chat_id)?;
        if *chat_id != self.changes.chat_id || self.changes.objects.is_empty() {
            return Ok(base);
        }
        let mut merged: BTreeMap<SyncObjId, ObjectRecord> =
            base.into_iter().map(|o| (o.sync_obj_id, o)).collect();
        merged.extend(self.changes.objects.iter().map(|(k, v)| (*k, v.clone())));
        Ok(merged.into_values().collect())
    }

    fn pending_until(
        &self,
        chat_id: &ChatId,
        until: u64,
    ) -> Result<Vec<PendingItem>, StorageError> {
        let base = self.store.pending_until(chat_id, until)?;
        if *chat_id != self.changes.chat_id || self.changes.objects.is_empty() {
            return Ok(base);
        }
        // Staged objects replace the store's entries for the same sync object.
        let mut items: Vec<PendingItem> = base
            .into_iter()
            .filter(|i| !self.changes.objects.contains_key(&i.sync_obj_id))
            .collect();
        items.extend(
            self.changes
                .objects
                .values()
                .flat_map(ObjectRecord::pending_items)
                .filter(|i| i.due <= until),
        );
        sort_pending(&mut items);
        Ok(items)
    }
}
