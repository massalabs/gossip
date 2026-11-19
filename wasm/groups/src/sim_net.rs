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
//! page requests), **liar** (answers every query with invalid data) and **flooder** (floods
//! notices of fake IDs and never answers).
//!
//! Properties checked:
//!
//! - (a) **convergence**: after a final period in which every honest device stays reachable
//!   (72 hours by default, clocks corrected), every honest device without local-only changes holds, at a
//!   common instant, the same retained events (rows and their parent links) and the same
//!   objects, hence the same results; devices with local-only changes differ on purpose and
//!   are checked for consistency only. Pruned stubs are not compared: an ID pruned everywhere
//!   before a device heard of it can never reach that device, by design (§9.3, §11.7);
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
//! - `GROUPS_NET_SEEDS=<n>`: run seeds `GROUPS_NET_FIRST` (default 0) to `+ n`;
//! - `GROUPS_NET_HOURS=<n>`: hours of activity per run (default 8);
//! - `GROUPS_NET_FINAL=<n>`: hours of the final period (default 72);
//! - `GROUPS_NET_DEBUG=1`: on a divergence, print the engines' state.

use std::collections::{BTreeMap, BTreeSet};

use crate::epoch::check_invariants;
use crate::event::Body;
use crate::ids::{ChatId, EventId, GossipId, SyncObjId};
use crate::node::tests::{config, epoch_root, member};
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
        let root = epoch_root(n, 0x20 + (seed % 200) as u8);
        let kinds = [
            Hostility::Silent,
            Hostility::Announcer,
            Hostility::Liar,
            Hostility::Flooder,
        ];
        let mut counters = Counters::default();
        let devs = (0..n)
            .map(|i| {
                // Every kind occurs in any four consecutive seeds.
                let hostile = (i >= honest).then(|| kinds[(seed as usize + i - honest) % 4]);
                match hostile {
                    Some(Hostility::Silent) => counters.silent += 1,
                    Some(Hostility::Announcer) => counters.announcer += 1,
                    Some(Hostility::Liar) => counters.liar += 1,
                    Some(Hostility::Flooder) => counters.flooder += 1,
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
                    local_changes: i > 0
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
        if chance(&mut self.rng, 1) {
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
        let results = self.devs[d]
            .node
            .as_mut()
            .map(Node::take_lookup_results)
            .unwrap_or_default();
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
            self.op(d, |n, s, now, rng| n.handed_off(s, handle, now, rng))
                .expect("handoff");
            let e = self.devs[d].hours.entry(hour).or_default();
            e.0 += 1;
            e.1 += o.plaintext.len() as u64;
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
                    Frame::Query(q) if matches!(kind, Hostility::Liar | Hostility::Announcer) => {
                        // The liar answers invalid data; the announcer answers "not
                        // available" to everything it announced, and "restart" to half of
                        // the page requests, which the requester must bound.
                        let frames: Vec<Frame> = q
                            .entries
                            .iter()
                            .enumerate()
                            .map(|(i, e)| {
                                let result = if kind == Hostility::Liar {
                                    self.lie(d, e)
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
                for _ in 0..16 {
                    ids.push(fake(&mut self.rng, self.now));
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
            skipped: 0,
        });
        let pt = wire::encode_plaintext(&[n]).expect("notice");
        self.transmit(d, target, pt);
    }

    /// An invalid answer to `e`: another event than the one asked, a page of another scan,
    /// or bytes that do not decode.
    fn lie(&mut self, d: usize, e: &QueryEntry) -> ResponseResult {
        match e {
            QueryEntry::Op(QueryOp::TipsScan { offset, .. }) => ResponseResult::Page(Page {
                scan_id: crate::ids::ScanId::from_bytes(bytes(&mut self.rng)),
                offset: *offset,
                count: 0,
                entries: Vec::new(),
                skipped: 0,
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

fn retained(store: &Store, chat: &ChatId) -> Retained {
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
    (rows, edges, store.objects(chat).unwrap())
}

fn results(store: &Store, chat: &ChatId) -> BTreeMap<SyncObjId, Option<StoredResult>> {
    store
        .objects(chat)
        .unwrap()
        .into_iter()
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
    let reference = retained(&sim.devs[clean[0]].store, &chat);
    let reference_results = results(&sim.devs[clean[0]].store, &chat);
    for &d in &honest {
        if sim.devs[d].local_changes {
            // Its own alterations differ on purpose; every other message converges.
            continue;
        }
        let mine = retained(&sim.devs[d].store, &chat);
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
        assert_eq!(results(&sim.devs[d].store, &chat), reference_results);
    }
    // (b) The sleeper holds the current messages that were behind pruned events.
    if let Some(s) = sim.sleeper_back
        && !sim.devs[s].local_changes
    {
        for (sync, id) in &sim.behind {
            let obj = sim.devs[s].store.object(&chat, sync).unwrap();
            let cur = sim.devs[clean[0]].store.object(&chat, sync).unwrap();
            assert_eq!(
                obj.as_ref().map(|o| &o.current),
                cur.as_ref().map(|o| &o.current),
                "sleeper misses {id:?}"
            );
        }
        sim.counters.behind_pruned += sim.behind.len() as u64;
    }
    // (c) Work per device and hour.
    for (d, dev) in sim.devs.iter().enumerate() {
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
        let mut t = at;
        while t < at + 40 * DAY {
            t += 6 * HOUR;
            node.tick(&mut dev.store, t, &mut sim.rng).expect("tick");
            for o in node
                .poll_outbox(&mut dev.store, t, &mut sim.rng)
                .expect("poll")
            {
                node.handed_off(&mut dev.store, o.handle, t, &mut sim.rng)
                    .expect("handoff");
            }
        }
        assert_eq!(node.task_count(), (0, 0), "device {d}: tasks left");
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
fn network_simulation() {
    let hours = env_u64("GROUPS_NET_HOURS").unwrap_or(8);
    let single = env_u64("GROUPS_NET_SEED");
    let seeds: Vec<u64> = match single {
        Some(seed) => vec![seed],
        None => {
            let first = env_u64("GROUPS_NET_FIRST").unwrap_or(0);
            let count = env_u64("GROUPS_NET_SEEDS").unwrap_or(4);
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
    if single.is_none() && seeds.len() >= 4 {
        assert!(
            total.missing().is_empty(),
            "situations never exercised: {:?}",
            total.missing()
        );
    }
}
