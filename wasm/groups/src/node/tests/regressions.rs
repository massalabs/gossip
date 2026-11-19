//! Regression tests of bugs found by the network simulation.

use super::*;
use crate::test_support::Instrumented;

/// Found by the network simulation (code at `6360f87a`, seed 0): a failed commit reloaded
/// the engine from storage and forgot the plaintexts in flight, so confirming one of them
/// afterwards failed with `UnknownHandle`, although the plaintext had been handed to the
/// transport.
#[test]
fn a_failed_commit_keeps_the_plaintexts_in_flight() {
    let root = epoch_root(3, 0x10);
    let chat = root.chat_id();
    let mut store = Instrumented::new(MemoryStorage::new());
    let mut rng = TestRng::new(3);
    let mut node = Node::open(&store, member(0)).unwrap();
    node.install_epoch(&mut store, config(&root), false, T0, &mut rng)
        .unwrap();
    node.publish_message(
        &mut store,
        chat,
        Body::Text("x".into()),
        BTreeMap::new(),
        None,
        T0,
        &mut rng,
    )
    .unwrap();
    let out = node.poll_outbox(&mut store, T0, &mut rng).unwrap();
    assert!(!out.is_empty());
    store.fail_commits = true;
    assert!(
        node.handed_off(&mut store, out[0].handle, T0, &mut rng)
            .is_err()
    );
    store.fail_commits = false;
    node.handed_off(&mut store, out[0].handle, T0, &mut rng)
        .unwrap();
}

/// Found by the network simulation (code at `4b327404`, seed 2): an operation other than
/// `tick` or a receipt served a scheduled deletion in its scheduled form after its due time,
/// because only those two applied what was due. §7.4: before relevant message access, the
/// device applies all due deletions.
#[test]
fn a_due_deletion_is_applied_before_it_is_served() {
    let mut net = Net::new(3, 1);
    let chat = net.chat();
    let m = net.event(T0, 5, &[], 1);
    net.give(0, 1, &m);
    let due = T0 + 10 * MIN;
    let d = MessageEvent::create(
        &net.root,
        EventId::new(T0, [6; 16]),
        &[],
        Payload::Delete {
            sync_obj_id: SyncObjId::from_bytes([5; 32]),
            scheduled_at: Some(due),
        },
    )
    .unwrap();
    net.give(0, 1, &d);
    net.poll(0);
    net.now = due + MIN;
    net.recv_frames(
        0,
        member(2),
        &[query(
            1,
            net.now,
            MIN,
            vec![QueryOp::Event {
                chat_id: chat,
                event_id: d.event_id(),
            }],
        )],
    );
    let r = responses(&net.poll_frames(0)[&member(2)]);
    let served = answer_event(&r[0]).unwrap();
    assert_eq!(
        served.payload(),
        &Payload::Delete {
            sync_obj_id: SyncObjId::from_bytes([5; 32]),
            scheduled_at: None,
        },
        "served in its scheduled form after its time"
    );
    crate::epoch::check_invariants(&net.devs[0].store, &chat, net.now).unwrap();
}
