//! Mesh behaviour of the replication engine: scope filters, the mesh clock and the
//! wanted-seekers table. Everything here is specified in `docs/MESH.md`.
//!
//! A node with [`MeshConfig::enabled`] off (every server) behaves exactly as before the
//! mesh work: no scope lookups, no `Wanted` messages, the plain clock.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::{Duration, Instant};

use gossip_wire::{
    Beacon, BlobKind, BlobMessage, PeerId, Scope, UnixMillis, WantedEntry, MAX_WANTED_LIFETIME_S,
    MAX_WANTED_PER_MESSAGE, MAX_WANTED_SUMMARY_LIFETIME, WANTED_ENTRY_BYTES, WANTED_SEEKER_LEN,
    WANTED_SUMMARY_LIFETIME_UNIT_S,
};

use crate::store::BlobInfo;
use parking_lot::Mutex;
use rand::Rng;

/// A seeker key, as carried by `Wanted` entries.
pub type Seeker = [u8; WANTED_SEEKER_LEN];

/// A forwarded entry extends a known one only when it is a renewal: an expiry later by
/// more than this. An entry already sent on a link is sent again only after such a
/// renewal. Lifetimes travel relative to the sender's clock and every hop adds its
/// transit and queueing time, so without this slack neighbours keep pushing the same
/// entry's expiry a little later and echo it to each other forever (found by the mesh
/// simulation).
pub const WANTED_RESEND_SLACK_MS: u64 = 300_000;

/// A beacon dated further than this ahead of mesh time is ignored: a bridge signs it
/// when it sends it, and mesh clocks agree within minutes.
pub const BEACON_MAX_FUTURE_MS: u64 = 10 * 60 * 1000;

/// Mesh settings of a node.
#[derive(Clone, Debug, PartialEq)]
pub struct MeshConfig {
    /// Whether the node has mesh links at all. Off on servers.
    pub enabled: bool,
    /// Bridging: blobs received on mesh links also get [`Scope::UPLOAD`].
    pub bridge: bool,
    /// Largest payload replicated on mesh links (default 64 KiB).
    pub max_payload_len: usize,
    /// Period of `Wanted` forwarding (default 2 s).
    pub wanted_forward_interval_ms: u64,
    /// Hop budget of own entries is drawn uniformly in `own_hops_min..=own_hops_max`.
    pub own_hops_min: u8,
    /// See [`MeshConfig::own_hops_min`].
    pub own_hops_max: u8,
    /// Lifetime of own entries, renewed while the app keeps them (default 1 h).
    pub own_lifetime_s: u32,
    /// Most entries in the table (default 32 768: with guided forwarding entries cross
    /// the whole mesh, and a march of 1000 phones with 10 contacts each already holds
    /// 10 000).
    pub max_wanted_entries: usize,
    /// Entries accepted per minute from one peer at trust 1 (default 512), scaled by
    /// `0.25 + 0.75 × trust`.
    pub wanted_ingest_per_min: u32,
    /// Most `Wanted` messages sent to one peer per forwarding round (default 4).
    pub wanted_messages_per_round: usize,
    /// Most `Wanted` bytes sent to one peer per forwarding round (default 16 KiB): the
    /// table of a crowd must not starve the blobs of a BLE link.
    pub wanted_bytes_per_round: usize,
    /// `Wanted` entries accepted per minute from all peers together (default 4096): a
    /// device that reconnects under fresh peer ids gets a fresh per-peer budget, but
    /// not more of this one.
    pub wanted_global_ingest_per_min: u32,
    /// Longest lifetime kept for a forwarded entry (default 1 h, the own lifetime):
    /// entries announced with a longer one would outlive honest ones in eviction.
    pub max_forwarded_lifetime_s: u32,
    /// How many distinct directions guided forwarding uses for one seeker (default 2):
    /// one peer advertising every seeker with a large hop budget must not become the
    /// only way to them.
    pub route_fanout: usize,
    /// Per mille of (blob, peer) pairs offered past the spray window whatever the
    /// directions (default 50, 5 %), so that no advertisement can blackhole a blob.
    pub spray_permille: u16,
    /// Most bridge beacons kept (default 64).
    pub max_beacons: usize,
    /// Guided forwarding: past the spray window a key-value blob only goes toward the
    /// phones that advertised its seeker with the most hops left, or toward the nearest
    /// bridge when nobody wants it yet (see `docs/MESH.md`, "Guided forwarding").
    pub guided: bool,
    /// Age below which a key-value blob is still offered on every mesh link.
    pub spray_ms: u64,
    /// Hop budget of a bridge beacon.
    pub beacon_hops: u8,
    /// Lifetime of a bridge beacon; renewed at half of it while the bridge works.
    pub beacon_lifetime_s: u32,
}

impl Default for MeshConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            bridge: false,
            max_payload_len: 64 * 1024,
            wanted_forward_interval_ms: 2000,
            own_hops_min: 24,
            own_hops_max: 32,
            own_lifetime_s: 3600,
            max_wanted_entries: 32_768,
            wanted_ingest_per_min: 512,
            wanted_messages_per_round: 4,
            wanted_bytes_per_round: 16 * 1024,
            wanted_global_ingest_per_min: 4096,
            max_forwarded_lifetime_s: 3600,
            route_fanout: 2,
            spray_permille: 50,
            max_beacons: 64,
            guided: true,
            spray_ms: 5_000,
            beacon_hops: 32,
            beacon_lifetime_s: 1200,
        }
    }
}

impl MeshConfig {
    /// The defaults of `docs/MESH.md` with the mesh enabled.
    pub fn phone() -> Self {
        Self {
            enabled: true,
            ..Self::default()
        }
    }

    /// [`MeshConfig::wanted_forward_interval_ms`] as a duration.
    pub fn wanted_forward_interval(&self) -> Duration {
        Duration::from_millis(self.wanted_forward_interval_ms.max(1))
    }

    /// Largest hop budget accepted from a peer: nobody honest sends more than an own
    /// entry or a bridge beacon starts with.
    pub fn max_hops(&self) -> u8 {
        self.own_hops_max.max(self.beacon_hops)
    }
}

/// Mesh time: the local clock corrected by the offset mesh peers agree on.
///
/// Each mesh link handshake gives an offset estimate for the peer, kept only while the
/// link is up ([`MeshClock::forget`] when it goes). Over the current links, the median
/// is the target when at least [`MeshClock::MIN_PEERS`] contribute and it is more than
/// [`MeshClock::THRESHOLD_MS`] away from zero, clamped to ±[`MeshClock::CLAMP_MS`]. The
/// applied correction moves toward the target by at most [`MeshClock::SLEW_PER_S_MS`]
/// per second. One device therefore moves mesh time only by holding most of a phone's
/// links at once, and then by at most the clamp, which stays inside the mesh skew: a
/// phone it shifted still accepts honest fresh blobs, and honest phones still accept
/// its own.
pub struct MeshClock {
    samples: Mutex<HashMap<PeerId, i64>>,
    applied: Mutex<(i64, Instant)>,
}

impl Default for MeshClock {
    fn default() -> Self {
        Self {
            samples: Mutex::new(HashMap::new()),
            applied: Mutex::new((0, Instant::now())),
        }
    }
}

impl MeshClock {
    /// Fewest current links whose estimates move mesh time.
    pub const MIN_PEERS: usize = 3;
    /// Smallest median that is applied.
    pub const THRESHOLD_MS: i64 = 60_000;
    /// Largest correction: half the 6-hour skew mesh blobs are accepted with.
    pub const CLAMP_MS: i64 = 3 * 60 * 60 * 1000;
    /// Fastest change of the applied correction, per second (5 minutes per minute).
    pub const SLEW_PER_S_MS: i64 = 5_000;

    /// A clock with no estimate (mesh time is local time).
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    /// Records the offset `peer clock − local clock` estimated for the link to `peer`,
    /// in ms.
    pub fn record(&self, peer: PeerId, offset_ms: i64) {
        self.samples.lock().insert(peer, offset_ms);
    }

    /// Forgets the estimate of a link that went down.
    pub fn forget(&self, peer: &PeerId) {
        self.samples.lock().remove(peer);
    }

    /// The correction the current links agree on, before slewing.
    pub fn target_ms(&self) -> i64 {
        let samples = self.samples.lock();
        if samples.len() < Self::MIN_PEERS {
            return 0;
        }
        let mut offsets: Vec<i64> = samples.values().copied().collect();
        drop(samples);
        offsets.sort_unstable();
        let n = offsets.len();
        let median = if n % 2 == 1 {
            offsets[n / 2]
        } else {
            ((i128::from(offsets[n / 2 - 1]) + i128::from(offsets[n / 2])) / 2) as i64
        };
        if median.saturating_abs() <= Self::THRESHOLD_MS {
            return 0;
        }
        median.clamp(-Self::CLAMP_MS, Self::CLAMP_MS)
    }

    /// The correction applied to the local clock now.
    pub fn offset_ms(&self) -> i64 {
        let target = self.target_ms();
        let mut applied = self.applied.lock();
        let now = Instant::now();
        let elapsed_ms = now
            .duration_since(applied.1)
            .as_millis()
            .min(i64::MAX as u128) as i64;
        let step = elapsed_ms.saturating_mul(Self::SLEW_PER_S_MS) / 1000;
        let delta = (target - applied.0).clamp(-step, step);
        if delta != 0 || target == applied.0 {
            *applied = (applied.0 + delta, now);
        }
        applied.0
    }

    /// Mesh time now.
    pub fn now(&self) -> UnixMillis {
        let local = UnixMillis::now().as_millis() as i64;
        UnixMillis(local.saturating_add(self.offset_ms()).max(0) as u64)
    }
}

/// Most advertisers remembered per entry (the ones with the most hops left).
const MAX_VIA: usize = 4;

/// The seeker form of a bridge beacon: `0x00 ‖ tag (32) ‖ 0x00`. Real seekers start
/// with `0x20`, so the two never collide.
pub fn beacon_seeker(tag: &[u8; 32]) -> Seeker {
    let mut s = [0u8; WANTED_SEEKER_LEN];
    s[1..33].copy_from_slice(tag);
    s
}

/// Whether a wanted entry is a bridge beacon.
pub fn is_beacon(seeker: &Seeker) -> bool {
    seeker[0] == 0
}

/// Hop budgets weigh this much more than trust when ranking directions: trust only
/// breaks ties and near ties (a fully trusted advertiser is worth two hops).
const TRUST_HOPS: f64 = 2.0;

/// A peer that advertised an entry.
#[derive(Clone, Copy, Debug)]
struct Via {
    peer: PeerId,
    /// The hop budget it sent (clamped).
    hops: u8,
    /// Its trust when it advertised.
    trust: f32,
}

impl Via {
    fn score(&self) -> f64 {
        f64::from(self.hops) + TRUST_HOPS * f64::from(self.trust).clamp(0.0, 1.0)
    }
}

#[derive(Clone, Debug)]
struct WantedSlot {
    /// Mesh time (ms) after which the entry is dropped.
    expires_at: u64,
    /// Hop budget sent with the entry when forwarded; 0 = kept but not forwarded.
    send_hops: u8,
    /// Asked by the local app.
    own: bool,
    /// Local-only: nobody advertised it as a regular entry (see `docs/MESH.md`,
    /// "Local-only blobs and seekers"). A regular advertisement clears it for the life
    /// of the slot: a stranger can mark a seeker local-only, which would stop bridges
    /// from fetching what somebody needs, but cannot keep it so.
    local: bool,
    /// Also received from a peer.
    forwarded: bool,
    /// The peer that first brought it, for fair-share eviction.
    origin: Option<PeerId>,
    /// Peers that advertised it; best direction first.
    via: Vec<Via>,
    /// For a bridge beacon, the signed statement forwarded with it.
    beacon: Option<Beacon>,
}

impl WantedSlot {
    fn new(expires_at: u64, send_hops: u8, own: bool, origin: Option<PeerId>) -> Self {
        Self {
            expires_at,
            send_hops,
            own,
            local: false,
            forwarded: !own,
            origin,
            via: Vec::new(),
            beacon: None,
        }
    }

    fn add_via(&mut self, via: Via) {
        match self.via.iter_mut().find(|v| v.peer == via.peer) {
            Some(v) => {
                v.hops = v.hops.max(via.hops);
                v.trust = via.trust;
            }
            None => self.via.push(via),
        }
        self.via
            .sort_by(|a, b| b.score().partial_cmp(&a.score()).expect("finite"));
        self.via.truncate(MAX_VIA);
    }
}

/// The `WantedSummary` item of a seeker: the seeker itself, followed by `0x01` when
/// the entry is local-only, so that a summary only hides an entry the peer holds with
/// the same flag.
pub fn wanted_summary_item(seeker: &Seeker, local: bool) -> Vec<u8> {
    let mut item = seeker.to_vec();
    if local {
        item.push(1);
    }
    item
}

#[derive(Default)]
struct WantedInner {
    entries: HashMap<Seeker, WantedSlot>,
    /// Per peer: the expiry last sent for each seeker.
    sent: HashMap<PeerId, HashMap<Seeker, u64>>,
}

/// The wanted-seekers table of a node (see `docs/MESH.md`, "Wanted seekers").
pub struct WantedTable {
    config: MeshConfig,
    inner: Mutex<WantedInner>,
}

impl WantedTable {
    /// An empty table.
    pub fn new(config: MeshConfig) -> Arc<Self> {
        Arc::new(Self {
            config,
            inner: Mutex::new(WantedInner::default()),
        })
    }

    /// Replaces the local app's own seekers: the given ones are (re)added with the own
    /// lifetime, own entries not in the list lose their own flag (and go when they were
    /// not also forwarded to us).
    pub fn set_own(&self, seekers: &[Seeker], now: UnixMillis) {
        let entries: Vec<(Seeker, bool)> = seekers.iter().map(|s| (*s, false)).collect();
        self.set_own_entries(&entries, now);
    }

    /// [`Self::set_own`] with a local-only flag per seeker: a local-only seeker is
    /// flooded with the flag, and bridges do not fetch it upstream. An own entry that is
    /// not also forwarded to us takes the flag it is given; a forwarded one only loses
    /// it (a regular advertisement wins).
    pub fn set_own_entries(&self, seekers: &[(Seeker, bool)], now: UnixMillis) {
        let keep: HashSet<&Seeker> = seekers.iter().map(|(s, _)| s).collect();
        let expires_at = now
            .as_millis()
            .saturating_add(u64::from(self.config.own_lifetime_s) * 1000);
        let (lo, hi) = (
            self.config.own_hops_min.min(self.config.own_hops_max),
            self.config.own_hops_max,
        );
        let mut rng = rand::thread_rng();
        let mut inner = self.inner.lock();
        inner.entries.retain(|seeker, slot| {
            if slot.own && !is_beacon(seeker) && !keep.contains(seeker) {
                slot.own = false;
                // a pure own entry has no forwarded copy to keep
                return slot.forwarded;
            }
            true
        });
        let mut cleared = Vec::new();
        for (seeker, local) in seekers {
            if is_beacon(seeker) {
                continue;
            }
            let hops = rng.gen_range(lo..=hi);
            let slot = inner.entries.entry(*seeker).or_insert_with(|| {
                let mut slot = WantedSlot::new(expires_at, hops, true, None);
                slot.local = *local;
                slot
            });
            slot.own = true;
            slot.expires_at = slot.expires_at.max(expires_at);
            slot.send_hops = slot.send_hops.max(hops);
            if slot.local && !*local {
                slot.local = false;
                cleared.push(*seeker);
            } else if *local && !slot.forwarded {
                slot.local = true;
            }
        }
        Self::resend(&mut inner, &cleared);
        Self::cap(&mut inner, &self.config);
    }

    /// Forgets that `seekers` were sent to anybody, so that they travel again (their
    /// local-only flag was cleared).
    fn resend(inner: &mut WantedInner, seekers: &[Seeker]) {
        if seekers.is_empty() {
            return;
        }
        for sent in inner.sent.values_mut() {
            for s in seekers {
                sent.remove(s);
            }
        }
    }

    /// Merges entries received from `from` (of trust `trust`) with hop budget `hops`;
    /// returns the seekers that were not wanted before. Entries are recorded as sent to
    /// `from`, so they are not echoed back to it.
    ///
    /// The hop budget is clamped to [`MeshConfig::max_hops`] and lifetimes to
    /// [`MeshConfig::max_forwarded_lifetime_s`]: a peer claiming more would otherwise
    /// become the best direction for every seeker it copies, and its entries would
    /// outlive honest ones. Beacon seekers only travel in signed `Beacon` messages and
    /// are ignored here. A regular entry clears the local-only flag of a local one.
    pub fn merge(
        &self,
        from: &PeerId,
        trust: f64,
        hops: u8,
        entries: &[WantedEntry],
        now: UnixMillis,
    ) -> Vec<Seeker> {
        let mut inner = self.inner.lock();
        let inner = &mut *inner;
        let mut fresh = Vec::new();
        let hops = hops.min(self.config.max_hops());
        let send_hops = hops.saturating_sub(1);
        let max_lifetime = self
            .config
            .max_forwarded_lifetime_s
            .min(MAX_WANTED_LIFETIME_S);
        for e in entries {
            if is_beacon(&e.seeker) {
                continue;
            }
            let lifetime = e.lifetime_s.min(max_lifetime);
            let expires_at = now.as_millis().saturating_add(u64::from(lifetime) * 1000);
            let mut cleared = false;
            match inner.entries.get_mut(&e.seeker) {
                Some(slot) => {
                    if expires_at > slot.expires_at.saturating_add(WANTED_RESEND_SLACK_MS) {
                        slot.expires_at = expires_at;
                    }
                    slot.send_hops = slot.send_hops.max(send_hops);
                    slot.forwarded = true;
                    slot.origin.get_or_insert(*from);
                    if slot.local && !e.local {
                        slot.local = false;
                        cleared = true;
                    }
                }
                None => {
                    let mut slot = WantedSlot::new(expires_at, send_hops, false, Some(*from));
                    slot.local = e.local;
                    inner.entries.insert(e.seeker, slot);
                    fresh.push(e.seeker);
                }
            }
            if cleared {
                Self::resend(inner, &[e.seeker]);
            }
            let slot = inner.entries.get_mut(&e.seeker).expect("just merged");
            slot.add_via(Via {
                peer: *from,
                hops,
                trust: trust as f32,
            });
            let expires = slot.expires_at;
            let sent = inner.sent.entry(*from).or_default();
            let mark = sent.entry(e.seeker).or_insert(0);
            *mark = (*mark).max(expires);
        }
        Self::cap(inner, &self.config);
        fresh
    }

    /// Merges a bridge beacon (signature already checked) received from `from` with hop
    /// budget `hops`. Returns whether it was new or renewed. A beacon that expired, is
    /// dated too far ahead of mesh time `now`, or lasts longer than the configured
    /// beacon lifetime is ignored.
    pub fn merge_beacon(
        &self,
        from: &PeerId,
        trust: f64,
        hops: u8,
        beacon: &Beacon,
        now: UnixMillis,
        max_future_ms: u64,
    ) -> bool {
        let now_ms = now.as_millis();
        let expires_at = beacon.expires_at();
        if expires_at <= now_ms
            || beacon.issued_at > now_ms.saturating_add(max_future_ms)
            || beacon.lifetime_s > self.config.beacon_lifetime_s.max(1)
        {
            return false;
        }
        let hops = hops.min(self.config.beacon_hops);
        let seeker = beacon_seeker(&beacon.tag());
        let mut inner = self.inner.lock();
        let inner = &mut *inner;
        let beacons = inner.entries.keys().filter(|s| is_beacon(s)).count();
        let changed = match inner.entries.get_mut(&seeker) {
            Some(slot) => {
                let newer = slot
                    .beacon
                    .as_ref()
                    .is_none_or(|b| beacon.issued_at > b.issued_at);
                if newer {
                    slot.beacon = Some(beacon.clone());
                    slot.expires_at = expires_at;
                }
                slot.send_hops = slot.send_hops.max(hops.saturating_sub(1));
                slot.forwarded = true;
                newer
            }
            None => {
                if beacons >= self.config.max_beacons {
                    return false;
                }
                let mut slot =
                    WantedSlot::new(expires_at, hops.saturating_sub(1), false, Some(*from));
                slot.beacon = Some(beacon.clone());
                inner.entries.insert(seeker, slot);
                true
            }
        };
        let slot = inner.entries.get_mut(&seeker).expect("just merged");
        slot.add_via(Via {
            peer: *from,
            hops,
            trust: trust as f32,
        });
        let expires = slot.expires_at;
        let mark = inner
            .sent
            .entry(*from)
            .or_default()
            .entry(seeker)
            .or_insert(0);
        *mark = (*mark).max(expires);
        changed
    }

    /// Whether `seeker` is wanted at mesh time `now`.
    pub fn contains(&self, seeker: &[u8], now: UnixMillis) -> bool {
        let Ok(seeker) = <&Seeker>::try_from(seeker) else {
            return false;
        };
        self.inner
            .lock()
            .entries
            .get(seeker)
            .is_some_and(|s| s.expires_at > now.as_millis())
    }

    /// Every wanted seeker.
    pub fn seekers(&self, now: UnixMillis) -> Vec<Seeker> {
        self.inner
            .lock()
            .entries
            .iter()
            .filter(|(_, s)| s.expires_at > now.as_millis())
            .map(|(k, _)| *k)
            .collect()
    }

    /// The wanted seekers a bridge may fetch upstream: every live one but beacons and
    /// local-only entries.
    pub fn upstream_seekers(&self, now: UnixMillis) -> Vec<Seeker> {
        self.inner
            .lock()
            .entries
            .iter()
            .filter(|(k, s)| s.expires_at > now.as_millis() && !s.local && !is_beacon(k))
            .map(|(k, _)| *k)
            .collect()
    }

    /// Whether `seeker` is wanted and local-only.
    pub fn is_local(&self, seeker: &[u8]) -> bool {
        let Ok(seeker) = <&Seeker>::try_from(seeker) else {
            return false;
        };
        self.inner
            .lock()
            .entries
            .get(seeker)
            .is_some_and(|s| s.local)
    }

    /// Number of entries.
    pub fn len(&self) -> usize {
        self.inner.lock().entries.len()
    }

    /// Whether the table is empty.
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// The messages to send `peer` this round: beacons, then `Wanted` entries it has not
    /// seen with this expiry or a later one, own entries before forwarded ones (each
    /// shuffled), grouped by hop budget, within [`MeshConfig::wanted_bytes_per_round`]
    /// and [`MeshConfig::wanted_messages_per_round`] full messages. Marks them sent.
    pub fn outgoing(&self, peer: &PeerId, now: UnixMillis) -> Vec<BlobMessage> {
        use rand::seq::SliceRandom;
        let now_ms = now.as_millis();
        let mut inner = self.inner.lock();
        inner.entries.retain(|_, s| s.expires_at > now_ms);
        let mut own: Vec<(u8, WantedEntry)> = Vec::new();
        let mut forwarded: Vec<(u8, WantedEntry)> = Vec::new();
        let mut messages = Vec::new();
        let mut sent_now: HashSet<Seeker> = HashSet::new();
        let mut marked = Vec::new();
        {
            let sent = inner.sent.get(peer);
            for (seeker, slot) in inner.entries.iter() {
                if slot.send_hops == 0 {
                    continue;
                }
                if sent
                    .and_then(|m| m.get(seeker))
                    .is_some_and(|e| e.saturating_add(WANTED_RESEND_SLACK_MS) >= slot.expires_at)
                {
                    continue;
                }
                marked.push((*seeker, slot.expires_at));
                if let Some(beacon) = &slot.beacon {
                    // few, small and signed: always sent
                    messages.push(BlobMessage::Beacon {
                        hops: slot.send_hops,
                        beacon: Box::new(beacon.clone()),
                    });
                    sent_now.insert(*seeker);
                    continue;
                }
                let lifetime = ((slot.expires_at - now_ms) / 1000)
                    .min(u64::from(MAX_WANTED_LIFETIME_S)) as u32;
                let entry = WantedEntry {
                    seeker: *seeker,
                    lifetime_s: lifetime.max(1),
                    local: slot.local,
                };
                if slot.own {
                    own.push((slot.send_hops, entry));
                } else {
                    forwarded.push((slot.send_hops, entry));
                }
            }
        }
        let mut rng = rand::thread_rng();
        own.shuffle(&mut rng);
        forwarded.shuffle(&mut rng);
        let budget = (self.config.wanted_bytes_per_round / WANTED_ENTRY_BYTES)
            .min(self.config.wanted_messages_per_round * MAX_WANTED_PER_MESSAGE as usize);
        let mut by_hops: HashMap<u8, Vec<WantedEntry>> = HashMap::new();
        for (hops, entry) in own.into_iter().chain(forwarded).take(budget) {
            by_hops.entry(hops).or_default().push(entry);
        }
        let mut groups: Vec<(u8, Vec<WantedEntry>)> = by_hops.into_iter().collect();
        groups.sort_by_key(|(h, _)| std::cmp::Reverse(*h));
        for (hops, entries) in groups {
            for chunk in entries.chunks(MAX_WANTED_PER_MESSAGE as usize) {
                sent_now.extend(chunk.iter().map(|e| e.seeker));
                messages.push(BlobMessage::Wanted {
                    hops,
                    entries: chunk.to_vec(),
                });
            }
        }
        let sent = inner.sent.entry(*peer).or_default();
        for (seeker, expires_at) in marked {
            if sent_now.contains(&seeker) {
                sent.insert(seeker, expires_at);
            }
        }
        sent.retain(|_, e| *e > now_ms);
        messages
    }

    /// What a `WantedSummary` lists: each live entry with the hop budget it would be
    /// forwarded with, its remaining lifetime in summary units (rounded up) and its
    /// local-only flag (see [`wanted_summary_item`]).
    pub fn summary_items(&self, now: UnixMillis) -> Vec<(Seeker, u8, u8, bool)> {
        let now_ms = now.as_millis();
        let unit_ms = u64::from(WANTED_SUMMARY_LIFETIME_UNIT_S) * 1000;
        self.inner
            .lock()
            .entries
            .iter()
            .filter(|(seeker, s)| s.expires_at > now_ms && !is_beacon(seeker))
            .map(|(seeker, s)| {
                let units = (s.expires_at - now_ms)
                    .div_ceil(unit_ms)
                    .clamp(1, u64::from(MAX_WANTED_SUMMARY_LIFETIME));
                (*seeker, s.send_hops, units as u8, s.local)
            })
            .collect()
    }

    /// Records as already sent to `peer` the entries its `WantedSummary` shows it
    /// holds at least as well: `lookup` gives, for a seeker of ours and its local-only
    /// flag, the hop budget and lifetime units the summary matched (see
    /// `docs/MESH.md`, "Wanted summary"). Returns how many entries were recorded.
    pub fn apply_summary(
        &self,
        peer: &PeerId,
        now: UnixMillis,
        lookup: impl Fn(&Seeker, bool) -> Option<(u8, u8)>,
    ) -> usize {
        let now_ms = now.as_millis();
        let unit_ms = u64::from(WANTED_SUMMARY_LIFETIME_UNIT_S) * 1000;
        let mut inner = self.inner.lock();
        let inner = &mut *inner;
        let sent = inner.sent.entry(*peer).or_default();
        let mut recorded = 0;
        for (seeker, slot) in inner.entries.iter() {
            if slot.expires_at <= now_ms || is_beacon(seeker) {
                continue;
            }
            let Some((hops, units)) = lookup(seeker, slot.local) else {
                continue;
            };
            // a budget of ours above the peer's by two or more is a strictly better
            // direction for it (one more is a tie with its best): it travels
            if slot.send_hops > hops.saturating_add(1) {
                continue;
            }
            let theirs = now_ms.saturating_add(u64::from(units) * unit_ms);
            let mark = sent.entry(*seeker).or_insert(0);
            *mark = (*mark).max(theirs);
            recorded += 1;
        }
        recorded
    }

    /// Forgets what was sent to a peer that went away, and its advertisements.
    pub fn remove_peer(&self, peer: &PeerId) {
        let mut inner = self.inner.lock();
        inner.sent.remove(peer);
        for slot in inner.entries.values_mut() {
            slot.via.retain(|v| v.peer != *peer);
        }
    }

    /// Whether this node's own beacon must be signed again: none yet, or half of its
    /// lifetime gone.
    pub fn beacon_due(&self, now: UnixMillis) -> bool {
        let lifetime = u64::from(self.config.beacon_lifetime_s) * 1000;
        !self.inner.lock().entries.iter().any(|(s, slot)| {
            is_beacon(s)
                && slot.own
                && slot.expires_at >= now.as_millis().saturating_add(lifetime / 2)
        })
    }

    /// Advertises this node as a bridge with a beacon it signed (`Some`), or stops
    /// (`None`). Called while the upstream answers, with a new beacon when
    /// [`Self::beacon_due`].
    pub fn set_beacon(&self, beacon: Option<Beacon>, _now: UnixMillis) {
        let mut inner = self.inner.lock();
        let tag = beacon.as_ref().map(Beacon::tag);
        // drop an own beacon under another key (or every own beacon when stopping)
        inner
            .entries
            .retain(|s, slot| !(is_beacon(s) && slot.own && tag.is_none_or(|t| s[1..33] != t)));
        let (Some(tag), Some(beacon)) = (tag, beacon) else {
            return;
        };
        let slot = inner
            .entries
            .entry(beacon_seeker(&tag))
            .or_insert_with(|| WantedSlot::new(0, self.config.beacon_hops, true, None));
        slot.own = true;
        slot.forwarded = false;
        slot.send_hops = self.config.beacon_hops;
        slot.expires_at = beacon.expires_at();
        slot.beacon = Some(beacon);
    }

    /// Whether this node currently advertises itself as a bridge.
    pub fn is_bridge(&self) -> bool {
        self.inner
            .lock()
            .entries
            .iter()
            .any(|(s, slot)| is_beacon(s) && slot.own)
    }

    /// The peers to forward a blob of `seeker` to: the [`MeshConfig::route_fanout`]
    /// best directions that advertised it (most hops left, trust breaking near ties).
    /// `None` when nobody advertised it (unknown, or our own).
    pub fn best_peers(&self, seeker: &[u8], now: UnixMillis) -> Option<Vec<PeerId>> {
        let seeker = <&Seeker>::try_from(seeker).ok()?;
        let inner = self.inner.lock();
        let slot = inner.entries.get(seeker)?;
        if slot.expires_at <= now.as_millis() || slot.via.is_empty() {
            return None;
        }
        Some(
            slot.via
                .iter()
                .take(self.config.route_fanout.max(1))
                .map(|v| v.peer)
                .collect(),
        )
    }

    /// The peers toward the nearest bridges: the [`MeshConfig::route_fanout`] best
    /// distinct directions over every live beacon but our own.
    pub fn bridge_peers(&self, now: UnixMillis) -> Vec<PeerId> {
        let inner = self.inner.lock();
        let mut vias: Vec<Via> = inner
            .entries
            .iter()
            .filter(|(s, slot)| is_beacon(s) && !slot.own && slot.expires_at > now.as_millis())
            .flat_map(|(_, slot)| slot.via.iter().copied())
            .collect();
        vias.sort_by(|a, b| b.score().partial_cmp(&a.score()).expect("finite"));
        let mut out: Vec<PeerId> = Vec::new();
        for v in vias {
            if out.len() >= self.config.route_fanout.max(1) {
                break;
            }
            if !out.contains(&v.peer) {
                out.push(v.peer);
            }
        }
        out
    }

    /// Evicts down to 90 % of the cap (so that the work runs once per tenth of the cap,
    /// not per entry). Forwarded entries go first, by fair share: always from the peer
    /// that brought the most entries, its earliest expiry first, so that a flooder only
    /// ever evicts its own entries while honest peers hold less than it. Own entries go
    /// last, earliest expiry first.
    fn cap(inner: &mut WantedInner, config: &MeshConfig) {
        let max = config.max_wanted_entries;
        if inner.entries.len() <= max {
            return;
        }
        let mut over = inner.entries.len() - max * 9 / 10;
        let mut groups: HashMap<Option<PeerId>, Vec<(u64, Seeker)>> = HashMap::new();
        let mut own: Vec<(u64, Seeker)> = Vec::new();
        for (k, s) in inner.entries.iter() {
            if s.own {
                own.push((s.expires_at, *k));
            } else {
                groups.entry(s.origin).or_default().push((s.expires_at, *k));
            }
        }
        let mut groups: Vec<Vec<(u64, Seeker)>> = groups
            .into_values()
            .map(|mut g| {
                // earliest expiry last, popped first
                g.sort_unstable_by(|a, b| b.cmp(a));
                g
            })
            .collect();
        let mut heap: std::collections::BinaryHeap<(usize, usize)> = groups
            .iter()
            .enumerate()
            .map(|(i, g)| (g.len(), i))
            .collect();
        while over > 0 {
            let Some((_, i)) = heap.pop() else {
                break;
            };
            let (_, k) = groups[i].pop().expect("groups in the heap are never empty");
            inner.entries.remove(&k);
            over -= 1;
            if !groups[i].is_empty() {
                heap.push((groups[i].len(), i));
            }
        }
        own.sort_unstable();
        for (_, k) in own.into_iter().take(over) {
            inner.entries.remove(&k);
        }
    }
}

/// What the engine needs for mesh behaviour.
#[derive(Clone)]
pub struct MeshParts {
    /// Settings.
    pub config: MeshConfig,
    /// Mesh time.
    pub clock: Arc<MeshClock>,
    /// Wanted seekers.
    pub wanted: Arc<WantedTable>,
}

impl MeshParts {
    /// Mesh parts for `config`, with a fresh clock and table.
    pub fn new(config: MeshConfig) -> Self {
        Self {
            wanted: WantedTable::new(config.clone()),
            clock: MeshClock::new(),
            config,
        }
    }

    /// Mesh off (servers).
    pub fn disabled() -> Self {
        Self::new(MeshConfig::default())
    }

    /// Scope a blob received from a link of `kind` is stored with; `local` for a blob
    /// that came in `LocalBlobs` (mesh links only): never marked for upload.
    pub fn ingest_scope(&self, mesh_link: bool, local: bool) -> Scope {
        if !mesh_link {
            Scope::INTERNET
        } else if local {
            Scope::MESH | Scope::LOCAL
        } else if self.config.bridge {
            Scope::MESH | Scope::UPLOAD
        } else {
            Scope::MESH
        }
    }

    /// The scope a link must find in a blob to carry it, or `None` when the node has
    /// no mesh and nothing is filtered.
    pub fn link_filter(&self, mesh_link: bool) -> Option<Scope> {
        if !self.config.enabled {
            None
        } else if mesh_link {
            Some(Scope::MESH)
        } else {
            Some(Scope::INTERNET)
        }
    }

    /// Whether a blob of `scope` and wire size `size` may travel on a link with
    /// `filter`.
    pub fn allows(&self, filter: Scope, scope: Scope, size: u32) -> bool {
        scope.contains(filter)
            && (filter != Scope::MESH
                // the payload cap, with room for the envelope header
                || (size as usize) <= self.config.max_payload_len + 256)
    }

    /// Whether a (blob key, peer) pair falls in the [`MeshConfig::spray_permille`]
    /// offered whatever the directions. Deterministic, so that every round decides the
    /// same.
    fn sprayed(&self, key: &[u8], peer: &PeerId) -> bool {
        if self.config.spray_permille == 0 {
            return false;
        }
        let mut h = blake3::Hasher::new();
        h.update(b"gossip/mesh/spray/v1");
        h.update(key);
        h.update(&peer.to_bytes());
        let v = u16::from_be_bytes(h.finalize().as_bytes()[..2].try_into().expect("2 bytes"));
        u32::from(v) % 1000 < u32::from(self.config.spray_permille)
    }

    /// Guided forwarding: whether a blob described by `info` may be offered to `peer`
    /// (a mesh link), with `bridges` the peers toward the nearest bridges. Blobs other
    /// than key-value ones (announcements, keys) are always offered: they are rare and
    /// must reach people nobody routes to yet.
    pub fn guided_allows(
        &self,
        info: &BlobInfo,
        peer: &PeerId,
        bridges: &[PeerId],
        now: UnixMillis,
    ) -> bool {
        if !self.config.guided || info.kind != BlobKind::KeyValue {
            return true;
        }
        if now.as_millis().saturating_sub(info.created_at) < self.config.spray_ms {
            return true;
        }
        if self.sprayed(&info.key, peer) {
            return true;
        }
        if let Some(best) = self.wanted.best_peers(&info.key, now) {
            return best.contains(peer);
        }
        if self.wanted.contains(&info.key, now) {
            // our own: this node is where it was going
            return false;
        }
        // a local-only blob nobody routes to has nothing to do at a bridge
        !info.scope.is_local() && bridges.contains(peer)
    }

    /// Whether a blob described by `info` may be offered on a link with `filter` to
    /// `peer`: the scope filter, then guided forwarding on mesh links. `bridges` are the
    /// peers toward the nearest bridges, empty when this node is itself a bridge.
    pub fn offers(
        &self,
        filter: Scope,
        info: &BlobInfo,
        peer: &PeerId,
        bridges: &[PeerId],
        now: UnixMillis,
    ) -> bool {
        self.allows(filter, info.scope, info.size)
            && (filter != Scope::MESH || self.guided_allows(info, peer, bridges, now))
    }

    /// The peers toward the nearest bridges, as [`MeshParts::offers`] wants them.
    pub fn bridge_direction(&self, now: UnixMillis) -> Vec<PeerId> {
        if self.wanted.is_bridge() {
            Vec::new()
        } else {
            self.wanted.bridge_peers(now)
        }
    }

    /// Time used for blobs from a link: mesh time on mesh links.
    pub fn now_for(&self, mesh_link: bool) -> UnixMillis {
        if mesh_link && self.config.enabled {
            self.clock.now()
        } else {
            UnixMillis::now()
        }
    }
}

impl Default for MeshParts {
    fn default() -> Self {
        Self::disabled()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use massa_signature::KeyPair;

    fn peer() -> PeerId {
        PeerId::from_public_key(KeyPair::generate(0).unwrap().get_public_key())
    }

    fn entry(n: u8, lifetime_s: u32) -> WantedEntry {
        WantedEntry {
            seeker: [n; WANTED_SEEKER_LEN],
            lifetime_s,
            local: false,
        }
    }

    #[test]
    fn clock_needs_three_current_links_and_is_clamped() {
        let clock = MeshClock::new();
        clock.record(peer(), 3_600_000);
        clock.record(peer(), 3_600_000);
        assert_eq!(clock.target_ms(), 0, "two links move nothing");
        clock.record(peer(), 3_500_000);
        assert_eq!(clock.target_ms(), 3_600_000);
        // small medians are ignored
        let calm = MeshClock::new();
        for o in [10_000, -20_000, 30_000] {
            calm.record(peer(), o);
        }
        assert_eq!(calm.target_ms(), 0);
        // a crowd of liars moves at most the clamp, and huge values do not overflow
        let lied = MeshClock::new();
        for o in [i64::MAX, i64::MAX, i64::MIN + 1, i64::MAX] {
            lied.record(peer(), o);
        }
        assert_eq!(lied.target_ms(), MeshClock::CLAMP_MS);
        // one peer counts once
        let one = MeshClock::new();
        let p = peer();
        for _ in 0..5 {
            one.record(p, 3_600_000);
        }
        assert_eq!(one.target_ms(), 0);
    }

    #[test]
    fn a_liar_reconnecting_under_fresh_ids_moves_nothing() {
        let clock = MeshClock::new();
        let honest: Vec<PeerId> = (0..3).map(|_| peer()).collect();
        for p in &honest {
            clock.record(*p, 1_000);
        }
        // one device, one link at a time, a new peer id each time
        for _ in 0..50 {
            let liar = peer();
            clock.record(liar, -MeshClock::CLAMP_MS);
            assert_eq!(clock.target_ms(), 0);
            clock.forget(&liar);
        }
        assert_eq!(clock.target_ms(), 0);
    }

    #[test]
    fn the_correction_slews() {
        let clock = MeshClock::new();
        for _ in 0..3 {
            clock.record(peer(), MeshClock::CLAMP_MS);
        }
        // right away nothing has moved; it never jumps past the slew rate
        assert!(clock.offset_ms() <= MeshClock::SLEW_PER_S_MS);
        std::thread::sleep(Duration::from_millis(200));
        let o = clock.offset_ms();
        assert!(o > 0 && o <= MeshClock::SLEW_PER_S_MS, "{o}");
    }

    #[test]
    fn wanted_entries_merge_forward_with_fewer_hops_and_stop_at_zero() {
        let table = WantedTable::new(MeshConfig::phone());
        let now = UnixMillis(1_000_000);
        let fresh = table.merge(&peer(), 0.0, 3, &[entry(1, 60), entry(2, 99_999)], now);
        assert_eq!(fresh.len(), 2);
        assert!(table.contains(&[1; WANTED_SEEKER_LEN], now));
        // merge again: nothing fresh, a renewal (more than the slack later) kept
        assert!(table
            .merge(&peer(), 0.0, 1, &[entry(1, 600)], now)
            .is_empty());

        let p = peer();
        let out = table.outgoing(&p, now);
        assert_eq!(out.len(), 1);
        let BlobMessage::Wanted { hops, entries } = &out[0] else {
            panic!("not a Wanted");
        };
        assert_eq!(*hops, 2, "forwarded with one hop less");
        assert_eq!(entries.len(), 2);
        let lifetimes: HashSet<u32> = entries.iter().map(|e| e.lifetime_s).collect();
        // forwarded lifetimes are clamped to the own lifetime
        assert!(lifetimes.contains(&600) && lifetimes.contains(&3600));
        // nothing new for the same peer, everything for another
        assert!(table.outgoing(&p, now).is_empty());
        assert_eq!(table.outgoing(&peer(), now).len(), 1);

        // an entry received with one hop left is kept, not forwarded
        table.merge(&peer(), 0.0, 1, &[entry(7, 60)], now);
        assert!(table.contains(&[7; WANTED_SEEKER_LEN], now));
        let q = peer();
        let all: Vec<Seeker> = table
            .outgoing(&q, now)
            .into_iter()
            .flat_map(|m| match m {
                BlobMessage::Wanted { entries, .. } => entries.into_iter().map(|e| e.seeker),
                _ => unreachable!(),
            })
            .collect();
        assert!(!all.contains(&[7; WANTED_SEEKER_LEN]));

        // entries expire
        let later = UnixMillis(now.as_millis() + 700_000);
        assert!(!table.contains(&[1; WANTED_SEEKER_LEN], later));
    }

    #[test]
    fn entries_are_not_echoed_and_small_renewals_are_not_resent() {
        let table = WantedTable::new(MeshConfig::phone());
        let now = UnixMillis(1_000_000);
        let (from, other) = (peer(), peer());
        table.merge(&from, 0.0, 5, &[entry(1, 600)], now);
        assert!(
            table.outgoing(&from, now).is_empty(),
            "not echoed to its sender"
        );
        assert_eq!(table.outgoing(&other, now).len(), 1);
        // the sender pushes it a few seconds later: no new traffic either way
        let later = UnixMillis(now.as_millis() + 2_000);
        table.merge(&from, 0.0, 5, &[entry(1, 600)], later);
        assert!(table.outgoing(&other, later).is_empty());
        // a real renewal travels again
        table.merge(&from, 0.0, 5, &[entry(1, 1200)], later);
        assert_eq!(table.outgoing(&other, later).len(), 1);
    }

    #[test]
    fn own_entries_get_random_hops_renew_and_leave() {
        let table = WantedTable::new(MeshConfig::phone());
        let now = UnixMillis(5_000_000);
        let s = [9u8; WANTED_SEEKER_LEN];
        table.set_own(&[s], now);
        let BlobMessage::Wanted { hops, entries } = table.outgoing(&peer(), now).remove(0) else {
            panic!();
        };
        assert!((24..=32).contains(&hops));
        assert_eq!(entries[0].lifetime_s, 3600);
        table.set_own(&[], now);
        assert!(!table.contains(&s, now), "dropped by the app");
    }

    fn no_spray() -> MeshConfig {
        MeshConfig {
            spray_permille: 0,
            ..MeshConfig::phone()
        }
    }

    fn signed_beacon(now: UnixMillis, lifetime_s: u32) -> Beacon {
        Beacon::sign(&KeyPair::generate(0).unwrap(), now.as_millis(), lifetime_s).unwrap()
    }

    #[test]
    fn guided_forwarding_follows_the_best_directions_and_beacons() {
        let parts = MeshParts::new(MeshConfig {
            route_fanout: 1,
            ..no_spray()
        });
        let now = UnixMillis(10_000_000);
        let (near, far, other, bridge_side) = (peer(), peer(), peer(), peer());
        let seeker = [0x20u8; WANTED_SEEKER_LEN];
        parts.wanted.merge(&far, 0.0, 10, &[entry(0x20, 600)], now);
        parts.wanted.merge(&near, 0.0, 20, &[entry(0x20, 600)], now);
        let beacon = signed_beacon(now, 600);
        assert!(parts.wanted.merge_beacon(
            &bridge_side,
            0.0,
            30,
            &beacon,
            now,
            BEACON_MAX_FUTURE_MS
        ));
        let info = |key: Vec<u8>, created_at: u64| BlobInfo {
            scope: Scope::MESH,
            size: 4000,
            kind: BlobKind::KeyValue,
            key,
            created_at,
        };
        let bridges = parts.bridge_direction(now);
        assert_eq!(bridges, vec![bridge_side]);
        let old = now.as_millis() - 60_000;
        let wanted = info(seeker.to_vec(), old);
        assert!(parts.guided_allows(&wanted, &near, &bridges, now));
        assert!(!parts.guided_allows(&wanted, &far, &bridges, now));
        assert!(!parts.guided_allows(&wanted, &other, &bridges, now));
        // nobody wants it: toward the bridge only
        let unwanted = info(vec![0x20; 33].into_iter().chain([9]).collect(), old);
        assert!(parts.guided_allows(&unwanted, &bridge_side, &bridges, now));
        assert!(!parts.guided_allows(&unwanted, &near, &bridges, now));
        // still young: everywhere
        let young = info(seeker.to_vec(), now.as_millis() - 1_000);
        assert!(parts.guided_allows(&young, &other, &bridges, now));
        // announcements are not guided
        let mut bulletin = info(Vec::new(), old);
        bulletin.kind = BlobKind::Bulletin;
        assert!(parts.guided_allows(&bulletin, &other, &bridges, now));
        // the advertiser goes away: next best
        parts.wanted.remove_peer(&near);
        assert!(parts.guided_allows(&wanted, &far, &bridges, now));
        // our own beacon is not a direction, and set_own keeps it
        parts.wanted.set_beacon(Some(signed_beacon(now, 600)), now);
        assert!(parts.wanted.is_bridge());
        assert!(parts.bridge_direction(now).is_empty());
        parts.wanted.set_own(&[], now);
        assert!(parts.wanted.is_bridge());
        assert_eq!(parts.wanted.bridge_peers(now), vec![bridge_side]);
        parts.wanted.set_beacon(None, now);
        assert!(!parts.wanted.is_bridge());
    }

    #[test]
    fn a_huge_hop_budget_does_not_capture_a_seeker_or_the_bridge_path() {
        let parts = MeshParts::new(no_spray());
        let now = UnixMillis(10_000_000);
        let (honest, liar) = (peer(), peer());
        let seeker = [0x20u8; WANTED_SEEKER_LEN];
        parts
            .wanted
            .merge(&honest, 0.0, 30, &[entry(0x20, 600)], now);
        // the liar copies the seeker with the largest budget the wire allows
        parts
            .wanted
            .merge(&liar, 0.0, 255, &[entry(0x20, 600)], now);
        let best = parts.wanted.best_peers(&seeker, now).unwrap();
        assert!(best.contains(&honest), "the honest direction stays in use");
        // and what it forwards is clamped too
        let BlobMessage::Wanted { hops, .. } = parts.wanted.outgoing(&peer(), now).remove(0) else {
            panic!("not a Wanted");
        };
        assert_eq!(hops, MeshConfig::phone().max_hops() - 1);
        // the same with a real bridge's beacon replayed with a huge budget
        let beacon = signed_beacon(now, 600);
        parts
            .wanted
            .merge_beacon(&honest, 0.0, 20, &beacon, now, BEACON_MAX_FUTURE_MS);
        parts
            .wanted
            .merge_beacon(&liar, 0.0, 255, &beacon, now, BEACON_MAX_FUTURE_MS);
        assert!(parts.bridge_direction(now).contains(&honest));
    }

    #[test]
    fn beacons_only_travel_signed() {
        let table = WantedTable::new(MeshConfig::phone());
        let now = UnixMillis(10_000_000);
        // a beacon seeker in a plain Wanted entry is ignored
        table.merge(
            &peer(),
            0.0,
            30,
            &[WantedEntry {
                seeker: beacon_seeker(&[7; 32]),
                lifetime_s: 600,
                local: false,
            }],
            now,
        );
        assert!(table.bridge_peers(now).is_empty());
        // a tampered beacon fails its signature
        let mut beacon = signed_beacon(now, 600);
        assert!(beacon.verify());
        beacon.lifetime_s += 1;
        assert!(!beacon.verify());
        // expired, far future or overlong beacons are ignored
        let p = peer();
        let old = signed_beacon(UnixMillis(now.as_millis() - 700_000), 600);
        assert!(!table.merge_beacon(&p, 0.0, 30, &old, now, BEACON_MAX_FUTURE_MS));
        let ahead = signed_beacon(UnixMillis(now.as_millis() + 3_600_000), 600);
        assert!(!table.merge_beacon(&p, 0.0, 30, &ahead, now, BEACON_MAX_FUTURE_MS));
        let long = signed_beacon(now, 3600);
        assert!(!table.merge_beacon(&p, 0.0, 30, &long, now, BEACON_MAX_FUTURE_MS));
        // a good one is forwarded as a Beacon message with one hop less
        let good = signed_beacon(now, 600);
        assert!(table.merge_beacon(&p, 0.0, 30, &good, now, BEACON_MAX_FUTURE_MS));
        let out = table.outgoing(&peer(), now);
        assert!(out.iter().any(|m| matches!(
            m,
            BlobMessage::Beacon { hops: 29, beacon } if **beacon == good
        )));
    }

    #[test]
    fn a_flooder_only_evicts_its_own_entries() {
        let table = WantedTable::new(MeshConfig {
            max_wanted_entries: 100,
            ..MeshConfig::phone()
        });
        let now = UnixMillis(1_000_000);
        let honest: Vec<PeerId> = (0..4).map(|_| peer()).collect();
        let seeker = |n: u32, tag: u8| {
            let mut s = [tag; WANTED_SEEKER_LEN];
            s[1..5].copy_from_slice(&n.to_be_bytes());
            WantedEntry {
                seeker: s,
                lifetime_s: 600,
                local: false,
            }
        };
        let mut honest_seekers = Vec::new();
        for (i, p) in honest.iter().enumerate() {
            let entries: Vec<_> = (0..10).map(|n| seeker(n, 0x21 + i as u8)).collect();
            honest_seekers.extend(entries.iter().map(|e| e.seeker));
            table.merge(p, 0.0, 20, &entries, now);
        }
        // a flooder sends far more, with the longest lifetime the wire allows
        let flooder = peer();
        for round in 0..10u32 {
            let entries: Vec<_> = (0..256)
                .map(|n| {
                    let mut e = seeker(round * 256 + n, 0x30);
                    e.lifetime_s = MAX_WANTED_LIFETIME_S;
                    e
                })
                .collect();
            table.merge(&flooder, 0.0, 20, &entries, now);
        }
        assert!(table.len() <= 100);
        for s in &honest_seekers {
            assert!(table.contains(s, now), "honest entries survive the flood");
        }
    }

    #[test]
    fn a_summary_marks_what_the_peer_holds_as_well_or_better() {
        let table = WantedTable::new(MeshConfig::phone());
        let (from, peer) = (peer(), peer());
        let now = UnixMillis(1_000_000_000);
        let (same, worse, renewed, unknown, tie) = (
            entry(1, 3600),
            entry(2, 3600),
            entry(3, 3600),
            entry(4, 3600),
            entry(5, 3600),
        );
        table.merge(&from, 0.0, 11, &[same, worse, renewed, unknown, tie], now);
        // our budget is 10 for all; units of 120 s
        let items = table.summary_items(now);
        assert!(items.iter().all(|(_, h, u, l)| *h == 10 && *u == 30 && !*l));
        let recorded = table.apply_summary(&peer, now, |s, _| match s[0] {
            1 => Some((10, 30)), // holds it as well
            2 => Some((8, 30)),  // two hops fewer: ours is a better direction, it travels
            5 => Some((9, 30)),  // one hop fewer: ours only ties its best direction
            3 => Some((10, 20)), // holds it, but ours expires 20 min later: a renewal
            _ => None,
        });
        assert_eq!(recorded, 3);
        let sent: Vec<u8> = table
            .outgoing(&peer, now)
            .into_iter()
            .flat_map(|m| match m {
                BlobMessage::Wanted { entries, .. } => {
                    entries.into_iter().map(|e| e.seeker[0]).collect::<Vec<_>>()
                }
                _ => Vec::new(),
            })
            .collect::<std::collections::BTreeSet<_>>()
            .into_iter()
            .collect();
        assert_eq!(sent, vec![2, 3, 4]);
    }

    #[test]
    fn the_table_is_capped_keeping_own_entries() {
        let table = WantedTable::new(MeshConfig {
            max_wanted_entries: 3,
            ..MeshConfig::phone()
        });
        let now = UnixMillis(1_000);
        table.set_own(&[[200; WANTED_SEEKER_LEN]], now);
        table.merge(
            &peer(),
            0.0,
            5,
            &[entry(1, 10), entry(2, 20), entry(3, 30)],
            now,
        );
        // over the cap: down to 90 % of it (2 entries), own kept
        assert_eq!(table.len(), 2);
        assert!(table.contains(&[200; WANTED_SEEKER_LEN], now));
        assert!(
            !table.contains(&[1; WANTED_SEEKER_LEN], now),
            "expires first"
        );
    }

    #[test]
    fn local_only_entries_travel_flagged_and_a_regular_one_wins() {
        let table = WantedTable::new(MeshConfig::phone());
        let (from, to) = (peer(), peer());
        let now = UnixMillis(1_000_000_000);
        let local = |n: u8| WantedEntry {
            local: true,
            ..entry(n, 3600)
        };
        // own: one regular, one local-only; relayed: one local-only
        table.set_own_entries(
            &[
                ([1; WANTED_SEEKER_LEN], false),
                ([2; WANTED_SEEKER_LEN], true),
            ],
            now,
        );
        table.merge(&from, 0.0, 10, &[local(3)], now);
        let upstream: Vec<u8> = table.upstream_seekers(now).iter().map(|s| s[0]).collect();
        assert_eq!(upstream, vec![1]);
        let flags: HashMap<u8, bool> = table
            .outgoing(&to, now)
            .into_iter()
            .flat_map(|m| match m {
                BlobMessage::Wanted { entries, .. } => entries,
                _ => Vec::new(),
            })
            .map(|e| (e.seeker[0], e.local))
            .collect();
        assert!(!flags[&1]);
        assert!(flags[&2] && flags[&3]);
        // somebody wants 3 as a regular entry: it is fetched, and sent again unflagged
        table.merge(&peer(), 0.0, 10, &[entry(3, 3600)], now);
        assert!(!table.is_local(&[3; WANTED_SEEKER_LEN]));
        let mut upstream: Vec<u8> = table.upstream_seekers(now).iter().map(|s| s[0]).collect();
        upstream.sort_unstable();
        assert_eq!(upstream, vec![1, 3]);
        let again: Vec<(u8, bool)> = table
            .outgoing(&to, now)
            .into_iter()
            .flat_map(|m| match m {
                BlobMessage::Wanted { entries, .. } => entries,
                _ => Vec::new(),
            })
            .map(|e| (e.seeker[0], e.local))
            .collect();
        assert_eq!(again, vec![(3, false)]);
        // a local-only copy of a regular entry does not make it local
        table.merge(&peer(), 0.0, 10, &[local(1)], now);
        assert!(!table.is_local(&[1; WANTED_SEEKER_LEN]));
        // a summary only hides entries the peer holds with the same flag
        let items = table.summary_items(now);
        assert!(items.iter().any(|(s, _, _, l)| s[0] == 2 && *l));
        assert_ne!(
            wanted_summary_item(&[2; WANTED_SEEKER_LEN], true),
            wanted_summary_item(&[2; WANTED_SEEKER_LEN], false)
        );
    }
}
