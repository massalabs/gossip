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
    MarkerKind, Target, TaskKey, TriggerKind, Work,
};
use super::retrieval::Answer;
use super::timing::PROMPT_DELAY_MS;
use super::timing::{
    FETCHED_PARENT_DEPTH, FETCHED_PARENTS_PER_INVITATION, HELD_ROOTS_PER_DEVICE,
    HELD_ROOTS_PER_SENDER, INHERITED_MARKERS_PER_DEVICE, INHERITED_MARKERS_PER_SENDER,
    INVITATIONS_PER_DEVICE, INVITATIONS_PER_SENDER,
};
use super::{Cx, EpochEntry, Node, NodeError, PENALTY_ROOT_ANNOUNCEMENT};
use crate::epoch::GroupState;
use crate::ids::{ChatId, GossipId, ParentCommitment, RefChatId};
use crate::root::{Root, RootType};
use crate::wire::EntryItem;

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

/// Which held roots (epoch records and handover roots kept while their parent is looked up)
/// each held root names as a parent, and the reverse, maintained as records come and go,
/// so that adopting a chain of roots costs time linear in its length; and the records whose
/// neighbourhood changed, which [`Node::reconsider`] examines.
#[derive(Debug, Default)]
pub(crate) struct RootIndex {
    /// Child → the held roots it names.
    pub(crate) names: BTreeMap<ChatId, BTreeSet<ChatId>>,
    /// Parent → the held roots that name it.
    pub(crate) named_by: BTreeMap<ChatId, BTreeSet<ChatId>>,
    /// Records to examine.
    pub(crate) dirty: BTreeSet<ChatId>,
}

/// Records [`Node::reconsider`] examines in one operation at most; the rest is examined by
/// the next operations, each committing its progress. Provisional.
pub(crate) const RECONSIDER_STEPS: usize = 64;

/// What becomes of a root that continues installed epochs (see `Node::continuation`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Continuation {
    /// Adopted; announced by root notice when `relay`.
    Adopt { relay: bool },
    /// An invitation that rejoins the group of this installed parent.
    Rejoin(ChatId),
}

/// How a root reached this device.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Via {
    /// In full in an event frame, from a member (§4.6, §9.4).
    Direct,
    /// As the answer to a chat lookup by ID or by reference (§12.7).
    Lookup,
    /// As the answer to a parent lookup of the held root given (§4.8).
    Parent(ChatId),
}

impl Node {
    // ── Derived state ────────────────────────────────────────────────────────

    /// Rebuilds the installed epochs and the group index from the records.
    pub(crate) fn rebuild_epochs(&mut self) {
        self.refresh_lines();
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
                    Some(GroupStatus::Superseded { .. }) => GroupState::Superseded,
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

    /// Moves the line followed past every held handover from it (§5.9): a group whose
    /// record follows a former owner while it holds that owner's handover (as a join of two
    /// groups can leave it) follows the new owner, the former one deposed; a group that
    /// follows the new owner already deposes the former one. Handovers are
    /// taken in the order they were received, so that of two handovers from one owner the
    /// first adopted wins.
    fn refresh_lines(&mut self) {
        let mut handovers: Vec<(u64, ChatId, GossipId, GossipId)> = Vec::new();
        for (c, r) in self.t.epochs.iter() {
            if r.status != EpochStatus::Installed || r.root.root_type() != RootType::Handover {
                continue;
            }
            let Some(prev) = r
                .parents
                .first()
                .and_then(|p| self.t.epochs.get(p))
                .map(|p| p.root.owner_id())
            else {
                continue;
            };
            handovers.push((r.received_at, r.group, prev, r.root.owner_id()));
            let _ = c;
        }
        handovers.sort();
        for (_, group, prev, next) in handovers {
            let Some(g) = self.t.group_recs.get(&group) else {
                continue;
            };
            if g.followed == Some(prev) && prev != next && !g.deposed.contains(&next) {
                let g = self.group_rec_mut(group);
                g.deposed.insert(prev);
                g.followed = Some(next);
            } else if g.followed == Some(next) && prev != next && !g.deposed.contains(&prev) {
                // A group that follows the new owner already (it accepted the handover root as
                // an invitation, and was joined with its earlier line later) deposes the
                // former owner too.
                self.group_rec_mut(group).deposed.insert(prev);
            }
        }
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

    /// The ends the owner of the current epoch must resolve before it sends again (§4.9):
    /// two or more ends that it owns itself.
    pub(crate) fn fork_to_resolve(&self, group: &ChatId) -> Vec<ChatId> {
        let Some(cur) = self.current_epoch(group) else {
            return Vec::new();
        };
        let Some(owner) = self.t.epochs.get(&cur).map(|r| r.root.owner_id()) else {
            return Vec::new();
        };
        let ends: Vec<ChatId> = self
            .ends(group)
            .into_iter()
            .filter(|c| {
                self.t
                    .epochs
                    .get(c)
                    .is_some_and(|r| r.root.owner_id() == owner)
            })
            .collect();
        if ends.len() > 1 { ends } else { Vec::new() }
    }

    /// The ends owned by a previous owner in the line of the current owner (§5.9: it may
    /// take them as parents). They never block the current owner: a former owner can still
    /// sign roots of its old epochs, and must not be able to stop its successor from
    /// sending or changing the group. Resolving them is an explicit action
    /// ([`GroupChange::Resolve`](super::GroupChange::Resolve)), offered to the caller.
    pub(crate) fn former_owner_ends(&self, group: &ChatId) -> Vec<ChatId> {
        let Some(cur) = self.current_epoch(group) else {
            return Vec::new();
        };
        let Some(owner) = self.t.epochs.get(&cur).map(|r| r.root.owner_id()) else {
            return Vec::new();
        };
        let authority = self.line_authority(owner, &[cur]);
        self.ends(group)
            .into_iter()
            .filter(|c| {
                self.t.epochs.get(c).is_some_and(|r| {
                    r.root.owner_id() != owner && authority.contains(&r.root.owner_id())
                })
            })
            .collect()
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
                    took_part: false,
                    earlier: Vec::new(),
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
    /// successor root, each held parent owned by the root's owner or by a previous owner in
    /// its line; the others are treated as unmatched (§4.7).
    ///
    /// Authority from a held handover counts only within the group of that handover's
    /// parent, as joined by the root lines this device holds (never by links made by hand):
    /// the parents are judged group by group (D.69). A new owner of one group of a former
    /// owner therefore cannot attach that owner's other groups, whose parents stay
    /// unmatched, while its root still continues the parents it has authority over. (D.69
    /// had the root fail as a whole: a device that could not verify one parent then split
    /// the line its owner continued directly, against "Accept" in §4.8.)
    pub(crate) fn authorized_parents(&self, root: &Root, held: &[ChatId]) -> Vec<ChatId> {
        let held: Vec<ChatId> = held
            .iter()
            .filter(|c| root.names_parent(c) && self.t.epochs.contains(c))
            .copied()
            .collect();
        if root.root_type() == RootType::Handover {
            return held;
        }
        let mut by_group: BTreeMap<ChatId, Vec<ChatId>> = BTreeMap::new();
        for c in &held {
            by_group.entry(self.group_of(c)).or_default().push(*c);
        }
        let mut authorized = BTreeSet::new();
        for parents in by_group.values() {
            let authority = self.line_authority(root.owner_id(), parents);
            authorized.extend(parents.iter().copied().filter(|c| {
                self.t
                    .epochs
                    .get(c)
                    .is_some_and(|r| authority.contains(&r.root.owner_id()))
            }));
        }
        held.into_iter()
            .filter(|c| authorized.contains(c))
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
        match self.marker_kind(&id) {
            Some(MarkerKind::Dissolved) => {
                self.marker_reference(&id, root.ref_chat_id());
                return Ok(Answer::Refused);
            }
            Some(MarkerKind::Closed | MarkerKind::ClosedFrom(_)) if via != Via::Direct => {
                self.marker_reference(&id, root.ref_chat_id());
                return Ok(Answer::Refused);
            }
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
        // A handover delivered by a peer that is no member of it, whose parent is not held:
        // possibly the outgoing owner of a "hand over and leave"; it cannot be judged yet,
        // and is kept while its parent is looked up, without penalty (§4.7).
        if root.root_type() == RootType::Handover
            && root.is_member(&self.me)
            && !root.is_member(&from)
            && from != self.me
            && !root
                .match_parents(self.t.epochs.keys())
                .iter()
                .any(|c| self.t.epochs.contains(c))
        {
            self.hold_handover(cx, from, root);
            return Ok(Answer::Supplied);
        }
        // A handover root this device signed for a parent it holds, without itself: a copy
        // of this account handed over and left, which members tell it (§5.6).
        if root.root_type() == RootType::Handover
            && !root.is_member(&self.me)
            && root.is_member(&from)
            && from != self.me
            && let Some(parent) = root
                .match_parents(self.t.epochs.keys())
                .into_iter()
                .find(|c| {
                    self.t.epochs.get(c).is_some_and(|r| {
                        r.status == EpochStatus::Installed && r.root.owner_id() == self.me
                    })
                })
            && root
                .verify_signature(self.t.epochs.get(&parent).map(|r| &r.root))
                .is_ok()
        {
            self.left_by_handover(cx, parent, &root);
            return Ok(Answer::Supplied);
        }
        if !root.is_member(&self.me) || !(root.is_member(&from) || signer_left) || from == self.me {
            self.failed_announcement(cx, &from);
            return Ok(Answer::Invalid);
        }
        // Step 6: the held roots and closed-chat markers its commitments name, each once: a
        // closed epoch delivered again in full is held as an invitation beside its marker,
        // and counted twice it would make case 3 below take one closed parent for two.
        let candidates: BTreeSet<ChatId> = self
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
        self.take_held(&id);
        let closed_before = self.t.markers.get(&id).is_some_and(Marker::is_closed);
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
        // §5.12: two creations at once (whatever this device closed: the losing group of a
        // pair is closed, and a copy delivered again is judged again), or a direct chat the
        // caller consented to.
        if self.receive_direct(cx, from, &root, !matched.is_empty(), closed_before)? {
            return Ok(Answer::Supplied);
        }
        // Case 1, closed by the user: a full root delivered directly prompts again.
        if closed_before {
            self.invite(cx, from, root, Vec::new(), true, None, via);
            return Ok(Answer::Supplied);
        }
        // Case 2: a retained member (see `continuation`).
        let continuation = self.continuation(&installed);
        if let Some(Continuation::Adopt { relay: true }) = continuation {
            self.adopt(cx, root, from, installed, true)?;
            return Ok(Answer::Supplied);
        }
        // Case 3: the parents match closed-chat markers. Only when every parent does: a
        // root that adds back a member who closed the group names the epoch it closed beside
        // one it never held, and is an invitation (§5.10).
        let closed = matched
            .iter()
            .filter(|c| self.t.markers.get(c).is_some_and(Marker::is_closed))
            .count();
        if closed > 0 && closed == root.parents().len() {
            if self.record_closed(id, root.ref_chat_id(), from) {
                self.reject_continuations(id);
            }
            return Ok(Answer::Supplied);
        }
        // Case 4: kicked, dissolved or waiting (see `continuation`).
        match continuation {
            Some(Continuation::Adopt { relay }) => {
                self.adopt(cx, root, from, installed, relay)?;
                return Ok(Answer::Supplied);
            }
            Some(Continuation::Rejoin(p)) => {
                self.invite(cx, from, root, Vec::new(), false, Some(p), via);
                return Ok(Answer::Supplied);
            }
            None => {}
        }
        // Case 5: no parent matched; the unmatched ones are looked up first, except for a
        // migration this device acts on (§5.12): it continues no epoch, and a parent found
        // would only make it an ordinary invitation.
        if self.direct_creation(&root, false).is_some() {
            self.invite(cx, from, root, Vec::new(), false, None, via);
            return Ok(Answer::Supplied);
        }
        let unmatched: Vec<ParentCommitment> = root
            .parents()
            .iter()
            .filter(|c| !matched.iter().any(|m| root.commitment_for(m) == **c))
            .copied()
            .collect();
        self.invite(cx, from, root, unmatched, false, None, via);
        Ok(Answer::Supplied)
    }

    /// What becomes of a root that continues, with its owner's authority, the installed epochs
    /// `installed` (§4.8 cases 2 and 4): the one decision for a root that arrives after its
    /// parent and for an invitation whose parent is installed later (`try_adopt_invitation`).
    /// Why one decision: the same root in the same group state must end the same way whatever
    /// the order in which roots arrive; otherwise a device that got the child first showed it
    /// as an invitation that the other order adopts silently.
    ///
    /// - A parent in an active group: adopted and announced (case 2).
    /// - Otherwise, the group of the first parent waits for a kick, or is a superseded chat of
    ///   two: adopted without a prompt and announced to no one, so that the current epoch names
    ///   the right owner (§5.4, §5.12).
    /// - Otherwise (kicked, left, dissolved): an invitation that rejoins that group (§5.10).
    fn continuation(&self, installed: &[ChatId]) -> Option<Continuation> {
        let first = installed.first()?;
        if installed
            .iter()
            .any(|c| self.group_status(c) == GroupStatus::Active)
        {
            return Some(Continuation::Adopt { relay: true });
        }
        Some(match self.group_status(first) {
            GroupStatus::Waiting { .. } | GroupStatus::Superseded { .. } => {
                Continuation::Adopt { relay: false }
            }
            _ => Continuation::Rejoin(*first),
        })
    }

    /// Records `id`, a root rejected because it continues a closed epoch, as closed too
    /// (§4.8 case 3), within limits per delivering peer: the markers a peer can make this
    /// device keep are bounded. Returns whether it was recorded.
    fn record_closed(&mut self, id: ChatId, reference: RefChatId, from: GossipId) -> bool {
        let mine = self
            .t
            .markers
            .iter()
            .filter(|(_, m)| m.kind == MarkerKind::ClosedFrom(from))
            .count();
        let all = self
            .t
            .markers
            .iter()
            .filter(|(_, m)| matches!(m.kind, MarkerKind::ClosedFrom(_)))
            .count();
        if mine < INHERITED_MARKERS_PER_SENDER && all < INHERITED_MARKERS_PER_DEVICE {
            self.put_marker(id, MarkerKind::ClosedFrom(from), Some(reference));
            return true;
        }
        false
    }

    /// `closed` was just recorded closed: an invitation that names it as a parent, and
    /// whose every parent is now closed, is rejected as case 3 would have rejected it had
    /// its parents been known on arrival, and recorded closed in turn, down the line. A
    /// root that arrived before the epoch between it and a closed one (which its parent
    /// lookup fetched) was otherwise offered once the lookup was over.
    fn reject_continuations(&mut self, closed: ChatId) {
        let mut work = vec![closed];
        while let Some(c) = work.pop() {
            let markers: Vec<ChatId> = self
                .t
                .markers
                .iter()
                .filter(|(_, m)| m.is_closed())
                .map(|(k, _)| *k)
                .collect();
            let rejected: Vec<(ChatId, RefChatId, GossipId)> = self
                .t
                .epochs
                .iter()
                .filter(|(_, r)| {
                    matches!(&r.status, EpochStatus::Invitation(i) if !i.closed_before)
                        && r.root.names_parent(&c)
                        && r.root.match_parents(markers.iter()).len() == r.root.parents().len()
                })
                .map(|(x, r)| (*x, r.root.ref_chat_id(), r.from))
                .collect();
            for (x, reference, from) in rejected {
                self.take_record(&x);
                self.t.events.remove(&(x, ChangeKind::Invitation));
                self.drop_tasks_of(&[x]);
                self.drop_fetched_for(x);
                if self.record_closed(x, reference, from) {
                    work.push(x);
                }
            }
        }
    }

    /// Keeps a handover root whose parent is not held, and looks the parent up (§4.7).
    fn hold_handover(&mut self, cx: &mut Cx<'_>, from: GossipId, root: Root) {
        let id = root.chat_id();
        if self.t.held_roots.contains(&id) {
            return;
        }
        // Kept unverified: bounded per delivering peer and in total, the newest refused,
        // never another peer's pushed out.
        let mine = self
            .t
            .held_roots
            .iter()
            .filter(|(_, h)| h.from == from)
            .count();
        if mine >= HELD_ROOTS_PER_SENDER || self.t.held_roots.len() >= HELD_ROOTS_PER_DEVICE {
            self.stats.capped += 1;
            return;
        }
        let commitment = root.parents()[0];
        self.put_held(
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
        let joined = groups.len() > 1;
        let previous_owner = parents
            .iter()
            .filter_map(|p| self.t.epochs.get(p))
            .map(|r| r.root.owner_id())
            .next();
        self.put_record(
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
            if before != self.current_epoch(&group) || joined {
                self.current_changed(cx, group);
                self.recheck_status(cx, group);
            }
            // §4.9: a device that is not the owner tells the owner of each competing end.
            let mut fork = self.fork_to_resolve(&group);
            let former = self.former_owner_ends(&group);
            if !former.is_empty() {
                fork.extend(former);
                fork.extend(self.current_epoch(&group));
            }
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
        if joined && !active {
            // Joined with a read-only group: judged again from the joined current epoch.
            self.recheck_status(cx, group);
        }
        Ok(())
    }

    /// Judges the state of `group` again after it was joined with another one or its
    /// current epoch changed. A read-only state whose epoch is no longer the current one
    /// ends: the device accepted a later root (§5.10). Then its own leave, a kick of it or
    /// a dissolve message naming the current epoch, held from before that epoch became
    /// current, apply (§5.6, §5.8, D.2).
    pub(crate) fn recheck_status(&mut self, cx: &mut Cx<'_>, group: ChatId) {
        let Some(cur) = self.current_epoch(&group) else {
            return;
        };
        // After "Dissolve & Delete" the dissolved epoch is erased in the end, while side
        // branches stay (§5.8): the one left current is no later root the device accepted, and
        // the group stays dissolved. A former owner's branch, whose handover was erased with
        // the line, would otherwise take the group back (§5.9, D.76).
        let erased = |n: &Self, e: &ChatId| !n.t.epochs.contains(e);
        match self.group_status(&group) {
            GroupStatus::Dissolved {
                epoch,
                must_delete: true,
                ..
            } if erased(self, &epoch) => {}
            GroupStatus::Removed { epoch, .. }
            | GroupStatus::Left { epoch, .. }
            | GroupStatus::Dissolved { epoch, .. }
                if epoch != cur =>
            {
                self.group_rec_mut(group).status = GroupStatus::Active;
                self.rebuild_epochs();
                self.resume_lookups(group);
            }
            _ => {}
        }
        if self.group_status(&group) != GroupStatus::Active {
            return;
        }
        let kick = (
            cur,
            crate::wire::SignedKind::Kick,
            *crate::hash::kick_id(&cur, &self.me).as_bytes(),
        );
        if self.t.signed.contains(&kick) {
            self.set_read_only(
                cx,
                group,
                GroupStatus::Removed {
                    epoch: cur,
                    at: cx.now,
                },
            );
            return;
        }
        let dissolve = [true, false].into_iter().find(|d| {
            self.t.signed.contains(&(
                cur,
                crate::wire::SignedKind::Dissolve,
                *crate::hash::dissolve_id(&cur, *d).as_bytes(),
            ))
        });
        if let Some(must_delete) = dissolve {
            self.apply_dissolve(cx, group, cur, must_delete);
            return;
        }
        self.check_own_leave(cx, group);
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
            // A read-only state is kept; `recheck_status` judges it again once the joined
            // group's current epoch is known.
            if g.status == GroupStatus::Active {
                g.status = old.status;
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
        let fetched_for = match via {
            Via::Parent(child) => {
                let (top, depth) = match self.t.epochs.get(&child).map(|r| &r.status) {
                    Some(EpochStatus::Invitation(Invitation {
                        fetched_for: Some((top, depth)),
                        ..
                    })) => (*top, depth.saturating_add(1)),
                    _ => (child, 1),
                };
                let count = self
                    .t
                    .epochs
                    .iter()
                    .filter(|(_, r)| {
                        matches!(&r.status, EpochStatus::Invitation(i) if i.fetched_for.is_some_and(|(t, _)| t == top))
                    })
                    .count();
                if depth > FETCHED_PARENT_DEPTH || count >= FETCHED_PARENTS_PER_INVITATION {
                    self.stats.capped += 1;
                    return;
                }
                Some((top, depth))
            }
            _ => None,
        };
        let hidden = fetched_for.is_some();
        // Listed by a shared-chats scan, it may be the last epoch of a group this device was
        // removed from, whose kick or leave the listing member sends with it (§4.11, §5.6).
        let listed = via == Via::Lookup
            && root.is_member(&self.me)
            && self
                .t
                .tasks
                .get(&TaskKey {
                    chat_id: id,
                    target: Target::Root,
                })
                .and_then(|t| t.candidates.get(&from))
                .and_then(|c| c.trigger)
                .is_some_and(|t| t.kind == TriggerKind::Page);
        if !hidden && !self.room_for_invitation(cx, &from) {
            self.stats.capped += 1;
            return;
        }
        self.put_record(
            id,
            EpochRecord {
                root,
                status: EpochStatus::Invitation(Invitation {
                    received_at: if hidden { u64::MAX } else { cx.now },
                    lookups: lookups.iter().copied().collect(),
                    not_available: BTreeSet::new(),
                    closed_before,
                    rejoins: rejoins.map(|p| self.group_of(&p)),
                    fetched_for,
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
        if listed {
            // In case that record is lost on the way, it is looked up from the listing member,
            // which is no claim of it: a "not available" costs it nothing (§11.8).
            let key = TaskKey {
                chat_id: id,
                target: Target::Removal(self.me),
            };
            self.trigger(cx, key, None);
            if let Some(t) = self.t.tasks.get_mut(&key) {
                t.candidates
                    .entry(from)
                    .or_insert_with(super::records::Candidate::new);
            }
        }
        for c in lookups {
            // Parent lookups count in the root fetches a peer may cause (§11.8); beyond,
            // the commitment is not looked up, and the prompt does not wait for it.
            if self.root_fetches_of(&from) >= ROOT_FETCHES_PER_PEER {
                if let Some(r) = self.t.epochs.get_mut(&id)
                    && let EpochStatus::Invitation(inv) = &mut r.status
                {
                    inv.lookups.remove(&c);
                }
                continue;
            }
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
        // A root a scan listed waits for the removal lookup it started (§4.11, §5.6).
        let removal_pending = self.t.tasks.contains(&TaskKey {
            chat_id: *chat,
            target: Target::Removal(self.me),
        });
        (inv.lookups.is_empty() && !removal_pending)
            || now >= inv.received_at.saturating_add(PROMPT_DELAY_MS)
            || inv.not_available.contains(&rec.root.owner_id())
            || inv.not_available.len() >= PROMPT_NOT_AVAILABLE
    }

    // ── The root index and the worklist ──────────────────────────────────────

    /// Stores an epoch record and indexes the parents its root names.
    pub(crate) fn put_record(&mut self, id: ChatId, rec: EpochRecord) {
        let fresh = !self.t.epochs.contains(&id) && !self.t.held_roots.contains(&id);
        let reference = rec.root.ref_chat_id();
        self.t.epochs.insert(id, rec);
        self.ref_stored(id, reference);
        if fresh {
            self.index_add(id);
        }
        self.ri.dirty.insert(id);
    }

    /// Removes an epoch record and its index entries.
    pub(crate) fn take_record(&mut self, id: &ChatId) -> Option<EpochRecord> {
        let rec = self.t.epochs.remove(id)?;
        self.ref_removed(rec.root.ref_chat_id());
        if !self.t.held_roots.contains(id) {
            self.index_remove(id);
        }
        Some(rec)
    }

    /// Stores a handover root kept while its parent is looked up.
    fn put_held(&mut self, id: ChatId, h: HeldRoot) {
        let fresh = !self.t.epochs.contains(&id) && !self.t.held_roots.contains(&id);
        self.t.held_roots.insert(id, h);
        if fresh {
            self.index_add(id);
        }
        self.ri.dirty.insert(id);
    }

    /// Removes a kept handover root.
    pub(crate) fn take_held(&mut self, id: &ChatId) -> Option<HeldRoot> {
        let h = self.t.held_roots.remove(id)?;
        if !self.t.epochs.contains(id) {
            self.index_remove(id);
        }
        Some(h)
    }

    fn index_add(&mut self, id: ChatId) {
        let Some(root) = self.held_root(&id).cloned() else {
            return;
        };
        let others: Vec<ChatId> = self
            .t
            .epochs
            .keys()
            .chain(self.t.held_roots.keys())
            .filter(|c| **c != id)
            .copied()
            .collect();
        for y in others {
            if root.names_parent(&y) {
                self.ri.names.entry(id).or_default().insert(y);
                self.ri.named_by.entry(y).or_default().insert(id);
            }
            if self.held_root(&y).is_some_and(|r| r.names_parent(&id)) {
                self.ri.names.entry(y).or_default().insert(id);
                self.ri.named_by.entry(id).or_default().insert(y);
            }
        }
    }

    fn index_remove(&mut self, id: &ChatId) {
        for p in self.ri.names.remove(id).unwrap_or_default() {
            if let Some(s) = self.ri.named_by.get_mut(&p) {
                s.remove(id);
            }
        }
        for c in self.ri.named_by.remove(id).unwrap_or_default() {
            if let Some(s) = self.ri.names.get_mut(&c) {
                s.remove(id);
            }
        }
        self.ri.dirty.remove(id);
    }

    /// Rebuilds the root index from the records (after a load), and marks every record to
    /// be examined.
    pub(crate) fn rebuild_root_index(&mut self) {
        self.ri = RootIndex::default();
        let ids: Vec<ChatId> = self
            .t
            .epochs
            .keys()
            .chain(self.t.held_roots.keys())
            .copied()
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect();
        for (i, a) in ids.iter().enumerate() {
            let ra = self.held_root(a).cloned();
            for b in &ids[i + 1..] {
                let b_names_a = self.held_root(b).is_some_and(|r| r.names_parent(a));
                if ra.as_ref().is_some_and(|r| r.names_parent(b)) {
                    self.ri.names.entry(*a).or_default().insert(*b);
                    self.ri.named_by.entry(*b).or_default().insert(*a);
                }
                if b_names_a {
                    self.ri.names.entry(*b).or_default().insert(*a);
                    self.ri.named_by.entry(*a).or_default().insert(*b);
                }
            }
        }
        self.ri.dirty = ids.into_iter().collect();
    }

    fn names_of(&self, id: &ChatId) -> Vec<ChatId> {
        self.ri
            .names
            .get(id)
            .map(|s| s.iter().copied().collect())
            .unwrap_or_default()
    }

    fn named_by_of(&self, id: &ChatId) -> Vec<ChatId> {
        self.ri
            .named_by
            .get(id)
            .map(|s| s.iter().copied().collect())
            .unwrap_or_default()
    }

    /// Whether the invitation `x` leads, through invitations, to an installed root: the user
    /// accepted a root it is an ancestor of (§4.8: the two conversations are joined).
    fn leads_to_accepted(&self, x: &ChatId) -> bool {
        let mut seen = BTreeSet::new();
        let mut stack = self.named_by_of(x);
        while let Some(c) = stack.pop() {
            if !seen.insert(c) {
                continue;
            }
            match self.t.epochs.get(&c).map(|r| &r.status) {
                Some(EpochStatus::Installed) => return true,
                Some(EpochStatus::Invitation(_)) => stack.extend(self.named_by_of(&c)),
                None => {}
            }
        }
        false
    }

    /// Examines the records whose neighbourhood changed (§4.8: the lookup succeeded, the
    /// conversations are joined), from a worklist, never by recursion, at most
    /// [`RECONSIDER_STEPS`] of them per operation: a held handover root whose parent is now
    /// held is received; an invitation that continues an installed epoch with authority is
    /// adopted, as is one that leads to a root the user accepted, or that an installed root
    /// continues with authority (it is joined, D.66); an installed root that
    /// continues an installed epoch it is not linked to yet is linked to it.
    pub(crate) fn reconsider(&mut self, cx: &mut Cx<'_>) -> Result<(), NodeError> {
        for _ in 0..RECONSIDER_STEPS {
            let Some(c) = self.ri.dirty.pop_first() else {
                return Ok(());
            };
            if self.t.held_roots.contains(&c) && !self.t.epochs.contains(&c) {
                if self.names_of(&c).iter().any(|p| self.installed(p)) {
                    let Some(h) = self.take_held(&c) else {
                        continue;
                    };
                    self.receive_root(cx, h.from, h.root, Via::Lookup)?;
                }
                continue;
            }
            match self.t.epochs.get(&c).map(|r| r.status.clone()) {
                Some(EpochStatus::Invitation(inv)) => self.try_adopt_invitation(cx, c, &inv)?,
                Some(EpochStatus::Installed) => {
                    for x in self.named_by_of(&c) {
                        if self.installed(&x) {
                            self.try_link(cx, x);
                        } else {
                            self.ri.dirty.insert(x);
                        }
                    }
                    // Invitations it names: ancestors of an accepted root.
                    for p in self.names_of(&c) {
                        if !self.installed(&p) {
                            self.ri.dirty.insert(p);
                        }
                    }
                    self.try_link(cx, c);
                }
                None => {}
            }
        }
        Ok(())
    }

    /// The group `group` is active again: each invitation that rejoins it is decided again
    /// by `continuation`, as a root arriving now would be (§4.8, §5.10). Why: two roots that
    /// both continue the epoch the device was kicked from are both invitations that rejoin
    /// it; once the user accepts one, the other continues an active group, and a root that
    /// arrives after the accept is adopted and announced. Left an invitation, it stayed one
    /// for good, so the order of arrival decided the end state.
    pub(crate) fn reconsider_rejoins(&mut self, group: ChatId) {
        let group = self.group_of(&group);
        let rejoining: Vec<ChatId> = self
            .t
            .epochs
            .iter()
            .filter(|(_, r)| {
                matches!(&r.status, EpochStatus::Invitation(i)
                    if i.rejoins.is_some_and(|g| self.group_of(&g) == group))
            })
            .map(|(c, _)| *c)
            .collect();
        for c in rejoining {
            if let Some(r) = self.t.epochs.get_mut(&c)
                && let EpochStatus::Invitation(i) = &mut r.status
            {
                i.rejoins = None;
            }
            self.ri.dirty.insert(c);
        }
    }

    fn try_adopt_invitation(
        &mut self,
        cx: &mut Cx<'_>,
        chat: ChatId,
        inv: &Invitation,
    ) -> Result<(), NodeError> {
        let held: Vec<ChatId> = self
            .names_of(&chat)
            .into_iter()
            .filter(|c| self.installed(c))
            .collect();
        let ancestor = self.leads_to_accepted(&chat);
        let Some(root) = self.t.epochs.get(&chat).map(|r| r.root.clone()) else {
            return Ok(());
        };
        let installed = if held.is_empty() {
            Vec::new()
        } else {
            self.authorized_parents(&root, &held)
        };
        // An ancestor of a root the user accepted is joined to it whatever the state of its
        // parents' group (§4.8). Otherwise the root ends as it would have, had it arrived after
        // its parent (`continuation`): a root the user closed before (case 1), or already an
        // invitation that rejoins its group, stays what it is.
        let (ok, relay) = if installed.is_empty() {
            (Vec::new(), true)
        } else if ancestor {
            (installed, true)
        } else if inv.closed_before || inv.rejoins.is_some() {
            (Vec::new(), true)
        } else {
            match self.continuation(&installed) {
                Some(Continuation::Adopt { relay }) => (installed, relay),
                Some(Continuation::Rejoin(p)) => {
                    let group = self.group_of(&p);
                    if let Some(r) = self.t.epochs.get_mut(&chat)
                        && let EpochStatus::Invitation(i) = &mut r.status
                    {
                        i.rejoins = Some(group);
                    }
                    (Vec::new(), true)
                }
                None => (Vec::new(), true),
            }
        };
        if ok.is_empty() {
            return self.join_ancestor(cx, chat, &root);
        }
        let Some(rec) = self.take_record(&chat) else {
            return Ok(());
        };
        self.t.events.remove(&(chat, ChangeKind::Invitation));
        self.drop_tasks_of(&[chat]);
        self.adopt(cx, rec.root, rec.from, ok, relay)
    }

    /// D.66: an invitation that an installed root continues with authority is part of that
    /// root's conversation, whether or not its own parents are held (a founding root, or an
    /// epoch whose parents are still looked up): it is installed, and the worklist then
    /// links the installed root to it. Authority is that of §4.7 seen from the child: a
    /// successor continues an epoch of its own owner; a handover continues the epoch whose
    /// owner signed it. An epoch of another owner (a former owner's other group that its
    /// successor names, D.69) is never joined this way. Its parent lookups keep running.
    fn join_ancestor(
        &mut self,
        cx: &mut Cx<'_>,
        chat: ChatId,
        root: &Root,
    ) -> Result<(), NodeError> {
        let continued = self.named_by_of(&chat).into_iter().any(|c| {
            self.t.epochs.get(&c).is_some_and(|r| {
                r.status == EpochStatus::Installed
                    && match r.root.root_type() {
                        RootType::Handover => r.root.verify_signature(Some(root)).is_ok(),
                        RootType::Successor => r.root.owner_id() == root.owner_id(),
                    }
            })
        });
        if !continued {
            return Ok(());
        }
        let Some(rec) = self.take_record(&chat) else {
            return Ok(());
        };
        self.t.events.remove(&(chat, ChangeKind::Invitation));
        self.adopt(cx, rec.root, rec.from, Vec::new(), false)
    }

    /// Links the installed epoch `child` to an installed epoch its root continues with
    /// authority that it is not linked to yet, joining their groups. Authority is judged
    /// with every held parent: a resolution's link to a former owner's branch rests on the
    /// handover on its other parent.
    fn try_link(&mut self, cx: &mut Cx<'_>, child: ChatId) {
        let Some(rec) = self.t.epochs.get(&child) else {
            return;
        };
        let named: Vec<ChatId> = self
            .names_of(&child)
            .into_iter()
            .filter(|c| self.installed(c))
            .collect();
        if named.iter().all(|c| rec.parents.contains(c)) {
            return;
        }
        let root = rec.root.clone();
        let linked = rec.parents.clone();
        let Some(parent) = self
            .authorized_parents(&root, &named)
            .into_iter()
            .find(|c| !linked.contains(c))
        else {
            return;
        };
        let (gc, gp) = (self.group_of(&child), self.group_of(&parent));
        if let Some(r) = self.t.epochs.get_mut(&child) {
            r.parents.push(parent);
            r.parents.sort_unstable();
        }
        let into = gc.min(gp);
        self.merge_groups(gc.max(gp), into);
        self.rebuild_epochs();
        self.recheck_status(cx, into);
        self.changed(into, ChangeKind::Membership, cx.now);
        // Its other parents may link too.
        self.ri.dirty.insert(child);
    }

    /// Removes the roots fetched as parents for the invitation `top` (§4.8), with their
    /// tasks, unless another held root still names them. Returns those removed, with the
    /// reference of each.
    /// Drops the roots fetched as parents of the invitation `top`, which the user refused
    /// (declined, or "Ignore and Delete"), each leaving a closed-chat marker with its
    /// reference, as the invitation does (§4.8, §5.2, §14.2): a copy of one is refused, and a
    /// reply naming one is placed (§7.6) as while the invitation was not answered. A parent
    /// that something else the device holds still names is kept ([`Node::drop_fetched_for`]).
    ///
    /// Why: the member lists and names of the earlier epochs of a chat the user refused must
    /// not stay on the device as hidden records that nothing points to.
    pub(crate) fn drop_refused_parents(&mut self, top: ChatId) {
        for (parent, reference) in self.drop_fetched_for(top) {
            self.put_marker(parent, MarkerKind::Closed, Some(reference));
        }
    }

    pub(crate) fn drop_fetched_for(&mut self, top: ChatId) -> Vec<(ChatId, RefChatId)> {
        let fetched: BTreeSet<ChatId> = self
            .t
            .epochs
            .iter()
            .filter(|(_, r)| {
                matches!(&r.status, EpochStatus::Invitation(i) if i.fetched_for.is_some_and(|(t, _)| t == top))
            })
            .map(|(c, _)| *c)
            .collect();
        let mut dropped = Vec::new();
        for c in &fetched {
            let needed = self
                .named_by_of(c)
                .iter()
                .any(|x| *x != top && !fetched.contains(x));
            if !needed && let Some(rec) = self.take_record(c) {
                self.t.events.remove(&(*c, ChangeKind::Invitation));
                self.drop_tasks_of(&[*c]);
                dropped.push((*c, rec.root.ref_chat_id()));
            }
        }
        dropped
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

    /// Whether a root or a signed object is queued in full for `peer`.
    pub(crate) fn object_queued(&self, peer: GossipId, chat: ChatId, item: EntryItem) -> bool {
        self.t
            .queue
            .range((peer, 0)..=(peer, u64::MAX))
            .any(|(_, w)| matches!(w, Work::Object { chat_id, item: i } if *chat_id == chat && *i == item))
    }

    /// Queues a root or a signed object in full, once.
    pub(crate) fn queue_object(&mut self, peer: GossipId, chat: ChatId, item: EntryItem) {
        if !self.object_queued(peer, chat, item) {
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

    /// The root and parent-lookup tasks `peer` triggered.
    fn root_fetches_of(&self, peer: &GossipId) -> usize {
        self.t
            .tasks
            .iter()
            .filter(|(k, t)| {
                matches!(k.target, Target::Root | Target::Parent(_))
                    && t.candidates.get(peer).is_some_and(|c| c.trigger.is_some())
            })
            .count()
    }

    /// Whether an invitation delivered by `from` may be kept: fewer than
    /// [`INVITATIONS_PER_SENDER`] of its invitations are pending, and below
    /// [`INVITATIONS_PER_DEVICE`] in all, or the newest invitation of a peer with more
    /// pending than `from` is dropped to make room (never one of a peer with as few).
    fn room_for_invitation(&mut self, cx: &mut Cx<'_>, from: &GossipId) -> bool {
        let mut by_sender: BTreeMap<GossipId, Vec<(u64, ChatId)>> = BTreeMap::new();
        for (c, r) in self.t.epochs.iter() {
            if let EpochStatus::Invitation(inv) = &r.status
                && inv.fetched_for.is_none()
            {
                by_sender
                    .entry(r.from)
                    .or_default()
                    .push((inv.received_at, *c));
            }
        }
        let mine = by_sender.get(from).map_or(0, Vec::len);
        if mine >= INVITATIONS_PER_SENDER {
            return false;
        }
        let all: usize = by_sender.values().map(Vec::len).sum();
        if all < INVITATIONS_PER_DEVICE {
            return true;
        }
        let Some((_, victims)) = by_sender
            .iter()
            .filter(|(s, v)| *s != from && v.len() > mine + 1)
            .max_by_key(|(_, v)| v.len())
        else {
            return false;
        };
        let Some(&(_, newest)) = victims.iter().max() else {
            return false;
        };
        self.take_record(&newest);
        self.t.events.remove(&(newest, ChangeKind::Invitation));
        self.drop_tasks_of(&[newest]);
        let _ = cx;
        true
    }
}

/// Root fetches a peer may have this device keep: 4 in progress and 256 waiting (§11.8,
/// D.4). They are kept as tasks; the general limits of §17.4 bound those asked at once.
pub(crate) const ROOT_FETCHES_PER_PEER: usize = 4 + 256;
