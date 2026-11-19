//! Deterministic identities for tests.

use auth::{StaticRootSecret, UserPublicKeys, UserSecretKeys, derive_keys_from_static_root_secret};

use crate::ids::GossipId;

pub(crate) struct Identity {
    pub public: UserPublicKeys,
    pub secret: UserSecretKeys,
    pub id: GossipId,
}

/// The identity derived by `auth` from the root secret `[seed; 32]`.
pub(crate) fn identity(seed: u8) -> Identity {
    let (public, secret) =
        derive_keys_from_static_root_secret(&StaticRootSecret::from_bytes([seed; 32]));
    let id = GossipId::of_keys(&public);
    Identity { public, secret, id }
}

/// A store wrapper for tests: it counts the records its reads return, and its commits fail
/// while `fail_commits` is set.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct Instrumented<S> {
    pub inner: S,
    pub fail_commits: bool,
    reads: std::cell::Cell<u64>,
}

impl<S> Instrumented<S> {
    pub(crate) fn new(inner: S) -> Self {
        Self {
            inner,
            fail_commits: false,
            reads: std::cell::Cell::new(0),
        }
    }

    /// The number of records (rows, IDs, edges, objects, pending items) returned so far.
    pub(crate) fn reads(&self) -> u64 {
        self.reads.get()
    }

    fn count<T>(&self, n: usize, value: T) -> T {
        self.reads.set(self.reads.get() + n as u64);
        value
    }
}

mod instrumented {
    use super::Instrumented;
    use crate::ids::{ChatId, EventId, SyncObjId};
    use crate::store::{
        Changes, EventRow, ObjectRecord, PendingItem, Storage, StorageError, StorageRead,
    };

    type R<T> = Result<T, StorageError>;

    impl<S: StorageRead> StorageRead for Instrumented<S> {
        fn event_row(&self, c: &ChatId, e: &EventId) -> R<Option<EventRow>> {
            let v = self.inner.event_row(c, e)?;
            Ok(self.count(1, v))
        }
        fn event_rows(&self, c: &ChatId) -> R<Vec<EventRow>> {
            let v = self.inner.event_rows(c)?;
            Ok(self.count(v.len(), v))
        }
        fn edges(&self, c: &ChatId) -> R<Vec<(EventId, Vec<EventId>)>> {
            let v = self.inner.edges(c)?;
            Ok(self.count(v.len(), v))
        }
        fn parents(&self, c: &ChatId, e: &EventId) -> R<Option<Vec<EventId>>> {
            let v = self.inner.parents(c, e)?;
            Ok(self.count(1, v))
        }
        fn held_ids(&self, c: &ChatId) -> R<Vec<EventId>> {
            let v = self.inner.held_ids(c)?;
            Ok(self.count(v.len(), v))
        }
        fn carriers(&self, c: &ChatId, ts_until: u64, limit: usize) -> R<Vec<EventRow>> {
            let v = self.inner.carriers(c, ts_until, limit)?;
            Ok(self.count(v.len(), v))
        }
        fn markers(&self, c: &ChatId, limit: usize) -> R<Vec<EventId>> {
            let v = self.inner.markers(c, limit)?;
            Ok(self.count(v.len(), v))
        }
        fn object(&self, c: &ChatId, s: &SyncObjId) -> R<Option<ObjectRecord>> {
            let v = self.inner.object(c, s)?;
            Ok(self.count(1, v))
        }
        fn objects(&self, c: &ChatId) -> R<Vec<ObjectRecord>> {
            let v = self.inner.objects(c)?;
            Ok(self.count(v.len(), v))
        }
        fn pending_until(&self, c: &ChatId, u: u64) -> R<Vec<PendingItem>> {
            let v = self.inner.pending_until(c, u)?;
            Ok(self.count(v.len(), v))
        }
        fn first_pending(&self, c: &ChatId) -> R<Option<PendingItem>> {
            let v = self.inner.first_pending(c)?;
            Ok(self.count(1, v))
        }
    }

    impl<S: Storage> Storage for Instrumented<S> {
        fn commit(&mut self, changes: Changes) -> R<()> {
            if self.fail_commits {
                return Err(StorageError("injected failure".into()));
            }
            self.inner.commit(changes)
        }
    }
}
