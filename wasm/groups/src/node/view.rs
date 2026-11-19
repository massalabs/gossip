//! The state the user interface needs (§4.8, §5, §7.5), as plain queries on the engine:
//! the groups with their name, members, owner and the device's status; the pending
//! invitations; the ordered timeline of a group, epoch changes included; and the changes
//! since the last call. No UI concern: names are returned as stored, never sanitised (the
//! display rules of §5.11 belong to the interface).

use std::collections::BTreeSet;

use super::records::{ChangeKind, EpochStatus, GroupStatus, NodeStorage, SignedObject};
use super::{Node, NodeError};
use crate::display::{self, VisibleMessage};
use crate::ids::{ChatId, GossipId};
use crate::rng::Randomness;
use crate::store::StorageRead;

/// The device's status in a group.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MyStatus {
    /// A member of the current epoch.
    Member,
    /// Waiting for the owner to remove it ("Ask to be kicked", §5.4).
    Waiting,
    /// Read-only after receiving its own leave, sent from another copy of the account (D.2).
    Left,
    /// Read-only after a kick (§5.6).
    Removed,
    /// Dissolved by the owner (§5.8); with `deleted`, the messages were erased.
    Dissolved {
        /// "Dissolve & Delete".
        deleted: bool,
    },
}

/// A group as listed (§4.8, §4.9, §5.10, §5.11).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GroupSummary {
    /// The group key (local).
    pub group: ChatId,
    /// The current epoch.
    pub current: ChatId,
    /// The group name of the current epoch, as stored (§5.11).
    pub name: String,
    /// The local name, if set.
    pub local_name: Option<String>,
    /// The members of the current epoch, ascending.
    pub members: Vec<GossipId>,
    /// The owner of the current epoch.
    pub owner: GossipId,
    /// The device's status.
    pub status: MyStatus,
    /// The other ends: side branches, still readable (§4.9, §5.9).
    pub side_branches: Vec<ChatId>,
    /// This device owns competing ends and must resolve them before sending (§4.9).
    pub must_resolve: bool,
    /// The groups linked by hand (§5.10).
    pub links: Vec<ChatId>,
}

/// An invitation to answer (§4.8).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InvitationSummary {
    /// The epoch.
    pub chat_id: ChatId,
    /// Its name, as stored.
    pub name: String,
    /// Its members.
    pub members: Vec<GossipId>,
    /// Its owner, verified by the signature.
    pub owner: GossipId,
    /// The peer that delivered it, when it is not the owner ("received from").
    pub received_from: Option<GossipId>,
    /// It was closed on this device before (§14.2): deleted content may reappear.
    pub closed_before: bool,
    /// It continues a group this device was removed from or that was dissolved (§4.8 case
    /// 4): accepting rejoins that conversation (§5.10).
    pub rejoins: Option<ChatId>,
}

/// A line of the timeline (§5.6, §5.8, §5.10, §7.5).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TimelineLine {
    /// The first epoch held of the group.
    Founded {
        /// The epoch.
        epoch: ChatId,
        /// Its owner.
        owner: GossipId,
    },
    /// A root that changed the members, the name or the owner, at its time `T`.
    EpochChange {
        /// The new epoch.
        epoch: ChatId,
        /// Its owner (who made the change).
        owner: GossipId,
        /// Members added.
        added: Vec<GossipId>,
        /// Members removed, whose leave the device does not hold (D.9).
        removed: Vec<GossipId>,
        /// Members removed whose signed leave the device holds: shown as having left.
        left: Vec<GossipId>,
        /// The new name, when it changed.
        renamed: Option<String>,
        /// The new owner, when it changed.
        new_owner: Option<GossipId>,
    },
    /// "You were removed from this group".
    YouWereRemoved,
    /// "You left this group" (D.2).
    YouLeft,
    /// "This group was dissolved by its owner".
    Dissolved,
    /// "You were not a member between `from` and `to`" (§5.10).
    NotAMember {
        /// When the kick was received.
        from: u64,
        /// The time `T` of the root that added the device back.
        to: u64,
    },
}

/// An item of the timeline, in order.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TimelineItem {
    /// A visible message (§7.5).
    Message(VisibleMessage),
    /// A line, at the time it is placed at.
    Line {
        /// Where it is placed.
        at: u64,
        /// What it says.
        line: TimelineLine,
    },
}

impl TimelineItem {
    fn order(&self) -> (u64, u8, [u8; 32], ChatId) {
        match self {
            TimelineItem::Message(m) => (m.content.created_at, 1, m.result_hash, m.chat_id),
            TimelineItem::Line { at, line } => {
                let epoch = match line {
                    TimelineLine::Founded { epoch, .. }
                    | TimelineLine::EpochChange { epoch, .. } => *epoch,
                    _ => ChatId::from_bytes([0xff; 32]),
                };
                (*at, 0, [0; 32], epoch)
            }
        }
    }
}

/// What changed in a group since the last [`Node::take_changes`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Change {
    /// The group key, or the epoch of an invitation.
    pub group: ChatId,
    /// What changed.
    pub kind: ChangeKind,
}

impl Node {
    /// The groups on this device, by key.
    #[must_use]
    pub fn groups(&self) -> Vec<GroupSummary> {
        let mut out = Vec::new();
        for (group, current) in &self.gx.current {
            let Some(rec) = self.t.epochs.get(current) else {
                continue;
            };
            let g = self.t.group_recs.get(group);
            let status = match g.map_or(GroupStatus::Active, |g| g.status) {
                GroupStatus::Active => MyStatus::Member,
                GroupStatus::Waiting { .. } => MyStatus::Waiting,
                GroupStatus::Left { .. } => MyStatus::Left,
                GroupStatus::Removed { .. } => MyStatus::Removed,
                GroupStatus::Dissolved { must_delete, .. } => MyStatus::Dissolved {
                    deleted: must_delete,
                },
            };
            let must_resolve =
                rec.root.owner_id() == self.me && !self.fork_to_resolve(group).is_empty();
            out.push(GroupSummary {
                group: *group,
                current: *current,
                name: rec.root.name().to_owned(),
                local_name: g.and_then(|g| g.local_name.clone()),
                members: rec.root.members().to_vec(),
                owner: rec.root.owner_id(),
                status,
                side_branches: self
                    .ends(group)
                    .into_iter()
                    .filter(|e| e != current)
                    .collect(),
                must_resolve,
                links: g
                    .map(|g| g.links.iter().copied().collect())
                    .unwrap_or_default(),
            });
        }
        out
    }

    /// The group whose key or epoch is `chat`.
    #[must_use]
    pub fn group(&self, chat: &ChatId) -> Option<GroupSummary> {
        let g = self.group_of(chat);
        self.groups().into_iter().find(|s| s.group == g)
    }

    /// The invitations whose prompt is due at `now` (§4.8).
    #[must_use]
    pub fn invitations(&self, now: u64) -> Vec<InvitationSummary> {
        self.t
            .epochs
            .iter()
            .filter(|(c, _)| self.prompt_due(c, now))
            .filter_map(|(c, r)| match &r.status {
                EpochStatus::Invitation(inv) => Some(InvitationSummary {
                    chat_id: *c,
                    name: r.root.name().to_owned(),
                    members: r.root.members().to_vec(),
                    owner: r.root.owner_id(),
                    received_from: (r.from != r.root.owner_id()).then_some(r.from),
                    closed_before: inv.closed_before,
                    rejoins: inv.rejoins,
                }),
                EpochStatus::Installed => None,
            })
            .collect()
    }

    /// The timeline of the group of `chat` at `now`: its visible messages from every
    /// epoch and side branch (and from the groups linked to it by hand), with the lines of
    /// its roots at their time `T` and of the signed objects that made it read-only at their
    /// receipt, in one order (§7.5).
    ///
    /// # Errors
    ///
    /// A storage failure.
    pub fn timeline<S: StorageRead>(
        &self,
        store: &S,
        chat: &ChatId,
        now: u64,
    ) -> Result<Vec<TimelineItem>, NodeError> {
        let group = self.group_of(chat);
        let mut groups = vec![group];
        if let Some(g) = self.t.group_recs.get(&group) {
            groups.extend(g.links.iter().copied());
        }
        let epochs: Vec<ChatId> = groups.iter().flat_map(|g| self.group_epochs(g)).collect();
        let mut items: Vec<TimelineItem> = display::view(store, &epochs, now)?
            .into_iter()
            .map(TimelineItem::Message)
            .collect();
        for e in &epochs {
            let Some(rec) = self.t.epochs.get(e) else {
                continue;
            };
            let at = rec.line_time.unwrap_or(rec.received_at);
            let root = &rec.root;
            if rec.parents.is_empty() {
                items.push(TimelineItem::Line {
                    at,
                    line: TimelineLine::Founded {
                        epoch: *e,
                        owner: root.owner_id(),
                    },
                });
                continue;
            }
            let parents: Vec<&crate::root::Root> = rec
                .parents
                .iter()
                .filter_map(|p| self.t.epochs.get(p).map(|r| &r.root))
                .collect();
            let before: BTreeSet<GossipId> = parents
                .iter()
                .flat_map(|p| p.members().iter().copied())
                .collect();
            let after: BTreeSet<GossipId> = root.members().iter().copied().collect();
            let gone: Vec<GossipId> = before.difference(&after).copied().collect();
            let (left, removed): (Vec<GossipId>, Vec<GossipId>) = gone.into_iter().partition(|m| {
                rec.parents.iter().any(|p| {
                    self.t.signed.contains(&(
                        *p,
                        crate::wire::SignedKind::Leave,
                        *crate::hash::leave_id(p, m).as_bytes(),
                    ))
                })
            });
            let first = parents.first();
            items.push(TimelineItem::Line {
                at,
                line: TimelineLine::EpochChange {
                    epoch: *e,
                    owner: root.owner_id(),
                    added: after.difference(&before).copied().collect(),
                    removed,
                    left,
                    renamed: first
                        .filter(|p| p.name() != root.name())
                        .map(|_| root.name().to_owned()),
                    new_owner: first
                        .filter(|p| p.owner_id() != root.owner_id())
                        .map(|_| root.owner_id()),
                },
            });
        }
        if let Some(g) = self.t.group_recs.get(&group) {
            match g.status {
                GroupStatus::Removed { at, .. } => items.push(TimelineItem::Line {
                    at,
                    line: TimelineLine::YouWereRemoved,
                }),
                GroupStatus::Left { at, .. } => items.push(TimelineItem::Line {
                    at,
                    line: TimelineLine::YouLeft,
                }),
                GroupStatus::Dissolved { at, .. } => items.push(TimelineItem::Line {
                    at,
                    line: TimelineLine::Dissolved,
                }),
                GroupStatus::Active | GroupStatus::Waiting { .. } => {}
            }
            for (from, to) in &g.junctions {
                items.push(TimelineItem::Line {
                    at: *from,
                    line: TimelineLine::YouWereRemoved,
                });
                items.push(TimelineItem::Line {
                    at: *from,
                    line: TimelineLine::NotAMember {
                        from: *from,
                        to: *to,
                    },
                });
            }
        }
        items.sort_by_key(TimelineItem::order);
        Ok(items)
    }

    /// The members of `chat` whose signed leave this device holds, for any epoch.
    #[must_use]
    pub fn leavers(&self, chat: &ChatId) -> Vec<GossipId> {
        self.t
            .signed
            .iter()
            .filter(|(k, _)| k.0 == *chat)
            .filter_map(|(_, r)| match &r.object {
                SignedObject::Leave(l) => Some(l.leaver()),
                _ => None,
            })
            .collect()
    }

    /// The verified keys held for an identity, as `bincode(UserPublicKeys)` (§4.3).
    #[must_use]
    pub fn keys(&self, id: &GossipId) -> Option<Vec<u8>> {
        self.t.keys.get(id).cloned()
    }

    /// The root of an epoch held by this device.
    #[must_use]
    pub fn root(&self, chat: &ChatId) -> Option<crate::root::Root> {
        self.held_root(chat).cloned()
    }

    /// The changes since the last call, each reported once (stored with the operation that
    /// caused it and removed by this one, across failed commits and restarts).
    ///
    /// # Errors
    ///
    /// A storage failure; nothing was removed and nothing is returned.
    pub fn take_changes<S: NodeStorage>(
        &mut self,
        store: &mut S,
        now: u64,
        rng: &mut dyn Randomness,
    ) -> Result<Vec<Change>, NodeError> {
        if self.t.events.len() == 0 {
            return Ok(Vec::new());
        }
        self.run(store, now, rng, |n, _cx| {
            let keys: Vec<(ChatId, ChangeKind)> = n.t.events.keys().copied().collect();
            for k in &keys {
                n.t.events.remove(k);
            }
            Ok(keys
                .into_iter()
                .map(|(group, kind)| Change { group, kind })
                .collect())
        })
    }

    /// Starts a shared-chats scan of `peer` (§4.11): to send to contacts after reinstalling,
    /// or when the user looks for shared groups.
    ///
    /// # Errors
    ///
    /// A storage failure.
    pub fn scan_shared_chats<S: NodeStorage>(
        &mut self,
        store: &mut S,
        peer: GossipId,
        now: u64,
        rng: &mut dyn Randomness,
    ) -> Result<(), NodeError> {
        self.run(store, now, rng, |n, cx| {
            n.scan_shared(cx, peer);
            Ok(())
        })
    }
}
