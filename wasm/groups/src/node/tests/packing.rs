//! §13.9, §13.10, §15.1: response allocation, packing, size limits, budgets, deferred
//! assembly and the two-phase handoff.

use super::dissemination::neighbors_of;
use super::retrieval::sent_lookups;
use super::*;
use crate::node::outbox::{Category, ReadyAnswer};
use crate::node::timing::RESPONSE_BURST;

fn ready(rid: u8, idx: u32, category: Category, seq: u64) -> ReadyAnswer {
    ReadyAnswer {
        key: (member(1), seq),
        event: None,
        request_id: RequestId::from_bytes([rid; 16]),
        idx,
        category,
        frame: Frame::Response(Response {
            request_id: Some(RequestId::from_bytes([rid; 16])),
            idx,
            result: ResponseResult::Status(Status::NotAvailable),
        }),
        len: 10,
    }
}

#[test]
fn allocations_take_three_deletions_per_final_lane_entry_and_pass_unused_shares() {
    let mut net = Net::new(3, 1);
    let node = &mut net.devs[0].node;
    let mut answers = Vec::new();
    let mut seq = 0;
    for i in 0..200 {
        answers.push(ready(1, i, Category::Deletion, seq));
        seq += 1;
    }
    for i in 0..30 {
        answers.push(ready(2, i, Category::Status, seq));
        seq += 1;
    }
    for i in 0..30 {
        answers.push(ready(3, i, Category::Ordinary, seq));
        seq += 1;
    }
    let out = node.allocate(member(1), Vec::new(), answers);
    let cats: Vec<Category> = out.iter().map(|a| a.category).collect();
    // First allocation of 128: 96 deletions, then 32 of the final lane (30 ordinary first,
    // then 2 statuses), emitted by category.
    let first = &cats[..128];
    assert_eq!(
        first.iter().filter(|c| **c == Category::Deletion).count(),
        96
    );
    assert!(first[..96].iter().all(|c| *c == Category::Deletion));
    assert!(first[96..126].iter().all(|c| *c == Category::Ordinary));
    assert!(first[126..].iter().all(|c| *c == Category::Status));
    // The rest: deletions keep their share; the statuses fill in.
    assert_eq!(cats.len(), 260);
    let second = &cats[128..256];
    assert_eq!(
        second.iter().filter(|c| **c == Category::Deletion).count(),
        100
    );
    assert_eq!(
        second.iter().filter(|c| **c == Category::Status).count(),
        28
    );
}

#[test]
fn answers_are_round_robin_across_requests_ascending_by_index() {
    let mut net = Net::new(3, 1);
    let node = &mut net.devs[0].node;
    let answers = vec![
        ready(1, 2, Category::Ordinary, 0),
        ready(1, 0, Category::Ordinary, 1),
        ready(1, 1, Category::Ordinary, 2),
        ready(2, 0, Category::Ordinary, 3),
        ready(2, 1, Category::Ordinary, 4),
    ];
    let out = node.allocate(member(1), Vec::new(), answers);
    let order: Vec<(u8, u32)> = out
        .iter()
        .map(|a| (a.request_id.as_bytes()[0], a.idx))
        .collect();
    assert_eq!(order, vec![(1, 0), (2, 0), (1, 1), (2, 1), (1, 2)]);
}

#[test]
fn answers_are_emitted_deletions_then_messages_then_statuses() {
    let mut net = Net::new(3, 1);
    let chat = net.chat();
    let m = net.event(T0, 5, &[], 1);
    let d = net.deletion(T0, 6, 9);
    net.give(0, 1, &m);
    net.give(0, 1, &d);
    net.poll(0);
    let missing = EventId::new(T0, [7; 16]);
    let ops = [missing, m.event_id(), d.event_id()]
        .iter()
        .map(|id| QueryOp::Event {
            chat_id: chat,
            event_id: *id,
        })
        .collect();
    net.recv_frames(0, member(2), &[query(1, T0, MIN, ops)]);
    let rs = responses(&net.poll_frames(0)[&member(2)]);
    let idx: Vec<u32> = rs.iter().map(|r| r.idx).collect();
    assert_eq!(idx, vec![2, 1, 0]);
}

#[test]
fn plaintexts_never_exceed_the_container_limit() {
    let mut net = Net::new(2, 1);
    neighbors_of(&mut net, 0, &[1]);
    let text = "x".repeat(1_000);
    for _ in 0..600 {
        net.publish(0, &text);
    }
    let out = net.poll(0);
    assert!(out.len() >= 3, "{} plaintexts", out.len());
    let mut events = 0;
    for (_, pt) in &out {
        assert!(pt.len() <= crate::constants::MAX_PLAINTEXT_BYTES);
        events += full_events(&frames(pt)).len();
    }
    assert_eq!(events, 600);
}

#[test]
fn the_response_budget_holds_back_answers_beyond_it() {
    let mut net = Net::new(3, 1);
    let chat = net.chat();
    let big = "y".repeat(60_000);
    let mut ids = Vec::new();
    for i in 0..30u8 {
        let e = MessageEvent::create(
            &net.root,
            EventId::new(T0, [i; 16]),
            &[],
            Payload::Content(Content {
                sync_obj_id: SyncObjId::from_bytes([i; 32]),
                author: member(1),
                created_at: T0,
                last_modified_at: T0,
                body: Body::Text(big.clone()),
                edited: false,
                metadata: BTreeMap::new(),
            }),
        )
        .unwrap();
        net.give(0, 1, &e);
        ids.push(e.event_id());
    }
    net.poll(0);
    let ops: Vec<QueryOp> = ids
        .iter()
        .map(|id| QueryOp::Event {
            chat_id: chat,
            event_id: *id,
        })
        .collect();
    net.recv_frames(
        0,
        member(2),
        &[
            query(1, T0, HOUR, ops[..16].to_vec()),
            query(2, T0, HOUR, ops[16..].to_vec()),
        ],
    );
    let first: usize = net
        .poll_frames(0)
        .get(&member(2))
        .map_or(0, |f| responses(f).len());
    assert!(
        first < 30 && (first as u64) * 60_000 <= RESPONSE_BURST,
        "{first}"
    );
    net.now += MIN;
    let second: usize = net
        .poll_frames(0)
        .get(&member(2))
        .map_or(0, |f| responses(f).len());
    assert!((1..=5).contains(&second), "{second}");
}

#[test]
fn notices_hold_at_most_128_entries() {
    let mut net = Net::new(3, 1);
    neighbors_of(&mut net, 0, &[1, 2]);
    for i in 0..300u16 {
        let mut r = [0u8; 16];
        r[..2].copy_from_slice(&i.to_be_bytes());
        let e = MessageEvent::create(
            &net.root,
            EventId::new(T0, r),
            &[],
            net.event(T0, 1, &[], 1).payload().clone(),
        )
        .unwrap();
        // Distinct messages so that none supersedes another.
        let e = MessageEvent::create(&net.root, e.event_id(), &[], {
            let mut p = match e.payload().clone() {
                Payload::Content(c) => c,
                _ => unreachable!(),
            };
            p.sync_obj_id = SyncObjId::from_bytes([
                r[0], r[1], 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
                0, 0, 0, 0, 0, 1,
            ]);
            Payload::Content(p)
        })
        .unwrap();
        net.give(0, 1, &e);
    }
    let sent = net.poll_frames(0);
    let sizes: Vec<usize> = sent[&member(2)]
        .iter()
        .filter_map(|f| match f {
            Frame::Notice(n) => Some(n.entries.len()),
            _ => None,
        })
        .collect();
    assert_eq!(sizes.iter().sum::<usize>(), 300);
    assert!(sizes.iter().all(|n| *n <= 128));
}

#[test]
fn queries_hold_at_most_16_entries_and_one_ttl() {
    let mut net = Net::new(3, 1);
    let chat = net.chat();
    let id = |i: u8, j: u8| EventId::new(T0, [i, j, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3]);
    // One task reaches stage 1 first.
    net.recv_frames(0, member(2), &[notice(chat, &[id(0, 0)])]);
    let s = sent_lookups(&mut net, 0);
    net.now = s[0].sent_at + 64_000;
    net.tick(0);
    net.recv_frames(
        0,
        member(1),
        &[notice(
            chat,
            &(1..16u8).map(|j| id(1, j)).collect::<Vec<_>>(),
        )],
    );
    let qs: Vec<(RequestId, u64, u64, Vec<QueryOp>)> = net
        .poll_frames(0)
        .remove(&member(1))
        .map(|f| queries(&f))
        .unwrap_or_default();
    let lookups: Vec<&(RequestId, u64, u64, Vec<QueryOp>)> = qs
        .iter()
        .filter(|q| matches!(q.3[0], QueryOp::Event { .. }))
        .collect();
    assert_eq!(lookups.len(), 2, "one query per TTL");
    assert!(lookups.iter().all(|q| q.3.len() <= 16));
    let ttls: BTreeSet<u64> = lookups.iter().map(|q| q.2).collect();
    assert_eq!(ttls.len(), 2);
}

#[test]
fn work_stays_queued_until_its_plaintext_is_handed_off() {
    let mut net = Net::new(2, 1);
    neighbors_of(&mut net, 0, &[1]);
    let e = net.publish(0, "hi");
    let now = net.now;
    let dev = &mut net.devs[0];
    let out = dev
        .node
        .poll_outbox(&mut dev.store, now, &mut net.rng)
        .unwrap();
    assert_eq!(out.len(), 1);
    // In flight: not assembled twice.
    assert!(
        dev.node
            .poll_outbox(&mut dev.store, now, &mut net.rng)
            .unwrap()
            .is_empty()
    );
    // A crash before the handoff: the work is assembled again.
    let mut node = Node::open(&dev.store, member(0)).unwrap();
    node.install_epoch(&mut dev.store, config(&net.root), false, now, &mut net.rng)
        .unwrap();
    let again = node.poll_outbox(&mut dev.store, now, &mut net.rng).unwrap();
    assert_eq!(again.len(), 1);
    assert_eq!(
        full_events(&frames(&again[0].plaintext)),
        vec![e.event_id()]
    );
    node.handed_off(&mut dev.store, again[0].handle, now, &mut net.rng)
        .unwrap();
    assert!(
        node.poll_outbox(&mut dev.store, now, &mut net.rng)
            .unwrap()
            .is_empty()
    );
    assert_eq!(node.queued(), 0);
    // Abandoning puts the work back.
    let e2 = {
        let chat = net.root.chat_id();
        node.publish_message(
            &mut dev.store,
            chat,
            Body::Text("2".into()),
            BTreeMap::new(),
            None,
            now,
            &mut net.rng,
        )
        .unwrap()
        .event
    };
    let out = node.poll_outbox(&mut dev.store, now, &mut net.rng).unwrap();
    node.abandon(out[0].handle);
    let out = node.poll_outbox(&mut dev.store, now, &mut net.rng).unwrap();
    assert_eq!(full_events(&frames(&out[0].plaintext)), vec![e2.event_id()]);
    assert_eq!(
        node.handed_off(&mut dev.store, 9999, now, &mut net.rng),
        Err(NodeError::UnknownHandle)
    );
}

#[test]
fn a_query_gets_its_correlation_reference_and_local_wait_at_handoff() {
    let mut net = Net::new(3, 1);
    let chat = net.chat();
    net.recv_frames(0, member(1), &[notice(chat, &[EventId::new(T0, [5; 16])])]);
    let now = net.now;
    let dev = &mut net.devs[0];
    let out = dev
        .node
        .poll_outbox(&mut dev.store, now, &mut net.rng)
        .unwrap();
    assert_eq!(dev.node.t.requests.len(), 0);
    // An answer before the handoff cannot be correlated.
    dev.node
        .handed_off(&mut dev.store, out[0].handle, now, &mut net.rng)
        .unwrap();
    assert_eq!(dev.node.t.requests.len(), 1);
    let key = TaskKey {
        chat_id: chat,
        target: Target::Event(EventId::new(T0, [5; 16])),
    };
    assert!(matches!(
        dev.node.t.tasks.get(&key).unwrap().run,
        crate::node::records::Run::Active {
            attempt: Some(crate::node::records::Attempt::Sent { .. }),
            ..
        }
    ));
}

#[test]
fn the_device_ceiling_rotates_across_peers() {
    let mut net = Net::new(80, 1);
    let chat = net.chat();
    for p in 1..80 {
        net.recv_frames(
            0,
            member(p),
            &[Frame::NeighborRequest(NeighborRequest { chat_id: chat })],
        );
    }
    let now = net.now;
    let dev = &mut net.devs[0];
    let first = dev
        .node
        .poll_outbox(&mut dev.store, now, &mut net.rng)
        .unwrap();
    assert_eq!(first.len(), crate::node::timing::PLAINTEXTS_PER_POLL);
    let second = dev
        .node
        .poll_outbox(&mut dev.store, now, &mut net.rng)
        .unwrap();
    let a: BTreeSet<GossipId> = first.iter().map(|o| o.to).collect();
    let b: BTreeSet<GossipId> = second.iter().map(|o| o.to).collect();
    assert_eq!(a.len() + b.len(), 79);
    assert!(a.is_disjoint(&b));
}

#[test]
fn a_plaintext_in_flight_becomes_stale_when_its_event_is_pruned() {
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
    assert!(dev.node.is_current(out[0].handle));
    dev.node
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
    assert!(!dev.node.is_current(out[0].handle));
    // Abandoned, it is not assembled again: its work was invalidated with the prune.
    dev.node.abandon(out[0].handle);
    let again = dev
        .node
        .poll_outbox(&mut dev.store, now + 1, &mut net.rng)
        .unwrap();
    assert!(
        again
            .iter()
            .all(|o| !full_events(&frames(&o.plaintext)).contains(&e.event_id()))
    );
}
