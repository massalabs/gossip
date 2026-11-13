//! Anti-entropy synchronisation: on connection (and periodically with high-trust
//! peers) a node asks its peer for the ids of the blobs created since a point in
//! time, page by page, and feeds them to the announcement machinery.
//!
//! Wire ids are ordered by `(expires_at, id)` on the responder; `since` and the
//! cursor time travel on the wire as `created_at` values (`expires_at - retention`),
//! so both sides only need their own retention to convert.
//!
//! A responder may drop a page request (its egress budget for us is exhausted), so a
//! request left unanswered for [`SYNC_REQUEST_TIMEOUT`] is abandoned and retried with
//! exponential backoff, resuming from the last cursor. Our own requests are paced per
//! peer (token bucket) so that honest nodes stay within each other's budgets.

use std::collections::HashMap;
use std::time::{Duration, Instant};

use gossip_wire::{BlobMessage, PeerId, Scope, SyncCursor, UnixMillis};
use rand::seq::SliceRandom;

use crate::store::BlobStore;

/// A page request left unanswered for this long is abandoned and retried later.
pub const SYNC_REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
/// Longest delay between two retries of an unanswered page request.
const MAX_SYNC_RETRY_DELAY: Duration = Duration::from_secs(5 * 60);
/// Unanswered retries of the same page before the sync with that peer is abandoned
/// (the hourly resync starts a new one).
const MAX_SYNC_RETRIES: u32 = 8;
/// A completed sync moves `high_water` up; the next initial sync starts this much
/// before it to absorb clock skew and in-flight blobs.
const HIGH_WATER_BACKOFF_MS: u64 = 60 * 60 * 1000;
/// Window of the periodic resync.
const RESYNC_WINDOW_MS: u64 = 2 * 60 * 60 * 1000;
/// Peers resynchronised with at every period.
pub const RESYNC_PEERS: usize = 2;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Phase {
    /// A page request is due at that instant (subject to pacing).
    Due(Instant),
    /// A page request was sent at that instant and is not answered yet.
    InFlight(Instant),
    /// No sync running with that peer (completed or abandoned).
    Done,
}

struct PeerSync {
    since: UnixMillis,
    started_at: UnixMillis,
    cursor: Option<SyncCursor>,
    phase: Phase,
    retries: u32,
    pace_tokens: f64,
    pace_last: Instant,
    /// `SyncRequest.max` this peer accepts (never above our own page size).
    page_size: usize,
    /// Requests per minute this peer answers for us (infinite: no pacing).
    pace_per_min: f64,
}

/// Bucket capacity for a pace: one minute's worth of requests, or unbounded.
fn pace_cap_of(pace_per_min: f64) -> f64 {
    if pace_per_min.is_finite() {
        pace_per_min
    } else {
        f64::MAX
    }
}

/// Per-peer sync state.
pub struct SyncState {
    per_peer: HashMap<PeerId, PeerSync>,
    /// Wall-clock time of the last completed sync (0 if none).
    pub high_water: UnixMillis,
    page_size: usize,
    retention_ms: u64,
    /// Page requests per minute we send to one peer (infinite: no pacing).
    pace_per_min: f64,
    timeout: Duration,
}

impl SyncState {
    /// Creates the state (no pacing, [`SYNC_REQUEST_TIMEOUT`]).
    pub fn new(page_size: usize, retention_ms: u64) -> Self {
        Self {
            per_peer: HashMap::new(),
            high_water: UnixMillis(0),
            page_size: page_size.max(1),
            retention_ms,
            pace_per_min: f64::INFINITY,
            timeout: SYNC_REQUEST_TIMEOUT,
        }
    }

    /// Paces our page requests to at most `requests_per_min` per peer.
    pub fn with_pacing(mut self, requests_per_min: f64) -> Self {
        self.pace_per_min = requests_per_min.max(f64::MIN_POSITIVE);
        self
    }

    /// The pace used for a peer that advertised none (infinite when unpaced).
    pub fn default_pace(&self) -> f64 {
        self.pace_per_min
    }

    /// Overrides the unanswered-request timeout.
    #[cfg(test)]
    pub fn with_timeout(mut self, timeout: Duration) -> Self {
        self.timeout = timeout;
        self
    }

    /// `since` of the sync started when a peer connects:
    /// `max(now - retention, high_water - 1h)`.
    pub fn initial_since(&self, now: UnixMillis) -> UnixMillis {
        now.saturating_sub(self.retention_ms)
            .max(self.high_water.saturating_sub(HIGH_WATER_BACKOFF_MS))
    }

    /// `since` of a periodic resync: `now - 2h`.
    pub fn resync_since(&self, now: UnixMillis) -> UnixMillis {
        now.saturating_sub(RESYNC_WINDOW_MS)
    }

    /// Whether a page request to `peer` is pending an answer.
    #[cfg(test)]
    pub fn is_in_flight(&self, peer: &PeerId) -> bool {
        matches!(
            self.per_peer.get(peer).map(|s| s.phase),
            Some(Phase::InFlight(_))
        )
    }

    /// Whether we ever started a sync with `peer` since it connected (a `SyncIds` from
    /// any other peer is unsolicited).
    pub fn has_synced_with(&self, peer: &PeerId) -> bool {
        self.per_peer.contains_key(peer)
    }

    /// Starts a sync with `peer` from `since`; `false` when one is already running.
    /// The first request goes out at the next [`Self::poll`]. Page size and pace are
    /// this state's defaults; the node itself always goes through
    /// [`Self::start_within`] with the peer's advertised ones.
    #[cfg(test)]
    pub fn start(&mut self, peer: PeerId, since: UnixMillis, now: UnixMillis) -> bool {
        self.start_within(peer, since, now, self.page_size, self.pace_per_min)
    }

    /// [`Self::start`] bounded by what the peer said it accepts: pages of at most
    /// `page_size` ids (clamped to ours) at `pace_per_min` requests a minute.
    pub fn start_within(
        &mut self,
        peer: PeerId,
        since: UnixMillis,
        now: UnixMillis,
        page_size: usize,
        pace_per_min: f64,
    ) -> bool {
        let page_size = page_size.clamp(1, self.page_size);
        let pace_per_min = if pace_per_min.is_finite() {
            pace_per_min.max(f64::MIN_POSITIVE)
        } else {
            self.pace_per_min
        };
        let pace_cap = pace_cap_of(pace_per_min);
        let instant = Instant::now();
        match self.per_peer.get_mut(&peer) {
            Some(state) if state.phase != Phase::Done => false,
            Some(state) => {
                state.since = since;
                state.started_at = now;
                state.cursor = None;
                state.phase = Phase::Due(instant);
                state.retries = 0;
                state.page_size = page_size;
                state.pace_per_min = pace_per_min;
                state.pace_tokens = state.pace_tokens.min(pace_cap);
                true
            }
            None => {
                self.per_peer.insert(
                    peer,
                    PeerSync {
                        since,
                        started_at: now,
                        cursor: None,
                        phase: Phase::Due(instant),
                        retries: 0,
                        pace_tokens: pace_cap,
                        pace_last: instant,
                        page_size,
                        pace_per_min,
                    },
                );
                true
            }
        }
    }

    /// A page arrived from `peer`. Returns `false` when no sync is running with it (a
    /// duplicate or late answer, or an unsolicited one). Otherwise the next page, if
    /// any, becomes due.
    pub fn on_page(&mut self, peer: &PeerId, next: Option<SyncCursor>) -> bool {
        let Some(state) = self.per_peer.get_mut(peer) else {
            return false;
        };
        if state.phase == Phase::Done {
            return false;
        }
        state.retries = 0;
        match next {
            Some(cursor) => {
                state.cursor = Some(cursor);
                state.phase = Phase::Due(Instant::now());
            }
            None => {
                state.phase = Phase::Done;
                self.high_water = self.high_water.max(state.started_at);
            }
        }
        true
    }

    /// Page requests to send now: times out unanswered requests (scheduling their
    /// retry with backoff) and emits the due requests allowed by each peer's pacing.
    pub fn poll(&mut self) -> Vec<(PeerId, BlobMessage)> {
        let now = Instant::now();
        let timeout = self.timeout;
        let mut out = Vec::new();
        for (peer, state) in self.per_peer.iter_mut() {
            let (pace, page_size) = (state.pace_per_min, state.page_size);
            let pace_cap = pace_cap_of(pace);
            if let Phase::InFlight(sent) = state.phase {
                if now.saturating_duration_since(sent) > timeout {
                    state.retries += 1;
                    if state.retries > MAX_SYNC_RETRIES {
                        state.phase = Phase::Done;
                        continue;
                    }
                    let backoff = timeout
                        .saturating_mul(1u32 << (state.retries - 1).min(16))
                        .min(MAX_SYNC_RETRY_DELAY);
                    state.phase = Phase::Due(now + backoff);
                }
            }
            let Phase::Due(at) = state.phase else {
                continue;
            };
            if at > now {
                continue;
            }
            if pace.is_finite() {
                let elapsed = now.saturating_duration_since(state.pace_last).as_secs_f64();
                state.pace_last = now;
                state.pace_tokens = (state.pace_tokens + elapsed * pace / 60.0).min(pace_cap);
                // a bucket smaller than one token still allows a request when full
                let needed = pace_cap.min(1.0);
                if state.pace_tokens < needed {
                    let wait = (needed - state.pace_tokens) * 60.0 / pace;
                    state.phase = Phase::Due(now + Duration::from_secs_f64(wait));
                    continue;
                }
                state.pace_tokens -= 1.0;
            }
            state.phase = Phase::InFlight(now);
            out.push((
                *peer,
                BlobMessage::SyncRequest {
                    since: state.since,
                    cursor: state.cursor,
                    max: page_size as u32,
                },
            ));
        }
        out
    }

    /// Builds the reply to a `SyncRequest`.
    pub fn reply(
        &self,
        store: &dyn BlobStore,
        since: UnixMillis,
        cursor: Option<SyncCursor>,
        max: u32,
    ) -> BlobMessage {
        self.reply_in(store, None, since, cursor, max)
    }

    /// [`SyncState::reply`] listing only blobs of `scope` (a mesh node answering one
    /// of its links). Mesh listings convert times with the mesh retention: blobs that
    /// also have the internet scope expire later and are listed generously, never
    /// missed.
    pub fn reply_in(
        &self,
        store: &dyn BlobStore,
        scope: Option<Scope>,
        since: UnixMillis,
        cursor: Option<SyncCursor>,
        max: u32,
    ) -> BlobMessage {
        let retention = match scope {
            Some(scope) => store.retention_ms_for(scope),
            None => store.retention_ms(),
        };
        let max = (max as usize).min(self.page_size);
        let from_expires_at = since.as_millis().saturating_add(retention);
        let cursor = cursor.map(|(t, id)| (t.as_millis().saturating_add(retention), id));
        let (ids, next) = match scope {
            Some(scope) => store.ids_by_expiry_in(scope, from_expires_at, cursor, max),
            None => store.ids_by_expiry(from_expires_at, cursor, max),
        };
        BlobMessage::SyncIds {
            ids,
            next: next.map(|(e, id)| (UnixMillis(e.saturating_sub(retention)), id)),
        }
    }

    /// Forgets a peer.
    pub fn remove(&mut self, peer: &PeerId) {
        self.per_peer.remove(peer);
    }

    /// Picks up to `n` peers for a resync among the most trusted ones: the top
    /// `2 × n` by trust, then `n` at random among them.
    pub fn pick_resync_peers(&self, peers: &[(PeerId, f64)], n: usize) -> Vec<PeerId> {
        let mut sorted: Vec<(PeerId, f64)> = peers.to_vec();
        sorted.sort_by(|a, b| {
            b.1.partial_cmp(&a.1)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| a.0.cmp(&b.0))
        });
        sorted.truncate(n.saturating_mul(2));
        let mut ids: Vec<PeerId> = sorted.into_iter().map(|(p, _)| p).collect();
        ids.shuffle(&mut rand::thread_rng());
        ids.truncate(n);
        ids
    }
}

/// Convenience for tests: ids of a `SyncIds`.
#[cfg(test)]
pub fn sync_ids(message: &BlobMessage) -> Option<(&Vec<gossip_wire::BlobId>, &Option<SyncCursor>)> {
    match message {
        BlobMessage::SyncIds { ids, next } => Some((ids, next)),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::{BlobSource, MemBlobStore, MemStoreConfig};
    use gossip_wire::{BlobEnvelope, BlobKind};
    use massa_signature::KeyPair;

    fn peer() -> PeerId {
        PeerId::from_public_key(KeyPair::generate(0).unwrap().get_public_key())
    }

    #[test]
    fn request_reply_and_paging_roundtrip() {
        let retention = 1_000_000;
        let store = MemBlobStore::new(MemStoreConfig {
            retention_ms: retention,
            ..MemStoreConfig::default()
        });
        let now = 1_700_000_000_000u64;
        let envs: Vec<BlobEnvelope> = (0..5u64)
            .map(|i| BlobEnvelope::new(BlobKind::Bulletin, now + i, vec![], vec![i as u8]))
            .collect();
        store
            .insert_many_prevalidated(
                envs.iter()
                    .map(|e| {
                        (
                            e.clone(),
                            BlobSource {
                                peer: None,
                                trust_bucket: 0,
                                scope: Scope::INTERNET,
                            },
                        )
                    })
                    .collect(),
                now,
            )
            .unwrap();

        let responder = SyncState::new(2, retention);
        let mut requester = SyncState::new(2, retention);
        let p = peer();
        let since = UnixMillis(now + 1);
        assert!(requester.start(p, since, UnixMillis(now)));
        assert!(!requester.start(p, since, UnixMillis(now)));
        let mut got = Vec::new();
        let mut pages = 0;
        loop {
            let mut requests = requester.poll();
            assert_eq!(requests.len(), 1);
            assert!(requester.is_in_flight(&p));
            assert!(requester.poll().is_empty(), "one page in flight per peer");
            let (to, BlobMessage::SyncRequest { since, cursor, max }) = requests.remove(0) else {
                panic!("expected request");
            };
            assert_eq!(to, p);
            let reply = responder.reply(&store, since, cursor, max);
            let (ids, next) = sync_ids(&reply).unwrap();
            assert!(ids.len() <= 2);
            got.extend(ids.iter().copied());
            pages += 1;
            assert!(requester.on_page(&p, *next));
            if next.is_none() {
                break;
            }
        }
        // blobs created at now+1 .. now+4, two per page
        assert_eq!(pages, 2);
        assert_eq!(got, envs[1..].iter().map(|e| e.id()).collect::<Vec<_>>());
        assert!(!requester.is_in_flight(&p));
        assert!(requester.poll().is_empty());
        assert_eq!(requester.high_water, UnixMillis(now));
        assert_eq!(
            requester.initial_since(UnixMillis(now + 10)),
            UnixMillis(now + 10 - retention)
        );
        requester.high_water = UnixMillis(now + 10 * HIGH_WATER_BACKOFF_MS);
        assert_eq!(
            requester.initial_since(UnixMillis(now + 10 * HIGH_WATER_BACKOFF_MS)),
            UnixMillis(
                (now + 10 * HIGH_WATER_BACKOFF_MS - retention).max(now + 9 * HIGH_WATER_BACKOFF_MS)
            )
        );
        // a late duplicate page after completion is not accepted, but the peer is known
        assert!(!requester.on_page(&p, None));
        assert!(requester.has_synced_with(&p));
        // a page from a peer we never synced with is unsolicited
        let stranger = peer();
        assert!(!requester.on_page(&stranger, None));
        assert!(!requester.has_synced_with(&stranger));
        // the page size is capped by the responder
        let reply = responder.reply(&store, UnixMillis(0), None, 100);
        assert_eq!(sync_ids(&reply).unwrap().0.len(), 2);
        // a finished sync can be started again (resync)
        assert!(requester.start(p, since, UnixMillis(now)));
        requester.remove(&p);
        assert!(!requester.has_synced_with(&p));
    }

    #[test]
    fn unanswered_request_times_out_and_is_retried_with_backoff() {
        let mut state = SyncState::new(10, 1000).with_timeout(Duration::from_millis(40));
        let p = peer();
        assert!(state.start(p, UnixMillis(0), UnixMillis(0)));
        assert_eq!(state.poll().len(), 1);
        std::thread::sleep(Duration::from_millis(50));
        // timed out: in flight cleared, retry scheduled 40 ms later (first backoff)
        assert!(state.poll().is_empty());
        assert!(!state.is_in_flight(&p));
        std::thread::sleep(Duration::from_millis(50));
        let retry = state.poll();
        assert_eq!(retry.len(), 1);
        assert!(matches!(
            retry[0].1,
            BlobMessage::SyncRequest { cursor: None, .. }
        ));
        // the answer resets the retry counter and completes the sync
        assert!(state.on_page(&p, None));
        assert!(state.poll().is_empty());
    }

    #[test]
    fn a_peer_s_advertised_page_and_pace_bound_what_we_ask_it() {
        let p = PeerId::from_public_key(KeyPair::generate(0).unwrap().get_public_key());
        let q = PeerId::from_public_key(KeyPair::generate(0).unwrap().get_public_key());
        let now = UnixMillis(1_000);
        // our own page size is 5000 and our default pace is the untrusted floor
        let mut state = SyncState::new(5000, 1_000_000).with_pacing(1.5);
        // p said: pages of 200, six requests a minute; q said nothing
        assert!(state.start_within(p, UnixMillis(0), now, 200, 6.0));
        assert!(state.start(q, UnixMillis(0), now));
        let requests = state.poll();
        assert_eq!(requests.len(), 2);
        for (to, msg) in &requests {
            let BlobMessage::SyncRequest { max, .. } = msg else {
                panic!("expected a sync request");
            };
            if *to == p {
                assert_eq!(*max, 200, "never above what the peer accepts");
            } else {
                assert_eq!(*max, 5000, "our own page size when the peer said nothing");
            }
        }
        // a peer claiming more than our own page size is clamped to ours
        let r = PeerId::from_public_key(KeyPair::generate(0).unwrap().get_public_key());
        assert!(state.start_within(r, UnixMillis(0), now, 100_000, f64::INFINITY));
        let (_, msg) = state.poll().into_iter().find(|(to, _)| *to == r).unwrap();
        assert!(matches!(msg, BlobMessage::SyncRequest { max: 5000, .. }));
    }

    #[test]
    fn page_requests_are_paced_per_peer() {
        // one request per minute: the first goes out, the next page waits
        let mut state = SyncState::new(10, 1000).with_pacing(1.0);
        let (p, q) = (peer(), peer());
        assert!(state.start(p, UnixMillis(0), UnixMillis(0)));
        assert!(state.start(q, UnixMillis(0), UnixMillis(0)));
        assert_eq!(state.poll().len(), 2, "pacing is per peer");
        let cursor = (UnixMillis(5), gossip_wire::BlobId([1; 32]));
        assert!(state.on_page(&p, Some(cursor)));
        assert!(state.poll().is_empty());
        assert!(!state.is_in_flight(&p));
        // a bucket below one token still lets a request through when full
        let mut slow = SyncState::new(10, 1000).with_pacing(0.25);
        assert!(slow.start(p, UnixMillis(0), UnixMillis(0)));
        assert_eq!(slow.poll().len(), 1);
    }

    #[test]
    fn resync_picks_most_trusted() {
        let state = SyncState::new(10, 1000);
        let peers: Vec<(PeerId, f64)> = (0..6).map(|i| (peer(), i as f64 / 10.0)).collect();
        let picked = state.pick_resync_peers(&peers, 2);
        assert_eq!(picked.len(), 2);
        for p in picked {
            let trust = peers.iter().find(|(id, _)| *id == p).unwrap().1;
            assert!(trust >= 0.2, "picked a low-trust peer");
        }
        assert!(state.pick_resync_peers(&[], 2).is_empty());
        assert_eq!(
            state.resync_since(UnixMillis(RESYNC_WINDOW_MS + 5)),
            UnixMillis(5)
        );
    }
}
