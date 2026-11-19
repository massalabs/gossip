//! Signed objects (§5.3, §5.6, §5.8) and keys (§4.3): verification, storage, effects,
//! relay, replies to removed peers (§5.6, §10.4), and closing a group (§14.2).

use std::collections::BTreeSet;

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
use crate::root::RootType;
use crate::wire::{EntryItem, EventObject, SignedKind};

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
        let keys: Vec<(ChatId, GossipId)> = self
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
        if rec.status != EpochStatus::Installed {
            return Ok(Answer::Refused);
        }
        let root = rec.root;
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
                    // The keys are not carried (§5.3): fetched, then verified.
                    if self.t.unverified.len() < UNVERIFIED_LEAVES {
                        self.t.unverified.insert(
                            (chat, l.leaver()),
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
            SignedObject::Kick(k) => {
                root.is_member(&k.removed())
                    && self
                        .kick_authorities(&chat)
                        .iter()
                        .any(|keys| k.verify_with(&root, keys).is_ok())
            }
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
        self.apply_signed(cx, &obj)?;
        Ok(Answer::Supplied)
    }

    /// The identities whose signature makes a kick naming `chat` valid (§5.6, D.18).
    ///
    /// D.18 is open; this follows its recommended choice A: the owner of `chat`, and every
    /// identity to which a held handover root passes ownership from `chat` or one of its
    /// held ancestors, transitively (a handover root signed by an identity already listed,
    /// continuing an epoch of that identity). Only held handover roots count: a removed
    /// member that does not hold the handover cannot verify such a kick (it is dropped, and
    /// no lookup of the handover is made, a simplification of choice A).
    pub(crate) fn kick_authorities(&self, chat: &ChatId) -> Vec<UserPublicKeys> {
        let Some(rec) = self.t.epochs.get(chat) else {
            return Vec::new();
        };
        let mut owners = vec![(rec.root.owner_id(), rec.root.owner_keys().clone())];
        // `chat` and its held ancestors, then the handover roots taken.
        let mut line: BTreeSet<ChatId> = BTreeSet::new();
        let mut stack = vec![*chat];
        while let Some(c) = stack.pop() {
            if line.insert(c)
                && let Some(r) = self.t.epochs.get(&c)
            {
                stack.extend(r.parents.iter().copied());
            }
        }
        loop {
            let mut grew = false;
            for (c, r) in self.t.epochs.iter() {
                if r.status != EpochStatus::Installed
                    || r.root.root_type() != RootType::Handover
                    || line.contains(c)
                {
                    continue;
                }
                let from_line =
                    r.parents.iter().any(|p| {
                        line.contains(p)
                            && self.t.epochs.get(p).is_some_and(|pr| {
                                owners.iter().any(|(o, _)| *o == pr.root.owner_id())
                            })
                    });
                if from_line {
                    line.insert(*c);
                    if !owners.iter().any(|(o, _)| *o == r.root.owner_id()) {
                        owners.push((r.root.owner_id(), r.root.owner_keys().clone()));
                    }
                    grew = true;
                }
            }
            if !grew {
                break;
            }
        }
        owners.into_iter().map(|(_, k)| k).collect()
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
                if self.leave_live_anywhere(&chat, &leaver) {
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
                // Relayed to members of the current epoch who were in the named one.
                let pool: Vec<GossipId> = self
                    .object_pool(&chat, None)
                    .into_iter()
                    .filter(|m| {
                        *m != removed
                            && current
                                .and_then(|c| self.t.epochs.get(&c))
                                .is_some_and(|r| r.root.is_member(m))
                    })
                    .collect();
                self.relay_object(cx, chat, obj.item(), pool);
                self.send_owed(cx, chat, removed);
            }
            SignedObject::Dissolve(d) => {
                let pool = self.object_pool(&chat, None);
                self.relay_object(cx, chat, obj.item(), pool);
                if current == Some(chat)
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

    /// Stops the neighbors, lanes and scans of a group.
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
            // The named epoch and every earlier epoch that leads to it (§5.8).
            let mut erase = BTreeSet::new();
            let mut stack = vec![chat];
            while let Some(c) = stack.pop() {
                if erase.insert(c)
                    && let Some(r) = self.t.epochs.get(&c)
                {
                    stack.extend(r.parents.iter().copied());
                }
            }
            for c in &erase {
                self.erase_messages(*c);
            }
        }
        self.rebuild_epochs();
        self.changed(group, ChangeKind::ReadOnly, cx.now);
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

    /// Closes a group (§14.2): its roots, secrets, messages, signed objects, tasks, hints
    /// and links are removed; with `markers`, a closed-chat marker is kept for each end.
    pub(crate) fn close_group(&mut self, cx: &mut Cx<'_>, group: ChatId, markers: bool) {
        let group = self.group_of(&group);
        let ends = self.ends(&group);
        let epochs: Vec<ChatId> = self
            .t
            .epochs
            .iter()
            .filter(|(_, r)| r.group == group)
            .map(|(c, _)| *c)
            .collect();
        for c in &epochs {
            self.erase_messages(*c);
            self.t.epochs.remove(c);
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
            for e in ends {
                self.t.markers.insert(e, Marker::Closed);
            }
        }
        self.rebuild_epochs();
        self.changed(group, ChangeKind::Closed, cx.now);
    }

    // ── Liveness of a leave (§5.3) ───────────────────────────────────────────

    /// Whether the leave of `member` for `chat` is live for the end `end`: the device holds
    /// `chat`, `end` is `chat` or descends from it, and `member` is a member of every epoch
    /// on at least one path from `chat` to `end` (through installed epochs).
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
        let mut seen = BTreeSet::new();
        let mut stack = vec![*end];
        while let Some(c) = stack.pop() {
            if c == *chat {
                return true;
            }
            if !seen.insert(c) {
                continue;
            }
            if let Some(r) = self.t.epochs.get(&c) {
                for p in &r.parents {
                    if member_of(p) {
                        stack.push(*p);
                    }
                }
            }
        }
        false
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
        if !self.installed(&chat) || self.t.signed.contains(&key) {
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
        if matches!(self.group_status(&chat), GroupStatus::Waiting { .. })
            && matches!(item, EntryItem::Leave(_))
        {
            return;
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

    /// `peer`, removed from `chat`, sent this device a frame for `chat`: it is answered with
    /// the kick naming it or its signed leave, at most three times a day; when this device
    /// holds neither, it looks them up with a removal lookup first (§5.6).
    pub(crate) fn removed_contact(&mut self, cx: &mut Cx<'_>, chat: ChatId, peer: GossipId) {
        if !self.removed_peer(&chat, &peer) {
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
        if !self.send_owed(cx, chat, peer) {
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

    /// Sends `peer` its kick or leave for `chat` if it is owed one and the daily count
    /// allows it. Returns whether a record was held.
    pub(crate) fn send_owed(&mut self, _cx: &mut Cx<'_>, chat: ChatId, peer: GossipId) -> bool {
        let kick = (
            chat,
            SignedKind::Kick,
            *crate::hash::kick_id(&chat, &peer).as_bytes(),
        );
        // A member that missed epochs is still at an older one, which no record of its
        // removal names: it is told of the epoch it was removed from by a root notice (it is
        // a member of it, and fetches it and its parents), and sent the kick of that epoch.
        let (key, later) = if self.t.signed.contains(&kick) {
            (kick, None)
        } else if let Some(leave) = self.leave_for(&chat, &peer) {
            (leave, None)
        } else if let Some(later) = self.later_removal(&chat, &peer) {
            (later, Some(later.0))
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
        self.stats.removal_replies += 1;
        if let Some(epoch) = later {
            self.queue_object_notice(peer, epoch, EntryItem::Root);
        }
        self.queue_object(peer, key.0, key_item(&key));
        true
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
