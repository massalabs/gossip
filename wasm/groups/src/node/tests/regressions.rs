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
    // Member 1 is the only other member, so every stage asks it.
    let mut net = Net::new(2, 1);
    let chat = net.chat();
    let id = EventId::new(T0 + 30 * DAY, [5; 16]);
    net.recv_frames(0, member(1), &[notice(chat, &[id])]);
    for round in 0..4 {
        let mut q = super::retrieval::sent_lookups(&mut net, 0);
        while q.is_empty() {
            net.now += MIN;
            net.tick(0);
            q = super::retrieval::sent_lookups(&mut net, 0);
        }
        assert_eq!(q[0].to, member(1));
        // The member was offline and acknowledges the request as expired after its
        // deadline (less 5 minutes of clock skew): plausible. An honest responder with the
        // same clock sends it only after the deadline. The device handles what it received
        // before it ticks, as on any return, and resends at once.
        net.now = super::super::timing::deadline(q[0].sent_at, q[0].ttl) + 1;
        super::retrieval::answer(&mut net, 0, &q[0], ResponseResult::Status(Status::Expired));
        let r = super::retrieval::sent_lookups(&mut net, 0);
        assert_eq!(r.len(), 1, "resend {round}");
        assert_eq!((r[0].to, r[0].ttl), (member(1), q[0].ttl));
        net.tick(0);
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
    // Member 3 is discredited before it announces 40 IDs (so that how many of them first
    // went to members 1 and 2 does not depend on the random spread), and answers "not
    // available" for each.
    net.devs[0].node.penalize(&member(3), PENALTY_MALFORMED);
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

/// Seen in the network simulation (code at `32561cec`, seed 2168): as for lookups, a
/// reconnection resend of a page request restarted the local wait of the stage, so a scan of
/// a member that never answers but whose session reset more often than the TTL never timed
/// out, and its lanes stayed pending with it.
#[test]
fn a_reconnection_resend_does_not_extend_a_scan_stage() {
    let mut net = Net::new(3, 1);
    let mut ttls = Vec::new();
    for _ in 0..8 {
        let now = net.now;
        let dev = &mut net.devs[0];
        dev.node
            .peer_reconnected(&mut dev.store, member(1), now, &mut net.rng)
            .unwrap();
        net.tick(0);
        for s in super::retrieval::sent_queries(&mut net, 0) {
            if matches!(s.op, QueryOp::TipsScan { .. }) && s.to == member(1) {
                ttls.push(s.ttl);
            }
        }
        net.now += MIN / 2;
    }
    assert!(ttls.iter().any(|t| *t > MIN), "{ttls:?}");
}

/// Found by review (code at `6a916f2e`; the cause of seed 2168 for reconnections): a resend
/// after `expired` restarted the local wait of the stage, for lookups and scans alike.
/// §11.4: such resends do not change the stage.
#[test]
fn an_expired_resend_does_not_extend_the_stage() {
    let mut net = Net::new(3, 1);
    let chat = net.chat();
    let id = EventId::new(T0, [5; 16]);
    net.recv_frames(0, member(1), &[notice(chat, &[id])]);
    let now = net.now;
    let dev = &mut net.devs[0];
    dev.node
        .peer_reconnected(&mut dev.store, member(2), now, &mut net.rng)
        .unwrap();
    let sent = super::retrieval::sent_queries(&mut net, 0);
    let lookup = sent
        .iter()
        .find(|s| matches!(s.op, QueryOp::Event { .. }))
        .unwrap();
    let scan = sent
        .iter()
        .find(|s| matches!(s.op, QueryOp::TipsScan { .. }))
        .unwrap();
    assert_eq!((lookup.to, scan.to), (member(1), member(2)));
    // Both answer `expired` early in the stage, then nothing.
    net.now += 50_000;
    super::retrieval::answer(&mut net, 0, lookup, ResponseResult::Status(Status::Expired));
    super::retrieval::answer(&mut net, 0, scan, ResponseResult::Status(Status::Expired));
    let resent = super::retrieval::sent_queries(&mut net, 0);
    assert_eq!(resent.len(), 2, "{resent:?}");
    net.now += 20_000;
    net.tick(0);
    let next = super::retrieval::sent_queries(&mut net, 0);
    assert!(
        next.iter()
            .any(|s| matches!(s.op, QueryOp::Event { .. }) && s.to == member(2)),
        "the lookup moves on: {next:?}"
    );
    assert!(
        next.iter()
            .any(|s| matches!(s.op, QueryOp::TipsScan { .. }) && s.ttl > MIN),
        "the scan moves to its next stage: {next:?}"
    );
}

/// The largest message event that can be created: its blob fits the admission limit exactly.
fn largest_event(net: &Net) -> MessageEvent {
    let make = |n: usize| {
        MessageEvent::create(
            &net.root,
            EventId::new(T0, [5; 16]),
            &[],
            Payload::Content(Content {
                sync_obj_id: SyncObjId::from_bytes([5; 32]),
                author: member(1),
                created_at: T0,
                last_modified_at: T0,
                body: Body::Media(vec![7; n]),
                edited: false,
                metadata: BTreeMap::new(),
            }),
        )
    };
    let (mut lo, mut hi) = (0, crate::constants::MAX_PLAINTEXT_BYTES);
    while lo + 1 < hi {
        let mid = usize::midpoint(lo, hi);
        if make(mid).is_ok() {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    make(lo).unwrap()
}

/// Found by review (code at `6a916f2e`): an event that fits an empty container as an event
/// frame did not fit as a response frame, which adds `request_id` and `idx`, so assembling
/// the answer to a lookup of it panicked, and again after every restart since the answer
/// work is stored.
#[test]
fn the_largest_event_can_be_served_in_an_answer() {
    let mut net = Net::new(3, 1);
    let chat = net.chat();
    let e = largest_event(&net);
    net.give(0, 1, &e);
    assert!(net.held(0, &e.event_id()));
    net.poll(0);
    net.recv_frames(
        0,
        member(2),
        &[query(
            1,
            net.now,
            MIN,
            vec![QueryOp::Event {
                chat_id: chat,
                event_id: e.event_id(),
            }],
        )],
    );
    let out = net.poll_frames(0);
    let r = responses(&out[&member(2)]);
    assert_eq!(answer_event(&r[0]), Some(e));
}

/// §2.2: `busy` is back-pressure, never a failure (it replaces a rule that counted three
/// `busy` in a row as a timeout: measured, nine `busy` in 192 s made an honest member
/// unresponsive and paused its tasks). A member answering `busy` to everything stays
/// responsive and keeps its score, is never failed for a task, and is asked again after a
/// growing, capped wait, so that it costs bounded work; its scans keep their stage.
#[test]
fn busy_is_back_pressure_never_a_failure() {
    let mut net = Net::new(3, 1);
    let chat = net.chat();
    let id = EventId::new(T0, [5; 16]);
    net.recv_frames(0, member(1), &[notice(chat, &[id])]);
    let now = net.now;
    let dev = &mut net.devs[0];
    dev.node
        .peer_reconnected(&mut dev.store, member(1), now, &mut net.rng)
        .unwrap();
    let score = net.devs[0].node.score(&member(1));
    let mut lookups = 0;
    let mut scan_ttls = Vec::new();
    let mut busy = 0;
    // Seventy minutes.
    for _ in 0..60 {
        for s in super::retrieval::sent_queries(&mut net, 0) {
            if s.to != member(1) {
                continue;
            }
            match s.op {
                QueryOp::Event { .. } => lookups += 1,
                QueryOp::TipsScan { .. } => scan_ttls.push(s.ttl),
                _ => {}
            }
            super::retrieval::answer(&mut net, 0, &s, ResponseResult::Status(Status::Busy));
            busy += 1;
        }
        net.now += 70_000;
        net.tick(0);
    }
    assert!(busy >= 6, "{busy}");
    let node = &net.devs[0].node;
    assert!(node.responsive(&member(1)), "busy is no failure");
    assert_eq!(node.unanswered_ms(&member(1)), 0);
    assert_eq!(node.score(&member(1)), score);
    // Asked after waits of about 1, 2, 4, 8, 16 and 32 minutes: at most seven times.
    assert!((2..=8).contains(&lookups), "asked {lookups} times");
    // The scan never advanced its stage on `busy`.
    assert!(scan_ttls.iter().all(|t| *t == MIN), "{scan_ttls:?}");
    // The lookup is still active, its candidate untried.
    let task = node
        .t
        .tasks
        .iter()
        .find(|(k, _)| k.target == Target::Event(id))
        .map(|(_, t)| t.clone())
        .expect("the task is kept");
    assert_eq!(
        task.candidates.get(&member(1)).map(|c| c.state),
        Some(crate::node::records::CandidateState::Untried)
    );
}

/// §2.2: in a group of two the only candidate answering `busy` is never lost: once it has
/// room again, it supplies the event.
#[test]
fn busy_never_loses_the_only_candidate() {
    let mut net = Net::new(2, 1);
    let chat = net.chat();
    let e = net.event(T0, 5, &[], 1);
    net.recv_frames(0, member(1), &[notice(chat, &[e.event_id()])]);
    let mut answered = 0;
    for _ in 0..600 {
        for s in super::retrieval::sent_queries(&mut net, 0) {
            if !matches!(s.op, QueryOp::Event { .. }) {
                continue;
            }
            if answered < 12 {
                super::retrieval::answer(&mut net, 0, &s, ResponseResult::Status(Status::Busy));
            } else {
                super::retrieval::answer(&mut net, 0, &s, ResponseResult::Event(blob(&e)));
            }
            answered += 1;
        }
        if net.held(0, &e.event_id()) {
            break;
        }
        net.now += MIN;
        net.tick(0);
    }
    assert!(answered > 12);
    assert!(net.held(0, &e.event_id()));
}

/// Found by review (code at `6a916f2e`): the lookup deadline of a task came from its ID's
/// timestamp alone, so a task for an ID dated far in the future never ended, and enough of
/// them filled the queue of missing IDs for good.
#[test]
fn a_task_for_an_id_dated_far_ahead_ends_within_a_retention_period() {
    let mut net = Net::new(3, 1);
    let chat = net.chat();
    let far = EventId::new(T0 + 3_650 * DAY, [5; 16]);
    net.recv_frames(0, member(1), &[notice(chat, &[far])]);
    assert_eq!(net.devs[0].node.task_count().0, 1);
    net.now = T0 + crate::constants::RETENTION_MS + MIN;
    net.tick(0);
    assert_eq!(net.devs[0].node.task_count(), (0, 0));
}

/// Found by review (code at `6a916f2e`): with the queue of missing IDs full, the missing
/// parent of an accepted event was dropped without a trace, even when the queue held only
/// discredited IDs.
#[test]
fn a_full_queue_of_suspect_ids_makes_room_for_a_missing_parent() {
    let mut net = Net::new(4, 1);
    let chat = net.chat();
    // Member 3 is discredited, then floods the queue.
    net.devs[0].node.penalize(&member(3), PENALTY_MALFORMED);
    net.devs[0].node.penalize(&member(3), PENALTY_MALFORMED);
    let full = super::super::timing::QUEUED_MISSING_PER_GROUP;
    for chunk in 0..full / 128 {
        let ids: Vec<EventId> = (0..128u32)
            .map(|i| {
                let n = (chunk * 128) as u32 + i;
                let mut r = [9u8; 16];
                r[..4].copy_from_slice(&n.to_be_bytes());
                EventId::new(T0, r)
            })
            .collect();
        net.recv_frames(0, member(3), &[notice(chat, &ids)]);
    }
    assert_eq!(net.devs[0].node.task_count().0, full);
    // Member 1 delivers an event whose parent is missing.
    let parent = EventId::new(T0, [1; 16]);
    let child = net.event(T0 + 1, 2, &[parent], 1);
    net.give(0, 1, &child);
    assert!(net.held(0, &child.event_id()));
    let key = TaskKey {
        chat_id: chat,
        target: Target::Event(parent),
    };
    assert!(
        net.devs[0].node.t.tasks.get(&key).is_some(),
        "parent dropped"
    );
}

/// Found by review (code at `6a916f2e`): a freed slot of a peer woke the tasks blocked on it
/// in key order, an order the announcer of the IDs chooses, and woke the same ones again
/// each time they blocked again, so one credible task behind a backlog of discredited IDs
/// waited as long as the backlog lasted.
#[test]
fn a_freed_slot_wakes_credible_tasks_first_and_rotates_the_others() {
    use super::super::index::{Blocked, CREDIBLE, TaskIndex};
    use super::super::records::{Run, Task};
    let chat = ChatId::from_bytes([1; 32]);
    let key = |ts: u64, n: u8| TaskKey {
        chat_id: chat,
        target: Target::Event(EventId::new(ts, [n; 16])),
    };
    let idle = Task {
        run: Run::Active {
            stage: 0,
            ttl: MIN,
            jitter: 1_000_000,
            attempt: None,
            expired_resends: 0,
        },
        candidates: BTreeMap::new(),
        runs: 1,
        created_at: T0,
    };
    let p = member(1);
    let blocked = Blocked {
        peers: vec![p],
        until: u64::MAX,
    };
    let mut ix = TaskIndex::default();
    // Discredited IDs dated early, so first by key; then one credible ID.
    let suspect: Vec<TaskKey> = (0..50u8).map(|n| key(T0 - DAY, n)).collect();
    let credible = key(T0, 99);
    for k in suspect.iter().chain([&credible]) {
        let prio = if *k == credible { CREDIBLE } else { 0 };
        ix.update(*k, Some(&idle), prio);
        ix.block(*k, blocked.clone());
    }
    // One slot of the peer is free.
    ix.load.insert(p, 15);
    ix.wake_free(|_| 16);
    assert_eq!(ix.ready().collect::<Vec<_>>(), vec![credible]);
    // Among equals, a task woken and blocked again goes behind the others.
    ix.block(credible, blocked.clone());
    ix.update(credible, None, 0);
    let mut woken = Vec::new();
    for _ in 0..3 {
        ix.wake_free(|_| 16);
        let k = ix.ready().next().unwrap();
        woken.push(k);
        ix.block(k, blocked.clone());
    }
    assert_eq!(woken.len(), 3);
    assert!(woken[0] != woken[1] && woken[1] != woken[2], "{woken:?}");
}

/// Found by review (code at `6a916f2e`): a tips scan from a peer that is not a member was
/// answered "not available" for an anchor this device does not hold, and ignored for one it
/// holds, so anyone with a session learned which epochs the device holds.
#[test]
fn a_stranger_cannot_tell_a_held_anchor_from_an_unknown_one() {
    let mut net = Net::new(3, 1);
    let chat = net.chat();
    let stranger = member(9);
    let scan = |anchor: ChatId, rid: u8, now: u64| {
        query(
            rid,
            now,
            MIN,
            vec![QueryOp::TipsScan {
                anchor,
                scan_id: scan_id(rid),
                offset: 0,
            }],
        )
    };
    let now = net.now;
    net.recv_frames(0, stranger, &[scan(chat, 1, now)]);
    let held = net.poll_frames(0).remove(&stranger).unwrap_or_default();
    net.recv_frames(0, stranger, &[scan(ChatId::from_bytes([0x77; 32]), 2, now)]);
    let unknown = net.poll_frames(0).remove(&stranger).unwrap_or_default();
    let statuses = |f: &[Frame]| responses(f).iter().map(status).collect::<Vec<_>>();
    assert_eq!(statuses(&unknown), vec![Some(Status::NotAvailable)]);
    assert_eq!(statuses(&held), statuses(&unknown));
}

/// The answer rows and version notices queued for `peer` on device `d`.
fn queued_for_peer(net: &Net, d: usize, peer: GossipId) -> (usize, usize) {
    let mut out = (0, 0);
    for (k, w) in net.devs[d].node.t.queue.iter() {
        if k.0 == peer {
            match w {
                super::super::records::Work::Answer { .. } => out.0 += 1,
                super::super::records::Work::VersionNotice => out.1 += 1,
                _ => {}
            }
        }
    }
    out
}

/// Found by review (code at `6a916f2e`): every entry over a member's request budget queued
/// a stored `busy` answer, so a member flooding queries while the answers could not leave
/// grew the queue without bound; and the version notices sent were remembered per distinct
/// version, which a peer chooses freely.
#[test]
fn query_floods_and_version_floods_queue_a_bounded_amount() {
    let mut net = Net::new(3, 1);
    let chat = net.chat();
    let now = net.now;
    for rid in 0..200u8 {
        let ops = (0..16u8)
            .map(|i| QueryOp::Event {
                chat_id: chat,
                event_id: EventId::new(T0, [i; 16]),
            })
            .collect();
        net.recv_frames(0, member(1), &[query(rid, now, MIN, ops)]);
    }
    let (answers, _) = queued_for_peer(&net, 0, member(1));
    assert!(answers <= 512, "{answers} answers queued");
    let now = net.now;
    let dev = &mut net.devs[0];
    dev.node
        .set_accepted_contact(&mut dev.store, member(2), true, now, &mut net.rng)
        .unwrap();
    for v in 2..300u64 {
        let mut pt = Vec::new();
        prost::encoding::encode_varint(v, &mut pt);
        net.recv(0, member(2), &pt);
    }
    let (_, notices) = queued_for_peer(&net, 0, member(2));
    let versions = net.devs[0]
        .node
        .t
        .peers
        .get(&member(2))
        .map_or(0, |r| r.version_notices.len());
    assert!(
        notices <= 1 && versions <= 8,
        "{notices} notices, {versions} versions"
    );
}

/// Found by review (code at `6a916f2e`): the entries of one query that timed out together
/// counted as as many timeouts, so one unanswered query of three lookups made a member
/// unresponsive; a member that later sent a valid notice or event stayed unresponsive; and
/// a sync-object lookup, which has no triggering candidate, always counted as suspect.
#[test]
fn responsiveness_counts_queries_and_any_valid_traffic() {
    let mut net = Net::new(3, 1);
    let chat = net.chat();
    let ids: Vec<EventId> = (0..3u8).map(|i| EventId::new(T0, [i; 16])).collect();
    net.recv_frames(0, member(1), &[notice(chat, &ids)]);
    let q = super::retrieval::sent_lookups(&mut net, 0);
    assert_eq!(q.len(), 3);
    assert!(q.iter().all(|s| s.to == member(1) && s.rid == q[0].rid));
    net.now = q[0].sent_at + 2 * MIN;
    net.tick(0);
    assert!(
        net.devs[0].node.responsive(&member(1)),
        "one unanswered query is one timeout"
    );
    // Unresponsive after three timeouts, responsive again after a valid notice.
    for t in 0..3 {
        net.devs[0].node.note_timeout(&member(2), T0 + t);
    }
    assert!(!net.devs[0].node.responsive(&member(2)));
    net.recv_frames(0, member(2), &[notice(chat, &[EventId::new(T0, [7; 16])])]);
    assert!(
        net.devs[0].node.responsive(&member(2)),
        "a notice is traffic"
    );
    // A sync-object lookup is credible.
    let sync = SyncObjId::from_bytes([9; 32]);
    let now = net.now;
    let dev = &mut net.devs[0];
    dev.node
        .lookup_sync_object(&mut dev.store, chat, sync, now, &mut net.rng)
        .unwrap();
    let key = TaskKey {
        chat_id: chat,
        target: Target::SyncObj(sync),
    };
    assert!(net.devs[0].node.priority(&key) >= super::super::index::CREDIBLE);
}

/// Found by review (code at `6a916f2e`): a task waited for a responsive member only when it
/// was at its lookup limit, not when its request was merely outstanding, so the task went to
/// a member that stopped answering for a whole stage.
#[test]
fn a_task_waits_for_an_outstanding_responsive_member() {
    let mut net = Net::new(4, 1);
    let chat = net.chat();
    for t in 0..3 {
        net.devs[0].node.note_timeout(&member(3), T0 + t);
    }
    let id = EventId::new(T0, [5; 16]);
    net.recv_frames(0, member(1), &[notice(chat, &[id])]);
    let mut asked = Vec::new();
    for _ in 0..6 {
        for s in super::retrieval::sent_lookups(&mut net, 0) {
            asked.push(s.to);
        }
        net.now += 70_000;
        net.tick(0);
    }
    assert!(asked.contains(&member(2)), "{asked:?}");
    assert!(!asked.contains(&member(3)), "{asked:?}");
}

/// Found by review (code at `6a916f2e`): the credible threshold was the score of an
/// unmeasured member, so one legitimate "not available" after a notice made a member that
/// had supplied nothing yet suspect; an invalid event in an answer was penalised twice; and
/// an ID listed in a tip page counted as announced, so "not available" for it was
/// penalised.
#[test]
fn the_score_does_not_overpunish_honest_answers() {
    use crate::wire::Page;
    let mut net = Net::new(4, 1);
    let chat = net.chat();
    // One "not available" after a notice: still credible.
    let a = EventId::new(T0, [1; 16]);
    net.recv_frames(0, member(1), &[notice(chat, &[a])]);
    let q = super::retrieval::sent_lookups(&mut net, 0);
    super::retrieval::answer(
        &mut net,
        0,
        &q[0],
        ResponseResult::Status(Status::NotAvailable),
    );
    let b = EventId::new(T0, [2; 16]);
    net.recv_frames(0, member(1), &[notice(chat, &[b])]);
    let key = TaskKey {
        chat_id: chat,
        target: Target::Event(b),
    };
    assert!(net.devs[0].node.priority(&key) >= super::super::index::CREDIBLE);
    // An invalid event (failed secret proof) is penalised once.
    let e = net.event(T0, 5, &[], 2);
    net.recv_frames(0, member(2), &[notice(chat, &[e.event_id()])]);
    let q = super::retrieval::sent_lookups(&mut net, 0);
    let s = q.iter().find(|s| s.to == member(2)).unwrap();
    let mut bad = blob(&e);
    let proof = e.secret_proof();
    let at = bad.windows(32).position(|w| w == proof.as_bytes()).unwrap();
    bad[at] ^= 1;
    super::retrieval::answer(&mut net, 0, s, ResponseResult::Event(bad));
    assert_eq!(
        net.devs[0].node.t.peers.get(&member(2)).unwrap().penalty,
        PENALTY_MALFORMED
    );
    // An ID listed in a page, then "not available": no penalty.
    let now = net.now;
    let dev = &mut net.devs[0];
    dev.node
        .peer_reconnected(&mut dev.store, member(3), now, &mut net.rng)
        .unwrap();
    let sent = super::retrieval::sent_queries(&mut net, 0);
    let s = sent
        .iter()
        .find(|s| s.to == member(3) && matches!(s.op, QueryOp::TipsScan { .. }))
        .unwrap();
    let QueryOp::TipsScan { scan_id, .. } = s.op else {
        unreachable!()
    };
    let c = EventId::new(T0, [3; 16]);
    let page = Page {
        scan_id,
        offset: 0,
        count: 1,
        entries: vec![Entry {
            chat_id: chat,
            item: EntryItem::Event(c),
        }],
        skipped: 0,
    };
    super::retrieval::answer(&mut net, 0, s, ResponseResult::Page(page));
    for _ in 0..4 {
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
        net.now += 70_000;
        net.tick(0);
    }
    assert_eq!(net.devs[0].node.score(&member(3)), 500_000);
}

/// Found by review (code at `6a916f2e`): a neighbor was replaced after three timeouts whose
/// first and last were two days apart even if it had not been asked anything in between;
/// and a replaced neighbor's count was reset, so a member that never answers counted as
/// responsive and was taken back as a neighbor once its cooldown ended.
#[test]
fn neighbor_replacement_needs_two_days_of_unanswered_asks_and_sticks() {
    let mut net = Net::new(13, 1);
    let chat = net.chat();
    super::dissemination::neighbors_of(&mut net, 0, &[1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    let node = &mut net.devs[0].node;
    // Two quick timeouts, then one two days later: not two days of asking.
    node.note_query_timeout(&member(1), T0, T0 + MIN);
    node.note_query_timeout(&member(1), T0 + MIN, T0 + 2 * MIN);
    node.note_query_timeout(&member(1), T0 + 2 * DAY, T0 + 2 * DAY + MIN);
    assert!(node.is_neighbor(&chat, &member(1)));
    // Member 3 is asked without an answer for two days: replaced, and stays unresponsive.
    node.note_query_timeout(&member(3), T0, T0 + DAY);
    node.note_query_timeout(&member(3), T0 + DAY, T0 + 2 * DAY);
    node.note_query_timeout(&member(3), T0 + 2 * DAY, T0 + 2 * DAY + HOUR);
    assert!(!node.is_neighbor(&chat, &member(3)));
    assert!(!node.responsive(&member(3)));
    // After its cooldown, a responsive member takes the free place.
    net.now = T0 + 4 * DAY;
    net.tick(0);
    let asked: Vec<GossipId> = net
        .poll_frames(0)
        .into_iter()
        .filter(|(_, f)| f.iter().any(|f| matches!(f, Frame::NeighborRequest(_))))
        .map(|(to, _)| to)
        .collect();
    assert!(
        !asked.is_empty() && !asked.contains(&member(3)),
        "{asked:?}"
    );
}

/// Checks that device `d` has nothing to do before its next wake-up: a copy of it rebuilt
/// from its storage and ticked just before then changes nothing and sends nothing. Returns
/// the wake-up.
fn assert_idle_until_wakeup(net: &mut Net, d: usize) -> u64 {
    let now = net.now;
    let wake = net.devs[d]
        .node
        .next_wakeup(&net.devs[d].store, now)
        .unwrap()
        .unwrap_or(now + 30 * DAY);
    if wake <= now + 1 {
        return wake;
    }
    let mut store = net.devs[d].store.clone();
    let mut node = Node::open(&store, member(d)).unwrap();
    node.install_epoch(&mut store, config(&net.root), false, now, &mut net.rng)
        .unwrap();
    let before = store.clone();
    node.tick(&mut store, wake - 1, &mut net.rng).unwrap();
    let out = node
        .poll_outbox(&mut store, wake - 1, &mut net.rng)
        .unwrap();
    assert!(
        store == before && out.is_empty(),
        "at {now}: something was due before the wake-up at {wake}"
    );
    wake
}

/// Found by review (code at `6a916f2e`): `next_wakeup` missed the first run of a freshly
/// installed group, the end of a neighbor cooldown, and the turn of a lane whose scan is
/// still pending, so a device sleeping until it would have missed them.
#[test]
fn a_device_sleeping_until_its_next_wakeup_misses_nothing() {
    let mut net = Net::new(4, 1);
    let chat = net.chat();
    for _ in 0..200 {
        let wake = assert_idle_until_wakeup(&mut net, 0);
        net.now = net.now.max(wake);
        net.tick(0);
        // Member 1 declines every neighbor request; the others never answer.
        for (to, frames) in net.poll_frames(0) {
            if to == member(1)
                && frames
                    .iter()
                    .any(|f| matches!(f, Frame::NeighborRequest(_)))
            {
                net.recv_frames(
                    0,
                    member(1),
                    &[Frame::NeighborResponse(crate::wire::NeighborResponse {
                        chat_id: chat,
                        accepted: false,
                        suggestions: Vec::new(),
                    })],
                );
            }
        }
        net.now += 1;
    }
}

/// Found by review (code at `6a916f2e`): after a failed `handed_off` commit the plaintext
/// stayed in flight and confirmable, but its work no longer counted as in flight, so the next
/// poll assembled the same work again and both copies could be sent.
#[test]
fn a_failed_handoff_does_not_assemble_the_same_work_again() {
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
    let again = node.poll_outbox(&mut store, T0, &mut rng).unwrap();
    assert!(
        again.iter().all(|o| o.to != out[0].to),
        "the work of {:?} was assembled twice",
        out[0].handle
    );
    node.handed_off(&mut store, out[0].handle, T0, &mut rng)
        .unwrap();
}

/// Found by review (code at `6a916f2e`): `is_current` took no clock, so a plaintext
/// assembled just before a scheduled deletion came due still counted as current after it,
/// and the deleted message went out.
#[test]
fn a_plaintext_is_not_current_once_a_deletion_came_due() {
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
    net.now = due - MIN;
    net.recv_frames(
        0,
        member(2),
        &[query(
            1,
            net.now,
            MIN,
            vec![QueryOp::Event {
                chat_id: chat,
                event_id: m.event_id(),
            }],
        )],
    );
    let now = net.now;
    let dev = &mut net.devs[0];
    let out = dev
        .node
        .poll_outbox(&mut dev.store, now, &mut net.rng)
        .unwrap();
    assert_eq!(out.len(), 1);
    // The transport encrypts two minutes later, after the deletion came due.
    net.now = due + MIN;
    assert!(!net.devs[0].node.is_current(out[0].handle, net.now));
}

/// Found by review (code at `6a916f2e`): the results of sync-object lookups were kept in
/// memory only, so a result was reported twice when the operation that completed the lookup
/// failed to commit and was retried, and lost when the device crashed before the caller
/// took it.
#[test]
fn lookup_results_survive_failed_commits_and_crashes_exactly_once() {
    let root = epoch_root(2, 0x10);
    let chat = root.chat_id();
    let mut store = Instrumented::new(MemoryStorage::new());
    let mut rng = TestRng::new(3);
    let mut node = Node::open(&store, member(0)).unwrap();
    node.install_epoch(&mut store, config(&root), false, T0, &mut rng)
        .unwrap();
    let sync = SyncObjId::from_bytes([5; 32]);
    node.lookup_sync_object(&mut store, chat, sync, T0, &mut rng)
        .unwrap();
    let out = node.poll_outbox(&mut store, T0, &mut rng).unwrap();
    let mut rid = None;
    for o in &out {
        node.handed_off(&mut store, o.handle, T0, &mut rng).unwrap();
        if o.to == member(1) {
            for (r, _, _, ops) in queries(&frames(&o.plaintext)) {
                if matches!(ops[0], QueryOp::SyncObj { .. }) {
                    rid = Some(r);
                }
            }
        }
    }
    let na = wire::encode_plaintext(&[Frame::Response(Response {
        request_id: Some(rid.unwrap()),
        idx: 0,
        result: ResponseResult::Status(Status::NotAvailable),
    })])
    .unwrap();
    store.fail_commits = true;
    assert!(
        node.handle_plaintext(&mut store, member(1), &na, T0 + 1, &mut rng)
            .is_err()
    );
    store.fail_commits = false;
    node.handle_plaintext(&mut store, member(1), &na, T0 + 1, &mut rng)
        .unwrap();
    // A crash before the caller takes the result.
    let mut node = Node::open(&store, member(0)).unwrap();
    node.install_epoch(&mut store, config(&root), false, T0 + 2, &mut rng)
        .unwrap();
    assert_eq!(
        node.take_lookup_results(&mut store, T0 + 2, &mut rng)
            .unwrap(),
        vec![(chat, sync, LookupResult::NotFound)]
    );
}

/// Found by review (code at `6a916f2e`): correlation references were dropped only by `tick`,
/// so a response arriving after its request's deadline, with no tick in between, was still
/// matched to it (§13.4 keeps a reference only until that deadline).
#[test]
fn a_response_after_its_request_deadline_is_dropped_without_a_tick() {
    let mut net = Net::new(3, 1);
    let chat = net.chat();
    let id = EventId::new(T0, [5; 16]);
    net.recv_frames(0, member(1), &[notice(chat, &[id])]);
    let q = super::retrieval::sent_lookups(&mut net, 0);
    assert_eq!(q[0].to, member(1));
    net.now = super::super::timing::deadline(q[0].sent_at, q[0].ttl) + 1;
    super::retrieval::answer(
        &mut net,
        0,
        &q[0],
        ResponseResult::Status(Status::NotAvailable),
    );
    assert_eq!(
        net.devs[0].node.score(&member(1)),
        500_000,
        "a stale answer counted"
    );
}

/// Device 0 scans member `peer`; returns the first page request.
fn start_scan(net: &mut Net, peer: usize) -> super::retrieval::Sent {
    let now = net.now;
    let dev = &mut net.devs[0];
    dev.node
        .peer_reconnected(&mut dev.store, member(peer), now, &mut net.rng)
        .unwrap();
    super::retrieval::sent_queries(net, 0)
        .into_iter()
        .find(|s| matches!(s.op, QueryOp::TipsScan { .. }) && s.to == member(peer))
        .unwrap()
}

/// Found by review (code at `6a916f2e`): a page request answered `malformed` penalised the
/// responder, while a lookup answered `malformed` only fails the peer for the run (§11.4).
#[test]
fn a_scan_answered_malformed_ends_without_a_penalty() {
    let mut net = Net::new(3, 1);
    let s = start_scan(&mut net, 1);
    super::retrieval::answer(&mut net, 0, &s, ResponseResult::Status(Status::Malformed));
    assert_eq!(net.devs[0].node.score(&member(1)), 500_000);
    assert!(
        net.devs[0]
            .node
            .t
            .scans_out
            .iter()
            .all(|(k, _)| k.1 != member(1))
    );
}

/// Found by review (code at `6a916f2e`): the restarts of a scan were counted over its whole
/// life, so three honest restarts spread over a long, progressing scan ended it; the count
/// now restarts when a page makes progress.
#[test]
fn a_page_that_makes_progress_resets_the_restart_count() {
    use crate::wire::Page;
    let mut net = Net::new(3, 1);
    let chat = net.chat();
    let mut s = start_scan(&mut net, 1);
    let next = |net: &mut Net| {
        super::retrieval::sent_queries(net, 0)
            .into_iter()
            .find(|s| matches!(s.op, QueryOp::TipsScan { .. }) && s.to == member(1))
    };
    for round in 0..2u8 {
        // A restart, then a page of a two-entry list.
        super::retrieval::answer(&mut net, 0, &s, ResponseResult::Status(Status::Restart));
        s = next(&mut net).expect("restarted");
        super::retrieval::answer(&mut net, 0, &s, ResponseResult::Status(Status::Restart));
        s = next(&mut net).expect("restarted");
        let QueryOp::TipsScan { scan_id, .. } = s.op else {
            unreachable!()
        };
        let page = Page {
            scan_id,
            offset: 0,
            count: 2,
            entries: vec![Entry {
                chat_id: chat,
                item: EntryItem::Event(EventId::new(T0, [round; 16])),
            }],
            skipped: 0,
        };
        super::retrieval::answer(&mut net, 0, &s, ResponseResult::Page(page));
        s = next(&mut net).expect("next page");
    }
    // Four restarts in all, never more than two since the last progress: still scanning.
    super::retrieval::answer(&mut net, 0, &s, ResponseResult::Status(Status::Restart));
    assert!(next(&mut net).is_some(), "the scan ended");
}

/// Found by the network simulation's check that honest members stay credible (code at
/// `74bd27cf`, seed 6): a member that announced an event and then said it did not have it
/// was penalised for good, although honest members do so whenever they prune or supersede
/// an event they announced, so honest relays of edited messages became suspect.
#[test]
fn not_available_is_penalised_only_if_the_item_never_turns_up() {
    let mut net = Net::new(4, 1);
    let chat = net.chat();
    // Member 1 announces a real event, then no longer has it; member 2 supplies it.
    let e = net.event(T0, 5, &[], 2);
    net.recv_frames(0, member(1), &[notice(chat, &[e.event_id()])]);
    let q = super::retrieval::sent_lookups(&mut net, 0);
    assert_eq!(q[0].to, member(1));
    super::retrieval::answer(
        &mut net,
        0,
        &q[0],
        ResponseResult::Status(Status::NotAvailable),
    );
    net.give(0, 2, &e);
    assert!(net.devs[0].node.score(&member(1)) >= 500_000);
    // Member 3 announces an ID that never turns up: penalised at its deadline.
    let fake = EventId::new(T0, [9; 16]);
    net.recv_frames(0, member(3), &[notice(chat, &[fake])]);
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
    net.now = T0 + crate::constants::RETENTION_MS + MIN;
    net.tick(0);
    assert!(net.devs[0].node.score(&member(3)) < 500_000);
}

/// Found by the network simulation's check that honest members stay credible (code at
/// `6c956a44`, seed 217): an honest member that relays notices of what it receives, and
/// prunes some of it (superseded by an edit) before others ask, answered "not available"
/// for those while its true announcements earned it nothing unless the asker lacked them,
/// so after two such answers it was suspect.
#[test]
fn true_announcements_keep_an_honest_relay_credible() {
    let mut net = Net::new(3, 1);
    let chat = net.chat();
    let known: Vec<MessageEvent> = (1..4u8).map(|r| net.event(T0, r, &[], 2)).collect();
    for e in &known {
        net.give(0, 2, e);
    }
    net.recv_frames(
        0,
        member(1),
        &[notice(
            chat,
            &known.iter().map(MessageEvent::event_id).collect::<Vec<_>>(),
        )],
    );
    let gone: Vec<EventId> = (7..9u8).map(|r| EventId::new(T0, [r; 16])).collect();
    net.recv_frames(0, member(1), &[notice(chat, &gone)]);
    for s in super::retrieval::sent_lookups(&mut net, 0) {
        if s.to == member(1) {
            super::retrieval::answer(
                &mut net,
                0,
                &s,
                ResponseResult::Status(Status::NotAvailable),
            );
        }
    }
    let score = net.devs[0].node.score(&member(1));
    assert!(score >= super::super::index::CREDIBLE, "{score}");
}

/// Found by the network simulation's check that honest members stay responsive (code at
/// `c3e4ba7f`, seed 6): the entries of one query time out at slightly different instants
/// (each stage has its own jitter), and a timeout of another query in between made the
/// later entries count again, so two lost queries made an online member unresponsive.
#[test]
fn a_query_counts_once_whatever_timed_out_in_between() {
    let mut net = Net::new(3, 1);
    let node = &mut net.devs[0].node;
    node.note_query_timeout(&member(1), T0, T0 + MIN);
    node.note_query_timeout(&member(1), T0 + MIN, T0 + 3 * MIN);
    node.note_query_timeout(&member(1), T0, T0 + 3 * MIN + 1);
    assert_eq!(node.t.peers.get(&member(1)).unwrap().failures, 2);
}

/// Found by the network simulation's check that honest members stay responsive (code at
/// `f2681c5a`, seed 119): the answers of an online member were delayed by hours in transit
/// and arrived after their requests' deadlines; dropped as uncorrelated, they did not count
/// as a sign of life, so the member stayed unresponsive although it had answered.
#[test]
fn a_late_uncorrelated_answer_still_shows_the_member_is_alive() {
    let mut net = Net::new(3, 1);
    for t in 0..3 {
        net.devs[0].node.note_timeout(&member(1), T0 + t);
    }
    assert!(!net.devs[0].node.responsive(&member(1)));
    net.recv_frames(
        0,
        member(1),
        &[Frame::Response(Response {
            request_id: Some(RequestId::from_bytes([3; 16])),
            idx: 0,
            result: ResponseResult::Status(Status::NotAvailable),
        })],
    );
    assert!(net.devs[0].node.responsive(&member(1)));
}

/// Found by the network simulation's check that honest members stay responsive (code at
/// `7a3fc31d`, seed 99): a member whose last answers were lost or delayed in transit kept
/// querying this device, yet stayed unresponsive, since only answers, notices and events
/// counted as signs of life.
#[test]
fn a_query_from_a_member_shows_it_is_alive() {
    let mut net = Net::new(3, 1);
    let chat = net.chat();
    for t in 0..3 {
        net.devs[0].node.note_timeout(&member(1), T0 + t);
    }
    let now = net.now;
    net.recv_frames(
        0,
        member(1),
        &[query(
            1,
            now,
            MIN,
            vec![QueryOp::Event {
                chat_id: chat,
                event_id: EventId::new(T0, [5; 16]),
            }],
        )],
    );
    assert!(net.devs[0].node.responsive(&member(1)));
}

/// Found by the network simulation's check that honest members stay credible (code at
/// `52917e98`, seed 15): an honest relay that had supplied and truly announced nothing to this
/// device yet answered "not available" twice for events it had announced and pruned since
/// (superseded by edits nobody had asked for), and was suspect with a score of 1/4.
#[test]
fn two_failed_announcements_leave_a_member_credible() {
    let mut net = Net::new(3, 1);
    let chat = net.chat();
    let gone: Vec<EventId> = (7..9u8).map(|r| EventId::new(T0, [r; 16])).collect();
    net.recv_frames(0, member(1), &[notice(chat, &gone)]);
    for s in super::retrieval::sent_lookups(&mut net, 0) {
        if s.to == member(1) {
            super::retrieval::answer(
                &mut net,
                0,
                &s,
                ResponseResult::Status(Status::NotAvailable),
            );
        }
    }
    let score = net.devs[0].node.score(&member(1));
    assert!(score >= super::super::index::CREDIBLE, "{score}");
}

/// §2.2: any defined status, in any context, ends that attempt without penalty: `restart`
/// or `unsupported` answering a lookup, `unsupported` answering a scan.
#[test]
fn any_defined_status_ends_the_attempt_without_penalty() {
    for status in [Status::Restart, Status::Unsupported] {
        let mut net = Net::new(3, 1);
        let chat = net.chat();
        let id = EventId::new(T0, [5; 16]);
        net.recv_frames(0, member(1), &[notice(chat, &[id])]);
        let score = net.devs[0].node.score(&member(1));
        let q = super::retrieval::sent_lookups(&mut net, 0);
        assert_eq!(q[0].to, member(1));
        super::retrieval::answer(&mut net, 0, &q[0], ResponseResult::Status(status));
        assert_eq!(net.devs[0].node.score(&member(1)), score, "{status:?}");
        assert_eq!(net.devs[0].node.stats().invalid, 0, "{status:?}");
        // The next candidate is asked at once.
        let q = super::retrieval::sent_lookups(&mut net, 0);
        assert_eq!(q[0].to, member(2), "{status:?}");
    }
    let mut net = Net::new(3, 1);
    let s = super::scans::start(&mut net, 1);
    let score = net.devs[0].node.score(&member(1));
    super::retrieval::answer(&mut net, 0, &s, ResponseResult::Status(Status::Unsupported));
    assert_eq!(net.devs[0].node.score(&member(1)), score);
    assert_eq!(net.devs[0].node.stats().invalid, 0);
}

/// An `expired` that arrives some time after the request's deadline, as one from an honest
/// responder with the same clock always does, is still recognised; any other answer that
/// late is not correlated.
#[test]
fn an_expired_after_the_deadline_is_recognised_for_a_margin() {
    let mut net = Net::new(2, 1);
    let chat = net.chat();
    let id = EventId::new(T0 + 30 * DAY, [5; 16]);
    net.recv_frames(0, member(1), &[notice(chat, &[id])]);
    let q = super::retrieval::sent_lookups(&mut net, 0);
    let deadline = super::super::timing::deadline(q[0].sent_at, q[0].ttl);
    net.now = deadline + 10 * MIN;
    super::retrieval::answer(&mut net, 0, &q[0], ResponseResult::Status(Status::Expired));
    let r = super::retrieval::sent_lookups(&mut net, 0);
    assert_eq!(r.len(), 1, "resent");
}

/// §2.2: a valid event in a response that can no longer be correlated (past its request's
/// deadline, or for a request this device does not know) is processed as an event frame
/// would be; correlation only serves the retry state.
#[test]
fn an_uncorrelated_response_still_supplies_its_event() {
    let mut net = Net::new(3, 1);
    let chat = net.chat();
    let e = net.event(T0, 5, &[], 1);
    net.recv_frames(0, member(1), &[notice(chat, &[e.event_id()])]);
    let q = super::retrieval::sent_lookups(&mut net, 0);
    net.now = super::super::timing::deadline(q[0].sent_at, q[0].ttl) + 2 * HOUR;
    net.tick(0);
    super::retrieval::answer(&mut net, 0, &q[0], ResponseResult::Event(blob(&e)));
    assert!(net.held(0, &e.event_id()));
    // A response to a request never sent.
    let f = net.event(T0, 6, &[], 2);
    net.recv_frames(
        0,
        member(2),
        &[Frame::Response(Response {
            request_id: Some(RequestId::from_bytes(
                [9; crate::constants::REQUEST_ID_SIZE],
            )),
            idx: 0,
            result: ResponseResult::Event(blob(&f)),
        })],
    );
    assert!(net.held(0, &f.event_id()));
}

/// Found by the membership simulation (seed 45): a root in a response that could no longer
/// be correlated was received as one delivered in full, which prompts again for a group the
/// user closed (§4.8 case 1). Only message events are taken from such a response.
#[test]
fn an_uncorrelated_response_never_delivers_a_root() {
    let mut net = Net::new(3, 1);
    let other = epoch_root(3, 0x40);
    let blob = wire::encode_event_blob(&EventObject::Root(Box::new(other.clone()))).unwrap();
    net.recv_frames(
        0,
        member(1),
        &[Frame::Response(Response {
            request_id: Some(RequestId::from_bytes(
                [9; crate::constants::REQUEST_ID_SIZE],
            )),
            idx: 0,
            result: ResponseResult::Event(blob),
        })],
    );
    assert!(net.devs[0].node.root(&other.chat_id()).is_none());
}
