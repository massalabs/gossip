//! The running mobile node: links from the radio, the replication engine, the bridge.

use std::collections::{HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use crossbeam::channel::{bounded, unbounded, Receiver, RecvTimeoutError, Sender};
use gossip_pools::{InsertOutcome, Pools, PoolsConfig, Source};
use gossip_repl::handler::cache::BlobCache;
use gossip_repl::handler::commands_propagation::PropagationCommand;
use gossip_repl::handler::commands_retrieval::RetrievalCommand;
use gossip_repl::handler::BlobHandler;
use gossip_repl::{
    BlobStore, FixedTrust, LinkInfo, LinkKind, Links, MeshConfig, MeshParts, NetEvent,
    PeerLimitsTable, PeerManagementCmd, PeerMessageTuple, PropagationConfig, ReplError,
};
use gossip_trust::schemes::pow::{PowConfig, PowScheme};
use gossip_trust::{TrustPolicy, TrustRecord, TrustRegistry};
use gossip_wire::{
    Beacon, BlobEnvelope, BlobId, BlobKind, KeyPair, Message, MessageTypeId,
    MessageTypeIdDeserializer, MessagesSerializer, PeerId, PeerLimits, Scope, UnixMillis,
    WANTED_SEEKER_LEN,
};
use massa_serialization::{DeserializeError, Deserializer};
use parking_lot::{Mutex, RwLock};

use crate::chunk::{self, Reassembler};
use crate::config::MobileConfig;
use crate::crypt::EncryptedFile;
use crate::handshake::{
    Admission, Done, Handshake, Step, CAP_BRIDGE, CAP_BULLETIN, DEDUPE_TOKEN_LEN,
};
use crate::seal::{LinkCipher, SEAL_OVERHEAD};
use crate::store::MobileStore;
use crate::upstream::{Upstream, UpstreamError};

/// File name of the pools inside the data directory.
pub const POOLS_FILE: &str = "mesh-pools.redb";
/// The pools' data key, wrapped by the app's key (destroyed by a wipe).
pub const POOLS_KEY_FILE: &str = "mesh-pools.key";
/// First wait before a blob an upstream did not take is offered again.
const UPLOAD_BACKOFF_MIN: Duration = Duration::from_secs(30);
/// Longest wait between two offers of the same blob.
const UPLOAD_BACKOFF_MAX: Duration = Duration::from_secs(30 * 60);
/// Where development builds saved the app's wanted seekers. Nothing writes it any more:
/// a list that outlives the app's session would show an account the app has locked
/// (`docs/MESH.md`, "Plausible deniability"). Overwritten and deleted when found.
pub const WANTED_FILE: &str = "mesh-wanted.bin";
/// A handshake not done after this closes the link.
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(20);
/// Most bytes queued toward one link before sends fail (the engine retries later).
const MAX_QUEUED: usize = 1024 * 1024;
/// Trust below which a peer counts against the low-trust link cap.
const LOW_TRUST: f64 = 0.2;
/// Scheme id of proof of work (`WIRE-PROTOCOL.md`, "Scheme formats").
const POW_SCHEME_ID: u16 = 3;
/// Trust weight of proof of work on phones.
const POW_WEIGHT: f64 = 0.3;
/// A bridge signs its beacons with a key it changes this often.
const BEACON_KEY_ROTATION: Duration = Duration::from_secs(60 * 60);

/// What the host does for the core (the radio and the app).
pub trait Host: Send + Sync {
    /// Queues one chunk on a link; `false` when the radio refused it.
    fn send_frame(&self, link: i32, frame: Vec<u8>) -> bool;
    /// Drops a link.
    fn close_link(&self, link: i32);
    /// Wanted messages and announcements just stored.
    fn arrival(&self, messages: Vec<(Vec<u8>, Vec<u8>)>, announcements: Vec<Vec<u8>>);
}

enum Phase {
    Handshaking(Option<Box<Handshake>>, Instant),
    Ready(PeerId),
    Closed,
}

/// Stream numbers of the two queues: each queue sends one message at a time, so a
/// stream is never reused while the peer still reassembles it.
const HIGH_STREAM: u8 = 0;
const LOW_STREAM: u8 = 1;
/// Most bytes of complete messages waiting for a busy handshake on one link.
const MAX_PENDING_BYTES: usize = 64 * 1024;

/// One priority queue of a link: whole messages, and the chunks of the one being sent.
#[derive(Default)]
struct Queue {
    messages: VecDeque<Vec<u8>>,
    chunks: VecDeque<Vec<u8>>,
}

impl Queue {
    fn clear(&mut self) {
        self.messages.clear();
        self.chunks.clear();
    }
}

struct LinkState {
    max_chunk: usize,
    phase: Phase,
    reasm: Reassembler,
    /// Seals and opens every message after the hellos.
    cipher: Option<LinkCipher>,
    /// Complete messages received while the handshake was busy.
    pending: VecDeque<Vec<u8>>,
    pending_bytes: usize,
    high: Queue,
    low: Queue,
    queued: usize,
    blocked_until: Option<Instant>,
    /// Close once the queue is empty (a refusal verdict must leave first).
    close_when_flushed: Option<String>,
}

impl LinkState {
    fn enqueue(&mut self, message: &[u8], high: bool) -> Result<(), ReplError> {
        let bytes = match &mut self.cipher {
            Some(c) => c.seal(message),
            None => message.to_vec(),
        };
        if self.queued + bytes.len() > MAX_QUEUED {
            return Err(ReplError::SendError("link queue full".into()));
        }
        self.queued += bytes.len();
        if high {
            self.high.messages.push_back(bytes);
        } else {
            self.low.messages.push_back(bytes);
        }
        Ok(())
    }

    /// The next chunk to send, high priority first, and which queue it is from.
    fn next_chunk(&mut self) -> Option<(Vec<u8>, bool)> {
        let max = self.max_chunk;
        for (high, stream) in [(true, HIGH_STREAM), (false, LOW_STREAM)] {
            let q = if high { &mut self.high } else { &mut self.low };
            if q.chunks.is_empty() {
                let Some(m) = q.messages.pop_front() else {
                    continue;
                };
                q.chunks = chunk::split(&m, max, stream).into();
                // chunk headers are counted from here on
                let headers: usize = q.chunks.iter().map(Vec::len).sum::<usize>() - m.len();
                self.queued += headers;
            }
            let q = if high { &self.high } else { &self.low };
            if let Some(c) = q.chunks.front() {
                return Some((c.clone(), high));
            }
        }
        None
    }

    /// The chunk returned by [`Self::next_chunk`] left.
    fn chunk_sent(&mut self, high: bool) {
        let q = if high { &mut self.high } else { &mut self.low };
        if let Some(c) = q.chunks.pop_front() {
            self.queued = self.queued.saturating_sub(c.len());
        }
    }

    /// Whether nothing is left to send.
    fn flushed(&self) -> bool {
        self.high.chunks.is_empty()
            && self.high.messages.is_empty()
            && self.low.chunks.is_empty()
            && self.low.messages.is_empty()
    }
}

/// A ready link as the engine sees it.
#[derive(Clone, Copy)]
struct ReadyLink {
    link: i32,
    trust: f64,
    compact: Option<[u8; 32]>,
    /// The peer's duplicate token.
    token: [u8; DEDUPE_TOKEN_LEN],
    /// Key both ends agree on for this link.
    link_key: [u8; 32],
    since: Instant,
}

/// The links, shared by the radio calls, the writer thread and the engine.
///
/// A full phone admits a newcomer by replacing its oldest link, at most once per
/// `replace_interval` and only for a link up for `min_replaced_age`: links that hold a
/// slot forever (an attacker that fills every slot) are replaced, without the churn of
/// rotating links on a timer.
pub struct LinkTable {
    links: Mutex<HashMap<i32, LinkState>>,
    replace_interval: Duration,
    min_replaced_age: Duration,
    by_peer: RwLock<HashMap<PeerId, ReadyLink>>,
    last_replacement: Mutex<Option<Instant>>,
    wake: Sender<()>,
}

impl LinkTable {
    fn ready_counts(&self) -> (usize, usize) {
        let peers = self.by_peer.read();
        (
            peers.len(),
            peers.values().filter(|r| r.trust < LOW_TRUST).count(),
        )
    }

    /// The link a newcomer may replace now, if any.
    fn replaceable(&self, by_peer: &HashMap<PeerId, ReadyLink>) -> Option<i32> {
        if self
            .last_replacement
            .lock()
            .is_some_and(|t| t.elapsed() < self.replace_interval)
        {
            return None;
        }
        by_peer
            .values()
            .filter(|r| r.since.elapsed() >= self.min_replaced_age)
            .min_by_key(|r| r.since)
            .map(|r| r.link)
    }
}

/// [`Links`] over the link table, for the engine.
#[derive(Clone)]
struct BleLinks(Arc<LinkTable>);

impl Links for BleLinks {
    fn send_to_peer(
        &self,
        peer_id: &PeerId,
        message_serializer: &MessagesSerializer,
        message: Message,
        _high_priority: bool,
    ) -> Result<(), ReplError> {
        let Some(link) = self.0.by_peer.read().get(peer_id).map(|r| r.link) else {
            return Err(ReplError::PeerDisconnected(peer_id.to_string()));
        };
        // announcements, asks and sync go ahead of queued blobs (high-priority streams);
        // wanted traffic shares the blobs' queue, so that a big table cannot starve them
        let high = !matches!(
            &message,
            Message::Blob(
                gossip_wire::BlobMessage::Blobs(_) | gossip_wire::BlobMessage::Wanted { .. }
            )
        );
        let mut bytes = Vec::new();
        message_serializer
            .serialize_message(&message, &mut bytes)
            .map_err(|e| ReplError::SendError(e.to_string()))?;
        if bytes.len() + SEAL_OVERHEAD > chunk::MAX_MESSAGE {
            return Err(ReplError::SendError("message above the mesh limit".into()));
        }
        {
            let mut links = self.0.links.lock();
            let Some(state) = links.get_mut(&link) else {
                return Err(ReplError::PeerDisconnected(peer_id.to_string()));
            };
            state.enqueue(&bytes, high)?;
        }
        let _ = self.0.wake.try_send(());
        Ok(())
    }

    fn clone_box(&self) -> Box<dyn Links> {
        Box::new(self.clone())
    }

    fn get_peer_ids_connected(&self) -> HashSet<PeerId> {
        self.0.by_peer.read().keys().copied().collect()
    }

    fn link_info(&self, peer_id: &PeerId) -> Option<LinkInfo> {
        self.0.by_peer.read().get(peer_id).map(|r| LinkInfo {
            kind: LinkKind::Ble,
            max_message_size: chunk::MAX_MESSAGE,
            bandwidth_bps: 0,
            compact_link_up: r.compact,
        })
    }
}

/// Link slots for the handshake.
struct Slots {
    table: Arc<LinkTable>,
    max_links: usize,
    max_low: usize,
    propagation: PropagationConfig,
}

impl Admission for Slots {
    fn admit(&self, _peer: &PeerId, record: &TrustRecord) -> bool {
        let (all, low) = self.table.ready_counts();
        let room =
            all < self.max_links || self.table.replaceable(&self.table.by_peer.read()).is_some();
        room && (record.value >= LOW_TRUST || low < self.max_low)
    }

    fn limits(&self, trust: f64) -> PeerLimits {
        let scale = gossip_repl::ingest_scale(trust);
        let p = &self.propagation;
        let c32 = |v: usize| u32::try_from(v).unwrap_or(u32::MAX);
        let s32 = |v: u64| u32::try_from((v as f64 * scale) as u64).unwrap_or(u32::MAX);
        PeerLimits {
            max_message_size: c32(chunk::MAX_MESSAGE),
            max_ids_per_message: c32(p.max_ids_per_message),
            max_blobs_per_message: c32(p.max_blobs_per_message),
            max_blobs_message_bytes: c32(p.max_blobs_message_bytes),
            max_sync_page: c32(p.sync_page_size),
            ingest_blobs_per_min: s32(p.peer_ingest_blobs_per_min),
            ingest_bytes_per_min: (p.peer_ingest_bytes_per_min as f64 * scale) as u64,
            unsolicited_blobs_per_min: gossip_repl::UNSOLICITED_BLOBS_PER_MIN,
            sync_requests_per_min: s32(p.peer_sync_requests_per_min),
        }
    }
}

/// Replication tuning of a phone (`docs/MESH.md`, "Phone defaults").
pub fn phone_propagation() -> PropagationConfig {
    PropagationConfig {
        announcement_interval_ms: 1000,
        batch_proc_period_ms: 500,
        max_ids_per_message: 2000,
        max_blobs_per_message: 8,
        max_blobs_message_bytes: 64 * 1024,
        max_known_blobs_size: 50_000,
        max_peer_known_blobs_size: 20_000,
        max_blobs_kept_for_propagation: 20_000,
        sync_page_size: 512,
        peer_ingest_bytes_per_min: 8 * 1024 * 1024,
        peer_ingest_blobs_per_min: 600,
        peer_egress_bytes_per_min: 8 * 1024 * 1024,
        max_payload_len: 65 * 1024,
        ..PropagationConfig::default()
    }
}

struct Upstreams {
    urls: Vec<String>,
    bridge: bool,
    reachable: bool,
}

/// One running node.
pub struct Core {
    cfg: MobileConfig,
    data_dir: PathBuf,
    store: Arc<MobileStore>,
    pools: Arc<Pools>,
    registry: Arc<TrustRegistry>,
    mesh: MeshParts,
    trust: Arc<FixedTrust>,
    limits: PeerLimitsTable,
    links: Arc<LinkTable>,
    host: Arc<dyn Host>,
    handler: Mutex<Option<BlobHandler>>,
    retrieval: Sender<RetrievalCommand>,
    propagation: Sender<PropagationCommand>,
    inbound: Sender<PeerMessageTuple>,
    /// Our duplicate token and when it was drawn: links show the same one to a peer for
    /// one epoch, so that it can tell two links to the same phone apart from two phones.
    dedupe: Mutex<([u8; DEDUPE_TOKEN_LEN], Instant)>,
    upstream: Mutex<Upstreams>,
    own_wanted: RwLock<HashSet<Vec<u8>>>,
    /// The app's local-only wanted seekers: never fetched upstream by this phone.
    own_local_wanted: RwLock<HashSet<Vec<u8>>>,
    /// Hashes of the key sets the app gave to `send_blob`, so that [`Self::lock`] can
    /// withdraw them. Memory only, emptied by a lock: the stored blobs carry no mark.
    shared_keys: Mutex<HashSet<[u8; 32]>>,
    /// Blobs an upstream did not take: when to offer each again, and how many tries.
    upload_backoff: Mutex<HashMap<BlobId, (Instant, u32)>>,
    beacon_key: Mutex<(KeyPair, Instant)>,
    stopping: Arc<AtomicBool>,
    threads: Mutex<Vec<JoinHandle<()>>>,
    sweeper: Mutex<Option<gossip_pools::SweeperHandle>>,
}

/// Status counters.
#[derive(Clone, Debug, Default)]
pub struct CoreStatus {
    /// Links whose handshake completed.
    pub mesh_peers: usize,
    /// Links still in handshake.
    pub handshaking: usize,
    /// Whether an upstream answered on the last bridge round.
    pub upstream_reachable: bool,
    /// Whether bridging is on.
    pub bridge_enabled: bool,
    /// Last bulletin counter.
    pub bulletin_counter: u64,
    /// Stored blobs.
    pub stored_blobs: u64,
    /// Mesh-only blobs.
    pub mesh_blobs: u64,
    /// Blobs waiting for an upload.
    pub upload_pending: u64,
    /// Wanted entries.
    pub wanted_entries: usize,
    /// Mesh clock correction.
    pub clock_offset_ms: i64,
    /// Current mesh peer id.
    pub peer_id: String,
}

fn open_pools(dir: &Path, cfg: &MobileConfig) -> Result<Arc<Pools>, String> {
    let path = dir.join(POOLS_FILE);
    let pools_cfg = PoolsConfig {
        mesh_retention_ms: cfg.mesh_retention_ms,
        mesh_max_bytes: cfg.mesh_max_bytes,
        mesh_max_blob_count: cfg.mesh_max_blob_count,
        // a phone stores mesh blobs only: the total caps follow the mesh ones
        max_total_bytes: cfg.mesh_max_bytes.saturating_mul(2),
        max_blob_count: cfg.mesh_max_blob_count.saturating_mul(2),
        sweep_interval: Duration::from_secs(60),
        // a blob the app sent is stored like one a neighbour relayed
        record_provenance: false,
        ..PoolsConfig::default().with_path(&path)
    };
    std::fs::create_dir_all(dir).map_err(|e| format!("data dir: {e}"))?;
    let pools = open_pools_file(dir, cfg, pools_cfg.clone())?;
    if !pools.had_own_marks() {
        return Ok(pools);
    }
    // a store from a development build that marked the app's blobs: older copies of
    // the marks may survive in free pages, so the whole store goes, key file first
    tracing::info!("discarding mesh pools written with own marks");
    drop(pools);
    let _ = crate::crypt::destroy_key_file(&dir.join(POOLS_KEY_FILE));
    let _ = std::fs::remove_file(&path);
    open_pools_file(dir, cfg, pools_cfg)
}

fn open_pools_file(
    dir: &Path,
    cfg: &MobileConfig,
    pools_cfg: PoolsConfig,
) -> Result<Arc<Pools>, String> {
    let path = dir.join(POOLS_FILE);
    match cfg.pool_key()? {
        Some(key) => {
            let file = EncryptedFile::open(&path, &dir.join(POOLS_KEY_FILE), &key)
                .map_err(|e| format!("pools file: {e}"))?;
            Pools::open_with_backend(pools_cfg, file).map_err(|e| format!("pools: {e}"))
        }
        None if cfg.allow_plaintext => Pools::open(pools_cfg).map_err(|e| format!("pools: {e}")),
        None => Err(
            "no pool_key_hex: the mesh keeps other people's traffic and needs a key \
                     (set allow_plaintext only for tests)"
                .into(),
        ),
    }
}

impl Core {
    /// Opens the pools in `data_dir` and starts the engine, the writer and the bridge.
    pub fn start(
        data_dir: &str,
        config_json: &str,
        host: Arc<dyn Host>,
    ) -> Result<Arc<Self>, String> {
        let cfg = MobileConfig::from_json(config_json)?;
        let dir = PathBuf::from(data_dir);
        let pools = open_pools(&dir, &cfg)?;
        scrub_file(&dir.join(WANTED_FILE));
        let store = Arc::new(MobileStore::new(pools.clone()));
        let registry = Arc::new(TrustRegistry::new(TrustPolicy::default()).with(Arc::new(
            PowScheme::new(PowConfig {
                min_bits: cfg.pow_bits,
                // every phone proves the same work: more of it buys no more trust, so
                // an attacker grinding bits does not outrank honest phones for slots
                full_score_bits: cfg.pow_bits,
                max_bits_to_prove: cfg.pow_bits,
                max_prove_ms: 2_000,
                ..PowConfig::default()
            }),
        )));
        // proof of work alone puts a phone at 0.3, above the low-trust link quota
        registry.set_weight(POW_SCHEME_ID, POW_WEIGHT);
        let sweeper = pools.start_sweeper(None);
        let mesh = MeshParts::new(MeshConfig {
            // a phone marks what reaches it for upload, so that it can bridge it the
            // moment it has internet (people walking out of the area)
            bridge: true,
            guided: cfg.guided,
            ..MeshConfig::phone()
        });
        let (wake_tx, wake_rx) = bounded(1);
        let links = Arc::new(LinkTable {
            links: Mutex::new(HashMap::new()),
            replace_interval: Duration::from_millis(cfg.link_replace_interval_ms),
            min_replaced_age: Duration::from_millis(cfg.min_replaced_link_age_ms),
            by_peer: RwLock::new(HashMap::new()),
            last_replacement: Mutex::new(None),
            wake: wake_tx,
        });
        let trust = Arc::new(FixedTrust::new(0.0));
        let limits = PeerLimitsTable::new();
        let propagation_cfg = phone_propagation();
        // a stalled engine holds at most this many messages (each at most 256 KiB, and the
        // radio delivers far slower than the engine reads)
        let (inbound_tx, inbound_rx) = bounded(1024);
        let (retrieval_tx, retrieval_rx) = unbounded();
        let (propagation_tx, propagation_rx) = unbounded();
        let (peer_cmd_tx, peer_cmd_rx) = unbounded();
        let (events_tx, events_rx) = unbounded();
        let cache = Arc::new(parking_lot::RwLock::new(BlobCache::new(
            propagation_cfg.max_known_blobs_size as u32,
            propagation_cfg.max_peer_known_blobs_size as u32,
        )));
        let handler = BlobHandler::new(
            store.clone(),
            propagation_cfg,
            cache,
            Box::new(BleLinks(links.clone())),
            inbound_rx,
            (retrieval_tx.clone(), retrieval_rx),
            (propagation_tx.clone(), propagation_rx),
            peer_cmd_tx,
            trust.clone(),
            registry.clone(),
            events_tx,
            limits.clone(),
            mesh.clone(),
        );
        let core = Arc::new(Self {
            cfg,
            data_dir: dir,
            store,
            pools,
            registry,
            mesh,
            trust,
            limits,
            links,
            host,
            handler: Mutex::new(Some(handler)),
            retrieval: retrieval_tx,
            propagation: propagation_tx,
            inbound: inbound_tx,
            dedupe: Mutex::new((rand::random(), Instant::now())),
            upstream: Mutex::new(Upstreams {
                urls: Vec::new(),
                bridge: false,
                reachable: false,
            }),
            own_wanted: RwLock::new(HashSet::new()),
            own_local_wanted: RwLock::new(HashSet::new()),
            shared_keys: Mutex::new(HashSet::new()),
            upload_backoff: Mutex::new(HashMap::new()),
            beacon_key: Mutex::new((KeyPair::generate(0).expect("keygen"), Instant::now())),
            stopping: Arc::new(AtomicBool::new(false)),
            threads: Mutex::new(Vec::new()),
            sweeper: Mutex::new(Some(sweeper)),
        });
        // alternate values of wanted seekers reach the app too
        {
            let weak = Arc::downgrade(&core);
            core.store
                .set_on_alternate(Some(Box::new(move |key, value| {
                    if let Some(core) = weak.upgrade() {
                        if core.own_wanted.read().contains(key) {
                            core.host
                                .arrival(vec![(key.to_vec(), value.to_vec())], Vec::new());
                        }
                    }
                })));
        }
        let threads = vec![
            Self::spawn(&core, "gm-writer", move |c| c.writer(wake_rx)),
            Self::spawn(&core, "gm-events", move |c| {
                c.events(events_rx, peer_cmd_rx)
            }),
            Self::spawn(&core, "gm-bridge", |c| c.bridge_loop()),
        ];
        core.threads.lock().extend(threads);
        Ok(core)
    }

    fn spawn(
        core: &Arc<Self>,
        name: &str,
        f: impl FnOnce(Arc<Self>) + Send + 'static,
    ) -> JoinHandle<()> {
        let c = core.clone();
        std::thread::Builder::new()
            .name(name.to_string())
            .spawn(move || f(c))
            .expect("spawn")
    }

    /// Stops every thread; links are forgotten (the radio drops them).
    pub fn stop(&self) {
        if self.stopping.swap(true, Ordering::SeqCst) {
            return;
        }
        let _ = self.links.wake.try_send(());
        if let Some(mut h) = self.handler.lock().take() {
            h.stop();
        }
        let me = std::thread::current().id();
        for t in self.threads.lock().drain(..) {
            // called from one of our own threads (a host callback that stops the node):
            // that thread ends by itself once it returns
            if t.thread().id() != me {
                let _ = t.join();
            }
        }
        if let Some(s) = self.sweeper.lock().take() {
            s.stop();
        }
        self.store.set_on_alternate(None);
    }

    /// The data directory.
    pub fn data_dir(&self) -> &Path {
        &self.data_dir
    }

    fn running(&self) -> bool {
        !self.stopping.load(Ordering::SeqCst)
    }

    // ------------------------------------------------------------------ radio

    /// Our duplicate token for this epoch.
    fn dedupe_token(&self) -> [u8; DEDUPE_TOKEN_LEN] {
        let mut d = self.dedupe.lock();
        if d.1.elapsed() >= Duration::from_millis(self.cfg.peer_id_rotation_ms) {
            *d = (rand::random(), Instant::now());
        }
        d.0
    }

    /// The radio connected a link.
    pub fn link_up(&self, link: i32, mtu: i32) {
        if !self.running() {
            return;
        }
        let caps = {
            let u = self.upstream.lock();
            if u.reachable && u.bridge {
                CAP_BRIDGE | CAP_BULLETIN
            } else {
                CAP_BULLETIN
            }
        };
        let admission = Arc::new(Slots {
            table: self.links.clone(),
            max_links: self.cfg.max_links,
            max_low: self.cfg.max_low_trust_links,
            propagation: phone_propagation(),
        });
        // a fresh peer id for every link: links cannot be tied to each other by it
        let (hs, first) = Handshake::start(
            Arc::new(KeyPair::generate(0).expect("keygen")),
            self.registry.clone(),
            admission,
            caps,
            self.dedupe_token(),
        );
        let mut state = LinkState {
            max_chunk: chunk::max_chunk(mtu),
            phase: Phase::Handshaking(Some(Box::new(hs)), Instant::now()),
            reasm: Reassembler::with_limit(chunk::MAX_HANDSHAKE_MESSAGE),
            cipher: None,
            pending: VecDeque::new(),
            pending_bytes: 0,
            high: Queue::default(),
            low: Queue::default(),
            queued: 0,
            blocked_until: None,
            close_when_flushed: None,
        };
        for m in first {
            let _ = state.enqueue(&m, true);
        }
        let old = self.links.links.lock().insert(link, state);
        if let Some(old) = old {
            if let Phase::Ready(peer) = old.phase {
                self.peer_gone(peer);
            }
        }
        let _ = self.links.wake.try_send(());
    }

    /// The radio lost a link.
    pub fn link_down(&self, link: i32) {
        let old = self.links.links.lock().remove(&link);
        if let Some(LinkState {
            phase: Phase::Ready(peer),
            ..
        }) = old
        {
            self.peer_gone(peer);
        }
    }

    /// Asks the radio to drop a link, and stops using it whatever the radio does (an
    /// iOS peripheral cannot disconnect a central).
    fn close(&self, link: i32, why: &str) {
        tracing::debug!(link, why, "closing mesh link");
        let was = {
            let mut links = self.links.links.lock();
            links.get_mut(&link).map(|s| {
                s.high.clear();
                s.low.clear();
                s.pending.clear();
                s.pending_bytes = 0;
                s.queued = 0;
                s.close_when_flushed = None;
                std::mem::replace(&mut s.phase, Phase::Closed)
            })
        };
        if let Some(Phase::Ready(peer)) = was {
            self.peer_gone(peer);
        }
        self.host.close_link(link);
    }

    /// Stops using a link that never became ready and closes it once what is queued
    /// on it has left.
    fn close_after_flush(&self, link: i32, why: &str) {
        let flushed = {
            let mut links = self.links.links.lock();
            let Some(s) = links.get_mut(&link) else {
                return;
            };
            s.phase = Phase::Closed;
            s.pending.clear();
            s.pending_bytes = 0;
            if !s.flushed() {
                s.close_when_flushed = Some(why.to_string());
            }
            s.flushed()
        };
        if flushed {
            self.close(link, why);
        } else {
            let _ = self.links.wake.try_send(());
        }
    }

    fn peer_gone(&self, peer: PeerId) {
        let removed = {
            let mut by_peer = self.links.by_peer.write();
            by_peer.remove(&peer).is_some()
        };
        if removed {
            let now = UnixMillis::now();
            self.registry.peer_disconnected(&peer, now);
            self.mesh.clock.forget(&peer);
            self.registry.release_tags(&peer);
            self.limits.remove(&peer);
            self.trust.remove(&peer);
            let _ = self
                .retrieval
                .try_send(RetrievalCommand::PeerDisconnected(peer));
        }
    }

    /// One chunk from the radio.
    pub fn frame_in(&self, link: i32, frame: &[u8]) {
        if !self.running() {
            return;
        }
        let ready = {
            let mut links = self.links.links.lock();
            let Some(state) = links.get_mut(&link) else {
                return;
            };
            if matches!(state.phase, Phase::Closed) {
                return;
            }
            let raw = match state.reasm.push(frame, Instant::now()) {
                Ok(Some(m)) => m,
                Ok(None) => return,
                Err(e) => {
                    drop(links);
                    self.close(link, &e.to_string());
                    return;
                }
            };
            match &state.phase {
                Phase::Ready(peer) => {
                    let peer = *peer;
                    let opened = state
                        .cipher
                        .as_mut()
                        .ok_or("ready link without a cipher")
                        .and_then(|c| c.open(&raw));
                    match opened {
                        Ok(plain) => Some((peer, plain)),
                        Err(e) => {
                            drop(links);
                            self.close(link, e);
                            return;
                        }
                    }
                }
                Phase::Handshaking(..) => {
                    if state.pending_bytes + raw.len() > MAX_PENDING_BYTES {
                        drop(links);
                        self.close(link, "too much sent during the handshake");
                        return;
                    }
                    state.pending_bytes += raw.len();
                    state.pending.push_back(raw);
                    None
                }
                Phase::Closed => return,
            }
        };
        match ready {
            Some((peer, plain)) => self.network_message(peer, &plain),
            None => self.drive_handshake(link),
        }
    }

    /// Runs the handshake of `link` over the messages waiting for it. Whoever finds the
    /// handshake in its slot runs it (outside the lock: proofs take time) and keeps
    /// going while messages wait; a caller that finds it busy leaves its message for
    /// that one.
    fn drive_handshake(&self, link: i32) {
        loop {
            let (mut hs, msg) = {
                let mut links = self.links.links.lock();
                let Some(state) = links.get_mut(&link) else {
                    return;
                };
                let Phase::Handshaking(slot, _) = &mut state.phase else {
                    return;
                };
                if slot.is_none() {
                    return;
                }
                let Some(raw) = state.pending.pop_front() else {
                    return;
                };
                state.pending_bytes -= raw.len();
                let msg = match state.cipher.as_mut() {
                    // only the hello travels in clear
                    None => raw,
                    Some(c) => match c.open(&raw) {
                        Ok(plain) => plain,
                        Err(e) => {
                            drop(links);
                            self.close(link, e);
                            return;
                        }
                    },
                };
                (slot.take().expect("checked"), msg)
            };
            let step = hs.on_message(&msg);
            let cipher = hs.take_cipher();
            let (send, outcome) = match step {
                Step::Send(v) => (v, None),
                Step::Ready(v, done) => (v, Some(Ok(*done))),
                Step::Fail(v, why) => (v, Some(Err(why))),
            };
            {
                let mut links = self.links.links.lock();
                let Some(state) = links.get_mut(&link) else {
                    return;
                };
                if cipher.is_some() {
                    state.cipher = cipher;
                }
                for m in &send {
                    let _ = state.enqueue(m, true);
                }
                match &mut state.phase {
                    Phase::Handshaking(slot, _) => *slot = Some(hs),
                    // closed (timeout) while the handshake ran
                    _ => return,
                }
                if let Some(Err(why)) = &outcome {
                    if !state.flushed() {
                        // the refusal verdict leaves first; the writer closes after it
                        state.close_when_flushed = Some(why.clone());
                    }
                }
            }
            let _ = self.links.wake.try_send(());
            match outcome {
                None => continue,
                Some(Err(why)) => {
                    if send.is_empty() {
                        self.close(link, &why);
                    }
                    return;
                }
                Some(Ok(done)) => {
                    self.link_ready(link, done);
                    return;
                }
            }
        }
    }

    fn link_ready(&self, link: i32, done: Done) {
        // the link may have closed (handshake timeout) while the handshake ran
        let still_up = matches!(
            self.links.links.lock().get(&link).map(|s| &s.phase),
            Some(Phase::Handshaking(..))
        );
        if !still_up {
            self.registry.release_tags(&done.peer);
            return;
        }
        let mut victim = None;
        let refusal = {
            let mut by_peer = self.links.by_peer.write();
            let duplicate = by_peer
                .values()
                .find(|r| r.token == done.dedupe_token)
                .copied();
            let refusal = match duplicate {
                // two links to the same phone: both ends keep the one with the lower key
                Some(other) if other.link_key <= done.link_key => {
                    Some("duplicate link to this phone")
                }
                Some(other) => {
                    victim = Some(other.link);
                    None
                }
                // admission was decided before the handshake ended: check again
                None if by_peer.len() >= self.cfg.max_links => {
                    match self.links.replaceable(&by_peer) {
                        Some(l) => {
                            victim = Some(l);
                            *self.links.last_replacement.lock() = Some(Instant::now());
                            None
                        }
                        None => Some("no slot left"),
                    }
                }
                None => None,
            };
            if refusal.is_none() {
                by_peer.insert(
                    done.peer,
                    ReadyLink {
                        link,
                        trust: done.record.value,
                        compact: done.compact_link_up,
                        token: done.dedupe_token,
                        link_key: done.link_key,
                        since: Instant::now(),
                    },
                );
            }
            refusal
        };
        if let Some(why) = refusal {
            self.registry.release_tags(&done.peer);
            // our last handshake message (the initiator's verdict) still leaves, so
            // that the peer completes too and reaches the same decision
            self.close_after_flush(link, why);
            return;
        }
        if let Some(v) = victim {
            self.close(v, "replaced by a newer link");
        }
        let pending = {
            let mut links = self.links.links.lock();
            match links.get_mut(&link) {
                Some(state) if matches!(state.phase, Phase::Handshaking(..)) => {
                    state.phase = Phase::Ready(done.peer);
                    state.reasm.set_limit(chunk::MAX_MESSAGE);
                    state.pending_bytes = 0;
                    let raw: Vec<Vec<u8>> = state.pending.drain(..).collect();
                    let cipher = state.cipher.as_mut().expect("sealed after the hellos");
                    raw.into_iter()
                        .map(|r| cipher.open(&r))
                        .collect::<Result<Vec<_>, _>>()
                }
                _ => {
                    drop(links);
                    self.peer_gone(done.peer);
                    return;
                }
            }
        };
        self.trust.set(done.peer, done.record.value);
        self.limits.set(done.peer, done.their_limits);
        self.mesh.clock.record(done.peer, done.clock_offset_ms);
        self.registry.peer_alive(&done.peer, UnixMillis::now());
        let _ = self
            .retrieval
            .try_send(RetrievalCommand::PeerConnected(done.peer));
        tracing::debug!(link, trust = done.record.value, "mesh link up");
        match pending {
            Ok(messages) => {
                for m in messages {
                    self.network_message(done.peer, &m);
                }
            }
            Err(e) => self.close(link, e),
        }
    }

    fn network_message(&self, peer: PeerId, message: &[u8]) {
        let Ok((rest, id)) =
            MessageTypeIdDeserializer::new().deserialize::<DeserializeError>(message)
        else {
            return;
        };
        if id == MessageTypeId::Blob {
            let _ = self.inbound.try_send((peer, rest.to_vec()));
        }
        // peer management does not exist on mesh links
    }

    /// Sends queued chunks, high priority first; backs off on a link the radio refuses.
    fn writer(self: Arc<Self>, wake: Receiver<()>) {
        let mut backoff: HashMap<i32, Duration> = HashMap::new();
        while self.running() {
            match wake.recv_timeout(Duration::from_millis(20)) {
                Ok(()) | Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => return,
            }
            let mut timed_out = Vec::new();
            loop {
                let now = Instant::now();
                let mut batch: Vec<(i32, Vec<u8>, bool)> = Vec::new();
                {
                    let mut links = self.links.links.lock();
                    for (id, s) in links.iter_mut() {
                        if s.flushed() {
                            if let Some(why) = &s.close_when_flushed {
                                timed_out.push((*id, why.clone()));
                            }
                        }
                        if let Phase::Handshaking(_, since) = &s.phase {
                            if now.duration_since(*since) > HANDSHAKE_TIMEOUT {
                                timed_out.push((*id, "handshake timeout".into()));
                                continue;
                            }
                        }
                        if s.blocked_until.is_some_and(|t| t > now) {
                            continue;
                        }
                        if let Some((c, high)) = s.next_chunk() {
                            batch.push((*id, c, high));
                        }
                    }
                }
                if batch.is_empty() {
                    break;
                }
                let mut sent_any = false;
                for (id, chunk, high) in batch {
                    let ok = self.host.send_frame(id, chunk);
                    let mut links = self.links.links.lock();
                    let Some(s) = links.get_mut(&id) else {
                        continue;
                    };
                    if ok {
                        sent_any = true;
                        s.chunk_sent(high);
                        s.blocked_until = None;
                        backoff.remove(&id);
                    } else {
                        let b = backoff.entry(id).or_insert(Duration::from_millis(5));
                        s.blocked_until = Some(Instant::now() + *b);
                        *b = (*b * 2).min(Duration::from_millis(500));
                    }
                }
                if !sent_any {
                    break;
                }
            }
            timed_out.dedup_by_key(|(id, _)| *id);
            for (id, why) in timed_out {
                self.close(id, &why);
            }
        }
    }

    // ------------------------------------------------------------------ app

    fn events(self: Arc<Self>, events: Receiver<NetEvent>, peer_cmds: Receiver<PeerManagementCmd>) {
        while self.running() {
            while let Ok(cmd) = peer_cmds.try_recv() {
                if let PeerManagementCmd::Ban(peers) = cmd {
                    for p in peers {
                        let link = self.links.by_peer.read().get(&p).map(|r| r.link);
                        if let Some(link) = link {
                            self.close(link, "banned");
                        }
                    }
                }
            }
            match events.recv_timeout(Duration::from_millis(200)) {
                Ok(NetEvent::BlobsStored(ids)) => self.notify(&ids),
                Ok(_) => {}
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => return,
            }
        }
    }

    /// Tells the app about stored blobs it waits for, and announcements.
    fn notify(&self, ids: &[BlobId]) {
        let envs = self.store.get_many(ids, usize::MAX);
        let wanted = self.own_wanted.read();
        let mut messages = Vec::new();
        let mut announcements = Vec::new();
        for env in envs {
            match env.kind {
                BlobKind::KeyValue if wanted.contains(&env.key) => {
                    messages.push((env.key, env.payload))
                }
                BlobKind::Bulletin => announcements.push(env.payload),
                _ => {}
            }
        }
        drop(wanted);
        if !messages.is_empty() || !announcements.is_empty() {
            self.host.arrival(messages, announcements);
        }
    }

    /// Stores and announces a blob from the app. Returns its id and, for an
    /// announcement, its counter. A `local` blob is local-only: never uploaded, by this
    /// phone or by a bridge that relays it (it travels in `LocalBlobs`).
    ///
    /// The blob is stored exactly as if a neighbour had relayed it: the scope a mesh
    /// link gives, the trust bucket of a phone, no arrival time or source. Like any
    /// other mesh blob it goes upstream only when this phone bridges, or through a
    /// bridge further on; the app posts its messages itself once it reaches a server.
    pub fn send_blob(
        &self,
        kind: BlobKind,
        key: Vec<u8>,
        payload: Vec<u8>,
        local: bool,
    ) -> Result<(BlobId, Option<u64>), String> {
        let now = self.mesh.clock.now();
        let env = BlobEnvelope::new(kind, now.as_millis(), key, payload);
        let scope = self.mesh.ingest_scope(true, local);
        self.pools
            .validate_scoped(&env, now.as_millis(), true, scope)
            .map_err(|e| format!("rejected: {e}"))?;
        let source = Source::local(relay_trust_bucket()).with_scope(scope);
        let wanted = kind == BlobKind::KeyValue && self.mesh.wanted.contains(&env.key, now);
        let key = env.key.clone();
        let payload = env.payload.clone();
        let (id, counter) = match self
            .pools
            .insert_prevalidated(env, source, now.as_millis())
            .map_err(|e| format!("store: {e}"))?
        {
            InsertOutcome::Inserted { id, counter } => (id, counter),
            InsertOutcome::AlreadyPresent { id, counter } => (id, counter),
            InsertOutcome::Rejected(r) => {
                if kind == BlobKind::KeyValue && format!("{r:?}").contains("KeyTaken") {
                    self.store.note_alternate(&key, &payload);
                }
                return Err(format!("rejected: {r:?}"));
            }
        };
        let cmd = if wanted {
            PropagationCommand::PropagateWanted(vec![id])
        } else {
            PropagationCommand::PropagateBlobs(vec![id])
        };
        let _ = self.propagation.try_send(cmd);
        if kind == BlobKind::Hash {
            self.shared_keys
                .lock()
                .insert(gossip_wire::hash_pool_key(&payload));
        }
        Ok((id, counter))
    }

    /// Deletes the key set stored under `hash` (its blake3 hash, the user id), whoever
    /// sent it. Returns whether one was deleted. Copies other phones hold are not
    /// recalled.
    pub fn forget_keys(&self, hash: &[u8]) -> bool {
        let Ok(hash) = <[u8; 32]>::try_from(hash) else {
            return false;
        };
        self.shared_keys.lock().remove(&hash);
        let Some(id) = self
            .pools
            .hash_get(&hash)
            .ok()
            .flatten()
            .map(|env| env.id())
        else {
            return false;
        };
        self.pools.remove(&[id]).is_ok_and(|r| !r.is_empty())
    }

    /// The app locked: the wanted list is emptied and the key sets the app shared
    /// since the last lock are deleted. Nothing else on the node belongs to the app:
    /// its other blobs are stored like relayed ones and stay to be delivered.
    pub fn lock(&self) {
        self.set_wanted(Vec::new(), Vec::new());
        let keys: Vec<[u8; 32]> = self.shared_keys.lock().drain().collect();
        for hash in keys {
            self.forget_keys(&hash);
        }
    }

    /// Every distinct value stored under each seeker, first stored first.
    pub fn fetch(&self, seekers: &[Vec<u8>]) -> Vec<(Vec<u8>, Vec<u8>)> {
        let mut out = Vec::new();
        for s in seekers {
            for v in self.store.values(s) {
                out.push((s.clone(), v));
            }
        }
        out
    }

    /// Announcements after `cursor`.
    pub fn fetch_bulletin(&self, cursor: u64, limit: usize) -> Vec<(u64, Vec<u8>)> {
        self.pools
            .bulletin_after(cursor, limit.max(1))
            .map(|v| v.into_iter().map(|(c, e)| (c, e.payload)).collect())
            .unwrap_or_default()
    }

    /// A published key set by its blake3 hash.
    pub fn get_keys(&self, hash: &[u8]) -> Option<Vec<u8>> {
        let hash: [u8; 32] = hash.try_into().ok()?;
        self.pools.hash_get(&hash).ok().flatten().map(|e| e.payload)
    }

    /// The seekers the app waits for, and those it waits for only from the mesh
    /// (`local`: flooded local-only, never fetched upstream). Both lists together
    /// replace the previous ones; a seeker in both is regular.
    pub fn set_wanted(&self, seekers: Vec<Vec<u8>>, local: Vec<Vec<u8>>) {
        let regular: HashSet<&Vec<u8>> = seekers.iter().collect();
        let local: Vec<Vec<u8>> = local.into_iter().filter(|s| !regular.contains(s)).collect();
        let own: Vec<([u8; WANTED_SEEKER_LEN], bool)> = seekers
            .iter()
            .map(|s| (s, false))
            .chain(local.iter().map(|s| (s, true)))
            .filter_map(|(s, l)| Some((s.as_slice().try_into().ok()?, l)))
            .collect();
        self.mesh
            .wanted
            .set_own_entries(&own, self.mesh.clock.now());
        *self.own_local_wanted.write() = local.iter().cloned().collect();
        *self.own_wanted.write() = seekers.into_iter().chain(local).collect();
    }

    /// Upstream internet nodes and bridging.
    pub fn set_upstream(&self, urls: Vec<String>, bridge: bool) {
        let mut u = self.upstream.lock();
        if urls.is_empty() {
            u.reachable = false;
        }
        u.urls = urls;
        u.bridge = bridge;
    }

    /// Counters for the app.
    pub fn status(&self) -> CoreStatus {
        let stats = self.pools.stats().unwrap_or_default();
        let (ready, handshaking) = {
            let links = self.links.links.lock();
            (
                links
                    .values()
                    .filter(|s| matches!(s.phase, Phase::Ready(_)))
                    .count(),
                links
                    .values()
                    .filter(|s| matches!(s.phase, Phase::Handshaking(..)))
                    .count(),
            )
        };
        let u = self.upstream.lock();
        CoreStatus {
            mesh_peers: ready,
            handshaking,
            upstream_reachable: u.reachable,
            bridge_enabled: u.bridge,
            bulletin_counter: self.pools.bulletin_counter(),
            stored_blobs: stats.blob_count,
            mesh_blobs: stats.mesh_count,
            upload_pending: stats.upload_count,
            wanted_entries: self.mesh.wanted.len(),
            clock_offset_ms: self.mesh.clock.offset_ms(),
            // a fresh peer id per link: there is no node-wide one to show
            peer_id: String::new(),
        }
    }

    // ------------------------------------------------------------------ bridge

    fn bridge_loop(self: Arc<Self>) {
        let period = Duration::from_millis(self.cfg.bridge_interval_ms.max(100));
        let mut next = Instant::now();
        let mut tokens = f64::from(self.cfg.bridge_upload_per_min);
        let mut last = Instant::now();
        while self.running() {
            std::thread::sleep(Duration::from_millis(100));
            if Instant::now() < next {
                continue;
            }
            next = Instant::now() + period;
            let cap = f64::from(self.cfg.bridge_upload_per_min);
            tokens = (tokens + last.elapsed().as_secs_f64() * cap / 60.0).min(cap);
            last = Instant::now();
            let (urls, bridge) = {
                let u = self.upstream.lock();
                (u.urls.clone(), u.bridge)
            };
            if urls.is_empty() {
                self.renew_beacon(false);
                continue;
            }
            let up = Upstream::new(urls, Duration::from_millis(self.cfg.upstream_timeout_ms));
            let reachable = up.reachable();
            self.upstream.lock().reachable = reachable;
            self.renew_beacon(bridge && reachable);
            if !reachable {
                continue;
            }
            // every mesh blob alike, the app's included, and only when bridging
            if bridge {
                self.upload(&up, &mut tokens);
                self.fetch_wanted(&up);
            }
        }
    }

    /// Signs a new bridge beacon when the current one is half gone (or stops
    /// advertising). The beacon key is not the link key and changes every
    /// [`BEACON_KEY_ROTATION`], so that beacons do not link a bridge over a whole day.
    fn renew_beacon(&self, bridging: bool) {
        let now = self.mesh.clock.now();
        if !bridging {
            self.mesh.wanted.set_beacon(None, now);
            return;
        }
        if !self.mesh.wanted.beacon_due(now) {
            return;
        }
        let key = {
            let mut k = self.beacon_key.lock();
            if k.1.elapsed() >= BEACON_KEY_ROTATION {
                *k = (KeyPair::generate(0).expect("keygen"), Instant::now());
            }
            k.0.clone()
        };
        match Beacon::sign(&key, now.as_millis(), self.mesh.config.beacon_lifetime_s) {
            Ok(b) => self.mesh.wanted.set_beacon(Some(b), now),
            Err(e) => tracing::warn!(error = %e, "could not sign the bridge beacon"),
        }
    }

    fn upload(&self, up: &Upstream, tokens: &mut f64) {
        let max = (*tokens as usize).min(256);
        // read further than what can be sent, past blobs that wait for a retry
        let scan = max.saturating_mul(4).max(64);
        let pending = self.store.upload_pending(scan);
        let now = Instant::now();
        let ready: Vec<BlobId> = {
            let mut backoff = self.upload_backoff.lock();
            backoff.retain(|id, _| pending.contains(id));
            pending
                .into_iter()
                .filter(|id| backoff.get(id).is_none_or(|(at, _)| *at <= now))
                .take(max)
                .collect()
        };
        // a local-only blob never waits for an upload; checked again all the same
        let ready: Vec<BlobId> = ready
            .into_iter()
            .filter(|id| {
                self.store
                    .scope_of(id)
                    .is_some_and(|(scope, _)| !scope.is_local())
            })
            .collect();
        let envs = self.store.get_many(&ready, usize::MAX);
        let mut done = Vec::new();
        let mut dropped = Vec::new();
        for env in envs {
            if *tokens < 1.0 || !self.running() {
                break;
            }
            *tokens -= 1.0;
            let res = match env.kind {
                BlobKind::KeyValue => up.put_message(&env.key, &env.payload),
                BlobKind::Bulletin => up.put_announcement(&env.payload),
                BlobKind::Hash => up.put_keys(&env.payload),
            };
            match res {
                Ok(()) | Err(UpstreamError::KeyTaken) => done.push(env.id()),
                Err(UpstreamError::Rejected(e)) => {
                    // refused for good: stop offering it, and let the next ones go
                    tracing::debug!(error = %e, "upload refused; not retried");
                    dropped.push(env.id());
                }
                Err(UpstreamError::Busy(e)) => {
                    tracing::debug!(error = %e, "upload deferred");
                    self.defer_upload(env.id());
                }
                Err(e @ UpstreamError::Http(_)) => {
                    // nobody answers: the rest would fail the same way this round
                    tracing::debug!(error = %e, "upload failed; retried next round");
                    self.defer_upload(env.id());
                    break;
                }
            }
        }
        done.extend(dropped);
        if !done.is_empty() {
            let mut backoff = self.upload_backoff.lock();
            for id in &done {
                backoff.remove(id);
            }
            drop(backoff);
            self.store.update_scope(&done, Scope::NONE, Scope::UPLOAD);
        }
    }

    /// Offers a blob again later, waiting twice as long after each failure.
    fn defer_upload(&self, id: BlobId) {
        let mut backoff = self.upload_backoff.lock();
        let entry = backoff.entry(id).or_insert((Instant::now(), 0));
        entry.1 = entry.1.saturating_add(1);
        let wait = UPLOAD_BACKOFF_MIN
            .saturating_mul(1 << (entry.1 - 1).min(10))
            .min(UPLOAD_BACKOFF_MAX);
        entry.0 = Instant::now() + wait;
    }

    fn fetch_wanted(&self, up: &Upstream) {
        let now = self.mesh.clock.now();
        // local-only seekers stay in the mesh: neither ours nor those flooded as such
        let own_local = self.own_local_wanted.read().clone();
        let missing: Vec<Vec<u8>> = self
            .mesh
            .wanted
            .upstream_seekers(now)
            .into_iter()
            .map(|s| s.to_vec())
            .filter(|s| !own_local.contains(s) && self.store.kv_id(s).is_none())
            .take(256)
            .collect();
        if missing.is_empty() {
            return;
        }
        let Ok(found) = up.fetch(&missing) else {
            return;
        };
        // only what was asked: an upstream must not push arbitrary seekers into the mesh
        let asked: HashSet<&Vec<u8>> = missing.iter().collect();
        let mut ids = Vec::new();
        for (key, value) in found
            .into_iter()
            .filter(|(k, _)| asked.contains(k))
            .take(missing.len())
        {
            let env = BlobEnvelope::new(BlobKind::KeyValue, now.as_millis(), key, value);
            if self
                .pools
                .validate_scoped(&env, now.as_millis(), true, Scope::MESH)
                .is_err()
            {
                continue;
            }
            let src = Source::local(gossip_trust::trust_bucket(0.5)).with_scope(Scope::MESH);
            if let Ok(InsertOutcome::Inserted { id, .. }) =
                self.pools.insert_prevalidated(env, src, now.as_millis())
            {
                ids.push(id);
            }
        }
        if !ids.is_empty() {
            self.notify(&ids);
            let _ = self
                .propagation
                .try_send(PropagationCommand::PropagateWanted(ids));
        }
    }
}

/// Trust bucket of the blobs a neighbour relays: every phone proves the same work
/// (`docs/MESH.md`, "Trust on mesh links"). The app's blobs get it too.
fn relay_trust_bucket() -> u8 {
    gossip_trust::trust_bucket(POW_WEIGHT)
}

/// Overwrites a file with zeros, flushes it and deletes it.
fn scrub_file(path: &Path) {
    use std::io::Write;
    let Ok(len) = std::fs::metadata(path).map(|m| m.len()) else {
        return;
    };
    if let Ok(mut f) = std::fs::OpenOptions::new().write(true).open(path) {
        let _ = f.write_all(&vec![0u8; len as usize]);
        let _ = f.sync_all();
    }
    let _ = std::fs::remove_file(path);
}

impl Drop for Core {
    fn drop(&mut self) {
        self.stop();
    }
}
