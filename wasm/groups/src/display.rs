//! The display rules of §7.5 that are data: which messages are visible at `now`, their
//! order, the time they show, and the stored time `T` of a root's line. No UI.

use std::collections::BTreeMap;

use crate::error::{Error, Result};
use crate::event::{Body, Content, Media, MessageType, Payload, ReactionAction};
use crate::ids::{ChatId, GossipId, SyncObjId};
use crate::store::{ObjectRecord, StorageError, StorageRead, StoredResult};

/// A message of the view.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VisibleMessage {
    /// Its epoch.
    pub chat_id: ChatId,
    /// The current result.
    pub content: Content,
    /// The result hash, the second ordering key (§6.2, §7.5). Computed, not stored.
    pub result_hash: [u8; 32],
    /// Its reactions (§7.6): `(author, emoji)` of each visible reaction to it whose current
    /// version is an *add*, ascending. A reaction is never a message of its own.
    pub reactions: Vec<(GossipId, String)>,
    /// The length of the media data, for a media message or a forwarded one (§7.6).
    pub data_len: Option<u64>,
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
/// group), in one chronological order (§7.5), each with its reactions (§7.6). Deleted
/// messages, pending future content and results whose dates are still in the future are
/// hidden; a reaction is listed on its target, in the same epoch, while its current version
/// is an *add*, and not at all when its target is not shown.
///
/// The view is computed as if everything due at `now` had been applied, whether or not
/// [`crate::Epoch::tick`] ran: a message whose earliest pending deletion is due is hidden,
/// and a pending version that is due is merged with the current result by the rule of §7.1.
/// Nothing is written.
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
        let mut messages = Vec::new();
        let mut reactions: BTreeMap<SyncObjId, Vec<(GossipId, String)>> = BTreeMap::new();
        for obj in store.objects(chat_id)? {
            let Some(content) = effective(store, chat_id, &obj, now)? else {
                continue;
            };
            if !is_visible(&content, now) {
                continue;
            }
            match &content.body {
                Body::Reaction(r) => {
                    if r.action == ReactionAction::Add {
                        reactions
                            .entry(r.target)
                            .or_default()
                            .push((content.author, r.emoji.clone()));
                    }
                }
                _ => messages.push(visible(chat_id, content)),
            }
        }
        for mut m in messages {
            if let Some(mut r) = reactions.remove(&m.sync_obj_id()) {
                r.sort();
                m.reactions = r;
            }
            out.push(m);
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

/// The visible message `sync_obj_id` of the epoch `chat_id` at `now`, without its reactions:
/// `None` when it is a reaction, deleted, not held or not visible.
///
/// # Errors
///
/// A storage failure.
pub fn message<R: StorageRead + ?Sized>(
    store: &R,
    chat_id: &ChatId,
    sync_obj_id: &SyncObjId,
    now: u64,
) -> core::result::Result<Option<VisibleMessage>, StorageError> {
    let Some(obj) = store.object(chat_id, sync_obj_id)? else {
        return Ok(None);
    };
    Ok(effective(store, chat_id, &obj, now)?
        .filter(|c| !c.is_reaction() && is_visible(c, now))
        .map(|c| visible(chat_id, c)))
}

fn visible(chat_id: &ChatId, content: Content) -> VisibleMessage {
    let result_hash = Payload::Content(content.clone()).result_hash(chat_id);
    let data_len = media_of(&content.body).map(|m| m.data.len() as u64);
    VisibleMessage {
        chat_id: *chat_id,
        content,
        result_hash,
        reactions: Vec::new(),
        data_len,
    }
}

/// The media message a body holds: its own, or the one it forwards.
#[must_use]
pub fn media_of(body: &Body) -> Option<Media> {
    match body {
        Body::Media(m) => Some(m.clone()),
        Body::Forward {
            content_type: MessageType::Media,
            content,
        } => Media::decode(content).ok(),
        _ => None,
    }
}

/// The non-delete result of `obj` once everything due at `now` is applied, or `None` when it
/// is deleted by then or has no result yet. The ranks are those of the merge (§7.1), and a
/// deletion, applied or due, hides every result but a reaction.
fn effective<R: StorageRead + ?Sized>(
    store: &R,
    chat_id: &ChatId,
    obj: &ObjectRecord,
    now: u64,
) -> core::result::Result<Option<Content>, StorageError> {
    let deleted = obj.is_deleted()
        || obj
            .pending_deletions
            .first()
            .is_some_and(|(due, _)| *due <= now);
    let ranked = |c: Content| {
        let hash = Payload::Content(c.clone()).result_hash(chat_id);
        (c.rank(hash), c)
    };
    let mut best = match &obj.current {
        Some(StoredResult::Content(c)) => Some(ranked(c.clone())),
        _ => None,
    };
    for (_, id) in obj
        .pending_versions
        .iter()
        .take_while(|(due, _)| *due <= now)
    {
        let Some(Payload::Content(c)) = store
            .event_row(chat_id, id)?
            .and_then(|r| r.event().map(|e| e.payload().clone()))
        else {
            continue;
        };
        let candidate = ranked(c);
        if best.as_ref().is_none_or(|b| candidate.0 > b.0) {
            best = Some(candidate);
        }
    }
    Ok(best.map(|(_, c)| c).filter(|c| c.is_reaction() || !deleted))
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
    fn a_due_version_is_shown_without_a_tick() {
        let mut f = Fixture::new();
        let a = f.event(T0, 1, &[], text(1, f.bob.id, T0, T0, "a"));
        let b = f.event(T0, 2, &[], text(1, f.bob.id, T0, T0 + 1_000, "b"));
        let c = f.event(T0, 3, &[], text(1, f.bob.id, T0, T0 + 2_000, "c"));
        let s = f.event(T0, 4, &[], text(2, f.bob.id, T0 + 500, T0 + 500, "s"));
        for e in [&a, &b, &c, &s] {
            f.recv(e, T0);
        }
        let chat = f.root.chat_id();
        let texts = |f: &Fixture, now| -> Vec<String> {
            view(&f.store, &[chat], now)
                .unwrap()
                .into_iter()
                .map(|m| match m.content.body {
                    crate::event::Body::Text(t) => t,
                    _ => String::new(),
                })
                .collect()
        };
        assert_eq!(texts(&f, T0 + 999), ["a", "s"]);
        assert_eq!(texts(&f, T0 + 1_000), ["b", "s"]);
        assert_eq!(texts(&f, T0 + 2_000), ["c", "s"]);
        // The same as after a tick.
        f.tick(T0 + 2_000);
        assert_eq!(texts(&f, T0 + 2_000), ["c", "s"]);
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
    fn reactions_are_listed_on_their_target_as_if_ticked() {
        use crate::ReactionAction::{Add, Remove};
        use crate::epoch::tests::react;
        let mut f = Fixture::new();
        let chat = f.root.chat_id();
        let (alice, bob) = (f.alice.id, f.bob.id);
        let m = f.event(T0, 1, &[], text(1, bob, T0, T0, "m"));
        let a = f.event(T0, 2, &[], react(1, alice, "+", Add, T0));
        let b = f.event(T0, 3, &[], react(1, bob, "+", Add, T0));
        let b_off = f.event(T0, 4, &[], react(1, bob, "+", Remove, T0 + 100));
        let b_on = f.event(T0, 5, &[], react(1, bob, "+", Add, T0 + 200));
        // A reaction to a message the device does not hold, and one that a deletion naming
        // it cannot touch.
        let orphan = f.event(T0, 6, &[], react(2, bob, "?", Add, T0));
        let pending_under_tombstone = f.event(T0, 7, &[], react(1, alice, "-", Add, T0 + 300));
        let d = f.event(
            T0,
            8,
            &[],
            Payload::Delete {
                sync_obj_id: pending_under_tombstone.payload().sync_obj_id(),
                scheduled_at: None,
            },
        );
        for e in [
            &m,
            &a,
            &b,
            &b_off,
            &b_on,
            &orphan,
            &pending_under_tombstone,
            &d,
        ] {
            f.recv(e, T0);
        }
        let reactions = |f: &Fixture, now| {
            let v = view(&f.store, &[chat], now).unwrap();
            assert_eq!(v.len(), 1, "reactions are no messages");
            v[0].reactions.clone()
        };
        let pair = |id: crate::GossipId, e: &str| (id, e.to_owned());
        let mut both = vec![pair(alice, "+"), pair(bob, "+")];
        both.sort();
        assert_eq!(reactions(&f, T0), both);
        assert_eq!(reactions(&f, T0 + 100), vec![pair(alice, "+")]);
        let mut all = both.clone();
        all.push(pair(alice, "-"));
        all.sort();
        assert_eq!(reactions(&f, T0 + 300), all);
        // The same once ticked.
        f.tick(T0 + 300);
        assert_eq!(reactions(&f, T0 + 300), all);
        assert_eq!(view(&f.store, &[chat], T0 + 300).unwrap()[0].data_len, None);
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
