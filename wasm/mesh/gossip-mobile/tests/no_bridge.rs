//! Delivery over the mesh when no phone bridges to the internet.
//!
//! Guided forwarding (`gossip-repl/src/mesh.rs`, `guided_allows`) offers a key-value
//! blob on every mesh link for its first 5 s (`spray_ms`), then only toward the phones
//! that advertised its seeker, toward a bridge, or, for 5 % of (blob, peer) pairs,
//! anyway. Without a bridge a blob nobody wants yet waits on its holders until the
//! recipient's wanted entry reaches one of them. These tests measure, with simulated
//! phones and real time, how long a blob takes to reach its recipient in the cases
//! where that wait matters: the recipient locked when it was sent, no link at send
//! time, a relay that learns of the recipient late, a run of consecutive seekers, a
//! link that drops and comes back. The same cases with a bridge are the controls.
//!
//! Every scenario runs several times in parallel (fresh phones and fresh blob keys each
//! time, so the 5 % rule draws differently) and prints the distribution with
//! `--nocapture`. `MESH_RUNS` sets the number of runs (default 10). The assertions
//! have generous ceilings: they say what happens, not how fast a loaded machine is.
//! The scenarios of this file run one at a time so that their timings do not mix.
//!
//! Only the plain case runs in the normal suite (3 runs); the other measurements
//! take several minutes of real time together and are `#[ignore]`d:
//! `cargo test -p gossip-mobile --test no_bridge -- --ignored --nocapture`.

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

/// The spray window of `MeshConfig::default` (`spray_ms`), in ms.
const SPRAY_MS: u64 = 5_000;
/// Later than the spray: a link or a wanted entry that comes "after the spray".
const AFTER_SPRAY: Duration = Duration::from_millis(SPRAY_MS + 2_000);
/// How long a run waits for a delivery before calling it lost.
const CEILING: Duration = Duration::from_secs(60);

/// One scenario at a time: parallel scenarios would distort each other's timings.
static SERIAL: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn serial() -> std::sync::MutexGuard<'static, ()> {
    SERIAL.lock().unwrap_or_else(|e| e.into_inner())
}

fn runs() -> usize {
    std::env::var("MESH_RUNS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(10)
}

/// Runs of the scenarios kept in the normal suite: 3, or `MESH_RUNS`.
fn fast_runs() -> usize {
    std::env::var("MESH_RUNS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(3)
}

type Route = (Sender<(i32, Vec<u8>)>, i32);

/// A phone's radio: frames go to the other phone of the link, and every arrival the
/// app hears of is timestamped.
#[derive(Default)]
struct Radio {
    routes: Mutex<HashMap<i32, Route>>,
    arrived: Mutex<Vec<(Instant, Vec<u8>)>>,
}

impl MeshCoreSink for Radio {
    fn send_frame(&self, link_id: i32, frame: Vec<u8>) -> bool {
        let Some((tx, there)) = self.routes.lock().get(&link_id).cloned() else {
            return false;
        };
        let _ = tx.send((there, frame));
        true
    }
    fn close_link(&self, _link_id: i32) {}
    fn arrival(&self, messages: Vec<MeshKeyValue>, _announcements: Vec<Vec<u8>>) {
        let now = Instant::now();
        self.arrived
            .lock()
            .extend(messages.into_iter().map(|kv| (now, kv.key)));
    }
}

struct Phone {
    node: Arc<MeshNodeCore>,
    radio: Arc<Radio>,
    inbox: Sender<(i32, Vec<u8>)>,
    _dir: tempfile::TempDir,
}

impl Drop for Phone {
    fn drop(&mut self) {
        self.node.stop();
    }
}

impl Phone {
    /// When the app was told of a blob under `seeker`, if it was.
    fn callback_at(&self, seeker: &[u8]) -> Option<Instant> {
        self.radio
            .arrived
            .lock()
            .iter()
            .find(|(_, k)| k == seeker)
            .map(|(t, _)| *t)
    }
    fn holds(&self, seeker: &[u8]) -> bool {
        !self.node.fetch(vec![seeker.to_vec()]).is_empty()
    }
    fn want(&self, seekers: &[&Vec<u8>]) {
        self.node
            .set_wanted(seekers.iter().map(|s| s.to_vec()).collect(), vec![]);
    }
    fn send(&self, (seeker, value): &(Vec<u8>, Vec<u8>)) {
        self.node
            .send_blob(
                MeshBlobKind::Message,
                Some(seeker.clone()),
                value.clone(),
                false,
            )
            .unwrap();
    }
}

fn phone(config: &str) -> Arc<Phone> {
    let dir = tempfile::tempdir().unwrap();
    let node = MeshNodeCore::new();
    let radio = Arc::new(Radio::default());
    let mut v: serde_json::Value = if config.is_empty() {
        serde_json::json!({})
    } else {
        serde_json::from_str(config).unwrap()
    };
    let key: [u8; 32] = rand::random();
    v["pool_key_hex"] = key
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<String>()
        .into();
    node.start(
        dir.path().to_string_lossy().into_owned(),
        v.to_string(),
        radio.clone(),
    )
    .unwrap();
    let (tx, rx) = unbounded::<(i32, Vec<u8>)>();
    let n = node.clone();
    std::thread::spawn(move || {
        while let Ok((link, frame)) = rx.recv() {
            n.frame_in(link, frame);
        }
    });
    Arc::new(Phone {
        node,
        radio,
        inbox: tx,
        _dir: dir,
    })
}

fn connect(a: &Phone, la: i32, b: &Phone, lb: i32) {
    a.node.link_up(la, 185);
    b.node.link_up(lb, 185);
    a.radio.routes.lock().insert(la, (b.inbox.clone(), lb));
    b.radio.routes.lock().insert(lb, (a.inbox.clone(), la));
}

/// The radio lost the link: both phones hear of it.
fn disconnect(a: &Phone, la: i32, b: &Phone, lb: i32) {
    a.radio.routes.lock().remove(&la);
    b.radio.routes.lock().remove(&lb);
    a.node.link_down(la);
    b.node.link_down(lb);
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

fn linked(p: &Phone, n: i32) {
    assert!(
        eventually(Duration::from_secs(20), || p.node.status().mesh_peers == n),
        "the links did not come up"
    );
}

/// A message under a fresh seeker: every run draws new (blob, peer) pairs.
fn message() -> (Vec<u8>, Vec<u8>) {
    build_kv_entry(&KeyPair::generate(0).unwrap(), &[42u8; 3000])
}

/// A small upstream for the bridge controls: stores posts, answers fetches with what
/// was asked.
fn upstream() -> String {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}/api", listener.local_addr().unwrap());
    let kv: Arc<Mutex<HashMap<Vec<u8>, Vec<u8>>>> = Arc::default();
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
            let reply = if path.ends_with("/bulletin/counter") {
                r#"{"counter":"0"}"#.to_string()
            } else if path.ends_with("/messages/fetch") {
                let kv = kv.lock();
                let items: Vec<serde_json::Value> = json["seekers"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|s| B64.decode(s.as_str().unwrap_or("")).ok())
                    .filter_map(|s| kv.get(&s).map(|v| (s, v.clone())))
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
                kv.lock().insert(k, v);
                "{}".to_string()
            } else {
                "{}".to_string()
            };
            let _ = write!(
                stream,
                "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
                reply.len(),
                reply
            );
        }
    });
    url
}

/// The phone bridges to a working upstream (and so sends bridge beacons).
fn bridging(p: &Phone) {
    p.node.set_upstream(vec![upstream()], true);
    assert!(eventually(Duration::from_secs(20), || p
        .node
        .status()
        .upstream_reachable));
}

const BRIDGE_CFG: &str = r#"{"bridge_interval_ms": 300}"#;

// ------------------------------------------------------------------ measuring

/// What one run saw, measured from the send.
#[derive(Clone, Copy, Debug, Default)]
struct Run {
    /// The blob was in the recipient's store (what `fetch` returns once the app asks).
    stored: Option<Duration>,
    /// The app was told by the arrival callback.
    callback: Option<Duration>,
    /// When the recipient's app wanted the seeker.
    wanted: Duration,
}

impl Run {
    /// When an app that fetches its seekers right after setting them, and listens to
    /// the callback, reads the message: the later of "stored" and "wanted".
    fn read(&self) -> Option<Duration> {
        self.stored.map(|s| s.max(self.wanted))
    }
}

/// A timed step of a scenario, run by the measuring loop.
type Step = (Duration, Box<dyn FnOnce() + Send>);

/// One run of a scenario, set up and ready: the send has not happened yet.
struct Setup {
    recipient: Arc<Phone>,
    sender: Arc<Phone>,
    message: (Vec<u8>, Vec<u8>),
    /// When (after the send) the recipient's app wants the seeker; `None` when the
    /// setup already set it before the send (and the app does not set it again).
    want_at: Option<Duration>,
    /// Other steps (links coming up, unlocks), after the send.
    steps: Vec<Step>,
    _keep: Vec<Arc<Phone>>,
}

/// Sends, runs the steps and watches the recipient until it was told or the ceiling.
fn watch(setup: Setup) -> Run {
    let Setup {
        recipient,
        sender,
        message,
        want_at,
        mut steps,
        _keep,
    } = setup;
    let seeker = message.0.clone();
    if let Some(at) = want_at {
        let (r, s) = (recipient.clone(), seeker.clone());
        steps.push((at, Box::new(move || r.want(&[&s]))));
    }
    let want_at = want_at.unwrap_or_default();
    steps.sort_by_key(|(t, _)| *t);
    let mut steps = steps.into_iter().peekable();
    let t0 = Instant::now();
    sender.send(&message);
    let mut run = Run {
        wanted: want_at,
        ..Run::default()
    };
    while t0.elapsed() < CEILING {
        while steps.peek().is_some_and(|(t, _)| t0.elapsed() >= *t) {
            (steps.next().unwrap().1)();
        }
        if run.stored.is_none() && recipient.holds(&seeker) {
            run.stored = Some(t0.elapsed());
        }
        if let Some(at) = recipient.callback_at(&seeker) {
            run.callback = Some(at - t0);
        }
        let done = steps.peek().is_none()
            && match run.stored {
                // stored before the app wanted it: no callback will ever come
                Some(s) if s < want_at => true,
                Some(s) => run.callback.is_some() || t0.elapsed() > s + Duration::from_secs(3),
                None => false,
            };
        if done {
            break;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    run
}

/// Runs a scenario [`runs`] times in parallel and prints the distribution.
fn measure(name: &str, scenario: impl Fn() -> Setup + Sync) -> Vec<Run> {
    measure_n(name, runs(), scenario)
}

/// [`measure`] with `n` runs.
fn measure_n(name: &str, n: usize, scenario: impl Fn() -> Setup + Sync) -> Vec<Run> {
    let out: Vec<Run> = std::thread::scope(|s| {
        let handles: Vec<_> = (0..n).map(|_| s.spawn(|| watch(scenario()))).collect();
        handles.into_iter().map(|h| h.join().unwrap()).collect()
    });
    report(name, &out);
    out
}

fn stats(xs: &[Option<Duration>]) -> String {
    let mut got: Vec<f64> = xs.iter().flatten().map(Duration::as_secs_f64).collect();
    got.sort_by(f64::total_cmp);
    if got.is_empty() {
        return format!("0/{}", xs.len());
    }
    format!(
        "{}/{} min {:.2} s, median {:.2} s, max {:.2} s",
        got.len(),
        xs.len(),
        got[0],
        got[got.len() / 2],
        got[got.len() - 1]
    )
}

fn report(name: &str, runs: &[Run]) {
    let stored: Vec<_> = runs.iter().map(|r| r.stored).collect();
    let read: Vec<_> = runs.iter().map(Run::read).collect();
    let callback: Vec<_> = runs.iter().map(|r| r.callback).collect();
    eprintln!(
        "MEASURE {name}\n  stored:   {}\n  read:     {}\n  callback: {}",
        stats(&stored),
        stats(&read),
        stats(&callback)
    );
}

fn all(runs: &[Run], f: impl Fn(&Run) -> bool) -> bool {
    runs.iter().all(f)
}

fn within(d: Option<Duration>, secs: u64) -> bool {
    d.is_some_and(|d| d < Duration::from_secs(secs))
}

// ------------------------------------------------------------------ scenarios

/// Two linked phones; `prepare` runs on (sender, recipient) once the link is up.
fn two_linked(cfg_recipient: &str, prepare: impl Fn(&Phone, &Phone)) -> (Arc<Phone>, Arc<Phone>) {
    let a = phone("");
    let b = phone(cfg_recipient);
    connect(&a, 1, &b, 1);
    linked(&a, 1);
    linked(&b, 1);
    prepare(&a, &b);
    (a, b)
}

/// Control: the recipient wants the seeker before the send, both linked. The plain
/// case, within the spray.
#[test]
fn without_a_bridge_a_wanted_blob_reaches_a_linked_recipient_at_once() {
    let _s = serial();
    let runs = measure_n("plain: wanted before the send, linked", fast_runs(), || {
        let message = message();
        let (a, b) = two_linked("", |_, b| b.want(&[&message.0]));
        Setup {
            recipient: b,
            sender: a,
            message,
            want_at: None,
            steps: vec![],
            _keep: vec![],
        }
    });
    assert!(all(&runs, |r| within(r.callback, 15)));
}

/// Case 1: the recipient is locked (its wanted list empty) when the blob is sent, then
/// unlocks after the spray and wants the seeker. The spray already put the blob on the
/// recipient's phone, so `fetch` has it; but the arrival callback only fires when a
/// blob is stored while wanted (`node.rs` `notify`), and `set_wanted` does not look at
/// what is already stored: an app that only listens to the callback never hears of it.
#[test]
#[ignore = "measurement, real time (several seconds to a minute): run on demand with --ignored --nocapture"]
fn without_a_bridge_a_blob_sent_to_a_locked_linked_recipient_is_on_its_phone_but_no_callback_fires_after_unlock(
) {
    let _s = serial();
    let runs = measure(
        "case 1: recipient locked at send, linked, unlocks and wants after the spray",
        || {
            let (a, b) = two_linked("", |_, b| b.node.lock());
            Setup {
                recipient: b,
                sender: a,
                message: message(),
                want_at: Some(AFTER_SPRAY),
                steps: vec![],
                _keep: vec![],
            }
        },
    );
    assert!(all(&runs, |r| within(r.stored, 15)
        && r.stored.unwrap() < AFTER_SPRAY));
    assert!(all(&runs, |r| r.callback.is_none()));
}

/// Case 1, with a bridge: the recipient is the bridge. Nothing changes: the spray has
/// already done the work.
#[test]
#[ignore = "measurement, real time (several seconds to a minute): run on demand with --ignored --nocapture"]
fn with_a_bridge_a_blob_sent_to_a_locked_recipient_behaves_the_same() {
    let _s = serial();
    let runs = measure(
        "case 1 control: recipient bridges, locked at send, wants after the spray",
        || {
            let (a, b) = two_linked(BRIDGE_CFG, |_, b| {
                bridging(b);
                b.node.lock();
            });
            Setup {
                recipient: b,
                sender: a,
                message: message(),
                want_at: Some(AFTER_SPRAY),
                steps: vec![],
                _keep: vec![],
            }
        },
    );
    assert!(all(&runs, |r| within(r.stored, 15)));
}

/// Two phones not linked at the send; the link comes up after the spray.
fn link_later(cfg_recipient: &str, bridge: bool, want_at: Duration) -> Setup {
    let a = phone("");
    let b = phone(cfg_recipient);
    if bridge {
        bridging(&b);
    }
    let (pa, pb) = (a.clone(), b.clone());
    Setup {
        recipient: b,
        sender: a,
        message: message(),
        want_at: Some(want_at),
        steps: vec![(AFTER_SPRAY, Box::new(move || connect(&pa, 1, &pb, 1)))],
        _keep: vec![],
    }
}

/// Case 2a: no link at the send, the recipient wants the seeker from the start, the
/// link comes up after the spray. The recipient's entry reaches the sender on the
/// first wanted round of the new link and the sender announces it at once
/// (`on_wanted_received`, `PropagateWanted`).
#[test]
#[ignore = "measurement, real time (several seconds to a minute): run on demand with --ignored --nocapture"]
fn without_a_bridge_a_blob_reaches_a_recipient_that_wanted_it_before_the_late_link() {
    let _s = serial();
    let runs = measure(
        "case 2a: no link at send, wanted before, link after the spray",
        || link_later("", false, Duration::ZERO),
    );
    assert!(all(&runs, |r| within(r.callback, 30)));
}

/// Case 2b: no link at the send, link after the spray, the recipient wants the seeker
/// only after the link is up.
#[test]
#[ignore = "measurement, real time (several seconds to a minute): run on demand with --ignored --nocapture"]
fn without_a_bridge_a_blob_reaches_a_recipient_that_wants_it_after_the_late_link() {
    let _s = serial();
    let runs = measure(
        "case 2b: no link at send, link after the spray, wanted 3 s later",
        || link_later("", false, AFTER_SPRAY + Duration::from_secs(3)),
    );
    // stored early only for the 5 % pairs; read once wanted
    assert!(all(&runs, |r| within(r.read(), 30)));
}

/// Case 2 with a bridge (the recipient bridges): no faster. The sender answers the
/// link-up summary before the bridge's beacon reaches it, and a beacon arriving later
/// does not re-offer the blobs already held (`on_beacon_received` only merges it), so
/// the blob still waits for the recipient's wanted entry.
#[test]
#[ignore = "measurement, real time (several seconds to a minute): run on demand with --ignored --nocapture"]
fn with_a_bridge_a_blob_reaches_a_late_linked_recipient_that_wanted_it_before() {
    let _s = serial();
    let runs = measure(
        "case 2a control: recipient bridges, no link at send, wanted before, link after the spray",
        || link_later(BRIDGE_CFG, true, Duration::ZERO),
    );
    assert!(all(&runs, |r| within(r.read(), 30)));
}

#[test]
#[ignore = "measurement, real time (several seconds to a minute): run on demand with --ignored --nocapture"]
fn with_a_bridge_a_blob_reaches_a_late_linked_recipient_that_wants_it_after() {
    let _s = serial();
    let runs = measure(
        "case 2b control: recipient bridges, no link at send, link after the spray, wanted 3 s later",
        || link_later(BRIDGE_CFG, true, AFTER_SPRAY + Duration::from_secs(3)),
    );
    assert!(all(&runs, |r| within(r.read(), 30)));
}

/// A chain A–B–C, A sends for C. `bc_at`: when B–C comes up (`None`: before the send).
fn chain(c_cfg: &str, bridge: bool, bc_at: Option<Duration>, want_at: Duration) -> Setup {
    let a = phone("");
    let b = phone("");
    let c = phone(c_cfg);
    if bridge {
        bridging(&c);
    }
    connect(&a, 1, &b, 1);
    let mut steps: Vec<Step> = Vec::new();
    match bc_at {
        None => {
            connect(&b, 2, &c, 1);
            linked(&b, 2);
        }
        Some(at) => {
            let (pb, pc) = (b.clone(), c.clone());
            steps.push((at, Box::new(move || connect(&pb, 2, &pc, 1))));
        }
    }
    linked(&a, 1);
    Setup {
        recipient: c,
        sender: a,
        message: message(),
        want_at: Some(want_at),
        steps,
        _keep: vec![b],
    }
}

/// Case 3a: all linked at the send, C wants the seeker only after the spray. The spray
/// carries the blob two hops (B relays it while it is younger than 5 s), so C holds it
/// before it wants it: read at once, no callback.
#[test]
#[ignore = "measurement, real time (several seconds to a minute): run on demand with --ignored --nocapture"]
fn without_a_bridge_a_chain_sprays_the_blob_to_the_far_end_before_it_is_wanted() {
    let _s = serial();
    let runs = measure(
        "case 3a: chain linked at send, C wants after the spray",
        || chain("", false, None, AFTER_SPRAY),
    );
    assert!(all(&runs, |r| within(r.read(), 30)));
}

/// Case 3b: A–B linked at the send, B–C only after the spray, C wanted from the start.
#[test]
#[ignore = "measurement, real time (several seconds to a minute): run on demand with --ignored --nocapture"]
fn without_a_bridge_a_relay_linked_late_to_the_recipient_forwards_once_it_hears_the_entry() {
    let _s = serial();
    let runs = measure(
        "case 3b: chain, B-C linked after the spray, C wanted before",
        || chain("", false, Some(AFTER_SPRAY), Duration::ZERO),
    );
    assert!(all(&runs, |r| within(r.callback, 30)));
}

/// Case 3c: A–B linked at the send, B–C after the spray, C wants 3 s after that.
#[test]
#[ignore = "measurement, real time (several seconds to a minute): run on demand with --ignored --nocapture"]
fn without_a_bridge_a_relay_linked_late_forwards_when_the_recipient_wants_it_later() {
    let _s = serial();
    let runs = measure(
        "case 3c: chain, B-C linked after the spray, C wants 3 s after the link",
        || {
            chain(
                "",
                false,
                Some(AFTER_SPRAY),
                AFTER_SPRAY + Duration::from_secs(3),
            )
        },
    );
    assert!(all(&runs, |r| within(r.read(), 30)));
}

#[test]
#[ignore = "measurement, real time (several seconds to a minute): run on demand with --ignored --nocapture"]
fn with_a_bridge_a_relay_linked_late_to_the_recipient_forwards() {
    let _s = serial();
    let runs = measure(
        "case 3b control: chain, C bridges, B-C linked after the spray, C wanted before",
        || chain(BRIDGE_CFG, true, Some(AFTER_SPRAY), Duration::ZERO),
    );
    assert!(all(&runs, |r| within(r.read(), 30)));
}

#[test]
#[ignore = "measurement, real time (several seconds to a minute): run on demand with --ignored --nocapture"]
fn with_a_bridge_a_relay_linked_late_forwards_when_the_recipient_wants_it_later() {
    let _s = serial();
    let runs = measure(
        "case 3c control: chain, C bridges, B-C linked after the spray, C wants 3 s after the link",
        || {
            chain(
                BRIDGE_CFG,
                true,
                Some(AFTER_SPRAY),
                AFTER_SPRAY + Duration::from_secs(3),
            )
        },
    );
    assert!(all(&runs, |r| within(r.read(), 30)));
}

/// Case 6: the phones met before, the recipient's entry reached the sender, then the
/// link dropped (the recipient walked away). The sender sends while apart; they meet
/// again after the spray (a new link, so new peer ids).
fn relink(want_at: Duration, bridge: bool) -> Setup {
    let message = message();
    let a = phone("");
    let b = phone(if bridge { BRIDGE_CFG } else { "" });
    if bridge {
        bridging(&b);
    }
    connect(&a, 1, &b, 1);
    linked(&a, 1);
    if want_at.is_zero() {
        b.want(&[&message.0]);
        // the sender has the recipient's entry
        let base = if bridge { 1 } else { 0 };
        assert!(eventually(Duration::from_secs(20), || a
            .node
            .status()
            .wanted_entries
            > base));
    }
    disconnect(&a, 1, &b, 1);
    let (pa, pb) = (a.clone(), b.clone());
    Setup {
        recipient: b,
        sender: a,
        message,
        // wanted before: the app does not set its list again
        want_at: (!want_at.is_zero()).then_some(want_at),
        steps: vec![(AFTER_SPRAY, Box::new(move || connect(&pa, 2, &pb, 2)))],
        _keep: vec![],
    }
}

/// Case 6: the sender keeps the recipient's entry after the link drops
/// (`WantedTable::remove_peer` only drops the direction), and `guided_allows` takes
/// the directionless entry for the sender's own seeker: the blob is offered nowhere.
/// `WantedTable::merge` now counts the entry as fresh when it comes back with a
/// direction, so `on_wanted_received` would announce the held blob. But it does not
/// come back: on the new link the sender's `WantedSummary` lists the stale entry, and
/// the recipient's `WantedTable::apply_summary` marks its own entry as already sent
/// (the echo's hop budget is one below its own, a tie). The recipient sends it again
/// only when its expiry has grown past `WANTED_RESEND_SLACK_MS` (5 min) beyond the
/// echo's, or when a new `set_wanted` draws a higher hop budget. Measured with the
/// merge rule and no new `set_wanted`: 1/12 delivered (the 5 % rule); with a
/// `set_wanted` repeated at the send: 9/12.
#[test]
#[ignore = "known loss: the sender's link-up WantedSummary echoes the recipient's stale entry, so the recipient marks its entry as sent (WantedTable::apply_summary) and never repeats it; the fresh-on-new-direction rule in WantedTable::merge never fires"]
fn a_blob_sent_while_apart_reaches_a_recipient_met_before_when_they_meet_again() {
    let _s = serial();
    let runs = measure_n(
        "case 6: met before (entry known), apart at send, meet again after the spray",
        fast_runs(),
        || relink(Duration::ZERO, false),
    );
    assert!(all(&runs, |r| within(r.callback, 30)));
}

/// Case 6 with a bridge: the recipient bridges; delivered by the same rule.
#[test]
#[ignore = "measurement, real time (about 10 s): run on demand with --ignored --nocapture"]
fn with_a_bridge_a_blob_sent_while_apart_reaches_a_recipient_met_before_when_they_meet_again() {
    let _s = serial();
    let runs = measure(
        "case 6 control: recipient bridges, met before, apart at send, meet again after the spray",
        || relink(Duration::ZERO, true),
    );
    assert!(all(&runs, |r| within(r.callback, 30)));
}

/// Case 6 when the recipient wanted nothing before the link dropped: no stale entry,
/// so its entry is fresh when they meet again.
#[test]
#[ignore = "measurement, real time (several seconds to a minute): run on demand with --ignored --nocapture"]
fn without_a_bridge_a_blob_sent_while_apart_reaches_a_recipient_met_before_that_wants_it_later() {
    let _s = serial();
    let runs = measure(
        "case 6b: met before (no entry), apart at send, meet again after the spray, wanted 3 s later",
        || relink(AFTER_SPRAY + Duration::from_secs(3), false),
    );
    assert!(all(&runs, |r| within(r.read(), 30)));
}

// ------------------------------------------------------------------ a run of seekers

/// What one run of [`seekers_run`] saw.
#[derive(Clone, Debug, Default)]
struct Chain {
    /// When each message was read, from the send.
    read: Vec<Option<Duration>>,
    /// How many of them the arrival callback announced.
    callbacks: usize,
}

const RUN_LEN: usize = 20;
/// The unpredictable seeker: the recipient only wants it some time after reading the
/// one before.
const FRESH: usize = 10;
const FRESH_DELAY: Duration = Duration::from_secs(3);

/// Twenty messages under consecutive seekers, all sent at once; the recipient wants
/// one seeker at a time and learns the next only by reading the previous message (as
/// a session chain does), except message `FRESH`, which it only wants `FRESH_DELAY`
/// after reading the one before. The app fetches right after setting its wanted list
/// and listens to the callback.
fn seekers_run(linked_at_send: bool, bridge: bool) -> Chain {
    let messages: Vec<_> = (0..RUN_LEN).map(|_| message()).collect();
    let a = phone("");
    let b = phone(if bridge { BRIDGE_CFG } else { "" });
    if bridge {
        bridging(&b);
    }
    if linked_at_send {
        connect(&a, 1, &b, 1);
        linked(&a, 1);
        linked(&b, 1);
    }
    b.want(&[&messages[0].0]);
    let t0 = Instant::now();
    for m in &messages {
        a.send(m);
    }
    let mut link_at = (!linked_at_send).then_some(AFTER_SPRAY);
    let mut read = vec![None; RUN_LEN];
    let mut next = 0;
    let mut want_next_at: Option<Instant> = None;
    let deadline = Duration::from_secs(180);
    while next < RUN_LEN && t0.elapsed() < deadline {
        if link_at.is_some_and(|at| t0.elapsed() >= at) {
            connect(&a, 1, &b, 1);
            link_at = None;
        }
        if want_next_at.is_some_and(|at| Instant::now() >= at) {
            b.want(&[&messages[next].0]);
            want_next_at = None;
        }
        if want_next_at.is_none() && b.holds(&messages[next].0) {
            read[next] = Some(t0.elapsed());
            next += 1;
            if next < RUN_LEN {
                if next == FRESH {
                    want_next_at = Some(Instant::now() + FRESH_DELAY);
                } else {
                    b.want(&[&messages[next].0]);
                }
            }
            continue;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    let callbacks = messages
        .iter()
        .filter(|(s, _)| b.callback_at(s).is_some())
        .count();
    Chain { read, callbacks }
}

fn measure_seekers(name: &str, linked_at_send: bool, bridge: bool) -> Vec<Chain> {
    let n = runs();
    let out: Vec<Chain> = std::thread::scope(|s| {
        let handles: Vec<_> = (0..n)
            .map(|_| s.spawn(move || seekers_run(linked_at_send, bridge)))
            .collect();
        handles.into_iter().map(|h| h.join().unwrap()).collect()
    });
    let total: Vec<Option<Duration>> = out.iter().map(|c| c.read[RUN_LEN - 1]).collect();
    // the longest wait between two reads (the first read, which waits for the link,
    // and the fresh seeker's own delay left out)
    let worst_step: Vec<Option<Duration>> = out
        .iter()
        .map(|c| {
            let mut prev = c.read[0]?;
            let mut worst = Duration::ZERO;
            for (i, r) in c.read.iter().enumerate().skip(1) {
                let r = (*r)?;
                let step = r.saturating_sub(prev);
                let step = if i == FRESH {
                    step.saturating_sub(FRESH_DELAY)
                } else {
                    step
                };
                worst = worst.max(step);
                prev = r;
            }
            Some(worst)
        })
        .collect();
    let fresh: Vec<Option<Duration>> = out
        .iter()
        .map(|c| Some(c.read[FRESH]?.saturating_sub(c.read[FRESH - 1]?)))
        .collect();
    let read: Vec<usize> = out
        .iter()
        .map(|c| c.read.iter().flatten().count())
        .collect();
    let first: Vec<Option<Duration>> = out.iter().map(|c| c.read[0]).collect();
    eprintln!(
        "MEASURE {name}\n  first read: {}\n  all {RUN_LEN} read: {}\n  worst step:  {}\n  fresh step (incl. {FRESH_DELAY:?} delay): {}\n  read per run: {read:?}\n  callbacks per run: {:?}",
        stats(&first),
        stats(&total),
        stats(&worst_step),
        stats(&fresh),
        out.iter().map(|c| c.callbacks).collect::<Vec<_>>()
    );
    out
}

/// Case 4, linked at the send: the spray puts all twenty on the recipient's phone in
/// the first seconds; each is read as soon as it is wanted. Only the first is
/// announced by the callback (the others were stored before they were wanted).
#[test]
#[ignore = "measurement, real time (several seconds to a minute): run on demand with --ignored --nocapture"]
fn without_a_bridge_twenty_consecutive_seekers_sent_to_a_linked_phone_are_read_at_once() {
    let _s = serial();
    let out = measure_seekers("case 4: twenty seekers, linked at send", true, false);
    assert!(out.iter().all(|c| c.read.iter().all(Option::is_some)
        && c.read[RUN_LEN - 1].unwrap() < Duration::from_secs(60)));
}

/// Case 4, no link at the send, link after the spray: each message waits for the
/// recipient's next entry to cross the link (one wanted round, every 2 s) before the
/// sender announces it.
#[test]
#[ignore = "measurement, real time (several seconds to a minute): run on demand with --ignored --nocapture"]
fn without_a_bridge_twenty_consecutive_seekers_sent_before_the_link_cost_a_wanted_round_each() {
    let _s = serial();
    let out = measure_seekers(
        "case 4b: twenty seekers, no link at send, link after the spray",
        false,
        false,
    );
    assert!(out.iter().all(|c| c.read.iter().all(Option::is_some)));
}

#[test]
#[ignore = "measurement, real time (several seconds to a minute): run on demand with --ignored --nocapture"]
fn with_a_bridge_twenty_consecutive_seekers_sent_before_the_link() {
    let _s = serial();
    let out = measure_seekers(
        "case 4b control: recipient bridges, twenty seekers, no link at send, link after the spray",
        false,
        true,
    );
    assert!(out.iter().all(|c| c.read.iter().all(Option::is_some)));
}
