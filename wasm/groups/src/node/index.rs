//! An in-memory index of the retrieval tasks, derived from their records, so that the
//! scheduling pass and the timers touch only the tasks that may move: the ready ones, the
//! ones whose local wait or deadline is due, and the ones a freed slot or an expired request
//! unblocks. Up to 65,536 missing IDs per group may be queued (§17.4); a pass over all of
//! them at every operation would not be bounded work.

use std::collections::{BTreeMap, BTreeSet};

use super::records::{Attempt, Run, Task, TaskKey};
use crate::ids::GossipId;

/// Why a task waits: every candidate left is at its lookup limit (`peers`) or has a request
/// outstanding until before `until`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Blocked {
    pub(crate) peers: Vec<GossipId>,
    pub(crate) until: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Slot {
    /// Active without an attempt.
    Idle,
    /// Active with an attempt to `peer`; `local` is its local deadline once sent; `suspect`
    /// when the task has no credible trigger.
    Busy {
        peer: GossipId,
        local: Option<u64>,
        suspect: bool,
    },
    /// Paused.
    Paused,
}

fn slot_of(task: &Task, prio: u64) -> Slot {
    match task.run {
        Run::Active { attempt: None, .. } => Slot::Idle,
        Run::Active {
            attempt: Some(a), ..
        } => Slot::Busy {
            peer: a.peer(),
            local: match a {
                Attempt::Sent { local_deadline, .. } => Some(local_deadline),
                Attempt::Queued { .. } => None,
            },
            suspect: prio < CREDIBLE,
        },
        Run::Paused => Slot::Paused,
    }
}

/// The priority from which a task is credible: one of its untried triggering candidates
/// scores at least as an unmeasured peer and was not asked in vain twice already.
pub(crate) const CREDIBLE: u64 = 500_000;

fn dec(map: &mut BTreeMap<GossipId, usize>, peer: &GossipId) {
    if let Some(n) = map.get_mut(peer) {
        *n -= 1;
        if *n == 0 {
            map.remove(peer);
        }
    }
}

#[derive(Debug, Default)]
pub(crate) struct TaskIndex {
    slot: BTreeMap<TaskKey, Slot>,
    /// The priority of each task when last updated (higher first).
    prio: BTreeMap<TaskKey, u64>,
    /// Idle tasks to rank at the next pass, highest priority first.
    ready: BTreeSet<(core::cmp::Reverse<u64>, TaskKey)>,
    /// Attempts per peer, and in total.
    pub(crate) load: BTreeMap<GossipId, usize>,
    pub(crate) total: usize,
    /// The same for the attempts of suspect tasks.
    pub(crate) suspect_load: BTreeMap<GossipId, usize>,
    pub(crate) suspect_total: usize,
    blocked: BTreeMap<TaskKey, Blocked>,
    by_peer: BTreeMap<GossipId, BTreeSet<TaskKey>>,
    until: BTreeSet<(u64, TaskKey)>,
    /// Local deadlines of sent attempts.
    pub(crate) timers: BTreeSet<(u64, TaskKey)>,
    /// Lookup deadlines of event tasks, and by task.
    pub(crate) deadlines: BTreeSet<(u64, TaskKey)>,
    deadline_of: BTreeMap<TaskKey, u64>,
}

impl TaskIndex {
    pub(crate) fn clear(&mut self) {
        *self = Self::default();
    }

    fn set_ready(&mut self, key: TaskKey) {
        let p = self.prio.get(&key).copied().unwrap_or(0);
        self.ready.insert((core::cmp::Reverse(p), key));
    }

    fn unset_ready(&mut self, key: &TaskKey) {
        let p = self.prio.get(key).copied().unwrap_or(0);
        self.ready.remove(&(core::cmp::Reverse(p), *key));
    }

    /// The ready tasks, highest priority first.
    pub(crate) fn ready(&self) -> impl Iterator<Item = TaskKey> + '_ {
        self.ready.iter().map(|(_, k)| *k)
    }

    /// Whether no task is ready.
    pub(crate) fn none_ready(&self) -> bool {
        self.ready.is_empty()
    }

    /// Brings the entries of `key` up to date with `task` (`None` once removed), with its
    /// scheduling priority. An idle task becomes ready again: whatever changed may unblock
    /// it.
    pub(crate) fn update(&mut self, key: TaskKey, task: Option<&Task>, prio: u64) {
        let new = task.map(|t| slot_of(t, prio));
        let old = self.slot.remove(&key);
        self.unblock(&key);
        match old {
            Some(Slot::Idle) => {
                self.unset_ready(&key);
            }
            Some(Slot::Busy {
                peer,
                local,
                suspect,
            }) => {
                if let Some(l) = local {
                    self.timers.remove(&(l, key));
                }
                dec(&mut self.load, &peer);
                self.total -= 1;
                if suspect {
                    dec(&mut self.suspect_load, &peer);
                    self.suspect_total -= 1;
                }
            }
            Some(Slot::Paused) | None => {}
        }
        if new.is_none()
            && let Some(d) = self.deadline_of.remove(&key)
        {
            self.deadlines.remove(&(d, key));
        }
        let Some(new) = new else {
            self.prio.remove(&key);
            return;
        };
        self.prio.insert(key, prio);
        if !self.deadline_of.contains_key(&key)
            && let Some(d) = task.and_then(|t| t.deadline(&key))
        {
            self.deadline_of.insert(key, d);
            self.deadlines.insert((d, key));
        }
        match new {
            Slot::Idle => self.set_ready(key),
            Slot::Busy {
                peer,
                local,
                suspect,
            } => {
                *self.load.entry(peer).or_default() += 1;
                self.total += 1;
                if suspect {
                    *self.suspect_load.entry(peer).or_default() += 1;
                    self.suspect_total += 1;
                }
                if let Some(l) = local {
                    self.timers.insert((l, key));
                }
            }
            Slot::Paused => {}
        }
        self.slot.insert(key, new);
    }

    /// Records that `key` waits for `b`.
    pub(crate) fn block(&mut self, key: TaskKey, b: Blocked) {
        self.unset_ready(&key);
        for p in &b.peers {
            self.by_peer.entry(*p).or_default().insert(key);
        }
        if b.until != u64::MAX {
            self.until.insert((b.until, key));
        }
        self.blocked.insert(key, b);
    }

    fn unblock(&mut self, key: &TaskKey) -> bool {
        let Some(b) = self.blocked.remove(key) else {
            return false;
        };
        for p in &b.peers {
            if let Some(set) = self.by_peer.get_mut(p) {
                set.remove(key);
                if set.is_empty() {
                    self.by_peer.remove(p);
                }
            }
        }
        self.until.remove(&(b.until, *key));
        true
    }

    /// Makes ready, for each peer below `limit` lookups, as many of the tasks blocked on it
    /// as it has free slots (oldest IDs first): only that many can use them, and waking
    /// every task blocked on a busy peer at each freed slot would rank thousands of tasks
    /// for one lookup.
    pub(crate) fn wake_free(&mut self, limit: usize) {
        let mut woken = Vec::new();
        for (peer, set) in &self.by_peer {
            let free = limit.saturating_sub(self.load.get(peer).copied().unwrap_or(0));
            woken.extend(set.iter().take(free).copied());
        }
        for key in woken {
            if self.unblock(&key) && self.slot.get(&key) == Some(&Slot::Idle) {
                self.set_ready(key);
            }
        }
    }

    /// Makes ready the blocked tasks whose outstanding requests have expired by `now`.
    pub(crate) fn wake_until(&mut self, now: u64) {
        while let Some(&(at, key)) = self.until.first() {
            if at > now {
                break;
            }
            self.until.pop_first();
            if self.unblock(&key) && self.slot.get(&key) == Some(&Slot::Idle) {
                self.set_ready(key);
            }
        }
    }

    /// The earliest instant at which a blocked task may move by time alone.
    pub(crate) fn next_until(&self) -> Option<u64> {
        self.until.first().map(|(t, _)| *t)
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use super::*;
    use crate::ids::{ChatId, EventId};
    use crate::node::records::Target;

    fn key(n: u8) -> TaskKey {
        TaskKey {
            chat_id: ChatId::from_bytes([1; 32]),
            target: Target::Event(EventId::new(1_000, [n; 16])),
        }
    }

    fn task(attempt: Option<Attempt>) -> Task {
        Task {
            run: Run::Active {
                stage: 0,
                ttl: 1,
                jitter: 1_000_000,
                attempt,
                expired_resends: 0,
            },
            candidates: BTreeMap::new(),
            runs: 1,
            created_at: 0,
        }
    }

    #[test]
    fn a_freed_slot_or_an_expiry_wakes_the_tasks_blocked_on_it() {
        let p = GossipId::from_bytes([7; 32]);
        let mut ix = TaskIndex::default();
        ix.update(
            key(1),
            Some(&task(Some(Attempt::Sent {
                peer: p,
                local_deadline: 50,
            }))),
            0,
        );
        ix.update(key(2), Some(&task(None)), 0);
        ix.update(key(3), Some(&task(None)), 0);
        assert_eq!((ix.total, ix.load[&p], ix.ready().count()), (1, 1, 2));
        assert_eq!(ix.timers.first(), Some(&(50, key(1))));
        assert_eq!(ix.deadlines.len(), 3);
        ix.block(
            key(2),
            Blocked {
                peers: vec![p],
                until: u64::MAX,
            },
        );
        ix.block(
            key(3),
            Blocked {
                peers: vec![],
                until: 100,
            },
        );
        assert!(ix.none_ready());
        // The attempt ends: key 2 is ready again once slots are woken.
        ix.update(key(1), Some(&task(None)), 0);
        assert!(!ix.ready().any(|k| k == key(2)) && ix.ready().any(|k| k == key(1)));
        ix.wake_free(1);
        assert!(ix.ready().any(|k| k == key(2)));
        assert_eq!(ix.total, 0);
        ix.wake_until(99);
        assert!(!ix.ready().any(|k| k == key(3)));
        ix.wake_until(100);
        assert!(ix.ready().any(|k| k == key(3)));
        ix.update(key(1), None, 0);
        assert_eq!(ix.deadlines.len(), 2);
    }
}
