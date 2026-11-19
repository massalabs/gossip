//! Received queries, responses and notices (§12.4, §12.5, §13.3 to §13.8).
//!
//! Every frame is authorized against the authenticated immediate peer (§13.7): a peer that
//! is not a member of the relevant epoch is ignored silently, and counts and state are
//! allocated only after authorization.

use super::records::{AnswerOp, Purpose, Target, TaskKey, TriggerKind, Work};
use super::retrieval::Answer;
use super::timing::{
    REQUEST_BURST, REQUEST_REFILL_PER_MIN, VERSION_NOTICE_INTERVAL_MS, deadline, ignored_query,
    may_answer,
};
use super::{Cx, Node, NodeError, NotHandled, PENALTY_MALFORMED};
use crate::event::{MessageEvent, Payload};
use crate::ids::{ChatId, EventId, GossipId, SyncObjId};
use crate::wire::{
    self, EntryItem, EventObject, Notice, Query, QueryEntry, QueryOp, Response, ResponseResult,
    Status,
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
        for (idx, entry) in q.entries.iter().enumerate() {
            if !self.authorize(from, entry) {
                continue;
            }
            let op = if !self.take_request_token(&from, cx.now) {
                self.stats.busy_sent += 1;
                AnswerOp::Status(Status::Busy)
            } else if !live {
                AnswerOp::Status(Status::Expired)
            } else {
                match entry {
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
                }
            };
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
        Ok(())
    }

    /// Whether an entry from `from` is answered at all (§13.7). Event and sync-object
    /// lookups need an installed epoch of which `from` is a member; a tips scan whose anchor
    /// this device does not hold is answered "not available" (§12.1); a malformed entry is
    /// answered `malformed` when `from` is a member of some installed epoch. The other
    /// operations are not handled yet.
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
                QueryOp::TipsScan { anchor, .. } => {
                    !self.epochs.contains_key(anchor) || member_of(self, anchor)
                }
                QueryOp::ChatById(_) | QueryOp::ChatByRef(_) | QueryOp::ChatByParent { .. } => {
                    self.not_handled_yet(NotHandled::ChatLookup);
                    false
                }
                QueryOp::SharedChatsScan { .. } => {
                    self.not_handled_yet(NotHandled::SharedChatsScan);
                    false
                }
                QueryOp::SignedObject { .. } => {
                    self.not_handled_yet(NotHandled::SignedObjectLookup);
                    false
                }
                QueryOp::Removal { .. } => {
                    self.not_handled_yet(NotHandled::RemovalLookup);
                    false
                }
                QueryOp::Keys { .. } => {
                    self.not_handled_yet(NotHandled::KeyQuery);
                    false
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
        let Some(entry) = self
            .t
            .requests
            .get(&(from, request_id))
            .and_then(|q| q.entries.get(r.idx as usize))
            .cloned()
        else {
            return Ok(());
        };
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
                let answer = self.lookup_answer(cx, from, version, key, &r.result)?;
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
                } = entry.op
                    && first
                {
                    self.scan_answer(cx, chat, from, (scan_id, offset), &r.result)?;
                }
            }
        }
        Ok(())
    }

    /// Judges the answer to a lookup of `key`, and receives a returned event. A returned
    /// item must match what was requested (§13.4): the epoch and the event ID, or the
    /// epoch and the sync-object ID; otherwise the answer is invalid (§11.4).
    fn lookup_answer(
        &mut self,
        cx: &mut Cx<'_>,
        from: GossipId,
        version: u64,
        key: TaskKey,
        result: &ResponseResult,
    ) -> Result<(Answer, Option<EventId>), NodeError> {
        Ok(match result {
            ResponseResult::Event(blob) => match wire::decode_event_blob(blob, version) {
                Ok(EventObject::Message(e)) if matches_lookup(&e, &key) => {
                    let id = e.event_id();
                    let a = self.receive_event(cx, from, e)?;
                    (a, (a == Answer::Supplied).then_some(id))
                }
                _ => (Answer::Invalid, None),
            },
            ResponseResult::Status(Status::NotAvailable) => (Answer::NotAvailable, None),
            ResponseResult::Status(Status::Expired) => (Answer::Expired, None),
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
                    self.not_handled_yet(NotHandled::RootNotice);
                    continue;
                }
                EntryItem::Leave(_) | EntryItem::Kick(_) | EntryItem::Dissolve(_) => {
                    self.not_handled_yet(NotHandled::SignedObjectNotice);
                    continue;
                }
            };
            if !self.may_receive(&chat, &from, false) {
                continue;
            }
            if cx.ov.event_row(&chat, &id)?.is_some_and(|r| r.processed()) {
                self.mark_seen(cx, chat, from, id)?;
            } else {
                self.want_event(cx, chat, id, Some(from), TriggerKind::Notice)?;
            }
        }
        Ok(())
    }

    /// A plaintext of a version higher than supported: one version notice per peer and
    /// version per 24 hours (§13.8), to members of an installed epoch only.
    pub(crate) fn version_notice(&mut self, cx: &mut Cx<'_>, from: GossipId, version: u64) {
        if !self.shares_epoch(&from) {
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
        }
}
