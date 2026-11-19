//! Peer-knowledge hints (§10.3): a device marks an event, and a bounded sample of its
//! ancestors, as seen by a peer, and skips notices of those events to that peer.
//!
//! Hints only suppress notices: they never set processed or validity, never cancel
//! retrieval, and never stop a query from being answered.

use super::records::{Hint, HintKey};
use super::timing::{HINT_CAPACITY, HINT_EXPIRY_MS};
use super::{Cx, Node, NodeError};
use crate::ids::{ChatId, EventId, GossipId};
use crate::rng::uniform_below;

/// The entry of a hint in the least-recently-used index: group first, so that the oldest
/// hint of a group is the first entry of its range.
pub(crate) type LruKey = (ChatId, u64, GossipId, EventId);

pub(crate) fn lru(used: u64, (chat, peer, id): HintKey) -> LruKey {
    (chat, used, peer, id)
}

/// Samples per level of the ancestor walk: at most 31 ancestors, 32 updates with E.
pub(crate) const ANCESTOR_SAMPLES: [usize; 5] = [16, 8, 4, 2, 1];

impl Node {
    /// Marks `id` and a sample of its locally known ancestors as seen by `peer`: from E,
    /// walk the validated parent links at most five levels; at each level, build the pool
    /// of the known parents of the previous level's selected nodes and sample up to 16, 8,
    /// 4, 2 and 1 of them without replacement.
    ///
    /// The walk examines at most 496 parent references, taken from the traversal budget of
    /// the turn (§17.4); when the budget runs out the walk stops early, which only makes the
    /// hint less complete.
    pub(crate) fn mark_seen(
        &mut self,
        cx: &mut Cx<'_>,
        chat: ChatId,
        peer: GossipId,
        id: EventId,
    ) -> Result<(), NodeError> {
        self.put_hint(chat, peer, id, cx.now);
        let mut level = vec![id];
        for k in ANCESTOR_SAMPLES {
            let mut pool: Vec<EventId> = Vec::new();
            for node in &level {
                let Some(parents) = cx.ov.parents(&chat, node)? else {
                    continue;
                };
                if parents.len() > cx.edges {
                    cx.edges = 0;
                    break;
                }
                cx.edges -= parents.len();
                for p in parents {
                    // Only parents whose own links are known (processed) are walked.
                    if !pool.contains(&p) && cx.ov.parents(&chat, &p)?.is_some() {
                        pool.push(p);
                    }
                }
            }
            if pool.is_empty() {
                break;
            }
            pool.sort_unstable();
            let n = k.min(pool.len());
            for i in 0..n {
                let j = i + uniform_below(cx.rng, pool.len() - i);
                pool.swap(i, j);
            }
            pool.truncate(n);
            for a in &pool {
                self.put_hint(chat, peer, *a, cx.now);
            }
            level = pool;
        }
        Ok(())
    }

    /// Records one hint. A new hint expires 28 days after now; an existing one keeps its
    /// first time and only becomes the most recently used. Beyond 65,536 hints in the
    /// group, the least recently used one is evicted.
    pub(crate) fn put_hint(&mut self, chat: ChatId, peer: GossipId, id: EventId, now: u64) {
        if peer == self.me {
            return;
        }
        let key: HintKey = (chat, peer, id);
        let hint = match self.t.hints.get(&key) {
            Some(h) => {
                self.hint_lru.remove(&lru(h.used, key));
                Hint {
                    first: h.first,
                    used: now.max(h.used),
                }
            }
            None => {
                self.evict_hints(chat);
                self.hint_age.insert((now, key));
                *self.hint_count.entry(chat).or_default() += 1;
                Hint {
                    first: now,
                    used: now,
                }
            }
        };
        self.hint_lru.insert(lru(hint.used, key));
        self.t.hints.insert(key, hint);
    }

    fn evict_hints(&mut self, chat: ChatId) {
        let lowest = lru(
            0,
            (
                chat,
                GossipId::from_bytes([0; 32]),
                EventId::from_bytes([0; 24]),
            ),
        );
        let in_group = self.hint_count.get(&chat).copied().unwrap_or(0);
        if in_group < HINT_CAPACITY {
            return;
        }
        let victim = self
            .hint_lru
            .range(lowest..)
            .next()
            .filter(|l| l.0 == chat)
            .map(|l| (l.0, l.2, l.3));
        if let Some(k) = victim {
            self.remove_hint(&k);
        }
    }

    pub(crate) fn remove_hint(&mut self, key: &HintKey) {
        if let Some(h) = self.t.hints.remove(key) {
            self.hint_lru.remove(&lru(h.used, *key));
            self.hint_age.remove(&(h.first, *key));
            if let Some(c) = self.hint_count.get_mut(&key.0) {
                *c = c.saturating_sub(1);
            }
        }
    }

    /// Whether `peer` is known to have seen `id`; a hit counts as a use.
    pub(crate) fn has_hint(&mut self, chat: ChatId, peer: GossipId, id: EventId, now: u64) -> bool {
        let key = (chat, peer, id);
        let Some(h) = self.t.hints.get(&key).copied() else {
            return false;
        };
        if u128::from(now) >= u128::from(h.first) + u128::from(HINT_EXPIRY_MS) {
            self.remove_hint(&key);
            return false;
        }
        if h.used < now {
            self.hint_lru.remove(&lru(h.used, key));
            self.hint_lru.insert(lru(now, key));
            self.t.hints.insert(key, Hint { used: now, ..h });
        }
        true
    }

    /// Removes the hints recorded 28 days or more before `now`.
    pub(crate) fn expire_hints(&mut self, now: u64) {
        let Some(limit) = now.checked_sub(HINT_EXPIRY_MS) else {
            return;
        };
        let expired: Vec<HintKey> = self
            .hint_age
            .iter()
            .take_while(|(first, _)| *first <= limit)
            .map(|(_, k)| *k)
            .collect();
        for k in expired {
            self.remove_hint(&k);
        }
    }

    /// The earliest hint expiry.
    pub(crate) fn next_hint_expiry(&self) -> Option<u64> {
        self.hint_age
            .first()
            .map(|(first, _)| first.saturating_add(HINT_EXPIRY_MS))
    }
}
