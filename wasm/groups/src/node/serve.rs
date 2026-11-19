//! Received queries, responses and notices (§12.4, §12.5, §13.3 to §13.8).
//!
//! Every frame is authorized against the authenticated immediate peer (§13.7): a peer that
//! is not a member of the relevant epoch is ignored silently, and counts and state are
//! allocated only after authorization.

use super::group::Via;
use super::records::{AnswerOp, Purpose, Target, TaskKey, TriggerKind, Work};
use super::records::{EpochStatus, SHARED_SCAN, SignedKey, SignedObject};
use super::retrieval::Answer;
use super::timing::{
    QUERY_CLOCK_TOLERANCE_MS, QUEUED_ANSWERS_PER_PEER, REQUEST_BURST, REQUEST_REFILL_PER_MIN,
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
                    QueryEntry::Op(
                        QueryOp::Event { chat_id, .. } | QueryOp::SyncObj { chat_id, .. },
                    ) if !self.serves(chat_id) => AnswerOp::Status(Status::NotAvailable),
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
            if let QueryEntry::Op(
                QueryOp::Event { chat_id, .. } | QueryOp::SyncObj { chat_id, .. },
            ) = entry
            {
                // A removed peer is told of its removal (§5.6).
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
        }
        if alive {
            self.answered(&from);
        }
        Ok(())
    }

    /// Whether an entry from `from` is answered at all (§13.7). Event and sync-object
    /// lookups need an installed epoch of which `from` is a member; a tips scan is always
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
                    member_of(self, chat_id)
                }
                QueryOp::TipsScan { .. } => from != self.me,
                // No epoch context: a requester that shares an accepted epoch (§4.11, §12.7).
                QueryOp::ChatById(_)
                | QueryOp::ChatByRef(_)
                | QueryOp::ChatByParent { .. }
                | QueryOp::SharedChatsScan { .. } => from != self.me && self.shares_epoch(&from),
                // A member of the named epoch (§12.8).
                QueryOp::SignedObject { chat_id, .. } | QueryOp::Removal { chat_id, .. } => {
                    member_of(self, chat_id)
                }
                // The requester, the responder and the subject are all members (§12.9).
                QueryOp::Keys { chat_id, gossip_id } => {
                    member_of(self, chat_id)
                        && self
                            .epochs
                            .get(chat_id)
                            .is_some_and(|e| e.root.is_member(gossip_id))
                }
            },
        }
    }

    fn take_request_token(&mut self, peer: &GossipId, now: u64) -> bool {
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
        // A reference lives until its request's deadline (§13.4), whether or not a tick has
        // dropped it yet.
        if self
            .t
            .requests
            .get(&(from, request_id))
            .is_some_and(|q| deadline(q.sent_at, q.ttl) < cx.now)
        {
            self.t.requests.remove(&(from, request_id));
            return Ok(());
        }
        let Some((entry, sent_at, ttl)) = self.t.requests.get(&(from, request_id)).and_then(|q| {
            q.entries
                .get(r.idx as usize)
                .map(|e| (e.clone(), q.sent_at, q.ttl))
        }) else {
            return Ok(());
        };
        // An `expired` acknowledgement is plausible once the request is past its receiver
        // deadline, less the 5 minutes a receiver's clock may run ahead (§11.3).
        let plausible = u128::from(cx.now) + u128::from(QUERY_CLOCK_TOLERANCE_MS)
            >= u128::from(deadline(sent_at, ttl));
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
                    (Ok(EventObject::Root(r)), Target::Parent(c))
                        if self
                            .held_root(&key.chat_id)
                            .is_some_and(|child| child.commitment_for(&r.chat_id()) == c) =>
                    {
                        (self.receive_root(cx, from, *r, Via::Parent)?, None)
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
            ResponseResult::Status(Status::Malformed) => (Answer::Refused, None),
            _ => (Answer::Invalid, None),
        })
    }

    /// A notice from `from` (§13.5): each entry is authorized on its own. An event this
    /// device knows records a hint (§10.3); an unknown one, or one held only as a
    /// temporary-rejection marker, enters retrieval with `from` as the triggering candidate
    /// (§11.1, §9.6). Everything a removed peer sends is dropped (§10.4).
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
            let id = match e.item {
                EntryItem::Event(id) => id,
                EntryItem::Root => {
                    // Acted on although the epoch is unknown (§4.6, §13.7).
                    self.root_announced(cx, from, chat, TriggerKind::Notice);
                    continue;
                }
                item @ (EntryItem::Leave(_) | EntryItem::Kick(_) | EntryItem::Dissolve(_)) => {
                    self.object_announced(cx, from, chat, item, TriggerKind::Notice);
                    continue;
                }
            };
            if !self.may_receive(&chat, &from, false) {
                self.removed_contact(cx, chat, from);
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

    /// A plaintext of a version higher than supported: one version notice per peer and
    /// version per 24 hours (§13.8), to members of an installed epoch only. At most one is
    /// queued per peer at a time, and the notices are remembered for
    /// [`VERSION_NOTICES_PER_PEER`] versions, the oldest forgotten first.
    pub(crate) fn version_notice(&mut self, cx: &mut Cx<'_>, from: GossipId, version: u64) {
        if !self.shares_epoch(&from) {
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
        let due = r
            .version_notices
            .get(&version)
            .is_none_or(|last| now.saturating_sub(*last) >= VERSION_NOTICE_INTERVAL_MS);
        if due {
            r.version_notices.insert(version, now);
            while r.version_notices.len() > VERSION_NOTICES_PER_PEER {
                let oldest = r
                    .version_notices
                    .iter()
                    .min_by_key(|(v, at)| (**at, **v))
                    .map(|(v, _)| *v)
                    .expect("not empty");
                r.version_notices.remove(&oldest);
            }
            self.queue_work(from, Work::VersionNotice);
        }
    }

    /// Drops the correlation references past their deadline (§13.4).
    pub(crate) fn expire_requests(&mut self, now: u64) {
        let old: Vec<(GossipId, crate::ids::RequestId)> = self
            .t
            .requests
            .iter()
            .filter(|(_, q)| deadline(q.sent_at, q.ttl) < now)
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
                let ops: Vec<AnswerOp> = keys
                    .iter()
                    .map(|k| AnswerOp::Object {
                        chat_id: k.0,
                        item: super::objects::key_item(k),
                    })
                    .collect();
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
        let page = AnswerOp::Page {
            anchor: SHARED_SCAN,
            scan_id,
            offset,
        };
        if let Some(f) = self.t.scans_in.get(&key).cloned() {
            let Some(list) = f.list.as_ref().filter(|_| f.live_until >= cx.now) else {
                return AnswerOp::Status(Status::Restart);
            };
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
            .iter()
            .filter(|(c, e)| {
                e.root.is_member(peer)
                    && e.root.is_member(&self.me)
                    && self.serves(c)
                    && self
                        .t
                        .epochs
                        .get(c)
                        .is_some_and(|r| r.status == EpochStatus::Installed)
                    && !self.gx.children.get(c).is_some_and(|ch| {
                        ch.iter()
                            .any(|s| self.epochs.get(s).is_some_and(|se| se.root.is_member(peer)))
                    })
            })
            .map(|(c, _)| *c)
            .collect()
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
    /// (`send_owed`).
    pub(crate) fn root_served_to(&self, chat: &ChatId, peer: &GossipId) -> bool {
        self.serves(chat)
            && self
                .epochs
                .get(chat)
                .is_some_and(|e| e.root.is_member(peer))
            && !self.removed_peer(chat, peer)
    }

    /// Whether the signed object `key` is served to `peer`: this device serves its epoch
    /// (or keeps a dissolved group, for the dissolve message, §5.8), and a removed peer of
    /// the epoch gets only its own kick or leave (§10.4, §5.6).
    pub(crate) fn signed_served_to(&self, key: &SignedKey, peer: &GossipId) -> bool {
        let dissolve_kept = key.1 == SignedKind::Dissolve
            && self.installed(&key.0)
            && matches!(
                self.group_status(&key.0),
                super::records::GroupStatus::Dissolved { .. }
            );
        if !self.serves(&key.0) && !dissolve_kept {
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
