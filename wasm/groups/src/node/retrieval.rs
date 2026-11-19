//! Retrieval tasks (§11): one task per missing `(chat_id, eventId)`, shared by every
//! reference and notice, and one per sync-object lookup (§12.5). Candidates are asked one
//! at a time, never broadcast, in 20-stage runs with growing TTLs; a run pauses and is
//! renewed by new evidence; an event task ends at its lookup deadline.

use std::collections::BTreeMap;

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

/// Resends caused by `expired` within one stage. §11.4 sets no bound; without one a peer
/// that always answers `expired` would make the requester resend forever at no cost to the
/// stage progression.
pub(crate) const MAX_EXPIRED_RESENDS: u8 = 2;

/// How an answer counts for its task.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Answer {
    /// A full event that validates (whatever its merge), or the matching sync object.
    Supplied,
    /// `not_available`.
    NotAvailable,
    /// Malformed, wrong ID, failed secret proof (§11.4): penalised.
    Invalid,
    /// `busy` or `malformed`: failed for this pass, not penalised.
    Refused,
    /// `expired`: an immediate resend (§11.4).
    Expired,
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

/// The deadline of a task: `ts + RETENTION` for an event (§11.6), none for a sync object.
fn past_deadline(key: &TaskKey, now: u64) -> bool {
    match key.target {
        Target::Event(id) => !in_window(&id, now),
        Target::SyncObj(_) => false,
    }
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
            if self.tasks_full(&key.chat_id) {
                self.stats.backpressure += 1;
                return;
            }
            self.t.tasks.insert(
                key,
                Task {
                    run: fresh_run(cx.rng),
                    candidates: BTreeMap::new(),
                    runs: 1,
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
        if answer != Answer::Expired {
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
            Answer::Expired => {
                if let Run::Active {
                    attempt: attempt @ Some(Attempt::Sent { .. }),
                    expired_resends,
                    ..
                } = &mut task.run
                    && current
                    && *expired_resends < MAX_EXPIRED_RESENDS
                {
                    *expired_resends += 1;
                    *attempt = Some(Attempt::Queued { peer });
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
        let mut load: BTreeMap<GossipId, usize> = BTreeMap::new();
        let mut waiting: Vec<(u64, TaskKey)> = Vec::new();
        for (key, task) in self.t.tasks.iter() {
            match task.run {
                Run::Active {
                    attempt: Some(a), ..
                } => *load.entry(a.peer()).or_default() += 1,
                Run::Active { attempt: None, .. } => {
                    let best = task
                        .candidates
                        .iter()
                        .filter(|(_, c)| c.trigger.is_some() && c.state == CandidateState::Untried)
                        .map(|(p, _)| self.score(p))
                        .max()
                        .unwrap_or(0);
                    waiting.push((best, *key));
                }
                Run::Paused => {}
            }
        }
        let mut total: usize = load.values().sum();
        // Tasks whose best triggering peer scores higher go first.
        waiting.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(&b.1)));
        for (_, key) in waiting {
            if total >= ACTIVE_LOOKUPS_PER_DEVICE {
                break;
            }
            if past_deadline(&key, cx.now) {
                continue;
            }
            match self.select(cx, &key, &load) {
                Selection::Peer(peer) => {
                    let task = self.t.tasks.get_mut(&key).expect("listed");
                    if let Run::Active { attempt, .. } = &mut task.run {
                        *attempt = Some(Attempt::Queued { peer });
                    }
                    *load.entry(peer).or_default() += 1;
                    total += 1;
                    self.queue_work(
                        peer,
                        Work::Query {
                            purpose: Purpose::Task(key),
                        },
                    );
                }
                Selection::Wait => {}
                Selection::Exhausted => self.pause(key),
            }
        }
        Ok(())
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
    /// skipped. When the best candidate already has 16 lookups outstanding the task waits
    /// for it rather than asking a lower-ranked peer.
    fn select(
        &mut self,
        cx: &mut Cx<'_>,
        key: &TaskKey,
        load: &BTreeMap<GossipId, usize>,
    ) -> Selection {
        let task = self.t.tasks.get(key).expect("listed");
        let mut ranked: Vec<((u8, u64, u64), GossipId, bool)> = Vec::new();
        let mut outstanding = false;
        for peer in self.eligible(&key.chat_id) {
            let c = task
                .candidates
                .get(&peer)
                .copied()
                .unwrap_or_else(Candidate::new);
            if c.state != CandidateState::Untried {
                continue;
            }
            if c.outstanding_until.is_some_and(|u| u >= cx.now) {
                outstanding = true;
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
                (tier, u64::MAX - self.score(&peer), u64::MAX - at),
                peer,
                limited,
            ));
        }
        let Some(best) = ranked.iter().map(|(k, _, _)| *k).min() else {
            return if outstanding {
                Selection::Wait
            } else {
                Selection::Exhausted
            };
        };
        let ties: Vec<GossipId> = ranked
            .iter()
            .filter(|(k, _, limited)| *k == best && !limited)
            .map(|(_, p, _)| *p)
            .collect();
        if ties.is_empty() {
            return Selection::Wait;
        }
        Selection::Peer(ties[uniform_below(cx.rng, ties.len())])
    }

    /// The query of `key` was handed off to `peer` at `sent_at` with `ttl`: the stage's
    /// local wait starts, and the peer is outstanding until the request's deadline.
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

    /// The query entry to send for `key`, with its TTL, if the task still wants `peer`.
    pub(crate) fn task_query(&self, key: &TaskKey, peer: &GossipId) -> Option<u64> {
        match self.t.tasks.get(key)?.run {
            Run::Active {
                attempt: Some(Attempt::Queued { peer: p }),
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
        let keys: Vec<TaskKey> = self.t.tasks.keys().copied().collect();
        for key in keys {
            if past_deadline(&key, cx.now) {
                self.t.tasks.remove(&key);
                self.stats.tasks_expired += 1;
                continue;
            }
            let task = self.t.tasks.get(&key).expect("listed");
            let Run::Active {
                stage,
                ttl,
                attempt:
                    Some(Attempt::Sent {
                        peer,
                        local_deadline,
                    }),
                ..
            } = task.run
            else {
                continue;
            };
            if local_deadline > cx.now {
                continue;
            }
            // An unanswered timeout: the next stage, with the next TTL and a new jitter,
            // and at once the next candidate (no extra backoff).
            self.stats.timeouts += 1;
            self.note_timeout(&peer);
            let stage = stage + 1;
            if stage >= MAX_UNANSWERED_STAGES {
                self.pause(key);
                continue;
            }
            let jitter = draw_jitter(cx.rng);
            let task = self.t.tasks.get_mut(&key).expect("listed");
            task.run = Run::Active {
                stage,
                ttl: next_ttl(ttl),
                jitter,
                attempt: None,
                expired_resends: 0,
            };
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
                    let t = self.t.tasks.get_mut(&key).expect("listed");
                    if let Run::Active { attempt, .. } = &mut t.run {
                        *attempt = Some(Attempt::Queued { peer });
                    }
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

    /// The earliest local deadline or lookup deadline of the tasks.
    pub(crate) fn task_wakeup(&self) -> Option<u64> {
        self.t
            .tasks
            .iter()
            .filter_map(|(k, t)| {
                let local = match t.run {
                    Run::Active {
                        attempt: Some(Attempt::Sent { local_deadline, .. }),
                        ..
                    } => Some(local_deadline),
                    _ => None,
                };
                let deadline = match k.target {
                    Target::Event(id) => {
                        Some(u64::try_from(crate::store::window_end(&id)).unwrap_or(u64::MAX))
                    }
                    Target::SyncObj(_) => None,
                };
                match (local, deadline) {
                    (Some(a), Some(b)) => Some(a.min(b)),
                    (a, b) => a.or(b),
                }
            })
            .min()
    }
}

enum Selection {
    Peer(GossipId),
    Wait,
    Exhausted,
}
