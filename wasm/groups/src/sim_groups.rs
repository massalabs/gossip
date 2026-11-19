//! Deterministic simulation of a group whose membership and ownership change, over a network
//! of devices connected only by their outboxes (test only).
//!
//! Each run is determined by its seed. Devices run the engine ([`Node`]) on their own store
//! with real identities, and exchange plaintexts through a simulated backend that delays,
//! reorders, duplicates and loses them. Devices go online and offline; they are rarely all
//! online together.
//!
//! The owner founds a group and, following a script with random times, adds members,
//! removes them, adds a removed member back, renames the group and hands it over (in some
//! seeds to a member that is offline for hours); members leave by a signed leave or by
//! asking to be kicked; the owner's automatic successor applies them. Some seeds end with a
//! dissolve. A device is restored from an old backup (a rollback) after its removal or its
//! leave, and must learn it again. In some seeds the owner restores its own backup and
//! creates a second successor of the same epoch (a fork, then resolved); in others a
//! hostile owner hands the group over twice, to two members, from the same epoch, and never
//! resolves. Users post, edit (also in older epochs) and delete messages throughout. Users
//! accept the invitations of the group's legitimate owners and decline the others.
//!
//! Hostile members: they forge roots (their own, with no authority, and with broken
//! signatures), forge kicks and leaves, replay roots and signed objects of other epochs, and
//! announce roots and signed objects that do not exist.
//!
//! Properties checked after a final period in which every honest device stays online:
//!
//! - **convergence**: the honest members of the group's current epoch hold the same current
//!   epoch, member list, owner and messages of that epoch (with a double handover, each
//!   device follows the line of the handover it adopted first, and devices on one line
//!   agree);
//! - **removal is learnt**: every honest device removed from the group (by a kick, or by its
//!   own leave seen again after a rollback) shows the group as removed or left, or has
//!   closed it;
//! - **nothing forbidden is accepted**: no honest device installs a forged root, and every
//!   root an honest device installed in the group was created by a legitimate owner;
//! - **bounded work**: plaintexts and bytes per device and simulated hour stay under
//!   [`LIMITS`];
//! - every generated behaviour occurred at least once over the default seeds.
//!
//! Environment variables (local runs):
//!
//! - `GROUPS_MEMBERS_SEED=<n>`: replay one seed;
//! - `GROUPS_MEMBERS_SEEDS=<n>`: run seeds `GROUPS_MEMBERS_FIRST` (default 0) to `+ n`
//!   (default 4, in which every scripted situation occurs);
//! - `GROUPS_MEMBERS_HOURS=<n>`: hours of activity per run (default 13; the script takes
//!   about 10);
//! - `GROUPS_MEMBERS_FINAL=<n>`: hours of the final period (default 12);
//! - `GROUPS_MEMBERS_DEBUG=1`: on a failure, print the devices' groups.

use std::collections::{BTreeMap, BTreeSet};

use crate::event::Body;
use crate::ids::{Challenge, ChatId, GossipId, GroupSecret};
use crate::node::records::{EpochStatus, SignedObject};
use crate::node::tests::membership::{ident, signer};
use crate::node::{GroupChange, LeaveChoice, MyStatus, Node, NodeError};
use crate::rng::{TestRng, bytes, uniform_below};
use crate::root::{Root, RootParams};
use crate::signed::{Kick, Leave};
use crate::store::{MemoryStorage, StorageRead, StoredResult};
use crate::wire::{
    self, Entry, EntryItem, EventObject, Frame, Notice, QueryEntry, QueryOp, Response,
    ResponseResult,
};

const START: u64 = 1_700_000_000_000;
const SECOND: u64 = 1_000;
const MINUTE: u64 = 60 * SECOND;
const HOUR: u64 = 60 * MINUTE;
/// The interval between two steps of the owner's script.
const STEP: u64 = 40 * MINUTE;

/// The bounds of bounded work, per device and simulated hour. A root of a dozen members is
/// about 7 KB and goes to every member, with its kicks (3.4 KB each); an hour with a change
/// of membership costs a few roots per device.
pub(crate) struct Limits {
    pub plaintexts: u64,
    pub bytes: u64,
}

pub(crate) const LIMITS: Limits = Limits {
    plaintexts: 1_000,
    bytes: 2 * 1024 * 1024,
};

/// How often each generated behaviour occurred.
#[derive(Debug, Clone, Default)]
struct Counters {
    groups_created: u64,
    members_added: u64,
    members_removed: u64,
    members_readded: u64,
    renames: u64,
    handovers: u64,
    handovers_to_offline: u64,
    double_handovers: u64,
    dissolves: u64,
    signed_leaves: u64,
    kick_requests: u64,
    auto_successors: u64,
    owner_forks: u64,
    resolutions: u64,
    rollbacks: u64,
    relearnt_removals: u64,
    invitations_accepted: u64,
    invitations_declined: u64,
    messages: u64,
    old_epoch_edits: u64,
    deletions: u64,
    forged_roots: u64,
    bad_signatures: u64,
    forged_kicks: u64,
    forged_leaves: u64,
    replays: u64,
    fake_notices: u64,
    removal_replies: u64,
    failed_announcements: u64,
    key_queries_needed: u64,
    lost: u64,
    duplicated: u64,
    crashes: u64,
    /// Devices that show the group as two conversations because they cannot verify a new
    /// owner's authority (§5.9, D.3; reported).
    split_conversations: u64,
    /// Older epochs whose messages differ between two devices of one line (reported).
    older_epoch_differences: u64,
    forged_handovers: u64,
    forged_dissolves: u64,
    hostile_queries: u64,
    wrong_answers: u64,
    stranger_frames: u64,
    former_owner_forks: u64,
    takeovers: u64,
    dissolve_deletes: u64,
    long_chains: u64,
    max_plaintexts_hour: u64,
    max_bytes_hour: u64,
}

impl Counters {
    fn add(&mut self, o: &Counters) {
        macro_rules! sum {
            ($($f:ident),*) => { $( self.$f += o.$f; )* };
        }
        sum!(
            groups_created,
            members_added,
            members_removed,
            members_readded,
            renames,
            handovers,
            handovers_to_offline,
            double_handovers,
            dissolves,
            signed_leaves,
            kick_requests,
            auto_successors,
            owner_forks,
            resolutions,
            rollbacks,
            relearnt_removals,
            invitations_accepted,
            invitations_declined,
            messages,
            old_epoch_edits,
            deletions,
            forged_roots,
            bad_signatures,
            forged_kicks,
            forged_leaves,
            replays,
            fake_notices,
            removal_replies,
            failed_announcements,
            key_queries_needed,
            lost,
            duplicated,
            crashes,
            split_conversations,
            older_epoch_differences,
            forged_handovers,
            forged_dissolves,
            hostile_queries,
            wrong_answers,
            stranger_frames,
            former_owner_forks,
            takeovers,
            dissolve_deletes,
            long_chains
        );
        self.max_plaintexts_hour = self.max_plaintexts_hour.max(o.max_plaintexts_hour);
        self.max_bytes_hour = self.max_bytes_hour.max(o.max_bytes_hour);
    }

    fn missing(&self) -> Vec<&'static str> {
        let all = [
            ("groups_created", self.groups_created),
            ("members_added", self.members_added),
            ("members_removed", self.members_removed),
            ("members_readded", self.members_readded),
            ("renames", self.renames),
            ("handovers", self.handovers),
            ("handovers_to_offline", self.handovers_to_offline),
            ("double_handovers", self.double_handovers),
            ("dissolves", self.dissolves),
            ("signed_leaves", self.signed_leaves),
            ("kick_requests", self.kick_requests),
            ("auto_successors", self.auto_successors),
            ("owner_forks", self.owner_forks),
            ("resolutions", self.resolutions),
            ("rollbacks", self.rollbacks),
            ("relearnt_removals", self.relearnt_removals),
            ("invitations_accepted", self.invitations_accepted),
            ("invitations_declined", self.invitations_declined),
            ("messages", self.messages),
            ("old_epoch_edits", self.old_epoch_edits),
            ("deletions", self.deletions),
            ("forged_roots", self.forged_roots),
            ("bad_signatures", self.bad_signatures),
            ("forged_kicks", self.forged_kicks),
            ("forged_leaves", self.forged_leaves),
            ("replays", self.replays),
            ("fake_notices", self.fake_notices),
            ("removal_replies", self.removal_replies),
            ("failed_announcements", self.failed_announcements),
            ("key_queries_needed", self.key_queries_needed),
            ("lost", self.lost),
            ("duplicated", self.duplicated),
            ("crashes", self.crashes),
            ("forged_handovers", self.forged_handovers),
            ("forged_dissolves", self.forged_dissolves),
            ("hostile_queries", self.hostile_queries),
            ("wrong_answers", self.wrong_answers),
            ("stranger_frames", self.stranger_frames),
            ("former_owner_forks", self.former_owner_forks),
            ("takeovers", self.takeovers),
            ("dissolve_deletes", self.dissolve_deletes),
            ("long_chains", self.long_chains),
        ];
        all.iter()
            .filter(|(_, n)| *n == 0)
            .map(|(k, _)| *k)
            .collect()
    }
}

struct Mail {
    at: u64,
    seq: u64,
    from: usize,
    bytes: Vec<u8>,
}

struct Device {
    id: GossipId,
    hostile: bool,
    /// A stranger: a hostile identity that is no member of the group.
    stranger: bool,
    store: MemoryStorage,
    node: Option<Node>,
    online: bool,
    next: u64,
    session_end: u64,
    /// Kept offline until then (a member handed the group while away).
    away_until: u64,
    inbox: Vec<Mail>,
    hours: BTreeMap<u64, (u64, u64)>,
    /// Blobs of roots and signed objects seen (hostile devices replay them).
    seen: Vec<Vec<u8>>,
    /// The roots seen, decoded (hostile devices build on the latest).
    roots: Vec<Root>,
    /// A backup of the store, for a rollback.
    backup: Option<MemoryStorage>,
    /// Removed (kicked) from the group by an owner, per the script.
    removed: bool,
    /// Left by its own signed leave, per the script.
    left: bool,
    /// Closed the group itself (decline, leave, ask to be kicked).
    closed: bool,
    /// Restored from an old backup after its removal or leave.
    restored: bool,
    /// The messages it published, by epoch: for later edits and deletions.
    mine: Vec<(ChatId, crate::ids::SyncObjId)>,
    /// The engine's counters before its last restart: removal replies, failed
    /// announcements, automatic successors.
    engine: (u64, u64, u64),
}

/// A step of the owner's script, run at its time by whoever owns the group then.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Step {
    Add,
    Remove,
    Readd,
    Leave,
    AskKick,
    Backup,
    Rollback,
    RemoveRestored,
    OwnerFork,
    Rename,
    LongChain,
    Handover,
    DoubleHandover,
    Dissolve,
}

struct Sim {
    rng: TestRng,
    now: u64,
    devs: Vec<Device>,
    seq: u64,
    counters: Counters,
    end_active: u64,
    final_phase: bool,
    /// The group key on the founder's device: the founding epoch.
    group: Option<ChatId>,
    /// Roots created through the owner API by honest devices.
    legit: BTreeSet<ChatId>,
    /// Roots built by hostile devices.
    forged: BTreeSet<ChatId>,
    /// The owners of record: identities that legitimately owned the group.
    owners: BTreeSet<GossipId>,
    script: Vec<(u64, Step)>,
    /// The members chosen by the script.
    late: usize,
    victim: usize,
    leaver: usize,
    asker: usize,
    restored: usize,
    /// A double handover happened: lines may differ.
    split: bool,
    dissolved: bool,
    /// The owner forked and must resolve.
    forked: bool,
    /// A second group of the founder, with the same members (the target of a takeover).
    second: Option<ChatId>,
    /// Signed objects built by hostile devices.
    forged_objects: Vec<SignedObject>,
    /// Roots of a former owner continuing its old epoch after a handover.
    former_roots: BTreeSet<ChatId>,
    /// Dissolve & Delete in this seed.
    dissolve_delete: bool,
    /// Roots of a new owner naming the former owner's second group: forbidden on a device
    /// that holds that group; a valid successor with one unmatched parent elsewhere.
    takeover_roots: BTreeSet<ChatId>,
}

fn below(rng: &mut TestRng, n: u64) -> u64 {
    uniform_below(rng, usize::try_from(n).expect("small")) as u64
}

fn chance(rng: &mut TestRng, percent: u64) -> bool {
    below(rng, 100) < percent
}

fn decode(bytes: &[u8]) -> Vec<Frame> {
    match wire::decode_plaintext(bytes) {
        Ok(pt) => pt.frames().filter_map(Result::ok).collect(),
        Err(_) => Vec::new(),
    }
}

impl Sim {
    fn new(seed: u64, hours: u64) -> Self {
        let mut rng = TestRng::new(seed ^ 0x6d65_6d62);
        // Honest devices 0..h, hostile ones after.
        let honest = 6 + below(&mut rng, 3) as usize;
        let hostile = 1 + below(&mut rng, 2) as usize;
        // The last device is a stranger, no member of the group.
        let n = honest + hostile + 1;
        let devs = (0..n)
            .map(|i| Device {
                id: ident(i).id,
                hostile: i >= honest,
                stranger: i == n - 1,
                store: MemoryStorage::new(),
                node: None,
                online: false,
                next: START + below(&mut rng, 10 * MINUTE),
                session_end: 0,
                away_until: 0,
                inbox: Vec::new(),
                hours: BTreeMap::new(),
                seen: Vec::new(),
                roots: Vec::new(),
                backup: None,
                removed: false,
                left: false,
                closed: false,
                restored: false,
                mine: Vec::new(),
                engine: (0, 0, 0),
            })
            .collect();
        // The script: at hour h (with jitter), the step. Members are chosen among the
        // honest devices other than the founder (0) and the first heir (1).
        let late = honest - 1;
        let victim = 2;
        let leaver = 3;
        let asker = 4;
        let restored = if seed.is_multiple_of(2) { leaver } else { 5 };
        // Steps every 40 minutes, with a jitter.
        let at = |rng: &mut TestRng, h: u64| START + h * STEP + below(rng, STEP / 3);
        let mut script = vec![
            (at(&mut rng, 1), Step::Add),
            (at(&mut rng, 2), Step::Remove),
            (at(&mut rng, 3), Step::Backup),
            (at(&mut rng, 4), Step::Readd),
            (at(&mut rng, 5), Step::Leave),
            (at(&mut rng, 6), Step::AskKick),
            (at(&mut rng, 7), Step::RemoveRestored),
            (at(&mut rng, 8), Step::Rollback),
            (at(&mut rng, 9), Step::Rename),
        ];
        match seed % 3 {
            0 => script.push((at(&mut rng, 10), Step::OwnerFork)),
            1 => script.push((at(&mut rng, 10), Step::Handover)),
            _ => script.push((at(&mut rng, 10), Step::DoubleHandover)),
        }
        if seed.is_multiple_of(3) {
            script.push((at(&mut rng, 12), Step::Handover));
        }
        script.push((at(&mut rng, 11), Step::LongChain));
        if seed % 4 == 3 {
            script.push((at(&mut rng, 14), Step::Dissolve));
        }
        let mut sim = Self {
            rng,
            now: START,
            devs,
            seq: 0,
            counters: Counters::default(),
            end_active: START + hours * HOUR,
            final_phase: false,
            group: None,
            legit: BTreeSet::new(),
            forged: BTreeSet::new(),
            owners: BTreeSet::new(),
            script,
            late,
            victim,
            leaver,
            asker,
            restored,
            split: false,
            dissolved: false,
            forked: false,
            second: None,
            forged_objects: Vec::new(),
            former_roots: BTreeSet::new(),
            dissolve_delete: seed % 8 == 3,
            takeover_roots: BTreeSet::new(),
        };
        for d in 0..n {
            sim.boot(d);
            // Most devices know the others as contacts; the late member and one other know
            // nobody and fetch the keys by key queries (§4.3).
            let contacts = d != late && d != 5;
            if !contacts {
                sim.counters.key_queries_needed += 1;
            }
            for k in 0..n {
                if contacts || k == d {
                    let bytes = ident(k).public.to_bytes();
                    let dev = &mut sim.devs[d];
                    dev.node
                        .as_mut()
                        .unwrap()
                        .learn_keys(&mut dev.store, &bytes, START, &mut sim.rng)
                        .unwrap();
                }
            }
        }
        // The founder creates the group with every device but the late one and the stranger.
        let members: Vec<GossipId> = (1..n - 1)
            .filter(|d| *d != late)
            .map(|d| ident(d).id)
            .collect();
        let s = signer(0);
        let dev = &mut sim.devs[0];
        let g = dev
            .node
            .as_mut()
            .unwrap()
            .create_group(
                &mut dev.store,
                &s,
                "Team".into(),
                members,
                START,
                &mut sim.rng,
            )
            .unwrap();
        sim.legit.insert(g);
        sim.owners.insert(ident(0).id);
        sim.group = Some(g);
        sim.counters.groups_created += 1;
        // A second group with the same members, which a new owner of the first must not be
        // able to take over (a former owner's other group).
        let members: Vec<GossipId> = (1..n - 1).map(|d| ident(d).id).collect();
        let dev = &mut sim.devs[0];
        let g2 = dev
            .node
            .as_mut()
            .unwrap()
            .create_group(
                &mut dev.store,
                &s,
                "Other".into(),
                members,
                START,
                &mut sim.rng,
            )
            .unwrap();
        sim.legit.insert(g2);
        sim.second = Some(g2);
        sim.counters.groups_created += 1;
        sim
    }

    fn boot(&mut self, d: usize) {
        let dev = &mut self.devs[d];
        if let Some(n) = dev.node.take() {
            let s = n.stats();
            dev.engine.0 += s.removal_replies;
            dev.engine.1 += s.failed_announcements;
            dev.engine.2 += s.auto_successors;
        }
        dev.node = Some(Node::open(&dev.store, dev.id).expect("open"));
    }

    fn node(&self, d: usize) -> &Node {
        self.devs[d].node.as_ref().expect("booted")
    }

    fn op<T>(
        &mut self,
        d: usize,
        mut f: impl FnMut(&mut Node, &mut MemoryStorage, u64, &mut TestRng) -> Result<T, NodeError>,
    ) -> Result<T, NodeError> {
        let now = self.now;
        let dev = &mut self.devs[d];
        f(
            dev.node.as_mut().expect("booted"),
            &mut dev.store,
            now,
            &mut self.rng,
        )
    }

    /// The group as device `d` sees it: the group whose key or an epoch is the founding
    /// epoch, or the group of any legitimate epoch it holds.
    ///
    /// A device may hold the group as two conversations: a root whose authority it cannot
    /// verify (it does not hold the handover that gives it) is an invitation that starts a
    /// separate group (§5.9, D.3). The one whose current epoch is the latest is the
    /// conversation the user follows; the other is history it may link by hand.
    fn group_of(&self, d: usize) -> Option<crate::node::GroupSummary> {
        let node = self.node(d);
        node.groups()
            .into_iter()
            .filter(|s| self.legit.contains(&s.current) && Some(s.current) != self.second)
            .max_by_key(|s| {
                let at = node.root(&s.current).map_or(0, |r| r.created_at());
                (at, s.current)
            })
    }

    fn honest(&self) -> Vec<usize> {
        (0..self.devs.len())
            .filter(|d| !self.devs[*d].hostile)
            .collect()
    }

    // ── Transport ────────────────────────────────────────────────────────────

    fn transmit(&mut self, from: usize, to: GossipId, bytes: Vec<u8>) {
        let Some(to) = self.devs.iter().position(|d| d.id == to) else {
            return;
        };
        if chance(&mut self.rng, 3) {
            self.counters.lost += 1;
            return;
        }
        let mut delay = 200 + below(&mut self.rng, 20 * SECOND);
        if chance(&mut self.rng, 3) {
            delay += HOUR + below(&mut self.rng, 3 * HOUR);
        }
        let copies = if chance(&mut self.rng, 3) {
            self.counters.duplicated += 1;
            2
        } else {
            1
        };
        for c in 0..copies {
            self.seq += 1;
            let at = self.now + delay + c * below(&mut self.rng, HOUR);
            self.devs[to].inbox.push(Mail {
                at,
                seq: self.seq,
                from,
                bytes: bytes.clone(),
            });
        }
    }

    fn send(&mut self, d: usize) {
        let out = self
            .op(d, |n, s, now, rng| n.poll_outbox(s, now, rng))
            .expect("poll");
        let hour = (self.now - START) / HOUR;
        for o in out {
            let handle = o.handle;
            if chance(&mut self.rng, 1) {
                // A crash between assembling and confirming: the work is assembled again.
                self.counters.crashes += 1;
                self.boot(d);
                return;
            }
            self.op(d, |n, s, now, rng| n.handed_off(s, handle, now, rng))
                .expect("handoff");
            let e = self.devs[d].hours.entry(hour).or_default();
            e.0 += 1;
            e.1 += o.plaintext.len() as u64;
            self.transmit(d, o.to, o.plaintext);
        }
    }

    // ── One poll of a device ─────────────────────────────────────────────────

    fn step(&mut self, d: usize) {
        let mut arrived: Vec<Mail> = Vec::new();
        for m in core::mem::take(&mut self.devs[d].inbox) {
            if m.at <= self.now {
                arrived.push(m);
            } else {
                self.devs[d].inbox.push(m);
            }
        }
        arrived.sort_by_key(|m| (m.at, m.seq));
        if self.devs[d].hostile {
            for m in &arrived {
                self.hostile_learn(d, m.from, &m.bytes);
            }
            self.hostile_step(d);
            return;
        }
        for m in arrived {
            let from = self.devs[m.from].id;
            self.op(d, |n, s, now, rng| {
                n.handle_plaintext(s, from, &m.bytes, now, rng)
            })
            .expect("receive");
        }
        let sg = signer(d);
        self.op(d, |n, s, now, rng| n.tick_with(s, Some(&sg), now, rng))
            .expect("tick");
        // The roots this honest device created (also automatically, §5.5) are legitimate.
        let me = self.devs[d].id;
        let created: Vec<ChatId> = self
            .node(d)
            .tables()
            .epochs
            .iter()
            .filter(|(_, r)| r.from == me && r.root.owner_id() != GossipId::from_bytes([0; 32]))
            .map(|(c, _)| *c)
            .collect();
        self.legit.extend(created);
        self.answer_invitations(d);
        self.resolve_if_needed(d);
        if !self.final_phase && self.now < self.end_active {
            self.user_action(d);
        }
        self.send(d);
        if chance(&mut self.rng, 1) {
            self.counters.crashes += 1;
            self.boot(d);
        }
    }

    /// The user answers its invitations: those of the group's legitimate owners are
    /// accepted, unless the user had left; the others are declined silently.
    fn answer_invitations(&mut self, d: usize) {
        let now = self.now;
        let invitations = self.node(d).invitations(now);
        for inv in invitations {
            // A former owner's root after its handover is no invitation a user takes.
            let legit = self.legit.contains(&inv.chat_id)
                && !self.former_roots.contains(&inv.chat_id)
                && !self.devs[d].closed;
            // Answering one invitation may settle another (the lookup of its parent
            // succeeded): an invitation that is gone is skipped.
            let r = if legit {
                self.op(d, |n, s, now, rng| {
                    n.accept_invitation(s, inv.chat_id, now, rng).map(|_| ())
                })
            } else {
                let sg = signer(d);
                self.op(d, |n, s, now, rng| {
                    n.decline_invitation(s, &sg, inv.chat_id, LeaveChoice::Silent, now, rng)
                })
            };
            match r {
                Ok(()) if legit => self.counters.invitations_accepted += 1,
                Ok(()) => self.counters.invitations_declined += 1,
                Err(NodeError::UnknownEpoch) => {}
                Err(e) => panic!("device {d}: answering an invitation: {e}"),
            }
        }
    }

    /// An honest owner resolves the competing ends it holds, with every member of every
    /// branch (§4.9: "include all").
    fn resolve_if_needed(&mut self, d: usize) {
        let Some(s) = self.group_of(d) else { return };
        if !(s.must_resolve || !s.former_owner_branches.is_empty()) || self.split {
            return;
        }
        let node = self.node(d);
        let mut members: BTreeSet<GossipId> = s.members.iter().copied().collect();
        for e in &s.side_branches {
            if let Some(r) = node.root(e) {
                members.extend(r.members().iter().copied());
            }
        }
        members.remove(&self.devs[d].id);
        let change = GroupChange::Resolve {
            members: members.into_iter().collect(),
            name: None,
        };
        let sg = signer(d);
        if let Ok(id) = self.op(d, |n, st, now, rng| {
            n.change_group(st, &sg, s.group, change.clone(), now, rng)
        }) {
            self.legit.insert(id);
            self.counters.resolutions += 1;
        }
    }

    fn user_action(&mut self, d: usize) {
        let Some(s) = self.group_of(d) else { return };
        if s.status != MyStatus::Member {
            return;
        }
        let roll = below(&mut self.rng, 100);
        let now = self.now;
        if roll < 8 {
            let body = Body::Text(format!("m{}", below(&mut self.rng, 1000)));
            let chat = s.current;
            if let Ok(p) = self.op(d, |n, st, now, rng| {
                n.publish_message(st, chat, body.clone(), BTreeMap::new(), None, now, rng)
            }) {
                self.counters.messages += 1;
                self.devs[d]
                    .mine
                    .push((chat, p.event.payload().sync_obj_id()));
            }
        } else if roll < 10 && !self.devs[d].mine.is_empty() {
            // An edit of one of its messages, often in an older epoch (§10.4).
            let i = below(&mut self.rng, self.devs[d].mine.len() as u64) as usize;
            let (chat, sync) = self.devs[d].mine[i];
            if self.node(d).root(&chat).is_none() {
                return;
            }
            let old = chat != s.current;
            let body = Body::Text(format!("e{}", below(&mut self.rng, 1000)));
            if self
                .op(d, |n, st, now, rng| {
                    n.publish_edit(
                        st,
                        chat,
                        sync,
                        body.clone(),
                        BTreeMap::new(),
                        None,
                        now,
                        rng,
                    )
                })
                .is_ok()
                && old
            {
                self.counters.old_epoch_edits += 1;
            }
        } else if roll < 11 && !self.devs[d].mine.is_empty() {
            let i = below(&mut self.rng, self.devs[d].mine.len() as u64) as usize;
            let (chat, sync) = self.devs[d].mine.swap_remove(i);
            if self.node(d).root(&chat).is_some()
                && self
                    .op(d, |n, st, now, rng| {
                        n.publish_deletion(st, chat, sync, None, now, rng)
                    })
                    .is_ok()
            {
                self.counters.deletions += 1;
            }
        }
        let _ = now;
    }

    // ── The owner's script ───────────────────────────────────────────────────

    /// The honest device that owns the group now: its current epoch names it as owner.
    fn owner(&self) -> Option<usize> {
        self.honest().into_iter().find(|d| {
            self.group_of(*d).is_some_and(|s| {
                s.owner == self.devs[*d].id && s.status == MyStatus::Member && !self.devs[*d].closed
            })
        })
    }

    fn change(&mut self, d: usize, change: GroupChange) -> Option<ChatId> {
        let s = self.group_of(d)?;
        let sg = signer(d);
        match self.op(d, |n, st, now, rng| {
            n.change_group(st, &sg, s.group, change.clone(), now, rng)
        }) {
            Ok(id) => {
                self.legit.insert(id);
                if let GroupChange::Handover { new_owner, .. } = change {
                    self.owners.insert(new_owner);
                }
                Some(id)
            }
            Err(_) => None,
        }
    }

    fn run_script(&mut self) {
        while let Some((at, step)) = self.script.first().copied() {
            if at > self.now {
                return;
            }
            self.script.remove(0);
            let Some(o) = self.owner() else {
                // Nobody owns the group right now (a new owner away, a fork): later.
                if self.now < self.end_active {
                    self.script.push((self.now + 10 * MINUTE, step));
                    self.script.sort_by_key(|(t, _)| *t);
                }
                continue;
            };
            // The owner is online for its step.
            self.devs[o].online = true;
            self.devs[o].session_end = self.devs[o].session_end.max(self.now + 20 * MINUTE);
            let id = |d: usize| ident(d).id;
            match step {
                Step::Add => {
                    if self
                        .change(
                            o,
                            GroupChange::Successor {
                                add: vec![id(self.late)],
                                remove: vec![],
                                name: None,
                            },
                        )
                        .is_some()
                    {
                        self.counters.members_added += 1;
                    }
                }
                Step::Remove => {
                    let v = self.victim;
                    if self
                        .change(
                            o,
                            GroupChange::Successor {
                                add: vec![],
                                remove: vec![id(v)],
                                name: None,
                            },
                        )
                        .is_some()
                    {
                        self.devs[v].removed = true;
                        self.counters.members_removed += 1;
                    }
                }
                Step::Readd => {
                    let v = self.victim;
                    if self
                        .change(
                            o,
                            GroupChange::Successor {
                                add: vec![id(v)],
                                remove: vec![],
                                name: None,
                            },
                        )
                        .is_some()
                    {
                        self.devs[v].removed = false;
                        self.counters.members_readded += 1;
                    }
                }
                Step::Backup => {
                    let r = self.restored;
                    self.devs[r].backup = Some(self.devs[r].store.clone());
                    // The owner too, for a fork.
                    self.devs[o].backup = Some(self.devs[o].store.clone());
                }
                Step::Leave => {
                    let l = self.leaver;
                    let Some(s) = self.group_of(l) else { continue };
                    let sg = signer(l);
                    if self
                        .op(l, |n, st, now, rng| {
                            n.leave_group(st, &sg, s.group, LeaveChoice::Signed, now, rng)
                        })
                        .is_ok()
                    {
                        self.devs[l].left = true;
                        self.devs[l].closed = true;
                        self.counters.signed_leaves += 1;
                        self.devs[l].online = true;
                        self.send(l);
                    }
                }
                Step::AskKick => {
                    let a = self.asker;
                    let Some(s) = self.group_of(a) else { continue };
                    let sg = signer(a);
                    if self
                        .op(a, |n, st, now, rng| {
                            n.leave_group(st, &sg, s.group, LeaveChoice::AskToBeKicked, now, rng)
                        })
                        .is_ok()
                    {
                        self.devs[a].closed = true;
                        self.counters.kick_requests += 1;
                        self.devs[a].online = true;
                        self.send(a);
                    }
                }
                Step::RemoveRestored => {
                    let r = self.restored;
                    if r != self.leaver
                        && self
                            .change(
                                o,
                                GroupChange::Successor {
                                    add: vec![],
                                    remove: vec![id(r)],
                                    name: None,
                                },
                            )
                            .is_some()
                    {
                        self.devs[r].removed = true;
                        self.counters.members_removed += 1;
                    }
                }
                Step::Rollback => {
                    let r = self.restored;
                    if let Some(b) = self.devs[r].backup.take()
                        && (self.devs[r].removed || self.devs[r].left)
                    {
                        self.devs[r].store = b;
                        self.boot(r);
                        self.devs[r].restored = true;
                        self.devs[r].closed = false;
                        self.counters.rollbacks += 1;
                    }
                }
                Step::OwnerFork => {
                    // The owner creates a successor, then restores its backup and creates
                    // another one of an earlier epoch: two competing ends.
                    if self
                        .change(
                            o,
                            GroupChange::Successor {
                                add: vec![],
                                remove: vec![],
                                name: Some("A".into()),
                            },
                        )
                        .is_some()
                    {
                        self.send(o);
                        if let Some(b) = self.devs[o].backup.take() {
                            self.devs[o].store = b;
                            self.boot(o);
                            if self
                                .change(
                                    o,
                                    GroupChange::Successor {
                                        add: vec![],
                                        remove: vec![],
                                        name: Some("B".into()),
                                    },
                                )
                                .is_some()
                            {
                                self.forked = true;
                                self.counters.owner_forks += 1;
                            }
                        }
                    }
                }
                Step::LongChain => {
                    // A member away while the owner renames the group many times: it gets a
                    // long chain of roots back, in whatever order they come.
                    let away = self.honest().into_iter().find(|d| {
                        *d != o
                            && !self.devs[*d].closed
                            && !self.devs[*d].restored
                            && !self.devs[*d].removed
                    });
                    if let Some(a) = away {
                        self.devs[a].online = false;
                        self.devs[a].away_until = self.now + HOUR;
                        self.devs[a].next = self.devs[a].away_until;
                    }
                    let mut made = 0;
                    for i in 0..12 {
                        if self
                            .change(
                                o,
                                GroupChange::Successor {
                                    add: vec![],
                                    remove: vec![],
                                    name: Some(format!("chain {i}")),
                                },
                            )
                            .is_some()
                        {
                            made += 1;
                        }
                    }
                    if made > 0 {
                        self.counters.long_chains += 1;
                    }
                }
                Step::Rename => {
                    if self
                        .change(
                            o,
                            GroupChange::Successor {
                                add: vec![],
                                remove: vec![],
                                name: Some("Renamed".into()),
                            },
                        )
                        .is_some()
                    {
                        self.counters.renames += 1;
                    }
                }
                Step::Handover => {
                    // To a member, in some seeds one that is offline for hours.
                    let Some(s) = self.group_of(o) else { continue };
                    let heir = self.honest().into_iter().find(|d| {
                        *d != o
                            && s.members.contains(&self.devs[*d].id)
                            && !self.devs[*d].closed
                            && !self.devs[*d].restored
                    });
                    let Some(heir) = heir else { continue };
                    if self
                        .change(
                            o,
                            GroupChange::Handover {
                                new_owner: id(heir),
                                leave: false,
                                remove: vec![],
                                name: None,
                            },
                        )
                        .is_some()
                    {
                        self.counters.handovers += 1;
                        if let Some(old) = self.group_of(o).map(|s| s.current) {
                            // Its root of the former epoch is the line's previous end.
                            let prev = self.node(o).root(&old).and_then(|_| {
                                self.node(o)
                                    .tables()
                                    .epochs
                                    .get(&old)
                                    .and_then(|r| r.parents.first().copied())
                            });
                            if let Some(prev) = prev {
                                self.after_handover(o, heir, prev);
                            }
                        }
                        if chance(&mut self.rng, 50) || self.counters.handovers_to_offline == 0 {
                            self.devs[heir].online = false;
                            self.devs[heir].away_until = self.now + 2 * HOUR;
                            self.devs[heir].next = self.devs[heir].away_until;
                            self.counters.handovers_to_offline += 1;
                        }
                    }
                }
                Step::DoubleHandover => {
                    // A hostile owner: two handovers of one epoch, to two members.
                    let Some(s) = self.group_of(o) else { continue };
                    let heirs: Vec<usize> = self
                        .honest()
                        .into_iter()
                        .filter(|d| {
                            *d != o
                                && s.members.contains(&self.devs[*d].id)
                                && !self.devs[*d].closed
                                && !self.devs[*d].restored
                        })
                        .take(2)
                        .collect();
                    if heirs.len() < 2 {
                        continue;
                    }
                    let backup = self.devs[o].store.clone();
                    if self
                        .change(
                            o,
                            GroupChange::Handover {
                                new_owner: id(heirs[0]),
                                leave: false,
                                remove: vec![],
                                name: None,
                            },
                        )
                        .is_some()
                    {
                        self.send(o);
                        self.devs[o].store = backup;
                        self.boot(o);
                        if self
                            .change(
                                o,
                                GroupChange::Handover {
                                    new_owner: id(heirs[1]),
                                    leave: false,
                                    remove: vec![],
                                    name: None,
                                },
                            )
                            .is_some()
                        {
                            self.split = true;
                            self.counters.double_handovers += 1;
                        }
                    }
                }
                Step::Dissolve => {
                    let delete = self.dissolve_delete;
                    let Some(s) = self.group_of(o) else { continue };
                    let sg = signer(o);
                    if self
                        .op(o, |n, st, now, rng| {
                            n.dissolve_group(st, &sg, s.group, delete, now, rng)
                        })
                        .is_ok()
                    {
                        self.dissolved = true;
                        self.counters.dissolves += 1;
                        self.counters.dissolve_deletes += u64::from(delete);
                    }
                }
            }
        }
    }

    // ── Hostile members ──────────────────────────────────────────────────────

    fn hostile_learn(&mut self, d: usize, from: usize, bytes: &[u8]) {
        for f in decode(bytes) {
            // Wrong answers to every lookup: a stray root or object, its own keys.
            if let Frame::Query(q) = &f {
                let me = ident(d);
                let mut out = Vec::new();
                for (idx, e) in q.entries.iter().enumerate() {
                    let result = match e {
                        QueryEntry::Op(QueryOp::Keys { .. }) => {
                            ResponseResult::Keys(me.public.to_bytes())
                        }
                        QueryEntry::Op(
                            QueryOp::ChatById(_)
                            | QueryOp::ChatByParent { .. }
                            | QueryOp::SignedObject { .. },
                        ) => match self.devs[d].seen.first() {
                            Some(b) => ResponseResult::Event(b.clone()),
                            None => continue,
                        },
                        _ => continue,
                    };
                    out.push(Frame::Response(Response {
                        request_id: Some(q.request_id),
                        idx: idx as u32,
                        result,
                    }));
                }
                if !out.is_empty() {
                    self.counters.wrong_answers += out.len() as u64;
                    if let Ok(pt) = wire::encode_plaintext(&out) {
                        let to = self.devs[from].id;
                        self.transmit(d, to, pt);
                    }
                }
                continue;
            }
            let Frame::Event(b) = f else { continue };
            match wire::decode_event_blob(&b, 1) {
                Ok(EventObject::Root(r)) => {
                    let known = self.devs[d]
                        .roots
                        .iter()
                        .any(|x| x.chat_id() == r.chat_id());
                    if !known {
                        if self.devs[d].roots.len() >= 16 {
                            self.devs[d].roots.remove(0);
                        }
                        self.devs[d].roots.push(*r);
                        self.devs[d].seen.push(b);
                    }
                }
                Ok(EventObject::Kick(_) | EventObject::Leave(_)) => self.devs[d].seen.push(b),
                _ => {}
            }
        }
        while self.devs[d].seen.len() > 64 {
            self.devs[d].seen.remove(0);
        }
    }

    fn hostile_step(&mut self, d: usize) {
        if self.final_phase || !chance(&mut self.rng, 20) {
            return;
        }
        if self.devs[d].stranger {
            self.stranger_step(d);
            return;
        }
        let Some(root) = self.devs[d].roots.last().cloned() else {
            return;
        };
        let me = &ident(d);
        let targets: Vec<GossipId> = root
            .members()
            .iter()
            .filter(|m| **m != me.id)
            .copied()
            .collect();
        if targets.is_empty() {
            return;
        }
        let to = targets[below(&mut self.rng, targets.len() as u64) as usize];
        let frame = match below(&mut self.rng, 9) {
            0 => {
                // Its own root continuing the group: a valid signature, no authority.
                let params = RootParams {
                    name: "taken over".into(),
                    members: root.members().to_vec(),
                    group_secret: GroupSecret::from_bytes(bytes(&mut self.rng)),
                    owner: me.public.clone(),
                    epoch_challenge: Challenge::from_bytes(bytes(&mut self.rng)),
                    ref_chat_id_challenge: Challenge::from_bytes(bytes(&mut self.rng)),
                    created_at: self.now,
                };
                let Ok(r) = Root::create_successor(
                    params,
                    &[root.chat_id()],
                    &me.secret.dsa_signing_key,
                    bytes(&mut self.rng),
                ) else {
                    return;
                };
                self.forged.insert(r.chat_id());
                self.counters.forged_roots += 1;
                Frame::Event(wire::encode_event_blob(&EventObject::Root(Box::new(r))).unwrap())
            }
            1 => {
                // A copy of a real root under the owner's name, with a broken signature.
                let mut p = root.to_proto();
                p.name = "evil".into();
                let Ok(r) = Root::from_proto(1, p) else {
                    return;
                };
                self.forged.insert(r.chat_id());
                self.counters.bad_signatures += 1;
                Frame::Event(wire::encode_event_blob(&EventObject::Root(Box::new(r))).unwrap())
            }
            2 => {
                // A kick of another member, signed with its own key.
                let victim = targets[0];
                let Ok(k) = Kick::sign_as(
                    &root,
                    victim,
                    &me.secret.dsa_signing_key,
                    &me.public,
                    bytes(&mut self.rng),
                ) else {
                    return;
                };
                self.forged_objects.push(SignedObject::Kick(k.clone()));
                self.counters.forged_kicks += 1;
                Frame::Event(wire::encode_event_blob(&EventObject::Kick(k)).unwrap())
            }
            3 => {
                // A leave of another member, signed with its own key.
                let victim = targets[0];
                let id = crate::hash::leave_id(&root.chat_id(), &victim);
                let sig = crate::keys::Signer::sign_id(
                    &me.secret.dsa_signing_key,
                    crate::constants::CONTEXT_LEAVE_SIGNATURE,
                    id.as_bytes(),
                    bytes(&mut self.rng),
                );
                let p = crate::wire::proto::Leave {
                    chat_id: root.chat_id().as_bytes().to_vec(),
                    gossip_id: victim.as_bytes().to_vec(),
                    signature: sig.as_bytes().to_vec(),
                };
                let Ok(l) = Leave::from_proto(&p) else { return };
                self.forged_objects.push(SignedObject::Leave(l.clone()));
                self.counters.forged_leaves += 1;
                Frame::Event(wire::encode_event_blob(&EventObject::Leave(l)).unwrap())
            }
            6 => {
                // A handover of the group to itself, with its own (wrong) signature.
                let mut p = root.to_proto();
                p.r#type = crate::wire::proto::RootType::Handover as i32;
                p.parents.truncate(1);
                p.owner = me.public.to_bytes();
                p.name = "mine".into();
                let Ok(r) = Root::from_proto(1, p) else {
                    return;
                };
                self.forged.insert(r.chat_id());
                self.counters.forged_handovers += 1;
                Frame::Event(wire::encode_event_blob(&EventObject::Root(Box::new(r))).unwrap())
            }
            7 => {
                // A dissolve message of the group, signed with its own key.
                let must_delete = chance(&mut self.rng, 50);
                let id = crate::hash::dissolve_id(&root.chat_id(), must_delete);
                let sig = crate::keys::Signer::sign_id(
                    &me.secret.dsa_signing_key,
                    crate::constants::CONTEXT_DISSOLVE_SIGNATURE,
                    id.as_bytes(),
                    bytes(&mut self.rng),
                );
                let p = crate::wire::proto::Dissolve {
                    chat_id: root.chat_id().as_bytes().to_vec(),
                    must_delete,
                    signature: sig.as_bytes().to_vec(),
                };
                let Ok(x) = crate::signed::Dissolve::from_proto(&p) else {
                    return;
                };
                self.forged_objects.push(SignedObject::Dissolve(x.clone()));
                self.counters.forged_dissolves += 1;
                Frame::Event(wire::encode_event_blob(&EventObject::Dissolve(x)).unwrap())
            }
            8 => {
                // Membership lookups, often from a member removed since.
                self.counters.hostile_queries += 1;
                Frame::Query(crate::wire::Query {
                    request_id: crate::ids::RequestId::from_bytes(bytes(&mut self.rng)),
                    sent_at: self.now,
                    ttl: MINUTE,
                    entries: vec![
                        QueryEntry::Op(QueryOp::ChatById(root.chat_id())),
                        QueryEntry::Op(QueryOp::Keys {
                            chat_id: root.chat_id(),
                            gossip_id: to,
                        }),
                        QueryEntry::Op(QueryOp::Removal {
                            chat_id: root.chat_id(),
                            gossip_id: to,
                        }),
                        QueryEntry::Op(QueryOp::SharedChatsScan {
                            scan_id: crate::ids::ScanId::from_bytes(bytes(&mut self.rng)),
                            offset: 0,
                        }),
                    ],
                })
            }
            4 => {
                // A replay of a root or signed object it received, possibly of another
                // epoch, or of an epoch the recipient left long ago.
                let i = below(&mut self.rng, self.devs[d].seen.len() as u64) as usize;
                self.counters.replays += 1;
                Frame::Event(self.devs[d].seen[i].clone())
            }
            _ => {
                // Notices of roots and signed objects that do not exist.
                self.counters.fake_notices += 1;
                Frame::Notice(Notice {
                    entries: vec![
                        Entry {
                            chat_id: ChatId::from_bytes(bytes(&mut self.rng)),
                            item: EntryItem::Root,
                        },
                        Entry {
                            chat_id: root.chat_id(),
                            item: EntryItem::Kick(crate::ids::KickId::from_bytes(bytes(
                                &mut self.rng,
                            ))),
                        },
                        Entry {
                            chat_id: root.chat_id(),
                            item: EntryItem::Leave(crate::ids::LeaveId::from_bytes(bytes(
                                &mut self.rng,
                            ))),
                        },
                    ],
                    skipped: 0,
                })
            }
        };
        let pt = wire::encode_plaintext(&[frame]).expect("fits");
        self.transmit(d, to, pt);
    }

    /// A stranger, no member of the group, sends a member roots of its own listing them
    /// both (invitations nobody accepts), and root notices of epochs.
    fn stranger_step(&mut self, d: usize) {
        let honest = self.honest();
        let target = honest[below(&mut self.rng, honest.len() as u64) as usize];
        let to = self.devs[target].id;
        let me = ident(d);
        let frame = if chance(&mut self.rng, 50) {
            let params = RootParams {
                name: "join us".into(),
                members: vec![to, me.id],
                group_secret: GroupSecret::from_bytes(bytes(&mut self.rng)),
                owner: me.public.clone(),
                epoch_challenge: Challenge::from_bytes(bytes(&mut self.rng)),
                ref_chat_id_challenge: Challenge::from_bytes(bytes(&mut self.rng)),
                created_at: self.now,
            };
            let parents: Vec<ChatId> = (0..4)
                .map(|_| ChatId::from_bytes(bytes(&mut self.rng)))
                .collect();
            let Ok(r) = Root::create_successor(
                params,
                &parents,
                &me.secret.dsa_signing_key,
                bytes(&mut self.rng),
            ) else {
                return;
            };
            self.forged.insert(r.chat_id());
            Frame::Event(wire::encode_event_blob(&EventObject::Root(Box::new(r))).unwrap())
        } else {
            let mut entries = vec![Entry {
                chat_id: ChatId::from_bytes(bytes(&mut self.rng)),
                item: EntryItem::Root,
            }];
            if let Some(g) = self.group {
                entries.push(Entry {
                    chat_id: g,
                    item: EntryItem::Root,
                });
            }
            Frame::Notice(Notice {
                entries,
                skipped: 0,
            })
        };
        self.counters.stranger_frames += 1;
        let pt = wire::encode_plaintext(&[frame]).expect("fits");
        self.transmit(d, to, pt);
    }

    /// The former owner `o`, after handing the group over, signs a successor of its old
    /// epoch dated at the end of time; the heir builds a root continuing both its line and
    /// the former owner's second group. Neither may take effect.
    fn after_handover(&mut self, o: usize, heir: usize, old: ChatId) {
        let members: Vec<GossipId> = self
            .node(o)
            .root(&old)
            .map(|r| r.members().to_vec())
            .unwrap_or_default();
        if members.is_empty() {
            return;
        }
        let params =
            |owner: &auth::UserPublicKeys, rng: &mut TestRng, at: u64, name: &str| RootParams {
                name: name.into(),
                members: members.clone(),
                group_secret: GroupSecret::from_bytes(bytes(rng)),
                owner: owner.clone(),
                epoch_challenge: Challenge::from_bytes(bytes(rng)),
                ref_chat_id_challenge: Challenge::from_bytes(bytes(rng)),
                created_at: at,
            };
        let a = ident(o);
        let p = params(&a.public, &mut self.rng, u64::MAX, "back");
        if let Ok(r) =
            Root::create_successor(p, &[old], &a.secret.dsa_signing_key, bytes(&mut self.rng))
        {
            // A former owner's root continuing its own epoch: valid, kept as a side branch
            // (§5.9), never current.
            self.legit.insert(r.chat_id());
            self.former_roots.insert(r.chat_id());
            self.counters.former_owner_forks += 1;
            let blob = wire::encode_event_blob(&EventObject::Root(Box::new(r))).unwrap();
            for m in &members {
                if *m != a.id {
                    let pt = wire::encode_plaintext(&[Frame::Event(blob.clone())]).unwrap();
                    self.transmit(o, *m, pt);
                }
            }
        }
        let (Some(second), Some(cur)) = (self.second, self.node(o).current_epoch(&old)) else {
            return;
        };
        let b = ident(heir);
        let p = params(&b.public, &mut self.rng, self.now, "taken");
        if let Ok(r) = Root::create_successor(
            p,
            &[cur, second],
            &b.secret.dsa_signing_key,
            bytes(&mut self.rng),
        ) {
            self.takeover_roots.insert(r.chat_id());
            self.counters.takeovers += 1;
            let blob = wire::encode_event_blob(&EventObject::Root(Box::new(r))).unwrap();
            for m in &members {
                if *m != b.id {
                    let pt = wire::encode_plaintext(&[Frame::Event(blob.clone())]).unwrap();
                    self.transmit(heir, *m, pt);
                }
            }
        }
    }

    // ── Time ─────────────────────────────────────────────────────────────────

    fn advance(&mut self) {
        let (d, at) = self
            .devs
            .iter()
            .enumerate()
            .map(|(i, dev)| (i, dev.next))
            .min_by_key(|(i, at)| (*at, *i))
            .expect("devices");
        self.now = self.now.max(at);
        self.run_script();
        let poll = 50 * SECOND + below(&mut self.rng, 20 * SECOND);
        if self.devs[d].hostile {
            self.step(d);
            self.devs[d].next = self.now + poll;
            return;
        }
        if self.devs[d].away_until > self.now && !self.final_phase {
            self.devs[d].next = self.devs[d].away_until;
            return;
        }
        if !self.devs[d].online {
            self.devs[d].online = true;
            self.devs[d].session_end = self.now + 5 * MINUTE + below(&mut self.rng, 30 * MINUTE);
            let peers: Vec<GossipId> = self.devs.iter().map(|x| x.id).collect();
            for p in peers {
                if p != self.devs[d].id {
                    self.op(d, |n, s, now, rng| {
                        n.set_session(p, true);
                        let _ = (s, now, rng);
                        Ok(())
                    })
                    .unwrap();
                }
            }
        }
        self.step(d);
        if self.final_phase || self.now < self.devs[d].session_end {
            self.devs[d].next = self.now + poll;
        } else {
            self.devs[d].online = false;
            let gap = match below(&mut self.rng, 10) {
                0..=5 => 5 * MINUTE + below(&mut self.rng, 30 * MINUTE),
                _ => HOUR + below(&mut self.rng, 3 * HOUR),
            };
            self.devs[d].next = self.now + gap;
        }
        let hour = (self.now - START) / HOUR;
        let (p, b) = self.devs[d].hours.get(&hour).copied().unwrap_or_default();
        self.counters.max_plaintexts_hour = self.counters.max_plaintexts_hour.max(p);
        self.counters.max_bytes_hour = self.counters.max_bytes_hour.max(b);
        assert!(
            p <= LIMITS.plaintexts && b <= LIMITS.bytes,
            "device {d}: {p} plaintexts, {b} bytes in hour {hour}"
        );
    }

    fn run(&mut self, final_hours: u64) {
        while self.now < self.end_active {
            self.advance();
        }
        self.final_phase = true;
        for d in self.honest() {
            self.devs[d].away_until = 0;
            self.devs[d].next = self.devs[d]
                .next
                .min(self.now + below(&mut self.rng, MINUTE));
        }
        let end = self.now + final_hours * HOUR;
        while self.now < end {
            self.advance();
        }
    }

    fn dump(&self) {
        let short = |c: &ChatId| format!("{:02x}{:02x}", c.as_bytes()[0], c.as_bytes()[1]);
        let who = |g: &GossipId| {
            (0..self.devs.len())
                .find(|d| self.devs[*d].id == *g)
                .map_or("?".to_owned(), |d| d.to_string())
        };
        for d in 0..self.devs.len() {
            let n = self.node(d);
            eprintln!(
                "device {d} hostile {} removed {} left {} closed {} restored {}",
                self.devs[d].hostile,
                self.devs[d].removed,
                self.devs[d].left,
                self.devs[d].closed,
                self.devs[d].restored
            );
            for s in n.groups() {
                eprintln!(
                    "  group {} current {} name {} owner {} status {:?} must_resolve {} side {:?} members {:?}",
                    short(&s.group),
                    short(&s.current),
                    s.name,
                    who(&s.owner),
                    s.status,
                    s.must_resolve,
                    s.side_branches.iter().map(short).collect::<Vec<_>>(),
                    s.members.iter().map(who).collect::<Vec<_>>()
                );
            }
            for (c, r) in n.tables().epochs.iter() {
                eprintln!(
                    "    epoch {} group {} name {} owner {} type {:?} at {} parents {:?} status {} legit {}",
                    short(c),
                    short(&r.group),
                    r.root.name(),
                    who(&r.root.owner_id()),
                    r.root.root_type(),
                    (r.root.created_at() - START) / MINUTE,
                    r.parents.iter().map(short).collect::<Vec<_>>(),
                    match r.status {
                        EpochStatus::Installed => "installed",
                        EpochStatus::Invitation(_) => "invitation",
                    },
                    self.legit.contains(c)
                );
            }
            for (k, r) in n.tables().signed.iter() {
                let what = match &r.object {
                    SignedObject::Leave(l) => format!("leave of {}", who(&l.leaver())),
                    SignedObject::Kick(k) => format!("kick of {}", who(&k.removed())),
                    SignedObject::Dissolve(_) => "dissolve".to_owned(),
                };
                eprintln!(
                    "    signed {} {what} at {}",
                    short(&k.0),
                    (r.received_at - START) / MINUTE
                );
            }
            for (g, r) in n.tables().group_recs.iter() {
                eprintln!(
                    "    group record {} followed {:?} deposed {:?} pending {:?}",
                    short(g),
                    r.followed.as_ref().map(who),
                    r.deposed.iter().map(who).collect::<Vec<_>>(),
                    r.pending_removals.keys().map(who).collect::<Vec<_>>()
                );
            }
        }
    }

    // ── Checks ───────────────────────────────────────────────────────────────

    fn check(&mut self) {
        let honest = self.honest();
        let mut split_conversations = 0u64;
        for &d in &honest {
            let node = self.node(d);
            // Nothing forbidden is accepted: no forged root is installed, and every installed
            // root of the group is legitimate.
            let holds_second = self.second.is_some_and(|g2| {
                node.tables()
                    .epochs
                    .get(&g2)
                    .is_some_and(|r| r.status == EpochStatus::Installed)
            });
            for (chat, rec) in node.tables().epochs.iter() {
                if self.takeover_roots.contains(chat) {
                    assert!(
                        !(holds_second
                            && rec.status == EpochStatus::Installed
                            && rec.parents.len() > 1),
                        "device {d} attached the second group to a takeover root"
                    );
                    continue;
                }
                assert!(
                    !(self.forged.contains(chat) && rec.status == EpochStatus::Installed),
                    "device {d} installed a forged root"
                );
                if rec.status == EpochStatus::Installed {
                    assert!(
                        self.legit.contains(chat),
                        "device {d} installed a root no legitimate owner created"
                    );
                }
            }
            // No signed object a hostile member built is stored.
            for (_, r) in node.tables().signed.iter() {
                assert!(
                    !self.forged_objects.contains(&r.object),
                    "device {d} stored a forged signed object: {:?}",
                    r.object.key()
                );
            }
            // A former owner's root after its handover is never current (§5.9).
            if let Some(s) = self.group_of(d) {
                // Unless it never got the handover (§5.9: a lagging device can be misled
                // until it does), as when Dissolve & Delete erased it before it arrived.
                let holds_handover = node.tables().epochs.iter().any(|(_, r)| {
                    r.status == EpochStatus::Installed
                        && r.root.root_type() == crate::root::RootType::Handover
                });
                assert!(
                    !self.former_roots.contains(&s.current) || !holds_handover,
                    "device {d} follows a former owner's root"
                );
            }
            // One logical group is one conversation, except where §5.9 and D.3 make it two:
            // the newer one is owned by an identity whose authority over the older line
            // rests on a handover root this device does not hold (it was no member of it).
            let conversations: Vec<crate::node::GroupSummary> = node
                .groups()
                .into_iter()
                .filter(|s| {
                    s.status == MyStatus::Member
                        && self.legit.contains(&s.current)
                        && Some(s.current) != self.second
                })
                .collect();
            if conversations.len() > 1 {
                let holds_handover_to = |o: &GossipId| {
                    node.tables().epochs.iter().any(|(_, r)| {
                        r.status == EpochStatus::Installed
                            && r.root.root_type() == crate::root::RootType::Handover
                            && r.root.owner_id() == *o
                    })
                };
                let unverifiable = conversations
                    .iter()
                    .any(|c| c.owner != ident(0).id && !holds_handover_to(&c.owner));
                // Dissolve & Delete erases roots on a best-effort basis: a member that
                // lagged cannot fetch the epochs that would join its conversations.
                assert!(
                    unverifiable || self.dissolve_delete,
                    "device {d} shows the group as {} conversations",
                    conversations.len()
                );
                split_conversations += 1;
            }
            // The second group stays the founder's.
            if let Some(g2) = self.second
                && let Some(s2) = node.group(&g2)
            {
                assert_eq!(
                    s2.current, g2,
                    "device {d}: the second group was taken over"
                );
            }
            // Every stored kick verifies with an authority of its epoch.
            for (_, r) in node.tables().signed.iter() {
                if let SignedObject::Kick(k) = &r.object {
                    assert!(
                        self.legit.contains(&k.chat_id()),
                        "device {d} keeps a kick of an epoch that is not legitimate"
                    );
                }
            }
        }
        self.counters.split_conversations += split_conversations;
        // Removal is learnt: a device removed by a kick, or that left and was restored from
        // an older backup, is not a member any more, unless an owner added it again since
        // (an owner restored from its own backup, for instance, lists it again). A member
        // that missed its removal would keep an older current epoch, which the convergence
        // check below finds.
        for &d in &honest {
            let dev = &self.devs[d];
            if !(dev.removed || (dev.left && dev.restored)) || self.dissolved {
                continue;
            }
            let s = self.group_of(d);
            let learnt = match &s {
                None => true,
                Some(s) => s.status != MyStatus::Member,
            };
            if dev.restored && learnt {
                self.counters.relearnt_removals += 1;
            }
        }
        // Convergence of the members of the current epoch.
        let members: Vec<usize> = honest
            .iter()
            .copied()
            .filter(|d| {
                self.group_of(*d)
                    .is_some_and(|s| s.status == MyStatus::Member)
            })
            .collect();
        let mut lines: BTreeMap<GossipId, Vec<usize>> = BTreeMap::new();
        for &d in &members {
            let s = self.group_of(d).unwrap();
            lines.entry(s.owner).or_default().push(d);
        }
        if !self.split {
            assert!(lines.len() <= 1, "owners differ: {lines:?}");
        } else {
            // A double handover: each line is one of the two heirs' (or a later owner).
            assert!(lines.len() <= 2, "more than two lines: {lines:?}");
            for o in lines.keys() {
                assert!(self.owners.contains(o), "a line of an owner of no record");
            }
        }
        let mut diffs = 0u64;
        for devices in lines.values() {
            let reference = self.group_of(devices[0]).unwrap();
            for &d in devices {
                let s = self.group_of(d).unwrap();
                assert_eq!(
                    s.current, reference.current,
                    "device {d} against device {}",
                    devices[0]
                );
                assert_eq!(s.members, reference.members);
                assert_eq!(s.owner, reference.owner);
                assert_eq!(s.name, reference.name);
                let a = results(&self.devs[d].store, &s.current);
                let b = results(&self.devs[devices[0]].store, &s.current);
                assert_eq!(
                    a, b,
                    "messages of the current epoch: device {d} against {}",
                    devices[0]
                );
                // A member is listed in the current epoch it follows: a device that missed
                // its removal would not be.
                assert!(
                    s.members.contains(&self.devs[d].id),
                    "device {d} believes it is a member of an epoch that does not list it"
                );
                // Older epochs held by both: the same messages.
                let mine: BTreeSet<ChatId> = self
                    .node(d)
                    .tables()
                    .epochs
                    .iter()
                    .filter(|(_, r)| r.status == EpochStatus::Installed)
                    .map(|(c, _)| *c)
                    .collect();
                for (c, r) in self.node(devices[0]).tables().epochs.iter() {
                    if r.status == EpochStatus::Installed && mine.contains(c) && *c != s.current {
                        let a = results(&self.devs[d].store, c);
                        let b = results(&self.devs[devices[0]].store, c);
                        if a != b {
                            diffs += 1;
                        }
                    }
                }
            }
            // Every honest member of the current epoch that did not close the group is in it.
            for &d in &honest {
                let dev = &self.devs[d];
                if reference.members.contains(&dev.id)
                    && !dev.closed
                    && !dev.restored
                    && !self.split
                    // A side branch a Dissolve & Delete leaves stays active (§5.8).
                    && !self.dissolved
                {
                    assert!(
                        self.group_of(d)
                            .is_some_and(|s| s.current == reference.current),
                        "device {d} is a member of the current epoch but does not follow it"
                    );
                }
            }
        }
        self.counters.older_epoch_differences += diffs;
        // After a dissolve, every honest device that follows the group shows it dissolved
        // (after a double handover, every device on the dissolved line).
        if self.dissolved {
            let dissolved: BTreeSet<ChatId> = honest
                .iter()
                .filter_map(|d| self.group_of(*d))
                .filter(|s| matches!(s.status, MyStatus::Dissolved { .. }))
                .map(|s| s.current)
                .collect();
            for &d in &honest {
                let dev = &self.devs[d];
                let Some(s) = self.group_of(d) else { continue };
                if dev.closed || dev.removed || dev.restored {
                    continue;
                }
                if self.split && !dissolved.contains(&s.current) {
                    continue;
                }
                // Dissolve & Delete removes the handover roots a remaining side branch of a
                // former owner was judged against: that branch may stay current on its own
                // (reported as a limit, not checked).
                if self.dissolve_delete && self.former_roots.contains(&s.current) {
                    continue;
                }
                assert!(
                    matches!(s.status, MyStatus::Dissolved { .. }),
                    "device {d} did not apply the dissolve: {s:?}"
                );
            }
        }
        for &d in &honest {
            let s = self.node(d).stats().clone();
            let e = self.devs[d].engine;
            self.counters.removal_replies += s.removal_replies + e.0;
            self.counters.failed_announcements += s.failed_announcements + e.1;
            self.counters.auto_successors += s.auto_successors + e.2;
        }
    }
}

fn results(
    store: &MemoryStorage,
    chat: &ChatId,
) -> BTreeMap<crate::ids::SyncObjId, Option<StoredResult>> {
    store
        .objects(chat)
        .unwrap()
        .into_iter()
        .map(|o| (o.sync_obj_id, o.current))
        .collect()
}

fn run(seed: u64, hours: u64, final_hours: u64) -> Counters {
    let mut sim = Sim::new(seed, hours);
    sim.run(final_hours);
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| sim.check()));
    if r.is_err() && std::env::var("GROUPS_MEMBERS_DEBUG").is_ok() {
        sim.dump();
    }
    if let Err(p) = r {
        std::panic::resume_unwind(p);
    }
    sim.counters
}

fn env_u64(name: &str) -> Option<u64> {
    std::env::var(name).ok().and_then(|v| v.parse().ok())
}

#[test]
fn membership_simulation() {
    let hours = env_u64("GROUPS_MEMBERS_HOURS").unwrap_or(13);
    let final_hours = env_u64("GROUPS_MEMBERS_FINAL").unwrap_or(12);
    let single = env_u64("GROUPS_MEMBERS_SEED");
    let seeds: Vec<u64> = match single {
        Some(s) => vec![s],
        None => {
            let first = env_u64("GROUPS_MEMBERS_FIRST").unwrap_or(0);
            let count = env_u64("GROUPS_MEMBERS_SEEDS").unwrap_or(4);
            (first..first + count).collect()
        }
    };
    let mut total = Counters::default();
    for seed in &seeds {
        let seed = *seed;
        match std::panic::catch_unwind(|| run(seed, hours, final_hours)) {
            Ok(c) => total.add(&c),
            Err(p) => {
                eprintln!(
                    "membership simulation failed with seed {seed} ({hours} hours); replay \
                     with GROUPS_MEMBERS_SEED={seed} GROUPS_MEMBERS_HOURS={hours} cargo test \
                     -p groups membership_simulation"
                );
                std::panic::resume_unwind(p);
            }
        }
    }
    eprintln!(
        "membership simulation counters over {} seeds: {total:?}",
        seeds.len()
    );
    if single.is_none() && seeds.len() >= 4 {
        assert!(
            total.missing().is_empty(),
            "situations never exercised: {:?}",
            total.missing()
        );
    }
}
