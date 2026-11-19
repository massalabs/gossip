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
