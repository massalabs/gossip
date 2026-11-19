//! Groups of several epochs (§4, §5): roots created by the owner, received, adopted and
//! answered; signed objects; replies to removed peers; queries of milestone 4; the state
//! for the interface.

use std::collections::BTreeMap;
use std::sync::OnceLock;

use super::*;
use crate::keys::KeySigner;
use crate::node::records::{EpochStatus, GroupStatus, SignedObject};
use crate::rng::TestRng;
use crate::store::MemoryStorage;
use crate::test_support::{Identity, identity};
use crate::{Kick, Leave};

/// Identities 0 to 11, derived once.
pub(crate) fn ident(i: usize) -> &'static Identity {
    static IDS: OnceLock<Vec<Identity>> = OnceLock::new();
    &IDS.get_or_init(|| (0..12).map(|s| identity(s as u8 + 101)).collect())[i]
}

pub(crate) fn signer(i: usize) -> KeySigner<'static> {
    KeySigner {
        public: ident(i).public.clone(),
        signing_key: &ident(i).secret.dsa_signing_key,
    }
}

pub(crate) fn gid(i: usize) -> GossipId {
    ident(i).id
}

/// Devices of real identities, connected by hand: everything sent is delivered by
/// [`MNet::exchange`] unless the recipient is offline.
pub(crate) struct MNet {
    pub devs: Vec<Dev>,
    pub rng: TestRng,
    pub now: u64,
    pub offline: Vec<bool>,
    /// Plaintexts dropped because the recipient was offline: `(from, to, bytes)`.
    pub dropped: Vec<(usize, usize, Vec<u8>)>,
}

impl MNet {
    /// `n` devices; with `contacts`, each knows every other's keys.
    pub(crate) fn new(n: usize, contacts: bool) -> Self {
        let mut rng = TestRng::new(11);
        let devs: Vec<Dev> = (0..n)
            .map(|i| {
                let store = MemoryStorage::new();
                let node = Node::open(&store, gid(i)).unwrap();
                Dev { node, store }
            })
            .collect();
        let mut net = Self {
            devs,
            rng: TestRng::new(12),
            now: T0,
            offline: vec![false; n],
            dropped: Vec::new(),
        };
        for d in 0..n {
            for k in 0..n {
                if contacts || k == d {
                    let bytes = ident(k).public.to_bytes();
                    let dev = &mut net.devs[d];
                    dev.node
                        .learn_keys(&mut dev.store, &bytes, T0, &mut rng)
                        .unwrap();
                }
            }
        }
        net
    }

    pub(crate) fn idx(&self, id: &GossipId) -> Option<usize> {
        (0..self.devs.len()).find(|i| gid(*i) == *id)
    }

    pub(crate) fn tick(&mut self, d: usize) {
        let now = self.now;
        let s = signer(d);
        let dev = &mut self.devs[d];
        dev.node
            .tick_with(&mut dev.store, Some(&s), now, &mut self.rng)
            .unwrap();
    }

    /// Delivers everything until quiet; offline devices neither send nor receive.
    pub(crate) fn exchange(&mut self) {
        for _ in 0..200 {
            let mut any = false;
            for d in 0..self.devs.len() {
                if self.offline[d] {
                    continue;
                }
                let now = self.now;
                let dev = &mut self.devs[d];
                let out = dev
                    .node
                    .poll_outbox(&mut dev.store, now, &mut self.rng)
                    .unwrap();
                for o in out {
                    let dev = &mut self.devs[d];
                    dev.node
                        .handed_off(&mut dev.store, o.handle, now, &mut self.rng)
                        .unwrap();
                    any = true;
                    let Some(r) = self.idx(&o.to) else { continue };
                    if self.offline[r] {
                        self.dropped.push((d, r, o.plaintext));
                        continue;
                    }
                    let dev = &mut self.devs[r];
                    dev.node
                        .handle_plaintext(&mut dev.store, gid(d), &o.plaintext, now, &mut self.rng)
                        .unwrap();
                }
            }
            if !any {
                return;
            }
        }
        panic!("the devices never went quiet");
    }

    /// Lets `ms` pass in steps of a minute, ticking and exchanging.
    pub(crate) fn run(&mut self, ms: u64) {
        let end = self.now + ms;
        while self.now < end {
            self.now = (self.now + MIN).min(end);
            for d in 0..self.devs.len() {
                if !self.offline[d] {
                    self.tick(d);
                }
            }
            self.exchange();
        }
    }

    pub(crate) fn create(&mut self, owner: usize, members: &[usize]) -> ChatId {
        let now = self.now;
        let s = signer(owner);
        let dev = &mut self.devs[owner];
        dev.node
            .create_group(
                &mut dev.store,
                &s,
                "Team".into(),
                members.iter().map(|m| gid(*m)).collect(),
                now,
                &mut self.rng,
            )
            .unwrap()
    }

    pub(crate) fn change(
        &mut self,
        d: usize,
        group: ChatId,
        change: GroupChange,
    ) -> Result<ChatId, NodeError> {
        let now = self.now;
        let s = signer(d);
        let dev = &mut self.devs[d];
        dev.node
            .change_group(&mut dev.store, &s, group, change, now, &mut self.rng)
    }

    pub(crate) fn accept(&mut self, d: usize, chat: ChatId) -> ChatId {
        let now = self.now;
        let dev = &mut self.devs[d];
        dev.node
            .accept_invitation(&mut dev.store, chat, now, &mut self.rng)
            .unwrap()
    }

    /// Device `d` accepts every invitation due.
    pub(crate) fn accept_all(&mut self, d: usize) -> Vec<ChatId> {
        let due: Vec<ChatId> = self.devs[d]
            .node
            .invitations(self.now)
            .iter()
            .map(|i| i.chat_id)
            .collect();
        due.into_iter().map(|c| self.accept(d, c)).collect()
    }

    pub(crate) fn current(&self, d: usize, group: &ChatId) -> Option<ChatId> {
        self.devs[d].node.current_epoch(group)
    }

    pub(crate) fn summary(&self, d: usize, chat: &ChatId) -> Option<GroupSummary> {
        self.devs[d].node.group(chat)
    }

    pub(crate) fn say(&mut self, d: usize, group: &ChatId, text: &str) -> MessageEvent {
        let now = self.now;
        let chat = self.current(d, group).unwrap();
        let dev = &mut self.devs[d];
        dev.node
            .publish_message(
                &mut dev.store,
                chat,
                Body::Text(text.into()),
                BTreeMap::new(),
                None,
                now,
                &mut self.rng,
            )
            .unwrap()
            .event
    }

    pub(crate) fn texts(&self, d: usize, group: &ChatId) -> Vec<String> {
        self.devs[d]
            .node
            .timeline(&self.devs[d].store, group, self.now)
            .unwrap()
            .into_iter()
            .filter_map(|i| match i {
                TimelineItem::Message(m) => match m.content.body {
                    Body::Text(t) => Some(t),
                    _ => None,
                },
                TimelineItem::Line { .. } => None,
            })
            .collect()
    }

    pub(crate) fn lines(&self, d: usize, group: &ChatId) -> Vec<TimelineLine> {
        self.devs[d]
            .node
            .timeline(&self.devs[d].store, group, self.now)
            .unwrap()
            .into_iter()
            .filter_map(|i| match i {
                TimelineItem::Line { line, .. } => Some(line),
                TimelineItem::Message(_) => None,
            })
            .collect()
    }

    /// Restarts device `d` from its store.
    pub(crate) fn restart(&mut self, d: usize) {
        let dev = &mut self.devs[d];
        dev.node = Node::open(&dev.store, gid(d)).unwrap();
    }
}

/// A group of owner 0 and members 1..n, accepted by everyone, with neighbors formed.
pub(crate) fn founded(n: usize) -> (MNet, ChatId) {
    let mut net = MNet::new(n, true);
    let members: Vec<usize> = (1..n).collect();
    let g = net.create(0, &members);
    net.exchange();
    for d in 1..n {
        let accepted = net.accept_all(d);
        assert_eq!(accepted.len(), 1, "device {d}");
    }
    net.run(2 * MIN);
    (net, g)
}

#[test]
fn a_new_group_is_an_invitation_shown_once_the_owner_answers() {
    let mut net = MNet::new(3, true);
    let g = net.create(0, &[1, 2]);
    assert_eq!(net.summary(0, &g).unwrap().status, MyStatus::Member);
    net.exchange();
    for d in 1..3 {
        // The parent lookup reached the owner, who answered "not available": the prompt is
        // shown before PROMPT_DELAY.
        let inv = net.devs[d].node.invitations(net.now);
        assert_eq!(inv.len(), 1, "device {d}");
        assert_eq!(inv[0].owner, gid(0));
        assert_eq!(inv[0].members.len(), 3);
        assert_eq!(inv[0].received_from, None);
        assert!(net.devs[d].node.groups().is_empty());
    }
    let got = net.accept(1, g);
    assert_eq!(got, g);
    assert_eq!(net.summary(1, &g).unwrap().status, MyStatus::Member);
    net.run(2 * MIN);
    let e = net.say(0, &g, "hello");
    net.run(MIN);
    assert!(net.texts(1, &g).contains(&"hello".to_owned()));
    // Device 2 has not accepted: nothing of the epoch is staged there.
    assert!(net.texts(2, &g).is_empty());
    assert!(
        net.devs[2]
            .store
            .event_row(&g, &e.event_id())
            .unwrap()
            .is_none()
    );
}

#[test]
fn the_prompt_waits_for_the_lookup_or_five_minutes() {
    let mut net = MNet::new(3, true);
    let g = net.create(0, &[1, 2]);
    // The owner goes offline before answering the parent lookup.
    net.offline[0] = false;
    let now = net.now;
    let dev = &mut net.devs[0];
    let out = dev
        .node
        .poll_outbox(&mut dev.store, now, &mut net.rng)
        .unwrap();
    for o in out {
        let dev = &mut net.devs[0];
        dev.node
            .handed_off(&mut dev.store, o.handle, now, &mut net.rng)
            .unwrap();
        if o.to == gid(1) {
            let dev = &mut net.devs[1];
            dev.node
                .handle_plaintext(&mut dev.store, gid(0), &o.plaintext, now, &mut net.rng)
                .unwrap();
        }
    }
    net.offline[0] = true;
    net.exchange();
    assert!(net.devs[1].node.invitations(net.now).is_empty());
    net.run(crate::node::timing::PROMPT_DELAY_MS);
    assert_eq!(net.devs[1].node.invitations(net.now).len(), 1);
    let _ = g;
}

#[test]
fn adding_a_member_is_adopted_by_members_and_invites_the_newcomer() {
    let (mut net, g) = founded(3);
    // A fourth device that knows everyone.
    let store = MemoryStorage::new();
    let node = Node::open(&store, gid(3)).unwrap();
    net.devs.push(Dev { node, store });
    net.offline.push(false);
    for k in 0..4 {
        let bytes = ident(k).public.to_bytes();
        let now = net.now;
        let dev = &mut net.devs[3];
        dev.node
            .learn_keys(&mut dev.store, &bytes, now, &mut net.rng)
            .unwrap();
    }
    net.say(1, &g, "before");
    net.run(MIN);
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
    for d in 0..3 {
        assert_eq!(net.current(d, &g), Some(e2), "device {d}");
        assert_eq!(net.summary(d, &g).unwrap().members.len(), 4);
    }
    // The newcomer gets an invitation, then joins a separate conversation of its own (it
    // holds no parent).
    let joined = net.accept_all(3);
    assert_eq!(joined, vec![e2]);
    net.run(3 * MIN);
    net.say(3, &e2, "hi from 3");
    net.run(2 * MIN);
    for d in 0..4 {
        let key = if d == 3 { e2 } else { g };
        assert!(
            net.texts(d, &key).contains(&"hi from 3".to_owned()),
            "device {d}"
        );
    }
    // The newcomer never sees the earlier epoch.
    assert!(!net.texts(3, &e2).contains(&"before".to_owned()));
    // The members see an epoch change line.
    let lines = net.lines(1, &g);
    assert!(
        lines.iter().any(
            |l| matches!(l, TimelineLine::EpochChange { added, .. } if added == &vec![gid(3)])
        )
    );
}

#[test]
fn removing_a_member_kicks_it_and_it_learns_its_removal() {
    let (mut net, g) = founded(4);
    let e2 = net
        .change(
            0,
            g,
            GroupChange::Successor {
                add: vec![],
                remove: vec![gid(3)],
                name: None,
            },
        )
        .unwrap();
    assert_eq!(net.devs[0].node.stats().kicks_created, 1);
    net.exchange();
    for d in 0..3 {
        assert_eq!(net.current(d, &g), Some(e2), "device {d}");
    }
    let s3 = net.summary(3, &g).unwrap();
    assert_eq!(s3.status, MyStatus::Removed);
    assert_eq!(s3.current, g);
    assert!(net.lines(3, &g).contains(&TimelineLine::YouWereRemoved));
    // Retained members hold the kick and the removed member is no longer served.
    let kick = crate::hash::kick_id(&g, &gid(3));
    assert!(net.devs[1].node.t.signed.contains(&(
        g,
        crate::wire::SignedKind::Kick,
        *kick.as_bytes()
    )));
    let line = net.lines(1, &g);
    assert!(line.iter().any(
        |l| matches!(l, TimelineLine::EpochChange { removed, .. } if removed == &vec![gid(3)])
    ));
    // A message of the new epoch never reaches it.
    net.say(1, &g, "secret");
    net.run(3 * MIN);
    assert!(!net.texts(3, &g).contains(&"secret".to_owned()));
}

#[test]
fn a_signed_leave_makes_the_owner_create_a_successor_without_a_kick() {
    let (mut net, g) = founded(4);
    let now = net.now;
    let s = signer(2);
    let dev = &mut net.devs[2];
    dev.node
        .leave_group(
            &mut dev.store,
            &s,
            g,
            LeaveChoice::Signed,
            now,
            &mut net.rng,
        )
        .unwrap();
    assert!(net.devs[2].node.groups().is_empty());
    assert!(net.devs[2].node.t.markers.contains(&g));
    net.exchange();
    // The owner waits 30 s without a new leave.
    assert_eq!(net.current(0, &g), Some(g));
    net.run(MIN);
    let e2 = net.current(0, &g).unwrap();
    assert_ne!(e2, g);
    assert_eq!(net.devs[0].node.stats().auto_successors, 1);
    assert_eq!(net.devs[0].node.stats().kicks_created, 0);
    for d in [1, 3] {
        assert_eq!(net.current(d, &g), Some(e2), "device {d}");
        let lines = net.lines(d, &g);
        assert!(
            lines.iter().any(
                |l| matches!(l, TimelineLine::EpochChange { left, .. } if left == &vec![gid(2)])
            ),
            "device {d}: {lines:?}"
        );
    }
    // The closed device rejects the successor automatically.
    assert!(net.devs[2].node.invitations(net.now).is_empty());
}

#[test]
fn installed_epochs_come_back_from_storage_after_a_restart() {
    let (mut net, g) = founded(3);
    let e2 = net
        .change(
            0,
            g,
            GroupChange::Successor {
                add: vec![],
                remove: vec![],
                name: Some("New".into()),
            },
        )
        .unwrap();
    net.exchange();
    for d in 0..3 {
        net.restart(d);
        let s = net.summary(d, &g).unwrap();
        assert_eq!(s.current, e2);
        assert_eq!(s.name, "New");
    }
    net.say(2, &g, "after restart");
    net.run(2 * MIN);
    assert!(net.texts(0, &g).contains(&"after restart".to_owned()));
}

#[test]
fn a_handover_makes_the_new_owner_and_the_old_owners_roots_side_branches() {
    let (mut net, g) = founded(4);
    let h = net
        .change(
            0,
            g,
            GroupChange::Handover {
                new_owner: gid(1),
                leave: false,
                name: None,
            },
        )
        .unwrap();
    net.exchange();
    for d in 0..4 {
        assert_eq!(net.summary(d, &g).unwrap().owner, gid(1), "device {d}");
        assert_eq!(net.current(d, &g), Some(h));
    }
    // The old owner can no longer change the group.
    assert_eq!(
        net.change(
            0,
            g,
            GroupChange::Successor {
                add: vec![],
                remove: vec![gid(2)],
                name: None
            }
        ),
        Err(NodeError::NotOwner)
    );
    // The new owner removes a member.
    let e3 = net
        .change(
            1,
            g,
            GroupChange::Successor {
                add: vec![],
                remove: vec![gid(3)],
                name: None,
            },
        )
        .unwrap();
    net.exchange();
    for d in 0..3 {
        assert_eq!(net.current(d, &g), Some(e3), "device {d}");
    }
    assert_eq!(net.summary(3, &g).unwrap().status, MyStatus::Removed);
}

#[test]
fn hand_over_and_leave_closes_the_group_on_the_old_owner() {
    let (mut net, g) = founded(3);
    let h = net
        .change(
            0,
            g,
            GroupChange::Handover {
                new_owner: gid(2),
                leave: true,
                name: None,
            },
        )
        .unwrap();
    assert!(net.devs[0].node.groups().is_empty());
    net.exchange();
    for d in 1..3 {
        let s = net.summary(d, &g).unwrap();
        assert_eq!(s.current, h);
        assert_eq!(s.owner, gid(2));
        assert_eq!(s.members, {
            let mut v = vec![gid(1), gid(2)];
            v.sort();
            v
        });
    }
}

#[test]
fn dissolving_ends_the_group_everywhere() {
    let (mut net, g) = founded(3);
    net.say(1, &g, "kept");
    net.run(MIN);
    let now = net.now;
    let s = signer(0);
    let dev = &mut net.devs[0];
    dev.node
        .dissolve_group(&mut dev.store, &s, g, false, now, &mut net.rng)
        .unwrap();
    net.exchange();
    for d in 0..3 {
        let s = net.summary(d, &g).unwrap();
        assert_eq!(
            s.status,
            MyStatus::Dissolved { deleted: false },
            "device {d}"
        );
        assert!(net.texts(d, &g).contains(&"kept".to_owned()));
        assert!(net.lines(d, &g).contains(&TimelineLine::Dissolved));
    }
    // "Dissolve & Delete" afterwards erases the messages.
    let now = net.now;
    let dev = &mut net.devs[0];
    let s = signer(0);
    assert!(
        dev.node
            .dissolve_group(&mut dev.store, &s, g, true, now, &mut net.rng)
            .is_err()
    );
}

#[test]
fn dissolve_and_delete_erases_the_messages_and_leaves_a_marker_after_two_weeks() {
    let (mut net, g) = founded(3);
    net.say(1, &g, "gone");
    net.run(MIN);
    let now = net.now;
    let s = signer(0);
    let dev = &mut net.devs[0];
    dev.node
        .dissolve_group(&mut dev.store, &s, g, true, now, &mut net.rng)
        .unwrap();
    net.exchange();
    for d in 0..3 {
        assert_eq!(
            net.summary(d, &g).unwrap().status,
            MyStatus::Dissolved { deleted: true }
        );
        assert!(net.texts(d, &g).is_empty(), "device {d}");
    }
    net.now += 15 * DAY;
    for d in 0..3 {
        net.tick(d);
        assert!(net.devs[d].node.groups().is_empty());
        assert_eq!(
            net.devs[d].node.t.markers.get(&g),
            Some(&crate::node::records::Marker::Dissolved)
        );
    }
}

#[test]
fn asking_to_be_kicked_waits_and_the_kick_closes_the_group() {
    let (mut net, g) = founded(3);
    let now = net.now;
    let s = signer(2);
    let dev = &mut net.devs[2];
    dev.node
        .leave_group(
            &mut dev.store,
            &s,
            g,
            LeaveChoice::AskToBeKicked,
            now,
            &mut net.rng,
        )
        .unwrap();
    assert_eq!(net.summary(2, &g).unwrap().status, MyStatus::Waiting);
    net.run(2 * MIN);
    // The owner removed it with a kick, and the waiting device closed the group.
    let s0 = net.summary(0, &g).unwrap();
    assert!(!s0.members.contains(&gid(2)));
    assert_eq!(net.devs[0].node.stats().kicks_created, 1);
    assert!(net.devs[2].node.groups().is_empty());
    assert!(net.devs[2].node.t.markers.contains(&g));
}

#[test]
fn a_removed_peer_is_answered_with_its_kick_at_most_three_times_a_day() {
    let (mut net, g) = founded(4);
    // Device 3 is offline through its removal.
    net.offline[3] = true;
    let e2 = net
        .change(
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
    net.dropped.clear();
    assert_eq!(net.current(1, &g), Some(e2));
    // Back online, it still acts in the old epoch; a retained member answers with the kick.
    net.offline[3] = false;
    net.say(3, &g, "still here?");
    net.run(2 * MIN);
    assert_eq!(net.summary(3, &g).unwrap().status, MyStatus::Removed);
    let replies: u64 = (0..3)
        .map(|d| net.devs[d].node.stats().removal_replies)
        .sum();
    assert!(replies >= 1);
    for d in 0..3 {
        let r = net.devs[d]
            .node
            .t
            .replies
            .iter()
            .map(|(_, r)| r.count)
            .max()
            .unwrap_or(0);
        assert!(r <= 3);
    }
}

#[test]
fn a_member_added_back_rejoins_its_conversation() {
    let (mut net, g) = founded(3);
    net.say(2, &g, "old history");
    net.run(MIN);
    let e2 = net
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
    net.run(MIN);
    assert_eq!(net.summary(2, &g).unwrap().status, MyStatus::Removed);
    let e3 = net
        .change(
            0,
            g,
            GroupChange::Successor {
                add: vec![gid(2)],
                remove: vec![],
                name: None,
            },
        )
        .unwrap();
    // The root has one more parent: the last epoch device 2 was a member of.
    assert_eq!(net.devs[0].node.root(&e3).unwrap().parents().len(), 2);
    net.exchange();
    let inv = net.devs[2].node.invitations(net.now);
    assert_eq!(inv.len(), 1);
    assert_eq!(inv[0].rejoins, Some(g));
    let joined = net.accept(2, e3);
    assert_eq!(joined, g);
    let s = net.summary(2, &g).unwrap();
    assert_eq!(s.status, MyStatus::Member);
    assert_eq!(s.current, e3);
    assert!(net.texts(2, &g).contains(&"old history".to_owned()));
    let lines = net.lines(2, &g);
    assert!(
        lines
            .iter()
            .any(|l| matches!(l, TimelineLine::NotAMember { .. })),
        "{lines:?}"
    );
    let _ = e2;
}

#[test]
fn a_forged_root_is_refused_and_penalised() {
    let (mut net, g) = founded(3);
    // Member 2 builds a root naming itself owner but signed with another key.
    let cur = net.devs[2].node.root(&g).unwrap();
    let params = crate::root::RootParams {
        name: "mine".into(),
        members: cur.members().to_vec(),
        group_secret: crate::ids::GroupSecret::from_bytes([9; 32]),
        owner: ident(2).public.clone(),
        epoch_challenge: crate::ids::Challenge::from_bytes([8; 32]),
        ref_chat_id_challenge: crate::ids::Challenge::from_bytes([7; 32]),
        created_at: net.now,
    };
    // A root of member 2 as owner continuing the group: valid signature, no authority.
    let own =
        Root::create_successor(params, &[g], &ident(2).secret.dsa_signing_key, [1; 32]).unwrap();
    let now = net.now;
    // First with a wrong signature: a failed announcement.
    let mut p = own.to_proto();
    p.signature[0] ^= 1;
    let bad = Root::from_proto(1, p).unwrap();
    let blob = wire::encode_event_blob(&EventObject::Root(Box::new(bad))).unwrap();
    let pt = wire::encode_plaintext(&[Frame::Event(blob)]).unwrap();
    let dev = &mut net.devs[1];
    let before = dev.node.score(&gid(2));
    dev.node
        .handle_plaintext(&mut dev.store, gid(2), &pt, now, &mut net.rng)
        .unwrap();
    assert!(dev.node.score(&gid(2)) < before);
    assert!(!dev.node.t.epochs.contains(&own.chat_id()));
    // Then valid: no authority over the held parent, so an invitation, not a continuation
    // (D.3).
    let blob = wire::encode_event_blob(&EventObject::Root(Box::new(own.clone()))).unwrap();
    let pt = wire::encode_plaintext(&[Frame::Event(blob)]).unwrap();
    let dev = &mut net.devs[1];
    dev.node
        .handle_plaintext(&mut dev.store, gid(2), &pt, now, &mut net.rng)
        .unwrap();
    assert_eq!(net.current(1, &g), Some(g));
    assert!(matches!(
        net.devs[1]
            .node
            .t
            .epochs
            .get(&own.chat_id())
            .unwrap()
            .status,
        EpochStatus::Invitation(_)
    ));
    assert_eq!(net.devs[1].node.stats().failed_announcements, 1);
}

#[test]
fn a_forged_kick_is_refused() {
    let (mut net, g) = founded(3);
    let root = net.devs[1].node.root(&g).unwrap();
    // Member 2 signs a "kick" of member 1 with its own key.
    let forged = Kick::sign_as(
        &root,
        gid(1),
        &ident(2).secret.dsa_signing_key,
        &ident(2).public,
        [3; 32],
    )
    .unwrap();
    let blob = wire::encode_event_blob(&EventObject::Kick(forged)).unwrap();
    let pt = wire::encode_plaintext(&[Frame::Event(blob)]).unwrap();
    let now = net.now;
    let dev = &mut net.devs[1];
    dev.node
        .handle_plaintext(&mut dev.store, gid(2), &pt, now, &mut net.rng)
        .unwrap();
    assert_eq!(net.summary(1, &g).unwrap().status, MyStatus::Member);
    assert!(net.devs[1].node.t.signed.len() == 0);
}

#[test]
fn keys_are_fetched_from_members_and_a_wrong_answer_is_penalised() {
    let mut net = MNet::new(3, false);
    let g = net.create(0, &[1, 2]);
    net.exchange();
    net.accept_all(1);
    net.accept_all(2);
    net.run(2 * MIN);
    // Every member obtained every other member's keys by key queries.
    for d in 0..3 {
        for k in 0..3 {
            assert!(
                net.devs[d].node.keys(&gid(k)).is_some(),
                "device {d} lacks {k}"
            );
        }
    }
    let _ = g;
}

#[test]
fn a_shared_chats_scan_finds_the_latest_epochs() {
    let (mut net, g) = founded(3);
    let e2 = net
        .change(
            0,
            g,
            GroupChange::Successor {
                add: vec![],
                remove: vec![],
                name: Some("x".into()),
            },
        )
        .unwrap();
    net.exchange();
    assert_eq!(net.devs[1].node.shared_epochs(&gid(2)), vec![e2]);
    // A device that lost everything finds the group again from a contact.
    let store = MemoryStorage::new();
    net.devs[2] = Dev {
        node: Node::open(&store, gid(2)).unwrap(),
        store,
    };
    for k in 0..3 {
        let bytes = ident(k).public.to_bytes();
        let now = net.now;
        let dev = &mut net.devs[2];
        dev.node
            .learn_keys(&mut dev.store, &bytes, now, &mut net.rng)
            .unwrap();
    }
    let now = net.now;
    let dev = &mut net.devs[2];
    dev.node
        .scan_shared_chats(&mut dev.store, gid(1), now, &mut net.rng)
        .unwrap();
    net.run(2 * MIN);
    let inv = net.devs[2].node.invitations(net.now);
    assert_eq!(inv.iter().map(|i| i.chat_id).collect::<Vec<_>>(), vec![e2]);
}

#[test]
fn the_changes_are_reported_once() {
    let (mut net, g) = founded(3);
    let now = net.now;
    let dev = &mut net.devs[1];
    let _ = dev
        .node
        .take_changes(&mut dev.store, now, &mut net.rng)
        .unwrap();
    net.say(0, &g, "x");
    net.run(MIN);
    let dev = &mut net.devs[1];
    let c = dev
        .node
        .take_changes(&mut dev.store, now, &mut net.rng)
        .unwrap();
    assert!(c.contains(&Change {
        group: g,
        kind: records::ChangeKind::Messages
    }));
    let dev = &mut net.devs[1];
    assert!(
        dev.node
            .take_changes(&mut dev.store, now, &mut net.rng)
            .unwrap()
            .is_empty()
    );
}

#[test]
fn a_device_restored_from_an_old_backup_learns_its_leave() {
    let (mut net, g) = founded(3);
    let backup = net.devs[2].store.clone();
    let now = net.now;
    let s = signer(2);
    let dev = &mut net.devs[2];
    dev.node
        .leave_group(
            &mut dev.store,
            &s,
            g,
            LeaveChoice::Signed,
            now,
            &mut net.rng,
        )
        .unwrap();
    net.run(2 * MIN);
    assert!(net.summary(0, &g).unwrap().current != g);
    // Restored from the backup: it acts in its old epoch and gets its own leave back (D.2).
    net.devs[2].store = backup;
    net.restart(2);
    net.say(2, &g, "I am back");
    net.run(2 * MIN);
    assert_eq!(net.summary(2, &g).unwrap().status, MyStatus::Left);
    assert!(net.lines(2, &g).contains(&TimelineLine::YouLeft));
}

#[test]
fn an_owner_fork_is_resolved_by_a_root_naming_both_ends() {
    let (mut net, g) = founded(4);
    let backup = net.devs[0].store.clone();
    let a = net
        .change(
            0,
            g,
            GroupChange::Successor {
                add: vec![],
                remove: vec![],
                name: Some("A".into()),
            },
        )
        .unwrap();
    net.exchange();
    // The owner restores its backup and creates another successor: a fork.
    net.devs[0].store = backup;
    net.restart(0);
    let b = net
        .change(
            0,
            g,
            GroupChange::Successor {
                add: vec![],
                remove: vec![gid(3)],
                name: Some("B".into()),
            },
        )
        .unwrap();
    net.exchange();
    // Members hold both ends and tell the owner of the other.
    net.run(2 * MIN);
    let s = net.summary(0, &g).unwrap();
    assert!(s.must_resolve, "{s:?}");
    // No new message while the fork is unresolved; a resolution is required.
    assert_eq!(
        net.change(
            0,
            g,
            GroupChange::Successor {
                add: vec![],
                remove: vec![],
                name: None
            }
        ),
        Err(NodeError::Fork)
    );
    let r = net
        .change(
            0,
            g,
            GroupChange::Resolve {
                members: vec![gid(1), gid(2), gid(3)],
                name: Some("R".into()),
            },
        )
        .unwrap();
    net.exchange();
    for d in 0..4 {
        assert_eq!(net.current(d, &g), Some(r), "device {d}");
    }
    assert!(net.devs[1].node.root(&r).unwrap().parents().len() >= 2);
    let _ = (a, b);
}

#[test]
fn signed_objects_of_a_removed_member_in_storage_are_kept_with_their_root() {
    let (mut net, g) = founded(3);
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
    net.exchange();
    let n = net.devs[1]
        .node
        .t
        .signed
        .iter()
        .filter(|(_, r)| matches!(r.object, SignedObject::Kick(_)))
        .count();
    assert_eq!(n, 1);
    assert!(
        net.devs[1]
            .node
            .t
            .group_recs
            .get(&g)
            .is_some_and(|r| r.status == GroupStatus::Active)
    );
}

/// Regression (simulation, code at afeb85d8, `GROUPS_MEMBERS_SEED=0`): a device whose owner
/// line had passed by a handover accepted a root of the former owner's branch as a separate
/// conversation before its parents were found; when the two were joined, the joined group
/// kept the line of the accepted one and made the former owner's branch current again
/// (§5.9: the handover wins).
#[test]
fn joining_two_groups_keeps_the_line_after_a_handover() {
    for into_main in [false, true] {
        let store = MemoryStorage::new();
        let mut node = Node::open(&store, gid(0)).unwrap();
        let main = ChatId::from_bytes([if into_main { 1 } else { 2 }; 32]);
        let other = ChatId::from_bytes([if into_main { 2 } else { 1 }; 32]);
        {
            let g = node.group_rec_mut(main);
            g.followed = Some(gid(1));
            g.deposed.insert(gid(0));
        }
        node.group_rec_mut(other).followed = Some(gid(0));
        let (from, into) = (main.max(other), main.min(other));
        node.merge_groups(from, into);
        let g = node.t.group_recs.get(&into).unwrap();
        assert_eq!(g.followed, Some(gid(1)), "into the main group: {into_main}");
        assert!(g.deposed.contains(&gid(0)));
    }
}

/// Regression (simulation, code at afeb85d8, `GROUPS_MEMBERS_SEED=0`): a member that missed
/// an epoch signed its leave of an older one; the owner applied it with no kick (§5.6). The
/// member, restored from a backup and back in the epoch it missed, was answered nothing:
/// neither a kick nor a leave names that epoch, so it never learnt that it had left.
#[test]
fn a_restored_member_learns_a_leave_of_an_older_epoch() {
    let (mut net, g) = founded(4);
    let backup = net.devs[3].store.clone();
    // The owner renames the group while device 3 is away.
    net.offline[3] = true;
    let e2 = net
        .change(
            0,
            g,
            GroupChange::Successor {
                add: vec![],
                remove: vec![],
                name: Some("x".into()),
            },
        )
        .unwrap();
    net.exchange();
    net.offline[3] = false;
    net.dropped.clear();
    // Device 3, still at the first epoch, leaves it.
    let now = net.now;
    let s = signer(3);
    let dev = &mut net.devs[3];
    dev.node
        .leave_group(
            &mut dev.store,
            &s,
            g,
            LeaveChoice::Signed,
            now,
            &mut net.rng,
        )
        .unwrap();
    net.run(2 * MIN);
    let e3 = net.current(0, &g).unwrap();
    assert_ne!(e3, e2);
    assert!(!net.summary(0, &g).unwrap().members.contains(&gid(3)));
    // Restored from its backup, device 3 receives the epoch it missed and acts in it.
    net.devs[3].store = backup;
    net.restart(3);
    let root = net.devs[1].node.root(&e2).unwrap();
    let blob = wire::encode_event_blob(&EventObject::Root(Box::new(root))).unwrap();
    let pt = wire::encode_plaintext(&[Frame::Event(blob)]).unwrap();
    let now = net.now;
    let dev = &mut net.devs[3];
    dev.node
        .handle_plaintext(&mut dev.store, gid(1), &pt, now, &mut net.rng)
        .unwrap();
    assert_eq!(net.current(3, &g), Some(e2));
    net.say(3, &g, "still here");
    net.run(3 * MIN);
    assert_eq!(net.summary(3, &g).unwrap().status, MyStatus::Left);
}

/// Regression (simulation, code at afeb85d8, `GROUPS_MEMBERS_SEED=0`): the owner forked the
/// group, then handed one branch over before it learnt the other. The new owner held the
/// former owner's branch beside its own line and was never asked to resolve them (§5.9: it
/// may take that branch as a parent), so members of that branch only were left behind.
#[test]
fn a_new_owner_resolves_the_former_owners_branch() {
    let (mut net, g) = founded(4);
    let backup = net.devs[0].store.clone();
    let a = net
        .change(
            0,
            g,
            GroupChange::Successor {
                add: vec![],
                remove: vec![],
                name: Some("A".into()),
            },
        )
        .unwrap();
    net.exchange();
    net.devs[0].store = backup;
    net.restart(0);
    // The owner, back at the first epoch, creates another successor and hands it over
    // before it hears of the first one.
    net.offline[1] = true;
    let b = net
        .change(
            0,
            g,
            GroupChange::Successor {
                add: vec![],
                remove: vec![],
                name: Some("B".into()),
            },
        )
        .unwrap();
    let h = net
        .change(
            0,
            g,
            GroupChange::Handover {
                new_owner: gid(1),
                leave: false,
                name: None,
            },
        )
        .unwrap();
    net.offline[1] = false;
    for (from, to, pt) in core::mem::take(&mut net.dropped) {
        let now = net.now;
        let dev = &mut net.devs[to];
        dev.node
            .handle_plaintext(&mut dev.store, gid(from), &pt, now, &mut net.rng)
            .unwrap();
    }
    net.run(3 * MIN);
    let s = net.summary(1, &g).unwrap();
    assert_eq!(s.current, h);
    assert!(s.side_branches.contains(&a), "{s:?}");
    // Offered to the new owner, without blocking it (finding 5 of the review of 54711780).
    assert!(!s.must_resolve);
    assert_eq!(
        s.former_owner_branches,
        vec![a],
        "the new owner is offered the resolution"
    );
    let r = net
        .change(
            1,
            g,
            GroupChange::Resolve {
                members: vec![gid(0), gid(2), gid(3)],
                name: None,
            },
        )
        .unwrap();
    net.run(2 * MIN);
    for d in 0..4 {
        assert_eq!(net.current(d, &g), Some(r), "device {d}");
    }
    let _ = b;
}

/// Regression (simulation, code at afeb85d8, `GROUPS_MEMBERS_SEED=0`): a resolution root by
/// a new owner was installed before the former owner's branch it continues; when that
/// branch arrived, its link to the resolution was checked for authority against the branch
/// alone, without the handover root on the resolution's other parent, and the branch stayed
/// an end beside the resolution.
#[test]
fn a_branch_arriving_after_its_resolution_is_linked_to_it() {
    let (mut net, g) = founded(4);
    let backup = net.devs[0].store.clone();
    net.offline[3] = true;
    let a = net
        .change(
            0,
            g,
            GroupChange::Successor {
                add: vec![],
                remove: vec![],
                name: Some("A".into()),
            },
        )
        .unwrap();
    net.exchange();
    let held_a = core::mem::take(&mut net.dropped);
    net.devs[0].store = backup;
    net.restart(0);
    net.offline[1] = true;
    net.change(
        0,
        g,
        GroupChange::Successor {
            add: vec![],
            remove: vec![],
            name: Some("B".into()),
        },
    )
    .unwrap();
    net.change(
        0,
        g,
        GroupChange::Handover {
            new_owner: gid(1),
            leave: false,
            name: None,
        },
    )
    .unwrap();
    net.offline[1] = false;
    for (from, to, pt) in core::mem::take(&mut net.dropped) {
        if to == 1 {
            let now = net.now;
            let dev = &mut net.devs[to];
            dev.node
                .handle_plaintext(&mut dev.store, gid(from), &pt, now, &mut net.rng)
                .unwrap();
        }
    }
    net.run(3 * MIN);
    let r = net
        .change(
            1,
            g,
            GroupChange::Resolve {
                members: vec![gid(0), gid(2), gid(3)],
                name: None,
            },
        )
        .unwrap();
    net.run(2 * MIN);
    // Device 3 was away: it gets everything but the first branch, then that branch.
    net.offline[3] = false;
    net.dropped.clear();
    let root = |n: &MNet, c: &ChatId| n.devs[1].node.root(c).unwrap();
    let mut order: Vec<ChatId> = Vec::new();
    for c in net.devs[1].node.tables().epochs.keys() {
        if *c != a && *c != g {
            order.push(*c);
        }
    }
    order.sort_by_key(|c| root(&net, c).created_at());
    order.push(a);
    let _ = held_a;
    for c in order {
        let blob = wire::encode_event_blob(&EventObject::Root(Box::new(root(&net, &c)))).unwrap();
        let pt = wire::encode_plaintext(&[Frame::Event(blob)]).unwrap();
        let now = net.now;
        let dev = &mut net.devs[3];
        dev.node
            .handle_plaintext(&mut dev.store, gid(1), &pt, now, &mut net.rng)
            .unwrap();
    }
    let s = net.summary(3, &g).unwrap();
    assert_eq!(s.current, r);
    assert!(s.side_branches.is_empty(), "{s:?}");
}

/// Regression (simulation, code at afeb85d8, `GROUPS_MEMBERS_SEED=0`): an invitation to
/// rejoin by a handover root (its single parent in a group the device was removed from) was
/// accepted as a separate group: authority over the parent was checked by the owners of the
/// root's line, which never include the signer of a handover, the owner of its parent.
#[test]
fn a_handover_rejoining_a_removed_member_continues_its_group() {
    let (mut net, g) = founded(4);
    let backup = net.devs[0].store.clone();
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
    assert_eq!(net.summary(3, &g).unwrap().status, MyStatus::Removed);
    // The owner, restored from its backup, hands the first epoch over: member 3 is in it.
    net.devs[0].store = backup;
    net.restart(0);
    let h = net
        .change(
            0,
            g,
            GroupChange::Handover {
                new_owner: gid(1),
                leave: false,
                name: None,
            },
        )
        .unwrap();
    net.exchange();
    let inv = net.devs[3].node.invitations(net.now);
    assert_eq!(inv.iter().map(|i| i.chat_id).collect::<Vec<_>>(), vec![h]);
    assert_eq!(net.accept(3, h), g);
    let s = net.summary(3, &g).unwrap();
    assert_eq!(s.current, h);
    assert_eq!(s.status, MyStatus::Member);
}

/// Regression (simulation, code at the parent of this commit, `GROUPS_MEMBERS_SEED=2`): a
/// member restored from a backup learnt its leave, then accepted a later root of the group,
/// which it could not link: the epoch between them, fetched by the parent lookup, continues
/// a group that is read-only, and stayed an invitation. The device showed itself a member
/// of a separate group although its leave applies there too.
#[test]
fn an_accepted_root_after_a_leave_is_linked_through_its_fetched_parents() {
    let (mut net, g) = founded(4);
    let backup = net.devs[3].store.clone();
    net.offline[3] = true;
    net.change(
        0,
        g,
        GroupChange::Successor {
            add: vec![],
            remove: vec![],
            name: Some("x".into()),
        },
    )
    .unwrap();
    let e3 = net
        .change(
            0,
            g,
            GroupChange::Successor {
                add: vec![],
                remove: vec![],
                name: Some("y".into()),
            },
        )
        .unwrap();
    net.exchange();
    net.offline[3] = false;
    net.dropped.clear();
    // Device 3, still at the first epoch, leaves it; the owner applies the leave.
    let now = net.now;
    let s = signer(3);
    let dev = &mut net.devs[3];
    dev.node
        .leave_group(
            &mut dev.store,
            &s,
            g,
            LeaveChoice::Signed,
            now,
            &mut net.rng,
        )
        .unwrap();
    net.run(2 * MIN);
    assert!(!net.summary(0, &g).unwrap().members.contains(&gid(3)));
    // Restored, it is told of its leave, then receives the later root.
    net.devs[3].store = backup;
    net.restart(3);
    net.say(3, &g, "back");
    net.run(2 * MIN);
    assert_eq!(net.summary(3, &g).unwrap().status, MyStatus::Left);
    let root = net.devs[1].node.root(&e3).unwrap();
    let blob = wire::encode_event_blob(&EventObject::Root(Box::new(root))).unwrap();
    let pt = wire::encode_plaintext(&[Frame::Event(blob)]).unwrap();
    let now = net.now;
    let dev = &mut net.devs[3];
    dev.node
        .handle_plaintext(&mut dev.store, gid(1), &pt, now, &mut net.rng)
        .unwrap();
    net.run(crate::node::timing::PROMPT_DELAY_MS + MIN);
    net.accept_all(3);
    net.run(2 * MIN);
    let groups = net.devs[3].node.groups();
    assert_eq!(groups.len(), 1, "{groups:?}");
    assert_eq!(groups[0].status, MyStatus::Left);
}

/// Regression (simulation, code at the parent of this commit, `GROUPS_MEMBERS_SEED=13`): a
/// removed device, restored from a backup, was told of its removal; when it later joined
/// the conversation it had accepted apart with the group the kick had made read-only, the
/// joined group became active again: the device showed itself a member of an epoch it was
/// removed from.
#[test]
fn joining_a_group_keeps_a_kick_of_its_current_epoch() {
    let store = MemoryStorage::new();
    let mut node = Node::open(&store, gid(0)).unwrap();
    let kicked = ChatId::from_bytes([1; 32]);
    let other = ChatId::from_bytes([2; 32]);
    node.group_rec_mut(kicked).status = GroupStatus::Removed {
        epoch: kicked,
        at: 5,
    };
    node.group_rec_mut(other);
    node.merge_groups(other, kicked);
    // The merged group is judged again from what it holds (see `check_own_removal`); a
    // kick naming a current epoch that the merge brings keeps it read-only.
    assert!(matches!(
        node.t.group_recs.get(&kicked).unwrap().status,
        GroupStatus::Removed { .. }
    ));
}

/// Regression (simulation, code at the parent of this commit, `GROUPS_MEMBERS_SEED=25`): a
/// member away through several epochs and removed in the last one is still at the first
/// when it comes back. No kick names that epoch, and it cannot check the kick of the epoch
/// it was removed from without that epoch's root, which nothing sent it: it never learnt
/// its removal.
#[test]
fn a_member_away_through_several_epochs_learns_its_removal() {
    let (mut net, g) = founded(4);
    net.offline[3] = true;
    net.change(
        0,
        g,
        GroupChange::Successor {
            add: vec![],
            remove: vec![],
            name: Some("x".into()),
        },
    )
    .unwrap();
    net.exchange();
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
    net.offline[3] = false;
    net.dropped.clear();
    assert_eq!(net.current(3, &g), Some(g));
    net.say(3, &g, "anyone?");
    net.run(5 * MIN);
    assert_eq!(net.summary(3, &g).unwrap().status, MyStatus::Removed);
}

/// Regression (simulation, code at the parent of this commit, `GROUPS_MEMBERS_SEED=40`): a
/// member restored from a backup older than an epoch it then left is behind its own leave:
/// the leave names a later epoch than the one it acts in, and it never learnt it had left.
#[test]
fn a_member_restored_behind_its_leave_learns_it() {
    let (mut net, g) = founded(4);
    let backup = net.devs[3].store.clone();
    let e2 = net
        .change(
            0,
            g,
            GroupChange::Successor {
                add: vec![],
                remove: vec![],
                name: Some("x".into()),
            },
        )
        .unwrap();
    net.exchange();
    let now = net.now;
    let s = signer(3);
    let dev = &mut net.devs[3];
    dev.node
        .leave_group(
            &mut dev.store,
            &s,
            e2,
            LeaveChoice::Signed,
            now,
            &mut net.rng,
        )
        .unwrap();
    net.run(2 * MIN);
    assert!(!net.summary(0, &g).unwrap().members.contains(&gid(3)));
    net.devs[3].store = backup;
    net.restart(3);
    assert_eq!(net.current(3, &g), Some(g));
    net.say(3, &g, "back");
    net.run(5 * MIN);
    assert_eq!(net.summary(3, &g).unwrap().status, MyStatus::Left);
}

/// Regression (simulation, code at the parent of this commit, `GROUPS_MEMBERS_SEED=59`):
/// after a double handover, the owner of one line dissolved it; a member of that line then
/// accepted an invitation of the other line's owner, which rejoined the dissolved group but
/// left it following the dissolved line: the device showed an active group whose current
/// epoch was dissolved.
#[test]
fn accepting_the_other_line_after_a_dissolve_follows_it() {
    let (mut net, g) = founded(4);
    let backup = net.devs[0].store.clone();
    net.offline[2] = true;
    net.change(
        0,
        g,
        GroupChange::Handover {
            new_owner: gid(1),
            leave: false,
            name: None,
        },
    )
    .unwrap();
    net.exchange();
    let to_two = core::mem::take(&mut net.dropped);
    net.devs[0].store = backup;
    net.restart(0);
    net.offline[1] = true;
    net.offline[3] = true;
    let h2 = net
        .change(
            0,
            g,
            GroupChange::Handover {
                new_owner: gid(2),
                leave: false,
                name: None,
            },
        )
        .unwrap();
    net.offline[2] = false;
    net.exchange();
    net.offline[1] = false;
    net.offline[3] = false;
    for (from, to, pt) in to_two.into_iter().chain(core::mem::take(&mut net.dropped)) {
        let now = net.now;
        let dev = &mut net.devs[to];
        dev.node
            .handle_plaintext(&mut dev.store, gid(from), &pt, now, &mut net.rng)
            .unwrap();
    }
    net.run(2 * MIN);
    assert_eq!(net.summary(2, &g).unwrap().owner, gid(2));
    assert_eq!(net.summary(1, &g).unwrap().owner, gid(1));
    // The owner of the first line dissolves it.
    let now = net.now;
    let s = signer(1);
    let dev = &mut net.devs[1];
    dev.node
        .dissolve_group(&mut dev.store, &s, g, false, now, &mut net.rng)
        .unwrap();
    net.run(2 * MIN);
    // The owner of the other line creates a successor of its own line.
    let s2 = net
        .change(
            2,
            h2,
            GroupChange::Successor {
                add: vec![],
                remove: vec![],
                name: Some("two".into()),
            },
        )
        .unwrap();
    net.run(2 * MIN);
    let inv: Vec<ChatId> = net.devs[1]
        .node
        .invitations(net.now)
        .iter()
        .map(|i| i.chat_id)
        .collect();
    assert_eq!(inv, vec![s2]);
    net.accept(1, s2);
    let s = net.summary(1, &g).unwrap();
    assert_eq!(s.current, s2, "{s:?}");
    assert_eq!(s.status, MyStatus::Member);
}

/// Regression (simulation, code at the parent of this commit, `GROUPS_MEMBERS_SEED=56`): an
/// invitation accepted before its parent lookup succeeded dropped the lookup, so the two
/// conversations were never joined (§4.8: the lookup keeps running in the background, and
/// when it succeeds after an Accept they are joined).
#[test]
fn a_parent_lookup_goes_on_after_the_invitation_is_accepted() {
    let (mut net, g) = founded(4);
    net.say(1, &g, "old");
    net.run(MIN);
    net.offline[3] = true;
    net.change(
        0,
        g,
        GroupChange::Successor {
            add: vec![],
            remove: vec![],
            name: Some("x".into()),
        },
    )
    .unwrap();
    let e3 = net
        .change(
            0,
            g,
            GroupChange::Successor {
                add: vec![],
                remove: vec![],
                name: Some("y".into()),
            },
        )
        .unwrap();
    net.exchange();
    net.dropped.clear();
    // Device 3 gets the last root only, while nobody can answer its parent lookup.
    let root = net.devs[1].node.root(&e3).unwrap();
    let blob = wire::encode_event_blob(&EventObject::Root(Box::new(root))).unwrap();
    let pt = wire::encode_plaintext(&[Frame::Event(blob)]).unwrap();
    net.offline = vec![true, true, true, false];
    let now = net.now;
    let dev = &mut net.devs[3];
    dev.node
        .handle_plaintext(&mut dev.store, gid(1), &pt, now, &mut net.rng)
        .unwrap();
    net.run(crate::node::timing::PROMPT_DELAY_MS + MIN);
    assert_eq!(net.accept_all(3), vec![e3]);
    assert_eq!(net.devs[3].node.groups().len(), 2);
    // Back online, the lookup succeeds and the conversations are joined.
    net.offline = vec![false; 4];
    net.dropped.clear();
    for d in 0..4 {
        let now = net.now;
        let dev = &mut net.devs[d];
        for p in 0..4 {
            if p != d {
                dev.node
                    .peer_reconnected(&mut dev.store, gid(p), now, &mut net.rng)
                    .unwrap();
            }
        }
    }
    net.run(10 * MIN);
    let groups = net.devs[3].node.groups();
    assert_eq!(groups.len(), 1, "{groups:?}");
    assert_eq!(groups[0].current, e3);
    assert!(net.texts(3, &e3).contains(&"old".to_owned()));
}

/// Regression (simulation, code at the parent of this commit, `GROUPS_MEMBERS_SEED=42`): as
/// above, but the epoch between arrived by itself, as an invitation to rejoin (its parent
/// is in the group the device left), not as a fetched parent: it was not joined to the
/// later root the user accepted.
#[test]
fn an_invitation_between_a_left_group_and_an_accepted_root_is_joined() {
    let (mut net, g) = founded(4);
    let backup = net.devs[3].store.clone();
    net.offline[3] = true;
    let e2 = net
        .change(
            0,
            g,
            GroupChange::Successor {
                add: vec![],
                remove: vec![],
                name: Some("x".into()),
            },
        )
        .unwrap();
    let e3 = net
        .change(
            0,
            g,
            GroupChange::Successor {
                add: vec![],
                remove: vec![],
                name: Some("y".into()),
            },
        )
        .unwrap();
    net.exchange();
    net.offline[3] = false;
    net.dropped.clear();
    let now = net.now;
    let s = signer(3);
    let dev = &mut net.devs[3];
    dev.node
        .leave_group(
            &mut dev.store,
            &s,
            g,
            LeaveChoice::Signed,
            now,
            &mut net.rng,
        )
        .unwrap();
    net.run(2 * MIN);
    net.devs[3].store = backup;
    net.restart(3);
    net.say(3, &g, "back");
    net.run(2 * MIN);
    assert_eq!(net.summary(3, &g).unwrap().status, MyStatus::Left);
    for c in [e2, e3] {
        let root = net.devs[1].node.root(&c).unwrap();
        let blob = wire::encode_event_blob(&EventObject::Root(Box::new(root))).unwrap();
        let pt = wire::encode_plaintext(&[Frame::Event(blob)]).unwrap();
        let now = net.now;
        let dev = &mut net.devs[3];
        dev.node
            .handle_plaintext(&mut dev.store, gid(1), &pt, now, &mut net.rng)
            .unwrap();
    }
    // The user accepts the later root only.
    net.accept(3, e3);
    net.run(2 * MIN);
    let groups = net.devs[3].node.groups();
    assert_eq!(groups.len(), 1, "{groups:?}");
    assert_eq!(groups[0].status, MyStatus::Left);
}

#[test]
fn nothing_is_published_in_a_read_only_group_or_by_an_owner_with_a_fork() {
    let (mut net, g) = founded(3);
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
    net.exchange();
    let now = net.now;
    let dev = &mut net.devs[2];
    let r = dev.node.publish_message(
        &mut dev.store,
        g,
        Body::Text("x".into()),
        BTreeMap::new(),
        None,
        now,
        &mut net.rng,
    );
    assert_eq!(r.map(|_| ()), Err(NodeError::NotAllowed));
    // A new message in an older epoch is refused too.
    let dev = &mut net.devs[1];
    let r = dev.node.publish_message(
        &mut dev.store,
        g,
        Body::Text("x".into()),
        BTreeMap::new(),
        None,
        now,
        &mut net.rng,
    );
    assert_eq!(r.map(|_| ()), Err(NodeError::NotAllowed));
}

/// Finding 1 of the review of 54711780: a member that missed a long chain of roots and
/// receives them newest first adopted them by recursion, one level per root, and rescanned
/// every epoch at each level: 60 roots overflowed a 1 MiB stack, and nothing being
/// committed, the device crashed again after a restart. The chain is now adopted from a
/// worklist, a bounded number of steps per operation, the rest on later operations.
#[test]
fn a_long_chain_received_newest_first_is_adopted_without_recursion() {
    let worker = std::thread::Builder::new()
        .stack_size(1 << 20)
        .spawn(|| {
            let (mut net, g) = founded(3);
            net.offline[2] = true;
            let mut chain = Vec::new();
            for i in 0..60 {
                let e = net
                    .change(
                        0,
                        g,
                        GroupChange::Successor {
                            add: vec![],
                            remove: vec![],
                            name: Some(format!("n{i}")),
                        },
                    )
                    .unwrap();
                chain.push(e);
            }
            net.exchange();
            net.offline[2] = false;
            net.dropped.clear();
            for c in chain.iter().rev() {
                let root = net.devs[1].node.root(c).unwrap();
                let blob = wire::encode_event_blob(&EventObject::Root(Box::new(root))).unwrap();
                let pt = wire::encode_plaintext(&[Frame::Event(blob)]).unwrap();
                let now = net.now;
                let dev = &mut net.devs[2];
                dev.node
                    .handle_plaintext(&mut dev.store, gid(1), &pt, now, &mut net.rng)
                    .unwrap();
            }
            net.run(5 * MIN);
            let s = net.summary(2, &g).unwrap();
            assert_eq!(s.current, *chain.last().unwrap());
            assert!(s.side_branches.is_empty());
            assert_eq!(net.devs[2].node.groups().len(), 1);
        })
        .unwrap();
    worker.join().unwrap();
}

/// The answers of `d` to the query `ops` from member `from`, by entry position.
fn answers_of(
    net: &mut MNet,
    d: usize,
    from: usize,
    ops: Vec<QueryOp>,
) -> Vec<(u32, ResponseResult)> {
    net.recv_frames_m(d, from, &[query(9, net.now, MIN, ops)]);
    let now = net.now;
    let dev = &mut net.devs[d];
    let out = dev
        .node
        .poll_outbox(&mut dev.store, now, &mut net.rng)
        .unwrap();
    let mut answers = Vec::new();
    for o in out {
        let dev = &mut net.devs[d];
        dev.node
            .handed_off(&mut dev.store, o.handle, now, &mut net.rng)
            .unwrap();
        if o.to != gid(from) {
            continue;
        }
        for f in frames(&o.plaintext) {
            if let Frame::Response(r) = f {
                answers.push((r.idx, r.result));
            }
        }
    }
    answers.sort_by_key(|(i, _)| *i);
    answers
}

impl MNet {
    pub(crate) fn recv_frames_m(&mut self, d: usize, from: usize, f: &[Frame]) {
        let pt = wire::encode_plaintext(f).unwrap();
        let now = self.now;
        let dev = &mut self.devs[d];
        dev.node
            .handle_plaintext(&mut dev.store, gid(from), &pt, now, &mut self.rng)
            .unwrap();
    }
}

fn not_available(r: &ResponseResult) -> bool {
    *r == ResponseResult::Status(Status::NotAvailable)
}

/// Finding 2 of the review of 54711780: a removed peer was answered like a member for the
/// epoch it was removed from (its root, keys, other members' records), and a device that
/// was kicked kept answering for its epochs and listing them in shared-chats scans.
#[test]
fn removed_peers_and_removed_devices_answer_not_available() {
    let (mut net, g) = founded(4);
    let e = net.say(1, &g, "before");
    net.run(MIN);
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
    assert_eq!(net.summary(3, &g).unwrap().status, MyStatus::Removed);
    let own_kick = *crate::hash::kick_id(&g, &gid(3)).as_bytes();
    let a = answers_of(
        &mut net,
        1,
        3,
        vec![
            QueryOp::ChatById(g),
            QueryOp::Keys {
                chat_id: g,
                gossip_id: gid(2),
            },
            QueryOp::SignedObject {
                chat_id: g,
                kind: crate::wire::SignedKind::Kick,
                id: own_kick,
            },
            QueryOp::Removal {
                chat_id: g,
                gossip_id: gid(3),
            },
            QueryOp::Removal {
                chat_id: g,
                gossip_id: gid(2),
            },
        ],
    );
    let by_idx = |i: u32| {
        a.iter()
            .filter(|(x, _)| *x == i)
            .map(|(_, r)| r.clone())
            .collect::<Vec<_>>()
    };
    assert!(
        by_idx(0).iter().all(not_available),
        "root to a removed peer"
    );
    assert!(
        by_idx(1).iter().all(not_available),
        "keys to a removed peer"
    );
    assert!(
        matches!(by_idx(2)[0], ResponseResult::Event(_)),
        "its own kick"
    );
    assert!(
        matches!(by_idx(3)[0], ResponseResult::Event(_)),
        "its own removal"
    );
    assert!(
        by_idx(4).iter().all(not_available),
        "another member's records"
    );
    // The kicked device answers for its epochs as for an epoch it does not hold.
    let b = answers_of(
        &mut net,
        3,
        1,
        vec![
            QueryOp::Event {
                chat_id: g,
                event_id: e.event_id(),
            },
            QueryOp::ChatById(g),
            QueryOp::SharedChatsScan {
                scan_id: crate::ids::ScanId::from_bytes([3; 32]),
                offset: 0,
            },
        ],
    );
    for (i, r) in &b {
        match r {
            ResponseResult::Page(p) => assert!(p.entries.is_empty(), "entry {i}"),
            r => assert!(not_available(r), "entry {i}: {r:?}"),
        }
    }
}

/// Finding 3 of the review of 54711780: after a handover from A to B in one group, a root of
/// B naming the current epochs of that group and of another group of A was adopted, and
/// merged A's other group under B: the handover gave B authority over every epoch of A.
#[test]
fn a_new_owner_cannot_take_over_another_group_of_the_former_owner() {
    let (mut net, g1) = founded(3);
    let g2 = net.create(0, &[1, 2]);
    net.exchange();
    for d in 1..3 {
        net.accept_all(d);
    }
    net.run(MIN);
    let h = net
        .change(
            0,
            g1,
            GroupChange::Handover {
                new_owner: gid(1),
                leave: false,
                name: None,
            },
        )
        .unwrap();
    net.exchange();
    assert_eq!(net.summary(2, &g1).unwrap().owner, gid(1));
    // B builds a root continuing both A's handed-over line and A's other group.
    let members: Vec<GossipId> = (0..3).map(gid).collect();
    let params = crate::root::RootParams {
        name: "mine".into(),
        members,
        group_secret: crate::ids::GroupSecret::from_bytes([4; 32]),
        owner: ident(1).public.clone(),
        epoch_challenge: crate::ids::Challenge::from_bytes([5; 32]),
        ref_chat_id_challenge: crate::ids::Challenge::from_bytes([6; 32]),
        created_at: net.now,
    };
    let r = Root::create_successor(params, &[h, g2], &ident(1).secret.dsa_signing_key, [1; 32])
        .unwrap();
    let blob = wire::encode_event_blob(&EventObject::Root(Box::new(r.clone()))).unwrap();
    net.recv_frames_m(2, 1, &[Frame::Event(blob)]);
    let s2 = net.summary(2, &g2).unwrap();
    assert_eq!(s2.current, g2, "{s2:?}");
    assert_eq!(s2.owner, gid(0));
    // The root continues B's own line only; A's other group is an unmatched parent.
    let s1 = net.summary(2, &g1).unwrap();
    assert_eq!(s1.current, r.chat_id());
    assert_ne!(s1.group, s2.group);
    assert_eq!(
        net.devs[2].node.t.epochs.get(&r.chat_id()).unwrap().parents,
        vec![h]
    );
}

/// Finding 4 of the review of 54711780: a member that left with a signed leave and was
/// added back (a) rejected the root that adds it back silently, since its extra parent is
/// the epoch the member closed; (b) once in, its old leave was live again through that extra
/// parent, and the owner's automatic successor removed it again.
#[test]
fn a_member_that_left_can_be_added_back() {
    let (mut net, g) = founded(4);
    let now = net.now;
    let s = signer(3);
    let dev = &mut net.devs[3];
    dev.node
        .leave_group(
            &mut dev.store,
            &s,
            g,
            LeaveChoice::Signed,
            now,
            &mut net.rng,
        )
        .unwrap();
    net.run(2 * MIN);
    assert!(!net.summary(0, &g).unwrap().members.contains(&gid(3)));
    let z = net
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
    net.run(2 * MIN);
    let inv: Vec<ChatId> = net.devs[3]
        .node
        .invitations(net.now)
        .iter()
        .map(|i| i.chat_id)
        .collect();
    assert_eq!(inv, vec![z], "(a) the invitation is shown");
    net.accept(3, z);
    net.run(3 * MIN);
    let s0 = net.summary(0, &g).unwrap();
    assert!(
        s0.members.contains(&gid(3)),
        "(b) not removed again: {s0:?}"
    );
    assert_eq!(s0.current, z);
}

/// Finding 5 of the review of 54711780: after handing the group over, the former owner made
/// a root of its own, dated at the end of time, continuing its old epoch. The new owner then
/// had a "fork to resolve" that blocked its messages and automatic successors, and could not
/// create any root since `created_at = L + 1` overflowed.
#[test]
fn a_former_owner_cannot_mute_or_freeze_the_new_owner() {
    let (mut net, g) = founded(3);
    let h = net
        .change(
            0,
            g,
            GroupChange::Handover {
                new_owner: gid(1),
                leave: false,
                name: None,
            },
        )
        .unwrap();
    net.exchange();
    let params = crate::root::RootParams {
        name: "mine again".into(),
        members: (0..3).map(gid).collect(),
        group_secret: crate::ids::GroupSecret::from_bytes([4; 32]),
        owner: ident(0).public.clone(),
        epoch_challenge: crate::ids::Challenge::from_bytes([5; 32]),
        ref_chat_id_challenge: crate::ids::Challenge::from_bytes([6; 32]),
        created_at: u64::MAX,
    };
    let a =
        Root::create_successor(params, &[g], &ident(0).secret.dsa_signing_key, [1; 32]).unwrap();
    let blob = wire::encode_event_blob(&EventObject::Root(Box::new(a.clone()))).unwrap();
    for d in 1..3 {
        net.recv_frames_m(d, 0, &[Frame::Event(blob.clone())]);
        assert_eq!(net.current(d, &g), Some(h), "device {d}");
    }
    let s = net.summary(1, &g).unwrap();
    assert!(!s.must_resolve);
    assert_eq!(s.former_owner_branches, vec![a.chat_id()]);
    // The new owner still sends and changes the group.
    net.say(1, &g, "still mine");
    let e = net
        .change(
            1,
            g,
            GroupChange::Successor {
                add: vec![],
                remove: vec![gid(2)],
                name: None,
            },
        )
        .unwrap();
    // Dated by the clock: the former owner's root does not count in `L`.
    assert!(net.devs[1].node.root(&e).unwrap().created_at() < u64::MAX);
    // Resolving the former owner's branch stays possible, explicitly.
    let r = net
        .change(
            1,
            g,
            GroupChange::Resolve {
                members: vec![gid(0)],
                name: None,
            },
        )
        .unwrap();
    assert!(net.devs[1].node.root(&r).unwrap().parents().len() == 2);
}

/// Finding 6 of the review of 54711780: any peer with a session could make a device keep
/// unbounded records: 40 self-signed roots, each with 32 unmatched parents, gave 41 epoch
/// records and 1,281 retrieval tasks.
#[test]
fn a_stranger_cannot_make_a_device_keep_unbounded_records() {
    let mut net = MNet::new(2, true);
    let stranger = ident(7);
    for i in 0..40u8 {
        let params = crate::root::RootParams {
            name: format!("spam {i}"),
            members: vec![gid(0), stranger.id],
            group_secret: crate::ids::GroupSecret::from_bytes([i; 32]),
            owner: stranger.public.clone(),
            epoch_challenge: crate::ids::Challenge::from_bytes([i; 32]),
            ref_chat_id_challenge: crate::ids::Challenge::from_bytes([i.wrapping_add(1); 32]),
            created_at: net.now,
        };
        let parents: Vec<ChatId> = (0..32u8)
            .map(|p| {
                ChatId::from_bytes([
                    i ^ 0x80,
                    p,
                    1,
                    2,
                    3,
                    4,
                    5,
                    6,
                    7,
                    8,
                    9,
                    10,
                    11,
                    12,
                    13,
                    14,
                    15,
                    16,
                    17,
                    18,
                    19,
                    20,
                    21,
                    22,
                    23,
                    24,
                    25,
                    26,
                    27,
                    28,
                    29,
                    30,
                ])
            })
            .collect();
        let r = Root::create_successor(params, &parents, &stranger.secret.dsa_signing_key, [i; 32])
            .unwrap();
        let blob = wire::encode_event_blob(&EventObject::Root(Box::new(r))).unwrap();
        let pt = wire::encode_plaintext(&[Frame::Event(blob)]).unwrap();
        let now = net.now;
        let dev = &mut net.devs[0];
        dev.node
            .handle_plaintext(&mut dev.store, stranger.id, &pt, now, &mut net.rng)
            .unwrap();
    }
    let t = net.devs[0].node.tables();
    assert!(
        t.epochs.len() <= timing::INVITATIONS_PER_SENDER,
        "{} epoch records",
        t.epochs.len()
    );
    assert!(
        t.tasks.len() <= group::ROOT_FETCHES_PER_PEER,
        "{} tasks",
        t.tasks.len()
    );
}

/// Finding 7 of the review of 54711780: a root notice from any peer was acted on, so a
/// stranger learnt whether the device holds an epoch: an unknown ID brought a chat lookup
/// back, a held or closed one nothing.
#[test]
fn a_root_notice_from_a_stranger_gets_no_reaction() {
    let (mut net, _g) = founded(3);
    let stranger = ident(7).id;
    let unknown = ChatId::from_bytes([0x5a; 32]);
    let pt = wire::encode_plaintext(&[Frame::Notice(Notice {
        entries: vec![Entry {
            chat_id: unknown,
            item: EntryItem::Root,
        }],
        skipped: 0,
    })])
    .unwrap();
    let now = net.now;
    let dev = &mut net.devs[1];
    dev.node
        .handle_plaintext(&mut dev.store, stranger, &pt, now, &mut net.rng)
        .unwrap();
    let out = dev
        .node
        .poll_outbox(&mut dev.store, now, &mut net.rng)
        .unwrap();
    assert!(
        out.iter().all(|o| o.to != stranger),
        "a lookup went back to the stranger"
    );
    assert!(dev.node.tables().tasks.keys().all(|k| k.chat_id != unknown));
}

/// Finding 8 of the review of 54711780 (a): declining an invitation left the roots fetched
/// as its parents, and their tasks, on the device.
#[test]
fn declining_an_invitation_removes_the_parents_fetched_for_it() {
    let mut net = MNet::new(4, true);
    let g = net.create(0, &[1, 2]);
    net.exchange();
    for d in 1..3 {
        net.accept_all(d);
    }
    net.offline[3] = true;
    net.change(
        0,
        g,
        GroupChange::Successor {
            add: vec![gid(3)],
            remove: vec![],
            name: None,
        },
    )
    .unwrap();
    let e3 = net
        .change(
            0,
            g,
            GroupChange::Successor {
                add: vec![],
                remove: vec![],
                name: Some("y".into()),
            },
        )
        .unwrap();
    net.exchange();
    net.offline[3] = false;
    net.dropped.clear();
    let root = net.devs[1].node.root(&e3).unwrap();
    let blob = wire::encode_event_blob(&EventObject::Root(Box::new(root))).unwrap();
    net.recv_frames_m(3, 1, &[Frame::Event(blob)]);
    net.run(crate::node::timing::PROMPT_DELAY_MS + MIN);
    assert!(
        net.devs[3].node.tables().epochs.len() >= 2,
        "a parent was fetched"
    );
    let now = net.now;
    let s = signer(3);
    let dev = &mut net.devs[3];
    dev.node
        .decline_invitation(
            &mut dev.store,
            &s,
            e3,
            LeaveChoice::Silent,
            now,
            &mut net.rng,
        )
        .unwrap();
    let t = net.devs[3].node.tables();
    assert_eq!(t.epochs.len(), 0, "fetched parents left");
    assert_eq!(t.tasks.len(), 0, "their tasks left");
}

/// Finding 8 (b): "Ask to be kicked" on an invitation made the epoch count as accepted.
#[test]
fn asking_to_be_kicked_on_an_invitation_accepts_nothing() {
    let mut net = MNet::new(3, true);
    let g = net.create(0, &[1, 2]);
    net.exchange();
    let now = net.now;
    let s = signer(2);
    let dev = &mut net.devs[2];
    dev.node
        .decline_invitation(
            &mut dev.store,
            &s,
            g,
            LeaveChoice::AskToBeKicked,
            now,
            &mut net.rng,
        )
        .unwrap();
    let a = answers_of(&mut net, 2, 1, vec![QueryOp::ChatById(g)]);
    assert!(
        a.is_empty(),
        "answered as if it shared an accepted epoch: {a:?}"
    );
}

/// Finding 8 (c): accepting an invitation to rejoin a group deleted meanwhile recreated a
/// record under the old group's key.
#[test]
fn accepting_a_rejoin_after_deleting_the_group_starts_a_new_one() {
    let (mut net, g) = founded(3);
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
    net.exchange();
    let z = net
        .change(
            0,
            g,
            GroupChange::Successor {
                add: vec![gid(2)],
                remove: vec![],
                name: None,
            },
        )
        .unwrap();
    net.exchange();
    assert_eq!(net.devs[2].node.invitations(net.now).len(), 1);
    let now = net.now;
    let dev = &mut net.devs[2];
    dev.node
        .delete_group(&mut dev.store, g, now, &mut net.rng)
        .unwrap();
    let joined = net.accept(2, z);
    assert_eq!(joined, z);
    assert!(net.devs[2].node.tables().group_recs.get(&g).is_none());
}

/// Finding 9 of the review of 54711780: handover roots whose parent is not held were kept
/// unverified, 64 for the whole device, with no expiry: a stranger filled every slot, and
/// the parent lookup of each went to the members the unverified root lists.
#[test]
fn unverified_handover_roots_are_bounded_per_sender_and_asked_of_their_sender() {
    let (mut net, _g) = founded(3);
    let stranger = ident(7);
    let members = vec![gid(0), gid(1), gid(2), stranger.id];
    for i in 0..10u8 {
        let params = |owner: &auth::UserPublicKeys, seed: u8| crate::root::RootParams {
            name: format!("h{i}"),
            members: members.clone(),
            group_secret: crate::ids::GroupSecret::from_bytes([seed; 32]),
            owner: owner.clone(),
            epoch_challenge: crate::ids::Challenge::from_bytes([seed.wrapping_add(1); 32]),
            ref_chat_id_challenge: crate::ids::Challenge::from_bytes([seed.wrapping_add(2); 32]),
            created_at: net.now,
        };
        let parent = Root::create_successor(
            params(&stranger.public, i),
            &[ChatId::from_bytes([i; 32])],
            &stranger.secret.dsa_signing_key,
            [1; 32],
        )
        .unwrap();
        let h = Root::create_handover(
            params(&ident(0).public, i.wrapping_add(100)),
            &parent,
            &stranger.secret.dsa_signing_key,
            [2; 32],
        )
        .unwrap();
        let blob = wire::encode_event_blob(&EventObject::Root(Box::new(h))).unwrap();
        let pt = wire::encode_plaintext(&[Frame::Event(blob)]).unwrap();
        let now = net.now;
        let dev = &mut net.devs[0];
        dev.node
            .handle_plaintext(&mut dev.store, stranger.id, &pt, now, &mut net.rng)
            .unwrap();
    }
    assert!(net.devs[0].node.tables().held_roots.len() <= 4);
    let now = net.now;
    let dev = &mut net.devs[0];
    let out = dev
        .node
        .poll_outbox(&mut dev.store, now, &mut net.rng)
        .unwrap();
    for o in out {
        if o.to == gid(1) || o.to == gid(2) {
            for f in frames(&o.plaintext) {
                assert!(
                    !matches!(f, Frame::Query(q) if q.entries.iter().any(|e| matches!(e, QueryEntry::Op(QueryOp::ChatByParent { .. }))))
                );
            }
        }
    }
}

/// Finding 10 of the review of 54711780: the identities whose kick naming an epoch is valid
/// (D.18) were not transitive across successors (A to B, a successor by B, B to D: D was
/// no authority), and a kick a device could not verify, for lack of the handover root,
/// was penalised as a malformed object from the member that relayed it.
#[test]
fn kick_authorities_are_transitive_and_an_unverifiable_kick_is_no_penalty() {
    let (mut net, g) = founded(4);
    net.change(
        0,
        g,
        GroupChange::Handover {
            new_owner: gid(1),
            leave: false,
            name: None,
        },
    )
    .unwrap();
    net.exchange();
    net.change(
        1,
        g,
        GroupChange::Successor {
            add: vec![],
            remove: vec![],
            name: Some("b".into()),
        },
    )
    .unwrap();
    net.exchange();
    net.change(
        1,
        g,
        GroupChange::Handover {
            new_owner: gid(2),
            leave: false,
            name: None,
        },
    )
    .unwrap();
    net.exchange();
    let auth = net.devs[3].node.kick_authorities(&g);
    assert!(
        auth.iter().any(|k| GossipId::of_keys(k) == gid(2)),
        "the second new owner has authority over the first epoch"
    );
    // A kick signed by an identity this device cannot verify costs its relay nothing.
    let root = net.devs[3].node.root(&g).unwrap();
    let k = Kick::sign_as(
        &root,
        gid(3),
        &ident(7).secret.dsa_signing_key,
        &ident(7).public,
        [5; 32],
    )
    .unwrap();
    let blob = wire::encode_event_blob(&EventObject::Kick(k)).unwrap();
    let before = net.devs[3].node.score(&gid(1));
    net.recv_frames_m(3, 1, &[Frame::Event(blob)]);
    assert_eq!(net.devs[3].node.score(&gid(1)), before);
}

/// Finding 11 of the review of 54711780: a "hand over and leave" root received while its
/// parent is not held was a failed announcement of the outgoing owner, who is no member of
/// it; it is discarded without penalty and its parent looked up (§4.7).
#[test]
fn hand_over_and_leave_with_an_unknown_parent_is_no_failed_announcement() {
    let (mut net, g) = founded(3);
    net.offline[2] = true;
    net.change(
        0,
        g,
        GroupChange::Successor {
            add: vec![],
            remove: vec![],
            name: Some("x".into()),
        },
    )
    .unwrap();
    net.exchange();
    let h = net
        .change(
            0,
            g,
            GroupChange::Handover {
                new_owner: gid(1),
                leave: true,
                name: None,
            },
        )
        .unwrap();
    let dropped = core::mem::take(&mut net.dropped);
    net.exchange();
    let dropped: Vec<_> = dropped
        .into_iter()
        .chain(core::mem::take(&mut net.dropped))
        .collect();
    net.offline[2] = false;
    for (from, to, pt) in dropped {
        if from == 0 && to == 2 {
            for f in frames(&pt) {
                if let Frame::Event(b) = &f
                    && matches!(wire::decode_event_blob(b, 1), Ok(EventObject::Root(r)) if r.chat_id() == h)
                {
                    net.recv_frames_m(2, 0, std::slice::from_ref(&f));
                }
            }
        }
    }
    assert_eq!(net.devs[2].node.stats().failed_announcements, 0);
    assert!(net.devs[2].node.tables().held_roots.contains(&h));
}

/// Finding 11: two signed leaves of one member pending its keys, from two relays: a forged
/// one replaced the genuine one, which was lost once the keys arrived.
#[test]
fn a_forged_leave_does_not_replace_a_genuine_one_waiting_for_keys() {
    let mut net = MNet::new(4, false);
    let g = net.create(0, &[1, 2, 3]);
    net.exchange();
    for d in 1..4 {
        net.accept_all(d);
    }
    let root = net.devs[0].node.root(&g).unwrap();
    assert!(net.devs[0].node.keys(&gid(3)).is_none());
    let genuine = Leave::sign(
        &root,
        &ident(3).public,
        &ident(3).secret.dsa_signing_key,
        [1; 32],
    )
    .unwrap();
    let mut p = genuine.to_proto();
    p.signature[0] ^= 1;
    let forged = Leave::from_proto(&p).unwrap();
    net.recv_frames_m(
        0,
        1,
        &[Frame::Event(
            wire::encode_event_blob(&EventObject::Leave(genuine)).unwrap(),
        )],
    );
    net.recv_frames_m(
        0,
        2,
        &[Frame::Event(
            wire::encode_event_blob(&EventObject::Leave(forged)).unwrap(),
        )],
    );
    assert_eq!(net.devs[0].node.tables().unverified.len(), 2);
}

/// Regression for 54711780 (finding 11): pending removals left on a device that handed the
/// group over made its next wake-up always due.
#[test]
fn a_former_owner_has_no_removal_due() {
    let (mut net, g) = founded(3);
    net.recv_frames_m(
        0,
        2,
        &[Frame::LeaveRequest(crate::wire::LeaveRequest {
            chat_id: g,
        })],
    );
    net.change(
        0,
        g,
        GroupChange::Handover {
            new_owner: gid(1),
            leave: false,
            name: None,
        },
    )
    .unwrap();
    net.now += 10 * MIN;
    net.tick(0);
    let wake = net.devs[0]
        .node
        .next_wakeup(&net.devs[0].store, net.now)
        .unwrap();
    assert!(wake.is_none_or(|t| t > net.now), "due at once: {wake:?}");
}

/// Finding 11: "Dissolve & Delete" kept every root of the group for two weeks and then
/// deleted side branches that do not lead to the dissolved epoch (§5.8 erases the named
/// epoch and those that lead to it, and keeps the named root and the message only).
#[test]
fn dissolve_and_delete_keeps_side_branches_and_only_the_named_root() {
    let (mut net, g) = founded(3);
    let backup = net.devs[0].store.clone();
    let a = net
        .change(
            0,
            g,
            GroupChange::Successor {
                add: vec![],
                remove: vec![],
                name: Some("A".into()),
            },
        )
        .unwrap();
    net.exchange();
    net.say(1, &a, "on the side");
    net.run(MIN);
    net.devs[0].store = backup;
    net.restart(0);
    net.now += MIN;
    let b = net
        .change(
            0,
            g,
            GroupChange::Successor {
                add: vec![],
                remove: vec![],
                name: Some("B".into()),
            },
        )
        .unwrap();
    net.offline[1] = true;
    net.offline[2] = true;
    let now = net.now;
    let s = signer(0);
    let dev = &mut net.devs[0];
    dev.node
        .dissolve_group(&mut dev.store, &s, b, true, now, &mut net.rng)
        .unwrap();
    net.offline = vec![false; 3];
    for (from, to, pt) in core::mem::take(&mut net.dropped) {
        let now = net.now;
        let dev = &mut net.devs[to];
        dev.node
            .handle_plaintext(&mut dev.store, gid(from), &pt, now, &mut net.rng)
            .unwrap();
    }
    net.exchange();
    let d = 1;
    assert_eq!(
        net.summary(d, &g).unwrap().status,
        MyStatus::Dissolved { deleted: true }
    );
    assert!(net.devs[d].node.root(&a).is_some());
    assert!(
        net.devs[d].node.root(&g).is_some(),
        "an ancestor of a side branch stays"
    );
    net.now += 15 * DAY;
    net.tick(d);
    assert!(
        net.devs[d].node.root(&b).is_none(),
        "the named root is gone after two weeks"
    );
    assert!(net.devs[d].node.root(&a).is_some(), "the side branch stays");
    assert!(net.texts(d, &a).contains(&"on the side".to_owned()));
}

/// Regression (simulation, code at the parent of this commit, `GROUPS_MEMBERS_SEED=0`): a
/// device held a handover root in a group whose record still followed the former owner (a
/// join of two groups kept the line of the one that had not adopted the handover), so a
/// root the former owner signed after its handover became current.
#[test]
fn a_held_handover_always_moves_the_line_followed() {
    let (mut net, g) = founded(3);
    let h = net
        .change(
            0,
            g,
            GroupChange::Handover {
                new_owner: gid(1),
                leave: false,
                name: None,
            },
        )
        .unwrap();
    net.exchange();
    // The record as a join left it: following the former owner, nothing deposed.
    let node = &mut net.devs[2].node;
    let key = node.group_of(&h);
    let gr = node.group_rec_mut(key);
    gr.followed = Some(gid(0));
    gr.deposed.clear();
    node.rebuild_epochs();
    let a = ident(0);
    let params = crate::root::RootParams {
        name: "back".into(),
        members: (0..3).map(gid).collect(),
        group_secret: crate::ids::GroupSecret::from_bytes([4; 32]),
        owner: a.public.clone(),
        epoch_challenge: crate::ids::Challenge::from_bytes([5; 32]),
        ref_chat_id_challenge: crate::ids::Challenge::from_bytes([6; 32]),
        created_at: u64::MAX,
    };
    let r = Root::create_successor(params, &[g], &a.secret.dsa_signing_key, [1; 32]).unwrap();
    net.recv_frames_m(
        2,
        0,
        &[Frame::Event(
            wire::encode_event_blob(&EventObject::Root(Box::new(r))).unwrap(),
        )],
    );
    assert_eq!(net.current(2, &g), Some(h));
}

/// Regression (simulation, code at the parent of this commit, `GROUPS_MEMBERS_SEED=15`): a
/// member away through several epochs came back after the group was dissolved; dissolved
/// devices answered "not available" for every epoch, so it could not fetch the epochs it
/// missed, never joined them nor learnt the dissolve, and showed the group as several
/// conversations.
#[test]
fn a_member_back_after_a_dissolve_learns_it() {
    let (mut net, g) = founded(3);
    net.offline[2] = true;
    net.change(
        0,
        g,
        GroupChange::Successor {
            add: vec![],
            remove: vec![],
            name: Some("x".into()),
        },
    )
    .unwrap();
    let e3 = net
        .change(
            0,
            g,
            GroupChange::Successor {
                add: vec![],
                remove: vec![],
                name: Some("y".into()),
            },
        )
        .unwrap();
    net.exchange();
    let now = net.now;
    let s = signer(0);
    let dev = &mut net.devs[0];
    dev.node
        .dissolve_group(&mut dev.store, &s, g, false, now, &mut net.rng)
        .unwrap();
    net.exchange();
    net.dropped.clear();
    net.offline[2] = false;
    // It gets the last root only.
    let root = net.devs[1].node.root(&e3).unwrap();
    net.recv_frames_m(
        2,
        1,
        &[Frame::Event(
            wire::encode_event_blob(&EventObject::Root(Box::new(root))).unwrap(),
        )],
    );
    net.run(crate::node::timing::PROMPT_DELAY_MS + MIN);
    net.accept_all(2);
    net.run(30 * MIN);
    let groups = net.devs[2].node.groups();
    assert_eq!(groups.len(), 1, "{groups:?}");
    assert_eq!(groups[0].status, MyStatus::Dissolved { deleted: false });
}

/// Regression (simulation, code at the parent of this commit, `GROUPS_MEMBERS_SEED=19`):
/// after "Dissolve & Delete" the roots of the erased epochs were deleted with no marker, so
/// the same roots relayed again by a lagging member came back as invitations, and accepted,
/// as separate conversations of the dissolved group.
#[test]
fn a_root_erased_by_dissolve_and_delete_is_not_an_invitation_again() {
    let (mut net, g) = founded(3);
    let e2 = net
        .change(
            0,
            g,
            GroupChange::Successor {
                add: vec![],
                remove: vec![],
                name: Some("x".into()),
            },
        )
        .unwrap();
    net.exchange();
    let old = net.devs[0].node.root(&g).unwrap();
    let now = net.now;
    let s = signer(0);
    let dev = &mut net.devs[0];
    dev.node
        .dissolve_group(&mut dev.store, &s, e2, true, now, &mut net.rng)
        .unwrap();
    net.exchange();
    assert!(
        net.devs[1].node.root(&g).is_none(),
        "the erased epoch's root is deleted"
    );
    net.recv_frames_m(
        1,
        2,
        &[Frame::Event(
            wire::encode_event_blob(&EventObject::Root(Box::new(old))).unwrap(),
        )],
    );
    assert!(
        net.devs[1]
            .node
            .invitations(net.now + crate::node::timing::PROMPT_DELAY_MS)
            .is_empty()
    );
}

/// SDK review (A): after closing its only shared group, a device kept records naming the
/// group's members and epochs: a peer record per former member, their keys, correlation
/// references. Only the closed markers and device-level counters may remain (§14.2).
#[test]
fn closing_the_only_shared_group_leaves_only_markers() {
    let (mut net, g) = founded(3);
    net.say(1, &g, "x");
    net.run(MIN);
    let now = net.now;
    let s = signer(2);
    let dev = &mut net.devs[2];
    dev.node
        .leave_group(
            &mut dev.store,
            &s,
            g,
            LeaveChoice::Signed,
            now,
            &mut net.rng,
        )
        .unwrap();
    net.now += 600_000;
    net.tick(2);
    net.exchange();
    let now = net.now;
    let dev = &mut net.devs[2];
    dev.node
        .take_changes(&mut dev.store, now, &mut net.rng)
        .unwrap();
    let t = dev.node.tables();
    assert!(t.epochs.len() == 0 && t.group_recs.len() == 0 && t.signed.len() == 0);
    assert_eq!(t.peers.len(), 0, "peer records of former members");
    // Its own keys only (device-level: the signer gives them again at every tick).
    assert!(
        t.keys.keys().all(|k| *k == gid(2)),
        "keys of former members"
    );
    assert_eq!(t.requests.len(), 0, "correlation references");
    assert_eq!(
        t.tasks.len() + t.scans_out.len() + t.scans_in.len() + t.hints.len(),
        0
    );
    assert_eq!(t.queue.len(), 0);
    assert!(t.markers.len() >= 1);
    // What remains is device-level: the markers, `meta.next_seq` and its own keys.
    assert_eq!(
        t.held_roots.len()
            + t.unverified.len()
            + t.events.len()
            + t.lookup_results.len()
            + t.groups.len()
            + t.replies.len(),
        0
    );
}

/// SDK review (B): `poll_outbox` assembled plaintexts for a peer marked without a session,
/// and an abandoned plaintext was assembled again at once, each poll committing.
#[test]
fn no_assembly_without_a_session_and_no_loop_after_abandon() {
    let (mut net, g) = founded(3);
    net.exchange();
    let now = net.now;
    net.devs[0].node.set_session(gid(1), false);
    net.devs[0].node.set_session(gid(2), false);
    net.say(0, &g, "hello");
    let dev = &mut net.devs[0];
    let out = dev
        .node
        .poll_outbox(&mut dev.store, now, &mut net.rng)
        .unwrap();
    assert!(out.is_empty(), "assembled for peers without a session");
    let commits = dev.store.commits();
    let out = dev
        .node
        .poll_outbox(&mut dev.store, now, &mut net.rng)
        .unwrap();
    assert!(out.is_empty());
    assert_eq!(
        dev.store.commits(),
        commits,
        "a poll with nothing sendable committed"
    );
    // With a session again: assembled; abandoned: not assembled again at once.
    dev.node.set_session(gid(1), true);
    let out = dev
        .node
        .poll_outbox(&mut dev.store, now, &mut net.rng)
        .unwrap();
    assert!(!out.is_empty());
    for o in &out {
        dev.node.abandon(o.handle);
    }
    let commits = dev.store.commits();
    let again = dev
        .node
        .poll_outbox(&mut dev.store, now, &mut net.rng)
        .unwrap();
    assert!(again.is_empty(), "assembled again right after an abandon");
    assert_eq!(dev.store.commits(), commits);
    // A reconnection makes it eligible again.
    dev.node.set_session(gid(1), true);
    let out = dev
        .node
        .poll_outbox(&mut dev.store, now, &mut net.rng)
        .unwrap();
    assert!(!out.is_empty());
}

/// Regression (simulation, code at the parent of this commit, `GROUPS_MEMBERS_SEED=162`):
/// a root with no held parent (the founding root) left as an invitation was never joined to
/// a later root the user accepted, which it is an ancestor of: the device kept the old
/// invitation and showed the group as two conversations.
#[test]
fn an_unanswered_founding_root_joins_the_accepted_root_it_leads_to() {
    let mut net = MNet::new(3, true);
    let g = net.create(0, &[1, 2]);
    net.exchange();
    net.accept_all(1);
    let e2 = net
        .change(
            0,
            g,
            GroupChange::Successor {
                add: vec![],
                remove: vec![],
                name: Some("x".into()),
            },
        )
        .unwrap();
    net.exchange();
    net.accept(2, e2);
    net.run(2 * MIN);
    assert!(
        net.devs[2]
            .node
            .invitations(net.now + crate::node::timing::PROMPT_DELAY_MS)
            .is_empty()
    );
    let groups = net.devs[2].node.groups();
    assert_eq!(groups.len(), 1, "{groups:?}");
    assert_eq!(groups[0].current, e2);
}

/// Regression (simulation, code at 7e8da430, `GROUPS_MEMBERS_SEED=189`): a new owner's
/// resolution named its own epoch and a former owner's epoch that this device held without
/// the handover that gives the authority over it. The root failed as a whole (D.69), so the
/// device showed it as a separate conversation beside the line its owner continued directly,
/// and followed the older end.
#[test]
fn a_root_continues_its_owners_epoch_beside_a_parent_it_has_no_authority_over() {
    let mut net = MNet::new(3, true);
    let g1 = net.create(1, &[0, 2]);
    let g2 = net.create(0, &[1, 2]);
    net.exchange();
    for d in 0..3 {
        net.accept_all(d);
    }
    net.run(MIN);
    let params = crate::root::RootParams {
        name: "next".into(),
        members: (0..3).map(gid).collect(),
        group_secret: crate::ids::GroupSecret::from_bytes([4; 32]),
        owner: ident(1).public.clone(),
        epoch_challenge: crate::ids::Challenge::from_bytes([5; 32]),
        ref_chat_id_challenge: crate::ids::Challenge::from_bytes([6; 32]),
        created_at: net.now,
    };
    let r = Root::create_successor(params, &[g1, g2], &ident(1).secret.dsa_signing_key, [1; 32])
        .unwrap();
    let blob = wire::encode_event_blob(&EventObject::Root(Box::new(r.clone()))).unwrap();
    net.recv_frames_m(2, 1, &[Frame::Event(blob)]);
    assert_eq!(net.current(2, &g1), Some(r.chat_id()));
    let s2 = net.summary(2, &g2).unwrap();
    assert_eq!((s2.current, s2.owner), (g2, gid(0)));
    assert_ne!(net.summary(2, &g1).unwrap().group, s2.group);
}

/// Regression (simulation, code at 7e8da430, `GROUPS_MEMBERS_SEED=115`, 171 and 189): a
/// former owner's root dated at the end of time made every later root of the new owner
/// `u64::MAX` (`L + 1` saturates, D.72), so the interim rule and anything ordered by date had
/// only the chat IDs left to order the group's roots.
#[test]
fn a_former_owners_root_does_not_date_the_new_owners_roots() {
    let (mut net, g) = founded(3);
    net.change(
        0,
        g,
        GroupChange::Handover {
            new_owner: gid(1),
            leave: false,
            name: None,
        },
    )
    .unwrap();
    net.exchange();
    let params = crate::root::RootParams {
        name: "mine again".into(),
        members: (0..3).map(gid).collect(),
        group_secret: crate::ids::GroupSecret::from_bytes([4; 32]),
        owner: ident(0).public.clone(),
        epoch_challenge: crate::ids::Challenge::from_bytes([5; 32]),
        ref_chat_id_challenge: crate::ids::Challenge::from_bytes([6; 32]),
        created_at: u64::MAX,
    };
    let a =
        Root::create_successor(params, &[g], &ident(0).secret.dsa_signing_key, [1; 32]).unwrap();
    let blob = wire::encode_event_blob(&EventObject::Root(Box::new(a))).unwrap();
    net.recv_frames_m(1, 0, &[Frame::Event(blob)]);
    let r = net
        .change(
            1,
            g,
            GroupChange::Resolve {
                members: vec![gid(0), gid(2)],
                name: None,
            },
        )
        .unwrap();
    let e = net
        .change(
            1,
            g,
            GroupChange::Successor {
                add: vec![],
                remove: vec![],
                name: Some("later".into()),
            },
        )
        .unwrap();
    let at = |c: &ChatId| net.devs[1].node.root(c).unwrap().created_at();
    assert!(at(&r) < u64::MAX);
    assert!(at(&r) < at(&e) && at(&e) < u64::MAX);
}

/// Regression (simulation, code at 7e8da430, `GROUPS_MEMBERS_SEED=256` and 262): a member
/// left an epoch while a later one listing it existed; restored from a backup that held
/// neither, it received the later epoch as an invitation and accepted it. Its leave names
/// the earlier epoch, which it did not hold and could never fetch as a removed peer: the
/// members sent the leave without that root, and the device stayed in the group for ever.
#[test]
fn a_restored_member_that_never_held_its_left_epoch_learns_its_leave() {
    let mut net = MNet::new(4, true);
    let backup = net.devs[3].store.clone();
    let g = net.create(0, &[1, 2, 3]);
    net.exchange();
    for d in 1..4 {
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
                name: Some("x".into()),
            },
        )
        .unwrap();
    net.exchange();
    net.offline[3] = false;
    let now = net.now;
    let s = signer(3);
    let dev = &mut net.devs[3];
    dev.node
        .leave_group(
            &mut dev.store,
            &s,
            g,
            LeaveChoice::Signed,
            now,
            &mut net.rng,
        )
        .unwrap();
    net.run(2 * MIN);
    assert!(!net.summary(0, &g).unwrap().members.contains(&gid(3)));
    net.devs[3].store = backup;
    net.restart(3);
    let root = net.devs[0].node.root(&e2).unwrap();
    let blob = wire::encode_event_blob(&EventObject::Root(Box::new(root))).unwrap();
    net.recv_frames_m(3, 0, &[Frame::Event(blob)]);
    net.run(6 * MIN);
    net.accept_all(3);
    assert_eq!(net.current(3, &e2), Some(e2));
    net.say(3, &e2, "back");
    net.run(10 * MIN);
    assert_eq!(net.summary(3, &e2).unwrap().status, MyStatus::Left);
}

/// Regression (simulation, code at 7e8da430, `GROUPS_MEMBERS_SEED=175`): a device adopted the
/// root of a dissolved epoch from a scan page whose dissolve entry it had to drop, since the
/// epoch was not held yet (§4.8). The scans that adopting a root starts (§12.3, trigger 1) are
/// what bring that dissolve; they went to two members drawn uniformly, both of which forged
/// and never answered, and the device kept the group active until the periodic lanes.
#[test]
fn the_scans_after_adopting_a_root_prefer_members_with_a_good_score() {
    let (mut net, g) = founded(5);
    for p in 2..5 {
        net.devs[1].node.penalize(&gid(p), 1000);
    }
    for i in 0..10 {
        let e = net
            .change(
                0,
                g,
                GroupChange::Successor {
                    add: vec![],
                    remove: vec![],
                    name: Some(format!("n{i}")),
                },
            )
            .unwrap();
        let root = net.devs[0].node.root(&e).unwrap();
        let blob = wire::encode_event_blob(&EventObject::Root(Box::new(root))).unwrap();
        net.recv_frames_m(1, 0, &[Frame::Event(blob)]);
        assert_eq!(net.current(1, &g), Some(e));
        let group = net.summary(1, &g).unwrap().group;
        assert!(
            net.devs[1].node.t.scans_out.contains(&(group, gid(0))),
            "adoption {i}"
        );
        net.exchange();
    }
}

/// Open since D.76 (code at 7e8da430): "Dissolve & Delete" keeps a side branch that does not
/// lead to the dissolved epoch, and erases the handover it was judged against when it is a
/// former owner's branch. Two weeks later the dissolved root went too, the group was judged
/// again, and the former owner's branch became the current epoch of an active group: the
/// former owner took the group back.
#[test]
fn a_former_owners_branch_left_by_dissolve_and_delete_never_reactivates_the_group() {
    let (mut net, g) = founded(3);
    net.change(
        0,
        g,
        GroupChange::Handover {
            new_owner: gid(1),
            leave: false,
            name: None,
        },
    )
    .unwrap();
    net.exchange();
    let params = crate::root::RootParams {
        name: "mine again".into(),
        members: (0..3).map(gid).collect(),
        group_secret: crate::ids::GroupSecret::from_bytes([4; 32]),
        owner: ident(0).public.clone(),
        epoch_challenge: crate::ids::Challenge::from_bytes([5; 32]),
        ref_chat_id_challenge: crate::ids::Challenge::from_bytes([6; 32]),
        created_at: net.now,
    };
    let a =
        Root::create_successor(params, &[g], &ident(0).secret.dsa_signing_key, [1; 32]).unwrap();
    let blob = wire::encode_event_blob(&EventObject::Root(Box::new(a.clone()))).unwrap();
    net.recv_frames_m(2, 0, &[Frame::Event(blob)]);
    assert_eq!(
        net.summary(2, &g).unwrap().former_owner_branches,
        vec![a.chat_id()]
    );
    let now = net.now;
    let s = signer(1);
    let dev = &mut net.devs[1];
    dev.node
        .dissolve_group(&mut dev.store, &s, g, true, now, &mut net.rng)
        .unwrap();
    net.exchange();
    let deleted = MyStatus::Dissolved { deleted: true };
    assert_eq!(net.summary(2, &a.chat_id()).unwrap().status, deleted);
    net.now += 15 * DAY;
    net.tick(2);
    let s = net.summary(2, &a.chat_id()).unwrap();
    assert_eq!(s.status, deleted, "{s:?}");
}

/// Regression (simulation, code at 6e7976a2, `GROUPS_MEMBERS_SEED=343`): a member removed by
/// a kick, then restored from a backup older than the kick, stayed a member of its old epoch
/// for ever once the group was dissolved and kept archived: an archive serves the dissolve
/// message and the roots, but not the kick, and the dissolve names an epoch the removed member
/// is not in. Its conversation stayed active with nobody in it.
#[test]
fn a_restored_member_learns_its_kick_from_an_archived_group() {
    let (mut net, g) = founded(4);
    let backup = net.devs[3].store.clone();
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
    assert_eq!(net.summary(3, &g).unwrap().status, MyStatus::Removed);
    let now = net.now;
    let s = signer(0);
    let dev = &mut net.devs[0];
    dev.node
        .dissolve_group(&mut dev.store, &s, g, false, now, &mut net.rng)
        .unwrap();
    net.exchange();
    net.devs[3].store = backup;
    net.restart(3);
    assert_eq!(net.summary(3, &g).unwrap().status, MyStatus::Member);
    net.say(3, &g, "anyone?");
    net.run(10 * MIN);
    assert_eq!(net.summary(3, &g).unwrap().status, MyStatus::Removed);
}

/// Issue "member who left is invited again to an old epoch" (first real run): a member
/// left by a signed leave at E2 and was added back at E4. The owner's tip list for E4's
/// group names E1, the epoch before the one it left, which it also held and erased with the
/// group, and which no closed-chat marker covered: it was fetched and offered as a fresh
/// invitation, owner verified, with no "closed before" warning; accepted, it became a second
/// copy of the group, which the device then pushed to the former owner as one more
/// invitation.
#[test]
fn an_epoch_before_the_one_a_member_left_is_not_offered_to_it_again() {
    let (mut net, e1) = founded(3);
    net.say(0, &e1, "before");
    net.say(1, &e1, "before too");
    net.run(MIN);
    net.change(
        0,
        e1,
        GroupChange::Successor {
            add: vec![],
            remove: vec![gid(2)],
            name: None,
        },
    )
    .unwrap();
    net.run(MIN);
    let now = net.now;
    let s = signer(1);
    let dev = &mut net.devs[1];
    dev.node
        .leave_group(
            &mut dev.store,
            &s,
            e1,
            LeaveChoice::Signed,
            now,
            &mut net.rng,
        )
        .unwrap();
    net.run(2 * MIN);
    assert!(net.devs[1].node.groups().is_empty());
    assert!(!net.summary(0, &e1).unwrap().members.contains(&gid(1)));
    let e4 = net
        .change(
            0,
            e1,
            GroupChange::Successor {
                add: vec![gid(1)],
                remove: vec![],
                name: None,
            },
        )
        .unwrap();
    net.run(MIN);
    let later = net.now + crate::node::timing::PROMPT_DELAY_MS;
    let inv: Vec<ChatId> = net.devs[1]
        .node
        .invitations(later)
        .iter()
        .map(|i| i.chat_id)
        .collect();
    assert_eq!(inv, vec![e4]);
    net.accept(1, e4);
    net.run(10 * MIN);
    let later = net.now + crate::node::timing::PROMPT_DELAY_MS;
    let inv = net.devs[1].node.invitations(later);
    assert!(inv.is_empty(), "an old epoch is offered again: {inv:?}");
    assert_eq!(net.devs[1].node.groups().len(), 1);
}

/// Found by the membership simulation's check that no old epoch is offered again (seed 115
/// once a member that left is added back): a member that left while it held only the first
/// epoch is later given a root two epochs down that line, and the epoch between. The epoch
/// between continues the closed one and was recorded closed (§4.8 case 3), but the root
/// waiting for it as a parent was still offered as an invitation once its lookup was over.
#[test]
fn a_root_whose_parent_turns_out_closed_is_no_invitation() {
    let (mut net, g) = founded(3);
    net.offline[2] = true;
    for name in ["x", "y"] {
        net.change(
            0,
            g,
            GroupChange::Successor {
                add: vec![],
                remove: vec![],
                name: Some(name.into()),
            },
        )
        .unwrap();
        net.exchange();
    }
    let now = net.now;
    let s = signer(2);
    let dev = &mut net.devs[2];
    dev.node
        .leave_group(
            &mut dev.store,
            &s,
            g,
            LeaveChoice::Signed,
            now,
            &mut net.rng,
        )
        .unwrap();
    assert!(net.devs[2].node.groups().is_empty());
    // The two roots arrive late, the newer first, while the owner cannot answer lookups.
    net.offline[2] = false;
    net.offline[0] = true;
    let late: Vec<Vec<u8>> = core::mem::take(&mut net.dropped)
        .into_iter()
        .filter(|(from, to, _)| *from == 0 && *to == 2)
        .map(|(_, _, pt)| pt)
        .collect();
    for pt in late.iter().rev() {
        let now = net.now;
        let dev = &mut net.devs[2];
        dev.node
            .handle_plaintext(&mut dev.store, gid(0), pt, now, &mut net.rng)
            .unwrap();
    }
    net.run(MIN);
    let later = net.now + crate::node::timing::PROMPT_DELAY_MS;
    let inv = net.devs[2].node.invitations(later);
    assert!(
        inv.is_empty(),
        "a root of a closed line is offered: {inv:?}"
    );
}

/// Found by the membership simulation (seed 168 once a member that left is added back): a
/// new owner added back a member and named, as the last epoch that member was in (§5.10),
/// the former owner's root of its old epoch, dated at the end of time (D.72). The member
/// held that root but could not verify the new owner's authority over it (no handover leads
/// to it), so the root was an invitation that started a second conversation of the group.
#[test]
fn adding_back_names_the_last_epoch_of_the_owners_line_not_a_former_owners_branch() {
    let (mut net, g) = founded(3);
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
    net.run(MIN);
    net.change(
        0,
        g,
        GroupChange::Handover {
            new_owner: gid(1),
            leave: false,
            name: None,
        },
    )
    .unwrap();
    net.run(MIN);
    // The former owner continues the first epoch, which still lists device 2, at the end of
    // time.
    let params = crate::root::RootParams {
        name: "back".into(),
        members: (0..3).map(gid).collect(),
        group_secret: crate::ids::GroupSecret::from_bytes([7; 32]),
        owner: ident(0).public.clone(),
        epoch_challenge: crate::ids::Challenge::from_bytes([8; 32]),
        ref_chat_id_challenge: crate::ids::Challenge::from_bytes([9; 32]),
        created_at: u64::MAX,
    };
    let back =
        Root::create_successor(params, &[g], &ident(0).secret.dsa_signing_key, [2; 32]).unwrap();
    let blob = wire::encode_event_blob(&EventObject::Root(Box::new(back.clone()))).unwrap();
    net.recv_frames_m(1, 0, &[Frame::Event(blob)]);
    assert!(net.devs[1].node.root(&back.chat_id()).is_some());
    let z = net
        .change(
            1,
            g,
            GroupChange::Successor {
                add: vec![gid(2)],
                remove: vec![],
                name: None,
            },
        )
        .unwrap();
    let root = net.devs[1].node.root(&z).unwrap();
    assert!(
        root.names_parent(&g),
        "the last epoch of the line listing it"
    );
    assert!(!root.names_parent(&back.chat_id()));
}

/// A handover root keeps the parent's members exactly, but for its signer (§4.7): one that
/// drops another member, validly signed by the parent's owner, is invalid for a device that
/// holds the parent, and counts against the peer that delivered it.
#[test]
fn a_handover_that_drops_a_member_is_refused() {
    let (mut net, g) = founded(4);
    let parent = net.devs[2].node.root(&g).unwrap();
    let mut p = parent.to_proto();
    p.r#type = crate::wire::proto::RootType::Handover as i32;
    p.owner = ident(1).public.to_bytes();
    p.epoch_challenge = vec![0x61; 32];
    p.parents = vec![parent_commitment_bytes(&p.epoch_challenge, &g)];
    let mut members: Vec<GossipId> = [0, 1, 2].iter().map(|d| gid(*d)).collect();
    members.sort();
    p.members = members.iter().map(|m| m.as_bytes().to_vec()).collect();
    let forged = crate::Root::forge_unchecked(p, &ident(0).secret.dsa_signing_key);
    let id = forged.chat_id();
    let blob = wire::encode_event_blob(&EventObject::Root(Box::new(forged))).unwrap();
    net.recv_frames_m(2, 0, &[Frame::Event(blob)]);
    assert!(!net.devs[2].node.tables().epochs.contains(&id));
    assert_eq!(net.devs[2].node.stats().failed_announcements, 1);
    assert_eq!(net.current(2, &g), Some(g));
    assert_eq!(net.summary(2, &g).unwrap().owner, gid(0));
}

fn parent_commitment_bytes(challenge: &[u8], parent: &ChatId) -> Vec<u8> {
    let c = crate::ids::Challenge::from_slice(challenge).unwrap();
    crate::hash::parent_commitment(&c, parent)
        .as_bytes()
        .to_vec()
}

/// A handover keeps a member whose signed leave the outgoing owner holds (§4.7): the new
/// owner, which holds the leave too, applies it with its own successor (§5.5).
#[test]
fn a_leave_pending_at_a_handover_is_applied_by_the_new_owner() {
    let (mut net, g) = founded(4);
    let now = net.now;
    let s = signer(2);
    let dev = &mut net.devs[2];
    dev.node
        .leave_group(
            &mut dev.store,
            &s,
            g,
            LeaveChoice::Signed,
            now,
            &mut net.rng,
        )
        .unwrap();
    net.exchange();
    let h = net
        .change(
            0,
            g,
            GroupChange::Handover {
                new_owner: gid(1),
                leave: true,
                name: None,
            },
        )
        .unwrap();
    net.exchange();
    let root = net.devs[1].node.root(&h).unwrap();
    assert!(root.is_member(&gid(2)), "the handover keeps the leaver");
    assert!(!root.is_member(&gid(0)));
    net.run(2 * MIN);
    let cur = net.current(1, &g).unwrap();
    assert_ne!(cur, h);
    let r = net.devs[1].node.root(&cur).unwrap();
    assert!(!r.is_member(&gid(2)));
    assert_eq!(net.current(3, &g), Some(cur));
    assert_eq!(net.devs[1].node.stats().kicks_created, 0);
}
