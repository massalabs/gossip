//! Replies that name an epoch by its reference (§7.6, §12.7): the chat lookup by reference
//! a device sends for an epoch it cannot place, and nothing for one it can.
//!
//! That side is off in the first release ([`crate::node::timing::REF_LOOKUPS_SENT`]): the
//! tests of what it sends turn it on ([`MNet::set_ref_lookups`]); with it off, a reply
//! naming a reference makes a device send exactly what the same reply without `replyTo`
//! does.

use std::collections::BTreeMap;

use super::membership::{MNet, gid, signer};
use super::*;
use crate::event::{ReplyTarget, encode_reply_to};
use crate::ids::RefChatId;

const WEEK: u64 = 7 * DAY;

/// Delivers everything until quiet, as [`MNet::exchange`], and returns every frame sent, as
/// `(from, to, frame)`.
fn exchange_log(net: &mut MNet) -> Vec<(usize, usize, Frame)> {
    let mut log = Vec::new();
    for _ in 0..200 {
        let mut any = false;
        for d in 0..net.devs.len() {
            if net.offline[d] {
                continue;
            }
            let now = net.now;
            let dev = &mut net.devs[d];
            let out = dev
                .node
                .poll_outbox(&mut dev.store, now, &mut net.rng)
                .unwrap();
            for o in out {
                let dev = &mut net.devs[d];
                dev.node
                    .handed_off(&mut dev.store, o.handle, now, &mut net.rng)
                    .unwrap();
                any = true;
                let Some(r) = net.idx(&o.to) else { continue };
                for f in frames(&o.plaintext) {
                    log.push((d, r, f));
                }
                if net.offline[r] {
                    continue;
                }
                let dev = &mut net.devs[r];
                dev.node
                    .handle_plaintext(&mut dev.store, gid(d), &o.plaintext, now, &mut net.rng)
                    .unwrap();
            }
        }
        if !any {
            return log;
        }
    }
    panic!("the devices never went quiet");
}

/// Lets `ms` pass in steps of a minute, as [`MNet::run`], and returns every frame sent.
fn run_log(net: &mut MNet, ms: u64) -> Vec<(usize, usize, Frame)> {
    let end = net.now + ms;
    let mut log = Vec::new();
    while net.now < end {
        net.now = (net.now + MIN).min(end);
        for d in 0..net.devs.len() {
            if !net.offline[d] {
                net.tick(d);
            }
        }
        log.extend(exchange_log(net));
    }
    log
}

/// Moves the clock `ms` forward at once, ticks every device and delivers.
fn jump(net: &mut MNet, ms: u64) -> Vec<(usize, usize, Frame)> {
    net.now += ms;
    for d in 0..net.devs.len() {
        if !net.offline[d] {
            net.tick(d);
        }
    }
    exchange_log(net)
}

/// The query entries in `log`, as `(from, to, op)`.
fn ops(log: &[(usize, usize, Frame)]) -> Vec<(usize, usize, QueryOp)> {
    log.iter()
        .filter_map(|(f, t, fr)| match fr {
            Frame::Query(q) => Some(
                q.entries
                    .iter()
                    .filter_map(|e| match e {
                        QueryEntry::Op(op) => Some((*f, *t, op.clone())),
                        QueryEntry::Malformed(_) => None,
                    })
                    .collect::<Vec<_>>(),
            ),
            _ => None,
        })
        .flatten()
        .collect()
}

/// The chat lookups by `reference` that device 3 sent in `log`, as `(from, to)`.
fn by_ref(log: &[(usize, usize, Frame)], reference: RefChatId) -> Vec<(usize, usize)> {
    ops(log)
        .into_iter()
        .filter(|(f, _, op)| *f == 3 && *op == QueryOp::ChatByRef(reference))
        .map(|(f, t, _)| (f, t))
        .collect()
}

/// Whether `d` sent, in `log`, a query about the messages of `chat` or a scan anchored at
/// it, or a neighbor request in it.
fn sent_in(log: &[(usize, usize, Frame)], d: usize, chat: ChatId) -> bool {
    let query = ops(log).into_iter().any(|(f, _, op)| {
        f == d
            && matches!(op,
                QueryOp::Event { chat_id, .. } | QueryOp::SyncObj { chat_id, .. }
                    if chat_id == chat)
            || f == d && matches!(op, QueryOp::TipsScan { anchor, .. } if anchor == chat)
    });
    let neighbor = log
        .iter()
        .any(|(f, _, fr)| *f == d && matches!(fr, Frame::NeighborRequest(r) if r.chat_id == chat));
    query || neighbor
}

fn sync(e: &MessageEvent) -> SyncObjId {
    e.payload().sync_obj_id()
}

fn reference(net: &MNet, d: usize, chat: &ChatId) -> RefChatId {
    net.devs[d].node.root(chat).unwrap().ref_chat_id()
}

/// Device `d` writes in the current epoch of `group` a reply to `targets`.
fn reply(
    net: &mut MNet,
    d: usize,
    group: &ChatId,
    targets: &[(RefChatId, SyncObjId)],
) -> MessageEvent {
    let now = net.now;
    let chat = net.current(d, group).unwrap();
    let targets: Vec<ReplyTarget> = targets
        .iter()
        .map(|(r, s)| ReplyTarget {
            ref_chat_id: *r,
            sync_obj_id: *s,
        })
        .collect();
    // No target: the same message without `replyTo`.
    let metadata = if targets.is_empty() {
        BTreeMap::new()
    } else {
        BTreeMap::from([("replyTo".to_owned(), encode_reply_to(&targets).unwrap())])
    };
    let dev = &mut net.devs[d];
    dev.node
        .publish_message(
            &mut dev.store,
            chat,
            Body::Text("a reply".into()),
            metadata,
            None,
            now,
            &mut net.rng,
        )
        .unwrap()
        .event
}

/// `author` writes the reply in `group` while `to` is offline; `via` then delivers it to
/// `to`, so that the peer that delivered it is not its author.
fn reply_via(
    net: &mut MNet,
    author: usize,
    via: usize,
    to: usize,
    group: &ChatId,
    targets: &[(RefChatId, SyncObjId)],
) -> MessageEvent {
    net.offline[to] = true;
    let e = reply(net, author, group, targets);
    net.exchange();
    net.offline[to] = false;
    net.recv_frames_m(to, via, &[Frame::Event(blob(&e))]);
    e
}

/// Whether device `d` holds the message `m` in `chat`.
fn holds(net: &MNet, d: usize, chat: &ChatId, m: &MessageEvent) -> bool {
    net.devs[d]
        .store
        .object(chat, &sync(m))
        .unwrap()
        .is_some_and(|o| o.current.is_some())
}

/// Six devices. G, of owner 0 with 1 and 2: device 3 is no member of it. H, of owner 4 with
/// 1, 2, 3 and 5: where the replies are written. `m` is a message of G. With `on`, the
/// devices send what a reply's reference calls for.
fn scene(on: bool) -> (MNet, ChatId, ChatId, MessageEvent) {
    let mut net = MNet::new(6, true);
    net.set_ref_lookups(on);
    let g = net.create(0, &[1, 2]);
    let h = net.create(4, &[1, 2, 3, 5]);
    net.exchange();
    for d in 1..6 {
        net.accept_all(d);
    }
    net.run(2 * MIN);
    let m = net.say(0, &g, "quoted");
    net.run(MIN);
    (net, g, h, m)
}

/// Lets `ms` pass minute by minute; returns the lookups of `reference` device 3 sent, and
/// when it sent the first of them.
fn watch(net: &mut MNet, reference: RefChatId, ms: u64) -> (Vec<(usize, usize)>, u64) {
    let mut asked = Vec::new();
    let mut at = 0;
    for _ in 0..ms / MIN {
        let sent = by_ref(&run_log(net, MIN), reference);
        if asked.is_empty() && !sent.is_empty() {
            at = net.now;
        }
        asked.extend(sent);
    }
    (asked, at)
}

/// The round after the one started at `last`: nothing from device 3 until a week has passed
/// since then, then one round; returns its lookups and when it started.
fn next_round(net: &mut MNet, reference: RefChatId, last: u64) -> (Vec<(usize, usize)>, u64) {
    let quiet = jump(net, last + WEEK - 10 * MIN - net.now);
    assert!(by_ref(&quiet, reference).is_empty(), "before a week");
    let (asked, at) = watch(net, reference, 20 * MIN);
    assert!(at >= last + WEEK, "a week after the last round");
    (asked, at)
}

/// §7.6, §12.7: a reply names an epoch no root of device 3 matches. On receipt, after a
/// short random wait, device 3 asks the peer that delivered it, then its author, then one
/// other member of the chat of the reply: three peers at most. "Not available" costs them
/// nothing (§11.8). With no root back, it tries again once a week, four rounds in all, and
/// then stops for good.
#[test]
fn an_unknown_reference_is_asked_of_three_peers_in_order_each_week_four_times() {
    let (mut net, g, h, m) = scene(true);
    let r = reference(&net, 0, &g);
    let penalties = net.devs[3].node.stats().penalties;
    let scores: Vec<u64> = (0..6).map(|p| net.devs[3].node.score(&gid(p))).collect();
    reply_via(&mut net, 1, 2, 3, &h, &[(r, sync(&m))]);
    // Nothing at the instant of receipt.
    assert!(by_ref(&exchange_log(&mut net), r).is_empty());
    let (first, mut last) = watch(&mut net, r, 2 * MIN);
    assert_eq!(first.len(), 3, "{first:?}");
    assert_eq!(first[0].1, 2, "the peer that delivered the reply first");
    assert_eq!(first[1].1, 1, "then its author");
    assert!([4, 5].contains(&first[2].1), "then another member of H");
    assert_eq!(net.devs[3].node.stats().penalties, penalties);
    let now: Vec<u64> = (0..6).map(|p| net.devs[3].node.score(&gid(p))).collect();
    assert_eq!(now, scores, "not available carries no penalty");
    for round in 2..=4 {
        let (asked, at) = next_round(&mut net, r, last);
        last = at;
        assert_eq!(asked.len(), 3, "round {round}: {asked:?}");
        assert_eq!(asked[0].1, 2, "round {round}");
        assert_eq!(asked[1].1, 1, "round {round}");
    }
    // Four rounds in all: never again, and a new reply naming it does not start again.
    let quiet = jump(&mut net, 3 * WEEK);
    assert!(by_ref(&quiet, r).is_empty());
    reply_via(&mut net, 5, 5, 3, &h, &[(r, sync(&m))]);
    let mut quiet = run_log(&mut net, 10 * MIN);
    quiet.extend(jump(&mut net, 2 * WEEK));
    assert!(by_ref(&quiet, r).is_empty());
    assert_eq!(net.devs[3].node.stats().penalties, penalties);
}

/// The lookup goes on only while device 3 holds a reply naming the reference: once the reply
/// is deleted, the next round is not sent and the reference is forgotten.
#[test]
fn the_lookup_stops_once_no_reply_naming_the_reference_is_held() {
    let (mut net, g, h, m) = scene(true);
    let r = reference(&net, 0, &g);
    let e = reply_via(&mut net, 1, 2, 3, &h, &[(r, sync(&m))]);
    assert_eq!(by_ref(&run_log(&mut net, 2 * MIN), r).len(), 3);
    let now = net.now;
    let dev = &mut net.devs[3];
    dev.node
        .local_delete(&mut dev.store, h, sync(&e), now, &mut net.rng)
        .unwrap();
    let later = jump(&mut net, WEEK + HOUR);
    assert!(by_ref(&later, r).is_empty());
}

/// The rounds and their count survive a restart, during the wait before the first round and
/// between rounds.
#[test]
fn the_rounds_of_a_lookup_survive_a_restart() {
    let (mut net, g, h, m) = scene(true);
    let r = reference(&net, 0, &g);
    reply_via(&mut net, 1, 2, 3, &h, &[(r, sync(&m))]);
    net.restart(3);
    let (asked, mut last) = watch(&mut net, r, 2 * MIN);
    assert_eq!(asked.len(), 3);
    for round in 2..=4 {
        net.restart(3);
        let (asked, at) = next_round(&mut net, r, last);
        last = at;
        assert_eq!(asked.len(), 3, "round {round}");
    }
    net.restart(3);
    assert!(by_ref(&jump(&mut net, 3 * WEEK), r).is_empty());
}

/// A root returned for a reference must have that reference: device 3 computes it again. A
/// root of another epoch, even one it holds, is an invalid answer under the usual rules
/// (penalised, the next peer is asked), never the end of the lookup.
#[test]
fn a_root_that_does_not_match_the_reference_is_an_invalid_answer() {
    let (mut net, g, h, m) = scene(true);
    let r = reference(&net, 0, &g);
    reply_via(&mut net, 1, 2, 3, &h, &[(r, sync(&m))]);
    // Device 3 sends its first query; device 2 never sees it.
    net.now += 2 * MIN;
    net.tick(3);
    let now = net.now;
    let dev = &mut net.devs[3];
    let out = dev
        .node
        .poll_outbox(&mut dev.store, now, &mut net.rng)
        .unwrap();
    let mut asked = None;
    for o in out {
        let dev = &mut net.devs[3];
        dev.node
            .handed_off(&mut dev.store, o.handle, now, &mut net.rng)
            .unwrap();
        for f in frames(&o.plaintext) {
            if let Frame::Query(q) = f
                && let Some(idx) = q
                    .entries
                    .iter()
                    .position(|e| *e == QueryEntry::Op(QueryOp::ChatByRef(r)))
            {
                assert_eq!(o.to, gid(2));
                asked = Some((q.request_id, idx));
            }
        }
    }
    let (request_id, idx) = asked.expect("asked device 2");
    let invalid = net.devs[3].node.stats().invalid;
    let score = net.devs[3].node.score(&gid(2));
    let other = net.devs[3].node.root(&h).unwrap();
    let wrong = wire::encode_event_blob(&EventObject::Root(Box::new(other))).unwrap();
    net.recv_frames_m(
        3,
        2,
        &[Frame::Response(Response {
            request_id: Some(request_id),
            idx: idx as u32,
            result: ResponseResult::Event(wrong),
        })],
    );
    assert_eq!(net.devs[3].node.stats().invalid, invalid + 1);
    assert!(net.devs[3].node.score(&gid(2)) < score);
    // The lookup goes on with the next peer, the author.
    let next = by_ref(&exchange_log(&mut net), r);
    assert_eq!(next.first(), Some(&(3, 1)), "{next:?}");
    assert!(net.devs[3].node.root(&g).is_none());
}

/// Never a lookup for what device 3 can place: an epoch it holds (the target held too), or an
/// invitation it has not answered (and nothing sent in that epoch before it is accepted).
#[test]
fn nothing_is_asked_for_a_held_epoch_or_an_unanswered_invitation() {
    for accepted in [true, false] {
        let mut net = MNet::new(6, true);
        net.set_ref_lookups(true);
        let g = net.create(0, &[1, 2, 3]);
        let h = net.create(4, &[1, 2, 3, 5]);
        net.exchange();
        for d in 1..6 {
            let due: Vec<ChatId> = net.devs[d]
                .node
                .invitations(net.now)
                .iter()
                .map(|i| i.chat_id)
                .filter(|c| accepted || d != 3 || *c != g)
                .collect();
            for c in due {
                net.accept(d, c);
            }
        }
        net.run(2 * MIN);
        let m = net.say(0, &g, "quoted");
        net.run(MIN);
        assert_eq!(holds(&net, 3, &g, &m), accepted);
        let r = reference(&net, 0, &g);
        reply_via(&mut net, 1, 2, 3, &h, &[(r, sync(&m))]);
        let mut log = run_log(&mut net, 5 * MIN);
        log.extend(jump(&mut net, WEEK + HOUR));
        assert!(by_ref(&log, r).is_empty(), "accepted={accepted}");
        if accepted {
            // The target is held: not looked up either.
            assert!(!ops(&log).iter().any(|(f, _, op)| *f == 3
                && *op
                    == QueryOp::SyncObj {
                        chat_id: g,
                        sync_obj_id: sync(&m)
                    }));
        } else {
            assert!(
                !sent_in(&log, 3, g),
                "nothing in the epoch of the invitation"
            );
        }
    }
}

/// §4.8 case 2 through a reference: device 3 skipped an epoch of its own group. A reply
/// naming a message of that epoch makes it ask the peer that delivered the reply, which
/// returns the root; the epoch joins the group's history without a prompt, and the quoted
/// message is fetched.
#[test]
fn a_skipped_epoch_fetched_by_reference_joins_the_history() {
    let mut net = MNet::new(5, true);
    net.set_ref_lookups(true);
    let g = net.create(0, &[1, 2, 3]);
    let h = net.create(4, &[1, 3]);
    net.exchange();
    for d in 1..5 {
        net.accept_all(d);
    }
    net.run(2 * MIN);
    net.offline[3] = true;
    let e2 = net
        .change(
            0,
            g,
            GroupChange::Successor {
                add: vec![],
                remove: vec![],
                name: Some("G2".into()),
            },
        )
        .unwrap();
    net.exchange();
    let m = net.say(2, &g, "in the skipped epoch");
    net.run(MIN);
    net.offline[3] = false;
    assert!(net.devs[3].node.root(&e2).is_none());
    let r = reference(&net, 0, &e2);
    reply(&mut net, 1, &h, &[(r, sync(&m))]);
    let mut log = exchange_log(&mut net);
    log.extend(run_log(&mut net, 5 * MIN));
    assert_eq!(by_ref(&log, r).first(), Some(&(3, 1)));
    assert_eq!(net.current(3, &g), Some(e2));
    assert!(net.devs[3].node.invitations(net.now).is_empty());
    assert!(holds(&net, 3, &e2, &m));
    assert!(
        net.texts(3, &g)
            .contains(&"in the skipped epoch".to_owned())
    );
}

/// §4.8 case 5 through a reference: device 3 was added to G, but the invitation never
/// arrived. The root fetched by reference is a real invitation, and nothing is sent in that
/// epoch before it is accepted; the quoted message comes after accepting.
#[test]
fn a_missed_invitation_fetched_by_reference_is_prompted() {
    let mut net = MNet::new(5, true);
    net.set_ref_lookups(true);
    let g = net.create(0, &[1, 2]);
    let h = net.create(4, &[1, 3]);
    net.exchange();
    for d in 1..5 {
        net.accept_all(d);
    }
    net.run(2 * MIN);
    net.offline[3] = true;
    let e2 = net
        .change(
            0,
            g,
            GroupChange::Successor {
                add: vec![gid(3)],
                remove: vec![],
                name: None,
            },
        )
        .unwrap();
    net.exchange();
    let m = net.say(1, &g, "before you came");
    net.run(MIN);
    net.offline[3] = false;
    assert!(net.devs[3].node.root(&e2).is_none());
    let r = reference(&net, 0, &e2);
    reply(&mut net, 1, &h, &[(r, sync(&m))]);
    let mut log = exchange_log(&mut net);
    log.extend(run_log(&mut net, 10 * MIN));
    assert_eq!(by_ref(&log, r).first(), Some(&(3, 1)));
    let invitations = net.devs[3].node.invitations(net.now);
    assert_eq!(invitations.len(), 1);
    assert_eq!(invitations[0].chat_id, e2);
    assert!(
        !sent_in(&log, 3, e2),
        "nothing in the epoch before accepting"
    );
    assert!(!holds(&net, 3, &e2, &m));
    net.accept(3, e2);
    net.run(10 * MIN);
    assert!(holds(&net, 3, &e2, &m));
}

/// §7.6: once device 3 holds the target's epoch, a target it lacks is fetched by a
/// sync-object lookup in that epoch, without any lookup by reference.
#[test]
fn a_quoted_message_missing_from_a_held_epoch_is_fetched() {
    let mut net = MNet::new(5, true);
    net.set_ref_lookups(true);
    let g = net.create(0, &[1, 2, 3]);
    let h = net.create(4, &[1, 3]);
    net.exchange();
    for d in 1..5 {
        net.accept_all(d);
    }
    net.run(2 * MIN);
    net.offline[3] = true;
    let m = net.say(2, &g, "missed");
    net.run(MIN);
    net.offline[3] = false;
    assert!(!holds(&net, 3, &g, &m));
    let r = reference(&net, 0, &g);
    reply(&mut net, 1, &h, &[(r, sync(&m))]);
    let mut log = exchange_log(&mut net);
    log.extend(run_log(&mut net, 3 * MIN));
    let fetch = QueryOp::SyncObj {
        chat_id: g,
        sync_obj_id: sync(&m),
    };
    assert!(ops(&log).iter().any(|(f, _, op)| *f == 3 && *op == fetch));
    assert!(by_ref(&log, r).is_empty());
    assert!(holds(&net, 3, &g, &m));
}

/// A chat the user closed is never asked for, whether it was an invitation ignored and
/// deleted or a group left silently: the closed-chat marker keeps the reference of the root it
/// closes (§14.2). Why: with the chat ID only, a reply naming that chat made the device ask,
/// the root came back and was dropped, and the next reply made it ask again, so a peer could
/// see the device throw the root away; now it never asks, as a device that has not answered
/// the invitation yet.
#[test]
fn nothing_is_asked_for_a_chat_the_user_closed() {
    for installed in [false, true] {
        let mut net = MNet::new(6, true);
        net.set_ref_lookups(true);
        let g = net.create(0, &[1, 2, 3]);
        let h = net.create(4, &[1, 2, 3, 5]);
        net.exchange();
        for d in 1..6 {
            let due: Vec<ChatId> = net.devs[d]
                .node
                .invitations(net.now)
                .iter()
                .map(|i| i.chat_id)
                .filter(|c| installed || d != 3 || *c != g)
                .collect();
            for c in due {
                net.accept(d, c);
            }
        }
        net.run(2 * MIN);
        let m = net.say(0, &g, "quoted");
        net.run(MIN);
        let r = reference(&net, 0, &g);
        let now = net.now;
        let s = signer(3);
        let dev = &mut net.devs[3];
        if installed {
            dev.node
                .leave_group(
                    &mut dev.store,
                    &s,
                    g,
                    LeaveChoice::Silent,
                    now,
                    &mut net.rng,
                )
                .unwrap();
        } else {
            dev.node
                .decline_invitation(
                    &mut dev.store,
                    &s,
                    g,
                    LeaveChoice::Silent,
                    now,
                    &mut net.rng,
                )
                .unwrap();
        }
        net.run(MIN);
        assert!(net.devs[3].node.root(&g).is_none());
        reply_via(&mut net, 1, 2, 3, &h, &[(r, sync(&m))]);
        let mut log = run_log(&mut net, 5 * MIN);
        log.extend(jump(&mut net, WEEK + HOUR));
        assert!(by_ref(&log, r).is_empty(), "installed={installed}");
        assert!(net.devs[3].node.root(&g).is_none());
    }
}

// ── Off in the first release ─────────────────────────────────────────────────

/// Every frame sent, as `(from, to, frame)`.
type Log = Vec<(usize, usize, Frame)>;

/// `log` with the blob of `reply` written as an empty blob, wherever it is carried: the
/// same reply with and without `replyTo` has the same IDs (drawn from the same randomness)
/// but not the same bytes.
fn without_blob(log: Log, reply: &MessageEvent) -> Log {
    let b = blob(reply);
    log.into_iter()
        .map(|(f, t, fr)| {
            let fr = match fr {
                Frame::Event(x) if x == b => Frame::Event(Vec::new()),
                Frame::Response(Response {
                    request_id,
                    idx,
                    result: ResponseResult::Event(x),
                }) if x == b => Frame::Response(Response {
                    request_id,
                    idx,
                    result: ResponseResult::Event(Vec::new()),
                }),
                other => other,
            };
            (f, t, fr)
        })
        .collect()
}

/// What device 3 keeps and schedules for replies' references: its records, the tasks of
/// their rounds, in memory and in its store, and when it would next wake up.
fn ref_state(net: &MNet) -> (usize, usize, usize, Option<u64>) {
    let dev = &net.devs[3];
    let refs = |t: &TaskKey| matches!(t.target, Target::Ref(_));
    let stored = dev.store.load_node().unwrap();
    (
        dev.node.t.ref_lookups.len() + dev.node.t.tasks.keys().filter(|k| refs(k)).count(),
        stored.ref_lookups.len(),
        stored.tasks.keys().filter(|k| refs(k)).count(),
        dev.node.next_wakeup(&dev.store, net.now).unwrap(),
    )
}

/// What the devices send once device 3 has received the reply: ten minutes, a week and an
/// hour at once, ten minutes more.
fn afterwards(net: &mut MNet) -> Log {
    let mut log = run_log(net, 10 * MIN);
    log.extend(jump(net, WEEK + HOUR));
    log.extend(run_log(net, 10 * MIN));
    log
}

/// Scene of [`scene`], the sending side `on` or not: device 1 writes in H a reply to a
/// message of G (device 3 is no member of G), with `replyTo` or without; device 2 delivers
/// it to device 3. Returns every frame sent from the reply on, and the reply.
fn unknown_reference(on: bool, reply_to: bool) -> (Log, MessageEvent, MNet) {
    let (mut net, g, h, m) = scene(on);
    let r = reference(&net, 0, &g);
    let targets = if reply_to {
        vec![(r, sync(&m))]
    } else {
        vec![]
    };
    net.offline[3] = true;
    let e = reply(&mut net, 1, &h, &targets);
    let mut log = exchange_log(&mut net);
    net.offline[3] = false;
    net.recv_frames_m(3, 2, &[Frame::Event(blob(&e))]);
    assert_eq!(
        ref_state(&net).0,
        usize::from(on && reply_to),
        "a record only when on"
    );
    log.extend(exchange_log(&mut net));
    log.extend(afterwards(&mut net));
    (without_blob(log, &e), e, net)
}

/// Off (the first release), a reply naming an epoch device 3 cannot place makes it send
/// exactly what the same reply without `replyTo` does: no lookup by reference, nothing
/// recorded and nothing scheduled for it. On, it would ask.
#[test]
fn off_a_reply_naming_an_unknown_reference_sends_what_a_plain_reply_does() {
    let (with, e1, n1) = unknown_reference(false, true);
    let (plain, e2, n2) = unknown_reference(false, false);
    assert_eq!(e1.event_id(), e2.event_id());
    assert!(!with.is_empty());
    assert_eq!(with, plain);
    assert_eq!(ref_state(&n1), ref_state(&n2));
    assert_eq!(ref_state(&n1).0, 0);
    let (on, _, _) = unknown_reference(true, true);
    assert_ne!(on, plain, "on, device 3 asks");
}

/// Device 3 holds G but missed `m`; device 1 writes in H a reply to `m`, with `replyTo` or
/// without. Returns every frame sent from the reply on, and the reply.
fn held_epoch_missing_target(
    on: bool,
    reply_to: bool,
) -> (Log, MessageEvent, MNet, ChatId, MessageEvent) {
    let mut net = MNet::new(5, true);
    net.set_ref_lookups(on);
    let g = net.create(0, &[1, 2, 3]);
    let h = net.create(4, &[1, 3]);
    net.exchange();
    for d in 1..5 {
        net.accept_all(d);
    }
    net.run(2 * MIN);
    net.offline[3] = true;
    let m = net.say(2, &g, "missed");
    net.run(MIN);
    net.offline[3] = false;
    assert!(!holds(&net, 3, &g, &m));
    let r = reference(&net, 0, &g);
    let targets = if reply_to {
        vec![(r, sync(&m))]
    } else {
        vec![]
    };
    let e = reply(&mut net, 1, &h, &targets);
    let mut log = exchange_log(&mut net);
    assert_eq!(ref_state(&net).0, usize::from(on && reply_to));
    log.extend(afterwards(&mut net));
    (without_blob(log, &e), e, net, g, m)
}

/// Off, a reply naming a message device 3 lacks in an epoch it holds starts no fetch of that
/// message: what it sends is what the same reply without `replyTo` makes it send. On, it
/// would fetch the message by a sync-object lookup.
#[test]
fn off_a_reply_naming_a_missing_target_in_a_held_epoch_sends_what_a_plain_reply_does() {
    let (with, e1, n1, _, _) = held_epoch_missing_target(false, true);
    let (plain, e2, n2, _, _) = held_epoch_missing_target(false, false);
    assert_eq!(e1.event_id(), e2.event_id());
    assert_eq!(with, plain);
    assert_eq!(ref_state(&n1), ref_state(&n2));
    let (on, _, _, g, m) = held_epoch_missing_target(true, true);
    let fetch = QueryOp::SyncObj {
        chat_id: g,
        sync_obj_id: sync(&m),
    };
    assert!(ops(&on).iter().any(|(f, _, op)| *f == 3 && *op == fetch));
    assert!(!ops(&plain).iter().any(|(f, _, op)| *f == 3 && *op == fetch));
}

/// A run of device 3 with the sending side on left a record and the task of its first round, queued but
/// not sent; device 3 restarts with it `after`. Returns every frame sent from the restart on,
/// the reply, and the record kept before the restart.
fn restart_with_record(
    reply_to: bool,
    after: bool,
) -> (Log, MessageEvent, MNet, (usize, usize, usize)) {
    // Only device 3 had it on.
    let (mut net, g, h, m) = scene(false);
    net.ref_lookups = true;
    net.restart(3);
    net.ref_lookups = false;
    let r = reference(&net, 0, &g);
    let targets = if reply_to {
        vec![(r, sync(&m))]
    } else {
        vec![]
    };
    net.offline[3] = true;
    let e = reply(&mut net, 1, &h, &targets);
    net.exchange();
    net.offline[3] = false;
    // Device 3 receives it and starts its round with randomness of its own, so that the
    // shared one is drawn alike with and without `replyTo`.
    let mut own = TestRng::new(77);
    let pt = wire::encode_plaintext(&[Frame::Event(blob(&e))]).unwrap();
    let now = net.now;
    let dev = &mut net.devs[3];
    dev.node
        .handle_plaintext(&mut dev.store, gid(2), &pt, now, &mut own)
        .unwrap();
    net.now += 2 * MIN;
    let now = net.now;
    let s = signer(3);
    let dev = &mut net.devs[3];
    dev.node
        .tick_with(&mut dev.store, Some(&s), now, &mut own)
        .unwrap();
    let (_, records, tasks, _) = ref_state(&net);
    let before = (records, tasks, net.devs[3].node.stats().ref_rounds as usize);
    net.ref_lookups = after;
    net.restart(3);
    let mut log = exchange_log(&mut net);
    log.extend(afterwards(&mut net));
    (without_blob(log, &e), e, net, before)
}

/// Off after a run that had it on: the record and the task of the round it started, persisted
/// by that run, are dropped when the engine is opened, from its store too, and nothing of
/// them is sent: device 3 sends what it sends after the same reply without `replyTo`. On, the
/// round would go on.
#[test]
fn off_a_record_persisted_by_an_earlier_run_is_dropped_and_never_sent() {
    let (with, e1, n1, before) = restart_with_record(true, false);
    assert_eq!(
        before,
        (1, 1, 1),
        "a record and its round's task were persisted"
    );
    let (plain, e2, n2, none) = restart_with_record(false, false);
    assert_eq!(none, (0, 0, 0));
    assert_eq!(e1.event_id(), e2.event_id());
    assert_eq!(with, plain);
    assert_eq!(ref_state(&n1), ref_state(&n2));
    assert_eq!(ref_state(&n1).0, 0);
    assert_eq!(
        (ref_state(&n1).1, ref_state(&n1).2),
        (0, 0),
        "dropped from the store"
    );
    let (on, _, _, _) = restart_with_record(true, true);
    assert_ne!(on, plain, "on, the round goes on");
}
