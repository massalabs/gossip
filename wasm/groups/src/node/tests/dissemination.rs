//! §10.2 to §10.4: who receives what, notices, hints and ancestor sampling, removed peers,
//! and invalidation of pending work.

use super::*;
use crate::node::hints::ANCESTOR_SAMPLES;
use crate::node::timing::{HINT_CAPACITY, HINT_EXPIRY_MS};

/// Device `d` accepts a neighbor request from each member of `peers`, then forgets its
/// answers.
pub(crate) fn neighbors_of(net: &mut Net, d: usize, peers: &[usize]) {
    let chat = net.chat();
    for p in peers {
        net.recv_frames(
            d,
            member(*p),
            &[Frame::NeighborRequest(NeighborRequest { chat_id: chat })],
        );
    }
    net.poll(d);
    for p in peers {
        assert!(net.devs[d].node.is_neighbor(&chat, &member(*p)));
    }
}

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

#[test]
fn an_own_message_goes_in_full_to_the_neighbors_and_two_extra_members() {
    let mut net = Net::new(6, 1);
    neighbors_of(&mut net, 0, &[1, 2]);
    let e = net.publish(0, "hi");
    let sent = net.poll_frames(0);
    let full = recipients(&sent, full_events, e.event_id());
    assert!(full.contains(&1) && full.contains(&2));
    assert_eq!(full.len(), 4, "two extra recipients: {full:?}");
    assert!(full.iter().all(|r| *r != 0));
    assert!(announced(&sent.values().flatten().cloned().collect::<Vec<_>>()).is_empty());
}

#[test]
fn extra_recipients_are_bounded_by_the_eligible_non_neighbors() {
    // Three members: two neighbors... none left; with one neighbor, one extra.
    let mut net = Net::new(3, 1);
    neighbors_of(&mut net, 0, &[1]);
    let e = net.publish(0, "hi");
    let full = recipients(&net.poll_frames(0), full_events, e.event_id());
    assert_eq!(full, BTreeSet::from([1, 2]));
}

#[test]
fn a_message_attributed_to_another_member_is_announced_not_sent() {
    let mut net = Net::new(4, 1);
    neighbors_of(&mut net, 0, &[1, 2]);
    // Bob's message, then this device edits it: the result is attributed to Bob (§10.2).
    let bobs = net.event(T0, 9, &[], 1);
    net.give(0, 1, &bobs);
    net.poll(0);
    let now = net.now;
    let chat = net.chat();
    let dev = &mut net.devs[0];
    let edit = dev
        .node
        .publish_edit(
            &mut dev.store,
            chat,
            SyncObjId::from_bytes([9; 32]),
            Body::Text("edited".into()),
            BTreeMap::new(),
            None,
            now + 1,
            &mut net.rng,
        )
        .unwrap()
        .event;
    // Nothing during the random wait (§10.2), then notices only.
    let sent = net.poll_frames(0);
    assert!(recipients(&sent, full_events, edit.event_id()).is_empty());
    assert!(recipients(&sent, announced, edit.event_id()).is_empty());
    net.now = now + 1 + crate::node::timing::RELAY_WAIT_MAX_MS;
    net.tick(0);
    let sent = net.poll_frames(0);
    assert!(recipients(&sent, full_events, edit.event_id()).is_empty());
    let noticed = recipients(&sent, announced, edit.event_id());
    assert!(noticed.contains(&1) && noticed.contains(&2), "{noticed:?}");
}

#[test]
fn a_relayed_event_is_announced_to_everyone_but_the_peer_that_sent_it() {
    let mut net = Net::new(6, 1);
    neighbors_of(&mut net, 0, &[1, 2, 3]);
    let e = net.event(T0, 5, &[], 1);
    net.give(0, 1, &e);
    let sent = net.poll_frames(0);
    let noticed = recipients(&sent, announced, e.event_id());
    assert!(!noticed.contains(&1));
    assert!(noticed.contains(&2) && noticed.contains(&3));
    // Two extra members among 4 and 5.
    assert_eq!(noticed.len(), 4);
    assert!(recipients(&sent, full_events, e.event_id()).is_empty());
}

#[test]
fn a_notice_from_a_peer_records_a_hint_that_suppresses_notices_to_it() {
    let mut net = Net::new(4, 1);
    neighbors_of(&mut net, 0, &[1, 2, 3]);
    let e = net.event(T0, 5, &[], 3);
    let chat = net.chat();
    // Peer 2 announced it before peer 1 delivered it.
    net.give(0, 3, &e);
    net.poll(0);
    net.recv_frames(0, member(2), &[notice(chat, &[e.event_id()])]);
    assert!(
        net.devs[0]
            .node
            .t
            .hints
            .contains(&(chat, member(2), e.event_id()))
    );
    // A child of E arrives from 1: E itself is not announced again to 2 or 3.
    let child = net.event(T0 + 1, 6, &[e.event_id()], 1);
    net.give(0, 1, &child);
    let sent = net.poll_frames(0);
    assert!(recipients(&sent, announced, e.event_id()).is_empty());
    // The child is announced to 2 and 3 but not to 1.
    assert_eq!(
        recipients(&sent, announced, child.event_id()),
        BTreeSet::from([2, 3])
    );
}

#[test]
fn a_full_send_records_a_hint_only_once_publication_is_confirmed() {
    let mut net = Net::new(2, 1);
    neighbors_of(&mut net, 0, &[1]);
    let e = net.publish(0, "hi");
    let chat = net.chat();
    let now = net.now;
    let dev = &mut net.devs[0];
    let out = dev
        .node
        .poll_outbox(&mut dev.store, now, &mut net.rng)
        .unwrap();
    assert_eq!(out.len(), 1);
    dev.node
        .handed_off(&mut dev.store, out[0].handle, now, &mut net.rng)
        .unwrap();
    let key = (chat, member(1), e.event_id());
    assert!(
        !dev.node.t.hints.contains(&key),
        "local queuing is not enough"
    );
    dev.node
        .published(&mut dev.store, out[0].handle, now, &mut net.rng)
        .unwrap();
    assert!(dev.node.t.hints.contains(&key));
}

#[test]
fn sending_a_notice_creates_no_hint() {
    let mut net = Net::new(3, 1);
    neighbors_of(&mut net, 0, &[1, 2]);
    let chat = net.chat();
    let r = net.event(T0, 7, &[], 1);
    net.give(0, 1, &r);
    let sent = net.poll_frames(0);
    assert!(announced(&sent[&member(2)]).contains(&r.event_id()));
    assert!(
        !net.devs[0]
            .node
            .t
            .hints
            .contains(&(chat, member(2), r.event_id()))
    );
}

#[test]
fn query_requests_and_unavailable_answers_create_no_hint() {
    let mut net = Net::new(3, 1);
    let chat = net.chat();
    let id = EventId::new(T0, [4; 16]);
    net.recv_frames(
        0,
        member(1),
        &[query(
            1,
            T0,
            MIN,
            vec![QueryOp::Event {
                chat_id: chat,
                event_id: id,
            }],
        )],
    );
    net.poll(0);
    assert_eq!(net.devs[0].node.t.hints.len(), 0);
}

#[test]
fn ancestor_sampling_walks_five_levels_with_16_8_4_2_1_samples() {
    // A chain of ten events: E10 and its five nearest ancestors are marked.
    let mut net = Net::new(3, 1);
    let chat = net.chat();
    let mut chain = Vec::new();
    for i in 0..10u8 {
        let parents: Vec<EventId> = chain
            .last()
            .map(|e: &MessageEvent| vec![e.event_id()])
            .unwrap_or_default();
        let e = net.event(T0 + u64::from(i), 10 + i, &parents, 1);
        net.give(0, 1, &e);
        chain.push(e);
    }
    let hinted = |net: &Net, peer: usize| -> usize {
        net.devs[0]
            .node
            .t
            .hints
            .keys()
            .filter(|k| k.0 == chat && k.1 == member(peer))
            .count()
    };
    let last = chain.last().unwrap().event_id();
    net.recv_frames(0, member(2), &[notice(chat, &[last])]);
    assert_eq!(hinted(&net, 2), 6);
    assert!(
        !net.devs[0]
            .node
            .t
            .hints
            .contains(&(chat, member(2), chain[3].event_id()))
    );
    assert!(
        net.devs[0]
            .node
            .t
            .hints
            .contains(&(chat, member(2), chain[4].event_id()))
    );

    // A wide graph: E has 16 parents, each with one parent of its own: 1 + 16 + 8.
    let mut net = Net::new(3, 1);
    let mut parents = Vec::new();
    for i in 0..16u8 {
        let q = net.event(T0, 100 + i, &[], 1);
        net.give(0, 1, &q);
        let p = net.event(T0 + 1, 120 + i, &[q.event_id()], 1);
        net.give(0, 1, &p);
        parents.push(p.event_id());
    }
    let e = net.event(T0 + 2, 150, &parents, 1);
    net.give(0, 1, &e);
    net.recv_frames(0, member(2), &[notice(chat, &[e.event_id()])]);
    assert_eq!(hinted(&net, 2), 1 + 16 + 8);
    assert_eq!(ANCESTOR_SAMPLES.iter().sum::<usize>() + 1, 32);
}

#[test]
fn the_traversal_budget_of_a_turn_bounds_ancestor_sampling() {
    let mut net = Net::new(3, 1);
    let chat = net.chat();
    let mut chain = Vec::new();
    for i in 0..10u8 {
        let parents: Vec<EventId> = chain
            .last()
            .map(|e: &MessageEvent| vec![e.event_id()])
            .unwrap_or_default();
        let e = net.event(T0 + u64::from(i), 10 + i, &parents, 1);
        net.give(0, 1, &e);
        chain.push(e);
    }
    let dev = &mut net.devs[0];
    let mut ov = crate::store::overlay::Overlay::new(&dev.store);
    let mut rng = TestRng::new(1);
    let mut cx = Cx {
        ov: &mut ov,
        now: T0,
        rng: &mut rng,
        edges: 2,
    };
    let before = dev.node.t.hints.len();
    dev.node
        .mark_seen(&mut cx, chat, member(2), chain[9].event_id())
        .unwrap();
    // E and two levels, then the budget is spent.
    assert_eq!(dev.node.t.hints.len() - before, 3);
    assert_eq!(cx.edges, 0);
}

#[test]
fn hints_expire_after_28_days_whatever_their_use() {
    let mut net = Net::new(3, 1);
    let chat = net.chat();
    let e = net.event(T0, 5, &[], 1);
    net.give(0, 1, &e);
    let key = (chat, member(1), e.event_id());
    let node = &mut net.devs[0].node;
    assert!(node.has_hint(chat, member(1), e.event_id(), T0 + HINT_EXPIRY_MS - 1));
    assert!(!node.has_hint(chat, member(1), e.event_id(), T0 + HINT_EXPIRY_MS));
    assert!(!node.t.hints.contains(&key));
    // Expiry by the tick as well.
    net.give(0, 2, &e);
    net.now = T0 + HINT_EXPIRY_MS + 1;
    net.tick(0);
    assert!(
        !net.devs[0]
            .node
            .t
            .hints
            .contains(&(chat, member(2), e.event_id()))
    );
}

#[test]
fn hints_are_capped_per_group_with_least_recently_used_eviction() {
    let mut net = Net::new(3, 1);
    let chat = net.chat();
    let node = &mut net.devs[0].node;
    let id = |i: u32| {
        EventId::new(T0, {
            let mut r = [0u8; 16];
            r[..4].copy_from_slice(&i.to_be_bytes());
            r
        })
    };
    for i in 0..HINT_CAPACITY as u32 {
        node.put_hint(chat, member(1), id(i), T0 + u64::from(i));
    }
    // Using the oldest makes the second oldest the victim.
    assert!(node.has_hint(chat, member(1), id(0), T0 + 10_000_000));
    node.put_hint(chat, member(2), id(0), T0 + 10_000_001);
    assert_eq!(node.t.hints.len(), HINT_CAPACITY);
    assert!(node.t.hints.contains(&(chat, member(1), id(0))));
    assert!(!node.t.hints.contains(&(chat, member(1), id(1))));
}

/// An epoch where member 2 is a removed peer (§10.4).
fn with_removed() -> Net {
    let mut net = Net::new(5, 1);
    let mut cfg = config(&net.root);
    cfg.removed = BTreeSet::from([member(2)]);
    let dev = &mut net.devs[0];
    dev.node
        .install_epoch(&mut dev.store, cfg, false, T0, &mut net.rng)
        .unwrap();
    net
}

#[test]
fn a_deletion_is_pushed_to_every_removed_peer_and_an_edit_never_reaches_one() {
    let mut net = with_removed();
    neighbors_of(&mut net, 0, &[1]);
    let chat = net.chat();
    let mine = net.publish(0, "mine");
    let sent = net.poll_frames(0);
    assert!(
        !sent.contains_key(&member(2)),
        "a message never reaches a removed peer"
    );
    let now = net.now;
    let sync = mine.payload().sync_obj_id();
    for _ in 0..20 {
        let dev = &mut net.devs[0];
        let edit = dev
            .node
            .publish_edit(
                &mut dev.store,
                chat,
                sync,
                Body::Text("e".into()),
                BTreeMap::new(),
                None,
                now,
                &mut net.rng,
            )
            .unwrap()
            .event;
        let sent = net.poll_frames(0);
        assert!(!recipients(&sent, full_events, edit.event_id()).contains(&2));
    }
    let dev = &mut net.devs[0];
    let del = dev
        .node
        .publish_deletion(&mut dev.store, chat, sync, None, now, &mut net.rng)
        .unwrap()
        .event;
    let sent = net.poll_frames(0);
    let full = recipients(&sent, full_events, del.event_id());
    assert!(full.contains(&2) && full.contains(&1), "{full:?}");
}

#[test]
fn everything_a_removed_peer_sends_is_dropped() {
    let mut net = with_removed();
    let chat = net.chat();
    let e = net.deletion(T0, 5, 9);
    net.give(0, 2, &e);
    assert!(!net.known(0, &e.event_id()));
    net.recv_frames(0, member(2), &[notice(chat, &[EventId::new(T0, [6; 16])])]);
    // No event is looked up; the device looks up the removal records to answer it (§5.6).
    assert!(
        net.devs[0]
            .node
            .t
            .tasks
            .keys()
            .all(|k| matches!(k.target, Target::Removal(_)))
    );
    // The same event relayed by a member that is not removed is accepted.
    net.give(0, 1, &e);
    assert!(net.held(0, &e.event_id()));
}

#[test]
fn a_removed_peer_is_served_deletion_events_only() {
    let mut net = with_removed();
    let chat = net.chat();
    let m = net.event(T0, 5, &[], 1);
    let d = net.deletion(T0, 6, 7);
    net.give(0, 1, &m);
    net.give(0, 1, &d);
    net.poll(0);
    net.recv_frames(
        0,
        member(2),
        &[query(
            1,
            T0,
            MIN,
            vec![
                QueryOp::Event {
                    chat_id: chat,
                    event_id: m.event_id(),
                },
                QueryOp::Event {
                    chat_id: chat,
                    event_id: d.event_id(),
                },
                QueryOp::SyncObj {
                    chat_id: chat,
                    sync_obj_id: SyncObjId::from_bytes([5; 32]),
                },
            ],
        )],
    );
    let rs = responses(&net.poll_frames(0)[&member(2)]);
    let by_idx: BTreeMap<u32, &Response> = rs.iter().map(|r| (r.idx, r)).collect();
    assert_eq!(status(by_idx[&0]), Some(Status::NotAvailable));
    assert_eq!(answer_event(by_idx[&1]).unwrap().event_id(), d.event_id());
    assert_eq!(status(by_idx[&2]), Some(Status::NotAvailable));
}

#[test]
fn pruning_invalidates_pending_sends_of_the_pruned_events() {
    let mut net = Net::new(3, 1);
    neighbors_of(&mut net, 0, &[1, 2]);
    let e = net.publish(0, "hi");
    let chat = net.chat();
    let now = net.now;
    let dev = &mut net.devs[0];
    let pruned = dev
        .node
        .local_edit(
            &mut dev.store,
            chat,
            e.payload().sync_obj_id(),
            crate::LocalEdit {
                body: Some(Body::Text("bye".into())),
                ..Default::default()
            },
            now + 1,
            &mut net.rng,
        )
        .unwrap();
    assert_eq!(pruned, vec![e.event_id()]);
    assert!(dev.node.stats.invalidated >= 2);
    let sent = net.poll_frames(0);
    assert!(recipients(&sent, full_events, e.event_id()).is_empty());
}

#[test]
fn an_event_that_loses_is_not_relayed() {
    let mut net = Net::new(4, 1);
    neighbors_of(&mut net, 0, &[1, 2, 3]);
    net.now = T0 + 20;
    let new = net.event(T0 + 10, 5, &[], 1);
    net.give(0, 1, &new);
    net.poll(0);
    // An older version of the same message loses and is pruned at once.
    let mut old = net.event(T0, 5, &[], 1);
    old = MessageEvent::create(
        &net.root,
        EventId::new(T0, [6; 16]),
        &[],
        old.payload().clone(),
    )
    .unwrap();
    net.give(0, 2, &old);
    let sent = net.poll_frames(0);
    assert!(recipients(&sent, announced, old.event_id()).is_empty());
}
