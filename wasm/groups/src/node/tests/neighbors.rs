//! §10.1: neighbor selection, requests, responses, suggestions and replacement.

use super::dissemination::neighbors_of;
use super::*;
use crate::node::neighbors::NEIGHBOR_COOLDOWN_MS;
use crate::wire::NeighborResponse;

fn neighbor_requests(frames: &BTreeMap<GossipId, Vec<Frame>>) -> BTreeSet<GossipId> {
    frames
        .iter()
        .filter(|(_, fs)| fs.iter().any(|f| matches!(f, Frame::NeighborRequest(_))))
        .map(|(to, _)| *to)
        .collect()
}

fn neighbor_response(frames: &[Frame]) -> Option<NeighborResponse> {
    frames.iter().find_map(|f| match f {
        Frame::NeighborResponse(r) => Some(r.clone()),
        _ => None,
    })
}

#[test]
fn a_group_seeks_ten_neighbors_or_every_other_member() {
    let mut net = Net::new(13, 1);
    net.tick(0);
    let asked = neighbor_requests(&net.poll_frames(0));
    assert_eq!(asked.len(), 10);
    assert!(!asked.contains(&member(0)));

    let mut net = Net::new(4, 1);
    net.tick(0);
    assert_eq!(neighbor_requests(&net.poll_frames(0)).len(), 3);
    // Pending requests count: no new request on the next tick.
    net.tick(0);
    assert!(neighbor_requests(&net.poll_frames(0)).is_empty());
}

#[test]
fn a_request_is_accepted_while_there_is_capacity() {
    let mut net = Net::new(4, 1);
    let chat = net.chat();
    net.recv_frames(
        0,
        member(1),
        &[Frame::NeighborRequest(NeighborRequest { chat_id: chat })],
    );
    let r = neighbor_response(&net.poll_frames(0)[&member(1)]).unwrap();
    assert!(r.accepted && r.suggestions.is_empty());
    assert!(net.devs[0].node.is_neighbor(&chat, &member(1)));
}

#[test]
fn a_full_group_declines_with_five_non_neighbors_then_neighbors() {
    let mut net = Net::new(16, 1);
    let chat = net.chat();
    neighbors_of(&mut net, 0, &(1..=10).collect::<Vec<_>>());
    net.recv_frames(
        0,
        member(11),
        &[Frame::NeighborRequest(NeighborRequest { chat_id: chat })],
    );
    let r = neighbor_response(&net.poll_frames(0)[&member(11)]).unwrap();
    assert!(!r.accepted);
    assert_eq!(r.suggestions.len(), 10);
    let set: BTreeSet<GossipId> = r.suggestions.iter().copied().collect();
    assert_eq!(set.len(), 10, "distinct");
    assert!(!set.contains(&member(0)) && !set.contains(&member(11)));
    // Non-neighbors 12..=15 come first (four of them), then six neighbors.
    let first: BTreeSet<GossipId> = r.suggestions[..4].iter().copied().collect();
    assert_eq!(first, (12..=15).map(member).collect());
    assert!(
        r.suggestions[4..]
            .iter()
            .all(|s| net.devs[0].node.is_neighbor(&chat, s))
    );
}

#[test]
fn suggestions_take_at_most_five_non_neighbors() {
    let mut net = Net::new(20, 1);
    let chat = net.chat();
    neighbors_of(&mut net, 0, &(1..=10).collect::<Vec<_>>());
    net.recv_frames(
        0,
        member(11),
        &[Frame::NeighborRequest(NeighborRequest { chat_id: chat })],
    );
    let r = neighbor_response(&net.poll_frames(0)[&member(11)]).unwrap();
    let non: usize = r
        .suggestions
        .iter()
        .filter(|s| !net.devs[0].node.is_neighbor(&chat, s))
        .count();
    assert_eq!(non, 5);
    assert_eq!(r.suggestions.len(), 10);
}

#[test]
fn score_weighted_draws_favour_higher_scores_and_cover_every_peer() {
    let mut net = Net::new(4, 1);
    let node = &mut net.devs[0].node;
    for _ in 0..30 {
        node.reward(&member(1));
    }
    let mut first = BTreeMap::new();
    for _ in 0..400 {
        let d = node.draw_by_score(&mut net.rng, vec![member(1), member(2), member(3)], 3);
        assert_eq!(d.iter().collect::<BTreeSet<_>>().len(), 3);
        *first.entry(d[0]).or_insert(0u32) += 1;
    }
    assert!(first[&member(1)] > first[&member(2)] && first[&member(1)] > first[&member(3)]);
    assert!(first[&member(2)] > 40);
}

#[test]
fn a_request_for_an_epoch_not_held_is_declined_without_suggestions() {
    let mut net = Net::new(4, 1);
    net.recv_frames(
        0,
        member(1),
        &[Frame::NeighborRequest(NeighborRequest {
            chat_id: ChatId::from_bytes([9; 32]),
        })],
    );
    let r = neighbor_response(&net.poll_frames(0)[&member(1)]).unwrap();
    assert!(!r.accepted && r.suggestions.is_empty());
}

#[test]
fn a_request_from_a_non_member_is_dropped_silently() {
    let mut net = Net::new(4, 1);
    let chat = net.chat();
    let outsider = GossipId::from_bytes([0x77; 32]);
    net.recv_frames(
        0,
        outsider,
        &[Frame::NeighborRequest(NeighborRequest { chat_id: chat })],
    );
    assert!(net.poll(0).is_empty());
    // Even for an epoch it does not hold.
    net.recv_frames(
        0,
        outsider,
        &[Frame::NeighborRequest(NeighborRequest {
            chat_id: ChatId::from_bytes([9; 32]),
        })],
    );
    assert!(net.poll(0).is_empty());
}

#[test]
fn only_an_answer_to_our_request_counts() {
    let mut net = Net::new(3, 1);
    let chat = net.chat();
    let accept = Frame::NeighborResponse(NeighborResponse {
        chat_id: chat,
        accepted: true,
        suggestions: vec![],
    });
    net.recv_frames(0, member(1), std::slice::from_ref(&accept));
    assert!(!net.devs[0].node.is_neighbor(&chat, &member(1)));
    net.tick(0);
    net.poll(0);
    net.recv_frames(0, member(1), &[accept]);
    assert!(net.devs[0].node.is_neighbor(&chat, &member(1)));
}

#[test]
fn a_decline_puts_the_peer_on_cooldown_and_its_suggestions_first() {
    let mut net = Net::new(13, 1);
    let chat = net.chat();
    net.tick(0);
    let asked = neighbor_requests(&net.poll_frames(0));
    let not_asked: Vec<GossipId> = (1..13).map(member).filter(|m| !asked.contains(m)).collect();
    assert_eq!(not_asked.len(), 2);
    let decliner = *asked.iter().next().unwrap();
    net.recv_frames(
        0,
        decliner,
        &[Frame::NeighborResponse(NeighborResponse {
            chat_id: chat,
            accepted: false,
            suggestions: vec![not_asked[1]],
        })],
    );
    net.tick(0);
    let again = neighbor_requests(&net.poll_frames(0));
    assert_eq!(again, BTreeSet::from([not_asked[1]]));
    // The decliner is not asked again for a day.
    let g = net.devs[0].node.t.groups.get(&chat).unwrap().clone();
    assert_eq!(g.cooldown[&decliner], T0 + NEIGHBOR_COOLDOWN_MS);
}

#[test]
fn an_unanswered_request_is_abandoned_after_a_day() {
    let mut net = Net::new(3, 1);
    let chat = net.chat();
    net.tick(0);
    net.poll(0);
    net.now = T0 + NEIGHBOR_COOLDOWN_MS;
    net.tick(0);
    let g = net.devs[0].node.t.groups.get(&chat).unwrap().clone();
    assert!(g.asked.is_empty());
    assert_eq!(g.cooldown.len(), 2);
}

#[test]
fn a_neighbor_that_keeps_failing_is_replaced_and_an_answer_resets_the_count() {
    let mut net = Net::new(4, 1);
    let chat = net.chat();
    neighbors_of(&mut net, 0, &[1, 2]);
    let node = &mut net.devs[0].node;
    // Timeouts spread over less than two days are delays.
    for i in 0..10 {
        node.note_timeout(&member(1), T0 + i * HOUR);
    }
    assert!(node.is_neighbor(&chat, &member(1)));
    // An answer resets the count; then three queries left unanswered for two days in all
    // replace it.
    node.answered(&member(1));
    node.note_query_timeout(&member(1), T0, T0 + DAY);
    node.note_query_timeout(&member(1), T0 + DAY, T0 + 2 * DAY);
    assert!(node.is_neighbor(&chat, &member(1)));
    node.note_query_timeout(&member(1), T0 + 2 * DAY, T0 + 3 * DAY);
    assert!(!node.is_neighbor(&chat, &member(1)));
    assert_eq!(node.stats.neighbors_replaced, 1);
    // A replacement is sought, not the replaced peer.
    net.now = T0 + 3 * DAY;
    net.tick(0);
    let asked = neighbor_requests(&net.poll_frames(0));
    assert_eq!(asked, BTreeSet::from([member(3)]));
}

#[test]
fn a_timed_out_query_counts_as_a_failure_of_its_peer() {
    let mut net = Net::new(3, 1);
    let chat = net.chat();
    net.recv_frames(0, member(1), &[notice(chat, &[EventId::new(T0, [5; 16])])]);
    net.poll(0);
    net.now += 2 * MIN;
    net.tick(0);
    assert_eq!(
        net.devs[0].node.t.peers.get(&member(1)).unwrap().failures,
        1
    );
}

#[test]
fn a_removed_peer_is_never_a_neighbor() {
    let mut net = Net::new(4, 1);
    let chat = net.chat();
    let mut cfg = config(&net.root);
    cfg.removed = BTreeSet::from([member(2)]);
    let dev = &mut net.devs[0];
    dev.node
        .install_epoch(&mut dev.store, cfg, false, T0, &mut net.rng)
        .unwrap();
    net.tick(0);
    let asked = neighbor_requests(&net.poll_frames(0));
    assert_eq!(asked, BTreeSet::from([member(1), member(3)]));
    net.recv_frames(
        0,
        member(2),
        &[Frame::NeighborRequest(NeighborRequest { chat_id: chat })],
    );
    let r = neighbor_response(&net.poll_frames(0)[&member(2)]).unwrap();
    assert!(!r.accepted && r.suggestions.is_empty());
}

#[test]
fn neighbors_prefer_existing_sessions() {
    let mut net = Net::new(13, 1);
    for i in [11, 12] {
        net.devs[0].node.set_session(member(i), true);
    }
    // Ask once with a target of 10 among 12: both peers with a session are always asked.
    for _ in 0..5 {
        let mut net2 = Net::new(13, 1);
        net2.rng = TestRng::new(net.rng.next_u64());
        for i in [11, 12] {
            net2.devs[0].node.set_session(member(i), true);
        }
        net2.tick(0);
        let asked = neighbor_requests(&net2.poll_frames(0));
        assert!(asked.contains(&member(11)) && asked.contains(&member(12)));
    }
}
