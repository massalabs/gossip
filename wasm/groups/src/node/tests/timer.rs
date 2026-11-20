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

/// §7.7: a group founded with a timer; its messages are deleted on every device at their
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
        assert_eq!(
            net.devs[d]
                .store
                .event_row(&g, &e.event_id())
                .unwrap()
                .map(|r| r.state),
            Some(crate::store::RowState::Pruned),
            "device {d}"
        );
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
