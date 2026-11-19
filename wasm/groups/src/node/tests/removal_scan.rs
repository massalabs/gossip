//! A removed member that lost everything learns of the chat and of its removal from a
//! shared-chats scan of a member that stayed (§4.11, §12.6, §12.7, §5.6, D.74): the scan lists
//! the last epoch that lists it, a chat lookup for that root is answered with the root and the
//! kick or leave naming it, and nothing of a later epoch is given.

use super::membership::{MNet, answers_of, founded, gid, ident, signer};
use super::*;
use crate::node::records::ChangeKind;
use crate::store::MemoryStorage;
use crate::wire::SignedKind;

/// Device `d` loses everything and starts again with the keys of every device.
fn reinstall(net: &mut MNet, d: usize) {
    let store = MemoryStorage::new();
    net.devs[d] = Dev {
        node: Node::open(&store, gid(d)).unwrap(),
        store,
    };
    for k in 0..net.devs.len() {
        let bytes = ident(k).public.to_bytes();
        let now = net.now;
        let dev = &mut net.devs[d];
        dev.node
            .learn_keys(&mut dev.store, &bytes, now, &mut net.rng)
            .unwrap();
    }
}

fn scan(net: &mut MNet, d: usize, peer: usize) {
    let now = net.now;
    let dev = &mut net.devs[d];
    dev.node
        .scan_shared_chats(&mut dev.store, gid(peer), now, &mut net.rng)
        .unwrap();
}

/// Everything device `d` sends to `from` in answer to the query `ops`.
fn frames_to(net: &mut MNet, d: usize, from: usize, ops: Vec<QueryOp>) -> Vec<Frame> {
    net.recv_frames_m(d, from, &[query(9, net.now, MIN, ops)]);
    let now = net.now;
    let dev = &mut net.devs[d];
    let out = dev
        .node
        .poll_outbox(&mut dev.store, now, &mut net.rng)
        .unwrap();
    let mut all = Vec::new();
    for o in out {
        let dev = &mut net.devs[d];
        dev.node
            .handed_off(&mut dev.store, o.handle, now, &mut net.rng)
            .unwrap();
        if o.to == gid(from) {
            all.extend(frames(&o.plaintext));
        }
    }
    all
}

fn changes(net: &mut MNet, d: usize) -> Vec<Change> {
    let now = net.now;
    let dev = &mut net.devs[d];
    dev.node
        .take_changes(&mut dev.store, now, &mut net.rng)
        .unwrap()
}

/// Owner 0, members 1 to 3; member 3 is removed from `g` by a kick (or leaves it by a signed
/// leave) and the owner's successor `e2` drops it. Returns the network, `g` and `e2`.
fn removed_from(leave: bool) -> (MNet, ChatId, ChatId) {
    let (mut net, g) = founded(4);
    net.say(1, &g, "before");
    net.run(MIN);
    if leave {
        let now = net.now;
        let s = signer(3);
        let dev = &mut net.devs[3];
        dev.node
            .leave_group(
                &mut dev.store,
                &s,
                g,
                LeaveChoice::Signed,
                now,
                &mut net.rng,
            )
            .unwrap();
    } else {
        net.change(
            0,
            g,
            GroupChange::Successor {
                add: vec![],
                remove: vec![gid(3)],
                name: None,
            },
        )
        .unwrap();
    }
    net.run(2 * MIN);
    let e2 = net.current(0, &g).unwrap();
    assert_ne!(e2, g);
    assert!(!net.devs[0].node.root(&e2).unwrap().is_member(&gid(3)));
    (net, g, e2)
}

fn learns_its_removal(leave: bool) {
    let (mut net, g, e2) = removed_from(leave);
    // The scan of a member that stayed lists the last epoch that lists the removed member.
    assert_eq!(net.devs[1].node.shared_epochs(&gid(3)), vec![g]);
    reinstall(&mut net, 3);
    scan(&mut net, 3, 1);
    net.run(3 * MIN);
    let s = net.summary(3, &g).expect("the group is back");
    let (status, line) = if leave {
        (MyStatus::Left, TimelineLine::YouLeft)
    } else {
        (MyStatus::Removed, TimelineLine::YouWereRemoved)
    };
    assert_eq!(s.status, status);
    assert_eq!(s.current, g);
    assert!(net.lines(3, &g).contains(&line), "{:?}", net.lines(3, &g));
    // No invitation, no prompt, no history, nothing of the later epoch.
    assert!(net.devs[3].node.invitations(net.now).is_empty());
    assert!(
        !changes(&mut net, 3)
            .iter()
            .any(|c| c.kind == ChangeKind::Invitation)
    );
    assert!(net.texts(3, &g).is_empty());
    assert!(net.devs[3].node.root(&e2).is_none());
    assert_eq!(net.devs[3].node.groups().len(), 1);
    // No failed announcement against the member that listed it.
    assert_eq!(net.devs[3].node.stats().failed_announcements, 0);
    // The member that answered stays as it was.
    assert_eq!(net.summary(1, &g).unwrap().current, e2);
}

#[test]
fn a_reinstalled_member_learns_its_kick_from_a_scan() {
    learns_its_removal(false);
}

#[test]
fn a_reinstalled_member_learns_its_leave_from_a_scan() {
    learns_its_removal(true);
}

/// The kick did not come with the root (the replies of the day are spent here): the device
/// gets it by a removal lookup, and is not prompted meanwhile.
#[test]
fn a_root_without_its_kick_is_completed_by_a_removal_lookup() {
    let (mut net, g, _) = removed_from(false);
    // Three chat lookups by the removed member spend the replies of the day.
    for _ in 0..3 {
        let a = answers_of(&mut net, 1, 3, vec![QueryOp::ChatById(g)]);
        assert!(matches!(a[0].1, ResponseResult::Event(_)));
        net.exchange();
    }
    reinstall(&mut net, 3);
    scan(&mut net, 3, 1);
    net.run(3 * MIN);
    assert_eq!(net.summary(3, &g).unwrap().status, MyStatus::Removed);
    assert!(net.devs[3].node.invitations(net.now).is_empty());
    assert!(
        !changes(&mut net, 3)
            .iter()
            .any(|c| c.kind == ChangeKind::Invitation)
    );
    assert_eq!(net.devs[3].node.stats().failed_announcements, 0);
}

/// What a removed member is answered: the root of the last epoch that lists it with its own
/// removal, and nothing of a later epoch or of another member.
#[test]
fn a_removed_member_gets_nothing_of_a_later_epoch() {
    let (mut net, g, e2) = removed_from(false);
    // Member 2 is removed in a later epoch too: its kick names `e2`, which member 3 is not in.
    let e3 = net
        .change(
            0,
            e2,
            GroupChange::Successor {
                add: vec![],
                remove: vec![gid(2)],
                name: None,
            },
        )
        .unwrap();
    net.run(2 * MIN);
    let kick_of = |chat: &ChatId, m: usize| *crate::hash::kick_id(chat, &gid(m)).as_bytes();
    let probes = vec![
        QueryOp::ChatById(g),
        QueryOp::ChatById(e2),
        QueryOp::ChatById(e3),
        QueryOp::ChatByRef(net.devs[1].node.root(&e2).unwrap().ref_chat_id()),
        QueryOp::SignedObject {
            chat_id: e2,
            kind: SignedKind::Kick,
            id: kick_of(&e2, 2),
        },
        QueryOp::Removal {
            chat_id: e2,
            gossip_id: gid(2),
        },
        QueryOp::Removal {
            chat_id: g,
            gossip_id: gid(2),
        },
        QueryOp::SharedChatsScan {
            scan_id: crate::ids::ScanId::from_bytes([5; 32]),
            offset: 0,
        },
    ];
    let sent = frames_to(&mut net, 1, 3, probes);
    let at = |i: u32| {
        sent.iter()
            .filter_map(|f| match f {
                Frame::Response(r) if r.idx == i => Some(r.result.clone()),
                _ => None,
            })
            .collect::<Vec<_>>()
    };
    assert!(
        matches!(&at(0)[..], [ResponseResult::Event(b)] if matches!(
            wire::decode_event_blob(b, 1),
            Ok(EventObject::Root(r)) if r.chat_id() == g
        )),
        "the root of the last epoch that lists it: {:?}",
        at(0)
    );
    // Not available, or not answered at all (the signed objects of an epoch it is not in).
    for i in 1..=6 {
        assert!(
            at(i)
                .iter()
                .all(|r| *r == ResponseResult::Status(Status::NotAvailable)),
            "probe {i}: {:?}",
            at(i)
        );
    }
    match &at(7)[..] {
        [ResponseResult::Page(p)] => {
            let listed: Vec<ChatId> = p.entries.iter().map(|e| e.chat_id).collect();
            assert_eq!(listed, vec![g]);
        }
        other => panic!("{other:?}"),
    }
    // Its own kick goes with the root, and no other object.
    let objects: Vec<EventObject> = sent
        .iter()
        .filter_map(|f| match f {
            Frame::Event(b) => Some(wire::decode_event_blob(b, 1).unwrap()),
            _ => None,
        })
        .collect();
    assert_eq!(objects.len(), 1, "{objects:?}");
    assert!(
        matches!(&objects[0], EventObject::Kick(k) if k.chat_id() == g && k.removed() == gid(3)),
        "{objects:?}"
    );
}

/// A shared-chats scan answers `restart` when an epoch it listed stops being listable while
/// the scan is in progress (§4.11): a later page never names an epoch the responder has
/// closed since.
#[test]
fn a_shared_chats_scan_restarts_when_a_listed_epoch_is_closed() {
    let (mut net, g) = founded(3);
    let g2 = net.create(2, &[1]);
    net.exchange();
    net.accept_all(1);
    net.run(MIN);
    let scan_id = crate::ids::ScanId::from_bytes([6; 32]);
    let mut listed = vec![g, g2];
    listed.sort();
    assert_eq!(net.devs[1].node.shared_epochs(&gid(2)), listed);
    // The scan is received and its list frozen; the responder leaves one of the groups
    // before the page goes out: the page is not sent, the scan restarts.
    let ask = query(
        9,
        net.now,
        MIN,
        vec![QueryOp::SharedChatsScan { scan_id, offset: 0 }],
    );
    net.recv_frames_m(1, 2, &[ask]);
    let now = net.now;
    let s = signer(1);
    let dev = &mut net.devs[1];
    dev.node
        .leave_group(
            &mut dev.store,
            &s,
            g2,
            LeaveChoice::Signed,
            now,
            &mut net.rng,
        )
        .unwrap();
    let sent = frames_to(&mut net, 1, 2, vec![]);
    let results: Vec<ResponseResult> = sent
        .into_iter()
        .filter_map(|f| match f {
            Frame::Response(r) => Some(r.result),
            _ => None,
        })
        .collect();
    assert_eq!(results, vec![ResponseResult::Status(Status::Restart)]);
    // The same scan continued is told to restart too.
    let again = answers_of(
        &mut net,
        1,
        2,
        vec![QueryOp::SharedChatsScan { scan_id, offset: 1 }],
    );
    assert_eq!(again[0].1, ResponseResult::Status(Status::Restart));
    // A new scan lists what is listable now.
    let fresh = crate::ids::ScanId::from_bytes([7; 32]);
    match answers_of(
        &mut net,
        1,
        2,
        vec![QueryOp::SharedChatsScan {
            scan_id: fresh,
            offset: 0,
        }],
    )
    .remove(0)
    .1
    {
        ResponseResult::Page(p) => {
            assert_eq!(
                p.entries.iter().map(|e| e.chat_id).collect::<Vec<_>>(),
                vec![g]
            );
        }
        other => panic!("{other:?}"),
    }
}
