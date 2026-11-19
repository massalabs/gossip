//! Retrieval tasks (§11): one task per missing `(chat_id, eventId)`, shared by every
//! reference and notice, and one per sync-object lookup (§12.5). Candidates are asked one
//! at a time, never broadcast, in 20-stage runs with growing TTLs; a run pauses and is
//! renewed by new evidence; an event task ends at its lookup deadline.

use std::collections::BTreeMap;

use super::index::{Blocked, CREDIBLE};
use super::records::{
    Attempt, Candidate, CandidateState, Purpose, Run, Target, Task, TaskKey, Trigger, TriggerKind,
    Work,
};
use super::timing::{
    ACTIVE_LOOKUPS_PER_DEVICE, ACTIVE_LOOKUPS_PER_PEER, FIRST_TTL_MS, MAX_UNANSWERED_STAGES,
    QUEUED_MISSING_PER_DEVICE, QUEUED_MISSING_PER_GROUP, draw_jitter, jittered, next_ttl,
};
use super::{Cx, LookupResult, Node, NodeError, PENALTY_MALFORMED, PENALTY_UNAVAILABLE};
use crate::ids::{ChatId, EventId, GossipId};
use crate::rng::{Randomness, uniform_below};
use crate::store::in_window;

/// Resends caused by an implausible `expired` within one stage: one that comes before the
/// request could have passed its receiver deadline. §11.4 sets no bound; without one a peer
/// that always answers `expired` at once would make the requester resend forever at no cost
/// to the stage progression. A plausible `expired` (a peer back from an absence) is always
/// followed by a resend.
pub(crate) const MAX_EXPIRED_RESENDS: u8 = 2;

/// `busy` answers in a row from one peer, for one task in a run or one scan in a stage, that
/// count as an unanswered timeout. `busy` asks for a retry a minute later (§13.4), which
/// §11.4 does not count; without a bound a peer answering `busy` to everything would be
/// asked for ever at no cost.
pub(crate) const MAX_BUSY_IN_A_ROW: u8 = 3;

/// Lookups a suspect task may have outstanding with one peer, and in total (a quarter of
/// the limits of §17.4).
pub(crate) const SUSPECT_LOOKUPS_PER_PEER: usize = ACTIVE_LOOKUPS_PER_PEER / 4;
/// See [`SUSPECT_LOOKUPS_PER_PEER`].
pub(crate) const SUSPECT_LOOKUPS_PER_DEVICE: usize = ACTIVE_LOOKUPS_PER_DEVICE / 4;

/// How an answer counts for its task.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Answer {
    /// A full event that validates (whatever its merge), or the matching sync object.
    Supplied,
    /// `not_available`.
    NotAvailable,
    /// Malformed, wrong ID, failed secret proof (§11.4): penalised.
    Invalid,
    /// `malformed`: failed for this pass, not penalised.
    Refused,
    /// `busy`: refused for resource reasons; asked again a minute later (§13.4), not
    /// penalised, and no sign of responsiveness; the third in a row counts as a timeout.
    Busy,
    /// `expired`: an immediate resend (§11.4); whether it is plausible (the request may have
    /// passed its receiver deadline).
    Expired(bool),
    /// The event validates but its timestamp is beyond `now + 5 min` (§9.6): the task
    /// pauses and keeps its identity.
    TemporarilyInvalid,
}

fn fresh_run(rng: &mut dyn Randomness) -> Run {
    Run::Active {
        stage: 0,
        ttl: FIRST_TTL_MS,
        jitter: draw_jitter(rng),
        attempt: None,
        expired_resends: 0,
    }
}

/// Whether the lookup deadline of a task has passed (see [`Task::deadline`]).
fn past_deadline(key: &TaskKey, task: &Task, now: u64) -> bool {
    task.deadline(key).is_some_and(|d| d <= now)
}

impl Node {
    /// An event ID was announced, referenced as a parent or listed in a page by `from`
    /// (§11.1). Only unknown IDs and temporary-rejection markers enter retrieval: a
    /// processed ID, retained or pruned, is never requested (§11.7), and neither is an ID
    /// whose lookup deadline has passed (§11.6).
    pub(crate) fn want_event(
        &mut self,
        cx: &mut Cx<'_>,
        chat: ChatId,
        id: EventId,
        from: Option<GossipId>,
        kind: TriggerKind,
    ) -> Result<(), NodeError> {
        if cx.ov.event_row(&chat, &id)?.is_some_and(|r| r.processed()) {
            return Ok(());
        }
        if !in_window(&id, cx.now) {
            // A deadline already passed: never requested. The generic stub of §11.6 needs
            // no record, since the deadline is a function of the ID (see `task_timers`).
            return Ok(());
        }
        let key = TaskKey {
            chat_id: chat,
            target: Target::Event(id),
        };
        self.trigger(cx, key, from.map(|p| (p, kind)));
        Ok(())
    }

    /// Creates the task if needed, records the trigger of `from`, and renews a paused run
    /// (§11.5). Triggers during an active run are coalesced.
    pub(crate) fn trigger(
        &mut self,
        cx: &mut Cx<'_>,
        key: TaskKey,
        from: Option<(GossipId, TriggerKind)>,
    ) {
        if !self.t.tasks.contains(&key) {
            if self.t.tasks.len() >= QUEUED_MISSING_PER_GROUP.min(QUEUED_MISSING_PER_DEVICE)
                && self.tasks_full(&key.chat_id)
            {
                // The missing parent of an accepted event takes the place of a suspect task
                // rather than being lost (§17.4 leaves the choice to the implementation).
                let parent = matches!(from, Some((_, TriggerKind::Child)));
                if !(parent && self.evict_suspect(&key.chat_id)) {
                    self.stats.backpressure += 1;
                    return;
                }
            }
            self.t.tasks.insert(
                key,
                Task {
                    run: fresh_run(cx.rng),
                    candidates: BTreeMap::new(),
                    runs: 1,
                    created_at: cx.now,
                },
            );
            self.stats.tasks_created += 1;
        }
        let eligible = from.is_some_and(|(p, _)| self.may_receive(&key.chat_id, &p, false));
        let now = cx.now;
        let task = self.t.tasks.get_mut(&key).expect("present");
        if let Some((peer, kind)) = from.filter(|_| eligible) {
            let c = task.candidates.entry(peer).or_insert_with(Candidate::new);
            c.trigger = Some(Trigger { kind, at: now });
            // The peer now claims to hold the item: new evidence for this run.
            c.state = CandidateState::Untried;
        }
        if task.run == Run::Paused && (eligible || from.is_none()) {
            task.run = fresh_run(cx.rng);
            task.runs += 1;
            for c in task.candidates.values_mut() {
                if c.state == CandidateState::Failed {
                    c.state = CandidateState::Untried;
                }
            }
            self.stats.tasks_renewed += 1;
        }
    }

    /// Whether the queues of missing IDs are full (§17.4): 65,536 per group, 262,144 in
    /// total. Overflow pauses paging and drops the new ID; it never marks anything invalid.
    pub(crate) fn tasks_full(&self, chat: &ChatId) -> bool {
        if self.t.tasks.len() >= QUEUED_MISSING_PER_DEVICE {
            return true;
        }
        let in_group = self
            .t
            .tasks
            .range(
                TaskKey {
                    chat_id: *chat,
                    target: Target::Event(EventId::from_bytes([0; 24])),
                }..,
            )
            .take_while(|(k, _)| k.chat_id == *chat)
            .take(QUEUED_MISSING_PER_GROUP)
            .count();
        in_group >= QUEUED_MISSING_PER_GROUP
    }

    /// Removes the event task of lowest priority among the suspect ones (below
    /// [`CREDIBLE`]), in the group of `chat` if that group is full, else anywhere. Returns
    /// whether one was removed.
    fn evict_suspect(&mut self, chat: &ChatId) -> bool {
        let device_full = self.t.tasks.len() >= QUEUED_MISSING_PER_DEVICE;
        let victim = self
            .tix
            .lowest_priority(|k| {
                matches!(k.target, Target::Event(_)) && (device_full || k.chat_id == *chat)
            })
            .filter(|(p, _)| *p < CREDIBLE)
            .map(|(_, k)| k);
        let Some(victim) = victim else {
            return false;
        };
        self.t.tasks.remove(&victim);
        self.reindex(victim);
        true
    }

    /// Ends a task without counting a supply (the device obtained the item itself).
    pub(crate) fn resolve(&mut self, key: TaskKey) {
        if self.t.tasks.remove(&key).is_some() {
            self.stats.tasks_resolved += 1;
        }
    }

    /// `peer` supplied the item of `(chat, target)`: the task resolves, even if the result
    /// then loses (§11.1), and the supply raises the peer's score (§11.8).
    pub(crate) fn supplied(&mut self, peer: &GossipId, chat: ChatId, target: Target) {
        let key = TaskKey {
            chat_id: chat,
            target,
        };
        if self.t.tasks.remove(&key).is_some() {
            self.stats.tasks_resolved += 1;
            self.reward(peer);
        }
    }

    /// Completes a sync-object lookup (§12.5).
    fn complete_lookup(&mut self, key: TaskKey, result: LookupResult) {
        if let Target::SyncObj(sync) = key.target
            && self.t.tasks.remove(&key).is_some()
        {
            self.lookup_results.push((key.chat_id, sync, result));
        }
    }

    /// Applies an answer from `peer` to the task `key` (§11.4). The caller has checked that
    /// it is the first valid answer of its wire entry.
    pub(crate) fn task_answer(
        &mut self,
        cx: &mut Cx<'_>,
        key: TaskKey,
        peer: GossipId,
        answer: Answer,
    ) {
        if !matches!(answer, Answer::Expired(_) | Answer::Busy) {
            self.answered(&peer);
        }
        if answer == Answer::Supplied {
            match key.target {
                Target::Event(_) => self.supplied(&peer, key.chat_id, key.target),
                Target::SyncObj(_) => {
                    // The event's ID is reported by the caller, which knows it.
                    self.reward(&peer);
                }
            }
            return;
        }
        let Some(task) = self.t.tasks.get(&key).cloned() else {
            return;
        };
        let mut task = task;
        let current = matches!(task.run, Run::Active { attempt: Some(a), .. } if a.peer() == peer);
        let cand = task.candidates.entry(peer).or_insert_with(Candidate::new);
        if !matches!(answer, Answer::Busy | Answer::Expired(_)) {
            cand.busy = 0;
        }
        let mut timed_out = false;
        match answer {
            Answer::Supplied => unreachable!(),
            Answer::TemporarilyInvalid => {
                task.run = Run::Paused;
                self.stats.tasks_paused += 1;
            }
            Answer::NotAvailable => {
                cand.state = CandidateState::NotAvailable;
                cand.outstanding_until = None;
                let announced = cand.announced();
                // Any valid answer resets the progression (§11.4).
                if let Run::Active { attempt, .. } = task.run {
                    task.run = Run::Active {
                        stage: 0,
                        ttl: FIRST_TTL_MS,
                        jitter: draw_jitter(cx.rng),
                        attempt: if current { None } else { attempt },
                        expired_resends: 0,
                    };
                }
                if announced {
                    self.penalize(&peer, PENALTY_UNAVAILABLE);
                }
            }
            Answer::Invalid | Answer::Refused => {
                cand.state = CandidateState::Failed;
                cand.outstanding_until = None;
                if answer == Answer::Invalid {
                    self.stats.invalid += 1;
                    self.penalize(&peer, PENALTY_MALFORMED);
                }
                // The next candidate is tried at once, at the current stage.
                if current && let Run::Active { attempt, .. } = &mut task.run {
                    *attempt = None;
                }
            }
            Answer::Busy => {
                cand.busy = cand.busy.saturating_add(1);
                if cand.busy >= MAX_BUSY_IN_A_ROW {
                    // As an unanswered timeout: failed for this run, and the stage ends.
                    cand.busy = 0;
                    cand.state = CandidateState::Failed;
                    cand.outstanding_until = None;
                    timed_out = true;
                } else {
                    // Retry later: skipped for one local wait of the first TTL, whatever
                    // the stage; a budget refills in seconds (§17.4), and a stage can last
                    // a day.
                    let wait = jittered(FIRST_TTL_MS, draw_jitter(cx.rng));
                    cand.outstanding_until = Some(cx.now.saturating_add(wait));
                    if current && let Run::Active { attempt, .. } = &mut task.run {
                        *attempt = None;
                    }
                }
            }
            Answer::Expired(plausible) => {
                if let Run::Active {
                    attempt: Some(Attempt::Sent { .. }),
                    expired_resends,
                    ..
                } = &mut task.run
                    && current
                    && (plausible || *expired_resends < MAX_EXPIRED_RESENDS)
                {
                    // The attempt stays sent with its local deadline: the resend does not
                    // change the stage (§11.4).
                    *expired_resends += 1;
                    self.stats.expired_resends += 1;
                    self.queue_work(
                        peer,
                        Work::Query {
                            purpose: Purpose::Task(key),
                        },
                    );
                }
            }
        }
        self.t.tasks.insert(key, task);
        if timed_out {
            self.note_timeout(&peer, cx.now);
            if current {
                self.next_stage(cx, key);
            }
        }
    }

    /// The current stage of `key` ended unanswered: the next stage, with the next TTL and a
    /// new jitter, and at once the next candidate (no extra backoff); after twenty, the
    /// task pauses.
    fn next_stage(&mut self, cx: &mut Cx<'_>, key: TaskKey) {
        let Some(Run::Active { stage, ttl, .. }) = self.t.tasks.get(&key).map(|t| t.run) else {
            return;
        };
        let stage = stage + 1;
        if stage >= MAX_UNANSWERED_STAGES {
            self.pause(key);
        } else {
            let jitter = draw_jitter(cx.rng);
            let task = self.t.tasks.get_mut(&key).expect("present");
            task.run = Run::Active {
                stage,
                ttl: next_ttl(ttl),
                jitter,
                attempt: None,
                expired_resends: 0,
            };
        }
        self.reindex(key);
    }

    /// Reports a sync-object lookup answered with an event (§12.5).
    pub(crate) fn lookup_found(&mut self, key: TaskKey, event: EventId) {
        self.complete_lookup(key, LookupResult::Found(event));
    }

    /// Starts an attempt for every active task that has none: the next candidate by the
    /// order of §11.2, within the lookup limits of §17.4 (16 entries per peer, 64 in all).
    /// A task with no candidate left pauses (a sync-object lookup then completes, not
    /// found).
    pub(crate) fn schedule(&mut self, cx: &mut Cx<'_>) -> Result<(), NodeError> {
        self.reindex_dirty();
        self.tix.wake_until(cx.now);
        self.tix.wake_free(ACTIVE_LOOKUPS_PER_PEER);
        if self.tix.total >= ACTIVE_LOOKUPS_PER_DEVICE || self.tix.none_ready() {
            return Ok(());
        }
        // Only the ready tasks are ranked, highest priority first (tasks whose best
        // triggering peer scores higher): a task found waiting is ranked again when what
        // held it back changes (the task itself, a slot of one of its candidates, or the
        // expiry of an outstanding request), see `index`.
        while self.tix.total < ACTIVE_LOOKUPS_PER_DEVICE {
            let Some(key) = self.tix.ready().next() else {
                break;
            };
            // A suspect task may use a quarter of the slots, so that IDs announced by peers
            // that then deny or ignore them cannot crowd out credible retrieval (§17.4
            // leaves the fair use of the device-wide ceiling to the implementation).
            let suspect = self.priority(&key) < CREDIBLE;
            if suspect && self.tix.suspect_total >= SUSPECT_LOOKUPS_PER_DEVICE {
                self.tix.block(
                    key,
                    Blocked {
                        peers: Vec::new(),
                        until: cx.now.saturating_add(FIRST_TTL_MS),
                    },
                );
                continue;
            }
            let load: BTreeMap<GossipId, usize> = if suspect {
                // A peer is full for a suspect task at its suspect share.
                self.tix
                    .load
                    .iter()
                    .map(|(p, n)| {
                        let s = self.tix.suspect_load.get(p).copied().unwrap_or(0);
                        let full = s >= SUSPECT_LOOKUPS_PER_PEER;
                        (*p, if full { ACTIVE_LOOKUPS_PER_PEER } else { *n })
                    })
                    .collect()
            } else {
                self.tix.load.clone()
            };
            if past_deadline(&key, self.t.tasks.get(&key).expect("ready"), cx.now) {
                // Removed by the next timer pass; not ranked meanwhile.
                self.tix.block(
                    key,
                    Blocked {
                        peers: Vec::new(),
                        until: u64::MAX,
                    },
                );
                continue;
            }
            match self.select(cx, &key, &load) {
                Selection::Peer(peer) => {
                    let task = self.t.tasks.get_mut(&key).expect("ready");
                    if let Run::Active { attempt, .. } = &mut task.run {
                        *attempt = Some(Attempt::Queued { peer });
                    }
                    self.reindex(key);
                    self.queue_work(
                        peer,
                        Work::Query {
                            purpose: Purpose::Task(key),
                        },
                    );
                }
                Selection::Wait(b) => self.tix.block(key, b),
                Selection::Exhausted => {
                    self.pause(key);
                    self.reindex(key);
                }
            }
        }
        Ok(())
    }

    /// Brings the task index up to date for `key`.
    pub(crate) fn reindex(&mut self, key: TaskKey) {
        let prio = self.priority(&key);
        self.tix.update(key, self.t.tasks.get(&key), prio);
    }

    /// Brings the task index up to date for every task written in this operation.
    pub(crate) fn reindex_dirty(&mut self) {
        for key in self.t.tasks.dirty_keys() {
            self.reindex(key);
        }
    }

    /// Whether `peer` answers: fewer than three queries in a row timed out since its last
    /// valid answer. Within a tier of §11.2 responsive peers come first, and a task waits
    /// for a responsive peer at its lookup limit rather than asking an unresponsive one.
    pub(crate) fn responsive(&self, peer: &GossipId) -> bool {
        self.t
            .peers
            .get(peer)
            .is_none_or(|r| r.failures < super::neighbors::NEIGHBOR_FAILURES)
    }

    /// The scheduling priority of a task: the best score among its untried, responsive
    /// candidates with a trigger, so that what honest, supplying peers announce goes first. Below [`CREDIBLE`] the task is suspect: every announcer
    /// said it did not have the event, or never answered, or scores below an unmeasured peer.
    pub(crate) fn priority(&self, key: &TaskKey) -> u64 {
        self.t.tasks.get(key).map_or(0, |task| {
            task.candidates
                .iter()
                .filter(|(p, c)| {
                    c.trigger.is_some() && c.state == CandidateState::Untried && self.responsive(p)
                })
                .map(|(p, _)| self.score(p))
                .max()
                .unwrap_or(0)
        })
    }

    fn pause(&mut self, key: TaskKey) {
        match key.target {
            Target::SyncObj(_) => self.complete_lookup(key, LookupResult::NotFound),
            Target::Event(_) => {
                if let Some(t) = self.t.tasks.get_mut(&key) {
                    t.run = Run::Paused;
                    self.stats.tasks_paused += 1;
                }
            }
        }
    }

    /// The next candidate of a task (§11.2): first the peers that announced the event or
    /// delivered a child referencing it, then the neighbors, then the other members,
    /// preferring existing sessions; within a tier by score, then by the receipt time of the
    /// trigger (newer first), exact ties uniformly at random. A peer that answered "not
    /// available" or failed in this run, or whose earlier request is still outstanding, is
    /// skipped, and so is a peer that already has 16 lookups outstanding (§17.4): the next
    /// candidate is asked instead, so that a peer announcing many IDs cannot hold back the
    /// retrieval of what others can supply.
    fn select(
        &mut self,
        cx: &mut Cx<'_>,
        key: &TaskKey,
        load: &BTreeMap<GossipId, usize>,
    ) -> Selection {
        let task = self.t.tasks.get(key).expect("listed");
        let mut ranked: Vec<(Rank, GossipId, bool)> = Vec::new();
        let mut until = u64::MAX;
        for peer in self.eligible(&key.chat_id) {
            let c = task
                .candidates
                .get(&peer)
                .copied()
                .unwrap_or_else(Candidate::new);
            if c.state != CandidateState::Untried {
                continue;
            }
            if let Some(u) = c.outstanding_until.filter(|u| *u >= cx.now) {
                until = until.min(u.saturating_add(1));
                continue;
            }
            let limited = load.get(&peer).copied().unwrap_or(0) >= ACTIVE_LOOKUPS_PER_PEER;
            let tier = if c.trigger.is_some() {
                0
            } else if self.is_neighbor(&key.chat_id, &peer) {
                1
            } else if self.sessions.contains(&peer) {
                2
            } else {
                3
            };
            let at = c.trigger.map_or(0, |t| t.at);
            ranked.push((
                (
                    tier,
                    u8::from(!self.responsive(&peer)),
                    u64::MAX - self.score(&peer),
                    u64::MAX - at,
                ),
                peer,
                limited,
            ));
        }
        let Some(best) = ranked
            .iter()
            .filter(|(_, _, limited)| !limited)
            .map(|(k, _, _)| *k)
            .min()
        else {
            if ranked.is_empty() && until == u64::MAX {
                return Selection::Exhausted;
            }
            return Selection::Wait(Blocked {
                peers: ranked.iter().map(|(_, p, _)| *p).collect(),
                until,
            });
        };
        let ties: Vec<GossipId> = ranked
            .iter()
            .filter(|(k, _, limited)| *k == best && !limited)
            .map(|(_, p, _)| *p)
            .collect();
        // Rather than a member that stopped answering, for a stage of up to a day, wait for
        // a responsive one whose slots are full: one frees in minutes when it is online.
        let busy_responsive: Vec<GossipId> = ranked
            .iter()
            .filter(|(_, p, limited)| *limited && self.responsive(p))
            .map(|(_, p, _)| *p)
            .collect();
        if best.1 == 1 && !busy_responsive.is_empty() {
            return Selection::Wait(Blocked {
                peers: busy_responsive,
                until,
            });
        }
        Selection::Peer(ties[uniform_below(cx.rng, ties.len())])
    }

    /// The query of `key` was handed off to `peer` at `sent_at` with `ttl`: the stage's
    /// local wait starts (a resend keeps the one running), and the peer is
    /// outstanding until the request's deadline.
    pub(crate) fn task_sent(&mut self, key: TaskKey, peer: GossipId, sent_at: u64, ttl: u64) {
        let Some(task) = self.t.tasks.get_mut(&key) else {
            return;
        };
        if let Run::Active {
            attempt: attempt @ Some(Attempt::Queued { .. }),
            jitter,
            ..
        } = &mut task.run
            && attempt.is_some_and(|a| a.peer() == peer)
        {
            *attempt = Some(Attempt::Sent {
                peer,
                local_deadline: sent_at.saturating_add(jittered(ttl, *jitter)),
            });
        }
        let c = task.candidates.entry(peer).or_insert_with(Candidate::new);
        c.outstanding_until = Some(super::timing::deadline(sent_at, ttl));
        c.attempts = c.attempts.saturating_add(1);
    }

    /// A queued query of `key` for `peer` was dropped before it was sent (the peer is no
    /// longer eligible, or the task changed): the attempt is abandoned.
    pub(crate) fn task_unsent(&mut self, key: TaskKey, peer: GossipId) {
        if let Some(task) = self.t.tasks.get_mut(&key)
            && let Run::Active { attempt, .. } = &mut task.run
            && *attempt == Some(Attempt::Queued { peer })
        {
            *attempt = None;
        }
    }

    /// The query entry to send for `key`, with its TTL, if the task still wants `peer`: a
    /// queued attempt, or a resend of a sent one (after a reconnection or `expired`).
    pub(crate) fn task_query(&self, key: &TaskKey, peer: &GossipId) -> Option<u64> {
        match self.t.tasks.get(key)?.run {
            Run::Active {
                attempt: Some(Attempt::Queued { peer: p } | Attempt::Sent { peer: p, .. }),
                ttl,
                ..
            } if p == *peer => Some(ttl),
            _ => None,
        }
    }

    /// Lookup deadlines and local timeouts (§11.3, §11.4, §11.6).
    ///
    /// At its deadline an event task stops: no new request or resend, and the ID stays
    /// unknown with no record. §11.6 says it is "pruned to a generic stub"; a stub is not
    /// needed because the deadline is computed from the ID itself, so any later notice or
    /// reference to it is refused by the same test, and a full event that arrives later is
    /// merged as one under an ID that was only known (§9.5). Requests already sent keep
    /// their validity through their correlation references.
    pub(crate) fn task_timers(&mut self, cx: &mut Cx<'_>) {
        self.reindex_dirty();
        while let Some(&(deadline, key)) = self.tix.deadlines.first() {
            if deadline > cx.now {
                break;
            }
            self.t.tasks.remove(&key);
            self.reindex(key);
            self.stats.tasks_expired += 1;
        }
        while let Some(&(local_deadline, key)) = self.tix.timers.first() {
            if local_deadline > cx.now {
                break;
            }
            let task = self.t.tasks.get(&key).expect("indexed");
            let Run::Active {
                attempt: Some(Attempt::Sent { peer, .. }),
                ..
            } = task.run
            else {
                unreachable!("a timer belongs to a sent attempt");
            };
            self.stats.timeouts += 1;
            self.note_timeout(&peer, cx.now);
            self.next_stage(cx, key);
        }
    }

    /// A connection reset with `peer` (§11.4, §11.5, §12.3): the queries outstanding with it
    /// are resent at once without changing their stage, and the paused tasks it can serve
    /// are renewed.
    pub(crate) fn reconnected_tasks(&mut self, cx: &mut Cx<'_>, peer: GossipId) {
        let keys: Vec<TaskKey> = self.t.tasks.keys().copied().collect();
        for key in keys {
            let eligible = self.may_receive(&key.chat_id, &peer, false);
            let task = self.t.tasks.get(&key).expect("listed").clone();
            match task.run {
                Run::Active {
                    attempt: Some(Attempt::Sent { peer: p, .. }),
                    ..
                } if p == peer => {
                    // The attempt stays sent with its local deadline: the resend does not
                    // change the stage (§11.4), so a peer whose session resets more often
                    // than the TTL cannot hold the task past it.
                    self.queue_work(
                        peer,
                        Work::Query {
                            purpose: Purpose::Task(key),
                        },
                    );
                }
                Run::Paused if eligible => {
                    let untried = task
                        .candidates
                        .get(&peer)
                        .is_none_or(|c| c.state == CandidateState::Untried);
                    if untried {
                        let t = self.t.tasks.get_mut(&key).expect("listed");
                        t.run = fresh_run(cx.rng);
                        t.runs += 1;
                        self.stats.tasks_renewed += 1;
                    }
                }
                _ => {}
            }
        }
    }

    /// The earliest local deadline, lookup deadline or unblocking time of the tasks.
    pub(crate) fn task_wakeup(&self) -> Option<u64> {
        [
            self.tix.timers.first().map(|(t, _)| *t),
            self.tix.deadlines.first().map(|(t, _)| *t),
            self.tix.next_until(),
        ]
        .into_iter()
        .flatten()
        .min()
    }
}

/// The rank of a candidate, smaller first: tier, unresponsive, inverse score, inverse
/// receipt time of its trigger.
type Rank = (u8, u8, u64, u64);

enum Selection {
    Peer(GossipId),
    Wait(Blocked),
    Exhausted,
}
