//! A device that holds an epoch but is no longer active in its group starts nothing for it
//! (§10.4, D.74): no lookup, no parent lookup, no fetch, whatever a member announces, and
//! what was pending when the group went inactive stops. A member must not be able to tell
//! such a device from one that deleted the chat or never held it.

use super::membership::{MNet, gid, signer};
use super::*;

/// The ways a device stops being active in a group while it keeps its epoch.
#[derive(Debug, Clone, Copy)]
enum Inactive {
    Removed,
    Left,
    Waiting,
    Dissolved,
}

const ALL: [Inactive; 4] = [
    Inactive::Removed,
    Inactive::Left,
    Inactive::Waiting,
    Inactive::Dissolved,
];

/// The device R and the member Q that probes it.
const R: usize = 1;
const Q: usize = 3;

/// A = {0, 1, 2, 3} is active on R and Q. C = {0, 1, 3} is held by R, inactive the way given;
/// D = {0, 1, 3} was deleted by R ("Delete", only markers left); E = {0, 3} was never held by R.
/// Returns `(net, [C, D, E, A])`. With `before`, run on R while C is still active (for the pending
/// lookups of the transition).
fn setup(how: Inactive, before: impl FnOnce(&mut MNet, ChatId)) -> (MNet, [ChatId; 4]) {
    let mut net = MNet::new(5, true);
    let a = net.create(0, &[1, 2, 3]);
    let c = net.create(0, &[1, 3]);
    let d = net.create(0, &[1, 3]);
    let e = net.create(0, &[3]);
    net.exchange();
    for m in 1..4 {
        net.accept_all(m);
    }
    net.run(2 * MIN);
    assert!(net.summary(R, &a).is_some());
    let now = net.now;
    let dev = &mut net.devs[R];
    dev.node
        .delete_group(&mut dev.store, d, now, &mut net.rng)
        .unwrap();
    net.run(MIN);
    net.say(Q, &c, "before");
    net.run(MIN);
    match how {
        Inactive::Removed => {
            before(&mut net, c);
            net.change(
                0,
                c,
                GroupChange::Successor {
                    add: vec![],
                    remove: vec![gid(R)],
                    name: None,
                },
            )
            .unwrap();
            net.exchange();
        }
        Inactive::Left => {
            // Restored from a backup made before its leave, it learns it and keeps the group
            // read-only.
            let backup = net.devs[R].store.clone();
            let now = net.now;
            let s = signer(R);
            let dev = &mut net.devs[R];
            dev.node
                .leave_group(
                    &mut dev.store,
                    &s,
                    c,
                    LeaveChoice::Signed,
                    now,
                    &mut net.rng,
                )
                .unwrap();
            net.run(2 * MIN);
            net.devs[R].store = backup;
            net.restart(R);
            before(&mut net, c);
            net.say(R, &c, "back");
            net.run(2 * MIN);
        }
        Inactive::Waiting => {
            net.offline[0] = true;
            before(&mut net, c);
            let now = net.now;
            let s = signer(R);
            let dev = &mut net.devs[R];
            dev.node
                .leave_group(
                    &mut dev.store,
                    &s,
                    c,
                    LeaveChoice::AskToBeKicked,
                    now,
                    &mut net.rng,
                )
                .unwrap();
            net.run(MIN);
        }
        Inactive::Dissolved => {
            before(&mut net, c);
            let now = net.now;
            let s = signer(0);
            let dev = &mut net.devs[0];
            dev.node
                .dissolve_group(&mut dev.store, &s, c, false, now, &mut net.rng)
                .unwrap();
            net.exchange();
        }
    }
    let want = match how {
        Inactive::Removed => MyStatus::Removed,
        Inactive::Left => MyStatus::Left,
        Inactive::Waiting => MyStatus::Waiting,
        Inactive::Dissolved => MyStatus::Dissolved { deleted: false },
    };
    assert_eq!(net.summary(R, &c).unwrap().status, want, "{how:?}");
    assert!(net.summary(R, &a).is_some(), "{how:?}: A stays active");
    assert!(net.summary(R, &e).is_none() && net.summary(Q, &e).is_some());
    (net, [c, d, e, a])
}

/// Everything R sends from now on for `hours`, delivered to nobody, ticking every minute: each
/// plaintext with its recipient, the 32 bytes of `chat` replaced by a fixed placeholder.
fn sent_by_r(net: &mut MNet, chat: ChatId, hours: u64) -> Vec<(GossipId, Vec<u8>)> {
    let mut out = Vec::new();
    for step in 0..=hours * 60 {
        if step > 0 {
            net.now += MIN;
            net.tick(R);
        }
        let now = net.now;
        let dev = &mut net.devs[R];
        let sent = dev
            .node
            .poll_outbox(&mut dev.store, now, &mut net.rng)
            .unwrap();
        for o in sent {
            let dev = &mut net.devs[R];
            dev.node
                .handed_off(&mut dev.store, o.handle, now, &mut net.rng)
                .unwrap();
            out.push((o.to, replace(&o.plaintext, chat.as_bytes(), &[0xC5; 32])));
        }
    }
    out
}

fn replace(bytes: &[u8], from: &[u8; 32], to: &[u8; 32]) -> Vec<u8> {
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i..].starts_with(from) {
            out.extend_from_slice(to);
            i += 32;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    out
}

fn contains(bytes: &[u8], chat: &ChatId) -> bool {
    bytes.windows(32).any(|w| w == chat.as_bytes())
}

/// The notice entry of each kind a member can send about `chat`.
fn entry(kind: &str, chat: ChatId, now: u64) -> Entry {
    let item = match kind {
        "event" => EntryItem::Event(EventId::new(now - 1, [0x66; 16])),
        "root" => EntryItem::Root,
        "kick" => EntryItem::Kick(crate::hash::kick_id(&chat, &gid(4))),
        // Q's own leave: live, so a device active in C would fetch it.
        "leave" => EntryItem::Leave(crate::hash::leave_id(&chat, &gid(Q))),
        "dissolve" => EntryItem::Dissolve(crate::hash::dissolve_id(&chat, true)),
        _ => unreachable!(),
    };
    Entry {
        chat_id: chat,
        item,
    }
}

const KINDS: [&str; 5] = ["event", "root", "kick", "leave", "dissolve"];

/// §10.4, D.74: Q, which shares the active chat A with R, sends R a notice naming C, an epoch
/// R holds in a group where it is no longer active, with a made-up item of each kind. Everything
/// R then sends, to anyone, for three hours, is the same, byte for byte (the chat ID aside), as
/// what it sends for the same notice naming D, which it deleted, and, but for a root notice,
/// naming an epoch it never held. A device that never held an epoch fetches a root a co-member
/// announces, where a device that holds it or deleted it does not (§16.7); that difference is
/// older and is not about an inactive group.
#[test]
fn an_inactive_device_starts_nothing_for_a_notice_naming_its_epoch() {
    let never = ChatId::from_bytes([0x77; 32]);
    let mut wrong = Vec::new();
    for how in ALL {
        for kind in KINDS {
            let probe = |target: &dyn Fn(ChatId, ChatId) -> ChatId| {
                let (mut net, [c, d, ..]) = setup(how, |_, _| {});
                let chat = target(c, d);
                let n = Frame::Notice(Notice {
                    entries: vec![entry(kind, chat, net.now)],
                });
                net.recv_frames_m(R, Q, &[n]);
                sent_by_r(&mut net, chat, 3)
            };
            let inactive = probe(&|c, _| c);
            let deleted = probe(&|_, d| d);
            if inactive != deleted {
                wrong.push((how, kind, "deleted"));
            }
            if kind != "root" && inactive != probe(&|_, _| never) {
                wrong.push((how, kind, "never held"));
            }
        }
    }
    assert!(
        wrong.is_empty(),
        "(status, notice, differs from): {wrong:?}"
    );
}

/// §10.4, D.74: what was pending in C when R stopped being active there stops at once: R had
/// asked Q for an event and a kick Q announced in C (Q took no answer back); from the moment
/// it is kicked, leaves, asks to be kicked or sees the group dissolved, nothing R sends names C,
/// for hours.
#[test]
fn an_inactive_device_stops_what_it_was_looking_up_in_the_epoch() {
    for how in ALL {
        let (mut net, [c, ..]) = setup(how, |net, c| {
            net.offline[Q] = true;
            let n = Frame::Notice(Notice {
                entries: vec![entry("event", c, net.now), entry("kick", c, net.now)],
            });
            net.recv_frames_m(R, Q, &[n]);
            let dropped = net.dropped.len();
            net.run(MIN);
            assert!(
                net.dropped[dropped..]
                    .iter()
                    .any(|(from, to, pt)| *from == R && *to == Q && contains(pt, &c)),
                "{how:?}: R asks Q while still active"
            );
        });
        let sent = sent_by_r(&mut net, never_replaced(), 6);
        let naming: Vec<GossipId> = sent
            .iter()
            .filter(|(_, pt)| contains(pt, &c))
            .map(|(to, _)| *to)
            .collect();
        assert!(naming.is_empty(), "{how:?}: R still names C to {naming:?}");
    }
}

/// A chat ID that appears nowhere: nothing is replaced.
fn never_replaced() -> ChatId {
    ChatId::from_bytes([0x13; 32])
}

/// §10.4, D.74: a lookup that waited while R was kicked from C goes on once R is added back and
/// accepts: R asks for the event again, which a scan might never bring back.
#[test]
fn a_lookup_that_waited_while_inactive_goes_on_once_the_device_is_back() {
    let (mut net, [c, ..]) = setup(Inactive::Removed, |net, c| {
        net.offline[Q] = true;
        let n = Frame::Notice(Notice {
            entries: vec![entry("event", c, net.now)],
        });
        net.recv_frames_m(R, Q, &[n]);
        net.run(MIN);
    });
    let asks = |net: &MNet, from: usize| {
        net.dropped[from..]
            .iter()
            .filter(|(f, to, pt)| *f == R && *to == Q && pt.windows(16).any(|w| w == [0x66; 16]))
            .count()
    };
    let before = net.dropped.len();
    net.run(3 * HOUR);
    assert_eq!(asks(&net, before), 0, "nothing while removed");
    let cur = net.current(0, &c).unwrap();
    net.change(
        0,
        cur,
        GroupChange::Successor {
            add: vec![gid(R)],
            remove: vec![],
            name: None,
        },
    )
    .unwrap();
    net.run(2 * MIN);
    assert_eq!(net.accept_all(R).len(), 1);
    net.run(10 * MIN);
    assert!(asks(&net, before) > 0, "R asks for the event again");
}

/// §10.4, §5.10, D.74: while R is kicked from C, or has left it, Q pushes R a deletion of C
/// whose parent R never got (an edit made after R went inactive, which only the members of
/// the current epoch received). R keeps the deletion and asks no one for the parent; once R
/// is added back and accepts, it asks for it. No scan would bring it back: the deletion
/// references it, so it is no tip any more. Before, R made no lookup for the parents of an
/// event it took while inactive, and a member added back kept the older version of the
/// message (membership simulation, seeds 0, 36, 56, 156, 194 and 290 of 300).
#[test]
fn the_parent_of_a_deletion_taken_while_inactive_is_fetched_once_the_device_is_back() {
    let mut wrong = Vec::new();
    for how in [Inactive::Removed, Inactive::Left] {
        let (mut net, [c, ..]) = setup(how, |_, _| {});
        let root = net.devs[0].node.root(&c).unwrap();
        let deletion = MessageEvent::create(
            &root,
            EventId::new(net.now - 1, [0x44; 16]),
            &[EventId::new(net.now - 2, [0x66; 16])],
            Payload::Delete {
                sync_obj_id: SyncObjId::from_bytes([0x45; 32]),
                scheduled_at: None,
            },
        )
        .unwrap();
        let f = Frame::Event(wire::encode_event_blob(&EventObject::Message(deletion)).unwrap());
        net.offline[Q] = true;
        net.recv_frames_m(R, Q, &[f]);
        let asks = |net: &MNet, from: usize| {
            net.dropped[from..]
                .iter()
                .filter(|(f, to, pt)| {
                    *f == R && *to == Q && pt.windows(16).any(|w| w == [0x66; 16])
                })
                .count()
        };
        let before = net.dropped.len();
        net.run(3 * HOUR);
        if asks(&net, before) != 0 {
            wrong.push((how, "asked while inactive"));
        }
        let cur = net.current(0, &c).unwrap();
        net.change(
            0,
            cur,
            GroupChange::Successor {
                add: vec![gid(R)],
                remove: vec![],
                name: None,
            },
        )
        .unwrap();
        net.run(2 * MIN);
        assert_eq!(net.accept_all(R).len(), 1, "{how:?}");
        net.run(10 * MIN);
        if asks(&net, before) == 0 {
            wrong.push((how, "never asked once back"));
        }
    }
    assert!(wrong.is_empty(), "{wrong:?}");
}

/// A valid object of `kind` naming `chat`, as Q can push it: Q's own leave, the owner's kick
/// of Q, or a deletion, which a member pushes in full to the removed peers of the epoch (§10.4).
fn pushed(net: &MNet, kind: &str, chat: ChatId) -> Frame {
    let root = net.devs[0].node.root(&chat).unwrap();
    let obj = match kind {
        "deletion" => EventObject::Message(
            MessageEvent::create(
                &root,
                EventId::new(net.now - 1, [0x44; 16]),
                &[],
                Payload::Delete {
                    sync_obj_id: SyncObjId::from_bytes([0x45; 32]),
                    scheduled_at: None,
                },
            )
            .unwrap(),
        ),
        "leave" => EventObject::Leave(
            crate::Leave::sign(
                &root,
                &super::membership::ident(Q).public,
                &super::membership::ident(Q).secret.dsa_signing_key,
                [7; 32],
            )
            .unwrap(),
        ),
        "kick" => EventObject::Kick(
            crate::Kick::sign(
                &root,
                gid(Q),
                &super::membership::ident(0).secret.dsa_signing_key,
                [8; 32],
            )
            .unwrap(),
        ),
        _ => unreachable!(),
    };
    Frame::Event(wire::encode_event_blob(&obj).unwrap())
}

/// §10.4, D.74: Q pushes R, in full, a valid leave, kick or deletion naming C, an epoch R holds
/// in a group where it is no longer active. R may keep it, but everything it then sends, for
/// three hours, is the same, byte for byte (the chat ID aside), as for the same object naming D,
/// which R deleted, or E, which R never held: it relays no notice of it to the members of C.
/// Before, a kicked device or one that left relayed a pushed deletion by notices.
#[test]
fn an_inactive_device_relays_nothing_pushed_to_it_for_its_epoch() {
    let mut wrong = Vec::new();
    for how in ALL {
        for kind in ["leave", "kick", "deletion"] {
            let probe = |pick: usize| {
                let (mut net, chats) = setup(how, |_, _| {});
                let f = pushed(&net, kind, chats[pick]);
                net.recv_frames_m(R, Q, &[f]);
                sent_by_r(&mut net, chats[pick], 3)
            };
            let inactive = probe(0);
            if inactive != probe(1) {
                wrong.push((how, kind, "deleted"));
            }
            if inactive != probe(2) {
                wrong.push((how, kind, "never held"));
            }
        }
    }
    assert!(
        wrong.is_empty(),
        "(status, pushed, differs from): {wrong:?}"
    );
}

/// §5.8, §10.4, D.74: the owner pushes R a dissolve naming C, an epoch R holds in a group where
/// it is already no longer active (kicked, left, waiting for a kick), with or without deletion.
/// R applies it silently: everything it then sends, for three hours, and what it answers Q's
/// chat, dissolve and tips lookups of that epoch, are the same as for a dissolve naming D, which
/// R deleted, or E, which R never held. Before, R announced the dissolve to the members and from
/// then on served the root and a page, which a device that deleted its copy never does.
#[test]
fn an_inactive_device_applies_a_dissolve_silently() {
    let mut wrong = Vec::new();
    for how in [Inactive::Removed, Inactive::Left, Inactive::Waiting] {
        for must_delete in [false, true] {
            let probe = |pick: usize| {
                let (mut net, chats) = setup(how, |_, _| {});
                let chat = chats[pick];
                let root = net.devs[0].node.root(&chat).unwrap();
                let d = crate::Dissolve::sign(
                    &root,
                    must_delete,
                    &super::membership::ident(0).secret.dsa_signing_key,
                    [9; 32],
                )
                .unwrap();
                let id = *crate::hash::dissolve_id(&chat, must_delete).as_bytes();
                let blob = wire::encode_event_blob(&EventObject::Dissolve(d)).unwrap();
                net.recv_frames_m(R, 0, &[Frame::Event(blob)]);
                let sent = sent_by_r(&mut net, chat, 3);
                let answers = super::membership::answers_of(
                    &mut net,
                    R,
                    Q,
                    vec![
                        QueryOp::ChatById(chat),
                        QueryOp::SignedObject {
                            chat_id: chat,
                            kind: crate::wire::SignedKind::Dissolve,
                            id,
                        },
                        QueryOp::TipsScan {
                            anchor: chat,
                            scan_id: scan_id(4),
                            offset: 0,
                        },
                    ],
                );
                (sent, answers)
            };
            let inactive = probe(0);
            for (pick, name) in [(1, "deleted"), (2, "never held")] {
                if inactive != probe(pick) {
                    wrong.push((how, must_delete, name));
                }
            }
        }
    }
    assert!(
        wrong.is_empty(),
        "(status, must_delete, differs from): {wrong:?}"
    );
}

/// §12.1, §5.10, D.74: R links C, a group where it is no longer active, to A by hand (local,
/// nothing is sent). Q, a member of both, scans R anchored in A. The page R gives is the one a
/// device that deleted C after linking it gives: it lists no entry of C. Before, the tips of C
/// were listed, so Q could tell R kept the history of a group it was kicked from or left.
#[test]
fn a_tips_scan_lists_nothing_of_a_linked_group_where_the_device_is_inactive() {
    let mut wrong = Vec::new();
    for how in [Inactive::Removed, Inactive::Left, Inactive::Dissolved] {
        let probe = |delete: bool| {
            let (mut net, [c, _, _, a]) = setup(how, |_, _| {});
            let now = net.now;
            let dev = &mut net.devs[R];
            dev.node
                .link_groups(&mut dev.store, a, c, true, now, &mut net.rng)
                .unwrap();
            if delete {
                dev.node
                    .delete_group(&mut dev.store, c, now, &mut net.rng)
                    .unwrap();
            }
            let answers = super::membership::answers_of(
                &mut net,
                R,
                Q,
                vec![QueryOp::TipsScan {
                    anchor: a,
                    scan_id: scan_id(4),
                    offset: 0,
                }],
            );
            let names_c = answers.iter().any(|(_, r)| match r {
                ResponseResult::Page(p) => p.entries.iter().any(|e| e.chat_id == c),
                _ => false,
            });
            (answers, names_c)
        };
        let (kept, names_c) = probe(false);
        let (deleted, _) = probe(true);
        if names_c || kept != deleted {
            wrong.push((how, names_c));
        }
    }
    assert!(wrong.is_empty(), "(status, lists C): {wrong:?}");
}

/// A = {0, 1, 2, 3} and C = {0, 1, 3}, both active on R and Q, and a message of Q in C.
/// Returns `(net, A, C)`.
fn active() -> (MNet, ChatId, ChatId) {
    let mut net = MNet::new(5, true);
    let a = net.create(0, &[1, 2, 3]);
    let c = net.create(0, &[1, 3]);
    net.exchange();
    for m in 1..4 {
        net.accept_all(m);
    }
    net.run(2 * MIN);
    net.say(Q, &c, "before");
    net.run(MIN);
    assert_eq!(net.summary(R, &c).unwrap().status, MyStatus::Member);
    (net, a, c)
}

/// Everything R sends now, handed off and delivered to nobody: `(recipient, frames)`.
fn drain(net: &mut MNet) -> Vec<(GossipId, Vec<Frame>)> {
    let now = net.now;
    let dev = &mut net.devs[R];
    let out = dev
        .node
        .poll_outbox(&mut dev.store, now, &mut net.rng)
        .unwrap();
    let mut sent = Vec::new();
    for o in out {
        let dev = &mut net.devs[R];
        dev.node
            .handed_off(&mut dev.store, o.handle, now, &mut net.rng)
            .unwrap();
        sent.push((o.to, frames(&o.plaintext)));
    }
    sent
}

/// The query Q sends R about C in the tests of queued answers, and the neighbor request.
fn lookups_of_c(c: ChatId) -> Vec<Frame> {
    vec![
        query(
            9,
            T0,
            MIN,
            vec![
                QueryOp::ChatById(c),
                QueryOp::SignedObject {
                    chat_id: c,
                    kind: crate::wire::SignedKind::Leave,
                    id: *crate::hash::leave_id(&c, &gid(Q)).as_bytes(),
                },
                QueryOp::TipsScan {
                    anchor: c,
                    scan_id: scan_id(4),
                    offset: 0,
                },
                QueryOp::Keys {
                    chat_id: c,
                    gossip_id: gid(0),
                },
            ],
        ),
        Frame::NeighborRequest(NeighborRequest { chat_id: c }),
    ]
}

/// What R sends Q in answer to [`lookups_of_c`]: the responses by entry position, and the
/// neighbor responses naming `c`.
fn answers_to_q(
    sent: &[(GossipId, Vec<Frame>)],
    c: ChatId,
) -> (Vec<(u32, ResponseResult)>, Vec<Frame>) {
    let mut answers = Vec::new();
    let mut neighbor = Vec::new();
    for (to, frames) in sent {
        if *to != gid(Q) {
            continue;
        }
        for f in frames {
            match f {
                Frame::Response(r) if r.request_id == Some(RequestId::from_bytes([9; 16])) => {
                    answers.push((r.idx, r.result.clone()));
                }
                Frame::NeighborResponse(n) if n.chat_id == c => neighbor.push(f.clone()),
                _ => {}
            }
        }
    }
    answers.sort_by_key(|(i, _)| *i);
    (answers, neighbor)
}

/// §13.7, D.74: Q asks R, active in C, for C's root, for its own leave R holds, for a tips
/// scan anchored in C and for the keys of a member, and asks to be its neighbor in C. R
/// deletes C before the answers go out. A device that never held C answers each lookup "not
/// available" (Q shares the active chat A with it) and declines the neighbor request without
/// suggestions, so R gives these answers too: never silence where a device that never held
/// the epoch answers. The key answer, decided on receipt and naming no chat, still goes. Before,
/// the root, signed-object and page answers and the neighbor response were dropped.
#[test]
fn answers_queued_when_the_chat_is_deleted_are_those_of_a_device_that_never_held_it() {
    let (mut net, _, c) = active();
    let leave = pushed(&net, "leave", c);
    net.recv_frames_m(R, Q, &[leave]);
    drain(&mut net);
    net.recv_frames_m(R, Q, &lookups_of_c(c));
    let now = net.now;
    let dev = &mut net.devs[R];
    dev.node
        .delete_group(&mut dev.store, c, now, &mut net.rng)
        .unwrap();
    let (answers, neighbor) = answers_to_q(&drain(&mut net), c);
    let na = ResponseResult::Status(Status::NotAvailable);
    assert_eq!(
        answers
            .iter()
            .map(|(i, r)| (*i, r == &na))
            .collect::<Vec<_>>(),
        vec![(0, true), (1, true), (2, true), (3, false)],
        "{answers:?}"
    );
    assert!(matches!(answers[3].1, ResponseResult::Keys(_)));
    assert_eq!(
        neighbor,
        vec![Frame::NeighborResponse(crate::wire::NeighborResponse {
            chat_id: c,
            accepted: false,
            suggestions: Vec::new(),
        })]
    );
}

/// Makes R inactive in C the way given, by what members push to it (its own leave, its kick, a
/// dissolve) or by its own "Ask to be kicked", without letting R send anything; or, with
/// `None`, deletes C on R.
fn go_inactive(net: &mut MNet, how: Option<Inactive>, c: ChatId) {
    let root = net.devs[0].node.root(&c).unwrap();
    let owner = &super::membership::ident(0).secret.dsa_signing_key;
    let obj = match how {
        None => {
            let now = net.now;
            let dev = &mut net.devs[R];
            dev.node
                .delete_group(&mut dev.store, c, now, &mut net.rng)
                .unwrap();
            return;
        }
        Some(Inactive::Waiting) => {
            let now = net.now;
            let s = signer(R);
            let dev = &mut net.devs[R];
            dev.node
                .leave_group(
                    &mut dev.store,
                    &s,
                    c,
                    LeaveChoice::AskToBeKicked,
                    now,
                    &mut net.rng,
                )
                .unwrap();
            return;
        }
        Some(Inactive::Removed) => {
            EventObject::Kick(crate::Kick::sign(&root, gid(R), owner, [8; 32]).unwrap())
        }
        Some(Inactive::Left) => EventObject::Leave(
            crate::Leave::sign(
                &root,
                &super::membership::ident(R).public,
                &super::membership::ident(R).secret.dsa_signing_key,
                [7; 32],
            )
            .unwrap(),
        ),
        Some(Inactive::Dissolved) => {
            EventObject::Dissolve(crate::Dissolve::sign(&root, false, owner, [9; 32]).unwrap())
        }
    };
    let f = Frame::Event(wire::encode_event_blob(&obj).unwrap());
    net.recv_frames_m(R, 0, &[f]);
}

/// The frames of `sent` about C: the answers to Q's query 9, and every other frame whose
/// bytes name C, except what an inactive group still sends by design: a request to be kicked
/// (§5.4) and the dissolve an archive announces (§5.8).
fn about_c(sent: &[(GossipId, Vec<Frame>)], c: ChatId) -> Vec<(GossipId, Frame)> {
    let mut out = Vec::new();
    for (to, frames) in sent {
        for f in frames {
            let keep = match f {
                Frame::Response(r) => r.request_id == Some(RequestId::from_bytes([9; 16])),
                Frame::LeaveRequest(_) => false,
                Frame::Notice(n) => n
                    .entries
                    .iter()
                    .any(|e| e.chat_id == c && !matches!(e.item, EntryItem::Dissolve(_))),
                Frame::Event(blob) => {
                    contains(blob, &c)
                        && !matches!(
                            wire::decode_event_blob(blob, 1),
                            Ok(EventObject::Dissolve(_))
                        )
                }
                f => f.encode().is_ok_and(|b| contains(&b, &c)),
            };
            if keep {
                out.push((*to, f.clone()));
            }
        }
    }
    out
}

/// §10.4, §15.1, D.74: while R is active in C, work for C waits in its queue or is already
/// assembled: its own message, the notices relaying a message of Q, its own neighbor request,
/// and its answers to Q's lookups and neighbor request. Then R stops being active in C (kicked,
/// left, waiting for a kick, dissolved). What it sends about C from then on, assembled before
/// or after, is what it sends when it deletes C instead: no message, notice or neighbor request,
/// and the answers a device that never held C gives. An archive (dissolved while active) still
/// serves the root (the decided exception, §5.8); a tips scan anchored in it is restarted, so
/// that the next list holds its dissolve message and root only. Before, all of this still went
/// out after the transition.
#[test]
fn work_for_the_epoch_queued_or_assembled_before_it_goes_inactive_is_not_sent() {
    let mut wrong = Vec::new();
    for how in ALL {
        let probe = |how: Option<Inactive>| {
            let (mut net, _, c) = active();
            let e = net.say(Q, &c, "more");
            let blob = wire::encode_event_blob(&EventObject::Message(e.clone())).unwrap();
            net.recv_frames_m(R, Q, &[Frame::Event(blob)]);
            net.say(R, &c, "mine");
            net.devs[R].node.queue_work(
                gid(Q),
                crate::node::records::Work::NeighborRequest { chat_id: c },
            );
            let mut lookups = lookups_of_c(c);
            if let Frame::Query(q) = &mut lookups[0] {
                q.sent_at = net.now;
                q.ttl = 10 * MIN;
                q.entries.push(QueryEntry::Op(QueryOp::Event {
                    chat_id: c,
                    event_id: e.event_id(),
                }));
            }
            net.recv_frames_m(R, Q, &lookups);
            // Half of it assembled before the transition, in flight.
            let now = net.now;
            let dev = &mut net.devs[R];
            let assembled = dev
                .node
                .poll_outbox(&mut dev.store, now, &mut net.rng)
                .unwrap();
            go_inactive(&mut net, how, c);
            let mut sent = Vec::new();
            for o in assembled {
                let dev = &mut net.devs[R];
                if dev.node.is_current(o.handle, net.now) {
                    dev.node
                        .handed_off(&mut dev.store, o.handle, net.now, &mut net.rng)
                        .unwrap();
                    sent.push((o.to, frames(&o.plaintext)));
                } else {
                    dev.node.abandon(o.handle);
                }
            }
            for _ in 0..10 {
                sent.extend(drain(&mut net));
                net.now += MIN;
                net.tick(R);
            }
            about_c(&sent, c)
        };
        let inactive = probe(Some(how));
        let deleted = probe(None);
        let (mut inactive_rest, mut deleted_rest) = (inactive.clone(), deleted.clone());
        if matches!(how, Inactive::Dissolved) {
            // The root answer (entry 0) and the page (entry 2) of an archive.
            let answer = |v: &[(GossipId, Frame)], i: u32| {
                v.iter().find_map(|(_, f)| match f {
                    Frame::Response(r) if r.idx == i => Some(r.result.clone()),
                    _ => None,
                })
            };
            if !matches!(answer(&inactive, 0), Some(ResponseResult::Event(_)))
                || answer(&inactive, 2) != Some(ResponseResult::Status(Status::Restart))
            {
                wrong.push((how, format!("archive answers: {inactive:?}")));
            }
            let other = |(_, f): &(GossipId, Frame)| !matches!(f, Frame::Response(r) if r.idx == 0 || r.idx == 2);
            inactive_rest.retain(other);
            deleted_rest.retain(other);
        }
        if inactive_rest != deleted_rest {
            wrong.push((
                how,
                format!("{inactive_rest:?}\nagainst deleted\n{deleted_rest:?}"),
            ));
        }
        let originated = |v: &[(GossipId, Frame)]| {
            v.iter()
                .filter(|(_, f)| !matches!(f, Frame::Response(_) | Frame::NeighborResponse(_)))
                .count()
        };
        if originated(&inactive) > 0 || originated(&deleted) > 0 {
            wrong.push((how, "originated".to_owned()));
        }
    }
    assert!(wrong.is_empty(), "{wrong:#?}");
}

/// §10.4, §12.5: the user asked for a sync object of C that no one has answered yet when R
/// stops being active in C. The lookup ends at once, not found, as one asked for then does;
/// before, it was parked and never reported.
#[test]
fn a_sync_object_lookup_in_progress_ends_not_found_when_the_group_goes_inactive() {
    for how in ALL {
        let (mut net, _, c) = active();
        net.offline[Q] = true;
        net.offline[0] = true;
        let sync = SyncObjId::from_bytes([0x5A; 32]);
        let now = net.now;
        let dev = &mut net.devs[R];
        dev.node
            .lookup_sync_object(&mut dev.store, c, sync, now, &mut net.rng)
            .unwrap();
        drain(&mut net);
        go_inactive(&mut net, Some(how), c);
        let now = net.now;
        let dev = &mut net.devs[R];
        let results = dev
            .node
            .take_lookup_results(&mut dev.store, now, &mut net.rng)
            .unwrap();
        assert_eq!(results, vec![(c, sync, LookupResult::NotFound)], "{how:?}");
    }
}

// ── A message on this device only in a chat it can only read (§9.7, D.99) ───

/// R creates `text` on this device only in C, as member `author`.
fn local_in(
    net: &mut MNet,
    c: ChatId,
    author: usize,
    text: &str,
) -> Result<SyncObjId, NodeError> {
    let now = net.now;
    let chat = net.current(R, &c).unwrap();
    let dev = &mut net.devs[R];
    dev.node.local_message(
        &mut dev.store,
        chat,
        gid(author),
        Body::Text(text.into()),
        BTreeMap::new(),
        now,
        &mut net.rng,
    )
}

/// §9.7, D.99: after a kick, a visible leave, or a dissolve, R keeps C read-only and may still
/// create a message there on this device only, under any member of the last epoch it holds,
/// itself included: stored in the shape of D.93, shown, and never sent. A normal send stays
/// refused. Waiting for a kick is refused, as a normal send is.
#[test]
fn a_local_message_is_accepted_in_a_chat_the_device_can_only_read() {
    let mut timers = 0;
    for (how, timed) in ALL.into_iter().flat_map(|h| [(h, false), (h, true)]) {
        let (mut net, [c, ..]) = setup(how, |net, c| {
            if timed {
                let cur = net.current(0, &c).unwrap();
                net.change(0, cur, GroupChange::MessageTimer { timer: DAY })
                    .unwrap();
                net.run(2 * MIN);
            }
        });
        let chat = net.current(R, &c).unwrap();
        let timer = net.devs[R].node.root(&chat).unwrap().message_timer();
        timers += usize::from(timer > 0);
        if matches!(how, Inactive::Waiting) {
            assert!(
                matches!(local_in(&mut net, c, Q, "x"), Err(NodeError::NotAllowed)),
                "{how:?}"
            );
            continue;
        }
        let as_q = local_in(&mut net, c, Q, "only here, as Q").unwrap();
        let as_me = local_in(&mut net, c, R, "only here, as me").unwrap();
        // Not a member of that epoch: refused, as for a published message.
        assert!(local_in(&mut net, c, 2, "x").is_err(), "{how:?}");
        let texts = net.texts(R, &c);
        assert!(texts.contains(&"only here, as Q".to_owned()), "{how:?}");
        assert!(texts.contains(&"only here, as me".to_owned()), "{how:?}");
        for sync in [as_q, as_me] {
            let obj = net.devs[R].store.object(&chat, &sync).unwrap().unwrap();
            assert!(obj.current_events.is_empty(), "{how:?}");
            assert_eq!(obj.stubs.len(), usize::from(timer > 0), "{how:?}");
            assert!(obj.shareable);
        }
        // A normal send stays refused.
        let now = net.now;
        let dev = &mut net.devs[R];
        assert!(
            dev.node
                .publish_message(
                    &mut dev.store,
                    chat,
                    Body::Text("to everyone".into()),
                    BTreeMap::new(),
                    None,
                    now,
                    &mut net.rng,
                )
                .is_err(),
            "{how:?}"
        );
        // Nothing of it ever leaves R.
        for (_, pt) in sent_by_r(&mut net, never_replaced(), 3) {
            for sync in [as_q, as_me] {
                assert!(!pt.windows(32).any(|w| w == sync.as_bytes()), "{how:?}");
            }
        }
        crate::epoch::check_invariants(&net.devs[R].store, &chat, net.now).unwrap();
    }
    // Both shapes are covered: with no timer, and with one when kicked or dissolved (after its
    // own leave, or with the owner offline while it waits, R never gets the timer's epoch).
    assert_eq!(timers, 2);
}

/// §9.7, §5.10, D.99: a local-only message created while R was kicked from C stays on R once R
/// is added back, shaped as an evicted message of an earlier epoch: R serves the epoch again,
/// and still never sends, announces or lists anything of it; the other members never get it.
#[test]
fn a_local_message_of_a_read_only_chat_stays_on_the_device_once_it_is_added_back() {
    let (mut net, [c, ..]) = setup(Inactive::Removed, |_, _| {});
    let old = net.current(R, &c).unwrap();
    let sync = local_in(&mut net, c, Q, "only here, as Q").unwrap();
    let cur = net.current(0, &c).unwrap();
    net.change(
        0,
        cur,
        GroupChange::Successor {
            add: vec![gid(R)],
            remove: vec![],
            name: None,
        },
    )
    .unwrap();
    net.run(2 * MIN);
    assert_eq!(net.accept_all(R).len(), 1);
    assert_eq!(net.summary(R, &c).unwrap().status, MyStatus::Member);
    assert_ne!(net.current(R, &c), Some(old));
    // R talks with the others again, and sends nothing of the message.
    net.say(R, &c, "back again");
    let sent = sent_by_r(&mut net, never_replaced(), 30);
    assert!(!sent.is_empty());
    for (_, pt) in &sent {
        assert!(!pt.windows(32).any(|w| w == sync.as_bytes()));
    }
    net.run(DAY);
    assert!(net.texts(R, &c).contains(&"only here, as Q".to_owned()));
    for d in [0, 2, Q] {
        assert!(
            !net.texts(d, &c).contains(&"only here, as Q".to_owned()),
            "{d}"
        );
        assert!(net.devs[d].store.object(&old, &sync).unwrap().is_none());
    }
    // Its old epoch is served again, and the message is what an evicted message is there.
    assert!(
        net.devs[R]
            .store
            .object(&old, &sync)
            .unwrap()
            .unwrap()
            .current_events
            .is_empty()
    );
    crate::epoch::check_invariants(&net.devs[R].store, &old, net.now).unwrap();
}
