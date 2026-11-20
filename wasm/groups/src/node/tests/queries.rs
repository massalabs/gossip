//! §11.3, §12.4, §12.5, §13.3, §13.4, §13.7, §13.8: answering queries.

use prost::Message;

use super::*;
use crate::constants::MAX_TTL_MS;
use crate::node::timing::REQUEST_BURST;
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
fn membership_queries_are_answered_and_strangers_ignored() {
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
    net.recv_frames(0, member(1), &[query(1, T0, MIN, ops.clone())]);
    let answers: Vec<(u32, ResponseResult)> = net
        .poll_frames(0)
        .remove(&member(1))
        .unwrap()
        .into_iter()
        .filter_map(|f| match f {
            Frame::Response(r) => Some((r.idx, r.result)),
            _ => None,
        })
        .collect();
    assert_eq!(answers.len(), 5);
    for (idx, r) in &answers {
        match idx {
            // The root, to a member of it.
            0 => assert!(matches!(r, ResponseResult::Event(_))),
            // The shared epochs: this one.
            2 => match r {
                ResponseResult::Page(p) => assert_eq!(p.entries.len(), 1),
                other => panic!("{other:?}"),
            },
            // No keys, no kick, no leave held.
            _ => assert_eq!(*r, ResponseResult::Status(Status::NotAvailable)),
        }
    }
    // A stranger gets nothing at all for operations without an epoch context.
    net.recv_frames(
        0,
        GossipId::from_bytes([0x77; 32]),
        &[query(2, T0, MIN, ops)],
    );
    assert!(net.poll(0).is_empty());
}

impl Net {
    /// Device `d` declares (or clears) `peer` as a contact its user accepted.
    fn contact(&mut self, d: usize, peer: GossipId, accepted: bool) {
        let now = self.now;
        let dev = &mut self.devs[d];
        dev.node
            .set_accepted_contact(&mut dev.store, peer, accepted, now, &mut self.rng)
            .unwrap();
    }

    fn restart_node(&mut self, d: usize) {
        let dev = &mut self.devs[d];
        dev.node = Node::open(&dev.store, member(d)).unwrap();
    }
}

/// A plaintext of wire version `v` and `len` bytes in all, whatever follows the prefix.
fn of_version(v: u64, len: usize) -> Vec<u8> {
    let mut pt = Vec::new();
    prost::encoding::encode_varint(v, &mut pt);
    pt.resize(len.max(pt.len()), 0);
    pt
}

/// §13.8: a plaintext of a higher version is answered with one version notice, at most once
/// per peer and version per 24 hours, and only to a contact the user accepted, whether or not
/// it shares a group; never a penalty.
#[test]
fn a_higher_version_from_an_accepted_contact_gets_one_version_notice_per_day() {
    let mut net = Net::new(3, 1);
    let stranger = GossipId::from_bytes([0x77; 32]);
    net.contact(0, stranger, true);
    net.restart_node(0);
    assert_eq!(net.devs[0].node.accepted_contacts(), vec![stranger]);
    let higher = of_version(2, 2);
    net.recv(0, stranger, &higher);
    let out = net.poll(0);
    assert_eq!(out, vec![(stranger, wire::version_notice())]);
    net.recv(0, stranger, &higher);
    assert!(net.poll(0).is_empty());
    net.now += DAY;
    net.recv(0, stranger, &higher);
    assert_eq!(net.poll(0).len(), 1);
    // Larger than any version-1 plaintext may be: the prefix is read first.
    net.recv(
        0,
        stranger,
        &of_version(3, crate::constants::MAX_PLAINTEXT_BYTES + 10),
    );
    assert_eq!(net.poll(0), vec![(stranger, wire::version_notice())]);
    // Cleared: nothing more.
    net.contact(0, stranger, false);
    net.now += DAY;
    net.recv(0, stranger, &higher);
    assert!(net.poll(0).is_empty());
    assert_eq!(net.devs[0].node.score(&stranger), 500_000);
}

/// No version notice for a co-member that is no accepted contact (its connection is
/// automatic), nor for an unknown peer, nor for a lower version; no penalty either way.
#[test]
fn a_higher_version_from_anyone_else_gets_silence() {
    let mut net = Net::new(3, 1);
    let before = net.devs[0].node.score(&member(1));
    net.recv(0, member(1), &of_version(2, 2));
    net.recv(0, GossipId::from_bytes([0x77; 32]), &of_version(2, 2));
    net.contact(0, member(2), true);
    net.recv(0, member(2), &of_version(0, 2));
    assert!(net.poll(0).is_empty());
    assert_eq!(net.devs[0].node.score(&member(1)), before);
    assert_eq!(net.devs[0].node.score(&member(2)), before);
}

/// A peer cycling through version numbers gets at most a few notices a day, and the device
/// remembers a bounded number of versions for it.
#[test]
fn a_peer_cycling_versions_gets_a_bounded_number_of_notices() {
    let mut net = Net::new(3, 1);
    net.contact(0, member(2), true);
    let mut sent = 0;
    for v in 2..300u64 {
        net.recv(0, member(2), &of_version(v, 2));
        sent += net.poll(0).len();
    }
    assert_eq!(sent, crate::node::timing::VERSION_NOTICES_PER_PEER);
    let remembered = net.devs[0]
        .node
        .t
        .peers
        .get(&member(2))
        .map_or(0, |r| r.version_notices.len());
    assert!(remembered <= crate::node::timing::VERSION_NOTICES_PER_PEER);
    net.now += DAY;
    for v in 300..310u64 {
        net.recv(0, member(2), &of_version(v, 2));
        sent += net.poll(0).len();
    }
    assert_eq!(sent, 2 * crate::node::timing::VERSION_NOTICES_PER_PEER);
}

/// A version-1 plaintext that is merely malformed gets no notice: it is rejected, and a
/// member that sends it is penalised as before.
#[test]
fn a_malformed_version_one_plaintext_gets_no_notice() {
    let mut net = Net::new(3, 1);
    net.contact(0, member(1), true);
    let container = proto::Container {
        frames: vec![vec![0xff, 0xff]],
    };
    let mut pt = vec![1u8];
    pt.extend(container.encode_to_vec());
    net.recv(0, member(1), &pt);
    assert!(net.poll(0).is_empty());
    assert!(net.devs[0].node.score(&member(1)) < 500_000);
}

/// A version notice received, solicited or not, from any peer in any state, changes nothing
/// but the version recorded for a peer that shares a group, and is never a penalty.
#[test]
fn a_version_notice_received_is_never_an_error() {
    let mut net = Net::new(3, 1);
    let stranger = GossipId::from_bytes([0x77; 32]);
    for from in [member(1), member(2), stranger] {
        let before = net.devs[0].node.score(&from);
        net.recv(0, from, &wire::version_notice());
        net.recv(0, from, &wire::version_notice());
        assert_eq!(net.devs[0].node.score(&from), before);
    }
    assert!(net.poll(0).is_empty());
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
/// D.23, settled: one unreadable entry makes the whole notice malformed; nothing of it is
/// used, and its sender is penalised once.
fn a_notice_with_an_unreadable_entry_is_malformed_whole() {
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
    let invalid = net.devs[0].node.stats().invalid;
    net.recv(0, member(1), &pt);
    assert!(net.devs[0].node.score(&member(1)) < 500_000);
    assert_eq!(
        net.devs[0].node.stats().invalid,
        invalid + 1,
        "penalised once"
    );
    assert_eq!(net.devs[0].node.t.tasks.len(), 0, "nothing of it is used");
}

#[test]
fn a_notice_of_a_held_root_or_an_unknown_leave_fetches_nothing() {
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
    assert_eq!(net.devs[0].node.t.tasks.len(), 0);
    // An unknown root is fetched from its announcer.
    let other = ChatId::from_bytes([0x33; 32]);
    net.recv_frames(
        0,
        member(1),
        &[Frame::Notice(Notice {
            entries: vec![Entry {
                chat_id: other,
                item: EntryItem::Root,
            }],
            skipped: 0,
        })],
    );
    let sent = net.poll_frames(0);
    let asked = sent[&member(1)].iter().any(|f| {
        matches!(f, Frame::Query(q) if q.entries.contains(&QueryEntry::Op(QueryOp::ChatById(other))))
    });
    assert!(asked);
}

#[test]
fn the_owner_takes_a_leave_request_from_a_member() {
    let mut net = Net::new(3, 1);
    let chat = net.chat();
    net.recv_frames(
        0,
        member(1),
        &[Frame::LeaveRequest(crate::wire::LeaveRequest {
            chat_id: chat,
        })],
    );
    let g = net.devs[0].node.t.group_recs.get(&chat).unwrap();
    assert!(g.pending_removals.contains_key(&member(1)));
    assert!(net.poll(0).is_empty());
    // A stranger's request is ignored.
    net.recv_frames(
        0,
        GossipId::from_bytes([0x77; 32]),
        &[Frame::LeaveRequest(crate::wire::LeaveRequest {
            chat_id: chat,
        })],
    );
    assert_eq!(
        net.devs[0]
            .node
            .t
            .group_recs
            .get(&chat)
            .unwrap()
            .pending_removals
            .len(),
        1
    );
}
