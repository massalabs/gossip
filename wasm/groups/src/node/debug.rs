//! Debug events of the engine (cargo feature `full-debug` only; see `crate::debug`).
//!
//! The helpers here only read the engine's state: they take `&self`, and what they compute
//! goes to the sink and nowhere else. A line can therefore never cause or change a message,
//! a record or a decision.
//!
//! Membership and lifecycle lines come from a comparison of the groups before and after each
//! committed operation ([`Node::dbg_snapshot`], [`Node::dbg_diff`]), so that every path that
//! changes a group (received roots, kicks, leaves, dissolves, handovers, local actions,
//! timers) is covered by one piece of code instead of a line at each of them.
//!
//! # Events
//!
//! Short IDs are the first 8 hex characters; full IDs, names and raw bytes are in `c`, the
//! group key in `s`. `op` is the engine line that started the operation (`file:line`).
//!
//! - `engine.event.in`: one per received item, with `type`, `from`, the IDs, `size`, `via`
//!   (`frame`, `response`, `late_response`, `lookup`, `parent_lookup`) and `verdict` +
//!   `reason`:
//!   - `plaintext`: `malformed`/`plaintext_undecodable` (raw bytes in `c`); a higher version
//!     `answered`/`higher_version` (a version notice) or `ignored`/
//!     `higher_version_not_a_contact`, `…_notice_pending`, `…_notice_rate_limited`.
//!   - `frame`: `malformed`/`frame_unparseable` (`penalized`, raw plaintext in `c`).
//!   - `event_blob`: `malformed`/`event_blob_undecodable` (raw blob in `c`).
//!   - `message`: `accepted`/`won`, `lost`, `identical`; `held`/`scheduled` (waiting for its
//!     due time); `duplicate`/`retained`, `restored_after_prune`, `pruned`; `ignored`/
//!     `unknown_epoch`, `epoch_not_accepted`, `peer_not_member`, `removed_peer`,
//!     `group_state` (the device is inactive: kicked, left, waiting, dissolved, superseded;
//!     `state` says which), `future_dated`, `timer_expired`; `malformed`/`invalid` (`err`,
//!     raw blob in `c`), `not_a_message_event`.
//!   - `root`: `duplicate`/`held_already`; `held`/`handover_from_non_member_parent_unknown`,
//!     `handover_parent_unknown`, `invitation_waiting_for_parents`; `accepted`/
//!     `own_handover_left`, `direct_chat`, `invitation_after_close`, `adopted`,
//!     `adopted_inactive_group`, `invitation_rejoin`, `invitation_migration`, `invitation`;
//!     `ignored`/`dissolved_and_deleted`, `closed_not_direct`, `continues_closed_chat`;
//!     `malformed`/`not_member_self`, `from_self`, `sender_not_member`, `bad_signature`.
//!   - `leave`, `kick`, `dissolve`: `accepted`/`verified`; `duplicate`/`stored_already`;
//!     `held`/`leaver_keys_unknown`; `ignored`/`dissolved_and_deleted`, `unknown_epoch`,
//!     `epoch_is_invitation`, `sender_not_member`, `limit_unverified_leaves`; `malformed`/
//!     `not_what_was_asked`, `leaver_not_member`, `bad_signature`.
//!   - `query`: `answered` (`live` or `past_deadline`) with `answers`, one per entry
//!     (`op:answer`, e.g. `event:busy`, `tips_scan:page`, `event:silent_unauthorized`,
//!     `event:dropped_answer_queue_full`); `ignored`/`bad_timing`.
//!   - `response`: `ignored`/`past_grace`, `past_deadline`, `unknown_request` (a message event
//!     in it is still received and has its own line); correlated answers are
//!     `engine.retrieval.result` or `engine.tipsync.page`.
//!   - `version_notice`: `accepted`/`peer_version_noted`, `ignored`/`shares_no_epoch`.
//!   - `notice`: `accepted`/`noted` or `ignored`/`inactive_device_or_not_member`, with counts
//!     `known`, `wanted`, `objects`, `ignored_inactive_or_not_member`.
//!   - `neighbor_request`: `answered`/`capacity` (accepted), `full`, `not_member_or_inactive`,
//!     `removed_peer`, `not_member_of_current` (declined); `ignored`/`from_self`,
//!     `request_budget`.
//!   - `neighbor_response`: `accepted`/`neighbor_accepted`, `neighbor_declined`; `ignored`/
//!     `unknown_epoch`, `peer_may_not_receive`, `not_asked`.
//!   - `leave_request`: `accepted`/`pending_removal`; `ignored`/`unknown_epoch`, `invitation`,
//!     `not_owner`, `not_member`, `no_current_epoch`, `inactive_device`,
//!     `not_owner_of_current`.
//! - `engine.event.out`: one per plaintext handed off: `to`, `size`, counts and `items`
//!   (`kind:why:epoch/item`: `event:first_send`, `event:push_to_removed`, `notice:relay`,
//!   `query:<target>`, `query:tip_sync`, `answer:<event|page|busy|…>`, `root:send`, …).
//! - `engine.publish.relay_like` (§10.2): a version this device published that leaves like
//!   a relay: `step` `waiting` (with the random `wait`), then `announced` (`notices`, whether
//!   the peer the hint names is in the notice set, `as_other`).
//! - `engine.local.message` (§9.7): a message created on this device only (`as_other`).
//!   Only this build logs it: a normal build keeps no trace of it, by design.
//! - `engine.retrieval.want` (task created, trigger), `.ask` (what, who, `tier` 0 announced /
//!   1 neighbor / 2 session / 3 other, `attempt`, `run`, `stage`, `ttl`, `resend`),
//!   `.result` (`found`, `not_available`, `busy`, `expired`, `malformed`, `refused`,
//!   `future_dated`, `timeout`, `deadline_passed`, `not_found`; `dur`), `.paused`,
//!   `.dropped` (limit `queued_missing`).
//! - `engine.held` (a root waiting for its parent), `engine.held.released` (a root, or a
//!   scheduled item that came due: `late`), `engine.held.dropped` (limit: held roots,
//!   invitations, fetched parents, unverified leaves, reference lookups).
//! - `engine.member.invitation` (`received`, `accepted_or_adopted`, `declined_or_dropped`,
//!   `epoch_erased`), `engine.member.epoch` (a new installed epoch: `reason` `add`, `remove`,
//!   `add_and_remove`, `handover`, `new_owner`, `timer`, `settings`, `rename`,
//!   `fork_resolution`, `successor`, `founding_or_unlinked`; members added and removed,
//!   timer, changed setting names; group key in `s`), `engine.member.current` (old → new
//!   current epoch), `engine.member.device` (old → new state of this device in the group),
//!   `engine.member.fork` (`detected`, `resolved`).
//! - `engine.tipsync.start`, `.page` (result, entries, `dur`, or `timeout`), `.end`
//!   (`complete`, `not_available`, `ended`).
//! - `engine.timer.erased` (objects erased by the message timer, per epoch),
//!   `engine.neighbor.replaced`, `engine.op.failed` (an operation that committed nothing:
//!   the lines before it in the same operation did not happen).

use std::collections::{BTreeMap, BTreeSet};

use super::Node;
use super::group::Via;
use super::records::{EpochStatus, GroupStatus, SignedObject, Target, TaskKey, Work};
use super::retrieval::Answer;
use crate::debug::{IntoVal, Val, dbg, hex, short, shorts};
use crate::epoch::{Merge, Outcome, Received, Rejection};
use crate::event::{MessageEvent, Payload};
use crate::ids::{ChatId, GossipId};
use crate::root::{Root, RootType};
use crate::wire::{EntryItem, EventObject, ResponseResult, Status};

/// What a group looked like before an operation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct GroupSnap {
    status: &'static str,
    current: Option<ChatId>,
    fork: bool,
}

/// The groups and epochs before an operation.
#[derive(Debug, Clone, Default)]
pub(crate) struct Snapshot {
    /// Epoch → (installed, group).
    epochs: BTreeMap<ChatId, (bool, ChatId)>,
    groups: BTreeMap<ChatId, GroupSnap>,
}

pub(crate) fn status_name(s: &GroupStatus) -> &'static str {
    match s {
        GroupStatus::Active => "active",
        GroupStatus::Removed { .. } => "kicked",
        GroupStatus::Left { .. } => "left",
        GroupStatus::Waiting { .. } => "waiting_for_kick",
        GroupStatus::Dissolved { .. } => "dissolved",
        GroupStatus::Superseded { .. } => "superseded",
    }
}

/// The kind and short ID of a retrieval target.
pub(crate) fn target(t: &Target) -> (&'static str, Val) {
    match t {
        Target::Event(id) => ("event", short(id)),
        Target::SyncObj(id) => ("sync_obj", short(id)),
        Target::Root => ("root", Val::Null),
        Target::Parent(c) => ("parent", short(c)),
        Target::Object(k, id) => (
            match k {
                crate::wire::SignedKind::Leave => "leave",
                crate::wire::SignedKind::Kick => "kick",
                crate::wire::SignedKind::Dissolve => "dissolve",
            },
            short(id),
        ),
        Target::Removal(m) => ("removal", short(m)),
        Target::Keys(m) => ("keys", short(m)),
        Target::Ref(r) => ("ref", short(r)),
    }
}

pub(crate) fn answer_name(a: Answer) -> &'static str {
    match a {
        Answer::Supplied => "found",
        Answer::NotAvailable => "not_available",
        Answer::Invalid => "malformed",
        Answer::Refused => "refused",
        Answer::Busy => "busy",
        Answer::Expired(true) => "expired",
        Answer::Expired(false) => "expired_implausible",
        Answer::TemporarilyInvalid => "future_dated",
    }
}

pub(crate) fn result_name(r: &ResponseResult) -> &'static str {
    match r {
        ResponseResult::Event(_) => "event",
        ResponseResult::Page(_) => "page",
        ResponseResult::Keys(_) => "keys",
        ResponseResult::InvalidPage => "invalid_page",
        ResponseResult::Status(s) => match s {
            Status::NotAvailable => "not_available",
            Status::Restart => "restart",
            Status::Expired => "expired",
            Status::Malformed => "malformed",
            Status::Unsupported => "unsupported",
            Status::Busy => "busy",
        },
    }
}

fn via_name(v: Via) -> &'static str {
    match v {
        Via::Direct => "frame",
        Via::Lookup => "lookup",
        Via::Parent(_) => "parent_lookup",
    }
}

fn item_name(i: &EntryItem) -> &'static str {
    match i {
        EntryItem::Event(_) => "event",
        EntryItem::Root => "root",
        EntryItem::Leave(_) => "leave",
        EntryItem::Kick(_) => "kick",
        EntryItem::Dissolve(_) => "dissolve",
    }
}

fn root_type(r: &Root) -> &'static str {
    match r.root_type() {
        RootType::Successor => "successor",
        RootType::Handover => "handover",
    }
}

impl Node {
    /// The verdict line of a message event (`engine.event.in`).
    pub(crate) fn dbg_verdict(
        &self,
        chat: &ChatId,
        from: &GossipId,
        event: &MessageEvent,
        received: &Received,
    ) {
        if !crate::debug::enabled() {
            return;
        }
        let (via, size) = crate::debug::ctx();
        let (verdict, reason, lvl) = match &received.outcome {
            Outcome::Rejected(Rejection::Invalid(_)) => ("malformed", "invalid", 2),
            Outcome::Rejected(Rejection::NotAccepted) => ("ignored", "epoch_not_accepted", 1),
            Outcome::Rejected(Rejection::PeerNotMember) => ("ignored", "peer_not_member", 1),
            Outcome::Rejected(Rejection::RemovedPeer) => ("ignored", "removed_peer", 1),
            Outcome::Rejected(Rejection::GroupState) => ("ignored", "group_state", 1),
            Outcome::Rejected(Rejection::NotAMessageEvent) => {
                ("malformed", "not_a_message_event", 2)
            }
            Outcome::TemporarilyInvalid => ("ignored", "future_dated", 1),
            Outcome::Duplicate => ("duplicate", "retained", 0),
            Outcome::Restored => ("duplicate", "restored_after_prune", 0),
            Outcome::KeptPruned => ("duplicate", "pruned", 0),
            Outcome::Expired => ("ignored", "timer_expired", 0),
            Outcome::Accepted(Merge::Pending) => ("held", "scheduled", 0),
            Outcome::Accepted(Merge::Won) => ("accepted", "won", 0),
            Outcome::Accepted(Merge::Lost) => ("accepted", "lost", 0),
            Outcome::Accepted(Merge::Identical) => ("accepted", "identical", 0),
        };
        let err = match &received.outcome {
            Outcome::Rejected(Rejection::Invalid(e)) => dbg(e),
            _ => Val::Null,
        };
        let (kind, author) = match event.payload() {
            Payload::Content(c) => ("content", short(&c.author)),
            Payload::Delete { .. } => ("delete", Val::Null),
        };
        let state = self.epochs.get(chat).map(|e| dbg(&e.state));
        let raw = if verdict == "malformed" {
            crate::wire::encode_event_blob(&EventObject::Message(event.clone()))
                .map_or(Val::Null, |b| hex(&b))
        } else {
            Val::Null
        };
        let e = crate::debug::DebugEvent {
            ev: "engine.event.in",
            lvl: match lvl {
                0 => crate::debug::Level::Debug,
                1 => crate::debug::Level::Info,
                _ => crate::debug::Level::Warn,
            },
            f: vec![
                ("type", "message".into_val()),
                ("payload", kind.into_val()),
                ("epoch", short(chat)),
                ("group", short(&self.group_of(chat))),
                ("id", short(&event.event_id())),
                ("from", short(from)),
                ("author", author),
                ("via", via.into_val()),
                ("size", size.into_val()),
                ("parents", event.parents().len().into_val()),
                ("pruned", received.pruned.len().into_val()),
                ("verdict", verdict.into_val()),
                ("reason", reason.into_val()),
                ("err", err),
                ("state", state.into_val()),
                (
                    "waiting_for",
                    if verdict == "held" {
                        "due_time".into_val()
                    } else {
                        Val::Null
                    },
                ),
            ],
            c: vec![("id", hex(&event.event_id())), ("raw", raw)],
            s: Vec::new(),
        };
        crate::debug::emit(&e);
    }

    /// The verdict line of a root (`engine.event.in`, type `root`).
    pub(crate) fn dbg_root(
        &self,
        from: &GossipId,
        root: &Root,
        via: Via,
        verdict: &'static str,
        reason: &'static str,
    ) {
        dbg_event!(Info, "engine.event.in", {
            "type" => "root", "root_type" => root_type(root), "epoch" => short(&root.chat_id()),
            "group" => short(&self.group_of(&root.chat_id())), "from" => short(from),
            "owner" => short(&root.owner_id()), "members" => root.members().len(),
            "parents" => root.parents().len(), "via" => via_name(via),
            "verdict" => verdict, "reason" => reason,
        }, c { "epoch" => hex(&root.chat_id()), "name" => root.name().to_string() });
    }

    /// The verdict line of a signed object (`engine.event.in`, type `leave`/`kick`/`dissolve`).
    pub(crate) fn dbg_signed(
        &self,
        from: &GossipId,
        obj: &SignedObject,
        verdict: &'static str,
        reason: &'static str,
    ) {
        let (chat, _, id) = obj.key();
        let (kind, subject) = match obj {
            SignedObject::Leave(l) => ("leave", short(&l.leaver())),
            SignedObject::Kick(k) => ("kick", short(&k.removed())),
            SignedObject::Dissolve(_) => ("dissolve", Val::Null),
        };
        dbg_event!(Info, "engine.event.in", {
            "type" => kind, "epoch" => short(&chat), "group" => short(&self.group_of(&chat)),
            "id" => short(&id), "from" => short(from), "subject" => subject,
            "verdict" => verdict, "reason" => reason,
        }, c { "id" => hex(&id) });
    }

    /// The tier a task would place `peer` in (see `select`): 0 announced it or delivered a
    /// child, 1 neighbor, 2 has a session, 3 other.
    pub(crate) fn dbg_tier(&self, key: &TaskKey, peer: &GossipId) -> u8 {
        if self
            .t
            .tasks
            .get(key)
            .and_then(|t| t.candidates.get(peer))
            .is_some_and(|c| c.trigger.is_some())
        {
            0
        } else if self.is_neighbor(&key.chat_id, peer) {
            1
        } else if self.sessions.contains(peer) {
            2
        } else {
            3
        }
    }

    /// One line per queued item a plaintext carries, for `engine.event.out`.
    pub(crate) fn dbg_work(&self, w: &Work, to: &GossipId) -> Val {
        let s = |kind: &str, why: &str, chat: Option<&ChatId>, item: Val| -> Val {
            let mut out = format!("{kind}:{why}");
            if let Some(c) = chat
                && let Val::String(c) = short(c)
            {
                out.push(':');
                out.push_str(&c);
            }
            if let Val::String(i) = item {
                out.push('/');
                out.push_str(&i);
            }
            Val::String(out)
        };
        match w {
            Work::Full { chat_id, event_id } => {
                let why = if self.removed_peer(chat_id, to) {
                    "push_to_removed"
                } else {
                    "first_send"
                };
                s("event", why, Some(chat_id), short(event_id))
            }
            Work::Notice { chat_id, event_id } => {
                s("notice", "relay", Some(chat_id), short(event_id))
            }
            Work::Query { purpose } => match purpose {
                super::records::Purpose::Task(key) => {
                    let (kind, item) = target(&key.target);
                    s("query", kind, Some(&key.chat_id), item)
                }
                super::records::Purpose::Scan(chat) => {
                    s("query", "tip_sync", Some(chat), Val::Null)
                }
            },
            Work::Answer { op, .. } => match op {
                super::records::AnswerOp::Event { chat_id, event_id } => {
                    s("answer", "event", Some(chat_id), short(event_id))
                }
                super::records::AnswerOp::SyncObj {
                    chat_id,
                    sync_obj_id,
                } => s("answer", "sync_obj", Some(chat_id), short(sync_obj_id)),
                super::records::AnswerOp::Page { anchor, .. } => {
                    s("answer", "page", Some(anchor), Val::Null)
                }
                super::records::AnswerOp::Status(st) => s(
                    "answer",
                    result_name(&ResponseResult::Status(*st)),
                    None,
                    Val::Null,
                ),
                other => Val::String(format!("answer:{}", op_name(other))),
            },
            Work::NeighborRequest { chat_id } => {
                s("neighbor_request", "upkeep", Some(chat_id), Val::Null)
            }
            Work::NeighborResponse {
                chat_id, accepted, ..
            } => s(
                "neighbor_response",
                if *accepted { "accepted" } else { "declined" },
                Some(chat_id),
                Val::Null,
            ),
            Work::VersionNotice => s("version_notice", "higher_version", None, Val::Null),
            Work::Object { chat_id, item } => {
                let why = if self.removed_peer(chat_id, to) {
                    "push_to_removed"
                } else {
                    "send"
                };
                s(item_name(item), why, Some(chat_id), Val::Null)
            }
            Work::ObjectNotice { chat_id, item } => {
                s("notice", item_name(item), Some(chat_id), Val::Null)
            }
            Work::Blob(b) => Val::String(format!("blob:after_close:{}", b.len())),
            Work::LeaveRequest { chat_id } => s(
                "leave_request",
                "ask_to_be_kicked",
                Some(chat_id),
                Val::Null,
            ),
        }
    }

    /// The groups and epochs now, to compare after the operation.
    pub(crate) fn dbg_snapshot(&self) -> Snapshot {
        let mut snap = Snapshot::default();
        let mut groups = BTreeSet::new();
        for (c, r) in self.t.epochs.iter() {
            snap.epochs
                .insert(*c, (r.status == EpochStatus::Installed, r.group));
            if r.status == EpochStatus::Installed {
                groups.insert(r.group);
            }
        }
        for g in groups {
            snap.groups.insert(
                g,
                GroupSnap {
                    status: status_name(&self.group_status(&g)),
                    current: self.current_epoch(&g),
                    fork: !self.fork_to_resolve(&g).is_empty(),
                },
            );
        }
        snap
    }

    /// The membership and lifecycle lines of what changed since `before`.
    #[allow(clippy::too_many_lines)]
    pub(crate) fn dbg_diff(&self, before: &Snapshot, op: &str) {
        let op = || op.to_string();
        let after = self.dbg_snapshot();
        // Epochs that appeared, changed status or went away.
        for (c, (installed, group)) in &after.epochs {
            let Some(rec) = self.t.epochs.get(c) else {
                continue;
            };
            match before.epochs.get(c) {
                None if !installed => {
                    let waiting = match &rec.status {
                        EpochStatus::Invitation(i) => i.lookups.len(),
                        EpochStatus::Installed => 0,
                    };
                    dbg_event!(Info, "engine.member.invitation", {
                        "action" => "received", "epoch" => short(c), "group" => short(group),
                        "from" => short(&rec.from), "owner" => short(&rec.root.owner_id()),
                        "members" => rec.root.members().len(),
                        "root_type" => root_type(&rec.root),
                        "parent_lookups" => waiting, "op" => op(),
                    }, c { "epoch" => hex(c), "name" => rec.root.name().to_string() });
                }
                Some((false, _)) if *installed => {
                    dbg_event!(Info, "engine.member.invitation", {
                        "action" => "accepted_or_adopted", "epoch" => short(c),
                        "group" => short(group), "op" => op(),
                    });
                }
                _ => {}
            }
            if *installed && before.epochs.get(c).is_none_or(|(i, _)| !i) {
                // A new epoch installed: its key, timer and settings.
                let parent = rec
                    .parents
                    .iter()
                    .find_map(|p| self.t.epochs.get(p).map(|r| r.root.clone()));
                let (added, removed): (Vec<GossipId>, Vec<GossipId>) = match &parent {
                    Some(p) => (
                        rec.root
                            .members()
                            .iter()
                            .filter(|m| !p.is_member(m))
                            .copied()
                            .collect(),
                        p.members()
                            .iter()
                            .filter(|m| !rec.root.is_member(m))
                            .copied()
                            .collect(),
                    ),
                    None => (Vec::new(), Vec::new()),
                };
                let reason = match &parent {
                    None => "founding_or_unlinked",
                    Some(_) if rec.root.root_type() == RootType::Handover => "handover",
                    Some(p) if p.owner_id() != rec.root.owner_id() => "new_owner",
                    Some(_) if !removed.is_empty() && !added.is_empty() => "add_and_remove",
                    Some(_) if !removed.is_empty() => "remove",
                    Some(_) if !added.is_empty() => "add",
                    Some(p) if p.message_timer() != rec.root.message_timer() => "timer",
                    Some(p) if p.settings() != rec.root.settings() => "settings",
                    Some(p) if p.name() != rec.root.name() => "rename",
                    Some(p) if p.parents().len() == 1 && rec.root.parents().len() > 1 => {
                        "fork_resolution"
                    }
                    Some(_) => "successor",
                };
                let changed_settings: Vec<String> = match &parent {
                    Some(p) => rec
                        .root
                        .settings()
                        .iter()
                        .filter(|(k, v)| p.settings().get(*k) != Some(*v))
                        .map(|(k, _)| k.clone())
                        .chain(
                            p.settings()
                                .keys()
                                .filter(|k| !rec.root.settings().contains_key(*k))
                                .cloned(),
                        )
                        .collect(),
                    None => rec.root.settings().keys().cloned().collect(),
                };
                dbg_event!(Info, "engine.member.epoch", {
                    "group" => short(group), "epoch" => short(c),
                    "parent" => parent.as_ref().map(|p| short(&p.chat_id())),
                    "reason" => reason, "root_type" => root_type(&rec.root),
                    "owner" => short(&rec.root.owner_id()),
                    "old_owner" => parent.as_ref().map(|p| short(&p.owner_id())),
                    "members" => rec.root.members().len(),
                    "added" => shorts(&added), "removed" => shorts(&removed),
                    "timer" => rec.root.message_timer(),
                    "old_timer" => parent.as_ref().map(Root::message_timer),
                    "settings_changed" => changed_settings,
                    "from" => short(&rec.from), "op" => op(),
                }, c {
                    "epoch" => hex(c), "name" => rec.root.name().to_string(),
                    "members" => rec.root.members().iter().map(hex).collect::<Vec<Val>>(),
                }, s {
                    "group_key" => hex(rec.root.group_secret().as_bytes()),
                });
            }
        }
        for (c, (installed, group)) in &before.epochs {
            if !after.epochs.contains_key(c) {
                dbg_event!(Info, "engine.member.invitation", {
                    "action" => if *installed { "epoch_erased" } else { "declined_or_dropped" },
                    "epoch" => short(c), "group" => short(group),
                    "closed" => self.t.markers.get(c).is_some_and(|m| m.is_closed()),
                    "op" => op(),
                });
            }
        }
        // Groups: current epoch, device state, forks.
        for (g, a) in &after.groups {
            let b = before.groups.get(g);
            if b.is_none_or(|b| b.current != a.current) {
                dbg_event!(Info, "engine.member.current", {
                    "group" => short(g),
                    "old" => b.and_then(|b| b.current.as_ref().map(short)),
                    "new" => a.current.as_ref().map(short), "op" => op(),
                });
            }
            let old_status = b.map_or("none", |b| b.status);
            if old_status != a.status {
                let active = a.status == "active";
                dbg_event!(Info, "engine.member.device", {
                    "group" => short(g), "old" => old_status, "new" => a.status,
                    "state" => if active { "active" } else { "inactive" },
                    "epoch" => a.current.as_ref().map(short), "op" => op(),
                });
            }
            let was_fork = b.is_some_and(|b| b.fork);
            if was_fork != a.fork {
                dbg_event!(Warn, "engine.member.fork", {
                    "group" => short(g),
                    "action" => if a.fork { "detected" } else { "resolved" },
                    "ends" => shorts(&self.fork_to_resolve(g)), "op" => op(),
                });
            }
        }
        for (g, b) in &before.groups {
            if !after.groups.contains_key(g) {
                dbg_event!(Info, "engine.member.device", {
                    "group" => short(g), "old" => b.status, "new" => "deleted",
                    "state" => "inactive", "op" => op(),
                });
            }
        }
    }
}

fn op_name(op: &super::records::AnswerOp) -> &'static str {
    match op {
        super::records::AnswerOp::Root { .. } => "root",
        super::records::AnswerOp::Object { .. } => "object",
        super::records::AnswerOp::Keys { .. } => "keys",
        super::records::AnswerOp::Event { .. } => "event",
        super::records::AnswerOp::SyncObj { .. } => "sync_obj",
        super::records::AnswerOp::Page { .. } => "page",
        super::records::AnswerOp::Status(_) => "status",
    }
}

#[cfg(test)]
mod tests {
    //! The verdict lines of a few scenarios.
    use super::super::tests::{DAY, HOUR, Net, T0, blob, config, epoch_root, member};
    use crate::debug::{DebugEvent, capture};
    use crate::epoch::GroupState;
    use crate::event::Payload;
    use crate::ids::{EventId, SyncObjId};
    use crate::wire::Frame;

    fn verdicts(events: &[DebugEvent]) -> Vec<(String, String, String)> {
        events
            .iter()
            .filter(|e| e.ev == "engine.event.in")
            .map(|e| {
                (
                    e.str("type").unwrap_or("").to_string(),
                    e.str("verdict").unwrap_or("").to_string(),
                    e.str("reason").unwrap_or("").to_string(),
                )
            })
            .collect()
    }

    fn has(events: &[DebugEvent], ty: &str, verdict: &str, reason: &str) -> bool {
        verdicts(events)
            .iter()
            .any(|(t, v, r)| t == ty && v == verdict && r == reason)
    }

    #[test]
    fn nothing_is_built_without_a_sink() {
        assert!(!crate::debug::enabled());
        let mut net = Net::new(3, 2);
        let e = net.event(T0, 1, &[], 1);
        net.give(0, 1, &e);
        assert!(!crate::debug::enabled());
    }

    #[test]
    fn a_valid_message_is_accepted_then_a_duplicate() {
        let mut net = Net::new(3, 2);
        let cap = capture::install();
        let e = net.event(T0, 1, &[], 1);
        net.give(0, 1, &e);
        let ev = cap.take();
        assert!(
            has(&ev, "message", "accepted", "won"),
            "{:?}",
            verdicts(&ev)
        );
        let line = ev
            .iter()
            .find(|e| e.str("verdict") == Some("accepted"))
            .unwrap();
        assert_eq!(line.str("via"), Some("frame"));
        assert_eq!(
            line.get("size"),
            Some(&crate::debug::Val::U64(blob(&e).len() as u64))
        );
        assert_eq!(line.str("id").map(str::len), Some(8));
        assert!(line.to_json().starts_with("{\"ev\":\"engine.event.in\""));
        net.give(0, 1, &e);
        let ev = cap.take();
        assert!(
            has(&ev, "message", "duplicate", "retained"),
            "{:?}",
            verdicts(&ev)
        );
    }

    #[test]
    fn malformed_bytes_carry_the_raw_bytes() {
        let mut net = Net::new(3, 2);
        let cap = capture::install();
        net.recv(0, member(1), &[0x00, 0x13, 0x37]);
        let ev = cap.take();
        assert!(
            has(&ev, "plaintext", "malformed", "plaintext_undecodable"),
            "{:?}",
            verdicts(&ev)
        );
        let line = &ev[0];
        assert_eq!(line.c[0].0, "raw");
        assert_eq!(line.c[0].1, crate::debug::Val::String("001337".into()));
        // A valid plaintext holding an event frame that does not decode.
        net.recv_frames(0, member(1), &[Frame::Event(vec![1, 2, 3])]);
        let ev = cap.take();
        assert!(
            has(&ev, "event_blob", "malformed", "event_blob_undecodable"),
            "{:?}",
            verdicts(&ev)
        );
    }

    #[test]
    fn an_event_of_an_unknown_epoch_is_ignored() {
        let mut net = Net::new(3, 2);
        let other = epoch_root(3, 0x60);
        let e = crate::event::MessageEvent::create(
            &other,
            EventId::new(T0, [1; 16]),
            &[],
            Payload::Content(crate::event::Content {
                sync_obj_id: SyncObjId::from_bytes([1; 32]),
                author: member(1),
                created_at: T0,
                last_modified_at: T0,
                body: crate::event::Body::Text("m".into()),
                edited: false,
                metadata: std::collections::BTreeMap::new(),
            }),
        )
        .unwrap();
        let cap = capture::install();
        net.give(0, 1, &e);
        let ev = cap.take();
        assert!(
            has(&ev, "message", "ignored", "unknown_epoch"),
            "{:?}",
            verdicts(&ev)
        );
    }

    #[test]
    fn an_event_to_an_inactive_device_is_ignored() {
        let mut net = Net::new(3, 2);
        let mut cfg = config(&net.root);
        cfg.group_state = GroupState::Waiting;
        let now = net.now;
        let dev = &mut net.devs[0];
        dev.node
            .install_epoch(&mut dev.store, cfg, false, now, &mut net.rng)
            .unwrap();
        let cap = capture::install();
        let e = net.event(T0, 1, &[], 1);
        net.give(0, 1, &e);
        let ev = cap.take();
        assert!(
            has(&ev, "message", "ignored", "group_state"),
            "{:?}",
            verdicts(&ev)
        );
    }

    #[test]
    fn a_held_deletion_is_released_when_due() {
        let mut net = Net::new(3, 2);
        let m = net.event(T0, 1, &[], 1);
        net.give(0, 1, &m);
        let del = crate::event::MessageEvent::create(
            &net.root,
            EventId::new(T0 + 1, [2; 16]),
            &[m.event_id()],
            Payload::Delete {
                sync_obj_id: SyncObjId::from_bytes([1; 32]),
                scheduled_at: Some(T0 + HOUR),
            },
        )
        .unwrap();
        let cap = capture::install();
        net.give(0, 1, &del);
        let ev = cap.take();
        assert!(
            has(&ev, "message", "held", "scheduled"),
            "{:?}",
            verdicts(&ev)
        );
        net.now = T0 + HOUR + 1;
        net.tick(0);
        let ev = cap.take();
        assert!(
            ev.iter().any(|e| e.ev == "engine.held.released"),
            "{:?}",
            ev.iter().map(|e| e.ev).collect::<Vec<_>>()
        );
        let _ = DAY;
    }

    #[test]
    fn an_unknown_parent_is_asked_and_the_send_is_logged() {
        let mut net = Net::new(3, 1);
        let parent = net.event(T0, 1, &[], 1);
        let child = net.event(T0 + 1, 2, &[parent.event_id()], 1);
        let cap = capture::install();
        net.give(0, 1, &child);
        net.poll(0);
        let ev = cap.take();
        assert!(ev.iter().any(|e| e.ev == "engine.retrieval.want"));
        let ask = ev
            .iter()
            .find(|e| e.ev == "engine.retrieval.ask")
            .expect("an ask line");
        assert_eq!(ask.str("what"), Some("event"));
        assert_eq!(ask.get("tier"), Some(&crate::debug::Val::U64(0)));
        let out = ev
            .iter()
            .filter(|e| e.ev == "engine.event.out")
            .collect::<Vec<_>>();
        assert!(!out.is_empty());
        assert!(out.iter().any(|o| o.to_json().contains("query:event:")));
    }
}
