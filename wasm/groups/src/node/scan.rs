//! Tip scans (§12.1 to §12.3): the requester's paged scans, the responder's frozen lists,
//! and the triggers and periodic lanes of recovery.

use super::records::{
    FrozenKey, FrozenScan, LANE_KINDS, LaneKind, Purpose, ScanAttempt, ScanKey, ScanOp, Work,
};
use super::timing::{
    FIRST_TTL_MS, FROZEN_ID_BYTES, LANE_OFFSET_MS, LANE_PERIOD_MS, LIVE_SCANS_PER_DEVICE,
    LIVE_SCANS_PER_PEER, MAX_UNANSWERED_STAGES, MINUTE_MS, SCAN_TOMBSTONE_MS, draw_jitter,
    jittered, next_ttl,
};
use super::{Cx, Node, NodeError, NotHandled, PENALTY_MALFORMED};
use crate::constants::{EVENT_ID_SIZE, ID_SIZE, MAX_PAGE_ENTRIES};
use crate::dag;
use crate::event::Payload;
use crate::ids::{ChatId, GossipId, ScanId};
use crate::rng::{bytes, uniform_below};
use crate::wire::{Entry, EntryItem, Page, QueryOp, ResponseResult, Status};

/// Fresh scans after `restart` before the operation gives up. §12.2 sets no bound; without
/// one a peer answering `restart` to everything would keep the requester restarting.
pub(crate) const MAX_RESTARTS: u8 = 3;
/// How long paging waits while the queue of missing IDs is full (§17.4 back-pressure).
pub(crate) const BACKPRESSURE_WAIT_MS: u64 = MINUTE_MS;

/// How a scan operation ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ScanEnd {
    /// The final page arrived.
    Final,
    /// The responder does not hold the anchor.
    NotAvailable,
    /// 20 unanswered stages, too many restarts, an invalid answer or an ineligible peer.
    Ended,
}

impl Node {
    // ── Requester ────────────────────────────────────────────────────────────

    /// Scans the group of `chat` with `peer`, or joins the scan in progress with it
    /// (overlapping triggers share one operation and one retry state, §12.3). `lane` is the
    /// periodic lane waiting for it, if any.
    pub(crate) fn start_scan(
        &mut self,
        cx: &mut Cx<'_>,
        chat: ChatId,
        peer: GossipId,
        lane: Option<u8>,
    ) {
        let key: ScanKey = (chat, peer);
        if let Some(op) = self.t.scans_out.get_mut(&key) {
            if let Some(l) = lane {
                op.lanes.insert(l);
            }
            return;
        }
        if !self.may_receive(&chat, &peer, false) {
            if let Some(l) = lane {
                self.lane_done(chat, l, cx.now);
            }
            return;
        }
        let op = ScanOp {
            scan_id: ScanId::from_bytes(bytes(cx.rng)),
            offset: 0,
            total: None,
            stage: 0,
            ttl: FIRST_TTL_MS,
            jitter: draw_jitter(cx.rng),
            attempt: ScanAttempt::Queued,
            restarts: 0,
            expired_resends: 0,
            lanes: lane.into_iter().collect(),
        };
        self.t.scans_out.insert(key, op);
        self.stats.scans_started += 1;
        self.queue_work(
            peer,
            Work::Query {
                purpose: Purpose::Scan(chat),
            },
        );
    }

    /// Trigger 1 of §12.3: after accepting an invitation or adopting a root, scan two
    /// members (or as many as exist) concurrently, preferring existing sessions.
    pub(crate) fn initial_scans(&mut self, cx: &mut Cx<'_>, chat: ChatId) {
        let mut pool = self.eligible(&chat);
        let mut chosen = Vec::new();
        while chosen.len() < 2 && !pool.is_empty() {
            let with_session: Vec<usize> = (0..pool.len())
                .filter(|i| self.sessions.contains(&pool[*i]))
                .collect();
            let i = if with_session.is_empty() {
                uniform_below(cx.rng, pool.len())
            } else {
                with_session[uniform_below(cx.rng, with_session.len())]
            };
            chosen.push(pool.swap_remove(i));
        }
        for peer in chosen {
            self.start_scan(cx, chat, peer, None);
        }
    }

    /// Trigger 2 of §12.3, a connection reset: scan `peer` at once in every group it is
    /// eligible in; a scan already in progress is resent without resetting its retries or
    /// completing it. Outstanding item queries are resent and paused tasks renewed.
    pub(crate) fn reconnected(&mut self, cx: &mut Cx<'_>, peer: GossipId) {
        self.reconnected_tasks(cx, peer);
        let chats: Vec<ChatId> = self.epochs.keys().copied().collect();
        for chat in chats {
            if !self.may_receive(&chat, &peer, false) {
                continue;
            }
            let key = (chat, peer);
            match self.t.scans_out.get(&key).map(|op| op.attempt) {
                Some(ScanAttempt::Sent { .. }) => self.resend_scan(key),
                Some(_) => {}
                None => self.start_scan(cx, chat, peer, None),
            }
        }
    }

    fn resend_scan(&mut self, key: ScanKey) {
        if let Some(op) = self.t.scans_out.get_mut(&key) {
            op.attempt = ScanAttempt::Queued;
            self.queue_work(
                key.1,
                Work::Query {
                    purpose: Purpose::Scan(key.0),
                },
            );
        }
    }

    /// The page request to send for the scan of `chat` with `peer`, with its TTL, if one is
    /// queued.
    pub(crate) fn scan_query(&self, chat: &ChatId, peer: &GossipId) -> Option<(QueryOp, u64)> {
        let op = self.t.scans_out.get(&(*chat, *peer))?;
        (op.attempt == ScanAttempt::Queued).then_some((
            QueryOp::TipsScan {
                anchor: *chat,
                scan_id: op.scan_id,
                offset: op.offset,
            },
            op.ttl,
        ))
    }

    /// The page request was handed off at `sent_at`: the stage's local wait starts.
    pub(crate) fn scan_sent(&mut self, key: ScanKey, sent_at: u64) {
        if let Some(op) = self.t.scans_out.get_mut(&key)
            && op.attempt == ScanAttempt::Queued
        {
            op.attempt = ScanAttempt::Sent {
                local_deadline: sent_at.saturating_add(jittered(op.ttl, op.jitter)),
            };
        }
    }

    /// An answer of `peer` to the page request `(scan_id, offset)` of the scan of `chat`
    /// (§12.1, §12.2). The page's entries are used whenever the page is valid; the
    /// operation advances only when the answer is for its current scan and offset.
    pub(crate) fn scan_answer(
        &mut self,
        cx: &mut Cx<'_>,
        chat: ChatId,
        peer: GossipId,
        asked: (ScanId, u64),
        result: &ResponseResult,
        plausible: bool,
    ) -> Result<(), NodeError> {
        let key = (chat, peer);
        let (scan_id, offset) = asked;
        let current = self
            .t
            .scans_out
            .get(&key)
            .is_some_and(|op| op.scan_id == scan_id);
        match result {
            ResponseResult::Page(p) => {
                let total = p.offset.checked_add(p.count);
                let consistent = self
                    .t
                    .scans_out
                    .get(&key)
                    .filter(|_| current)
                    .and_then(|op| op.total)
                    .is_none_or(|t| Some(t) == total);
                if p.scan_id != scan_id || p.offset != offset || total.is_none() || !consistent {
                    self.scan_invalid(cx, key, current);
                    return Ok(());
                }
                if p.skipped > 0 {
                    // Invalid entries are skipped and the sender penalised as for one
                    // malformed item (D.23, D.37).
                    self.stats.invalid += 1;
                    self.penalize(&peer, PENALTY_MALFORMED);
                }
                self.answered(&peer);
                for e in &p.entries {
                    match e.item {
                        EntryItem::Event(id) if e.chat_id == chat => {
                            self.want_event(
                                cx,
                                chat,
                                id,
                                Some(peer),
                                super::records::TriggerKind::Page,
                            )?;
                        }
                        _ => self.not_handled_yet(NotHandled::PageEntry),
                    }
                }
                let at_offset = current
                    && self
                        .t
                        .scans_out
                        .get(&key)
                        .is_some_and(|op| op.offset == offset);
                if !at_offset {
                    return Ok(());
                }
                if p.is_final() {
                    self.complete_scan(cx, key, ScanEnd::Final);
                    return Ok(());
                }
                let full = self.tasks_full(&chat);
                let jitter = draw_jitter(cx.rng);
                let op = self.t.scans_out.get_mut(&key).expect("current");
                op.total = total;
                op.offset = offset + p.received();
                op.stage = 0;
                op.ttl = FIRST_TTL_MS;
                op.jitter = jitter;
                op.expired_resends = 0;
                // Back-pressure pauses paging while the queue of missing IDs is full.
                if full {
                    op.attempt = ScanAttempt::Waiting {
                        until: cx.now.saturating_add(BACKPRESSURE_WAIT_MS),
                    };
                } else {
                    self.resend_scan(key);
                }
            }
            ResponseResult::Status(Status::Restart) => {
                self.answered(&peer);
                if !current {
                    return Ok(());
                }
                self.stats.restarts += 1;
                let op = self.t.scans_out.get(&key).expect("current");
                if op.restarts >= MAX_RESTARTS {
                    self.complete_scan(cx, key, ScanEnd::Ended);
                    return Ok(());
                }
                let scan_id = ScanId::from_bytes(bytes(cx.rng));
                let jitter = draw_jitter(cx.rng);
                let op = self.t.scans_out.get_mut(&key).expect("current");
                op.restarts += 1;
                op.scan_id = scan_id;
                op.offset = 0;
                op.total = None;
                op.stage = 0;
                op.ttl = FIRST_TTL_MS;
                op.jitter = jitter;
                op.expired_resends = 0;
                self.stats.scans_started += 1;
                self.resend_scan(key);
            }
            ResponseResult::Status(Status::NotAvailable) => {
                // Legitimate: the responder is late on the root (§11.8, §12.1).
                self.answered(&peer);
                if current {
                    self.not_handled_yet(NotHandled::AnchorRootNotice);
                    self.complete_scan(cx, key, ScanEnd::NotAvailable);
                }
            }
            ResponseResult::Status(Status::Expired) => {
                if let Some(op) = self.t.scans_out.get_mut(&key)
                    && current
                    && matches!(op.attempt, ScanAttempt::Sent { .. })
                    && (plausible || op.expired_resends < super::retrieval::MAX_EXPIRED_RESENDS)
                {
                    op.expired_resends += 1;
                    self.stats.expired_resends += 1;
                    self.resend_scan(key);
                }
            }
            ResponseResult::Status(Status::Busy) => {
                self.answered(&peer);
                if let Some(op) = self.t.scans_out.get_mut(&key)
                    && current
                {
                    op.attempt = ScanAttempt::Waiting {
                        until: cx.now.saturating_add(jittered(op.ttl, op.jitter)),
                    };
                }
            }
            _ => self.scan_invalid(cx, key, current),
        }
        Ok(())
    }

    fn scan_invalid(&mut self, cx: &mut Cx<'_>, key: ScanKey, current: bool) {
        self.stats.invalid += 1;
        self.penalize(&key.1, PENALTY_MALFORMED);
        if current {
            self.complete_scan(cx, key, ScanEnd::Ended);
        }
    }

    fn complete_scan(&mut self, cx: &mut Cx<'_>, key: ScanKey, end: ScanEnd) {
        let Some(op) = self.t.scans_out.remove(&key) else {
            return;
        };
        let (chat, peer) = key;
        if end == ScanEnd::Final {
            self.stats.scans_completed += 1;
        } else {
            self.stats.scans_ended += 1;
        }
        for lane in op.lanes {
            let moved = self
                .t
                .groups
                .get(&chat)
                .is_some_and(|g| g.lanes[usize::from(lane)].moved);
            // "Not available": the lane runs its scan with another peer, once per round.
            if end == ScanEnd::NotAvailable && !moved {
                let next = self.lane_peer(cx, chat, lane, Some(peer));
                if let Some(next) = next {
                    let g = self.t.groups.get_mut(&chat).expect("present");
                    g.lanes[usize::from(lane)].moved = true;
                    g.lanes[usize::from(lane)].active = Some(next);
                    self.start_scan(cx, chat, next, Some(lane));
                    continue;
                }
            }
            self.lane_done(chat, lane, cx.now);
        }
    }

    /// Local timeouts of page requests, waits after `busy` or back-pressure, and scans with
    /// peers that are no longer eligible.
    pub(crate) fn scan_timers(&mut self, cx: &mut Cx<'_>) {
        let keys: Vec<ScanKey> = self.t.scans_out.keys().copied().collect();
        for key in keys {
            if !self.may_receive(&key.0, &key.1, false) {
                self.complete_scan(cx, key, ScanEnd::Ended);
                continue;
            }
            let op = self.t.scans_out.get(&key).expect("listed").clone();
            match op.attempt {
                ScanAttempt::Sent { local_deadline } if local_deadline <= cx.now => {
                    self.stats.timeouts += 1;
                    self.note_timeout(&key.1, cx.now);
                    let stage = op.stage + 1;
                    if stage >= MAX_UNANSWERED_STAGES {
                        self.complete_scan(cx, key, ScanEnd::Ended);
                        continue;
                    }
                    let jitter = draw_jitter(cx.rng);
                    let op = self.t.scans_out.get_mut(&key).expect("listed");
                    op.stage = stage;
                    op.ttl = next_ttl(op.ttl);
                    op.jitter = jitter;
                    op.expired_resends = 0;
                    self.resend_scan(key);
                }
                ScanAttempt::Waiting { until } if until <= cx.now => {
                    if self.tasks_full(&key.0) {
                        let op = self.t.scans_out.get_mut(&key).expect("listed");
                        op.attempt = ScanAttempt::Waiting {
                            until: cx.now.saturating_add(BACKPRESSURE_WAIT_MS),
                        };
                    } else {
                        self.resend_scan(key);
                    }
                }
                _ => {}
            }
        }
    }

    // ── Periodic lanes (§12.3) ───────────────────────────────────────────────

    fn lane_done(&mut self, chat: ChatId, lane: u8, now: u64) {
        if let Some(g) = self.t.groups.get_mut(&chat) {
            let l = &mut g.lanes[usize::from(lane)];
            l.active = None;
            l.moved = false;
            // The next interval is measured from completion, in wall-clock time.
            l.earliest = now.saturating_add(LANE_PERIOD_MS);
        }
    }

    /// The peer a lane scans: the next neighbor of the persisted shuffled cycle (skipping
    /// peers that are no longer neighbors, reshuffled once exhausted), or a member that is
    /// not a neighbor, uniformly at random. `None` skips the slot; a neighbor is never
    /// substituted for a random lane.
    pub(crate) fn lane_peer(
        &mut self,
        cx: &mut Cx<'_>,
        chat: ChatId,
        lane: u8,
        not: Option<GossipId>,
    ) -> Option<GossipId> {
        match LANE_KINDS[usize::from(lane)] {
            LaneKind::Neighbor => {
                let g = self.t.groups.get_mut(&chat)?;
                let mut reshuffled = false;
                loop {
                    if g.cycle.is_empty() {
                        if reshuffled || g.neighbors.is_empty() {
                            return None;
                        }
                        reshuffled = true;
                        let mut c: Vec<GossipId> = g.neighbors.iter().copied().collect();
                        for i in (1..c.len()).rev() {
                            c.swap(i, uniform_below(cx.rng, i + 1));
                        }
                        g.cycle = c;
                    }
                    let p = g.cycle.pop().expect("non-empty");
                    if g.neighbors.contains(&p) && Some(p) != not {
                        return Some(p);
                    }
                }
            }
            LaneKind::Random => {
                let pool: Vec<GossipId> = self
                    .eligible(&chat)
                    .into_iter()
                    .filter(|p| !self.is_neighbor(&chat, p) && Some(*p) != not)
                    .collect();
                (!pool.is_empty()).then(|| pool[uniform_below(cx.rng, pool.len())])
            }
        }
    }

    /// Starts the next periodic lane when it is due (§12.3). The phase starts at the
    /// device's first time online. When a lane starts, the next one in the order becomes due
    /// `floor(6 h × r)` later, even if the first is still pending; each lane waits at least
    /// 24 h after its previous completion. Only the lane at the cursor can start, so after
    /// a long time offline one overdue round runs, not one per missed day. A lane still
    /// pending at its turn skips it (a departure from §12.3, see the comment inside).
    pub(crate) fn run_lanes(&mut self, cx: &mut Cx<'_>, chat: ChatId) {
        let now = cx.now;
        let Some(g) = self.t.groups.get(&chat) else {
            return;
        };
        if g.first_online.is_none() {
            let g = self.t.groups.get_mut(&chat).expect("present");
            g.first_online = Some(now);
            g.cursor = 0;
            g.lanes[0].due = Some(now);
        }
        let g = self.t.groups.get(&chat).expect("present");
        let i = g.cursor;
        let lane = g.lanes[usize::from(i)];
        let Some(due) = lane.due else {
            return;
        };
        if now < due.max(lane.earliest) {
            return;
        }
        // A lane whose previous scan is still pending (with a member that does not answer,
        // its 20 stages last about two weeks) gives up its turn: the next lane follows at
        // its usual offset. §12.3 would make the start wait, which stops every lane.
        let peer = if lane.active.is_some() {
            None
        } else {
            self.lane_peer(cx, chat, i, None)
        };
        let offset = jittered(LANE_OFFSET_MS, draw_jitter(cx.rng));
        let g = self.t.groups.get_mut(&chat).expect("present");
        let next = (i + 1) % 4;
        g.cursor = next;
        g.lanes[usize::from(next)].due = Some(now.saturating_add(offset));
        let l = &mut g.lanes[usize::from(i)];
        l.due = None;
        l.moved = false;
        match (lane.active, peer) {
            (Some(_), _) => {}
            (None, Some(p)) => {
                l.active = Some(p);
                self.start_scan(cx, chat, p, Some(i));
            }
            (None, None) => self.lane_done(chat, i, now),
        }
    }

    // ── Responder (§12.1, §12.2) ─────────────────────────────────────────────

    /// A tips scan request from `peer`. `None` means the request is ignored silently (the
    /// peer is not a member of the anchor). The scan state is keyed by
    /// `(peer, anchor, scan_id)`; the first valid offset-0 request freezes the list, later
    /// pages refer to it, and every valid request moves its lifetime to that request's
    /// deadline.
    pub(crate) fn serve_tips_scan(
        &mut self,
        cx: &mut Cx<'_>,
        peer: GossipId,
        anchor: ChatId,
        scan_id: ScanId,
        offset: u64,
        live_until: u64,
    ) -> Result<Option<super::records::AnswerOp>, NodeError> {
        use super::records::AnswerOp;
        let Some(entry) = self.epochs.get(&anchor) else {
            // Not holding the anchor is legitimate (§12.1).
            return Ok(Some(AnswerOp::Status(Status::NotAvailable)));
        };
        if !entry.root.is_member(&peer) || peer == self.me {
            return Ok(None);
        }
        let key: FrozenKey = (peer, anchor, scan_id);
        let page = AnswerOp::Page {
            anchor,
            scan_id,
            offset,
        };
        if let Some(f) = self.t.scans_in.get(&key).cloned() {
            let Some(list) = f.list.as_ref().filter(|_| f.live_until >= cx.now) else {
                if f.list.is_some() {
                    self.drop_frozen(key, cx.now);
                }
                // Dropped or tombstoned, including an offset-0 request (§12.2).
                return Ok(Some(AnswerOp::Status(Status::Restart)));
            };
            if offset > list.len() as u64 {
                return Ok(Some(AnswerOp::Status(Status::Malformed)));
            }
            let f = self.t.scans_in.get_mut(&key).expect("present");
            f.live_until = live_until;
            return Ok(Some(page));
        }
        if offset != 0 {
            return Ok(Some(AnswerOp::Status(Status::Restart)));
        }
        let list = self.tip_list(cx, peer, anchor)?;
        if !self.can_freeze(&peer, list.len()) {
            self.stats.busy_sent += 1;
            return Ok(Some(AnswerOp::Status(Status::Busy)));
        }
        self.t.scans_in.insert(
            key,
            FrozenScan {
                list: Some(list),
                live_until,
                forget_at: 0,
            },
        );
        Ok(Some(page))
    }

    /// Whether a new list of `n` entries may be frozen for `peer` (§17.4): 4 live scans per
    /// peer, 64 per device, 16 MiB of frozen IDs. Under pressure new scans are refused with
    /// `busy`; live ones are never evicted.
    fn can_freeze(&self, peer: &GossipId, n: usize) -> bool {
        let entry_bytes = ID_SIZE + EVENT_ID_SIZE;
        let (mut mine, mut all, mut bytes) = (0usize, 0usize, n * entry_bytes);
        for (k, f) in self.t.scans_in.iter() {
            if let Some(list) = &f.list {
                all += 1;
                bytes += list.len() * entry_bytes;
                if k.0 == *peer {
                    mine += 1;
                }
            }
        }
        mine < LIVE_SCANS_PER_PEER && all < LIVE_SCANS_PER_DEVICE && bytes <= FROZEN_ID_BYTES
    }

    /// The ordered list of a new scan (§12.1): first the signed objects (milestone 4, see
    /// [`Node::signed_scan_entries`]), then the tips of every listed epoch from two queues,
    /// deletion events by ID ascending and other events by ID descending, three deletions
    /// then one other event, the rest of one queue once the other runs out. An epoch from
    /// which the requester is a removed peer lists deletion events only (§10.4).
    fn tip_list(
        &mut self,
        cx: &mut Cx<'_>,
        peer: GossipId,
        anchor: ChatId,
    ) -> Result<Vec<Entry>, NodeError> {
        let mut list = self.signed_scan_entries(anchor, peer);
        // The epochs of the anchor's group that the requester is a member of: milestone 3
        // has one epoch per group.
        let removed = self.removed_peer(&anchor, &peer);
        let mut deletions = Vec::new();
        let mut others = Vec::new();
        for id in dag::tips(cx.ov, &anchor, cx.now)? {
            let Some(row) = cx.ov.event_row(&anchor, &id)? else {
                continue;
            };
            let Some(event) = row.event() else { continue };
            if matches!(event.payload(), Payload::Delete { .. }) {
                deletions.push(id);
            } else if !removed {
                others.push(id);
            }
        }
        deletions.sort_unstable();
        others.sort_unstable_by(|a, b| b.cmp(a));
        let (mut d, mut o) = (
            deletions.into_iter().peekable(),
            others.into_iter().peekable(),
        );
        let entry = |id| Entry {
            chat_id: anchor,
            item: EntryItem::Event(id),
        };
        loop {
            let mut took = false;
            for _ in 0..3 {
                if let Some(id) = d.next() {
                    list.push(entry(id));
                    took = true;
                }
            }
            if let Some(id) = o.next() {
                list.push(entry(id));
                took = true;
            }
            if !took {
                break;
            }
        }
        Ok(list)
    }

    /// The signed objects a tip list starts with: every live signed leave and the dissolve
    /// message of the current epoch, ascending (§12.1, D.1). Milestone 4: none yet.
    fn signed_scan_entries(&mut self, _anchor: ChatId, _peer: GossipId) -> Vec<Entry> {
        Vec::new()
    }

    /// The page to answer at assembly, from the frozen list: at most 128 entries from
    /// `offset`, `count` being what remains from `offset` (§12.1). `restart` if the list is
    /// gone by then.
    pub(crate) fn build_page(&self, key: &FrozenKey, offset: u64) -> ResponseResult {
        let Some(list) = self.t.scans_in.get(key).and_then(|f| f.list.as_ref()) else {
            return ResponseResult::Status(Status::Restart);
        };
        let Ok(start) = usize::try_from(offset) else {
            return ResponseResult::Status(Status::Malformed);
        };
        if start > list.len() {
            return ResponseResult::Status(Status::Malformed);
        }
        let end = list.len().min(start + MAX_PAGE_ENTRIES);
        ResponseResult::Page(Page {
            scan_id: key.2,
            offset,
            count: (list.len() - start) as u64,
            entries: list[start..end].to_vec(),
            skipped: 0,
        })
    }

    fn drop_frozen(&mut self, key: FrozenKey, now: u64) {
        if let Some(f) = self.t.scans_in.get_mut(&key) {
            f.list = None;
            f.forget_at = now.saturating_add(SCAN_TOMBSTONE_MS);
        }
    }

    /// Drops the frozen lists past their lifetime (keeping a tombstone for 24 h) and forgets
    /// old tombstones (§12.2).
    pub(crate) fn expire_frozen(&mut self, now: u64) {
        let keys: Vec<(FrozenKey, bool)> = self
            .t
            .scans_in
            .iter()
            .filter_map(|(k, f)| match &f.list {
                Some(_) if f.live_until < now => Some((*k, true)),
                None if f.forget_at <= now => Some((*k, false)),
                _ => None,
            })
            .collect();
        for (k, live) in keys {
            if live {
                self.drop_frozen(k, now);
            } else {
                self.t.scans_in.remove(&k);
            }
        }
    }

    /// The earliest timer of the scans, the frozen lists and the lanes.
    pub(crate) fn scan_wakeup(&self) -> Option<u64> {
        let ops = self
            .t
            .scans_out
            .iter()
            .filter_map(|(_, op)| match op.attempt {
                ScanAttempt::Sent { local_deadline } => Some(local_deadline),
                ScanAttempt::Waiting { until } => Some(until),
                ScanAttempt::Queued => None,
            });
        let frozen = self.t.scans_in.iter().map(|(_, f)| match f.list {
            Some(_) => f.live_until.saturating_add(1),
            None => f.forget_at,
        });
        let lanes = self.t.groups.iter().filter_map(|(_, g)| {
            let l = g.lanes[usize::from(g.cursor)];
            match (l.due, l.active) {
                (Some(due), None) => Some(due.max(l.earliest)),
                _ => None,
            }
        });
        ops.chain(frozen).chain(lanes).min()
    }
}
