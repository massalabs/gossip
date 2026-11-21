//! One peer per underlying identity: the nullifier registry.
//!
//! Anonymous schemes cannot reveal *who* proved, but they can reveal a stable
//! [`Tag`] per identity and scope (a key image, an epoch nullifier). The registry
//! remembers which peer id currently holds each tag so a single identity cannot back
//! many peers at once.

use std::collections::HashMap;

use gossip_wire::{PeerId, SchemeId, UnixMillis};

use crate::scheme::Tag;

/// The tag is held by another peer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NullifierCollision {
    /// Current holder.
    pub holder: PeerId,
    /// When the holder was last seen alive.
    pub last_seen: UnixMillis,
}

#[derive(Clone, Debug)]
struct Holder {
    peer: PeerId,
    last_seen: UnixMillis,
    connected: bool,
}

/// In-memory registry of claimed tags.
#[derive(Default, Debug)]
pub struct NullifierRegistry {
    held: HashMap<(SchemeId, Tag), Holder>,
}

impl NullifierRegistry {
    /// Empty registry.
    pub fn new() -> Self {
        Self::default()
    }

    /// Claims `tag` for `peer`. Succeeds if the tag is free, already held by `peer`,
    /// or held by a peer that has been disconnected for longer than `grace_ms`.
    #[allow(clippy::result_large_err)]
    pub fn claim(
        &mut self,
        scheme: SchemeId,
        tag: Tag,
        peer: &PeerId,
        now: UnixMillis,
        grace_ms: u64,
    ) -> Result<(), NullifierCollision> {
        match self.held.get_mut(&(scheme, tag.clone())) {
            None => {
                self.held.insert(
                    (scheme, tag),
                    Holder {
                        peer: *peer,
                        last_seen: now,
                        connected: true,
                    },
                );
                Ok(())
            }
            Some(h) if &h.peer == peer => {
                h.last_seen = now;
                h.connected = true;
                Ok(())
            }
            Some(h) if !h.connected && now.0.saturating_sub(h.last_seen.0) > grace_ms => {
                *h = Holder {
                    peer: *peer,
                    last_seen: now,
                    connected: true,
                };
                Ok(())
            }
            Some(h) => Err(NullifierCollision {
                holder: h.peer,
                last_seen: h.last_seen,
            }),
        }
    }

    /// Marks every tag held by `peer` as disconnected (starts the transfer grace).
    pub fn disconnected(&mut self, peer: &PeerId, now: UnixMillis) {
        for h in self.held.values_mut().filter(|h| &h.peer == peer) {
            h.connected = false;
            h.last_seen = now;
        }
    }

    /// Refreshes liveness of every tag held by `peer`.
    pub fn touch(&mut self, peer: &PeerId, now: UnixMillis) {
        for h in self.held.values_mut().filter(|h| &h.peer == peer) {
            h.last_seen = now;
            h.connected = true;
        }
    }

    /// Drops tags of disconnected peers not seen for `max_age_ms`, and every tag whose
    /// scope the caller declares expired.
    pub fn prune(
        &mut self,
        now: UnixMillis,
        max_age_ms: u64,
        scope_expired: impl Fn(SchemeId, &[u8]) -> bool,
    ) {
        self.held.retain(|(scheme, tag), h| {
            if scope_expired(*scheme, &tag.scope) {
                return false;
            }
            h.connected || now.0.saturating_sub(h.last_seen.0) <= max_age_ms
        });
    }

    /// Removes one tag (used to roll back a partial claim).
    pub fn remove(&mut self, scheme: SchemeId, tag: &Tag) {
        self.held.remove(&(scheme, tag.clone()));
    }

    /// Releases every tag held by `peer` immediately (no grace period). Used when a
    /// handshake fails after tags were claimed, so an honest identity is never locked out.
    pub fn release(&mut self, peer: &PeerId) {
        self.held.retain(|_, h| &h.peer != peer);
    }

    /// Current holder of a tag, if any.
    pub fn holder(&self, scheme: SchemeId, tag: &Tag) -> Option<&PeerId> {
        self.held.get(&(scheme, tag.clone())).map(|h| &h.peer)
    }

    /// Number of tags held.
    pub fn len(&self) -> usize {
        self.held.len()
    }

    /// Whether no tag is held.
    pub fn is_empty(&self) -> bool {
        self.held.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use massa_signature::KeyPair;

    fn pid() -> PeerId {
        PeerId::from_public_key(KeyPair::generate(0).unwrap().get_public_key())
    }
    fn tag(v: u8) -> Tag {
        Tag {
            scope: b"epoch-1".to_vec(),
            value: [v; 32],
        }
    }

    #[test]
    fn same_peer_can_reclaim_other_peer_cannot() {
        let mut r = NullifierRegistry::new();
        let a = pid();
        let b = pid();
        r.claim(16, tag(1), &a, UnixMillis(0), 100).unwrap();
        r.claim(16, tag(1), &a, UnixMillis(10), 100).unwrap();
        let err = r.claim(16, tag(1), &b, UnixMillis(20), 100).unwrap_err();
        assert_eq!(err.holder, a);
        // different scheme, same value: independent
        r.claim(2, tag(1), &b, UnixMillis(20), 100).unwrap();
    }

    #[test]
    fn transfer_after_grace() {
        let mut r = NullifierRegistry::new();
        let a = pid();
        let b = pid();
        r.claim(16, tag(1), &a, UnixMillis(0), 100).unwrap();
        r.disconnected(&a, UnixMillis(50));
        assert!(r.claim(16, tag(1), &b, UnixMillis(100), 100).is_err());
        r.claim(16, tag(1), &b, UnixMillis(151), 100).unwrap();
        assert_eq!(r.holder(16, &tag(1)), Some(&b));
    }

    #[test]
    fn prune_drops_expired_scopes_and_stale_holders() {
        let mut r = NullifierRegistry::new();
        let a = pid();
        r.claim(16, tag(1), &a, UnixMillis(0), 100).unwrap();
        r.claim(
            16,
            Tag {
                scope: b"epoch-0".to_vec(),
                value: [2; 32],
            },
            &a,
            UnixMillis(0),
            100,
        )
        .unwrap();
        r.prune(UnixMillis(10), 1000, |_, scope| scope == b"epoch-0");
        assert_eq!(r.len(), 1);
        r.disconnected(&a, UnixMillis(10));
        r.prune(UnixMillis(2000), 1000, |_, _| false);
        assert!(r.is_empty());
    }
}
