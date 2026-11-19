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

/// Found by the network simulation (code at `efe4edd8`, seed 2): a periodic lane whose
/// scan went to a member that never answers stayed pending for its 20 stages (about two
/// weeks), and every other lane waited behind it, so periodic recovery stopped.
#[test]
fn a_lane_pending_with_a_silent_member_does_not_stop_the_other_lanes() {
    use crate::wire::Page;
    let mut net = Net::new(4, 1);
    let chat = net.chat();
    super::dissemination::neighbors_of(&mut net, 0, &[1, 2]);
    // Member 3, the only non-neighbor, never answers: every random lane scans it.
    let mut neighbor_scans = Vec::new();
    for _ in 0..(4 * 24 * 6) {
        net.tick(0);
        for s in super::retrieval::sent_queries(&mut net, 0) {
            if let QueryOp::TipsScan {
                scan_id, offset, ..
            } = s.op
                && s.to != member(3)
            {
                if offset == 0 {
                    neighbor_scans.push(net.now);
                }
                let page = Page {
                    scan_id,
                    offset,
                    count: 0,
                    entries: vec![],
                    skipped: 0,
                };
                super::retrieval::answer(&mut net, 0, &s, ResponseResult::Page(page));
            }
        }
        net.now += 10 * MIN;
    }
    let late = neighbor_scans.iter().filter(|t| **t > T0 + 2 * DAY).count();
    assert!(
        late >= 2,
        "neighbor lanes after two days: {neighbor_scans:?}"
    );
    let _ = chat;
}
