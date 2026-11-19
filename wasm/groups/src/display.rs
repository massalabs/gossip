//! The display rules of §7.5 that are data: which messages are visible at `now`, their
//! order, the time they show, and the stored time `T` of a root's line. No UI.

use crate::error::{Error, Result};
use crate::event::{Content, Payload};
use crate::ids::{ChatId, SyncObjId};
use crate::store::{StorageError, StorageRead, StoredResult};

/// A message of the view.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VisibleMessage {
    /// Its epoch.
    pub chat_id: ChatId,
    /// The current result.
    pub content: Content,
    /// The result hash, the second ordering key (§6.2, §7.5). Computed, not stored.
    pub result_hash: [u8; 32],
}

impl VisibleMessage {
    /// Its sync object.
    #[must_use]
    pub fn sync_obj_id(&self) -> SyncObjId {
        self.content.sync_obj_id
    }

    /// The time shown: `last_modified_at` after "Edited at" when `edited`, otherwise
    /// `created_at` (§7.5).
    #[must_use]
    pub fn shown_time(&self) -> u64 {
        if self.content.edited {
            self.content.last_modified_at
        } else {
            self.content.created_at
        }
    }

    /// Whether "Edited at" is shown (a claim, not proof).
    #[must_use]
    pub fn shows_edited(&self) -> bool {
        self.content.edited
    }

    /// The ordering key: ascending `(created_at, resultHash)` (§7.5).
    #[must_use]
    pub fn order_key(&self) -> (u64, [u8; 32]) {
        (self.content.created_at, self.result_hash)
    }
}

/// Whether a current non-delete result is displayed at `now`:
/// `now ≥ max(last_modified_at, created_at)` (§7.5).
#[must_use]
pub fn is_visible(content: &Content, now: u64) -> bool {
    now >= content.last_modified_at.max(content.created_at)
}

/// The visible messages of the epochs `chat_ids` (all the epochs and side branches of a
/// group), in one chronological order (§7.5). Deleted messages, pending future content and
/// results whose dates are still in the future are hidden. Run
/// [`crate::Epoch::tick`] on each epoch first so that due versions are applied.
///
/// # Errors
///
/// A storage failure.
pub fn view<R: StorageRead + ?Sized>(
    store: &R,
    chat_ids: &[ChatId],
    now: u64,
) -> core::result::Result<Vec<VisibleMessage>, StorageError> {
    let mut out = Vec::new();
    for chat_id in chat_ids {
        for obj in store.objects(chat_id)? {
            if let Some(StoredResult::Content(c)) = obj.current
                && is_visible(&c, now)
            {
                let result_hash = Payload::Content(c.clone()).result_hash(chat_id);
                out.push(VisibleMessage {
                    chat_id: *chat_id,
                    content: c,
                    result_hash,
                });
            }
        }
    }
    out.sort_by(|a, b| {
        a.order_key()
            .cmp(&b.order_key())
            .then(a.chat_id.cmp(&b.chat_id))
            .then(a.sync_obj_id().cmp(&b.sync_obj_id()))
    });
    Ok(out)
}

/// `M` of §7.5: the greatest `created_at` among the visible messages held in the root's
/// parent epochs at `now`, or `None` when there is none.
///
/// # Errors
///
/// A storage failure.
pub fn greatest_visible_created_at<R: StorageRead + ?Sized>(
    store: &R,
    parent_chat_ids: &[ChatId],
    now: u64,
) -> core::result::Result<Option<u64>, StorageError> {
    Ok(view(store, parent_chat_ids, now)?
        .iter()
        .map(|m| m.content.created_at)
        .max())
}

/// The time `T` of a root's line, computed once at adoption and stored with the epoch
/// (§7.5, §14.1):
///
/// ```text
/// T = max(M + 1, min(root.created_at, t_adopt))      or, with no M,
/// T = min(root.created_at, t_adopt)
/// ```
///
/// # Errors
///
/// [`Error::Overflow`] if `M + 1` does not fit a u64.
pub fn root_line_time(root_created_at: u64, t_adopt: u64, m: Option<u64>) -> Result<u64> {
    let base = root_created_at.min(t_adopt);
    match m {
        None => Ok(base),
        Some(m) => Ok(m.checked_add(1).ok_or(Error::Overflow("M + 1"))?.max(base)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::epoch::tests::{Fixture, T0, del, text};
    use crate::root::tests::founding;

    #[test]
    fn visibility_needs_both_dates_reached() {
        let f = Fixture::new();
        let Payload::Content(mut c) = text(1, f.bob.id, T0, T0, "x") else {
            unreachable!()
        };
        assert!(is_visible(&c, T0));
        assert!(!is_visible(&c, T0 - 1));
        // A current result whose created_at is in the future stays hidden.
        c.created_at = T0 + 10;
        assert!(!is_visible(&c, T0 + 9));
        assert!(is_visible(&c, T0 + 10));
        c.created_at = T0;
        c.last_modified_at = T0 + 20;
        assert!(!is_visible(&c, T0 + 19));
    }

    #[test]
    fn the_view_orders_hides_and_merges_epochs() {
        let mut f = Fixture::new();
        let late = f.event(T0, 1, &[], text(1, f.bob.id, T0 + 5, T0 + 5, "late"));
        let early = f.event(T0, 2, &[], text(2, f.bob.id, T0 - 5, T0, "early"));
        let deleted = f.event(T0, 3, &[], del(3, None));
        let pending = f.event(T0, 4, &[], text(4, f.bob.id, T0, T0 + 100, "pending"));
        let mut edited = text(5, f.bob.id, T0 - 1, T0 + 1, "edited");
        if let Payload::Content(c) = &mut edited {
            c.edited = true;
        }
        let edited = f.event(T0, 5, &[], edited);
        // Future created_at, but applied: hidden.
        let future = f.event(T0, 6, &[], text(6, f.bob.id, T0 + 1_000, T0, "future"));
        for e in [&late, &early, &deleted, &pending, &edited, &future] {
            f.recv(e, T0 + 10);
        }
        let chat = f.root.chat_id();
        let v = view(&f.store, &[chat], T0 + 10).unwrap();
        let texts: Vec<_> = v
            .iter()
            .map(|m| match &m.content.body {
                crate::event::Body::Text(t) => t.as_str(),
                _ => "",
            })
            .collect();
        assert_eq!(texts, ["early", "edited", "late"]);
        assert_eq!(v[0].shown_time(), T0 - 5);
        assert!(v[1].shows_edited());
        assert_eq!(v[1].shown_time(), T0 + 1);
        assert_eq!(v[0].result_hash, early.result_hash());

        // A second epoch of the same group interleaves by created_at.
        let other = founding(&f.alice, &[&f.alice, &f.bob, &f.carol]);
        let o = crate::MessageEvent::create(
            &other,
            crate::EventId::new(T0, [7; 16]),
            &[],
            text(1, f.carol.id, T0 - 2, T0, "other"),
        )
        .unwrap();
        crate::Epoch::new(&other, true, crate::GroupState::Active)
            .receive(&mut f.store, crate::Sender::Local, o, T0 + 10)
            .unwrap();
        let v = view(&f.store, &[chat, other.chat_id()], T0 + 10).unwrap();
        assert_eq!(v.len(), 4);
        assert_eq!(v[1].chat_id, other.chat_id());
        assert_eq!(
            greatest_visible_created_at(&f.store, &[chat], T0 + 10).unwrap(),
            Some(T0 + 5)
        );
        assert_eq!(
            greatest_visible_created_at(&f.store, &[chat], T0 - 100).unwrap(),
            None
        );
    }

    #[test]
    fn a_scheduled_message_appears_when_due() {
        let mut f = Fixture::new();
        let s = T0 + 1_000;
        let e = f.event(T0, 1, &[], text(1, f.bob.id, s, s, "later"));
        f.recv(&e, T0);
        assert!(view(&f.store, &[f.root.chat_id()], T0).unwrap().is_empty());
        f.tick(s);
        assert_eq!(view(&f.store, &[f.root.chat_id()], s).unwrap().len(), 1);
    }

    /// Regression (review of c11b2163): a message whose scheduled deletion is due was still
    /// shown when the caller read the view without ticking first (§7.4 "before relevant
    /// message access").
    #[test]
    fn a_due_deletion_hides_the_message_without_a_tick() {
        let mut f = Fixture::new();
        let a = f.event(T0, 1, &[], text(1, f.bob.id, T0, T0, "a"));
        let ds = f.event(T0, 2, &[], del(1, Some(T0 + 1_000)));
        f.recv(&a, T0);
        f.recv(&ds, T0);
        let chat = f.root.chat_id();
        assert_eq!(view(&f.store, &[chat], T0 + 999).unwrap().len(), 1);
        assert!(view(&f.store, &[chat], T0 + 1_000).unwrap().is_empty());
    }

    #[test]
    fn equal_creation_times_order_by_result_hash() {
        let mut f = Fixture::new();
        let a = f.event(T0, 1, &[], text(1, f.bob.id, T0, T0, "a"));
        let b = f.event(T0, 2, &[], text(2, f.bob.id, T0, T0, "b"));
        f.recv(&a, T0);
        f.recv(&b, T0);
        let v = view(&f.store, &[f.root.chat_id()], T0).unwrap();
        assert!(v[0].result_hash < v[1].result_hash);
    }

    #[test]
    fn root_line_time_formula() {
        // No visible message in the parents: min(created_at, t_adopt).
        assert_eq!(root_line_time(100, 200, None), Ok(100));
        assert_eq!(root_line_time(300, 200, None), Ok(200));
        // The line never sits above a message already shown.
        assert_eq!(root_line_time(100, 200, Some(150)), Ok(151));
        assert_eq!(root_line_time(100, 200, Some(50)), Ok(100));
        // A fast owner clock cannot push the line into the future.
        assert_eq!(root_line_time(u64::MAX, 200, Some(10)), Ok(200));
        assert_eq!(
            root_line_time(1, 1, Some(u64::MAX)),
            Err(Error::Overflow("M + 1"))
        );
    }
}
