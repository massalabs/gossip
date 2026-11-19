//! Local changes: publishing a new message, an edit or a deletion (§7.2, §7.4), Retry
//! synchronisation of a message (§9.4), and local-only edits and deletions with the
//! withdrawal of shareability (§9.1 to §9.3).
//!
//! A published event is created with `ts = now`, the current eligible tips as parents
//! (§6.1), and applied locally through the same merge path as a received event. The caller
//! disseminates [`Published::event`] (§10).

use std::collections::BTreeMap;

use super::{Epoch, GroupState, Merge, absorb, apply_new, expire, prune, tick};
use crate::constants::MAX_SCHEDULE_MS;
use crate::dag;
use crate::error::Error;
use crate::event::{Body, Content, MessageEvent, Payload};
use crate::ids::{EventId, GossipId, SyncObjId};
use crate::rng::{Randomness, bytes};
use crate::store::tx::Tx;
use crate::store::{ObjectRecord, Storage, StorageError, StorageRead, StoredResult};

/// Why a local change was refused. Nothing was committed.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ChangeError {
    /// A storage failure.
    #[error(transparent)]
    Storage(#[from] StorageError),
    /// The epoch is not accepted.
    #[error("the epoch is not accepted")]
    NotAccepted,
    /// The group's state forbids sending (§5.4, §5.6, §5.8).
    #[error("the group's state forbids sending")]
    GroupState,
    /// The message is not known on this device.
    #[error("unknown message")]
    UnknownMessage,
    /// The message is deleted (the tombstone is absorbing).
    #[error("the message is deleted")]
    Deleted,
    /// The message has no current result yet (only pending versions).
    #[error("the message has no current result")]
    NoCurrentResult,
    /// A scheduled time is not after `now`.
    #[error("a scheduled time must be in the future")]
    NotInFuture,
    /// A local-only edit would set `last_modified_at` later than `now` (D.34): the message
    /// would disappear from the view until then, and honest edits dated before it would lose.
    #[error("a local-only edit cannot be dated later than now")]
    ModifiedInFuture,
    /// The fresh event ID is already known (a randomness failure).
    #[error("event ID collision")]
    IdCollision,
    /// The change breaks a protocol rule (a date beyond `MAX_SCHEDULE`, an author who is not a
    /// member, an invalid body or metadata, a size limit, an overflow).
    #[error(transparent)]
    Invalid(Error),
}

/// A published event and how it merged locally.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Published {
    /// The event to disseminate.
    pub event: MessageEvent,
    /// Its local merge.
    pub merge: Merge,
    /// The events the publication pruned that were retained before it, ascending (§9.3).
    pub pruned: Vec<EventId>,
}

/// A local-only edit (§9.1): each `Some` field replaces the stored one. Its `Debug` output
/// hides the metadata, as the body's does its content.
#[derive(Clone, Default, PartialEq, Eq)]
pub struct LocalEdit {
    /// New body.
    pub body: Option<Body>,
    /// New claimed author; it must be a member of the epoch, so that a Retry stays valid.
    pub author: Option<GossipId>,
    /// New `created_at`, entered by the user.
    pub created_at: Option<u64>,
    /// New `last_modified_at`, entered by the user; it wins over the automatic one.
    pub last_modified_at: Option<u64>,
    /// New metadata.
    pub metadata: Option<BTreeMap<String, Vec<u8>>>,
    /// New `edited` flag. None is added automatically.
    pub edited: Option<bool>,
}

impl core::fmt::Debug for LocalEdit {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.debug_struct("LocalEdit")
            .field("body", &self.body)
            .field("author", &self.author)
            .field("created_at", &self.created_at)
            .field("last_modified_at", &self.last_modified_at)
            .field(
                "metadata",
                &self
                    .metadata
                    .as_ref()
                    .map(|m| crate::redact::Entries(m.len())),
            )
            .field("edited", &self.edited)
            .finish()
    }
}

impl Epoch<'_> {
    fn check_can_send(&self) -> Result<(), ChangeError> {
        if !self.accepted {
            return Err(ChangeError::NotAccepted);
        }
        if self.group_state != GroupState::Active {
            return Err(ChangeError::GroupState);
        }
        Ok(())
    }

    /// Publishes a new message by `author` (this device's identity): `created_at =
    /// last_modified_at = now`, or `= S` when scheduled for `S` (§7.2). The sync-object ID is
    /// fresh and random.
    ///
    /// # Errors
    ///
    /// [`ChangeError`]; nothing was committed then.
    #[allow(clippy::too_many_arguments)]
    pub fn publish_message<S: Storage + ?Sized>(
        &self,
        store: &mut S,
        now: u64,
        rng: &mut dyn Randomness,
        author: GossipId,
        body: Body,
        metadata: BTreeMap<String, Vec<u8>>,
        scheduled_for: Option<u64>,
    ) -> Result<Published, ChangeError> {
        let at = scheduled_time(scheduled_for, now)?.unwrap_or(now);
        let sync_obj_id = SyncObjId::from_bytes(bytes(rng));
        self.publish(store, now, rng, |_| {
            Ok(Payload::Content(Content {
                sync_obj_id,
                author,
                created_at: at,
                last_modified_at: at,
                body,
                edited: false,
                metadata,
            }))
        })
    }

    /// Publishes an edit of a message of this epoch (§7.2): `created_at` and the author are
    /// kept, `edited = true`, and `last_modified_at = max(now, previous + 1)` with the
    /// previous value of the current applied result, or `S` when scheduled for `S`.
    ///
    /// # Errors
    ///
    /// [`ChangeError`]; nothing was committed then.
    #[allow(clippy::too_many_arguments)]
    pub fn publish_edit<S: Storage + ?Sized>(
        &self,
        store: &mut S,
        now: u64,
        rng: &mut dyn Randomness,
        sync_obj_id: SyncObjId,
        body: Body,
        metadata: BTreeMap<String, Vec<u8>>,
        scheduled_for: Option<u64>,
    ) -> Result<Published, ChangeError> {
        let scheduled = scheduled_time(scheduled_for, now)?;
        self.publish(store, now, rng, |tx| {
            let current = current_content(&object(tx, &sync_obj_id)?)?;
            let last_modified_at = match scheduled {
                Some(s) => s,
                None => next_modification(now, current.last_modified_at)?,
            };
            Ok(Payload::Content(Content {
                sync_obj_id,
                author: current.author,
                created_at: current.created_at,
                last_modified_at,
                body,
                edited: true,
                metadata,
            }))
        })
    }

    /// Publishes a deletion of a message of this epoch: immediate, or scheduled for `S`
    /// (§7.4).
    ///
    /// # Errors
    ///
    /// [`ChangeError`]; nothing was committed then.
    pub fn publish_deletion<S: Storage + ?Sized>(
        &self,
        store: &mut S,
        now: u64,
        rng: &mut dyn Randomness,
        sync_obj_id: SyncObjId,
        scheduled_for: Option<u64>,
    ) -> Result<Published, ChangeError> {
        let scheduled_at = scheduled_time(scheduled_for, now)?;
        self.publish(store, now, rng, |tx| {
            if object(tx, &sync_obj_id)?.is_deleted() {
                return Err(ChangeError::Deleted);
            }
            Ok(Payload::Delete {
                sync_obj_id,
                scheduled_at,
            })
        })
    }

    /// Retry synchronisation of a message (§9.4): republishes the stored complete result,
    /// unchanged, in a fresh event of this epoch (a tombstone as an immediate deletion).
    ///
    /// # Errors
    ///
    /// [`ChangeError`]; nothing was committed then.
    pub fn retry<S: Storage + ?Sized>(
        &self,
        store: &mut S,
        now: u64,
        rng: &mut dyn Randomness,
        sync_obj_id: SyncObjId,
    ) -> Result<Published, ChangeError> {
        self.publish(store, now, rng, |tx| {
            let obj = object(tx, &sync_obj_id)?;
            let current = obj.current.as_ref().ok_or(ChangeError::NoCurrentResult)?;
            Ok(current.to_payload(sync_obj_id))
        })
    }

    /// The shared publication path: tick, build the payload against the current state, take
    /// the tips as parents, create the event with `ts = now`, apply it, commit.
    fn publish<S: Storage + ?Sized>(
        &self,
        store: &mut S,
        now: u64,
        rng: &mut dyn Randomness,
        build: impl FnOnce(&Tx<'_, S>) -> Result<Payload, ChangeError>,
    ) -> Result<Published, ChangeError> {
        self.check_can_send()?;
        let chat = self.chat_id();
        let mut tx = Tx::new(&*store, chat);
        tick(&mut tx, now)?;
        let payload = build(&tx)?;
        let tips = dag::tips(&tx, &chat, now)?;
        let parents = dag::choose_parents(&tips, rng);
        let event_id = EventId::new(now, bytes(rng));
        if tx.row(&event_id)?.is_some() || parents.contains(&event_id) {
            return Err(ChangeError::IdCollision);
        }
        let event = MessageEvent::create(self.root, event_id, &parents, payload)
            .map_err(ChangeError::Invalid)?;
        let merge = apply_new(&mut tx, event.clone(), now)?;
        expire(&mut tx, now)?;
        let (changes, pruned) = tx.finish()?;
        store.commit(changes)?;
        Ok(Published {
            event,
            merge,
            pruned,
        })
    }

    /// A local-only edit (§9.1), then the withdrawal of shareability (§9.3): the stored
    /// result is replaced, nothing is sent, and every content event of the message (carriers
    /// of the old result and pending versions) is pruned to a stub.
    ///
    /// A body or metadata change sets `last_modified_at = max(now, previous + 1)` unless a
    /// date is given. A resulting `last_modified_at` later than `now` is refused (D.34,
    /// choice A; §9.1 allows any date), so after the clock moved back the user waits or
    /// enters a date. A `created_at` beyond `now + MAX_SCHEDULE` is refused, so that a Retry
    /// stays valid; the new result must pass every rule a published one passes.
    ///
    /// Returns every ID the operation pruned, ascending, so that pending outgoing work that
    /// refers to them can be invalidated (§9.3).
    ///
    /// # Errors
    ///
    /// [`ChangeError`]; nothing was committed then.
    pub fn local_edit<S: Storage + ?Sized>(
        &self,
        store: &mut S,
        now: u64,
        sync_obj_id: SyncObjId,
        edit: LocalEdit,
    ) -> Result<Vec<EventId>, ChangeError> {
        if !self.accepted {
            return Err(ChangeError::NotAccepted);
        }
        let mut tx = Tx::new(&*store, self.chat_id());
        tick(&mut tx, now)?;
        let mut obj = object(&tx, &sync_obj_id)?;
        let old = current_content(&obj)?;
        let content_edit = edit.body.as_ref().is_some_and(|b| *b != old.body)
            || edit.metadata.as_ref().is_some_and(|m| *m != old.metadata);
        let mut new = old.clone();
        if let Some(body) = edit.body {
            new.body = body;
        }
        if let Some(metadata) = edit.metadata {
            new.metadata = metadata;
        }
        if let Some(author) = edit.author {
            new.author = author;
        }
        if let Some(created_at) = edit.created_at {
            new.created_at = created_at;
        }
        if let Some(edited) = edit.edited {
            new.edited = edited;
        }
        new.last_modified_at = match edit.last_modified_at {
            Some(t) => t,
            None if content_edit => next_modification(now, old.last_modified_at)?,
            None => old.last_modified_at,
        };
        if new.last_modified_at > now {
            return Err(ChangeError::ModifiedInFuture);
        }
        // The bound of §9.1 is the bound of §7.2 for an event created now, so validating the
        // result as such an event checks it together with every other rule.
        MessageEvent::create(
            self.root,
            EventId::new(now, [0; 16]),
            &[],
            Payload::Content(new.clone()),
        )
        .map_err(ChangeError::Invalid)?;

        obj.current = Some(StoredResult::Content(new));
        for old_id in core::mem::take(&mut obj.current_events) {
            prune(&mut tx, old_id);
        }
        for (_, old_id) in core::mem::take(&mut obj.pending_versions) {
            prune(&mut tx, old_id);
        }
        // Pending scheduled deletions carry no content; they stay pending.
        tx.put_object(obj);
        let (changes, pruned) = tx.finish()?;
        store.commit(changes)?;
        Ok(pruned)
    }

    /// A local-only deletion (§9.2, §9.3): the message is replaced by its tombstone, nothing
    /// is sent, and every content event of the message is pruned to a stub. Pending scheduled
    /// deletions carry no content and stay pending, as on a local-only edit (D.28, D.31):
    /// each keeps its scheduled form until its own time.
    ///
    /// Returns every ID the operation pruned, ascending (§9.3).
    ///
    /// # Errors
    ///
    /// [`ChangeError`]; nothing was committed then.
    pub fn local_delete<S: Storage + ?Sized>(
        &self,
        store: &mut S,
        now: u64,
        sync_obj_id: SyncObjId,
    ) -> Result<Vec<EventId>, ChangeError> {
        if !self.accepted {
            return Err(ChangeError::NotAccepted);
        }
        let mut tx = Tx::new(&*store, self.chat_id());
        tick(&mut tx, now)?;
        let mut obj = object(&tx, &sync_obj_id)?;
        if obj.is_deleted() {
            return Err(ChangeError::Deleted);
        }
        absorb(&mut tx, &mut obj, None)?;
        tx.put_object(obj);
        let (changes, pruned) = tx.finish()?;
        store.commit(changes)?;
        Ok(pruned)
    }
}

fn object<S: StorageRead + ?Sized>(
    tx: &Tx<'_, S>,
    sync_obj_id: &SyncObjId,
) -> Result<ObjectRecord, ChangeError> {
    tx.object(sync_obj_id)?.ok_or(ChangeError::UnknownMessage)
}

fn current_content(obj: &ObjectRecord) -> Result<Content, ChangeError> {
    match &obj.current {
        Some(StoredResult::Content(c)) => Ok(c.clone()),
        Some(StoredResult::Tombstone) => Err(ChangeError::Deleted),
        None => Err(ChangeError::NoCurrentResult),
    }
}

/// `max(now, previous + 1)` (§7.2, §9.1).
fn next_modification(now: u64, previous: u64) -> Result<u64, ChangeError> {
    let next = previous
        .checked_add(1)
        .ok_or(ChangeError::Invalid(Error::Overflow(
            "last_modified_at + 1",
        )))?;
    Ok(now.max(next))
}

/// A scheduled time must be after `now`; its bound `now + MAX_SCHEDULE` is checked when the
/// event is created (§7.2).
fn scheduled_time(scheduled_for: Option<u64>, now: u64) -> Result<Option<u64>, ChangeError> {
    match scheduled_for {
        Some(s) if s <= now => Err(ChangeError::NotInFuture),
        Some(s)
            if now
                .checked_add(MAX_SCHEDULE_MS)
                .is_some_and(|limit| s > limit) =>
        {
            Err(ChangeError::Invalid(Error::BeyondSchedule(
                "scheduled time",
            )))
        }
        other => Ok(other),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::constants::RETENTION_MS;
    use crate::epoch::tests::{Fixture, MIN, T0, del, ep, sid, text};
    use crate::epoch::{Outcome, check_invariants};
    use crate::rng::TestRng;
    use crate::store::{Role, RowState};

    fn hello(f: &mut Fixture, rng: &mut TestRng, now: u64) -> Published {
        let author = f.alice.id;
        ep(&f.root)
            .publish_message(
                &mut f.store,
                now,
                rng,
                author,
                Body::Text("hello".into()),
                BTreeMap::new(),
                None,
            )
            .unwrap()
    }

    fn content_of(p: &Published) -> Content {
        match p.event.payload() {
            Payload::Content(c) => c.clone(),
            Payload::Delete { .. } => panic!("not content"),
        }
    }

    fn check(f: &Fixture, now: u64) {
        check_invariants(&f.store, &f.root.chat_id(), now).unwrap();
    }

    #[test]
    fn a_new_message_uses_now_and_the_tips() {
        let mut f = Fixture::new();
        let mut rng = TestRng::new(1);
        let first = hello(&mut f, &mut rng, T0);
        assert_eq!(first.merge, Merge::Won);
        assert_eq!(first.event.timestamp(), T0);
        assert!(first.event.parents().is_empty());
        let c = content_of(&first);
        assert_eq!(
            (c.created_at, c.last_modified_at, c.edited),
            (T0, T0, false)
        );
        assert_eq!(c.author, f.alice.id);
        let second = hello(&mut f, &mut rng, T0 + 1);
        assert_eq!(second.event.parents(), &[first.event.event_id()]);
        assert_ne!(content_of(&second).sync_obj_id, c.sync_obj_id);
        assert_eq!(f.tips(T0 + 1), vec![second.event.event_id()]);
        check(&f, T0 + 1);
    }

    #[test]
    fn a_scheduled_message_uses_its_time() {
        let mut f = Fixture::new();
        let mut rng = TestRng::new(1);
        let s = T0 + 10 * MIN;
        let author = f.alice.id;
        let p = ep(&f.root)
            .publish_message(
                &mut f.store,
                T0,
                &mut rng,
                author,
                Body::Text("later".into()),
                BTreeMap::new(),
                Some(s),
            )
            .unwrap();
        assert_eq!(p.merge, Merge::Pending);
        assert_eq!(p.event.timestamp(), T0);
        let c = content_of(&p);
        assert_eq!((c.created_at, c.last_modified_at), (s, s));
        for (when, err) in [
            (T0, ChangeError::NotInFuture),
            (
                T0 + MAX_SCHEDULE_MS + 1,
                ChangeError::Invalid(Error::BeyondSchedule("scheduled time")),
            ),
        ] {
            assert_eq!(
                ep(&f.root).publish_message(
                    &mut f.store,
                    T0,
                    &mut rng,
                    author,
                    Body::Text("x".into()),
                    BTreeMap::new(),
                    Some(when),
                ),
                Err(err)
            );
        }
        // The boundary is allowed.
        assert!(
            ep(&f.root)
                .publish_message(
                    &mut f.store,
                    T0,
                    &mut rng,
                    author,
                    Body::Text("x".into()),
                    BTreeMap::new(),
                    Some(T0 + MAX_SCHEDULE_MS),
                )
                .is_ok()
        );
        // An outsider cannot be the author.
        let carol = f.carol.id;
        assert_eq!(
            ep(&f.root).publish_message(
                &mut f.store,
                T0,
                &mut rng,
                carol,
                Body::Text("x".into()),
                BTreeMap::new(),
                None,
            ),
            Err(ChangeError::Invalid(Error::NotMember("the claimed author")))
        );
    }

    #[test]
    fn sending_needs_an_accepted_active_epoch() {
        let mut f = Fixture::new();
        let mut rng = TestRng::new(1);
        let author = f.alice.id;
        for (accepted, state, err) in [
            (false, GroupState::Active, ChangeError::NotAccepted),
            (true, GroupState::ReadOnlyAfterKick, ChangeError::GroupState),
            (true, GroupState::Waiting, ChangeError::GroupState),
            (true, GroupState::Dissolved, ChangeError::GroupState),
        ] {
            assert_eq!(
                Epoch::new(&f.root, accepted, state).publish_message(
                    &mut f.store,
                    T0,
                    &mut rng,
                    author,
                    Body::Text("x".into()),
                    BTreeMap::new(),
                    None,
                ),
                Err(err)
            );
        }
        assert_eq!(f.store.commits(), 0);
    }

    #[test]
    fn changes_over_the_size_limits_are_refused() {
        let mut f = Fixture::new();
        let mut rng = TestRng::new(1);
        let sync = content_of(&hello(&mut f, &mut rng, T0)).sync_obj_id;
        let commits = f.store.commits();
        let author = f.alice.id;
        let short = || Body::Text("x".into());
        let long = || Body::Text("x".repeat(16_385));
        let none = BTreeMap::new;
        // 16,385 bytes as encoded (see `event::tests`).
        let big = || BTreeMap::from([("k".to_owned(), vec![0; 16_376])]);
        let too_long = |field, got| {
            ChangeError::Invalid(Error::TooMany {
                field,
                max: 16_384,
                got,
            })
        };
        for (body, metadata, err) in [
            (long(), none(), too_long("text", 16_385)),
            (short(), big(), too_long("metadata", 16_385)),
        ] {
            assert_eq!(
                ep(&f.root)
                    .publish_message(
                        &mut f.store,
                        T0 + 1,
                        &mut rng,
                        author,
                        body.clone(),
                        metadata.clone(),
                        None,
                    )
                    .map(|_| ()),
                Err(err.clone())
            );
            assert_eq!(
                ep(&f.root)
                    .publish_edit(
                        &mut f.store,
                        T0 + 1,
                        &mut rng,
                        sync,
                        body.clone(),
                        metadata.clone(),
                        None,
                    )
                    .map(|_| ()),
                Err(err.clone())
            );
            assert_eq!(
                ep(&f.root).local_edit(
                    &mut f.store,
                    T0 + 1,
                    sync,
                    LocalEdit {
                        body: Some(body),
                        metadata: Some(metadata),
                        ..Default::default()
                    },
                ),
                Err(err)
            );
        }
        assert_eq!(f.store.commits(), commits);
    }

    #[test]
    fn an_edit_keeps_creation_and_author_and_moves_time_forward() {
        let mut f = Fixture::new();
        let mut rng = TestRng::new(1);
        let first = hello(&mut f, &mut rng, T0);
        let sync = content_of(&first).sync_obj_id;
        // Bob edits Alice's message: the claimed author is kept.
        let edit = ep(&f.root)
            .publish_edit(
                &mut f.store,
                T0 + 100,
                &mut rng,
                sync,
                Body::Text("edited".into()),
                BTreeMap::new(),
                None,
            )
            .unwrap();
        assert_eq!(edit.merge, Merge::Won);
        let c = content_of(&edit);
        assert_eq!(
            (c.created_at, c.last_modified_at, c.edited, c.author),
            (T0, T0 + 100, true, f.alice.id)
        );
        assert_eq!(edit.event.parents(), &[first.event.event_id()]);
        assert_eq!(
            f.row(first.event.event_id()).unwrap().state,
            RowState::Pruned
        );
        // With the clock behind, the edit still moves past the current result.
        let again = ep(&f.root)
            .publish_edit(
                &mut f.store,
                T0 + 50,
                &mut rng,
                sync,
                Body::Text("again".into()),
                BTreeMap::new(),
                None,
            )
            .unwrap();
        assert_eq!(content_of(&again).last_modified_at, T0 + 101);
        // It is then a future version for 51 ms (§7.3): merging depends on the date only.
        assert_eq!(again.merge, Merge::Pending);
        check(&f, T0 + 50);
    }

    /// §2.2: an edit starts from the message's current metadata, so that entries a client
    /// does not know (and `replyTo`) survive an edit by it; the SDK passes no metadata by
    /// default.
    #[test]
    fn an_edit_keeps_the_metadata_it_does_not_patch() {
        let mut f = Fixture::new();
        let mut rng = TestRng::new(1);
        let author = f.alice.id;
        let reply = crate::event::encode_reply_to(&[crate::event::ReplyTarget {
            ref_chat_id: f.root.ref_chat_id(),
            sync_obj_id: sid(7),
        }])
        .unwrap();
        let original = BTreeMap::from([
            ("replyTo".to_owned(), reply),
            ("x.unknown".to_owned(), vec![2]),
        ]);
        let sync = content_of(
            &ep(&f.root)
                .publish_message(
                    &mut f.store,
                    T0,
                    &mut rng,
                    author,
                    Body::Text("hello".into()),
                    original.clone(),
                    None,
                )
                .unwrap(),
        )
        .sync_obj_id;
        let edit = |f: &mut Fixture, rng: &mut TestRng, at, metadata| {
            content_of(
                &ep(&f.root)
                    .publish_edit(
                        &mut f.store,
                        at,
                        rng,
                        sync,
                        Body::Text("edited".into()),
                        metadata,
                        None,
                    )
                    .unwrap(),
            )
            .metadata
        };
        assert_eq!(edit(&mut f, &mut rng, T0 + 1, BTreeMap::new()), original);
        let mut expected = original.clone();
        expected.insert("k".into(), vec![3]);
        assert_eq!(
            edit(
                &mut f,
                &mut rng,
                T0 + 2,
                BTreeMap::from([("k".to_owned(), vec![3])])
            ),
            expected
        );
    }

    #[test]
    fn an_edit_ranks_against_the_applied_result_not_a_pending_one() {
        let mut f = Fixture::new();
        let mut rng = TestRng::new(1);
        let sync = content_of(&hello(&mut f, &mut rng, T0)).sync_obj_id;
        let s = T0 + 10 * MIN;
        let scheduled = ep(&f.root)
            .publish_edit(
                &mut f.store,
                T0 + 1,
                &mut rng,
                sync,
                Body::Text("friday".into()),
                BTreeMap::new(),
                Some(s),
            )
            .unwrap();
        assert_eq!(scheduled.merge, Merge::Pending);
        assert_eq!(content_of(&scheduled).last_modified_at, s);
        let now_edit = ep(&f.root)
            .publish_edit(
                &mut f.store,
                T0 + 2,
                &mut rng,
                sync,
                Body::Text("now".into()),
                BTreeMap::new(),
                None,
            )
            .unwrap();
        assert_eq!(content_of(&now_edit).last_modified_at, T0 + 2);
        assert_eq!(now_edit.merge, Merge::Won);
        let body = |f: &Fixture| match f.store.object(&f.root.chat_id(), &sync).unwrap() {
            Some(ObjectRecord {
                current: Some(StoredResult::Content(c)),
                ..
            }) => c.body,
            other => panic!("{other:?}"),
        };
        assert_eq!(body(&f), Body::Text("now".into()));
        // The scheduled edit still takes over at its time.
        f.tick(s);
        assert_eq!(body(&f), Body::Text("friday".into()));
    }

    #[test]
    fn edits_and_deletions_need_a_live_message() {
        let mut f = Fixture::new();
        let mut rng = TestRng::new(1);
        let edit = |f: &mut Fixture, rng: &mut TestRng, sync| {
            ep(&f.root).publish_edit(
                &mut f.store,
                T0 + 5,
                rng,
                sync,
                Body::Text("x".into()),
                BTreeMap::new(),
                None,
            )
        };
        assert_eq!(
            edit(&mut f, &mut rng, sid(9)),
            Err(ChangeError::UnknownMessage)
        );
        assert_eq!(
            ep(&f.root).publish_deletion(&mut f.store, T0, &mut rng, sid(9), None),
            Err(ChangeError::UnknownMessage)
        );
        // Only a pending version: nothing to edit yet.
        let pending = f.event(T0, 1, &[], text(1, f.bob.id, T0 + MIN, T0 + MIN, "p"));
        f.recv(&pending, T0);
        assert_eq!(
            edit(&mut f, &mut rng, sid(1)),
            Err(ChangeError::NoCurrentResult)
        );
        // Deleted.
        let d = f.event(T0, 2, &[], del(2, None));
        f.recv(&d, T0);
        assert_eq!(edit(&mut f, &mut rng, sid(2)), Err(ChangeError::Deleted));
        assert_eq!(
            ep(&f.root).publish_deletion(&mut f.store, T0, &mut rng, sid(2), None),
            Err(ChangeError::Deleted)
        );
    }

    #[test]
    fn deletions_immediate_and_scheduled() {
        let mut f = Fixture::new();
        let mut rng = TestRng::new(1);
        let a = content_of(&hello(&mut f, &mut rng, T0)).sync_obj_id;
        let b = content_of(&hello(&mut f, &mut rng, T0)).sync_obj_id;
        let now = ep(&f.root)
            .publish_deletion(&mut f.store, T0 + 1, &mut rng, a, None)
            .unwrap();
        assert_eq!(now.merge, Merge::Won);
        let later = ep(&f.root)
            .publish_deletion(&mut f.store, T0 + 1, &mut rng, b, Some(T0 + MIN))
            .unwrap();
        assert_eq!(later.merge, Merge::Pending);
        assert_eq!(
            *later.event.payload(),
            Payload::Delete {
                sync_obj_id: b,
                scheduled_at: Some(T0 + MIN)
            }
        );
        assert_eq!(
            ep(&f.root).publish_deletion(&mut f.store, T0 + 1, &mut rng, b, Some(T0 + 1)),
            Err(ChangeError::NotInFuture)
        );
        f.tick(T0 + MIN);
        let obj = f.store.object(&f.root.chat_id(), &b).unwrap().unwrap();
        assert!(obj.is_deleted());
        check(&f, T0 + MIN);
    }

    #[test]
    fn retry_republishes_the_stored_result_unchanged() {
        let mut f = Fixture::new();
        let mut rng = TestRng::new(1);
        let first = hello(&mut f, &mut rng, T0);
        let sync = content_of(&first).sync_obj_id;
        let retry = ep(&f.root)
            .retry(&mut f.store, T0 + 10, &mut rng, sync)
            .unwrap();
        assert_eq!(retry.merge, Merge::Identical);
        assert_eq!(retry.event.timestamp(), T0 + 10);
        assert_ne!(retry.event.event_id(), first.event.event_id());
        assert_eq!(retry.event.payload(), first.event.payload());
        assert_eq!(retry.event.parents(), &[first.event.event_id()]);
        // A deleted message is retried as an immediate deletion.
        ep(&f.root)
            .publish_deletion(&mut f.store, T0 + 20, &mut rng, sync, Some(T0 + 30))
            .unwrap();
        f.tick(T0 + 30);
        let r = ep(&f.root)
            .retry(&mut f.store, T0 + 40, &mut rng, sync)
            .unwrap();
        assert_eq!(
            *r.event.payload(),
            Payload::Delete {
                sync_obj_id: sync,
                scheduled_at: None
            }
        );
        assert_eq!(r.merge, Merge::Identical);
        assert_eq!(
            ep(&f.root).retry(&mut f.store, T0, &mut rng, sid(9)),
            Err(ChangeError::UnknownMessage)
        );
    }

    #[test]
    fn a_local_edit_withdraws_every_content_event() {
        let mut f = Fixture::new();
        let a = f.event(T0, 1, &[], text(1, f.bob.id, T0, T0, "a"));
        let a2 = f.event(T0, 2, &[], text(1, f.bob.id, T0, T0, "a"));
        let v = f.event(T0, 3, &[], text(1, f.bob.id, T0, T0 + MIN, "v"));
        let ds = f.event(T0, 4, &[], del(1, Some(T0 + 2 * MIN)));
        for e in [&a, &a2, &v, &ds] {
            f.recv(e, T0);
        }
        let pruned = ep(&f.root)
            .local_edit(
                &mut f.store,
                T0 + 10,
                sid(1),
                LocalEdit {
                    body: Some(Body::Text("altered".into())),
                    ..Default::default()
                },
            )
            .unwrap();
        // The pruned IDs are reported, so that pending work referring to them can be dropped.
        assert_eq!(pruned, vec![a.event_id(), a2.event_id(), v.event_id()]);
        for e in [&a, &a2, &v] {
            assert_eq!(f.row(e.event_id()).unwrap().state, RowState::Pruned);
            assert!(f.has_edges(e.event_id()));
        }
        // A content-free pending deletion stays pending.
        assert_eq!(
            f.row(ds.event_id()).unwrap().role(),
            Some(Role::PendingDeletion { due: T0 + 2 * MIN })
        );
        let obj = f.obj(1);
        let Some(StoredResult::Content(c)) = obj.current else {
            panic!("content expected");
        };
        assert_eq!(c.body, Body::Text("altered".into()));
        // A content edit sets max(now, previous + 1); no edited flag is added.
        assert_eq!((c.last_modified_at, c.edited), (T0 + 10, false));
        // Nothing of the message is served any more.
        for e in [&a, &a2, &v] {
            assert!(
                f.epoch()
                    .serve(&f.store, &e.event_id(), T0 + 10)
                    .unwrap()
                    .is_none()
            );
        }
        assert!(obj.current_events.is_empty());
        check(&f, T0 + 10);
        // Later results merge normally against the altered one.
        let newer = f.event(T0 + 20, 5, &[], text(1, f.bob.id, T0, T0 + 20, "newer"));
        assert_eq!(f.recv(&newer, T0 + 20), Outcome::Accepted(Merge::Won));
        let older = f.event(T0 + 21, 6, &[], text(1, f.bob.id, T0, T0 + 5, "older"));
        assert_eq!(f.recv(&older, T0 + 21), Outcome::Accepted(Merge::Lost));
    }

    #[test]
    fn local_edit_dates_and_fields() {
        let mut f = Fixture::new();
        let a = f.event(T0, 1, &[], text(1, f.bob.id, T0, T0 + 50, "a"));
        f.recv(&a, T0 + 50);
        let edit = |f: &mut Fixture, e: LocalEdit| {
            ep(&f.root).local_edit(&mut f.store, T0 + 10, sid(1), e)
        };
        // With the clock behind, previous + 1 is later than now: refused (D.34).
        let b = LocalEdit {
            body: Some(Body::Text("b".into())),
            ..Default::default()
        };
        assert_eq!(edit(&mut f, b.clone()), Err(ChangeError::ModifiedInFuture));
        assert_eq!(
            edit(
                &mut f,
                LocalEdit {
                    last_modified_at: Some(T0 + 11),
                    ..Default::default()
                }
            ),
            Err(ChangeError::ModifiedInFuture)
        );
        // max(now, previous + 1) otherwise.
        ep(&f.root)
            .local_edit(&mut f.store, T0 + 51, sid(1), b)
            .unwrap();
        let cur = |f: &Fixture| match f.obj(1).current {
            Some(StoredResult::Content(c)) => c,
            _ => panic!(),
        };
        assert_eq!(cur(&f).last_modified_at, T0 + 51);
        // An explicit date wins; date-only edits keep last_modified_at.
        edit(
            &mut f,
            LocalEdit {
                body: Some(Body::Text("c".into())),
                last_modified_at: Some(7),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(cur(&f).last_modified_at, 7);
        let alice = f.alice.id;
        edit(
            &mut f,
            LocalEdit {
                created_at: Some(3),
                edited: Some(true),
                author: Some(alice),
                ..Default::default()
            },
        )
        .unwrap();
        let c = cur(&f);
        assert_eq!(
            (c.created_at, c.last_modified_at, c.edited, c.author),
            (3, 7, true, f.alice.id)
        );
        // Bounds.
        let limit = T0 + 10 + MAX_SCHEDULE_MS;
        assert!(
            edit(
                &mut f,
                LocalEdit {
                    created_at: Some(limit),
                    ..Default::default()
                }
            )
            .is_ok()
        );
        assert_eq!(
            edit(
                &mut f,
                LocalEdit {
                    created_at: Some(limit + 1),
                    ..Default::default()
                }
            ),
            Err(ChangeError::Invalid(Error::BeyondSchedule("created_at")))
        );
        assert_eq!(
            edit(
                &mut f,
                LocalEdit {
                    last_modified_at: Some(limit + 1),
                    ..Default::default()
                }
            ),
            Err(ChangeError::ModifiedInFuture)
        );
        let carol = f.carol.id;
        assert_eq!(
            edit(
                &mut f,
                LocalEdit {
                    author: Some(carol),
                    ..Default::default()
                }
            ),
            Err(ChangeError::Invalid(Error::NotMember("the claimed author")))
        );
        assert_eq!(
            ep(&f.root).local_edit(&mut f.store, T0, sid(9), LocalEdit::default()),
            Err(ChangeError::UnknownMessage)
        );
        assert_eq!(
            Epoch::new(&f.root, false, GroupState::Active).local_edit(
                &mut f.store,
                T0,
                sid(1),
                LocalEdit::default()
            ),
            Err(ChangeError::NotAccepted)
        );
        // Retry of an altered result is a valid event.
        let mut rng = TestRng::new(3);
        assert!(
            ep(&f.root)
                .retry(&mut f.store, T0 + 10, &mut rng, sid(1))
                .is_ok()
        );
    }

    #[test]
    fn a_local_deletion_prunes_every_content_event_and_sends_nothing() {
        let mut f = Fixture::new();
        let a = f.event(T0, 1, &[], text(1, f.bob.id, T0, T0, "a"));
        let v = f.event(T0, 2, &[], text(1, f.bob.id, T0, T0 + MIN, "v"));
        let ds = f.event(T0, 3, &[], del(1, Some(T0 + 2 * MIN)));
        for e in [&a, &v, &ds] {
            f.recv(e, T0);
        }
        let before = f.store.commits();
        let pruned = ep(&f.root)
            .local_delete(&mut f.store, T0 + 1, sid(1))
            .unwrap();
        assert_eq!(pruned, vec![a.event_id(), v.event_id()]);
        assert_eq!(f.store.commits(), before + 1);
        assert!(f.obj(1).is_deleted());
        for e in [&a, &v] {
            assert_eq!(f.row(e.event_id()).unwrap().state, RowState::Pruned);
        }
        // No content is served. The scheduled deletion carries none: it stays pending and is
        // served in its scheduled form until its own time (D.28, D.31), never earlier in its
        // immediate form.
        assert_eq!(f.tips(T0 + 1), vec![ds.event_id()]);
        assert_eq!(
            f.epoch().serve(&f.store, &ds.event_id(), T0 + 1).unwrap(),
            Some(ds.clone())
        );
        assert_eq!(
            ep(&f.root).local_delete(&mut f.store, T0 + 1, sid(1)),
            Err(ChangeError::Deleted)
        );
        // A real deletion arriving later is kept and served as usual.
        let d = f.event(T0 + 2, 4, &[], del(1, None));
        assert_eq!(f.recv(&d, T0 + 2), Outcome::Accepted(Merge::Identical));
        check(&f, T0 + 2);
        // Retention later prunes them like any other event.
        f.tick(T0 + 2 + RETENTION_MS);
        assert!(f.tips(T0 + 2 + RETENTION_MS).is_empty());
    }

    #[test]
    fn a_pruned_event_with_another_result_stays_pruned_even_if_it_would_win() {
        let mut f = Fixture::new();
        let a = f.event(T0, 1, &[], text(1, f.bob.id, T0, T0, "hello"));
        f.recv(&a, T0);
        // A local alteration prunes the event; a duplicate of the original must not come back.
        ep(&f.root)
            .local_edit(
                &mut f.store,
                T0 + 1,
                sid(1),
                LocalEdit {
                    body: Some(Body::Text("bye".into())),
                    last_modified_at: Some(T0 - 100),
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(f.state(&a), Some(RowState::Pruned));
        assert_eq!(f.recv(&a, T0 + 2), Outcome::KeptPruned);
        assert_eq!(f.state(&a), Some(RowState::Pruned));
        assert_eq!(f.current_text(1).as_deref(), Some("bye"));
    }
}
