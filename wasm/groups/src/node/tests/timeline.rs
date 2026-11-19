//! The lines of the timeline (§5.10, §7.5, D.9): who each line names as acting, whom it
//! names, and where it stands, seen by the owner, a continuing member, a member that joins
//! later, a removed member and a member added back.

use super::membership::{MNet, founded, gid};
use super::*;

/// The epoch-change lines of device `d` in group `g`.
fn changes(net: &MNet, d: usize, g: &ChatId) -> Vec<TimelineLine> {
    net.lines(d, g)
        .into_iter()
        .filter(|l| matches!(l, TimelineLine::EpochChange { .. }))
        .collect()
}

/// Issue "handover line names the new owner as actor": the change is made by the owner of
/// the parent, who signs the handover root (§4.7), and an outgoing owner that drops itself
/// from the member list left (§5.8 "Everyone knows you left and who you named").
#[test]
fn a_handover_line_names_its_signer_and_the_outgoing_owner_left() {
    let (mut net, g) = founded(3);
    let h = net
        .change(
            0,
            g,
            GroupChange::Handover {
                new_owner: gid(2),
                leave: true,
                remove: vec![],
                name: None,
            },
        )
        .unwrap();
    net.run(MIN);
    for d in 1..3 {
        let lines = changes(&net, d, &g);
        assert_eq!(
            lines,
            vec![TimelineLine::EpochChange {
                epoch: h,
                by: gid(0),
                added: vec![],
                removed: vec![],
                left: vec![gid(0)],
                renamed: None,
                new_owner: Some(gid(2)),
            }],
            "device {d}"
        );
    }
}

/// Issue "joiner timeline lines": the first epoch a device holds is a creation only on the
/// device that created it. A member cannot tell a founding root from a root whose parents
/// it does not hold (a parent commitment hides its epoch, §4.5), so whoever receives it
/// reads that the owner added it.
#[test]
fn only_the_creator_reads_that_the_group_was_created() {
    let mut net = MNet::new(4, true);
    let g = net.create(0, &[1, 2]);
    net.exchange();
    for d in 1..3 {
        net.accept_all(d);
    }
    net.run(MIN);
    let e2 = net
        .change(
            0,
            g,
            GroupChange::Successor {
                add: vec![gid(3)],
                remove: vec![],
                name: None,
            },
        )
        .unwrap();
    net.run(MIN);
    net.accept_all(3);
    net.run(MIN);
    assert_eq!(
        net.lines(0, &g)[0],
        TimelineLine::Founded {
            epoch: g,
            owner: gid(0)
        }
    );
    for d in 1..3 {
        assert_eq!(
            net.lines(d, &g)[0],
            TimelineLine::Joined {
                epoch: g,
                by: gid(0)
            },
            "device {d}"
        );
    }
    assert_eq!(
        net.lines(3, &e2),
        vec![TimelineLine::Joined {
            epoch: e2,
            by: gid(0)
        }]
    );
}

/// Issue "joiner timeline lines": at the junction of a member added back, "<owner> added
/// you back" follows "You were removed from this group" and "You were not a member
/// between…" (§5.10), in place of a line comparing the new root with the last epoch the
/// member held, which would ascribe to the owner every change made while it was away.
#[test]
fn a_member_added_back_reads_who_added_it_back() {
    let (mut net, g) = founded(3);
    net.change(
        0,
        g,
        GroupChange::Successor {
            add: vec![],
            remove: vec![gid(2)],
            name: None,
        },
    )
    .unwrap();
    net.run(MIN);
    let e3 = net
        .change(
            0,
            g,
            GroupChange::Successor {
                add: vec![gid(2)],
                remove: vec![gid(1)],
                name: None,
            },
        )
        .unwrap();
    net.run(MIN);
    assert_eq!(net.accept(2, e3), g);
    net.run(MIN);
    let lines = net.lines(2, &g);
    let tail: Vec<&TimelineLine> = lines.iter().skip(1).collect();
    assert!(
        matches!(
            tail[..],
            [
                TimelineLine::YouWereRemoved,
                TimelineLine::NotAMember { .. },
                TimelineLine::AddedBack { epoch, by },
            ] if *epoch == e3 && *by == gid(0)
        ),
        "{lines:?}"
    );
}

/// Review of the lines (§5.10, §7.5): a root that adds a member back names, beside the
/// current epoch, the last epoch that member was in (§5.10). A member that holds both reads
/// the change against the current epoch only: the member added back was added, and nobody
/// removed since that older epoch is removed again, nor the name changed back.
#[test]
fn a_continuing_member_reads_an_addition_back_against_the_current_epoch() {
    let (mut net, g) = founded(4);
    net.change(
        0,
        g,
        GroupChange::Successor {
            add: vec![],
            remove: vec![gid(2)],
            name: None,
        },
    )
    .unwrap();
    net.run(MIN);
    net.change(
        0,
        g,
        GroupChange::Successor {
            add: vec![],
            remove: vec![gid(3)],
            name: Some("x".into()),
        },
    )
    .unwrap();
    net.run(MIN);
    let z = net
        .change(
            0,
            g,
            GroupChange::Successor {
                add: vec![gid(2)],
                remove: vec![],
                name: None,
            },
        )
        .unwrap();
    assert_eq!(net.devs[0].node.root(&z).unwrap().parents().len(), 2);
    net.run(MIN);
    for d in 0..2 {
        let line = changes(&net, d, &g)
            .into_iter()
            .find(|l| matches!(l, TimelineLine::EpochChange { epoch, .. } if *epoch == z));
        assert_eq!(
            line,
            Some(TimelineLine::EpochChange {
                epoch: z,
                by: gid(0),
                added: vec![gid(2)],
                removed: vec![],
                left: vec![],
                renamed: None,
                new_owner: None,
            }),
            "device {d}"
        );
    }
}

/// Review of the lines (§4.7, §5.9): only a handover root changes the owner. A new owner's
/// resolution root that takes a former owner's branch as a parent names another owner than
/// that parent, and is no handover.
#[test]
fn a_resolution_over_a_former_owners_branch_does_not_change_the_owner() {
    let (mut net, g) = founded(4);
    let backup = net.devs[0].store.clone();
    let a = net
        .change(
            0,
            g,
            GroupChange::Successor {
                add: vec![],
                remove: vec![],
                name: Some("A".into()),
            },
        )
        .unwrap();
    net.exchange();
    net.devs[0].store = backup;
    net.restart(0);
    net.offline[1] = true;
    let h = net
        .change(
            0,
            g,
            GroupChange::Handover {
                new_owner: gid(1),
                leave: false,
                remove: vec![],
                name: None,
            },
        )
        .unwrap();
    net.offline[1] = false;
    for (from, to, pt) in core::mem::take(&mut net.dropped) {
        let now = net.now;
        let dev = &mut net.devs[to];
        dev.node
            .handle_plaintext(&mut dev.store, gid(from), &pt, now, &mut net.rng)
            .unwrap();
    }
    net.run(3 * MIN);
    let r = net
        .change(
            1,
            g,
            GroupChange::Resolve {
                members: vec![gid(0), gid(2), gid(3)],
                name: None,
            },
        )
        .unwrap();
    net.run(2 * MIN);
    for d in 0..4 {
        let line = changes(&net, d, &g)
            .into_iter()
            .find(|l| matches!(l, TimelineLine::EpochChange { epoch, .. } if *epoch == r));
        assert!(
            matches!(
                line,
                Some(TimelineLine::EpochChange {
                    by,
                    new_owner: None,
                    ..
                }) if by == gid(1)
            ),
            "device {d}: {line:?}"
        );
    }
    let _ = (a, h);
}

/// The lines of a junction (§5.10) after a member left: the history ends with "You left this
/// group" (D.2), not with "You were removed".
#[test]
fn a_member_added_back_after_its_leave_reads_that_it_left() {
    let (mut net, g) = founded(3);
    let backup = net.devs[2].store.clone();
    let now = net.now;
    let s = super::membership::signer(2);
    let dev = &mut net.devs[2];
    dev.node
        .leave_group(
            &mut dev.store,
            &s,
            g,
            LeaveChoice::Signed,
            now,
            &mut net.rng,
        )
        .unwrap();
    net.run(2 * MIN);
    // Restored from a backup, it learns its leave again (D.2) and is read-only.
    net.devs[2].store = backup;
    net.restart(2);
    net.say(2, &g, "I am back");
    net.run(2 * MIN);
    assert_eq!(net.summary(2, &g).unwrap().status, MyStatus::Left);
    let z = net
        .change(
            0,
            g,
            GroupChange::Successor {
                add: vec![gid(2)],
                remove: vec![],
                name: None,
            },
        )
        .unwrap();
    net.run(MIN);
    assert_eq!(net.accept(2, z), g);
    net.run(MIN);
    let lines = net.lines(2, &g);
    let at = lines
        .iter()
        .position(|l| matches!(l, TimelineLine::NotAMember { .. }))
        .expect("the junction");
    assert_eq!(lines[at - 1], TimelineLine::YouLeft, "{lines:?}");
    assert!(!lines.contains(&TimelineLine::YouWereRemoved), "{lines:?}");
}

/// The lines of a junction (§5.10) after "Dissolve & Keep archived" (§5.8): the history ends
/// with "This group was dissolved by its owner", not with "You were removed".
#[test]
fn a_member_back_after_a_dissolve_reads_that_it_was_dissolved() {
    let (mut net, g) = founded(3);
    let now = net.now;
    let s = super::membership::signer(0);
    let dev = &mut net.devs[0];
    dev.node
        .dissolve_group(&mut dev.store, &s, g, false, now, &mut net.rng)
        .unwrap();
    net.run(MIN);
    assert_eq!(
        net.summary(1, &g).unwrap().status,
        MyStatus::Dissolved { deleted: false }
    );
    // The owner continues the dissolved epoch with a root of its own.
    let params = crate::root::RootParams {
        name: "again".into(),
        members: (0..3).map(gid).collect(),
        group_secret: crate::ids::GroupSecret::from_bytes([3; 32]),
        owner: super::membership::ident(0).public.clone(),
        epoch_challenge: crate::ids::Challenge::from_bytes([4; 32]),
        ref_chat_id_challenge: crate::ids::Challenge::from_bytes([5; 32]),
        created_at: net.now,
    };
    let z = Root::create_successor(
        params,
        &[g],
        &super::membership::ident(0).secret.dsa_signing_key,
        [6; 32],
    )
    .unwrap();
    let blob = wire::encode_event_blob(&EventObject::Root(Box::new(z.clone()))).unwrap();
    net.recv_frames_m(1, 0, &[Frame::Event(blob)]);
    let inv = net.devs[1].node.invitations(net.now);
    assert_eq!(inv.len(), 1, "{inv:?}");
    assert_eq!(net.accept(1, z.chat_id()), g);
    net.run(MIN);
    let lines = net.lines(1, &g);
    let at = lines
        .iter()
        .position(|l| matches!(l, TimelineLine::NotAMember { .. }))
        .expect("the junction");
    assert_eq!(lines[at - 1], TimelineLine::Dissolved, "{lines:?}");
    assert!(!lines.contains(&TimelineLine::YouWereRemoved), "{lines:?}");
}
