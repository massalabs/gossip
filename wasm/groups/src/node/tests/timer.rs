//! The message timer and the settings map of a root (§4.1, §7.7): carried forward by the
//! owner, changed by the owner, and the deletion of each message at its creation date plus
//! the timer of its epoch, on every device, with nothing sent.

use std::collections::BTreeMap;

use super::membership::{MNet, gid, ident};
use super::*;

const HOUR: u64 = 60 * MIN;

/// A root of owner 0 founding a group of `members`, with a message timer and settings,
/// installed on the owner's device as an accepted epoch.
fn install_timed(
    net: &mut MNet,
    members: &[usize],
    timer: u64,
) -> (ChatId, BTreeMap<String, Vec<u8>>) {
    let settings = BTreeMap::from([
        ("gossip.later.a".to_owned(), vec![1, 2, 3]),
        ("gossip.later.b".to_owned(), Vec::new()),
    ]);
    let params = RootParams {
        name: "Timed".into(),
        members: members.iter().map(|m| gid(*m)).collect(),
        group_secret: GroupSecret::from_bytes([0x31; 32]),
        owner: ident(0).public.clone(),
        epoch_challenge: Challenge::from_bytes([0x32; 32]),
        ref_chat_id_challenge: Challenge::from_bytes([0x33; 32]),
        created_at: net.now,
        message_timer: timer,
        settings: settings.clone(),
    };
    let root = Root::create_successor(
        params,
        &[ChatId::from_bytes([0x34; 32])],
        &ident(0).secret.dsa_signing_key,
        [0x35; 32],
    )
    .unwrap();
    let g = root.chat_id();
    let now = net.now;
    let dev = &mut net.devs[0];
    dev.node
        .install_epoch(
            &mut dev.store,
            EpochConfig {
                root,
                accepted: true,
                group_state: GroupState::Active,
                removed: Default::default(),
            },
            false,
            now,
            &mut net.rng,
        )
        .unwrap();
    (g, settings)
}

/// §4.1 "Carried forward": every root the owner's device builds next copies the message
/// timer and the whole settings map, entries it does not understand included, so that an
/// owner on an older release never erases what a newer one set.
#[test]
fn the_owner_carries_the_timer_and_every_setting_forward() {
    let mut net = MNet::new(4, true);
    let (g, settings) = install_timed(&mut net, &[0, 1, 2], HOUR);
    let changes = [
        GroupChange::Successor {
            add: vec![gid(3)],
            remove: vec![],
            name: None,
        },
        GroupChange::Successor {
            add: vec![],
            remove: vec![gid(3)],
            name: Some("Renamed".into()),
        },
        GroupChange::Handover {
            new_owner: gid(1),
            leave: false,
            name: None,
        },
    ];
    for change in changes {
        let next = net.change(0, g, change.clone()).unwrap();
        let root = net.devs[0].node.root(&next).unwrap();
        assert_eq!(root.message_timer(), HOUR, "{change:?}");
        assert_eq!(root.settings(), &settings, "{change:?}");
    }
}

/// Owner 0 founds a group of `members` with the message timer `timer`; every member
/// accepts.
fn found_timed(net: &mut MNet, members: &[usize], timer: u64) -> ChatId {
    let now = net.now;
    let s = super::membership::signer(0);
    let dev = &mut net.devs[0];
    let g = dev
        .node
        .create_group_with(
            &mut dev.store,
            &s,
            "Timed".into(),
            members.iter().map(|m| gid(*m)).collect(),
            GroupOptions {
                message_timer: timer,
                ..GroupOptions::default()
            },
            now,
            &mut net.rng,
        )
        .unwrap();
    net.exchange();
    for &d in members {
        let inv = net.devs[d].node.invitations(net.now);
        assert_eq!(inv.len(), 1, "device {d}");
        assert_eq!(inv[0].message_timer, timer, "device {d}");
        net.accept_all(d);
    }
    net.run(2 * MIN);
    g
}

/// §7.7: a group founded with a timer; its messages are erased on every device at their
/// moment, a device offline until after it never shows it, and nothing is sent for it.
#[test]
fn a_group_founded_with_a_timer_deletes_its_messages_on_every_device() {
    let mut net = MNet::new(3, true);
    let g = found_timed(&mut net, &[1, 2], HOUR);
    for d in 0..3 {
        let s = net.summary(d, &g).unwrap();
        assert_eq!(s.message_timer, HOUR, "device {d}");
        assert_eq!(s.timers.len(), 1, "device {d}");
        assert_eq!(
            (s.timers[0].epoch, s.timers[0].message_timer),
            (g, HOUR),
            "device {d}"
        );
    }
    net.offline[2] = true;
    let sent = net.now;
    let e = net.say(0, &g, "brief");
    net.run(MIN);
    assert_eq!(net.texts(1, &g), vec!["brief".to_owned()]);
    net.run(sent + HOUR - net.now);
    for d in 0..2 {
        assert!(net.texts(d, &g).is_empty(), "device {d}");
        // Erased with every record of it: no stub, no parent links, no object.
        let store = &net.devs[d].store;
        assert!(
            store.event_row(&g, &e.event_id()).unwrap().is_none(),
            "device {d}"
        );
        assert!(
            store.parents(&g, &e.event_id()).unwrap().is_none(),
            "device {d}"
        );
        let sync = e.payload().sync_obj_id();
        assert!(store.object(&g, &sync).unwrap().is_none(), "device {d}");
    }
    net.offline[2] = false;
    net.run(30 * MIN);
    assert!(net.texts(2, &g).is_empty());
    assert!(
        net.devs[2]
            .store
            .event_row(&g, &e.event_id())
            .unwrap()
            .is_none()
    );
}

/// §7.7: the owner changes the timer by a new root; each message keeps the timer of its own
/// epoch, and the view lists every epoch with its timer and when it started. Only the owner
/// changes it.
#[test]
fn the_owner_changes_the_timer_and_each_message_keeps_the_timer_of_its_epoch() {
    let mut net = MNet::new(3, true);
    let g = found_timed(&mut net, &[1, 2], HOUR);
    let start = net.now;
    net.say(1, &g, "old");
    net.run(MIN);
    assert_eq!(
        net.change(1, g, GroupChange::MessageTimer { timer: 0 }),
        Err(NodeError::NotOwner)
    );
    let e2 = net
        .change(0, g, GroupChange::MessageTimer { timer: 3 * HOUR })
        .unwrap();
    net.run(MIN);
    let root = net.devs[0].node.root(&e2).unwrap();
    assert_eq!(root.message_timer(), 3 * HOUR);
    assert_eq!(root.members().len(), 3);
    assert_eq!(root.name(), "Timed");
    net.say(2, &g, "new");
    net.run(MIN);
    for d in 0..3 {
        assert_eq!(net.current(d, &g), Some(e2), "device {d}");
        let s = net.summary(d, &g).unwrap();
        assert_eq!(s.message_timer, 3 * HOUR, "device {d}");
        let timers: Vec<(ChatId, u64)> = s
            .timers
            .iter()
            .map(|t| (t.epoch, t.message_timer))
            .collect();
        assert_eq!(timers, vec![(g, HOUR), (e2, 3 * HOUR)], "device {d}");
        assert!(
            s.timers[0].started_at < s.timers[1].started_at,
            "device {d}"
        );
        assert_eq!(net.texts(d, &g), vec!["old".to_owned(), "new".to_owned()]);
    }
    net.run(start + HOUR + MIN - net.now);
    for d in 0..3 {
        assert_eq!(net.texts(d, &g), vec!["new".to_owned()], "device {d}");
    }
    net.run(3 * HOUR);
    for d in 0..3 {
        assert!(net.texts(d, &g).is_empty(), "device {d}");
    }
}

/// §7.7: a member removed from the group keeps a read-only archive, whose messages are
/// deleted at their moment as everywhere else.
#[test]
fn a_removed_members_archive_deletes_its_messages_too() {
    let mut net = MNet::new(3, true);
    let g = found_timed(&mut net, &[1, 2], HOUR);
    let sent = net.now;
    net.say(0, &g, "brief");
    net.run(MIN);
    net.change(
        0,
        g,
        GroupChange::Successor {
            add: vec![],
            remove: vec![gid(2)],
            name: None,
        },
    )
    .unwrap();
    net.run(2 * MIN);
    assert_eq!(net.summary(2, &g).unwrap().status, MyStatus::Removed);
    assert_eq!(net.texts(2, &g), vec!["brief".to_owned()]);
    net.run(sent + HOUR - net.now);
    assert!(net.texts(2, &g).is_empty());
}

/// The lookup entries for `id` that device 0 sends now.
fn lookups_of(net: &mut Net, id: EventId) -> Vec<super::retrieval::Sent> {
    super::retrieval::sent_lookups(net, 0)
        .into_iter()
        .filter(|s| matches!(s.op, QueryOp::Event { event_id, .. } if event_id == id))
        .collect()
}

/// Whether device 0 keeps a hint naming `id` (§10.3).
fn hinted(net: &Net, id: EventId) -> bool {
    net.devs[0].node.t.hints.iter().any(|(k, _)| k.2 == id)
}

/// §7.7, §11.1: once the timer erased a message, nothing about it is left on the device,
/// not even a hint of which peer had seen it; an event still held that names it as a
/// parent does not make the device look it up, however long it waits.
#[test]
fn an_erased_event_is_not_looked_up_for_a_child_still_held() {
    let mut net = Net::timed(4, 1, HOUR);
    let chat = net.chat();
    let e1 = net.event(T0, 1, &[], 1);
    let e2 = net.event(T0 + 30 * MIN, 2, &[e1.event_id()], 1);
    net.give(0, 1, &e1);
    net.poll(0);
    assert!(hinted(&net, e1.event_id()));
    net.now = T0 + 30 * MIN;
    net.give(0, 1, &e2);
    net.poll(0);
    net.now = T0 + HOUR;
    net.tick(0);
    assert!(!net.known(0, &e1.event_id()));
    assert!(net.held(0, &e2.event_id()));
    assert!(!hinted(&net, e1.event_id()));
    for _ in 0..12 {
        assert!(lookups_of(&mut net, e1.event_id()).is_empty());
        net.now += 10 * MIN;
        net.tick(0);
    }
    assert!(!net.known(0, &e2.event_id()));
    assert!(net.devs[0].store.event_rows(&chat).unwrap().is_empty());
    assert!(net.devs[0].store.edges(&chat).unwrap().is_empty());
    assert!(net.devs[0].store.objects(&chat).unwrap().is_empty());
}

/// §7.7, §11: a peer whose clock is late still holds an erased event and offers it again.
/// Each offer costs at most one lookup: the event comes back, is refused by its dates and
/// nothing is stored, relayed or hinted, so two devices never pass it back and forth. A
/// child that arrives late and names it starts one lookup task, which asks each member at
/// most once and then pauses: every honest device erased the event at the same moment.
#[test]
fn an_erased_event_offered_again_costs_at_most_one_lookup_per_offer() {
    let mut net = Net::timed(4, 1, HOUR);
    let chat = net.chat();
    let e1 = net.event(T0, 1, &[], 1);
    net.give(0, 1, &e1);
    net.poll(0);
    net.now = T0 + HOUR;
    net.tick(0);
    assert!(!net.known(0, &e1.event_id()));
    for _ in 0..3 {
        net.recv_frames(0, member(1), &[notice(chat, &[e1.event_id()])]);
        let q = lookups_of(&mut net, e1.event_id());
        assert_eq!(q.len(), 1);
        assert_eq!(q[0].to, member(1));
        super::retrieval::answer(&mut net, 0, &q[0], ResponseResult::Event(blob(&e1)));
        assert!(!net.known(0, &e1.event_id()));
        assert!(!hinted(&net, e1.event_id()));
        let sent = net.poll_frames(0);
        assert!(
            sent.values()
                .all(|f| !announced(f).contains(&e1.event_id()))
        );
        assert!(
            sent.values()
                .all(|f| !full_events(f).contains(&e1.event_id()))
        );
        net.now += MIN;
    }
    // A child published before the moment arrives late and names it.
    let e3 = net.event(T0 + 50 * MIN, 3, &[e1.event_id()], 2);
    net.give(0, 2, &e3);
    assert!(net.held(0, &e3.event_id()));
    let mut asked = Vec::new();
    for _ in 0..200 {
        for q in lookups_of(&mut net, e1.event_id()) {
            asked.push(q.to);
            let na = ResponseResult::Status(Status::NotAvailable);
            super::retrieval::answer(&mut net, 0, &q, na);
        }
        net.now += 10 * MIN;
        net.tick(0);
    }
    asked.sort_unstable();
    assert_eq!(asked, vec![member(1), member(2), member(3)]);
    assert!(!net.known(0, &e1.event_id()));
}

// ── Deletions for a message the device never processed (§7.7, §14.1) ─────────

const DAY: u64 = 24 * HOUR;

/// Whether device 0 announces `id` in what it sends now.
fn announces(net: &mut Net, id: EventId) -> bool {
    net.poll_frames(0)
        .values()
        .any(|f| announced(f).contains(&id) || full_events(f).contains(&id))
}

/// Member 2 asks device 0 for `id` by a direct event lookup; the event answered, if any.
fn looked_up(net: &mut Net, rid: u8, id: EventId) -> Option<MessageEvent> {
    let chat = net.chat();
    let q = query(
        rid,
        net.now,
        MIN,
        vec![QueryOp::Event {
            chat_id: chat,
            event_id: id,
        }],
    );
    net.recv_frames(0, member(2), &[q]);
    let frames = net.poll_frames(0).remove(&member(2)).unwrap_or_default();
    let rs = responses(&frames);
    assert_eq!(rs.len(), 1);
    answer_event(&rs[0])
}

/// The event IDs device 0 lists to member 2 in a new tips scan.
fn listed(net: &mut Net, rid: u8) -> Vec<EventId> {
    super::scans::ids(&super::scans::page(super::scans::ask(net, 2, rid, rid, 0)))
}

/// §7.7, §14.1: a deletion that arrives before its message is neither announced nor listed
/// in a tips scan, and is answered on a direct request. Once the message arrives a moment
/// later, blocked by the tombstone, the record is shareable again and the deletion is
/// listed as any other.
#[test]
fn a_deletion_before_its_message_is_offered_once_the_message_arrives() {
    let mut net = Net::timed(3, 1, HOUR);
    let e = net.event(T0, 1, &[], 1);
    let d = net.deletion(T0 + 10, 2, 1);
    net.now = T0 + 11;
    net.give(0, 1, &d);
    assert!(!announces(&mut net, d.event_id()));
    assert!(listed(&mut net, 1).is_empty());
    assert_eq!(looked_up(&mut net, 2, d.event_id()), Some(d.clone()));
    net.now = T0 + 12;
    net.give(0, 1, &e);
    assert!(net.known(0, &e.event_id()));
    assert!(!net.held(0, &e.event_id()));
    assert_eq!(listed(&mut net, 3), vec![d.event_id()]);
}

/// §7.7, §14.1: a deletion for a message already erased is kept quiet: not announced, not
/// listed in a tips scan, served on direct request, and erased at the time it was processed
/// plus the timer, rounded up to the step of the timer; a restart changes nothing.
#[test]
fn a_late_deletion_is_not_offered_but_served_on_request_and_then_erased() {
    let mut net = Net::timed(3, 1, HOUR);
    let e = net.event(T0, 1, &[], 1);
    net.give(0, 1, &e);
    net.poll(0);
    net.now = T0 + HOUR;
    net.tick(0);
    assert!(!net.known(0, &e.event_id()));
    let d = net.deletion(T0 + 10, 2, 1);
    let at = T0 + 2 * HOUR + 7;
    net.now = at;
    net.give(0, 1, &d);
    assert!(net.held(0, &d.event_id()));
    assert!(!announces(&mut net, d.event_id()));
    assert!(listed(&mut net, 1).is_empty());
    assert_eq!(looked_up(&mut net, 2, d.event_id()), Some(d.clone()));
    // A restart reads the same record.
    let dev = &mut net.devs[0];
    dev.node = Node::open(&dev.store, member(0)).unwrap();
    assert!(listed(&mut net, 3).is_empty());
    let erase = (at + HOUR).div_ceil(5 * MIN) * 5 * MIN;
    net.now = erase - 1;
    net.tick(0);
    assert!(net.held(0, &d.event_id()));
    net.now = erase;
    net.tick(0);
    assert!(!net.known(0, &d.event_id()));
    assert!(net.devs[0].store.objects(&net.chat()).unwrap().is_empty());
}

/// §7.7: in a quiet chat with a long timer, devices that receive a deletion at staggered
/// times, after its message was deleted everywhere, keep it to themselves; the deletion
/// disappears from every device within a bounded time. If those devices offered it to each
/// other, each copy would restart the deadline of the next and it would never go.
#[test]
fn a_deletion_received_at_staggered_times_disappears_from_every_device() {
    let timer = 2 * DAY;
    let mut net = MNet::new(4, true);
    let g = found_timed(&mut net, &[1, 2, 3], timer);
    let chat = net.current(0, &g).unwrap();
    net.offline[2] = true;
    net.offline[3] = true;
    let start = net.now;
    let m = net.say(0, &g, "short-lived");
    let sync = m.payload().sync_obj_id();
    net.run(MIN);
    let now = net.now;
    let dev = &mut net.devs[0];
    let d = dev
        .node
        .publish_deletion(&mut dev.store, chat, sync, None, now, &mut net.rng)
        .unwrap()
        .event;
    net.run(MIN);
    let holds = |net: &MNet, i: usize| {
        net.devs[i]
            .store
            .event_row(&chat, &d.event_id())
            .unwrap()
            .is_some()
    };
    let shareable = |net: &MNet, i: usize| {
        net.devs[i]
            .store
            .object(&chat, &sync)
            .unwrap()
            .map(|o| o.shareable)
    };
    assert!(holds(&net, 1));
    assert_eq!(shareable(&net, 1), Some(true));
    // Coarse steps: ticks and exchanges every ten minutes.
    let run = |net: &mut MNet, until: u64| {
        while net.now < until {
            net.now = (net.now + 10 * MIN).min(until);
            for i in 0..net.devs.len() {
                if !net.offline[i] {
                    net.tick(i);
                }
            }
            net.exchange();
        }
    };
    run(&mut net, start + 12 * HOUR);
    net.offline[2] = false;
    run(&mut net, start + 24 * HOUR);
    assert!(holds(&net, 2), "device 2 fetched the deletion by a scan");
    assert_eq!(shareable(&net, 2), Some(false));
    net.offline[3] = false;
    // Device 2 restarts in between: the record keeps its state.
    net.restart(2);
    run(&mut net, start + 2 * DAY);
    assert!(holds(&net, 3), "device 3 fetched the deletion by a scan");
    assert_eq!(shareable(&net, 3), Some(false));

    // The last device received it before `start + 2 days`: every copy is gone a timer
    // later, rounded up to a day, plus a day of margin.
    run(&mut net, start + 5 * DAY);
    for i in 0..4 {
        assert!(!holds(&net, i), "device {i} still holds the deletion");
        assert!(net.devs[i].store.object(&chat, &sync).unwrap().is_none());
    }
    // And it does not come back.
    run(&mut net, start + 8 * DAY);
    for i in 0..4 {
        assert!(!holds(&net, i), "device {i} holds the deletion again");
    }
}

/// A timed epoch of five members, devices for the first three, in which device 0 has member
/// 2 as a removed peer (§10.4); device 2 does not know of its removal.
fn timed_with_removed() -> Net {
    let mut net = Net::timed(5, 3, HOUR);
    let mut cfg = config(&net.root);
    cfg.removed = BTreeSet::from([member(2)]);
    let dev = &mut net.devs[0];
    dev.node
        .install_epoch(&mut dev.store, cfg, false, T0, &mut net.rng)
        .unwrap();
    net
}

/// §7.7, §10.4, §14.1: a device holding a quiet deletion pushes it in full to the removed
/// peers of the epoch, as a deletion is pushed to them, and offers it to no current member,
/// neighbor or not: no full event, no notice. A removed peer relays nothing, so this cannot
/// renew the deletion between devices.
#[test]
fn a_quiet_deletion_is_pushed_in_full_to_removed_peers_only() {
    let mut net = timed_with_removed();
    super::dissemination::neighbors_of(&mut net, 0, &[1, 3]);
    let d = net.deletion(T0 + 10, 2, 1);
    net.now = T0 + 11;
    net.give(0, 1, &d);
    let chat = net.chat();
    assert_eq!(
        net.devs[0]
            .store
            .object(&chat, &d.payload().sync_obj_id())
            .unwrap()
            .map(|o| o.shareable),
        Some(false)
    );
    let sent = net.poll_frames(0);
    for (to, frames) in &sent {
        let full = full_events(frames).contains(&d.event_id());
        let notice = announced(frames).contains(&d.event_id());
        if *to == member(2) {
            assert!(full, "the removed peer gets the deletion in full");
        } else {
            assert!(!full && !notice, "a current member is offered the deletion");
        }
    }
    assert!(
        sent.get(&member(2))
            .is_some_and(|f| full_events(f).contains(&d.event_id())),
        "nothing pushed to the removed peer"
    );
    assert!(listed(&mut net, 1).is_empty());
}

/// §10.4: the removed peer keeps the quiet deletion pushed to it and passes it on to no one,
/// although it does not know of its removal: the record is quiet there too, and it has no
/// removed peer of its own.
#[test]
fn a_removed_peer_does_not_pass_a_pushed_quiet_deletion_on() {
    let mut net = timed_with_removed();
    let d = net.deletion(T0 + 10, 2, 1);
    net.now = T0 + 11;
    net.give(0, 1, &d);
    let pushed = net.poll_frames(0).remove(&member(2)).unwrap_or_default();
    net.recv_frames(2, member(0), &pushed);
    assert!(
        net.held(2, &d.event_id()),
        "the removed peer keeps the deletion"
    );
    for (to, frames) in net.poll_frames(2) {
        assert!(
            !full_events(&frames).contains(&d.event_id())
                && !announced(&frames).contains(&d.event_id()),
            "the removed peer passed the deletion on to {to:?}"
        );
    }
}

/// §7.7, §10.4: as [`a_deletion_received_at_staggered_times_disappears_from_every_device`],
/// in an epoch with removed peers: every device that receives the quiet deletion pushes it to
/// them, one of them back online only after the deletion was published, and the deletion still disappears from every
/// device within a bounded time.
#[test]
fn a_quiet_deletion_pushed_to_removed_peers_still_disappears_from_every_device() {
    let timer = 2 * DAY;
    let mut net = MNet::new(6, true);
    let g = found_timed(&mut net, &[1, 2, 3, 4, 5], timer);
    let chat = net.current(0, &g).unwrap();
    net.offline[2] = true;
    net.offline[3] = true;
    net.offline[5] = true;
    let start = net.now;
    let m = net.say(0, &g, "short-lived");
    let sync = m.payload().sync_obj_id();
    net.run(MIN);
    net.change(
        0,
        g,
        GroupChange::Successor {
            add: vec![],
            remove: vec![gid(4), gid(5)],
            name: None,
        },
    )
    .unwrap();
    net.run(2 * MIN);
    // Devices 2 and 3 learn of the successor while offline, so that they look up the
    // superseded epoch once back.
    let next = net.current(0, &g).unwrap();
    let root = net.devs[0].node.root(&next).unwrap();
    let blob = wire::encode_event_blob(&EventObject::Root(Box::new(root))).unwrap();
    for d in [2, 3] {
        net.recv_frames_m(d, 0, &[Frame::Event(blob.clone())]);
        assert_eq!(net.current(d, &g), Some(next), "device {d}");
    }
    let now = net.now;
    let dev = &mut net.devs[0];
    let d = dev
        .node
        .publish_deletion(&mut dev.store, chat, sync, None, now, &mut net.rng)
        .unwrap()
        .event;
    net.run(MIN);
    let holds = |net: &MNet, i: usize| {
        net.devs[i]
            .store
            .event_row(&chat, &d.event_id())
            .unwrap()
            .is_some()
    };
    let shareable = |net: &MNet, i: usize| {
        net.devs[i]
            .store
            .object(&chat, &sync)
            .unwrap()
            .map(|o| o.shareable)
    };
    assert!(holds(&net, 1) && holds(&net, 4));
    let run = |net: &mut MNet, until: u64| {
        while net.now < until {
            net.now = (net.now + 10 * MIN).min(until);
            for i in 0..net.devs.len() {
                if !net.offline[i] {
                    net.tick(i);
                }
            }
            net.exchange();
        }
    };
    run(&mut net, start + 12 * HOUR);
    net.offline[2] = false;
    net.offline[5] = false;
    run(&mut net, start + 24 * HOUR);
    assert!(holds(&net, 2), "device 2 fetched the deletion by a scan");
    assert_eq!(shareable(&net, 2), Some(false));
    assert!(holds(&net, 5), "the removed device 5 got the deletion");
    assert_eq!(shareable(&net, 5), Some(false));
    net.offline[3] = false;
    run(&mut net, start + 2 * DAY);
    assert!(holds(&net, 3), "device 3 fetched the deletion by a scan");
    assert_eq!(shareable(&net, 3), Some(false));

    run(&mut net, start + 5 * DAY);
    for i in 0..6 {
        assert!(!holds(&net, i), "device {i} still holds the deletion");
        assert!(net.devs[i].store.object(&chat, &sync).unwrap().is_none());
    }
    run(&mut net, start + 8 * DAY);
    for i in 0..6 {
        assert!(!holds(&net, i), "device {i} holds the deletion again");
    }
}
