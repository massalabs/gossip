//! §11: retrieval tasks, candidates, stages and TTLs, answers, pauses, deadlines.

use super::dissemination::neighbors_of;
use super::*;
use crate::constants::RETENTION_MS;
use crate::node::records::Run;
use crate::node::timing::{
    ACTIVE_LOOKUPS_PER_DEVICE, ACTIVE_LOOKUPS_PER_PEER, FIRST_TTL_MS, MAX_UNANSWERED_STAGES,
    next_ttl,
};

/// One query entry sent by device `d`.
#[derive(Debug, Clone)]
pub(crate) struct Sent {
    pub to: GossipId,
    pub rid: RequestId,
    pub sent_at: u64,
    pub ttl: u64,
    pub idx: u32,
    pub op: QueryOp,
}

/// Every query entry device `d` sends now.
pub(crate) fn sent_queries(net: &mut Net, d: usize) -> Vec<Sent> {
    let mut out = Vec::new();
    for (to, frames) in net.poll_frames(d) {
        for (rid, sent_at, ttl, ops) in queries(&frames) {
            for (idx, op) in ops.into_iter().enumerate() {
                out.push(Sent {
                    to,
                    rid,
                    sent_at,
                    ttl,
                    idx: idx as u32,
                    op,
                });
            }
        }
    }
    out
}

/// The lookup entries (event and sync-object) device `d` sends now.
pub(crate) fn sent_lookups(net: &mut Net, d: usize) -> Vec<Sent> {
    sent_queries(net, d)
        .into_iter()
        .filter(|s| matches!(s.op, QueryOp::Event { .. } | QueryOp::SyncObj { .. }))
        .collect()
}

/// Member `s.to` answers `s` with `result`.
pub(crate) fn answer(net: &mut Net, d: usize, s: &Sent, result: ResponseResult) {
    net.recv_frames(
        d,
        s.to,
        &[Frame::Response(Response {
            request_id: Some(s.rid),
            idx: s.idx,
            result,
        })],
    );
}

fn na() -> ResponseResult {
    ResponseResult::Status(Status::NotAvailable)
}

fn index(m: &GossipId) -> usize {
    (0..64).find(|i| member(*i) == *m).unwrap()
}

#[test]
fn a_notice_of_an_unknown_event_asks_the_announcer_first_and_only_it() {
    let mut net = Net::new(5, 1);
    let chat = net.chat();
    neighbors_of(&mut net, 0, &[1, 2]);
    let id = EventId::new(T0, [5; 16]);
    net.recv_frames(0, member(3), &[notice(chat, &[id])]);
    let q = sent_queries(&mut net, 0);
    assert_eq!(q.len(), 1);
    assert_eq!(q[0].to, member(3));
    assert_eq!(q[0].ttl, FIRST_TTL_MS);
    assert_eq!(q[0].sent_at, T0);
    assert!(matches!(q[0].op, QueryOp::Event { event_id, .. } if event_id == id));
}

#[test]
fn candidates_go_announcer_then_neighbors_by_score_then_other_members() {
    let mut net = Net::new(5, 1);
    let chat = net.chat();
    neighbors_of(&mut net, 0, &[1, 2]);
    for _ in 0..5 {
        net.devs[0].node.reward(&member(2));
    }
    let id = EventId::new(T0, [5; 16]);
    net.recv_frames(0, member(4), &[notice(chat, &[id])]);
    let mut order = Vec::new();
    loop {
        let q = sent_queries(&mut net, 0);
        if q.is_empty() {
            break;
        }
        assert_eq!(q.len(), 1, "one peer at a time");
        order.push(index(&q[0].to));
        // Not available: the next candidate is tried at once, at the first TTL again.
        assert_eq!(q[0].ttl, FIRST_TTL_MS);
        answer(&mut net, 0, &q[0], na());
    }
    assert_eq!(order, vec![4, 2, 1, 3]);
    let key = TaskKey {
        chat_id: chat,
        target: Target::Event(id),
    };
    assert_eq!(net.devs[0].node.t.tasks.get(&key).unwrap().run, Run::Paused);
}

#[test]
fn a_member_with_a_session_comes_before_one_without() {
    let mut net = Net::new(4, 1);
    let chat = net.chat();
    net.devs[0].node.set_session(member(3), true);
    let id = EventId::new(T0, [5; 16]);
    net.devs[0].node.reward(&member(1));
    // No trigger: a sync-object lookup.
    let now = net.now;
    let dev = &mut net.devs[0];
    dev.node
        .lookup_sync_object(
            &mut dev.store,
            chat,
            SyncObjId::from_bytes([1; 32]),
            now,
            &mut net.rng,
        )
        .unwrap();
    let q = sent_queries(&mut net, 0);
    assert_eq!(q[0].to, member(3));
    let _ = id;
}

#[test]
fn unanswered_stages_grow_the_ttl_by_pi_with_local_jitter_then_pause_after_twenty() {
    let mut net = Net::new(5, 1);
    let chat = net.chat();
    // Twenty stages last about 14.6 days, longer than the deadline of any event task (one
    // retention period): a sync-object lookup, which has no deadline, runs them all.
    let sync = SyncObjId::from_bytes([5; 32]);
    let now = net.now;
    let dev = &mut net.devs[0];
    dev.node
        .lookup_sync_object(&mut dev.store, chat, sync, now, &mut net.rng)
        .unwrap();
    let mut ttl = FIRST_TTL_MS;
    let mut stages = 0;
    loop {
        let q = sent_lookups(&mut net, 0);
        if q.is_empty() {
            break;
        }
        assert_eq!(q.len(), 1);
        assert_eq!(q[0].ttl, ttl, "stage {stages}");
        stages += 1;
        // Not before 0.95 × ttl, at the latest at 1.05 × ttl.
        net.now = q[0].sent_at + ttl * 95 / 100 - 1;
        net.tick(0);
        assert!(sent_lookups(&mut net, 0).is_empty());
        net.now = q[0].sent_at + ttl * 105 / 100;
        net.tick(0);
        ttl = next_ttl(ttl);
        if stages > 25 {
            panic!("never paused");
        }
    }
    assert_eq!(stages, usize::from(MAX_UNANSWERED_STAGES));
    assert_eq!(
        net.devs[0].node.take_lookup_results(),
        vec![(chat, sync, LookupResult::NotFound)]
    );
}

#[test]
fn not_available_from_an_announcer_is_penalised_but_not_from_others() {
    let mut net = Net::new(4, 1);
    let chat = net.chat();
    let id = EventId::new(T0, [5; 16]);
    net.recv_frames(0, member(1), &[notice(chat, &[id])]);
    let q = sent_queries(&mut net, 0);
    answer(&mut net, 0, &q[0], na());
    let q2 = sent_queries(&mut net, 0);
    assert_ne!(q2[0].to, member(1));
    answer(&mut net, 0, &q2[0], na());
    let node = &net.devs[0].node;
    assert!(node.score(&member(1)) < 500_000);
    assert_eq!(node.score(&q2[0].to), 500_000);
}

#[test]
fn an_invalid_answer_is_penalised_and_the_next_candidate_asked_at_the_same_stage() {
    let mut net = Net::new(5, 1);
    let chat = net.chat();
    let wanted = net.event(T0, 5, &[], 1);
    let other = net.event(T0, 6, &[], 1);
    net.recv_frames(0, member(1), &[notice(chat, &[wanted.event_id()])]);
    let q = sent_queries(&mut net, 0);
    // Stage 0 times out; stage 1 goes to another peer with the next TTL.
    net.now = q[0].sent_at + 2 * MIN;
    net.tick(0);
    let q1 = sent_queries(&mut net, 0);
    assert_eq!(q1[0].ttl, next_ttl(FIRST_TTL_MS));
    // A wrong event: invalid.
    answer(&mut net, 0, &q1[0], ResponseResult::Event(blob(&other)));
    assert!(
        !net.known(0, &other.event_id()),
        "a wrong item is not received"
    );
    let q2 = sent_queries(&mut net, 0);
    assert_eq!(q2.len(), 1);
    assert_ne!(q2[0].to, q1[0].to);
    assert_eq!(q2[0].ttl, q1[0].ttl, "the stage does not advance");
    assert!(net.devs[0].node.score(&q1[0].to) < 500_000);
    // The right event resolves the task and raises the supplier's score.
    answer(&mut net, 0, &q2[0], ResponseResult::Event(blob(&wanted)));
    assert!(net.held(0, &wanted.event_id()));
    assert!(net.devs[0].node.t.tasks.len() == 0);
    assert!(net.devs[0].node.score(&q2[0].to) > 500_000);
}

#[test]
fn expired_triggers_an_immediate_bounded_resend_without_changing_the_stage() {
    let mut net = Net::new(4, 1);
    let chat = net.chat();
    let id = EventId::new(T0, [5; 16]);
    net.recv_frames(0, member(1), &[notice(chat, &[id])]);
    let q = sent_queries(&mut net, 0);
    net.now += 1_000;
    answer(&mut net, 0, &q[0], ResponseResult::Status(Status::Expired));
    let r1 = sent_queries(&mut net, 0);
    assert_eq!(r1.len(), 1);
    assert_eq!(r1[0].to, member(1));
    assert_eq!(r1[0].ttl, q[0].ttl);
    assert_eq!(r1[0].sent_at, net.now, "fresh sent_at");
    assert_ne!(r1[0].rid, q[0].rid, "a fresh request_id");
    answer(&mut net, 0, &r1[0], ResponseResult::Status(Status::Expired));
    let r2 = sent_queries(&mut net, 0);
    answer(&mut net, 0, &r2[0], ResponseResult::Status(Status::Expired));
    assert!(
        sent_queries(&mut net, 0).is_empty(),
        "at most two resends per stage"
    );
}

#[test]
fn a_new_notice_renews_a_paused_task_and_notices_during_a_run_are_coalesced() {
    let mut net = Net::new(3, 1);
    let chat = net.chat();
    let id = EventId::new(T0, [5; 16]);
    net.recv_frames(0, member(1), &[notice(chat, &[id])]);
    let q = sent_queries(&mut net, 0);
    // Coalesced: no second query while the first is outstanding.
    net.recv_frames(0, member(1), &[notice(chat, &[id])]);
    assert!(sent_queries(&mut net, 0).is_empty());
    answer(&mut net, 0, &q[0], na());
    let q = sent_queries(&mut net, 0);
    answer(&mut net, 0, &q[0], na());
    assert!(sent_queries(&mut net, 0).is_empty());
    let key = TaskKey {
        chat_id: chat,
        target: Target::Event(id),
    };
    assert_eq!(net.devs[0].node.t.tasks.get(&key).unwrap().run, Run::Paused);
    // New evidence: a fresh run at the first TTL, asking the new announcer.
    net.now += HOUR;
    net.recv_frames(0, member(2), &[notice(chat, &[id])]);
    let q = sent_queries(&mut net, 0);
    assert_eq!(q.len(), 1);
    assert_eq!((q[0].to, q[0].ttl), (member(2), FIRST_TTL_MS));
    assert_eq!(net.devs[0].node.t.tasks.get(&key).unwrap().runs, 2);
}

#[test]
fn a_task_ends_at_its_lookup_deadline_and_an_expired_id_is_never_requested() {
    let mut net = Net::new(3, 1);
    let chat = net.chat();
    net.now = T0 + RETENTION_MS - MIN;
    let id = EventId::new(T0, [5; 16]);
    net.recv_frames(0, member(1), &[notice(chat, &[id])]);
    assert_eq!(sent_queries(&mut net, 0).len(), 1);
    net.now = T0 + RETENTION_MS;
    net.tick(0);
    assert_eq!(net.devs[0].node.t.tasks.len(), 0);
    assert_eq!(net.devs[0].node.stats.tasks_expired, 1);
    // A notice of an ID past its deadline creates nothing.
    net.recv_frames(
        0,
        member(1),
        &[notice(chat, &[EventId::new(T0 - 1, [6; 16])])],
    );
    assert_eq!(net.devs[0].node.t.tasks.len(), 0);
    // A full event that arrives later is still merged, then pruned at once (§9.5, §8.1).
    let late = net.event(T0, 5, &[], 1);
    net.give(0, 1, &late);
    assert!(net.known(0, &late.event_id()) && !net.held(0, &late.event_id()));
}

#[test]
fn a_pruned_id_is_never_requested_again() {
    let mut net = Net::new(3, 1);
    let chat = net.chat();
    net.now = T0 + 20;
    let new = net.event(T0 + 10, 5, &[], 1);
    net.give(0, 1, &new);
    let old = MessageEvent::create(
        &net.root,
        EventId::new(T0, [6; 16]),
        &[],
        net.event(T0, 5, &[], 1).payload().clone(),
    )
    .unwrap();
    net.give(0, 1, &old);
    assert!(net.known(0, &old.event_id()) && !net.held(0, &old.event_id()));
    net.poll(0);
    net.recv_frames(0, member(2), &[notice(chat, &[old.event_id()])]);
    let child = net.event(T0 + 11, 7, &[old.event_id()], 2);
    net.give(0, 2, &child);
    assert!(sent_queries(&mut net, 0).is_empty());
}

#[test]
fn a_temporarily_invalid_event_is_fetched_again_on_a_later_notice() {
    let mut net = Net::new(3, 1);
    let chat = net.chat();
    let future = net.event(T0 + HOUR, 5, &[], 1);
    net.give(0, 1, &future);
    assert!(net.known(0, &future.event_id()) && !net.held(0, &future.event_id()));
    net.now = T0 + HOUR;
    net.recv_frames(0, member(2), &[notice(chat, &[future.event_id()])]);
    let q = sent_queries(&mut net, 0);
    assert_eq!(q.len(), 1);
    answer(&mut net, 0, &q[0], ResponseResult::Event(blob(&future)));
    assert!(net.held(0, &future.event_id()));
}

#[test]
fn a_temporarily_invalid_answer_pauses_the_task() {
    let mut net = Net::new(3, 1);
    let chat = net.chat();
    let future = net.event(T0 + HOUR, 5, &[], 1);
    net.recv_frames(0, member(1), &[notice(chat, &[future.event_id()])]);
    let q = sent_queries(&mut net, 0);
    answer(&mut net, 0, &q[0], ResponseResult::Event(blob(&future)));
    let key = TaskKey {
        chat_id: chat,
        target: Target::Event(future.event_id()),
    };
    assert_eq!(net.devs[0].node.t.tasks.get(&key).unwrap().run, Run::Paused);
    assert!(sent_queries(&mut net, 0).is_empty());
}

#[test]
fn lookups_outstanding_are_limited_per_peer_and_per_device() {
    let mut net = Net::new(6, 1);
    let chat = net.chat();
    let ids = |p: u8| -> Vec<EventId> {
        (0..20u8)
            .map(|i| EventId::new(T0, [p, i, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]))
            .collect()
    };
    net.recv_frames(0, member(1), &[notice(chat, &ids(1))]);
    let q = sent_queries(&mut net, 0);
    assert_eq!(q.len(), 20);
    let to_1 = q.iter().filter(|s| s.to == member(1)).count();
    assert_eq!(
        to_1, ACTIVE_LOOKUPS_PER_PEER,
        "the rest go to other members"
    );
    for p in 2..=5u8 {
        net.recv_frames(0, member(p as usize), &[notice(chat, &ids(p))]);
    }
    let more = sent_queries(&mut net, 0);
    assert_eq!(q.len() + more.len(), ACTIVE_LOOKUPS_PER_DEVICE);
}

#[test]
fn missing_parents_are_requested_from_the_peer_that_delivered_the_child() {
    let mut net = Net::new(4, 1);
    let p1 = net.event(T0, 5, &[], 1);
    let p2 = net.event(T0, 6, &[], 1);
    let child = net.event(T0 + 1, 7, &[p1.event_id(), p2.event_id()], 1);
    net.give(0, 2, &child);
    let q = sent_queries(&mut net, 0);
    assert_eq!(q.len(), 2);
    assert!(q.iter().all(|s| s.to == member(2)));
    for s in &q {
        let e = if matches!(s.op, QueryOp::Event { event_id, .. } if event_id == p1.event_id()) {
            &p1
        } else {
            &p2
        };
        answer(&mut net, 0, s, ResponseResult::Event(blob(e)));
    }
    assert!(net.held(0, &p1.event_id()) && net.held(0, &p2.event_id()));
}

#[test]
fn a_late_answer_after_a_local_timeout_is_still_processed() {
    let mut net = Net::new(4, 1);
    let chat = net.chat();
    let e = net.event(T0, 5, &[], 1);
    net.recv_frames(0, member(1), &[notice(chat, &[e.event_id()])]);
    let q = sent_queries(&mut net, 0);
    net.now = q[0].sent_at + 63_001;
    net.tick(0);
    let q2 = sent_queries(&mut net, 0);
    assert_ne!(q2[0].to, member(1));
    answer(&mut net, 0, &q[0], ResponseResult::Event(blob(&e)));
    assert!(net.held(0, &e.event_id()));
    assert_eq!(net.devs[0].node.t.tasks.len(), 0);
}

#[test]
fn an_uncorrelated_response_is_dropped() {
    let mut net = Net::new(3, 1);
    let e = net.event(T0, 5, &[], 1);
    net.recv_frames(
        0,
        member(1),
        &[Frame::Response(Response {
            request_id: Some(RequestId::from_bytes([9; 16])),
            idx: 0,
            result: ResponseResult::Event(blob(&e)),
        })],
    );
    assert!(!net.known(0, &e.event_id()));
}

#[test]
fn busy_moves_on_at_once_without_a_penalty() {
    let mut net = Net::new(3, 1);
    let chat = net.chat();
    let id = EventId::new(T0, [5; 16]);
    net.recv_frames(0, member(1), &[notice(chat, &[id])]);
    let q = sent_queries(&mut net, 0);
    answer(&mut net, 0, &q[0], ResponseResult::Status(Status::Busy));
    let q2 = sent_queries(&mut net, 0);
    assert_eq!(q2[0].to, member(2));
    assert_eq!(net.devs[0].node.score(&member(1)), 500_000);
}

#[test]
fn only_the_first_answer_of_a_wire_entry_counts() {
    let mut net = Net::new(4, 1);
    let chat = net.chat();
    let id = EventId::new(T0, [5; 16]);
    net.recv_frames(0, member(1), &[notice(chat, &[id])]);
    let q = sent_queries(&mut net, 0);
    answer(&mut net, 0, &q[0], na());
    let penalty = net.devs[0].node.t.peers.get(&member(1)).unwrap().penalty;
    answer(&mut net, 0, &q[0], na());
    assert_eq!(
        net.devs[0].node.t.peers.get(&member(1)).unwrap().penalty,
        penalty
    );
}

#[test]
fn a_sync_object_lookup_completes_with_the_carrier_or_not_found() {
    let mut net = Net::new(3, 1);
    let chat = net.chat();
    let e = net.event(T0, 5, &[], 1);
    let now = net.now;
    let dev = &mut net.devs[0];
    dev.node
        .lookup_sync_object(
            &mut dev.store,
            chat,
            SyncObjId::from_bytes([5; 32]),
            now,
            &mut net.rng,
        )
        .unwrap();
    // A second caller shares the operation.
    dev.node
        .lookup_sync_object(
            &mut dev.store,
            chat,
            SyncObjId::from_bytes([5; 32]),
            now,
            &mut net.rng,
        )
        .unwrap();
    let q = sent_queries(&mut net, 0);
    assert_eq!(q.len(), 1);
    // An event of another message is an invalid answer.
    let wrong = net.event(T0, 6, &[], 1);
    answer(&mut net, 0, &q[0], ResponseResult::Event(blob(&wrong)));
    let q = sent_queries(&mut net, 0);
    answer(&mut net, 0, &q[0], ResponseResult::Event(blob(&e)));
    assert!(net.held(0, &e.event_id()));
    assert_eq!(
        net.devs[0].node.take_lookup_results(),
        vec![(
            chat,
            SyncObjId::from_bytes([5; 32]),
            LookupResult::Found(e.event_id())
        )]
    );
    // Nobody has message 7.
    let dev = &mut net.devs[0];
    dev.node
        .lookup_sync_object(
            &mut dev.store,
            chat,
            SyncObjId::from_bytes([7; 32]),
            now,
            &mut net.rng,
        )
        .unwrap();
    for _ in 0..2 {
        let q = sent_queries(&mut net, 0);
        answer(&mut net, 0, &q[0], na());
    }
    assert_eq!(
        net.devs[0].node.take_lookup_results(),
        vec![(chat, SyncObjId::from_bytes([7; 32]), LookupResult::NotFound)]
    );
}

#[test]
fn a_reconnection_resends_outstanding_queries_and_renews_paused_tasks() {
    let mut net = Net::new(3, 1);
    let chat = net.chat();
    let id = EventId::new(T0, [5; 16]);
    net.recv_frames(0, member(1), &[notice(chat, &[id])]);
    let q = sent_queries(&mut net, 0);
    net.now += 1_000;
    let now = net.now;
    let dev = &mut net.devs[0];
    dev.node
        .peer_reconnected(&mut dev.store, member(1), now, &mut net.rng)
        .unwrap();
    let r = sent_queries(&mut net, 0);
    let lookups: Vec<&Sent> = r
        .iter()
        .filter(|s| matches!(s.op, QueryOp::Event { .. }))
        .collect();
    assert_eq!(lookups.len(), 1);
    assert_eq!(
        (lookups[0].to, lookups[0].ttl, lookups[0].sent_at),
        (member(1), q[0].ttl, now)
    );
    // A scan of the reconnected peer starts as well (§12.3).
    assert!(
        r.iter()
            .any(|s| matches!(s.op, QueryOp::TipsScan { .. }) && s.to == member(1))
    );
    // Pause the task, then a reconnection renews it.
    answer(&mut net, 0, lookups[0], na());
    let q = sent_queries(&mut net, 0);
    let q: Vec<&Sent> = q
        .iter()
        .filter(|s| matches!(s.op, QueryOp::Event { .. }))
        .collect();
    answer(&mut net, 0, q[0], na());
    let key = TaskKey {
        chat_id: chat,
        target: Target::Event(id),
    };
    assert_eq!(net.devs[0].node.t.tasks.get(&key).unwrap().run, Run::Paused);
    let dev = &mut net.devs[0];
    // Member 1 answered "not available": its reconnection is no new candidate.
    dev.node
        .peer_reconnected(&mut dev.store, member(1), now, &mut net.rng)
        .unwrap();
    assert_eq!(net.devs[0].node.t.tasks.get(&key).unwrap().run, Run::Paused);
}

#[test]
fn a_malformed_status_fails_the_peer_for_the_run_without_a_penalty() {
    let mut net = Net::new(3, 1);
    let chat = net.chat();
    let id = EventId::new(T0, [5; 16]);
    net.recv_frames(0, member(1), &[notice(chat, &[id])]);
    let q = sent_lookups(&mut net, 0);
    answer(
        &mut net,
        0,
        &q[0],
        ResponseResult::Status(Status::Malformed),
    );
    assert_eq!(net.devs[0].node.score(&member(1)), 500_000);
    let q = sent_lookups(&mut net, 0);
    assert_eq!(q[0].to, member(2));
    answer(&mut net, 0, &q[0], na());
    net.now += HOUR;
    net.tick(0);
    assert!(
        sent_lookups(&mut net, 0).is_empty(),
        "member 1 is not asked again"
    );
}

#[test]
fn bytes_that_do_not_decode_are_an_invalid_answer() {
    let mut net = Net::new(3, 1);
    let chat = net.chat();
    let id = EventId::new(T0, [5; 16]);
    net.recv_frames(0, member(1), &[notice(chat, &[id])]);
    let q = sent_lookups(&mut net, 0);
    answer(
        &mut net,
        0,
        &q[0],
        ResponseResult::Event(vec![1, 0x0a, 0x03, 1, 2, 3]),
    );
    assert!(net.devs[0].node.score(&member(1)) < 500_000);
    assert_eq!(sent_lookups(&mut net, 0)[0].to, member(2));
}
