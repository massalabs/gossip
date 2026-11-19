//! Groups and their epochs (§4.8, §4.9, §5.9, §5.10, §10.4, §14.1): the epoch and group
//! records, what is derived from them (ends, current epoch, removed peers), and receiving,
//! validating and adopting roots.
//!
//! A group is keyed by the ID of one of its epochs (local, never sent). Its installed epochs
//! are linked by the parents each root continues with verified authority (§4.7); two groups
//! that a root links are merged.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;

use super::records::{
    ChangeKind, EpochRecord, EpochStatus, GroupRecord, GroupStatus, HeldRoot, Invitation, Marker,
    Target, TaskKey, TriggerKind, Work,
};
use super::retrieval::Answer;
use super::{Cx, EpochEntry, Node, NodeError, PENALTY_ROOT_ANNOUNCEMENT};
use crate::constants::PROMPT_DELAY_MS;
use crate::epoch::GroupState;
use crate::ids::{ChatId, GossipId, ParentCommitment};
use crate::root::{Root, RootType};
use crate::wire::EntryItem;

/// Handover roots kept while their parent is looked up, at most (§4.7). Provisional.
pub(crate) const HELD_ROOTS: usize = 64;
/// Members answering "not available" to a parent lookup that show the prompt early (§4.8).
pub(crate) const PROMPT_NOT_AVAILABLE: usize = 3;

/// The groups and epochs derived from the records, rebuilt after every change of them.
#[derive(Debug, Default)]
pub(crate) struct GroupIndex {
    /// The installed epochs of each group.
    pub(crate) epochs: BTreeMap<ChatId, BTreeSet<ChatId>>,
    /// The installed epochs that continue each epoch.
    pub(crate) children: BTreeMap<ChatId, BTreeSet<ChatId>>,
    /// The current epoch of each group (§4.9, §5.9).
    pub(crate) current: BTreeMap<ChatId, ChatId>,
}

/// How a root reached this device.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Via {
    /// In full in an event frame, from a member (§4.6, §9.4).
    Direct,
    /// As the answer to a chat lookup by ID or by reference (§12.7).
    Lookup,
    /// As the answer to a parent lookup (§4.8).
    Parent,
}

impl Node {
    // ── Derived state ────────────────────────────────────────────────────────

    /// Rebuilds the installed epochs and the group index from the records.
    pub(crate) fn rebuild_epochs(&mut self) {
        let mut gx = GroupIndex::default();
        for (chat, rec) in self.t.epochs.iter() {
            if rec.status != EpochStatus::Installed {
                continue;
            }
            gx.epochs.entry(rec.group).or_default().insert(*chat);
            for p in &rec.parents {
                gx.children.entry(*p).or_default().insert(*chat);
            }
        }
        for (group, epochs) in &gx.epochs {
            if let Some(c) = self.compute_current(group, epochs, &gx.children) {
                gx.current.insert(*group, c);
            }
        }
        let mut entries = BTreeMap::new();
        for (chat, rec) in self.t.epochs.iter() {
            if rec.status != EpochStatus::Installed {
                continue;
            }
            let group = rec.group;
            let current = gx.current.get(&group).copied();
            let superseded = gx.children.get(chat).is_some_and(|c| !c.is_empty());
            let mut removed = rec.removed_override.clone();
            if superseded && let Some(cur) = current.and_then(|c| self.t.epochs.get(&c)) {
                for m in rec.root.members() {
                    if !cur.root.is_member(m) {
                        removed.insert(*m);
                    }
                }
            }
            let state = rec.state_override.unwrap_or_else(|| {
                match self.t.group_recs.get(&group).map(|g| g.status) {
                    Some(GroupStatus::Removed { .. } | GroupStatus::Left { .. }) => {
                        GroupState::ReadOnlyAfterKick
                    }
                    Some(GroupStatus::Waiting { .. }) => GroupState::Waiting,
                    Some(GroupStatus::Dissolved { .. }) => GroupState::Dissolved,
                    Some(GroupStatus::Active) | None => GroupState::Active,
                }
            });
            // An unchanged entry is kept, so that the `Arc`s held by an operation stay
            // current.
            let entry = match self.epochs.get(chat) {
                Some(e) if e.state == state && e.removed == removed => Arc::clone(e),
                _ => Arc::new(EpochEntry {
                    root: rec.root.clone(),
                    accepted: true,
                    state,
                    removed,
                }),
            };
            entries.insert(*chat, entry);
        }
        self.epochs = entries;
        self.gx = gx;
    }

    /// The current epoch of a group among its installed `epochs` (§4.9, §5.9): among the
    /// ends, those of the followed owner's line; the greatest `(created_at, chat_id)` among
    /// them (the interim rule).
    fn compute_current(
        &self,
        group: &ChatId,
        epochs: &BTreeSet<ChatId>,
        children: &BTreeMap<ChatId, BTreeSet<ChatId>>,
    ) -> Option<ChatId> {
        let ends: Vec<&EpochRecord> = epochs
            .iter()
            .filter(|c| children.get(c).is_none_or(BTreeSet::is_empty))
            .filter_map(|c| self.t.epochs.get(c))
            .collect();
        let g = self.t.group_recs.get(group);
        let followed = g.and_then(|g| g.followed);
        let in_line: Vec<&&EpochRecord> = ends
            .iter()
            .filter(|e| Some(e.root.owner_id()) == followed)
            .collect();
        let pool: Vec<&&EpochRecord> = if in_line.is_empty() {
            let not_deposed: Vec<&&EpochRecord> = ends
                .iter()
                .filter(|e| g.is_none_or(|g| !g.deposed.contains(&e.root.owner_id())))
                .collect();
            if not_deposed.is_empty() {
                ends.iter().collect()
            } else {
                not_deposed
            }
        } else {
            in_line
        };
        pool.iter()
            .max_by_key(|e| (e.root.created_at(), e.root.chat_id()))
            .map(|e| e.root.chat_id())
    }

    /// The key of the group of `chat`; `chat` itself when it is not held.
    pub(crate) fn group_of(&self, chat: &ChatId) -> ChatId {
        self.t.epochs.get(chat).map_or(*chat, |r| r.group)
    }

    /// The current epoch of a group, if it has an installed epoch.
    pub(crate) fn current_epoch(&self, group: &ChatId) -> Option<ChatId> {
        self.gx.current.get(&self.group_of(group)).copied()
    }

    /// The current epoch of the group with key `group`, or `group` itself (the anchor of
    /// its scans and the epoch of its neighbors, §10.1, §12.1).
    pub(crate) fn cur(&self, group: &ChatId) -> ChatId {
        self.current_epoch(group).unwrap_or(*group)
    }

    /// The installed epochs of the group of `chat`.
    pub(crate) fn group_epochs(&self, chat: &ChatId) -> Vec<ChatId> {
        self.gx
            .epochs
            .get(&self.group_of(chat))
            .map(|s| s.iter().copied().collect())
            .unwrap_or_default()
    }

    /// The ends of the group of `chat` (§4.9).
    pub(crate) fn ends(&self, chat: &ChatId) -> Vec<ChatId> {
        self.group_epochs(chat)
            .into_iter()
            .filter(|c| self.gx.children.get(c).is_none_or(BTreeSet::is_empty))
            .collect()
    }

    /// The ends the owner of the current epoch must resolve (§4.9, §5.9): two or more ends
    /// whose owners are that owner or a previous owner in its line (it may take their
    /// branches as parents, §4.7). Ends of a rival line, owned by another identity the same
    /// former owner handed the group to, are side branches it cannot resolve.
    ///
    /// §5.9 says the new owner "may" resolve a branch of the former owner; it is treated as
    /// a fork to resolve so that the members of that branch only are not left behind.
    pub(crate) fn fork_to_resolve(&self, group: &ChatId) -> Vec<ChatId> {
        let Some(cur) = self.current_epoch(group) else {
            return Vec::new();
        };
        let Some(owner) = self.t.epochs.get(&cur).map(|r| r.root.owner_id()) else {
            return Vec::new();
        };
        let authority = self.line_authority(owner, &[cur]);
        let ends: Vec<ChatId> = self
            .ends(group)
            .into_iter()
            .filter(|c| {
                self.t
                    .epochs
                    .get(c)
                    .is_some_and(|r| authority.contains(&r.root.owner_id()))
            })
            .collect();
        if ends.len() > 1 { ends } else { Vec::new() }
    }

    /// The group keys that run neighbors, lanes and scans: active groups with an installed
    /// epoch.
    pub(crate) fn sync_groups(&self) -> Vec<ChatId> {
        self.gx
            .current
            .keys()
            .filter(|g| self.group_status(g) == GroupStatus::Active)
            .copied()
            .collect()
    }

    /// The status of the group of `chat`.
    pub(crate) fn group_status(&self, chat: &ChatId) -> GroupStatus {
        self.t
            .group_recs
            .get(&self.group_of(chat))
            .map_or(GroupStatus::Active, |g| g.status)
    }

    /// The root of `chat`, if held: installed, an invitation, or a handover root kept
    /// while its parent is looked up.
    pub(crate) fn held_root(&self, chat: &ChatId) -> Option<&Root> {
        self.t
            .epochs
            .get(chat)
            .map(|r| &r.root)
            .or_else(|| self.t.held_roots.get(chat).map(|h| &h.root))
    }

    /// Whether `chat` is installed.
    pub(crate) fn installed(&self, chat: &ChatId) -> bool {
        self.t
            .epochs
            .get(chat)
            .is_some_and(|r| r.status == EpochStatus::Installed)
    }

    /// Records a change for the caller (coalesced per group and kind).
    pub(crate) fn changed(&mut self, group: ChatId, kind: ChangeKind, now: u64) {
        if !self.t.events.contains(&(group, kind)) {
            self.t.events.insert((group, kind), now);
        }
    }

    pub(crate) fn group_rec_mut(&mut self, group: ChatId) -> &mut GroupRecord {
        if !self.t.group_recs.contains(&group) {
            self.t.group_recs.insert(
                group,
                GroupRecord {
                    status: GroupStatus::Active,
                    followed: None,
                    deposed: BTreeSet::new(),
                    links: BTreeSet::new(),
                    local_name: None,
                    pending_removals: BTreeMap::new(),
                    junctions: Vec::new(),
                },
            );
        }
        self.t.group_recs.get_mut(&group).expect("inserted")
    }

    // ── Authority (§4.7, §5.9) ───────────────────────────────────────────────

    /// The owners with authority in the line of a root owned by `owner` whose held parents
    /// are `parents`: `owner` itself, and each previous owner that signed a held handover
    /// root on a path leading to one of `parents` whose new owner has authority (§4.7).
    pub(crate) fn line_authority(&self, owner: GossipId, parents: &[ChatId]) -> BTreeSet<GossipId> {
        let mut auth = BTreeSet::from([owner]);
        // The held ancestors of the parents, bounded by what is held.
        let mut seen: BTreeSet<ChatId> = BTreeSet::new();
        let mut stack: Vec<ChatId> = parents.to_vec();
        while let Some(c) = stack.pop() {
            if !seen.insert(c) {
                continue;
            }
            if let Some(r) = self.t.epochs.get(&c) {
                stack.extend(r.parents.iter().copied());
            }
        }
        loop {
            let mut grew = false;
            for c in &seen {
                let Some(r) = self.t.epochs.get(c) else {
                    continue;
                };
                if r.root.root_type() != RootType::Handover || !auth.contains(&r.root.owner_id()) {
                    continue;
                }
                for p in &r.parents {
                    if let Some(prev) = self.t.epochs.get(p).map(|pr| pr.root.owner_id())
                        && auth.insert(prev)
                    {
                        grew = true;
                    }
                }
            }
            if !grew {
                return auth;
            }
        }
    }

    /// The epochs among `held` (held parents named by `root`) over which the owner of
    /// `root` has verified authority (§4.7): for a handover root, its parent, whose owner
    /// signed it (the signature was verified against that parent on receipt); for a
    /// successor root, the parents owned by its owner or by a previous owner in its line,
    /// judged with all of `held`.
    pub(crate) fn authorized_parents(&self, root: &Root, held: &[ChatId]) -> Vec<ChatId> {
        let held: Vec<ChatId> = held
            .iter()
            .filter(|c| root.names_parent(c) && self.t.epochs.contains(c))
            .copied()
            .collect();
        if root.root_type() == RootType::Handover {
            return held;
        }
        let authority = self.line_authority(root.owner_id(), &held);
        held.into_iter()
            .filter(|c| {
                self.t
                    .epochs
                    .get(c)
                    .is_some_and(|r| authority.contains(&r.root.owner_id()))
            })
            .collect()
    }

    // ── Receiving a root (§4.7, §4.8) ────────────────────────────────────────

    /// A root from `from` (§4.7, §4.8). Returns how a task counts it.
    #[allow(clippy::too_many_lines)]
    pub(crate) fn receive_root(
        &mut self,
        cx: &mut Cx<'_>,
        from: GossipId,
        root: Root,
        via: Via,
    ) -> Result<Answer, NodeError> {
        let id = root.chat_id();
        match self.t.markers.get(&id) {
            Some(Marker::Dissolved) => return Ok(Answer::Refused),
            Some(Marker::Closed) if via != Via::Direct => return Ok(Answer::Refused),
            _ => {}
        }
        if self.t.epochs.contains(&id) {
            // A duplicate changes nothing (§4.7).
            return Ok(Answer::Supplied);
        }
        // §4.7 steps 4 and 5. The delivering peer of a handover root may also be the owner
        // of its parent, who signed it and may have left in it ("Hand over and leave", §5.7:
        // the outgoing owner sends the root it is no longer a member of).
        let signer_left = root.root_type() == RootType::Handover
            && self
                .t
                .epochs
                .iter()
                .any(|(c, r)| root.names_parent(c) && r.root.owner_id() == from);
        if !root.is_member(&self.me) || !(root.is_member(&from) || signer_left) || from == self.me {
            self.failed_announcement(cx, &from);
            return Ok(Answer::Invalid);
        }
        // Step 6: the held roots and closed-chat markers its commitments name.
        let candidates: Vec<ChatId> = self
            .t
            .epochs
            .keys()
            .copied()
            .chain(self.t.markers.keys().copied())
            .collect();
        let matched = root.match_parents(candidates.iter());
        // Step 7.
        let handover_parent = if root.root_type() == RootType::Handover {
            let parent = matched.iter().find(|c| self.t.epochs.contains(c)).copied();
            let Some(parent) = parent else {
                // Discarded without penalty; the parent is looked up (§4.7).
                self.hold_handover(cx, from, root);
                return Ok(Answer::Supplied);
            };
            Some(parent)
        } else {
            None
        };
        let parent_root =
            handover_parent.and_then(|p| self.t.epochs.get(&p).map(|r| r.root.clone()));
        if root.verify_signature(parent_root.as_ref()).is_err() {
            self.failed_announcement(cx, &from);
            return Ok(Answer::Invalid);
        }
        self.t.held_roots.remove(&id);
        let closed_before = self.t.markers.get(&id) == Some(&Marker::Closed);
        // Continuity (§4.7): the held parents over which the owner has authority.
        let held: Vec<ChatId> = matched
            .iter()
            .filter(|c| self.t.epochs.contains(c))
            .copied()
            .collect();
        let authorized = self.authorized_parents(&root, &held);
        let installed: Vec<ChatId> = authorized
            .iter()
            .filter(|c| self.installed(c))
            .copied()
            .collect();
        // Case 1, closed by the user: a full root delivered directly prompts again.
        if closed_before {
            self.invite(cx, from, root, Vec::new(), true, None, via);
            return Ok(Answer::Supplied);
        }
        // Case 2: a retained member.
        let retained: Vec<ChatId> = installed
            .iter()
            .filter(|c| self.group_status(c) == GroupStatus::Active)
            .copied()
            .collect();
        if !retained.is_empty() {
            self.adopt(cx, root, from, installed, true)?;
            return Ok(Answer::Supplied);
        }
        // Case 3: a parent matches a closed-chat marker.
        if matched
            .iter()
            .any(|c| self.t.markers.get(c) == Some(&Marker::Closed))
        {
            self.t.markers.insert(id, Marker::Closed);
            return Ok(Answer::Supplied);
        }
        // Case 4: kicked, dissolved or waiting.
        if let Some(p) = installed.first().copied() {
            match self.group_status(&p) {
                GroupStatus::Waiting { .. } => {
                    // Kept without a prompt, so that the current epoch names the right owner
                    // (§5.4).
                    self.adopt(cx, root, from, installed, false)?;
                }
                _ => self.invite(cx, from, root, Vec::new(), false, Some(p), via),
            }
            return Ok(Answer::Supplied);
        }
        // Case 5: no parent matched; the unmatched ones are looked up first.
        let unmatched: Vec<ParentCommitment> = root
            .parents()
            .iter()
            .filter(|c| !matched.iter().any(|m| root.commitment_for(m) == **c))
            .copied()
            .collect();
        self.invite(cx, from, root, unmatched, false, None, via);
        Ok(Answer::Supplied)
    }

    /// Keeps a handover root whose parent is not held, and looks the parent up (§4.7).
    fn hold_handover(&mut self, cx: &mut Cx<'_>, from: GossipId, root: Root) {
        let id = root.chat_id();
        if self.t.held_roots.len() >= HELD_ROOTS && !self.t.held_roots.contains(&id) {
            return;
        }
        let commitment = root.parents()[0];
        self.t.held_roots.insert(
            id,
            HeldRoot {
                root,
                from,
                at: cx.now,
            },
        );
        self.trigger(
            cx,
            TaskKey {
                chat_id: id,
                target: Target::Parent(commitment),
            },
            Some((from, TriggerKind::Notice)),
        );
    }

    /// A failed root announcement by `peer` (§11.8): a large penalty, and after three within
    /// 24 hours its root notices and shared-chats pages are not acted on for an hour,
    /// doubling on each repeat up to 24 hours.
    pub(crate) fn failed_announcement(&mut self, cx: &mut Cx<'_>, peer: &GossipId) {
        use super::timing::{DAY_MS, HOUR_MS};
        self.stats.invalid += 1;
        self.stats.failed_announcements += 1;
        self.penalize(peer, PENALTY_ROOT_ANNOUNCEMENT);
        let now = cx.now;
        let r = self.peer_mut(peer);
        r.failed_announcements
            .retain(|t| now.saturating_sub(*t) < DAY_MS);
        r.failed_announcements.push(now);
        if r.failed_announcements.len() >= 3 {
            r.failed_announcements.clear();
            r.pause_ms = if r.paused_until == 0 {
                HOUR_MS
            } else {
                (r.pause_ms.saturating_mul(2)).clamp(HOUR_MS, DAY_MS)
            };
            r.paused_until = now.saturating_add(r.pause_ms);
            self.stats.announcer_pauses += 1;
        }
    }

    /// Whether the root notices and shared-chats pages of `peer` are not acted on (§11.8).
    pub(crate) fn announcer_paused(&self, peer: &GossipId, now: u64) -> bool {
        self.t.peers.get(peer).is_some_and(|r| r.paused_until > now)
    }

    /// Adopts a valid root (§4.8 case 2, a waiting group, or an accepted invitation): the
    /// epoch is installed in the group of its `parents` (merging the groups they belong
    /// to), or in a new group; the time `T` of its line is computed and stored (§7.5); keys
    /// are fetched and tips scanned (§4.3, §12.3). `relay` announces it by root notice.
    pub(crate) fn adopt(
        &mut self,
        cx: &mut Cx<'_>,
        root: Root,
        from: GossipId,
        parents: Vec<ChatId>,
        relay: bool,
    ) -> Result<(), NodeError> {
        let id = root.chat_id();
        let mut groups: Vec<ChatId> = parents.iter().map(|p| self.group_of(p)).collect();
        groups.sort_unstable();
        groups.dedup();
        let group = match groups.first().copied() {
            Some(g) => {
                for other in &groups[1..] {
                    self.merge_groups(*other, g);
                }
                g
            }
            None => id,
        };
        let m = crate::display::greatest_visible_created_at(cx.ov, &parents, cx.now)?;
        let line_time = crate::display::root_line_time(root.created_at(), cx.now, m).ok();
        let previous_owner = parents
            .iter()
            .filter_map(|p| self.t.epochs.get(p))
            .map(|r| r.root.owner_id())
            .next();
        self.t.epochs.insert(
            id,
            EpochRecord {
                root: root.clone(),
                status: EpochStatus::Installed,
                group,
                parents,
                line_time,
                received_at: cx.now,
                from,
                removed_override: BTreeSet::new(),
                state_override: None,
            },
        );
        // §5.9: the line followed.
        let owner = root.owner_id();
        let is_handover = root.root_type() == RootType::Handover;
        let g = self.group_rec_mut(group);
        match g.followed {
            None => g.followed = Some(owner),
            Some(f) if is_handover && Some(f) == previous_owner && f != owner => {
                g.deposed.insert(f);
                g.followed = Some(owner);
            }
            _ => {}
        }
        if g.status == GroupStatus::Active {
            // Kept for adoption by a waiting group, which starts nothing itself (§5.4).
        }
        let active = g.status == GroupStatus::Active;
        let before = self.current_epoch(&group);
        self.rebuild_epochs();
        self.changed(group, ChangeKind::Membership, cx.now);
        if active {
            if self.t.groups.get(&group).is_none() {
                self.t
                    .groups
                    .insert(group, super::records::GroupSync::default());
            }
            self.drop_ineligible_neighbors(group);
            self.fetch_missing_keys(cx, &id);
            if relay {
                self.relay_root(cx, id);
            }
            self.initial_scans(cx, group);
            if before != self.current_epoch(&group) {
                self.current_changed(cx, group);
            }
            // §4.9: a device that is not the owner tells the owner of each competing end.
            let fork = self.fork_to_resolve(&group);
            if !fork.is_empty() {
                self.changed(group, ChangeKind::Fork, cx.now);
                let owner = self
                    .current_epoch(&group)
                    .and_then(|c| self.t.epochs.get(&c))
                    .map(|r| r.root.owner_id());
                if let Some(owner) = owner.filter(|o| *o != self.me) {
                    for end in fork {
                        self.queue_object_notice(owner, end, EntryItem::Root);
                    }
                }
            }
        }
        self.reconsider(cx)?;
        Ok(())
    }

    /// The current epoch of `group` changed: neighbors that are not members of it are
    /// dropped (§10.1), and leaves held are judged again (§5.5).
    pub(crate) fn current_changed(&mut self, cx: &mut Cx<'_>, group: ChatId) {
        self.drop_ineligible_neighbors(group);
        self.collect_live_leaves(cx, group);
    }

    /// Moves every epoch of group `from` into group `into`; the sync state of `from` is
    /// dropped.
    pub(crate) fn merge_groups(&mut self, from: ChatId, into: ChatId) {
        if from == into {
            return;
        }
        let chats: Vec<ChatId> = self
            .t
            .epochs
            .iter()
            .filter(|(_, r)| r.group == from)
            .map(|(c, _)| *c)
            .collect();
        for c in chats {
            if let Some(r) = self.t.epochs.get_mut(&c) {
                r.group = into;
            }
        }
        if let Some(old) = self.t.group_recs.remove(&from) {
            let g = self.group_rec_mut(into);
            g.links.extend(old.links);
            g.links.remove(&into);
            g.junctions.extend(old.junctions);
            if g.local_name.is_none() {
                g.local_name = old.local_name;
            }
            g.deposed.extend(old.deposed);
            // The line followed is the one no handover deposed (§5.9): a group accepted on
            // its own before its parents were found must not bring a former owner back.
            if g.followed.is_none_or(|f| g.deposed.contains(&f))
                && old.followed.is_some_and(|f| !g.deposed.contains(&f))
            {
                g.followed = old.followed;
            }
            for (m, at) in old.pending_removals {
                g.pending_removals.entry(m).or_insert(at);
            }
        }
        self.t.groups.remove(&from);
        let scans: Vec<_> = self
            .t
            .scans_out
            .keys()
            .filter(|k| k.0 == from)
            .copied()
            .collect();
        for k in scans {
            self.t.scans_out.remove(&k);
        }
    }

    /// Records an invitation (§4.8): looked up first when parents are unmatched, then
    /// prompted.
    #[allow(clippy::too_many_arguments)]
    fn invite(
        &mut self,
        cx: &mut Cx<'_>,
        from: GossipId,
        root: Root,
        lookups: Vec<ParentCommitment>,
        closed_before: bool,
        rejoins: Option<ChatId>,
        via: Via,
    ) {
        let id = root.chat_id();
        let hidden = via == Via::Parent;
        self.t.epochs.insert(
            id,
            EpochRecord {
                root,
                status: EpochStatus::Invitation(Invitation {
                    received_at: if hidden { u64::MAX } else { cx.now },
                    lookups: lookups.iter().copied().collect(),
                    not_available: BTreeSet::new(),
                    closed_before,
                    rejoins: rejoins.map(|p| self.group_of(&p)),
                }),
                group: id,
                parents: Vec::new(),
                line_time: None,
                received_at: cx.now,
                from,
                removed_override: BTreeSet::new(),
                state_override: None,
            },
        );
        for c in lookups {
            self.trigger(
                cx,
                TaskKey {
                    chat_id: id,
                    target: Target::Parent(c),
                },
                Some((from, TriggerKind::Notice)),
            );
        }
        if self.prompt_due(&id, cx.now) {
            self.changed(id, ChangeKind::Invitation, cx.now);
        }
    }

    /// Whether the invitation `chat` is shown (§4.8): not a parent fetched for another
    /// root, and its parent lookup is over, `PROMPT_DELAY` has passed since it was
    /// received, or the owner or three members answered "not available".
    pub(crate) fn prompt_due(&self, chat: &ChatId, now: u64) -> bool {
        let Some(rec) = self.t.epochs.get(chat) else {
            return false;
        };
        let EpochStatus::Invitation(inv) = &rec.status else {
            return false;
        };
        if inv.received_at == u64::MAX {
            return false;
        }
        inv.lookups.is_empty()
            || now >= inv.received_at.saturating_add(PROMPT_DELAY_MS)
            || inv.not_available.contains(&rec.root.owner_id())
            || inv.not_available.len() >= PROMPT_NOT_AVAILABLE
    }

    /// After an epoch was installed: invitations and held handover roots that continue an
    /// installed epoch are handled again (§4.8: the lookup succeeded); accepted roots that
    /// continue it are linked to it (the two conversations are joined).
    pub(crate) fn reconsider(&mut self, cx: &mut Cx<'_>) -> Result<(), NodeError> {
        for _ in 0..64 {
            let installed: Vec<ChatId> = self
                .t
                .epochs
                .iter()
                .filter(|(_, r)| r.status == EpochStatus::Installed)
                .map(|(c, _)| *c)
                .collect();
            // A held handover root whose parent is now held.
            let held: Vec<ChatId> = self
                .t
                .held_roots
                .iter()
                .filter(|(_, h)| installed.iter().any(|c| h.root.names_parent(c)))
                .map(|(c, _)| *c)
                .collect();
            if let Some(c) = held.first() {
                let h = self.t.held_roots.remove(c).expect("listed");
                self.receive_root(cx, h.from, h.root, Via::Lookup)?;
                continue;
            }
            // An invitation that now continues an installed epoch with authority.
            let mut next: Option<(ChatId, Vec<ChatId>)> = None;
            for (chat, rec) in self.t.epochs.iter() {
                let EpochStatus::Invitation(inv) = &rec.status else {
                    continue;
                };
                if inv.rejoins.is_some() {
                    continue;
                }
                let held: Vec<ChatId> = installed
                    .iter()
                    .filter(|c| rec.root.names_parent(c))
                    .copied()
                    .collect();
                if held.is_empty() {
                    continue;
                }
                let ok: Vec<ChatId> = self
                    .authorized_parents(&rec.root, &held)
                    .into_iter()
                    .filter(|c| self.group_status(c) == GroupStatus::Active)
                    .collect();
                if !ok.is_empty() {
                    next = Some((*chat, ok));
                    break;
                }
            }
            if let Some((chat, parents)) = next {
                let rec = self.t.epochs.remove(&chat).expect("listed");
                self.t.events.remove(&(chat, ChangeKind::Invitation));
                self.drop_tasks_of(&[chat]);
                self.adopt(cx, rec.root, rec.from, parents, true)?;
                continue;
            }
            // An installed epoch whose root continues an installed epoch of another group.
            let mut link: Option<(ChatId, ChatId)> = None;
            for (chat, rec) in self.t.epochs.iter() {
                if rec.status != EpochStatus::Installed {
                    continue;
                }
                let named: Vec<ChatId> = installed
                    .iter()
                    .filter(|c| *c != chat && rec.root.names_parent(c))
                    .copied()
                    .collect();
                if named.iter().all(|c| rec.parents.contains(c)) {
                    continue;
                }
                // Authority is judged with every held parent: a resolution's link to a
                // former owner's branch rests on the handover on its other parent.
                if let Some(c) = self
                    .authorized_parents(&rec.root, &named)
                    .into_iter()
                    .find(|c| !rec.parents.contains(c))
                {
                    link = Some((*chat, c));
                }
                if link.is_some() {
                    break;
                }
            }
            if let Some((child, parent)) = link {
                let (gc, gp) = (self.group_of(&child), self.group_of(&parent));
                if let Some(r) = self.t.epochs.get_mut(&child) {
                    r.parents.push(parent);
                    r.parents.sort_unstable();
                }
                let into = gc.min(gp);
                self.merge_groups(gc.max(gp), into);
                self.rebuild_epochs();
                self.changed(into, ChangeKind::Membership, cx.now);
                continue;
            }
            break;
        }
        Ok(())
    }

    /// Drops the retrieval tasks keyed by the given epochs.
    pub(crate) fn drop_tasks_of(&mut self, chats: &[ChatId]) {
        let keys: Vec<TaskKey> = self
            .t
            .tasks
            .keys()
            .filter(|k| chats.contains(&k.chat_id))
            .copied()
            .collect();
        for k in keys {
            self.t.tasks.remove(&k);
            self.reindex(k);
        }
    }

    /// Announces a held root by root notice to the members of its epoch that may receive it
    /// (§4.6, §10.2): neighbors and up to two others.
    pub(crate) fn relay_root(&mut self, cx: &mut Cx<'_>, chat: ChatId) {
        let Some(root) = self.held_root(&chat).cloned() else {
            return;
        };
        let pool: Vec<GossipId> = root
            .members()
            .iter()
            .filter(|m| **m != self.me && !self.removed_peer(&chat, m))
            .copied()
            .collect();
        self.relay_object(cx, chat, EntryItem::Root, pool);
    }

    /// Sends notices of an object to the neighbors in `pool` and to up to
    /// `min(2, |pool| − neighbors)` others drawn uniformly (§10.2).
    pub(crate) fn relay_object(
        &mut self,
        cx: &mut Cx<'_>,
        chat: ChatId,
        item: EntryItem,
        pool: Vec<GossipId>,
    ) {
        let (neighbors, mut others): (Vec<GossipId>, Vec<GossipId>) =
            pool.into_iter().partition(|p| self.is_neighbor(&chat, p));
        let extra = 2.min(others.len());
        let mut recipients = neighbors;
        for i in 0..extra {
            let j = i + crate::rng::uniform_below(cx.rng, others.len() - i);
            others.swap(i, j);
            recipients.push(others[i]);
        }
        for peer in recipients {
            self.queue_object_notice(peer, chat, item);
        }
    }

    /// Queues a notice entry for a root or a signed object, once.
    pub(crate) fn queue_object_notice(&mut self, peer: GossipId, chat: ChatId, item: EntryItem) {
        let queued = self
            .t
            .queue
            .range((peer, 0)..=(peer, u64::MAX))
            .any(|(_, w)| matches!(w, Work::ObjectNotice { chat_id, item: i } if *chat_id == chat && *i == item));
        if !queued {
            self.queue_work(
                peer,
                Work::ObjectNotice {
                    chat_id: chat,
                    item,
                },
            );
        }
    }

    /// Queues a root or a signed object in full, once.
    pub(crate) fn queue_object(&mut self, peer: GossipId, chat: ChatId, item: EntryItem) {
        let queued = self
            .t
            .queue
            .range((peer, 0)..=(peer, u64::MAX))
            .any(|(_, w)| matches!(w, Work::Object { chat_id, item: i } if *chat_id == chat && *i == item));
        if !queued {
            self.queue_work(
                peer,
                Work::Object {
                    chat_id: chat,
                    item,
                },
            );
        }
    }

    /// A root announced by `from` in a notice or a page (§4.6, §12.1, §4.11): fetched by
    /// chat lookup unless held, closed, or `from` is paused (§11.8).
    pub(crate) fn root_announced(
        &mut self,
        cx: &mut Cx<'_>,
        from: GossipId,
        chat: ChatId,
        kind: TriggerKind,
    ) {
        if self.held_root(&chat).is_some()
            || self.t.markers.contains(&chat)
            || from == self.me
            || self.announcer_paused(&from, cx.now)
        {
            return;
        }
        let key = TaskKey {
            chat_id: chat,
            target: Target::Root,
        };
        if !self.t.tasks.contains(&key) && self.root_fetches_of(&from) >= ROOT_FETCHES_PER_PEER {
            // The per-peer list is full: the rest is recovered by a shared-chats scan of that
            // peer (§11.8).
            self.stats.backpressure += 1;
            self.start_scan(cx, super::records::SHARED_SCAN, from, None);
            return;
        }
        self.trigger(cx, key, Some((from, kind)));
    }

    /// The root tasks `peer` triggered.
    fn root_fetches_of(&self, peer: &GossipId) -> usize {
        self.t
            .tasks
            .iter()
            .filter(|(k, t)| k.target == Target::Root && t.candidates.contains_key(peer))
            .count()
    }
}

/// Root fetches a peer may have this device keep: 4 in progress and 256 waiting (§11.8,
/// D.4). They are kept as tasks; the general limits of §17.4 bound those asked at once.
pub(crate) const ROOT_FETCHES_PER_PEER: usize = 4 + 256;
