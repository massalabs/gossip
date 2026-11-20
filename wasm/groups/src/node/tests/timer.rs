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
