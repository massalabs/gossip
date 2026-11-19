//! Tips, the cycle frontier and parent selection (§6.1, §12.1).
//!
//! A **tip** is an available event that no **available** event references as a parent (D.27,
//! choice B; §12.1 says "accepted"). A pruned event answers "not available", so nobody can
//! learn its parent links: if a pruned child still hid its parents, an event that carries a
//! current result could become unreachable for discovery. Tips are therefore a function of
//! the available events and their parent links only.
//!
//! Ancestry may contain cycles (an adversary can name events in both directions). Strongly
//! connected components of the available events are collapsed: a component that no available
//! event outside it references exposes its members as tips (for a component of two or more
//! events, these are the **frontier** entries of §6.1). A single event is its own component,
//! so one rule covers both: the tips are the members of the source components of the
//! condensation of the available events.
//!
//! The work is linear in the available events and their parent links: one strongly connected
//! components pass, then one pass over the edges with a node-to-component map.

use std::collections::BTreeMap;

use crate::constants::MAX_EVENT_PARENTS;
use crate::ids::{ChatId, EventId};
use crate::rng::{Randomness, uniform_below};
use crate::store::{StorageError, StorageRead};

/// The tips of the epoch at `now`, with the cycle frontier, ascending (§6.1, §12.1).
///
/// These are exactly the eligible tips of §6.1: each is available, hence neither pruned nor
/// temporarily invalid.
///
/// # Errors
///
/// A storage failure.
pub fn tips<R: StorageRead + ?Sized>(
    store: &R,
    chat_id: &ChatId,
    now: u64,
) -> Result<Vec<EventId>, StorageError> {
    let nodes: Vec<EventId> = store
        .event_rows(chat_id)?
        .iter()
        .filter(|r| r.available(now))
        .map(|r| r.event_id)
        .collect();
    let edges: BTreeMap<EventId, Vec<EventId>> = store.edges(chat_id)?.into_iter().collect();
    Ok(source_members(&nodes, |id| {
        edges.get(id).cloned().unwrap_or_default()
    }))
}

/// The members of the source components of the graph on `nodes` (ascending), with the edges
/// child → parent given by `parents` restricted to `nodes`.
fn source_members(nodes: &[EventId], parents: impl Fn(&EventId) -> Vec<EventId>) -> Vec<EventId> {
    let index_of: BTreeMap<EventId, usize> =
        nodes.iter().enumerate().map(|(i, id)| (*id, i)).collect();
    let succ: Vec<Vec<usize>> = nodes
        .iter()
        .map(|id| {
            parents(id)
                .iter()
                .filter_map(|p| index_of.get(p).copied())
                .collect()
        })
        .collect();
    let component = components(&succ);
    let count = component.iter().max().map_or(0, |m| m + 1);
    let mut has_child_outside = vec![false; count];
    for (child, ps) in succ.iter().enumerate() {
        for &p in ps {
            if component[p] != component[child] {
                has_child_outside[component[p]] = true;
            }
        }
    }
    nodes
        .iter()
        .enumerate()
        .filter(|(i, _)| !has_child_outside[component[*i]])
        .map(|(_, id)| *id)
        .collect()
}

/// The strongly connected component of each node (iterative Tarjan), numbered from 0.
fn components(succ: &[Vec<usize>]) -> Vec<usize> {
    const UNSEEN: usize = usize::MAX;
    let n = succ.len();
    let mut index = vec![UNSEEN; n];
    let mut low = vec![0usize; n];
    let mut on_stack = vec![false; n];
    let mut component = vec![UNSEEN; n];
    let mut stack: Vec<usize> = Vec::new();
    let mut next = 0usize;
    let mut components = 0usize;

    for start in 0..n {
        if index[start] != UNSEEN {
            continue;
        }
        // Call stack of (node, next successor position).
        let mut call: Vec<(usize, usize)> = vec![(start, 0)];
        index[start] = next;
        low[start] = next;
        next += 1;
        stack.push(start);
        on_stack[start] = true;
        while let Some(&(v, pos)) = call.last() {
            if pos < succ[v].len() {
                let w = succ[v][pos];
                if let Some(top) = call.last_mut() {
                    top.1 += 1;
                }
                if index[w] == UNSEEN {
                    index[w] = next;
                    low[w] = next;
                    next += 1;
                    stack.push(w);
                    on_stack[w] = true;
                    call.push((w, 0));
                } else if on_stack[w] {
                    low[v] = low[v].min(index[w]);
                }
            } else {
                call.pop();
                if let Some(&(u, _)) = call.last() {
                    low[u] = low[u].min(low[v]);
                }
                if low[v] == index[v] {
                    loop {
                        let w = stack.pop().expect("v is on the stack");
                        on_stack[w] = false;
                        component[w] = components;
                        if w == v {
                            break;
                        }
                    }
                    components += 1;
                }
            }
        }
    }
    component
}

/// The parents of a new event (§6.1): every eligible tip when there are at most 16,
/// otherwise a uniform random sample of 16 distinct tips. Ascending.
pub fn choose_parents(tips: &[EventId], rng: &mut dyn Randomness) -> Vec<EventId> {
    let mut pool: Vec<EventId> = tips.to_vec();
    pool.sort_unstable();
    pool.dedup();
    if pool.len() > MAX_EVENT_PARENTS {
        // Partial Fisher-Yates: the first 16 positions become a uniform sample.
        for i in 0..MAX_EVENT_PARENTS {
            let j = i + uniform_below(rng, pool.len() - i);
            pool.swap(i, j);
        }
        pool.truncate(MAX_EVENT_PARENTS);
        pool.sort_unstable();
    }
    pool
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rng::TestRng;

    fn id(n: u8) -> EventId {
        EventId::new(1_000 + u64::from(n), [n; 16])
    }

    /// The source members of the graph of `pairs` (child, parents), restricted to `nodes`.
    fn sources(nodes: &[u8], pairs: &[(u8, &[u8])]) -> Vec<EventId> {
        let edges: BTreeMap<EventId, Vec<EventId>> = pairs
            .iter()
            .map(|(c, ps)| (id(*c), ps.iter().map(|p| id(*p)).collect()))
            .collect();
        let mut nodes: Vec<EventId> = nodes.iter().map(|n| id(*n)).collect();
        nodes.sort_unstable();
        source_members(&nodes, |i| edges.get(i).cloned().unwrap_or_default())
    }

    #[test]
    fn sources_of_a_dag_are_its_unreferenced_nodes() {
        let pairs: &[(u8, &[u8])] = &[(1, &[]), (2, &[1]), (3, &[1, 2]), (4, &[1])];
        assert_eq!(sources(&[1, 2, 3, 4], pairs), vec![id(3), id(4)]);
        // Edges from a node outside the set do not count: 1 is exposed again.
        assert_eq!(sources(&[1, 2], &[(2, &[]), (3, &[1])]), vec![id(1), id(2)]);
    }

    #[test]
    fn cycles_expose_their_members_only_when_no_outside_node_references_them() {
        // 1 <-> 2, 3 -> 4 -> 5 -> 3, 6 -> 1.
        let pairs: &[(u8, &[u8])] = &[
            (1, &[2]),
            (2, &[1]),
            (3, &[4]),
            (4, &[5]),
            (5, &[3]),
            (6, &[1]),
        ];
        assert_eq!(
            sources(&[1, 2, 3, 4, 5, 6], pairs),
            vec![id(3), id(4), id(5), id(6)]
        );
        // Without 6, the cycle 1 <-> 2 is a source component too.
        assert_eq!(
            sources(&[1, 2, 3, 4, 5], pairs),
            vec![id(1), id(2), id(3), id(4), id(5)]
        );
        // A cycle broken by a missing member is an ordinary chain: 4 -> 5 leaves 4.
        assert_eq!(sources(&[4, 5], pairs), vec![id(4)]);
    }

    #[test]
    fn parent_choice() {
        let mut rng = TestRng::new(1);
        let few: Vec<EventId> = (0..16).rev().map(id).collect();
        let chosen = choose_parents(&few, &mut rng);
        assert_eq!(chosen.len(), 16);
        assert!(chosen.windows(2).all(|w| w[0] < w[1]));

        let many: Vec<EventId> = (0..40).map(id).collect();
        let mut counts = BTreeMap::new();
        for _ in 0..400 {
            let chosen = choose_parents(&many, &mut rng);
            assert_eq!(chosen.len(), 16);
            assert!(chosen.windows(2).all(|w| w[0] < w[1]));
            assert!(chosen.iter().all(|c| many.contains(c)));
            for c in chosen {
                *counts.entry(c).or_insert(0u32) += 1;
            }
        }
        // Every tip is sampled; 400 * 16 / 40 = 160 on average.
        assert_eq!(counts.len(), 40);
        assert!(counts.values().all(|c| *c > 90 && *c < 240));
        assert!(choose_parents(&[], &mut rng).is_empty());
    }
}
