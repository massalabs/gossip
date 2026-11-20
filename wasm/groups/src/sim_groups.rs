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
//! seeds to a member that is offline for hours, in odd seeds leaving in the handover; the
//! former owner's device is then restored from a backup made just before the handover and
//! must learn from the members that it handed over, and left if it did), and adds back the
//! member that left by a signed leave; members leave by a signed leave or by
//! asking to be kicked; the owner's automatic successor applies them. Some seeds end with a
//! dissolve. A device is restored from an old backup (a rollback) after its removal or its
//! leave, and must learn it again; in some seeds it is reinstalled with nothing instead, and
//! learns of the group and of its removal from members' shared-chats scans (§4.11). In some seeds the owner restores its own backup and
//! creates a second successor of the same epoch (a fork, then resolved); in others a
//! hostile owner signs handover roots that drop or add a member (forgeries to reject), then
//! hands the group over twice, to two members, from the same epoch, and never resolves. A
//! former owner's branch lists the stranger, whom the new owner drops when it resolves the
//! branch: no kick can be signed for it (a known limit, counted). Users post, edit (also in older epochs) and delete messages throughout. Users
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
//!   closed it; a reinstalled device shows it removed or left, never as an invitation; a former owner restored from before its handover is no longer the owner, and
//!   shows the group as left when it left in the handover;
//! - **kicks**: every kick stored is signed by the owner of the epoch it names;
//! - **nothing forbidden is accepted**: no honest device installs a forged root, and every
//!   root an honest device installed in the group was created by a legitimate owner;
//! - **a former owner never takes the group back**: its root after the handover is never
//!   current on a device listed in a handover root, and no group becomes active again two
//!   weeks after "Dissolve & Delete", when the dissolved root is erased too;
//! - **no old epoch offered again**: no honest device is shown an invitation for an epoch
//!   it installed before (unless delivered again in full, with its "closed before" warning,
//!   §14.2), or for an ancestor of an epoch it holds once its parent lookup is over;
//! - **one conversation per group**, except where a device cannot verify a new owner's
//!   authority (§5.9, D.3), and the remnants "Dissolve & Delete" leaves on a device that
//!   received part of the erased line late (counted);
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
//! - `GROUPS_MEMBERS_FINAL=<n>`: hours of the final period (default 48: periodic recovery
//!   scans one peer per lane and day, §12.3, and with members that never answer a device
//!   may need two days of lanes to reach one that holds what it misses);
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
/// The message timer of the group in timed seeds: its first messages are deleted during the
/// final period.
const TIMER: u64 = 30 * HOUR;
/// The timer the owner sets later: messages after the change are deleted during the run.
const CHANGED_TIMER: u64 = 3 * HOUR;
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
    leavers_readded: u64,
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
    /// A removed or left device reinstalled with nothing, and that learnt its removal from
    /// a member's shared-chats scan (§4.11).
    reinstalls: u64,
    reinstalled_relearnt: u64,
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
    /// Older epochs whose messages differ between two devices of one line where the rules
    /// make it so (another conversation on one device, or a device removed and added back
    /// since the epoch; reported). Any other difference fails.
    older_epoch_differences: u64,
    /// Conversations left active by "Dissolve & Delete" on a device that received part of
    /// the erased line after the others erased it (§5.8, best effort; reported).
    dissolve_remnants: u64,
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
    /// Direct chats (§5.12): migrations of an earlier conversation.
    direct_migrations: u64,
    /// Both devices of a pair founded their migration before seeing the other's.
    direct_crossings: u64,
    /// Losing groups closed by the tie rule.
    direct_superseded: u64,
    /// Groups of two adopted under a contact's consent.
    direct_consents: u64,
    /// Invitations to continue a chat of two in a new one, accepted (§5.12).
    direct_continuations: u64,
    /// Devices restored from a backup made before their chat of two (§5.12, cases 7 and 8).
    direct_restores: u64,
    /// Messages written in chats of two.
    direct_messages: u64,
    /// Migration roots replayed by a hostile member to a third party.
    direct_replays: u64,
    /// `migrate_from` forged by a hostile owner on a larger group.
    direct_forged: u64,
    /// Handover roots signed by a hostile owner that drop or add a member: forgeries every
    /// device holding the parent rejects (§4.7).
    forged_member_handovers: u64,
    /// "Hand over and leave".
    handovers_left: u64,
    /// Former owners restored from a backup made before their handover.
    former_owner_rollbacks: u64,
    /// Former owners restored so that learnt the handover again: left, or no longer owner.
    former_owners_relearnt: u64,
    /// Handover roots sent to their former owner by members (§5.6).
    handover_replies: u64,
    /// Members only on a former owner's branch that a new owner's resolution dropped: no kick
    /// can be signed for them, and they are not told (a known limit; reported).
    removed_without_kick: u64,
    /// Groups founded with a message timer (§7.7).
    timed_groups: u64,
    /// Changes of the message timer by the owner.
    timer_changes: u64,
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
            leavers_readded,
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
            reinstalls,
            reinstalled_relearnt,
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
            dissolve_remnants,
            forged_handovers,
            forged_dissolves,
            hostile_queries,
            wrong_answers,
            stranger_frames,
            former_owner_forks,
            takeovers,
            dissolve_deletes,
            long_chains,
            direct_migrations,
            direct_crossings,
            direct_superseded,
            direct_consents,
            direct_continuations,
            direct_restores,
            direct_messages,
            direct_replays,
            direct_forged,
            forged_member_handovers,
            handovers_left,
            former_owner_rollbacks,
            former_owners_relearnt,
            handover_replies,
            removed_without_kick,
            timed_groups,
            timer_changes
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
            ("leavers_readded", self.leavers_readded),
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
            ("reinstalls", self.reinstalls),
            ("reinstalled_relearnt", self.reinstalled_relearnt),
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
            ("direct_migrations", self.direct_migrations),
            ("direct_crossings", self.direct_crossings),
            ("direct_superseded", self.direct_superseded),
            ("direct_consents", self.direct_consents),
            ("direct_continuations", self.direct_continuations),
            ("direct_restores", self.direct_restores),
            ("direct_messages", self.direct_messages),
            ("direct_replays", self.direct_replays),
            ("direct_forged", self.direct_forged),
            ("forged_member_handovers", self.forged_member_handovers),
            ("handovers_left", self.handovers_left),
            ("former_owner_rollbacks", self.former_owner_rollbacks),
            ("former_owners_relearnt", self.former_owners_relearnt),
            ("handover_replies", self.handover_replies),
            ("timed_groups", self.timed_groups),
            ("timer_changes", self.timer_changes),
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
    /// A backup of the store, for a rollback, with the epochs it had installed then.
    backup: Option<(MemoryStorage, BTreeSet<ChatId>)>,
    /// Every epoch the device installed since its store was last restored from a backup
    /// (seen after each of its polls).
    held: BTreeSet<ChatId>,
    /// Its store was restored from a backup once: it lost what it learnt since.
    lost: bool,
    /// Removed (kicked) from the group by an owner, per the script.
    removed: bool,
    /// Left by its own signed leave, per the script.
    left: bool,
    /// Closed the group itself (decline, leave, ask to be kicked).
    closed: bool,
    /// Restored from an old backup after its removal or leave.
    restored: bool,
    /// Reinstalled with nothing after its removal or leave, instead of the rollback: it
    /// learns of the group and of its removal from members' shared-chats scans (§4.11).
    reinstalled: bool,
    /// A former owner restored from a backup made before its handover: whether it left in
    /// that handover.
    former_restored: Option<bool>,
    /// The messages it published, by epoch: for later edits and deletions.
    mine: Vec<(ChatId, crate::ids::SyncObjId)>,
    /// The engine's counters before its last restart: removal replies, failed
    /// announcements, automatic successors, handover replies, members removed without a
    /// kick.
    engine: (u64, u64, u64, u64, u64),
}

/// A step of the owner's script, run at its time by whoever owns the group then.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Step {
    Add,
    Remove,
    Readd,
    Leave,
    ReaddLeaver,
    AskKick,
    Backup,
    Rollback,
    RemoveRestored,
    OwnerFork,
    Rename,
    LongChain,
    Handover,
    DoubleHandover,
    FormerOwnerRollback,
    Dissolve,
    Timer,
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
    /// The device that dissolved the group.
    dissolver: Option<usize>,
    /// The owner forked and must resolve.
    forked: bool,
    /// The first end of the owner's fork, which its restored device does not hold at first.
    fork_end: Option<ChatId>,
    /// A second group of the founder, with the same members (the target of a takeover).
    second: Option<ChatId>,
    /// Signed objects built by hostile devices.
    forged_objects: Vec<SignedObject>,
    /// Roots of a former owner continuing its old epoch after a handover.
    former_roots: BTreeSet<ChatId>,
    /// Dissolve & Delete in this seed.
    dissolve_delete: bool,
    /// Roots of a new owner naming its own line and the former owner's second group: a
    /// successor in its line, whose parent in the second group stays unmatched (D.69).
    takeover_roots: BTreeSet<ChatId>,
    /// The members of the handover roots created.
    handover_members: BTreeSet<GossipId>,
    /// The handover roots created: the new owner and the members.
    handovers: Vec<(GossipId, BTreeSet<GossipId>)>,
    /// The epochs the owner's device erased with "Dissolve & Delete".
    erased_line: BTreeSet<ChatId>,
    /// When the script first removed a device by a kick.
    removed_at: BTreeMap<usize, u64>,
    /// Every root an honest device held, and the roots among them each one names as a
    /// parent: the lines of the group as the script made them.
    roots_seen: BTreeMap<ChatId, Root>,
    parents_seen: BTreeMap<ChatId, BTreeSet<ChatId>>,
    /// Invitations shown for an epoch of a line the device holds or closed (see
    /// [`Sim::check_invitations`]).
    stale_invitations: Vec<String>,
    /// Roots an honest device signed outside its engine, given to it once it has installed
    /// their parent: the device, the parent, the member that gives it, the plaintext.
    own_roots: Vec<(usize, ChatId, usize, Vec<u8>)>,
    /// The seed: "hand over and leave" in odd seeds.
    seed: u64,
    /// A former owner's backup made just before its handover, restored later: the device,
    /// the store and its installed epochs, and whether it left in the handover.
    former_backup: Option<(usize, MemoryStorage, BTreeSet<ChatId>, bool)>,
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
                held: BTreeSet::new(),
                lost: false,
                removed: false,
                left: false,
                closed: false,
                restored: false,
                reinstalled: false,
                former_restored: None,
                mine: Vec::new(),
                engine: (0, 0, 0, 0, 0),
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
        // The member that left by a signed leave is added back, by whoever owns the group
        // then (§5.10, D.70).
        script.push((at(&mut rng, 13), Step::ReaddLeaver));
        if seed % 4 == 3 {
            script.push((at(&mut rng, 14), Step::Dissolve));
        }
        // In some seeds the group has a message timer (§7.7), which the owner changes later:
        // the messages of the first epochs are deleted during the final period, those of the
        // epochs after the change during the run.
        let timed = seed % 4 == 1;
        if timed {
            script.push((at(&mut rng, 7), Step::Timer));
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
            dissolver: None,
            forked: false,
            fork_end: None,
            second: None,
            forged_objects: Vec::new(),
            former_roots: BTreeSet::new(),
            dissolve_delete: seed % 8 == 3,
            takeover_roots: BTreeSet::new(),
            handover_members: BTreeSet::new(),
            handovers: Vec::new(),
            erased_line: BTreeSet::new(),
            removed_at: BTreeMap::new(),
            roots_seen: BTreeMap::new(),
            parents_seen: BTreeMap::new(),
            stale_invitations: Vec::new(),
            own_roots: Vec::new(),
            seed,
            former_backup: None,
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
            .create_group_with(
                &mut dev.store,
                &s,
                "Team".into(),
                members,
                crate::node::GroupOptions {
                    message_timer: if timed { TIMER } else { 0 },
                    ..crate::node::GroupOptions::default()
                },
                START,
                &mut sim.rng,
            )
            .unwrap();
        if timed {
            sim.counters.timed_groups += 1;
        }
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
            dev.engine.3 += s.handover_replies;
            dev.engine.4 += s.removed_without_kick;
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
        let (own, rest): (Vec<_>, Vec<_>) = core::mem::take(&mut self.own_roots)
            .into_iter()
            .partition(|(x, parent, _, _)| *x == d && self.node(d).installed(parent));
        self.own_roots = rest;
        for (_, _, giver, pt) in own {
            let from = self.devs[giver].id;
            self.op(d, |n, s, now, rng| {
                n.handle_plaintext(s, from, &pt, now, rng)
            })
            .expect("receive");
        }
        self.see_roots(d);
        self.check_invitations(d);
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

    /// Records the roots device `d` holds, and the parents each one names among the roots
    /// seen.
    fn see_roots(&mut self, d: usize) {
        let installed: Vec<ChatId> = self
            .node(d)
            .tables()
            .epochs
            .iter()
            .filter(|(_, r)| r.status == EpochStatus::Installed)
            .map(|(c, _)| *c)
            .collect();
        self.devs[d].held.extend(installed);
        let fresh: Vec<Root> = self
            .node(d)
            .tables()
            .epochs
            .iter()
            .filter(|(c, _)| !self.roots_seen.contains_key(c))
            .map(|(_, r)| r.root.clone())
            .collect();
        for r in fresh {
            let id = r.chat_id();
            if self.roots_seen.contains_key(&id) {
                continue;
            }
            let mut parents = BTreeSet::new();
            for (c, other) in &self.roots_seen {
                if r.names_parent(c) {
                    parents.insert(*c);
                }
                if other.names_parent(&id) {
                    self.parents_seen.entry(*c).or_default().insert(id);
                }
            }
            self.parents_seen.entry(id).or_default().extend(parents);
            self.roots_seen.insert(id, r);
        }
    }

    /// Whether `x` is an ancestor of `y` among the roots seen.
    fn ancestor_of(&self, x: &ChatId, y: &ChatId) -> bool {
        let mut seen = BTreeSet::new();
        let mut stack: Vec<ChatId> = vec![*y];
        while let Some(c) = stack.pop() {
            for p in self.parents_seen.get(&c).into_iter().flatten() {
                if p == x {
                    return true;
                }
                if seen.insert(*p) {
                    stack.push(*p);
                }
            }
        }
        false
    }

    /// No invitation shown to device `d` is an old epoch of a line it knows, which accepted
    /// would be a second copy of the group:
    ///
    /// - an epoch it installed before (and closed or erased since);
    /// - an ancestor of an epoch it holds, once its parent lookup is over (its own and that
    ///   of each invitation it continues): before, the device cannot tell it from another
    ///   group (§4.8 "Parent lookup", D.69).
    ///
    /// Not counted: a root delivered again in full after the device closed it, which prompts
    /// again with its warning (§14.2); an invitation to rejoin a group it holds (§4.8 case
    /// 4), which accepted continues that conversation and makes no second copy. Nor, for the
    /// second rule, an ancestor of the root "Dissolve & Delete" keeps for two weeks (whose
    /// line is erased: the remnants of §5.8, counted), or any epoch on a device restored from
    /// a backup: it lost the roots that would tell it the epoch is of its line (a member back
    /// behind its leave is offered epochs of its old line it never held, an owner's older
    /// side branch or the epoch its own leave names; its own leave makes it read-only again).
    fn check_invitations(&mut self, d: usize) {
        let node = self.node(d);
        let invitations = node.invitations(self.now);
        if invitations.is_empty() {
            return;
        }
        let installed: Vec<ChatId> = node
            .tables()
            .epochs
            .iter()
            .filter(|(_, r)| r.status == EpochStatus::Installed)
            .map(|(c, _)| *c)
            .collect();
        let short = |c: &ChatId| format!("{:02x}{:02x}", c.as_bytes()[0], c.as_bytes()[1]);
        let who = |g: &GossipId| {
            (0..self.devs.len())
                .find(|x| self.devs[*x].id == *g)
                .map_or("?".to_owned(), |x| x.to_string())
        };
        let dev = &self.devs[d];
        let mut found = Vec::new();
        for inv in &invitations {
            // Its lookup goes on while it, or a held invitation it continues, waits for a
            // parent.
            let mut looking = false;
            let mut stack = vec![inv.chat_id];
            let mut seen = BTreeSet::new();
            while let Some(c) = stack.pop() {
                if !seen.insert(c) {
                    continue;
                }
                if let Some(r) = node.tables().epochs.get(&c)
                    && let EpochStatus::Invitation(i) = &r.status
                {
                    looking |= !i.lookups.is_empty();
                    stack.extend(
                        node.tables()
                            .epochs
                            .keys()
                            .filter(|p| r.root.names_parent(p))
                            .copied(),
                    );
                }
            }
            if inv.closed_before {
                continue;
            }
            let why = if dev.held.contains(&inv.chat_id) {
                "it installed before".to_owned()
            } else if let Some(k) = installed.iter().find(|k| {
                !looking
                    && inv.rejoins.is_none()
                    && !dev.lost
                    && !self.erased_line.contains(k)
                    && self.ancestor_of(&inv.chat_id, k)
            }) {
                format!("an ancestor of {} it holds", short(k))
            } else {
                continue;
            };
            found.push(format!(
                "device {d} at minute {}: invitation {} (owner {}, from {}, rejoins {:?}, closed \
                 before {}): {why} (removed {} left {} closed {} restored {})",
                (self.now - START) / MINUTE,
                short(&inv.chat_id),
                who(&inv.owner),
                inv.received_from.as_ref().map_or("owner".to_owned(), who),
                inv.rejoins.as_ref().map(short),
                inv.closed_before,
                dev.removed,
                dev.left,
                dev.closed,
                dev.restored,
            ));
        }
        if !found.is_empty() && std::env::var("GROUPS_MEMBERS_TRACE").is_ok() {
            let who = |g: &GossipId| {
                (0..self.devs.len())
                    .find(|x| self.devs[*x].id == *g)
                    .map_or("?".to_owned(), |x| x.to_string())
            };
            for (c, r) in &self.roots_seen {
                eprintln!(
                    "  root {} owner {} {:?} at {} name {} members {:?} parents {:?}",
                    short(c),
                    who(&r.owner_id()),
                    r.root_type(),
                    (r.created_at().min(START + 100 * HOUR) - START) / MINUTE,
                    r.name(),
                    r.members().iter().map(who).collect::<Vec<_>>(),
                    self.parents_seen
                        .get(c)
                        .into_iter()
                        .flatten()
                        .map(short)
                        .collect::<Vec<_>>()
                );
            }
            for (c, r) in node.tables().epochs.iter() {
                eprintln!(
                    "  held {} group {} status {:?} from {} received {} parents {:?}",
                    short(c),
                    short(&r.group),
                    r.status,
                    who(&r.from),
                    (r.received_at - START) / MINUTE,
                    r.parents.iter().map(short).collect::<Vec<_>>()
                );
            }
            for (c, m) in node.tables().markers.iter() {
                eprintln!("  marker {} {:?}", short(c), m);
            }
            for g in node.groups() {
                eprintln!(
                    "  group {} current {} status {:?}",
                    short(&g.group),
                    short(&g.current),
                    g.status
                );
            }
        }
        self.stale_invitations.extend(found);
    }

    /// The user answers its invitations: those of the group's legitimate owners are
    /// accepted, unless the user had left; the others are declined silently.
    fn answer_invitations(&mut self, d: usize) {
        let now = self.now;
        let invitations = self.node(d).invitations(now);
        for inv in invitations {
            // A root the user signed itself outside its engine is no invitation to it: its
            // device holds it once it holds its parent (see `own_roots`).
            if inv.owner == self.devs[d].id && self.takeover_roots.contains(&inv.chat_id) {
                continue;
            }
            // A former owner's root after its handover is no invitation a user takes.
            // Nor is a way back into a group the user dissolved itself, nor an epoch it closed
            // before (the prompt says so, §14.2): no user here closed one by mistake.
            let legit = self.legit.contains(&inv.chat_id)
                && !self.former_roots.contains(&inv.chat_id)
                && !self.devs[d].closed
                && !(self.dissolver == Some(d) && inv.rejoins.is_some())
                && !inv.closed_before;
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
        // But the stranger a former owner's branch lists, whom the user does not know: it is
        // dropped without a kick, none can be signed for that branch (§5.6, a known limit).
        // Nor is a former owner that left taken back.
        let former: BTreeSet<GossipId> = s
            .former_owner_branches
            .iter()
            .filter_map(|e| node.root(e).map(|r| r.owner_id()))
            .collect();
        for x in &self.devs {
            if (x.stranger || former.contains(&x.id)) && !s.members.contains(&x.id) {
                members.remove(&x.id);
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
                s.owner == self.devs[*d].id
                    && s.status == MyStatus::Member
                    && !self.devs[*d].closed
                    && self.devs[*d].former_restored.is_none()
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
                    if let Some(r) = self.node(d).root(&id) {
                        self.handover_members.extend(r.members().iter().copied());
                        self.handovers
                            .push((new_owner, r.members().iter().copied().collect()));
                    }
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
            if step == Step::FormerOwnerRollback {
                // The former owner's device is restored from its backup made just before the
                // handover: it holds itself the owner of the parent epoch again, and must learn
                // from the members that it handed over, and left if it did (§5.6).
                if let Some((a, store, held, left)) = self.former_backup.take() {
                    // What it has not sent yet goes first (a crash may stop a send).
                    for _ in 0..3 {
                        self.send(a);
                    }
                    self.devs[a].store = store;
                    self.devs[a].held = held;
                    self.devs[a].lost = true;
                    self.devs[a].closed = false;
                    self.devs[a].former_restored = Some(left);
                    self.boot(a);
                    self.counters.former_owner_rollbacks += 1;
                }
                continue;
            }
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
                        self.removed_at.entry(v).or_insert(self.now);
                        self.counters.members_removed += 1;
                    }
                }
                Step::ReaddLeaver => {
                    let l = self.leaver;
                    // Once the owner's line has dropped it (its leave applied, §5.5).
                    let listed = self.group_of(o).is_some_and(|s| s.members.contains(&id(l)));
                    if !self.devs[l].left || listed {
                        if self.devs[l].left && self.now < self.end_active {
                            self.script.push((self.now + 10 * MINUTE, step));
                            self.script.sort_by_key(|(t, _)| *t);
                        }
                        continue;
                    }
                    if self
                        .change(
                            o,
                            GroupChange::Successor {
                                add: vec![id(l)],
                                remove: vec![],
                                name: None,
                            },
                        )
                        .is_some()
                    {
                        self.devs[l].left = false;
                        self.devs[l].closed = false;
                        self.counters.leavers_readded += 1;
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
                    self.devs[r].backup =
                        Some((self.devs[r].store.clone(), self.devs[r].held.clone()));
                    // The owner too, for a fork.
                    self.devs[o].backup =
                        Some((self.devs[o].store.clone(), self.devs[o].held.clone()));
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
                        self.removed_at.entry(r).or_insert(self.now);
                        self.counters.members_removed += 1;
                    }
                }
                // In seeds 1 and 2 modulo 4, the device is reinstalled instead (a kick in the
                // first, a signed leave in the second); not with a double handover, whose two
                // lines a member split between them may show as two conversations (a known
                // limit of that scenario, also reached without a reinstall in other seeds).
                Step::Rollback
                    if matches!(self.seed % 4, 1 | 2)
                        && self.seed % 3 != 2
                        && (self.devs[self.restored].removed || self.devs[self.restored].left) =>
                {
                    let r = self.restored;
                    self.devs[r].backup = None;
                    self.devs[r].store = MemoryStorage::new();
                    self.devs[r].held = BTreeSet::new();
                    self.boot(r);
                    // As at the start: its own keys, and the others' unless it knows nobody.
                    let n = self.devs.len();
                    let contacts = r != self.late && r != 5;
                    for k in 0..n {
                        if contacts || k == r {
                            let bytes = ident(k).public.to_bytes();
                            let now = self.now;
                            self.op(r, |node, st, _, rng| node.learn_keys(st, &bytes, now, rng))
                                .expect("keys");
                        }
                    }
                    self.devs[r].restored = true;
                    self.devs[r].reinstalled = true;
                    self.devs[r].lost = true;
                    self.devs[r].closed = false;
                    self.counters.reinstalls += 1;
                    self.scan_from_members(r);
                }
                Step::Rollback => {
                    let r = self.restored;
                    if let Some((b, held)) = self.devs[r].backup.take()
                        && (self.devs[r].removed || self.devs[r].left)
                    {
                        self.devs[r].store = b;
                        self.devs[r].held = held;
                        self.boot(r);
                        self.devs[r].restored = true;
                        self.devs[r].lost = true;
                        self.devs[r].closed = false;
                        self.counters.rollbacks += 1;
                    }
                }
                Step::OwnerFork => {
                    // The owner creates a successor, then restores its backup and creates
                    // another one of an earlier epoch: two competing ends.
                    let a = self.change(
                        o,
                        GroupChange::Successor {
                            add: vec![],
                            remove: vec![],
                            name: Some("A".into()),
                        },
                    );
                    if a.is_some() {
                        self.fork_end = a;
                        self.send(o);
                        if let Some((b, held)) = self.devs[o].backup.take() {
                            self.devs[o].store = b;
                            self.devs[o].held = held;
                            self.devs[o].lost = true;
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
                Step::Timer => {
                    if self
                        .change(
                            o,
                            GroupChange::MessageTimer {
                                timer: CHANGED_TIMER,
                            },
                        )
                        .is_some()
                    {
                        self.counters.timer_changes += 1;
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
                            && self.devs[*d].former_restored.is_none()
                    });
                    let Some(heir) = heir else { continue };
                    // "Hand over and leave" in odd seeds; the former owner is restored later
                    // from a backup made now (once per seed). Not after the owner's own fork:
                    // its device, already restored once, holds neither end's whole line, and
                    // gets the other end back as a separate conversation (the unit tests
                    // cover a former owner restored on its other fork end).
                    let leave = self.seed % 2 == 1;
                    let backup =
                        (self.former_backup.is_none() && !self.dissolve_delete && !self.forked)
                            .then(|| (self.devs[o].store.clone(), self.devs[o].held.clone()));
                    // The owner's device restored from its backup does not hold the other end
                    // of its fork yet: the handover leaves that end to the former owner's line,
                    // which the members listed in no handover root keep following (§5.9).
                    let unresolved = self
                        .fork_end
                        .is_some_and(|a| !self.node(o).tables().epochs.contains(&a));
                    if let Some(h) = self.change(
                        o,
                        GroupChange::Handover {
                            new_owner: id(heir),
                            leave,
                            name: None,
                        },
                    ) {
                        if unresolved {
                            self.split = true;
                        }
                        self.counters.handovers += 1;
                        if leave {
                            self.devs[o].closed = true;
                            self.counters.handovers_left += 1;
                        }
                        // Sent before the device can be restored from its backup.
                        self.send(o);
                        if let Some((store, held)) = backup {
                            self.former_backup = Some((o, store, held, leave));
                            let at = self.now + 30 * MINUTE + below(&mut self.rng, 30 * MINUTE);
                            self.script.push((at, Step::FormerOwnerRollback));
                            self.script.sort_by_key(|(t, _)| *t);
                        }
                        // The handover's parent is the epoch that was current.
                        self.after_handover(o, heir, s.current, h, s.members.clone(), leave);
                        if chance(&mut self.rng, 50) || self.counters.handovers_to_offline == 0 {
                            self.devs[heir].online = false;
                            self.devs[heir].away_until = self.now + 2 * HOUR;
                            self.devs[heir].next = self.devs[heir].away_until;
                            self.counters.handovers_to_offline += 1;
                        }
                    }
                }
                Step::FormerOwnerRollback => {}
                Step::DoubleHandover => {
                    // A hostile owner: two handovers of one epoch, to two members.
                    let Some(s) = self.group_of(o) else { continue };
                    // First, validly signed handovers of its epoch that drop a member, or add
                    // one: forgeries, rejected by every device that holds the epoch (§4.7).
                    self.forge_member_handovers(o, s.current);
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
                                name: None,
                            },
                        )
                        .is_some()
                    {
                        self.send(o);
                        self.devs[o].store = backup;
                        self.devs[o].lost = true;
                        self.boot(o);
                        if self
                            .change(
                                o,
                                GroupChange::Handover {
                                    new_owner: id(heirs[1]),
                                    leave: false,
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
                    if delete {
                        // The line the owner's device erases: the dissolved epoch and every
                        // epoch it holds that leads to it (§5.8).
                        let mut stack = vec![s.current];
                        while let Some(c) = stack.pop() {
                            if self.erased_line.insert(c)
                                && let Some(r) = self.node(o).tables().epochs.get(&c)
                            {
                                stack.extend(r.parents.iter().copied());
                            }
                        }
                    }
                    let sg = signer(o);
                    if self
                        .op(o, |n, st, now, rng| {
                            n.dissolve_group(st, &sg, s.group, delete, now, rng)
                        })
                        .is_ok()
                    {
                        self.dissolved = true;
                        self.dissolver = Some(o);
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
                    message_timer: 0,
                    settings: std::collections::BTreeMap::new(),
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
                let id = crate::hash::kick_id(&root.chat_id(), &victim);
                let sig = crate::keys::Signer::sign_id(
                    &me.secret.dsa_signing_key,
                    crate::constants::CONTEXT_KICK_SIGNATURE,
                    id.as_bytes(),
                    bytes(&mut self.rng),
                );
                let Ok(k) = Kick::from_fields(root.chat_id(), victim, sig.as_bytes()) else {
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
                message_timer: 0,
                settings: std::collections::BTreeMap::new(),
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
            Frame::Notice(Notice { entries })
        };
        self.counters.stranger_frames += 1;
        let pt = wire::encode_plaintext(&[frame]).expect("fits");
        self.transmit(d, to, pt);
    }

    /// The owner `o`, hostile, signs handover roots of its epoch `epoch` to another member,
    /// one that drops a member other than itself and one that adds the stranger, and sends
    /// them to the members: valid signatures, invalid roots (§4.7).
    fn forge_member_handovers(&mut self, o: usize, epoch: ChatId) {
        let Some(parent) = self.node(o).root(&epoch) else {
            return;
        };
        let others: Vec<GossipId> = parent
            .members()
            .iter()
            .filter(|m| **m != self.devs[o].id)
            .copied()
            .collect();
        let Some(stranger) = self.devs.iter().find(|x| x.stranger).map(|x| x.id) else {
            return;
        };
        if others.len() < 2 {
            return;
        }
        let new_owner = others[0];
        let Some(owner_keys) = self.node(o).keys(&new_owner) else {
            return;
        };
        let dropped: Vec<GossipId> = parent
            .members()
            .iter()
            .filter(|m| **m != others[1])
            .copied()
            .collect();
        let mut added: Vec<GossipId> = parent.members().to_vec();
        added.push(stranger);
        added.sort();
        for members in [dropped, added] {
            let challenge = Challenge::from_bytes(bytes(&mut self.rng));
            let unsigned = crate::wire::proto::GroupRoot {
                r#type: crate::wire::proto::RootType::Handover as i32,
                name: parent.name().to_owned(),
                parents: vec![
                    crate::hash::parent_commitment(&challenge, &epoch)
                        .as_bytes()
                        .to_vec(),
                ],
                members: members.iter().map(|m| m.as_bytes().to_vec()).collect(),
                group_secret: bytes::<32>(&mut self.rng).to_vec(),
                owner: owner_keys.clone(),
                epoch_challenge: challenge.as_bytes().to_vec(),
                ref_chat_id_challenge: bytes::<32>(&mut self.rng).to_vec(),
                created_at: self.now,
                signature: vec![0; crypto_dsa::SIGNATURE_SIZE],
                migrate_from: None,
                message_timer: parent.message_timer(),
                settings: Vec::new(),
            };
            let r = Root::forge_unchecked(unsigned, &ident(o).secret.dsa_signing_key);
            self.forged.insert(r.chat_id());
            self.counters.forged_member_handovers += 1;
            let blob = wire::encode_event_blob(&EventObject::Root(Box::new(r))).unwrap();
            for m in parent.members() {
                if *m != self.devs[o].id {
                    let pt = wire::encode_plaintext(&[Frame::Event(blob.clone())]).unwrap();
                    self.transmit(o, *m, pt);
                }
            }
        }
    }

    /// The former owner `o`, after handing the group over in `h`, signs a successor of its
    /// old epoch `old`, of `members`, dated at the end of time, which must never become
    /// current; it lists the stranger too, a member only on that branch, which the new owner
    /// drops when it resolves the branch, without a kick (a known limit, counted). The heir
    /// builds a root naming both its line and the former owner's second group, which may
    /// continue the heir's line only.
    fn after_handover(
        &mut self,
        o: usize,
        heir: usize,
        old: ChatId,
        h: ChatId,
        members: Vec<GossipId>,
        left: bool,
    ) {
        if members.is_empty() {
            return;
        }
        let stranger = self.devs.iter().find(|x| x.stranger).map(|x| x.id);
        let mut back_members = members.clone();
        back_members.extend(stranger);
        back_members.sort();
        back_members.dedup();
        let params =
            |owner: &auth::UserPublicKeys, rng: &mut TestRng, at: u64, name: &str| RootParams {
                name: name.into(),
                members: members.clone(),
                group_secret: GroupSecret::from_bytes(bytes(rng)),
                owner: owner.clone(),
                epoch_challenge: Challenge::from_bytes(bytes(rng)),
                ref_chat_id_challenge: Challenge::from_bytes(bytes(rng)),
                created_at: at,
                message_timer: 0,
                settings: std::collections::BTreeMap::new(),
            };
        let a = ident(o);
        let mut p = params(&a.public, &mut self.rng, u64::MAX, "back");
        p.members = back_members;
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
        let (Some(second), cur) = (self.second, h) else {
            return;
        };
        let b = ident(heir);
        let mut p = params(&b.public, &mut self.rng, self.now, "taken");
        // The members of the handover: without the former owner when it left.
        let h_members: Vec<GossipId> = members
            .iter()
            .filter(|m| !left || **m != a.id)
            .copied()
            .collect();
        p.members = h_members.clone();
        if let Ok(r) = Root::create_successor(
            p,
            &[cur, second],
            &b.secret.dsa_signing_key,
            bytes(&mut self.rng),
        ) {
            // A successor of the new owner in its own line, with one parent in another group:
            // legitimate there, never a continuation of the second group.
            self.legit.insert(r.chat_id());
            self.takeover_roots.insert(r.chat_id());
            self.counters.takeovers += 1;
            let blob = wire::encode_event_blob(&EventObject::Root(Box::new(r))).unwrap();
            for m in &h_members {
                if *m != b.id {
                    let pt = wire::encode_plaintext(&[Frame::Event(blob.clone())]).unwrap();
                    self.transmit(heir, *m, pt);
                }
            }
            // The heir's device holds the root it signed, as it holds one the engine builds,
            // once it holds the handover it continues. Otherwise the root could reach the
            // heir only after the heir dissolved that epoch, which no other device would then
            // follow. It is given by a member of it.
            let giver = (0..self.devs.len()).find(|x| {
                *x != heir && !self.devs[*x].hostile && h_members.contains(&self.devs[*x].id)
            });
            if let Some(giver) = giver {
                let pt = wire::encode_plaintext(&[Frame::Event(blob)]).unwrap();
                self.own_roots.push((heir, cur, giver, pt));
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

    /// A reinstalled device scans every honest member of the group for the chats they share
    /// (§4.11), as the app does after a reinstall.
    fn scan_from_members(&mut self, r: usize) {
        let members: Vec<usize> = self
            .honest()
            .into_iter()
            .filter(|m| *m != r)
            .filter(|m| {
                self.group_of(*m)
                    .is_some_and(|s| s.status == MyStatus::Member)
            })
            .collect();
        for m in members {
            let peer = ident(m).id;
            self.op(r, |n, st, now, rng| n.scan_shared_chats(st, peer, now, rng))
                .expect("scan");
        }
        self.devs[r].online = true;
        self.send(r);
    }

    fn run(&mut self, final_hours: u64) {
        while self.now < self.end_active {
            self.advance();
        }
        // Scans sent while the members were away are sent again once they are all online.
        for r in self.honest() {
            if self.devs[r].reinstalled {
                self.scan_from_members(r);
            }
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
            for (k, t) in n.tables().tasks.iter() {
                eprintln!(
                    "    task {:?} {:?} runs {} cands {}",
                    short(&k.chat_id),
                    k.target,
                    t.runs,
                    t.candidates.len()
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

    /// Whether conversation `c` of device `d` is a remnant of "Dissolve & Delete": it holds
    /// an epoch of the erased line, or a root continuing one the device does not hold (see
    /// [`Sim::check`]).
    fn remnant(&self, d: usize, c: &crate::node::GroupSummary) -> bool {
        let node = self.node(d);
        node.tables()
            .epochs
            .iter()
            .filter(|(_, r)| r.group == c.group && r.status == EpochStatus::Installed)
            .any(|(e, r)| {
                self.erased_line.contains(e)
                    || self
                        .erased_line
                        .iter()
                        .any(|x| r.root.names_parent(x) && node.root(x).is_none())
            })
    }

    fn check(&mut self) {
        assert!(
            self.stale_invitations.is_empty(),
            "an old epoch offered as an invitation: {:#?}",
            self.stale_invitations
        );
        let honest = self.honest();
        let mut split_conversations = 0u64;
        let mut dissolve_remnants = 0u64;
        for &d in &honest {
            let node = self.node(d);
            // Nothing forbidden is accepted: no forged root is installed, and every installed
            // root of the group is legitimate.
            for (chat, rec) in node.tables().epochs.iter() {
                // A takeover root continues its owner's own line, never the second group
                // (D.69): that parent stays unmatched.
                assert!(
                    !(self.takeover_roots.contains(chat)
                        && self.second.is_some_and(|g2| rec.parents.contains(&g2))),
                    "device {d} attached the second group to a takeover root"
                );
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
            // A former owner's root after its handover is never current (§5.9), unless the
            // device is listed in no handover root: it cannot hold one and follows the line it
            // knows (§5.9, "a device that cannot check this"), as a member that left before
            // the handover and was restored from a backup does.
            if let Some(s) = self.group_of(d) {
                let listed = self.handover_members.contains(&self.devs[d].id);
                assert!(
                    !(self.former_roots.contains(&s.current) && listed),
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
            // "Dissolve & Delete" is best effort (§5.8): a device that received part of the
            // erased line only after every other device erased it keeps that part, active,
            // as a conversation of its own: an epoch of the erased line, or a root continuing
            // one the device never held (the link to the rest is gone with it). Counted.
            let remnant = |c: &crate::node::GroupSummary| self.remnant(d, c);
            let remnants = conversations.iter().filter(|c| remnant(c)).count();
            dissolve_remnants += remnants as u64;
            let conversations: Vec<&crate::node::GroupSummary> =
                conversations.iter().filter(|c| !remnant(c)).collect();
            if conversations.len() > 1 {
                // From the script: the device is listed in no handover root to that owner.
                let me = self.devs[d].id;
                let unverifiable = conversations.iter().any(|c| {
                    c.owner != ident(0).id
                        && !self
                            .handovers
                            .iter()
                            .any(|(o, m)| *o == c.owner && m.contains(&me))
                });
                assert!(
                    unverifiable,
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
            // Every stored kick is of a legitimate epoch and signed by its owner (§5.6): no
            // device created one it could not sign.
            for (_, r) in node.tables().signed.iter() {
                if let SignedObject::Kick(k) = &r.object {
                    assert!(
                        self.legit.contains(&k.chat_id()),
                        "device {d} keeps a kick of an epoch that is not legitimate"
                    );
                    let root = node.root(&k.chat_id()).expect("kept with its root");
                    assert!(
                        k.verify(&root).is_ok(),
                        "device {d} keeps a kick not signed by its epoch's owner"
                    );
                }
            }
        }
        self.counters.split_conversations += split_conversations;
        self.counters.dissolve_remnants += dissolve_remnants;
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
            // A reinstalled device holds the group again, read-only: it learnt of it and of
            // its removal from a member's scan, and was never asked to accept it. An owner
            // may have listed it again since (a fork from the owner's backup): then it is a
            // member of the epoch it follows.
            if dev.reinstalled {
                let added_again = s.as_ref().is_some_and(|s| s.members.contains(&dev.id));
                assert!(
                    added_again
                        || s.as_ref().is_some_and(|s| {
                            matches!(s.status, MyStatus::Removed | MyStatus::Left)
                        }),
                    "device {d}, reinstalled after its removal, shows {s:?}"
                );
                self.counters.reinstalled_relearnt += 1;
            }
        }
        // A former owner restored from a backup made before its handover learnt it from the
        // members (§5.6): it is not the owner any more, and shows the group as left when it
        // left in the handover.
        for &d in &honest {
            let Some(left) = self.devs[d].former_restored else {
                continue;
            };
            if self.dissolved {
                continue;
            }
            let me = self.devs[d].id;
            let s = self.group_of(d);
            if left {
                assert!(
                    s.as_ref().is_none_or(|s| s.status != MyStatus::Member),
                    "device {d}, a former owner that left, is a member again: {s:?}"
                );
            } else {
                assert!(
                    s.as_ref().is_some_and(|s| s.owner != me),
                    "device {d}, a former owner, still holds itself the owner: {s:?}"
                );
            }
            self.counters.former_owners_relearnt += 1;
        }
        // Convergence of the members of the current epoch.
        // A remnant of "Dissolve & Delete" (counted above) is no line to converge on.
        let members: Vec<usize> = honest
            .iter()
            .copied()
            .filter(|d| {
                self.group_of(*d)
                    .is_some_and(|s| s.status == MyStatus::Member && !self.remnant(*d, &s))
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
                let timed = |c: &ChatId| {
                    self.node(devices[0])
                        .root(c)
                        .is_some_and(|r| r.message_timer() > 0)
                };
                let (a, b) = compared_results(
                    &self.devs[d].store,
                    &self.devs[devices[0]].store,
                    &s.current,
                    timed(&s.current),
                );
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
                        let (a, b) = compared_results(
                            &self.devs[d].store,
                            &self.devs[devices[0]].store,
                            c,
                            timed(c),
                        );
                        if a != b {
                            // Differences the rules make, from the script:
                            // - the epoch is in another conversation than the current one on
                            //   one of the two devices (an allowed split, §5.9, or the archive
                            //   of a removed or left device): a scan lists the epochs of the
                            //   anchor's group in the responder's own grouping (§12.1), and
                            //   edits in it reach only the members of the current epoch;
                            // - one of the two devices was removed after the epoch was created
                            //   and added back since: while removed it dropped every event but
                            //   deletions (§10.4) and does not fetch them again (§11.7).
                            let other_conversation = |x: usize| {
                                self.node(x).current_epoch(c)
                                    != self.node(x).current_epoch(&s.current)
                            };
                            let removed_since = |x: usize| {
                                self.removed_at
                                    .get(&x)
                                    .is_some_and(|t| r.root.created_at() <= *t)
                            };
                            assert!(
                                other_conversation(d)
                                    || other_conversation(devices[0])
                                    || removed_since(d)
                                    || removed_since(devices[0]),
                                "messages of an older epoch: device {d} against {}",
                                devices[0]
                            );
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
                // A former owner that left in its handover: it is no member of the dissolved
                // line.
                if dev.closed
                    || dev.removed
                    || dev.restored
                    || dev.former_restored == Some(true)
                    || self.remnant(d, &s)
                {
                    continue;
                }
                if self.split && !dissolved.contains(&s.current) {
                    continue;
                }
                assert!(
                    matches!(s.status, MyStatus::Dissolved { .. }),
                    "device {d} did not apply the dissolve: {s:?}"
                );
            }
            // Two weeks later "Dissolve & Delete" has erased the dissolved root, and no group
            // comes back to life, under a former owner's branch for instance (§5.8, §5.9).
            if self.dissolve_delete {
                let active = |sim: &Self, d: usize| -> BTreeSet<ChatId> {
                    sim.node(d)
                        .groups()
                        .into_iter()
                        .filter(|c| c.status == MyStatus::Member)
                        .map(|c| c.group)
                        .collect()
                };
                let before: Vec<BTreeSet<ChatId>> =
                    honest.iter().map(|d| active(self, *d)).collect();
                self.now += 15 * 24 * HOUR;
                for (i, &d) in honest.iter().enumerate() {
                    let sg = signer(d);
                    self.op(d, |n, st, now, rng| n.tick_with(st, Some(&sg), now, rng))
                        .expect("tick");
                    let after = active(self, d);
                    assert!(
                        after.is_subset(&before[i]),
                        "device {d}: a group became active again after Dissolve & Delete"
                    );
                }
            }
        }
        for &d in &honest {
            let s = self.node(d).stats().clone();
            let e = self.devs[d].engine;
            self.counters.removal_replies += s.removal_replies + e.0;
            self.counters.failed_announcements += s.failed_announcements + e.1;
            self.counters.auto_successors += s.auto_successors + e.2;
            self.counters.handover_replies += s.handover_replies + e.3;
            self.counters.removed_without_kick += s.removed_without_kick + e.4;
        }
    }
}

/// The results of the epoch `chat` on two devices, as compared: without the objects that are
/// quiet on either (§7.7, §14.1), a deletion for a message that device never processed. Such
/// a device keeps it to itself, so which devices hold it, and until when, depends on arrival
/// order.
fn compared_results(
    a: &MemoryStorage,
    b: &MemoryStorage,
    chat: &ChatId,
    timed: bool,
) -> (
    BTreeMap<crate::ids::SyncObjId, Option<StoredResult>>,
    BTreeMap<crate::ids::SyncObjId, Option<StoredResult>>,
) {
    let quiet: BTreeSet<crate::ids::SyncObjId> = [a, b]
        .iter()
        .flat_map(|s| s.objects(chat).unwrap())
        .filter(|o| !o.shareable)
        .map(|o| o.sync_obj_id)
        .collect();
    let keep = |m: BTreeMap<_, _>| {
        m.into_iter()
            .filter(|(k, _)| !quiet.contains(k))
            .collect::<BTreeMap<_, _>>()
    };
    (keep(results(a, chat, timed)), keep(results(b, chat, timed)))
}

/// The results of the epoch `chat`. Under a message timer (§7.7) a tombstone or an empty
/// result with no event is left out: the timer erases what it deletes, so such a record is
/// what a deletion arriving after the erasure leaves, which depends on arrival order, and a
/// device that received the message only after its moment holds nothing for it, by design.
fn results(
    store: &MemoryStorage,
    chat: &ChatId,
    timed: bool,
) -> BTreeMap<crate::ids::SyncObjId, Option<StoredResult>> {
    store
        .objects(chat)
        .unwrap()
        .into_iter()
        .filter(|o| {
            !(timed
                && !matches!(o.current, Some(StoredResult::Content(_)))
                && o.current_events.is_empty()
                && o.pending_versions.is_empty()
                && o.pending_deletions.is_empty())
        })
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
    let mut counters = sim.counters;
    counters.add(&direct::run(seed));
    counters
}

fn env_u64(name: &str) -> Option<u64> {
    std::env::var(name).ok().and_then(|v| v.parse().ok())
}

#[test]
fn membership_simulation() {
    let hours = env_u64("GROUPS_MEMBERS_HOURS").unwrap_or(13);
    let final_hours = env_u64("GROUPS_MEMBERS_FINAL").unwrap_or(48);
    let single = env_u64("GROUPS_MEMBERS_SEED");
    let seeds: Vec<u64> = match single {
        Some(s) => vec![s],
        None => {
            let first = env_u64("GROUPS_MEMBERS_FIRST").unwrap_or(0);
            let count = env_u64("GROUPS_MEMBERS_SEEDS").unwrap_or(4);
            (first..first + count).collect()
        }
    };
    // The seeds run on as many threads as the machine offers; the results are taken in
    // seed order, so the first failing seed is the one reported.
    let workers = std::thread::available_parallelism()
        .map_or(1, std::num::NonZeroUsize::get)
        .min(seeds.len());
    let next = std::sync::atomic::AtomicUsize::new(0);
    let results: std::sync::Mutex<BTreeMap<u64, std::thread::Result<Counters>>> =
        std::sync::Mutex::new(BTreeMap::new());
    std::thread::scope(|scope| {
        for _ in 0..workers {
            scope.spawn(|| {
                loop {
                    let i = next.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                    let Some(&seed) = seeds.get(i) else { return };
                    let r = std::panic::catch_unwind(|| run(seed, hours, final_hours));
                    results.lock().unwrap().insert(seed, r);
                }
            });
        }
    });
    let mut total = Counters::default();
    for (seed, r) in results.into_inner().unwrap() {
        match r {
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

/// Direct chats (§5.12), run with every seed after the group above: honest devices that
/// migrate their earlier conversations, sometimes both at once, contacts that consent to the
/// chat the requester founds (sometimes both ways), ordinary groups of two left as
/// invitations, a pair of which one device restores a backup made before their chat and
/// founds a new one (cases 7 and 8 of §5.12), and a hostile member that replays a migration
/// root to a third party and forges `migrate_from` on a larger group. Plaintexts are delayed,
/// reordered and duplicated; devices go offline.
///
/// Checks: both devices of every migrating pair end with the same single migration group;
/// no device adopts a group it neither created, nor accepted, nor consented to, nor won by
/// the tie rule; no device holds a root it is not a member of; a forged or replayed root is
/// never acted on; a device whose own chat the tie rule keeps is never asked to continue the
/// conversation in the other's.
mod direct {
    use std::collections::{BTreeMap, BTreeSet};

    use super::{Counters, HOUR, MINUTE, START, below, chance};
    use crate::ids::{ChatId, GossipId};
    use crate::node::records::{ChangeKind, EpochStatus};
    use crate::node::tests::membership::{ident, signer};
    use crate::node::{GroupOptions, MyStatus, Node};
    use crate::rng::TestRng;
    use crate::root::Root;
    use crate::store::MemoryStorage;
    use crate::wire::{self, EventObject, Frame};

    const HONEST: usize = 5;
    const HOSTILE: usize = 5;
    /// The pair of the restore scenario, apart from the others.
    const RESTORED: [usize; 2] = [6, 7];
    const N: usize = 8;

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    enum Kind {
        /// The first migrates; the second, if it has not seen the invitation yet, too.
        Migration { both: bool },
        /// The second consents; the first founds (and with `both`, the reverse too).
        Contact { both: bool },
        /// An ordinary group of two, left as an invitation.
        Plain,
        /// The second consents and the first founds; both write in it; an hour later the
        /// second, which sorts first, founds a new chat to continue the conversation (one
        /// that sorts last would get the chat it holds back from its creation).
        Continue,
        /// The first consented to the second's chat, both wrote in it; an hour later the
        /// first restores a backup made before and founds a new chat: case 7 when it sorts
        /// last (the other keeps its chat, not asked), case 8 when it sorts first (the other
        /// is asked).
        Restore,
    }

    struct Dev {
        store: MemoryStorage,
        node: Node,
        online: bool,
        inbox: Vec<(u64, u64, usize, Vec<u8>)>,
        created: BTreeSet<ChatId>,
        accepted: BTreeSet<ChatId>,
        consented: BTreeSet<usize>,
        /// Peers it founded a migration with.
        migrated: BTreeSet<usize>,
        /// The chats of two it holds in which the other person took part or it wrote itself,
        /// since its last restore: never erased.
        kept: BTreeSet<ChatId>,
        /// The store as it was before any chat.
        backup: MemoryStorage,
    }

    struct Sim {
        rng: TestRng,
        now: u64,
        seq: u64,
        devs: Vec<Dev>,
        /// Scripted actions: when, who, with whom, what.
        script: Vec<(u64, usize, usize, Kind)>,
        pairs: Vec<(usize, usize, Kind)>,
        forged: BTreeSet<ChatId>,
        counters: Counters,
    }

    fn gid(i: usize) -> GossipId {
        ident(i).id
    }

    impl Sim {
        fn new(seed: u64) -> Self {
            let mut rng = TestRng::new(seed ^ 0x6469_7263);
            let mut devs: Vec<Dev> = (0..N)
                .map(|i| Dev {
                    store: MemoryStorage::new(),
                    node: Node::open(&MemoryStorage::new(), gid(i)).unwrap(),
                    online: true,
                    inbox: Vec::new(),
                    created: BTreeSet::new(),
                    accepted: BTreeSet::new(),
                    consented: BTreeSet::new(),
                    migrated: BTreeSet::new(),
                    kept: BTreeSet::new(),
                    backup: MemoryStorage::new(),
                })
                .collect();
            for d in &mut devs {
                for k in 0..N {
                    d.node
                        .learn_keys(&mut d.store, &ident(k).public.to_bytes(), START, &mut rng)
                        .unwrap();
                }
                d.backup = d.store.clone();
            }
            let mut sim = Self {
                rng,
                now: START,
                seq: 0,
                devs,
                script: Vec::new(),
                pairs: Vec::new(),
                forged: BTreeSet::new(),
                counters: Counters::default(),
            };
            // Every pair of honest devices gets a scenario; the first two pairs are a
            // crossing migration and a contact, so that every seed has both.
            let mut n = 0;
            for a in 0..HONEST {
                for b in a + 1..HONEST {
                    let (x, y) = if chance(&mut sim.rng, 50) {
                        (a, b)
                    } else {
                        (b, a)
                    };
                    let kind = match (n, below(&mut sim.rng, 6)) {
                        (0, _) => Kind::Migration { both: true },
                        (1, _) => Kind::Contact { both: false },
                        (2, _) | (_, 5) => Kind::Continue,
                        (_, 0) => Kind::Migration { both: false },
                        (_, 1) => Kind::Migration { both: true },
                        (_, 2) => Kind::Contact { both: false },
                        (_, 3) => Kind::Contact { both: true },
                        _ => Kind::Plain,
                    };
                    n += 1;
                    let t = START + below(&mut sim.rng, 2 * HOUR);
                    let gap = below(&mut sim.rng, 5 * MINUTE);
                    match kind {
                        Kind::Migration { both } => {
                            sim.declare(x, y);
                            sim.declare(y, x);
                            sim.script.push((t, x, y, kind));
                            if both {
                                sim.script.push((t + gap, y, x, kind));
                            }
                        }
                        Kind::Contact { both } => {
                            sim.script.push((t, x, y, kind));
                            if both {
                                sim.script.push((t + gap, y, x, kind));
                            }
                        }
                        Kind::Plain => sim.script.push((t, x, y, kind)),
                        Kind::Continue => {
                            let (x, y) = if gid(x).as_bytes() < gid(y).as_bytes() {
                                (y, x)
                            } else {
                                (x, y)
                            };
                            sim.script.push((t, x, y, Kind::Contact { both: false }));
                            sim.script.push((t + HOUR, y, x, kind));
                        }
                        Kind::Restore => unreachable!("scripted apart"),
                    }
                    sim.pairs.push((x, y, kind));
                }
            }
            // The restore pair: case 7 or case 8 by the seed.
            let [a, b] = RESTORED;
            let (restored, other) = if chance(&mut sim.rng, 50) {
                (a, b)
            } else {
                (b, a)
            };
            let t = START + below(&mut sim.rng, HOUR);
            sim.script
                .push((t, other, restored, Kind::Contact { both: false }));
            sim.script.push((t + HOUR, restored, other, Kind::Restore));
            sim.pairs.push((other, restored, Kind::Restore));
            // The hostile member migrates with an honest one that declared it.
            let x = below(&mut sim.rng, HONEST as u64) as usize;
            sim.declare(x, HOSTILE);
            sim.script
                .push((START + HOUR, HOSTILE, x, Kind::Migration { both: false }));
            sim.script.sort_by_key(|s| s.0);
            sim
        }

        fn declare(&mut self, d: usize, peer: usize) {
            let now = self.now;
            let dev = &mut self.devs[d];
            dev.node
                .set_earlier_conversation(&mut dev.store, gid(peer), 0, true, now, &mut self.rng)
                .unwrap();
        }

        fn send(&mut self, from: usize, to: usize, bytes: Vec<u8>) {
            let delay = below(&mut self.rng, 20 * MINUTE);
            self.seq += 1;
            let at = self.now + delay;
            if chance(&mut self.rng, 5) {
                self.seq += 1;
                self.devs[to].inbox.push((
                    at + below(&mut self.rng, HOUR),
                    self.seq,
                    from,
                    bytes.clone(),
                ));
            }
            self.devs[to].inbox.push((at, self.seq, from, bytes));
        }

        fn act(&mut self, d: usize, peer: usize, kind: Kind) {
            let now = self.now;
            let s = signer(d);
            match kind {
                Kind::Migration { .. } => {
                    // §5.12: what was received first, then "Migrate" only if the peer's
                    // invitation is not held.
                    self.deliver_due(d);
                    let held = self.devs[d]
                        .node
                        .invitations(now)
                        .iter()
                        .any(|i| i.migration_of == Some(gid(peer)));
                    if held {
                        return;
                    }
                    if !self.devs[peer].created.is_empty() && self.devs[peer].migrated.contains(&d)
                    {
                        self.counters.direct_crossings += 1;
                    }
                    let dev = &mut self.devs[d];
                    let g = dev
                        .node
                        .create_group_with(
                            &mut dev.store,
                            &s,
                            String::new(),
                            vec![gid(peer)],
                            GroupOptions {
                                migrate_from: Some(0),
                                ..Default::default()
                            },
                            now,
                            &mut self.rng,
                        )
                        .unwrap();
                    dev.created.insert(g);
                    dev.migrated.insert(peer);
                    self.counters.direct_migrations += 1;
                    if d == HOSTILE {
                        self.hostile(g, peer);
                    }
                }
                Kind::Contact { .. } => {
                    // The peer accepted this device's request: it consents, this founds.
                    let dev = &mut self.devs[peer];
                    dev.node
                        .consent_to_direct_chat(&mut dev.store, gid(d), true, now, &mut self.rng)
                        .unwrap();
                    dev.consented.insert(d);
                    // The requester founds the chat, as every automatic group of two, with
                    // migrate_from = 0.
                    let dev = &mut self.devs[d];
                    let g = dev
                        .node
                        .create_group_with(
                            &mut dev.store,
                            &s,
                            String::new(),
                            vec![gid(peer)],
                            GroupOptions {
                                migrate_from: Some(0),
                                ..Default::default()
                            },
                            now,
                            &mut self.rng,
                        )
                        .unwrap();
                    dev.created.insert(g);
                    dev.migrated.insert(peer);
                }
                Kind::Continue | Kind::Restore => {
                    if kind == Kind::Restore {
                        let dev = &mut self.devs[d];
                        dev.store = dev.backup.clone();
                        dev.node = Node::open(&dev.store, gid(d)).unwrap();
                        dev.created.clear();
                        dev.accepted.clear();
                        dev.consented.clear();
                        dev.migrated.clear();
                        dev.kept.clear();
                        dev.inbox.clear();
                        self.counters.direct_restores += 1;
                    }
                    let dev = &mut self.devs[d];
                    let g = dev
                        .node
                        .create_group_with(
                            &mut dev.store,
                            &s,
                            String::new(),
                            vec![gid(peer)],
                            GroupOptions {
                                migrate_from: Some(0),
                                ..Default::default()
                            },
                            now,
                            &mut self.rng,
                        )
                        .unwrap();
                    dev.created.insert(g);
                    dev.migrated.insert(peer);
                }
                Kind::Plain => {
                    let dev = &mut self.devs[d];
                    let g = dev
                        .node
                        .create_group(
                            &mut dev.store,
                            &s,
                            String::new(),
                            vec![gid(peer)],
                            now,
                            &mut self.rng,
                        )
                        .unwrap();
                    dev.created.insert(g);
                }
            }
        }

        /// The hostile member replays its migration root to a third party, and forges
        /// `migrate_from` on a group of three.
        fn hostile(&mut self, g: ChatId, peer: usize) {
            let root = self.devs[HOSTILE].node.root(&g).unwrap();
            let third = (peer + 1) % HONEST;
            let blob = wire::encode_event_blob(&EventObject::Root(Box::new(root.clone()))).unwrap();
            let pt = wire::encode_plaintext(&[Frame::Event(blob)]).unwrap();
            self.send(HOSTILE, third, pt);
            self.counters.direct_replays += 1;
            let mut p = root.to_proto();
            let mut members = [gid(HOSTILE), gid(peer), gid(third)];
            members.sort();
            p.members = members.iter().map(|m| m.as_bytes().to_vec()).collect();
            p.created_at += 1;
            let forged = Root::forge(p, &ident(HOSTILE).secret.dsa_signing_key);
            self.forged.insert(forged.chat_id());
            let blob = wire::encode_event_blob(&EventObject::Root(Box::new(forged))).unwrap();
            let pt = wire::encode_plaintext(&[Frame::Event(blob)]).unwrap();
            for to in [peer, third] {
                self.send(HOSTILE, to, pt.clone());
            }
            self.counters.direct_forged += 1;
        }

        fn deliver_due(&mut self, d: usize) {
            let now = self.now;
            let mut due: Vec<(u64, u64, usize, Vec<u8>)> = Vec::new();
            let inbox = std::mem::take(&mut self.devs[d].inbox);
            let mut rest = Vec::new();
            for m in inbox {
                if m.0 <= now {
                    due.push(m);
                } else {
                    rest.push(m);
                }
            }
            self.devs[d].inbox = rest;
            due.sort_by_key(|m| (m.0, m.1));
            for (_, _, from, bytes) in due {
                let dev = &mut self.devs[d];
                dev.node
                    .handle_plaintext(&mut dev.store, gid(from), &bytes, now, &mut self.rng)
                    .unwrap();
            }
        }

        fn step(&mut self, d: usize) {
            let now = self.now;
            self.deliver_due(d);
            let s = signer(d);
            let dev = &mut self.devs[d];
            dev.node
                .tick_with(&mut dev.store, Some(&s), now, &mut self.rng)
                .unwrap();
            // The user accepts the migrations it is shown and the invitations to continue a
            // chat of two; ordinary invitations wait.
            for inv in dev.node.invitations(now) {
                if inv.continues.is_some() && d != HOSTILE {
                    // Only the side whose chat loses the tie is ever asked.
                    assert!(
                        inv.owner.as_bytes() < gid(d).as_bytes(),
                        "device {d} asked to continue in {:?}",
                        inv.chat_id
                    );
                    self.counters.direct_continuations += 1;
                }
                if (inv.migration_of.is_some() || inv.continues.is_some()) && d != HOSTILE {
                    let g = dev
                        .node
                        .accept_invitation(&mut dev.store, inv.chat_id, now, &mut self.rng)
                        .unwrap();
                    dev.accepted.insert(g);
                    dev.accepted.insert(inv.chat_id);
                }
            }
            for c in dev
                .node
                .take_changes(&mut dev.store, now, &mut self.rng)
                .unwrap()
            {
                if let ChangeKind::Superseded { .. } = c.kind {
                    self.counters.direct_superseded += 1;
                }
            }
            // The user writes now and then in its active chats of two, and the chats in which
            // the other person took part, or it wrote, are recorded: never to be erased.
            let chats: Vec<crate::node::GroupSummary> = dev
                .node
                .groups()
                .into_iter()
                .filter(|g| g.members.len() == 2)
                .collect();
            for g in chats {
                if g.took_part == Some(true) {
                    self.devs[d].kept.insert(g.group);
                }
                if g.status == MyStatus::Member && d != HOSTILE && chance(&mut self.rng, 2) {
                    let dev = &mut self.devs[d];
                    if dev
                        .node
                        .publish_message(
                            &mut dev.store,
                            g.current,
                            crate::event::Body::Text("hi".into()),
                            BTreeMap::new(),
                            None,
                            now,
                            &mut self.rng,
                        )
                        .is_ok()
                    {
                        dev.kept.insert(g.group);
                        self.counters.direct_messages += 1;
                    }
                }
            }
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
                if let Some(to) = (0..N).find(|i| gid(*i) == o.to) {
                    self.send(d, to, o.plaintext);
                }
            }
        }

        fn run(&mut self) {
            let active_end = START + 3 * HOUR;
            let end = active_end + 8 * HOUR;
            let mut next = 0;
            while self.now < end {
                while next < self.script.len() && self.script[next].0 <= self.now {
                    let (_, d, peer, kind) = self.script[next];
                    next += 1;
                    self.act(d, peer, kind);
                }
                for d in 0..N {
                    if self.now < active_end && chance(&mut self.rng, 3) {
                        self.devs[d].online = !self.devs[d].online;
                    }
                    if self.now >= active_end {
                        self.devs[d].online = true;
                    }
                    if self.devs[d].online {
                        self.step(d);
                    }
                }
                self.now += MINUTE;
            }
        }

        /// The installed groups of device `d` with their founding root, superseded chats of
        /// two apart.
        fn groups(&self, d: usize) -> BTreeMap<ChatId, Root> {
            let node = &self.devs[d].node;
            node.groups()
                .into_iter()
                .filter(|g| !matches!(g.status, MyStatus::Superseded { .. }))
                .filter_map(|g| node.root(&g.group).map(|r| (g.group, r)))
                .collect()
        }

        fn check(&self) {
            for d in 0..N {
                let node = &self.devs[d].node;
                // No chat of two the other person took part in, or this device wrote in, is
                // erased: a replaced one is kept superseded.
                let held: BTreeSet<ChatId> = node.groups().iter().map(|g| g.group).collect();
                for g in &self.devs[d].kept {
                    assert!(held.contains(g), "device {d} erased {g:?}");
                }
                // A non-member never holds, installs or links a root.
                for (c, r) in node.tables().epochs.iter() {
                    assert!(r.root.is_member(&gid(d)), "device {d} holds {c:?}");
                }
                if d == HOSTILE {
                    continue;
                }
                for (g, root) in self.groups(d) {
                    assert!(
                        !self.forged.contains(&g),
                        "device {d} installed a forged root"
                    );
                    let dev = &self.devs[d];
                    if dev.created.contains(&g) || dev.accepted.contains(&g) {
                        continue;
                    }
                    // Adopted without a prompt: a group of two founded by the peer, under a
                    // consent or won by the tie rule.
                    let owner = root.owner_id();
                    let p = (0..N).find(|i| gid(*i) == owner).unwrap();
                    assert_eq!(root.members().len(), 2, "device {d}: {g:?}");
                    let consent = dev.consented.contains(&p) && root.migrate_from() == Some(0);
                    let tie = dev.migrated.contains(&p)
                        && root.migrate_from() == Some(0)
                        && owner.as_bytes() < gid(d).as_bytes();
                    assert!(consent || tie, "device {d} adopted {g:?} of {p} unasked");
                }
                // Every forged root is at most an ordinary invitation.
                for inv in node.invitations(u64::MAX / 2) {
                    if self.forged.contains(&inv.chat_id) {
                        assert_eq!((inv.migrate_from, inv.migration_of), (None, None));
                    }
                }
            }
            let migration = |d: usize, p: usize| -> BTreeSet<ChatId> {
                self.groups(d)
                    .into_iter()
                    .filter(|(_, r)| r.migrate_from() == Some(0) && r.is_member(&gid(p)))
                    .map(|(g, _)| g)
                    .collect()
            };
            for &(x, y, kind) in &self.pairs {
                match kind {
                    Kind::Migration { .. } => {
                        let (a, b) = (migration(x, y), migration(y, x));
                        if a != b || a.len() != 1 {
                            for d in [x, y] {
                                let dev = &self.devs[d];
                                eprintln!(
                                    "device {d} {:?}: created {:?} accepted {:?} migrated {:?}",
                                    gid(d),
                                    dev.created,
                                    dev.accepted,
                                    dev.migrated
                                );
                                for (g, r) in self.groups(d) {
                                    eprintln!(
                                        "  holds {g:?} owner {:?} mf {:?}",
                                        r.owner_id(),
                                        r.migrate_from()
                                    );
                                }
                            }
                            eprintln!(
                                "script {:?}",
                                self.script
                                    .iter()
                                    .filter(|s| (s.1 == x || s.1 == y) && (s.2 == x || s.2 == y))
                                    .collect::<Vec<_>>()
                            );
                        }
                        assert_eq!(a.len(), 1, "pair {x} {y}: {a:?}");
                        assert_eq!(a, b, "pair {x} {y}");
                    }
                    Kind::Contact { .. } | Kind::Continue | Kind::Restore => {
                        // One chat, held by both, also when the requests crossed, and after a
                        // conversation continued in a new chat.
                        let (a, b) = (migration(x, y), migration(y, x));
                        assert_eq!(a.len(), 1, "contact {x} {y}: {a:?}");
                        assert_eq!(a, b, "contact {x} {y}");
                    }
                    Kind::Plain => {
                        let held = self.groups(y).values().any(|r| {
                            r.is_member(&gid(x))
                                && r.migrate_from().is_none()
                                && r.members().len() == 2
                        });
                        let consented = self.devs[y].consented.contains(&x)
                            || self.devs[x].consented.contains(&y);
                        assert!(!held || consented, "plain {x} {y} adopted");
                    }
                }
            }
        }
    }

    pub(super) fn run(seed: u64) -> Counters {
        let mut sim = Sim::new(seed);
        sim.run();
        sim.check();
        for d in &sim.devs {
            for (_, r) in d.node.tables().epochs.iter() {
                if matches!(r.status, EpochStatus::Installed)
                    && r.from != d.node.me()
                    && r.root.members().len() == 2
                {
                    sim.counters.direct_consents += u64::from(
                        r.root.migrate_from() == Some(0)
                            && d.consented.iter().any(|p| gid(*p) == r.root.owner_id()),
                    );
                }
            }
        }
        sim.counters
    }
}
