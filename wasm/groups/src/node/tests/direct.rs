//! Direct chats, contacts, connections and migration (§5.12).

use super::membership::{MNet, founded, gid, ident, signer};
use super::*;
use crate::node::records::ChangeKind;
use crate::test_support::Instrumented;

impl MNet {
    fn create_with(
        &mut self,
        owner: usize,
        members: &[usize],
        migrate_from: Option<u64>,
    ) -> Result<ChatId, NodeError> {
        let now = self.now;
        let s = signer(owner);
        let dev = &mut self.devs[owner];
        dev.node.create_group_with(
            &mut dev.store,
            &s,
            "Direct".into(),
            members.iter().map(|m| gid(*m)).collect(),
            GroupOptions { migrate_from },
            now,
            &mut self.rng,
        )
    }

    fn earlier(&mut self, d: usize, peer: usize, version: u64, held: bool) {
        let now = self.now;
        let dev = &mut self.devs[d];
        dev.node
            .set_earlier_conversation(&mut dev.store, gid(peer), version, held, now, &mut self.rng)
            .unwrap();
    }

    fn consent(&mut self, d: usize, peer: usize, consent: bool) {
        let now = self.now;
        let dev = &mut self.devs[d];
        dev.node
            .consent_to_direct_chat(&mut dev.store, gid(peer), consent, now, &mut self.rng)
            .unwrap();
    }

    fn changes(&mut self, d: usize) -> Vec<Change> {
        let now = self.now;
        let dev = &mut self.devs[d];
        dev.node
            .take_changes(&mut dev.store, now, &mut self.rng)
            .unwrap()
    }

    /// The plaintexts device `from` sends now, handed off, with their recipients.
    fn outgoing(&mut self, from: usize) -> Vec<(usize, Vec<u8>)> {
        let now = self.now;
        let dev = &mut self.devs[from];
        let out = dev
            .node
            .poll_outbox(&mut dev.store, now, &mut self.rng)
            .unwrap();
        let mut sent = Vec::new();
        for o in out {
            let dev = &mut self.devs[from];
            dev.node
                .handed_off(&mut dev.store, o.handle, now, &mut self.rng)
                .unwrap();
            if let Some(r) = self.idx(&o.to) {
                sent.push((r, o.plaintext));
            }
        }
        sent
    }

    /// Delivers what `from` sends now to `to` only; the rest is lost.
    fn deliver(&mut self, from: usize, to: usize) {
        let now = self.now;
        for (r, pt) in self.outgoing(from) {
            if r == to {
                let dev = &mut self.devs[r];
                dev.node
                    .handle_plaintext(&mut dev.store, gid(from), &pt, now, &mut self.rng)
                    .unwrap();
            }
        }
    }

    fn group_keys(&self, d: usize) -> Vec<ChatId> {
        self.devs[d].node.groups().iter().map(|g| g.group).collect()
    }
}

/// The plaintext of a root sent in full.
fn root_plaintext(root: &Root) -> Vec<u8> {
    let blob = wire::encode_event_blob(&EventObject::Root(Box::new(root.clone()))).unwrap();
    wire::encode_plaintext(&[Frame::Event(blob)]).unwrap()
}

/// The device of the pair whose GossipID sorts first, then the other.
fn sorted_pair() -> (usize, usize) {
    if gid(0).as_bytes() < gid(1).as_bytes() {
        (0, 1)
    } else {
        (1, 0)
    }
}

// ── migrate_from at creation and classification ──────────────────────────────

#[test]
fn a_group_of_two_carries_migrate_from_and_another_count_refuses_it() {
    let mut net = MNet::new(3, true);
    let g = net.create_with(0, &[1], Some(0)).unwrap();
    assert_eq!(net.devs[0].node.root(&g).unwrap().migrate_from(), Some(0));
    assert_eq!(
        net.create_with(0, &[1, 2], Some(0)),
        Err(NodeError::Root(crate::Error::MigrateFrom))
    );
    assert_eq!(
        net.create_with(0, &[], Some(0)),
        Err(NodeError::Root(crate::Error::MigrateFrom))
    );
    // The plain creation is unchanged.
    let plain = net.create_with(0, &[1, 2], None).unwrap();
    assert_eq!(net.devs[0].node.root(&plain).unwrap().migrate_from(), None);
}

#[test]
fn a_migration_is_one_only_with_the_earlier_conversation_declared() {
    let mut net = MNet::new(2, true);
    let g = net.create_with(0, &[1], Some(0)).unwrap();
    net.exchange();
    // Conditions 1 and 2 hold: the version is shown, not yet a migration. It is prompted at
    // once: no parent lookup holds it back.
    let inv = net.devs[1].node.invitations(net.now);
    assert_eq!(inv.len(), 1);
    assert_eq!(inv[0].chat_id, g);
    assert_eq!(inv[0].migrate_from, Some(0));
    assert_eq!(inv[0].migration_of, None);
    // Condition 3, as the caller declares it.
    net.earlier(1, 0, 0, true);
    let inv = net.devs[1].node.invitations(net.now);
    assert_eq!(inv[0].migration_of, Some(gid(0)));
    // Kept across a restart, and cleared by the caller.
    net.restart(1);
    assert_eq!(net.devs[1].node.earlier_conversations(), vec![(gid(0), 0)]);
    assert_eq!(
        net.devs[1].node.invitations(net.now)[0].migration_of,
        Some(gid(0))
    );
    net.earlier(1, 0, 0, false);
    assert_eq!(net.devs[1].node.invitations(net.now)[0].migration_of, None);
    net.earlier(1, 0, 0, true);
    // Accepting is an ordinary acceptance.
    assert_eq!(net.accept(1, g), g);
    assert_eq!(net.summary(1, &g).unwrap().members.len(), 2);
}

#[test]
fn migrate_from_is_ignored_when_a_condition_fails() {
    let mut net = MNet::new(3, true);
    net.earlier(1, 0, 0, true);
    net.earlier(1, 0, 7, true);
    // A format version this release does not know.
    let unknown = net.create_with(0, &[1], Some(7)).unwrap();
    net.exchange();
    let inv = net.devs[1].node.invitations(net.now);
    let i = inv.iter().find(|i| i.chat_id == unknown).unwrap();
    assert_eq!(i.migrate_from, Some(7));
    assert_eq!(i.migration_of, None);
    // A hostile owner forges it on a group of three: valid, an ordinary invitation.
    let cur = net.devs[0].node.root(&unknown).unwrap();
    let mut p = cur.to_proto();
    let mut members = [gid(0), gid(1), gid(2)];
    members.sort();
    p.members = members.iter().map(|m| m.as_bytes().to_vec()).collect();
    p.migrate_from = Some(0);
    p.created_at += 1;
    let forged = Root::forge(p, &ident(0).secret.dsa_signing_key);
    let pt = root_plaintext(&forged);
    let now = net.now;
    let dev = &mut net.devs[1];
    dev.node
        .handle_plaintext(&mut dev.store, gid(0), &pt, now, &mut net.rng)
        .unwrap();
    net.run(crate::constants::PROMPT_DELAY_MS);
    let inv = net.devs[1].node.invitations(net.now);
    let i = inv.iter().find(|i| i.chat_id == forged.chat_id()).unwrap();
    assert_eq!((i.migrate_from, i.migration_of), (None, None));
    // A member that replays the migration root to a third party: not a member, refused.
    let migration = net.create_with(0, &[1], Some(0)).unwrap();
    let root = net.devs[0].node.root(&migration).unwrap();
    let pt = root_plaintext(&root);
    let now = net.now;
    let dev = &mut net.devs[2];
    dev.node
        .handle_plaintext(&mut dev.store, gid(1), &pt, now, &mut net.rng)
        .unwrap();
    assert!(dev.node.root(&migration).is_none());
    assert!(
        dev.node.invitations(now + DAY).is_empty() || {
            dev.node
                .invitations(now + DAY)
                .iter()
                .all(|i| i.chat_id != migration)
        }
    );
    // A migration that continues an epoch the device holds: an ordinary root of that
    // group (here a retained member's), never a migration.
    let (mut net, g) = founded(2);
    net.earlier(1, 0, 0, true);
    let cur = net.devs[0].node.root(&g).unwrap();
    let params = crate::root::RootParams {
        name: "next".into(),
        members: cur.members().to_vec(),
        group_secret: crate::ids::GroupSecret::from_bytes([9; 32]),
        owner: ident(0).public.clone(),
        epoch_challenge: crate::ids::Challenge::from_bytes([8; 32]),
        ref_chat_id_challenge: crate::ids::Challenge::from_bytes([7; 32]),
        created_at: net.now + 1,
    };
    let next = Root::create_founding(
        params,
        g,
        Some(0),
        &ident(0).secret.dsa_signing_key,
        [1; 32],
    )
    .unwrap();
    let pt = root_plaintext(&next);
    let now = net.now;
    let dev = &mut net.devs[1];
    dev.node
        .handle_plaintext(&mut dev.store, gid(0), &pt, now, &mut net.rng)
        .unwrap();
    assert_eq!(net.current(1, &g), Some(next.chat_id()));
    assert_eq!(net.devs[1].node.groups().len(), 1);
}

// ── A new contact ──────────────────────────────────────────────────────────

#[test]
fn a_group_of_two_from_a_consented_contact_is_adopted_without_a_prompt() {
    let mut net = MNet::new(3, true);
    net.consent(1, 0, true);
    assert_eq!(net.devs[1].node.direct_chat_consents().len(), 1);
    net.restart(1);
    let g = net.create_with(0, &[1], None).unwrap();
    net.exchange();
    assert!(net.devs[1].node.invitations(net.now).is_empty());
    assert_eq!(net.group_keys(1), vec![g]);
    assert!(
        net.changes(1)
            .iter()
            .any(|c| c.group == g && c.kind == ChangeKind::Joined)
    );
    // One-shot: a second group of two is an invitation.
    let second = net.create_with(0, &[1], None).unwrap();
    net.exchange();
    assert!(net.devs[1].node.direct_chat_consents().is_empty());
    let inv = net.devs[1]
        .node
        .invitations(net.now + crate::constants::PROMPT_DELAY_MS);
    assert!(inv.iter().any(|i| i.chat_id == second));
    // Messages flow in the adopted group.
    net.run(2 * MIN);
    net.say(0, &g, "hi");
    net.run(MIN);
    assert_eq!(net.texts(1, &g), vec!["hi".to_owned()]);
}

#[test]
fn a_consent_covers_only_a_group_of_the_two_owned_by_that_peer() {
    let mut net = MNet::new(3, true);
    net.consent(1, 0, true);
    // A group of three from that peer, and a group of two from another peer: invitations.
    let three = net.create_with(0, &[1, 2], None).unwrap();
    let other = net.create_with(2, &[1], None).unwrap();
    net.run(crate::constants::PROMPT_DELAY_MS);
    let inv: Vec<ChatId> = net.devs[1]
        .node
        .invitations(net.now)
        .iter()
        .map(|i| i.chat_id)
        .collect();
    assert!(inv.contains(&three) && inv.contains(&other));
    assert!(net.group_keys(1).is_empty());
    assert_eq!(net.devs[1].node.direct_chat_consents().len(), 1);
    // Withdrawn, then given again and expired.
    net.consent(1, 0, false);
    assert!(net.devs[1].node.direct_chat_consents().is_empty());
    net.consent(1, 0, true);
    net.run(CONSENT_MS);
    assert!(net.devs[1].node.direct_chat_consents().is_empty());
    let late = net.create_with(0, &[1], None).unwrap();
    net.exchange();
    assert!(net.group_keys(1).is_empty());
    let _ = late;
}

#[test]
fn a_consent_given_after_the_root_arrived_adopts_it() {
    let mut net = MNet::new(2, true);
    let g = net.create_with(0, &[1], None).unwrap();
    net.exchange();
    assert!(net.group_keys(1).is_empty());
    net.consent(1, 0, true);
    assert_eq!(net.group_keys(1), vec![g]);
    assert!(net.devs[1].node.invitations(net.now + DAY).is_empty());
}

// ── Two creations at once ───────────────────────────────────────────────────

/// Both devices hold their earlier conversation and migrate it at once; the root of
/// `first` reaches the other device first.
fn crossing(first: usize, message_in_losing: bool) -> (MNet, ChatId, ChatId) {
    let mut net = MNet::new(2, true);
    net.earlier(0, 1, 0, true);
    net.earlier(1, 0, 0, true);
    let a = net.create_with(0, &[1], Some(0)).unwrap();
    let b = net.create_with(1, &[0], Some(0)).unwrap();
    let (keep, lose) = sorted_pair();
    let groups = [a, b];
    if message_in_losing {
        // The loser's owner writes in its own group before anything arrives.
        net.say(lose, &groups[lose], "lost");
    }
    let second = 1 - first;
    net.deliver(first, second);
    net.deliver(second, first);
    net.run(10 * MIN);
    (net, groups[keep], groups[lose])
}

fn check_crossing(net: &mut MNet, keep: ChatId, lose: ChatId, lost_messages: bool) {
    let (_, loser) = sorted_pair();
    for d in 0..2 {
        assert_eq!(net.group_keys(d), vec![keep], "device {d}");
        assert!(
            net.devs[d].node.invitations(net.now + DAY).is_empty(),
            "device {d}"
        );
    }
    let changes = net.changes(loser);
    assert!(changes.contains(&Change {
        group: lose,
        kind: ChangeKind::Superseded {
            by: keep,
            lost_messages
        }
    }));
    // Both write in the group kept.
    net.say(0, &keep, "from 0");
    net.say(1, &keep, "from 1");
    net.run(5 * MIN);
    for d in 0..2 {
        let mut t = net.texts(d, &keep);
        t.sort();
        assert_eq!(
            t,
            vec!["from 0".to_owned(), "from 1".to_owned()],
            "device {d}"
        );
    }
}

#[test]
fn crossing_migrations_keep_the_group_whose_owner_sorts_first_in_either_order() {
    for first in 0..2 {
        let (mut net, keep, lose) = crossing(first, false);
        check_crossing(&mut net, keep, lose, false);
    }
}

#[test]
fn messages_written_in_the_losing_group_are_lost_and_said_so() {
    for first in 0..2 {
        let (mut net, keep, lose) = crossing(first, true);
        check_crossing(&mut net, keep, lose, true);
    }
}

#[test]
fn a_creation_while_the_peers_migration_is_held_settles_at_once() {
    for creator_first in 0..2 {
        let mut net = MNet::new(2, true);
        net.earlier(0, 1, 0, true);
        net.earlier(1, 0, 0, true);
        let other = 1 - creator_first;
        let theirs = net.create_with(creator_first, &[other], Some(0)).unwrap();
        net.deliver(creator_first, other);
        assert_eq!(net.devs[other].node.invitations(net.now).len(), 1);
        // The other device migrates anyway.
        let got = net.create_with(other, &[creator_first], Some(0)).unwrap();
        let (keep_dev, _) = sorted_pair();
        if keep_dev == creator_first {
            assert_eq!(got, theirs, "the peer's group is adopted, none founded");
        } else {
            assert_ne!(got, theirs);
        }
        assert!(net.devs[other].node.invitations(net.now + DAY).is_empty());
        net.run(10 * MIN);
        let keep = if keep_dev == creator_first {
            theirs
        } else {
            got
        };
        for d in 0..2 {
            assert_eq!(
                net.group_keys(d),
                vec![keep],
                "case {creator_first} device {d}"
            );
        }
    }
}

#[test]
fn a_crash_while_settling_two_creations_changes_nothing_and_the_retry_settles_them() {
    let mut net = MNet::new(2, true);
    net.earlier(0, 1, 0, true);
    net.earlier(1, 0, 0, true);
    let a = net.create_with(0, &[1], Some(0)).unwrap();
    let b = net.create_with(1, &[0], Some(0)).unwrap();
    let (keep, _) = sorted_pair();
    let lose = 1 - keep;
    let groups = [a, b];
    // The loser receives the winner's root, and its commit fails.
    let out = net.outgoing(keep);
    let now = net.now;
    let mut failing = Instrumented::new(net.devs[lose].store.clone());
    failing.fail_commits = true;
    for (r, pt) in &out {
        if *r == lose {
            assert!(
                net.devs[lose]
                    .node
                    .handle_plaintext(&mut failing, gid(keep), pt, now, &mut net.rng)
                    .is_err()
            );
        }
    }
    assert_eq!(net.group_keys(lose), vec![groups[lose]]);
    // Restarted, it receives the same plaintext again: settled.
    net.restart(lose);
    for (r, pt) in &out {
        if *r == lose {
            let dev = &mut net.devs[lose];
            dev.node
                .handle_plaintext(&mut dev.store, gid(keep), pt, now, &mut net.rng)
                .unwrap();
        }
    }
    assert_eq!(net.group_keys(lose), vec![groups[keep]]);
    net.run(10 * MIN);
    for d in 0..2 {
        assert_eq!(net.group_keys(d), vec![groups[keep]]);
    }
}

#[test]
fn no_pairing_without_the_earlier_conversation_or_with_a_successor() {
    // Device 1 did not declare the conversation: device 0's root is an ordinary invitation
    // there, and device 1's own group stays.
    let mut net = MNet::new(2, true);
    net.earlier(0, 1, 0, true);
    let a = net.create_with(0, &[1], Some(0)).unwrap();
    let b = net.create_with(1, &[0], Some(0)).unwrap();
    net.deliver(0, 1);
    assert_eq!(net.group_keys(1), vec![b]);
    assert!(
        net.devs[1]
            .node
            .invitations(net.now + crate::constants::PROMPT_DELAY_MS)
            .iter()
            .any(|i| i.chat_id == a)
    );
    // A group already continued by a successor (a member added) pairs with nothing.
    let mut net = MNet::new(3, true);
    net.earlier(0, 1, 0, true);
    net.earlier(1, 0, 0, true);
    let a = net.create_with(0, &[1], Some(0)).unwrap();
    let b = net.create_with(1, &[0], Some(0)).unwrap();
    for (d, g) in [(0, a), (1, b)] {
        net.change(
            d,
            g,
            GroupChange::Successor {
                add: vec![gid(2)],
                remove: vec![],
                name: None,
            },
        )
        .unwrap();
    }
    net.run(10 * MIN);
    for d in 0..2 {
        assert!(net.group_keys(d).contains(&[a, b][d]), "device {d}");
    }
}

// ── Connections ──────────────────────────────────────────────────────────────

#[test]
fn co_members_are_the_members_of_accepted_groups_only() {
    let mut net = MNet::new(4, true);
    let g = net.create_with(0, &[1, 2], None).unwrap();
    net.exchange();
    // Invited only: nothing is opened automatically.
    assert!(!net.devs[1].node.is_co_member(&gid(0)));
    assert!(net.devs[1].node.peers_wanting_connection().is_empty());
    // Not revocable either: an invitation lists them.
    assert!(
        net.devs[1]
            .node
            .connections_to_revoke(&[gid(0), gid(2), gid(3)])
            == vec![gid(3)]
    );
    net.accept(1, g);
    assert!(net.devs[1].node.is_co_member(&gid(0)));
    assert!(net.devs[1].node.is_co_member(&gid(2)));
    assert!(!net.devs[1].node.is_co_member(&gid(1)));
    assert!(!net.devs[1].node.is_co_member(&gid(3)));
    let mut want = net.devs[1].node.peers_wanting_connection();
    want.sort();
    let mut expected = vec![gid(0), gid(2)];
    expected.sort();
    assert_eq!(want, expected);
    net.devs[1].node.set_session(gid(0), true);
    assert_eq!(net.devs[1].node.peers_wanting_connection(), vec![gid(2)]);
    // Left: no co-member any more; the closed group lists nobody.
    let now = net.now;
    let s = signer(1);
    let dev = &mut net.devs[1];
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
    assert!(!net.devs[1].node.is_co_member(&gid(0)));
    let mut revoke = net.devs[1].node.connections_to_revoke(&[gid(0), gid(2)]);
    revoke.sort();
    assert_eq!(revoke, expected);
}

#[test]
fn a_removed_member_stays_connected_while_an_epoch_lists_it() {
    let (mut net, g) = founded(3);
    net.changes(0);
    let next = net
        .change(
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
    // The set of co-members changed: reported.
    assert!(net.changes(0).contains(&Change {
        group: DEVICE,
        kind: ChangeKind::Connections
    }));
    let node = &net.devs[0].node;
    assert!(!node.is_co_member(&gid(2)));
    assert!(node.is_co_member(&gid(1)));
    // The epoch that lists it is held: replies and deletions are still owed.
    assert!(node.connections_to_revoke(&[gid(2)]).is_empty());
    let _ = next;
    // Once that epoch is gone (the group deleted here), it is revocable.
    let now = net.now;
    let dev = &mut net.devs[0];
    dev.node
        .delete_group(&mut dev.store, g, now, &mut net.rng)
        .unwrap();
    assert_eq!(
        net.devs[0].node.connections_to_revoke(&[gid(2)]),
        vec![gid(2)]
    );
    assert!(net.changes(0).contains(&Change {
        group: DEVICE,
        kind: ChangeKind::Connections
    }));
}

#[test]
fn the_winner_sends_its_root_again_when_the_losing_root_reaches_it() {
    let mut net = MNet::new(2, true);
    net.earlier(0, 1, 0, true);
    net.earlier(1, 0, 0, true);
    let a = net.create_with(0, &[1], Some(0)).unwrap();
    let b = net.create_with(1, &[0], Some(0)).unwrap();
    let (keep, lose) = sorted_pair();
    let groups = [a, b];
    // The winner's root is lost on the way; the loser's arrives.
    let _ = net.outgoing(keep);
    net.deliver(lose, keep);
    assert_eq!(net.group_keys(keep), vec![groups[keep]]);
    // The winner answers with its own root again: the loser adopts it.
    net.run(10 * MIN);
    for d in 0..2 {
        assert_eq!(net.group_keys(d), vec![groups[keep]], "device {d}");
    }
}

/// Found by the direct-chat simulation (seed 6): a device that had accepted the peer's
/// migration and then migrated again held both groups, while the peer kept one of them.
#[test]
fn a_migration_founded_after_accepting_the_peers_settles_with_it() {
    for accepter in 0..2 {
        let mut net = MNet::new(2, true);
        net.earlier(0, 1, 0, true);
        net.earlier(1, 0, 0, true);
        let creator = 1 - accepter;
        let theirs = net.create_with(creator, &[accepter], Some(0)).unwrap();
        net.exchange();
        net.accept(accepter, theirs);
        let got = net.create_with(accepter, &[creator], Some(0)).unwrap();
        net.run(10 * MIN);
        let (keep_dev, _) = sorted_pair();
        let keep = if keep_dev == creator { theirs } else { got };
        assert_eq!(got == theirs, keep_dev == creator);
        for d in 0..2 {
            assert_eq!(
                net.group_keys(d),
                vec![keep],
                "accepter {accepter} device {d}"
            );
        }
    }
}

/// Found by the direct-chat simulation (seed 14): the losing root, closed on a device that
/// had accepted it, came back in full and was prompted again as "closed before".
#[test]
fn a_losing_root_delivered_again_is_never_prompted() {
    let (keep_dev, lose_dev) = sorted_pair();
    let mut net = MNet::new(2, true);
    net.earlier(0, 1, 0, true);
    net.earlier(1, 0, 0, true);
    // The device that sorts last migrates; the other accepts, then migrates too, which
    // closes the accepted group.
    let losing = net.create_with(lose_dev, &[keep_dev], Some(0)).unwrap();
    let root = net.devs[lose_dev].node.root(&losing).unwrap();
    net.exchange();
    net.accept(keep_dev, losing);
    let kept = net.create_with(keep_dev, &[lose_dev], Some(0)).unwrap();
    assert_eq!(net.group_keys(keep_dev), vec![kept]);
    let pt = root_plaintext(&root);
    let now = net.now;
    let dev = &mut net.devs[keep_dev];
    dev.node
        .handle_plaintext(&mut dev.store, gid(lose_dev), &pt, now, &mut net.rng)
        .unwrap();
    assert!(net.devs[keep_dev].node.invitations(now + DAY).is_empty());
    assert_eq!(net.group_keys(keep_dev), vec![kept]);
}
