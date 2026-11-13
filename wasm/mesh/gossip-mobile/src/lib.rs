//! Gossip P2P backend: the node embedded in the phone app.
//!
//! It holds the pools, replicates blobs with nearby phones over BLE links handed to it by
//! the radio (Kotlin or Swift), and, when the phone has internet and bridging is on,
//! uploads mesh blobs to internet nodes and fetches what people in the mesh wait for.
//! See `docs/MOBILE.md` for the API and `docs/MESH.md` for the protocol.
//!
//! The crate builds without PeerNet, the HTTP server, the dashboard and the zkVM
//! prover. Its UniFFI interface mirrors the app's `MeshCore` (Kotlin) and `MeshCore`
//! (Swift): [`MeshNodeCore`] and the foreign trait [`MeshCoreSink`].

#![warn(missing_docs)]

pub mod chunk;
pub mod config;
pub mod crypt;
pub mod handshake;
pub mod node;
pub mod seal;
pub mod store;
pub mod upstream;

use std::sync::Arc;

use gossip_wire::BlobKind;
use parking_lot::Mutex;

use node::{Core, Host};

uniffi::setup_scaffolding!();

/// Errors returned to the app.
#[derive(Debug, thiserror::Error, uniffi::Error)]
pub enum MeshError {
    /// The node is not started.
    #[error("the mesh node is not running")]
    NotRunning,
    /// Bad configuration or storage failure at start.
    #[error("start failed: {reason}")]
    Start {
        /// Why.
        reason: String,
    },
    /// A blob the node refused.
    #[error("blob refused: {reason}")]
    Refused {
        /// Why.
        reason: String,
    },
}

/// What the core asks of its host. `send_frame` and `close_link` may be called from any
/// core thread, and from inside `link_up` / `frame_in`; `arrival` is called from a
/// thread of its own, never while the core holds a lock, so the app may call back into
/// the core from it. A callback that throws is caught and logged: it never takes a core
/// thread down.
#[uniffi::export(with_foreign)]
pub trait MeshCoreSink: Send + Sync {
    /// Queues one chunk on the link; `false` when the radio refused it (the core
    /// retries with backoff).
    fn send_frame(&self, link_id: i32, frame: Vec<u8>) -> bool;
    /// Asks the radio to drop the link: a duplicate peer, a failed handshake, a protocol
    /// violation. The core stops using the link either way.
    fn close_link(&self, link_id: i32);
    /// Blobs for seekers on the wanted list, and announcements, the node just stored.
    fn arrival(&self, messages: Vec<MeshKeyValue>, announcements: Vec<Vec<u8>>);
}

/// Kinds of blob the app sends.
#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum MeshBlobKind {
    /// A session message under its seeker (key-value pool).
    Message,
    /// A session announcement (bulletin pool).
    Announcement,
    /// A published public key set (hash pool).
    Keys,
}

/// A seeker and one value stored under it.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct MeshKeyValue {
    /// The seeker.
    pub key: Vec<u8>,
    /// The signed entry.
    pub value: Vec<u8>,
}

/// One announcement and its local counter.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct MeshBulletinItem {
    /// Local counter, a decimal string.
    pub counter: String,
    /// The announcement bytes.
    pub data: Vec<u8>,
}

/// What `send_blob` stored.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct MeshSendResult {
    /// Blob id (32 bytes).
    pub id: Vec<u8>,
    /// Bulletin counter of an announcement.
    pub counter: Option<String>,
}

/// Node counters.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct MeshCoreStatus {
    /// Whether the node runs.
    pub running: bool,
    /// Links whose handshake completed.
    pub mesh_peers: i32,
    /// Whether an internet node answered on the last bridge round.
    pub upstream_reachable: bool,
    /// Whether bridging is on.
    pub bridge_enabled: bool,
    /// Last local bulletin counter, a decimal string.
    pub bulletin_counter: String,
    /// Blobs stored.
    pub stored_blobs: i64,
    /// Links still in handshake.
    pub links_handshaking: i32,
    /// Blobs stored only for the mesh.
    pub mesh_blobs: i64,
    /// Blobs waiting for a bridge upload.
    pub upload_pending: i64,
    /// Wanted entries known (own and relayed).
    pub wanted_entries: i64,
    /// Mesh clock correction, milliseconds.
    pub clock_offset_ms: i64,
    /// Empty: every link has its own peer id (kept for compatibility).
    pub peer_id: String,
}

/// Runs a host callback, catching a panic (a foreign exception surfaces as one).
fn guarded<T>(what: &str, default: T, f: impl FnOnce() -> T) -> T {
    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(f)) {
        Ok(v) => v,
        Err(_) => {
            tracing::warn!(callback = what, "the host callback failed");
            default
        }
    }
}

/// Arrivals waiting for the dispatcher thread.
type Arrival = (Vec<MeshKeyValue>, Vec<Vec<u8>>);

/// The app's sink as the core's [`Host`]: frames and closes go straight through,
/// arrivals through a dispatcher thread.
struct SinkHost {
    sink: Arc<dyn MeshCoreSink>,
    arrivals: crossbeam::channel::Sender<Arrival>,
}

impl SinkHost {
    fn new(sink: Arc<dyn MeshCoreSink>) -> Self {
        let (tx, rx) = crossbeam::channel::unbounded::<Arrival>();
        let s = sink.clone();
        // ends when the host (and so the sender) is dropped
        let _ = std::thread::Builder::new()
            .name("gm-arrival".into())
            .spawn(move || {
                while let Ok((messages, announcements)) = rx.recv() {
                    guarded("arrival", (), || s.arrival(messages, announcements));
                }
            });
        Self { sink, arrivals: tx }
    }
}

impl Host for SinkHost {
    fn send_frame(&self, link: i32, frame: Vec<u8>) -> bool {
        guarded("send_frame", false, || self.sink.send_frame(link, frame))
    }
    fn close_link(&self, link: i32) {
        guarded("close_link", (), || self.sink.close_link(link))
    }
    fn arrival(&self, messages: Vec<(Vec<u8>, Vec<u8>)>, announcements: Vec<Vec<u8>>) {
        let _ = self.arrivals.send((
            messages
                .into_iter()
                .map(|(key, value)| MeshKeyValue { key, value })
                .collect(),
            announcements,
        ));
    }
}

struct Started {
    core: Arc<Core>,
    data_dir: String,
    config_json: String,
    sink: Arc<dyn MeshCoreSink>,
}

/// The mesh node, as the app's `MeshCore`. Every method is thread-safe.
#[derive(uniffi::Object, Default)]
pub struct MeshNodeCore {
    /// Held across a whole start, stop or wipe, so that two of them never interleave
    /// (two cores on one data directory).
    lifecycle: Mutex<()>,
    inner: Mutex<Option<Started>>,
}

impl MeshNodeCore {
    fn core(&self) -> Option<Arc<Core>> {
        self.inner.lock().as_ref().map(|s| s.core.clone())
    }
}

#[uniffi::export]
impl MeshNodeCore {
    /// A stopped node.
    #[uniffi::constructor]
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    /// Opens the node's storage in `data_dir` and starts it. `config_json` is the
    /// app's mesh configuration (see `docs/MOBILE.md`); empty for the defaults. A
    /// running node is stopped first.
    pub fn start(
        &self,
        data_dir: String,
        config_json: String,
        sink: Arc<dyn MeshCoreSink>,
    ) -> Result<(), MeshError> {
        let _lifecycle = self.lifecycle.lock();
        self.stop_locked();
        let core = Core::start(
            &data_dir,
            &config_json,
            Arc::new(SinkHost::new(sink.clone())),
        )
        .map_err(|reason| MeshError::Start { reason })?;
        *self.inner.lock() = Some(Started {
            core,
            data_dir,
            config_json,
            sink,
        });
        Ok(())
    }

    /// Stops the node. Links are forgotten.
    pub fn stop(&self) {
        let _lifecycle = self.lifecycle.lock();
        self.stop_locked();
    }

    /// The radio connected a link (ATT MTU `mtu`).
    pub fn link_up(&self, link_id: i32, mtu: i32) {
        if let Some(c) = self.core() {
            c.link_up(link_id, mtu);
        }
    }

    /// The radio lost a link.
    pub fn link_down(&self, link_id: i32) {
        if let Some(c) = self.core() {
            c.link_down(link_id);
        }
    }

    /// One chunk received on a link, in order.
    pub fn frame_in(&self, link_id: i32, frame: Vec<u8>) {
        if let Some(c) = self.core() {
            c.frame_in(link_id, &frame);
        }
    }

    /// Stores a blob from the app and offers it to the mesh, exactly as if a neighbour
    /// had relayed it. A `local_only` blob stays in the mesh: neither this phone nor a
    /// bridge that relays it uploads it (see `docs/MESH.md`, "Local-only blobs and
    /// seekers").
    #[uniffi::method(default(local_only = false))]
    pub fn send_blob(
        &self,
        kind: MeshBlobKind,
        key: Option<Vec<u8>>,
        payload: Vec<u8>,
        local_only: bool,
    ) -> Result<MeshSendResult, MeshError> {
        let core = self.core().ok_or(MeshError::NotRunning)?;
        let (kind, key) = match kind {
            MeshBlobKind::Message => (
                BlobKind::KeyValue,
                key.ok_or(MeshError::Refused {
                    reason: "a message needs its seeker".into(),
                })?,
            ),
            MeshBlobKind::Announcement => (BlobKind::Bulletin, Vec::new()),
            MeshBlobKind::Keys => (BlobKind::Hash, Vec::new()),
        };
        let (id, counter) = core
            .send_blob(kind, key, payload, local_only)
            .map_err(|reason| MeshError::Refused { reason })?;
        Ok(MeshSendResult {
            id: id.as_bytes().to_vec(),
            counter: counter.map(|c| c.to_string()),
        })
    }

    /// Every distinct value stored under each seeker, in arrival order.
    pub fn fetch(&self, seekers: Vec<Vec<u8>>) -> Vec<MeshKeyValue> {
        self.core()
            .map(|c| {
                c.fetch(&seekers)
                    .into_iter()
                    .map(|(key, value)| MeshKeyValue { key, value })
                    .collect()
            })
            .unwrap_or_default()
    }

    /// Announcements after `cursor` (a counter from an earlier page; none from the
    /// start).
    pub fn fetch_bulletin(&self, cursor: Option<String>, limit: i32) -> Vec<MeshBulletinItem> {
        let after = cursor.and_then(|c| c.parse::<u64>().ok()).unwrap_or(0);
        self.core()
            .map(|c| {
                c.fetch_bulletin(after, limit.max(1) as usize)
                    .into_iter()
                    .map(|(counter, data)| MeshBulletinItem {
                        counter: counter.to_string(),
                        data,
                    })
                    .collect()
            })
            .unwrap_or_default()
    }

    /// A public key set by its blake3 hash (the user id).
    pub fn get_keys(&self, hash: Vec<u8>) -> Option<Vec<u8>> {
        self.core().and_then(|c| c.get_keys(&hash))
    }

    /// The seekers the app waits for, and `local_seekers` it waits for only from the
    /// mesh: those travel flagged local-only, bridges do not fetch them upstream and
    /// neither does this phone. Both lists replace the previous ones; a seeker in both
    /// is regular. The lists live in memory only: a restarted node waits for nothing
    /// until the app sets them again.
    #[uniffi::method(default(local_seekers = []))]
    pub fn set_wanted(&self, seekers: Vec<Vec<u8>>, local_seekers: Vec<Vec<u8>>) {
        if let Some(c) = self.core() {
            c.set_wanted(seekers, local_seekers);
        }
    }

    /// Internet nodes (API roots) and whether to bridge through them.
    pub fn set_upstream(&self, urls: Vec<String>, bridge_enabled: bool) {
        if let Some(c) = self.core() {
            c.set_upstream(urls, bridge_enabled);
        }
    }

    /// Deletes the key set stored under `hash` (its blake3 hash, the user id): the
    /// keys the app shared nearby. Returns whether one was deleted. Phones that already
    /// received a copy keep it until it expires.
    pub fn forget_keys(&self, hash: Vec<u8>) -> bool {
        self.core().is_some_and(|c| c.forget_keys(&hash))
    }

    /// The app locked: empties the wanted list and deletes the key sets the app shared
    /// since the last lock. The node keeps relaying, and the app's other blobs stay to
    /// be delivered: they are stored like relayed ones (see `docs/MESH.md`,
    /// "Plausible deniability"). A stopped node holds no wanted list and nothing to do.
    pub fn lock(&self) {
        if let Some(c) = self.core() {
            c.lock();
        }
    }

    /// Counters.
    pub fn status(&self) -> MeshCoreStatus {
        let Some(c) = self.core() else {
            return MeshCoreStatus {
                running: false,
                mesh_peers: 0,
                upstream_reachable: false,
                bridge_enabled: false,
                bulletin_counter: "0".into(),
                stored_blobs: 0,
                links_handshaking: 0,
                mesh_blobs: 0,
                upload_pending: 0,
                wanted_entries: 0,
                clock_offset_ms: 0,
                peer_id: String::new(),
            };
        };
        let s = c.status();
        MeshCoreStatus {
            running: true,
            mesh_peers: s.mesh_peers as i32,
            upstream_reachable: s.upstream_reachable,
            bridge_enabled: s.bridge_enabled,
            bulletin_counter: s.bulletin_counter.to_string(),
            stored_blobs: s.stored_blobs as i64,
            links_handshaking: s.handshaking as i32,
            mesh_blobs: s.mesh_blobs as i64,
            upload_pending: s.upload_pending as i64,
            wanted_entries: s.wanted_entries as i64,
            clock_offset_ms: s.clock_offset_ms,
            peer_id: s.peer_id,
        }
    }

    /// Deletes everything the node stored, relayed or sent by the app: the key
    /// file first, so that whatever stays on flash no longer decrypts. A running node
    /// restarts empty with the same sink, and with `new_config_json` when given (the
    /// app replaces `pool_key_hex` there, so that nothing is left wrapped under the old
    /// key), else the same configuration; the app sets the upstream and the wanted
    /// seekers again. A stopped node has nothing to wipe: the app deletes the data
    /// directory itself.
    #[uniffi::method(default(new_config_json = None))]
    pub fn wipe(&self, new_config_json: Option<String>) -> Result<(), MeshError> {
        let _lifecycle = self.lifecycle.lock();
        let Some(s) = self.inner.lock().take() else {
            return Ok(());
        };
        s.core.stop();
        drop(s.core);
        let dir = std::path::Path::new(&s.data_dir);
        let _ = crypt::destroy_key_file(&dir.join(node::POOLS_KEY_FILE));
        for f in [node::POOLS_FILE, node::WANTED_FILE] {
            let _ = std::fs::remove_file(dir.join(f));
        }
        let config_json = new_config_json.unwrap_or(s.config_json);
        let core = Core::start(
            &s.data_dir,
            &config_json,
            Arc::new(SinkHost::new(s.sink.clone())),
        )
        .map_err(|reason| MeshError::Start { reason })?;
        *self.inner.lock() = Some(Started {
            core,
            data_dir: s.data_dir,
            config_json,
            sink: s.sink,
        });
        Ok(())
    }
}

impl MeshNodeCore {
    fn stop_locked(&self) {
        let started = self.inner.lock().take();
        if let Some(s) = started {
            s.core.stop();
        }
    }
}

impl Drop for MeshNodeCore {
    fn drop(&mut self) {
        self.stop();
    }
}
