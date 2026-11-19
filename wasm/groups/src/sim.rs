//! Deterministic simulation of the devices of one epoch (test only).
//!
//! Each run is fully determined by its seed: N devices with skewed clocks publish messages,
//! edits, deletions (immediate and scheduled) and retries; every event travels as an encoded
//! blob through a simulated network that delays, reorders, duplicates, loses and later
//! redelivers it, and devices relay events they serve. After delivery completes the run checks:
//!
//! 1. **convergence**: every device holds the same current objects, tips and visible view;
//! 2. **order independence**: replaying every blob in two random orders on fresh devices gives
//!    identical stores, and the same results as the simulated devices;
//! 3. **pruning**: evicting events, then receiving everything again, never changes a result.
//!
//! Environment variables (local runs; the default run takes a few seconds):
//!
//! - `GROUPS_SIM_SEED=<n>`: replay one seed;
//! - `GROUPS_SIM_SEEDS=<n>`: run seeds `GROUPS_SIM_FIRST` (default 0) to `+ n`;
//! - `GROUPS_SIM_STEPS=<n>`: steps per run (default 160).

use std::collections::BTreeMap;
use std::sync::OnceLock;

use crate::constants::RETENTION_MS;
use crate::display::view;
use crate::epoch::{Epoch, GroupState, Outcome, Sender, check_invariants};
use crate::event::Body;
use crate::ids::{ChatId, EventId, GossipId, SyncObjId};
use crate::rng::TestRng;
use crate::root::Root;
use crate::root::tests::founding;
use crate::store::{MemoryStorage, StorageRead, StoredResult};
use crate::test_support::{Identity, identity};
use crate::wire::{self, EventObject};

const START: u64 = 1_700_000_000_000;
const SECOND: u64 = 1_000;
const MINUTE: u64 = 60 * SECOND;
const HOUR: u64 = 60 * MINUTE;
const MAX_DEVICES: usize = 4;

fn identities() -> &'static Vec<Identity> {
    static IDS: OnceLock<Vec<Identity>> = OnceLock::new();
    IDS.get_or_init(|| (1..=MAX_DEVICES as u8).map(identity).collect())
}

fn roots() -> &'static Vec<Root> {
    // The root of an epoch of the first n identities, for n = 1..=MAX_DEVICES.
    static ROOTS: OnceLock<Vec<Root>> = OnceLock::new();
    ROOTS.get_or_init(|| {
        let ids = identities();
        (1..=MAX_DEVICES)
            .map(|n| {
                let members: Vec<&Identity> = ids[..n].iter().collect();
                founding(&ids[0], &members)
            })
            .collect()
    })
}

struct Device {
    id: GossipId,
    store: MemoryStorage,
    /// Clock offset from the global clock, in ms.
    skew: i64,
}

struct Packet {
    at: u64,
    seq: u64,
    from: usize,
    to: usize,
    blob: Vec<u8>,
}

struct Sim {
    rng: TestRng,
    now: u64,
    root: &'static Root,
    devices: Vec<Device>,
    queue: Vec<Packet>,
    seq: u64,
    /// Every blob ever sent, for the replay checks.
    log: Vec<Vec<u8>>,
    steps: usize,
}

fn below(rng: &mut TestRng, n: u64) -> u64 {
    crate::rng::uniform_below(rng, usize::try_from(n).expect("small")) as u64
}

fn chance(rng: &mut TestRng, percent: u64) -> bool {
    below(rng, 100) < percent
}

impl Sim {
    fn new(seed: u64, steps: usize) -> Self {
        let mut rng = TestRng::new(seed);
        let n = 2 + below(&mut rng, (MAX_DEVICES - 1) as u64) as usize;
        let root = &roots()[n - 1];
        let devices = (0..n)
            .map(|i| {
                // Mostly small skews; sometimes beyond the 5-minute admission bound.
                let range = if chance(&mut rng, 20) {
                    16 * MINUTE
                } else {
                    4 * MINUTE
                };
                let skew = below(&mut rng, range) as i64 - (range / 2) as i64;
                Device {
                    id: identities()[i].id,
                    store: MemoryStorage::new(),
                    skew,
                }
            })
            .collect();
        Self {
            rng,
            now: START,
            root,
            devices,
            queue: Vec::new(),
            seq: 0,
            log: Vec::new(),
            steps,
        }
    }

    fn epoch(&self) -> Epoch<'static> {
        Epoch::new(self.root, true, GroupState::Active)
    }

    fn chat(&self) -> ChatId {
        self.root.chat_id()
    }

    fn clock(&self, d: usize) -> u64 {
        self.now.saturating_add_signed(self.devices[d].skew)
    }

    fn send(&mut self, from: usize, to: usize, blob: Vec<u8>) {
        let delay = if chance(&mut self.rng, 10) {
            below(&mut self.rng, 20 * MINUTE)
        } else {
            below(&mut self.rng, 30 * SECOND)
        };
        // Loss, then a redelivery much later (a scan or a retry finds it again).
        let delay = if chance(&mut self.rng, 5) {
            delay + HOUR + below(&mut self.rng, 47 * HOUR)
        } else {
            delay
        };
        self.seq += 1;
        self.queue.push(Packet {
            at: self.now + delay,
            seq: self.seq,
            from,
            to,
            blob: blob.clone(),
        });
        if chance(&mut self.rng, 10) {
            self.seq += 1;
            let at = self.now + below(&mut self.rng, 2 * HOUR);
            self.queue.push(Packet {
                at,
                seq: self.seq,
                from,
                to,
                blob,
            });
        }
    }

    fn broadcast(&mut self, from: usize, blob: Vec<u8>) {
        self.log.push(blob.clone());
        for to in 0..self.devices.len() {
            if to != from {
                self.send(from, to, blob.clone());
            }
        }
    }

    fn deliver_due(&mut self) {
        loop {
            let Some(pos) = self
                .queue
                .iter()
                .enumerate()
                .filter(|(_, p)| p.at <= self.now)
                .min_by_key(|(_, p)| (p.at, p.seq))
                .map(|(i, _)| i)
            else {
                return;
            };
            let p = self.queue.swap_remove(pos);
            self.deliver(p);
        }
    }

    fn deliver(&mut self, p: Packet) {
        let now = self.clock(p.to);
        let sender = Sender::Peer {
            id: self.devices[p.from].id,
            removed: false,
        };
        let epoch = self.epoch();
        let chat = self.chat();
        let device = &mut self.devices[p.to];
        let outcome = epoch
            .receive_blob(&mut device.store, sender, &p.blob, 1, now)
            .expect("memory storage");
        check_invariants(&device.store, &chat, now).expect("invariants after a delivery");
        match outcome {
            Outcome::Rejected(r) => panic!("an honest event was rejected: {r:?}"),
            Outcome::TemporarilyInvalid => {
                // A later notice or scan reactivates retrieval (§9.6).
                self.seq += 1;
                let at = self.now + 5 * MINUTE + below(&mut self.rng, 10 * MINUTE);
                self.queue.push(Packet {
                    at,
                    seq: self.seq,
                    ..p
                });
            }
            _ => {}
        }
    }

    fn objects_where(&self, d: usize, f: impl Fn(&Option<StoredResult>) -> bool) -> Vec<SyncObjId> {
        self.devices[d]
            .store
            .objects(&self.chat())
            .unwrap()
            .into_iter()
            .filter(|o| f(&o.current))
            .map(|o| o.sync_obj_id)
            .collect()
    }

    fn pick(&mut self, items: &[SyncObjId]) -> Option<SyncObjId> {
        if items.is_empty() {
            None
        } else {
            Some(items[below(&mut self.rng, items.len() as u64) as usize])
        }
    }

    fn schedule(&mut self, now: u64) -> Option<u64> {
        if chance(&mut self.rng, 25) {
            Some(now + 1 + below(&mut self.rng, 3 * HOUR))
        } else {
            None
        }
    }

    fn step(&mut self) {
        let d = below(&mut self.rng, self.devices.len() as u64) as usize;
        let now = self.clock(d);
        let epoch = self.epoch();
        let roll = below(&mut self.rng, 100);
        let published = match roll {
            0..=24 => {
                let body = Body::Text(format!("m{}", self.rng.next_u64() % 1000));
                let at = self.schedule(now);
                let author = self.devices[d].id;
                let device = &mut self.devices[d];
                epoch
                    .publish_message(
                        &mut device.store,
                        now,
                        &mut self.rng,
                        author,
                        body,
                        BTreeMap::new(),
                        at,
                    )
                    .ok()
            }
            25..=44 => {
                let live = self.objects_where(d, |c| matches!(c, Some(StoredResult::Content(_))));
                let at = self.schedule(now);
                // Several edits may share a body, which exercises identical results.
                let body = Body::Text(format!("e{}", self.rng.next_u64() % 4));
                self.pick(&live).and_then(|sync| {
                    let device = &mut self.devices[d];
                    epoch
                        .publish_edit(
                            &mut device.store,
                            now,
                            &mut self.rng,
                            sync,
                            body,
                            BTreeMap::new(),
                            at,
                        )
                        .ok()
                })
            }
            45..=54 => {
                let alive = self.objects_where(d, |c| !matches!(c, Some(StoredResult::Tombstone)));
                let at = if chance(&mut self.rng, 40) {
                    Some(now + 1 + below(&mut self.rng, 3 * HOUR))
                } else {
                    None
                };
                self.pick(&alive).and_then(|sync| {
                    let device = &mut self.devices[d];
                    epoch
                        .publish_deletion(&mut device.store, now, &mut self.rng, sync, at)
                        .ok()
                })
            }
            55..=59 => {
                let any = self.objects_where(d, Option::is_some);
                self.pick(&any).and_then(|sync| {
                    let device = &mut self.devices[d];
                    epoch
                        .retry(&mut device.store, now, &mut self.rng, sync)
                        .ok()
                })
            }
            60..=69 => {
                self.relay(d, now);
                None
            }
            70..=89 => {
                self.now += 1 + below(&mut self.rng, 5 * MINUTE);
                None
            }
            _ => {
                self.now += below(&mut self.rng, 6 * HOUR);
                None
            }
        };
        if let Some(p) = published {
            // A successful operation applied what was due at `now`.
            check_invariants(&self.devices[d].store, &self.chat(), now).expect("invariants");
            let blob = wire::encode_event_blob(&EventObject::Message(p.event)).unwrap();
            self.broadcast(d, blob);
        }
        self.deliver_due();
    }

    /// Device `d` serves one of its available events to another device, encoded from its
    /// store under the event's own version (§13.1).
    fn relay(&mut self, d: usize, now: u64) {
        let rows = self.devices[d].store.event_rows(&self.chat()).unwrap();
        let available: Vec<EventId> = rows
            .iter()
            .filter(|r| r.available(now))
            .map(|r| r.event_id)
            .collect();
        if available.is_empty() || self.devices.len() < 2 {
            return;
        }
        let id = available[below(&mut self.rng, available.len() as u64) as usize];
        let event = self
            .epoch()
            .serve(&self.devices[d].store, &id, now)
            .unwrap()
            .expect("available");
        let blob = wire::encode_event_blob(&EventObject::Message(event)).unwrap();
        let mut to = below(&mut self.rng, self.devices.len() as u64 - 1) as usize;
        if to >= d {
            to += 1;
        }
        self.log.push(blob.clone());
        self.send(d, to, blob);
    }

    fn drain(&mut self) {
        while let Some(at) = self.queue.iter().map(|p| p.at).min() {
            self.now = self.now.max(at);
            self.deliver_due();
        }
    }

    fn tick_all(&mut self) {
        let epoch = self.epoch();
        for i in 0..self.devices.len() {
            let now = self.clock(i);
            epoch.tick(&mut self.devices[i].store, now).unwrap();
        }
    }
}

/// What must agree between devices.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Snapshot {
    results: BTreeMap<SyncObjId, Option<StoredResult>>,
    view: Vec<(SyncObjId, u64, [u8; 32])>,
    tips: Vec<EventId>,
    /// Every available (servable) event: stronger than the tips.
    available: Vec<EventId>,
}

fn snapshot(store: &MemoryStorage, root: &Root, now: u64) -> Snapshot {
    let chat = root.chat_id();
    let results = store
        .objects(&chat)
        .unwrap()
        .into_iter()
        .map(|o| (o.sync_obj_id, o.current))
        .collect();
    let view = view(store, &[chat], now)
        .unwrap()
        .into_iter()
        .map(|m| (m.sync_obj_id(), m.content.created_at, m.result_hash))
        .collect();
    let tips = Epoch::new(root, true, GroupState::Active)
        .tips(store, now)
        .unwrap()
        .into_iter()
        .collect();
    let available = store
        .event_rows(&chat)
        .unwrap()
        .into_iter()
        .filter(|r| r.available(now))
        .map(|r| r.event_id)
        .collect();
    Snapshot {
        results,
        view,
        tips,
        available,
    }
}

fn replay(sim: &Sim, order_seed: u64, now: u64) -> MemoryStorage {
    let mut rng = TestRng::new(order_seed);
    let mut blobs = sim.log.clone();
    for i in (1..blobs.len()).rev() {
        let j = below(&mut rng, i as u64 + 1) as usize;
        blobs.swap(i, j);
    }
    let mut store = MemoryStorage::new();
    let sender = Sender::Peer {
        id: sim.devices[0].id,
        removed: false,
    };
    for blob in &blobs {
        let out = sim
            .epoch()
            .receive_blob(&mut store, sender, blob, 1, now)
            .unwrap();
        assert!(
            !matches!(out, Outcome::Rejected(_) | Outcome::TemporarilyInvalid),
            "replay: {out:?}"
        );
    }
    check_invariants(&store, &sim.chat(), now).expect("replay invariants");
    store
}

type FullState = (
    Vec<crate::store::EventRow>,
    Vec<(EventId, Vec<EventId>)>,
    Vec<crate::store::ObjectRecord>,
);

fn full_state(store: &MemoryStorage, chat: &ChatId) -> FullState {
    (
        store.event_rows(chat).unwrap(),
        store.edges(chat).unwrap(),
        store.objects(chat).unwrap(),
    )
}

fn assert_same(a: &Snapshot, b: &Snapshot, label: &str) {
    assert_eq!(a.results, b.results, "{label}: current results differ");
    assert_eq!(a.view, b.view, "{label}: visible views differ");
    assert_eq!(a.tips, b.tips, "{label}: tips differ");
    assert_eq!(a.available, b.available, "{label}: available events differ");
}

fn check_convergence(sim: &mut Sim, label: &str) {
    sim.tick_all();
    // Every device is compared at the same global instant; skews are a few minutes and
    // nothing is due or expires within them at the checkpoints of `run`.
    let at = sim.now;
    let first = snapshot(&sim.devices[0].store, sim.root, at);
    for (i, d) in sim.devices.iter().enumerate() {
        check_invariants(&d.store, &sim.chat(), sim.clock(i)).expect("invariants");
        let s = snapshot(&d.store, sim.root, at);
        assert_same(&s, &first, &format!("{label}, device {i} against device 0"));
    }
}

fn run(seed: u64, steps: usize) {
    let mut sim = Sim::new(seed, steps);
    for _ in 0..sim.steps {
        sim.step();
    }
    sim.drain();
    // Past every scheduled time (at most 3 hours ahead) and every redelivery.
    sim.now += 4 * HOUR;
    sim.drain();
    check_convergence(&mut sim, "after delivery");

    // Order independence on fresh devices, at one instant: identical stores.
    let now = sim.now;
    let a = replay(&sim, seed ^ 0xa5a5, now);
    let b = replay(&sim, seed ^ 0x5a5a, now);
    assert_eq!(
        full_state(&a, &sim.chat()),
        full_state(&b, &sim.chat()),
        "replay orders differ"
    );
    assert_same(
        &snapshot(&a, sim.root, now),
        &snapshot(&sim.devices[0].store, sim.root, now),
        "replay against device 0",
    );

    // Pruning never changes a result, not even after everything arrives again.
    let before = snapshot(&sim.devices[0].store, sim.root, now);
    let mut pruned = sim.devices[0].store.clone();
    let epoch = sim.epoch();
    let k = 1 + below(&mut sim.rng, 8) as usize;
    epoch.evict(&mut pruned, now, k).unwrap();
    check_invariants(&pruned, &sim.chat(), now).expect("invariants after eviction");
    let after = snapshot(&pruned, sim.root, now);
    assert_eq!(before.results, after.results, "eviction changed a result");
    assert_eq!(before.view, after.view, "eviction changed the view");
    let sender = Sender::Peer {
        id: sim.devices[1].id,
        removed: false,
    };
    for blob in &sim.log {
        epoch
            .receive_blob(&mut pruned, sender, blob, 1, now)
            .unwrap();
    }
    check_invariants(&pruned, &sim.chat(), now).expect("invariants after redelivery");
    let again = snapshot(&pruned, sim.root, now);
    assert_eq!(before.results, again.results, "redelivery changed a result");
    assert_eq!(before.view, again.view, "redelivery changed the view");

    // After every window has closed: results stay, nothing is served.
    sim.now += RETENTION_MS + HOUR;
    check_convergence(&mut sim, "after retention");
    for (i, d) in sim.devices.iter().enumerate() {
        assert!(
            sim.epoch().tips(&d.store, sim.clock(i)).unwrap().is_empty(),
            "device {i} still serves after retention"
        );
    }
}

fn env_u64(name: &str) -> Option<u64> {
    std::env::var(name).ok().map(|v| {
        v.trim()
            .parse()
            .unwrap_or_else(|_| panic!("{name} must be an integer"))
    })
}

#[test]
fn simulation() {
    let steps = env_u64("GROUPS_SIM_STEPS").map_or(160, |s| s as usize);
    let seeds: Vec<u64> = match env_u64("GROUPS_SIM_SEED") {
        Some(seed) => vec![seed],
        None => {
            let first = env_u64("GROUPS_SIM_FIRST").unwrap_or(0);
            let count = env_u64("GROUPS_SIM_SEEDS").unwrap_or(12);
            (first..first + count).collect()
        }
    };
    for seed in seeds {
        let result = std::panic::catch_unwind(|| run(seed, steps));
        if let Err(panic) = result {
            eprintln!(
                "simulation failed with seed {seed} ({steps} steps); replay with \
                 GROUPS_SIM_SEED={seed} GROUPS_SIM_STEPS={steps} cargo test -p groups simulation"
            );
            std::panic::resume_unwind(panic);
        }
    }
}
