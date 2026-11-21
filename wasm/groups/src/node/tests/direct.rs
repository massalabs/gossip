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
            GroupOptions {
                migrate_from,
                ..Default::default()
            },
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

    /// The groups device `d` takes part in: superseded chats of two are kept apart.
    fn group_keys(&self, d: usize) -> Vec<ChatId> {
        self.devs[d]
            .node
            .groups()
            .iter()
            .filter(|g| !matches!(g.status, MyStatus::Superseded { .. }))
            .map(|g| g.group)
            .collect()
    }

    /// The chats of two device `d` holds superseded, with the chat that continues each.
    fn superseded(&self, d: usize) -> Vec<(ChatId, ChatId)> {
        self.devs[d]
            .node
            .groups()
            .iter()
            .filter_map(|g| match g.status {
                MyStatus::Superseded { by } => Some((g.group, by)),
                _ => None,
            })
            .collect()
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
    net.run(crate::node::timing::PROMPT_DELAY_MS);
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
        message_timer: 0,
        settings: std::collections::BTreeMap::new(),
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
    let g = net.create_with(0, &[1], Some(0)).unwrap();
    net.exchange();
    assert!(net.devs[1].node.invitations(net.now).is_empty());
    assert_eq!(net.group_keys(1), vec![g]);
    assert!(
        net.changes(1)
            .iter()
            .any(|c| c.group == g && c.kind == ChangeKind::Joined)
    );
    // One-shot: a second group of two is an invitation (and, with a direct chat already
    // held, an ordinary one).
    let second = net.create_with(0, &[1], Some(0)).unwrap();
    net.exchange();
    assert!(net.devs[1].node.direct_chat_consents().is_empty());
    let inv = net.devs[1]
        .node
        .invitations(net.now + crate::node::timing::PROMPT_DELAY_MS);
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
    // A group of three from that peer, a group of two from another peer, and a group of
    // two founded with "New group" (no migrate_from): invitations.
    let three = net.create_with(0, &[1, 2], None).unwrap();
    let other = net.create_with(2, &[1], Some(0)).unwrap();
    let plain = net.create_with(0, &[1], None).unwrap();
    net.run(crate::node::timing::PROMPT_DELAY_MS);
    let inv: Vec<ChatId> = net.devs[1]
        .node
        .invitations(net.now)
        .iter()
        .map(|i| i.chat_id)
        .collect();
    assert!(inv.contains(&three) && inv.contains(&other) && inv.contains(&plain));
    assert!(net.group_keys(1).is_empty());
    assert_eq!(net.devs[1].node.direct_chat_consents().len(), 1);
    // Withdrawn, then given again and expired.
    net.consent(1, 0, false);
    assert!(net.devs[1].node.direct_chat_consents().is_empty());
    net.consent(1, 0, true);
    net.run(CONSENT_MS);
    assert!(net.devs[1].node.direct_chat_consents().is_empty());
    let late = net.create_with(0, &[1], Some(0)).unwrap();
    net.exchange();
    assert!(net.group_keys(1).is_empty());
    let _ = late;
}

#[test]
fn a_consent_given_after_the_root_arrived_adopts_it() {
    let mut net = MNet::new(2, true);
    let g = net.create_with(0, &[1], Some(0)).unwrap();
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
        net.say(lose, &groups[lose], "written");
    }
    let second = 1 - first;
    net.deliver(first, second);
    net.deliver(second, first);
    net.run(10 * MIN);
    (net, groups[keep], groups[lose])
}

/// Both keep `keep`; neither erases `lose`, which both hold superseded by `keep`, with what
/// was written in it, and which `keep` lists as its earlier chat.
fn check_crossing(net: &mut MNet, keep: ChatId, lose: ChatId, has_messages: bool) {
    let (_, loser) = sorted_pair();
    for d in 0..2 {
        assert_eq!(net.group_keys(d), vec![keep], "device {d}");
        assert_eq!(net.superseded(d), vec![(lose, keep)], "device {d}");
        assert_eq!(
            net.summary(d, &keep).unwrap().earlier,
            vec![lose],
            "device {d}"
        );
        assert!(
            net.devs[d].node.invitations(net.now + DAY).is_empty(),
            "device {d}"
        );
        assert_eq!(
            net.texts(d, &lose),
            if has_messages {
                vec!["written".to_owned()]
            } else {
                Vec::new()
            },
            "device {d}"
        );
    }
    let changes = net.changes(loser);
    assert!(changes.contains(&Change {
        group: lose,
        kind: ChangeKind::Superseded {
            by: keep,
            has_messages
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
fn messages_written_in_the_losing_group_are_kept_on_both_devices() {
    for first in 0..2 {
        let (mut net, keep, lose) = crossing(first, true);
        check_crossing(&mut net, keep, lose, true);
        // A superseded chat takes no new message, and is served to no one: a tips scan of it
        // is answered as by a device that does not hold it.
        for d in 0..2 {
            let now = net.now;
            let dev = &mut net.devs[d];
            assert!(
                dev.node
                    .publish_message(
                        &mut dev.store,
                        lose,
                        Body::Text("late".into()),
                        BTreeMap::new(),
                        None,
                        now,
                        &mut net.rng,
                    )
                    .is_err(),
                "device {d}"
            );
            let answers = super::membership::answers_of(
                &mut net,
                d,
                1 - d,
                vec![QueryOp::TipsScan {
                    anchor: lose,
                    scan_id: crate::ids::ScanId::from_bytes([3; 32]),
                    offset: 0,
                }],
            );
            assert_eq!(
                answers,
                vec![(0, ResponseResult::Status(Status::NotAvailable))],
                "device {d}"
            );
        }
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

/// The pairing rests on the two roots alone (the owner's decision): no declaration is needed
/// to settle two creations at once. A direct chat continued by a successor pairs with nothing,
/// and a later creation from the peer is then an ordinary invitation.
#[test]
fn pairing_needs_no_declaration_and_a_successor_ends_it() {
    let mut net = MNet::new(2, true);
    let a = net.create_with(0, &[1], Some(0)).unwrap();
    let b = net.create_with(1, &[0], Some(0)).unwrap();
    net.run(10 * MIN);
    let (keep, _) = sorted_pair();
    for d in 0..2 {
        assert_eq!(net.group_keys(d), vec![[a, b][keep]], "device {d}");
    }
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
        let inv = net.devs[d].node.invitations(net.now + DAY);
        assert!(
            inv.iter()
                .any(|i| i.chat_id == [a, b][1 - d] && i.migration_of.is_none()),
            "device {d}"
        );
    }
}

/// Two contact requests crossing: each device consents to the other's chat and founds its
/// own, both with migrate_from = 0; both keep the one whose owner sorts first.
#[test]
fn crossing_contact_requests_keep_one_chat() {
    for first in 0..2 {
        let mut net = MNet::new(2, true);
        net.consent(0, 1, true);
        net.consent(1, 0, true);
        let a = net.create_with(0, &[1], Some(0)).unwrap();
        let b = net.create_with(1, &[0], Some(0)).unwrap();
        net.deliver(first, 1 - first);
        net.deliver(1 - first, first);
        net.run(10 * MIN);
        let (keep, _) = sorted_pair();
        for d in 0..2 {
            assert_eq!(
                net.group_keys(d),
                vec![[a, b][keep]],
                "first {first} device {d}"
            );
            assert!(net.devs[d].node.invitations(net.now + DAY).is_empty());
        }
    }
}

/// A device that holds an accepted direct chat with a peer, grown since, takes a later
/// creation from that peer as an ordinary invitation: no migration, no consent.
#[test]
fn a_held_direct_chat_makes_a_later_one_ordinary() {
    let mut net = MNet::new(3, true);
    net.earlier(1, 0, 0, true);
    let g = net.create_with(0, &[1], Some(0)).unwrap();
    net.exchange();
    net.accept(1, g);
    net.change(
        0,
        g,
        GroupChange::Successor {
            add: vec![gid(2)],
            remove: vec![],
            name: None,
        },
    )
    .unwrap();
    net.run(5 * MIN);
    net.consent(1, 0, true);
    let again = net.create_with(0, &[1], Some(0)).unwrap();
    net.exchange();
    assert_eq!(net.group_keys(1), vec![g]);
    let inv = net.devs[1].node.invitations(net.now + DAY);
    let i = inv.iter().find(|i| i.chat_id == again).unwrap();
    assert_eq!(i.migration_of, None);
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

// ── Who took part, and continuing a conversation in a new chat (§5.12) ─────────

impl MNet {
    /// `d` founds its automatic chat with `p`, which `p` adopts under a consent and in
    /// which both write. Returns the chat.
    fn chat_taken_part_in(&mut self, d: usize, p: usize) -> ChatId {
        self.consent(p, d, true);
        let g = self.create_with(d, &[p], Some(0)).unwrap();
        self.run(2 * MIN);
        assert_eq!(self.group_keys(p), vec![g]);
        self.say(d, &g, "from the owner");
        self.say(p, &g, "from the other");
        self.run(2 * MIN);
        g
    }

    fn took_part(&self, d: usize, g: &ChatId) -> Option<bool> {
        self.summary(d, g).unwrap().took_part
    }

    fn backup(&self, d: usize) -> crate::store::MemoryStorage {
        self.devs[d].store.clone()
    }

    fn restore(&mut self, d: usize, store: crate::store::MemoryStorage) {
        self.devs[d].store = store;
        self.restart(d);
    }

    /// The due invitation of `d` for `chat`.
    fn invitation(&self, d: usize, chat: &ChatId) -> Option<InvitationSummary> {
        self.devs[d]
            .node
            .invitations(self.now + crate::node::timing::PROMPT_DELAY_MS)
            .into_iter()
            .find(|i| i.chat_id == *chat)
    }
}

/// The owner of an automatic chat records, for good, that the other person took part: a
/// message, a notice or a query of it in that chat; nothing it sends itself, no answer of the
/// peer. Other groups have no such fact.
#[test]
fn the_owner_records_that_the_other_person_took_part() {
    let mut net = MNet::new(2, true);
    let g = net.create_with(0, &[1], Some(0)).unwrap();
    net.say(0, &g, "alone");
    net.run(2 * MIN);
    // An invitation not answered: the peer took no part, whatever the owner sends.
    assert_eq!(net.took_part(0, &g), Some(false));
    net.accept(1, g);
    net.run(2 * MIN);
    assert_eq!(net.took_part(0, &g), Some(true));
    net.restart(0);
    assert_eq!(net.took_part(0, &g), Some(true));
    // The adopting side and an ordinary group have no such fact.
    assert_eq!(net.took_part(1, &g), None);
    let plain = net.create_with(0, &[1], None).unwrap();
    assert_eq!(net.took_part(0, &plain), None);
}

/// Case 5: the other person took part in the owner's chat for a long time, then founds a
/// new one: the owner gets an invitation to continue the conversation there, and nothing
/// changes unless it accepts; on accepting, its chat is superseded by the new one.
#[test]
fn a_new_chat_after_taking_part_is_an_invitation_to_continue() {
    let (l, h) = sorted_pair();
    for accept in [false, true] {
        let mut net = MNet::new(2, true);
        let gh = net.chat_taken_part_in(h, l);
        net.run(HOUR);
        let gl = net.create_with(l, &[h], Some(0)).unwrap();
        net.run(2 * MIN);
        let inv = net.invitation(h, &gl).expect("an invitation");
        assert_eq!(inv.continues, Some(gh));
        assert_eq!(net.group_keys(h), vec![gh]);
        assert!(net.superseded(h).is_empty());
        if accept {
            assert_eq!(net.accept(h, gl), gl);
            assert_eq!(net.group_keys(h), vec![gl]);
            assert_eq!(net.superseded(h), vec![(gh, gl)]);
            assert_eq!(net.summary(h, &gl).unwrap().earlier, vec![gh]);
            assert_eq!(net.texts(h, &gh).len(), 2, "nothing erased");
            net.say(h, &gl, "continued");
            net.run(2 * MIN);
            assert!(net.texts(l, &gl).contains(&"continued".to_owned()));
        } else {
            let s = signer(h);
            let now = net.now;
            let dev = &mut net.devs[h];
            dev.node
                .decline_invitation(
                    &mut dev.store,
                    &s,
                    gl,
                    LeaveChoice::Silent,
                    now,
                    &mut net.rng,
                )
                .unwrap();
            net.run(2 * MIN);
            assert_eq!(net.group_keys(h), vec![gh]);
            assert!(net.superseded(h).is_empty());
            assert_eq!(net.summary(h, &gh).unwrap().status, MyStatus::Member);
        }
    }
}

/// Cases 6 and 7: the other person, whose GossipID sorts last, founds a new chat. The device
/// that sorts first keeps its own chat whether or not that person took part in it: the new
/// chat is settled as history, with no prompt, and the other device switches back to the
/// kept chat by itself.
#[test]
fn a_new_chat_from_the_peer_that_sorts_last_is_history_whether_it_took_part() {
    let (l, h) = sorted_pair();
    // Never took part: the chat of the device that sorts first is kept, no prompt.
    let mut net = MNet::new(2, true);
    let gl = net.create_with(l, &[h], Some(0)).unwrap();
    let _ = net.outgoing(l);
    let gh = net.create_with(h, &[l], Some(0)).unwrap();
    net.deliver(h, l);
    assert!(net.invitation(l, &gh).is_none());
    assert_eq!(net.group_keys(l), vec![gl]);
    assert_eq!(net.superseded(l), vec![(gh, gl)]);
    // Took part, then restored from a backup made before it held the chat: its new chat is
    // still history on the device that keeps its own, never an invitation.
    let mut net = MNet::new(2, true);
    let before = net.backup(h);
    let gl = net.chat_taken_part_in(l, h);
    assert_eq!(net.took_part(l, &gl), Some(true));
    net.restore(h, before);
    net.run(HOUR);
    let gh = net.create_with(h, &[l], Some(0)).unwrap();
    net.say(h, &gh, "written in the new chat");
    net.run(5 * MIN);
    assert!(net.invitation(l, &gh).is_none());
    assert_eq!(net.group_keys(l), vec![gl]);
    assert_eq!(net.superseded(l), vec![(gh, gl)]);
    assert_eq!(net.summary(l, &gl).unwrap().earlier, vec![gh]);
    assert!(
        net.texts(l, &gh)
            .contains(&"written in the new chat".to_owned())
    );
    // The other device switches back to the kept chat by itself.
    net.run(HOUR);
    assert!(net.invitation(h, &gl).is_none());
    assert_eq!(net.group_keys(h), vec![gl]);
    assert_eq!(net.superseded(h), vec![(gh, gl)]);
}

/// Whether the other person took part is a plain fact, compared with no date: a chat founded
/// by that person with a creation time earlier than its first participation is still an
/// invitation to continue when it wins the tie.
#[test]
fn taking_part_is_compared_with_no_date() {
    let (l, h) = sorted_pair();
    let mut net = MNet::new(2, true);
    let founded_at = net.now;
    let gh = net.chat_taken_part_in(h, l);
    net.run(HOUR);
    // The other device's clock is behind: its new chat is dated before it took part.
    let params = crate::root::RootParams {
        name: "Direct".into(),
        members: {
            let mut m = vec![gid(l), gid(h)];
            m.sort();
            m
        },
        group_secret: crate::ids::GroupSecret::from_bytes([9; 32]),
        owner: ident(l).public.clone(),
        epoch_challenge: crate::ids::Challenge::from_bytes([8; 32]),
        ref_chat_id_challenge: crate::ids::Challenge::from_bytes([7; 32]),
        created_at: founded_at,
        message_timer: 0,
        settings: std::collections::BTreeMap::new(),
    };
    let gl = Root::create_founding(
        params,
        ChatId::from_bytes([3; 32]),
        Some(0),
        &ident(l).secret.dsa_signing_key,
        [1; 32],
    )
    .unwrap();
    let pt = root_plaintext(&gl);
    let now = net.now;
    let dev = &mut net.devs[h];
    dev.node
        .handle_plaintext(&mut dev.store, gid(l), &pt, now, &mut net.rng)
        .unwrap();
    net.run(crate::node::timing::PROMPT_DELAY_MS);
    assert_eq!(
        net.invitation(h, &gl.chat_id()).and_then(|i| i.continues),
        Some(gh)
    );
    assert_eq!(net.group_keys(h), vec![gh]);
    assert!(net.superseded(h).is_empty());
}

/// Case 7: the device that sorts first took part in the other's chat, is restored from a
/// backup made before, and founds its own: the other gets an invitation to continue, and
/// they converge on the new chat once it accepts.
#[test]
fn a_restored_device_that_took_part_founds_a_chat_to_continue() {
    let (l, h) = sorted_pair();
    let mut net = MNet::new(2, true);
    let before = net.backup(l);
    let gh = net.chat_taken_part_in(h, l);
    net.restore(l, before);
    net.run(HOUR);
    let gl = net.create_with(l, &[h], Some(0)).unwrap();
    net.run(2 * MIN);
    assert_eq!(net.invitation(h, &gl).and_then(|i| i.continues), Some(gh));
    assert_eq!(net.group_keys(h), vec![gh]);
    net.accept(h, gl);
    net.run(2 * MIN);
    for d in [l, h] {
        assert_eq!(net.group_keys(d), vec![gl], "device {d}");
    }
    assert_eq!(net.superseded(h), vec![(gh, gl)]);
}

/// Case 8: the owner restored from a backup made before the other person took part: the
/// fact is absent, and the other's new chat replaces its own by itself. Nothing is erased.
#[test]
fn an_owner_restored_before_the_other_took_part_switches_by_itself() {
    let (l, h) = sorted_pair();
    let mut net = MNet::new(2, true);
    net.consent(l, h, true);
    let gh = net.create_with(h, &[l], Some(0)).unwrap();
    let before = net.backup(h);
    net.run(2 * MIN);
    net.say(l, &gh, "from the other");
    net.run(2 * MIN);
    assert_eq!(net.took_part(h, &gh), Some(true));
    net.restore(h, before);
    assert_eq!(net.took_part(h, &gh), Some(false));
    net.run(HOUR);
    let gl = net.create_with(l, &[h], Some(0)).unwrap();
    net.run(2 * MIN);
    assert!(net.invitation(h, &gl).is_none());
    assert_eq!(net.group_keys(h), vec![gl]);
    assert_eq!(net.superseded(h), vec![(gh, gl)]);
    assert_eq!(net.superseded(l), vec![(gh, gl)]);
    assert!(net.texts(l, &gh).contains(&"from the other".to_owned()));
}

/// Case 1, the late order: the device that sorts last switches to the other's chat and takes
/// part in it before its own creating root, made before, reaches the other: still the tie
/// rule, no prompt.
#[test]
fn a_crossing_root_arriving_after_the_switch_is_no_invitation() {
    let (l, h) = sorted_pair();
    let mut net = MNet::new(2, true);
    let gl = net.create_with(l, &[h], Some(0)).unwrap();
    let gh = net.create_with(h, &[l], Some(0)).unwrap();
    // The root of the device that sorts last is held back; the other's arrives.
    let held: Vec<(usize, Vec<u8>)> = net.outgoing(h);
    net.deliver(l, h);
    assert_eq!(net.group_keys(h), vec![gl]);
    net.now += MIN;
    net.say(h, &gl, "switched");
    net.run(2 * MIN);
    assert_eq!(net.took_part(l, &gl), Some(true));
    for (r, pt) in held {
        let now = net.now;
        let dev = &mut net.devs[r];
        dev.node
            .handle_plaintext(&mut dev.store, gid(h), &pt, now, &mut net.rng)
            .unwrap();
    }
    assert!(net.invitation(l, &gh).is_none());
    assert_eq!(net.group_keys(l), vec![gl]);
    assert_eq!(net.superseded(l), vec![(gh, gl)]);
}

/// The device that keeps its chat settles every later chat of the other person as history:
/// the kept chat lists them all, oldest first, and nothing written in them is erased.
#[test]
fn the_chats_a_kept_chat_replaced_are_listed_oldest_first() {
    let (l, h) = sorted_pair();
    let mut net = MNet::new(2, true);
    let before = net.backup(h);
    let gl = net.create_with(l, &[h], Some(0)).unwrap();
    let gh = net.create_with(h, &[l], Some(0)).unwrap();
    net.run(5 * MIN);
    assert_eq!(net.summary(l, &gl).unwrap().earlier, vec![gh]);
    net.say(h, &gl, "in the kept chat");
    net.run(2 * MIN);
    net.restore(h, before);
    net.run(HOUR);
    let gh2 = net.create_with(h, &[l], Some(0)).unwrap();
    net.say(h, &gh2, "in the second chat");
    net.run(5 * MIN);
    assert!(net.invitation(l, &gh2).is_none());
    assert_eq!(net.group_keys(l), vec![gl]);
    assert_eq!(net.summary(l, &gl).unwrap().earlier, vec![gh, gh2]);
    let mut superseded = net.superseded(l);
    superseded.sort();
    let mut expected = vec![(gh, gl), (gh2, gl)];
    expected.sort();
    assert_eq!(superseded, expected);
    assert!(net.texts(l, &gl).contains(&"in the kept chat".to_owned()));
    assert!(
        net.texts(l, &gh2)
            .contains(&"in the second chat".to_owned())
    );
    assert_eq!(net.group_keys(h), vec![gl]);
}

impl MNet {
    fn decline(&mut self, d: usize, chat: ChatId, choice: LeaveChoice) {
        let s = signer(d);
        let now = self.now;
        let dev = &mut self.devs[d];
        dev.node
            .decline_invitation(&mut dev.store, &s, chat, choice, now, &mut self.rng)
            .unwrap();
    }

    /// `owner` held its chat `mine`, which no longer lists `other`, and `other` founded
    /// `theirs`: `owner` is asked to continue there. Declining changes nothing; accepting
    /// makes `theirs` the conversation on both devices, `mine` kept as history with what was
    /// written in it.
    fn check_continuation(
        &mut self,
        owner: usize,
        other: usize,
        mine: ChatId,
        theirs: ChatId,
        accept: bool,
        written: &str,
    ) {
        assert_ne!(mine, theirs);
        let inv = self.invitation(owner, &theirs).expect("an invitation");
        assert_eq!(inv.continues, Some(mine));
        assert_eq!(self.group_keys(owner), vec![mine]);
        assert!(self.superseded(owner).is_empty());
        if !accept {
            self.decline(owner, theirs, LeaveChoice::Silent);
            self.run(5 * MIN);
            assert_eq!(self.group_keys(owner), vec![mine]);
            assert!(self.superseded(owner).is_empty());
            return;
        }
        assert_eq!(self.accept(owner, theirs), theirs);
        assert_eq!(self.group_keys(owner), vec![theirs]);
        assert_eq!(self.superseded(owner), vec![(mine, theirs)]);
        assert_eq!(self.summary(owner, &theirs).unwrap().earlier, vec![mine]);
        assert!(self.texts(owner, &mine).contains(&written.to_owned()));
        self.say(owner, &theirs, "continued");
        self.run(5 * MIN);
        assert!(self.texts(other, &theirs).contains(&"continued".to_owned()));
        // The other device lists the chat it was removed from, if it holds it, as the earlier
        // part of its new chat: one conversation there too.
        let earlier = self.summary(other, &theirs).unwrap().earlier;
        let keys = self.group_keys(other);
        assert!(keys.contains(&theirs));
        for k in keys.into_iter().filter(|k| *k != theirs) {
            assert_eq!(k, mine);
            assert_eq!(earlier, vec![mine]);
            assert_eq!(
                self.summary(other, &mine).unwrap().status,
                MyStatus::Removed
            );
        }
    }
}

/// The issue of the field run, in both orders of the GossipIDs: one migrates, the other
/// declines with a signed leave (the chat shrinks to its owner alone), then migrates in
/// turn. A chat that no longer lists the other person competes in no tie: the decliner's
/// device founds a new chat, and the owner is always asked to continue there.
#[test]
fn a_migration_after_a_signed_decline_is_an_invitation_to_continue() {
    let (l, h) = sorted_pair();
    for (owner, other) in [(h, l), (l, h)] {
        for accept in [false, true] {
            let mut net = MNet::new(2, true);
            net.earlier(l, h, 0, true);
            net.earlier(h, l, 0, true);
            let mine = net.create_with(owner, &[other], Some(0)).unwrap();
            net.say(owner, &mine, "before the decline");
            net.run(2 * MIN);
            assert_eq!(net.devs[other].node.migration_of(&mine), Some(gid(owner)));
            net.decline(other, mine, LeaveChoice::Signed);
            net.run(HOUR);
            assert_eq!(net.summary(owner, &mine).unwrap().members, vec![gid(owner)]);
            assert!(!net.devs[owner].node.holds_direct_chat(&gid(other)));
            let theirs = net.create_with(other, &[owner], Some(0)).unwrap();
            net.run(5 * MIN);
            net.check_continuation(owner, other, mine, theirs, accept, "before the decline");
        }
    }
}

/// The owner removed the other person from its chat, then that person migrates: the
/// removed device no longer holds a direct chat and founds one, and the owner is always
/// asked to continue there, in both orders of the GossipIDs.
#[test]
fn a_migration_after_a_removal_is_an_invitation_to_continue() {
    let (l, h) = sorted_pair();
    for (owner, other) in [(h, l), (l, h)] {
        for accept in [false, true] {
            let mut net = MNet::new(2, true);
            let mine = net.chat_taken_part_in(owner, other);
            net.change(
                owner,
                mine,
                GroupChange::Successor {
                    add: Vec::new(),
                    remove: vec![gid(other)],
                    name: None,
                },
            )
            .unwrap();
            net.run(HOUR);
            assert_eq!(net.summary(other, &mine).unwrap().status, MyStatus::Removed);
            assert_eq!(net.summary(owner, &mine).unwrap().members, vec![gid(owner)]);
            assert!(!net.devs[other].node.holds_direct_chat(&gid(owner)));
            assert!(!net.devs[owner].node.holds_direct_chat(&gid(other)));
            let theirs = net.create_with(other, &[owner], Some(0)).unwrap();
            net.run(5 * MIN);
            net.check_continuation(owner, other, mine, theirs, accept, "from the other");
        }
    }
}

/// An invitation ignored (declined silently, a closed-chat marker left): the owner's chat
/// still lists both, so it competes by the tie rule when the one who ignored it migrates,
/// with no prompt on either side, in both orders of the GossipIDs. The device that ignored
/// the winning chat is brought back to it.
#[test]
fn a_migration_after_an_ignored_invitation_follows_the_tie_rule() {
    let (l, h) = sorted_pair();
    for (owner, other) in [(h, l), (l, h)] {
        let mut net = MNet::new(2, true);
        net.earlier(l, h, 0, true);
        net.earlier(h, l, 0, true);
        let mine = net.create_with(owner, &[other], Some(0)).unwrap();
        net.say(owner, &mine, "unanswered");
        net.run(2 * MIN);
        net.decline(other, mine, LeaveChoice::Silent);
        net.run(HOUR);
        let theirs = net.create_with(other, &[owner], Some(0)).unwrap();
        net.run(HOUR);
        let (keep, lose) = if owner == l {
            (mine, theirs)
        } else {
            (theirs, mine)
        };
        for d in [l, h] {
            assert!(
                net.invitation(d, &theirs).is_none(),
                "owner {owner} device {d}"
            );
            assert!(
                net.invitation(d, &mine).is_none(),
                "owner {owner} device {d}"
            );
            assert_eq!(net.group_keys(d), vec![keep], "owner {owner} device {d}");
        }
        assert_eq!(net.superseded(owner), vec![(lose, keep)], "owner {owner}");
        assert!(net.texts(owner, &mine).contains(&"unanswered".to_owned()));
        net.say(other, &keep, "together");
        net.run(5 * MIN);
        assert!(net.texts(owner, &keep).contains(&"together".to_owned()));
    }
}

// ── An account reinstalled into an empty device (§5.12) ──────────────────────────

impl MNet {
    /// Device `d` is reinstalled from its recovery phrase into an empty device: the same
    /// identity, nothing held, the keys of the others known again from its contacts.
    fn reinstall(&mut self, d: usize) {
        let store = crate::store::MemoryStorage::new();
        self.devs[d].node = Node::open(&store, gid(d)).unwrap();
        self.devs[d].store = store;
        let now = self.now;
        for k in 0..self.devs.len() {
            let bytes = ident(k).public.to_bytes();
            let dev = &mut self.devs[d];
            dev.node
                .learn_keys(&mut dev.store, &bytes, now, &mut self.rng)
                .unwrap();
        }
    }

    /// The invitations of `d` due by then, of any kind.
    fn invitations_of(&self, d: usize) -> Vec<InvitationSummary> {
        self.devs[d]
            .node
            .invitations(self.now + crate::node::timing::PROMPT_DELAY_MS)
    }
}

/// Found by a live run: the owner of a chat of two changes its timer (a second epoch) while
/// no session with the other person works; that person reinstalls and founds a new chat,
/// which the owner accepts as the continuation. The second epoch of the replaced chat, still
/// queued, must not reach the empty device: lacking its parent, it would be shown there as an
/// ordinary invitation to a chat the owner no longer uses.
#[test]
fn a_superseded_chat_of_two_pushes_no_later_epoch_to_its_peer() {
    let (l, h) = sorted_pair();
    let (alice, carol) = (h, l);
    let mut net = MNet::new(2, true);
    let ga = net.chat_taken_part_in(alice, carol);
    net.devs[alice].node.set_session(gid(carol), false);
    net.change(alice, ga, GroupChange::MessageTimer { timer: HOUR })
        .unwrap();
    net.run(5 * MIN);
    net.reinstall(carol);
    let gc = net.create_with(carol, &[alice], Some(0)).unwrap();
    net.run(5 * MIN);
    assert_eq!(
        net.invitation(alice, &gc).and_then(|i| i.continues),
        Some(ga)
    );
    net.accept(alice, gc);
    assert_eq!(net.superseded(alice), vec![(ga, gc)]);
    net.devs[alice].node.set_session(gid(carol), true);
    net.run(HOUR);
    assert!(net.invitations_of(carol).is_empty());
    assert_eq!(net.group_keys(carol), vec![gc]);
    assert_eq!(net.group_keys(alice), vec![gc]);
}

/// Found by a live run: the owner of a chat of two changes its timer after the other person
/// reinstalled and before that person founds a new chat. The empty device holds the second
/// epoch as an invitation and the first, fetched as its parent; once it founds its own chat,
/// that first epoch is an automatic chat of the pair and settles with it as §5.12 says, in
/// both orders of the GossipIDs: no invitation is left to a chat that is not continued.
#[test]
fn a_later_epoch_reaching_a_reinstalled_device_settles_with_its_new_chat() {
    let (l, h) = sorted_pair();
    for (alice, carol) in [(h, l), (l, h)] {
        let mut net = MNet::new(2, true);
        let ga = net.chat_taken_part_in(alice, carol);
        net.reinstall(carol);
        let second = net
            .change(alice, ga, GroupChange::MessageTimer { timer: HOUR })
            .unwrap();
        net.run(5 * MIN);
        assert!(net.invitation(carol, &second).is_some());
        let gc = net.create_with(carol, &[alice], Some(0)).unwrap();
        net.run(5 * MIN);
        net.accept_all(alice);
        net.run(HOUR);
        let keep = if alice == l { ga } else { gc };
        for d in [alice, carol] {
            assert!(net.invitations_of(d).is_empty(), "alice {alice} device {d}");
            assert_eq!(net.group_keys(d), vec![keep], "alice {alice} device {d}");
        }
        if alice == h {
            assert_eq!(net.superseded(carol), vec![(ga, gc)]);
            assert_eq!(net.current(carol, &ga), Some(second));
        }
    }
}
