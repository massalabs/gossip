//! §7.2, §9.7, §10.2, §10.3 (D.92 to D.97): a message published under another member's
//! name, a message on this device only, and an edit that changes the author.

use super::dissemination::neighbors_of;
use super::*;
use crate::epoch::check_invariants;
use crate::node::timing::{RELAY_WAIT_MAX_MS, RELAY_WAIT_MIN_MS};
use crate::store::{ObjectRecord, RowState, StoredResult};

fn recipients(
    sent: &BTreeMap<GossipId, Vec<Frame>>,
    f: fn(&[Frame]) -> Vec<EventId>,
    id: EventId,
) -> BTreeSet<usize> {
    sent.iter()
        .filter(|(_, frames)| f(frames).contains(&id))
        .map(|(to, _)| (0..32).find(|i| member(*i) == *to).unwrap())
        .collect()
}

/// Device 0 publishes `text` as member `author`.
fn publish_as(net: &mut Net, author: usize, text: &str) -> MessageEvent {
    let now = net.now;
    let chat = net.chat();
    let dev = &mut net.devs[0];
    dev.node
        .publish_message_as(
            &mut dev.store,
            chat,
            member(author),
            Body::Text(text.into()),
            BTreeMap::new(),
            None,
            now,
            &mut net.rng,
        )
        .unwrap()
        .event
}

/// Device 0 edits `sync`, setting the author to `author` (`None` keeps it).
fn edit_as(net: &mut Net, sync: SyncObjId, author: Option<usize>, text: &str) -> MessageEvent {
    let now = net.now;
    let chat = net.chat();
    let dev = &mut net.devs[0];
    dev.node
        .publish_edit_as(
            &mut dev.store,
            chat,
            sync,
            Body::Text(text.into()),
            BTreeMap::new(),
            None,
            author.map(member),
            now,
            &mut net.rng,
        )
        .unwrap()
        .event
}

/// Device 0 creates `text` on this device only, as member `author`.
fn local(net: &mut Net, author: usize, text: &str) -> SyncObjId {
    let now = net.now;
    let chat = net.chat();
    let dev = &mut net.devs[0];
    dev.node
        .local_message(
            &mut dev.store,
            chat,
            member(author),
            Body::Text(text.into()),
            BTreeMap::new(),
            now,
            &mut net.rng,
        )
        .unwrap()
}

fn sync_of(e: &MessageEvent) -> SyncObjId {
    e.payload().sync_obj_id()
}

/// The hints device 0 holds for `id`, by peer.
fn hints_for(net: &Net, id: EventId) -> BTreeSet<usize> {
    net.devs[0]
        .node
        .t
        .hints
        .keys()
        .filter(|k| k.2 == id)
        .map(|k| (0..32).find(|i| member(*i) == k.1).unwrap())
        .collect()
}

/// Every hint device 0 holds that names `peer`.
fn hints_naming(net: &Net, peer: usize) -> Vec<EventId> {
    net.devs[0]
        .node
        .t
        .hints
        .keys()
        .filter(|k| k.1 == member(peer))
        .map(|k| k.2)
        .collect()
}

/// Member `peer` asks device 0 for `id`; the answer.
fn ask_event(net: &mut Net, peer: usize, rid: u8, id: EventId) -> Response {
    let chat = net.chat();
    let q = query(
        rid,
        net.now,
        MIN,
        vec![QueryOp::Event {
            chat_id: chat,
            event_id: id,
        }],
    );
    net.recv_frames(0, member(peer), &[q]);
    let frames = net.poll_frames(0).remove(&member(peer)).unwrap_or_default();
    let mut rs = responses(&frames);
    assert_eq!(rs.len(), 1);
    rs.remove(0)
}

/// Member `peer` asks device 0 for the sync object `sync`; the answer.
fn ask_sync(net: &mut Net, peer: usize, rid: u8, sync: SyncObjId) -> Response {
    let chat = net.chat();
    let q = query(
        rid,
        net.now,
        MIN,
        vec![QueryOp::SyncObj {
            chat_id: chat,
            sync_obj_id: sync,
        }],
    );
    net.recv_frames(0, member(peer), &[q]);
    let frames = net.poll_frames(0).remove(&member(peer)).unwrap_or_default();
    let mut rs = responses(&frames);
    assert_eq!(rs.len(), 1);
    rs.remove(0)
}

/// Every event ID device 0 names in what it sends now: full events, notices, answers.
fn named(sent: &BTreeMap<GossipId, Vec<Frame>>) -> BTreeSet<EventId> {
    let mut ids = BTreeSet::new();
    for frames in sent.values() {
        ids.extend(full_events(frames));
        ids.extend(announced(frames));
        for r in responses(frames) {
            if let Some(e) = answer_event(&r) {
                ids.insert(e.event_id());
                ids.extend(e.parents().iter().copied());
            }
        }
    }
    ids
}

/// Moves past the longest wait and runs the timers of device 0.
fn after_wait(net: &mut Net) {
    net.now += RELAY_WAIT_MAX_MS;
    net.tick(0);
}

// ── A message published under another member's name (D.95, D.96) ───────────

#[test]
fn a_message_as_another_member_waits_then_leaves_as_notices_to_the_normal_set() {
    let mut net = Net::new(6, 1);
    neighbors_of(&mut net, 0, &[1, 2]);
    let chat = net.chat();
    let start = net.now;
    let e = publish_as(&mut net, 1, "as bob");
    // The true timestamp, and the message is shown here at once.
    assert_eq!(e.event_id().timestamp(), start);
    let Payload::Content(c) = e.payload() else {
        panic!()
    };
    assert_eq!(c.author, member(1));
    assert!(net.held(0, &e.event_id()));
    // Nothing leaves during the wait, and nothing at all goes in full.
    let sent = net.poll_frames(0);
    assert!(named(&sent).is_empty(), "{sent:?}");
    let relay = *net.devs[0]
        .node
        .t
        .relays
        .get(&(chat, e.event_id()))
        .expect("waiting");
    assert!(relay.due >= start + RELAY_WAIT_MIN_MS && relay.due <= start + RELAY_WAIT_MAX_MS);
    assert!(
        hints_for(&net, e.event_id()).is_empty(),
        "no hint during the wait"
    );
    net.now = relay.due - 1;
    net.tick(0);
    assert!(named(&net.poll_frames(0)).is_empty());
    // Once it is over: notices to the two neighbors and two random extra members, the
    // normal set of a relay; the claimed author, a neighbor, is notified despite the hint.
    net.now = relay.due;
    net.tick(0);
    let sent = net.poll_frames(0);
    assert!(recipients(&sent, full_events, e.event_id()).is_empty());
    let noticed = recipients(&sent, announced, e.event_id());
    assert_eq!(noticed.len(), 4, "{noticed:?}");
    assert!(noticed.contains(&1) && noticed.contains(&2));
    assert!(!noticed.contains(&0));
    // One hint, for the claimed author and this event only (no ancestor walk).
    assert_eq!(hints_for(&net, e.event_id()), BTreeSet::from([1]));
    assert_eq!(hints_naming(&net, 1), vec![e.event_id()]);
    // Nothing else is kept once the notice is out.
    assert!(net.devs[0].node.t.relays.len() == 0);
    // The claimed author asks for it although the hints say they have it: the full event.
    let r = ask_event(&mut net, 1, 1, e.event_id());
    assert_eq!(answer_event(&r), Some(e.clone()));
    check_invariants(&net.devs[0].store, &chat, net.now).unwrap();
}

#[test]
fn the_hint_for_the_claimed_author_is_written_only_for_the_event_even_with_ancestors() {
    let mut net = Net::new(6, 1);
    neighbors_of(&mut net, 0, &[1, 2]);
    // A short chain of earlier messages: a real arrival would mark a sample of them.
    let a = net.event(T0, 1, &[], 3);
    net.give(0, 3, &a);
    let b = net.event(T0 + 1, 2, &[a.event_id()], 3);
    net.give(0, 3, &b);
    net.poll(0);
    net.now = T0 + 10;
    let e = publish_as(&mut net, 4, "as member 4");
    assert!(e.parents().contains(&b.event_id()));
    after_wait(&mut net);
    net.poll(0);
    assert_eq!(hints_naming(&net, 4), vec![e.event_id()]);
}

#[test]
fn the_claimed_author_gets_a_hint_whether_or_not_it_is_a_neighbor_and_is_not_forced_into_the_set() {
    // Twelve members, three neighbors: the claimed author 10 is not a neighbor.
    let mut forced = 0;
    for seed in 0..20u64 {
        let mut net = Net::new(12, 1);
        net.rng = crate::rng::TestRng::new(seed);
        neighbors_of(&mut net, 0, &[1, 2, 3]);
        let e = publish_as(&mut net, 10, "as member 10");
        after_wait(&mut net);
        let sent = net.poll_frames(0);
        let noticed = recipients(&sent, announced, e.event_id());
        // The normal set: the neighbors and two extra members, nothing added for 10.
        assert_eq!(noticed.len(), 5, "{noticed:?}");
        assert!([1, 2, 3].iter().all(|n| noticed.contains(n)));
        assert_eq!(hints_for(&net, e.event_id()), BTreeSet::from([10]));
        forced += usize::from(noticed.contains(&10));
    }
    // Member 10 is an extra recipient only by the draw (2 of 8 non-neighbors).
    assert!(forced < 20, "the claimed author is not always notified");
}

#[test]
fn the_wait_survives_a_restart() {
    let mut net = Net::new(6, 1);
    neighbors_of(&mut net, 0, &[1, 2]);
    let e = publish_as(&mut net, 1, "as bob");
    // The app closes during the wait.
    let dev = &mut net.devs[0];
    dev.node = Node::open(&dev.store, member(0)).unwrap();
    assert!(named(&net.poll_frames(0)).is_empty());
    let wake = {
        let dev = &net.devs[0];
        dev.node.next_wakeup(&dev.store, net.now).unwrap().unwrap()
    };
    assert!(wake <= net.now + RELAY_WAIT_MAX_MS);
    after_wait(&mut net);
    let noticed = recipients(&net.poll_frames(0), announced, e.event_id());
    assert!(noticed.contains(&1) && noticed.contains(&2), "{noticed:?}");
}

#[test]
fn the_notice_to_the_claimed_author_survives_a_restart_despite_the_hint() {
    let mut net = Net::new(6, 1);
    neighbors_of(&mut net, 0, &[1, 2]);
    let e = publish_as(&mut net, 1, "as bob");
    after_wait(&mut net);
    // The notices are queued and the hint written; the app closes before they leave.
    let dev = &mut net.devs[0];
    dev.node = Node::open(&dev.store, member(0)).unwrap();
    let noticed = recipients(&net.poll_frames(0), announced, e.event_id());
    assert!(noticed.contains(&1), "{noticed:?}");
    assert_eq!(net.devs[0].node.t.relays.len(), 0);
}

// ── The record that lets the hinted peer be notified: one round only (D.98) ─

#[test]
fn the_record_for_the_hinted_peer_does_not_survive_the_first_round_when_its_notice_leaves() {
    let mut net = Net::new(4, 1);
    neighbors_of(&mut net, 0, &[1, 2]);
    let chat = net.chat();
    let e = publish_as(&mut net, 1, "as bob");
    after_wait(&mut net);
    // The record waits for the first round of sending.
    assert_eq!(
        net.devs[0].node.t.relays.get(&(chat, e.event_id())).map(|r| r.notify),
        Some(Some(member(1)))
    );
    // The round: the notice to Bob is assembled, and the record is gone at once, before
    // the transport even confirmed anything.
    let now = net.now;
    let dev = &mut net.devs[0];
    let out = dev.node.poll_outbox(&mut dev.store, now, &mut net.rng).unwrap();
    assert_eq!(dev.node.t.relays.len(), 0);
    let to_bob: Vec<EventId> = out
        .iter()
        .filter(|o| o.to == member(1))
        .flat_map(|o| announced(&frames(&o.plaintext)))
        .collect();
    assert_eq!(to_bob, vec![e.event_id()]);
    // Abandoned by the transport: assembled again later, the hint now cancels it.
    for o in out {
        dev.node.abandon(o.handle);
    }
    dev.node.set_session(member(1), true);
    net.now += MIN;
    let again = net.poll_frames(0);
    assert!(recipients(&again, announced, e.event_id()).contains(&2));
    assert!(!recipients(&again, announced, e.event_id()).contains(&1));
}

#[test]
fn the_record_for_the_hinted_peer_is_dropped_when_that_peer_has_no_session_in_the_first_round() {
    let mut net = Net::new(4, 1);
    neighbors_of(&mut net, 0, &[1, 2]);
    let chat = net.chat();
    let e = publish_as(&mut net, 1, "as bob");
    after_wait(&mut net);
    assert!(net.devs[0].node.t.relays.contains(&(chat, e.event_id())));
    // No working session with Bob at that moment.
    net.devs[0].node.set_session(member(1), false);
    let sent = net.poll_frames(0);
    assert!(recipients(&sent, announced, e.event_id()).contains(&2));
    assert!(!sent.contains_key(&member(1)));
    assert_eq!(net.devs[0].node.t.relays.len(), 0);
    // Bob comes back: this device never notifies him of it.
    net.devs[0].node.set_session(member(1), true);
    net.now += MIN;
    net.tick(0);
    assert!(!recipients(&net.poll_frames(0), announced, e.event_id()).contains(&1));
    // Even when nothing at all can be sent in that round, the record goes.
    let f = publish_as(&mut net, 1, "as bob, again");
    for p in [1, 2, 3] {
        net.devs[0].node.set_session(member(p), false);
    }
    after_wait(&mut net);
    assert!(net.devs[0].node.t.relays.contains(&(chat, f.event_id())));
    assert!(net.poll(0).is_empty());
    assert_eq!(net.devs[0].node.t.relays.len(), 0);
}

/// A chat of two: device 0 publishes as member 1, whose session is missing in the first round
/// after the wait; member 1 is not notified then, nor later.
fn chat_of_two_not_notified() -> (Net, MessageEvent) {
    let mut net = Net::new(2, 2);
    neighbors_of(&mut net, 0, &[1]);
    neighbors_of(&mut net, 1, &[0]);
    let e = publish_as(&mut net, 1, "as you");
    net.devs[0].node.set_session(member(1), false);
    after_wait(&mut net);
    assert!(net.poll(0).is_empty());
    assert_eq!(net.devs[0].node.t.relays.len(), 0);
    net.devs[0].node.set_session(member(1), true);
    net.now += MIN;
    net.tick(0);
    net.exchange();
    assert!(!net.known(1, &e.event_id()), "not notified later");
    (net, e)
}

#[test]
fn in_a_chat_of_two_the_unnotified_member_gets_the_event_once_the_next_event_names_it() {
    let (mut net, e) = chat_of_two_not_notified();
    // The publisher's next message names it as a parent: member 1 asks, and is answered.
    net.now += MIN;
    let next = net.publish(0, "mine");
    assert!(next.parents().contains(&e.event_id()));
    // At the same moment: no lane or timer is involved, only the missing parent.
    net.exchange();
    assert!(net.held(1, &next.event_id()));
    assert!(net.held(1, &e.event_id()));
}

#[test]
fn in_a_chat_of_two_the_unnotified_member_gets_the_event_through_tip_sync() {
    let (mut net, e) = chat_of_two_not_notified();
    // Nothing else is published: member 1's periodic tip sync with device 0 lists it.
    for _ in 0..12 {
        net.now += 6 * HOUR;
        net.tick(0);
        net.tick(1);
        net.exchange();
        if net.held(1, &e.event_id()) {
            break;
        }
    }
    assert!(net.held(1, &e.event_id()));
}

#[test]
fn the_first_time_of_the_hint_is_never_rewritten() {
    let mut net = Net::new(4, 1);
    neighbors_of(&mut net, 0, &[1, 2]);
    let chat = net.chat();
    let e = publish_as(&mut net, 1, "as bob");
    after_wait(&mut net);
    net.poll(0);
    let first = net.devs[0]
        .node
        .t
        .hints
        .get(&(chat, member(1), e.event_id()))
        .unwrap()
        .first;
    // Bob announces it later, as he would once he fetched it.
    net.now += MIN;
    net.recv_frames(0, member(1), &[notice(chat, &[e.event_id()])]);
    let h = *net.devs[0]
        .node
        .t
        .hints
        .get(&(chat, member(1), e.event_id()))
        .unwrap();
    assert_eq!(h.first, first);
    assert!(h.used > first);
}

#[test]
fn an_author_who_is_not_a_member_is_refused() {
    let mut net = Net::new(3, 1);
    let now = net.now;
    let chat = net.chat();
    let dev = &mut net.devs[0];
    assert!(
        dev.node
            .publish_message_as(
                &mut dev.store,
                chat,
                member(7),
                Body::Text("x".into()),
                BTreeMap::new(),
                None,
                now,
                &mut net.rng,
            )
            .is_err()
    );
    assert!(dev.node.t.relays.len() == 0);
}

#[test]
fn an_own_message_still_goes_in_full_at_once() {
    let mut net = Net::new(4, 1);
    neighbors_of(&mut net, 0, &[1, 2]);
    let e = publish_as(&mut net, 0, "mine");
    let full = recipients(&net.poll_frames(0), full_events, e.event_id());
    assert!(full.contains(&1) && full.contains(&2));
    assert_eq!(net.devs[0].node.t.relays.len(), 0);
}

#[test]
fn a_relay_pruned_during_the_wait_announces_nothing() {
    let mut net = Net::new(4, 1);
    neighbors_of(&mut net, 0, &[1, 2]);
    let chat = net.chat();
    let e = publish_as(&mut net, 1, "as bob");
    let now = net.now;
    let dev = &mut net.devs[0];
    dev.node
        .local_delete(&mut dev.store, chat, sync_of(&e), now, &mut net.rng)
        .unwrap();
    assert_eq!(net.devs[0].node.t.relays.len(), 0);
    after_wait(&mut net);
    assert!(named(&net.poll_frames(0)).is_empty());
}

// ── An edit that changes the author, and the sending rule of edits (D.97) ───

/// Bob's message, received by device 0 from Bob.
fn bobs_message(net: &mut Net) -> MessageEvent {
    let m = net.event(T0, 9, &[], 1);
    net.give(0, 1, &m);
    net.poll(0);
    net.now = T0 + 10;
    m
}

#[test]
fn an_own_edit_of_an_own_message_goes_in_full_at_once() {
    let mut net = Net::new(4, 1);
    neighbors_of(&mut net, 0, &[1, 2]);
    let m = net.publish(0, "mine");
    net.poll(0);
    net.now += 10;
    let edit = edit_as(&mut net, sync_of(&m), None, "mine, edited");
    let full = recipients(&net.poll_frames(0), full_events, edit.event_id());
    assert!(full.contains(&1) && full.contains(&2));
    // Explicitly naming oneself is the same edit.
    net.now += 10;
    let again = edit_as(&mut net, sync_of(&m), Some(0), "mine, again");
    let full = recipients(&net.poll_frames(0), full_events, again.event_id());
    assert!(full.contains(&1) && full.contains(&2));
}

#[test]
fn an_edit_giving_an_own_message_to_another_member_leaves_like_a_relay() {
    let mut net = Net::new(4, 1);
    neighbors_of(&mut net, 0, &[1, 2]);
    let m = net.publish(0, "mine");
    net.poll(0);
    net.now += 10;
    let edit = edit_as(&mut net, sync_of(&m), Some(2), "now carol's");
    let Payload::Content(c) = edit.payload() else {
        panic!()
    };
    assert_eq!(c.author, member(2));
    assert!(named(&net.poll_frames(0)).is_empty());
    after_wait(&mut net);
    let sent = net.poll_frames(0);
    assert!(recipients(&sent, full_events, edit.event_id()).is_empty());
    let noticed = recipients(&sent, announced, edit.event_id());
    assert!(noticed.contains(&1) && noticed.contains(&2), "{noticed:?}");
    assert_eq!(hints_for(&net, edit.event_id()), BTreeSet::from([2]));
}

#[test]
fn an_edit_of_another_members_message_keeping_its_author_waits_and_names_that_author() {
    let mut net = Net::new(4, 1);
    neighbors_of(&mut net, 0, &[1, 2]);
    let m = bobs_message(&mut net);
    let edit = edit_as(&mut net, sync_of(&m), None, "bob's, edited");
    assert!(
        named(&net.poll_frames(0)).is_empty(),
        "no longer sent at once"
    );
    after_wait(&mut net);
    let sent = net.poll_frames(0);
    assert!(recipients(&sent, full_events, edit.event_id()).is_empty());
    let noticed = recipients(&sent, announced, edit.event_id());
    assert!(noticed.contains(&1) && noticed.contains(&2), "{noticed:?}");
    assert_eq!(hints_for(&net, edit.event_id()), BTreeSet::from([1]));
}

#[test]
fn a_re_appropriation_names_one_random_peer_inside_the_notice_set_and_notifies_it() {
    let mut picked = BTreeSet::new();
    for seed in 0..30u64 {
        let mut net = Net::new(8, 1);
        net.rng = crate::rng::TestRng::new(seed);
        neighbors_of(&mut net, 0, &[1, 2, 3]);
        let m = bobs_message(&mut net);
        let edit = edit_as(&mut net, sync_of(&m), Some(0), "mine now");
        let Payload::Content(c) = edit.payload() else {
            panic!()
        };
        assert_eq!(c.author, member(0));
        // Not pushed in full: that would tell the user's neighbors the user took it.
        assert!(named(&net.poll_frames(0)).is_empty());
        after_wait(&mut net);
        let sent = net.poll_frames(0);
        assert!(recipients(&sent, full_events, edit.event_id()).is_empty());
        let noticed = recipients(&sent, announced, edit.event_id());
        assert_eq!(noticed.len(), 5, "{noticed:?}");
        let hinted = hints_for(&net, edit.event_id());
        assert_eq!(hinted.len(), 1);
        let peer = *hinted.iter().next().unwrap();
        assert!(
            noticed.contains(&peer),
            "inside the set, and notified anyway"
        );
        picked.insert(peer);
    }
    // Random, not the previous author every time.
    assert!(picked.len() > 2, "{picked:?}");
}

#[test]
fn a_re_appropriation_in_a_chat_of_two_names_the_previous_author() {
    let mut net = Net::new(2, 1);
    neighbors_of(&mut net, 0, &[1]);
    let m = bobs_message(&mut net);
    let edit = edit_as(&mut net, sync_of(&m), Some(0), "mine now");
    assert!(named(&net.poll_frames(0)).is_empty());
    after_wait(&mut net);
    let sent = net.poll_frames(0);
    assert_eq!(
        recipients(&sent, announced, edit.event_id()),
        BTreeSet::from([1])
    );
    assert_eq!(hints_for(&net, edit.event_id()), BTreeSet::from([1]));
}

#[test]
fn an_edit_that_changes_the_author_is_accepted_by_an_unmodified_receiver() {
    // Device 1 runs the receiving side only: nothing in it knows of the new abilities.
    let mut net = Net::new(3, 2);
    neighbors_of(&mut net, 0, &[1]);
    let chat = net.chat();
    let m = net.publish(0, "mine");
    net.exchange();
    net.now += 10;
    let edit = edit_as(&mut net, sync_of(&m), Some(2), "carol's now");
    after_wait(&mut net);
    net.exchange();
    let obj = net.devs[1]
        .store
        .object(&chat, &sync_of(&m))
        .unwrap()
        .unwrap();
    let Some(StoredResult::Content(c)) = obj.current else {
        panic!()
    };
    assert_eq!(c.author, member(2));
    assert!(net.held(1, &edit.event_id()));
}

#[test]
fn a_reaction_cannot_be_given_another_author() {
    let mut net = Net::new(3, 1);
    let chat = net.chat();
    let m = net.publish(0, "mine");
    let now = net.now + 1;
    let dev = &mut net.devs[0];
    let r = dev
        .node
        .publish_reaction(
            &mut dev.store,
            chat,
            sync_of(&m),
            "👍".into(),
            true,
            now,
            &mut net.rng,
        )
        .unwrap();
    let e = dev.node.publish_edit_as(
        &mut dev.store,
        chat,
        sync_of(&r.event),
        Body::Text("x".into()),
        BTreeMap::new(),
        None,
        Some(member(1)),
        now + 1,
        &mut net.rng,
    );
    assert!(e.is_err());
}

#[test]
fn a_retry_of_another_members_message_leaves_like_a_relay() {
    let mut net = Net::new(4, 1);
    neighbors_of(&mut net, 0, &[1, 2]);
    let m = bobs_message(&mut net);
    let now = net.now;
    let chat = net.chat();
    let dev = &mut net.devs[0];
    let r = dev
        .node
        .retry(&mut dev.store, chat, sync_of(&m), now, &mut net.rng)
        .unwrap()
        .event;
    assert!(named(&net.poll_frames(0)).is_empty());
    after_wait(&mut net);
    let sent = net.poll_frames(0);
    assert!(recipients(&sent, full_events, r.event_id()).is_empty());
    assert!(!recipients(&sent, announced, r.event_id()).is_empty());
    assert_eq!(hints_for(&net, r.event_id()), BTreeSet::from([1]));
}

// ── A message on this device only (D.92, D.93, D.94) ─────────────────────────

/// What device 0 stores of an epoch: rows, edges, objects.
type Records = (
    Vec<crate::store::EventRow>,
    Vec<(EventId, Vec<EventId>)>,
    Vec<ObjectRecord>,
);

fn records(net: &Net) -> Records {
    let chat = net.chat();
    let s = &net.devs[0].store;
    (
        s.event_rows(&chat).unwrap(),
        s.edges(&chat).unwrap(),
        s.objects(&chat).unwrap(),
    )
}

#[test]
fn a_local_message_with_no_timer_is_its_result_only_and_nothing_leaves() {
    let mut net = Net::new(4, 1);
    neighbors_of(&mut net, 0, &[1, 2]);
    let chat = net.chat();
    let a = net.event(T0, 1, &[], 1);
    net.give(0, 1, &a);
    net.poll(0);
    net.now = T0 + 10;
    let (rows, edges, _) = records(&net);
    let queued = net.devs[0].node.queued();
    let sync = local(&mut net, 2, "only here, as carol");
    // Nothing queued for anyone.
    assert_eq!(net.devs[0].node.queued(), queued);
    assert!(named(&net.poll_frames(0)).is_empty());
    // The result only: no row, no edge, no stub.
    let (rows2, edges2, objects) = records(&net);
    assert_eq!(rows, rows2);
    assert_eq!(edges, edges2);
    let obj = objects.iter().find(|o| o.sync_obj_id == sync).unwrap();
    assert!(obj.current_events.is_empty() && obj.stubs.is_empty());
    assert!(obj.pending_versions.is_empty() && obj.pending_deletions.is_empty());
    assert_eq!((obj.expires_at, obj.erase_at), (None, None));
    assert!(obj.shareable);
    let Some(StoredResult::Content(c)) = &obj.current else {
        panic!()
    };
    assert_eq!(c.author, member(2));
    assert_eq!((c.created_at, c.last_modified_at), (net.now, net.now));
    assert!(!c.edited);
    // Never anything about it, later either.
    net.now += DAY;
    net.tick(0);
    assert!(net.devs[0].node.t.relays.len() == 0);
    let later = net.publish(0, "later");
    assert_eq!(later.parents(), &[a.event_id()]);
    check_invariants(&net.devs[0].store, &chat, net.now).unwrap();
}

#[test]
fn a_local_message_with_a_timer_has_one_stub_erased_with_it() {
    let mut net = Net::timed(4, 1, HOUR);
    neighbors_of(&mut net, 0, &[1, 2]);
    let chat = net.chat();
    let a = net.event(T0, 1, &[], 1);
    net.give(0, 1, &a);
    net.poll(0);
    net.now = T0 + 10;
    let tips_before = crate::dag::tips(&net.devs[0].store, &chat, net.now).unwrap();
    let sync = local(&mut net, 0, "only here");
    assert!(named(&net.poll_frames(0)).is_empty());
    let (rows, edges, objects) = records(&net);
    let obj = objects
        .iter()
        .find(|o| o.sync_obj_id == sync)
        .unwrap()
        .clone();
    assert_eq!(obj.stubs.len(), 1);
    let stub = *obj.stubs.iter().next().unwrap();
    assert_eq!(stub.timestamp(), net.now);
    assert!(obj.current_events.is_empty());
    assert_eq!(obj.expires_at, Some(net.now + HOUR));
    assert_eq!(obj.erase_at, Some(net.now + HOUR));
    assert_eq!(
        rows.iter().find(|r| r.event_id == stub).map(|r| &r.state),
        Some(&RowState::Pruned)
    );
    let parents = edges.iter().find(|(c, _)| *c == stub).unwrap().1.clone();
    assert_eq!(
        parents, tips_before,
        "the tips, as a publication would choose"
    );
    check_invariants(&net.devs[0].store, &chat, net.now).unwrap();
    // Never a tip or a parent; never listed in a scan; asked for, "not available" as for an
    // unknown ID.
    assert_eq!(
        crate::dag::tips(&net.devs[0].store, &chat, net.now).unwrap(),
        tips_before
    );
    let ids = super::scans::ids(&super::scans::page(super::scans::ask(&mut net, 2, 1, 1, 0)));
    assert!(!ids.contains(&stub));
    let asked = ask_event(&mut net, 2, 2, stub);
    let unknown_id = EventId::new(net.now, [0xEE; 16]);
    let unknown = ask_event(&mut net, 2, 3, unknown_id);
    assert_eq!(status(&asked), Some(Status::NotAvailable));
    assert_eq!(asked.result, unknown.result);
    net.now += 1;
    let later = net.publish(0, "later");
    assert!(!later.parents().contains(&stub));
    assert!(!named(&net.poll_frames(0)).contains(&stub));
    // A notice naming it from a peer starts nothing (§11.7).
    net.recv_frames(0, member(1), &[notice(chat, &[stub])]);
    assert!(named(&net.poll_frames(0)).is_empty());
    // The timer erases the message and its stub together.
    net.now = obj.erase_at.unwrap();
    net.tick(0);
    assert!(!net.known(0, &stub));
    assert!(net.devs[0].store.object(&chat, &sync).unwrap().is_none());
    assert!(!records(&net).1.iter().any(|(c, _)| *c == stub));
    check_invariants(&net.devs[0].store, &chat, net.now).unwrap();
}

#[test]
fn a_local_message_is_answered_as_a_message_whose_events_were_evicted() {
    let mut net = Net::timed(4, 1, HOUR);
    let chat = net.chat();
    let real = net.publish(0, "real");
    net.poll(0);
    net.now += 10;
    Epoch::new(&net.root, true, GroupState::Active)
        .evict(&mut net.devs[0].store, net.now, 1)
        .unwrap();
    assert!(!net.held(0, &real.event_id()));
    let sync = local(&mut net, 0, "only here");
    let a = ask_sync(&mut net, 2, 1, sync_of(&real));
    let b = ask_sync(&mut net, 2, 2, sync);
    assert_eq!(a.result, b.result);
    check_invariants(&net.devs[0].store, &chat, net.now).unwrap();
}

/// The records of a local-only message against those of a real message of this device
/// whose events were all evicted: the same shape, with only these differences: the random
/// IDs (sync object and stub), the content, and, with no timer, the real message's pruned
/// row and edges, which nothing links to it.
#[test]
fn a_local_message_is_stored_as_a_real_message_whose_events_were_evicted() {
    for timer in [0, HOUR] {
        let mut net = if timer == 0 {
            Net::new(4, 1)
        } else {
            Net::timed(4, 1, timer)
        };
        let chat = net.chat();
        let base = net.event(T0, 1, &[], 1);
        net.give(0, 1, &base);
        net.poll(0);
        net.now = T0 + 10;
        // A real message of this device, then every event of it evicted.
        let real = net.publish(0, "same text");
        net.poll(0);
        // Oldest first: the earlier message, then this one.
        Epoch::new(&net.root, true, GroupState::Active)
            .evict(&mut net.devs[0].store, net.now, 2)
            .unwrap();
        assert!(!net.held(0, &real.event_id()));
        let (rows1, edges1, objs1) = records(&net);
        // A local-only message created at the same moment, from the same tips.
        let mut other = if timer == 0 {
            Net::new(4, 1)
        } else {
            Net::timed(4, 1, timer)
        };
        other.give(0, 1, &base);
        other.poll(0);
        other.now = T0 + 10;
        let sync = local(&mut other, 0, "same text");
        // The earlier message evicted too, as on the first device.
        Epoch::new(&other.root, true, GroupState::Active)
            .evict(&mut other.devs[0].store, other.now, 2)
            .unwrap();
        let (rows2, edges2, objs2) = records(&other);
        let mut r = objs1
            .into_iter()
            .find(|o| o.sync_obj_id == sync_of(&real))
            .unwrap();
        let mut l = objs2.into_iter().find(|o| o.sync_obj_id == sync).unwrap();
        // Normalise the random IDs.
        let zero = SyncObjId::from_bytes([0; 32]);
        for o in [&mut r, &mut l] {
            o.sync_obj_id = zero;
            if let Some(StoredResult::Content(c)) = &mut o.current {
                c.sync_obj_id = zero;
            }
            o.stubs = o
                .stubs
                .iter()
                .map(|s| EventId::new(s.timestamp(), [0; 16]))
                .collect();
        }
        assert_eq!(r, l, "timer {timer}");
        // Rows and edges without their random bytes: timestamp, state, parents.
        let rows = |rows: &[crate::store::EventRow]| -> Vec<(u64, RowState)> {
            rows.iter()
                .map(|x| (x.event_id.timestamp(), x.state.clone()))
                .collect()
        };
        let edges = |edges: &[(EventId, Vec<EventId>)]| -> Vec<(u64, Vec<EventId>)> {
            edges
                .iter()
                .map(|(c, p)| (c.timestamp(), p.clone()))
                .collect()
        };
        let base_only = (
            vec![(T0, RowState::Pruned)],
            vec![(T0, Vec::<EventId>::new())],
        );
        let with_message = (
            vec![(T0, RowState::Pruned), (T0 + 10, RowState::Pruned)],
            vec![(T0, vec![]), (T0 + 10, vec![base.event_id()])],
        );
        assert_eq!((rows(&rows1), edges(&edges1)), with_message);
        if timer == 0 {
            // The real message leaves a pruned row and its edges, linked to nothing (no
            // timer: `stubs` stays empty); the local-only message leaves none.
            assert_eq!((rows(&rows2), edges(&edges2)), base_only);
        } else {
            // The same: one pruned stub dated now, its parents the tips of that moment.
            assert_eq!((rows(&rows2), edges(&edges2)), with_message);
        }
        check_invariants(&net.devs[0].store, &chat, net.now).unwrap();
        check_invariants(&other.devs[0].store, &chat, other.now).unwrap();
    }
}

#[test]
fn a_local_message_takes_replies_reactions_local_changes_and_retry_like_any_message() {
    let mut net = Net::timed(4, 1, HOUR);
    neighbors_of(&mut net, 0, &[1, 2]);
    let chat = net.chat();
    let sync = local(&mut net, 1, "only here, as bob");
    let now = net.now + 1;
    let dev = &mut net.devs[0];
    dev.node
        .publish_reaction(
            &mut dev.store,
            chat,
            sync,
            "👍".into(),
            true,
            now,
            &mut net.rng,
        )
        .unwrap();
    dev.node
        .local_edit(
            &mut dev.store,
            chat,
            sync,
            LocalEdit {
                body: Some(Body::Text("changed here".into())),
                ..LocalEdit::default()
            },
            now + 1,
            &mut net.rng,
        )
        .unwrap();
    let retried = dev
        .node
        .retry(&mut dev.store, chat, sync, now + 2, &mut net.rng)
        .unwrap()
        .event;
    // Retry publishes it to everyone, under its author, as a relay of Bob's message.
    let Payload::Content(c) = retried.payload() else {
        panic!()
    };
    assert_eq!(c.author, member(1));
    assert_eq!(c.created_at, net.now);
    net.now = now + 2;
    after_wait(&mut net);
    assert!(!recipients(&net.poll_frames(0), announced, retried.event_id()).is_empty());
    let now = net.now;
    let dev = &mut net.devs[0];
    dev.node
        .local_delete(&mut dev.store, chat, sync, now, &mut net.rng)
        .unwrap();
    check_invariants(&net.devs[0].store, &chat, net.now).unwrap();
}

#[test]
fn a_local_message_refuses_a_reaction_body_and_a_non_member() {
    let mut net = Net::new(3, 1);
    let chat = net.chat();
    let now = net.now;
    let dev = &mut net.devs[0];
    let reaction = Body::Reaction(crate::event::Reaction {
        target: SyncObjId::from_bytes([1; 32]),
        emoji: "👍".into(),
        action: crate::event::ReactionAction::Add,
    });
    for (author, body) in [(member(0), reaction), (member(9), Body::Text("x".into()))] {
        assert!(
            dev.node
                .local_message(
                    &mut dev.store,
                    chat,
                    author,
                    body,
                    BTreeMap::new(),
                    now,
                    &mut net.rng
                )
                .is_err()
        );
    }
    assert!(dev.store.objects(&chat).unwrap().is_empty());
}
