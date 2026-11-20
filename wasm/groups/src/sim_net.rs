//! Deterministic simulation of a network of devices of one epoch connected only by their
//! outboxes (test only).
//!
//! Each run is fully determined by its seed. Devices run the engine ([`Node`]) on their own
//! store and exchange plaintexts through a simulated backend that delays, reorders,
//! duplicates and loses them, and keeps them until the recipient polls. Devices are online
//! for a few minutes at a time, polling about every 30 s, then offline for minutes to hours,
//! so they are rarely online together; a **wake-up driven** device, online, polls only at
//! the engine's next wake-up or when a plaintext arrives; a **sleeper** goes offline for days and its mailbox is
//! emptied meanwhile, so what it missed can only come back through tip scans. An event
//! reaches others only through the protocol: first sends, notices, lookups and scans.
//!
//! Users publish, edit, delete (immediately or scheduled), retry, look up sync objects, and
//! some devices make local-only changes. Devices crash at arbitrary points (the engine is
//! dropped and rebuilt from storage), also between assembling a plaintext and confirming
//! it, before or after the transport sent it; commits fail by injection. Clocks are skewed,
//! some fast enough to make events temporarily invalid elsewhere. Sessions are reset.
//!
//! Hostile members: **silent** (never answers), **announcer** (announces real and fake IDs,
//! again and again, and answers "not available" to every query, or "restart" to half of the
//! page requests), **liar** (answers every query with invalid data or, to half of the page
//! requests, pages of a list said to hold a billion entries, and pushes once an event of the
//! largest size), **flooder** (floods notices of fake IDs, half of them dated years ahead,
//! and query frames, and never answers) and **staller** (answers `busy`, `expired` or
//! `restart` to everything).
//!
//! Properties checked:
//!
//! - (a) **convergence**: after a final period in which every honest device stays reachable
//!   (72 hours by default, clocks corrected), every honest device without local-only changes holds, at a
//!   common instant, the same retained events (rows and their parent links) and the same
//!   objects, hence the same results; devices with local-only changes differ on purpose and
//!   are checked for consistency only. Pruned stubs are not compared, nor the stubs an object
//!   lists for the message timer to erase: an ID pruned everywhere before a device heard of it
//!   can never reach that device, by design (§9.3, §11.7); under a timer, every object past
//!   its erasure is gone (§7.7);
//! - (b) the sleeper converges too, and recovers the current messages that only sat behind
//!   pruned (superseded) events when it came back ([`Counters::behind_pruned`]);
//! - (c) **bounded work**: plaintexts, bytes and lookup entries per device per simulated hour
//!   stay under [`LIMITS`]; runs per task are bounded, and a device left alone without
//!   answers for 40 days ends every task (lookup deadlines, twenty stages);
//! - (d) hostile members are ranked below honest ones, and the work they cause stays within
//!   the same limits; convergence between honest devices holds whatever they do;
//! - (e) crashes and injected commit failures lose nothing committed: the epoch records stay
//!   consistent and convergence holds.
//!
//! Every failure prints its seed; a run replays from the seed alone. The run counts each
//! generated behaviour ([`Counters`]); the default test asserts that each occurred.
//!
//! Environment variables (local runs; the default run takes a few seconds):
//!
//! - `GROUPS_NET_SEED=<n>`: replay one seed;
//! - `GROUPS_NET_SEEDS=<n>`: run seeds `GROUPS_NET_FIRST` (default 0) to `+ n` (default 5,
//!   in which every hostile kind and every situation occurs);
//! - `GROUPS_NET_HOURS=<n>`: hours of activity per run (default 8);
//! - `GROUPS_NET_FINAL=<n>`: hours of the final period (default 72);
//! - `GROUPS_NET_DEBUG=1`: on a divergence, print the engines' state.

use std::collections::{BTreeMap, BTreeSet};

use crate::epoch::check_invariants;
use crate::event::Body;
use crate::ids::{ChatId, EventId, GossipId, SyncObjId};
use crate::node::tests::{config, epoch_root_with_timer, member};
use crate::node::{Node, NodeError};
use crate::rng::{TestRng, bytes, uniform_below};
use crate::root::Root;
use crate::store::{EventRow, MemoryStorage, ObjectRecord, RowState, StorageRead, StoredResult};
use crate::test_support::Instrumented;
use crate::wire::{
    self, Entry, EntryItem, EventObject, Frame, Notice, Page, QueryEntry, QueryOp, Response,
    ResponseResult, Status,
};

const START: u64 = 1_700_000_000_000;
const SECOND: u64 = 1_000;
const MINUTE: u64 = 60 * SECOND;
const HOUR: u64 = 60 * MINUTE;
const DAY: u64 = 24 * HOUR;
/// The final period in which every honest device stays online, by default (hours).
const FINAL_HOURS: u64 = 72;

/// The stated bounds of property (c), per device and simulated hour.
pub(crate) struct Limits {
    pub plaintexts: u64,
    pub bytes: u64,
    pub lookups: u64,
}

/// Per device and hour. Lookups: at most 64 outstanding per device (§17.4), each lasting at
/// least one local wait of the first TTL (57 s), so about 4,000 per hour whatever peers do.
/// Plaintexts and bytes: well under one plaintext per second and the idle-traffic target of
/// §17.3 (1 MiB per device per group per day) times the active load of the workload.
pub(crate) const LIMITS: Limits = Limits {
    plaintexts: 1_000,
    bytes: 1024 * 1024,
    lookups: 4_100,
};

type Store = Instrumented<MemoryStorage>;

/// How often each generated behaviour occurred.
#[derive(Debug, Clone, Default)]
pub(crate) struct Counters {
    messages: u64,
    edits: u64,
    deletions: u64,
    scheduled: u64,
    retries: u64,
    local_changes: u64,
    sync_lookups: u64,
    lookups_found: u64,
    crashes: u64,
    crash_before_send: u64,
    crash_after_send: u64,
    commit_failures: u64,
    lost: u64,
    duplicated: u64,
    long_delays: u64,
    session_resets: u64,
    sleeps: u64,
    behind_pruned: u64,
    temporarily_invalid: u64,
    silent: u64,
    announcer: u64,
    liar: u64,
    flooder: u64,
    staller: u64,
    stalled_answers: u64,
    far_ahead_ids: u64,
    query_floods: u64,
    huge_pages: u64,
    huge_events: u64,
    timed_runs: u64,
    timer_deletions: u64,
    invalid_answers: u64,
    fake_notices: u64,
    scans_completed: u64,
    restarts: u64,
    tasks_paused: u64,
    tasks_renewed: u64,
    neighbors_replaced: u64,
    expired_resends: u64,
    busy: u64,
    wakeup_steps: u64,
    max_plaintexts_hour: u64,
    max_bytes_hour: u64,
    max_lookups_hour: u64,
    max_task_runs: u64,
}

impl Counters {
    fn add(&mut self, o: &Counters) {
        macro_rules! sum {
            ($($f:ident),*) => { $( self.$f += o.$f; )* };
        }
        sum!(
            messages,
            edits,
            deletions,
            scheduled,
            retries,
            local_changes,
            sync_lookups,
            lookups_found,
            crashes,
            crash_before_send,
            crash_after_send,
            commit_failures,
            lost,
            duplicated,
            long_delays,
            session_resets,
            sleeps,
            behind_pruned,
            temporarily_invalid,
            silent,
            announcer,
            liar,
            flooder,
            staller,
            stalled_answers,
            far_ahead_ids,
            query_floods,
            huge_pages,
            huge_events,
            timed_runs,
            timer_deletions,
            invalid_answers,
            fake_notices,
            scans_completed,
            restarts,
            tasks_paused,
            tasks_renewed,
            neighbors_replaced,
            expired_resends,
            busy,
            wakeup_steps
        );
        self.max_plaintexts_hour = self.max_plaintexts_hour.max(o.max_plaintexts_hour);
        self.max_bytes_hour = self.max_bytes_hour.max(o.max_bytes_hour);
        self.max_lookups_hour = self.max_lookups_hour.max(o.max_lookups_hour);
        self.max_task_runs = self.max_task_runs.max(o.max_task_runs);
    }

    fn missing(&self) -> Vec<&'static str> {
        let all = [
            ("messages", self.messages),
            ("edits", self.edits),
            ("deletions", self.deletions),
            ("scheduled", self.scheduled),
            ("retries", self.retries),
            ("local_changes", self.local_changes),
            ("sync_lookups", self.sync_lookups),
            ("lookups_found", self.lookups_found),
            ("crashes", self.crashes),
            ("crash_before_send", self.crash_before_send),
            ("crash_after_send", self.crash_after_send),
            ("commit_failures", self.commit_failures),
            ("lost", self.lost),
            ("duplicated", self.duplicated),
            ("long_delays", self.long_delays),
            ("session_resets", self.session_resets),
            ("sleeps", self.sleeps),
            ("behind_pruned", self.behind_pruned),
            ("temporarily_invalid", self.temporarily_invalid),
            ("silent", self.silent),
            ("announcer", self.announcer),
            ("liar", self.liar),
            ("flooder", self.flooder),
            ("staller", self.staller),
            ("stalled_answers", self.stalled_answers),
            ("far_ahead_ids", self.far_ahead_ids),
            ("query_floods", self.query_floods),
            ("huge_pages", self.huge_pages),
            ("huge_events", self.huge_events),
            ("timed_runs", self.timed_runs),
            ("timer_deletions", self.timer_deletions),
            ("invalid_answers", self.invalid_answers),
            ("fake_notices", self.fake_notices),
            ("scans_completed", self.scans_completed),
            ("restarts", self.restarts),
            ("tasks_paused", self.tasks_paused),
            ("tasks_renewed", self.tasks_renewed),
            ("neighbors_replaced", self.neighbors_replaced),
            ("expired_resends", self.expired_resends),
            ("wakeup_steps", self.wakeup_steps),
        ];
        all.iter()
            .filter(|(_, n)| *n == 0)
            .map(|(k, _)| *k)
            .collect()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Hostility {
    Silent,
    Announcer,
    Liar,
    Flooder,
    Staller,
}

struct Device {
    id: GossipId,
    hostile: Option<Hostility>,
    store: Store,
    node: Option<Node>,
    skew: i64,
    online: bool,
    next: u64,
    session_end: u64,
    local_changes: bool,
    sleeper: bool,
    slept: bool,
    /// Online, it polls only at the engine's next wake-up or when a plaintext arrives.
    wakeup_driven: bool,
    /// When it last polled.
    last_step: u64,
    inbox: Vec<Mail>,
    /// Per hour: plaintexts, bytes, lookup entries handed off.
    hours: BTreeMap<u64, (u64, u64, u64)>,
    /// Hostile devices: event blobs seen.
    seen: Vec<Vec<u8>>,
    /// The liar: whether it pushed its largest event.
    pushed_huge: bool,
    /// Honest devices: plaintexts sent carrying the liar's largest event.
    huge_sends: u64,
    /// Hostile devices: the fake IDs announced.
    announced: Vec<EventId>,
    /// Hostile devices: every ID announced, repeats included.
    announced_log: Vec<EventId>,
    /// The engine's counters before its last crash, summed.
    stats_before: crate::node::Stats,
}

struct Mail {
    at: u64,
    seq: u64,
    from: usize,
    bytes: Vec<u8>,
}

struct Sim {
    rng: TestRng,
    now: u64,
    root: Root,
    devs: Vec<Device>,
    seq: u64,
    counters: Counters,
    end_active: u64,
    final_phase: bool,
    /// The current messages behind pruned events when the sleeper came back.
    behind: Vec<(SyncObjId, EventId)>,
    sleeper_back: Option<usize>,
    /// The quiet period before the sleeper's return: `(start, return)`.
    script: Option<(u64, u64)>,
    script_done: bool,
    ops: u64,
    /// Whether sessions are still reset during the final period (not in every third seed,
    /// so that resends after reconnections do not mask a missed retry).
    resets_in_final: bool,
    /// The liar's event of the largest size, once pushed.
    huge: Option<EventId>,
}

fn below(rng: &mut TestRng, n: u64) -> u64 {
    uniform_below(rng, usize::try_from(n).expect("small")) as u64
}

fn chance(rng: &mut TestRng, percent: u64) -> bool {
    below(rng, 100) < percent
}

fn per_mille(rng: &mut TestRng, n: u64) -> bool {
    below(rng, 1000) < n
}

fn decode(bytes: &[u8]) -> Vec<Frame> {
    match wire::decode_plaintext(bytes) {
        Ok(pt) => pt.frames().filter_map(Result::ok).collect(),
        Err(_) => Vec::new(),
    }
}

impl Sim {
    fn new(seed: u64, hours: u64) -> Self {
        let mut rng = TestRng::new(seed);
        let honest = 3 + below(&mut rng, 3) as usize;
        let hostile = 1 + below(&mut rng, 2) as usize;
        let n = honest + hostile;
        // Some seeds have a message timer (§7.7): a short one, under which messages are
        // deleted while devices are still offline and arrive after their moment, and one
        // under which the oldest messages are deleted during the final period.
        let timer = match seed % 5 {
            2 => 3 * HOUR,
            4 => 76 * HOUR,
            _ => 0,
        };
        let root = epoch_root_with_timer(n, 0x20 + (seed % 200) as u8, timer);
        let kinds = [
            Hostility::Silent,
            Hostility::Announcer,
            Hostility::Liar,
            Hostility::Flooder,
            Hostility::Staller,
        ];
        let mut counters = Counters {
            timed_runs: u64::from(timer > 0),
            ..Counters::default()
        };
        let devs = (0..n)
            .map(|i| {
                // Every kind occurs in any five consecutive seeds.
                let hostile = (i >= honest).then(|| kinds[(seed as usize + i - honest) % 5]);
                match hostile {
                    Some(Hostility::Silent) => counters.silent += 1,
                    Some(Hostility::Announcer) => counters.announcer += 1,
                    Some(Hostility::Liar) => counters.liar += 1,
                    Some(Hostility::Flooder) => counters.flooder += 1,
                    Some(Hostility::Staller) => counters.staller += 1,
                    None => {}
                }
                // Mostly small skews; sometimes a fast clock beyond the 5-minute bound.
                // One device of every fourth seed has a clock beyond the bound.
                let fast = ((i == 1 || i == 2) && seed % 4 == 1) || chance(&mut rng, 10);
                let skew = if fast {
                    (10 + below(&mut rng, 50)) as i64 * MINUTE as i64
                } else {
                    below(&mut rng, 4 * MINUTE) as i64 - 2 * MINUTE as i64
                };
                Device {
                    id: member(i),
                    hostile,
                    store: Instrumented::new(MemoryStorage::new()),
                    node: None,
                    skew,
                    online: false,
                    next: START + below(&mut rng, HOUR),
                    session_end: 0,
                    // Devices 0 and 1 never alter messages locally: at least two devices
                    // are compared in full.
                    local_changes: i > 1
                        && hostile.is_none()
                        && ((i == honest - 1 && seed % 2 == 1) || chance(&mut rng, 15)),
                    sleeper: i == 1 && seed.is_multiple_of(2),
                    slept: false,
                    // One honest device in every seed, a different one from seed to seed.
                    wakeup_driven: hostile.is_none() && (seed as usize + i).is_multiple_of(honest),
                    last_step: 0,
                    inbox: Vec::new(),
                    hours: BTreeMap::new(),
                    seen: Vec::new(),
                    pushed_huge: false,
                    huge_sends: 0,
                    announced: Vec::new(),
                    announced_log: Vec::new(),
                    stats_before: crate::node::Stats::default(),
                }
            })
            .collect();
        let mut sim = Self {
            rng,
            now: START,
            root,
            devs,
            seq: 0,
            counters,
            end_active: START + hours * HOUR,
            final_phase: false,
            behind: Vec::new(),
            sleeper_back: None,
            script: None,
            script_done: false,
            ops: 0,
            resets_in_final: seed % 3 != 2,
            huge: None,
        };
        for d in 0..n {
            if sim.devs[d].hostile.is_none() {
                sim.boot(d, true);
            }
        }
        sim
    }

    fn chat(&self) -> ChatId {
        self.root.chat_id()
    }

    fn clock(&self, d: usize) -> u64 {
        self.now.saturating_add_signed(self.devs[d].skew)
    }

    /// (Re)builds the engine of device `d` from its storage.
    fn boot(&mut self, d: usize, first: bool) {
        let now = self.clock(d);
        let dev = &mut self.devs[d];
        let mut node = Node::open(&dev.store, dev.id).expect("open");
        node.install_epoch(
            &mut dev.store,
            config(&self.root),
            first,
            now,
            &mut self.rng,
        )
        .expect("install");
        dev.node = Some(node);
    }

    fn crash(&mut self, d: usize) {
        self.counters.crashes += 1;
        let dev = &mut self.devs[d];
        if let Some(node) = dev.node.take() {
            add_stats(&mut dev.stats_before, node.stats());
        }
        self.boot(d, false);
    }

    /// Runs an engine operation on device `d`; sometimes first with an injected commit
    /// failure, which must leave the store unchanged, then again.
    fn op<T>(
        &mut self,
        d: usize,
        mut f: impl FnMut(&mut Node, &mut Store, u64, &mut TestRng) -> Result<T, NodeError>,
    ) -> Result<T, NodeError> {
        let now = self.clock(d);
        self.ops += 1;
        if per_mille(&mut self.rng, 5) {
            let before = self.devs[d].store.inner.clone();
            let dev = &mut self.devs[d];
            dev.store.fail_commits = true;
            let r = f(
                dev.node.as_mut().expect("booted"),
                &mut dev.store,
                now,
                &mut self.rng,
            );
            dev.store.fail_commits = false;
            assert!(
                dev.store.inner == before,
                "device {d}: a failed operation changed the store"
            );
            match r {
                Err(NodeError::Storage(_)) => self.counters.commit_failures += 1,
                Err(e) => return Err(e),
                Ok(_) => {}
            }
        }
        let dev = &mut self.devs[d];
        let r = f(
            dev.node.as_mut().expect("booted"),
            &mut dev.store,
            now,
            &mut self.rng,
        );
        if self.ops.is_multiple_of(300) {
            self.check(d);
        }
        r
    }

    fn check(&self, d: usize) {
        let now = self.clock(d);
        if let Err(e) = check_invariants(&self.devs[d].store, &self.chat(), now) {
            panic!("device {d}: {e}");
        }
    }

    // ── Transport ────────────────────────────────────────────────────────────

    fn transmit(&mut self, from: usize, to: GossipId, bytes: Vec<u8>) {
        let Some(to) = self.devs.iter().position(|d| d.id == to) else {
            return;
        };
        if chance(&mut self.rng, 3) {
            self.counters.lost += 1;
            return;
        }
        let mut delay = 200 + below(&mut self.rng, 20 * SECOND);
        if chance(&mut self.rng, 3) {
            delay += HOUR + below(&mut self.rng, 6 * HOUR);
            self.counters.long_delays += 1;
        }
        let copies = if chance(&mut self.rng, 3) {
            self.counters.duplicated += 1;
            2
        } else {
            1
        };
        for c in 0..copies {
            self.seq += 1;
            let at = self.now + delay + c * below(&mut self.rng, HOUR);
            self.devs[to].inbox.push(Mail {
                at,
                seq: self.seq,
                from,
                bytes: bytes.clone(),
            });
            // A plaintext wakes a wake-up driven device that is online (a push), but not
            // sooner than its usual poll interval after its last poll.
            let dev = &mut self.devs[to];
            if dev.wakeup_driven && dev.online {
                dev.next = dev.next.min(at.max(dev.last_step + 25 * SECOND));
            }
        }
    }

    // ── One poll of a device ─────────────────────────────────────────────────

    fn step(&mut self, d: usize) {
        if self.devs[d].hostile.is_some() {
            self.hostile_step(d);
            return;
        }
        // Receive what arrived, in arrival order.
        let mut arrived: Vec<Mail> = Vec::new();
        let inbox = core::mem::take(&mut self.devs[d].inbox);
        for m in inbox {
            if m.at <= self.now {
                arrived.push(m);
            } else {
                self.devs[d].inbox.push(m);
            }
        }
        arrived.sort_by_key(|m| (m.at, m.seq));
        for m in arrived {
            let from = self.devs[m.from].id;
            self.op(d, |n, s, now, rng| {
                n.handle_plaintext(s, from, &m.bytes, now, rng)
            })
            .expect("receive");
        }
        self.op(d, |n, s, now, rng| n.tick(s, now, rng))
            .expect("tick");
        let quiet = self
            .script
            .is_some_and(|(at, wake)| self.now >= at && self.now < wake);
        if d == 0 && quiet && !self.script_done {
            self.behind_script();
        } else if !quiet
            && !self.final_phase
            && self.now < self.end_active
            && chance(&mut self.rng, 12)
        {
            self.user_action(d);
        }
        if chance(&mut self.rng, 1) && (!self.final_phase || self.resets_in_final) {
            let peer = self.devs[below(&mut self.rng, self.devs.len() as u64) as usize].id;
            if peer != self.devs[d].id {
                self.counters.session_resets += 1;
                self.op(d, |n, s, now, rng| n.peer_reconnected(s, peer, now, rng))
                    .expect("reconnect");
            }
        }
        self.send(d);
        if per_mille(&mut self.rng, 3) {
            self.crash(d);
        }
        let results = self
            .op(d, |n, s, now, rng| n.take_lookup_results(s, now, rng))
            .expect("results");
        for (_, _, r) in results {
            if matches!(r, crate::node::LookupResult::Found(_)) {
                self.counters.lookups_found += 1;
            }
        }
    }

    fn send(&mut self, d: usize) {
        let out = self
            .op(d, |n, s, now, rng| n.poll_outbox(s, now, rng))
            .expect("poll");
        let hour = (self.now - START) / HOUR;
        for o in out {
            let lookups = decode(&o.plaintext)
                .iter()
                .map(|f| match f {
                    Frame::Query(q) => q
                        .entries
                        .iter()
                        .filter(|e| {
                            matches!(
                                e,
                                QueryEntry::Op(QueryOp::Event { .. } | QueryOp::SyncObj { .. })
                            )
                        })
                        .count() as u64,
                    _ => 0,
                })
                .sum::<u64>();
            // A crash between assembling and confirming: before or after the transport
            // stored and sent the ciphertext.
            if per_mille(&mut self.rng, 5) {
                if chance(&mut self.rng, 50) {
                    self.counters.crash_after_send += 1;
                    self.transmit(d, o.to, o.plaintext.clone());
                } else {
                    self.counters.crash_before_send += 1;
                }
                self.crash(d);
                return;
            }
            let handle = o.handle;
            let clock = self.clock(d);
            let node = self.devs[d].node.as_mut().expect("booted");
            if !node.is_current(handle, clock) {
                node.abandon(handle);
                continue;
            }
            self.check_sent(d, &o.plaintext);
            self.op(d, |n, s, now, rng| n.handed_off(s, handle, now, rng))
                .expect("handoff");
            // The liar's event of the largest size is bounded on its own: every member that
            // lacks it must get it once, a quarter of a MiB each time, beyond the idle
            // target of (c).
            let huge = self.huge_bytes(&o.plaintext);
            self.devs[d].huge_sends += u64::from(huge > 0);
            let e = self.devs[d].hours.entry(hour).or_default();
            e.0 += 1;
            e.1 += o.plaintext.len() as u64 - huge;
            e.2 += lookups;
            self.transmit(d, o.to, o.plaintext);
            if chance(&mut self.rng, 90) {
                self.op(d, |n, s, now, rng| n.published(s, handle, now, rng))
                    .expect("published");
            }
        }
    }

    fn user_action(&mut self, d: usize) {
        let chat = self.chat();
        let now = self.clock(d);
        let objects: Vec<ObjectRecord> = self.devs[d].store.objects(&chat).unwrap();
        let live: Vec<SyncObjId> = objects
            .iter()
            .filter(|o| matches!(o.current, Some(StoredResult::Content(_))))
            .map(|o| o.sync_obj_id)
            .collect();
        let pick = |rng: &mut TestRng, v: &[SyncObjId]| {
            (!v.is_empty()).then(|| v[below(rng, v.len() as u64) as usize])
        };
        let scheduled =
            |rng: &mut TestRng| chance(rng, 15).then(|| now + 1 + below(rng, 12 * HOUR));
        let body = Body::Text(format!("t{}", below(&mut self.rng, 1_000)));
        // A device that alters messages locally does so in a third of its actions.
        let roll = if self.devs[d].local_changes && chance(&mut self.rng, 33) {
            99
        } else {
            below(&mut self.rng, 100)
        };
        let r = match roll {
            0..=44 => {
                let at = scheduled(&mut self.rng);
                self.counters.messages += 1;
                self.counters.scheduled += u64::from(at.is_some());
                self.op(d, |n, s, now, rng| {
                    n.publish_message(s, chat, body.clone(), BTreeMap::new(), at, now, rng)
                })
                .map(|_| ())
            }
            45..=69 => match pick(&mut self.rng, &live) {
                Some(sync) => {
                    let at = scheduled(&mut self.rng);
                    self.counters.edits += 1;
                    self.counters.scheduled += u64::from(at.is_some());
                    self.op(d, |n, s, now, rng| {
                        n.publish_edit(s, chat, sync, body.clone(), BTreeMap::new(), at, now, rng)
                    })
                    .map(|_| ())
                }
                None => Ok(()),
            },
            70..=81 => match pick(&mut self.rng, &live) {
                Some(sync) => {
                    let at = scheduled(&mut self.rng);
                    self.counters.deletions += 1;
                    self.counters.scheduled += u64::from(at.is_some());
                    self.op(d, |n, s, now, rng| {
                        n.publish_deletion(s, chat, sync, at, now, rng)
                    })
                    .map(|_| ())
                }
                None => Ok(()),
            },
            82..=86 => match pick(&mut self.rng, &live) {
                Some(sync) => {
                    self.counters.retries += 1;
                    self.op(d, |n, s, now, rng| n.retry(s, chat, sync, now, rng))
                        .map(|_| ())
                }
                None => Ok(()),
            },
            87..=91 => {
                let sync = pick(&mut self.rng, &live)
                    .unwrap_or_else(|| SyncObjId::from_bytes(bytes(&mut self.rng)));
                self.counters.sync_lookups += 1;
                self.op(d, |n, s, now, rng| {
                    n.lookup_sync_object(s, chat, sync, now, rng)
                })
            }
            _ => match (self.devs[d].local_changes, pick(&mut self.rng, &live)) {
                (true, Some(sync)) => {
                    self.counters.local_changes += 1;
                    if chance(&mut self.rng, 50) {
                        self.op(d, |n, s, now, rng| n.local_delete(s, chat, sync, now, rng))
                            .map(|_| ())
                    } else {
                        let edit = crate::LocalEdit {
                            body: Some(Body::Text("local".into())),
                            last_modified_at: Some(now),
                            ..Default::default()
                        };
                        self.op(d, |n, s, now, rng| {
                            n.local_edit(s, chat, sync, edit.clone(), now, rng)
                        })
                        .map(|_| ())
                    }
                }
                _ => Ok(()),
            },
        };
        match r {
            Ok(()) => {}
            // Refusals that depend on the state or the clock (a date later than now after
            // a clock skew, a message deleted by a due deletion).
            Err(NodeError::Change(_)) => {}
            Err(e) => panic!("device {d}: {e:?}"),
        }
    }

    /// Device 0 publishes M1, then M2 (whose parent is M1), then edits M2: the first event
    /// of M2 is pruned, so M1 is a current message whose only child is pruned (D.27).
    fn behind_script(&mut self) {
        self.script_done = true;
        let chat = self.chat();
        let text = |t: &str| Body::Text(t.to_owned());
        self.op(0, |n, s, now, rng| {
            n.publish_message(s, chat, text("m1"), BTreeMap::new(), None, now, rng)
        })
        .expect("m1");
        let m2 = self
            .op(0, |n, s, now, rng| {
                n.publish_message(s, chat, text("m2"), BTreeMap::new(), None, now, rng)
            })
            .expect("m2");
        let sync = m2.event.payload().sync_obj_id();
        self.op(0, |n, s, now, rng| {
            n.publish_edit(
                s,
                chat,
                sync,
                text("m2'"),
                BTreeMap::new(),
                None,
                now + 1,
                rng,
            )
        })
        .expect("edit");
        self.counters.messages += 2;
        self.counters.edits += 1;
    }

    /// Every event a plaintext about to be sent carries or announces is one device `d`
    /// serves at this instant, what came due included: the check does not rely on
    /// `is_current`.
    fn check_sent(&self, d: usize, plaintext: &[u8]) {
        let chat = self.chat();
        let now = self.clock(d);
        let store = &self.devs[d].store.inner;
        let due = store
            .first_pending(&chat)
            .unwrap()
            .is_some_and(|i| i.due <= now);
        let epoch = crate::epoch::Epoch::new(&self.root, true, crate::epoch::GroupState::Active);
        let ticked;
        let view: &MemoryStorage = if due {
            let mut c = store.clone();
            epoch.tick(&mut c, now).expect("tick");
            ticked = c;
            &ticked
        } else {
            store
        };
        let served = |id: &EventId| epoch.serve(view, id, now).expect("serve");
        for f in decode(plaintext) {
            match f {
                Frame::Event(b)
                | Frame::Response(Response {
                    result: ResponseResult::Event(b),
                    ..
                }) => {
                    let Ok(EventObject::Message(e)) = wire::decode_event_blob(&b, 1) else {
                        panic!("device {d} sends an undecodable event");
                    };
                    assert_eq!(
                        served(&e.event_id()).as_ref(),
                        Some(&e),
                        "device {d} sends {:?}, which it does not serve now",
                        e.event_id()
                    );
                }
                Frame::Notice(n) => {
                    for e in n.entries {
                        if let EntryItem::Event(id) = e.item {
                            assert!(
                                served(&id).is_some(),
                                "device {d} announces {id:?}, which it does not serve now"
                            );
                        }
                    }
                }
                _ => {}
            }
        }
    }

    /// The bytes of the liar's largest event that `plaintext` carries.
    fn huge_bytes(&self, plaintext: &[u8]) -> u64 {
        let Some(id) = self.huge else {
            return 0;
        };
        decode(plaintext)
            .into_iter()
            .filter_map(|f| match f {
                Frame::Event(b)
                | Frame::Response(Response {
                    result: ResponseResult::Event(b),
                    ..
                }) => Some(b),
                _ => None,
            })
            .filter(|b| {
                matches!(wire::decode_event_blob(b, 1), Ok(EventObject::Message(e)) if e.event_id() == id)
            })
            .map(|b| b.len() as u64)
            .sum()
    }

    /// The most times one ID was announced by the hostile members.
    fn announced_most(&self) -> u64 {
        let mut counts: BTreeMap<EventId, u64> = BTreeMap::new();
        for d in &self.devs {
            for id in &d.announced_log {
                *counts.entry(*id).or_default() += 1;
            }
        }
        counts.values().copied().max().unwrap_or(0)
    }

    // ── Hostile members ──────────────────────────────────────────────────────

    fn hostile_step(&mut self, d: usize) {
        let kind = self.devs[d].hostile.expect("hostile");
        let chat = self.chat();
        let inbox = core::mem::take(&mut self.devs[d].inbox);
        let (arrived, later): (Vec<Mail>, Vec<Mail>) =
            inbox.into_iter().partition(|m| m.at <= self.now);
        self.devs[d].inbox = later;
        for m in arrived {
            for f in decode(&m.bytes) {
                match f {
                    Frame::Event(b) => self.devs[d].seen.push(b),
                    Frame::Response(Response {
                        result: ResponseResult::Event(b),
                        ..
                    }) => {
                        self.devs[d].seen.push(b);
                    }
                    Frame::Query(q)
                        if matches!(
                            kind,
                            Hostility::Liar | Hostility::Announcer | Hostility::Staller
                        ) =>
                    {
                        // The liar answers invalid data or endless pages; the announcer
                        // answers "not available" to everything it announced, and "restart"
                        // to half of the page requests, which the requester must bound; the
                        // staller answers `busy`, `expired` or `restart` to everything.
                        let frames: Vec<Frame> = q
                            .entries
                            .iter()
                            .enumerate()
                            .map(|(i, e)| {
                                let result = if kind == Hostility::Liar {
                                    self.lie(d, e)
                                } else if kind == Hostility::Staller {
                                    self.counters.stalled_answers += 1;
                                    ResponseResult::Status(match below(&mut self.rng, 3) {
                                        0 => Status::Busy,
                                        1 => Status::Expired,
                                        _ => Status::Restart,
                                    })
                                } else if matches!(e, QueryEntry::Op(QueryOp::TipsScan { .. }))
                                    && chance(&mut self.rng, 50)
                                {
                                    ResponseResult::Status(Status::Restart)
                                } else {
                                    ResponseResult::Status(Status::NotAvailable)
                                };
                                Frame::Response(Response {
                                    request_id: Some(q.request_id),
                                    idx: i as u32,
                                    result,
                                })
                            })
                            .collect();
                        if kind == Hostility::Liar {
                            self.counters.invalid_answers += frames.len() as u64;
                        }
                        let to = self.devs[m.from].id;
                        for chunk in frames.chunks(16) {
                            if let Ok(pt) = wire::encode_plaintext(chunk) {
                                self.transmit(d, to, pt);
                            }
                        }
                    }
                    _ => {}
                }
            }
        }
        let fake = |rng: &mut TestRng, now: u64| EventId::new(now - below(rng, DAY), bytes(rng));
        let target = member(below(&mut self.rng, self.devs.len() as u64) as usize);
        if target == self.devs[d].id {
            return;
        }
        if kind == Hostility::Liar && !self.devs[d].pushed_huge && self.now > START + HOUR {
            // Once, an event of the largest size, valid, to one honest device: the others
            // fetch it from there, in answers.
            self.devs[d].pushed_huge = true;
            self.counters.huge_events += 1;
            let e = largest_event(&self.root, self.devs[d].id, self.now, &mut self.rng);
            self.huge = Some(e.event_id());
            let blob = wire::encode_event_blob(&EventObject::Message(e)).expect("fits");
            let pt = wire::encode_plaintext(&[Frame::Event(blob)]).expect("fits");
            self.transmit(d, member(0), pt);
        }
        if kind == Hostility::Flooder && chance(&mut self.rng, 4) {
            // A query frame of lookups of fake IDs and a scan, to be answered.
            let mut entries: Vec<QueryEntry> = (0..15)
                .map(|_| {
                    QueryEntry::Op(QueryOp::Event {
                        chat_id: chat,
                        event_id: fake(&mut self.rng, self.now),
                    })
                })
                .collect();
            entries.push(QueryEntry::Op(QueryOp::TipsScan {
                anchor: chat,
                scan_id: crate::ids::ScanId::from_bytes(bytes(&mut self.rng)),
                offset: 0,
            }));
            self.counters.query_floods += entries.len() as u64;
            let q = Frame::Query(crate::wire::Query {
                request_id: crate::ids::RequestId::from_bytes(bytes(&mut self.rng)),
                sent_at: self.now,
                ttl: MINUTE,
                entries,
            });
            if let Ok(pt) = wire::encode_plaintext(&[q]) {
                self.transmit(d, target, pt);
            }
        }
        let mut ids: Vec<EventId> = Vec::new();
        match kind {
            Hostility::Announcer if chance(&mut self.rng, 20) => {
                for _ in 0..2 {
                    let id = fake(&mut self.rng, self.now);
                    self.devs[d].announced.push(id);
                    ids.push(id);
                }
                // It announces again what it announced before.
                let earlier = self.devs[d].announced.len();
                if earlier > 4 {
                    let i = below(&mut self.rng, earlier as u64 - 2) as usize;
                    ids.push(self.devs[d].announced[i]);
                }
                if let Some(b) = self.devs[d].seen.last()
                    && let Ok(EventObject::Message(e)) = wire::decode_event_blob(b, 1)
                {
                    ids.push(e.event_id());
                }
            }
            Hostility::Flooder if chance(&mut self.rng, 4) => {
                for i in 0..16 {
                    if i % 2 == 0 {
                        // Dated one to ten years ahead.
                        self.counters.far_ahead_ids += 1;
                        let ahead = (1 + below(&mut self.rng, 10)) * 365 * DAY;
                        ids.push(EventId::new(self.now + ahead, bytes(&mut self.rng)));
                    } else {
                        ids.push(fake(&mut self.rng, self.now));
                    }
                }
            }
            _ => {}
        }
        if ids.is_empty() {
            return;
        }
        self.counters.fake_notices += ids.len() as u64;
        self.devs[d].announced_log.extend(ids.iter().copied());
        let n = Frame::Notice(Notice {
            entries: ids
                .into_iter()
                .map(|id| Entry {
                    chat_id: chat,
                    item: EntryItem::Event(id),
                })
                .collect(),
        });
        let pt = wire::encode_plaintext(&[n]).expect("notice");
        self.transmit(d, target, pt);
    }

    /// An invalid answer to `e`: another event than the one asked, a page of another scan,
    /// or bytes that do not decode.
    fn lie(&mut self, d: usize, e: &QueryEntry) -> ResponseResult {
        match e {
            QueryEntry::Op(QueryOp::TipsScan {
                scan_id, offset, ..
            }) if chance(&mut self.rng, 50) => {
                // A valid page of a list said to hold a billion entries.
                self.counters.huge_pages += 1;
                ResponseResult::Page(Page {
                    scan_id: *scan_id,
                    offset: *offset,
                    count: 1_000_000_000_u64.saturating_sub(*offset).max(1),
                    entries: vec![Entry {
                        chat_id: self.chat(),
                        item: EntryItem::Event(EventId::new(
                            self.now - below(&mut self.rng, DAY),
                            bytes(&mut self.rng),
                        )),
                    }],
                })
            }
            QueryEntry::Op(QueryOp::TipsScan { offset, .. }) => ResponseResult::Page(Page {
                scan_id: crate::ids::ScanId::from_bytes(bytes(&mut self.rng)),
                offset: *offset,
                count: 0,
                entries: Vec::new(),
            }),
            _ => match self.devs[d].seen.first() {
                Some(b) if chance(&mut self.rng, 70) => ResponseResult::Event(b.clone()),
                _ => ResponseResult::Event(vec![1, 0x0a, 0x03, 1, 2, 3]),
            },
        }
    }

    // ── The run ──────────────────────────────────────────────────────────────

    fn honest(&self) -> Vec<usize> {
        (0..self.devs.len())
            .filter(|d| self.devs[*d].hostile.is_none())
            .collect()
    }

    /// Moves time to the next device action and runs it.
    fn advance(&mut self) {
        let (d, at) = self
            .devs
            .iter()
            .enumerate()
            .map(|(i, dev)| (i, dev.next))
            .min_by_key(|(i, at)| (*at, *i))
            .expect("devices");
        self.now = self.now.max(at);
        let poll = 25 * SECOND + below(&mut self.rng, 10 * SECOND);
        if self.devs[d].hostile.is_some() {
            self.step(d);
            self.devs[d].next = self.now + poll;
            return;
        }
        if !self.devs[d].online {
            self.go_online(d);
        }
        self.devs[d].last_step = self.now;
        self.step(d);
        if self.final_phase || self.now < self.devs[d].session_end {
            self.devs[d].next = if self.devs[d].wakeup_driven {
                let wake = self.wakeup(d);
                // Steps where it relied on the engine's wake-up to come back.
                self.counters.wakeup_steps += u64::from(wake > self.now + poll);
                wake.max(self.now + poll)
            } else {
                self.now + poll
            };
        } else {
            self.go_offline(d);
        }
    }

    /// When a wake-up driven device next polls: the engine's next wake-up (on its clock)
    /// or the next plaintext's arrival, whichever comes first. The caller then waits at
    /// least one poll interval, as an application coalescing its wake-ups would: the engine
    /// asks for each timer at its own instant, and polling at every one of them would send
    /// one plaintext per timed-out lookup instead of batching them.
    fn wakeup(&self, d: usize) -> u64 {
        let dev = &self.devs[d];
        let engine = dev
            .node
            .as_ref()
            .expect("booted")
            .next_wakeup(&dev.store, self.clock(d))
            .expect("wakeup")
            .map_or(u64::MAX, |t| t.saturating_add_signed(-dev.skew));
        let mail = dev.inbox.iter().map(|m| m.at).min().unwrap_or(u64::MAX);
        engine.min(mail)
    }

    fn go_online(&mut self, d: usize) {
        let session = MINUTE + below(&mut self.rng, 10 * MINUTE);
        let dev = &mut self.devs[d];
        dev.online = true;
        dev.session_end = self.now + session;
        if dev.slept {
            // Back from days offline: what was sent meanwhile is gone from the backend, so
            // what it missed can only come back through scans.
            dev.slept = false;
            dev.inbox.clear();
            self.sleeper_back = Some(d);
            let at = self.clock(0);
            let chat = self.chat();
            let mut behind = BTreeSet::new();
            for (i, other) in self.devs.iter().enumerate() {
                if i != d && other.hostile.is_none() && !other.local_changes {
                    behind.extend(behind_pruned(&other.store, &chat, at));
                }
            }
            self.behind = behind.into_iter().collect();
        }
    }

    fn go_offline(&mut self, d: usize) {
        let gap = match below(&mut self.rng, 10) {
            0..=4 => 5 * MINUTE + below(&mut self.rng, 30 * MINUTE),
            5..=8 => HOUR + below(&mut self.rng, 4 * HOUR),
            _ => 6 * HOUR + below(&mut self.rng, 12 * HOUR),
        };
        let sleep = 2 * DAY + below(&mut self.rng, 2 * DAY);
        let mut next = self.now + gap;
        let dev = &self.devs[d];
        if dev.sleeper && !dev.slept && self.counters.sleeps == 0 && self.now > START + 2 * HOUR {
            next = self.now + sleep;
            self.devs[d].slept = true;
            self.counters.sleeps += 1;
            // The others keep going while it sleeps.
            self.end_active = self.end_active.max(next + 4 * HOUR);
            // Shortly before it comes back, a message ends up behind a pruned event, and
            // nothing else is published until it is back.
            self.script = Some((next - 2 * HOUR, next));
        }
        self.devs[d].online = false;
        self.devs[d].next = next;
        // Device 0 runs the script: it is online when the quiet period starts.
        if let Some((at, _)) = self.script
            && !self.script_done
            && self.now < at
        {
            self.devs[0].next = self.devs[0].next.min(at);
        }
    }

    fn run(&mut self) {
        while self.now < self.end_active {
            self.advance();
        }
        // Final period: every honest device stays reachable; nothing new is published. Fast
        // clocks are corrected: a receiver ignores queries sent more than 5 minutes in its
        // future (§11.3), so a device whose clock runs that fast cannot retrieve anything.
        self.final_phase = true;
        for d in 0..self.devs.len() {
            if self.devs[d].skew > 2 * MINUTE as i64 {
                self.devs[d].skew = below(&mut self.rng, 2 * MINUTE) as i64;
            }
        }
        for d in self.honest() {
            self.devs[d].next = self.devs[d]
                .next
                .min(self.now + below(&mut self.rng, MINUTE));
        }
        let end = self.now + env_u64("GROUPS_NET_FINAL").unwrap_or(FINAL_HOURS) * HOUR;
        while self.now < end {
            self.advance();
        }
    }
}

impl Sim {
    fn debug(&self, a: &Retained, b: &Retained, at: u64) {
        let chat = self.chat();
        let ra: BTreeSet<EventId> = a.0.iter().map(|r| r.event_id).collect();
        let rb: BTreeSet<EventId> = b.0.iter().map(|r| r.event_id).collect();
        let diff: Vec<EventId> = ra.symmetric_difference(&rb).copied().collect();
        eprintln!("now {} at {}", self.now, at);
        for (i, dev) in self.devs.iter().enumerate() {
            eprintln!(
                "dev {i}: hostile {:?} local {} sleeper {} skew {}",
                dev.hostile, dev.local_changes, dev.sleeper, dev.skew
            );
            if let Some(n) = &dev.node {
                eprintln!(
                    "  neighbors {:?}",
                    n.neighbors(&chat)
                        .iter()
                        .map(|g| self.devs.iter().position(|d| d.id == *g).unwrap())
                        .collect::<Vec<_>>()
                );
                eprintln!("  tasks {:?} stats {:?}", n.task_count(), n.stats());
                n.debug_dump(&diff);
            }
            for id in &diff {
                let row = dev.store.event_row(&chat, id).unwrap();
                let tips = crate::dag::tips(&dev.store, &chat, at).unwrap();
                eprintln!(
                    "  {id:?}: {:?} tip {}",
                    row.map(|r| match r.state {
                        RowState::Held { role, .. } => format!("held {role:?}"),
                        s => format!("{s:?}"),
                    }),
                    tips.contains(id)
                );
            }
        }
    }
}

fn add_stats(a: &mut crate::node::Stats, b: &crate::node::Stats) {
    a.scans_completed += b.scans_completed;
    a.restarts += b.restarts;
    a.tasks_paused += b.tasks_paused;
    a.tasks_renewed += b.tasks_renewed;
    a.neighbors_replaced += b.neighbors_replaced;
    a.expired_resends += b.expired_resends;
    a.busy_sent += b.busy_sent;
    a.temporarily_invalid += b.temporarily_invalid;
    a.erased += b.erased;
}

/// The current messages whose carrier's children are all pruned: discoverable only because
/// a pruned child does not hide its parent from the tips (D.27).
fn behind_pruned(store: &Store, chat: &ChatId, now: u64) -> Vec<(SyncObjId, EventId)> {
    let rows: BTreeMap<EventId, EventRow> = store
        .event_rows(chat)
        .unwrap()
        .into_iter()
        .map(|r| (r.event_id, r))
        .collect();
    let mut children: BTreeMap<EventId, Vec<EventId>> = BTreeMap::new();
    for (c, ps) in store.edges(chat).unwrap() {
        for p in ps {
            children.entry(p).or_default().push(c);
        }
    }
    let mut out = Vec::new();
    for obj in store.objects(chat).unwrap() {
        for id in &obj.current_events {
            let Some(kids) = children.get(id) else {
                continue;
            };
            let all_pruned = kids
                .iter()
                .all(|k| rows.get(k).is_some_and(|r| r.state == RowState::Pruned));
            if all_pruned && rows.get(id).is_some_and(|r| r.available(now)) {
                out.push((obj.sync_obj_id, *id));
            }
        }
    }
    out
}

/// What converges between honest devices: retained rows, their parent links, the objects.
type Retained = (
    Vec<EventRow>,
    Vec<(EventId, Vec<EventId>)>,
    Vec<ObjectRecord>,
);

/// Whether `o` holds only a tombstone, or no result at all, with no event (§7.7). The timer
/// erases what it deletes, so under a timer such an object is what a deletion that arrives
/// after the erasure leaves; whether a device has one depends on arrival order, so such
/// objects are not compared.
fn timer_remnant(o: &ObjectRecord) -> bool {
    (o.is_deleted() || o.current.is_none())
        && o.current_events.is_empty()
        && o.pending_versions.is_empty()
        && o.pending_deletions.is_empty()
}

fn retained(store: &Store, chat: &ChatId, timed: bool) -> Retained {
    let rows: Vec<EventRow> = store
        .event_rows(chat)
        .unwrap()
        .into_iter()
        .filter(|r| matches!(r.state, RowState::Held { .. }))
        .collect();
    let held: BTreeSet<EventId> = rows.iter().map(|r| r.event_id).collect();
    let edges = store
        .edges(chat)
        .unwrap()
        .into_iter()
        .filter(|(c, _)| held.contains(c))
        .collect();
    // The stubs an object lists for the timer to erase are compared as the stub rows are:
    // not at all. They name the pruned events this device knows, which differ by design.
    let objects = store
        .objects(chat)
        .unwrap()
        .into_iter()
        .filter(|o| !(timed && timer_remnant(o)))
        .map(|mut o| {
            o.stubs.clear();
            o
        })
        .collect();
    (rows, edges, objects)
}

fn results(store: &Store, chat: &ChatId, timed: bool) -> BTreeMap<SyncObjId, Option<StoredResult>> {
    store
        .objects(chat)
        .unwrap()
        .into_iter()
        .filter(|o| !(timed && timer_remnant(o)))
        .map(|o| (o.sync_obj_id, o.current))
        .collect()
}

fn explain(a: &Retained, b: &Retained, label: &str) -> String {
    let ra: BTreeMap<_, _> = a.0.iter().map(|r| (r.event_id, r)).collect();
    let rb: BTreeMap<_, _> = b.0.iter().map(|r| (r.event_id, r)).collect();
    for id in ra.keys().chain(rb.keys()) {
        if ra.get(id) != rb.get(id) {
            return format!(
                "{label}: row {id:?}:\n  {:?}\n  {:?}",
                ra.get(id).map(|r| &r.state),
                rb.get(id).map(|r| &r.state)
            );
        }
    }
    if a.1 != b.1 {
        return format!("{label}: edges differ");
    }
    let oa: BTreeMap<_, _> = a.2.iter().map(|o| (o.sync_obj_id, o)).collect();
    let ob: BTreeMap<_, _> = b.2.iter().map(|o| (o.sync_obj_id, o)).collect();
    for id in oa.keys().chain(ob.keys()) {
        if oa.get(id) != ob.get(id) {
            return format!(
                "{label}: object {id:?}:\n  {:?}\n  {:?}",
                oa.get(id),
                ob.get(id)
            );
        }
    }
    format!("{label}: objects differ")
}

fn run(seed: u64, hours: u64) -> Counters {
    let mut sim = Sim::new(seed, hours);
    sim.run();
    let chat = sim.chat();
    // A common instant: every honest device ticks at the latest device clock.
    let at = sim
        .devs
        .iter()
        .enumerate()
        .map(|(d, _)| sim.clock(d))
        .max()
        .unwrap();
    for d in sim.honest() {
        let dev = &mut sim.devs[d];
        let node = dev.node.as_mut().expect("booted");
        node.tick(&mut dev.store, at, &mut sim.rng).expect("tick");
        check_invariants(&dev.store, &chat, at).unwrap_or_else(|e| panic!("device {d}: {e}"));
    }
    let honest = sim.honest();
    let clean: Vec<usize> = honest
        .iter()
        .copied()
        .filter(|d| !sim.devs[*d].local_changes)
        .collect();
    assert!(clean.len() >= 2, "fewer than two devices compared");
    let timed = sim.root.message_timer() > 0;
    // Under a message timer, no honest device keeps a message past its moment, and none
    // keeps an object past the moment the timer erases it (§7.7).
    if timed {
        for &d in &honest {
            for o in sim.devs[d].store.objects(&chat).unwrap() {
                if let Some(StoredResult::Content(c)) = &o.current {
                    let moment = crate::epoch::moment(c, sim.root.message_timer());
                    assert!(
                        moment.is_none_or(|m| m > at),
                        "device {d} keeps a message past its moment"
                    );
                }
                assert!(
                    o.erase_at.is_none_or(|e| e > at),
                    "device {d} keeps an object past its erasure"
                );
            }
            let dev = &sim.devs[d];
            let node = dev.node.as_ref().expect("booted");
            sim.counters.timer_deletions += dev.stats_before.erased + node.stats().erased;
        }
    }
    let reference = retained(&sim.devs[clean[0]].store, &chat, timed);
    let reference_results = results(&sim.devs[clean[0]].store, &chat, timed);
    for &d in &honest {
        if sim.devs[d].local_changes {
            // Its own alterations differ on purpose; every other message converges.
            continue;
        }
        let mine = retained(&sim.devs[d].store, &chat, timed);
        if mine != reference && std::env::var("GROUPS_NET_DEBUG").is_ok() {
            sim.debug(&mine, &reference, at);
        }
        assert!(
            mine == reference,
            "{}",
            explain(
                &mine,
                &reference,
                &format!("device {d} against device {}", clean[0])
            )
        );
        assert_eq!(results(&sim.devs[d].store, &chat, timed), reference_results);
    }
    // (b) The sleeper holds the current messages that were behind pruned events.
    if let Some(s) = sim.sleeper_back
        && !sim.devs[s].local_changes
    {
        for (sync, id) in &sim.behind {
            let remnant = |o: Option<ObjectRecord>| o.filter(|o| !(timed && timer_remnant(o)));
            let obj = remnant(sim.devs[s].store.object(&chat, sync).unwrap());
            let cur = remnant(sim.devs[clean[0]].store.object(&chat, sync).unwrap());
            assert_eq!(
                obj.as_ref().map(|o| &o.current),
                cur.as_ref().map(|o| &o.current),
                "sleeper misses {id:?}"
            );
        }
        sim.counters.behind_pruned += sim.behind.len() as u64;
    }
    // (c) Work per device and hour. The liar's largest event, counted apart, is sent by
    // each device at most twice per other member (a resend after a crash or `expired`
    // may repeat one).
    for (d, dev) in sim.devs.iter().enumerate() {
        let most = 2 * (sim.devs.len() as u64 - 1);
        assert!(
            dev.huge_sends <= most,
            "device {d} sent the largest event {} times",
            dev.huge_sends
        );
        for (h, (p, b, l)) in &dev.hours {
            assert!(
                *p <= LIMITS.plaintexts,
                "device {d}, hour {h}: {p} plaintexts"
            );
            assert!(*b <= LIMITS.bytes, "device {d}, hour {h}: {b} bytes");
            assert!(*l <= LIMITS.lookups, "device {d}, hour {h}: {l} lookups");
            sim.counters.max_plaintexts_hour = sim.counters.max_plaintexts_hour.max(*p);
            sim.counters.max_bytes_hour = sim.counters.max_bytes_hour.max(*b);
            sim.counters.max_lookups_hour = sim.counters.max_lookups_hour.max(*l);
        }
    }
    // Honest members, all reachable during the final period, end credible and responsive
    // in each other's view.
    for &d in &honest {
        let node = sim.devs[d].node.as_ref().expect("booted");
        for &h in &honest {
            if h != d {
                let id = sim.devs[h].id;
                // A member that deletes locally answers "not available" for what it
                // announced, as one announcing fake IDs does: for deniability the two must
                // not be told apart, so its score is not checked.
                assert!(
                    sim.devs[h].local_changes || node.score(&id) >= crate::node::CREDIBLE,
                    "device {d} scores honest device {h} (local changes {}) at {}",
                    sim.devs[h].local_changes,
                    node.score(&id)
                );
                // Transit delays answers by up to 7 hours: the last few queries before
                // this instant may be unanswered yet, which is no lasting misjudgement.
                assert!(
                    node.responsive(&id) || node.unanswered_ms(&id) < HOUR,
                    "device {d} holds honest device {h} (sleeper {}, wake-up driven {}) unresponsive",
                    sim.devs[h].sleeper,
                    sim.devs[h].wakeup_driven
                );
            }
        }
    }
    // (d) Hostile members rank below every honest one that supplied something.
    for &d in &honest {
        let node = sim.devs[d].node.as_ref().expect("booted");
        for (h, dev) in sim.devs.iter().enumerate() {
            if matches!(dev.hostile, Some(Hostility::Liar | Hostility::Announcer)) {
                assert!(
                    node.score(&dev.id) < 500_000,
                    "device {d} ranks liar {h} at {}",
                    node.score(&dev.id)
                );
            }
        }
    }
    // Temporarily invalid markers met on the way, and the engines' counters.
    for &d in &honest {
        let dev = &mut sim.devs[d];
        let node = dev.node.take().expect("booted");
        add_stats(&mut dev.stats_before, node.stats());
        let s = &dev.stats_before;
        sim.counters.scans_completed += s.scans_completed;
        sim.counters.restarts += s.restarts;
        sim.counters.tasks_paused += s.tasks_paused;
        sim.counters.tasks_renewed += s.tasks_renewed;
        sim.counters.neighbors_replaced += s.neighbors_replaced;
        sim.counters.expired_resends += s.expired_resends;
        sim.counters.busy += s.busy_sent;
        sim.counters.temporarily_invalid += s.temporarily_invalid;
        dev.node = Some(node);
    }
    let most_runs = sim.announced_most() + sim.counters.session_resets + 2;
    // No task retries forever: alone, without answers, every task ends within its lookup
    // deadline or its twenty stages (a sync-object lookup has no deadline).
    for &d in &honest {
        let dev = &mut sim.devs[d];
        let node = dev.node.as_mut().expect("booted");
        // A paused task is renewed only by new evidence (§11.5): an announcement, a page
        // listing it, or a reconnection. Hostile members announce the same fake ID again and
        // again; each announcement may renew it once.
        let most = most_runs;
        assert!(
            u64::from(node.max_task_runs()) <= most,
            "device {d}: a task ran {} times, more than {most}",
            node.max_task_runs()
        );
        sim.counters.max_task_runs = sim
            .counters
            .max_task_runs
            .max(u64::from(node.max_task_runs()));
        // Alone for 40 days, then 40 more days with every request answered at once by a
        // peer that never supplies anything (busy, expired, restart, not available, endless
        // pages): every task, scan, queued item and correlation reference ends either way.
        let mut t = at;
        for answering in [false, true] {
            let until = t + 40 * DAY;
            let before = node.pending_ids();
            while t < until {
                t += 6 * HOUR;
                let mut inbox: Vec<(GossipId, Vec<u8>)> = Vec::new();
                node.tick(&mut dev.store, t, &mut sim.rng).expect("tick");
                for _ in 0..8 {
                    for (from, pt) in core::mem::take(&mut inbox) {
                        node.handle_plaintext(&mut dev.store, from, &pt, t, &mut sim.rng)
                            .expect("receive");
                    }
                    for o in node
                        .poll_outbox(&mut dev.store, t, &mut sim.rng)
                        .expect("poll")
                    {
                        node.handed_off(&mut dev.store, o.handle, t, &mut sim.rng)
                            .expect("handoff");
                        if answering {
                            let frames = stubborn_answers(&mut sim.rng, &chat, &o.plaintext);
                            for chunk in frames.chunks(16) {
                                if let Ok(pt) = wire::encode_plaintext(chunk) {
                                    inbox.push((o.to, pt));
                                }
                            }
                        }
                    }
                }
            }
            assert_eq!(node.task_count(), (0, 0), "device {d}: tasks left");
            let left: Vec<String> = node.pending_ids().intersection(&before).cloned().collect();
            assert!(
                left.is_empty(),
                "device {d}: still pending after 40 days (answering: {answering}): {left:?}"
            );
        }
    }
    sim.counters
}

/// The largest message event `author` can create at `now`: its blob fits the admission
/// limit exactly.
fn largest_event(
    root: &Root,
    author: GossipId,
    now: u64,
    rng: &mut TestRng,
) -> crate::event::MessageEvent {
    let id = EventId::new(now, bytes(rng));
    let sync = SyncObjId::from_bytes(bytes(rng));
    let make = |n: usize| {
        crate::event::MessageEvent::create(
            root,
            id,
            &[],
            crate::event::Payload::Content(crate::event::Content {
                sync_obj_id: sync,
                author,
                created_at: now,
                last_modified_at: now,
                body: Body::Media(crate::Media {
                    mimetype: "application/octet-stream".into(),
                    data: vec![7; n],
                }),
                edited: false,
                metadata: BTreeMap::new(),
            }),
        )
    };
    let (mut lo, mut hi) = (0, crate::constants::MAX_PLAINTEXT_BYTES);
    while lo + 1 < hi {
        let mid = usize::midpoint(lo, hi);
        if make(mid).is_ok() {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    make(lo).expect("fits")
}

/// The answers of a peer that answers every request at once and never supplies anything:
/// `busy`, `expired` or "not available" to lookups, and `busy`, `expired`, `restart` or a
/// page of one fake ID out of a list said to be huge to page requests.
fn stubborn_answers(rng: &mut TestRng, chat: &ChatId, plaintext: &[u8]) -> Vec<Frame> {
    let mut out = Vec::new();
    for f in decode(plaintext) {
        let Frame::Query(q) = f else { continue };
        for (i, e) in q.entries.iter().enumerate() {
            let roll = below(rng, 4);
            let result = match e {
                QueryEntry::Op(QueryOp::TipsScan {
                    scan_id, offset, ..
                }) if roll == 3 => ResponseResult::Page(Page {
                    scan_id: *scan_id,
                    offset: *offset,
                    count: 1_000_000_000 - offset,
                    entries: vec![Entry {
                        chat_id: *chat,
                        item: EntryItem::Event(EventId::new(START, bytes(rng))),
                    }],
                }),
                QueryEntry::Op(QueryOp::TipsScan { .. }) if roll == 2 => {
                    ResponseResult::Status(Status::Restart)
                }
                _ if roll == 2 => ResponseResult::Status(Status::NotAvailable),
                _ if roll == 1 => ResponseResult::Status(Status::Expired),
                _ => ResponseResult::Status(Status::Busy),
            };
            out.push(Frame::Response(Response {
                request_id: Some(q.request_id),
                idx: i as u32,
                result,
            }));
        }
    }
    out
}

fn env_u64(name: &str) -> Option<u64> {
    std::env::var(name).ok().map(|v| {
        v.trim()
            .parse()
            .unwrap_or_else(|_| panic!("{name} must be an integer"))
    })
}

#[test]
fn network_simulation() {
    let hours = env_u64("GROUPS_NET_HOURS").unwrap_or(8);
    let single = env_u64("GROUPS_NET_SEED");
    let seeds: Vec<u64> = match single {
        Some(seed) => vec![seed],
        None => {
            let first = env_u64("GROUPS_NET_FIRST").unwrap_or(0);
            let count = env_u64("GROUPS_NET_SEEDS").unwrap_or(5);
            (first..first + count).collect()
        }
    };
    let mut total = Counters::default();
    for seed in &seeds {
        let seed = *seed;
        match std::panic::catch_unwind(|| run(seed, hours)) {
            Ok(c) => total.add(&c),
            Err(panic) => {
                eprintln!(
                    "network simulation failed with seed {seed} ({hours} hours); replay with \
                     GROUPS_NET_SEED={seed} GROUPS_NET_HOURS={hours} cargo test -p groups \
                     network_simulation"
                );
                std::panic::resume_unwind(panic);
            }
        }
    }
    eprintln!(
        "network simulation counters over {} seeds: {total:?}",
        seeds.len()
    );
    if single.is_none() && seeds.len() >= 5 {
        assert!(
            total.missing().is_empty(),
            "situations never exercised: {:?}",
            total.missing()
        );
    }
}
