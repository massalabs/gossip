//! Received queries, responses and notices (§12.4, §12.5, §13.3 to §13.8).
//!
//! Every frame is authorized against the authenticated immediate peer (§13.7): a peer that
//! is not a member of the relevant epoch is ignored silently, and counts and state are
//! allocated only after authorization.

use super::group::Via;
use super::records::{AnswerOp, Purpose, Target, TaskKey, TriggerKind, Work};
use super::records::{EpochStatus, SHARED_SCAN, SignedKey, SignedObject};
use super::retrieval::Answer;
use super::timing::EXPIRED_GRACE_MS;
use super::timing::{
    EXPIRED_SKEW_MS, QUEUED_ANSWERS_PER_PEER, REQUEST_BURST, REQUEST_REFILL_PER_MIN,
    VERSION_NOTICE_INTERVAL_MS, VERSION_NOTICES_PER_PEER, deadline, ignored_query, may_answer,
};
use super::{Cx, Node, NodeError, PENALTY_KEY_ANSWER, PENALTY_MALFORMED};
use crate::event::{MessageEvent, Payload};
use crate::ids::{ChatId, EventId, GossipId, SyncObjId};
use crate::wire::{
    self, EntryItem, EventObject, Notice, Query, QueryEntry, QueryOp, Response, ResponseResult,
    SignedKind, Status,
};

impl Node {
    /// A query from `from` (§13.3, §13.7). A query with bad timing is ignored whole
    /// (§11.3). Each entry is authorized on its own; an authorized entry takes one unit of
    /// the peer's request budget (§17.4), or is answered `busy`; past the receiver deadline
    /// it is answered `expired`; otherwise its answer is queued and decided at assembly
    /// (§15.1). A tips scan freezes its list on receipt (§12.2).
    pub(crate) fn handle_query(
        &mut self,
        cx: &mut Cx<'_>,
        from: GossipId,
        q: Query,
    ) -> Result<(), NodeError> {
        if ignored_query(q.sent_at, q.ttl, cx.now) {
            return Ok(());
        }
        let live = may_answer(q.sent_at, q.ttl, cx.now);
        let mut queued = self
            .t
            .queue
            .range((from, 0)..=(from, u64::MAX))
            .filter(|(_, w)| matches!(w, Work::Answer { .. }))
            .count();
        let mut alive = false;
        for (idx, entry) in q.entries.iter().enumerate() {
            if !self.authorize(from, entry) {
                continue;
            }
            // A query about the messages of a chat of two is taking part in it (§5.12).
            if let QueryEntry::Op(
                QueryOp::Event { chat_id, .. }
                | QueryOp::SyncObj { chat_id, .. }
                | QueryOp::TipsScan {
                    anchor: chat_id, ..
                },
            ) = entry
            {
                self.note_participation(chat_id, from);
            }
            // An authorized entry from a member: it is online (§10.1).
            alive = alive || self.shares_epoch(&from);
            if queued >= QUEUED_ANSWERS_PER_PEER {
                // Dropped unanswered: one `busy` per entry cannot be bounded otherwise, and
                // the wire format has no status for a whole frame.
                continue;
            }
            let ops = if !self.take_request_token(&from, cx.now) {
                self.stats.busy_sent += 1;
                vec![AnswerOp::Status(Status::Busy)]
            } else if !live {
                vec![AnswerOp::Status(Status::Expired)]
            } else if let QueryEntry::Op(op) = entry
                && let Some(ops) =
                    self.membership_answer(cx, from, op, deadline(q.sent_at, q.ttl))?
            {
                ops
            } else {
                vec![match entry {
                    QueryEntry::Malformed(_) => AnswerOp::Status(Status::Malformed),
                    QueryEntry::Op(QueryOp::Event { chat_id, event_id }) => AnswerOp::Event {
                        chat_id: *chat_id,
                        event_id: *event_id,
                    },
                    QueryEntry::Op(QueryOp::SyncObj {
                        chat_id,
                        sync_obj_id,
                    }) => AnswerOp::SyncObj {
                        chat_id: *chat_id,
                        sync_obj_id: *sync_obj_id,
                    },
                    QueryEntry::Op(QueryOp::TipsScan {
                        anchor,
                        scan_id,
                        offset,
                    }) => {
                        match self.serve_tips_scan(
                            cx,
                            from,
                            *anchor,
                            *scan_id,
                            *offset,
                            deadline(q.sent_at, q.ttl),
                        )? {
                            Some(op) => op,
                            None => continue,
                        }
                    }
                    QueryEntry::Op(_) => continue,
                }]
            };
            // A removed peer is told of its removal, a former owner of its handover (§5.6), by
            // any query that names the epoch, the three membership lookups included. Why one
            // wide rule: which frames a later client sends first is local policy and may
            // change, while this list is fixed for the wire version; a pushed record is no
            // question, so no loop can start. A lookup whose answer already carries the
            // peer's own kick or leave is not answered twice.
            if let QueryEntry::Op(
                QueryOp::Event { chat_id, .. }
                | QueryOp::SyncObj { chat_id, .. }
                | QueryOp::SignedObject { chat_id, .. }
                | QueryOp::Removal { chat_id, .. }
                | QueryOp::Keys { chat_id, .. },
            ) = entry
                && !carries_own_removal(&ops, &from)
            {
                self.removed_contact(cx, *chat_id, from);
            }
            for op in ops {
                queued += 1;
                self.queue_work(
                    from,
                    Work::Answer {
                        request_id: q.request_id,
                        idx: idx as u32,
                        sent_at: q.sent_at,
                        ttl: q.ttl,
                        op,
                    },
                );
            }
            // The root of the last epoch that lists a removed peer goes with the kick or leave
            // naming it (§4.11, §5.6), under the daily limit of those replies; queued after
            // the answer, it is carried after the root.
            if let QueryEntry::Op(QueryOp::ChatById(chat)) = entry
                && self.removal_root(chat, &from)
            {
                self.removed_contact(cx, *chat, from);
            }
        }
        if alive {
            self.answered(&from);
        }
        Ok(())
    }

    /// Whether an entry from `from` is answered at all (§13.7). Event and sync-object
    /// lookups need an installed epoch of which `from` is a member, in a group where this
    /// device is active (see [`Node::answers_epoch`]); a tips scan is always
    /// answered, "not available" when this device does not hold the anchor (§12.1) and
    /// equally when `from` is not a member of the held anchor, so that a stranger cannot
    /// tell which epochs the device holds (§12.1 and §13.7 would ignore it silently); a
    /// malformed entry is answered `malformed` when `from` is a member of some installed
    /// epoch. The other operations are not handled yet.
    fn authorize(&mut self, from: GossipId, entry: &QueryEntry) -> bool {
        let member_of = |n: &Self, chat: &ChatId| {
            from != n.me && n.epochs.get(chat).is_some_and(|e| e.root.is_member(&from))
        };
        match entry {
            QueryEntry::Malformed(_) => self.shares_epoch(&from),
            QueryEntry::Op(op) => match op {
                QueryOp::Event { chat_id, .. } | QueryOp::SyncObj { chat_id, .. } => {
                    member_of(self, chat_id) && self.answers_epoch(chat_id)
                }
                QueryOp::TipsScan { .. } => from != self.me,
                // No epoch context: a requester that shares an accepted epoch (§4.11, §12.7).
                QueryOp::SharedChatsScan { .. } => from != self.me && self.shares_epoch(&from),
                // Chat lookups also from a member of an archived dissolved group, whose roots
                // stay served (see `root_served_to`).
                QueryOp::ChatById(_) | QueryOp::ChatByRef(_) | QueryOp::ChatByParent { .. } => {
                    from != self.me && (self.shares_epoch(&from) || self.shares_archive(&from))
                }
                // A member of the named epoch (§12.8). A dissolved group still serves its
                // dissolve message and an archive the removed peers' own records (§5.8).
                QueryOp::SignedObject { chat_id, kind, id } => {
                    member_of(self, chat_id)
                        && (self.answers_epoch(chat_id)
                            || self.signed_served_to(&(*chat_id, *kind, *id), &from))
                }
                QueryOp::Removal { chat_id, .. } => {
                    member_of(self, chat_id) && self.answers_epoch(chat_id)
                }
                // The requester, the responder and the subject are all members (§12.9).
                QueryOp::Keys { chat_id, gossip_id } => {
                    member_of(self, chat_id)
                        && self.answers_epoch(chat_id)
                        && self
                            .epochs
                            .get(chat_id)
                            .is_some_and(|e| e.root.is_member(gossip_id))
                }
            },
        }
    }

    /// Whether this device answers the per-epoch lookups of `chat` at all: its group is
    /// active there (D.74). A device that still holds the epoch but was kicked, left, waits
    /// for a kick or saw the group dissolved stays silent, exactly as a device that does not
    /// hold the epoch: no entry, no request token taken, the requester not marked as alive.
    /// Why: "not available" would tell a member that this device kept the chat, where silence
    /// cannot be told apart from a device that deleted it or is offline. The cost is one
    /// timeout for the asker, only until it learns that this device is out. The exceptions
    /// are stated where they are served: a dissolved group's roots and dissolve message, and
    /// a removed peer's own kick or leave from an archive (§5.8, §5.6).
    pub(crate) fn answers_epoch(&self, chat: &ChatId) -> bool {
        self.serves(chat)
    }

    pub(crate) fn take_request_token(&mut self, peer: &GossipId, now: u64) -> bool {
        self.peer_mut(peer)
            .requests
            .take(1, REQUEST_BURST, REQUEST_REFILL_PER_MIN, now)
    }

    /// A response from `from` (§13.4). The version notice records the peer's highest
    /// version. Any other response must be correlated with a reference `(from, request_id,
    /// idx)` still kept; others are dropped. Only the first valid answer of a wire entry
    /// counts for its task or scan; a duplicate may still supply event bytes, validated as
    /// any event.
    pub(crate) fn handle_response(
        &mut self,
        cx: &mut Cx<'_>,
        from: GossipId,
        version: u64,
        r: Response,
    ) -> Result<(), NodeError> {
        let Some(request_id) = r.request_id else {
            if self.shares_epoch(&from) {
                self.peer_mut(&from).version = Some(version);
            }
            return Ok(());
        };
        // An actual answer from a member, correlated or not (one delayed past its request's
        // deadline is dropped below), shows that it is alive (§10.1).
        if self.shares_epoch(&from)
            && !matches!(
                r.result,
                ResponseResult::Status(Status::Busy | Status::Expired)
            )
        {
            self.answered(&from);
        }
        // A reference serves its request until the deadline (§13.4), and an `expired` for it
        // for [`EXPIRED_GRACE_MS`] more: an honest responder sends `expired` only once the
        // deadline has passed. Any other answer that late is not correlated.
        let expired = matches!(r.result, ResponseResult::Status(Status::Expired));
        if let Some(d) = self
            .t
            .requests
            .get(&(from, request_id))
            .map(|q| deadline(q.sent_at, q.ttl))
            .filter(|d| *d < cx.now)
        {
            if cx.now > d.saturating_add(EXPIRED_GRACE_MS) {
                self.t.requests.remove(&(from, request_id));
                return self.uncorrelated(cx, from, version, &r.result);
            }
            if !expired {
                return self.uncorrelated(cx, from, version, &r.result);
            }
        }
        let Some((entry, sent_at, ttl)) = self.t.requests.get(&(from, request_id)).and_then(|q| {
            q.entries
                .get(r.idx as usize)
                .map(|e| (e.clone(), q.sent_at, q.ttl))
        }) else {
            return self.uncorrelated(cx, from, version, &r.result);
        };
        // An `expired` acknowledgement is plausible once the request is past its receiver
        // deadline, less the 5 minutes a receiver's clock may run ahead (§11.3).
        let plausible =
            u128::from(cx.now) + u128::from(EXPIRED_SKEW_MS) >= u128::from(deadline(sent_at, ttl));
        let first = !entry.answered;
        let counts = !matches!(r.result, ResponseResult::Status(Status::Expired));
        if counts && first {
            let q = self
                .t
                .requests
                .get_mut(&(from, request_id))
                .expect("present");
            q.entries[r.idx as usize].answered = true;
        }
        match entry.purpose {
            Purpose::Task(key) => {
                let answer = self.lookup_answer(cx, from, version, key, &r.result, plausible)?;
                if first {
                    self.task_answer(cx, key, from, answer.0);
                    if let (Target::SyncObj(_), Some(id)) = (key.target, answer.1) {
                        self.lookup_found(key, id);
                    }
                }
            }
            Purpose::Scan(chat) => {
                if let QueryOp::TipsScan {
                    scan_id, offset, ..
                }
                | QueryOp::SharedChatsScan { scan_id, offset } = entry.op
                    && first
                {
                    self.scan_answer(cx, chat, from, (scan_id, offset), &r.result, plausible)?;
                }
            }
        }
        Ok(())
    }

    /// A response that can no longer be correlated with a request (past its deadline, or
    /// unknown): a valid message event in it is processed as an event frame would be (§2.2:
    /// correlation only serves the retry state). A root or a signed object is not: how a
    /// device treats one depends on how it reached it (a root delivered in full prompts
    /// again after a close, §4.8), and the same object can be fetched again by ID.
    fn uncorrelated(
        &mut self,
        cx: &mut Cx<'_>,
        from: GossipId,
        version: u64,
        result: &ResponseResult,
    ) -> Result<(), NodeError> {
        if let ResponseResult::Event(blob) = result
            && let Ok(EventObject::Message(e)) = wire::decode_event_blob(blob, version)
        {
            self.receive_event(cx, from, e)?;
        }
        Ok(())
    }

    /// Judges the answer to a lookup of `key`, and receives a returned item. A returned item
    /// must match what was requested (§13.4): the epoch and the event ID or sync-object ID
    /// of an event, the hash ID of a root or signed object, the parent commitment of a chat
    /// lookup by parent, the GossipID of a key query; otherwise the answer is invalid
    /// (§11.4).
    fn lookup_answer(
        &mut self,
        cx: &mut Cx<'_>,
        from: GossipId,
        version: u64,
        key: TaskKey,
        result: &ResponseResult,
        plausible: bool,
    ) -> Result<(Answer, Option<EventId>), NodeError> {
        Ok(match result {
            ResponseResult::Event(blob) => {
                match (wire::decode_event_blob(blob, version), key.target) {
                    (Ok(EventObject::Message(e)), Target::Event(_) | Target::SyncObj(_))
                        if matches_lookup(&e, &key) =>
                    {
                        let id = e.event_id();
                        let a = self.receive_event(cx, from, e)?;
                        (a, (a == Answer::Supplied).then_some(id))
                    }
                    (Ok(EventObject::Root(r)), Target::Root) if r.chat_id() == key.chat_id => {
                        (self.receive_root(cx, from, *r, Via::Lookup)?, None)
                    }
                    // A removal lookup about a former owner, answered with the handover
                    // root it signed for the epoch looked up and left in (§5.6).
                    (Ok(EventObject::Root(r)), Target::Removal(m))
                        if r.root_type() == crate::root::RootType::Handover
                            && !r.is_member(&m)
                            && r.names_parent(&key.chat_id)
                            && self
                                .held_root(&key.chat_id)
                                .is_some_and(|p| p.owner_id() == m) =>
                    {
                        let a = self.receive_root(cx, from, *r, Via::Lookup)?;
                        self.send_owed(cx, key.chat_id, m);
                        (a, None)
                    }
                    (Ok(EventObject::Root(r)), Target::Parent(c))
                        if self
                            .held_root(&key.chat_id)
                            .is_some_and(|child| child.commitment_for(&r.chat_id()) == c) =>
                    {
                        (
                            self.receive_root(cx, from, *r, Via::Parent(key.chat_id))?,
                            None,
                        )
                    }
                    (
                        Ok(
                            obj @ (EventObject::Leave(_)
                            | EventObject::Kick(_)
                            | EventObject::Dissolve(_)),
                        ),
                        target,
                    ) => {
                        let obj = match obj {
                            EventObject::Leave(l) => SignedObject::Leave(l),
                            EventObject::Kick(k) => SignedObject::Kick(k),
                            EventObject::Dissolve(d) => SignedObject::Dissolve(d),
                            _ => unreachable!(),
                        };
                        let expected: Option<SignedKey> = match target {
                            Target::Object(kind, id) => Some((key.chat_id, kind, id)),
                            Target::Removal(m) => match &obj {
                                SignedObject::Kick(_) => Some((
                                    key.chat_id,
                                    SignedKind::Kick,
                                    *crate::hash::kick_id(&key.chat_id, &m).as_bytes(),
                                )),
                                // A leave of an earlier epoch that is live for this one
                                // answers too (see `leave_for`).
                                SignedObject::Leave(l)
                                    if l.leaver() == m
                                        && (l.chat_id() == key.chat_id
                                            || self.leave_live_for(
                                                &l.chat_id(),
                                                &m,
                                                &key.chat_id,
                                            )) =>
                                {
                                    Some(obj.key())
                                }
                                SignedObject::Leave(_) => None,
                                SignedObject::Dissolve(_) => None,
                            },
                            _ => None,
                        };
                        match expected {
                            Some(e) => (self.receive_signed(cx, from, obj, Some(e))?, None),
                            None => (Answer::Invalid, None),
                        }
                    }
                    _ => (Answer::Invalid, None),
                }
            }
            ResponseResult::Keys(bytes) => match key.target {
                Target::Keys(id) => match crate::keys::check_key_answer(bytes, &id) {
                    Ok(_) => {
                        self.cache_keys(cx, bytes);
                        (Answer::Supplied, None)
                    }
                    Err(_) => {
                        // The heaviest penalty (§4.3, §11.8); the candidate fails this pass.
                        self.stats.wrong_keys += 1;
                        self.penalize(&from, PENALTY_KEY_ANSWER);
                        (Answer::Refused, None)
                    }
                },
                _ => (Answer::Invalid, None),
            },
            ResponseResult::Status(Status::NotAvailable) => {
                self.membership_not_available(cx, from, key);
                (Answer::NotAvailable, None)
            }
            ResponseResult::Status(Status::Expired) => (Answer::Expired(plausible), None),
            ResponseResult::Status(Status::Busy) => (Answer::Busy, None),
            // Any other defined status ends the attempt, without penalty (§2.2): `restart`
            // and `unsupported` are not lookup answers, but they are valid answers.
            ResponseResult::Status(Status::Malformed | Status::Restart | Status::Unsupported) => {
                (Answer::Refused, None)
            }
            _ => (Answer::Invalid, None),
        })
    }

    /// A notice from `from` (§13.5): each entry is authorized on its own. An event this
    /// device knows records a hint (§10.3); an unknown one, or one held only as a
    /// temporary-rejection marker, enters retrieval with `from` as the triggering candidate
    /// (§11.1, §9.6). A removed peer's notices of messages are dropped (§10.4); its notices
    /// of signed objects are acted on, and the object is asked of it (see
    /// `object_announced`). Every entry from a removed peer tells it of its removal (§5.6).
    pub(crate) fn handle_notice(
        &mut self,
        cx: &mut Cx<'_>,
        from: GossipId,
        n: Notice,
    ) -> Result<(), NodeError> {
        if n.skipped > 0 && self.shares_epoch(&from) {
            self.stats.invalid += 1;
            self.penalize(&from, PENALTY_MALFORMED);
        }
        for e in n.entries {
            let chat = e.chat_id;
            // A removed peer is told of its removal, a former owner of its handover (§5.6),
            // by a notice of any kind that names the epoch.
            self.removed_contact(cx, chat, from);
            let id = match e.item {
                EntryItem::Event(id) => {
                    // A notice of a message is taking part in a chat of two (§5.12).
                    self.note_participation(&chat, from);
                    id
                }
                EntryItem::Root => {
                    // Acted on although the epoch is unknown (§4.6, §13.7), but only from a
                    // peer that shares an active accepted epoch with this device: otherwise
                    // whether a lookup comes back would tell a stranger which epochs this
                    // device holds or closed.
                    if self.shares_epoch(&from) {
                        self.root_announced(cx, from, chat, TriggerKind::Notice);
                    }
                    continue;
                }
                item @ (EntryItem::Leave(_) | EntryItem::Kick(_) | EntryItem::Dissolve(_)) => {
                    self.object_announced(cx, from, chat, item, TriggerKind::Notice);
                    continue;
                }
            };
            if !self.may_receive(&chat, &from, false) {
                continue;
            }
            // A valid entry from a member: it is responsive (§10.1).
            self.answered(&from);
            if cx.ov.event_row(&chat, &id)?.is_some_and(|r| r.processed()) {
                // A true announcement, the first from this member for this event (no hint
                // yet): it counts like a supply for its score, as when the event turns up
                // later (see `credit_announcers`), so that the "not available" an honest
                // relay gives for what it pruned since do not make it suspect.
                if !self.has_hint(chat, from, id, cx.now) {
                    self.reward(&from);
                }
                self.mark_seen(cx, chat, from, id)?;
            } else {
                self.want_event(cx, chat, id, Some(from), TriggerKind::Notice)?;
            }
        }
        Ok(())
    }

    /// A plaintext of a version higher than any this device supports (§13.8): it is not
    /// processed and never penalised, and may be answered with a version notice
    /// ([`crate::wire::version_notice`]: one plaintext at version 1 holding one response
    /// frame with an empty `request_id`, `idx = 0` and status `unsupported`).
    ///
    /// - **What for.** It is the only upgrade path of wire version 1: a device of a later
    ///   version must be able to tell "this peer speaks version 1" from silence, and fall
    ///   back to it.
    /// - **To whom.** Only to a contact the user accepted ([`Node::set_accepted_contact`]),
    ///   whether or not it shares a group; sharing a group is not enough (a co-member's
    ///   connection is automatic). Everyone else gets silence.
    /// - **Order.** The version prefix is read before any other check, the size included
    ///   ([`crate::wire::decode_plaintext`]); a lower version is dropped silently.
    /// - **How often.** Once per peer and version per 24 hours, at most
    ///   [`VERSION_NOTICES_PER_PEER`] per peer in 24 hours whatever versions it cycles
    ///   through, one queued at a time; at most that many versions are remembered per peer.
    /// - **What it reveals.** Only that this device speaks version 1, to a peer the user
    ///   accepted as a contact, which already has a session with it.
    ///
    /// A notice received is never an error: it only records the version of a peer that
    /// shares a group (`handle_response`).
    pub(crate) fn version_notice(&mut self, cx: &mut Cx<'_>, from: GossipId, version: u64) {
        if !self.t.contacts.contains(&from) {
            return;
        }
        let pending = self
            .t
            .queue
            .range((from, 0)..=(from, u64::MAX))
            .any(|(_, w)| matches!(w, Work::VersionNotice));
        if pending {
            return;
        }
        let now = cx.now;
        let r = self.peer_mut(&from);
        // Versions whose notice is 24 hours old are forgotten; the others stay, and fill the
        // peer's allowance for the day.
        r.version_notices
            .retain(|_, at| now.saturating_sub(*at) < VERSION_NOTICE_INTERVAL_MS);
        if r.version_notices.contains_key(&version)
            || r.version_notices.len() >= VERSION_NOTICES_PER_PEER
        {
            return;
        }
        r.version_notices.insert(version, now);
        self.queue_work(from, Work::VersionNotice);
    }

    /// Drops the correlation references past their deadline (§13.4).
    pub(crate) fn expire_requests(&mut self, now: u64) {
        let old: Vec<(GossipId, crate::ids::RequestId)> = self
            .t
            .requests
            .iter()
            .filter(|(_, q)| deadline(q.sent_at, q.ttl).saturating_add(EXPIRED_GRACE_MS) < now)
            .map(|(k, _)| *k)
            .collect();
        for k in old {
            self.t.requests.remove(&k);
        }
    }

    /// The event to answer an event lookup of `peer` with (§12.4): exactly that event, if
    /// available; to a removed peer, deletion events only (§10.4).
    pub(crate) fn serve_event(
        &self,
        cx: &mut Cx<'_>,
        peer: &GossipId,
        chat: &ChatId,
        id: &EventId,
    ) -> Result<Option<MessageEvent>, NodeError> {
        let Some(entry) = self.epochs.get(chat) else {
            return Ok(None);
        };
        let Some(e) = entry.epoch().serve(cx.ov, id, cx.now)? else {
            return Ok(None);
        };
        let deletion = matches!(e.payload(), Payload::Delete { .. });
        Ok(self.may_receive(chat, peer, deletion).then_some(e))
    }

    /// The event to answer a sync-object lookup with (§12.5): an available event carrying
    /// the current result, the newest one; none if no carrier is available, even if the
    /// message is still displayed. Never a pruned event restored, never a new one.
    pub(crate) fn serve_sync(
        &self,
        cx: &mut Cx<'_>,
        peer: &GossipId,
        chat: &ChatId,
        sync: &SyncObjId,
    ) -> Result<Option<MessageEvent>, NodeError> {
        let Some(obj) = cx.ov.object(chat, sync)? else {
            return Ok(None);
        };
        for id in obj.current_events.iter().rev() {
            if let Some(e) = self.serve_event(cx, peer, chat, id)? {
                return Ok(Some(e));
            }
        }
        Ok(None)
    }
}

/// Whether `ops` answer with a kick naming `peer` or a leave `peer` signed.
fn carries_own_removal(ops: &[AnswerOp], peer: &GossipId) -> bool {
    ops.iter().any(|op| match op {
        AnswerOp::Object {
            chat_id,
            item: EntryItem::Kick(k),
        } => *k == crate::hash::kick_id(chat_id, peer),
        AnswerOp::Object {
            chat_id,
            item: EntryItem::Leave(l),
        } => *l == crate::hash::leave_id(chat_id, peer),
        _ => false,
    })
}

/// Whether a returned event is the requested item (§13.4).
fn matches_lookup(e: &MessageEvent, key: &TaskKey) -> bool {
    e.chat_id() == key.chat_id
        && match key.target {
            Target::Event(id) => e.event_id() == id,
            Target::SyncObj(s) => e.payload().sync_obj_id() == s,
            _ => false,
        }
}

impl Node {
    /// The answers to a query entry of this milestone's operations (§12.6 to §12.9), decided
    /// on receipt (content is assembled later, §15.1); `None` for the other operations.
    /// "Not available" is the same whether the item is not held or the requester is not a
    /// member of it (§12.7).
    fn membership_answer(
        &mut self,
        cx: &mut Cx<'_>,
        from: GossipId,
        op: &QueryOp,
        live_until: u64,
    ) -> Result<Option<Vec<AnswerOp>>, NodeError> {
        let na = AnswerOp::Status(Status::NotAvailable);
        let root_for = |n: &Self, chat: &ChatId| {
            if n.root_served_to(chat, &from) {
                AnswerOp::Root { chat_id: *chat }
            } else {
                AnswerOp::Status(Status::NotAvailable)
            }
        };
        Ok(Some(match op {
            // The last epoch that lists a removed peer, which a shared-chats scan lists for it,
            // by ID only (§4.11): the root discloses nothing that peer did not hold.
            QueryOp::ChatById(chat) if self.removal_root(chat, &from) => {
                vec![AnswerOp::Root { chat_id: *chat }]
            }
            QueryOp::ChatById(chat) => vec![root_for(self, chat)],
            QueryOp::ChatByRef(r) => {
                let chat = self
                    .epochs
                    .iter()
                    .find(|(c, e)| e.root.ref_chat_id() == *r && self.serves(c))
                    .map(|(c, _)| *c);
                vec![chat.map_or(na, |c| root_for(self, &c))]
            }
            QueryOp::ChatByParent {
                chat_id,
                commitment,
            } => {
                let child = self
                    .held_root(chat_id)
                    .filter(|c| c.is_member(&from) && c.is_member(&self.me))
                    .filter(|c| c.parents().contains(commitment))
                    .cloned();
                let parent = child.and_then(|child| {
                    self.epochs
                        .keys()
                        .find(|p| child.commitment_for(p) == *commitment)
                        .copied()
                });
                vec![parent.map_or(na, |p| root_for(self, &p))]
            }
            QueryOp::SharedChatsScan { scan_id, offset } => {
                vec![self.serve_shared_scan(cx, from, *scan_id, *offset, live_until)]
            }
            QueryOp::SignedObject { chat_id, kind, id } => {
                let key = (*chat_id, *kind, *id);
                let served = self.signed_served_to(&key, &from)
                    && match self.t.signed.get(&key).map(|r| &r.object) {
                        // A leave that is not live is kept for its leaver and for removal
                        // lookups only (§5.3).
                        Some(SignedObject::Leave(l)) => {
                            l.leaver() == from || self.leave_live_anywhere(chat_id, &l.leaver())
                        }
                        Some(_) => true,
                        None => false,
                    };
                vec![if served {
                    AnswerOp::Object {
                        chat_id: *chat_id,
                        item: super::objects::key_item(&key),
                    }
                } else {
                    na
                }]
            }
            QueryOp::Removal { chat_id, gossip_id }
                if !self.serves(chat_id)
                    || (self.removed_peer(chat_id, &from) && *gossip_id != from) =>
            {
                vec![na]
            }
            QueryOp::Removal { chat_id, gossip_id } => {
                let kick = (
                    *chat_id,
                    SignedKind::Kick,
                    *crate::hash::kick_id(chat_id, gossip_id).as_bytes(),
                );
                let keys: Vec<SignedKey> = self
                    .t
                    .signed
                    .contains(&kick)
                    .then_some(kick)
                    .into_iter()
                    .chain(self.leave_for(chat_id, gossip_id))
                    .collect();
                let mut ops: Vec<AnswerOp> = keys
                    .iter()
                    .map(|k| AnswerOp::Object {
                        chat_id: k.0,
                        item: super::objects::key_item(k),
                    })
                    .collect();
                // Neither held: a former owner that left in a handover root this device
                // holds is answered with that root, which the requester holds the parent
                // of (§5.6).
                if ops.is_empty()
                    && let Some(h) = self
                        .handover_owed(chat_id, gossip_id)
                        .and_then(|c| c.last().copied())
                    && self.held_root(&h).is_some_and(|r| !r.is_member(gossip_id))
                    && self.root_served_to(&h, &from)
                {
                    ops.push(AnswerOp::Root { chat_id: h });
                }
                if ops.is_empty() { vec![na] } else { ops }
            }
            QueryOp::Keys { chat_id, gossip_id } => vec![if self.t.keys.contains(gossip_id)
                && self.serves(chat_id)
                && !self.removed_peer(chat_id, &from)
            {
                AnswerOp::Keys {
                    gossip_id: *gossip_id,
                }
            } else {
                na
            }],
            _ => return Ok(None),
        }))
    }

    /// A shared-chats scan request (§4.11, §12.6): the frozen list holds, ascending, every
    /// accepted epoch this device retains whose members include the requester and itself
    /// and of which it holds no successor that also lists the requester.
    fn serve_shared_scan(
        &mut self,
        cx: &mut Cx<'_>,
        peer: GossipId,
        scan_id: crate::ids::ScanId,
        offset: u64,
        live_until: u64,
    ) -> AnswerOp {
        let key = (peer, SHARED_SCAN, scan_id);
        let live_until = live_until.min(cx.now.saturating_add(super::timing::FROZEN_MAX_LIVE_MS));
        let page = AnswerOp::Page {
            anchor: SHARED_SCAN,
            scan_id,
            offset,
        };
        if let Some(f) = self.t.scans_in.get(&key).cloned() {
            let Some(list) = f.list.as_ref().filter(|_| f.live_until >= cx.now) else {
                return AnswerOp::Status(Status::Restart);
            };
            // A listed epoch is no longer listable: the scan starts again (§4.11).
            if list.iter().any(|e| !self.listable(&e.chat_id, &peer)) {
                self.t.scans_in.remove(&key);
                return AnswerOp::Status(Status::Restart);
            }
            if offset > list.len() as u64 {
                return AnswerOp::Status(Status::Malformed);
            }
            if let Some(f) = self.t.scans_in.get_mut(&key) {
                f.live_until = live_until;
            }
            return page;
        }
        if offset != 0 {
            return AnswerOp::Status(Status::Restart);
        }
        let list: Vec<crate::wire::Entry> = self
            .shared_epochs(&peer)
            .into_iter()
            .map(|chat_id| crate::wire::Entry {
                chat_id,
                item: EntryItem::Root,
            })
            .collect();
        self.t.scans_in.insert(
            key,
            super::records::FrozenScan {
                list: Some(list),
                live_until,
                forget_at: 0,
            },
        );
        page
    }

    /// The epochs a shared-chats scan of `peer` lists (§4.11), ascending.
    pub(crate) fn shared_epochs(&self, peer: &GossipId) -> Vec<ChatId> {
        self.epochs
            .keys()
            .filter(|c| self.listable(c, peer))
            .copied()
            .collect()
    }

    /// Whether a shared-chats scan of `peer` lists `chat` (§4.11): an accepted epoch this
    /// device serves (its group is active here, D.74), that lists both, and of which it holds
    /// no successor that also lists `peer`, at any depth (a member removed and added back is
    /// listed its later epochs only). For a peer removed from the group, by a kick or its
    /// signed leave, that is the last epoch that lists it.
    pub(crate) fn listable(&self, chat: &ChatId, peer: &GossipId) -> bool {
        self.epochs.get(chat).is_some_and(|e| {
            e.root.is_member(peer)
                && e.root.is_member(&self.me)
                && self.serves(chat)
                && self
                    .t
                    .epochs
                    .get(chat)
                    .is_some_and(|r| r.status == EpochStatus::Installed)
                && !self.later_epoch_lists(chat, peer)
        })
    }

    /// Whether an installed epoch that continues `chat`, at any depth, lists `peer`.
    fn later_epoch_lists(&self, chat: &ChatId, peer: &GossipId) -> bool {
        let mut seen = std::collections::BTreeSet::new();
        let mut stack: Vec<ChatId> = self
            .gx
            .children
            .get(chat)
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .collect();
        while let Some(c) = stack.pop() {
            if !seen.insert(c) {
                continue;
            }
            if self.epochs.get(&c).is_some_and(|e| e.root.is_member(peer)) {
                return true;
            }
            stack.extend(self.gx.children.get(&c).into_iter().flatten().copied());
        }
        false
    }

    /// Whether `chat` is the epoch a scan lists for `peer`, a removed peer of it: its root is
    /// answered to `peer`, which it lists, with the kick or leave naming it (§4.11, §5.6).
    pub(crate) fn removal_root(&self, chat: &ChatId, peer: &GossipId) -> bool {
        self.removed_peer(chat, peer) && self.listable(chat, peer)
    }

    /// A "not available" to a lookup of this milestone (§11.8): a failed announcement for a
    /// root the peer announced or listed; for a parent lookup, an answer counted for the
    /// invitation prompt (§4.8), without penalty.
    fn membership_not_available(&mut self, cx: &mut Cx<'_>, from: GossipId, key: TaskKey) {
        match key.target {
            Target::Root => {
                let announced = self
                    .t
                    .tasks
                    .get(&key)
                    .and_then(|t| t.candidates.get(&from))
                    .is_some_and(|c| c.trigger.is_some());
                if announced {
                    self.failed_announcement(cx, &from);
                }
            }
            Target::Parent(_) => {
                if let Some(r) = self.t.epochs.get_mut(&key.chat_id)
                    && let EpochStatus::Invitation(inv) = &mut r.status
                {
                    inv.not_available.insert(from);
                }
                if self.prompt_due(&key.chat_id, cx.now) {
                    self.changed(key.chat_id, super::records::ChangeKind::Invitation, cx.now);
                }
            }
            _ => {}
        }
    }
}

impl Node {
    /// Whether the root of `chat` is served to `peer` (§12.7): this device serves the epoch,
    /// `peer` is a member of it and not a removed peer of it (§10.4). A member removed after
    /// missing epochs is sent the roots it needs with its removal record instead
    /// (`send_owed`); a chat lookup by ID for the last epoch that lists a removed peer is
    /// answered too ([`Node::removal_root`]).
    pub(crate) fn root_served_to(&self, chat: &ChatId, peer: &GossipId) -> bool {
        // A dissolved group keeps its named root to announce the dissolve message (§5.8).
        // A dissolved group keeps its named root to announce the dissolve message (§5.8);
        // "Dissolve & Keep archived" keeps the whole line served (roots only, never
        // messages), so that a member that missed epochs reaches the dissolved one and
        // learns the dissolve.
        let dissolved_named = self.installed(chat)
            && matches!(
                self.group_status(chat),
                super::records::GroupStatus::Dissolved { epoch, must_delete, .. }
                    if epoch == *chat || !must_delete
            );
        (self.serves(chat) || dissolved_named)
            && self
                .epochs
                .get(chat)
                .is_some_and(|e| e.root.is_member(peer))
            && !self.removed_peer(chat, peer)
    }

    /// Whether the signed object `key` is served to `peer`: this device serves its epoch
    /// (or keeps a dissolved group, for the dissolve message, §5.8, and in an archive for
    /// the removed peers' own kicks and leaves), and a removed peer of the epoch gets only its
    /// own kick or leave (§10.4, §5.6).
    pub(crate) fn signed_served_to(&self, key: &SignedKey, peer: &GossipId) -> bool {
        let dissolved = |keep_only: bool| {
            self.installed(&key.0)
                && matches!(
                    self.group_status(&key.0),
                    super::records::GroupStatus::Dissolved { must_delete, .. }
                        if !(keep_only && must_delete)
                )
        };
        // An archive ("Dissolve & Keep archived") also tells a removed peer of its own
        // removal (§5.6): the dissolve names an epoch that peer is not in, and nothing else
        // would ever end its membership of the epoch it was removed from.
        let own_removal = self.removed_peer(&key.0, peer)
            && matches!(key.1, SignedKind::Kick | SignedKind::Leave)
            && dissolved(true);
        let dissolve_kept = key.1 == SignedKind::Dissolve && dissolved(false);
        if !self.serves(&key.0) && !dissolve_kept && !own_removal {
            return false;
        }
        if !self.removed_peer(&key.0, peer) {
            return true;
        }
        match self.t.signed.get(key).map(|r| &r.object) {
            Some(SignedObject::Kick(k)) => k.removed() == *peer,
            Some(SignedObject::Leave(l)) => l.leaver() == *peer,
            _ => false,
        }
    }
}

impl Node {
    /// Whether `peer` is a member of an installed epoch of a group dissolved with "Dissolve
    /// & Keep archived" (§5.8).
    pub(crate) fn shares_archive(&self, peer: &GossipId) -> bool {
        self.epochs.iter().any(|(c, e)| {
            e.root.is_member(peer)
                && matches!(
                    self.group_status(c),
                    super::records::GroupStatus::Dissolved {
                        must_delete: false,
                        ..
                    }
                )
        })
    }
}
