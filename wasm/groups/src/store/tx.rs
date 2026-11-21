//! One logical step: reads see the store plus the writes staged so far, and the writes are
//! committed together at the end (§15.2).

use std::collections::BTreeMap;

use super::{
    Changes, EventRow, ObjectRecord, PendingItem, Role, RowState, StorageError, StorageRead,
    sort_pending,
};
use crate::ids::{ChatId, EventId, SyncObjId};

/// A read-your-writes overlay over a store, for one epoch.
pub(crate) struct Tx<'s, S: StorageRead + ?Sized> {
    store: &'s S,
    changes: Changes,
    /// The message timer of the epoch (§7.7); 0 for a transaction that only stores.
    message_timer: u64,
}

impl<'s, S: StorageRead + ?Sized> Tx<'s, S> {
    pub(crate) fn new(store: &'s S, chat_id: ChatId) -> Self {
        Self {
            store,
            changes: Changes::new(chat_id),
            message_timer: 0,
        }
    }

    /// The same transaction, for an epoch whose root has the message timer `timer`.
    pub(crate) fn with_timer(mut self, timer: u64) -> Self {
        self.message_timer = timer;
        self
    }

    pub(crate) fn chat_id(&self) -> ChatId {
        self.changes.chat_id
    }

    pub(crate) fn message_timer(&self) -> u64 {
        self.message_timer
    }

    pub(crate) fn row(&self, id: &EventId) -> Result<Option<EventRow>, StorageError> {
        if self.changes.removed_rows.contains(id) {
            return Ok(None);
        }
        match self.changes.rows.get(id) {
            Some(r) => Ok(Some(r.clone())),
            None => self.store.event_row(&self.changes.chat_id, id),
        }
    }

    pub(crate) fn put_row(&mut self, row: EventRow) {
        self.changes.removed_rows.remove(&row.event_id);
        self.changes.rows.insert(row.event_id, row);
    }

    /// Removes a temporary-rejection marker (§9.6).
    pub(crate) fn remove_marker(&mut self, id: EventId) {
        self.changes.rows.remove(&id);
        self.changes.removed_rows.insert(id);
    }

    /// Erases the row of `id` and its parent edges (§7.7).
    pub(crate) fn erase_event(&mut self, id: EventId) {
        self.remove_marker(id);
        self.erase_edges(id);
    }

    /// Erases the parent edges of `id` (§7.7).
    pub(crate) fn erase_edges(&mut self, id: EventId) {
        self.changes.edges.remove(&id);
        self.changes.removed_edges.insert(id);
    }

    /// Erases the object `sync` (§7.7).
    pub(crate) fn erase_object(&mut self, sync: SyncObjId) {
        self.changes.objects.remove(&sync);
        self.changes.removed_objects.insert(sync);
    }

    /// Whether the store's answer for the object `sync` is replaced by a staged write.
    fn staged_object(&self, sync: &SyncObjId) -> bool {
        self.changes.objects.contains_key(sync) || self.changes.removed_objects.contains(sync)
    }

    /// Whether objects are staged, written or erased.
    fn objects_staged(&self) -> bool {
        !self.changes.objects.is_empty() || !self.changes.removed_objects.is_empty()
    }

    /// Whether the store's answer for `id` is replaced by a staged write.
    fn staged(&self, id: &EventId) -> bool {
        self.changes.rows.contains_key(id) || self.changes.removed_rows.contains(id)
    }

    /// How many entries of a store answer staged writes can replace.
    fn staged_count(&self) -> usize {
        self.changes.rows.len() + self.changes.removed_rows.len()
    }

    pub(crate) fn put_edges(&mut self, child: EventId, parents: Vec<EventId>) {
        self.changes.removed_edges.remove(&child);
        self.changes.edges.insert(child, parents);
    }

    pub(crate) fn object(&self, id: &SyncObjId) -> Result<Option<ObjectRecord>, StorageError> {
        if self.changes.removed_objects.contains(id) {
            return Ok(None);
        }
        match self.changes.objects.get(id) {
            Some(o) => Ok(Some(o.clone())),
            None => self.store.object(&self.changes.chat_id, id),
        }
    }

    pub(crate) fn put_object(&mut self, object: ObjectRecord) {
        self.changes.removed_objects.remove(&object.sync_obj_id);
        self.changes.objects.insert(object.sync_obj_id, object);
    }

    pub(crate) fn into_changes(self) -> Changes {
        self.changes
    }

    /// The staged changes, with the IDs this step prunes or erases that were retained
    /// before it, ascending (§9.3: later layers invalidate pending work that refers to them).
    pub(crate) fn finish(self) -> Result<(Changes, Vec<EventId>), StorageError> {
        let mut pruned = Vec::new();
        let gone = self
            .changes
            .rows
            .iter()
            .filter(|(_, row)| row.state == RowState::Pruned)
            .map(|(id, _)| id);
        for id in gone.chain(&self.changes.removed_rows) {
            if self
                .store
                .event_row(&self.changes.chat_id, id)?
                .is_some_and(|r| matches!(r.state, RowState::Held { .. }))
            {
                pruned.push(*id);
            }
        }
        pruned.sort_unstable();
        Ok((self.changes, pruned))
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
        if *chat_id != self.changes.chat_id || self.staged_count() == 0 {
            return Ok(base);
        }
        let mut merged: BTreeMap<EventId, EventRow> =
            base.into_iter().map(|r| (r.event_id, r)).collect();
        merged.extend(self.changes.rows.iter().map(|(k, v)| (*k, v.clone())));
        for id in &self.changes.removed_rows {
            merged.remove(id);
        }
        Ok(merged.into_values().collect())
    }

    fn held_ids(&self, chat_id: &ChatId) -> Result<Vec<EventId>, StorageError> {
        let base = self.store.held_ids(chat_id)?;
        if *chat_id != self.changes.chat_id || self.staged_count() == 0 {
            return Ok(base);
        }
        let mut ids: Vec<EventId> = base.into_iter().filter(|id| !self.staged(id)).collect();
        ids.extend(
            self.changes
                .rows
                .values()
                .filter(|r| matches!(r.state, RowState::Held { .. }))
                .map(|r| r.event_id),
        );
        ids.sort_unstable();
        Ok(ids)
    }

    fn carriers(
        &self,
        chat_id: &ChatId,
        ts_until: u64,
        limit: usize,
    ) -> Result<Vec<EventRow>, StorageError> {
        if *chat_id != self.changes.chat_id || self.staged_count() == 0 {
            return self.store.carriers(chat_id, ts_until, limit);
        }
        // Staged writes can replace at most `staged_count` of the store's answers.
        let fetch = limit.saturating_add(self.staged_count());
        let mut rows: Vec<EventRow> = self
            .store
            .carriers(chat_id, ts_until, fetch)?
            .into_iter()
            .filter(|r| !self.staged(&r.event_id))
            .collect();
        rows.extend(
            self.changes
                .rows
                .values()
                .filter(|r| r.role() == Some(Role::Current) && r.event_id.timestamp() <= ts_until)
                .cloned(),
        );
        rows.sort_unstable_by_key(|r| r.event_id);
        rows.truncate(limit);
        Ok(rows)
    }

    fn markers(&self, chat_id: &ChatId, limit: usize) -> Result<Vec<EventId>, StorageError> {
        if *chat_id != self.changes.chat_id || self.staged_count() == 0 {
            return self.store.markers(chat_id, limit);
        }
        let fetch = limit.saturating_add(self.staged_count());
        let mut ids: Vec<EventId> = self
            .store
            .markers(chat_id, fetch)?
            .into_iter()
            .filter(|id| !self.staged(id))
            .collect();
        ids.extend(
            self.changes
                .rows
                .values()
                .filter(|r| r.state == RowState::TemporarilyInvalid)
                .map(|r| r.event_id),
        );
        ids.sort_unstable();
        ids.truncate(limit);
        Ok(ids)
    }

    fn edges(&self, chat_id: &ChatId) -> Result<Vec<(EventId, Vec<EventId>)>, StorageError> {
        let base = self.store.edges(chat_id)?;
        if *chat_id != self.changes.chat_id
            || (self.changes.edges.is_empty() && self.changes.removed_edges.is_empty())
        {
            return Ok(base);
        }
        let mut merged: BTreeMap<EventId, Vec<EventId>> = base.into_iter().collect();
        merged.extend(self.changes.edges.iter().map(|(k, v)| (*k, v.clone())));
        for id in &self.changes.removed_edges {
            merged.remove(id);
        }
        Ok(merged.into_iter().collect())
    }

    fn parents(
        &self,
        chat_id: &ChatId,
        event_id: &EventId,
    ) -> Result<Option<Vec<EventId>>, StorageError> {
        if *chat_id == self.changes.chat_id {
            if self.changes.removed_edges.contains(event_id) {
                return Ok(None);
            }
            if let Some(p) = self.changes.edges.get(event_id) {
                return Ok(Some(p.clone()));
            }
        }
        self.store.parents(chat_id, event_id)
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
        if *chat_id != self.changes.chat_id || !self.objects_staged() {
            return Ok(base);
        }
        let mut merged: BTreeMap<SyncObjId, ObjectRecord> =
            base.into_iter().map(|o| (o.sync_obj_id, o)).collect();
        merged.extend(self.changes.objects.iter().map(|(k, v)| (*k, v.clone())));
        for id in &self.changes.removed_objects {
            merged.remove(id);
        }
        Ok(merged.into_values().collect())
    }

    fn pending_until(
        &self,
        chat_id: &ChatId,
        until: u64,
    ) -> Result<Vec<PendingItem>, StorageError> {
        let base = self.store.pending_until(chat_id, until)?;
        if *chat_id != self.changes.chat_id || !self.objects_staged() {
            return Ok(base);
        }
        // Staged objects, written or erased, replace the store's entries for the same sync
        // object.
        let mut items: Vec<PendingItem> = base
            .into_iter()
            .filter(|i| !self.staged_object(&i.sync_obj_id))
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

    fn first_pending(&self, chat_id: &ChatId) -> Result<Option<PendingItem>, StorageError> {
        if *chat_id != self.changes.chat_id || !self.objects_staged() {
            return self.store.first_pending(chat_id);
        }
        Ok(self.pending_until(chat_id, u64::MAX)?.into_iter().next())
    }

    fn reactions_to(
        &self,
        chat_id: &ChatId,
        target: &SyncObjId,
    ) -> Result<Vec<SyncObjId>, StorageError> {
        let base = self.store.reactions_to(chat_id, target)?;
        if *chat_id != self.changes.chat_id || !self.objects_staged() {
            return Ok(base);
        }
        let mut ids: Vec<SyncObjId> = base
            .into_iter()
            .filter(|id| !self.staged_object(id))
            .collect();
        ids.extend(
            self.changes
                .objects
                .values()
                .filter(|o| o.reaction_target() == Some(*target))
                .map(|o| o.sync_obj_id),
        );
        ids.sort_unstable();
        Ok(ids)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::epoch::tests::{Fixture, T0, text};
    use crate::store::{Role, RowState, Storage};

    /// The index reads of a transaction agree with its merged rows, whatever is staged.
    #[test]
    fn index_reads_see_the_staged_writes() {
        let mut f = Fixture::new();
        let chat = f.root.chat_id();
        let held = |f: &Fixture, n: u8, role| EventRow {
            event_id: EventId::new(T0 + u64::from(n), [n; 16]),
            state: RowState::Held {
                event: f.event(T0 + u64::from(n), n, &[], text(n, f.bob.id, T0, T0, "x")),
                role,
            },
        };
        let other = |n: u8, state| EventRow {
            event_id: EventId::new(T0 + u64::from(n), [n; 16]),
            state,
        };
        let mut c = Changes::new(chat);
        for r in [
            held(&f, 1, Role::Current),
            held(&f, 2, Role::Current),
            held(&f, 3, Role::PendingVersion { due: T0 + 9 }),
            held(&f, 4, Role::Current),
            other(5, RowState::TemporarilyInvalid),
            other(6, RowState::TemporarilyInvalid),
            other(7, RowState::Pruned),
        ] {
            c.rows.insert(r.event_id, r);
        }
        f.store.commit(c).unwrap();

        let mut tx = Tx::new(&f.store, chat);
        tx.put_row(other(1, RowState::Pruned));
        tx.put_row(held(&f, 7, Role::Current));
        tx.put_row(held(&f, 8, Role::Current));
        tx.put_row(other(9, RowState::TemporarilyInvalid));
        tx.remove_marker(EventId::new(T0 + 5, [5; 16]));

        let rows = tx.event_rows(&chat).unwrap();
        assert_eq!(rows.len(), 8);
        let ids = |p: &dyn Fn(&EventRow) -> bool| -> Vec<EventId> {
            rows.iter().filter(|r| p(r)).map(|r| r.event_id).collect()
        };
        let carriers = ids(&|r| r.role() == Some(Role::Current));
        assert_eq!(carriers.len(), 4);
        for limit in 0..6 {
            for until in [T0, T0 + 2, T0 + 7, u64::MAX] {
                let want: Vec<EventId> = carriers
                    .iter()
                    .filter(|id| id.timestamp() <= until)
                    .take(limit)
                    .copied()
                    .collect();
                let got: Vec<EventId> = tx
                    .carriers(&chat, until, limit)
                    .unwrap()
                    .iter()
                    .map(|r| r.event_id)
                    .collect();
                assert_eq!(got, want, "limit {limit}, until {until}");
            }
        }
        let markers = ids(&|r| r.state == RowState::TemporarilyInvalid);
        assert_eq!(tx.markers(&chat, usize::MAX).unwrap(), markers);
        assert_eq!(tx.markers(&chat, 1).unwrap(), markers[..1]);
        assert_eq!(
            tx.held_ids(&chat).unwrap(),
            ids(&|r| matches!(r.state, RowState::Held { .. }))
        );
        assert!(tx.row(&EventId::new(T0 + 5, [5; 16])).unwrap().is_none());
    }
}
