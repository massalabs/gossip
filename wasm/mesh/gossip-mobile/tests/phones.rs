//! Mobile nodes wired through a fake radio: handshake, replication, the app calls,
//! the bridge against a small HTTP upstream, encryption at rest and wipe.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::sync::Arc;
use std::time::{Duration, Instant};

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use crossbeam::channel::{unbounded, Sender};
use gossip_mobile::{MeshBlobKind, MeshCoreSink, MeshKeyValue, MeshNodeCore};
use gossip_wire::{build_kv_entry, KeyPair};
use parking_lot::Mutex;

/// Where a link goes: the other phone's inbox and its link id there.
type Route = (Sender<(i32, Vec<u8>)>, i32);
/// The upstream's key-value pool.
type Kv = Arc<Mutex<HashMap<Vec<u8>, Vec<u8>>>>;
/// The seekers an upstream was asked for.
type Asked = Arc<Mutex<Vec<Vec<u8>>>>;

/// One phone's side of the radio: frames sent on a link go to the other phone's link.
#[derive(Default)]
struct Radio {
    /// link id here -> (sender into the other phone, link id there)
    routes: Mutex<HashMap<i32, Route>>,
    closed: Mutex<Vec<i32>>,
    arrived: Mutex<Vec<MeshKeyValue>>,
    announcements: Mutex<Vec<Vec<u8>>>,
}

impl MeshCoreSink for Radio {
    fn send_frame(&self, link_id: i32, frame: Vec<u8>) -> bool {
        // not connected yet: refused, the core retries
        let Some((tx, there)) = self.routes.lock().get(&link_id).cloned() else {
            return false;
        };
        let _ = tx.send((there, frame));
        true
    }
    fn close_link(&self, link_id: i32) {
        self.closed.lock().push(link_id);
    }
    fn arrival(&self, messages: Vec<MeshKeyValue>, announcements: Vec<Vec<u8>>) {
        self.arrived.lock().extend(messages);
        self.announcements.lock().extend(announcements);
    }
}

struct Phone {
    node: Arc<MeshNodeCore>,
    radio: Arc<Radio>,
    inbox: Sender<(i32, Vec<u8>)>,
    _dir: tempfile::TempDir,
}

/// `config` with a random pool key when it has none: the node refuses to keep the
/// pools in plaintext.
fn with_key(config: &str) -> String {
    let mut v: serde_json::Value = if config.trim().is_empty() {
        serde_json::json!({})
    } else {
        serde_json::from_str(config).unwrap()
    };
    let o = v.as_object_mut().unwrap();
    if !o.contains_key("pool_key_hex") && !o.contains_key("allow_plaintext") {
        let key: [u8; 32] = rand::random();
        o.insert(
            "pool_key_hex".into(),
            key.iter()
                .map(|b| format!("{b:02x}"))
                .collect::<String>()
                .into(),
        );
    }
    v.to_string()
}

fn phone(config: &str) -> Phone {
    let dir = tempfile::tempdir().unwrap();
    let node = MeshNodeCore::new();
    let radio = Arc::new(Radio::default());
    node.start(
        dir.path().to_string_lossy().into_owned(),
        with_key(config),
        radio.clone(),
    )
    .unwrap();
    // one radio thread per phone delivers incoming chunks in order
    let (tx, rx) = unbounded::<(i32, Vec<u8>)>();
    let n = node.clone();
    std::thread::spawn(move || {
        while let Ok((link, frame)) = rx.recv() {
            n.frame_in(link, frame);
        }
    });
    Phone {
        node,
        radio,
        inbox: tx,
        _dir: dir,
    }
}

fn connect(a: &Phone, la: i32, b: &Phone, lb: i32) {
    // like the radio: each side hears of the link before any chunk arrives on it
    a.node.link_up(la, 185);
    b.node.link_up(lb, 185);
    a.radio.routes.lock().insert(la, (b.inbox.clone(), lb));
    b.radio.routes.lock().insert(lb, (a.inbox.clone(), la));
}

fn eventually(timeout: Duration, mut f: impl FnMut() -> bool) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if f() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    f()
}

fn message() -> (Vec<u8>, Vec<u8>) {
    build_kv_entry(&KeyPair::generate(0).unwrap(), &[42u8; 3000])
}

#[test]
fn two_phones_link_and_carry_messages_announcements_and_keys() {
    let a = phone("");
    let b = phone("");
    connect(&a, 1, &b, 7);
    assert!(eventually(Duration::from_secs(10), || a
        .node
        .status()
        .mesh_peers
        == 1
        && b.node.status().mesh_peers == 1));

    let (seeker, value) = message();
    b.node.set_wanted(vec![seeker.clone()], vec![]);
    let sent = a
        .node
        .send_blob(
            MeshBlobKind::Message,
            Some(seeker.clone()),
            value.clone(),
            false,
        )
        .unwrap();
    assert_eq!(sent.id.len(), 32);
    assert!(eventually(Duration::from_secs(15), || !b
        .radio
        .arrived
        .lock()
        .is_empty()));
    assert_eq!(b.radio.arrived.lock()[0].value, value);
    let got = b.node.fetch(vec![seeker.clone()]);
    assert_eq!(got.len(), 1);
    assert_eq!(got[0].value, value);

    let announcement = vec![9u8; 9000];
    let r = a
        .node
        .send_blob(
            MeshBlobKind::Announcement,
            None,
            announcement.clone(),
            false,
        )
        .unwrap();
    assert!(r.counter.is_some());
    assert!(eventually(Duration::from_secs(15), || !b
        .radio
        .announcements
        .lock()
        .is_empty()));
    let page = b.node.fetch_bulletin(None, 10);
    assert_eq!(page.len(), 1);
    assert_eq!(page[0].data, announcement);

    let keys = vec![5u8; 3200];
    a.node
        .send_blob(MeshBlobKind::Keys, None, keys.clone(), false)
        .unwrap();
    let hash = blake3::hash(&keys).as_bytes().to_vec();
    assert!(eventually(Duration::from_secs(15), || b
        .node
        .get_keys(hash.clone())
        .is_some()));

    // another value under the same seeker is kept beside the first, not replicated
    let other = build_kv_entry(&KeyPair::generate(0).unwrap(), &[1u8; 10]).1;
    assert!(b
        .node
        .send_blob(MeshBlobKind::Message, Some(seeker.clone()), other, false)
        .is_err());
    assert!(b.node.status().stored_blobs >= 3);
    a.node.stop();
    b.node.stop();
}

#[test]
fn a_chain_of_three_relays_and_duplicate_links_are_closed() {
    let a = phone("");
    let b = phone("");
    let c = phone("");
    connect(&a, 1, &b, 1);
    connect(&b, 2, &c, 1);
    assert!(eventually(Duration::from_secs(10), || b
        .node
        .status()
        .mesh_peers
        == 2));
    let (seeker, value) = message();
    c.node.set_wanted(vec![seeker.clone()], vec![]);
    a.node
        .send_blob(
            MeshBlobKind::Message,
            Some(seeker.clone()),
            value.clone(),
            false,
        )
        .unwrap();
    assert!(eventually(Duration::from_secs(20), || !c
        .node
        .fetch(vec![seeker.clone()])
        .is_empty()));

    // a second radio link between a and b: both phones close the same one of the two,
    // although each link has its own peer ids
    connect(&a, 9, &b, 9);
    assert!(eventually(Duration::from_secs(10), || {
        let (ca, cb) = (a.radio.closed.lock().clone(), b.radio.closed.lock().clone());
        ca.len() == 1 && ca == cb
    }));
    std::thread::sleep(Duration::from_millis(300));
    assert_eq!(a.radio.closed.lock().len(), 1, "no close loop");
    assert_eq!(a.node.status().mesh_peers, 1);
    assert_eq!(b.node.status().mesh_peers, 2);
    for p in [a, b, c] {
        p.node.stop();
    }
}

/// A minimal upstream: the client API routes the bridge uses.
fn upstream() -> (String, Kv) {
    let (url, kv, _) = upstream_logging();
    (url, kv)
}

/// [`upstream`], also recording every seeker a fetch asked for.
fn upstream_logging() -> (String, Kv, Asked) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}/api", listener.local_addr().unwrap());
    let kv: Kv = Arc::default();
    let asked: Asked = Arc::default();
    let log = asked.clone();
    let store = kv.clone();
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { continue };
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut line = String::new();
            if reader.read_line(&mut line).is_err() {
                continue;
            }
            let mut len = 0usize;
            loop {
                let mut h = String::new();
                if reader.read_line(&mut h).is_err() || h == "\r\n" || h.is_empty() {
                    break;
                }
                if let Some(v) = h.to_ascii_lowercase().strip_prefix("content-length:") {
                    len = v.trim().parse().unwrap_or(0);
                }
            }
            let mut body = vec![0u8; len];
            let _ = reader.read_exact(&mut body);
            let json: serde_json::Value = serde_json::from_slice(&body).unwrap_or_default();
            let path = line.split_whitespace().nth(1).unwrap_or("").to_string();
            let mut status = "200 OK";
            let reply = if path.ends_with("/bulletin/counter") {
                r#"{"counter":"0"}"#.to_string()
            } else if path.ends_with("/messages/fetch") {
                for s in json["seekers"].as_array().into_iter().flatten() {
                    if let Ok(seeker) = B64.decode(s.as_str().unwrap_or("")) {
                        log.lock().push(seeker);
                    }
                }
                // a careless upstream: everything it holds, asked for or not
                let kv = store.lock();
                let items: Vec<serde_json::Value> = kv
                    .iter()
                    .map(|(k, v)| serde_json::json!({"key": B64.encode(k), "value": B64.encode(v)}))
                    .collect();
                serde_json::Value::Array(items).to_string()
            } else if path.ends_with("/messages/") {
                let k = B64
                    .decode(json["key"].as_str().unwrap_or(""))
                    .unwrap_or_default();
                let v = B64
                    .decode(json["value"].as_str().unwrap_or(""))
                    .unwrap_or_default();
                if v.len() > 10_000 {
                    // a smaller payload limit than the mesh's
                    status = "413 Payload Too Large";
                } else {
                    store.lock().insert(k, v);
                }
                "{}".to_string()
            } else {
                "{}".to_string()
            };
            let _ = write!(
                stream,
                "HTTP/1.1 {status}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
                reply.len(),
                reply
            );
        }
    });
    (url, kv, asked)
}

#[test]
fn a_bridge_uploads_mesh_messages_and_fetches_wanted_ones() {
    let (url, upstream_kv) = upstream();
    let fast = r#"{"bridge_interval_ms": 300}"#;
    let inside = phone(fast);
    let bridge = phone(fast);
    connect(&inside, 1, &bridge, 1);
    bridge.node.set_upstream(vec![url], true);
    assert!(eventually(Duration::from_secs(10), || bridge
        .node
        .status()
        .upstream_reachable
        && inside.node.status().mesh_peers == 1));

    // inside to outside: uploaded by the bridge
    let (out_seeker, out_value) = message();
    inside
        .node
        .send_blob(
            MeshBlobKind::Message,
            Some(out_seeker.clone()),
            out_value.clone(),
            false,
        )
        .unwrap();
    assert!(eventually(Duration::from_secs(20), || upstream_kv
        .lock()
        .get(&out_seeker)
        == Some(&out_value)));

    // outside to inside: the inside phone waits for a seeker, the bridge fetches it
    let (in_seeker, in_value) = message();
    upstream_kv
        .lock()
        .insert(in_seeker.clone(), in_value.clone());
    inside.node.set_wanted(vec![in_seeker.clone()], vec![]);
    assert!(eventually(Duration::from_secs(20), || inside
        .radio
        .arrived
        .lock()
        .iter()
        .any(|kv| kv.key == in_seeker && kv.value == in_value)));
    inside.node.stop();
    bridge.node.stop();
}

#[test]
fn pools_are_encrypted_at_rest_and_wipe_empties_them() {
    let key = "11".repeat(32);
    let cfg = format!(r#"{{"pool_key_hex": "{key}"}}"#);
    let p = phone(&cfg);
    let (seeker, value) = message();
    p.node
        .send_blob(
            MeshBlobKind::Message,
            Some(seeker.clone()),
            value.clone(),
            false,
        )
        .unwrap();
    let dir = p._dir.path().to_path_buf();
    p.node.stop();
    let raw = std::fs::read(dir.join(gossip_mobile::node::POOLS_FILE)).unwrap();
    assert!(
        !raw.windows(32).any(|w| w == &seeker[1..33]),
        "seeker hash visible on disk"
    );

    // reopened with the key: still there
    let radio = Arc::new(Radio::default());
    let node = MeshNodeCore::new();
    node.start(
        dir.to_string_lossy().into_owned(),
        cfg.clone(),
        radio.clone(),
    )
    .unwrap();
    assert_eq!(node.fetch(vec![seeker.clone()]).len(), 1);
    node.wipe(None).unwrap();
    assert!(node.fetch(vec![seeker.clone()]).is_empty());
    assert!(node.status().running);
    node.stop();
    // a wrong key does not open the file
    let other = format!(r#"{{"pool_key_hex": "{}"}}"#, "22".repeat(32));
    node.start(
        dir.to_string_lossy().into_owned(),
        cfg.clone(),
        radio.clone(),
    )
    .unwrap();
    node.send_blob(MeshBlobKind::Message, Some(seeker.clone()), value, false)
        .unwrap();
    node.stop();
    assert!(node
        .start(
            dir.to_string_lossy().into_owned(),
            other.clone(),
            radio.clone()
        )
        .is_err());

    // a wipe with a new key: the old key no longer opens anything, the new one does
    node.start(
        dir.to_string_lossy().into_owned(),
        cfg.clone(),
        radio.clone(),
    )
    .unwrap();
    node.wipe(Some(other.clone())).unwrap();
    assert!(node.fetch(vec![seeker.clone()]).is_empty());
    node.stop();
    assert!(node
        .start(dir.to_string_lossy().into_owned(), cfg, radio.clone())
        .is_err());
    node.start(dir.to_string_lossy().into_owned(), other, radio)
        .unwrap();
    node.stop();
}

#[test]
fn a_phone_uploads_mesh_blobs_only_when_bridging_its_own_like_the_others() {
    let (url, upstream_kv) = upstream();
    let fast = r#"{"bridge_interval_ms": 300}"#;
    let other = phone(fast);
    let me = phone(fast);
    connect(&other, 1, &me, 1);
    assert!(eventually(Duration::from_secs(10), || me
        .node
        .status()
        .mesh_peers
        == 1));
    // a message of another phone reaches me over the mesh while I have no upstream
    let (their_seeker, their_value) = message();
    other
        .node
        .send_blob(
            MeshBlobKind::Message,
            Some(their_seeker.clone()),
            their_value.clone(),
            false,
        )
        .unwrap();
    assert!(eventually(Duration::from_secs(10), || !me
        .node
        .fetch(vec![their_seeker.clone()])
        .is_empty()));

    // my own message, then an upstream without bridging: nothing goes up
    let (my_seeker, my_value) = message();
    me.node
        .send_blob(
            MeshBlobKind::Message,
            Some(my_seeker.clone()),
            my_value.clone(),
            false,
        )
        .unwrap();
    me.node.set_upstream(vec![url.clone()], false);
    assert!(eventually(Duration::from_secs(10), || me
        .node
        .status()
        .upstream_reachable));
    std::thread::sleep(Duration::from_millis(1500));
    assert!(upstream_kv.lock().is_empty());
    assert_eq!(me.node.status().upload_pending, 2);

    // bridging on: both go up
    me.node.set_upstream(vec![url], true);
    assert!(eventually(Duration::from_secs(20), || {
        let kv = upstream_kv.lock();
        kv.get(&their_seeker) == Some(&their_value) && kv.get(&my_seeker) == Some(&my_value)
    }));
    other.node.stop();
    me.node.stop();
}

#[test]
fn wanted_seekers_live_in_memory_only() {
    let p = phone(r#"{"allow_plaintext": true}"#);
    let (seeker, _) = message();
    let (local, _) = message();
    p.node.set_wanted(vec![seeker.clone()], vec![local.clone()]);
    assert_eq!(p.node.status().wanted_entries, 2);
    let dir = p._dir.path().to_path_buf();
    p.node.stop();
    // nothing on disk names them (the pools are in the clear here)
    for f in std::fs::read_dir(&dir).unwrap() {
        let raw = std::fs::read(f.unwrap().path()).unwrap();
        assert!(!contains(&raw, &seeker[1..33]) && !contains(&raw, &local[1..33]));
    }
    assert!(!dir.join(gossip_mobile::node::WANTED_FILE).exists());

    // a list saved by a development build is not restored, and does not stay
    let legacy = dir.join(gossip_mobile::node::WANTED_FILE);
    std::fs::write(&legacy, &seeker).unwrap();
    let node = MeshNodeCore::new();
    node.start(
        dir.to_string_lossy().into_owned(),
        r#"{"allow_plaintext": true}"#.into(),
        Arc::new(Radio::default()),
    )
    .unwrap();
    assert_eq!(node.status().wanted_entries, 0);
    assert!(!legacy.exists());
    node.stop();
}

/// Whether `needle` occurs in `haystack`.
fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    haystack.windows(needle.len()).any(|w| w == needle)
}

/// A phone with a known pool key, for tests that read its pools afterwards.
fn keyed_phone(key: &[u8; 32]) -> Phone {
    let hex: String = key.iter().map(|b| format!("{b:02x}")).collect();
    phone(&format!(
        r#"{{"pool_key_hex": "{hex}", "bridge_interval_ms": 300, "guided": false}}"#
    ))
}

/// The whole decrypted pools file of a stopped phone, free pages included.
fn decrypted_pools(dir: &std::path::Path, key: &[u8; 32]) -> Vec<u8> {
    use redb::StorageBackend as _;
    let file = gossip_mobile::crypt::EncryptedFile::open(
        &dir.join(gossip_mobile::node::POOLS_FILE),
        &dir.join(gossip_mobile::node::POOLS_KEY_FILE),
        key,
    )
    .unwrap();
    let len = file.len().unwrap();
    file.read(0, len as usize).unwrap()
}

/// The pools of a stopped phone.
fn open_pools(dir: &std::path::Path, key: &[u8; 32]) -> Arc<gossip_pools::Pools> {
    let file = gossip_mobile::crypt::EncryptedFile::open(
        &dir.join(gossip_mobile::node::POOLS_FILE),
        &dir.join(gossip_mobile::node::POOLS_KEY_FILE),
        key,
    )
    .unwrap();
    gossip_pools::Pools::open_with_backend(gossip_pools::PoolsConfig::default(), file).unwrap()
}

#[test]
fn a_sent_blob_is_stored_exactly_like_the_same_blob_received_from_a_link() {
    let (ka, kb): ([u8; 32], [u8; 32]) = (rand::random(), rand::random());
    let a = keyed_phone(&ka);
    let b = keyed_phone(&kb);
    connect(&a, 1, &b, 1);
    let (seeker, value) = message();
    let (local_seeker, local_value) = message();
    let sent = [
        a.node
            .send_blob(MeshBlobKind::Message, Some(seeker.clone()), value, false)
            .unwrap()
            .id,
        a.node
            .send_blob(
                MeshBlobKind::Message,
                Some(local_seeker.clone()),
                local_value,
                true,
            )
            .unwrap()
            .id,
        a.node
            .send_blob(MeshBlobKind::Announcement, None, vec![3u8; 900], false)
            .unwrap()
            .id,
    ];
    assert!(eventually(Duration::from_secs(20), || b
        .node
        .status()
        .stored_blobs
        == 3));
    let (da, db) = (a._dir.path().to_path_buf(), b._dir.path().to_path_buf());
    a.node.stop();
    b.node.stop();
    let (pa, pb) = (open_pools(&da, &ka), open_pools(&db, &kb));
    for id in sent {
        let id = gossip_wire::BlobId::from_bytes(id.try_into().unwrap());
        let (ma, mb) = (
            pa.meta(&id).unwrap().unwrap(),
            pb.meta(&id).unwrap().unwrap(),
        );
        // every stored field: arrival time, source, trust bucket, scope, expiry
        assert_eq!(ma, mb);
        assert_eq!(ma.received_at, 0);
        assert!(ma.source_peer.is_empty());
        assert_eq!(pa.get(&id).unwrap(), pb.get(&id).unwrap());
    }
}

#[test]
fn a_lock_leaves_no_wanted_seeker_or_shared_keys_and_the_blobs_still_go() {
    let (url, upstream_kv) = upstream();
    let key: [u8; 32] = rand::random();
    let me = keyed_phone(&key);
    let other = keyed_phone(&rand::random());
    connect(&me, 1, &other, 1);
    let (wanted, _) = message();
    let (local_wanted, _) = message();
    me.node
        .set_wanted(vec![wanted.clone()], vec![local_wanted.clone()]);
    let (seeker, value) = message();
    me.node
        .send_blob(
            MeshBlobKind::Message,
            Some(seeker.clone()),
            value.clone(),
            false,
        )
        .unwrap();
    let keys = vec![5u8; 3200];
    me.node
        .send_blob(MeshBlobKind::Keys, None, keys.clone(), false)
        .unwrap();
    let hash = blake3::hash(&keys).as_bytes().to_vec();
    assert!(eventually(Duration::from_secs(20), || other
        .node
        .get_keys(hash.clone())
        .is_some()
        && !other.node.fetch(vec![seeker.clone()]).is_empty()));

    me.node.lock();
    assert!(me.node.get_keys(hash.clone()).is_none());
    assert!(!me.node.fetch(vec![seeker.clone()]).is_empty());
    other.node.stop();

    // a bridge comes by: the locked phone hands it the message, which goes up
    let bridge = keyed_phone(&rand::random());
    bridge.node.set_upstream(vec![url], true);
    connect(&me, 2, &bridge, 1);
    assert!(eventually(Duration::from_secs(20), || upstream_kv
        .lock()
        .get(&seeker)
        == Some(&value)));

    // the next session: its own wanted list and its own sends, as usual
    let (next_wanted, next_value) = message();
    me.node.set_wanted(vec![next_wanted.clone()], vec![]);
    bridge
        .node
        .send_blob(
            MeshBlobKind::Message,
            Some(next_wanted.clone()),
            next_value.clone(),
            false,
        )
        .unwrap();
    assert!(eventually(Duration::from_secs(20), || me
        .radio
        .arrived
        .lock()
        .iter()
        .any(|kv| kv.key == next_wanted && kv.value == next_value)));
    let (next_seeker, next_sent) = message();
    me.node
        .send_blob(
            MeshBlobKind::Message,
            Some(next_seeker.clone()),
            next_sent.clone(),
            false,
        )
        .unwrap();
    assert!(eventually(Duration::from_secs(20), || upstream_kv
        .lock()
        .get(&next_seeker)
        == Some(&next_sent)));
    me.node.lock();

    // nothing on the phone names the locked sessions' wanted seekers, in the pools
    // (free pages included) or in any other file
    let dir = me._dir.path().to_path_buf();
    me.node.stop();
    bridge.node.stop();
    let mut files = vec![decrypted_pools(&dir, &key)];
    for f in std::fs::read_dir(&dir).unwrap() {
        files.push(std::fs::read(f.unwrap().path()).unwrap());
    }
    for raw in &files {
        // (next_wanted is also the key of the message the bridge sent: stored as any)
        for s in [&wanted, &local_wanted] {
            assert!(
                !contains(raw, &s[1..33]),
                "a wanted seeker survived the lock"
            );
        }
    }
    // the message is still there, and no meta record marks it
    let pools = &files[0];
    assert!(contains(pools, &seeker[1..33]));
    let mut marked = Vec::new();
    for (at, w) in pools.windows(seeker.len()).enumerate() {
        // a meta record: index key length ‖ index key ‖ no source peer ‖ a mesh scope
        let end = at + seeker.len();
        if w == seeker.as_slice()
            && at > 0
            && pools[at - 1] == seeker.len() as u8
            && pools.get(end) == Some(&0)
            && pools.get(end + 1).is_some_and(|b| b & 0b10 != 0)
        {
            marked.push(pools[end + 1]);
        }
    }
    assert!(!marked.is_empty());
    // bit 3 was the own mark of development builds
    assert!(marked.iter().all(|scope| scope & 0b1000 == 0));
}

#[test]
fn a_store_from_a_build_that_marked_own_blobs_is_discarded() {
    let key: [u8; 32] = rand::random();
    let hex: String = key.iter().map(|b| format!("{b:02x}")).collect();
    let cfg = format!(r#"{{"pool_key_hex": "{hex}"}}"#);
    let p = phone(&cfg);
    let (seeker, value) = message();
    p.node
        .send_blob(MeshBlobKind::Message, Some(seeker.clone()), value, false)
        .unwrap();
    let dir = p._dir.path().to_path_buf();
    p.node.stop();
    {
        let file = gossip_mobile::crypt::EncryptedFile::open(
            &dir.join(gossip_mobile::node::POOLS_FILE),
            &dir.join(gossip_mobile::node::POOLS_KEY_FILE),
            &key,
        )
        .unwrap();
        let db = redb::Database::builder().create_with_backend(file).unwrap();
        let txn = db.begin_write().unwrap();
        txn.open_table(redb::TableDefinition::<[u8; 32], ()>::new("own_upload"))
            .unwrap()
            .insert(&[1u8; 32], ())
            .unwrap();
        txn.commit().unwrap();
    }
    let node = MeshNodeCore::new();
    node.start(
        dir.to_string_lossy().into_owned(),
        cfg,
        Arc::new(Radio::default()),
    )
    .unwrap();
    assert!(node.fetch(vec![seeker]).is_empty());
    assert_eq!(node.status().stored_blobs, 0);
    node.stop();
}

#[test]
fn a_full_phone_replaces_its_oldest_link_but_not_too_often() {
    // one slot; links may be replaced at once, at most once per 2 s
    let cfg = r#"{"max_links":1,"min_replaced_link_age_ms":0,"link_replace_interval_ms":2000}"#;
    let b = phone(cfg);
    let a = phone("");
    let c = phone("");
    let d = phone("");
    connect(&a, 1, &b, 1);
    assert!(eventually(Duration::from_secs(10), || b
        .node
        .status()
        .mesh_peers
        == 1));
    // c takes a's slot: a holding it forever would eclipse b
    connect(&c, 1, &b, 2);
    assert!(eventually(Duration::from_secs(10), || b
        .radio
        .closed
        .lock()
        .contains(&1)
        && c.node.status().mesh_peers == 1));
    assert_eq!(b.node.status().mesh_peers, 1);
    // right after, d is refused: no churn
    connect(&d, 1, &b, 3);
    assert!(eventually(Duration::from_secs(10), || b
        .radio
        .closed
        .lock()
        .contains(&3)));
    assert!(!b.radio.closed.lock().contains(&2), "c keeps its link");
    for p in [a, b, c, d] {
        p.node.stop();
    }
}

#[test]
fn a_refused_upload_does_not_hold_back_the_others() {
    let (url, upstream_kv) = upstream();
    let me = phone(r#"{"bridge_interval_ms": 200}"#);
    // the big one is refused for good by this upstream
    let (big_seeker, big) = build_kv_entry(&KeyPair::generate(0).unwrap(), &[1u8; 20_000]);
    me.node
        .send_blob(MeshBlobKind::Message, Some(big_seeker.clone()), big, false)
        .unwrap();
    let small: Vec<(Vec<u8>, Vec<u8>)> = (0..5).map(|_| message()).collect();
    for (s, v) in &small {
        me.node
            .send_blob(MeshBlobKind::Message, Some(s.clone()), v.clone(), false)
            .unwrap();
    }
    me.node.set_upstream(vec![url], true);
    assert!(eventually(Duration::from_secs(10), || {
        let kv = upstream_kv.lock();
        small.iter().all(|(s, _)| kv.contains_key(s))
    }));
    assert!(eventually(Duration::from_secs(5), || me
        .node
        .status()
        .upload_pending
        == 0));
    assert!(!upstream_kv.lock().contains_key(&big_seeker));
    me.node.stop();
}

#[test]
fn a_bridge_only_takes_the_seekers_it_asked_for() {
    let (url, upstream_kv) = upstream();
    let bridge = phone(r#"{"bridge_interval_ms": 200}"#);
    let inside = phone("");
    connect(&bridge, 1, &inside, 1);
    assert!(eventually(Duration::from_secs(10), || inside
        .node
        .status()
        .mesh_peers
        == 1));
    // an entry nobody in the mesh asked for, and one somebody waits for
    let (stray_seeker, stray) = message();
    let (wanted_seeker, wanted) = message();
    upstream_kv.lock().insert(stray_seeker.clone(), stray);
    upstream_kv.lock().insert(wanted_seeker.clone(), wanted);
    inside.node.set_wanted(vec![wanted_seeker.clone()], vec![]);
    bridge.node.set_upstream(vec![url], true);
    assert!(eventually(Duration::from_secs(15), || !inside
        .node
        .fetch(vec![wanted_seeker.clone()])
        .is_empty()));
    std::thread::sleep(Duration::from_millis(600));
    assert!(bridge.node.fetch(vec![stray_seeker.clone()]).is_empty());
    assert!(inside.node.fetch(vec![stray_seeker]).is_empty());
    for p in [bridge, inside] {
        p.node.stop();
    }
}

#[test]
fn a_node_without_a_pool_key_does_not_start() {
    let dir = tempfile::tempdir().unwrap();
    let node = MeshNodeCore::new();
    assert!(node
        .start(
            dir.path().to_string_lossy().into_owned(),
            String::new(),
            Arc::new(Radio::default()),
        )
        .is_err());
}

/// A host whose callbacks fail, like an app throwing from Kotlin or Swift.
struct Throwing;

impl MeshCoreSink for Throwing {
    fn send_frame(&self, _: i32, _: Vec<u8>) -> bool {
        panic!("the radio is gone")
    }
    fn close_link(&self, _: i32) {
        panic!("the radio is gone")
    }
    fn arrival(&self, _: Vec<MeshKeyValue>, _: Vec<Vec<u8>>) {
        panic!("the app is gone")
    }
}

#[test]
fn failing_callbacks_do_not_kill_the_node() {
    let dir = tempfile::tempdir().unwrap();
    let node = MeshNodeCore::new();
    node.start(
        dir.path().to_string_lossy().into_owned(),
        with_key(""),
        Arc::new(Throwing),
    )
    .unwrap();
    node.link_up(1, 185);
    std::thread::sleep(Duration::from_millis(200));
    let (seeker, value) = message();
    node.set_wanted(vec![seeker.clone()], vec![]);
    node.send_blob(MeshBlobKind::Message, Some(seeker.clone()), value, false)
        .unwrap();
    node.frame_in(1, vec![0xff]);
    std::thread::sleep(Duration::from_millis(200));
    assert!(node.status().running);
    assert_eq!(node.fetch(vec![seeker]).len(), 1);
    node.stop();
}

#[test]
fn a_long_blob_and_a_burst_of_small_messages_share_a_link() {
    let a = phone("");
    let b = phone("");
    connect(&a, 1, &b, 1);
    assert!(eventually(Duration::from_secs(10), || b
        .node
        .status()
        .mesh_peers
        == 1));
    // one blob of 60 KB (hundreds of chunks) and many small ones right behind it, with
    // their announcements and asks overtaking it on the high-priority stream
    let (big_seeker, big) = build_kv_entry(&KeyPair::generate(0).unwrap(), &[3u8; 60_000]);
    a.node
        .send_blob(MeshBlobKind::Message, Some(big_seeker.clone()), big, false)
        .unwrap();
    let small: Vec<(Vec<u8>, Vec<u8>)> = (0..100).map(|_| message()).collect();
    for (s, v) in &small {
        a.node
            .send_blob(MeshBlobKind::Message, Some(s.clone()), v.clone(), false)
            .unwrap();
    }
    let mut seekers: Vec<Vec<u8>> = small.iter().map(|(s, _)| s.clone()).collect();
    seekers.push(big_seeker);
    assert!(eventually(Duration::from_secs(30), || b
        .node
        .fetch(seekers.clone())
        .len()
        == seekers.len()));
    assert!(a.radio.closed.lock().is_empty() && b.radio.closed.lock().is_empty());
    for p in [a, b] {
        p.node.stop();
    }
}

#[test]
fn local_only_blobs_are_relayed_but_never_uploaded() {
    let (url, upstream_kv) = upstream();
    // no guided forwarding: the local-only blob reaches the bridge without a route
    let cfg = r#"{"bridge_interval_ms": 300, "guided": false}"#;
    let inside = phone(cfg);
    let bridge = phone(cfg);
    let beyond = phone(cfg);
    connect(&inside, 1, &bridge, 1);
    connect(&bridge, 2, &beyond, 1);
    assert!(eventually(Duration::from_secs(10), || bridge
        .node
        .status()
        .mesh_peers
        == 2));
    let (local_seeker, local_value) = message();
    let (seeker, value) = message();
    inside
        .node
        .send_blob(
            MeshBlobKind::Message,
            Some(local_seeker.clone()),
            local_value.clone(),
            true,
        )
        .unwrap();
    inside
        .node
        .send_blob(
            MeshBlobKind::Message,
            Some(seeker.clone()),
            value.clone(),
            false,
        )
        .unwrap();
    // relayed two hops, still local-only on the far side
    assert!(eventually(Duration::from_secs(20), || !beyond
        .node
        .fetch(vec![local_seeker.clone()])
        .is_empty()));
    // the sender (not bridging) and the bridges get an upstream: the regular one goes up
    inside.node.set_upstream(vec![url.clone()], false);
    bridge.node.set_upstream(vec![url.clone()], true);
    beyond.node.set_upstream(vec![url], true);
    assert!(eventually(Duration::from_secs(20), || upstream_kv
        .lock()
        .get(&seeker)
        == Some(&value)));
    std::thread::sleep(Duration::from_millis(1500));
    assert!(!upstream_kv.lock().contains_key(&local_seeker));
    // the sender does not bridge: its regular blob waits like any other
    assert_eq!(inside.node.status().upload_pending, 1);
    assert_eq!(beyond.node.status().upload_pending, 0);
    for p in [inside, bridge, beyond] {
        p.node.stop();
    }
}

#[test]
fn local_only_wanted_seekers_are_not_fetched_upstream() {
    let (url, upstream_kv, asked) = upstream_logging();
    let fast = r#"{"bridge_interval_ms": 300}"#;
    let inside = phone(fast);
    let bridge = phone(fast);
    connect(&inside, 1, &bridge, 1);
    assert!(eventually(Duration::from_secs(10), || inside
        .node
        .status()
        .mesh_peers
        == 1));
    let (seeker, value) = message();
    let (local_seeker, local_value) = message();
    upstream_kv.lock().insert(seeker.clone(), value);
    // the upstream holds it, but nobody may ask for it there
    upstream_kv.lock().insert(local_seeker.clone(), local_value);
    inside
        .node
        .set_wanted(vec![seeker.clone()], vec![local_seeker.clone()]);
    // the bridge hears both entries
    assert!(eventually(Duration::from_secs(10), || bridge
        .node
        .status()
        .wanted_entries
        >= 2));
    // both phones bridge: the inside phone must not poll its own local seeker either
    bridge.node.set_upstream(vec![url.clone()], true);
    inside.node.set_upstream(vec![url], true);
    assert!(eventually(Duration::from_secs(20), || !inside
        .node
        .fetch(vec![seeker.clone()])
        .is_empty()));
    std::thread::sleep(Duration::from_millis(1500));
    assert!(asked.lock().contains(&seeker));
    assert!(!asked.lock().contains(&local_seeker));
    assert!(inside.node.fetch(vec![local_seeker.clone()]).is_empty());
    assert!(bridge.node.fetch(vec![local_seeker]).is_empty());
    for p in [inside, bridge] {
        p.node.stop();
    }
}
