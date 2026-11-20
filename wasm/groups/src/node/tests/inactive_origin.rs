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
/// Returns `(net, [C, D, E])`. With `before`, run on R while C is still active (for the pending
/// lookups of the transition).
fn setup(how: Inactive, before: impl FnOnce(&mut MNet, ChatId)) -> (MNet, [ChatId; 3]) {
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
    (net, [c, d, e])
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
                let (mut net, [c, d, _]) = setup(how, |_, _| {});
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
