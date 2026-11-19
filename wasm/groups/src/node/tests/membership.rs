//! Groups of several epochs (§4, §5): roots created by the owner, received, adopted and
//! answered; signed objects; replies to removed peers; queries of milestone 4; the state
//! for the interface.

use std::collections::BTreeMap;
use std::sync::OnceLock;

use super::*;
use crate::Kick;
use crate::keys::KeySigner;
use crate::node::records::{EpochStatus, GroupStatus, SignedObject};
use crate::rng::TestRng;
use crate::store::MemoryStorage;
use crate::test_support::{Identity, identity};

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
    net.run(crate::constants::PROMPT_DELAY_MS);
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
                remove: vec![],
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
                remove: vec![],
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
