//! What the user does with groups (§4.6, §4.8, §5): founding a group and changing it as its
//! owner (successor, handover and resolution roots with their kicks), dissolving it,
//! leaving it in one of the three ways of §5.2, answering an invitation, and the owner's
//! automatic successor after leaves and requests (§5.5).
//!
//! Every action that signs takes a [`IdentitySigner`]: the engine never holds key
//! material.

use std::collections::{BTreeMap, BTreeSet};

use super::records::{
    ChangeKind, EpochRecord, EpochStatus, GroupStatus, Junction, JunctionKind, MarkerKind,
    SignedObject, SignedRecord, Work,
};
use super::{Cx, Node, NodeError};
use crate::constants::MAX_ROOT_PARENTS;
use crate::ids::{Challenge, ChatId, GossipId, GroupSecret};
use crate::keys::IdentitySigner;
use crate::rng::{Randomness, bytes};
use crate::root::{Root, RootParams, next_root_created_at};
use crate::signed::{Dissolve, Kick, Leave};
use crate::wire::{EntryItem, EventObject, encode_event_blob};

use super::records::NodeStorage;

/// The quiet time the owner's device waits after the last leave or request (§5.5).
pub const SUCCESSOR_QUIET_MS: u64 = 30_000;
/// The longest it waits after the first one (§5.5).
pub const SUCCESSOR_MAX_WAIT_MS: u64 = 300_000;

/// A change of a group by its owner (§4.6, §5.7, §4.9).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GroupChange {
    /// A successor root: members added and removed, and the name.
    Successor {
        /// Members added.
        add: Vec<GossipId>,
        /// Members removed.
        remove: Vec<GossipId>,
        /// A new name, if any.
        name: Option<String>,
    },
    /// A handover root to `new_owner` (§5.7), who must be a member and whose keys this
    /// device must hold. It keeps every member (§4.7) but, with `leave`, this device, which
    /// then closes the group; it may rename.
    Handover {
        /// The new owner.
        new_owner: GossipId,
        /// "Hand over and leave".
        leave: bool,
        /// A new name, if any.
        name: Option<String>,
    },
    /// A successor root that changes only the message timer (§4.1, §7.7): the members, the
    /// name and the settings stay. The new timer applies to the messages of the new epoch;
    /// those of earlier epochs keep the timer of their own epoch.
    MessageTimer {
        /// The new message timer, in milliseconds; 0 keeps messages forever.
        timer: u64,
    },
    /// A resolution root whose parents are all the competing ends, with this member list
    /// (§4.9). Members whose leave applies are left out whatever the list says (§5.5).
    Resolve {
        /// The members.
        members: Vec<GossipId>,
        /// The name.
        name: Option<String>,
    },
}

/// How a member leaves a group or declines an invitation (§5.2).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LeaveChoice {
    /// The signed leave, visible to everyone (§5.3).
    Signed,
    /// The owner-only request, "Ask to be kicked" (§5.4).
    AskToBeKicked,
    /// The silent close, "Ignore and Delete" (§14.2).
    Silent,
}

impl Node {
    /// Founds a group owned by the signer's identity with these members (the owner is added)
    /// and name (§4.5, §4.6). The root is installed as accepted and sent to every other
    /// member. Returns the key of the group, which is its first epoch's ID.
    ///
    /// # Errors
    ///
    /// [`NodeError::Root`] for a member list or name the root refuses, or a storage failure.
    #[allow(clippy::too_many_arguments)]
    pub fn create_group<S: NodeStorage>(
        &mut self,
        store: &mut S,
        signer: &dyn IdentitySigner,
        name: String,
        members: Vec<GossipId>,
        now: u64,
        rng: &mut dyn Randomness,
    ) -> Result<ChatId, NodeError> {
        self.create_group_with(
            store,
            signer,
            name,
            members,
            super::GroupOptions::default(),
            now,
            rng,
        )
    }

    /// Founds a group as [`Node::create_group`] does, with `options` (§5.12): with
    /// `migrate_from`, the group of two continues an earlier conversation with the other
    /// member. When this device holds that member's own creation for the same conversation
    /// and that member's GossipID sorts first, that group is adopted instead and its key
    /// returned (two creations at once); when this device's sorts first, the other is
    /// dropped.
    ///
    /// # Errors
    ///
    /// As [`Node::create_group`]; [`NodeError::Root`] with [`crate::Error::MigrateFrom`]
    /// for `migrate_from` on a group that is not of two.
    #[allow(clippy::too_many_arguments)]
    pub fn create_group_with<S: NodeStorage>(
        &mut self,
        store: &mut S,
        signer: &dyn IdentitySigner,
        name: String,
        members: Vec<GossipId>,
        options: super::GroupOptions,
        now: u64,
        rng: &mut dyn Randomness,
    ) -> Result<ChatId, NodeError> {
        self.run(store, now, rng, |n, cx| {
            n.found_group(cx, signer, name, members, options)
        })
    }

    /// Changes a group as its owner (§4.6): a successor, handover or resolution root built
    /// on the current epoch (or on every competing end), with its kicks (§5.6). Returns the
    /// new epoch.
    ///
    /// # Errors
    ///
    /// [`NodeError::NotOwner`] when this device does not own the current epoch,
    /// [`NodeError::Fork`] for a successor or handover while competing ends wait for a
    /// resolution (or a resolution without them), [`NodeError::UnknownKeys`] for a handover
    /// to an identity whose keys are not held, [`NodeError::Root`] for a root refused by
    /// §4.1 and §4.7, or a storage failure.
    pub fn change_group<S: NodeStorage>(
        &mut self,
        store: &mut S,
        signer: &dyn IdentitySigner,
        group: ChatId,
        change: GroupChange,
        now: u64,
        rng: &mut dyn Randomness,
    ) -> Result<ChatId, NodeError> {
        self.run(store, now, rng, |n, cx| {
            n.remember_own_keys(cx, signer);
            n.owner_root(cx, signer, group, change)
        })
    }

    /// Dissolves a group as its owner (§5.8): the dissolve message of the current epoch is
    /// sent to every member and applied on this device.
    ///
    /// # Errors
    ///
    /// [`NodeError::NotOwner`], [`NodeError::UnknownEpoch`] or a storage failure.
    pub fn dissolve_group<S: NodeStorage>(
        &mut self,
        store: &mut S,
        signer: &dyn IdentitySigner,
        group: ChatId,
        must_delete: bool,
        now: u64,
        rng: &mut dyn Randomness,
    ) -> Result<(), NodeError> {
        self.run(store, now, rng, |n, cx| {
            let cur = n.current_epoch(&group).ok_or(NodeError::UnknownEpoch)?;
            let root =
                n.t.epochs
                    .get(&cur)
                    .ok_or(NodeError::UnknownEpoch)?
                    .root
                    .clone();
            if root.owner_id() != n.me || n.group_status(&group) != GroupStatus::Active {
                return Err(NodeError::NotOwner);
            }
            let d = Dissolve::sign(&root, must_delete, signer, bytes(cx.rng))
                .map_err(NodeError::Root)?;
            let obj = SignedObject::Dissolve(d);
            let key = obj.key();
            n.t.signed.insert(
                key,
                SignedRecord {
                    object: obj.clone(),
                    received_at: cx.now,
                },
            );
            for m in root.members() {
                if *m != n.me {
                    n.queue_object(*m, cur, obj.item());
                }
            }
            let g = n.group_of(&cur);
            n.apply_dissolve(cx, g, cur, must_delete);
            Ok(())
        })
    }

    /// Leaves a group (§5.2): the signed leave of the current epoch to every member of it,
    /// then the group is closed (§5.3); "Ask to be kicked", which deletes the messages and
    /// waits for the kick (§5.4); or the silent close (§14.2). An owner hands the group over
    /// or dissolves it instead (§5.8); the silent close stays open to it.
    ///
    /// # Errors
    ///
    /// [`NodeError::UnknownEpoch`], [`NodeError::NotAllowed`] for an owner leaving otherwise
    /// than silently, or a storage failure.
    pub fn leave_group<S: NodeStorage>(
        &mut self,
        store: &mut S,
        signer: &dyn IdentitySigner,
        group: ChatId,
        choice: LeaveChoice,
        now: u64,
        rng: &mut dyn Randomness,
    ) -> Result<(), NodeError> {
        self.run(store, now, rng, |n, cx| {
            n.remember_own_keys(cx, signer);
            let cur = n.current_epoch(&group).ok_or(NodeError::UnknownEpoch)?;
            let root =
                n.t.epochs
                    .get(&cur)
                    .ok_or(NodeError::UnknownEpoch)?
                    .root
                    .clone();
            let only = root.members().len() == 1;
            if root.owner_id() == n.me && choice != LeaveChoice::Silent && !only {
                return Err(NodeError::NotAllowed);
            }
            let g = n.group_of(&cur);
            match choice {
                LeaveChoice::Signed => {
                    n.send_leave(cx, signer, &root)?;
                    n.close_group(cx, g, true);
                }
                LeaveChoice::AskToBeKicked => n.start_waiting(cx, g, &root),
                LeaveChoice::Silent => n.close_group(cx, g, true),
            }
            Ok(())
        })
    }

    /// Deletes a group's data on this device (§14.2): "Delete" on a kicked, left or
    /// dissolved group, or "Ignore and Delete".
    ///
    /// # Errors
    ///
    /// [`NodeError::UnknownEpoch`] or a storage failure.
    pub fn delete_group<S: NodeStorage>(
        &mut self,
        store: &mut S,
        group: ChatId,
        now: u64,
        rng: &mut dyn Randomness,
    ) -> Result<(), NodeError> {
        self.run(store, now, rng, |n, cx| {
            if !n.t.epochs.contains(&group) {
                return Err(NodeError::UnknownEpoch);
            }
            let g = n.group_of(&group);
            // "Ignore and Delete" on an invitation not answered: the roots fetched as its
            // parents go too, as on a decline (§4.8, §14.2). Why: the action meant to leave the
            // least trace must not leave the earlier epochs' member lists behind.
            let invitations: Vec<ChatId> =
                n.t.epochs
                    .iter()
                    .filter(|(_, r)| r.group == g && matches!(r.status, EpochStatus::Invitation(_)))
                    .map(|(c, _)| *c)
                    .collect();
            for top in invitations {
                n.drop_refused_parents(top);
            }
            n.close_group(cx, g, true);
            Ok(())
        })
    }

    /// Accepts an invitation (§4.8): the epoch is installed and nothing is sent; the device
    /// fetches the keys it lacks and scans tips. It continues the held group whose epoch it
    /// continues with verified authority, or rejoins the group it was removed from (§5.10);
    /// otherwise it starts a separate group. Returns the group key.
    ///
    /// # Errors
    ///
    /// [`NodeError::UnknownEpoch`] when `chat` is not an invitation, or a storage failure.
    pub fn accept_invitation<S: NodeStorage>(
        &mut self,
        store: &mut S,
        chat: ChatId,
        now: u64,
        rng: &mut dyn Randomness,
    ) -> Result<ChatId, NodeError> {
        self.run(store, now, rng, |n, cx| {
            let Some(rec) = n.t.epochs.get(&chat).cloned() else {
                return Err(NodeError::UnknownEpoch);
            };
            let EpochStatus::Invitation(inv) = rec.status else {
                return Err(NodeError::UnknownEpoch);
            };
            n.take_record(&chat);
            n.take_marker(&chat);
            n.t.events.remove(&(chat, ChangeKind::Invitation));
            // The parent lookup keeps running: when it succeeds, the conversations are
            // joined (§4.8).
            let held: Vec<ChatId> =
                n.gx.epochs
                    .values()
                    .flatten()
                    .filter(|c| rec.root.names_parent(c))
                    .copied()
                    .collect();
            let parents = n.authorized_parents(&rec.root, &held);
            // A group deleted since the invitation arrived is not recreated.
            let rejoins = inv.rejoins.filter(|g| n.t.group_recs.contains(g));
            if let Some(g) = rejoins.or_else(|| parents.first().map(|p| n.group_of(p))) {
                // Back in a group it had left by a kick or a dissolve (§5.10): the junction.
                let kicked_at = match n.group_status(&g) {
                    GroupStatus::Removed { at, .. } => Some((at, JunctionKind::Removed)),
                    GroupStatus::Left { at, .. } => Some((at, JunctionKind::Left)),
                    GroupStatus::Dissolved { at, .. } => Some((at, JunctionKind::Dissolved)),
                    _ => None,
                };
                let owner = rec.root.owner_id();
                let rejoined = kicked_at.is_some();
                let gr = n.group_rec_mut(g);
                gr.status = GroupStatus::Active;
                // The user chose this root's line to come back: it is followed, unless a
                // handover deposed its owner (§5.9).
                if rejoined && !gr.deposed.contains(&owner) {
                    gr.followed = Some(owner);
                }
                n.rebuild_epochs();
                n.resume_lookups(g);
                n.adopt(cx, rec.root, rec.from, parents, false)?;
                let g = n.group_of(&chat);
                n.recheck_status(cx, g);
                if let (Some((from, kind)), Some(to)) =
                    (kicked_at, n.t.epochs.get(&chat).and_then(|r| r.line_time))
                {
                    n.group_rec_mut(g)
                        .junctions
                        .push(Junction { from, to, kind });
                }
                n.changed(g, ChangeKind::Joined, cx.now);
                Ok(g)
            } else {
                // An invitation to continue a chat of two supersedes it (§5.12).
                let continues = n.superseded_on_accept(&rec.root);
                n.adopt(cx, rec.root, rec.from, Vec::new(), false)?;
                n.changed(chat, ChangeKind::Joined, cx.now);
                for c in continues {
                    n.supersede(cx, c, chat)?;
                }
                Ok(n.group_of(&chat))
            }
        })
    }

    /// Declines an invitation (§5.2): with the signed decline sent to every member of its
    /// epoch, by asking its owner to be kicked (the root is kept in the waiting state), or
    /// silently. Except while waiting, a closed-chat marker remains.
    ///
    /// # Errors
    ///
    /// [`NodeError::UnknownEpoch`] when `chat` is not an invitation, or a storage failure.
    #[allow(clippy::too_many_arguments)]
    pub fn decline_invitation<S: NodeStorage>(
        &mut self,
        store: &mut S,
        signer: &dyn IdentitySigner,
        chat: ChatId,
        choice: LeaveChoice,
        now: u64,
        rng: &mut dyn Randomness,
    ) -> Result<(), NodeError> {
        self.run(store, now, rng, |n, cx| {
            n.remember_own_keys(cx, signer);
            let Some(rec) = n.t.epochs.get(&chat).cloned() else {
                return Err(NodeError::UnknownEpoch);
            };
            if !matches!(rec.status, EpochStatus::Invitation(_)) {
                return Err(NodeError::UnknownEpoch);
            }
            n.take_record(&chat);
            n.t.events.remove(&(chat, ChangeKind::Invitation));
            n.drop_tasks_of(&[chat]);
            // The roots fetched as its parents go with it, each leaving a closed-chat marker
            // with its reference, as the invitation does.
            n.drop_refused_parents(chat);
            match choice {
                LeaveChoice::Signed => {
                    n.send_leave(cx, signer, &rec.root)?;
                    n.put_marker(chat, MarkerKind::Closed, Some(rec.root.ref_chat_id()));
                }
                LeaveChoice::Silent => {
                    n.put_marker(chat, MarkerKind::Closed, Some(rec.root.ref_chat_id()));
                }
                LeaveChoice::AskToBeKicked => {
                    let root = rec.root.clone();
                    n.put_record(
                        chat,
                        EpochRecord {
                            status: EpochStatus::Installed,
                            group: chat,
                            parents: Vec::new(),
                            ..rec
                        },
                    );
                    n.start_waiting(cx, chat, &root);
                }
            }
            n.rebuild_epochs();
            Ok(())
        })
    }

    /// Retry synchronisation of a group (§9.4): the exact root of the current epoch is sent
    /// again to its other members.
    ///
    /// # Errors
    ///
    /// [`NodeError::UnknownEpoch`] or a storage failure.
    pub fn resend_root<S: NodeStorage>(
        &mut self,
        store: &mut S,
        group: ChatId,
        now: u64,
        rng: &mut dyn Randomness,
    ) -> Result<(), NodeError> {
        self.run(store, now, rng, |n, _cx| {
            let cur = n.current_epoch(&group).ok_or(NodeError::UnknownEpoch)?;
            let members: Vec<GossipId> = n.object_pool(&cur, None);
            for m in members {
                n.queue_object(m, cur, EntryItem::Root);
            }
            Ok(())
        })
    }

    /// Adds keys this device already holds for an identity, from a contact or a session
    /// (§4.3: no query is needed for them), its own included.
    ///
    /// # Errors
    ///
    /// [`NodeError::Root`] for bytes that are not canonical keys, or a storage failure.
    pub fn learn_keys<S: NodeStorage>(
        &mut self,
        store: &mut S,
        keys: &[u8],
        now: u64,
        rng: &mut dyn Randomness,
    ) -> Result<GossipId, NodeError> {
        let (_, id) = crate::keys::parse_user_public_keys(keys).map_err(NodeError::Root)?;
        self.run(store, now, rng, |n, cx| {
            n.cache_keys(cx, keys);
            Ok(id)
        })
    }

    /// Sets or clears the local name of a group (§5.11): stored on this device only.
    ///
    /// # Errors
    ///
    /// [`NodeError::UnknownEpoch`] or a storage failure.
    pub fn set_local_name<S: NodeStorage>(
        &mut self,
        store: &mut S,
        group: ChatId,
        name: Option<String>,
        now: u64,
        rng: &mut dyn Randomness,
    ) -> Result<(), NodeError> {
        self.run(store, now, rng, |n, cx| {
            if !n.installed(&group) {
                return Err(NodeError::UnknownEpoch);
            }
            let g = n.group_of(&group);
            n.group_rec_mut(g).local_name = name;
            n.changed(g, ChangeKind::Membership, cx.now);
            Ok(())
        })
    }

    /// Links two groups by hand, or unlinks them (§5.10): local, reversible, nothing sent.
    /// Linked groups are shown as one conversation and answer scans as one group.
    ///
    /// # Errors
    ///
    /// [`NodeError::UnknownEpoch`] or a storage failure.
    pub fn link_groups<S: NodeStorage>(
        &mut self,
        store: &mut S,
        a: ChatId,
        b: ChatId,
        linked: bool,
        now: u64,
        rng: &mut dyn Randomness,
    ) -> Result<(), NodeError> {
        self.run(store, now, rng, |n, cx| {
            if !n.installed(&a) || !n.installed(&b) {
                return Err(NodeError::UnknownEpoch);
            }
            let (ga, gb) = (n.group_of(&a), n.group_of(&b));
            if ga == gb {
                return Ok(());
            }
            for (x, y) in [(ga, gb), (gb, ga)] {
                let g = n.group_rec_mut(x);
                if linked {
                    g.links.insert(y);
                } else {
                    g.links.remove(&y);
                }
                n.changed(x, ChangeKind::Membership, cx.now);
            }
            Ok(())
        })
    }

    // ── Helpers ──────────────────────────────────────────────────────────────

    pub(crate) fn remember_own_keys(&mut self, cx: &mut Cx<'_>, signer: &dyn IdentitySigner) {
        if !self.t.keys.contains(&self.me) {
            let bytes = signer.public_keys().to_bytes();
            self.cache_keys(cx, &bytes);
        }
    }

    /// Signs this device's leave of the epoch `root` and queues it, as bytes, for every
    /// other member of it (§5.3): it must leave even after the group is closed here.
    fn send_leave(
        &mut self,
        cx: &mut Cx<'_>,
        signer: &dyn IdentitySigner,
        root: &Root,
    ) -> Result<(), NodeError> {
        let leave = Leave::sign(root, signer.public_keys(), signer, bytes(cx.rng))
            .map_err(NodeError::Root)?;
        let blob = encode_event_blob(&EventObject::Leave(leave)).map_err(NodeError::Root)?;
        for m in root.members() {
            if *m != self.me {
                self.queue_work(*m, Work::Blob(blob.clone()));
            }
        }
        self.stats.leaves_sent += 1;
        Ok(())
    }

    /// Enters the waiting state of §5.4: the request goes to the owner of the current
    /// epoch, the messages are deleted at once and only the roots are kept.
    fn start_waiting(&mut self, cx: &mut Cx<'_>, group: ChatId, root: &Root) {
        if root.owner_id() != self.me {
            self.queue_work(
                root.owner_id(),
                Work::LeaveRequest {
                    chat_id: root.chat_id(),
                },
            );
        }
        let epochs: Vec<ChatId> = self
            .t
            .epochs
            .iter()
            .filter(|(_, r)| r.group == group)
            .map(|(c, _)| *c)
            .collect();
        for c in epochs {
            self.erase_messages(c);
        }
        self.group_rec_mut(group).status = GroupStatus::Waiting {
            since: cx.now,
            last_request: cx.now,
        };
        self.stop_sync(group);
        self.rebuild_epochs();
        self.changed(group, ChangeKind::ReadOnly, cx.now);
    }

    /// Builds, signs, installs and delivers an owner's root (§4.6) with its kicks (§5.6).
    #[allow(clippy::too_many_lines)]
    pub(crate) fn owner_root(
        &mut self,
        cx: &mut Cx<'_>,
        signer: &dyn IdentitySigner,
        group: ChatId,
        change: GroupChange,
    ) -> Result<ChatId, NodeError> {
        let cur = self.current_epoch(&group).ok_or(NodeError::UnknownEpoch)?;
        let group = self.group_of(&cur);
        if self.group_status(&group) != GroupStatus::Active {
            return Err(NodeError::NotAllowed);
        }
        let cur_root = self
            .t
            .epochs
            .get(&cur)
            .ok_or(NodeError::UnknownEpoch)?
            .root
            .clone();
        if cur_root.owner_id() != self.me {
            return Err(NodeError::NotOwner);
        }
        let fork = self.fork_to_resolve(&group);
        let my_keys = signer.public_keys().clone();
        let leavers = self.live_leavers(&cur);
        let mut message_timer = cur_root.message_timer();
        let (mut parents, mut members, name, handover) = match &change {
            GroupChange::Successor { add, remove, name } => {
                if !fork.is_empty() {
                    return Err(NodeError::Fork);
                }
                let mut m: BTreeSet<GossipId> = cur_root.members().iter().copied().collect();
                m.extend(add.iter().copied());
                for r in remove {
                    m.remove(r);
                }
                (vec![cur], m, name.clone(), None)
            }
            GroupChange::MessageTimer { timer } => {
                if !fork.is_empty() {
                    return Err(NodeError::Fork);
                }
                message_timer = *timer;
                let m: BTreeSet<GossipId> = cur_root.members().iter().copied().collect();
                (vec![cur], m, None, None)
            }
            GroupChange::Handover {
                new_owner,
                leave,
                name,
            } => {
                if !fork.is_empty() {
                    return Err(NodeError::Fork);
                }
                if !cur_root.is_member(new_owner) || *new_owner == self.me {
                    return Err(NodeError::NotAllowed);
                }
                let mut m: BTreeSet<GossipId> = cur_root.members().iter().copied().collect();
                if *leave {
                    m.remove(&self.me);
                }
                (vec![cur], m, name.clone(), Some(*new_owner))
            }
            GroupChange::Resolve { members, name } => {
                // Its own competing ends, and the ends of former owners in its line (§5.9),
                // the current epoch first; more than 32 are resolved in steps (§4.9).
                let mut ends = vec![cur];
                for e in fork.iter().chain(self.former_owner_ends(&group).iter()) {
                    if !ends.contains(e) {
                        ends.push(*e);
                    }
                }
                ends.truncate(MAX_ROOT_PARENTS);
                if ends.len() < 2 {
                    return Err(NodeError::Fork);
                }
                let mut m: BTreeSet<GossipId> = members.iter().copied().collect();
                m.insert(self.me);
                (ends, m, name.clone(), None)
            }
        };
        // Members whose leave or request applies are left out (§5.5), except in a handover,
        // which keeps every member but the outgoing owner (§4.7): the new owner applies
        // the leaves it holds once it owns the group, and the requests are sent to it again.
        let pending: Vec<GossipId> = self
            .t
            .group_recs
            .get(&group)
            .map(|g| g.pending_removals.keys().copied().collect())
            .unwrap_or_default();
        if handover.is_none() {
            for m in leavers.iter().chain(pending.iter()) {
                if *m != self.me {
                    members.remove(m);
                }
            }
        }
        // §5.10: one more parent per distinct last epoch of the members added back: among
        // the epochs of the line the new root continues (the held ancestors of its parents)
        // that list the member and that this owner has authority over, one that no later such
        // epoch continues (the latest by date of those, then by chat ID); none if no epoch
        // qualifies, and the root then reaches the member as an ordinary invitation. Not
        // simply the latest by date: a former owner's root continuing its old epoch, dated at
        // the end of time (D.72), is latest by date whether a side branch or resolved into the
        // line, and the member, which holds no handover leading to it, could not verify the
        // new owner's authority over it and would not be joined.
        if handover.is_none() {
            let held_ancestors = |from: &[ChatId]| {
                let mut seen: BTreeSet<ChatId> = BTreeSet::new();
                let mut stack = from.to_vec();
                while let Some(c) = stack.pop() {
                    if seen.insert(c)
                        && let Some(r) = self.t.epochs.get(&c)
                    {
                        stack.extend(r.parents.iter().copied());
                    }
                }
                seen
            };
            let line = held_ancestors(&parents);
            for m in &members {
                if parents
                    .iter()
                    .any(|p| self.t.epochs.get(p).is_some_and(|r| r.root.is_member(m)))
                {
                    continue;
                }
                // Only an epoch this owner has authority over as a receiver judges it, from
                // that epoch's own held ancestors (§4.7, D.69): its owner, or a previous owner
                // in its line. A former owner's branch resolved into the line does not
                // qualify: the member, which does not hold the resolution root, cannot verify
                // the authority over it, and would see the new root start a second
                // conversation (membership simulation, seed 22).
                let listing: Vec<ChatId> = line
                    .iter()
                    .filter(|c| {
                        self.t.epochs.get(c).is_some_and(|r| {
                            r.root.is_member(m)
                                && self
                                    .line_authority(self.me, &[**c])
                                    .contains(&r.root.owner_id())
                        })
                    })
                    .copied()
                    .collect();
                let continued: BTreeSet<ChatId> = listing
                    .iter()
                    .flat_map(|c| {
                        let parents = self.t.epochs.get(c).map(|r| r.parents.clone());
                        held_ancestors(&parents.unwrap_or_default())
                    })
                    .collect();
                let last = listing
                    .iter()
                    .filter(|c| !continued.contains(c))
                    .filter_map(|c| self.t.epochs.get(c))
                    .max_by_key(|r| (r.root.created_at(), r.root.chat_id()))
                    .map(|r| r.root.chat_id());
                if let Some(last) = last
                    && !parents.contains(&last)
                    && parents.len() < MAX_ROOT_PARENTS
                {
                    parents.push(last);
                }
            }
        }
        // `L` of §4.6 among the group's roots, leaving out those of owners a handover
        // deposed (§5.9): they are never current here, and a former owner that dates a root
        // at the end of time (D.72) would otherwise date every later root of the group there,
        // which leaves the interim rule only the chat IDs to order them.
        let deposed = self
            .t
            .group_recs
            .get(&group)
            .map(|g| g.deposed.clone())
            .unwrap_or_default();
        let greatest = self
            .group_epochs(&group)
            .iter()
            .filter_map(|c| self.t.epochs.get(c))
            .filter(|r| r.root.owner_id() == self.me || !deposed.contains(&r.root.owner_id()))
            .map(|r| r.root.created_at())
            .max();
        let created_at = next_root_created_at(cx.now, greatest).map_err(NodeError::Root)?;
        let owner_keys = match handover {
            Some(h) => self.keys_of(&h).ok_or(NodeError::UnknownKeys)?,
            None => my_keys.clone(),
        };
        let params = RootParams {
            name: name.unwrap_or_else(|| cur_root.name().to_owned()),
            members: members.iter().copied().collect(),
            group_secret: GroupSecret::from_bytes(bytes(cx.rng)),
            owner: owner_keys,
            epoch_challenge: Challenge::from_bytes(bytes(cx.rng)),
            ref_chat_id_challenge: Challenge::from_bytes(bytes(cx.rng)),
            created_at,
            // §4.1 "Carried forward": the timer and the whole settings map of the current
            // epoch, entries this release does not understand included, so that an owner on
            // an older release never erases what a newer one set. Receivers put no rule
            // between a root's timer or settings and its parents'.
            message_timer,
            settings: cur_root.settings().clone(),
        };
        let root = match handover {
            Some(_) => Root::create_handover(params, &cur_root, signer, bytes(cx.rng)),
            None => Root::create_successor(params, &parents, signer, bytes(cx.rng)),
        }
        .map_err(NodeError::Root)?;
        let id = root.chat_id();
        self.stats.roots_created += 1;
        // One kick per parent epoch and member of it not in the new root, except members
        // whose live leave this device holds (§5.6, D.10).
        let mut kicks: Vec<Kick> = Vec::new();
        let mut foreign: BTreeSet<GossipId> = BTreeSet::new();
        for p in &parents {
            let Some(proot) = self.t.epochs.get(p).map(|r| r.root.clone()) else {
                continue;
            };
            // Only the owner of an epoch signs a kick naming it (§5.6): a new owner resolving
            // a former owner's branch, or naming an epoch of the former owner as the last one
            // of a member added back (§5.10), kicks no one from it.
            if proot.owner_id() != self.me {
                // Counted below when it is an end this root merges (a former owner's
                // branch); the members an earlier epoch lists were dropped long ago.
                if self.gx.children.get(p).is_none_or(BTreeSet::is_empty) {
                    foreign.extend(proot.members().iter().copied());
                }
                continue;
            }
            for m in proot.members() {
                if root.is_member(m) || *m == self.me || leavers.contains(m) {
                    continue;
                }
                kicks.push(Kick::sign(&proot, *m, signer, bytes(cx.rng)).map_err(NodeError::Root)?);
            }
        }
        // A member dropped from such an epoch is told by a kick from an epoch of this owner
        // among the parents, when it is in one; a member only on the former owner's branch is
        // not told (a known limit), counted.
        self.stats.removed_without_kick += foreign
            .iter()
            .filter(|m| {
                !root.is_member(m)
                    && **m != self.me
                    && !leavers.contains(m)
                    && !kicks.iter().any(|k| k.removed() == **m)
            })
            .count() as u64;
        let leaving = !root.is_member(&self.me);
        if leaving {
            self.queued_objects_in_full(group);
        }
        // Install, then deliver: the root to every other member, each kick to the member it
        // names, and every kick to the members in both the parent and the new root (§4.6).
        let installed_parents: Vec<ChatId> = parents
            .iter()
            .filter(|p| self.installed(p))
            .copied()
            .collect();
        if !leaving {
            self.adopt(cx, root.clone(), self.me, installed_parents, false)?;
        }
        let root_blob = leaving
            .then(|| encode_event_blob(&EventObject::Root(Box::new(root.clone()))))
            .transpose()
            .map_err(NodeError::Root)?;
        for m in root.members() {
            if *m == self.me {
                continue;
            }
            match &root_blob {
                Some(b) => self.queue_work(*m, Work::Blob(b.clone())),
                None => self.queue_object(*m, id, EntryItem::Root),
            }
        }
        let mut sends: BTreeMap<GossipId, Vec<usize>> = BTreeMap::new();
        for (i, k) in kicks.iter().enumerate() {
            sends.entry(k.removed()).or_default().push(i);
            if let Some(p) = self.t.epochs.get(&k.chat_id()) {
                for m in p.root.members() {
                    if *m != self.me && *m != k.removed() && root.is_member(m) {
                        sends.entry(*m).or_default().push(i);
                    }
                }
            }
        }
        for (i, k) in kicks.iter().enumerate() {
            let obj = SignedObject::Kick(k.clone());
            self.stats.kicks_created += 1;
            if !leaving {
                self.t.signed.insert(
                    obj.key(),
                    SignedRecord {
                        object: obj.clone(),
                        received_at: cx.now,
                    },
                );
            }
            for (peer, idx) in &sends {
                if !idx.contains(&i) {
                    continue;
                }
                if leaving {
                    let blob =
                        encode_event_blob(&obj.to_event_object()).map_err(NodeError::Root)?;
                    self.queue_work(*peer, Work::Blob(blob));
                } else {
                    self.queue_object(*peer, k.chat_id(), obj.item());
                }
            }
        }
        if let Some(g) = self.t.group_recs.get_mut(&group) {
            g.pending_removals.retain(|m, _| root.is_member(m));
        }
        if leaving {
            self.close_group(cx, group, true);
        }
        self.changed(self.group_of(&id), ChangeKind::Membership, cx.now);
        Ok(id)
    }

    /// Before this device closes `group` ("Hand over and leave", §5.7) or supersedes it
    /// (§5.12): the roots and signed objects of its epochs still queued for a peer, decided
    /// at assembly from records the close erases or that are served no more, are queued again
    /// in full, so that they are still delivered (the parent of the handover root among them).
    pub(crate) fn queued_objects_in_full(&mut self, group: ChatId) {
        let queued: Vec<(super::records::WorkKey, GossipId, ChatId, EntryItem)> = self
            .t
            .queue
            .iter()
            .filter_map(|(k, w)| match w {
                Work::Object { chat_id, item } if self.group_of(chat_id) == group => {
                    Some((*k, k.0, *chat_id, *item))
                }
                _ => None,
            })
            .collect();
        for (key, peer, chat, item) in queued {
            let object = match item {
                EntryItem::Root => self
                    .held_root(&chat)
                    .map(|r| EventObject::Root(Box::new(r.clone()))),
                _ => super::objects::item_key(chat, item)
                    .and_then(|k| self.t.signed.get(&k))
                    .map(|r| r.object.to_event_object()),
            };
            self.remove_queued(&key);
            if let Some(blob) = object.and_then(|o| encode_event_blob(&o).ok()) {
                self.queue_work(peer, Work::Blob(blob));
            }
        }
    }

    /// Owner side (§5.5): a successor without every member whose live leave or request is
    /// held, once 30 seconds passed without a new one, or 5 minutes after the first; never
    /// during an unresolved fork.
    pub(crate) fn auto_successors(
        &mut self,
        cx: &mut Cx<'_>,
        signer: &dyn IdentitySigner,
    ) -> Result<(), NodeError> {
        let groups: Vec<ChatId> = self.sync_groups();
        for group in groups {
            let Some(cur) = self.current_epoch(&group) else {
                continue;
            };
            let Some(root) = self.t.epochs.get(&cur).map(|r| r.root.clone()) else {
                continue;
            };
            if root.owner_id() != self.me {
                // The group was handed over: its requests are the new owner's (§5.4).
                if self
                    .t
                    .group_recs
                    .get(&group)
                    .is_some_and(|g| !g.pending_removals.is_empty())
                {
                    self.group_rec_mut(group).pending_removals.clear();
                }
                continue;
            }
            if !self.fork_to_resolve(&group).is_empty() {
                continue;
            }
            let pending: Vec<(GossipId, u64)> = self
                .t
                .group_recs
                .get(&group)
                .map(|g| {
                    g.pending_removals
                        .iter()
                        .filter(|(m, _)| root.is_member(m) && **m != self.me)
                        .map(|(m, at)| (*m, *at))
                        .collect()
                })
                .unwrap_or_default();
            if pending.is_empty() {
                continue;
            }
            let Some(first) = pending.iter().map(|(_, t)| *t).min() else {
                continue;
            };
            let Some(last) = pending.iter().map(|(_, t)| *t).max() else {
                continue;
            };
            if cx.now < last.saturating_add(SUCCESSOR_QUIET_MS)
                && cx.now < first.saturating_add(SUCCESSOR_MAX_WAIT_MS)
            {
                continue;
            }
            self.stats.auto_successors += 1;
            self.owner_root(
                cx,
                signer,
                group,
                GroupChange::Successor {
                    add: Vec::new(),
                    remove: pending.iter().map(|(m, _)| *m).collect(),
                    name: None,
                },
            )?;
        }
        Ok(())
    }

    /// The owner-only request of `from` naming `chat` (§5.4, §13.6): processed only by the
    /// owner of that epoch, when the immediate peer is a member of it, and when this device
    /// still owns its current epoch.
    pub(crate) fn handle_leave_request(&mut self, cx: &mut Cx<'_>, from: GossipId, chat: ChatId) {
        let Some(rec) = self.t.epochs.get(&chat) else {
            return;
        };
        if rec.status != EpochStatus::Installed
            || rec.root.owner_id() != self.me
            || !rec.root.is_member(&from)
            || from == self.me
        {
            return;
        }
        let group = rec.group;
        let Some(cur) = self.current_epoch(&group) else {
            return;
        };
        let owns = self
            .t
            .epochs
            .get(&cur)
            .is_some_and(|r| r.root.owner_id() == self.me && r.root.is_member(&from));
        if !owns || self.group_status(&group) != GroupStatus::Active {
            return;
        }
        self.stats.leave_requests += 1;
        self.group_rec_mut(group)
            .pending_removals
            .entry(from)
            .or_insert(cx.now);
    }

    /// The timers of the groups: invitation prompts that became due, the daily request of
    /// a waiting group and its end after two weeks (§5.4), and the end of the two weeks a
    /// root is kept after "Dissolve & Delete" (§5.8).
    pub(crate) fn group_timers(&mut self, cx: &mut Cx<'_>) {
        // Unverified handover roots expire after the retention period.
        let old: Vec<ChatId> = self
            .t
            .held_roots
            .iter()
            .filter(|(_, h)| cx.now >= h.at.saturating_add(super::timing::HELD_ROOT_KEEP_MS))
            .map(|(c, _)| *c)
            .collect();
        for c in old {
            self.take_held(&c);
            self.drop_tasks_of(&[c]);
        }
        let invitations: Vec<ChatId> = self
            .t
            .epochs
            .iter()
            .filter(|(_, r)| matches!(r.status, EpochStatus::Invitation(_)))
            .map(|(c, _)| *c)
            .collect();
        for c in invitations {
            if self.prompt_due(&c, cx.now) && !self.t.events.contains(&(c, ChangeKind::Invitation))
            {
                self.changed(c, ChangeKind::Invitation, cx.now);
            }
        }
        let groups: Vec<(ChatId, GroupStatus)> = self
            .t
            .group_recs
            .iter()
            .map(|(g, r)| (*g, r.status))
            .collect();
        for (g, status) in groups {
            match status {
                GroupStatus::Waiting {
                    since,
                    last_request,
                } => {
                    if cx.now >= since.saturating_add(super::objects::WAITING_MS) {
                        // Two weeks without a kick: the device leaves quietly, as "Ignore
                        // and Delete" does. The user stays in the member list for the others,
                        // and the chat's connections go with it (§5.4, §5.12, D.86).
                        self.close_group(cx, g, true);
                    } else if cx.now
                        >= last_request.saturating_add(super::objects::REQUEST_RESEND_MS)
                    {
                        if let Some(cur) = self.current_epoch(&g)
                            && let Some(owner) = self.t.epochs.get(&cur).map(|r| r.root.owner_id())
                            && owner != self.me
                        {
                            self.queue_work(owner, Work::LeaveRequest { chat_id: cur });
                        }
                        if let Some(r) = self.t.group_recs.get_mut(&g) {
                            r.status = GroupStatus::Waiting {
                                since,
                                last_request: cx.now,
                            };
                        }
                    }
                }
                GroupStatus::Dissolved {
                    epoch,
                    must_delete: true,
                    at,
                } if cx.now >= at.saturating_add(super::objects::DISSOLVED_KEPT_MS)
                    && self.t.epochs.contains(&epoch) =>
                {
                    // The named root and the message go; side branches stay (§5.8), in a group
                    // that stays dissolved (see `recheck_status`).
                    let reference = self.held_root(&epoch).map(Root::ref_chat_id);
                    self.drop_epoch(&epoch);
                    self.put_marker(epoch, MarkerKind::Dissolved, reference);
                    self.rebuild_epochs();
                    if self.group_epochs(&g).is_empty() {
                        self.close_group(cx, g, false);
                    } else {
                        self.recheck_status(cx, g);
                    }
                }
                _ => {}
            }
        }
    }

    /// The earliest timer of the groups (for [`Node::next_wakeup`]).
    pub(crate) fn group_wakeup(&self) -> Option<u64> {
        let mut at: Option<u64> = None;
        let mut add = |t: u64| at = Some(at.map_or(t, |a: u64| a.min(t)));
        for (_, h) in self.t.held_roots.iter() {
            add(h.at.saturating_add(super::timing::HELD_ROOT_KEEP_MS));
        }
        for (c, r) in self.t.epochs.iter() {
            if let EpochStatus::Invitation(inv) = &r.status
                && inv.received_at != u64::MAX
                && !self.t.events.contains(&(*c, ChangeKind::Invitation))
            {
                add(inv
                    .received_at
                    .saturating_add(super::timing::PROMPT_DELAY_MS));
            }
        }
        for (key, g) in self.t.group_recs.iter() {
            match g.status {
                GroupStatus::Waiting {
                    since,
                    last_request,
                } => {
                    add(since.saturating_add(super::objects::WAITING_MS));
                    add(last_request.saturating_add(super::objects::REQUEST_RESEND_MS));
                }
                GroupStatus::Dissolved {
                    epoch,
                    must_delete: true,
                    at,
                } if self.t.epochs.contains(&epoch) => {
                    add(at.saturating_add(super::objects::DISSOLVED_KEPT_MS));
                }
                _ => {}
            }
            // Only an owner acts on its pending removals; another device keeps none due.
            let owns = self
                .current_epoch(key)
                .and_then(|c| self.t.epochs.get(&c))
                .is_some_and(|r| r.root.owner_id() == self.me);
            if owns
                && let (Some(first), Some(last)) = (
                    g.pending_removals.values().min(),
                    g.pending_removals.values().max(),
                )
            {
                add(last
                    .saturating_add(SUCCESSOR_QUIET_MS)
                    .min(first.saturating_add(SUCCESSOR_MAX_WAIT_MS)));
            }
        }
        at
    }
}
