//! Unit tests of receiving, merging, scheduling, retention and tips (§6, §7, §8, §9.5,
//! §9.6, §12.1).

use std::collections::BTreeMap;

use super::*;
use crate::constants::{MAX_SCHEDULE_MS, RETENTION_MS};
use crate::event::{Body, Content};
use crate::root::tests::founding;
use crate::store::{MemoryStorage, ObjectRecord};
use crate::test_support::{Identity, identity};
use crate::wire::proto;

pub(crate) const T0: u64 = 1_700_000_000_000;
pub(crate) const MIN: u64 = 60_000;

pub(crate) struct Fixture {
    pub alice: Identity,
    pub bob: Identity,
    pub carol: Identity,
    pub root: Root,
    pub store: MemoryStorage,
}

impl Fixture {
    /// Alice owns an epoch of Alice and Bob; Carol is an outsider.
    pub(crate) fn new() -> Self {
        let alice = identity(1);
        let bob = identity(2);
        let carol = identity(3);
        let root = founding(&alice, &[&alice, &bob]);
        Self {
            alice,
            bob,
            carol,
            root,
            store: MemoryStorage::new(),
        }
    }

    pub(crate) fn epoch(&self) -> Epoch<'_> {
        Epoch::new(&self.root, true, GroupState::Active)
    }

    pub(crate) fn bob_sender(&self) -> Sender {
        Sender::Peer {
            id: self.bob.id,
            removed: false,
        }
    }

    pub(crate) fn event(
        &self,
        ts: u64,
        r: u8,
        parents: &[EventId],
        payload: Payload,
    ) -> MessageEvent {
        MessageEvent::create(&self.root, EventId::new(ts, [r; 16]), parents, payload).unwrap()
    }

    /// Bob delivers `event` at `now`.
    pub(crate) fn recv(&mut self, event: &MessageEvent, now: u64) -> Outcome {
        let sender = self.bob_sender();
        let root = self.root.clone();
        let out = Epoch::new(&root, true, GroupState::Active)
            .receive(&mut self.store, sender, event.clone(), now)
            .unwrap();
        check_invariants(&self.store, &root.chat_id(), now).unwrap();
        out
    }

    pub(crate) fn tick(&mut self, now: u64) {
        let root = self.root.clone();
        Epoch::new(&root, true, GroupState::Active)
            .tick(&mut self.store, now)
            .unwrap();
        check_invariants(&self.store, &root.chat_id(), now).unwrap();
    }

    pub(crate) fn row(&self, id: EventId) -> Option<EventRow> {
        self.store.event_row(&self.root.chat_id(), &id).unwrap()
    }

    pub(crate) fn state(&self, e: &MessageEvent) -> Option<RowState> {
        self.row(e.event_id()).map(|r| r.state)
    }

    pub(crate) fn obj(&self, sync: u8) -> ObjectRecord {
        self.store
            .object(&self.root.chat_id(), &sid(sync))
            .unwrap()
            .unwrap()
    }

    pub(crate) fn current_text(&self, sync: u8) -> Option<String> {
        match self.obj(sync).current {
            Some(StoredResult::Content(Content {
                body: Body::Text(t),
                ..
            })) => Some(t),
            _ => None,
        }
    }

    pub(crate) fn tips(&self, now: u64) -> Vec<EventId> {
        self.epoch().tips(&self.store, now).unwrap()
    }

    pub(crate) fn has_edges(&self, id: EventId) -> bool {
        self.store
            .edges(&self.root.chat_id())
            .unwrap()
            .iter()
            .any(|(c, _)| *c == id)
    }
}

/// The accepted, active epoch of `root`.
pub(crate) fn ep(root: &Root) -> Epoch<'_> {
    Epoch::new(root, true, GroupState::Active)
}

pub(crate) fn sid(n: u8) -> SyncObjId {
    SyncObjId::from_bytes([n; 32])
}

pub(crate) fn text(sync: u8, author: GossipId, created: u64, lma: u64, s: &str) -> Payload {
    Payload::Content(Content {
        sync_obj_id: sid(sync),
        author,
        created_at: created,
        last_modified_at: lma,
        body: Body::Text(s.to_owned()),
        edited: false,
        metadata: BTreeMap::new(),
    })
}

pub(crate) fn del(sync: u8, scheduled_at: Option<u64>) -> Payload {
    Payload::Delete {
        sync_obj_id: sid(sync),
        scheduled_at,
    }
}

fn held_role(state: Option<RowState>) -> Option<Role> {
    match state {
        Some(RowState::Held { role, .. }) => Some(role),
        _ => None,
    }
}

const PRUNED: Option<RowState> = Some(RowState::Pruned);

// ── Acceptance gate (§6.3, §10.4) ───────────────────────────────────────────

#[test]
fn rejects_when_the_epoch_is_not_accepted() {
    let mut f = Fixture::new();
    let e = f.event(T0, 1, &[], text(1, f.bob.id, T0, T0, "hi"));
    let sender = f.bob_sender();
    let out = Epoch::new(&f.root, false, GroupState::Active)
        .receive(&mut f.store, sender, e.clone(), T0)
        .unwrap();
    assert_eq!(out, Outcome::Rejected(Rejection::NotAccepted));
    assert_eq!(f.state(&e), None);
}

#[test]
fn rejects_a_peer_that_is_not_a_member_or_is_removed() {
    let mut f = Fixture::new();
    let e = f.event(T0, 1, &[], text(1, f.bob.id, T0, T0, "hi"));
    let epoch = Epoch::new(&f.root, true, GroupState::Active);
    let carol = Sender::Peer {
        id: f.carol.id,
        removed: false,
    };
    assert_eq!(
        epoch.receive(&mut f.store, carol, e.clone(), T0).unwrap(),
        Outcome::Rejected(Rejection::PeerNotMember)
    );
    let removed = Sender::Peer {
        id: f.bob.id,
        removed: true,
    };
    // Even a deletion is dropped from a removed peer (§10.4).
    let d = f.event(T0, 2, &[], del(1, None));
    assert_eq!(
        epoch.receive(&mut f.store, removed, d, T0).unwrap(),
        Outcome::Rejected(Rejection::RemovedPeer)
    );
    // The peer need not be the claimed author.
    let by_alice = f.event(T0, 3, &[], text(1, f.alice.id, T0, T0, "hi"));
    assert_eq!(f.recv(&by_alice, T0), Outcome::Accepted(Merge::Won));
    assert_eq!(f.store.commits(), 1);
}

#[test]
fn group_states_drop_events() {
    let mut f = Fixture::new();
    let e = f.event(T0, 1, &[], text(1, f.bob.id, T0, T0, "hi"));
    let d = f.event(T0, 2, &[], del(1, None));
    let sender = f.bob_sender();
    for state in [GroupState::Waiting, GroupState::Dissolved] {
        let epoch = Epoch::new(&f.root, true, state);
        for ev in [&e, &d] {
            assert_eq!(
                epoch.receive(&mut f.store, sender, ev.clone(), T0).unwrap(),
                Outcome::Rejected(Rejection::GroupState)
            );
        }
    }
    // A read-only archive after a kick applies deletions only.
    let epoch = Epoch::new(&f.root, true, GroupState::ReadOnlyAfterKick);
    assert_eq!(
        epoch.receive(&mut f.store, sender, e, T0).unwrap(),
        Outcome::Rejected(Rejection::GroupState)
    );
    assert_eq!(
        epoch.receive(&mut f.store, sender, d, T0).unwrap(),
        Outcome::Accepted(Merge::Won)
    );
}

#[test]
fn rejects_a_wrong_epoch_secret_proof_or_author() {
    let mut f = Fixture::new();
    // Another epoch.
    let other = founding(&f.alice, &[&f.alice, &f.bob, &f.carol]);
    let foreign = MessageEvent::create(
        &other,
        EventId::new(T0, [1; 16]),
        &[],
        text(1, f.bob.id, T0, T0, "x"),
    )
    .unwrap();
    assert_eq!(
        f.recv(&foreign, T0),
        Outcome::Rejected(Rejection::Invalid(Error::IdMismatch("chat_id")))
    );
    // A proof moved onto another ID.
    let e = f.event(T0, 1, &[], text(1, f.bob.id, T0, T0, "x"));
    let mut p = e.to_proto();
    p.event_id = EventId::new(T0, [2; 16]).as_bytes().to_vec();
    let moved = MessageEvent::from_proto(1, p).unwrap();
    assert_eq!(
        f.recv(&moved, T0),
        Outcome::Rejected(Rejection::Invalid(Error::SecretProofMismatch))
    );
    // An outsider named as author, under a valid proof.
    let mut p = e.to_proto();
    p.payload.as_mut().unwrap().author = f.carol.id.as_bytes().to_vec();
    let outsider = MessageEvent::from_proto(1, p).unwrap();
    assert_eq!(
        f.recv(&outsider, T0),
        Outcome::Rejected(Rejection::Invalid(Error::NotMember("the claimed author")))
    );
    assert!(f.store.event_rows(&f.root.chat_id()).unwrap().is_empty());
}

#[test]
fn rejects_malformed_blobs_and_other_objects() {
    let mut f = Fixture::new();
    let epoch = Epoch::new(&f.root, true, GroupState::Active);
    let sender = f.bob_sender();
    let e = f.event(T0, 1, &[], text(1, f.bob.id, T0, T0, "x"));
    let blob = wire::encode_event_blob(&EventObject::Message(e.clone())).unwrap();
    // Truncated.
    assert!(matches!(
        epoch
            .receive_blob(&mut f.store, sender, &blob[..blob.len() - 1], 1, T0)
            .unwrap(),
        Outcome::Rejected(Rejection::Invalid(_))
    ));
    // Unsorted parents.
    let mut p = e.to_proto();
    p.parents = vec![
        EventId::new(T0 - 1, [9; 16]).as_bytes().to_vec(),
        EventId::new(T0 - 2, [9; 16]).as_bytes().to_vec(),
    ];
    let mut bad = vec![1u8];
    prost::Message::encode(
        &proto::Event {
            kind: Some(proto::EventKind::GroupMessageEvent(p)),
        },
        &mut bad,
    )
    .unwrap();
    assert_eq!(
        epoch
            .receive_blob(&mut f.store, sender, &bad, 1, T0)
            .unwrap(),
        Outcome::Rejected(Rejection::Invalid(Error::NotSortedDistinct("parents")))
    );
    // A payload date beyond ts + MAX_SCHEDULE is permanently malformed.
    let mut p = e.to_proto();
    p.payload.as_mut().unwrap().created_at = T0 + MAX_SCHEDULE_MS + 1;
    let mut bad = vec![1u8];
    prost::Message::encode(
        &proto::Event {
            kind: Some(proto::EventKind::GroupMessageEvent(p)),
        },
        &mut bad,
    )
    .unwrap();
    assert_eq!(
        epoch
            .receive_blob(&mut f.store, sender, &bad, 1, T0)
            .unwrap(),
        Outcome::Rejected(Rejection::Invalid(Error::BeyondSchedule("created_at")))
    );
    // A root is not a message event.
    let root_blob = wire::encode_event_blob(&EventObject::Root(Box::new(f.root.clone()))).unwrap();
    assert_eq!(
        epoch
            .receive_blob(&mut f.store, sender, &root_blob, 1, T0)
            .unwrap(),
        Outcome::Rejected(Rejection::NotAMessageEvent)
    );
    // The valid blob is accepted.
    assert_eq!(
        epoch
            .receive_blob(&mut f.store, sender, &blob, 1, T0)
            .unwrap(),
        Outcome::Accepted(Merge::Won)
    );
}

#[test]
fn time_bounds_near_the_top_of_the_range_are_exact() {
    // ts + RETENTION and now + 5 min are beyond u64::MAX: the bounds are computed as with
    // unbounded integers (§1, D.25), so the event is admitted and its window never closes.
    let mut f = Fixture::new();
    let ts = u64::MAX - MAX_SCHEDULE_MS;
    let e = f.event(ts, 1, &[], text(1, f.bob.id, u64::MAX, u64::MAX, "x"));
    assert_eq!(f.recv(&e, ts - 5 * MIN - 1), Outcome::TemporarilyInvalid);
    assert_eq!(f.recv(&e, u64::MAX), Outcome::Accepted(Merge::Won));
    assert!(crate::store::in_window(&e.event_id(), u64::MAX));
    assert!(!crate::store::in_window(
        &f.event(T0, 2, &[], text(2, f.bob.id, T0, T0, "y"))
            .event_id(),
        u64::MAX
    ));
}

// ── Temporarily invalid events (§7.2, §9.6) ─────────────────────────────────

#[test]
fn future_timestamp_is_temporarily_invalid_then_recovers() {
    let mut f = Fixture::new();
    let parent = EventId::new(T0 - 10, [7; 16]);
    let e = f.event(
        T0 + 5 * MIN + 1,
        1,
        &[parent],
        text(1, f.bob.id, T0, T0, "x"),
    );
    assert_eq!(f.recv(&e, T0), Outcome::TemporarilyInvalid);
    // A marker without content or parent links; not a tip.
    assert_eq!(f.state(&e), Some(RowState::TemporarilyInvalid));
    assert!(!f.has_edges(e.event_id()));
    assert!(f.tips(T0).is_empty());
    assert!(
        f.store
            .object(&f.root.chat_id(), &sid(1))
            .unwrap()
            .is_none()
    );
    // Still in the future: still a marker.
    assert_eq!(f.recv(&e, T0), Outcome::TemporarilyInvalid);
    // Revalidated from scratch once admissible; the marker is cleared.
    assert_eq!(f.recv(&e, T0 + 1), Outcome::Accepted(Merge::Won));
    assert_eq!(held_role(f.state(&e)), Some(Role::Current));
    assert!(f.has_edges(e.event_id()));
}

#[test]
fn timestamp_admission_boundary() {
    let mut f = Fixture::new();
    let e = f.event(T0 + 5 * MIN, 1, &[], text(1, f.bob.id, T0, T0, "x"));
    assert_eq!(f.recv(&e, T0), Outcome::Accepted(Merge::Won));
    // No lower bound: a very old event is accepted (and expires at once).
    let old = f.event(1, 2, &[], text(2, f.bob.id, 1, 1, "old"));
    assert_eq!(f.recv(&old, T0), Outcome::Accepted(Merge::Won));
    assert_eq!(f.state(&old), PRUNED);
    assert_eq!(f.current_text(2).as_deref(), Some("old"));
}

// ── Merging (§7.1) ──────────────────────────────────────────────────────────

#[test]
fn greatest_last_modified_wins_and_prunes_the_superseded() {
    let mut f = Fixture::new();
    let a = f.event(T0, 1, &[], text(1, f.bob.id, T0, T0, "a"));
    let b = f.event(T0 + 1, 2, &[], text(1, f.bob.id, T0, T0 + 1, "b"));
    let older = f.event(T0 + 2, 3, &[], text(1, f.bob.id, T0, T0 - 5, "older"));
    assert_eq!(f.recv(&a, T0 + 10), Outcome::Accepted(Merge::Won));
    assert_eq!(f.recv(&b, T0 + 10), Outcome::Accepted(Merge::Won));
    assert_eq!(f.state(&a), PRUNED);
    assert_eq!(f.current_text(1).as_deref(), Some("b"));
    // Loses: pruned, but processed with its parent links.
    assert_eq!(f.recv(&older, T0 + 10), Outcome::Accepted(Merge::Lost));
    assert_eq!(f.state(&older), PRUNED);
    assert!(f.has_edges(older.event_id()));
    assert_eq!(f.current_text(1).as_deref(), Some("b"));
    assert_eq!(f.tips(T0 + 10), vec![b.event_id()]);
}

#[test]
fn equal_times_are_ranked_by_result_hash() {
    let mut f = Fixture::new();
    let x = f.event(T0, 1, &[], text(1, f.bob.id, T0, T0, "x"));
    let y = f.event(T0, 2, &[], text(1, f.bob.id, T0, T0, "y"));
    let (lo, hi) = if x.result_hash() < y.result_hash() {
        (x, y)
    } else {
        (y, x)
    };
    assert_eq!(f.recv(&hi, T0), Outcome::Accepted(Merge::Won));
    assert_eq!(f.recv(&lo, T0), Outcome::Accepted(Merge::Lost));
    let mut g = Fixture::new();
    assert_eq!(g.recv(&lo, T0), Outcome::Accepted(Merge::Won));
    assert_eq!(g.recv(&hi, T0), Outcome::Accepted(Merge::Won));
    assert_eq!(f.obj(1).current, g.obj(1).current);
}

#[test]
fn identical_results_stay_available_side_by_side() {
    let mut f = Fixture::new();
    let a = f.event(T0, 1, &[], text(1, f.bob.id, T0, T0, "same"));
    let b = f.event(
        T0 + 1,
        2,
        &[a.event_id()],
        text(1, f.bob.id, T0, T0, "same"),
    );
    assert_eq!(f.recv(&a, T0 + 5), Outcome::Accepted(Merge::Won));
    assert_eq!(f.recv(&b, T0 + 5), Outcome::Accepted(Merge::Identical));
    assert_eq!(held_role(f.state(&a)), Some(Role::Current));
    assert_eq!(held_role(f.state(&b)), Some(Role::Current));
    assert_eq!(f.obj(1).current_events.len(), 2);
    assert_eq!(f.tips(T0 + 5), vec![b.event_id()]);
}

#[test]
fn a_delete_is_absorbing_in_any_order() {
    let mut f = Fixture::new();
    let c = f.event(T0, 1, &[], text(1, f.bob.id, T0, T0, "c"));
    let d = f.event(T0 + 1, 2, &[], del(1, None));
    let later = f.event(T0 + 2, 3, &[], text(1, f.bob.id, T0, T0 + 1_000, "later"));
    // A delete before any content still creates the tombstone.
    assert_eq!(f.recv(&d, T0 + 10), Outcome::Accepted(Merge::Won));
    assert!(f.obj(1).is_deleted());
    assert_eq!(f.recv(&c, T0 + 10), Outcome::Accepted(Merge::Lost));
    assert_eq!(f.recv(&later, T0 + 2_000), Outcome::Accepted(Merge::Lost));
    assert!(f.obj(1).is_deleted());
    assert_eq!(f.state(&c), PRUNED);

    let mut g = Fixture::new();
    g.recv(&c, T0 + 10);
    assert_eq!(g.recv(&d, T0 + 10), Outcome::Accepted(Merge::Won));
    assert_eq!(g.state(&c), PRUNED);
    // A second delete is identical: both stay available to propagate the deletion.
    let d2 = g.event(T0 + 3, 4, &[], del(1, None));
    assert_eq!(g.recv(&d2, T0 + 10), Outcome::Accepted(Merge::Identical));
    assert_eq!(g.obj(1).current_events.len(), 2);
}

#[test]
fn a_retained_id_keeps_its_first_interpretation() {
    let mut f = Fixture::new();
    let a = f.event(T0, 1, &[], text(1, f.bob.id, T0, T0, "first"));
    f.recv(&a, T0);
    let mut p = a.to_proto();
    if let Some(proto::Body::Text(t)) = &mut p.payload.as_mut().unwrap().body {
        *t = "second".into();
    }
    p.payload.as_mut().unwrap().last_modified_at = Some(T0 + 1);
    let conflicting = MessageEvent::from_proto(1, p).unwrap();
    assert_eq!(f.recv(&conflicting, T0 + 5), Outcome::Duplicate);
    assert_eq!(f.recv(&a, T0 + 5), Outcome::Duplicate);
    assert_eq!(f.current_text(1).as_deref(), Some("first"));
    assert_eq!(f.row(a.event_id()).unwrap().event(), Some(&a));
}

// ── Events under an already-known ID (§9.5) ─────────────────────────────────

#[test]
fn a_pruned_identical_event_is_restored_while_its_window_is_open() {
    let mut f = Fixture::new();
    let a = f.event(T0, 1, &[], text(1, f.bob.id, T0, T0, "a"));
    let b = f.event(T0 + 1, 2, &[], text(1, f.bob.id, T0, T0, "a"));
    f.recv(&a, T0 + 5);
    f.recv(&b, T0 + 5);
    let evicted = ep(&f.root).evict(&mut f.store, T0 + 5, 1).unwrap();
    assert_eq!(evicted, vec![a.event_id()]);
    assert_eq!(f.state(&a), PRUNED);
    assert_eq!(f.recv(&a, T0 + 6), Outcome::Restored);
    assert_eq!(held_role(f.state(&a)), Some(Role::Current));
    // Once its window is closed it stays pruned.
    let mut g = Fixture::new();
    g.recv(&a, T0 + 5);
    g.recv(&b, T0 + 5);
    ep(&g.root).evict(&mut g.store, T0 + 5, 1).unwrap();
    let late = T0 + RETENTION_MS;
    assert_eq!(g.recv(&a, late), Outcome::KeptPruned);
    assert_eq!(g.state(&a), PRUNED);
}

// ── Scheduled future versions (§7.3) ────────────────────────────────────────

#[test]
fn future_versions_wait_and_activate_in_order() {
    let mut f = Fixture::new();
    let tue = T0 + 1_000;
    let fri = T0 + 2_000;
    let a = f.event(T0, 1, &[], text(1, f.bob.id, T0, T0, "A"));
    let c = f.event(T0, 3, &[], text(1, f.bob.id, T0, fri, "C"));
    let b = f.event(T0, 2, &[], text(1, f.bob.id, T0, tue, "B"));
    assert_eq!(f.recv(&a, T0), Outcome::Accepted(Merge::Won));
    assert_eq!(f.recv(&c, T0), Outcome::Accepted(Merge::Pending));
    // A later future version never discards an earlier pending one.
    assert_eq!(f.recv(&b, T0), Outcome::Accepted(Merge::Pending));
    assert_eq!(f.obj(1).pending_versions.len(), 2);
    assert_eq!(
        held_role(f.state(&b)),
        Some(Role::PendingVersion { due: tue })
    );
    // Pending versions are available, hence tips (§6.1).
    assert_eq!(f.tips(T0).len(), 3);
    assert_eq!(f.epoch().next_wakeup(&f.store, T0).unwrap(), Some(tue));
    f.tick(tue - 1);
    assert_eq!(f.current_text(1).as_deref(), Some("A"));
    f.tick(tue);
    assert_eq!(f.current_text(1).as_deref(), Some("B"));
    assert_eq!(f.state(&a), PRUNED);
    f.tick(fri);
    assert_eq!(f.current_text(1).as_deref(), Some("C"));
    assert_eq!(f.state(&b), PRUNED);
    assert!(f.obj(1).pending_versions.is_empty());
    assert_eq!(f.epoch().next_wakeup(&f.store, fri).unwrap(), None);
}

#[test]
fn a_pending_version_can_lose_at_activation() {
    let mut f = Fixture::new();
    let t = T0 + 1_000;
    let x = f.event(T0, 1, &[], text(1, f.bob.id, T0, t, "x"));
    let y = f.event(T0, 2, &[], text(1, f.bob.id, T0, t, "y"));
    f.recv(&x, T0);
    f.recv(&y, T0);
    f.tick(t);
    let winner = if x.result_hash() > y.result_hash() {
        &x
    } else {
        &y
    };
    let loser = if x.result_hash() > y.result_hash() {
        &y
    } else {
        &x
    };
    assert_eq!(held_role(f.state(winner)), Some(Role::Current));
    assert_eq!(f.state(loser), PRUNED);
}

#[test]
fn a_new_scheduled_message_has_no_current_result_until_due() {
    let mut f = Fixture::new();
    let s = T0 + 1_000;
    let e = f.event(T0, 1, &[], text(1, f.bob.id, s, s, "later"));
    assert_eq!(f.recv(&e, T0), Outcome::Accepted(Merge::Pending));
    assert_eq!(f.obj(1).current, None);
    f.tick(s - 1);
    assert_eq!(f.obj(1).current, None);
    f.tick(s);
    assert_eq!(f.current_text(1).as_deref(), Some("later"));
}

#[test]
fn wakeups_are_clamped_to_two_hours() {
    let mut f = Fixture::new();
    let far = T0 + 10 * 60 * MIN;
    let e = f.event(T0, 1, &[], del(1, Some(far)));
    f.recv(&e, T0);
    assert_eq!(
        f.epoch().next_wakeup(&f.store, T0).unwrap(),
        Some(T0 + MAX_TIMER_WAIT_MS)
    );
}

// ── Scheduled deletions (§7.4) ──────────────────────────────────────────────

#[test]
fn a_scheduled_deletion_waits_then_is_served_in_immediate_form() {
    let mut f = Fixture::new();
    let t = T0 + 1_000;
    let c = f.event(T0, 1, &[], text(1, f.bob.id, T0, T0, "c"));
    let p = EventId::new(T0 - 1, [5; 16]);
    let d = f.event(T0, 2, &[p], del(1, Some(t)));
    f.recv(&c, T0);
    assert_eq!(f.recv(&d, T0), Outcome::Accepted(Merge::Pending));
    // It does not absorb the message before its time.
    assert_eq!(f.current_text(1).as_deref(), Some("c"));
    assert_eq!(
        held_role(f.state(&d)),
        Some(Role::PendingDeletion { due: t })
    );
    f.tick(t - 1);
    assert_eq!(f.current_text(1).as_deref(), Some("c"));
    f.tick(t);
    assert!(f.obj(1).is_deleted());
    assert_eq!(f.state(&c), PRUNED);
    // Same ID, parents and version; no date.
    let served = f
        .epoch()
        .serve(&f.store, &d.event_id(), t)
        .unwrap()
        .unwrap();
    assert_eq!(served.event_id(), d.event_id());
    assert_eq!(served.parents(), d.parents());
    assert_eq!(served.version(), d.version());
    assert_eq!(served.secret_proof(), d.secret_proof());
    assert_eq!(*served.payload(), del(1, None));
    assert_eq!(served.result_hash(), d.result_hash());
}

#[test]
fn a_due_scheduled_deletion_applies_on_arrival() {
    let mut f = Fixture::new();
    let c = f.event(T0, 1, &[], text(1, f.bob.id, T0, T0, "c"));
    let d = f.event(T0, 2, &[], del(1, Some(T0 + 100)));
    f.recv(&c, T0);
    assert_eq!(f.recv(&d, T0 + 100), Outcome::Accepted(Merge::Won));
    assert!(f.obj(1).is_deleted());
    assert_eq!(
        *f.row(d.event_id()).unwrap().event().unwrap().payload(),
        del(1, None)
    );
}

#[test]
fn every_scheduled_deletion_is_kept_and_the_earliest_applies() {
    let mut f = Fixture::new();
    let c = f.event(T0, 1, &[], text(1, f.bob.id, T0, T0, "c"));
    let d10 = f.event(T0, 2, &[], del(1, Some(T0 + 10_000)));
    let d20 = f.event(T0, 3, &[], del(1, Some(T0 + 20_000)));
    let d5 = f.event(T0, 4, &[], del(1, Some(T0 + 5_000)));
    f.recv(&c, T0);
    for d in [&d10, &d20, &d5] {
        assert_eq!(f.recv(d, T0), Outcome::Accepted(Merge::Pending));
    }
    assert_eq!(f.obj(1).pending_deletions.len(), 3);
    assert_eq!(
        f.epoch().next_wakeup(&f.store, T0).unwrap(),
        Some(T0 + 5_000)
    );
    f.tick(T0 + 4_999);
    assert_eq!(f.current_text(1).as_deref(), Some("c"));
    // The earliest applies, and the others with it, all in their immediate form.
    f.tick(T0 + 5_000);
    let o = f.obj(1);
    assert!(o.is_deleted() && o.pending_deletions.is_empty());
    for d in [&d5, &d10, &d20] {
        assert_eq!(held_role(f.state(d)), Some(Role::Current));
        assert_eq!(
            *f.row(d.event_id()).unwrap().event().unwrap().payload(),
            del(1, None)
        );
    }
    assert_eq!(f.state(&c), PRUNED);
}

#[test]
fn an_immediate_deletion_clears_pending_work() {
    let mut f = Fixture::new();
    let c = f.event(T0, 1, &[], text(1, f.bob.id, T0, T0, "c"));
    let v = f.event(T0, 2, &[], text(1, f.bob.id, T0, T0 + 500, "v"));
    let ds = f.event(T0, 3, &[], del(1, Some(T0 + 1_000)));
    let di = f.event(T0 + 1, 4, &[], del(1, None));
    f.recv(&c, T0);
    f.recv(&v, T0);
    f.recv(&ds, T0);
    assert_eq!(f.recv(&di, T0 + 2), Outcome::Accepted(Merge::Won));
    let o = f.obj(1);
    assert!(o.is_deleted() && o.pending_versions.is_empty() && o.pending_deletions.is_empty());
    assert_eq!(f.state(&v), PRUNED);
    // The pending deletion is applied with it, in its immediate form.
    assert_eq!(held_role(f.state(&ds)), Some(Role::Current));
    assert_eq!(
        *f.row(ds.event_id()).unwrap().event().unwrap().payload(),
        del(1, None)
    );
    assert_eq!(f.epoch().next_wakeup(&f.store, T0 + 2).unwrap(), None);
}

#[test]
fn a_scheduled_deletion_of_a_deleted_message_is_applied_at_once() {
    let mut f = Fixture::new();
    let di = f.event(T0, 1, &[], del(1, None));
    let ds = f.event(T0, 2, &[], del(1, Some(T0 + 1_000)));
    f.recv(&di, T0);
    assert_eq!(f.recv(&ds, T0), Outcome::Accepted(Merge::Identical));
    assert_eq!(
        *f.row(ds.event_id()).unwrap().event().unwrap().payload(),
        del(1, None)
    );
}

/// Regression (review of c11b2163, D.31 choice A): the served form of a scheduled deletion
/// depends only on the event and the clock. After a local-only deletion, a scheduled deletion
/// arriving again, or a new one, was stored and served at once in its immediate form, so a
/// peer fetching it deleted the message before its time (§7.4).
#[test]
fn a_scheduled_deletion_is_never_served_before_its_own_time() {
    let mut f = Fixture::new();
    let a = f.event(T0, 1, &[], text(1, f.bob.id, T0, T0, "a"));
    let ds = f.event(T0, 2, &[], del(1, Some(T0 + 60 * MIN)));
    f.recv(&a, T0);
    f.recv(&ds, T0);
    ep(&f.root)
        .local_delete(&mut f.store, T0 + 1, sid(1))
        .unwrap();
    f.recv(&ds, T0 + 2);
    let ds2 = f.event(T0 + 3, 3, &[], del(1, Some(T0 + 90 * MIN)));
    f.recv(&ds2, T0 + 3);
    // Served before its own due time: the scheduled form, or nothing; never the immediate
    // form.
    let served = |f: &Fixture, e: &MessageEvent, now: u64| {
        f.epoch()
            .serve(&f.store, &e.event_id(), now)
            .unwrap()
            .map(|s| s.payload().clone())
    };
    for now in [T0 + 3, T0 + 60 * MIN - 1] {
        f.tick(now);
        for e in [&ds, &ds2] {
            let form = served(&f, e, now);
            assert!(
                form.is_none() || form.as_ref() == Some(e.payload()),
                "{form:?} served at {now}"
            );
        }
    }
    // Each is normalised at its own time.
    f.tick(T0 + 60 * MIN);
    assert_eq!(served(&f, &ds, T0 + 60 * MIN), Some(del(1, None)));
    assert_eq!(
        served(&f, &ds2, T0 + 60 * MIN).as_ref(),
        Some(ds2.payload())
    );
    f.tick(T0 + 90 * MIN);
    assert_eq!(served(&f, &ds2, T0 + 90 * MIN), Some(del(1, None)));
}

#[test]
fn the_immediate_form_of_a_pending_deletion_does_not_apply_it_early() {
    let mut f = Fixture::new();
    let c = f.event(T0, 1, &[], text(1, f.bob.id, T0, T0, "c"));
    let ds = f.event(T0, 2, &[], del(1, Some(T0 + 1_000)));
    f.recv(&c, T0);
    f.recv(&ds, T0);
    let immediate = immediate_form(&ds);
    assert_eq!(f.recv(&immediate, T0 + 1), Outcome::Duplicate);
    assert_eq!(f.current_text(1).as_deref(), Some("c"));
    // Postponing an applied deletion is ignored too.
    f.tick(T0 + 1_000);
    let mut p = ds.to_proto();
    p.payload.as_mut().unwrap().last_modified_at = Some(T0 + 9_000);
    let postponed = MessageEvent::from_proto(1, p).unwrap();
    assert_eq!(f.recv(&postponed, T0 + 1_001), Outcome::Duplicate);
    assert_eq!(
        *f.row(ds.event_id()).unwrap().event().unwrap().payload(),
        del(1, None)
    );
}

// ── Retention and eviction (§8) ─────────────────────────────────────────────

#[test]
fn events_expire_at_ts_plus_retention_and_results_stay() {
    let mut f = Fixture::new();
    let c = f.event(T0, 1, &[], text(1, f.bob.id, T0, T0, "c"));
    let d = f.event(T0, 2, &[], del(2, None));
    f.recv(&c, T0);
    f.recv(&d, T0);
    let end = T0 + RETENTION_MS;
    f.tick(end - 1);
    assert!(
        f.epoch()
            .serve(&f.store, &c.event_id(), end - 1)
            .unwrap()
            .is_some()
    );
    f.tick(end);
    assert_eq!(f.state(&c), PRUNED);
    assert_eq!(f.state(&d), PRUNED);
    assert!(
        f.epoch()
            .serve(&f.store, &c.event_id(), end)
            .unwrap()
            .is_none()
    );
    assert_eq!(f.current_text(1).as_deref(), Some("c"));
    assert!(f.obj(2).is_deleted());
    assert!(f.tips(end).is_empty());
}

#[test]
fn a_pending_version_still_activates_when_the_device_wakes_after_its_window() {
    // `last_modified_at ≤ ts + MAX_SCHEDULE < ts + RETENTION` (§7.2): a version is always due
    // before its window ends, so a device that sleeps past both applies it, then prunes it.
    let mut f = Fixture::new();
    let due = T0 + MAX_SCHEDULE_MS;
    let v = f.event(T0, 1, &[], text(1, f.bob.id, T0, due, "v"));
    assert_eq!(f.recv(&v, T0), Outcome::Accepted(Merge::Pending));
    let end = T0 + RETENTION_MS;
    assert!(
        f.epoch()
            .serve(&f.store, &v.event_id(), due - 1)
            .unwrap()
            .is_some()
    );
    f.tick(end + 1);
    assert_eq!(f.current_text(1).as_deref(), Some("v"));
    assert_eq!(f.state(&v), PRUNED);
    assert!(
        f.epoch()
            .serve(&f.store, &v.event_id(), end + 1)
            .unwrap()
            .is_none()
    );
}

#[test]
fn an_event_received_after_its_window_is_merged_then_pruned() {
    let mut f = Fixture::new();
    let c = f.event(T0, 1, &[], text(1, f.bob.id, T0, T0, "c"));
    let late = T0 + RETENTION_MS + 5;
    assert_eq!(f.recv(&c, late), Outcome::Accepted(Merge::Won));
    assert_eq!(f.state(&c), PRUNED);
    assert_eq!(f.current_text(1).as_deref(), Some("c"));
}

#[test]
fn eviction_takes_the_oldest_and_spares_pending_events() {
    let mut f = Fixture::new();
    let pending = f.event(T0 - 50, 1, &[], text(1, f.bob.id, T0, T0 + 1_000, "p"));
    let old = f.event(T0 - 20, 2, &[], del(2, None));
    let new = f.event(T0 - 10, 3, &[], text(3, f.bob.id, T0, T0, "n"));
    for e in [&pending, &old, &new] {
        f.recv(e, T0);
    }
    let evicted = ep(&f.root).evict(&mut f.store, T0, 1).unwrap();
    assert_eq!(evicted, vec![old.event_id()]);
    let evicted = ep(&f.root).evict(&mut f.store, T0, 10).unwrap();
    assert_eq!(evicted, vec![new.event_id()]);
    assert!(f.obj(2).is_deleted());
    assert_eq!(f.current_text(3).as_deref(), Some("n"));
    assert!(f.has_edges(old.event_id()));
    check_invariants(&f.store, &f.root.chat_id(), T0).unwrap();
}

// ── Tips (§6.1, §12.1) ──────────────────────────────────────────────────────

#[test]
fn tips_are_unreferenced_available_events() {
    let mut f = Fixture::new();
    let a = f.event(T0, 1, &[], text(1, f.bob.id, T0, T0, "a"));
    let b = f.event(T0 + 1, 2, &[a.event_id()], text(2, f.bob.id, T0, T0, "b"));
    let missing = EventId::new(T0 - 5, [9; 16]);
    let c = f.event(T0 + 2, 3, &[missing], text(3, f.bob.id, T0, T0, "c"));
    for e in [&a, &b, &c] {
        f.recv(e, T0 + 5);
    }
    assert_eq!(f.tips(T0 + 5), vec![b.event_id(), c.event_id()]);
    // Only an available child hides its parents (D.27): once the child is pruned, an
    // available parent is a tip again.
    ep(&f.root).evict(&mut f.store, T0 + 5, 3).unwrap();
    assert!(f.tips(T0 + 5).is_empty());
    let mut g = Fixture::new();
    g.recv(&a, T0 + 5);
    g.recv(&b, T0 + 5);
    ep(&g.root).evict(&mut g.store, T0 + 5, 3).unwrap();
    g.recv(&a, T0 + 6);
    assert_eq!(g.tips(T0 + 6), vec![a.event_id()]);
}

/// Regression (review of c11b2163, D.27 choice B): a pruned child must not hide its parent.
/// E1 creates message 1; X1 creates message 2 with parent E1; X2 edits message 2 with parent
/// X1, which prunes X1 as superseded. X1 answers "not available", so its parent links cannot
/// be learned: if E1 were not a tip, a device that was offline would never find it, though
/// it carries a current result.
#[test]
fn a_pruned_child_does_not_hide_its_parent() {
    let mut f = Fixture::new();
    let e1 = f.event(T0, 1, &[], text(1, f.bob.id, T0, T0, "m1"));
    let x1 = f.event(
        T0 + 1,
        2,
        &[e1.event_id()],
        text(2, f.bob.id, T0 + 1, T0 + 1, "m2"),
    );
    let x2 = f.event(
        T0 + 2,
        3,
        &[x1.event_id()],
        text(2, f.bob.id, T0 + 1, T0 + 2, "m2 edited"),
    );
    f.recv(&e1, T0);
    f.recv(&x1, T0 + 1);
    f.recv(&x2, T0 + 2);
    let now = T0 + 3;
    assert_eq!(f.state(&x1), PRUNED);
    assert!(
        f.epoch()
            .serve(&f.store, &x1.event_id(), now)
            .unwrap()
            .is_none()
    );
    // Every available event is reachable from the tips by walking parents of available
    // events; here E1 is a tip itself.
    assert_eq!(f.tips(now), vec![e1.event_id(), x2.event_id()]);
}

#[test]
fn a_cycle_exposes_its_available_members_as_frontier() {
    let mut f = Fixture::new();
    let ida = EventId::new(T0, [1; 16]);
    let idb = EventId::new(T0, [2; 16]);
    let a = MessageEvent::create(&f.root, ida, &[idb], text(1, f.bob.id, T0, T0, "a")).unwrap();
    let b = MessageEvent::create(&f.root, idb, &[ida], text(2, f.bob.id, T0, T0, "b")).unwrap();
    f.recv(&a, T0);
    f.recv(&b, T0);
    assert_eq!(f.tips(T0), vec![ida, idb]);
    // A child outside the cycle makes it an ordinary ancestor.
    let c = f.event(T0 + 1, 3, &[ida], text(3, f.bob.id, T0, T0, "c"));
    f.recv(&c, T0 + 1);
    assert_eq!(f.tips(T0 + 1), vec![c.event_id()]);
}

#[test]
fn storage_failures_commit_nothing() {
    #[derive(Default)]
    struct Failing(MemoryStorage);
    impl StorageRead for Failing {
        fn event_row(&self, c: &ChatId, e: &EventId) -> Result<Option<EventRow>, StorageError> {
            self.0.event_row(c, e)
        }
        fn event_rows(&self, c: &ChatId) -> Result<Vec<EventRow>, StorageError> {
            self.0.event_rows(c)
        }
        fn edges(&self, c: &ChatId) -> Result<Vec<(EventId, Vec<EventId>)>, StorageError> {
            self.0.edges(c)
        }
        fn object(&self, c: &ChatId, s: &SyncObjId) -> Result<Option<ObjectRecord>, StorageError> {
            self.0.object(c, s)
        }
        fn objects(&self, c: &ChatId) -> Result<Vec<ObjectRecord>, StorageError> {
            self.0.objects(c)
        }
        fn pending_until(
            &self,
            c: &ChatId,
            u: u64,
        ) -> Result<Vec<crate::store::PendingItem>, StorageError> {
            self.0.pending_until(c, u)
        }
    }
    impl Storage for Failing {
        fn commit(&mut self, _: crate::store::Changes) -> Result<(), StorageError> {
            Err(StorageError("disk full".into()))
        }
    }
    let f = Fixture::new();
    let mut store = Failing::default();
    let e = f.event(T0, 1, &[], text(1, f.bob.id, T0, T0, "x"));
    assert!(
        f.epoch()
            .receive(&mut store, f.bob_sender(), e, T0)
            .is_err()
    );
    assert_eq!(store.0, MemoryStorage::new());
}

/// Regression (simulation seed 7 at 22d9d782 with the scheduled-deletion exclusion off):
/// which deletion events stay available must not depend on when a later scheduled deletion
/// arrived relative to the activation of an earlier one.
#[test]
fn scheduled_deletions_end_up_available_whatever_the_arrival_timing() {
    let mut early = Fixture::new();
    let c = early.event(T0, 1, &[], text(1, early.bob.id, T0, T0, "c"));
    let s1 = early.event(T0, 2, &[], del(1, Some(T0 + 5_000)));
    let s2 = early.event(T0, 3, &[], del(1, Some(T0 + 10_000)));
    // Both scheduled deletions arrive before the first applies.
    for e in [&c, &s1, &s2] {
        early.recv(e, T0);
    }
    early.tick(T0 + 20_000);
    // The second one arrives after the first applied.
    let mut late = Fixture::new();
    late.recv(&c, T0);
    late.recv(&s1, T0);
    late.tick(T0 + 6_000);
    late.recv(&s2, T0 + 7_000);
    late.tick(T0 + 20_000);

    let available = |f: &Fixture| -> Vec<EventId> {
        f.store
            .event_rows(&f.root.chat_id())
            .unwrap()
            .into_iter()
            .filter(|r| r.available(T0 + 20_000))
            .map(|r| r.event_id)
            .collect()
    };
    assert_eq!(early.obj(1).current, late.obj(1).current);
    assert_eq!(available(&early), available(&late));
    assert_eq!(early.tips(T0 + 20_000), late.tips(T0 + 20_000));
}
