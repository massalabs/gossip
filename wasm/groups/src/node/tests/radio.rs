//! Group messages over radio (see `crate::radio`): a message sent by radio is the same event
//! everywhere, and a member who receives it relays it online.

use super::membership::{founded, gid};
use super::*;

fn radio_send(net: &mut membership::MNet, d: usize, group: &ChatId, text: &str) -> Vec<u8> {
    let now = net.now;
    let chat = net.current(d, group).unwrap();
    let dev = &mut net.devs[d];
    let (published, datagram) = dev
        .node
        .publish_radio_text(&mut dev.store, chat, text, now, &mut net.rng)
        .unwrap();
    assert!(published.event.parents().is_empty());
    datagram
}

fn radio_receive(
    net: &mut membership::MNet,
    d: usize,
    datagram: &[u8],
) -> Option<crate::node::RadioReceived> {
    let now = net.now;
    let dev = &mut net.devs[d];
    match dev
        .node
        .receive_radio(&mut dev.store, datagram, now, &mut net.rng)
        .unwrap()?
    {
        crate::node::RadioIn::Message(r) => Some(r),
        crate::node::RadioIn::Relay(r) => panic!("a relay: {r:?}"),
    }
}

fn count(net: &membership::MNet, d: usize, group: &ChatId, text: &str) -> usize {
    net.texts(d, group).iter().filter(|t| *t == text).count()
}

#[test]
fn a_radio_message_reaches_online_members_through_a_member_in_range() {
    let (mut net, g) = founded(3);
    // Device 1 has no internet; device 2 is in radio range and online; device 0 is online only.
    net.offline[1] = true;
    let datagram = radio_send(&mut net, 1, &g, "by radio");

    let received = radio_receive(&mut net, 2, &datagram).unwrap();
    assert!(received.accepted);
    assert!(!received.older_key);
    assert_eq!(received.author, gid(1));
    assert_eq!(received.group_id, g);

    net.exchange();
    net.run(2 * MIN);
    assert_eq!(count(&net, 2, &g, "by radio"), 1);
    assert_eq!(
        count(&net, 0, &g, "by radio"),
        1,
        "relayed online by device 2"
    );

    // A replay is the same event: nothing new.
    let replay = radio_receive(&mut net, 2, &datagram).unwrap();
    assert!(!replay.accepted);

    // The author comes back online: its own copy is the same event, no duplicate.
    net.offline[1] = false;
    net.exchange();
    net.run(2 * MIN);
    for d in 0..3 {
        assert_eq!(count(&net, d, &g, "by radio"), 1, "device {d}");
    }
}

#[test]
fn an_older_key_message_is_kept_but_not_relayed() {
    let (mut net, g) = founded(4);
    let first = net.current(0, &g).unwrap();
    let old_root = net.devs[3].node.root(&first).unwrap();
    // The owner removes device 3; the others adopt the new epoch.
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
    net.exchange();
    net.run(2 * MIN);
    assert_ne!(net.current(2, &g), Some(first));

    // The removed member still holds the old epoch's radio key.
    let sealed = crate::radio::seal_text(&old_root, gid(3), net.now, [5; 4], "sneaky").unwrap();
    let received = radio_receive(&mut net, 2, &sealed.datagram).unwrap();
    assert!(received.older_key);
    assert_eq!(received.chat_id, first);

    net.exchange();
    net.run(2 * MIN);
    assert_eq!(count(&net, 0, &g, "sneaky"), 0, "not relayed online");
    assert_eq!(count(&net, 1, &g, "sneaky"), 0, "not relayed online");
}

#[test]
fn a_device_outside_the_group_opens_nothing() {
    let (mut net, g) = founded(3);
    let datagram = radio_send(&mut net, 1, &g, "members only");
    let mut stranger = membership::MNet::new(1, false);
    let now = stranger.now;
    let dev = &mut stranger.devs[0];
    assert!(
        dev.node
            .receive_radio(&mut dev.store, &datagram, now, &mut stranger.rng)
            .unwrap()
            .is_none()
    );
}

#[test]
fn a_relay_carries_an_online_message_to_a_member_with_radio_only() {
    let (mut net, g) = founded(3);
    // Device 0 writes online; device 2 relays it; device 1 only has radio.
    net.offline[1] = true;
    let chat = net.current(0, &g).unwrap();
    let now = net.now;
    let dev = &mut net.devs[0];
    let published = dev
        .node
        .publish_message(
            &mut dev.store,
            chat,
            crate::event::Body::Text("online only".into()),
            BTreeMap::new(),
            None,
            now,
            &mut net.rng,
        )
        .unwrap();
    let sync = published.event.payload().sync_obj_id();
    let relay = net.devs[2]
        .node
        .seal_radio_relay(chat, gid(0), now, &sync, "online only", &mut net.rng)
        .unwrap();

    let now = net.now;
    let dev = &mut net.devs[1];
    let Some(crate::node::RadioIn::Relay(r)) = dev
        .node
        .receive_radio(&mut dev.store, &relay, now, &mut net.rng)
        .unwrap()
    else {
        panic!("not a relay");
    };
    assert_eq!(r.group_id, g);
    assert_eq!(r.author, gid(0));
    assert_eq!(r.created_at, now);
    assert_eq!(&r.sync_ref[..], &sync.as_bytes()[..crate::radio::RELAY_REF_SIZE]);
    assert_eq!(r.text, "online only");
    assert!(!r.older_key);
    // Nothing was stored: the message itself arrives once device 1 is back online.
    assert_eq!(count(&net, 1, &g, "online only"), 0);

    // An outsider's author is refused.
    assert!(net.devs[2]
        .node
        .seal_radio_relay(chat, gid(7), now, &sync, "x", &mut net.rng)
        .is_err());
}
