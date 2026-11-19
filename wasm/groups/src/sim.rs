//! Deterministic simulation of the devices of one epoch (test only).
//!
//! Each run is fully determined by its seed: N devices publish messages (text, forwards,
//! reactions and media, with or without metadata), edits, deletions (immediate and scheduled
//! up to `MAX_SCHEDULE`) and retries; every event travels as an encoded blob through a
//! simulated network that delays, reorders, duplicates, loses and later redelivers it, and
//! devices relay events they serve. During the run, device clocks jump forward and backward,
//! commits fail by injection, some devices evict under storage pressure or make local-only
//! edits and deletions, and members act adversarially: cycles of parents, bursts of more than
//! 16 tips, the same ID with another payload or other parents, and events old enough to
//! arrive after their window.
//!
//! Devices are **clean** (device 0 always) or **flagged** to evict or to make local-only
//! changes. Checks:
//!
//! 1. after every operation, the records and their indexes are consistent; an injected
//!    commit failure leaves the store unchanged and the operation is retried;
//! 2. the view computed without a tick equals the view after one;
//! 3. a local-only change withdraws every content event of the message (§9.3), and those
//!    events are never served again unless they carry the current result;
//! 4. **convergence**: at a common instant past every due time, all clean devices hold the
//!    same **full store** (rows in their stored form, edges, objects); evicting devices hold
//!    the same results and view;
//! 5. **order independence**: replaying every blob in two random orders, at instants spread
//!    across activation times and windows, on fresh devices gives the same full store as each
//!    other and as device 0;
//! 6. **pruning**: evicting events, then receiving everything again, never changes a result.
//!
//! The run counts the situations it is meant to exercise ([`Counters`]); the default test
//! asserts that each occurred at least once across its seeds.
//!
//! Environment variables (local runs; the default run takes a few seconds):
//!
//! - `GROUPS_SIM_SEED=<n>`: replay one seed;
//! - `GROUPS_SIM_SEEDS=<n>`: run seeds `GROUPS_SIM_FIRST` (default 0) to `+ n`;
//! - `GROUPS_SIM_STEPS=<n>`: steps per run (default 160).

use std::collections::{BTreeMap, BTreeSet};
use std::sync::OnceLock;

use crate::constants::{MAX_SCHEDULE_MS, RETENTION_MS};
use crate::display::view;
use crate::epoch::local::{ChangeError, LocalEdit, Published};
use crate::epoch::{Epoch, GroupState, Outcome, Received, Sender, check_invariants};
use crate::event::{Body, Content, MessageEvent, MessageType, Payload};
use crate::ids::{ChatId, EventId, GossipId, SyncObjId};
use crate::rng::{TestRng, bytes};
use crate::root::Root;
use crate::root::tests::founding;
use crate::store::{
    EventRow, MemoryStorage, ObjectRecord, StorageError, StorageRead, StoredResult, in_window,
};
use crate::test_support::{Identity, Instrumented, identity};
use crate::wire::{self, EventObject};

const START: u64 = 1_700_000_000_000;
const SECOND: u64 = 1_000;
const MINUTE: u64 = 60 * SECOND;
const HOUR: u64 = 60 * MINUTE;
const DAY: u64 = 24 * HOUR;
const MAX_DEVICES: usize = 4;
/// The bounds of a device's clock offset after jumps.
const MIN_SKEW: i64 = -3 * HOUR as i64;
const MAX_SKEW: i64 = DAY as i64;

type Store = Instrumented<MemoryStorage>;

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

/// How often each situation the simulation is meant to exercise occurred.
#[derive(Debug, Clone, Default)]
pub(crate) struct Counters {
    /// Events accepted after their availability window had ended.
    late_arrivals: u64,
    /// `Restored` outcomes (§9.5).
    restored: u64,
    /// Events evicted during a run (§8.2).
    evicted: u64,
    /// Temporary-rejection markers evicted during a run (§9.6).
    markers_evicted: u64,
    /// Events scheduled more than a week ahead (up to `MAX_SCHEDULE`).
    long_schedules: u64,
    /// Device clock jumps forward and backward.
    clock_forward: u64,
    clock_backward: u64,
    /// Temporary rejections (§9.6).
    temporarily_invalid: u64,
    /// Cycles of parents created by an adversary.
    cycles: u64,
    /// Publications that found more than 16 tips (§6.1).
    many_tips: u64,
    /// The same ID received with another payload, or with other parents.
    other_payload: u64,
    other_parents: u64,
    /// Bodies other than text, and messages with metadata.
    non_text_bodies: u64,
    metadata: u64,
    /// Local-only edits and deletions (§9.1, §9.2), and those refused as dated later than
    /// now (D.34; informational, rare).
    local_edits: u64,
    local_deletes: u64,
    local_edits_refused: u64,
    /// Injected commit failures, each followed by a retry.
    injected_failures: u64,
    /// Scheduled deletions arriving for a message already deleted.
    deletions_beside_tombstone: u64,
}

impl Counters {
    fn add(&mut self, o: &Counters) {
        macro_rules! sum {
            ($($f:ident),*) => { $( self.$f += o.$f; )* };
        }
        sum!(
            late_arrivals,
            restored,
            evicted,
            markers_evicted,
            long_schedules,
            clock_forward,
            clock_backward,
            temporarily_invalid,
            cycles,
            many_tips,
            other_payload,
            other_parents,
            non_text_bodies,
            metadata,
            local_edits,
            local_deletes,
            local_edits_refused,
            injected_failures,
            deletions_beside_tombstone
        );
    }

    /// The names of the counters that stayed at zero.
    fn missing(&self) -> Vec<&'static str> {
        let all = [
            ("late_arrivals", self.late_arrivals),
            ("restored", self.restored),
            ("evicted", self.evicted),
            ("markers_evicted", self.markers_evicted),
            ("long_schedules", self.long_schedules),
            ("clock_forward", self.clock_forward),
            ("clock_backward", self.clock_backward),
            ("temporarily_invalid", self.temporarily_invalid),
            ("cycles", self.cycles),
            ("many_tips", self.many_tips),
            ("other_payload", self.other_payload),
            ("other_parents", self.other_parents),
            ("non_text_bodies", self.non_text_bodies),
            ("metadata", self.metadata),
            ("local_edits", self.local_edits),
            ("local_deletes", self.local_deletes),
            ("injected_failures", self.injected_failures),
            (
                "deletions_beside_tombstone",
                self.deletions_beside_tombstone,
            ),
        ];
        all.iter()
            .filter(|(_, n)| *n == 0)
            .map(|(name, _)| *name)
            .collect()
    }
}

struct Device {
    id: GossipId,
    store: Store,
    /// Clock offset from the global clock, in ms.
    skew: i64,
    /// The offset it returns to before the final delivery (its clock is resynchronised).
    initial_skew: i64,
    /// It evicts events under simulated storage pressure.
    evicts: bool,
    /// It makes local-only edits and deletions.
    local_changes: bool,
    /// Events withdrawn by a local-only change, with their sync object.
    withdrawn: Vec<(EventId, SyncObjId)>,
    /// Scheduled deletions whose first interpretation here carried their date: the device
    /// must not serve their immediate form before that date (§7.4, D.31).
    dated: BTreeMap<EventId, u64>,
    /// The latest instant its clock has shown (a deletion normalised then stays so after the
    /// clock moves back).
    max_clock: u64,
}

impl Device {
    fn clean(&self) -> bool {
        !self.evicts && !self.local_changes
    }
}

struct Packet {
    at: u64,
    seq: u64,
    from: usize,
    to: usize,
    blob: Vec<u8>,
    /// Delivered only once the receiver has processed this ID (a conflicting copy of an
    /// event, which must not become anyone's first interpretation).
    after_known: Option<EventId>,
}

struct Sim {
    rng: TestRng,
    now: u64,
    root: &'static Root,
    devices: Vec<Device>,
    queue: Vec<Packet>,
    seq: u64,
    /// Every blob ever sent except conflicting copies, for the replay checks.
    log: Vec<Vec<u8>>,
    /// The conflicting copies.
    variants: Vec<Vec<u8>>,
    steps: usize,
    counters: Counters,
    /// The latest instant any device clock has shown.
    max_clock: u64,
    /// The latest due time of any scheduled version or deletion.
    max_due: u64,
}

fn below(rng: &mut TestRng, n: u64) -> u64 {
    crate::rng::uniform_below(rng, usize::try_from(n).expect("small")) as u64
}

fn chance(rng: &mut TestRng, percent: u64) -> bool {
    below(rng, 100) < percent
}

/// Errors that say a storage failure happened.
trait StorageFailure {
    fn is_storage(&self) -> bool;
}

impl StorageFailure for StorageError {
    fn is_storage(&self) -> bool {
        true
    }
}

impl StorageFailure for ChangeError {
    fn is_storage(&self) -> bool {
        matches!(self, ChangeError::Storage(_))
    }
}

fn blob_of(event: &MessageEvent) -> Vec<u8> {
    wire::encode_event_blob(&EventObject::Message(event.clone())).expect("encodable")
}

fn event_of(blob: &[u8]) -> MessageEvent {
    match wire::decode_event_blob(blob, 1) {
        Ok(EventObject::Message(e)) => e,
        other => panic!("not a message event: {other:?}"),
    }
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
                // Device 0 is always clean; others may evict or alter locally.
                let evicts = i > 0 && chance(&mut rng, 35);
                let local_changes = i > 0 && chance(&mut rng, 35);
                Device {
                    id: identities()[i].id,
                    store: Instrumented::new(MemoryStorage::new()),
                    skew,
                    initial_skew: skew,
                    evicts,
                    local_changes,
                    withdrawn: Vec::new(),
                    dated: BTreeMap::new(),
                    max_clock: 0,
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
            variants: Vec::new(),
            steps,
            counters: Counters::default(),
            max_clock: START,
            max_due: START,
        }
    }

    fn epoch(&self) -> Epoch<'static> {
        Epoch::new(self.root, true, GroupState::Active)
    }

    fn chat(&self) -> ChatId {
        self.root.chat_id()
    }

    fn clock(&mut self, d: usize) -> u64 {
        let c = self.now.saturating_add_signed(self.devices[d].skew);
        self.max_clock = self.max_clock.max(c);
        self.devices[d].max_clock = self.devices[d].max_clock.max(c);
        c
    }

    fn check(&self, d: usize, now: u64, what: &str) {
        if let Err(e) = check_invariants(&self.devices[d].store, &self.chat(), now) {
            panic!("device {d}, {what}: {e}");
        }
    }

    /// Runs `op` on the store of device `d`; sometimes first with an injected commit failure,
    /// which must leave the store unchanged, then again.
    fn on_store<T, E: StorageFailure + core::fmt::Debug>(
        &mut self,
        d: usize,
        mut op: impl FnMut(&mut Store, &mut TestRng) -> Result<T, E>,
    ) -> Result<T, E> {
        if chance(&mut self.rng, 3) {
            let before = self.devices[d].store.inner.clone();
            self.devices[d].store.fail_commits = true;
            let failed = op(&mut self.devices[d].store, &mut self.rng);
            self.devices[d].store.fail_commits = false;
            assert!(
                self.devices[d].store.inner == before,
                "device {d}: a failed operation changed the store"
            );
            match failed {
                Err(e) if e.is_storage() => self.counters.injected_failures += 1,
                // A refusal before any commit: the same without the failure.
                Err(e) => return Err(e),
                Ok(_) => panic!("device {d}: an operation succeeded without its commit"),
            }
        }
        op(&mut self.devices[d].store, &mut self.rng)
    }

    fn send(&mut self, from: usize, to: usize, blob: Vec<u8>, after_known: Option<EventId>) {
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
            after_known,
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
                after_known,
            });
        }
    }

    fn broadcast(&mut self, from: usize, event: &MessageEvent) {
        let blob = blob_of(event);
        self.note_due(event);
        self.log.push(blob.clone());
        for to in 0..self.devices.len() {
            if to != from {
                self.send(from, to, blob.clone(), None);
            }
        }
    }

    fn note_dated(&mut self, d: usize, event: &MessageEvent) {
        if let Payload::Delete {
            scheduled_at: Some(due),
            ..
        } = event.payload()
        {
            self.devices[d].dated.insert(event.event_id(), *due);
        }
    }

    /// What device `d` serves under `id` at `now`, checked against §7.4: a scheduled
    /// deletion whose date it learned first is served with its date until its clock has
    /// reached that date.
    fn serve(&self, d: usize, id: &EventId, now: u64) -> Option<MessageEvent> {
        let event = self
            .epoch()
            .serve(&self.devices[d].store, id, now)
            .unwrap()?;
        if let Some(due) = self.devices[d].dated.get(id)
            && *due > self.devices[d].max_clock
        {
            assert!(
                matches!(
                    event.payload(),
                    Payload::Delete {
                        scheduled_at: Some(_),
                        ..
                    }
                ),
                "device {d} serves a scheduled deletion without its date before its time: \
                 {id:?} due {due}, now {now}"
            );
        }
        Some(event)
    }

    fn note_due(&mut self, event: &MessageEvent) {
        let due = match event.payload() {
            Payload::Content(c) => c.last_modified_at.max(c.created_at),
            Payload::Delete { scheduled_at, .. } => scheduled_at.unwrap_or(0),
        };
        self.max_due = self.max_due.max(due);
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

    fn requeue(&mut self, p: Packet, at: u64) {
        self.seq += 1;
        self.queue.push(Packet {
            at,
            seq: self.seq,
            ..p
        });
    }

    fn deliver(&mut self, p: Packet) {
        let now = self.clock(p.to);
        let chat = self.chat();
        if let Some(id) = p.after_known {
            let known = self.devices[p.to]
                .store
                .event_row(&chat, &id)
                .unwrap()
                .is_some_and(|r| r.processed());
            if !known {
                let at = self.now + 10 * MINUTE + below(&mut self.rng, HOUR);
                self.requeue(p, at);
                return;
            }
        }
        let sender = Sender::Peer {
            id: self.devices[p.from].id,
            removed: false,
        };
        let epoch = self.epoch();
        let blob = p.blob.clone();
        let beside_tombstone = match event_of(&blob).payload() {
            Payload::Delete {
                sync_obj_id,
                scheduled_at: Some(due),
            } if *due > now => self.devices[p.to]
                .store
                .object(&chat, sync_obj_id)
                .unwrap()
                .is_some_and(|o| o.is_deleted()),
            _ => false,
        };
        let known_before = self.devices[p.to]
            .store
            .event_row(&chat, &event_of(&blob).event_id())
            .unwrap()
            .is_some_and(|r| r.processed());
        let received = self
            .on_store(p.to, |store, _| {
                epoch.receive_blob(store, sender, &blob, 1, now)
            })
            .expect("memory storage");
        // The first interpretation is the first one processed (not a temporary rejection).
        if !known_before && matches!(received.outcome, Outcome::Accepted(_)) {
            self.note_dated(p.to, &event_of(&blob));
        }
        self.check(p.to, now, "after a delivery");
        let event = event_of(&p.blob);
        self.count_arrival(&received, &event, now, p.after_known.is_some());
        if beside_tombstone && received.outcome == Outcome::Accepted(crate::Merge::Pending) {
            self.counters.deletions_beside_tombstone += 1;
        }
        match received.outcome {
            Outcome::Rejected(r) => panic!("a valid event was rejected: {r:?}"),
            Outcome::TemporarilyInvalid => {
                // A later notice or scan reactivates retrieval (§9.6), once the receiver's
                // clock admits the event.
                let admit = (event.timestamp() - 5 * MINUTE)
                    .saturating_add_signed(-self.devices[p.to].skew);
                let at = admit.max(self.now + MINUTE) + below(&mut self.rng, 10 * MINUTE);
                self.requeue(p, at);
            }
            _ => {}
        }
    }

    fn count_arrival(&mut self, r: &Received, event: &MessageEvent, now: u64, variant: bool) {
        match r.outcome {
            Outcome::Restored => self.counters.restored += 1,
            Outcome::TemporarilyInvalid => self.counters.temporarily_invalid += 1,
            Outcome::Accepted(_) if !in_window(&event.event_id(), now) => {
                self.counters.late_arrivals += 1;
            }
            _ => {}
        }
        if variant {
            assert!(
                matches!(r.outcome, Outcome::Duplicate | Outcome::KeptPruned),
                "a conflicting copy was applied: {:?}",
                r.outcome
            );
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

    fn pick<T: Copy>(&mut self, items: &[T]) -> Option<T> {
        if items.is_empty() {
            None
        } else {
            Some(items[below(&mut self.rng, items.len() as u64) as usize])
        }
    }

    fn schedule(&mut self, now: u64, percent: u64) -> Option<u64> {
        if !chance(&mut self.rng, percent) {
            return None;
        }
        if chance(&mut self.rng, 6) {
            self.counters.long_schedules += 1;
            Some(now + MAX_SCHEDULE_MS - below(&mut self.rng, 6 * DAY))
        } else {
            Some(now + 1 + below(&mut self.rng, 3 * HOUR))
        }
    }

    fn body_and_metadata(&mut self) -> (Body, BTreeMap<String, Vec<u8>>) {
        let n = self.rng.next_u64() % 4;
        let body = match below(&mut self.rng, 10) {
            0 => Body::Reaction(vec![0xf0, n as u8]),
            1 => Body::Media(vec![n as u8; 3]),
            2 => Body::Forward {
                content_type: MessageType::Text,
                content: format!("f{n}").into_bytes(),
            },
            // Several messages and edits share a body, which exercises identical results.
            _ => Body::Text(format!("e{n}")),
        };
        if !matches!(body, Body::Text(_)) {
            self.counters.non_text_bodies += 1;
        }
        let mut metadata = BTreeMap::new();
        if chance(&mut self.rng, 15) {
            metadata.insert("x-sim".to_owned(), vec![n as u8]);
            self.counters.metadata += 1;
        }
        (body, metadata)
    }

    fn step(&mut self) {
        let d = below(&mut self.rng, self.devices.len() as u64) as usize;
        let now = self.clock(d);
        let epoch = self.epoch();
        if chance(&mut self.rng, 5) {
            self.check_view_without_tick(d);
        }
        // The device applies what is due before the user acts (§7.4), so that what it picks
        // below is still live.
        self.on_store(d, |store, _| epoch.tick(store, now))
            .expect("memory storage");
        let roll = below(&mut self.rng, 100);
        let published: Option<Published> = match roll {
            0..=21 => {
                let (body, metadata) = self.body_and_metadata();
                let at = self.schedule(now, 25);
                let author = self.devices[d].id;
                Some(self.publish(d, |store, rng| {
                    epoch.publish_message(
                        store,
                        now,
                        rng,
                        author,
                        body.clone(),
                        metadata.clone(),
                        at,
                    )
                }))
            }
            22..=39 => {
                let live = self.objects_where(d, |c| matches!(c, Some(StoredResult::Content(_))));
                let at = self.schedule(now, 25);
                let (body, metadata) = self.body_and_metadata();
                self.pick(&live).map(|sync| {
                    self.publish(d, |store, rng| {
                        epoch.publish_edit(
                            store,
                            now,
                            rng,
                            sync,
                            body.clone(),
                            metadata.clone(),
                            at,
                        )
                    })
                })
            }
            40..=48 => {
                let alive = self.objects_where(d, |c| !matches!(c, Some(StoredResult::Tombstone)));
                let at = self.schedule(now, 40);
                self.pick(&alive).map(|sync| {
                    self.publish(d, |store, rng| {
                        epoch.publish_deletion(store, now, rng, sync, at)
                    })
                })
            }
            49..=52 => {
                let any = self.objects_where(d, Option::is_some);
                self.pick(&any)
                    .map(|sync| self.publish(d, |store, rng| epoch.retry(store, now, rng, sync)))
            }
            53..=60 => {
                self.relay(d, now);
                None
            }
            61..=64 => {
                self.adversary(d, now);
                None
            }
            65..=67 => {
                self.local_change(d, now);
                None
            }
            68..=69 => {
                self.evict(d, now);
                None
            }
            70..=71 => {
                self.jump_clock(d);
                None
            }
            72..=89 => {
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
            self.check(d, now, "after a publication");
            self.note_dated(d, &p.event);
            self.broadcast(d, &p.event);
        }
        let pending: Vec<EventId> = self.devices[d]
            .dated
            .iter()
            .filter(|(_, due)| **due > now)
            .map(|(id, _)| *id)
            .collect();
        for id in pending {
            self.serve(d, &id, now);
        }
        self.deliver_due();
    }

    /// Publishes through `op`, which must succeed: an unexpected error fails the run.
    fn publish(
        &mut self,
        d: usize,
        op: impl FnMut(&mut Store, &mut TestRng) -> Result<Published, ChangeError>,
    ) -> Published {
        let now = self.clock(d);
        if self
            .epoch()
            .tips(&self.devices[d].store, now)
            .unwrap()
            .len()
            > 16
        {
            self.counters.many_tips += 1;
        }
        match self.on_store(d, op) {
            Ok(p) => p,
            Err(e) => panic!("device {d}: publication failed: {e:?}"),
        }
    }

    /// The view without a tick equals the view after one (§7.4, §7.5).
    fn check_view_without_tick(&mut self, d: usize) {
        let now = self.clock(d);
        let chat = self.chat();
        let before = view(&self.devices[d].store, &[chat], now).unwrap();
        let mut ticked = self.devices[d].store.inner.clone();
        self.epoch().tick(&mut ticked, now).unwrap();
        assert_eq!(
            before,
            view(&ticked, &[chat], now).unwrap(),
            "device {d}: the view depends on a tick"
        );
    }

    /// Device `d` serves one of its available events to another device, encoded from its
    /// store under the event's own version (§13.1).
    fn relay(&mut self, d: usize, now: u64) {
        let chat = self.chat();
        let available: Vec<EventId> = self.devices[d]
            .store
            .held_ids(&chat)
            .unwrap()
            .into_iter()
            .filter(|id| in_window(id, now))
            .collect();
        let Some(id) = self.pick(&available) else {
            return;
        };
        let event = self.serve(d, &id, now).expect("available");
        let blob = blob_of(&event);
        let mut to = below(&mut self.rng, self.devices.len() as u64 - 1) as usize;
        if to >= d {
            to += 1;
        }
        self.log.push(blob.clone());
        self.send(d, to, blob, None);
    }

    /// Creates `event` on device `d` as a member acting on its own (not through the
    /// publication path), and broadcasts it.
    fn inject(&mut self, d: usize, event: &MessageEvent, now: u64) {
        let epoch = self.epoch();
        let e = event.clone();
        let r = self
            .on_store(d, |store, _| {
                epoch.receive(store, Sender::Local, e.clone(), now)
            })
            .expect("memory storage");
        assert!(
            matches!(r.outcome, Outcome::Accepted(_)),
            "an injected event was {:?}",
            r.outcome
        );
        self.note_dated(d, event);
        self.count_arrival(&r, event, now, false);
        self.check(d, now, "after an injection");
        self.broadcast(d, event);
    }

    fn fresh_id(&mut self, ts: u64) -> EventId {
        EventId::new(ts, bytes(&mut self.rng))
    }

    fn new_message(&mut self, d: usize, at: u64) -> Payload {
        let (body, metadata) = self.body_and_metadata();
        Payload::Content(Content {
            sync_obj_id: SyncObjId::from_bytes(bytes(&mut self.rng)),
            author: self.devices[d].id,
            created_at: at,
            last_modified_at: at,
            body,
            edited: false,
            metadata,
        })
    }

    /// A member acting adversarially (every action is valid, so it is accepted).
    fn adversary(&mut self, d: usize, now: u64) {
        let root = self.root;
        match below(&mut self.rng, 5) {
            0 => {
                // A cycle of 2 or 3 events naming each other.
                let k = 2 + below(&mut self.rng, 2) as usize;
                let ids: Vec<EventId> = (0..k).map(|_| self.fresh_id(now)).collect();
                for i in 0..k {
                    let payload = self.new_message(d, now);
                    let e = MessageEvent::create(root, ids[i], &[ids[(i + 1) % k]], payload)
                        .expect("valid");
                    self.inject(d, &e, now);
                }
                self.counters.cycles += 1;
            }
            1 => {
                // A burst of unrelated events: more than 16 tips.
                for _ in 0..17 + below(&mut self.rng, 4) {
                    let id = self.fresh_id(now);
                    let payload = self.new_message(d, now);
                    let e = MessageEvent::create(root, id, &[], payload).expect("valid");
                    self.inject(d, &e, now);
                }
            }
            2 => {
                // An event old enough to arrive everywhere after its window.
                let ts = now - RETENTION_MS - below(&mut self.rng, DAY);
                let id = self.fresh_id(ts);
                let payload = self.new_message(d, ts);
                let e = MessageEvent::create(root, id, &[], payload).expect("valid");
                self.inject(d, &e, now);
            }
            3 => {
                // A scheduled deletion of any message it knows, deleted or not.
                let any = self.objects_where(d, Option::is_some);
                let Some(sync) = self.pick(&any) else {
                    return;
                };
                let deleted = self.devices[d]
                    .store
                    .object(&self.chat(), &sync)
                    .unwrap()
                    .is_some_and(|o| o.is_deleted());
                let due = now + 1 + below(&mut self.rng, 3 * HOUR);
                let id = self.fresh_id(now);
                let payload = Payload::Delete {
                    sync_obj_id: sync,
                    scheduled_at: Some(due),
                };
                let e = MessageEvent::create(root, id, &[], payload).expect("valid");
                if deleted {
                    self.counters.deletions_beside_tombstone += 1;
                }
                self.inject(d, &e, now);
            }
            _ => self.conflicting_copy(d, now),
        }
    }

    /// The same ID as an event device `d` holds, with another payload or other parents,
    /// sent to every other device once it has processed the original.
    fn conflicting_copy(&mut self, d: usize, now: u64) {
        let chat = self.chat();
        let held = self.devices[d].store.held_ids(&chat).unwrap();
        let Some(id) = self.pick(&held) else {
            return;
        };
        let original = self.devices[d]
            .store
            .event_row(&chat, &id)
            .unwrap()
            .and_then(|r| r.event().cloned())
            .expect("held");
        let other_parents = chance(&mut self.rng, 50);
        let (parents, payload) = if other_parents {
            let fresh = self.fresh_id(now.saturating_sub(HOUR));
            (vec![fresh], original.payload().clone())
        } else {
            let payload = match original.payload() {
                Payload::Content(c) => {
                    let mut c = c.clone();
                    c.body = Body::Text("conflicting".into());
                    Payload::Content(c)
                }
                Payload::Delete { sync_obj_id, .. } => self.with_sync(d, *sync_obj_id, now),
            };
            (original.parents().to_vec(), payload)
        };
        if parents == original.parents() && payload == *original.payload() {
            return;
        }
        let Ok(variant) = MessageEvent::create(self.root, id, &parents, payload) else {
            return;
        };
        if other_parents {
            self.counters.other_parents += 1;
        } else {
            self.counters.other_payload += 1;
        }
        let blob = blob_of(&variant);
        self.variants.push(blob.clone());
        for to in 0..self.devices.len() {
            if to != d {
                self.send(d, to, blob.clone(), Some(id));
            }
        }
    }

    fn with_sync(&mut self, d: usize, sync: SyncObjId, now: u64) -> Payload {
        match self.new_message(d, now) {
            Payload::Content(mut c) => {
                c.sync_obj_id = sync;
                Payload::Content(c)
            }
            p @ Payload::Delete { .. } => p,
        }
    }

    /// A local-only edit or deletion on a flagged device (§9.1 to §9.3).
    fn local_change(&mut self, d: usize, now: u64) {
        if !self.devices[d].local_changes {
            return;
        }
        let chat = self.chat();
        let live = self.objects_where(d, |c| matches!(c, Some(StoredResult::Content(_))));
        let Some(sync) = self.pick(&live) else {
            return;
        };
        let held_content: BTreeSet<EventId> = self.devices[d]
            .store
            .event_rows(&chat)
            .unwrap()
            .into_iter()
            .filter(|r| {
                r.event().is_some_and(
                    |e| matches!(e.payload(), Payload::Content(c) if c.sync_obj_id == sync),
                )
            })
            .map(|r| r.event_id)
            .collect();
        let epoch = self.epoch();
        let result = if chance(&mut self.rng, 60) {
            let (body, metadata) = self.body_and_metadata();
            let lma = if chance(&mut self.rng, 30) {
                Some(now.saturating_sub(below(&mut self.rng, HOUR)))
            } else {
                None
            };
            let edit = LocalEdit {
                body: Some(body),
                metadata: Some(metadata),
                last_modified_at: lma,
                edited: Some(chance(&mut self.rng, 50)),
                ..Default::default()
            };
            let r = self.on_store(d, |store, _| {
                epoch.local_edit(store, now, sync, edit.clone())
            });
            match r {
                Err(ChangeError::ModifiedInFuture) => {
                    // The clock moved back behind the current result (D.34).
                    self.counters.local_edits_refused += 1;
                    return;
                }
                Ok(_) => self.counters.local_edits += 1,
                Err(_) => {}
            }
            r
        } else {
            let r = self.on_store(d, |store, _| epoch.local_delete(store, now, sync));
            self.counters.local_deletes += 1;
            r
        };
        let pruned = result.unwrap_or_else(|e| panic!("device {d}: local change failed: {e:?}"));
        self.check(d, now, "after a local change");
        // Every content event of the message is withdrawn and reported (§9.3).
        let pruned: BTreeSet<EventId> = pruned.into_iter().collect();
        assert!(
            held_content.is_subset(&pruned),
            "device {d}: a withdrawn event was not reported"
        );
        for id in &held_content {
            assert!(
                self.epoch()
                    .serve(&self.devices[d].store, id, now)
                    .unwrap()
                    .is_none(),
                "device {d} still serves a content event of an altered message"
            );
            self.devices[d].withdrawn.push((*id, sync));
        }
    }

    fn evict(&mut self, d: usize, now: u64) {
        if !self.devices[d].evicts {
            return;
        }
        let epoch = self.epoch();
        let k = 1 + below(&mut self.rng, 6) as usize;
        let pruned = self
            .on_store(d, |store, _| epoch.evict(store, now, k))
            .expect("memory storage");
        self.counters.evicted += pruned.len() as u64;
        let markers = self
            .on_store(d, |store, _| epoch.evict_markers(store, 1))
            .expect("memory storage");
        self.counters.markers_evicted += markers.len() as u64;
        self.check(d, now, "after an eviction");
    }

    fn jump_clock(&mut self, d: usize) {
        let jump = below(&mut self.rng, (MAX_SKEW - MIN_SKEW) as u64) as i64 + MIN_SKEW;
        let skew = (self.devices[d].skew + jump).clamp(MIN_SKEW, MAX_SKEW);
        if skew > self.devices[d].skew {
            self.counters.clock_forward += 1;
        } else if skew < self.devices[d].skew {
            self.counters.clock_backward += 1;
        }
        self.devices[d].skew = skew;
    }

    fn drain(&mut self) {
        while let Some(at) = self.queue.iter().map(|p| p.at).min() {
            self.now = self.now.max(at);
            self.deliver_due();
        }
    }

    /// Ticks every device at the same instant `at`.
    fn tick_all(&mut self, at: u64) {
        let epoch = self.epoch();
        for d in &mut self.devices {
            epoch.tick(&mut d.store, at).unwrap();
        }
    }

    /// Brings the global clock forward so that every device clock is at least `at`.
    fn advance_to(&mut self, at: u64) {
        let lowest = self.devices.iter().map(|d| d.skew).min().unwrap_or(0);
        self.now = self.now.max(at.saturating_add_signed(-lowest));
    }

    /// The latest device clock: an instant every device can be brought to, since a tick
    /// never undoes what an earlier one applied or pruned.
    fn latest_clock(&mut self) -> u64 {
        let latest = (0..self.devices.len())
            .map(|i| self.now.saturating_add_signed(self.devices[i].skew))
            .max()
            .unwrap_or(self.now);
        latest.max(self.max_clock)
    }
}

type FullState = (
    Vec<EventRow>,
    Vec<(EventId, Vec<EventId>)>,
    Vec<ObjectRecord>,
);

fn full_state<R: StorageRead + ?Sized>(store: &R, chat: &ChatId) -> FullState {
    (
        store.event_rows(chat).unwrap(),
        store.edges(chat).unwrap(),
        store.objects(chat).unwrap(),
    )
}

/// What an evicting device must still share with the others.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Results {
    results: BTreeMap<SyncObjId, Option<StoredResult>>,
    view: Vec<(SyncObjId, u64, [u8; 32])>,
}

fn results<R: StorageRead + ?Sized>(store: &R, chat: &ChatId, now: u64) -> Results {
    Results {
        results: store
            .objects(chat)
            .unwrap()
            .into_iter()
            .map(|o| (o.sync_obj_id, o.current))
            .collect(),
        view: view(store, &[*chat], now)
            .unwrap()
            .into_iter()
            .map(|m| (m.sync_obj_id(), m.content.created_at, m.result_hash))
            .collect(),
    }
}

/// Explains the first difference between two full states.
fn assert_same_state(a: &FullState, b: &FullState, label: &str) {
    if a == b {
        return;
    }
    let rows_a: BTreeMap<_, _> = a.0.iter().map(|r| (r.event_id, r)).collect();
    let rows_b: BTreeMap<_, _> = b.0.iter().map(|r| (r.event_id, r)).collect();
    for id in rows_a.keys().chain(rows_b.keys()) {
        if rows_a.get(id) != rows_b.get(id) {
            panic!(
                "{label}: row {id:?} differs:\n  {:?}\n  {:?}",
                rows_a.get(id),
                rows_b.get(id)
            );
        }
    }
    assert_eq!(a.1, b.1, "{label}: edges differ");
    let objs_a: BTreeMap<_, _> = a.2.iter().map(|o| (o.sync_obj_id, o)).collect();
    let objs_b: BTreeMap<_, _> = b.2.iter().map(|o| (o.sync_obj_id, o)).collect();
    for id in objs_a.keys().chain(objs_b.keys()) {
        assert_eq!(
            objs_a.get(id),
            objs_b.get(id),
            "{label}: object {id:?} differs"
        );
    }
    unreachable!("{label}: states differ");
}

/// Brings every device to a common instant `at` and compares them there: clean devices on
/// their full stores, evicting devices on their results and view. Local-only changes make a
/// device differ on purpose; it is only checked for consistency.
fn check_convergence(sim: &mut Sim, at: u64, label: &str) {
    sim.tick_all(at);
    let chat = sim.chat();
    for i in 0..sim.devices.len() {
        sim.check(i, at, label);
    }
    let reference = full_state(&sim.devices[0].store, &chat);
    let reference_results = results(&sim.devices[0].store, &chat, at);
    for (i, d) in sim.devices.iter().enumerate() {
        if d.clean() {
            assert_same_state(
                &full_state(&d.store, &chat),
                &reference,
                &format!("{label}, device {i} against device 0"),
            );
        } else if !d.local_changes {
            assert_eq!(
                results(&d.store, &chat, at),
                reference_results,
                "{label}: evicting device {i} has other results"
            );
        }
    }
    // A withdrawn event is never served again unless it carries the current result.
    for (i, d) in sim.devices.iter().enumerate() {
        for (id, sync) in &d.withdrawn {
            let Some(e) = sim.epoch().serve(&d.store, id, at).unwrap() else {
                continue;
            };
            let current = d.store.object(&chat, sync).unwrap().and_then(|o| o.current);
            assert_eq!(
                current.map(|c| c.result_hash(&chat, *sync)),
                Some(e.result_hash()),
                "device {i} serves a withdrawn event"
            );
        }
    }
}

/// Replays every logged blob on a fresh device, in a random order, each at an instant drawn
/// after its timestamp (mostly within hours, sometimes across long schedules, sometimes after
/// its window), then the conflicting copies. Returns the store and the last instant.
fn replay(sim: &Sim, order_seed: u64, counters: &mut Counters) -> (MemoryStorage, u64) {
    let mut rng = TestRng::new(order_seed);
    let mut plan: Vec<(u64, u64, &Vec<u8>)> = sim
        .log
        .iter()
        .map(|blob| {
            let ts = event_of(blob).timestamp();
            let offset = match below(&mut rng, 100) {
                0..=2 => RETENTION_MS + below(&mut rng, DAY),
                3..=9 => below(&mut rng, MAX_SCHEDULE_MS),
                _ => below(&mut rng, 3 * HOUR),
            };
            (ts + offset, rng.next_u64(), blob)
        })
        .collect();
    plan.sort_unstable_by_key(|(at, key, _)| (*at, *key));
    let mut store = MemoryStorage::new();
    let sender = Sender::Peer {
        id: sim.devices[0].id,
        removed: false,
    };
    let mut last = START;
    for (at, _, blob) in &plan {
        let at = (*at).max(last);
        last = at;
        let r = sim
            .epoch()
            .receive_blob(&mut store, sender, blob, 1, at)
            .unwrap();
        assert!(
            !matches!(
                r.outcome,
                Outcome::Rejected(_) | Outcome::TemporarilyInvalid
            ),
            "replay: {:?}",
            r.outcome
        );
        if matches!(r.outcome, Outcome::Accepted(_)) && !in_window(&event_of(blob).event_id(), at) {
            counters.late_arrivals += 1;
        }
        if r.outcome == Outcome::Restored {
            counters.restored += 1;
        }
    }
    for blob in &sim.variants {
        let r = sim
            .epoch()
            .receive_blob(&mut store, sender, blob, 1, last)
            .unwrap();
        assert!(
            matches!(r.outcome, Outcome::Duplicate | Outcome::KeptPruned),
            "replay: a conflicting copy was {:?}",
            r.outcome
        );
    }
    check_invariants(&store, &sim.chat(), last).expect("replay invariants");
    (store, last)
}

fn run(seed: u64, steps: usize) -> Counters {
    let mut sim = Sim::new(seed, steps);
    for _ in 0..sim.steps {
        sim.step();
    }
    // Clocks are resynchronised, then everything in flight is delivered.
    for d in &mut sim.devices {
        d.skew = d.initial_skew;
    }
    sim.drain();
    // Past every due time and every instant a device clock has shown: forms, activations
    // and windows are then the same on every device (D.31, D.36).
    let at = sim.latest_clock().max(sim.max_due) + 1;
    sim.advance_to(at);
    sim.drain();
    let at = sim.latest_clock();
    check_convergence(&mut sim, at, "after delivery");

    // Order independence on fresh devices: identical full stores.
    let mut counters = core::mem::take(&mut sim.counters);
    let (mut a, last_a) = replay(&sim, seed ^ 0xa5a5, &mut counters);
    let (mut b, last_b) = replay(&sim, seed ^ 0x5a5a, &mut counters);
    let end = at.max(last_a).max(last_b);
    let epoch = sim.epoch();
    epoch.tick(&mut a, end).unwrap();
    epoch.tick(&mut b, end).unwrap();
    let mut reference = sim.devices[0].store.inner.clone();
    epoch.tick(&mut reference, end).unwrap();
    let chat = sim.chat();
    assert_same_state(
        &full_state(&a, &chat),
        &full_state(&b, &chat),
        "replay orders",
    );
    assert_same_state(
        &full_state(&a, &chat),
        &full_state(&reference, &chat),
        "replay against device 0",
    );

    // Pruning never changes a result, not even after everything arrives again.
    let before = results(&sim.devices[0].store, &chat, at);
    let mut pruned = sim.devices[0].store.inner.clone();
    let k = 1 + below(&mut sim.rng, 8) as usize;
    counters.evicted += epoch.evict(&mut pruned, at, k).unwrap().len() as u64;
    check_invariants(&pruned, &chat, at).expect("invariants after eviction");
    assert_eq!(
        before,
        results(&pruned, &chat, at),
        "eviction changed a result"
    );
    let sender = Sender::Peer {
        id: sim.devices[1].id,
        removed: false,
    };
    for blob in sim.log.iter().chain(&sim.variants) {
        let r = epoch
            .receive_blob(&mut pruned, sender, blob, 1, at)
            .unwrap();
        if r.outcome == Outcome::Restored {
            counters.restored += 1;
        }
    }
    check_invariants(&pruned, &chat, at).expect("invariants after redelivery");
    assert_eq!(
        before,
        results(&pruned, &chat, at),
        "redelivery changed a result"
    );

    // After every window has closed: results stay, nothing is served.
    sim.counters = counters;
    sim.now += RETENTION_MS + HOUR;
    let at = sim.latest_clock();
    check_convergence(&mut sim, at, "after retention");
    for (i, d) in sim.devices.iter().enumerate() {
        assert!(
            sim.epoch().tips(&d.store, at).unwrap().is_empty(),
            "device {i} still serves after retention"
        );
    }
    sim.counters
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
    let single = env_u64("GROUPS_SIM_SEED");
    let seeds: Vec<u64> = match single {
        Some(seed) => vec![seed],
        None => {
            let first = env_u64("GROUPS_SIM_FIRST").unwrap_or(0);
            let count = env_u64("GROUPS_SIM_SEEDS").unwrap_or(12);
            (first..first + count).collect()
        }
    };
    let mut total = Counters::default();
    for seed in &seeds {
        let seed = *seed;
        let result = std::panic::catch_unwind(|| run(seed, steps));
        match result {
            Ok(c) => total.add(&c),
            Err(panic) => {
                eprintln!(
                    "simulation failed with seed {seed} ({steps} steps); replay with \
                     GROUPS_SIM_SEED={seed} GROUPS_SIM_STEPS={steps} cargo test -p groups \
                     simulation"
                );
                std::panic::resume_unwind(panic);
            }
        }
    }
    eprintln!("simulation counters over {} seeds: {total:?}", seeds.len());
    if single.is_none() && seeds.len() >= 12 {
        assert!(
            total.missing().is_empty(),
            "situations never exercised: {:?}",
            total.missing()
        );
    }
}
