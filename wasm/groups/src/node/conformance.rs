//! Conformance checks for a [`NodeStorage`] backend, usable by any implementation (a
//! database backend, for instance) in its own tests.

use super::records::{Batch, Meta, NodeStorage};
use crate::ids::{ChatId, SyncObjId};
use crate::store::{Changes, ObjectRecord, StorageRead};

fn object(n: u8) -> ObjectRecord {
    ObjectRecord::empty(SyncObjId::from_bytes([n; 32]))
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
}
