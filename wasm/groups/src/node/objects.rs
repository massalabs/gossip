//! Signed objects (§5.3, §5.6, §5.8) and keys (§4.3): verification, storage, effects,
//! relay, replies to removed peers (§5.6, §10.4), and closing a group (§14.2).

use std::collections::{BTreeMap, BTreeSet};

use auth::UserPublicKeys;

use super::records::{
    ChangeKind, EpochStatus, GroupStatus, Marker, PendingLeave, ReplyCount, SignedKey,
    SignedObject, SignedRecord, Target, TaskKey, TriggerKind, Work,
};
use super::retrieval::Answer;
use super::timing::DAY_MS;
use super::{Cx, Node, NodeError, PENALTY_MALFORMED};
use crate::hash::leave_id;
use crate::ids::{ChatId, GossipId};
use crate::keys::parse_user_public_keys;
use crate::wire::{EntryItem, EventObject, SignedKind};

/// Roots sent with one removal record to a member that missed epochs, at most.
pub(crate) const ROOTS_PER_REPLY: usize = 16;
/// Answers with a removal record to one removed peer per epoch and day (§5.6).
pub(crate) const REPLIES_PER_DAY: u8 = 3;
/// Leaves kept while the leaver's keys are fetched, at most.
pub(crate) const UNVERIFIED_LEAVES: usize = 1_024;
/// "Dissolve & Delete" keeps the named root and the message two weeks (§5.8).
pub(crate) const DISSOLVED_KEPT_MS: u64 = 14 * DAY_MS;
/// The longest wait for a kick (§5.4).
pub(crate) const WAITING_MS: u64 = 14 * DAY_MS;
/// The owner-only request is sent again every 24 hours (§5.4).
pub(crate) const REQUEST_RESEND_MS: u64 = DAY_MS;

impl SignedObject {
    /// The key of the object: the epoch it names, its kind and its ID.
    #[must_use]
    pub fn key(&self) -> SignedKey {
        match self {
            SignedObject::Leave(l) => (l.chat_id(), SignedKind::Leave, *l.id().as_bytes()),
            SignedObject::Kick(k) => (k.chat_id(), SignedKind::Kick, *k.id().as_bytes()),
            SignedObject::Dissolve(d) => (d.chat_id(), SignedKind::Dissolve, *d.id().as_bytes()),
        }
    }

    /// The notice entry item of the object.
    #[must_use]
    pub fn item(&self) -> EntryItem {
        match self {
            SignedObject::Leave(l) => EntryItem::Leave(l.id()),
            SignedObject::Kick(k) => EntryItem::Kick(k.id()),
            SignedObject::Dissolve(d) => EntryItem::Dissolve(d.id()),
        }
    }

    /// As an event blob's content.
    #[must_use]
    pub fn to_event_object(&self) -> EventObject {
        match self {
            SignedObject::Leave(l) => EventObject::Leave(l.clone()),
            SignedObject::Kick(k) => EventObject::Kick(k.clone()),
            SignedObject::Dissolve(d) => EventObject::Dissolve(d.clone()),
        }
    }
}

/// The key of the object an entry item names in `chat`; `None` for an event or a root.
pub(crate) fn item_key(chat: ChatId, item: EntryItem) -> Option<SignedKey> {
    match item {
        EntryItem::Leave(id) => Some((chat, SignedKind::Leave, *id.as_bytes())),
        EntryItem::Kick(id) => Some((chat, SignedKind::Kick, *id.as_bytes())),
        EntryItem::Dissolve(id) => Some((chat, SignedKind::Dissolve, *id.as_bytes())),
        EntryItem::Event(_) | EntryItem::Root => None,
    }
}

/// The entry item of a signed key.
pub(crate) fn key_item(key: &SignedKey) -> EntryItem {
    match key.1 {
        SignedKind::Leave => EntryItem::Leave(crate::ids::LeaveId::from_bytes(key.2)),
        SignedKind::Kick => EntryItem::Kick(crate::ids::KickId::from_bytes(key.2)),
        SignedKind::Dissolve => EntryItem::Dissolve(crate::ids::DissolveId::from_bytes(key.2)),
    }
}

impl Node {
    // ── Keys (§4.3, §12.9) ───────────────────────────────────────────────────

    /// The verified keys this device holds for `id`.
    pub(crate) fn keys_of(&self, id: &GossipId) -> Option<UserPublicKeys> {
        self.t
            .keys
            .get(id)
            .and_then(|b| parse_user_public_keys(b).ok().map(|(k, _)| k))
    }

    /// Caches verified keys; returns their GossipID.
    pub(crate) fn cache_keys(&mut self, cx: &mut Cx<'_>, bytes: &[u8]) -> Option<GossipId> {
        let (_, id) = parse_user_public_keys(bytes).ok()?;
        if !self.t.keys.contains(&id) {
            self.t.keys.insert(id, bytes.to_vec());
            self.retry_unverified(cx, id);
        }
        Some(id)
    }

    /// Starts fetching every key of the members of `chat` this device does not hold
    /// (§4.3).
    pub(crate) fn fetch_missing_keys(&mut self, cx: &mut Cx<'_>, chat: &ChatId) {
        let Some(root) = self.held_root(chat).cloned() else {
            return;
        };
        for m in root.members() {
            if *m != self.me && !self.t.keys.contains(m) {
                self.trigger(
                    cx,
                    TaskKey {
                        chat_id: *chat,
                        target: Target::Keys(*m),
                    },
                    None,
                );
            }
        }
    }

    /// The leaves waiting for the keys of `id` are verified again.
    fn retry_unverified(&mut self, cx: &mut Cx<'_>, id: GossipId) {
        let keys: Vec<(ChatId, GossipId, GossipId)> = self
            .t
            .unverified
            .keys()
            .filter(|k| k.1 == id)
            .copied()
            .collect();
        for k in keys {
            if let Some(p) = self.t.unverified.remove(&k) {
                // A failure here is the leave's own fault, already counted on arrival.
                let _ = self.receive_signed(cx, p.from, SignedObject::Leave(p.leave), None);
            }
        }
    }

    // ── Receiving (§5.1) ─────────────────────────────────────────────────────

    /// A signed object from `from`, in an event frame or an answer; `expected` is the
    /// requested key for an answer (§12.8). It is verified before anything is stored or
    /// relayed (§5.1): it must name a held epoch of which `from` is a member.
    #[allow(clippy::too_many_lines)]
    pub(crate) fn receive_signed(
        &mut self,
        cx: &mut Cx<'_>,
        from: GossipId,
        obj: SignedObject,
        expected: Option<SignedKey>,
    ) -> Result<Answer, NodeError> {
        let key = obj.key();
        if expected.is_some_and(|e| e != key) {
            return Ok(Answer::Invalid);
        }
        let chat = key.0;
        if self.t.markers.get(&chat) == Some(&Marker::Dissolved) {
            return Ok(Answer::Refused);
        }
        let Some(rec) = self.t.epochs.get(&chat).cloned() else {
            // An epoch this device does not hold cannot be checked: dropped (§5.6).
            return Ok(Answer::Refused);
        };
        // The device's own kick or leave naming an epoch it holds as an invitation, and nothing
        // of its line: a device that lost everything learns from a member's scan that it was
        // removed from that epoch (§4.11, §5.6). It is installed read-only, never prompted.
        let removal_of_invitation = matches!(
            &rec.status,
            EpochStatus::Invitation(i) if i.fetched_for.is_none()
        ) && self.removes_me(&obj, &chat)
            && self.holds_nothing_around(&chat, &rec.root);
        if rec.status != EpochStatus::Installed && !removal_of_invitation {
            return Ok(Answer::Refused);
        }
        let root = rec.root;
        // Any member of the epoch may carry it, a removed peer of it included (§10.4): the
        // signature proves the object, not the carrier (see `object_announced`).
        if !root.is_member(&from) {
            return Ok(Answer::Refused);
        }
        if self.t.signed.contains(&key) {
            if let SignedObject::Leave(l) = &obj
                && l.leaver() == self.me
            {
                self.check_own_leave(cx, self.group_of(&chat));
            }
            return Ok(Answer::Supplied);
        }
        let valid = match &obj {
            SignedObject::Leave(l) => {
                let Some(keys) = self.keys_of(&l.leaver()) else {
                    if !root.is_member(&l.leaver()) {
                        return Ok(Answer::Invalid);
                    }
                    // The keys are not carried (§5.3): fetched, then verified. Kept per
                    // relay, so that a forged copy cannot replace a genuine one, and
                    // bounded per relay and in total; one not kept is not counted supplied.
                    let mine = self.t.unverified.keys().filter(|k| k.2 == from).count();
                    if self.t.unverified.len() >= UNVERIFIED_LEAVES
                        || mine >= super::timing::UNVERIFIED_LEAVES_PER_SENDER
                    {
                        self.stats.capped += 1;
                        return Ok(Answer::Refused);
                    }
                    {
                        self.t.unverified.insert(
                            (chat, l.leaver(), from),
                            PendingLeave {
                                leave: l.clone(),
                                from,
                                at: cx.now,
                            },
                        );
                        self.trigger(
                            cx,
                            TaskKey {
                                chat_id: chat,
                                target: Target::Keys(l.leaver()),
                            },
                            None,
                        );
                    }
                    return Ok(Answer::Supplied);
                };
                l.verify(&root, &keys).is_ok()
            }
            // Only the owner of the epoch it names signs a kick (§5.6): no authority passes
            // through a handover.
            SignedObject::Kick(k) => k.verify(&root).is_ok(),
            SignedObject::Dissolve(d) => d.verify(&root).is_ok(),
        };
        if !valid {
            self.stats.invalid += 1;
            self.penalize(&from, PENALTY_MALFORMED);
            return Ok(Answer::Invalid);
        }
        self.t.signed.insert(
            key,
            SignedRecord {
                object: obj.clone(),
                received_at: cx.now,
            },
        );
        self.stats.signed_stored += 1;
        self.resolve(TaskKey {
            chat_id: chat,
            target: Target::Object(key.1, key.2),
        });
        if removal_of_invitation {
            self.install_removed(cx, chat)?;
        }
        self.apply_signed(cx, &obj)?;
        Ok(Answer::Supplied)
    }

    /// Whether this device holds no installed epoch that `root` (of `chat`) continues or that
    /// continues it: nothing of its line, as after a reinstall.
    fn holds_nothing_around(&self, chat: &ChatId, root: &crate::root::Root) -> bool {
        !self
            .gx
            .epochs
            .values()
            .flatten()
            .any(|c| root.names_parent(c))
            && !self
                .ri
                .named_by
                .get(chat)
                .is_some_and(|s| s.iter().any(|c| self.installed(c)))
    }

    /// Whether `obj` is this device's own kick or own leave naming `chat`.
    fn removes_me(&self, obj: &SignedObject, chat: &ChatId) -> bool {
        match obj {
            SignedObject::Kick(k) => k.removed() == self.me,
            SignedObject::Leave(l) => l.leaver() == self.me && l.chat_id() == *chat,
            SignedObject::Dissolve(_) => false,
        }
    }

    /// Installs the invitation `chat` as a group of its own, which the own kick or leave
    /// about to be applied makes read-only (§5.6, D.2): no prompt, and its parent lookups,
    /// the roots fetched for it and its removal lookup stop. Nothing of the epoch's history
    /// is fetched: a read-only group starts nothing.
    fn install_removed(&mut self, cx: &mut Cx<'_>, chat: ChatId) -> Result<(), NodeError> {
        let Some(rec) = self.take_record(&chat) else {
            return Ok(());
        };
        self.t.events.remove(&(chat, ChangeKind::Invitation));
        self.t.markers.remove(&chat);
        let tasks: Vec<TaskKey> = self
            .t
            .tasks
            .keys()
            .filter(|k| {
                k.chat_id == chat && matches!(k.target, Target::Parent(_) | Target::Removal(_))
            })
            .copied()
            .collect();
        for k in tasks {
            self.resolve(k);
        }
        self.drop_fetched_for(chat);
        self.adopt(cx, rec.root, rec.from, Vec::new(), false)
    }

    /// The effects of a newly stored signed object.
    fn apply_signed(&mut self, cx: &mut Cx<'_>, obj: &SignedObject) -> Result<(), NodeError> {
        let (chat, _, _) = obj.key();
        let group = self.group_of(&chat);
        let current = self.current_epoch(&group);
        let status = self.group_status(&group);
        match obj {
            SignedObject::Leave(l) => {
                let leaver = l.leaver();
                if leaver == self.me {
                    self.check_own_leave(cx, group);
                    return Ok(());
                }
                self.changed(group, ChangeKind::Membership, cx.now);
                // A device no longer active in the group keeps the leave and announces it to
                // no one, as a device that does not hold the epoch (see `retrieves`).
                if self.serves(&chat) && self.leave_live_anywhere(&chat, &leaver) {
                    let pool = self.object_pool(&chat, None);
                    self.relay_object(cx, chat, obj.item(), pool);
                    self.collect_live_leaves(cx, group);
                }
                self.send_owed(cx, chat, leaver);
            }
            SignedObject::Kick(k) => {
                let removed = k.removed();
                if removed == self.me {
                    if matches!(status, GroupStatus::Waiting { .. }) {
                        // §5.4: any held root of the group counts; the kick confirms.
                        self.close_group(cx, group, true);
                        return Ok(());
                    }
                    if current == Some(chat) && status == GroupStatus::Active {
                        self.set_read_only(
                            cx,
                            group,
                            GroupStatus::Removed {
                                epoch: chat,
                                at: cx.now,
                            },
                        );
                    }
                    return Ok(());
                }
                // Relayed to members of the current epoch who were in the named one; by a device
                // no longer active in the group, to no one (see `retrieves`).
                let pool: Vec<GossipId> = self
                    .object_pool(&chat, None)
                    .into_iter()
                    .filter(|m| {
                        *m != removed
                            && self.serves(&chat)
                            && current
                                .and_then(|c| self.t.epochs.get(&c))
                                .is_some_and(|r| r.root.is_member(m))
                    })
                    .collect();
                self.relay_object(cx, chat, obj.item(), pool);
                self.send_owed(cx, chat, removed);
            }
            SignedObject::Dissolve(d) => {
                // A device already no longer active in the group (kicked, left, waiting for a
                // kick, superseded) applies it silently (§5.8, D.74): it announces it to no
                // one and stays in its state, so that it goes on answering as a device that
                // does not hold the epoch; "Dissolve & Delete" still erases its archive.
                // Only a device that was active when it applied the dissolve serves the root
                // and the dissolve message. Why: announcing the dissolve, or serving its root
                // and a page afterwards, told the members that this device kept the chat, which
                // a device that deleted its copy never does.
                let inactive =
                    !matches!(status, GroupStatus::Active | GroupStatus::Dissolved { .. });
                if !inactive {
                    let pool = self.object_pool(&chat, None);
                    self.relay_object(cx, chat, obj.item(), pool);
                }
                // Applied by a device kicked from that epoch, or that left it and keeps it
                // read-only, as by any other (§5.6, §10.4): "Dissolve & Delete" then erases its
                // archive. Why: the deletion is meant to erase the chat on every device that
                // holds the epoch; otherwise the removed member would keep the only transcript
                // of a chat everyone else erased. Single deletion events reach removed peers
                // already (§10.4), and the owner gains nothing it did not have: it could have
                // dissolved with deletion just before the kick. Known drawback: a removed
                // member's archive stays within the owner's reach after the removal; only a
                // dissolve naming an epoch that member holds reaches it, never one of a later
                // epoch.
                if current == Some(chat) && inactive {
                    if d.must_delete() {
                        self.erase_dissolved(group, chat);
                        self.rebuild_epochs();
                        self.changed(group, ChangeKind::ReadOnly, cx.now);
                    }
                } else if current == Some(chat)
                    || matches!(status, GroupStatus::Dissolved { epoch, .. } if epoch == chat)
                {
                    self.apply_dissolve(cx, group, chat, d.must_delete());
                }
            }
        }
        Ok(())
    }

    /// The members of `chat` that may receive its signed objects: not this device and
    /// not `except`.
    pub(crate) fn object_pool(&self, chat: &ChatId, except: Option<GossipId>) -> Vec<GossipId> {
        self.held_root(chat)
            .map(|r| {
                r.members()
                    .iter()
                    .filter(|m| **m != self.me && Some(**m) != except)
                    .copied()
                    .collect()
            })
            .unwrap_or_default()
    }

    /// Makes a group read-only (a kick, D.2): the history stays, the device starts nothing
    /// itself in it any more (§5.6).
    pub(crate) fn set_read_only(&mut self, cx: &mut Cx<'_>, group: ChatId, status: GroupStatus) {
        self.group_rec_mut(group).status = status;
        self.stop_sync(group);
        self.rebuild_epochs();
        self.changed(group, ChangeKind::ReadOnly, cx.now);
    }

    /// Stops the neighbors, lanes and scans of a group: it went inactive, or is closed. Its
    /// lookups send nothing more while it is inactive (see `retrieves`).
    pub(crate) fn stop_sync(&mut self, group: ChatId) {
        self.t.groups.remove(&group);
        let scans: Vec<_> = self
            .t
            .scans_out
            .keys()
            .filter(|k| k.0 == group)
            .copied()
            .collect();
        for k in scans {
            self.t.scans_out.remove(&k);
        }
    }

    /// Applies a dissolve message naming the current epoch `chat` of `group` (§5.8).
    pub(crate) fn apply_dissolve(
        &mut self,
        cx: &mut Cx<'_>,
        group: ChatId,
        chat: ChatId,
        must_delete: bool,
    ) {
        let was = self.group_status(&group);
        let must_delete = must_delete
            || matches!(
                was,
                GroupStatus::Dissolved {
                    must_delete: true,
                    ..
                }
            );
        if matches!(was, GroupStatus::Dissolved { must_delete: d, .. } if d == must_delete) {
            return;
        }
        let at = match was {
            GroupStatus::Dissolved { at, .. } => at,
            _ => cx.now,
        };
        self.group_rec_mut(group).status = GroupStatus::Dissolved {
            epoch: chat,
            must_delete,
            at,
        };
        self.stop_sync(group);
        if must_delete {
            self.erase_dissolved(group, chat);
        }
        self.rebuild_epochs();
        self.changed(group, ChangeKind::ReadOnly, cx.now);
    }

    /// What "Dissolve & Delete" naming `chat`, the current epoch of `group`, erases (§5.8).
    pub(crate) fn erase_dissolved(&mut self, group: ChatId, chat: ChatId) {
        // The named epoch and every earlier epoch that leads to it (§5.8); side
        // branches that do not lead to it are not erased.
        let mut erase = BTreeSet::new();
        let mut stack = vec![chat];
        while let Some(c) = stack.pop() {
            if erase.insert(c)
                && let Some(r) = self.t.epochs.get(&c)
            {
                stack.extend(r.parents.iter().copied());
            }
        }
        // The epochs a remaining side branch descends from keep their root (its line);
        // the others but the named one are deleted at once: only the named root and
        // the message are kept (two weeks by a device that was active, §5.8).
        let mut kept_lines = BTreeSet::new();
        for e in self.ends(&group) {
            if e == chat {
                continue;
            }
            let mut stack = vec![e];
            while let Some(c) = stack.pop() {
                if kept_lines.insert(c)
                    && let Some(r) = self.t.epochs.get(&c)
                {
                    stack.extend(r.parents.iter().copied());
                }
            }
        }
        for c in &erase {
            self.erase_messages(*c);
            // Erased: nothing is fetched into it again, even after a rejoin.
            if let Some(r) = self.t.epochs.get_mut(c) {
                r.state_override = Some(crate::epoch::GroupState::Dissolved);
            }
            if *c != chat && !kept_lines.contains(c) {
                self.drop_epoch(c);
                // A dissolved marker (a chat ID only, §14.2): the same root relayed
                // again is dropped, not an invitation.
                self.t.markers.insert(*c, Marker::Dissolved);
            }
        }
    }

    /// Erases the message records of `chat` at the commit, with the work and hints that
    /// refer to them.
    pub(crate) fn erase_messages(&mut self, chat: ChatId) {
        self.erase.insert(chat);
        let keys: Vec<_> = self
            .t
            .hints
            .keys()
            .filter(|k| k.0 == chat)
            .copied()
            .collect();
        for k in keys {
            self.remove_hint(&k);
        }
        let work: Vec<_> = self
            .t
            .queue
            .iter()
            .filter(|(_, w)| matches!(w, Work::Full { chat_id, .. } | Work::Notice { chat_id, .. } if *chat_id == chat))
            .map(|(k, _)| *k)
            .collect();
        for k in work {
            self.remove_queued(&k);
        }
        let tasks: Vec<TaskKey> = self
            .t
            .tasks
            .keys()
            .filter(|k| k.chat_id == chat && !k.target.is_membership())
            .copied()
            .collect();
        for k in tasks {
            self.t.tasks.remove(&k);
            self.reindex(k);
        }
    }

    /// Deletes one epoch's record and what is kept with it: its signed objects, pending
    /// leaves, reply counts, tasks and messages.
    pub(crate) fn drop_epoch(&mut self, c: &ChatId) {
        self.erase_messages(*c);
        self.take_record(c);
        let signed: Vec<SignedKey> = self
            .t
            .signed
            .keys()
            .filter(|k| k.0 == *c)
            .copied()
            .collect();
        for k in signed {
            self.t.signed.remove(&k);
        }
        let pending: Vec<_> = self
            .t
            .unverified
            .keys()
            .filter(|k| k.0 == *c)
            .copied()
            .collect();
        for k in pending {
            self.t.unverified.remove(&k);
        }
        let replies: Vec<_> = self
            .t
            .replies
            .keys()
            .filter(|k| k.0 == *c)
            .copied()
            .collect();
        for k in replies {
            self.t.replies.remove(&k);
        }
        self.drop_tasks_of(&[*c]);
    }

    /// Closes a group (§14.2): its roots, secrets, messages, signed objects, tasks, hints
    /// and links are removed; with `markers`, a closed-chat marker is kept for each of its
    /// installed epochs.
    ///
    /// §14.2 keeps a marker for each end only. An older epoch would then come back: a
    /// member's tip list for the group the device rejoins names it (§12.1 lists every epoch
    /// of the group the requester is a member of), and a delayed delivery of its root does
    /// too; with no marker it was fetched and offered as a fresh invitation, which accepted
    /// was a second copy of the group, that the device then announced to the other members.
    /// A marker is a chat ID only, and the device held each of these epochs.
    pub(crate) fn close_group(&mut self, cx: &mut Cx<'_>, group: ChatId, markers: bool) {
        let group = self.group_of(&group);
        let installed = self.group_epochs(&group);
        let epochs: Vec<ChatId> = self
            .t
            .epochs
            .iter()
            .filter(|(_, r)| r.group == group)
            .map(|(c, _)| *c)
            .collect();
        for c in &epochs {
            self.erase_messages(*c);
            self.take_record(c);
            let signed: Vec<SignedKey> = self
                .t
                .signed
                .keys()
                .filter(|k| k.0 == *c)
                .copied()
                .collect();
            for k in signed {
                self.t.signed.remove(&k);
            }
            let unverified: Vec<_> = self
                .t
                .unverified
                .keys()
                .filter(|k| k.0 == *c)
                .copied()
                .collect();
            for k in unverified {
                self.t.unverified.remove(&k);
            }
            let replies: Vec<_> = self
                .t
                .replies
                .keys()
                .filter(|k| k.0 == *c)
                .copied()
                .collect();
            for k in replies {
                self.t.replies.remove(&k);
            }
            let frozen: Vec<_> = self
                .t
                .scans_in
                .keys()
                .filter(|k| k.1 == *c)
                .copied()
                .collect();
            for k in frozen {
                self.t.scans_in.remove(&k);
            }
            let work: Vec<_> = self
                .t
                .queue
                .iter()
                .filter(|(_, w)| match w {
                    Work::Object { chat_id, .. } | Work::ObjectNotice { chat_id, .. } => {
                        chat_id == c
                    }
                    Work::NeighborRequest { chat_id } => chat_id == c,
                    _ => false,
                })
                .map(|(k, _)| *k)
                .collect();
            for k in work {
                self.remove_queued(&k);
            }
            let events: Vec<_> = self
                .t
                .events
                .keys()
                .filter(|k| k.0 == *c)
                .copied()
                .collect();
            for k in events {
                self.t.events.remove(&k);
            }
        }
        self.drop_tasks_of(&epochs);
        self.stop_sync(group);
        // The links other groups hold to it.
        let linked: Vec<ChatId> = self
            .t
            .group_recs
            .iter()
            .filter(|(_, g)| g.links.contains(&group))
            .map(|(k, _)| *k)
            .collect();
        for k in linked {
            if let Some(g) = self.t.group_recs.get_mut(&k) {
                g.links.remove(&group);
            }
        }
        self.t.group_recs.remove(&group);
        if markers {
            for e in installed {
                self.t.markers.insert(e, Marker::Closed);
            }
        }
        self.forget_closed(&epochs, group);
        self.rebuild_epochs();
        self.changed(group, ChangeKind::Closed, cx.now);
    }

    /// After a group is closed (§14.2: only a minimal closed-chat marker remains): every
    /// correlation reference, queued work and lookup result naming its epochs goes at once
    /// (a signed leave or decline queued as bytes still leaves), and so do the peer records
    /// and cached keys of every identity that shares no remaining group with this device
    /// (held, invited or waiting). The caller learns the keys of its contacts again through
    /// [`Node::learn_keys`].
    pub(crate) fn forget_closed(&mut self, epochs: &[ChatId], group: ChatId) {
        use super::records::{AnswerOp, Purpose, WorkKey};
        let names = |c: &ChatId| epochs.contains(c) || *c == group;
        let refs: Vec<_> = self
            .t
            .requests
            .iter()
            .filter(|(_, q)| {
                q.entries.iter().any(|e| match e.purpose {
                    Purpose::Task(k) => names(&k.chat_id),
                    Purpose::Scan(g) => names(&g),
                })
            })
            .map(|(k, _)| *k)
            .collect();
        for k in refs {
            self.t.requests.remove(&k);
        }
        // A queued answer to an event or sync-object lookup of these epochs becomes the answer
        // of a device that does not hold them, decided as on receipt: "not available" to a peer
        // that shares an active chat with this device, dropped for any other (§13.7, D.74).
        // Why: the lookup was taken while this device held the epoch; dropping it would leave
        // the asker with silence where a device that never held the epoch answers.
        let lookups: Vec<(WorkKey, GossipId)> = self
            .t
            .queue
            .iter()
            .filter(|(_, w)| {
                matches!(w, Work::Answer {
                    op: AnswerOp::Event { chat_id, .. } | AnswerOp::SyncObj { chat_id, .. },
                    ..
                } if names(chat_id))
            })
            .map(|(k, _)| (*k, k.0))
            .collect();
        for (k, peer) in lookups {
            if let Some(Work::Answer {
                request_id,
                idx,
                sent_at,
                ttl,
                op: AnswerOp::Event { .. } | AnswerOp::SyncObj { .. },
            }) = self.t.queue.get(&k).cloned()
                && self.shares_epoch(&peer)
            {
                self.t.queue.insert(
                    k,
                    Work::Answer {
                        request_id,
                        idx,
                        sent_at,
                        ttl,
                        op: AnswerOp::Status(crate::wire::Status::NotAvailable),
                    },
                );
            } else {
                self.remove_queued(&k);
            }
        }
        let work: Vec<_> = self
            .t
            .queue
            .iter()
            .filter(|(_, w)| match w {
                Work::Full { chat_id, .. }
                | Work::Notice { chat_id, .. }
                | Work::Object { chat_id, .. }
                | Work::ObjectNotice { chat_id, .. }
                | Work::NeighborRequest { chat_id }
                | Work::NeighborResponse { chat_id, .. }
                | Work::LeaveRequest { chat_id } => names(chat_id),
                Work::Query { purpose } => match purpose {
                    Purpose::Task(k) => names(&k.chat_id),
                    Purpose::Scan(g) => names(g),
                },
                Work::Answer { op, .. } => match op {
                    AnswerOp::Event { chat_id, .. }
                    | AnswerOp::SyncObj { chat_id, .. }
                    | AnswerOp::Root { chat_id }
                    | AnswerOp::Object { chat_id, .. } => names(chat_id),
                    AnswerOp::Page { anchor, .. } => names(anchor),
                    AnswerOp::Keys { .. } | AnswerOp::Status(_) => false,
                },
                Work::Blob(_) | Work::VersionNotice => false,
            })
            .map(|(k, _)| *k)
            .collect();
        for k in work {
            self.remove_queued(&k);
        }
        let results: Vec<_> = self
            .t
            .lookup_results
            .keys()
            .filter(|k| names(&k.0))
            .copied()
            .collect();
        for k in results {
            self.t.lookup_results.remove(&k);
        }
        // The identities this device still shares a group with.
        let mut known: BTreeSet<GossipId> = BTreeSet::from([self.me]);
        for (_, r) in self.t.epochs.iter() {
            known.extend(r.root.members().iter().copied());
        }
        for (_, h) in self.t.held_roots.iter() {
            known.extend(h.root.members().iter().copied());
        }
        let peers: Vec<GossipId> = self
            .t
            .peers
            .keys()
            .filter(|p| !known.contains(p))
            .copied()
            .collect();
        for p in peers {
            self.t.peers.remove(&p);
        }
        let keys: Vec<GossipId> = self
            .t
            .keys
            .keys()
            .filter(|p| !known.contains(p))
            .copied()
            .collect();
        for p in keys {
            self.t.keys.remove(&p);
        }
        let backoff: Vec<GossipId> = self
            .t
            .backoff
            .keys()
            .filter(|p| !known.contains(p))
            .copied()
            .collect();
        for p in backoff {
            self.t.backoff.remove(&p);
        }
    }

    // ── Liveness of a leave (§5.3) ───────────────────────────────────────────

    /// Whether the leave of `member` for `chat` is live for the end `end` (§5.3): the device
    /// holds `chat`, `end` is `chat` or descends from it, and `member` is a member of every
    /// held epoch between them (through installed epochs).
    ///
    /// This is stricter than §5.3 ("every epoch on at least one path"): a leave is dead once
    /// a held root on the line from `chat` to `end` omitted the leaver. A root that adds the
    /// leaver back names the epoch it left as an extra parent (§5.10), which would otherwise
    /// make the old leave live again and remove it once more.
    pub(crate) fn leave_live_for(&self, chat: &ChatId, member: &GossipId, end: &ChatId) -> bool {
        let member_of = |c: &ChatId| {
            self.t
                .epochs
                .get(c)
                .is_some_and(|r| r.status == EpochStatus::Installed && r.root.is_member(member))
        };
        if !member_of(chat) || !member_of(end) {
            return false;
        }
        // The held ancestors of `end`, itself included.
        let mut ancestors = BTreeSet::new();
        let mut stack = vec![*end];
        while let Some(c) = stack.pop() {
            if !ancestors.insert(c) {
                continue;
            }
            if let Some(r) = self.t.epochs.get(&c) {
                stack.extend(r.parents.iter().copied());
            }
        }
        if !ancestors.contains(chat) {
            return false;
        }
        // Every one of them that descends from `chat` lists the member.
        let mut between = BTreeSet::new();
        let mut stack = vec![*chat];
        while let Some(c) = stack.pop() {
            if !ancestors.contains(&c) || !between.insert(c) {
                continue;
            }
            if let Some(children) = self.gx.children.get(&c) {
                stack.extend(children.iter().copied());
            }
        }
        // This device's own leave is not live across a root between them with a parent the
        // device does not hold: that parent may be the epoch that left it out (§5.3). Why: a
        // member added back holds the epoch it left and the root that adds it back, never the
        // epoch between that dropped it; its own old leave would otherwise look live again and
        // make it read-only in the group it was added back to.
        // Another member's leave is judged on the epochs held only, as condition 3 reads. Why:
        // otherwise liveness depended on which parents a device holds, and an owner with such
        // a gap (added back itself, or on one side only of a resolved fork) never acted on a
        // late leaver's leave naming an earlier epoch: the leaver stayed listed and no
        // successor came. Known cost: such an owner can apply an old leave of a member added
        // back since and remove it again, which is visible, and the member can be added back.
        let own = *member == self.me;
        between.iter().all(|c| {
            member_of(c)
                && (c == chat
                    || !own
                    || self
                        .t
                        .epochs
                        .get(c)
                        .is_some_and(|r| r.parents.len() == r.root.parents().len()))
        })
    }

    /// Whether the leave is live for the device's current epoch of its group (§5.3).
    pub(crate) fn leave_live(&self, chat: &ChatId, member: &GossipId) -> bool {
        self.current_epoch(chat)
            .is_some_and(|c| self.leave_live_for(chat, member, &c))
    }

    /// Whether the leave is live for the current epoch or, during a fork, for one of the
    /// competing ends (§5.5).
    pub(crate) fn leave_live_anywhere(&self, chat: &ChatId, member: &GossipId) -> bool {
        self.leave_live(chat, member)
            || self
                .fork_to_resolve(chat)
                .iter()
                .any(|e| self.leave_live_for(chat, member, e))
    }

    /// Owner side (§5.5): the members whose leave held by this device is live become
    /// pending removals of `group`, when the device owns its current epoch.
    pub(crate) fn collect_live_leaves(&mut self, cx: &mut Cx<'_>, group: ChatId) {
        let Some(cur) = self.current_epoch(&group) else {
            return;
        };
        if self.t.epochs.get(&cur).map(|r| r.root.owner_id()) != Some(self.me)
            || self.group_status(&group) != GroupStatus::Active
        {
            return;
        }
        let epochs: BTreeSet<ChatId> = self.group_epochs(&group).into_iter().collect();
        let leaves: Vec<(ChatId, GossipId)> = self
            .t
            .signed
            .iter()
            .filter(|(k, _)| epochs.contains(&k.0))
            .filter_map(|(_, r)| match &r.object {
                SignedObject::Leave(l) => Some((l.chat_id(), l.leaver())),
                _ => None,
            })
            .collect();
        for (chat, m) in leaves {
            if m != self.me && self.leave_live_anywhere(&chat, &m) {
                let g = self.group_rec_mut(group);
                g.pending_removals.entry(m).or_insert(cx.now);
            }
        }
    }

    /// The members of `chat` whose live leave this device holds (§5.6: no kick for them).
    pub(crate) fn live_leavers(&self, chat: &ChatId) -> BTreeSet<GossipId> {
        self.t
            .signed
            .iter()
            .filter_map(|(_, r)| match &r.object {
                SignedObject::Leave(l) => Some((l.chat_id(), l.leaver())),
                _ => None,
            })
            .filter(|(c, m)| {
                self.group_of(c) == self.group_of(chat) && self.leave_live_anywhere(c, m)
            })
            .map(|(_, m)| m)
            .collect()
    }

    // ── Announced objects (§5.3, §10.2, §12.1) ───────────────────────────────

    /// A signed object announced by `from` in a notice or a page entry: fetched by a
    /// signed-object lookup unless held. A leave that is not live is ignored without
    /// fetching (§5.3); `from` must be a member of the named epoch.
    ///
    /// `from` may be a removed peer of that epoch: unlike its messages (§10.4), what it
    /// announces is fetched, from it too. Why: a signed object proves itself whoever carries
    /// it, and a removed peer cannot forge one. Refusing it would lose a membership fact when
    /// that peer is the only device online that holds it, and would refuse its own leave
    /// coming from it. The cost is that the lookup tells that peer this device lacked one
    /// membership object, which says nothing about messages or who wrote them.
    pub(crate) fn object_announced(
        &mut self,
        cx: &mut Cx<'_>,
        from: GossipId,
        chat: ChatId,
        item: EntryItem,
        kind: TriggerKind,
    ) {
        let Some(key) = item_key(chat, item) else {
            return;
        };
        // Only in a group where this device is active: an inactive device fetches nothing, as a
        // device that does not hold the epoch (see `retrieves`); what it needs is pushed.
        if !self.serves(&chat) || self.t.signed.contains(&key) {
            return;
        }
        let Some(root) = self.held_root(&chat).cloned() else {
            return;
        };
        if !root.is_member(&from) || from == self.me {
            return;
        }
        if let EntryItem::Leave(id) = item {
            // A device that holds the root finds the member from the roots alone.
            let Some(m) = root
                .members()
                .iter()
                .find(|m| leave_id(&chat, m) == id)
                .copied()
            else {
                return;
            };
            if !self.leave_live_anywhere(&chat, &m) && m != self.me {
                return;
            }
        }
        self.trigger(
            cx,
            TaskKey {
                chat_id: chat,
                target: Target::Object(key.1, key.2),
            },
            Some((from, kind)),
        );
    }

    // ── Replies to removed peers (§5.6, §10.4) ───────────────────────────────

    /// `peer` sent this device a frame for `chat`. Removed from `chat`, it is answered with
    /// the kick naming it or its signed leave, at most three times a day; when this device
    /// holds neither, it looks them up with a removal lookup first (§5.6). The former owner
    /// of a held handover root that `chat` leads to (its parent, or an earlier epoch of its
    /// line) is answered with that root in the same way: a device of the former owner
    /// restored from a backup made before the handover learns that it handed over, and
    /// left if it did.
    ///
    /// A member that left `chat`, or was removed from it, and was added back later is no
    /// removed peer, but its kept leave or kick naming `chat` is sent to it in the same way
    /// (§5.3 "Keeping", §5.6). Why: a device of
    /// that member restored from a backup made before it left still acts in `chat` and would
    /// otherwise adopt the later root silently, as if it had never left; with its leave it
    /// shows the group as left and gets the root that adds it back as an invitation. The
    /// same member, up to date, gets the leave too when it looks up history of `chat`; it
    /// already holds it, so the cost is a few repeated sends a day, under the same limit.
    pub(crate) fn removed_contact(&mut self, cx: &mut Cx<'_>, chat: ChatId, peer: GossipId) {
        let removed = self.removed_peer(&chat, &peer);
        let kept_record = self.kept_removal(chat, peer).is_some();
        if !removed && !kept_record && self.handover_owed(&chat, &peer).is_none() {
            return;
        }
        // A device no longer active in the group stays silent, as one that does not hold the
        // epoch (D.74): no reply, no root, no lookup. An archive still gives a removed peer
        // its own kick or leave (§5.6, see `signed_served_to`).
        let archive = matches!(
            self.group_status(&chat),
            GroupStatus::Dissolved {
                must_delete: false,
                ..
            }
        );
        if !self.serves(&chat) && !archive {
            return;
        }
        let now = cx.now;
        let mut r = self
            .t
            .replies
            .get(&(chat, peer))
            .copied()
            .unwrap_or(ReplyCount {
                since: now,
                count: 0,
                owed: false,
            });
        if now.saturating_sub(r.since) >= DAY_MS {
            r.since = now;
            r.count = 0;
        }
        r.owed = true;
        self.t.replies.insert((chat, peer), r);
        if !self.send_owed(cx, chat, peer) && removed {
            self.trigger(
                cx,
                TaskKey {
                    chat_id: chat,
                    target: Target::Removal(peer),
                },
                None,
            );
        }
    }

    /// The kick naming `peer` in `chat`, or the leave it signed for `chat`, when this device
    /// keeps one (§5.3, §5.6): the kick first, as [`Node::send_owed`] sends it.
    fn kept_removal(&self, chat: ChatId, peer: GossipId) -> Option<SignedKey> {
        let kick = (
            chat,
            SignedKind::Kick,
            *crate::hash::kick_id(&chat, &peer).as_bytes(),
        );
        let leave = (chat, SignedKind::Leave, *leave_id(&chat, &peer).as_bytes());
        [kick, leave]
            .into_iter()
            .find(|k| self.t.signed.contains(k))
    }

    /// `peer` answered a scan of `chat`, this device's current epoch, "not available", and is
    /// about to be told of that root by a root notice (§12.1). When this device keeps the
    /// kick naming `peer` in a parent of `chat`, or the leave `peer` signed for it, it first
    /// sends that record in full, as a reply of [`Node::removed_contact`] to a contact in that
    /// parent, and then the root of `chat` in full, in that order (§5.3 "Keeping", §5.6,
    /// §5.10). One rule for both ways of going out of a group.
    ///
    /// Why: such a root adds `peer` back after it left or was removed. A device of `peer`
    /// restored from a backup made before that still acts in the parent; given the root
    /// first, it would take it as the next epoch of its group, silently, without the prompt
    /// every other member added back gets, and its history would not match what the others
    /// saw. With its record first the group shows as left or removed, and the root then
    /// comes as an invitation, which the user accepts again. A kick applies only to the epoch
    /// it names, so it never removes `peer` from the root that adds it back. Both go as full objects because full objects are carried in the order
    /// they were queued, after the answers of the same plaintext; a root answered to a lookup
    /// would be read before the leave. A device of `peer` that does not hold the parent
    /// cannot check the leave and drops it; one that holds the root already ignores it.
    pub(crate) fn removal_with_root(&mut self, cx: &mut Cx<'_>, chat: ChatId, peer: GossipId) {
        let parents = self
            .t
            .epochs
            .get(&chat)
            .map(|r| r.parents.clone())
            .unwrap_or_default();
        let mut sent = false;
        for p in parents {
            if let Some(key) = self.kept_removal(p, peer) {
                self.removed_contact(cx, p, peer);
                sent |= self.object_queued(peer, p, key_item(&key));
            }
        }
        if sent {
            self.queue_object(peer, chat, EntryItem::Root);
        }
    }

    /// Sends `peer` its kick or leave for `chat`, or the handover root it signed (see
    /// [`Node::removed_contact`]), if it is owed one and the daily count allows it. Returns
    /// whether a record was held.
    pub(crate) fn send_owed(&mut self, _cx: &mut Cx<'_>, chat: ChatId, peer: GossipId) -> bool {
        let kick = (
            chat,
            SignedKind::Kick,
            *crate::hash::kick_id(&chat, &peer).as_bytes(),
        );
        // A member that missed epochs is still at an older one, which no record of its
        // removal names: it is sent the roots of the epochs between (it is a member of
        // each, and a removed peer is answered no lookup, §10.4) and the kick or leave of
        // the epoch it was removed from. A leave of an earlier epoch that is live for
        // `chat` comes with its root and the roots between: the device can tell it applies.
        let (key, chain) = if self.t.signed.contains(&kick) {
            (Some(kick), Vec::new())
        } else if let Some(leave) = self.leave_for(&chat, &peer) {
            // A leave of an earlier epoch is verified against that epoch's root, which the
            // device may not hold (restored from a backup older than it, it got `chat` as an
            // invitation): that root comes first.
            let mut chain = self.line_between(&leave.0, &chat, &peer);
            if leave.0 != chat {
                chain.insert(0, leave.0);
            }
            (Some(leave), chain)
        } else if let Some(later) = self.later_removal(&chat, &peer) {
            let chain = self.line_between(&chat, &later.0, &peer);
            (Some(later), chain)
        } else if let Some(chain) = self.handover_owed(&chat, &peer) {
            // The roots from `chat` to the handover root, which ends the chain.
            (None, chain)
        } else {
            return false;
        };
        let Some(mut r) = self.t.replies.get(&(chat, peer)).copied() else {
            return true;
        };
        if !r.owed || r.count >= REPLIES_PER_DAY {
            return true;
        }
        r.owed = false;
        r.count += 1;
        self.t.replies.insert((chat, peer), r);
        if key.is_some() {
            self.stats.removal_replies += 1;
        } else {
            self.stats.handover_replies += 1;
        }
        for c in chain.into_iter().take(ROOTS_PER_REPLY) {
            if let Some(root) = self.held_root(&c).cloned()
                && let Ok(blob) = crate::wire::encode_event_blob(&EventObject::Root(Box::new(root)))
            {
                self.queue_work(peer, Work::Blob(blob));
            }
        }
        if let Some(key) = key {
            self.queue_object(peer, key.0, key_item(&key));
        }
        true
    }

    /// When `peer` is the former owner of a held handover root that `chat` leads to, the
    /// roots to send it, ending with that handover root (§5.6): `chat` is the handover's
    /// parent; or, for a removed peer of `chat`, an earlier epoch from which a line of epochs
    /// `peer` is a member of leads to it (the roots between come first, D.62); or `chat` is
    /// the handover root itself, which does not list `peer`. A former owner still a member
    /// that acts in an earlier epoch is not answered: it edits its messages there (§10.4),
    /// and its recovery takes it past them. The latest such handover when there are several.
    /// `None` for any other peer: only an owner a handover deposed here is looked for.
    pub(crate) fn handover_owed(&self, chat: &ChatId, peer: &GossipId) -> Option<Vec<ChatId>> {
        let group = self.group_of(chat);
        let removed = self.removed_peer(chat, peer);
        // An epoch of the former owner's own that does not lead to the handover: a competing
        // branch it still follows.
        let own_branch = self
            .t
            .epochs
            .get(chat)
            .is_some_and(|r| r.root.owner_id() == *peer);
        if *peer == self.me
            || !self
                .t
                .group_recs
                .get(&group)
                .is_some_and(|g| g.deposed.contains(peer))
        {
            return None;
        }
        self.t
            .epochs
            .iter()
            .filter(|(_, r)| {
                r.group == group
                    && r.status == EpochStatus::Installed
                    && r.root.root_type() == crate::root::RootType::Handover
                    && r.parents
                        .first()
                        .and_then(|p| self.t.epochs.get(p))
                        .is_some_and(|p| p.root.owner_id() == *peer)
            })
            .filter_map(|(h, r)| {
                let chain = if h == chat {
                    if r.root.is_member(peer) {
                        return None;
                    }
                    vec![*h]
                } else if r.parents.first() == Some(chat) {
                    self.line_between(chat, h, peer)
                } else if removed || own_branch {
                    // From `chat` when it leads to the handover (for a removed peer only: a
                    // member edits its messages in older epochs, §10.4); otherwise, for a
                    // competing branch of the former owner's own, from the nearest ancestor
                    // of `chat` that leads to it, which the former owner holds.
                    let direct = self.line_between(chat, h, peer);
                    if !direct.is_empty() {
                        if !removed {
                            return None;
                        }
                        direct
                    } else {
                        self.held_ancestors_of(chat)
                            .into_iter()
                            .map(|x| self.line_between(&x, h, peer))
                            .find(|c| !c.is_empty())
                            .unwrap_or_default()
                    }
                } else {
                    return None;
                };
                (!chain.is_empty()).then_some(((r.root.created_at(), *h), chain))
            })
            .max_by_key(|(k, _)| *k)
            .map(|(_, chain)| chain)
    }

    /// A valid handover root `handover` this device signed, as the owner of its held parent
    /// `parent`, and in which it is no member: a copy of this account handed the group over
    /// and left ("Hand over and leave", §5.7), and this device, restored from a backup made
    /// before, still owns the group, on that line or on a competing branch of its own (the
    /// handover deposes it on every branch, §5.9). It adopts the consequence: the group
    /// becomes read-only, "You left". Nothing changes when the group was handed back to it
    /// since (a held handover root naming it, later than `handover`), or when its current
    /// epoch is not its own.
    pub(crate) fn left_by_handover(
        &mut self,
        cx: &mut Cx<'_>,
        parent: ChatId,
        handover: &crate::root::Root,
    ) {
        let group = self.group_of(&parent);
        if self.group_status(&group) != GroupStatus::Active {
            return;
        }
        let Some(current) = self.current_epoch(&group) else {
            return;
        };
        let owns = self
            .t
            .epochs
            .get(&current)
            .is_some_and(|r| r.root.owner_id() == self.me);
        let handed_back = self.t.epochs.iter().any(|(_, r)| {
            r.group == group
                && r.status == EpochStatus::Installed
                && r.root.root_type() == crate::root::RootType::Handover
                && r.root.owner_id() == self.me
                && r.root.created_at() > handover.created_at()
        });
        if !owns || handed_back {
            return;
        }
        self.stats.handovers_learnt += 1;
        self.set_read_only(
            cx,
            group,
            GroupStatus::Left {
                epoch: current,
                at: cx.now,
            },
        );
    }

    /// The held ancestors of `chat`, nearest first (breadth first), `chat` excluded.
    fn held_ancestors_of(&self, chat: &ChatId) -> Vec<ChatId> {
        let mut out = Vec::new();
        let mut seen = BTreeSet::from([*chat]);
        let mut queue = std::collections::VecDeque::from([*chat]);
        while let Some(c) = queue.pop_front() {
            for p in self
                .t
                .epochs
                .get(&c)
                .map(|r| r.parents.clone())
                .unwrap_or_default()
            {
                if seen.insert(p) {
                    out.push(p);
                    queue.push_back(p);
                }
            }
        }
        out
    }

    /// The installed epochs after `anc` up to `desc` on a line of epochs `peer` is a member
    /// of, from `anc`'s side; empty when there is none.
    fn line_between(&self, anc: &ChatId, desc: &ChatId, peer: &GossipId) -> Vec<ChatId> {
        let member = |c: &ChatId| {
            self.t
                .epochs
                .get(c)
                .is_some_and(|r| r.status == EpochStatus::Installed && r.root.is_member(peer))
        };
        let mut next: BTreeMap<ChatId, ChatId> = BTreeMap::new();
        let mut seen = BTreeSet::from([*desc]);
        let mut stack = vec![*desc];
        let mut found = false;
        while let Some(c) = stack.pop() {
            if c == *anc {
                found = true;
                break;
            }
            for p in self
                .t
                .epochs
                .get(&c)
                .map(|r| r.parents.clone())
                .unwrap_or_default()
            {
                if member(&p) && seen.insert(p) {
                    next.insert(p, c);
                    stack.push(p);
                }
            }
        }
        if !found {
            return Vec::new();
        }
        let mut out = Vec::new();
        let mut c = *anc;
        while let Some(n) = next.get(&c) {
            out.push(*n);
            c = *n;
        }
        out
    }

    /// The kick or leave of `peer` held for a later epoch of the group of `chat` that
    /// descends from `chat` through epochs `peer` is a member of: the epoch it was removed
    /// from, or left, after the ones it is behind (the latest such record).
    fn later_removal(&self, chat: &ChatId, peer: &GossipId) -> Option<SignedKey> {
        let group = self.group_of(chat);
        self.t
            .signed
            .iter()
            .filter_map(|(k, r)| match &r.object {
                SignedObject::Kick(kick) if kick.removed() == *peer && k.0 != *chat => {
                    Some((*k, kick.chat_id()))
                }
                SignedObject::Leave(l) if l.leaver() == *peer && k.0 != *chat => {
                    Some((*k, l.chat_id()))
                }
                _ => None,
            })
            .filter(|(_, e)| self.group_of(e) == group && self.leave_live_for(chat, peer, e))
            .max_by_key(|(_, e)| self.t.epochs.get(e).map(|r| r.root.created_at()))
            .map(|(k, _)| k)
    }

    /// D.2, choice A: a leave of this device, from a copy of the account restored or used
    /// elsewhere, that applies to its current epoch makes the group read-only. "Applies" is
    /// read as "is live for the current epoch" (§5.3): the leave may name an earlier epoch
    /// when the leaver had missed later ones, while D.2 speaks of the current epoch only.
    pub(crate) fn check_own_leave(&mut self, cx: &mut Cx<'_>, group: ChatId) {
        if self.group_status(&group) != GroupStatus::Active {
            return;
        }
        let Some(current) = self.current_epoch(&group) else {
            return;
        };
        let mine: Vec<ChatId> = self
            .t
            .signed
            .iter()
            .filter_map(|(_, r)| match &r.object {
                SignedObject::Leave(l) if l.leaver() == self.me => Some(l.chat_id()),
                _ => None,
            })
            .filter(|c| self.group_of(c) == group)
            .collect();
        if let Some(epoch) = mine
            .into_iter()
            .find(|c| self.leave_live_for(c, &self.me, &current))
        {
            self.set_read_only(cx, group, GroupStatus::Left { epoch, at: cx.now });
        }
    }

    /// The signed leave of `peer` held by this device that applies to `chat`: the one
    /// naming `chat`, or one naming an earlier epoch from which it is live for `chat`
    /// (§5.3). A member that missed an epoch signs its leave of an older one, and the owner
    /// applies it with no kick (§5.6): nothing else names the epoch it was removed from.
    pub(crate) fn leave_for(&self, chat: &ChatId, peer: &GossipId) -> Option<SignedKey> {
        let exact = (*chat, SignedKind::Leave, *leave_id(chat, peer).as_bytes());
        if self.t.signed.contains(&exact) {
            return Some(exact);
        }
        let group = self.group_of(chat);
        self.t
            .signed
            .iter()
            .filter_map(|(k, r)| match &r.object {
                SignedObject::Leave(l) if l.leaver() == *peer => Some((*k, l.chat_id())),
                _ => None,
            })
            .find(|(_, c)| self.group_of(c) == group && self.leave_live_for(c, peer, chat))
            .map(|(k, _)| k)
    }
}
