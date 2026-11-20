//! §12.1 to §12.3: tip lists, frozen pages, scan IDs, restart and expiry, the requester's
//! paging, and the triggers and periodic lanes.

use super::dissemination::neighbors_of;
use super::retrieval::{Sent, answer, sent_queries};
use super::*;
use crate::node::records::{FrozenScan, LANE_KINDS, LaneKind};
use crate::node::timing::{LANE_OFFSET_MS, LANE_PERIOD_MS, LIVE_SCANS_PER_PEER, SCAN_TOMBSTONE_MS};
use crate::wire::Page;

fn scan(rid: u8, chat: ChatId, id: u8, offset: u64, sent_at: u64) -> Frame {
    query(
        rid,
        sent_at,
        MIN,
        vec![QueryOp::TipsScan {
            anchor: chat,
            scan_id: scan_id(id),
            offset,
        }],
    )
}

/// Member `peer` scans device 0 and gets one answer.
fn ask(net: &mut Net, peer: usize, rid: u8, id: u8, offset: u64) -> ResponseResult {
    let chat = net.chat();
    let f = scan(rid, chat, id, offset, net.now);
    net.recv_frames(0, member(peer), &[f]);
    let mut rs = responses(&net.poll_frames(0).remove(&member(peer)).unwrap_or_default());
    assert_eq!(rs.len(), 1);
    rs.remove(0).result
}

fn page(r: ResponseResult) -> Page {
    match r {
        ResponseResult::Page(p) => p,
        other => panic!("not a page: {other:?}"),
    }
}

fn ids(p: &Page) -> Vec<EventId> {
    p.entries
        .iter()
        .map(|e| match e.item {
            EntryItem::Event(id) => id,
            _ => panic!("not an event"),
        })
        .collect()
}

#[test]
fn a_tip_list_takes_three_deletions_then_one_other_event() {
    let mut net = Net::new(3, 1);
    let dels: Vec<MessageEvent> = (0..5u8)
        .map(|i| net.deletion(T0 + u64::from(i), 10 + i, 100 + i))
        .collect();
    let others: Vec<MessageEvent> = (0..3u8)
        .map(|i| net.event(T0 + u64::from(i), 20 + i, &[], 1))
        .collect();
    for e in dels.iter().chain(&others) {
        net.give(0, 1, e);
    }
    net.poll(0);
    let p = page(ask(&mut net, 2, 1, 1, 0));
    let d = |i: usize| dels[i].event_id();
    let o = |i: usize| others[i].event_id();
    // Deletions ascending, others descending (newest first), 3:1, then the rest.
    assert_eq!(
        ids(&p),
        vec![d(0), d(1), d(2), o(2), d(3), d(4), o(1), o(0)]
    );
    assert_eq!(p.count, 8);
    assert!(p.is_final());
}

#[test]
fn a_frozen_list_keeps_its_ids_and_a_pruned_entry_answers_not_available() {
    let mut net = Net::new(3, 1);
    let chat = net.chat();
    net.now = T0 + 1000;
    let events: Vec<MessageEvent> = (0..200u8)
        .map(|i| net.event(T0 + u64::from(i), i, &[], 1))
        .collect();
    for e in &events {
        net.give(0, 1, e);
    }
    net.poll(0);
    let first = page(ask(&mut net, 2, 1, 1, 0));
    assert_eq!(first.entries.len(), 128);
    assert_eq!(first.count, 200);
    assert!(!first.is_final());
    // A new tip after the freeze is not listed; a listed event is pruned meanwhile.
    let late = net.event(T0 + 500, 250, &[], 1);
    net.give(0, 1, &late);
    let pruned_id = events[10].event_id();
    let now = net.now;
    let dev = &mut net.devs[0];
    dev.node
        .local_delete(
            &mut dev.store,
            chat,
            SyncObjId::from_bytes([10; 32]),
            now,
            &mut net.rng,
        )
        .unwrap();
    net.poll(0);
    let second = page(ask(&mut net, 2, 2, 1, 128));
    assert_eq!(second.offset, 128);
    assert_eq!(second.count, 72);
    assert!(second.is_final());
    let all: Vec<EventId> = ids(&first).into_iter().chain(ids(&second)).collect();
    assert!(!all.contains(&late.event_id()));
    assert!(all.contains(&pruned_id));
    net.recv_frames(
        0,
        member(2),
        &[query(
            3,
            net.now,
            MIN,
            vec![QueryOp::Event {
                chat_id: chat,
                event_id: pruned_id,
            }],
        )],
    );
    let r = responses(&net.poll_frames(0)[&member(2)]);
    assert_eq!(status(&r[0]), Some(Status::NotAvailable));
    // A new scan lists the new tip.
    let fresh = page(ask(&mut net, 2, 4, 2, 0));
    assert_eq!(fresh.count, 200);
    assert!(ids(&fresh).contains(&late.event_id()));
}

#[test]
fn an_empty_list_is_one_empty_final_page() {
    let mut net = Net::new(3, 1);
    let p = page(ask(&mut net, 1, 1, 1, 0));
    assert_eq!((p.count, p.entries.len()), (0, 0));
    assert!(p.is_final());
    // The final page sent releases the list: asked again, `restart`.
    assert_eq!(
        ask(&mut net, 1, 2, 1, 0),
        ResponseResult::Status(Status::Restart)
    );
}

/// More events than one page holds, given to device 0 by member 1.
fn longer_than_a_page(net: &mut Net) -> usize {
    let n = crate::constants::MAX_PAGE_ENTRIES + 2;
    for i in 0..n {
        let e = net.event(T0, i as u8, &[], 1);
        net.give(0, 1, &e);
    }
    net.poll(0);
    n
}

#[test]
fn unknown_or_dropped_scans_answer_restart() {
    let mut net = Net::new(3, 1);
    let e = net.event(T0, 5, &[], 1);
    net.give(0, 1, &e);
    net.poll(0);
    assert_eq!(
        ask(&mut net, 2, 1, 7, 1),
        ResponseResult::Status(Status::Restart)
    );
    page(ask(&mut net, 2, 2, 1, 0));
    // The list lives until sent_at + 1.05 × ttl + 5 min of the latest request.
    net.now += 7 * MIN;
    net.tick(0);
    assert_eq!(
        ask(&mut net, 2, 3, 1, 1),
        ResponseResult::Status(Status::Restart)
    );
    // The tombstone answers an offset-0 request too, for 24 hours.
    assert_eq!(
        ask(&mut net, 2, 4, 1, 0),
        ResponseResult::Status(Status::Restart)
    );
    net.now += SCAN_TOMBSTONE_MS;
    net.tick(0);
    page(ask(&mut net, 2, 5, 1, 0));
}

/// A frozen list lives at most until the deadline of its latest request, and no longer
/// than this device's own bound, [`crate::node::timing::FROZEN_MAX_LIVE_MS`]: a requester
/// asking with a 24-hour TTL cannot hold a slot for a day (§2.2: the responder may drop it
/// earlier and answer `restart`).
#[test]
fn a_frozen_list_lives_no_longer_than_the_responders_bound() {
    let mut net = Net::new(3, 1);
    let chat = net.chat();
    // A list longer than one page, so that the first page is not the final one.
    let n = crate::constants::MAX_PAGE_ENTRIES as u8 + 2;
    for i in 0..n {
        let e = net.event(T0, i, &[], 1);
        net.give(0, 1, &e);
    }
    net.poll(0);
    net.recv_frames(
        0,
        member(2),
        &[query(
            1,
            net.now,
            DAY,
            vec![QueryOp::TipsScan {
                anchor: chat,
                scan_id: scan_id(1),
                offset: 0,
            }],
        )],
    );
    net.poll(0);
    let live = |net: &Net| {
        net.devs[0]
            .node
            .t
            .scans_in
            .iter()
            .filter(|(_, f)| f.list.is_some())
            .count()
    };
    assert_eq!(live(&net), 1);
    net.now += crate::node::timing::FROZEN_MAX_LIVE_MS + 1;
    net.tick(0);
    assert_eq!(live(&net), 0, "dropped at the responder's bound");
    assert_eq!(
        ask(&mut net, 2, 2, 1, 128),
        ResponseResult::Status(Status::Restart)
    );
}

/// The frozen list is released once its final page has been sent.
#[test]
fn a_frozen_list_is_released_after_its_final_page() {
    let mut net = Net::new(3, 1);
    let e = net.event(T0, 5, &[], 1);
    net.give(0, 1, &e);
    net.poll(0);
    let p = page(ask(&mut net, 2, 1, 1, 0));
    assert!(p.is_final());
    assert!(
        net.devs[0]
            .node
            .t
            .scans_in
            .iter()
            .all(|(_, f)| f.list.is_none())
    );
}

#[test]
fn new_scans_beyond_four_per_peer_are_busy() {
    let mut net = Net::new(3, 1);
    longer_than_a_page(&mut net);
    for i in 0..LIVE_SCANS_PER_PEER as u8 {
        assert!(!page(ask(&mut net, 2, i, i, 0)).is_final());
    }
    assert_eq!(
        ask(&mut net, 2, 9, 9, 0),
        ResponseResult::Status(Status::Busy)
    );
    // Another peer still gets its scan; a live scan still pages.
    page(ask(&mut net, 1, 10, 10, 0));
    page(ask(&mut net, 2, 11, 0, 0));
}

#[test]
fn an_offset_beyond_the_list_is_malformed() {
    let mut net = Net::new(3, 1);
    let n = longer_than_a_page(&mut net) as u64;
    let first = page(ask(&mut net, 2, 1, 1, 0));
    assert!(first.count >= n);
    assert_eq!(
        ask(&mut net, 2, 3, 1, first.count + 1),
        ResponseResult::Status(Status::Malformed)
    );
}

#[test]
fn a_scan_whose_anchor_is_not_held_is_answered_not_available() {
    let mut net = Net::new(3, 1);
    let f = query(
        1,
        T0,
        MIN,
        vec![QueryOp::TipsScan {
            anchor: ChatId::from_bytes([9; 32]),
            scan_id: scan_id(1),
            offset: 0,
        }],
    );
    net.recv_frames(0, member(1), &[f]);
    let r = responses(&net.poll_frames(0)[&member(1)]);
    assert_eq!(status(&r[0]), Some(Status::NotAvailable));
}

#[test]
fn a_scan_from_a_non_member_is_answered_as_for_an_unknown_anchor() {
    let mut net = Net::new(3, 1);
    let chat = net.chat();
    let stranger = GossipId::from_bytes([0x77; 32]);
    net.recv_frames(0, stranger, &[scan(1, chat, 1, 0, T0)]);
    let r = responses(&net.poll_frames(0)[&stranger]);
    assert_eq!(
        r.iter().map(status).collect::<Vec<_>>(),
        vec![Some(Status::NotAvailable)]
    );
}

/// Device 0 scans member `peer`; returns the first page request.
pub(crate) fn start(net: &mut Net, peer: usize) -> Sent {
    let now = net.now;
    let dev = &mut net.devs[0];
    dev.node
        .peer_reconnected(&mut dev.store, member(peer), now, &mut net.rng)
        .unwrap();
    let q = sent_queries(net, 0);
    q.into_iter()
        .find(|s| matches!(s.op, QueryOp::TipsScan { .. }))
        .unwrap()
}

fn asked(s: &Sent) -> (ScanId, u64) {
    match s.op {
        QueryOp::TipsScan {
            scan_id, offset, ..
        } => (scan_id, offset),
        _ => unreachable!(),
    }
}

#[test]
fn the_requester_pages_through_and_fetches_the_listed_events() {
    let mut net = Net::new(3, 1);
    let chat = net.chat();
    let s = start(&mut net, 1);
    let (sid, offset) = asked(&s);
    assert_eq!(offset, 0);
    let listed: Vec<EventId> = (0..130u8).map(|i| EventId::new(T0, [i; 16])).collect();
    let entries: Vec<Entry> = listed
        .iter()
        .map(|id| Entry {
            chat_id: chat,
            item: EntryItem::Event(*id),
        })
        .collect();
    answer(
        &mut net,
        0,
        &s,
        ResponseResult::Page(Page {
            scan_id: sid,
            offset: 0,
            count: 130,
            entries: entries[..128].to_vec(),
        }),
    );
    let q = sent_queries(&mut net, 0);
    // The next page is asked first (page requests before content requests).
    let next = q
        .iter()
        .find(|s| matches!(s.op, QueryOp::TipsScan { .. }))
        .unwrap();
    assert_eq!(asked(next), (sid, 128));
    // 16 lookups to the peer that listed them (its limit), 16 to the other member.
    let lookups: Vec<&Sent> = q
        .iter()
        .filter(|s| matches!(s.op, QueryOp::Event { .. }))
        .collect();
    assert_eq!(lookups.iter().filter(|s| s.to == member(1)).count(), 16);
    assert_eq!(lookups.len(), 32);
    answer(
        &mut net,
        0,
        next,
        ResponseResult::Page(Page {
            scan_id: sid,
            offset: 128,
            count: 2,
            entries: entries[128..].to_vec(),
        }),
    );
    assert_eq!(net.devs[0].node.stats.scans_completed, 1);
    assert_eq!(net.devs[0].node.t.tasks.len(), 130);
}

#[test]
fn the_requester_rejects_a_page_of_another_scan_or_offset() {
    let mut net = Net::new(3, 1);
    let s = start(&mut net, 1);
    let (sid, _) = asked(&s);
    answer(
        &mut net,
        0,
        &s,
        ResponseResult::Page(Page {
            scan_id: scan_id(0xee),
            offset: 0,
            count: 0,
            entries: vec![],
        }),
    );
    assert!(net.devs[0].node.score(&member(1)) < 500_000);
    assert_eq!(net.devs[0].node.stats.scans_ended, 1);
    let _ = sid;

    let mut net = Net::new(3, 1);
    let chat = net.chat();
    let s = start(&mut net, 1);
    let (sid, _) = asked(&s);
    let e = |i: u8| Entry {
        chat_id: chat,
        item: EntryItem::Event(EventId::new(T0, [i; 16])),
    };
    answer(
        &mut net,
        0,
        &s,
        ResponseResult::Page(Page {
            scan_id: sid,
            offset: 0,
            count: 3,
            entries: vec![e(1)],
        }),
    );
    let next = sent_queries(&mut net, 0)
        .into_iter()
        .find(|s| matches!(s.op, QueryOp::TipsScan { .. }))
        .unwrap();
    // The total moved from 3 to 5: invalid.
    answer(
        &mut net,
        0,
        &next,
        ResponseResult::Page(Page {
            scan_id: sid,
            offset: 1,
            count: 4,
            entries: vec![e(2)],
        }),
    );
    assert_eq!(net.devs[0].node.stats.scans_ended, 1);
}

#[test]
fn restart_begins_a_fresh_scan_with_a_new_id_a_bounded_number_of_times() {
    let mut net = Net::new(3, 1);
    let mut s = start(&mut net, 1);
    let mut seen = BTreeSet::from([asked(&s).0]);
    for _ in 0..crate::node::scan::MAX_RESTARTS {
        answer(&mut net, 0, &s, ResponseResult::Status(Status::Restart));
        s = sent_queries(&mut net, 0)
            .into_iter()
            .find(|s| matches!(s.op, QueryOp::TipsScan { .. }))
            .unwrap();
        assert_eq!(asked(&s).1, 0);
        assert!(seen.insert(asked(&s).0), "a fresh scan ID");
    }
    answer(&mut net, 0, &s, ResponseResult::Status(Status::Restart));
    assert!(sent_queries(&mut net, 0).is_empty());
    assert_eq!(net.devs[0].node.stats.scans_ended, 1);
}

#[test]
fn not_available_ends_the_scan_and_asks_for_the_root_notice() {
    let mut net = Net::new(3, 1);
    let s = start(&mut net, 1);
    answer(
        &mut net,
        0,
        &s,
        ResponseResult::Status(Status::NotAvailable),
    );
    // The responder is sent a root notice of the anchor.
    assert_eq!(net.devs[0].node.stats.anchor_notices, 1);
    let sent = net.poll_frames(0);
    let notice = sent[&member(1)].iter().any(
        |f| matches!(f, Frame::Notice(n) if n.entries.iter().any(|e| e.item == EntryItem::Root)),
    );
    assert!(notice);
    // Legitimate: no penalty.
    assert_eq!(net.devs[0].node.score(&member(1)), 500_000);
}

#[test]
fn an_unanswered_scan_retries_with_growing_ttls_and_busy_waits() {
    let mut net = Net::new(3, 1);
    let s = start(&mut net, 1);
    net.now = s.sent_at + 64 * 1000;
    net.tick(0);
    let r = sent_queries(&mut net, 0)
        .into_iter()
        .find(|s| matches!(s.op, QueryOp::TipsScan { .. }))
        .unwrap();
    assert_eq!(asked(&r), asked(&s), "the same scan and offset");
    assert_eq!(r.ttl, crate::node::timing::next_ttl(MIN));
    answer(&mut net, 0, &r, ResponseResult::Status(Status::Busy));
    assert!(sent_queries(&mut net, 0).is_empty());
    net.now += r.ttl * 106 / 100;
    net.tick(0);
    let again = sent_queries(&mut net, 0);
    assert!(
        again
            .iter()
            .any(|q| matches!(q.op, QueryOp::TipsScan { .. }))
    );
}

#[test]
fn adopting_an_epoch_scans_two_members_preferring_sessions() {
    let mut store = MemoryStorage::new();
    let root = epoch_root(6, 0x10);
    let mut node = Node::open(&store, member(0)).unwrap();
    let mut rng = TestRng::new(1);
    node.set_session(member(4), true);
    node.install_epoch(&mut store, config(&root), true, T0, &mut rng)
        .unwrap();
    let out = node.poll_outbox(&mut store, T0, &mut rng).unwrap();
    let to: BTreeSet<GossipId> = out.iter().map(|o| o.to).collect();
    assert_eq!(to.len(), 2);
    assert!(to.contains(&member(4)));
    for o in &out {
        assert!(
            queries(&frames(&o.plaintext))
                .iter()
                .all(|q| matches!(q.3[0], QueryOp::TipsScan { .. }))
        );
    }
}

#[test]
fn lanes_alternate_neighbor_and_random_six_hours_apart() {
    assert_eq!(
        LANE_KINDS,
        [
            LaneKind::Neighbor,
            LaneKind::Random,
            LaneKind::Neighbor,
            LaneKind::Random
        ]
    );
    let mut net = Net::new(6, 1);
    neighbors_of(&mut net, 0, &[1, 2]);
    let scans = |net: &mut Net| -> Vec<GossipId> {
        sent_queries(net, 0)
            .into_iter()
            .filter(|s| matches!(s.op, QueryOp::TipsScan { .. }))
            .map(|s| s.to)
            .collect()
    };
    // The phase starts at the first time online: lane 0 scans a neighbor.
    net.tick(0);
    let first = scans(&mut net);
    assert_eq!(first.len(), 1);
    assert!(net.devs[0].node.is_neighbor(&net.chat(), &first[0]));
    // Lane 1 starts 6 h × r later, r in [0.95, 1.05], even though lane 0 is pending.
    net.now = T0 + LANE_OFFSET_MS * 95 / 100 - 1;
    net.tick(0);
    let between: Vec<GossipId> = scans(&mut net);
    assert!(
        between.iter().all(|p| *p == first[0]),
        "only lane 0's retries"
    );
    net.now = T0 + LANE_OFFSET_MS * 105 / 100;
    net.tick(0);
    let second: Vec<GossipId> = scans(&mut net)
        .into_iter()
        .filter(|p| *p != first[0])
        .collect();
    assert_eq!(second.len(), 1);
    assert!(
        !net.devs[0].node.is_neighbor(&net.chat(), &second[0]),
        "a random non-neighbor"
    );
}

#[test]
fn a_random_lane_with_no_non_neighbor_is_skipped_and_a_lane_waits_a_day_after_completion() {
    let mut net = Net::new(3, 1);
    let chat = net.chat();
    neighbors_of(&mut net, 0, &[1, 2]);
    net.tick(0);
    let s = sent_queries(&mut net, 0)
        .into_iter()
        .find(|s| matches!(s.op, QueryOp::TipsScan { .. }))
        .unwrap();
    let (sid, _) = asked(&s);
    // Answered before the request's deadline (a later answer is dropped, §13.4).
    net.now += MIN / 2;
    answer(
        &mut net,
        0,
        &s,
        ResponseResult::Page(Page {
            scan_id: sid,
            offset: 0,
            count: 0,
            entries: vec![],
        }),
    );
    let done = net.now;
    let g = net.devs[0].node.t.groups.get(&chat).unwrap().clone();
    assert_eq!(g.lanes[0].earliest, done + LANE_PERIOD_MS);
    // Lane 1 (random): every member is a neighbor, so the slot is skipped.
    net.now = T0 + 7 * HOUR;
    net.tick(0);
    let g = net.devs[0].node.t.groups.get(&chat).unwrap().clone();
    assert_eq!(g.cursor, 2);
    assert_eq!(g.lanes[1].active, None);
    assert_eq!(g.lanes[1].earliest, net.now + LANE_PERIOD_MS);
    assert!(
        sent_queries(&mut net, 0)
            .iter()
            .all(|s| !matches!(s.op, QueryOp::TipsScan { .. }))
    );
}

#[test]
fn after_a_long_time_offline_one_overdue_round_runs() {
    let mut net = Net::new(6, 1);
    neighbors_of(&mut net, 0, &[1, 2]);
    net.tick(0);
    net.poll(0);
    // Ten days later: one lane starts now, the next one 6 h later, not four at once.
    net.now = T0 + 10 * DAY;
    net.tick(0);
    let scans: BTreeSet<GossipId> = sent_queries(&mut net, 0)
        .into_iter()
        .filter(|s| matches!(s.op, QueryOp::TipsScan { offset: 0, .. }) && s.sent_at == net.now)
        .map(|s| s.to)
        .collect();
    assert!(scans.len() <= 2, "{scans:?}");
}

#[test]
fn the_neighbor_lanes_visit_every_neighbor_before_repeating() {
    let mut net = Net::new(5, 1);
    let chat = net.chat();
    neighbors_of(&mut net, 0, &[1, 2, 3]);
    let mut visited = Vec::new();
    for _ in 0..3 {
        let peer = {
            let mut cx_rng = TestRng::new(visited.len() as u64);
            let dev = &mut net.devs[0];
            let mut ov = crate::store::overlay::Overlay::new(&dev.store);
            let mut cx = Cx {
                ov: &mut ov,
                now: T0,
                rng: &mut cx_rng,
                edges: 100,
            };
            dev.node.lane_peer(&mut cx, chat, 0, None).unwrap()
        };
        visited.push(peer);
    }
    let set: BTreeSet<GossipId> = visited.iter().copied().collect();
    assert_eq!(set.len(), 3);
    let g = net.devs[0].node.t.groups.get(&chat).unwrap();
    assert!(g.cycle.is_empty());
    let _ = FrozenScan {
        list: None,
        live_until: 0,
        forget_at: 0,
    };
}

#[test]
/// D.23 and D.37, settled: one unreadable entry makes the whole page malformed; nothing of
/// it is used, its sender is penalised once, and the page does not end the scan as final.
fn a_page_with_an_unreadable_entry_is_malformed_whole() {
    use prost::Message;

    use crate::wire::proto;
    let mut net = Net::new(3, 1);
    let chat = net.chat();
    let s = start(&mut net, 1);
    let (sid, _) = asked(&s);
    let entry = |id: Vec<u8>| proto::Entry {
        chat_id: chat.as_bytes().to_vec(),
        kind: 0,
        id,
    };
    let page = proto::Page {
        scan_id: sid.as_bytes().to_vec(),
        offset: 0,
        count: 2,
        entries: vec![
            entry(vec![1; 5]),
            entry(EventId::new(T0, [7; 16]).as_bytes().to_vec()),
        ],
    };
    let r = proto::Response {
        request_id: s.rid.as_bytes().to_vec(),
        idx: s.idx,
        result: Some(proto::ResponseResult::Page(page)),
    };
    let frame = proto::Frame {
        kind: Some(proto::FrameKind::Response(r)),
    };
    let container = proto::Container {
        frames: vec![frame.encode_to_vec()],
    };
    let mut pt = vec![1u8];
    pt.extend(container.encode_to_vec());
    net.recv(0, member(1), &pt);
    assert!(net.devs[0].node.score(&member(1)) < 500_000);
    assert_eq!(net.devs[0].node.t.tasks.len(), 0, "nothing of it is used");
    assert_eq!(net.devs[0].node.stats.scans_completed, 0);
}
