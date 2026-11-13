//! Mesh behaviour over in-memory links: per-link scope filter, ingest scope, wanted
//! forwarding with priority, and the mesh time window.

use std::sync::Arc;
use std::time::{Duration, Instant};

use gossip_repl::mem::{MemHub, MemNode, MemNodeParts};
use gossip_repl::{
    BlobStore, FixedTrust, LinkInfo, LinkKind, MemBlobStore, MemStoreConfig, MeshConfig, MeshParts,
    PropagationConfig,
};
use gossip_trust::{TrustPolicy, TrustRegistry};
use gossip_wire::{
    build_kv_entry, BlobEnvelope, BlobId, BlobKind, KeyPair, PeerId, Scope, UnixMillis,
    WANTED_SEEKER_LEN,
};

struct Node {
    node: MemNode,
    store: Arc<MemBlobStore>,
}

fn start(hub: &Arc<MemHub>, mesh: MeshConfig) -> Node {
    let keypair = KeyPair::generate(0).unwrap();
    let store = Arc::new(MemBlobStore::new(MemStoreConfig::default()));
    let node = MemNode::start(
        hub.clone(),
        MemNodeParts {
            peer_id: PeerId::from_public_key(keypair.get_public_key()),
            store: store.clone(),
            config: PropagationConfig {
                announcement_interval_ms: 50,
                batch_proc_period_ms: 50,
                ..PropagationConfig::default()
            },
            trust: Arc::new(FixedTrust::new(0.5)),
            registry: Arc::new(TrustRegistry::new(TrustPolicy::default())),
            mesh: MeshParts::new(mesh),
        },
    );
    Node { node, store }
}

fn phone() -> MeshConfig {
    MeshConfig {
        wanted_forward_interval_ms: 50,
        // deterministic paths
        spray_permille: 0,
        ..MeshConfig::phone()
    }
}

fn link(hub: &MemHub, a: &Node, b: &Node, kind: LinkKind) {
    hub.connect_with(
        &a.node.peer_id(),
        &b.node.peer_id(),
        LinkInfo {
            kind,
            max_message_size: usize::MAX,
            bandwidth_bps: 0,
            compact_link_up: None,
        },
    );
}

fn kv_at(kp: &KeyPair, created_at: u64, n: u8) -> BlobEnvelope {
    let (key, payload) = build_kv_entry(kp, &[n; 64]);
    BlobEnvelope::new(BlobKind::KeyValue, created_at, key, payload)
}

fn now() -> u64 {
    UnixMillis::now().0
}

fn eventually(timeout: Duration, mut f: impl FnMut() -> bool) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if f() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    f()
}

#[test]
fn each_link_kind_carries_only_its_scope() {
    let hub = MemHub::new();
    let a = start(&hub, phone());
    let mesh_peer = start(&hub, phone());
    let tcp_peer = start(&hub, phone());
    let internet = a.store.insert_raw_scoped(
        kv_at(&KeyPair::generate(0).unwrap(), now(), 1),
        Scope::INTERNET,
    );
    let mesh = a
        .store
        .insert_raw_scoped(kv_at(&KeyPair::generate(0).unwrap(), now(), 2), Scope::MESH);

    // anti-entropy on connect lists only what the link may carry
    link(&hub, &a, &mesh_peer, LinkKind::Mem);
    link(&hub, &a, &tcp_peer, LinkKind::Tcp);
    assert!(eventually(Duration::from_secs(10), || mesh_peer
        .store
        .contains(&mesh)
        && tcp_peer.store.contains(&internet)));
    std::thread::sleep(Duration::from_millis(500));
    assert!(!mesh_peer.store.contains(&internet));
    assert!(!tcp_peer.store.contains(&mesh));

    // and so does announcing a new one
    let late = a
        .store
        .insert_raw_scoped(kv_at(&KeyPair::generate(0).unwrap(), now(), 3), Scope::MESH);
    a.node.propagate(vec![late]);
    assert!(eventually(Duration::from_secs(10), || mesh_peer
        .store
        .contains(&late)));
    std::thread::sleep(Duration::from_millis(300));
    assert!(!tcp_peer.store.contains(&late));

    // what arrives on a mesh link is mesh scope; a bridge also marks it for upload
    assert_eq!(mesh_peer.store.scope_of(&mesh).unwrap().0, Scope::MESH);
    let hub2 = MemHub::new();
    let src = start(&hub2, phone());
    let bridge = start(
        &hub2,
        MeshConfig {
            bridge: true,
            ..phone()
        },
    );
    let id = src
        .store
        .insert_raw_scoped(kv_at(&KeyPair::generate(0).unwrap(), now(), 4), Scope::MESH);
    link(&hub2, &src, &bridge, LinkKind::Ble);
    assert!(eventually(Duration::from_secs(10), || bridge
        .store
        .contains(&id)));
    assert_eq!(
        bridge.store.scope_of(&id).unwrap().0,
        Scope::MESH | Scope::UPLOAD
    );
    assert_eq!(bridge.store.upload_pending(10), vec![id]);

    for n in [a, mesh_peer, tcp_peer, src, bridge] {
        n.node.stop();
    }
}

#[test]
fn wanted_seekers_travel_hops_and_wanted_blobs_go_first() {
    let hub = MemHub::new();
    let a = start(&hub, phone());
    let b = start(&hub, phone());
    let c = start(&hub, phone());
    link(&hub, &a, &b, LinkKind::Ble);
    link(&hub, &b, &c, LinkKind::Ble);

    // c's app waits for a seeker; a learns it through b
    let seeker_key = KeyPair::generate(0).unwrap();
    let env = kv_at(&seeker_key, now(), 7);
    let seeker: [u8; WANTED_SEEKER_LEN] = env.key.clone().try_into().unwrap();
    c.node
        .mesh()
        .wanted
        .set_own(&[seeker], c.node.mesh().clock.now());
    assert!(eventually(Duration::from_secs(10), || a
        .node
        .mesh()
        .wanted
        .contains(&seeker, UnixMillis::now())));
    assert!(b.node.mesh().wanted.contains(&seeker, UnixMillis::now()));

    // a bridge-like insert at a reaches c
    let id = a.store.insert_raw_scoped(env, Scope::MESH);
    a.node.propagate_wanted(vec![id]);
    assert!(eventually(Duration::from_secs(10), || c
        .store
        .contains(&id)));

    for n in [a, b, c] {
        n.node.stop();
    }
}

#[test]
fn mesh_links_accept_clock_drift_that_tcp_links_refuse() {
    let hub = MemHub::new();
    let src = start(&hub, phone());
    let over_mesh = start(&hub, phone());
    let over_tcp = start(&hub, phone());
    // three hours ahead: a phone whose clock drifted while offline
    let ahead = now() + 3 * 60 * 60 * 1000;
    let id: BlobId = src.store.insert_raw_scoped(
        kv_at(&KeyPair::generate(0).unwrap(), ahead, 1),
        Scope::MESH | Scope::INTERNET,
    );
    link(&hub, &src, &over_mesh, LinkKind::Ble);
    link(&hub, &src, &over_tcp, LinkKind::Tcp);
    assert!(eventually(Duration::from_secs(10), || over_mesh
        .store
        .contains(&id)));
    std::thread::sleep(Duration::from_millis(500));
    assert!(!over_tcp.store.contains(&id), "5-minute window on TCP");
    for n in [src, over_mesh, over_tcp] {
        n.node.stop();
    }
}

#[test]
fn guided_forwarding_takes_the_wanted_path_and_unwanted_blobs_go_to_the_bridge() {
    let hub = MemHub::new();
    // a star: x in the middle, a holds the blobs, c wants one, b wants nothing,
    // bridge advertises itself
    let x = start(&hub, phone());
    let a = start(&hub, phone());
    let b = start(&hub, phone());
    let c = start(&hub, phone());
    let bridge = start(&hub, phone());
    for n in [&a, &b, &c, &bridge] {
        link(&hub, &x, n, LinkKind::Ble);
    }
    let wanted_env = kv_at(&KeyPair::generate(0).unwrap(), now() - 60_000, 1);
    let unwanted_env = kv_at(&KeyPair::generate(0).unwrap(), now() - 60_000, 2);
    let seeker: [u8; WANTED_SEEKER_LEN] = wanted_env.key.clone().try_into().unwrap();
    c.node.mesh().wanted.set_own(&[seeker], UnixMillis::now());
    bridge.node.mesh().wanted.set_beacon(
        Some(
            gossip_wire::Beacon::sign(
                &KeyPair::generate(0).unwrap(),
                UnixMillis::now().as_millis(),
                600,
            )
            .unwrap(),
        ),
        UnixMillis::now(),
    );
    // wait until a heard both through x
    assert!(eventually(Duration::from_secs(10), || {
        let w = &a.node.mesh().wanted;
        w.best_peers(&seeker, UnixMillis::now()).is_some()
            && !w.bridge_peers(UnixMillis::now()).is_empty()
    }));

    let wanted = a.store.insert_raw_scoped(wanted_env, Scope::MESH);
    let unwanted = a.store.insert_raw_scoped(unwanted_env, Scope::MESH);
    a.node.propagate(vec![wanted, unwanted]);
    assert!(eventually(Duration::from_secs(10), || c
        .store
        .contains(&wanted)
        && bridge.store.contains(&unwanted)));
    std::thread::sleep(Duration::from_millis(500));
    assert!(!b.store.contains(&wanted), "b is off the wanted path");
    assert!(!b.store.contains(&unwanted), "b is not toward the bridge");
    assert!(!c.store.contains(&unwanted));
    assert!(!bridge.store.contains(&wanted));

    for n in [x, a, b, c, bridge] {
        n.node.stop();
    }
}

/// Two neighbours that already share most blobs and wanted entries, linked with or
/// without the compact link-up: the bytes the link carries until it settles, and
/// whether each lacking piece got through.
fn link_up_between_neighbours(compact: bool) -> u64 {
    let hub = MemHub::new();
    let a = start(&hub, phone());
    let b = start(&hub, phone());
    let t = UnixMillis::now();
    let elsewhere = PeerId::from_public_key(KeyPair::generate(0).unwrap().get_public_key());
    let entry = |seeker| gossip_wire::WantedEntry {
        seeker,
        lifetime_s: 3600,
        local: false,
    };
    // shared: 200 blobs, 300 wanted entries with the same hop budget
    for n in 0..200u32 {
        let env = kv_at(&KeyPair::generate(0).unwrap(), now(), n as u8);
        a.store.insert_raw_scoped(env.clone(), Scope::MESH);
        b.store.insert_raw_scoped(env, Scope::MESH);
    }
    let shared: Vec<_> = (0..300u32)
        .map(|n| {
            let mut s = [0x20; WANTED_SEEKER_LEN];
            s[1..5].copy_from_slice(&n.to_be_bytes());
            entry(s)
        })
        .collect();
    a.node.mesh().wanted.merge(&elsewhere, 0.0, 10, &shared, t);
    b.node.mesh().wanted.merge(&elsewhere, 0.0, 10, &shared, t);
    // only a: a blob, a wanted entry, and a better direction for a shared seeker
    let only_blob = a.store.insert_raw_scoped(
        kv_at(&KeyPair::generate(0).unwrap(), now(), 250),
        Scope::MESH,
    );
    let only_seeker = [0x21; WANTED_SEEKER_LEN];
    a.node
        .mesh()
        .wanted
        .merge(&elsewhere, 0.0, 10, &[entry(only_seeker)], t);
    let better = [0x22; WANTED_SEEKER_LEN];
    a.node
        .mesh()
        .wanted
        .merge(&elsewhere, 0.0, 21, &[entry(better)], t);
    b.node
        .mesh()
        .wanted
        .merge(&elsewhere, 0.0, 6, &[entry(better)], t);

    let before = hub.stats().bytes;
    hub.connect_with(
        &a.node.peer_id(),
        &b.node.peer_id(),
        LinkInfo {
            kind: LinkKind::Ble,
            max_message_size: usize::MAX,
            bandwidth_bps: 0,
            compact_link_up: compact.then_some([0; 32]),
        },
    );
    let bw = &b.node.mesh().wanted;
    assert!(eventually(Duration::from_secs(10), || {
        b.store.contains(&only_blob)
            && bw.contains(&only_seeker, UnixMillis::now())
            && bw
                .best_peers(&better, UnixMillis::now())
                .is_some_and(|v| v.first() == Some(&a.node.peer_id()))
    }));
    // let the wanted rounds and asks settle
    std::thread::sleep(Duration::from_millis(600));
    let bytes = hub.stats().bytes - before;
    for n in [a, b] {
        n.node.stop();
    }
    bytes
}

#[test]
fn compact_link_up_sends_only_what_the_peer_lacks() {
    let full = link_up_between_neighbours(false);
    let compact = link_up_between_neighbours(true);
    // full: about 2 × (200 × 32 + 302 × 38) bytes; compact: summaries and three deltas
    eprintln!("link-up bytes: full {full}, compact {compact}");
    assert!(full > 20_000, "full link-up took {full} bytes");
    assert!(compact * 5 < full, "compact {compact} bytes against {full}");
}

#[test]
fn a_liar_with_a_huge_hop_budget_does_not_blackhole_a_seeker() {
    let hub = MemHub::new();
    // a holds the blob, x relays, c wants it, the liar copies c's seeker with a budget of
    // 255 to become the best direction for it
    let x = start(&hub, phone());
    let a = start(&hub, phone());
    let c = start(&hub, phone());
    let liar = start(
        &hub,
        MeshConfig {
            own_hops_min: 255,
            own_hops_max: 255,
            ..phone()
        },
    );
    link(&hub, &a, &x, LinkKind::Ble);
    link(&hub, &x, &c, LinkKind::Ble);
    link(&hub, &x, &liar, LinkKind::Ble);
    let env = kv_at(&KeyPair::generate(0).unwrap(), now() - 60_000, 1);
    let seeker: [u8; WANTED_SEEKER_LEN] = env.key.clone().try_into().unwrap();
    c.node.mesh().wanted.set_own(&[seeker], UnixMillis::now());
    liar.node
        .mesh()
        .wanted
        .set_own(&[seeker], UnixMillis::now());
    assert!(eventually(Duration::from_secs(10), || x
        .node
        .mesh()
        .wanted
        .best_peers(&seeker, UnixMillis::now())
        .is_some_and(|v| v.len() == 2)));
    let id = a.store.insert_raw_scoped(env, Scope::MESH);
    a.node.propagate(vec![id]);
    assert!(eventually(Duration::from_secs(10), || c
        .store
        .contains(&id)));
    for n in [x, a, c, liar] {
        n.node.stop();
    }
}
