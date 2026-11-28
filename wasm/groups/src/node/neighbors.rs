//! Neighbors (§10.1): selection and ranking, neighbor requests and responses with
//! suggestions, and replacement of peers that keep failing to answer.

use super::records::{GroupSync, Work};
use super::timing::DAY_MS;
use super::{Cx, Node};
use crate::ids::{ChatId, GossipId};
use crate::rng::{Randomness, uniform_below};
use crate::wire::NeighborResponse;

/// The most neighbors a group seeks: `min(10, memberCount − 1)`.
pub(crate) const MAX_NEIGHBORS: usize = 10;
/// The most suggestions in a declining response, and the most taken from non-neighbors.
pub(crate) const MAX_SUGGESTIONS: usize = 10;
/// See [`MAX_SUGGESTIONS`].
pub(crate) const MAX_NON_NEIGHBOR_SUGGESTIONS: usize = 5;
/// Consecutive unanswered timeouts after which a neighbor may be replaced. §10.1 leaves the
/// threshold to the deferred score (§17.5); provisional.
pub(crate) const NEIGHBOR_FAILURES: u32 = 3;
/// How long those timeouts must span without a valid answer; provisional.
pub(crate) const NEIGHBOR_UNRESPONSIVE_MS: u64 = 2 * DAY_MS;
/// How long a neighbor request may stay unanswered, and how long a peer that declined,
/// did not answer, or was replaced is not asked again. Not given by §10.1; provisional.
pub(crate) const NEIGHBOR_COOLDOWN_MS: u64 = DAY_MS;

impl Node {
    fn group_mut(&mut self, chat: ChatId) -> &mut GroupSync {
        if !self.t.groups.contains(&chat) {
            self.t.groups.insert(chat, GroupSync::default());
        }
        self.t.groups.get_mut(&chat).expect("inserted")
    }

    /// The number of neighbors the group `chat` seeks: `min(10, memberCount − 1)`, where
    /// `memberCount` is that of its current epoch, never counting this device.
    pub(crate) fn neighbor_target(&self, chat: &ChatId) -> usize {
        MAX_NEIGHBORS.min(self.eligible(&self.cur(chat)).len())
    }

    /// Drops the neighbors that are no longer eligible members of the current epoch of the
    /// group `chat` (§10.1).
    pub(crate) fn drop_ineligible_neighbors(&mut self, chat: ChatId) {
        let eligible = self.eligible(&self.cur(&chat));
        let Some(g) = self.t.groups.get(&chat) else {
            return;
        };
        if g.neighbors.iter().all(|n| eligible.contains(n)) {
            return;
        }
        let g = self.group_mut(chat);
        g.neighbors.retain(|n| eligible.contains(n));
    }

    /// Neighbor upkeep: requests unanswered for a day are abandoned, and while the group has
    /// fewer neighbors (and pending requests) than it seeks, the best candidate is asked:
    /// responsive members first, then suggested members, then members with a session (sessions are reused before new
    /// ones are opened), then by score, ties at random.
    pub(crate) fn maintain_neighbors(&mut self, cx: &mut Cx<'_>, chat: ChatId) {
        self.drop_ineligible_neighbors(chat);
        let now = cx.now;
        let target = self.neighbor_target(&chat);
        let eligible = self.eligible(&self.cur(&chat));
        let Some(g) = self.t.groups.get(&chat).cloned() else {
            return;
        };
        let mut g = g;
        let stale: Vec<GossipId> = g
            .asked
            .iter()
            .filter(|(_, at)| now.saturating_sub(**at) >= NEIGHBOR_COOLDOWN_MS)
            .map(|(p, _)| *p)
            .collect();
        for p in &stale {
            g.asked.remove(p);
            g.cooldown
                .insert(*p, now.saturating_add(NEIGHBOR_COOLDOWN_MS));
        }
        g.cooldown.retain(|_, until| *until > now);
        let mut asks = Vec::new();
        while g.neighbors.len() + g.asked.len() < target {
            let pool: Vec<GossipId> = eligible
                .iter()
                .filter(|p| {
                    !g.neighbors.contains(p)
                        && !g.asked.contains_key(p)
                        && !g.cooldown.contains_key(p)
                })
                .copied()
                .collect();
            if pool.is_empty() {
                break;
            }
            let key = |p: &GossipId| {
                (
                    !self.responsive(p),
                    !g.suggested.contains(p),
                    !self.sessions.contains(p),
                    u64::MAX - self.score(p),
                )
            };
            let best = pool.iter().map(key).min().expect("non-empty");
            let ties: Vec<GossipId> = pool.iter().filter(|p| key(p) == best).copied().collect();
            let peer = ties[uniform_below(cx.rng, ties.len())];
            g.asked.insert(peer, now);
            g.suggested.remove(&peer);
            asks.push(peer);
        }
        if g != *self.t.groups.get(&chat).expect("present") {
            self.t.groups.insert(chat, g);
        }
        let current = self.cur(&chat);
        for peer in asks {
            self.queue_work(peer, Work::NeighborRequest { chat_id: current });
        }
    }

    /// Whether the group of `chat` seeks more neighbors and has a candidate it may ask now
    /// (what [`Node::maintain_neighbors`] would ask).
    pub(crate) fn neighbor_candidate_free(&self, chat: &ChatId) -> bool {
        let Some(g) = self.t.groups.get(chat) else {
            return false;
        };
        g.neighbors.len() + g.asked.len() < self.neighbor_target(chat)
            && self.eligible(&self.cur(chat)).iter().any(|p| {
                !g.neighbors.contains(p) && !g.asked.contains_key(p) && !g.cooldown.contains_key(p)
            })
    }

    /// A neighbor request from `from` naming its current epoch `chat` (§10.1, §13.6).
    ///
    /// It must not tell whether this device holds `chat` (D.6). Every request takes one token
    /// of the peer's request budget, as a query entry does, whoever sends it and whatever it
    /// names; without one it gets silence. Then the same decline with no suggestions answers,
    /// by the same path and with no other state kept: an epoch this device does not hold or
    /// holds in an inactive status (left, removed, waiting, dissolved, superseded, an
    /// invitation, a closed marker); an epoch it holds of which `from` is no member; and a
    /// removed peer of it (which is also told of its removal, §5.6, as on any contact). A
    /// peer that shares nothing with this device gets that decline too, as it gets "not
    /// available" for a tips scan (§12.1): answering a stranger is no new signal. A member
    /// asking a device that holds the epoch is accepted while there is capacity, and
    /// otherwise declined with suggestions.
    pub(crate) fn handle_neighbor_request(
        &mut self,
        cx: &mut Cx<'_>,
        from: GossipId,
        chat: ChatId,
    ) {
        if from == self.me || !self.take_request_token(&from, cx.now) {
            dbg_event!(Warn, "engine.event.in", {
                "type" => "neighbor_request", "epoch" => crate::debug::short(&chat),
                "from" => crate::debug::short(&from), "verdict" => "ignored",
                "reason" => if from == self.me { "from_self" } else { "request_budget" },
            });
            return;
        }
        let r_chat = chat;
        let decline = Work::NeighborResponse {
            chat_id: chat,
            accepted: false,
            suggestions: Vec::new(),
        };
        let member = self.epochs.get(&chat).is_some_and(|e| {
            e.root.is_member(&from)
                && matches!(
                    self.group_status(&chat),
                    super::records::GroupStatus::Active
                )
        });
        if !member {
            dbg_event!(Debug, "engine.event.in", {
                "type" => "neighbor_request", "epoch" => crate::debug::short(&chat),
                "from" => crate::debug::short(&from), "verdict" => "answered",
                "reason" => "not_member_or_inactive", "answer" => "declined",
            });
            self.queue_work(from, decline);
            return;
        }
        // A removed peer is no member of a current epoch: told of its removal (§5.6).
        if self.removed_peer(&chat, &from) {
            dbg_event!(Debug, "engine.event.in", {
                "type" => "neighbor_request", "epoch" => crate::debug::short(&chat),
                "from" => crate::debug::short(&from), "verdict" => "answered",
                "reason" => "removed_peer", "answer" => "declined",
            });
            self.removed_contact(cx, chat, from);
            self.queue_work(from, decline);
            return;
        }
        // A former owner naming the parent of its handover as its current epoch is told of
        // the handover (§5.6).
        self.removed_contact(cx, chat, from);
        // The request names the requester's current epoch; the relation is the group's.
        let chat = self.group_of(&chat);
        if !self.may_receive(&self.cur(&chat), &from, false) {
            dbg_event!(Debug, "engine.event.in", {
                "type" => "neighbor_request", "epoch" => crate::debug::short(&r_chat),
                "from" => crate::debug::short(&from), "verdict" => "answered",
                "reason" => "not_member_of_current", "answer" => "declined",
            });
            self.queue_work(
                from,
                Work::NeighborResponse {
                    chat_id: r_chat,
                    accepted: false,
                    suggestions: Vec::new(),
                },
            );
            return;
        }
        let target = self.neighbor_target(&chat);
        let g = self.group_mut(chat);
        let mutual = g.asked.contains_key(&from);
        let accepted =
            g.neighbors.contains(&from) || mutual || g.neighbors.len() + g.asked.len() < target;
        let suggestions = if accepted {
            g.asked.remove(&from);
            g.cooldown.remove(&from);
            self.add_neighbor(cx, chat, from);
            Vec::new()
        } else {
            self.suggestions(cx, chat, from)
        };
        dbg_event!(Debug, "engine.event.in", {
            "type" => "neighbor_request", "epoch" => crate::debug::short(&r_chat),
            "group" => crate::debug::short(&chat), "from" => crate::debug::short(&from),
            "verdict" => "answered", "reason" => if accepted { "capacity" } else { "full" },
            "answer" => if accepted { "accepted" } else { "declined" },
            "suggestions" => suggestions.len(),
        });
        self.queue_work(
            from,
            Work::NeighborResponse {
                chat_id: r_chat,
                accepted,
                suggestions,
            },
        );
    }

    /// A neighbor response from `from` (§13.6). Only a response to a request this device
    /// sent counts: acceptance makes `from` a neighbor; a decline puts it on cooldown and
    /// keeps its suggestions that are eligible members as preferred candidates.
    pub(crate) fn handle_neighbor_response(
        &mut self,
        cx: &mut Cx<'_>,
        from: GossipId,
        r: NeighborResponse,
    ) {
        let epoch = r.chat_id;
        if !self.epochs.contains_key(&epoch) || !self.may_receive(&epoch, &from, false) {
            dbg_event!(Debug, "engine.event.in", {
                "type" => "neighbor_response", "epoch" => crate::debug::short(&epoch),
                "from" => crate::debug::short(&from), "verdict" => "ignored",
                "reason" => if self.epochs.contains_key(&epoch) { "peer_may_not_receive" } else { "unknown_epoch" },
            });
            return;
        }
        let chat = self.group_of(&epoch);
        if !self
            .t
            .groups
            .get(&chat)
            .is_some_and(|g| g.asked.contains_key(&from))
        {
            dbg_event!(Debug, "engine.event.in", {
                "type" => "neighbor_response", "epoch" => crate::debug::short(&epoch),
                "from" => crate::debug::short(&from), "verdict" => "ignored",
                "reason" => "not_asked",
            });
            return;
        }
        dbg_event!(Debug, "engine.event.in", {
            "type" => "neighbor_response", "epoch" => crate::debug::short(&epoch),
            "group" => crate::debug::short(&chat), "from" => crate::debug::short(&from),
            "verdict" => "accepted",
            "reason" => if r.accepted { "neighbor_accepted" } else { "neighbor_declined" },
            "suggestions" => r.suggestions.len(),
        });
        self.answered(&from);
        let eligible = self.eligible(&self.cur(&chat));
        let now = cx.now;
        let g = self.group_mut(chat);
        g.asked.remove(&from);
        if r.accepted {
            self.add_neighbor(cx, chat, from);
        } else {
            g.cooldown
                .insert(from, now.saturating_add(NEIGHBOR_COOLDOWN_MS));
            for s in r.suggestions {
                if eligible.contains(&s) && !g.neighbors.contains(&s) {
                    g.suggested.insert(s);
                }
            }
        }
    }

    /// Adds a neighbor, and adds it among the unvisited peers of the neighbor lanes' cycle
    /// (§12.3).
    fn add_neighbor(&mut self, cx: &mut Cx<'_>, chat: ChatId, peer: GossipId) {
        let g = self.group_mut(chat);
        if g.neighbors.insert(peer) && !g.cycle.contains(&peer) {
            let at = uniform_below(cx.rng, g.cycle.len() + 1);
            g.cycle.insert(at, peer);
        }
    }

    /// Up to ten distinct members of `chat` other than this device and the requester: up to
    /// five non-neighbors first, then neighbors for the remaining places; within each pool
    /// by repeated draws proportional to the score, uniform when every remaining weight is
    /// zero (§10.1).
    fn suggestions(&mut self, cx: &mut Cx<'_>, chat: ChatId, requester: GossipId) -> Vec<GossipId> {
        let eligible = self.eligible(&self.cur(&chat));
        let (neighbors, others): (Vec<GossipId>, Vec<GossipId>) = eligible
            .into_iter()
            .filter(|p| *p != requester)
            .partition(|p| self.is_neighbor(&chat, p));
        let mut out = self.draw_by_score(cx.rng, others, MAX_NON_NEIGHBOR_SUGGESTIONS);
        let rest = MAX_SUGGESTIONS - out.len();
        out.extend(self.draw_by_score(cx.rng, neighbors, rest));
        out
    }

    /// `k` draws without replacement, each proportional to the score of what remains.
    pub(crate) fn draw_by_score(
        &self,
        rng: &mut dyn Randomness,
        mut pool: Vec<GossipId>,
        k: usize,
    ) -> Vec<GossipId> {
        let mut out = Vec::new();
        while out.len() < k && !pool.is_empty() {
            let weights: Vec<u64> = pool.iter().map(|p| self.score(p)).collect();
            let sum: u64 = weights.iter().sum();
            let i = if sum == 0 {
                uniform_below(rng, pool.len())
            } else {
                let mut x = draw_u64(rng, sum);
                let mut i = 0;
                while x >= weights[i] {
                    x -= weights[i];
                    i += 1;
                }
                i
            };
            out.push(pool.swap_remove(i));
        }
        out
    }

    /// The query sent to `peer` at `sent_at` timed out: counted once, however many of its
    /// entries time out and whatever timed out in between; a query sent no later than one
    /// already counted adds nothing (the entries of one query time out at slightly
    /// different instants, each stage having its own jitter).
    pub(crate) fn note_query_timeout(&mut self, peer: &GossipId, sent_at: u64, now: u64) {
        if self
            .t
            .peers
            .get(peer)
            .is_some_and(|r| r.failures > 0 && sent_at <= r.last_timeout_query)
        {
            return;
        }
        self.peer_mut(peer).last_timeout_query = sent_at;
        self.count_timeout(peer, sent_at, now);
    }

    /// A failure of `peer` at `now` that covers no time asked (tests).
    #[cfg(test)]
    pub(crate) fn note_timeout(&mut self, peer: &GossipId, now: u64) {
        self.count_timeout(peer, now, now);
    }

    /// A query to `peer` sent at `sent_at` timed out unanswered at `now`. A peer that keeps
    /// failing, at least [`NEIGHBOR_FAILURES`] timeouts in a row whose queries waited
    /// [`NEIGHBOR_UNRESPONSIVE_MS`] or more in all without any valid answer, is replaced in
    /// every group where it is a neighbor (§10.1). Members are often offline for hours, so a
    /// few timeouts of the first, short TTLs are delays, not failures, and timeouts far
    /// apart say nothing of the time between; any valid answer resets the count. A replaced
    /// neighbor keeps its count, so it stays unresponsive until it answers.
    fn count_timeout(&mut self, peer: &GossipId, sent_at: u64, now: u64) {
        let r = self.peer_mut(peer);
        let from = sent_at.max(r.last_failure);
        r.unanswered_ms = r.unanswered_ms.saturating_add(now.saturating_sub(from));
        r.last_failure = r.last_failure.max(now);
        r.failures = r.failures.saturating_add(1);
        if r.failures < NEIGHBOR_FAILURES || r.unanswered_ms < NEIGHBOR_UNRESPONSIVE_MS {
            return;
        }
        let chats: Vec<ChatId> = self
            .t
            .groups
            .iter()
            .filter(|(_, g)| g.neighbors.contains(peer))
            .map(|(c, _)| *c)
            .collect();
        for chat in chats {
            let g = self.group_mut(chat);
            g.neighbors.remove(peer);
            g.cooldown
                .insert(*peer, now.saturating_add(NEIGHBOR_COOLDOWN_MS));
            self.stats.neighbors_replaced += 1;
            dbg_event!(Info, "engine.neighbor.replaced", { "reason" => "unanswered" });
        }
    }
}

/// A uniform value in `0..n`, `n > 0`, without modulo bias.
pub(crate) fn draw_u64(rng: &mut dyn Randomness, n: u64) -> u64 {
    let zone = u64::MAX - (u64::MAX % n);
    loop {
        let v = u64::from_le_bytes(crate::rng::bytes::<8>(rng));
        if v < zone {
            return v % n;
        }
    }
}
