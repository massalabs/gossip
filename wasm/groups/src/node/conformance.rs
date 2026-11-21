//! Conformance checks for a [`NodeStorage`] backend, usable by any implementation (a
//! database backend, for instance) in its own tests.

use super::records::{Batch, Meta, NodeStorage};
use crate::ids::{ChatId, SyncObjId};
use crate::store::{Changes, ObjectRecord, StorageRead};

fn object(n: u8) -> ObjectRecord {
    ObjectRecord::empty(SyncObjId::from_bytes([n; 32]), true)
}

fn changes(chat: ChatId, n: u8) -> Changes {
    let mut c = Changes::new(chat);
    let o = object(n);
    c.objects.insert(o.sync_obj_id, o);
    c
}

fn objects(store: &dyn StorageRead, chat: &ChatId) -> Result<usize, String> {
    store
        .objects(chat)
        .map(|v| v.len())
        .map_err(|e| e.to_string())
}

fn next_seq<S: NodeStorage>(store: &S) -> Result<u64, String> {
    Ok(store
        .load_node()
        .map_err(|e| e.to_string())?
        .meta
        .get(&())
        .map_or(0, |m| m.next_seq))
}

/// Checks that `store` applies a [`Batch`] with [`Batch::erase`] all or nothing, and in the
/// order the trait states (epoch changes, then erasure, then node records).
///
/// `arm_failure(store, true)` must make the next commit fail (and `false` undo it), as the
/// backend's own fault injection does; pass a function that does nothing to check only the
/// order. The store must start empty. Returns the first violation found.
///
/// # Errors
///
/// A description of the violation.
pub fn check_batch_with_erase<S: NodeStorage>(
    store: &mut S,
    arm_failure: &mut dyn FnMut(&mut S, bool),
) -> Result<(), String> {
    let (a, b, c) = (
        ChatId::from_bytes([0xa1; 32]),
        ChatId::from_bytes([0xb2; 32]),
        ChatId::from_bytes([0xc3; 32]),
    );
    let mut first = Batch {
        epochs: vec![changes(a, 1), changes(b, 1), changes(c, 1)],
        ..Batch::default()
    };
    first.node.meta.insert((), Some(Meta { next_seq: 1 }));
    store.commit_batch(first).map_err(|e| e.to_string())?;
    let second = || {
        let mut batch = Batch {
            epochs: vec![changes(a, 2), changes(c, 2)],
            ..Batch::default()
        };
        batch.erase.insert(b);
        batch.erase.insert(c);
        batch.node.meta.insert((), Some(Meta { next_seq: 2 }));
        batch
    };
    arm_failure(store, true);
    let failed = store.commit_batch(second());
    arm_failure(store, false);
    if failed.is_ok() {
        // The backend cannot inject a failure: only the order is checked below.
    } else if objects(store, &a)? != 1
        || objects(store, &b)? != 1
        || objects(store, &c)? != 1
        || next_seq(store)? != 1
    {
        return Err("a failed batch was partly applied".into());
    }
    if failed.is_err() {
        store.commit_batch(second()).map_err(|e| e.to_string())?;
    }
    if objects(store, &a)? != 2 {
        return Err("the epoch changes of the batch were not applied".into());
    }
    if objects(store, &b)? != 0 {
        return Err("an erased epoch kept records".into());
    }
    if objects(store, &c)? != 0 {
        return Err("an epoch written and erased by one batch kept records".into());
    }
    if next_seq(store)? != 2 {
        return Err("the node records of the batch were not applied".into());
    }
    Ok(())
}

/// Checks that `store` deletes the rows, parent edges and objects a [`Changes`] lists in
/// `removed_rows`, `removed_edges` and `removed_objects` (what the message timer erases,
/// §7.7), and only those, with the indexes the engine reads: none of them is held, a
/// carrier, pending, or a reaction any more. The store must start empty. Returns the first
/// violation found.
///
/// # Errors
///
/// A description of the violation.
pub fn check_removals<S: NodeStorage>(store: &mut S) -> Result<(), String> {
    use crate::event::{Body, Content, Reaction, ReactionAction};
    use crate::ids::EventId;
    use crate::store::{EventRow, RowState, StoredResult};
    let chat = ChatId::from_bytes([0xd4; 32]);
    let id = |n: u8| EventId::new(u64::from(n), [n; 16]);
    let target = SyncObjId::from_bytes([1; 32]);
    let mut first = Changes::new(chat);
    for n in 1..=3 {
        first.rows.insert(
            id(n),
            EventRow {
                event_id: id(n),
                state: RowState::Pruned,
            },
        );
        first.edges.insert(id(n), vec![id(n - 1)]);
    }
    let mut message = object(1);
    message.expires_at = Some(10);
    let mut reaction = object(2);
    reaction.current = Some(StoredResult::Content(Content {
        sync_obj_id: reaction.sync_obj_id,
        author: crate::ids::GossipId::from_bytes([3; 32]),
        created_at: 5,
        last_modified_at: 5,
        body: Body::Reaction(Reaction {
            target,
            emoji: "+".into(),
            action: ReactionAction::Add,
        }),
        edited: false,
        metadata: Default::default(),
    }));
    reaction.expires_at = Some(10);
    for o in [message, reaction, object(3)] {
        first.objects.insert(o.sync_obj_id, o);
    }
    store
        .commit_batch(Batch {
            epochs: vec![first],
            ..Batch::default()
        })
        .map_err(|e| e.to_string())?;
    let e = |e: crate::store::StorageError| e.to_string();
    if store.reactions_to(&chat, &target).map_err(e)?.len() != 1
        || store.pending_until(&chat, u64::MAX).map_err(e)?.len() != 2
    {
        return Err("the indexes do not see the records written".into());
    }
    let mut second = Changes::new(chat);
    second.removed_rows.extend([id(1), id(2)]);
    second.removed_edges.extend([id(1), id(2)]);
    second.removed_objects.extend([
        SyncObjId::from_bytes([1; 32]),
        SyncObjId::from_bytes([2; 32]),
    ]);
    store
        .commit_batch(Batch {
            epochs: vec![second],
            ..Batch::default()
        })
        .map_err(|e| e.to_string())?;
    let rows: Vec<EventId> = store
        .event_rows(&chat)
        .map_err(e)?
        .into_iter()
        .map(|r| r.event_id)
        .collect();
    if rows != [id(3)] {
        return Err(format!("rows left: {rows:?}"));
    }
    let edges: Vec<EventId> = store
        .edges(&chat)
        .map_err(e)?
        .into_iter()
        .map(|x| x.0)
        .collect();
    if edges != [id(3)] || store.parents(&chat, &id(1)).map_err(e)?.is_some() {
        return Err(format!("edges left: {edges:?}"));
    }
    if store.objects(&chat).map_err(e)? != [object(3)] {
        return Err("objects left other than the one kept".into());
    }
    if !store.reactions_to(&chat, &target).map_err(e)?.is_empty()
        || !store.pending_until(&chat, u64::MAX).map_err(e)?.is_empty()
        || store.first_pending(&chat).map_err(e)?.is_some()
    {
        return Err("an index still names an erased object".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::MemoryStorage;
    use crate::test_support::Instrumented;

    #[test]
    fn the_memory_store_applies_a_batch_with_erase_all_or_nothing() {
        let mut store = Instrumented::new(MemoryStorage::new());
        check_batch_with_erase(&mut store, &mut |s, on| s.fail_commits = on).unwrap();
        let mut plain = MemoryStorage::new();
        check_batch_with_erase(&mut plain, &mut |_, _| {}).unwrap();
    }

    #[test]
    fn the_memory_store_deletes_what_the_timer_erases() {
        check_removals(&mut MemoryStorage::new()).unwrap();
    }
}
