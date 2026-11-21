//! Back-pressure from peers that answer `busy` (§13.4, §2.2).
//!
//! `busy` says "not now": it is never a failure. It is no timeout, no sign of being
//! unresponsive, no penalty and no change of score, and it never marks a candidate failed
//! for a task or advances a scan's stage. Instead, per peer:
//!
//! - an **adaptive window**: the lookups this device keeps outstanding with the peer are
//!   halved on each `busy` (down to one) and grow back by one on each other answer, up to
//!   [`ACTIVE_LOOKUPS_PER_PEER`];
//! - an **exponential backoff**: the peer is not asked again before a wait that starts at
//!   [`BUSY_FIRST_WAIT_MS`] and doubles on each `busy` in a row, up to [`BUSY_MAX_WAIT_MS`];
//!   any other answer ends it. Meanwhile tasks go to other candidates.
//!
//! A peer that answers only `busy` forever is thus asked about once per [`BUSY_MAX_WAIT_MS`]
//! for one entry at a time. All of this is local policy.

use super::records::Backoff;
use super::timing::{
    ACTIVE_LOOKUPS_PER_PEER, DAY_MS, FIRST_TTL_MS, HOUR_MS, draw_jitter, jittered,
};
use super::{Cx, Node};
use crate::ids::GossipId;

/// The first wait after `busy`. Local policy.
pub(crate) const BUSY_FIRST_WAIT_MS: u64 = FIRST_TTL_MS;
/// The longest wait after `busy` in a row. Local policy.
pub(crate) const BUSY_MAX_WAIT_MS: u64 = HOUR_MS;
/// A scan whose peer has answered only `busy` for this long ends, without penalty, so that
/// its lane moves on (§12.3). Local policy.
pub(crate) const BUSY_SCAN_GIVE_UP_MS: u64 = DAY_MS;

impl Node {
    /// `peer` answered `busy`: its window halves and its backoff grows. Returns until when
    /// it is not asked again.
    pub(crate) fn busy_from(&mut self, cx: &mut Cx<'_>, peer: &GossipId) -> u64 {
        let jitter = draw_jitter(cx.rng);
        let now = cx.now;
        let mut b = self.t.backoff.get(peer).copied().unwrap_or(Backoff {
            since: now,
            until: 0,
            wait_ms: 0,
            window: ACTIVE_LOOKUPS_PER_PEER as u32,
        });
        if b.wait_ms == 0 {
            b.since = now;
            b.wait_ms = BUSY_FIRST_WAIT_MS;
        } else {
            b.wait_ms = b.wait_ms.saturating_mul(2).min(BUSY_MAX_WAIT_MS);
        }
        b.window = (b.window / 2).max(1);
        b.until = now.saturating_add(jittered(b.wait_ms, jitter));
        self.t.backoff.insert(*peer, b);
        b.until
    }

    /// Any answer of `peer` other than `busy`: its backoff ends and its window grows.
    pub(crate) fn not_busy(&mut self, peer: &GossipId) {
        let Some(mut b) = self.t.backoff.get(peer).copied() else {
            return;
        };
        b.wait_ms = 0;
        b.until = 0;
        b.window = b.window.saturating_add(1);
        if b.window as usize >= ACTIVE_LOOKUPS_PER_PEER {
            self.t.backoff.remove(peer);
        } else {
            self.t.backoff.insert(*peer, b);
        }
    }

    /// Until when `peer` is not asked again after `busy`, if that is later than `now`.
    pub(crate) fn backed_off(&self, peer: &GossipId, now: u64) -> Option<u64> {
        self.t
            .backoff
            .get(peer)
            .map(|b| b.until)
            .filter(|u| *u > now)
    }

    /// Since when `peer` has answered only `busy`, if it is in a streak.
    pub(crate) fn busy_since(&self, peer: &GossipId) -> Option<u64> {
        self.t
            .backoff
            .get(peer)
            .filter(|b| b.wait_ms > 0)
            .map(|b| b.since)
    }
}

/// The lookups this device may keep outstanding with `peer` (its adaptive window).
pub(crate) fn window(table: &super::records::Table<GossipId, Backoff>, peer: &GossipId) -> usize {
    table.get(peer).map_or(ACTIVE_LOOKUPS_PER_PEER, |b| {
        (b.window as usize).clamp(1, ACTIVE_LOOKUPS_PER_PEER)
    })
}
