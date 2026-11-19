//! §11.3, §12.4, §12.5, §13.3, §13.4, §13.7, §13.8: answering queries.

use prost::Message;

use super::*;
use crate::node::timing::{MAX_TTL_MS, REQUEST_BURST};
use crate::wire::proto;

fn answers_to(net: &mut Net, d: usize, peer: usize) -> Vec<Response> {
    net.poll_frames(d)
        .remove(&member(peer))
        .map(|f| responses(&f))
        .unwrap_or_default()
}

fn lookup(chat: ChatId, id: EventId) -> QueryOp {
    QueryOp::Event {
        chat_id: chat,
        event_id: id,
    }
}

#[test]
fn queries_with_bad_timing_are_ignored_whole() {
    let mut net = Net::new(3, 1);
    let chat = net.chat();
    let id = EventId::new(T0, [5; 16]);
    for (sent_at, ttl) in [(T0, 0), (T0, MAX_TTL_MS + 1), (T0 + 5 * MIN + 1, MIN)] {
        net.recv_frames(
            0,
            member(1),
            &[query(1, sent_at, ttl, vec![lookup(chat, id)])],
        );
        assert!(answers_to(&mut net, 0, 1).is_empty(), "{sent_at} {ttl}");
    }
    net.recv_frames(
        0,
        member(1),
        &[query(1, T0 + 5 * MIN, MAX_TTL_MS, vec![lookup(chat, id)])],
    );
    assert_eq!(answers_to(&mut net, 0, 1).len(), 1);
}

#[test]
fn a_query_past_its_receiver_deadline_is_answered_expired() {
    let mut net = Net::new(3, 1);
    let chat = net.chat();
    let e = net.event(T0, 5, &[], 1);
    net.give(0, 1, &e);
    net.poll(0);
    net.now = T0 + 10 * HOUR;
    // now > sent_at + 1.05 × ttl + 5 min.
    net.recv_frames(
        0,
        member(2),
        &[query(
            1,
            net.now - 69 * MIN,
            HOUR,
            vec![lookup(chat, e.event_id())],
        )],
    );
    let r = answers_to(&mut net, 0, 2);
    assert_eq!(status(&r[0]), Some(Status::Expired));
    // An answer that waits in the queue past the deadline becomes `expired` too.
    let sent_at = net.now;
    net.recv_frames(
        0,
        member(2),
        &[query(2, sent_at, MIN, vec![lookup(chat, e.event_id())])],
    );
    net.now = sent_at + 2 * HOUR;
    let r = answers_to(&mut net, 0, 2);
    assert_eq!(status(&r[0]), Some(Status::Expired));
}

#[test]
fn the_request_budget_answers_busy_beyond_its_burst() {
    let mut net = Net::new(3, 1);
    let chat = net.chat();
    let mut frames = Vec::new();
    for q in 0..9u8 {
        let ops = (0..16u8)
            .map(|i| {
                lookup(
                    chat,
                    EventId::new(T0, [q, i, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1]),
                )
            })
            .collect();
        frames.push(query(q, T0, MIN, ops));
    }
    net.recv_frames(0, member(1), &frames);
    let r = answers_to(&mut net, 0, 1);
    assert_eq!(r.len(), 9 * 16);
    let busy = r.iter().filter(|r| status(r) == Some(Status::Busy)).count();
    assert_eq!(busy, 9 * 16 - REQUEST_BURST as usize);
    // 16 entries per minute come back.
    net.now += MIN;
    let ops = (0..16u8)
        .map(|i| {
            lookup(
                chat,
                EventId::new(T0, [9, i, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1]),
            )
        })
        .collect();
    net.recv_frames(0, member(1), &[query(20, net.now, MIN, ops)]);
    let r = answers_to(&mut net, 0, 1);
    assert!(r.iter().all(|r| status(r) == Some(Status::NotAvailable)));
}

#[test]
fn queries_from_non_members_and_for_unknown_epochs_are_dropped_silently() {
    let mut net = Net::new(3, 1);
    let chat = net.chat();
    let id = EventId::new(T0, [5; 16]);
    let outsider = GossipId::from_bytes([0x77; 32]);
    net.recv_frames(0, outsider, &[query(1, T0, MIN, vec![lookup(chat, id)])]);
    assert!(net.poll(0).is_empty());
    net.recv_frames(
        0,
        member(1),
        &[query(
            1,
            T0,
            MIN,
            vec![lookup(ChatId::from_bytes([9; 32]), id)],
        )],
    );
    assert!(net.poll(0).is_empty());
    // Nothing was allocated for them.
    assert!(net.devs[0].node.t.peers.get(&outsider).is_none());
}

#[test]
fn a_malformed_entry_is_answered_malformed_at_its_own_index() {
    let mut net = Net::new(3, 1);
    let chat = net.chat();
    let e = net.event(T0, 5, &[], 1);
    net.give(0, 1, &e);
    net.poll(0);
    let good_bytes = proto::QueryEntry {
        op: Some(proto::QueryOp::EventLookup(proto::EventLookup {
            chat_id: chat.as_bytes().to_vec(),
            event_id: e.event_id().as_bytes().to_vec(),
        })),
    }
    .encode_to_vec();
    let q = proto::Query {
        request_id: vec![3; 16],
        sent_at: T0,
        ttl: MIN,
        entries: vec![vec![0x1a, 0x02, 0x0a, 0x01, 0x00], good_bytes],
    };
    let frame = proto::Frame {
        kind: Some(proto::FrameKind::Query(q)),
    };
    let container = proto::Container {
        frames: vec![frame.encode_to_vec()],
    };
    let mut pt = vec![1u8];
    pt.extend(container.encode_to_vec());
    net.recv(0, member(2), &pt);
    let r = answers_to(&mut net, 0, 2);
    let by_idx: BTreeMap<u32, &Response> = r.iter().map(|r| (r.idx, r)).collect();
    assert_eq!(status(by_idx[&0]), Some(Status::Malformed));
    assert_eq!(answer_event(by_idx[&1]).unwrap().event_id(), e.event_id());
}

#[test]
fn an_event_lookup_returns_exactly_that_event_or_not_available() {
    let mut net = Net::new(3, 1);
    let chat = net.chat();
    let e = net.event(T0, 5, &[], 1);
    net.give(0, 1, &e);
    net.poll(0);
    let other = EventId::new(T0, [6; 16]);
    net.recv_frames(
        0,
        member(2),
        &[query(
            1,
            T0,
            MIN,
            vec![lookup(chat, e.event_id()), lookup(chat, other)],
        )],
    );
    let r = answers_to(&mut net, 0, 2);
    let by_idx: BTreeMap<u32, &Response> = r.iter().map(|r| (r.idx, r)).collect();
    assert_eq!(answer_event(by_idx[&0]).unwrap(), e);
    assert_eq!(status(by_idx[&1]), Some(Status::NotAvailable));
}

#[test]
fn a_sync_object_lookup_returns_a_carrier_of_the_current_result() {
    let mut net = Net::new(3, 1);
    let chat = net.chat();
    let e = net.event(T0, 5, &[], 1);
    net.give(0, 1, &e);
    net.poll(0);
    let sync = SyncObjId::from_bytes([5; 32]);
    let op = QueryOp::SyncObj {
        chat_id: chat,
        sync_obj_id: sync,
    };
    net.recv_frames(0, member(2), &[query(1, T0, MIN, vec![op.clone()])]);
    assert_eq!(answer_event(&answers_to(&mut net, 0, 2)[0]).unwrap(), e);
    // After a local-only edit no carrier is available: "not available", although the
    // message is still displayed, and nothing is created or restored to answer.
    net.now = T0 + 1;
    let now = net.now;
    let dev = &mut net.devs[0];
    dev.node
        .local_edit(
            &mut dev.store,
            chat,
            sync,
            crate::LocalEdit {
                body: Some(Body::Text("x".into())),
                ..Default::default()
            },
            now,
            &mut net.rng,
        )
        .unwrap();
    net.recv_frames(0, member(2), &[query(2, now, MIN, vec![op])]);
    assert_eq!(
        status(&answers_to(&mut net, 0, 2)[0]),
        Some(Status::NotAvailable)
    );
}

#[test]
fn operations_of_milestone_four_are_counted_and_not_answered() {
    let mut net = Net::new(3, 1);
    let chat = net.chat();
    let ops = vec![
        QueryOp::ChatById(chat),
        QueryOp::Keys {
            chat_id: chat,
            gossip_id: member(1),
        },
        QueryOp::SharedChatsScan {
            scan_id: scan_id(1),
            offset: 0,
        },
        QueryOp::Removal {
            chat_id: chat,
            gossip_id: member(1),
        },
        QueryOp::SignedObject {
            chat_id: chat,
            kind: crate::wire::SignedKind::Leave,
            id: [1; 32],
        },
    ];
    net.recv_frames(0, member(1), &[query(1, T0, MIN, ops)]);
    assert!(net.poll(0).is_empty());
    let nh = &net.devs[0].node.stats.not_handled;
    assert_eq!(nh.values().sum::<u64>(), 5);
    assert_eq!(nh[&NotHandled::KeyQuery], 1);
}

#[test]
fn a_higher_version_gets_one_version_notice_per_day() {
    let mut net = Net::new(3, 1);
    let higher = [2u8, 0];
    net.recv(0, member(1), &higher);
    let out = net.poll(0);
    assert_eq!(out.len(), 1);
    assert_eq!(out[0].1, wire::version_notice());
    net.recv(0, member(1), &higher);
    assert!(net.poll(0).is_empty());
    net.now += DAY;
    net.recv(0, member(1), &higher);
    assert_eq!(net.poll(0).len(), 1);
    // A lower version, and a non-member, get nothing.
    net.recv(0, member(1), &[0u8]);
    net.recv(0, GossipId::from_bytes([0x77; 32]), &higher);
    assert!(net.poll(0).is_empty());
    // The version notice of a peer records its version.
    net.recv(0, member(2), &wire::version_notice());
    assert_eq!(
        net.devs[0].node.t.peers.get(&member(2)).unwrap().version,
        Some(1)
    );
}

#[test]
fn an_unparseable_frame_from_a_member_is_penalised() {
    let mut net = Net::new(3, 1);
    let container = proto::Container {
        frames: vec![vec![0xff, 0xff]],
    };
    let mut pt = vec![1u8];
    pt.extend(container.encode_to_vec());
    net.recv(0, member(1), &pt);
    assert!(net.devs[0].node.score(&member(1)) < 500_000);
}

#[test]
fn a_notice_with_skipped_entries_is_penalised_and_its_valid_entries_used() {
    let mut net = Net::new(3, 1);
    let chat = net.chat();
    let n = proto::Notice {
        entries: vec![
            proto::Entry {
                chat_id: chat.as_bytes().to_vec(),
                kind: 0,
                id: vec![1; 5],
            },
            proto::Entry {
                chat_id: chat.as_bytes().to_vec(),
                kind: 0,
                id: EventId::new(T0, [5; 16]).as_bytes().to_vec(),
            },
        ],
    };
    let frame = proto::Frame {
        kind: Some(proto::FrameKind::Notice(n)),
    };
    let container = proto::Container {
        frames: vec![frame.encode_to_vec()],
    };
    let mut pt = vec![1u8];
    pt.extend(container.encode_to_vec());
    net.recv(0, member(1), &pt);
    assert!(net.devs[0].node.score(&member(1)) < 500_000);
    assert_eq!(net.devs[0].node.t.tasks.len(), 1);
}

#[test]
fn notices_of_other_kinds_are_counted_as_not_handled() {
    let mut net = Net::new(3, 1);
    let chat = net.chat();
    net.recv_frames(
        0,
        member(1),
        &[Frame::Notice(Notice {
            entries: vec![
                Entry {
                    chat_id: chat,
                    item: EntryItem::Root,
                },
                Entry {
                    chat_id: chat,
                    item: EntryItem::Leave(crate::LeaveId::from_bytes([1; 32])),
                },
            ],
            skipped: 0,
        })],
    );
    let nh = &net.devs[0].node.stats.not_handled;
    assert_eq!(nh[&NotHandled::RootNotice], 1);
    assert_eq!(nh[&NotHandled::SignedObjectNotice], 1);
}

#[test]
fn a_leave_request_is_not_handled_yet() {
    let mut net = Net::new(3, 1);
    let chat = net.chat();
    net.recv_frames(
        0,
        member(1),
        &[Frame::LeaveRequest(crate::wire::LeaveRequest {
            chat_id: chat,
        })],
    );
    assert_eq!(
        net.devs[0].node.stats.not_handled[&NotHandled::LeaveRequest],
        1
    );
    assert!(net.poll(0).is_empty());
}
