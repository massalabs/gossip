//! Regression tests of bugs found by the network simulation.

use super::*;
use crate::test_support::Instrumented;

/// Found by the network simulation (code at `6360f87a`, seed 0): a failed commit reloaded
/// the engine from storage and forgot the plaintexts in flight, so confirming one of them
/// afterwards failed with `UnknownHandle`, although the plaintext had been handed to the
/// transport.
#[test]
fn a_failed_commit_keeps_the_plaintexts_in_flight() {
    let root = epoch_root(3, 0x10);
    let chat = root.chat_id();
    let mut store = Instrumented::new(MemoryStorage::new());
    let mut rng = TestRng::new(3);
    let mut node = Node::open(&store, member(0)).unwrap();
    node.install_epoch(&mut store, config(&root), false, T0, &mut rng)
        .unwrap();
    node.publish_message(
        &mut store,
        chat,
        Body::Text("x".into()),
        BTreeMap::new(),
        None,
        T0,
        &mut rng,
    )
    .unwrap();
    let out = node.poll_outbox(&mut store, T0, &mut rng).unwrap();
    assert!(!out.is_empty());
    store.fail_commits = true;
    assert!(
        node.handed_off(&mut store, out[0].handle, T0, &mut rng)
            .is_err()
    );
    store.fail_commits = false;
    node.handed_off(&mut store, out[0].handle, T0, &mut rng)
        .unwrap();
}

/// Found by the network simulation (code at `4b327404`, seed 2): an operation other than
/// `tick` or a receipt served a scheduled deletion in its scheduled form after its due time,
/// because only those two applied what was due. §7.4: before relevant message access, the
/// device applies all due deletions.
#[test]
fn a_due_deletion_is_applied_before_it_is_served() {
    let mut net = Net::new(3, 1);
    let chat = net.chat();
    let m = net.event(T0, 5, &[], 1);
    net.give(0, 1, &m);
    let due = T0 + 10 * MIN;
    let d = MessageEvent::create(
        &net.root,
        EventId::new(T0, [6; 16]),
        &[],
        Payload::Delete {
            sync_obj_id: SyncObjId::from_bytes([5; 32]),
            scheduled_at: Some(due),
        },
    )
    .unwrap();
    net.give(0, 1, &d);
    net.poll(0);
    net.now = due + MIN;
    net.recv_frames(
        0,
        member(2),
        &[query(
            1,
            net.now,
            MIN,
            vec![QueryOp::Event {
                chat_id: chat,
                event_id: d.event_id(),
            }],
        )],
    );
    let r = responses(&net.poll_frames(0)[&member(2)]);
    let served = answer_event(&r[0]).unwrap();
    assert_eq!(
        served.payload(),
        &Payload::Delete {
            sync_obj_id: SyncObjId::from_bytes([5; 32]),
            scheduled_at: None,
        },
        "served in its scheduled form after its time"
    );
    crate::epoch::check_invariants(&net.devs[0].store, &chat, net.now).unwrap();
}

/// Found by the network simulation (code at `efe4edd8`, seed 2): a periodic lane whose
/// scan went to a member that never answers stayed pending for its 20 stages (about two
/// weeks), and every other lane waited behind it, so periodic recovery stopped.
#[test]
fn a_lane_pending_with_a_silent_member_does_not_stop_the_other_lanes() {
    use crate::wire::Page;
    let mut net = Net::new(4, 1);
    let chat = net.chat();
    super::dissemination::neighbors_of(&mut net, 0, &[1, 2]);
    // Member 3, the only non-neighbor, never answers: every random lane scans it.
    let mut neighbor_scans = Vec::new();
    for _ in 0..(4 * 24 * 6) {
        net.tick(0);
        for s in super::retrieval::sent_queries(&mut net, 0) {
            if let QueryOp::TipsScan {
                scan_id, offset, ..
            } = s.op
                && s.to != member(3)
            {
                if offset == 0 {
                    neighbor_scans.push(net.now);
                }
                let page = Page {
                    scan_id,
                    offset,
                    count: 0,
                    entries: vec![],
                    skipped: 0,
                };
                super::retrieval::answer(&mut net, 0, &s, ResponseResult::Page(page));
            }
        }
        net.now += 10 * MIN;
    }
    let late = neighbor_scans.iter().filter(|t| **t > T0 + 2 * DAY).count();
    assert!(
        late >= 2,
        "neighbor lanes after two days: {neighbor_scans:?}"
    );
    let _ = chat;
}

/// Found by the network simulation (code at `91539263`, seed 2): when the best candidate of
/// a task already had 16 lookups outstanding the task waited for it, so a member announcing
/// many IDs it never serves held back every task it announced, real events included, while
/// other members could have supplied them.
#[test]
fn a_task_does_not_wait_for_a_candidate_at_its_lookup_limit() {
    let mut net = Net::new(4, 1);
    let chat = net.chat();
    let fake: Vec<EventId> = (0..16u8)
        .map(|i| EventId::new(T0, [i, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9]))
        .collect();
    net.recv_frames(0, member(1), &[notice(chat, &fake)]);
    assert_eq!(super::retrieval::sent_lookups(&mut net, 0).len(), 16);
    // Member 1 also announces a real event; it is at its limit, so another member is
    // asked at once.
    let real = EventId::new(T0, [5; 16]);
    net.recv_frames(0, member(1), &[notice(chat, &[real])]);
    let q = super::retrieval::sent_lookups(&mut net, 0);
    assert_eq!(q.len(), 1);
    assert_ne!(q[0].to, member(1));
}

/// Found by the network simulation (code at `341c83d9`, seed 24): a neighbor was replaced
/// after three timeouts in a row, which a member offline for an hour reaches with the first
/// TTLs, so with devices rarely online together every group lost all its neighbors. §10.1:
/// an occasional delayed answer is not a failure.
#[test]
fn a_neighbor_that_answers_hours_late_is_kept() {
    let mut net = Net::new(3, 1);
    let chat = net.chat();
    super::dissemination::neighbors_of(&mut net, 0, &[1, 2]);
    for i in 0..3u8 {
        net.recv_frames(0, member(1), &[notice(chat, &[EventId::new(T0, [i; 16])])]);
        super::retrieval::sent_lookups(&mut net, 0);
        net.now += 2 * MIN;
        net.tick(0);
        super::retrieval::sent_lookups(&mut net, 0);
    }
    assert!(net.devs[0].node.is_neighbor(&chat, &member(1)));
}

/// Found by the network simulation (code at `341c83d9`, seed 24): `busy` marked the peer as
/// failed for the whole run, so a task never asked it again although it held the event and
/// only had no budget left at that moment. `busy` means "retry later" (§13.4).
#[test]
fn a_busy_candidate_is_asked_again_later_in_the_same_run() {
    let mut net = Net::new(3, 1);
    let chat = net.chat();
    let e = net.event(T0, 5, &[], 1);
    net.recv_frames(0, member(1), &[notice(chat, &[e.event_id()])]);
    let q = super::retrieval::sent_lookups(&mut net, 0);
    super::retrieval::answer(&mut net, 0, &q[0], ResponseResult::Status(Status::Busy));
    let q = super::retrieval::sent_lookups(&mut net, 0);
    assert_eq!(q[0].to, member(2));
    super::retrieval::answer(
        &mut net,
        0,
        &q[0],
        ResponseResult::Status(Status::NotAvailable),
    );
    net.now += HOUR;
    net.tick(0);
    let q = super::retrieval::sent_lookups(&mut net, 0);
    assert_eq!(q.len(), 1, "member 1 is asked again");
    assert_eq!(q[0].to, member(1));
}

/// Found by the network simulation (code at `1ca7da19`, seed 2140): resends after `expired`
/// were limited to two per stage, so a member that came back online after a long absence
/// and acknowledged old requests as expired was not asked again until the stage timed out,
/// a day later with long TTLs.
#[test]
fn an_expired_acknowledgement_of_an_old_request_is_always_resent() {
    let mut net = Net::new(3, 1);
    let chat = net.chat();
    let id = EventId::new(T0, [5; 16]);
    net.recv_frames(0, member(1), &[notice(chat, &[id])]);
    let mut q = super::retrieval::sent_lookups(&mut net, 0);
    for round in 0..4 {
        // The member was offline and sees each request two minutes later: plausibly
        // expired (past its deadline less 5 minutes of clock skew). No tick runs, so the
        // stage does not time out meanwhile.
        net.now += 2 * MIN;
        super::retrieval::answer(&mut net, 0, &q[0], ResponseResult::Status(Status::Expired));
        q = super::retrieval::sent_lookups(&mut net, 0);
        assert_eq!(q.len(), 1, "resend {round}");
        assert_eq!(q[0].to, member(1));
    }
}

/// Found by the network simulation (code at `7dd64c7d`, seed 2140): lookups of IDs that a
/// member announced and then said it did not have took every slot of the honest members
/// for long TTLs, so a real event announced by an honest member went to a member that never
/// answers, for a day per stage.
#[test]
fn lookups_of_discredited_announcements_leave_room_for_credible_ones() {
    let mut net = Net::new(5, 1);
    let chat = net.chat();
    let fake: Vec<EventId> = (0..40u8)
        .map(|i| EventId::new(T0, [i, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7]))
        .collect();
    // Member 3 announces 40 IDs and answers "not available" for each.
    net.recv_frames(0, member(3), &[notice(chat, &fake[..20])]);
    net.recv_frames(0, member(3), &[notice(chat, &fake[20..])]);
    for _ in 0..3 {
        for s in super::retrieval::sent_lookups(&mut net, 0) {
            if s.to == member(3) {
                super::retrieval::answer(
                    &mut net,
                    0,
                    &s,
                    ResponseResult::Status(Status::NotAvailable),
                );
            }
        }
    }
    // The honest members 1 and 2 are asked about them and do not answer yet. Member 1 now
    // announces a real event: it is asked at once.
    let real = EventId::new(T0, [5; 16]);
    net.recv_frames(0, member(1), &[notice(chat, &[real])]);
    let q = super::retrieval::sent_lookups(&mut net, 0);
    let to_real: Vec<GossipId> = q
        .iter()
        .filter(|s| matches!(s.op, QueryOp::Event { event_id, .. } if event_id == real))
        .map(|s| s.to)
        .collect();
    assert_eq!(to_real, vec![member(1)]);
}

/// Found by the network simulation (code at `9c0392a3`, seed 2008): after `busy`, the peer
/// was skipped for one local wait of the current stage, up to a day once the TTL has grown,
/// so the task went to a member that never answers for that long, although the busy member
/// had room again a minute later.
#[test]
fn a_busy_peer_is_asked_again_a_minute_later_whatever_the_stage() {
    let mut net = Net::new(5, 1);
    let chat = net.chat();
    let id = EventId::new(T0 + 30 * DAY, [5; 16]);
    net.recv_frames(0, member(1), &[notice(chat, &[id])]);
    // Stages time out until the announcer, member 1, is asked with a TTL over five hours.
    let mut q = super::retrieval::sent_lookups(&mut net, 0);
    for _ in 0..40 {
        if q[0].to == member(1) && q[0].ttl > 5 * HOUR {
            break;
        }
        net.now = q[0].sent_at + q[0].ttl * 106 / 100;
        net.tick(0);
        q = super::retrieval::sent_lookups(&mut net, 0);
        while q.is_empty() {
            net.now += MIN;
            net.tick(0);
            q = super::retrieval::sent_lookups(&mut net, 0);
        }
    }
    assert!(q[0].to == member(1) && q[0].ttl > 5 * HOUR);
    super::retrieval::answer(&mut net, 0, &q[0], ResponseResult::Status(Status::Busy));
    // Every other member says it does not have the event.
    loop {
        let q = super::retrieval::sent_lookups(&mut net, 0);
        let Some(s) = q.first() else { break };
        assert_ne!(s.to, member(1));
        super::retrieval::answer(&mut net, 0, s, ResponseResult::Status(Status::NotAvailable));
    }
    net.now += 2 * MIN;
    net.tick(0);
    let q = super::retrieval::sent_lookups(&mut net, 0);
    assert_eq!(q.len(), 1);
    assert_eq!(q[0].to, member(1));
}

/// Found by the network simulation (code at `85ba8ff9`, seed 2008): when the responsive
/// members had 16 lookups outstanding each, a task went to the only member with room, one
/// that had not answered anything for a long time, and stayed there for a stage of up to a
/// day, so a member back online could not supply the event meanwhile.
#[test]
fn a_task_waits_for_a_responsive_member_rather_than_asking_an_unresponsive_one() {
    let mut net = Net::new(4, 1);
    let chat = net.chat();
    for t in 0..3 {
        net.devs[0].node.note_timeout(&member(3), T0 + t);
    }
    let ids = |p: u8| -> Vec<EventId> {
        (0..16u8)
            .map(|i| EventId::new(T0, [p, i, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8]))
            .collect()
    };
    net.recv_frames(0, member(1), &[notice(chat, &ids(1))]);
    net.recv_frames(0, member(2), &[notice(chat, &ids(2))]);
    let q = super::retrieval::sent_lookups(&mut net, 0);
    assert_eq!(q.len(), 32);
    net.recv_frames(0, member(1), &[notice(chat, &[EventId::new(T0, [9; 16])])]);
    let q = super::retrieval::sent_lookups(&mut net, 0);
    assert!(q.iter().all(|s| s.to != member(3)), "{q:?}");
}

/// Found by the network simulation (code at `bb6f2bf2`, seed 2118): a task whose honest
/// announcer had been asked twice while offline counted as suspect, so it queued behind
/// thousands of IDs flooded by a hostile member for the quarter of the slots left to them.
#[test]
fn a_task_announced_by_a_responsive_member_stays_credible_after_two_attempts() {
    let mut net = Net::new(4, 1);
    let chat = net.chat();
    let id = EventId::new(T0 + 30 * DAY, [5; 16]);
    net.recv_frames(0, member(1), &[notice(chat, &[id])]);
    for _ in 0..2 {
        let q = super::retrieval::sent_lookups(&mut net, 0);
        assert!(!q.is_empty());
        net.now = q[0].sent_at + q[0].ttl * 106 / 100 + 10 * MIN;
        net.tick(0);
    }
    // Member 1 answers something else: it is responsive again.
    net.devs[0].node.answered(&member(1));
    let key = TaskKey {
        chat_id: chat,
        target: Target::Event(id),
    };
    assert!(net.devs[0].node.priority(&key) >= crate::node::index::CREDIBLE);
}

/// Found by the network simulation (code at `32561cec`, seed 2168): a resend after a
/// reconnection restarted the local wait of the stage, so a member that never answers but
/// whose session reset more often than the stage's TTL held a task forever, and the members
/// that had announced the event were never asked. §11.4: such resends do not change the
/// stage.
#[test]
fn a_reconnection_resend_does_not_extend_the_stage() {
    let mut net = Net::new(3, 1);
    let chat = net.chat();
    let id = EventId::new(T0, [5; 16]);
    net.recv_frames(0, member(1), &[notice(chat, &[id])]);
    let q = super::retrieval::sent_lookups(&mut net, 0);
    assert_eq!(q[0].to, member(1));
    // Member 1 never answers; its session resets every half TTL.
    let mut asked = Vec::new();
    for _ in 0..6 {
        net.now += q[0].ttl / 2;
        let now = net.now;
        let dev = &mut net.devs[0];
        dev.node
            .peer_reconnected(&mut dev.store, member(1), now, &mut net.rng)
            .unwrap();
        net.tick(0);
        asked.extend(
            super::retrieval::sent_lookups(&mut net, 0)
                .iter()
                .map(|s| s.to),
        );
    }
    assert!(asked.contains(&member(2)), "{asked:?}");
}
