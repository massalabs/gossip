//! Which chats keep the device's automatic connections (§5.12, D.86): a chat the device is
//! out of (kicked, left once its leave is sent, superseded) keeps none, whether the user
//! kept its history read-only or deleted it, so that a member sharing nothing else with the
//! device cannot tell the two apart by the connection. An active chat, the waiting state and
//! the archive of a chat dissolved while active keep them.

use super::membership::{MNet, gid, signer};
use super::*;
use crate::node::direct::DEVICE;
use crate::node::records::{ChangeKind, GroupStatus};

/// The device R, in C = {0, R, 2} (owned by 0) and in A = {3, R} (owned by 3, active).
const R: usize = 1;

/// Every other peer, as automatic connections the caller asks about.
fn candidates() -> Vec<GossipId> {
    vec![gid(0), gid(2), gid(3)]
}

/// The peers sharing only C with R: what a chat R is out of no longer keeps.
fn only_c() -> Vec<GossipId> {
    let mut v = vec![gid(0), gid(2)];
    v.sort_unstable();
    v
}

fn setup() -> (MNet, ChatId, ChatId) {
    let mut net = MNet::new(4, true);
    let c = net.create(0, &[R, 2]);
    let a = net.create(3, &[R]);
    net.exchange();
    for m in [R, 2] {
        net.accept_all(m);
    }
    net.run(2 * MIN);
    assert!(net.summary(R, &c).is_some() && net.summary(R, &a).is_some());
    (net, c, a)
}

fn revoked(net: &MNet) -> Vec<GossipId> {
    net.devs[R].node.connections_to_revoke(&candidates())
}

fn delete(net: &mut MNet, c: ChatId) {
    let now = net.now;
    let dev = &mut net.devs[R];
    dev.node
        .delete_group(&mut dev.store, c, now, &mut net.rng)
        .unwrap();
}

fn leave(net: &mut MNet, c: ChatId, choice: LeaveChoice) {
    let now = net.now;
    let s = signer(R);
    let dev = &mut net.devs[R];
    dev.node
        .leave_group(&mut dev.store, &s, c, choice, now, &mut net.rng)
        .unwrap();
}

fn kick(net: &mut MNet, c: ChatId) {
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
    assert_eq!(net.summary(R, &c).unwrap().status, MyStatus::Removed);
}

/// R restored from a backup made before its own signed leave: it learns the leave and keeps
/// C read-only (D.2), with nothing of its own left to send.
fn left_read_only(net: &mut MNet, c: ChatId) {
    let backup = net.devs[R].store.clone();
    leave(net, c, LeaveChoice::Signed);
    net.run(2 * MIN);
    net.devs[R].store = backup;
    net.restart(R);
    net.say(R, &c, "back");
    net.run(2 * MIN);
    assert_eq!(net.summary(R, &c).unwrap().status, MyStatus::Left);
}

#[test]
fn an_active_chat_keeps_its_connections_and_the_other_peers_are_revocable_only_if_unlisted() {
    let (net, _, _) = setup();
    assert!(revoked(&net).is_empty());
    assert_eq!(
        net.devs[R].node.connections_to_revoke(&[gid(0), gid(2)]),
        Vec::<GossipId>::new()
    );
}

#[test]
fn a_kicked_device_keeps_no_connection_for_the_chat_whether_it_keeps_the_history_or_not() {
    let (mut kept, c, _) = setup();
    kick(&mut kept, c);
    let (mut deleted, c2, _) = setup();
    kick(&mut deleted, c2);
    delete(&mut deleted, c2);
    assert_eq!(revoked(&kept), only_c());
    assert_eq!(revoked(&deleted), only_c());
    // The change is reported, so that the caller revokes them.
    assert!(kept.changes_of(R).contains(&Change {
        group: DEVICE,
        kind: ChangeKind::Connections
    }));
}

#[test]
fn a_device_that_left_keeps_no_connection_for_the_chat_whether_it_keeps_the_history_or_not() {
    let (mut kept, c, _) = setup();
    left_read_only(&mut kept, c);
    let (mut deleted, c2, _) = setup();
    left_read_only(&mut deleted, c2);
    delete(&mut deleted, c2);
    assert_eq!(revoked(&kept), only_c());
    assert_eq!(revoked(&deleted), only_c());
}

#[test]
fn a_superseded_chat_keeps_no_connection() {
    let (mut net, c, _) = setup();
    // A chat of two is superseded by another chat of the same two, which keeps its peer; the
    // rule is shown on C, as no peer can be listed by a superseded chat alone.
    let g = net.devs[R].node.group_of(&c);
    if let Some(r) = net.devs[R].node.t.group_recs.get_mut(&g) {
        r.status = GroupStatus::Superseded { by: g, at: net.now };
    }
    assert_eq!(revoked(&net), only_c());
}

/// The signed leave is pushed whole to every member after the chat is closed: the connection
/// goes only once it was handed to the transport for each of them.
#[test]
fn a_visible_leave_is_handed_off_to_every_member_before_its_connections_go() {
    let (mut net, c, _) = setup();
    net.changes_of(R);
    leave(&mut net, c, LeaveChoice::Signed);
    assert!(net.devs[R].node.groups().len() == 1);
    // Queued, not sent yet: both members are still owed it.
    assert!(revoked(&net).is_empty());
    // Assembled but not yet handed off: still owed.
    let now = net.now;
    let dev = &mut net.devs[R];
    let out = dev
        .node
        .poll_outbox(&mut dev.store, now, &mut net.rng)
        .unwrap();
    assert!(!out.is_empty());
    assert!(revoked(&net).is_empty());
    // Handed off for one member only: that member alone is revocable.
    let first = out[0].to;
    for o in out.iter().filter(|o| o.to == first) {
        let dev = &mut net.devs[R];
        dev.node
            .handed_off(&mut dev.store, o.handle, now, &mut net.rng)
            .unwrap();
    }
    assert_eq!(revoked(&net), vec![first]);
    assert!(net.changes_of(R).contains(&Change {
        group: DEVICE,
        kind: ChangeKind::Connections
    }));
    for o in out.iter().filter(|o| o.to != first) {
        let dev = &mut net.devs[R];
        dev.node
            .handed_off(&mut dev.store, o.handle, now, &mut net.rng)
            .unwrap();
    }
    net.exchange();
    assert_eq!(revoked(&net), only_c());
    assert!(net.changes_of(R).contains(&Change {
        group: DEVICE,
        kind: ChangeKind::Connections
    }));
}

/// The waiting state keeps every connection of the chat (the kick can come from any member);
/// it ends with the kick or after two weeks without one, closing the chat as "Ignore and
/// Delete" does, and the connections go then.
#[test]
fn waiting_for_a_kick_keeps_the_connections_until_the_kick_or_two_weeks() {
    // No kick comes: the owner is offline throughout.
    let (mut net, c, _) = setup();
    net.offline[0] = true;
    leave(&mut net, c, LeaveChoice::AskToBeKicked);
    net.run(MIN);
    assert_eq!(net.summary(R, &c).unwrap().status, MyStatus::Waiting);
    assert!(revoked(&net).is_empty());
    net.now += 13 * DAY;
    net.tick(R);
    assert_eq!(net.summary(R, &c).unwrap().status, MyStatus::Waiting);
    assert!(revoked(&net).is_empty());
    net.now += 2 * DAY;
    net.tick(R);
    assert!(net.summary(R, &c).is_none(), "closed after two weeks");
    assert_eq!(revoked(&net), only_c());
    // The others still list R as a member.
    assert!(net.summary(2, &c).unwrap().members.contains(&gid(R)));

    // The kick comes: closed at once.
    let (mut net, c, _) = setup();
    leave(&mut net, c, LeaveChoice::AskToBeKicked);
    net.run(2 * MIN);
    assert!(net.summary(R, &c).is_none());
    assert_eq!(revoked(&net), only_c());
}

#[test]
fn the_archive_of_a_chat_dissolved_while_active_keeps_its_connections() {
    let (mut net, c, _) = setup();
    let now = net.now;
    let s = signer(0);
    let dev = &mut net.devs[0];
    dev.node
        .dissolve_group(&mut dev.store, &s, c, false, now, &mut net.rng)
        .unwrap();
    net.exchange();
    assert_eq!(
        net.summary(R, &c).unwrap().status,
        MyStatus::Dissolved { deleted: false }
    );
    assert!(revoked(&net).is_empty());
}

/// Kicked, its connections revoked, then added back: the device is invited again, and once it
/// accepts, the members are co-members it reconnects to.
#[test]
fn a_member_kicked_then_added_back_reconnects_and_joins() {
    let (mut net, c, _) = setup();
    for p in [0, 2, 3] {
        net.devs[R].node.set_session(gid(p), true);
    }
    kick(&mut net, c);
    let gone = revoked(&net);
    assert_eq!(gone, only_c());
    for p in &gone {
        net.devs[R].node.set_session(*p, false);
    }
    assert!(net.devs[R].node.peers_wanting_connection().is_empty());
    net.change(
        0,
        c,
        GroupChange::Successor {
            add: vec![gid(R)],
            remove: vec![],
            name: None,
        },
    )
    .unwrap();
    net.exchange();
    net.accept_all(R);
    net.run(2 * MIN);
    assert_eq!(net.summary(R, &c).unwrap().status, MyStatus::Member);
    let mut want = net.devs[R].node.peers_wanting_connection();
    want.sort_unstable();
    assert_eq!(want, only_c());
    assert!(revoked(&net).is_empty());
    net.say(2, &c, "welcome back");
    net.run(2 * MIN);
    assert!(net.texts(R, &c).contains(&"welcome back".to_owned()));
}

impl MNet {
    fn changes_of(&mut self, d: usize) -> Vec<Change> {
        let now = self.now;
        let dev = &mut self.devs[d];
        dev.node
            .take_changes(&mut dev.store, now, &mut self.rng)
            .unwrap()
    }
}
