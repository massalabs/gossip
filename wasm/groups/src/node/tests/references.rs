//! Replies that name an epoch by its reference (§7.6, §12.7): the chat lookup by reference
//! a device sends for an epoch it cannot place, and nothing for one it can.

use std::collections::BTreeMap;

use super::membership::{MNet, gid};
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
    let metadata = BTreeMap::from([("replyTo".to_owned(), encode_reply_to(&targets).unwrap())]);
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
/// 1, 2, 3 and 5: where the replies are written. `m` is a message of G.
fn scene() -> (MNet, ChatId, ChatId, MessageEvent) {
    let mut net = MNet::new(6, true);
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
    let (mut net, g, h, m) = scene();
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
    let (mut net, g, h, m) = scene();
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
    let (mut net, g, h, m) = scene();
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
    let (mut net, g, h, m) = scene();
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
