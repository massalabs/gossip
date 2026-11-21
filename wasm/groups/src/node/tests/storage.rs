//! §14.1, §15.2: the node records, one commit per operation, failures and restarts.

use super::dissemination::neighbors_of;
use super::retrieval::sent_lookups;
use super::*;
use crate::test_support::Instrumented;

#[test]
fn every_operation_commits_once_with_the_epoch_and_node_records_together() {
    let mut net = Net::new(4, 1);
    let chat = net.chat();
    neighbors_of(&mut net, 0, &[1, 2]);
    let before = net.devs[0].store.commits();
    // A plaintext with an event and a notice: one transaction for both.
    let e = net.event(T0, 5, &[], 1);
    let f = vec![
        Frame::Event(blob(&e)),
        notice(chat, &[EventId::new(T0, [6; 16])]),
    ];
    net.recv_frames(0, member(1), &f);
    assert_eq!(net.devs[0].store.commits(), before + 1);
    assert!(net.held(0, &e.event_id()));
    assert_eq!(net.devs[0].store.load_node().unwrap().tasks.len(), 1);
    // A publication: the event, its dissemination work.
    let before = net.devs[0].store.commits();
    net.publish(0, "hi");
    assert_eq!(net.devs[0].store.commits(), before + 1);
}

#[test]
fn a_failed_commit_changes_nothing_and_the_engine_reloads() {
    let root = epoch_root(4, 0x10);
    let chat = root.chat_id();
    let mut store = Instrumented::new(MemoryStorage::new());
    let mut rng = TestRng::new(3);
    let mut node = Node::open(&store, member(0)).unwrap();
    node.install_epoch(&mut store, config(&root), false, T0, &mut rng)
        .unwrap();
    let before = store.inner.clone();
    store.fail_commits = true;
    let f = wire::encode_plaintext(&[notice(chat, &[EventId::new(T0, [6; 16])])]).unwrap();
    assert!(
        node.handle_plaintext(&mut store, member(1), &f, T0, &mut rng)
            .is_err()
    );
    assert!(store.inner == before);
    assert_eq!(node.t.tasks.len(), 0, "the in-memory copy was reloaded");
    assert!(
        node.publish_message(
            &mut store,
            chat,
            Body::Text("x".into()),
            BTreeMap::new(),
            None,
            T0,
            &mut rng
        )
        .is_err()
    );
    assert_eq!(node.queued(), 0);
    store.fail_commits = false;
    node.handle_plaintext(&mut store, member(1), &f, T0, &mut rng)
        .unwrap();
    assert_eq!(node.t.tasks.len(), 1);
}

#[test]
fn a_restarted_engine_continues_from_storage() {
    let mut net = Net::new(4, 1);
    let chat = net.chat();
    neighbors_of(&mut net, 0, &[1, 2]);
    let id = EventId::new(T0, [5; 16]);
    net.recv_frames(0, member(3), &[notice(chat, &[id])]);
    let q = sent_lookups(&mut net, 0);
    assert_eq!(q.len(), 1);
    let e = net.event(T0, 7, &[], 1);
    net.give(0, 1, &e);
    net.poll(0);
    // Drop the engine and rebuild it from storage.
    let now = net.now;
    let dev = &mut net.devs[0];
    let old = core::mem::replace(&mut dev.node, Node::open(&dev.store, member(0)).unwrap());
    dev.node
        .install_epoch(&mut dev.store, config(&net.root), false, now, &mut net.rng)
        .unwrap();
    assert_eq!(dev.node.neighbors(&chat), old.neighbors(&chat));
    assert_eq!(dev.node.t.tasks.len(), 1);
    assert_eq!(dev.node.t.requests.len(), 1);
    assert_eq!(dev.node.t.hints.len(), old.t.hints.len());
    assert_eq!(dev.node.hint_lru, old.hint_lru);
    // The correlation reference survived: the answer is used.
    let ev = net.event(T0, 5, &[], 1);
    let ev = MessageEvent::create(&net.root, id, &[], ev.payload().clone()).unwrap();
    super::retrieval::answer(&mut net, 0, &q[0], ResponseResult::Event(blob(&ev)));
    assert!(net.held(0, &id));
}
