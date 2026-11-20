//! Pending plaintext work, deferred assembly (§15.1), scheduling and packing (§13.9) and the
//! size limits of §13.10.
//!
//! Work is queued per peer as scoped references plus the kind of transmission. Immediately
//! before a plaintext is built, authorization, availability and relevance are checked again;
//! work that no longer applies is dropped, and pruning removes the work that refers to the
//! pruned events in the same commit (§9.3).

use std::collections::{BTreeMap, BTreeSet};

use super::records::{AnswerOp, Purpose, RefEntry, RequestRef, Target, Work, WorkKey};
use super::timing::{
    ABANDON_BACKOFF_MS, PLAINTEXTS_PER_POLL, RESPONSE_BURST, RESPONSE_REFILL_PER_MIN,
};
use super::{Cx, Node, NodeError};
use crate::constants::{MAX_PLAINTEXT_BYTES, MAX_QUERY_ENTRIES, PROTOCOL_VERSION};
use crate::event::{MessageEvent, Payload};
use crate::ids::{ChatId, EventId, GossipId, RequestId};
use crate::rng::{Randomness, bytes};
use crate::wire::{
    self, Entry, EntryItem, EventObject, Frame, LeaveRequest, NeighborRequest, NeighborResponse,
    Notice, Query, QueryEntry, QueryOp, Response, ResponseResult, Status, varint_len,
};

use super::records::NodeStorage;

/// The most entries of one logical response allocation (§13.9, §13.10).
pub(crate) const RESPONSE_ALLOCATION: usize = 128;
/// Full events kept for the publication confirmation that creates hints; beyond, the oldest
/// handles are forgotten (a hint is only an optimisation).
const PUBLISHED_KEPT: usize = 4_096;

/// A plaintext assembled for a peer. It counts as sent only after [`Node::handed_off`].
#[derive(Clone, PartialEq, Eq)]
pub struct Outgoing {
    /// Identifies the plaintext in [`Node::handed_off`], [`Node::published`] and
    /// [`Node::abandon`].
    pub handle: u64,
    /// The recipient.
    pub to: GossipId,
    /// The plaintext, at most [`MAX_PLAINTEXT_BYTES`] bytes.
    pub plaintext: Vec<u8>,
}

impl core::fmt::Debug for Outgoing {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.debug_struct("Outgoing")
            .field("handle", &self.handle)
            .field("to", &self.to)
            .field("plaintext", &crate::redact::Bytes(self.plaintext.len()))
            .finish()
    }
}

/// A query frame built at assembly, with the purposes of its entries.
#[derive(Debug, Clone)]
struct SentQuery {
    request_id: RequestId,
    sent_at: u64,
    ttl: u64,
    entries: Vec<RefEntry>,
}

/// What one assembled plaintext carries, applied at handoff.
#[derive(Debug, Clone, Default)]
struct Pending {
    peer: Option<GossipId>,
    items: Vec<WorkKey>,
    queries: Vec<SentQuery>,
    full: Vec<(ChatId, EventId)>,
    /// Every event the plaintext sends or announces: a prune of one makes it stale.
    events: Vec<(ChatId, EventId)>,
    bytes: u64,
    lookups: u64,
    scans: u64,
    notices: u64,
    answers: u64,
    /// Bytes of answers charged to the peer's response budget, given back on an abandon.
    charged: u64,
    /// When it was assembled.
    assembled_at: u64,
    /// The plaintext is current only before this instant: the first due item of an epoch
    /// (a deletion or activation that may change what it carries) or the end of the window
    /// of an event it carries, whichever comes first.
    valid_until: u64,
}

/// The plaintexts assembled and not confirmed yet, in memory only: after a restart their
/// work is assembled again.
#[derive(Debug, Default)]
pub(crate) struct InFlight {
    next: u64,
    sent: BTreeMap<u64, Pending>,
    items: BTreeSet<WorkKey>,
    published: BTreeMap<u64, (GossipId, Vec<(ChatId, EventId)>)>,
    /// Plaintexts in flight that refer to an event pruned since they were assembled.
    stale: BTreeSet<u64>,
    rotation: u64,
    /// The position in the 3:1 pattern of each peer's response allocation (§13.9).
    ratio: BTreeMap<GossipId, u8>,
    /// Peers reported without a session: their work stays queued.
    no_session: BTreeSet<GossipId>,
    /// Peers whose work waits after an abandon, until the given instant.
    backoff: BTreeMap<GossipId, u64>,
}

/// The event a queued full send or notice refers to.
pub(crate) fn event_ref(w: &Work) -> Option<(ChatId, EventId)> {
    match w {
        Work::Full { chat_id, event_id } | Work::Notice { chat_id, event_id } => {
            Some((*chat_id, *event_id))
        }
        _ => None,
    }
}

/// The answer categories of §13.9, in emission order. Pages are scheduled apart.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) enum Category {
    /// Roots, signed objects and key answers: sent first (§13.9, D.5).
    Priority,
    Deletion,
    Ordinary,
    Status,
}

pub(crate) struct ReadyAnswer {
    pub(crate) key: WorkKey,
    /// The event it carries, if any.
    pub(crate) event: Option<(ChatId, EventId)>,
    pub(crate) request_id: RequestId,
    pub(crate) idx: u32,
    pub(crate) category: Category,
    pub(crate) frame: Frame,
    pub(crate) len: usize,
}

/// An answer decided at assembly: its category (`None` for a page), its result, and the
/// event it carries.
type Evaluated = (Option<Category>, ResponseResult, Option<(ChatId, EventId)>);

/// The size a frame of `len` encoded bytes adds to a plaintext.
fn framed(len: usize) -> usize {
    1 + varint_len(len as u64) + len
}

impl Node {
    // ── Queueing ─────────────────────────────────────────────────────────────

    pub(crate) fn queue_work(&mut self, peer: GossipId, work: Work) {
        let mut meta = self.t.meta.get(&()).copied().unwrap_or_default();
        let key = (peer, meta.next_seq);
        meta.next_seq += 1;
        self.t.meta.insert((), meta);
        if let Some(r) = event_ref(&work) {
            self.work_refs.entry(r).or_default().insert(key);
        }
        self.t.queue.insert(key, work);
    }

    pub(crate) fn remove_queued(&mut self, key: &WorkKey) {
        self.remove_work(key);
    }

    fn remove_work(&mut self, key: &WorkKey) {
        if let Some(w) = self.t.queue.remove(key)
            && let Some(r) = event_ref(&w)
            && let Some(set) = self.work_refs.get_mut(&r)
        {
            set.remove(key);
            if set.is_empty() {
                self.work_refs.remove(&r);
            }
        }
        self.outbox.items.remove(key);
    }

    /// Whether a full send (or, with `notice`, any send) of the event to `peer` is queued.
    fn queued_for(&self, peer: GossipId, chat: ChatId, id: EventId, notice: bool) -> bool {
        self.work_refs.get(&(chat, id)).is_some_and(|keys| {
            keys.iter().any(|k| {
                k.0 == peer && (notice || matches!(self.t.queue.get(k), Some(Work::Full { .. })))
            })
        })
    }

    pub(crate) fn queue_full(&mut self, peer: GossipId, chat: ChatId, id: EventId) {
        if !self.queued_for(peer, chat, id, false) {
            self.queue_work(
                peer,
                Work::Full {
                    chat_id: chat,
                    event_id: id,
                },
            );
        }
    }

    /// Queues a notice unless a hint says `peer` has seen the event (§10.3).
    pub(crate) fn queue_notice(
        &mut self,
        cx: &mut Cx<'_>,
        peer: GossipId,
        chat: ChatId,
        id: EventId,
    ) {
        if self.has_hint(chat, peer, id, cx.now) || self.queued_for(peer, chat, id, true) {
            return;
        }
        self.queue_work(
            peer,
            Work::Notice {
                chat_id: chat,
                event_id: id,
            },
        );
    }

    // ── Assembly ─────────────────────────────────────────────────────────────

    /// Assembles plaintexts from the pending work (§13.9, §15.1), at most
    /// [`PLAINTEXTS_PER_POLL`] in this call, starting with a different peer each time so
    /// that the device-wide ceiling rotates fairly. Work that no longer applies is dropped
    /// in this operation's commit; the work carried by the returned plaintexts stays queued
    /// until [`Node::handed_off`] confirms each one.
    ///
    /// # Errors
    ///
    /// A storage failure; nothing was committed and nothing is in flight.
    pub fn poll_outbox<S: NodeStorage>(
        &mut self,
        store: &mut S,
        now: u64,
        rng: &mut dyn Randomness,
    ) -> Result<Vec<Outgoing>, NodeError> {
        let before = self.outbox.next;
        // Nothing sendable: nothing is assembled and nothing committed.
        let any = self
            .t
            .queue
            .keys()
            .any(|k| !self.outbox.items.contains(k) && self.assemblable(&k.0, now));
        if !any {
            return Ok(Vec::new());
        }
        let r = self.run(store, now, rng, |n, cx| {
            let mut peers: Vec<GossipId> = Vec::new();
            for (k, _) in n.t.queue.iter() {
                if !n.outbox.items.contains(k)
                    && peers.last() != Some(&k.0)
                    && n.assemblable(&k.0, cx.now)
                {
                    peers.push(k.0);
                }
            }
            peers.dedup();
            if peers.is_empty() {
                return Ok(Vec::new());
            }
            let mut due = u64::MAX;
            let chats: Vec<ChatId> = n.epochs.keys().copied().collect();
            for chat in chats {
                if let Some(item) = cx.ov.first_pending(&chat)? {
                    due = due.min(item.due);
                }
            }
            let start = (n.outbox.rotation % peers.len() as u64) as usize;
            n.outbox.rotation = n.outbox.rotation.wrapping_add(1);
            peers.rotate_left(start);
            let mut out = Vec::new();
            for peer in peers {
                if out.len() >= PLAINTEXTS_PER_POLL {
                    break;
                }
                let room = PLAINTEXTS_PER_POLL - out.len();
                for (plaintext, mut pending) in n.assemble(cx, peer, room)? {
                    pending.valid_until = pending
                        .events
                        .iter()
                        .map(|(_, id)| {
                            u64::try_from(crate::store::window_end(id)).unwrap_or(u64::MAX)
                        })
                        .fold(due, u64::min)
                        .max(cx.now.saturating_add(1));
                    pending.assembled_at = cx.now;
                    let handle = n.outbox.next;
                    n.outbox.next += 1;
                    n.outbox.items.extend(pending.items.iter().copied());
                    n.outbox.sent.insert(handle, pending);
                    out.push(Outgoing {
                        handle,
                        to: peer,
                        plaintext,
                    });
                }
            }
            Ok(out)
        });
        if r.is_err() {
            // Nothing is in flight from a failed assembly.
            let failed: Vec<u64> = self.outbox.sent.range(before..).map(|(h, _)| *h).collect();
            for h in failed {
                self.release(h);
            }
        }
        r
    }

    /// Forgets an assembled plaintext that will not be sent: its work is assembled again.
    ///
    /// The answers it carried are not charged to the peer's response budget, and the peer's
    /// work waits [`ABANDON_BACKOFF_MS`] before it is assembled again, unless a session or a
    /// reconnection is reported for it first ([`Node::set_session`],
    /// [`Node::peer_reconnected`]).
    pub fn abandon(&mut self, handle: u64) {
        if let Some(p) = self.release(handle)
            && let Some(peer) = p.peer
        {
            if p.charged > 0 && self.t.peers.contains(&peer) {
                self.peer_mut(&peer)
                    .responses
                    .refund(p.charged, RESPONSE_BURST);
            }
            self.outbox
                .backoff
                .insert(peer, p.assembled_at.saturating_add(ABANDON_BACKOFF_MS));
        }
    }

    /// Forgets an assembled plaintext; its work is assembled again.
    fn release(&mut self, handle: u64) -> Option<Pending> {
        self.outbox.stale.remove(&handle);
        let p = self.outbox.sent.remove(&handle)?;
        for k in &p.items {
            self.outbox.items.remove(k);
        }
        Some(p)
    }

    /// Whether the work of `peer` may be assembled at `now`: it has a session (or none was
    /// reported missing) and no abandon holds it back.
    pub(crate) fn assemblable(&self, peer: &GossipId, now: u64) -> bool {
        !self.outbox.no_session.contains(peer)
            && self.outbox.backoff.get(peer).is_none_or(|t| *t <= now)
    }

    /// A session with `peer` is reported, or its absence (in memory only).
    pub(crate) fn session_changed(&mut self, peer: GossipId, has_session: bool) {
        if has_session {
            self.outbox.no_session.remove(&peer);
            self.outbox.backoff.remove(&peer);
        } else {
            self.outbox.no_session.insert(peer);
        }
    }

    /// The transport stored the ciphertext of `handle` durably: the plaintext counts as
    /// sent (§15.2). Its work leaves the queue, its queries get their correlation references
    /// (§13.4) and their local waits start.
    ///
    /// # Errors
    ///
    /// [`NodeError::UnknownHandle`] or a storage failure; then the plaintext stays in
    /// flight and the call can be repeated.
    pub fn handed_off<S: NodeStorage>(
        &mut self,
        store: &mut S,
        handle: u64,
        now: u64,
        rng: &mut dyn Randomness,
    ) -> Result<(), NodeError> {
        let Some(p) = self.outbox.sent.get(&handle).cloned() else {
            return Err(NodeError::UnknownHandle);
        };
        let r = self.run(store, now, rng, |n, cx| {
            let peer = p.peer.expect("assembled for a peer");
            for k in &p.items {
                if let Some(Work::Answer {
                    op:
                        super::records::AnswerOp::Page {
                            anchor,
                            scan_id,
                            offset,
                        },
                    ..
                }) = n.t.queue.get(k).cloned()
                {
                    n.page_sent((peer, anchor, scan_id), offset, cx.now);
                }
                n.remove_work(k);
            }
            for q in &p.queries {
                n.t.requests.insert(
                    (peer, q.request_id),
                    RequestRef {
                        sent_at: q.sent_at,
                        ttl: q.ttl,
                        entries: q.entries.clone(),
                    },
                );
                for e in &q.entries {
                    match e.purpose {
                        Purpose::Task(key) => n.task_sent(key, peer, q.sent_at, q.ttl),
                        Purpose::Scan(chat) => n.scan_sent((chat, peer), q.sent_at),
                    }
                }
            }
            Ok(())
        });
        if let Err(e) = r {
            // Nothing was committed and the plaintext stays in flight: so does its work,
            // which the failed operation took out of the in-flight set.
            self.outbox.items.extend(p.items.iter().copied());
            return Err(e);
        }
        self.outbox.sent.remove(&handle);
        self.outbox.stale.remove(&handle);
        let s = &mut self.stats;
        s.plaintexts += 1;
        s.bytes += p.bytes;
        s.lookup_entries += p.lookups;
        s.scan_requests += p.scans;
        s.full_events += p.full.len() as u64;
        s.notice_entries += p.notices;
        s.answers += p.answers;
        if !p.full.is_empty() {
            self.outbox
                .published
                .insert(handle, (p.peer.expect("assembled"), p.full));
            while self.outbox.published.len() > PUBLISHED_KEPT {
                self.outbox.published.pop_first();
            }
        }
        Ok(())
    }

    /// Whether the plaintext `handle` is still current at `now`: in flight, no event it
    /// sends or announces was pruned since it was assembled, and nothing that could change
    /// it came due since (a scheduled deletion or activation of its epoch, the end of an
    /// event's window) (§15.1). The transport checks it immediately before encryption; a
    /// stale plaintext is abandoned ([`Node::abandon`]) and its remaining work assembled
    /// again.
    #[must_use]
    pub fn is_current(&self, handle: u64, now: u64) -> bool {
        self.outbox
            .sent
            .get(&handle)
            .is_some_and(|p| now < p.valid_until)
            && !self.outbox.stale.contains(&handle)
    }

    /// Marks stale the plaintexts in flight that refer to a pruned event (§15.1).
    pub(crate) fn stale_in_flight(&mut self, chat: ChatId, pruned: &[EventId]) {
        for (h, p) in &self.outbox.sent {
            if p.events
                .iter()
                .any(|(c, id)| *c == chat && pruned.contains(id))
            {
                self.outbox.stale.insert(*h);
            }
        }
    }

    /// The backend confirmed the publication of `handle`'s ciphertext: the full events it
    /// carried are marked as seen by the recipient, with sampled ancestors (§10.3). Local
    /// queuing alone never creates a hint.
    ///
    /// # Errors
    ///
    /// A storage failure.
    pub fn published<S: NodeStorage>(
        &mut self,
        store: &mut S,
        handle: u64,
        now: u64,
        rng: &mut dyn Randomness,
    ) -> Result<(), NodeError> {
        let Some((peer, full)) = self.outbox.published.remove(&handle) else {
            return Ok(());
        };
        self.run(store, now, rng, |n, cx| {
            for (chat, id) in full {
                n.mark_seen(cx, chat, peer, id)?;
            }
            Ok(())
        })
    }

    /// The event to send `peer` in full or announce to it, if it is still available and
    /// `peer` may receive it.
    fn sendable(
        &self,
        cx: &mut Cx<'_>,
        peer: &GossipId,
        chat: &ChatId,
        id: &EventId,
    ) -> Result<Option<MessageEvent>, NodeError> {
        self.serve_event(cx, peer, chat, id)
    }

    /// Builds the plaintexts for `peer`, at most `room` of them.
    #[allow(clippy::too_many_lines)]
    fn assemble(
        &mut self,
        cx: &mut Cx<'_>,
        peer: GossipId,
        room: usize,
    ) -> Result<Vec<(Vec<u8>, Pending)>, NodeError> {
        let items: Vec<(WorkKey, Work)> = self
            .t
            .queue
            .range((peer, 0)..=(peer, u64::MAX))
            .filter(|(k, _)| !self.outbox.items.contains(k))
            .map(|(k, w)| (*k, w.clone()))
            .collect();
        let mut stale: Vec<WorkKey> = Vec::new();
        let mut control: Vec<(WorkKey, Frame)> = Vec::new();
        let mut version_notice: Vec<WorkKey> = Vec::new();
        let mut pages: Vec<ReadyAnswer> = Vec::new();
        let mut answers: Vec<ReadyAnswer> = Vec::new();
        let mut queries: Vec<(WorkKey, Purpose, QueryOp, u64)> = Vec::new();
        let mut fulls: Vec<(WorkKey, ChatId, EventId, Frame)> = Vec::new();
        let mut notices: Vec<(WorkKey, Entry)> = Vec::new();
        let mut objects: Vec<(WorkKey, Frame)> = Vec::new();
        let mut purposes: BTreeSet<Purpose> = BTreeSet::new();
        for (key, work) in items {
            match work {
                Work::Full { chat_id, event_id } => {
                    match self.sendable(cx, &peer, &chat_id, &event_id)? {
                        Some(e) => match wire::encode_event_blob(&EventObject::Message(e)) {
                            Ok(blob) => fulls.push((key, chat_id, event_id, Frame::Event(blob))),
                            // Stored under a larger bound: it cannot be carried.
                            Err(_) => stale.push(key),
                        },
                        None => stale.push(key),
                    }
                }
                Work::Notice { chat_id, event_id } => {
                    let ok = self.sendable(cx, &peer, &chat_id, &event_id)?.is_some()
                        && !self.has_hint(chat_id, peer, event_id, cx.now);
                    if ok {
                        notices.push((
                            key,
                            Entry {
                                chat_id,
                                item: EntryItem::Event(event_id),
                            },
                        ));
                    } else {
                        stale.push(key);
                    }
                }
                Work::Query { purpose } => {
                    let q = match purpose {
                        Purpose::Task(t) => self.task_query(&t, &peer).map(|ttl| {
                            let chat_id = t.chat_id;
                            let op = match t.target {
                                Target::Event(event_id) => QueryOp::Event { chat_id, event_id },
                                Target::SyncObj(sync_obj_id) => QueryOp::SyncObj {
                                    chat_id,
                                    sync_obj_id,
                                },
                                Target::Root => QueryOp::ChatById(chat_id),
                                Target::Parent(commitment) => QueryOp::ChatByParent {
                                    chat_id,
                                    commitment,
                                },
                                Target::Object(kind, id) => {
                                    QueryOp::SignedObject { chat_id, kind, id }
                                }
                                Target::Removal(gossip_id) => {
                                    QueryOp::Removal { chat_id, gossip_id }
                                }
                                Target::Keys(gossip_id) => QueryOp::Keys { chat_id, gossip_id },
                            };
                            (op, ttl)
                        }),
                        Purpose::Scan(chat) => self.scan_query(&chat, &peer),
                    };
                    match q {
                        Some((op, ttl)) if purposes.insert(purpose) => {
                            queries.push((key, purpose, op, ttl));
                        }
                        _ => {
                            if let Purpose::Task(t) = purpose
                                && !purposes.contains(&purpose)
                            {
                                self.task_unsent(t, peer);
                            }
                            stale.push(key);
                        }
                    }
                }
                Work::Answer {
                    request_id,
                    idx,
                    sent_at,
                    ttl,
                    op,
                } => {
                    let Some((category, result, event)) =
                        self.evaluate(cx, &peer, sent_at, ttl, op)?
                    else {
                        stale.push(key);
                        continue;
                    };
                    let frame = Frame::Response(Response {
                        request_id: Some(request_id),
                        idx,
                        result,
                    });
                    let len = frame.encode().map_or(usize::MAX, |b| b.len());
                    let ready = ReadyAnswer {
                        key,
                        event,
                        request_id,
                        idx,
                        category: category.unwrap_or(Category::Status),
                        frame,
                        len,
                    };
                    if category.is_none() {
                        pages.push(ready);
                    } else {
                        answers.push(ready);
                    }
                }
                Work::NeighborRequest { chat_id } => {
                    control.push((key, Frame::NeighborRequest(NeighborRequest { chat_id })));
                }
                Work::NeighborResponse {
                    chat_id,
                    accepted,
                    suggestions,
                } => control.push((
                    key,
                    Frame::NeighborResponse(NeighborResponse {
                        chat_id,
                        accepted,
                        suggestions,
                    }),
                )),
                Work::VersionNotice => version_notice.push(key),
                Work::Object { chat_id, item } => match self.object_blob(&peer, &chat_id, item) {
                    Some(blob) => objects.push((key, Frame::Event(blob))),
                    None => stale.push(key),
                },
                Work::ObjectNotice { chat_id, item } => {
                    if self.object_blob(&peer, &chat_id, item).is_some() {
                        notices.push((key, Entry { chat_id, item }));
                    } else {
                        stale.push(key);
                    }
                }
                Work::Blob(blob) => objects.push((key, Frame::Event(blob))),
                Work::LeaveRequest { chat_id } => {
                    control.push((key, Frame::LeaveRequest(LeaveRequest { chat_id })));
                }
            }
        }

        // Frames that cannot be encoded or do not fit an empty container are dropped with
        // their work rather than sent (they cannot be, and must not stay queued).
        let fits_alone = |f: &Frame| {
            f.encode()
                .ok()
                .map(|b| b.len())
                .filter(|len| wire::single_frame_plaintext_len(*len) <= MAX_PLAINTEXT_BYTES)
        };
        let mut drop_unfit = |v: &mut Vec<ReadyAnswer>| {
            v.retain(|a| {
                let ok = fits_alone(&a.frame).is_some();
                if !ok {
                    stale.push(a.key);
                }
                ok
            });
        };
        drop_unfit(&mut pages);
        drop_unfit(&mut answers);
        fulls.retain(|(k, _, _, f)| {
            let ok = fits_alone(f).is_some();
            if !ok {
                stale.push(*k);
            }
            ok
        });
        objects.retain(|(k, f)| {
            let ok = fits_alone(f).is_some();
            if !ok {
                stale.push(*k);
            }
            ok
        });
        for k in &stale {
            self.remove_work(k);
            self.stats.invalidated += 1;
        }

        // The answers, within the response budget: pages first (scheduled apart from the
        // lookup quotas), then allocations of at most 128 entries, 3 deletions per final-lane
        // entry, ordinary messages before statuses (§13.9).
        let ordered = self.allocate(peer, pages, answers);
        let mut sendable_answers = Vec::new();
        // The peer record is touched only when there are answers to charge to it.
        if !ordered.is_empty() {
            let r = self.peer_mut(&peer);
            for a in ordered {
                let cost = a.len as u64;
                if !r
                    .responses
                    .take(cost, RESPONSE_BURST, RESPONSE_REFILL_PER_MIN, cx.now)
                {
                    break;
                }
                sendable_answers.push(a);
            }
        }

        // Frames in order: control, answers, queries (page requests first), full events,
        // notices. Then greedy packing into plaintexts by whole frames (§13.9, §13.10).
        let mut frames: Vec<(Frame, Vec<WorkKey>, Pending)> = Vec::new();
        for (k, f) in control {
            frames.push((f, vec![k], Pending::default()));
        }
        for a in sendable_answers {
            frames.push((
                a.frame,
                vec![a.key],
                Pending {
                    answers: 1,
                    charged: a.len as u64,
                    events: a.event.into_iter().collect(),
                    ..Pending::default()
                },
            ));
        }
        queries.sort_by_key(|(k, p, _, _)| (!matches!(p, Purpose::Scan(_)), *k));
        let mut by_ttl: BTreeMap<u64, Vec<(WorkKey, Purpose, QueryOp)>> = BTreeMap::new();
        for (k, p, op, ttl) in queries {
            by_ttl.entry(ttl).or_default().push((k, p, op));
        }
        for (ttl, group) in by_ttl {
            for chunk in group.chunks(MAX_QUERY_ENTRIES) {
                let request_id = RequestId::from_bytes(bytes(cx.rng));
                let mut pending = Pending::default();
                let mut entries = Vec::new();
                let mut refs = Vec::new();
                for (_, p, op) in chunk {
                    match p {
                        Purpose::Task(_) => pending.lookups += 1,
                        Purpose::Scan(_) => pending.scans += 1,
                    }
                    entries.push(QueryEntry::Op(op.clone()));
                    refs.push(RefEntry {
                        purpose: *p,
                        op: op.clone(),
                        answered: false,
                    });
                }
                pending.queries.push(SentQuery {
                    request_id,
                    sent_at: cx.now,
                    ttl,
                    entries: refs,
                });
                let keys = chunk.iter().map(|(k, _, _)| *k).collect();
                frames.push((
                    Frame::Query(Query {
                        request_id,
                        sent_at: cx.now,
                        ttl,
                        entries,
                    }),
                    keys,
                    pending,
                ));
            }
        }
        // Roots and signed objects before message events (§13.9, D.5).
        for (k, f) in objects {
            frames.push((f, vec![k], Pending::default()));
        }
        for (k, chat, id, f) in fulls {
            frames.push((
                f,
                vec![k],
                Pending {
                    full: vec![(chat, id)],
                    events: vec![(chat, id)],
                    ..Pending::default()
                },
            ));
        }
        let mut notice = Notice {
            entries: Vec::new(),
        };
        let mut notice_keys = Vec::new();
        let flush = |notice: &mut Notice,
                     keys: &mut Vec<WorkKey>,
                     frames: &mut Vec<(Frame, Vec<WorkKey>, Pending)>| {
            if notice.entries.is_empty() {
                return;
            }
            let n = notice.entries.len() as u64;
            let events = notice
                .entries
                .iter()
                .filter_map(|e| match e.item {
                    EntryItem::Event(id) => Some((e.chat_id, id)),
                    _ => None,
                })
                .collect();
            frames.push((
                Frame::Notice(core::mem::replace(
                    notice,
                    Notice {
                        entries: Vec::new(),
                    },
                )),
                core::mem::take(keys),
                Pending {
                    notices: n,
                    events,
                    ..Pending::default()
                },
            ));
        };
        for (k, e) in notices {
            // An entry encodes to at most 80 bytes, so 128 of them stay under 16 KiB; both
            // limits are kept explicitly.
            if notice.entries.len() >= super::timing::NOTICE_ENTRIES_SENT
                || (notice.entries.len() + 1) * 80 > super::timing::NOTICE_BYTES_SENT
            {
                flush(&mut notice, &mut notice_keys, &mut frames);
            }
            notice.entries.push(e);
            notice_keys.push(k);
        }
        flush(&mut notice, &mut notice_keys, &mut frames);

        let mut out: Vec<(Vec<u8>, Pending)> = Vec::new();
        for k in version_notice {
            if out.len() >= room {
                break;
            }
            let pt = wire::version_notice();
            out.push((
                pt.clone(),
                Pending {
                    peer: Some(peer),
                    items: vec![k],
                    bytes: pt.len() as u64,
                    ..Pending::default()
                },
            ));
        }
        let base = varint_len(PROTOCOL_VERSION);
        let mut current: (Vec<Frame>, Pending, usize) = (Vec::new(), Pending::default(), base);
        let finish = |cur: &mut (Vec<Frame>, Pending, usize), out: &mut Vec<(Vec<u8>, Pending)>| {
            if cur.0.is_empty() {
                return;
            }
            let (frames, mut pending, _) =
                core::mem::replace(cur, (Vec::new(), Pending::default(), base));
            // Packed by exact sizes within the limits; should encoding fail anyway, the
            // work stays queued rather than the engine panicking.
            let Ok(pt) = wire::encode_plaintext(&frames) else {
                return;
            };
            pending.peer = Some(peer);
            pending.bytes = pt.len() as u64;
            out.push((pt, pending));
        };
        for (frame, keys, part) in frames {
            let Some(len) = fits_alone(&frame) else {
                continue;
            };
            let add = framed(len);
            if current.2 + add > MAX_PLAINTEXT_BYTES {
                finish(&mut current, &mut out);
                if out.len() >= room {
                    break;
                }
            }
            current.0.push(frame);
            current.2 += add;
            let p = &mut current.1;
            p.items.extend(keys);
            p.queries.extend(part.queries);
            p.full.extend(part.full);
            p.events.extend(part.events);
            p.lookups += part.lookups;
            p.scans += part.scans;
            p.notices += part.notices;
            p.answers += part.answers;
            p.charged += part.charged;
        }
        if out.len() < room {
            finish(&mut current, &mut out);
        }
        Ok(out)
    }

    /// Decides an answer at assembly (§15.1): `None` drops it (no longer authorized); the
    /// category is `None` for a page. Past the receiver deadline, content becomes `expired`.
    fn evaluate(
        &mut self,
        cx: &mut Cx<'_>,
        peer: &GossipId,
        sent_at: u64,
        ttl: u64,
        op: AnswerOp,
    ) -> Result<Option<Evaluated>, NodeError> {
        let late = !super::timing::may_answer(sent_at, ttl, cx.now);
        let status = |s| Some((Some(Category::Status), ResponseResult::Status(s), None));
        let member =
            |n: &Self, chat: &ChatId| n.epochs.get(chat).is_some_and(|e| e.root.is_member(peer));
        Ok(match op {
            AnswerOp::Status(s) => status(s),
            _ if late => status(Status::Expired),
            AnswerOp::Event { chat_id, event_id } => {
                if !member(self, &chat_id) {
                    return Ok(None);
                }
                match self.serve_event(cx, peer, &chat_id, &event_id)? {
                    Some(e) => Some(event_answer(e)),
                    None => status(Status::NotAvailable),
                }
            }
            AnswerOp::SyncObj {
                chat_id,
                sync_obj_id,
            } => {
                if !member(self, &chat_id) {
                    return Ok(None);
                }
                match self.serve_sync(cx, peer, &chat_id, &sync_obj_id)? {
                    Some(e) => Some(event_answer(e)),
                    None => status(Status::NotAvailable),
                }
            }
            AnswerOp::Root { chat_id } | AnswerOp::Object { chat_id, .. } => {
                let item = match op {
                    AnswerOp::Object { item, .. } => item,
                    _ => EntryItem::Root,
                };
                match self.object_blob(peer, &chat_id, item) {
                    Some(blob) => {
                        Some((Some(Category::Priority), ResponseResult::Event(blob), None))
                    }
                    None => status(Status::NotAvailable),
                }
            }
            AnswerOp::Keys { gossip_id } => match self.t.keys.get(&gossip_id) {
                Some(bytes) => Some((
                    Some(Category::Priority),
                    ResponseResult::Keys(bytes.clone()),
                    None,
                )),
                None => status(Status::NotAvailable),
            },
            AnswerOp::Page {
                anchor,
                scan_id,
                offset,
            } => match self.build_page(&(*peer, anchor, scan_id), offset) {
                r @ ResponseResult::Page(_) => Some((None, r, None)),
                ResponseResult::Status(s) => status(s),
                _ => None,
            },
        })
    }

    /// Orders the ready answers: pages, then allocations of at most 128 entries following
    /// the 3:1 pattern between deletions and the final lane, round-robin across requests
    /// and ascending `idx` within each, each allocation emitted as deletions, ordinary
    /// messages, statuses (§13.9). An unused share passes to the other category.
    pub(crate) fn allocate(
        &mut self,
        peer: GossipId,
        pages: Vec<ReadyAnswer>,
        answers: Vec<ReadyAnswer>,
    ) -> Vec<ReadyAnswer> {
        let (priority, answers): (Vec<ReadyAnswer>, Vec<ReadyAnswer>) = answers
            .into_iter()
            .partition(|a| a.category == Category::Priority);
        let mut out = pages;
        out.extend(priority);
        // Round-robin across requests: the n-th answer of every request before the
        // (n+1)-th of any, requests in queue order, ascending idx within each.
        let round_robin = |mut v: Vec<ReadyAnswer>| {
            let mut first: BTreeMap<RequestId, u64> = BTreeMap::new();
            for a in &v {
                first.entry(a.request_id).or_insert(a.key.1);
            }
            v.sort_by_key(|a| (a.request_id, a.idx));
            let mut round: BTreeMap<RequestId, u32> = BTreeMap::new();
            let mut keyed: Vec<((u32, u64, u32), ReadyAnswer)> = v
                .into_iter()
                .map(|a| {
                    let r = round.entry(a.request_id).or_insert(0);
                    let k = (*r, first[&a.request_id], a.idx);
                    *r += 1;
                    (k, a)
                })
                .collect();
            keyed.sort_by_key(|(k, _)| *k);
            keyed.into_iter().map(|(_, a)| a).collect::<Vec<_>>()
        };
        let (deletions, rest): (Vec<ReadyAnswer>, Vec<ReadyAnswer>) = answers
            .into_iter()
            .partition(|a| a.category == Category::Deletion);
        let (ordinary, statuses): (Vec<ReadyAnswer>, Vec<ReadyAnswer>) = rest
            .into_iter()
            .partition(|a| a.category == Category::Ordinary);
        let mut d = round_robin(deletions).into_iter().peekable();
        let mut fin = round_robin(ordinary)
            .into_iter()
            .chain(round_robin(statuses))
            .peekable();
        let mut pos = self.outbox.ratio.get(&peer).copied().unwrap_or(0);
        loop {
            let mut batch: Vec<ReadyAnswer> = Vec::new();
            while batch.len() < RESPONSE_ALLOCATION && (d.peek().is_some() || fin.peek().is_some())
            {
                let want_deletion = pos < 3;
                let next = if want_deletion {
                    d.next().or_else(|| fin.next())
                } else {
                    fin.next().or_else(|| d.next())
                };
                batch.extend(next);
                pos = (pos + 1) % 4;
            }
            if batch.is_empty() {
                break;
            }
            batch.sort_by_key(|a| a.category);
            out.extend(batch);
        }
        self.outbox.ratio.insert(peer, pos);
        out
    }

    /// The earliest timer of the node records (for [`Node::next_wakeup`]).
    pub(crate) fn timer_wakeups(&self, now: u64, add: &mut dyn FnMut(u64)) {
        for t in [
            self.task_wakeup(),
            self.scan_wakeup(),
            self.next_hint_expiry(),
        ]
        .into_iter()
        .flatten()
        {
            add(t);
        }
        for (chat, g) in self.t.groups.iter() {
            for at in g.asked.values() {
                add(at.saturating_add(super::neighbors::NEIGHBOR_COOLDOWN_MS));
            }
            // A cooldown that ends frees a candidate.
            for until in g.cooldown.values() {
                add(*until);
            }
            // A group never run yet starts its lanes; one short of neighbors with a free
            // candidate asks it.
            if g.first_online.is_none() || self.neighbor_candidate_free(chat) {
                add(now);
            }
        }
        for (_, q) in self.t.requests.iter() {
            add(super::timing::deadline(q.sent_at, q.ttl)
                .saturating_add(super::timing::EXPIRED_GRACE_MS)
                .saturating_add(1));
        }
    }
}

fn event_answer(e: MessageEvent) -> Evaluated {
    let carried = Some((e.chat_id(), e.event_id()));
    let category = if matches!(e.payload(), Payload::Delete { .. }) {
        Category::Deletion
    } else {
        Category::Ordinary
    };
    match wire::encode_event_blob(&EventObject::Message(e)) {
        Ok(blob) => (Some(category), ResponseResult::Event(blob), carried),
        // Stored under a larger bound (an older version): it cannot be carried.
        Err(_) => (
            Some(Category::Status),
            ResponseResult::Status(Status::NotAvailable),
            None,
        ),
    }
}

impl Node {
    /// The blob of a root or signed object to send `peer`, decided at assembly (§15.1): it is
    /// still held, and `peer` is a member of the epoch it names (for a root, of the root).
    pub(crate) fn object_blob(
        &self,
        peer: &GossipId,
        chat: &ChatId,
        item: EntryItem,
    ) -> Option<Vec<u8>> {
        let root = self.held_root(chat)?;
        if !root.is_member(peer) || *peer == self.me {
            return None;
        }
        let object = match item {
            EntryItem::Root => {
                // A root decided at receipt for a removed peer (`removal_root`) is checked the
                // same way when it is sent.
                if !self.root_served_to(chat, peer) && !self.removal_root(chat, peer) {
                    return None;
                }
                EventObject::Root(Box::new(root.clone()))
            }
            EntryItem::Event(_) => return None,
            item => {
                let key = super::objects::item_key(*chat, item)?;
                if !self.signed_served_to(&key, peer) {
                    return None;
                }
                self.t.signed.get(&key)?.object.to_event_object()
            }
        };
        wire::encode_event_blob(&object).ok()
    }
}
