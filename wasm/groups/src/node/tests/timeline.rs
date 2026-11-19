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
