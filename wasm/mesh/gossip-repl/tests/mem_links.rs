//! The replication engine over in-memory links: a pair, and a chain where the middle
//! node relays.

use std::sync::Arc;
use std::time::{Duration, Instant};

use gossip_repl::mem::{MemHub, MemNode, MemNodeParts};
use gossip_repl::MeshParts;
use gossip_repl::{BlobStore, FixedTrust, MemBlobStore, MemStoreConfig, PropagationConfig};
use gossip_trust::{TrustPolicy, TrustRegistry};
use gossip_wire::{build_kv_entry, BlobEnvelope, BlobId, BlobKind, KeyPair, PeerId, UnixMillis};

struct Node {
    node: MemNode,
    store: Arc<MemBlobStore>,
}

fn fast_config() -> PropagationConfig {
    PropagationConfig {
        announcement_interval_ms: 50,
        batch_proc_period_ms: 50,
        ..PropagationConfig::default()
    }
}

fn start(hub: &Arc<MemHub>) -> Node {
    let keypair = KeyPair::generate(0).unwrap();
    let store = Arc::new(MemBlobStore::new(MemStoreConfig::default()));
    let node = MemNode::start(
        hub.clone(),
        MemNodeParts {
            peer_id: PeerId::from_public_key(keypair.get_public_key()),
            store: store.clone(),
            config: fast_config(),
            trust: Arc::new(FixedTrust::new(0.5)),
            registry: Arc::new(TrustRegistry::new(TrustPolicy::default())),
            mesh: MeshParts::disabled(),
        },
    );
    Node { node, store }
}

fn kv_blob(n: u8) -> BlobEnvelope {
    let seeker_key = KeyPair::generate(0).unwrap();
    let (key, payload) = build_kv_entry(&seeker_key, &[n; 64]);
    BlobEnvelope::new(BlobKind::KeyValue, UnixMillis::now().0, key, payload)
}

fn insert_local(node: &Node, env: BlobEnvelope) -> BlobId {
    let id = node.store.insert_raw(env);
    node.node.propagate(vec![id]);
    id
}

fn wait_for(node: &Node, ids: &[BlobId], timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if ids.iter().all(|id| node.store.contains(id)) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    false
}

#[test]
fn two_nodes_replicate_both_ways_and_catch_up_on_connect() {
    let hub = MemHub::new();
    let a = start(&hub);
    let b = start(&hub);

    // stored before the link exists: anti-entropy on connect must bring it over
    let early = insert_local(&a, kv_blob(1));
    hub.connect(&a.node.peer_id(), &b.node.peer_id());
    assert!(
        wait_for(&b, &[early], Duration::from_secs(10)),
        "sync on connect"
    );

    // stored while linked: announce then ask
    let from_a = insert_local(&a, kv_blob(2));
    let from_b = insert_local(&b, kv_blob(3));
    assert!(wait_for(&b, &[from_a], Duration::from_secs(10)));
    assert!(wait_for(&a, &[from_b], Duration::from_secs(10)));
    assert!(hub.stats().messages > 0);

    a.node.stop();
    b.node.stop();
}

#[test]
fn a_chain_relays_through_the_middle_node() {
    let hub = MemHub::new();
    let a = start(&hub);
    let b = start(&hub);
    let c = start(&hub);
    hub.connect(&a.node.peer_id(), &b.node.peer_id());
    hub.connect(&b.node.peer_id(), &c.node.peer_id());
    assert!(!hub.is_linked(&a.node.peer_id(), &c.node.peer_id()));

    let ids: Vec<BlobId> = (0..5).map(|n| insert_local(&a, kv_blob(n))).collect();
    assert!(wait_for(&c, &ids, Duration::from_secs(10)), "two hops");
    assert!(wait_for(&b, &ids, Duration::from_secs(1)));

    // c's blob goes back the other way
    let back = insert_local(&c, kv_blob(9));
    assert!(wait_for(&a, &[back], Duration::from_secs(10)));

    // a link down stops the flow; it comes back with the link
    hub.disconnect(&b.node.peer_id(), &c.node.peer_id());
    let late = insert_local(&a, kv_blob(10));
    assert!(wait_for(&b, &[late], Duration::from_secs(10)));
    assert!(!c.store.contains(&late));
    hub.connect(&b.node.peer_id(), &c.node.peer_id());
    assert!(
        wait_for(&c, &[late], Duration::from_secs(10)),
        "resync after relink"
    );

    a.node.stop();
    b.node.stop();
    c.node.stop();
}
