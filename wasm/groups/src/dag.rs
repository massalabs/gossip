//! Tips, the cycle frontier and parent selection (§6.1, §12.1).
//!
//! A **tip** is an available event that no known accepted event references as a parent.
//! Every processed event (retained or pruned) keeps its parent links, so pruning never turns a
//! referenced event back into a tip.
//!
//! Ancestry may contain cycles (an adversary can name events in both directions). Strongly
//! connected components are collapsed: a component of two or more events that no processed
//! event outside it references exposes its available members as **frontier** entries, listed
//! with the tips.

use std::collections::{BTreeMap, BTreeSet};

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
    let rows = store.event_rows(chat_id)?;
    let edges: BTreeMap<EventId, Vec<EventId>> = store.edges(chat_id)?.into_iter().collect();
    let processed: BTreeSet<EventId> = rows
        .iter()
        .filter(|r| r.processed())
        .map(|r| r.event_id)
        .collect();
    let referenced: BTreeSet<EventId> = edges
        .iter()
        .filter(|(child, _)| processed.contains(child))
        .flat_map(|(_, parents)| parents.iter().copied())
        .collect();
    let available: BTreeSet<EventId> = rows
        .iter()
        .filter(|r| r.available(now))
        .map(|r| r.event_id)
        .collect();

    let mut out: BTreeSet<EventId> = available.difference(&referenced).copied().collect();
    for component in cycle_components(&processed, &edges) {
        let members: BTreeSet<EventId> = component.iter().copied().collect();
        let referenced_from_outside = edges.iter().any(|(child, parents)| {
            processed.contains(child)
                && !members.contains(child)
                && parents.iter().any(|p| members.contains(p))
        });
        if !referenced_from_outside {
            out.extend(members.intersection(&available).copied());
        }
    }
    Ok(out.into_iter().collect())
}

/// The strongly connected components of two or more processed events, over the edges
/// child → parent between processed events (iterative Tarjan).
fn cycle_components(
    processed: &BTreeSet<EventId>,
    edges: &BTreeMap<EventId, Vec<EventId>>,
) -> Vec<Vec<EventId>> {
    let nodes: Vec<EventId> = processed.iter().copied().collect();
    let index_of: BTreeMap<EventId, usize> =
        nodes.iter().enumerate().map(|(i, id)| (*id, i)).collect();
    let succ: Vec<Vec<usize>> = nodes
        .iter()
        .map(|id| {
            edges
                .get(id)
                .map(|ps| ps.iter().filter_map(|p| index_of.get(p).copied()).collect())
                .unwrap_or_default()
        })
        .collect();

    const UNSEEN: usize = usize::MAX;
    let n = nodes.len();
    let mut index = vec![UNSEEN; n];
    let mut low = vec![0usize; n];
    let mut on_stack = vec![false; n];
    let mut stack: Vec<usize> = Vec::new();
    let mut next = 0usize;
    let mut out = Vec::new();

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
                    let mut component = Vec::new();
                    loop {
                        let w = stack.pop().expect("v is on the stack");
                        on_stack[w] = false;
                        component.push(nodes[w]);
                        if w == v {
                            break;
                        }
                    }
                    if component.len() > 1 {
                        component.sort_unstable();
                        out.push(component);
                    }
                }
            }
        }
    }
    out
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

    fn graph(pairs: &[(u8, &[u8])]) -> (BTreeSet<EventId>, BTreeMap<EventId, Vec<EventId>>) {
        let mut processed = BTreeSet::new();
        let mut edges = BTreeMap::new();
        for (c, ps) in pairs {
            processed.insert(id(*c));
            let mut v: Vec<EventId> = ps.iter().map(|p| id(*p)).collect();
            v.sort_unstable();
            edges.insert(id(*c), v);
        }
        (processed, edges)
    }

    #[test]
    fn components_of_a_dag_are_trivial() {
        let (p, e) = graph(&[(1, &[]), (2, &[1]), (3, &[1, 2])]);
        assert!(cycle_components(&p, &e).is_empty());
    }

    #[test]
    fn cycles_are_found() {
        // 1 <-> 2, 3 -> 4 -> 5 -> 3, 6 -> 1.
        let (p, e) = graph(&[
            (1, &[2]),
            (2, &[1]),
            (3, &[4]),
            (4, &[5]),
            (5, &[3]),
            (6, &[1]),
        ]);
        let mut c = cycle_components(&p, &e);
        c.sort();
        assert_eq!(c, vec![vec![id(1), id(2)], vec![id(3), id(4), id(5)]]);
    }

    #[test]
    fn edges_to_unprocessed_parents_are_ignored() {
        let (mut p, e) = graph(&[(1, &[2]), (2, &[1])]);
        p.remove(&id(2));
        assert!(cycle_components(&p, &e).is_empty());
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
