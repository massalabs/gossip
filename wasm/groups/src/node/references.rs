//! Replies that name an epoch by its reference (§4.5, §7.6, §12.7): the requester side of a
//! chat lookup by reference, and the fetch of a target in an epoch this device holds.
//!
//! When a reply is received, each of its targets is placed against what the device holds:
//! an installed epoch or an invitation not answered yet. A reference the device cannot place
//! is looked up by reference, in rounds, from the members of the chat the reply was written
//! in. All of it is local
//! policy and local storage ([`RefLookup`]); nothing here adds to the wire format.
//!
//! **When.** Only on receipt of a reply, after a short random wait
//! ([`REF_LOOKUP_DELAY_MS`]); never on display or reading, and no call of the engine starts
//! it. Why: a lookup made when the user opens the message would tell a peer when it was
//! read.
//!
//! **Never for what the device can place.** An installed epoch and an invitation not
//! answered yet are never asked for.
//!
//! **What comes back** goes through the normal reception of a root (§4.8): a skipped epoch
//! of a group the device is in joins that group's history without a prompt, a group the
//! user was added to whose invitation never arrived becomes an invitation. Nothing is
//! fetched in an epoch the user has not accepted.

use super::records::{RefLookup, RefReply, Target, TaskKey};
use super::timing::{
    REF_LOOKUP_DELAY_MS, REF_LOOKUP_INTERVAL_MS, REF_LOOKUP_PEERS, REF_LOOKUP_ROUNDS,
    REF_LOOKUPS_PER_DEVICE, REF_LOOKUPS_PER_SENDER, REF_REPLIES_KEPT,
};
use super::{Cx, Node, NodeError};
use crate::constants::METADATA_KEY_REPLY_TO;
use crate::event::{MessageEvent, Payload, decode_reply_to};
use crate::ids::{ChatId, GossipId, RefChatId, SyncObjId};
use crate::rng::uniform_below;
use crate::store::StoredResult;
use std::collections::{BTreeMap, BTreeSet};

/// The references of the roots this device holds (installed or invitations), derived from
/// the epoch records, and the references whose place changed in this operation.
#[derive(Debug, Default)]
pub(crate) struct RefIndex {
    /// Reference → the epoch record whose root it is.
    pub(crate) epochs: BTreeMap<RefChatId, ChatId>,
    /// References whose place changed since the last pass.
    pub(crate) moved: BTreeSet<RefChatId>,
}

/// Where a reference leads on this device.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Placed {
    /// An installed epoch.
    Installed(ChatId),
    /// An invitation not answered yet: what it names is fetched only once it is accepted.
    Invitation,
}

impl Node {
    /// Rebuilds the reference index from the epoch records (after a load).
    pub(crate) fn rebuild_ref_index(&mut self) {
        self.rx = RefIndex::default();
        for (c, r) in self.t.epochs.iter() {
            self.rx.epochs.insert(r.root.ref_chat_id(), *c);
        }
    }

    /// An epoch record was stored: its reference now leads to it.
    pub(crate) fn ref_stored(&mut self, id: ChatId, reference: RefChatId) {
        self.rx.epochs.insert(reference, id);
        self.rx.moved.insert(reference);
    }

    /// An epoch record was removed.
    pub(crate) fn ref_removed(&mut self, reference: RefChatId) {
        self.rx.epochs.remove(&reference);
        self.rx.moved.insert(reference);
    }

    /// Where `reference` leads on this device, if anywhere.
    pub(crate) fn placed(&self, reference: &RefChatId) -> Option<Placed> {
        let chat = self.rx.epochs.get(reference)?;
        Some(if self.installed(chat) {
            Placed::Installed(*chat)
        } else {
            Placed::Invitation
        })
    }

    /// Whether the reply `(chat, sync)` is still held and still names `target` under
    /// `reference`: not deleted, not past its moment (§7.7), not edited to drop it.
    fn reply_held(
        &self,
        cx: &mut Cx<'_>,
        reference: &RefChatId,
        (chat, sync, target): &(ChatId, SyncObjId, SyncObjId),
    ) -> Result<bool, NodeError> {
        if !self.epochs.contains_key(chat) {
            return Ok(false);
        }
        let Some(o) = cx.ov.object(chat, sync)? else {
            return Ok(false);
        };
        if o.expires_at.is_some_and(|m| m <= cx.now) {
            return Ok(false);
        }
        let Some(StoredResult::Content(c)) = o.current else {
            return Ok(false);
        };
        Ok(c.metadata
            .get(METADATA_KEY_REPLY_TO)
            .and_then(|v| decode_reply_to(v).ok())
            .is_some_and(|ts| {
                ts.iter()
                    .any(|t| t.ref_chat_id == *reference && t.sync_obj_id == *target)
            }))
    }

    /// A short random wait from now (see [`REF_LOOKUP_DELAY_MS`]).
    fn ref_delay(&self, cx: &mut Cx<'_>) -> u64 {
        let wait = uniform_below(
            cx.rng,
            usize::try_from(REF_LOOKUP_DELAY_MS + 1).unwrap_or(1),
        );
        cx.now.saturating_add(wait as u64)
    }

    /// A message event was accepted from `from` in `chat`: each target of its `replyTo`
    /// that the device cannot show yet is noted, to be fetched or looked up after a short
    /// random wait (§7.6). Only in a group where this device is active: a read-only group
    /// starts nothing.
    pub(crate) fn note_reply(
        &mut self,
        cx: &mut Cx<'_>,
        chat: ChatId,
        from: GossipId,
        event: &MessageEvent,
    ) -> Result<(), NodeError> {
        let Payload::Content(c) = event.payload() else {
            return Ok(());
        };
        let Some(targets) = c
            .metadata
            .get(METADATA_KEY_REPLY_TO)
            .and_then(|v| decode_reply_to(v).ok())
        else {
            return Ok(());
        };
        if !self.serves(&chat) {
            return Ok(());
        }
        for t in targets {
            match self.placed(&t.ref_chat_id) {
                Some(Placed::Installed(_)) => continue,
                Some(Placed::Invitation) | None => {}
            }
            let reply = (chat, c.sync_obj_id, t.sync_obj_id);
            let note = RefReply {
                from,
                author: c.author,
                at: cx.now,
            };
            self.note_ref(cx, t.ref_chat_id, reply, note)?;
        }
        Ok(())
    }

    /// Adds a reply to the record of `reference`, creating it if needed. A record whose
    /// replies are all gone is forgotten first, so that the count of rounds belongs to the
    /// replies still held.
    fn note_ref(
        &mut self,
        cx: &mut Cx<'_>,
        reference: RefChatId,
        reply: (ChatId, SyncObjId, SyncObjId),
        note: RefReply,
    ) -> Result<(), NodeError> {
        if let Some(mut rec) = self.t.ref_lookups.get(&reference).cloned() {
            self.keep_held(cx, &reference, &mut rec)?;
            if !rec.replies.is_empty() {
                if rec.replies.len() < REF_REPLIES_KEPT || rec.replies.contains_key(&reply) {
                    rec.replies.insert(reply, note);
                }
                self.t.ref_lookups.insert(reference, rec);
                return Ok(());
            }
            self.forget_ref(&reference);
        }
        let mine = self
            .t
            .ref_lookups
            .iter()
            .filter(|(_, r)| latest(r).is_some_and(|l| l.from == note.from))
            .count();
        if mine >= REF_LOOKUPS_PER_SENDER || self.t.ref_lookups.len() >= REF_LOOKUPS_PER_DEVICE {
            self.stats.capped += 1;
            return Ok(());
        }
        let due = self.ref_delay(cx);
        self.t.ref_lookups.insert(
            reference,
            RefLookup {
                replies: BTreeMap::from([(reply, note)]),
                rounds: 0,
                last_round: None,
                round: None,
                asked: Vec::new(),
                due,
            },
        );
        Ok(())
    }

    /// Keeps only the replies of `rec` that are still held.
    fn keep_held(
        &self,
        cx: &mut Cx<'_>,
        reference: &RefChatId,
        rec: &mut RefLookup,
    ) -> Result<(), NodeError> {
        let mut gone = Vec::new();
        for k in rec.replies.keys() {
            if !self.reply_held(cx, reference, k)? {
                gone.push(*k);
            }
        }
        for k in gone {
            rec.replies.remove(&k);
        }
        Ok(())
    }

    /// Forgets the record of `reference` and stops its round.
    fn forget_ref(&mut self, reference: &RefChatId) {
        if let Some(rec) = self.t.ref_lookups.remove(reference)
            && let Some(chat) = rec.round
        {
            let key = TaskKey {
                chat_id: chat,
                target: Target::Ref(*reference),
            };
            if self.t.tasks.remove(&key).is_some() {
                self.reindex(key);
            }
        }
    }

    /// The messages of `chat` are erased (§14.2): the replies of it are forgotten, so that
    /// nothing of a closed chat stays behind, and so is a record left with none.
    pub(crate) fn forget_replies_in(&mut self, chat: &ChatId) {
        let touched: Vec<RefChatId> = self
            .t
            .ref_lookups
            .iter()
            .filter(|(_, r)| r.replies.keys().any(|k| k.0 == *chat))
            .map(|(k, _)| *k)
            .collect();
        for reference in touched {
            let Some(mut rec) = self.t.ref_lookups.get(&reference).cloned() else {
                continue;
            };
            rec.replies.retain(|k, _| k.0 != *chat);
            if rec.replies.is_empty() {
                self.forget_ref(&reference);
            } else {
                self.t.ref_lookups.insert(reference, rec);
            }
        }
    }

    /// The references whose place changed in this operation are examined again after a
    /// short random wait: a root fetched by reference, or an invitation answered, ends or
    /// changes what the record waits for.
    pub(crate) fn refs_moved(&mut self, cx: &mut Cx<'_>) {
        let moved = core::mem::take(&mut self.rx.moved);
        for reference in moved {
            if self.t.ref_lookups.contains(&reference) {
                let due = self.ref_delay(cx);
                if let Some(rec) = self.t.ref_lookups.get_mut(&reference) {
                    rec.due = rec.due.min(due);
                }
            }
        }
    }

    /// Examines every record that is due.
    pub(crate) fn ref_timers(&mut self, cx: &mut Cx<'_>) -> Result<(), NodeError> {
        let due: Vec<RefChatId> = self
            .t
            .ref_lookups
            .iter()
            .filter(|(_, r)| r.due <= cx.now)
            .map(|(k, _)| *k)
            .collect();
        for reference in due {
            self.examine_ref(cx, reference)?;
        }
        Ok(())
    }

    /// The earliest time a record is due.
    pub(crate) fn ref_wakeup(&self) -> Option<u64> {
        self.t.ref_lookups.iter().map(|(_, r)| r.due).min()
    }

    /// A record is due: the replies no longer held are dropped (none left: the record is
    /// forgotten); then, by where the reference leads, the record is done (an installed
    /// epoch), waits (an invitation not answered yet), or a round of the lookup by reference
    /// starts, at most once a week and at most [`REF_LOOKUP_ROUNDS`] times.
    fn examine_ref(&mut self, cx: &mut Cx<'_>, reference: RefChatId) -> Result<(), NodeError> {
        let Some(mut rec) = self.t.ref_lookups.get(&reference).cloned() else {
            return Ok(());
        };
        self.keep_held(cx, &reference, &mut rec)?;
        if rec.replies.is_empty() {
            self.forget_ref(&reference);
            return Ok(());
        }
        let running = rec.round.is_some_and(|chat| {
            self.t.tasks.contains(&TaskKey {
                chat_id: chat,
                target: Target::Ref(reference),
            })
        });
        match self.placed(&reference) {
            Some(Placed::Installed(_)) => {
                self.forget_ref(&reference);
                return Ok(());
            }
            Some(Placed::Invitation) => {
                // Nothing is fetched in an epoch the user has not accepted (§4.8); the
                // record waits, and is examined again once the invitation is answered.
                self.t.ref_lookups.insert(reference, rec);
                self.stop_round(&reference);
                if let Some(r) = self.t.ref_lookups.get_mut(&reference) {
                    r.due = cx.now.saturating_add(REF_LOOKUP_INTERVAL_MS);
                }
                return Ok(());
            }
            None => {}
        }
        if running {
            // A round that is still asking (its stages can last longer than a week).
            rec.due = cx.now.saturating_add(REF_LOOKUP_INTERVAL_MS);
            self.t.ref_lookups.insert(reference, rec);
            return Ok(());
        }
        rec.round = None;
        let next = rec
            .last_round
            .map_or(0, |t| t.saturating_add(REF_LOOKUP_INTERVAL_MS));
        if rec.rounds >= REF_LOOKUP_ROUNDS || cx.now < next {
            // After the last round the device stops for good for this reference; the record
            // stays while a reply naming it is held, so that a new reply does not start the
            // count again.
            rec.due = if rec.rounds >= REF_LOOKUP_ROUNDS {
                // Examined weekly only to forget it once no reply naming it is held.
                cx.now.saturating_add(REF_LOOKUP_INTERVAL_MS)
            } else {
                next
            };
            self.t.ref_lookups.insert(reference, rec);
            return Ok(());
        }
        // The members of the chat of the newest reply are asked.
        let Some((&(chat, _, _), &newest)) = rec.replies.iter().max_by_key(|(k, r)| (r.at, **k))
        else {
            return Ok(());
        };
        let asked = self.ref_peers(cx, &chat, &newest);
        rec.due = cx.now.saturating_add(REF_LOOKUP_INTERVAL_MS);
        if asked.is_empty() {
            // Nobody to ask: no round is counted.
            self.t.ref_lookups.insert(reference, rec);
            return Ok(());
        }
        let key = TaskKey {
            chat_id: chat,
            target: Target::Ref(reference),
        };
        rec.asked = asked;
        self.t.ref_lookups.insert(reference, rec);
        self.trigger(cx, key, None);
        if !self.t.tasks.contains(&key) {
            // Refused by a limit on retrieval: tried again later, not counted.
            return Ok(());
        }
        if let Some(rec) = self.t.ref_lookups.get_mut(&reference) {
            rec.rounds = rec.rounds.saturating_add(1);
            rec.last_round = Some(cx.now);
            rec.round = Some(chat);
        }
        self.stats.ref_rounds += 1;
        Ok(())
    }

    /// The peers a round asks, in order, at most [`REF_LOOKUP_PEERS`], among the members of
    /// the reply's epoch that may receive anything of it (this device and removed peers
    /// excluded): the peer that delivered the reply; its author when that is another peer
    /// (an unsigned claim, used only for the order); then the other members, those with a
    /// session first, each drawn by score.
    fn ref_peers(&self, cx: &mut Cx<'_>, chat: &ChatId, newest: &RefReply) -> Vec<GossipId> {
        let eligible = self.eligible(chat);
        let mut out: Vec<GossipId> = Vec::new();
        for p in [newest.from, newest.author] {
            if eligible.contains(&p) && !out.contains(&p) {
                out.push(p);
            }
        }
        let (with_session, others): (Vec<GossipId>, Vec<GossipId>) = eligible
            .into_iter()
            .filter(|p| !out.contains(p))
            .partition(|p| self.sessions.contains(p));
        let room = REF_LOOKUP_PEERS.saturating_sub(out.len());
        let first = self.draw_by_score(cx.rng, with_session, room);
        let room = room - first.len();
        out.extend(first);
        out.extend(self.draw_by_score(cx.rng, others, room));
        out.truncate(REF_LOOKUP_PEERS);
        out
    }

    /// Stops the round of `reference`, if one runs.
    fn stop_round(&mut self, reference: &RefChatId) {
        let Some(chat) = self.t.ref_lookups.get(reference).and_then(|r| r.round) else {
            return;
        };
        let key = TaskKey {
            chat_id: chat,
            target: Target::Ref(*reference),
        };
        if self.t.tasks.remove(&key).is_some() {
            self.reindex(key);
        }
        if let Some(r) = self.t.ref_lookups.get_mut(reference) {
            r.round = None;
        }
    }

    /// The task of a round ended: answered, or every peer of the round answered "not
    /// available" or let its stages run out. The next round comes a week after this one
    /// started, if any is left.
    pub(crate) fn ref_round_over(&mut self, key: &TaskKey) {
        let Target::Ref(reference) = key.target else {
            return;
        };
        if self.t.tasks.remove(key).is_some() {
            self.reindex(*key);
        }
        if let Some(r) = self.t.ref_lookups.get_mut(&reference) {
            r.round = None;
            r.due = r
                .last_round
                .unwrap_or(0)
                .saturating_add(REF_LOOKUP_INTERVAL_MS);
        }
    }

    /// The position of `peer` in the order of the round of `key`, if it is one of its peers
    /// and may still be asked.
    pub(crate) fn ref_position(&self, key: &TaskKey, peer: &GossipId) -> Option<usize> {
        let Target::Ref(reference) = key.target else {
            return None;
        };
        if !self.may_receive(&key.chat_id, peer, false) {
            return None;
        }
        self.t
            .ref_lookups
            .get(&reference)?
            .asked
            .iter()
            .position(|p| p == peer)
    }

    /// The peers the round of `key` may ask, in order.
    pub(crate) fn ref_pool(&self, key: &TaskKey) -> Vec<GossipId> {
        let Target::Ref(reference) = key.target else {
            return Vec::new();
        };
        self.t
            .ref_lookups
            .get(&reference)
            .map(|r| {
                r.asked
                    .iter()
                    .filter(|p| self.may_receive(&key.chat_id, p, false))
                    .copied()
                    .collect()
            })
            .unwrap_or_default()
    }
}

/// The newest reply of a record.
fn latest(rec: &RefLookup) -> Option<&RefReply> {
    rec.replies.values().max_by_key(|r| r.at)
}
