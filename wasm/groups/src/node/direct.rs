//! Direct chats, contacts, connections and migration (§5.12).
//!
//! The engine knows nothing of contacts or of the earlier one-to-one conversations: the caller
//! tells it what it holds, and the engine only acts on a root when that knowledge and what
//! the device holds agree.
//!
//! - **One mechanism.** Every group of two created automatically, for a migration or after an
//!   accepted contact request, carries `migrate_from` (`0`); a group created with "New group"
//!   never does and is never touched here. Such a root is recognised by
//!   a successor with one parent commitment that matches nothing held, of exactly this device
//!   and its owner, with a format version this release knows ([`KNOWN_FORMAT_VERSIONS`]).
//! - **Two creations at once.** Defined only from what the device holds: its own creating
//!   root and the peer's, the same two members, the same `migrate_from`, neither continued by
//!   a successor it holds. The group whose owner's GossipID sorts first is kept; the other is
//!   never erased: both devices hold it superseded ([`GroupStatus::Superseded`]), read-only,
//!   with what was written in it, listed among the kept chat's earlier chats, and reported by
//!   [`ChangeKind::Superseded`]. It is judged whenever the
//!   second of the two becomes held: on receipt, on creation, and when the caller declares
//!   what it knows.
//! - **Continuing a conversation.** The owner of an automatic chat records, for good,
//!   whether the other person took part in it (a message event, a notice of one or a query
//!   about its messages, received from that person in that chat): a local fact, never sent
//!   and compared with no date. The device that keeps its own chat by the tie rule settles
//!   the other's as history and is never asked. When the other's chat wins the tie, this
//!   device switches to it by itself while the other person never took part in its own, and
//!   otherwise holds it as an invitation that continues its chat
//!   ([`super::InvitationSummary::continues`]): accepting it supersedes that chat, declining
//!   leaves it. Only chats that both still list compete: an own chat that no longer lists
//!   the other person (a signed decline, a leave, a removal) is history only, and a new
//!   chat of that person is always an invitation to continue it.
//! - **What the caller declares** decides the receiving side only. A **migration**
//!   ([`Node::migration_of`]) is shown when the caller declared an earlier conversation with
//!   the owner at that version ([`Node::set_earlier_conversation`]); a **new contact**'s chat
//!   is adopted without a prompt under a one-shot consent ([`Node::consent_to_direct_chat`],
//!   expiring after [`CONSENT_MS`]). Once the device holds a direct chat with that peer
//!   ([`Node::holds_direct_chat`]: active, and listing both), a later creation from it is an
//!   ordinary invitation.
//! - **Connections.** [`Node::is_co_member`], [`Node::connections_to_revoke`] and
//!   [`Node::peers_wanting_connection`] are pure queries; [`ChangeKind::Connections`] is
//!   reported, keyed by [`DEVICE`], when what they answer may have changed.

use std::collections::BTreeSet;

use super::records::{ChangeKind, EpochStatus, GroupStatus, NodeStorage};
use super::{Cx, Node, NodeError};
use crate::ids::{ChatId, GossipId};
use crate::rng::Randomness;
use crate::root::{Root, RootType};

/// The conversation format versions this release can continue (§5.12): `0`, the earlier
/// one-to-one format. A root naming another version is an ordinary root here.
pub const KNOWN_FORMAT_VERSIONS: &[u64] = &[0];

/// How long a consent to a direct chat with a new contact waits for the peer's root: two
/// weeks, the time the backend keeps a blob. Local policy.
pub const CONSENT_MS: u64 = 14 * super::timing::DAY_MS;

/// The key of the changes that concern the device rather than a group
/// ([`ChangeKind::Connections`]): no epoch has an all-zero ID.
pub const DEVICE: ChatId = ChatId::from_bytes([0; 32]);

/// What the caller chooses when founding a group, beyond its name and members.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct GroupOptions {
    /// The format version of the earlier conversation the group continues (§5.12); only on
    /// a group of two, this device and one other.
    pub migrate_from: Option<u64>,
    /// The message timer of the group, in milliseconds (§4.1, §7.7); 0 keeps messages
    /// forever.
    pub message_timer: u64,
}

/// The peers a device's connections are judged against (§5.12).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct ConnectionView {
    co_members: BTreeSet<GossipId>,
    listed: BTreeSet<GossipId>,
}

impl Node {
    // ── What the caller declares ─────────────────────────────────────────────

    /// Records (`held`) or clears that this device holds an earlier conversation of format
    /// `version` with `peer` (§5.12, condition 3). Declaring one may settle two creations at
    /// once that were waiting for it.
    ///
    /// # Errors
    ///
    /// A storage failure.
    pub fn set_earlier_conversation<S: NodeStorage>(
        &mut self,
        store: &mut S,
        peer: GossipId,
        version: u64,
        held: bool,
        now: u64,
        rng: &mut dyn Randomness,
    ) -> Result<(), NodeError> {
        self.run(store, now, rng, |n, cx| {
            if held {
                if !n.t.earlier.contains(&(peer, version)) {
                    n.t.earlier.insert((peer, version), cx.now);
                }
                n.settle_invitations_of(cx, peer)?;
            } else {
                n.t.earlier.remove(&(peer, version));
            }
            Ok(())
        })
    }

    /// The earlier conversations declared, as `(peer, format version)`.
    #[must_use]
    pub fn earlier_conversations(&self) -> Vec<(GossipId, u64)> {
        self.t.earlier.keys().copied().collect()
    }

    /// Gives (`consent`) or withdraws the consent to a group of two that `peer` creates and
    /// owns, after the user accepted its contact request (§5.12): the first such root from it
    /// is adopted as if the user had accepted it, within [`CONSENT_MS`]. One-shot.
    ///
    /// # Errors
    ///
    /// A storage failure.
    pub fn consent_to_direct_chat<S: NodeStorage>(
        &mut self,
        store: &mut S,
        peer: GossipId,
        consent: bool,
        now: u64,
        rng: &mut dyn Randomness,
    ) -> Result<(), NodeError> {
        self.run(store, now, rng, |n, cx| {
            if consent && peer != n.me {
                n.t.consents.insert(peer, cx.now.saturating_add(CONSENT_MS));
                n.settle_invitations_of(cx, peer)?;
            } else {
                n.t.consents.remove(&peer);
            }
            Ok(())
        })
    }

    /// Declares (`accepted`) or clears that `peer` is a contact the user accepted. Only such a
    /// peer is answered with a version notice when it sends a plaintext of a later wire
    /// version (§13.8): co-members whose connection is automatic and unknown peers get
    /// silence. Kept until cleared. The caller declares a contact when the user accepts it,
    /// clears it when the contact is removed, and declares its accepted contacts again at
    /// open (declaring one again changes nothing).
    ///
    /// # Errors
    ///
    /// A storage failure.
    pub fn set_accepted_contact<S: NodeStorage>(
        &mut self,
        store: &mut S,
        peer: GossipId,
        accepted: bool,
        now: u64,
        rng: &mut dyn Randomness,
    ) -> Result<(), NodeError> {
        self.run(store, now, rng, |n, cx| {
            if accepted && peer != n.me {
                if !n.t.contacts.contains(&peer) {
                    n.t.contacts.insert(peer, cx.now);
                }
            } else {
                n.t.contacts.remove(&peer);
            }
            Ok(())
        })
    }

    /// The contacts the user accepted, as declared ([`Node::set_accepted_contact`]).
    #[must_use]
    pub fn accepted_contacts(&self) -> Vec<GossipId> {
        self.t.contacts.keys().copied().collect()
    }

    /// The consents to a direct chat not used yet, with when each expires.
    #[must_use]
    pub fn direct_chat_consents(&self) -> Vec<(GossipId, u64)> {
        self.t.consents.iter().map(|(p, t)| (*p, *t)).collect()
    }

    // ── Classification ───────────────────────────────────────────────────────

    /// The other member of a root that founds a group of this device and its owner
    /// (conditions 1 and 2 of §5.12), as far as a device can tell: a successor root with one
    /// parent commitment that `parent_held` says matches nothing held, two members, this
    /// device and the owner.
    pub(crate) fn direct_owner(&self, root: &Root, parent_held: bool) -> Option<GossipId> {
        let owner = root.owner_id();
        (root.root_type() == RootType::Successor
            && root.parents().len() == 1
            && !parent_held
            && root.members().len() == 2
            && owner != self.me
            && root.is_member(&self.me))
        .then_some(owner)
    }

    /// The peer and format version of a root that founds an automatic group of this device
    /// and its owner (§5.12): conditions 1 and 2, with a `migrate_from` this release knows.
    /// Contact chats and migrations both carry it; "New group" never does.
    pub(crate) fn direct_creation(
        &self,
        root: &Root,
        parent_held: bool,
    ) -> Option<(GossipId, u64)> {
        let v = root.migrate_from()?;
        let peer = self.direct_owner(root, parent_held)?;
        KNOWN_FORMAT_VERSIONS.contains(&v).then_some((peer, v))
    }

    /// Whether this device holds a direct chat with `peer`: an installed epoch, in an active
    /// group whose current epoch still lists both, whose root founded an automatic group of
    /// the two (a successor with one parent commitment, those two members, a known
    /// `migrate_from`), whoever owns it and however the group grew since. A later creation
    /// from that peer is then an ordinary invitation. A chat that no longer lists one of the
    /// two (a signed decline, a leave, a removal) is not held.
    #[must_use]
    pub fn holds_direct_chat(&self, peer: &GossipId) -> bool {
        self.t.epochs.iter().any(|(c, r)| {
            r.status == EpochStatus::Installed
                && self.lists_both(c, *peer)
                && r.root.root_type() == RootType::Successor
                && r.root.parents().len() == 1
                && r.root.members().len() == 2
                && r.root.is_member(&self.me)
                && r.root.is_member(peer)
                && r.root
                    .migrate_from()
                    .is_some_and(|v| KNOWN_FORMAT_VERSIONS.contains(&v))
                && self.group_status(c) == GroupStatus::Active
        })
    }

    /// The peer whose earlier conversation `root` continues, when this device shows it as a
    /// migration (§5.12): an automatic group of the two, condition 3 as declared by the
    /// caller, and no direct chat with that peer held already.
    pub(crate) fn migration_peer(&self, root: &Root, parent_held: bool) -> Option<GossipId> {
        let (peer, v) = self.direct_creation(root, parent_held)?;
        (self.t.earlier.contains(&(peer, v)) && !self.holds_direct_chat(&peer)).then_some(peer)
    }

    /// The migration the held invitation `chat` is, if this device acts on it: the peer.
    #[must_use]
    pub fn migration_of(&self, chat: &ChatId) -> Option<GossipId> {
        let rec = self.t.epochs.get(chat)?;
        let EpochStatus::Invitation(inv) = &rec.status else {
            return None;
        };
        self.migration_peer(&rec.root, inv.rejoins.is_some())
    }

    /// This device's own migration group with `peer` at format `version` that a peer's
    /// creation pairs with: an installed root it created founding a group of the two with
    /// that `migrate_from`, in an active group that is still a chat of exactly the two,
    /// owned by this device.
    fn own_migration(&self, peer: GossipId, version: u64) -> Option<ChatId> {
        self.own_chats(peer, version)
            .into_iter()
            .find(|c| self.still_of_two(c, peer))
    }

    /// This device's own automatic chat with `peer` at format `version` that no longer
    /// lists `peer`, of this device alone (§5.12): history only, competing in no tie. A new
    /// chat of `peer` is an invitation to continue it.
    fn own_former_chat(&self, peer: GossipId, version: u64) -> Option<ChatId> {
        self.own_chats(peer, version).into_iter().find(|c| {
            self.current_epoch(c)
                .and_then(|e| self.t.epochs.get(&e))
                .is_some_and(|r| r.root.members() == [self.me])
        })
    }

    /// The installed roots this device created founding an automatic group of it and
    /// `peer` with that `migrate_from`, in active groups, in order.
    fn own_chats(&self, peer: GossipId, version: u64) -> Vec<ChatId> {
        self.t
            .epochs
            .iter()
            .filter(|(c, r)| {
                r.status == EpochStatus::Installed
                    && r.from == self.me
                    && r.parents.is_empty()
                    && r.root.owner_id() == self.me
                    && r.root.root_type() == RootType::Successor
                    && r.root.parents().len() == 1
                    && r.root.migrate_from() == Some(version)
                    && r.root.members().len() == 2
                    && r.root.is_member(&peer)
                    && self.group_status(c) == GroupStatus::Active
            })
            .map(|(c, _)| *c)
            .collect()
    }

    /// Whether the current epoch of the group of `chat` is owned by this device and lists
    /// exactly this device and `peer`.
    fn still_of_two(&self, chat: &ChatId, peer: GossipId) -> bool {
        self.lists_both(chat, peer)
            && self
                .current_epoch(&self.group_of(chat))
                .and_then(|c| self.t.epochs.get(&c))
                .is_some_and(|r| r.root.owner_id() == self.me && r.root.members().len() == 2)
    }

    /// Whether the current epoch of the group of `chat` lists both this device and `peer`.
    fn lists_both(&self, chat: &ChatId, peer: GossipId) -> bool {
        self.current_epoch(&self.group_of(chat))
            .and_then(|c| self.t.epochs.get(&c))
            .is_some_and(|r| r.root.is_member(&self.me) && r.root.is_member(&peer))
    }

    /// The peer's migration groups with this device at format `version` that this device
    /// installed (accepted or adopted): founded by the peer's root, continued by no
    /// successor it holds, in an active group.
    fn peer_migrations(&self, peer: GossipId, version: u64) -> Vec<ChatId> {
        self.t
            .epochs
            .iter()
            .filter(|(c, r)| {
                r.status == EpochStatus::Installed
                    && r.parents.is_empty()
                    && r.root.migrate_from() == Some(version)
                    && self.direct_owner(&r.root, false) == Some(peer)
                    && self.gx.children.get(c).is_none_or(BTreeSet::is_empty)
                    && self.group_status(c) == GroupStatus::Active
                    && self.lists_both(c, peer)
            })
            .map(|(c, _)| *c)
            .collect()
    }

    // ── Acting on a received root ────────────────────────────────────────────

    /// What receiving the valid root `root` from `from` does under §5.12, before the cases
    /// of §4.8 (`parent_held`: a parent commitment matched a held epoch or a closed-chat
    /// marker). Returns whether the root was handled here.
    pub(crate) fn receive_direct(
        &mut self,
        cx: &mut Cx<'_>,
        from: GossipId,
        root: &Root,
        parent_held: bool,
        closed_before: bool,
    ) -> Result<bool, NodeError> {
        let Some((peer, v)) = self.direct_creation(root, parent_held) else {
            return Ok(false);
        };
        if let Some(mine) = self.own_migration(peer, v) {
            if self.continues_mine(root, mine) {
                // An invitation to continue the conversation in the peer's chat.
                return Ok(false);
            }
            self.settle_pair(cx, mine, root.clone(), from)?;
            return Ok(true);
        }
        if self.own_former_chat(peer, v).is_some() {
            // Always an invitation to continue the chat the peer is no longer in.
            return Ok(false);
        }
        if !closed_before
            && !self.holds_direct_chat(&peer)
            && self
                .t
                .consents
                .get(&peer)
                .is_some_and(|until| *until > cx.now)
        {
            self.t.consents.remove(&peer);
            self.adopt(cx, root.clone(), from, Vec::new(), false)?;
            self.changed(root.chat_id(), ChangeKind::Joined, cx.now);
            return Ok(true);
        }
        Ok(false)
    }

    /// Two automatic chats for one pair (§5.12): `mine`, this device's own migration group,
    /// and `theirs`, the peer's creating root, not installed here. The group the tie rule
    /// keeps ([`Node::keeps_mine`]) continues; the other is held superseded at once.
    fn settle_pair(
        &mut self,
        cx: &mut Cx<'_>,
        mine: ChatId,
        theirs: Root,
        from: GossipId,
    ) -> Result<(), NodeError> {
        let id = theirs.chat_id();
        if self.t.epochs.contains(&id) {
            // An invitation: replaced by the outcome.
            self.take_record(&id);
            self.t.events.remove(&(id, ChangeKind::Invitation));
            self.drop_tasks_of(&[id]);
            self.drop_fetched_for(id);
        }
        self.take_marker(&id);
        if !self.keeps_mine(&theirs) {
            self.adopt(cx, theirs, from, Vec::new(), false)?;
            self.changed(id, ChangeKind::Joined, cx.now);
            self.supersede(cx, mine, id)?;
        } else {
            // This device's group is kept; the peer's is held superseded by it, with the
            // messages the peer wrote there before it switched. A copy delivered again is a
            // duplicate.
            let by = self.group_of(&mine);
            self.group_rec_mut(id).status = GroupStatus::Superseded { by, at: cx.now };
            let peer = theirs.owner_id();
            self.adopt(cx, theirs, from, Vec::new(), false)?;
            self.supersede(cx, id, mine)?;
            // The peer founded its chat without holding this one: lost on the way, or the
            // peer restored a backup made before. It gets this device's root again.
            self.queue_object(peer, mine, crate::wire::EntryItem::Root);
        }
        Ok(())
    }

    /// Supersedes this device's automatic chat `group` by `by`, the chat of the same two
    /// that continues it (§5.12): nothing is erased; it becomes read-only and sends nothing
    /// more, `by` lists it (and what it superseded) among its earlier chats, and the change
    /// is reported with whether it holds messages.
    pub(crate) fn supersede(
        &mut self,
        cx: &mut Cx<'_>,
        group: ChatId,
        by: ChatId,
    ) -> Result<(), NodeError> {
        let group = self.group_of(&group);
        let by = self.group_of(&by);
        if group == by
            || self
                .t
                .group_recs
                .get(&by)
                .is_some_and(|g| g.earlier.contains(&group))
        {
            return Ok(());
        }
        let mut has_messages = false;
        for e in self.group_epochs(&group) {
            if !cx.ov.held_ids(&e)?.is_empty() {
                has_messages = true;
            }
        }
        // What was queued before the switch still goes: the peer gets the chat it replaces,
        // by its founding root, which §5.12 recognises. A root or signed object of a later
        // epoch is not pushed: a device without its parent (an account reinstalled, say)
        // cannot tell that root from a new group and would show it as an ordinary invitation.
        let later: Vec<super::records::WorkKey> = self
            .t
            .queue
            .iter()
            .filter(|(_, w)| {
                matches!(w, super::records::Work::Object { chat_id, .. }
                    if *chat_id != group && self.group_of(chat_id) == group)
            })
            .map(|(k, _)| *k)
            .collect();
        for k in later {
            self.remove_queued(&k);
        }
        self.queued_objects_in_full(group);
        let before = {
            let g = self.group_rec_mut(group);
            g.status = GroupStatus::Superseded { by, at: cx.now };
            g.pending_removals.clear();
            g.earlier.clone()
        };
        let b = self.group_rec_mut(by);
        for e in before.into_iter().chain([group]) {
            if !b.earlier.contains(&e) {
                b.earlier.push(e);
            }
        }
        self.stop_sync(group);
        self.rebuild_epochs();
        self.changed(group, ChangeKind::Superseded { by, has_messages }, cx.now);
        self.changed(by, ChangeKind::Membership, cx.now);
        Ok(())
    }

    /// Records that the other person of an automatic chat of two this device founded took
    /// part in it (§5.12): `from` sent it, about an epoch `chat` of it, a message event, a
    /// notice of one or a query about its messages. A local fact, kept for good, with no
    /// date.
    pub(crate) fn note_participation(&mut self, chat: &ChatId, from: GossipId) {
        if from == self.me || !self.t.epochs.contains(chat) {
            return;
        }
        let group = self.group_of(chat);
        if self.t.group_recs.get(&group).is_some_and(|g| g.took_part)
            || !self.own_direct_chat(&group)
            || !self
                .t
                .epochs
                .get(&group)
                .is_some_and(|r| r.root.is_member(&from))
        {
            return;
        }
        self.group_rec_mut(group).took_part = true;
    }

    /// Whether the tie rule keeps this device's own chat `mine` against the peer's creating
    /// root `theirs` for the same two and `migrate_from`, both still listing both (§5.12):
    /// its own GossipID sorts first.
    fn keeps_mine(&self, theirs: &Root) -> bool {
        self.me.as_bytes() < theirs.owner_id().as_bytes()
    }

    /// Whether the peer's creating root `theirs`, for the same two and `migrate_from` as
    /// this device's own chat `mine`, is an invitation to continue the conversation rather
    /// than a switch without a prompt (§5.12): the peer's chat wins the tie, and the peer took
    /// part in `mine`. The side that keeps its own chat is never asked.
    fn continues_mine(&self, theirs: &Root, mine: ChatId) -> bool {
        !self.keeps_mine(theirs)
            && self
                .t
                .group_recs
                .get(&self.group_of(&mine))
                .is_some_and(|g| g.took_part)
    }

    /// The chat of this device that the creating root `root` of a peer (an invitation)
    /// continues (§5.12): its own automatic chat with that peer, either listing both, which
    /// `root` wins by the tie rule and in which the peer took part, or no longer listing the
    /// peer. Accepting it supersedes that chat.
    pub(crate) fn continued_by(&self, root: &Root, parent_held: bool) -> Option<ChatId> {
        let (peer, v) = self.direct_creation(root, parent_held)?;
        match self.own_migration(peer, v) {
            Some(mine) => self
                .continues_mine(root, mine)
                .then(|| self.group_of(&mine)),
            None => self.own_former_chat(peer, v).map(|c| self.group_of(&c)),
        }
    }

    /// Whether `group` is an automatic chat of two this device founded (§5.12): its first
    /// epoch is a creating root of this device and one other, with a known `migrate_from`.
    pub(crate) fn own_direct_chat(&self, group: &ChatId) -> bool {
        self.t.epochs.get(group).is_some_and(|r| {
            r.parents.is_empty()
                && r.root.owner_id() == self.me
                && r.root.root_type() == RootType::Successor
                && r.root.parents().len() == 1
                && r.root.members().len() == 2
                && r.root
                    .migrate_from()
                    .is_some_and(|v| KNOWN_FORMAT_VERSIONS.contains(&v))
        })
    }

    /// Settles the held invitations from `peer` that this device now acts on: a migration
    /// that pairs with its own, or a group of two it consents to.
    fn settle_invitations_of(&mut self, cx: &mut Cx<'_>, peer: GossipId) -> Result<(), NodeError> {
        let invitations: Vec<ChatId> = self
            .t
            .epochs
            .iter()
            .filter(|(_, r)| {
                matches!(&r.status, EpochStatus::Invitation(i) if i.fetched_for.is_none())
                    && r.root.owner_id() == peer
            })
            .map(|(c, _)| *c)
            .collect();
        for c in invitations {
            let Some(rec) = self.t.epochs.get(&c).cloned() else {
                continue;
            };
            let EpochStatus::Invitation(inv) = &rec.status else {
                continue;
            };
            if inv.closed_before {
                continue;
            }
            let parent_held = inv.rejoins.is_some();
            let Some((_, v)) = self.direct_creation(&rec.root, parent_held) else {
                continue;
            };
            if let Some(mine) = self.own_migration(peer, v) {
                if !self.continues_mine(&rec.root, mine) {
                    self.settle_pair(cx, mine, rec.root, rec.from)?;
                }
                continue;
            }
            if self.own_former_chat(peer, v).is_some() {
                continue;
            }
            if !self.holds_direct_chat(&peer)
                && self
                    .t
                    .consents
                    .get(&peer)
                    .is_some_and(|until| *until > cx.now)
            {
                self.t.consents.remove(&peer);
                self.take_record(&c);
                self.t.events.remove(&(c, ChangeKind::Invitation));
                self.drop_tasks_of(&[c]);
                self.adopt(cx, rec.root, rec.from, Vec::new(), false)?;
                self.changed(c, ChangeKind::Joined, cx.now);
            }
        }
        Ok(())
    }

    /// After this device founded `created`: a held migration invitation from the same peer
    /// with the same `migrate_from` pairs with it.
    pub(crate) fn settle_created(
        &mut self,
        cx: &mut Cx<'_>,
        created: &Root,
    ) -> Result<(), NodeError> {
        let Some(v) = created.migrate_from() else {
            return Ok(());
        };
        let Some(peer) = created.members().iter().find(|m| **m != self.me).copied() else {
            return Ok(());
        };
        if KNOWN_FORMAT_VERSIONS.contains(&v) && peer.as_bytes() > self.me.as_bytes() {
            // The peer's migration accepted before: this device's own sorts first.
            for c in self.peer_migrations(peer, v) {
                self.supersede(cx, c, created.chat_id())?;
            }
        }
        if KNOWN_FORMAT_VERSIONS.contains(&v) {
            // An automatic chat of the two this device was removed from or left is the
            // earlier part of the conversation the new chat continues; it stays as it is.
            let by = self.group_of(&created.chat_id());
            let read_only: Vec<ChatId> = self
                .gx
                .current
                .keys()
                .filter(|g| {
                    **g != by
                        && matches!(
                            self.group_status(g),
                            GroupStatus::Removed { .. } | GroupStatus::Left { .. }
                        )
                        && self.t.epochs.get(g).is_some_and(|r| {
                            r.root.root_type() == RootType::Successor
                                && r.root.parents().len() == 1
                                && r.root.migrate_from() == Some(v)
                                && r.root.members().len() == 2
                                && r.root.is_member(&self.me)
                                && r.root.is_member(&peer)
                        })
                })
                .copied()
                .collect();
            for g in read_only {
                let b = self.group_rec_mut(by);
                if !b.earlier.contains(&g) {
                    b.earlier.push(g);
                }
            }
        }
        self.settle_invitations_of(cx, peer)
    }

    /// Expired consents go (§5.12).
    pub(crate) fn direct_timers(&mut self, cx: &mut Cx<'_>) {
        let expired: Vec<GossipId> = self
            .t
            .consents
            .iter()
            .filter(|(_, until)| **until <= cx.now)
            .map(|(p, _)| *p)
            .collect();
        for p in expired {
            self.t.consents.remove(&p);
        }
    }

    /// The earliest expiry of a consent.
    pub(crate) fn direct_wakeup(&self) -> Option<u64> {
        self.t.consents.iter().map(|(_, t)| *t).min()
    }

    // ── Connections ──────────────────────────────────────────────────────────

    /// The active ends of the groups this device holds and has accepted, in which it is a
    /// member: not invitations, and not groups it left, was removed from, waits to be
    /// removed from or that were dissolved.
    fn accepted_ends(&self) -> Vec<ChatId> {
        self.gx
            .current
            .keys()
            .filter(|g| self.group_status(g) == GroupStatus::Active)
            .flat_map(|g| self.ends(g))
            .filter(|e| {
                self.t
                    .epochs
                    .get(e)
                    .is_some_and(|r| r.root.is_member(&self.me))
            })
            .collect()
    }

    /// Whether `peer` is a member of a group this device holds and has accepted (§5.12): a
    /// connection it asks for may be opened automatically.
    #[must_use]
    pub fn is_co_member(&self, peer: &GossipId) -> bool {
        *peer != self.me
            && self
                .accepted_ends()
                .iter()
                .any(|e| self.t.epochs.get(e).is_some_and(|r| r.root.is_member(peer)))
    }

    /// The members of groups this device has accepted, other than itself, with which it has
    /// no session ([`Node::set_session`]): the connections the caller may open.
    #[must_use]
    pub fn peers_wanting_connection(&self) -> Vec<GossipId> {
        self.connection_view()
            .co_members
            .into_iter()
            .filter(|p| !self.sessions.contains(p))
            .collect()
    }

    /// Among `candidates`, the peers whose automatic connection may be revoked (§5.12, D.86):
    /// no chat that keeps connections lists them, as a member or a removed peer, and nothing
    /// pushed whole is still queued for them. The caller never revokes a peer its user
    /// accepted.
    ///
    /// The chats that keep connections: an active group (the replies owed to a member it
    /// removed, §5.6, and the deletions still served to it, §10.4, keep working), the waiting
    /// state (the kick can come from any member), the archive of a group dissolved while
    /// active, an invitation, and a handover root kept for its parent. A group the device is
    /// out of keeps none, whether the user keeps its history read-only or deletes it: kicked,
    /// left, or superseded.
    ///
    /// Why: a member that shares nothing else with this device sees its keep-alives stop when
    /// the chat is deleted; were they kept with the read-only history, that member could tell
    /// the two apart. The cost: a kept history no longer receives the later deletions or a
    /// "Dissolve & Delete" from such members, as a deleted chat does not.
    ///
    /// The waiting state ends with the kick or, after two weeks without one
    /// ([`super::objects::WAITING_MS`]), with the device leaving quietly as "Ignore and Delete"
    /// does (roots deleted, the entry gone, the user still in the member list for the
    /// others); either way the chat is closed and its connections go then.
    ///
    /// A visible leave closes the chat, and its signed leave is pushed whole to each member
    /// afterwards (a queued blob): a peer is not revocable until it was handed off for it, or
    /// revoking the session would lose it.
    #[must_use]
    pub fn connections_to_revoke(&self, candidates: &[GossipId]) -> Vec<GossipId> {
        let view = self.connection_view();
        let mut out: Vec<GossipId> = candidates
            .iter()
            .filter(|p| **p != self.me && !view.listed.contains(p))
            .copied()
            .collect();
        out.sort_unstable();
        out.dedup();
        out
    }

    pub(crate) fn connection_view(&self) -> ConnectionView {
        let mut co_members = BTreeSet::new();
        for e in self.accepted_ends() {
            if let Some(r) = self.t.epochs.get(&e) {
                co_members.extend(r.root.members().iter().copied());
            }
        }
        co_members.remove(&self.me);
        let mut listed = co_members.clone();
        for (c, r) in self.t.epochs.iter() {
            if r.status == EpochStatus::Installed && !self.keeps_connections(c) {
                continue;
            }
            listed.extend(r.root.members().iter().copied());
            listed.extend(r.removed_override.iter().copied());
        }
        for (_, h) in self.t.held_roots.iter() {
            listed.extend(h.root.members().iter().copied());
        }
        // What is pushed whole after a close (a signed leave, the roots and objects of a
        // leaving owner) is owed until handed off.
        for (k, w) in self.t.queue.iter() {
            if matches!(w, super::records::Work::Blob(_)) {
                listed.insert(k.0);
            }
        }
        listed.remove(&self.me);
        ConnectionView { co_members, listed }
    }

    /// Whether the installed epoch `chat` keeps the connections with its members (see
    /// [`Node::connections_to_revoke`]): not once the device is out of its group, kicked,
    /// left or superseded, whether the history is kept or not.
    fn keeps_connections(&self, chat: &ChatId) -> bool {
        !matches!(
            self.group_status(chat),
            GroupStatus::Removed { .. } | GroupStatus::Left { .. } | GroupStatus::Superseded { .. }
        )
    }

    /// Reports [`ChangeKind::Connections`] when what the connection queries answer changed
    /// in this operation.
    pub(crate) fn connections_changed(&mut self, cx: &mut Cx<'_>) {
        if self.t.epochs.dirty_keys().is_empty()
            && self.t.group_recs.dirty_keys().is_empty()
            && self.t.held_roots.dirty_keys().is_empty()
            && self.t.queue.dirty_keys().is_empty()
        {
            return;
        }
        let view = self.connection_view();
        if view != self.conn_view {
            self.conn_view = view;
            self.changed(DEVICE, ChangeKind::Connections, cx.now);
        }
    }

    /// Founds a group with options (§4.6, §5.12); see [`Node::create_group`].
    pub(crate) fn found_group(
        &mut self,
        cx: &mut Cx<'_>,
        signer: &dyn crate::keys::IdentitySigner,
        name: String,
        members: Vec<GossipId>,
        options: GroupOptions,
    ) -> Result<ChatId, NodeError> {
        use crate::ids::{Challenge, GroupSecret};
        use crate::rng::bytes;
        use crate::wire::EntryItem;
        self.remember_own_keys(cx, signer);
        let mut members: BTreeSet<GossipId> = members.into_iter().collect();
        members.insert(self.me);
        // §5.12: a group of two whose peer's creation this device holds and that sorts
        // first is that one; no second group is founded.
        if let Some(v) = options.migrate_from
            && members.len() == 2
            && let Some(peer) = members.iter().find(|m| **m != self.me).copied()
            && peer.as_bytes() < self.me.as_bytes()
        {
            let theirs = self
                .t
                .epochs
                .iter()
                .find(|(_, r)| {
                    matches!(&r.status, EpochStatus::Invitation(i)
                        if !i.closed_before
                            && self.direct_creation(&r.root, i.rejoins.is_some())
                                == Some((peer, v)))
                })
                .map(|(c, r)| (*c, r.clone()));
            if let Some((c, rec)) = theirs {
                self.take_record(&c);
                self.t.events.remove(&(c, ChangeKind::Invitation));
                self.drop_tasks_of(&[c]);
                self.adopt(cx, rec.root, rec.from, Vec::new(), false)?;
                self.changed(c, ChangeKind::Joined, cx.now);
                return Ok(self.group_of(&c));
            }
            // The peer's migration, accepted before: that group is the conversation.
            if let Some(c) = self.peer_migrations(peer, v).into_iter().min() {
                return Ok(self.group_of(&c));
            }
        }
        // A single commitment to a fresh random dummy ID, then discarded (§4.5).
        let dummy = ChatId::from_bytes(bytes(cx.rng));
        let params = crate::root::RootParams {
            name,
            members: members.into_iter().collect(),
            group_secret: GroupSecret::from_bytes(bytes(cx.rng)),
            owner: signer.public_keys().clone(),
            epoch_challenge: Challenge::from_bytes(bytes(cx.rng)),
            ref_chat_id_challenge: Challenge::from_bytes(bytes(cx.rng)),
            created_at: cx.now,
            message_timer: options.message_timer,
            settings: std::collections::BTreeMap::new(),
        };
        let root =
            Root::create_founding(params, dummy, options.migrate_from, signer, bytes(cx.rng))
                .map_err(NodeError::Root)?;
        let id = root.chat_id();
        self.stats.roots_created += 1;
        self.adopt(cx, root.clone(), self.me, Vec::new(), false)?;
        self.changed(id, ChangeKind::Joined, cx.now);
        for m in root.members() {
            if *m != self.me {
                self.queue_object(*m, id, EntryItem::Root);
            }
        }
        self.settle_created(cx, &root)?;
        Ok(id)
    }
}
