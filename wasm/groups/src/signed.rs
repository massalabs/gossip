//! Signed objects: the leave (§5.3), the kick (§5.6) and the dissolve message (§5.8).
//!
//! Each has a 32-byte hash ID with no timestamp and no random value, and is signed with
//! ML-DSA-65 over that ID (§5.1). The signature is not hashed.

use auth::UserPublicKeys;
use crypto_dsa::SIGNING_RANDOMNESS_SIZE;

use crate::constants::{
    CONTEXT_DISSOLVE_SIGNATURE, CONTEXT_KICK_SIGNATURE, CONTEXT_LEAVE_SIGNATURE,
};
use crate::error::{Error, Result};
use crate::hash::{dissolve_id, kick_id, leave_id};
use crate::ids::{ChatId, DissolveId, GossipId, KickId, LeaveId};
use crate::keys::{SignatureBytes, Signer, verify_id};
use crate::root::Root;
use crate::wire::proto;

fn check_names_epoch(chat_id: &ChatId, root: &Root) -> Result<()> {
    if *chat_id == root.chat_id() {
        Ok(())
    } else {
        Err(Error::IdMismatch("chat_id"))
    }
}

/// A signed leave: "I leave this epoch's group" (§5.3).
///
/// # Identity
///
/// The object's identity is its ID, [`Leave::id`]: the signature is not hashed, and ML-DSA
/// signing is randomized, so two valid copies of one object may carry different signatures.
/// `==` compares the signature too and tells such copies apart; storage and relaying MUST
/// deduplicate by ID, never by `==`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Leave {
    chat_id: ChatId,
    leaver: GossipId,
    signature: SignatureBytes,
}

impl Leave {
    /// Signs the leave of `leaver_keys` from the epoch `root`.
    ///
    /// # Errors
    ///
    /// [`Error::NotMember`] if the leaver is not a member of `root`, and
    /// [`Error::InvalidSignature`] if `signing_key` does not belong to `leaver_keys`.
    pub fn sign(
        root: &Root,
        leaver_keys: &UserPublicKeys,
        signing_key: &dyn Signer,
        randomness: [u8; SIGNING_RANDOMNESS_SIZE],
    ) -> Result<Self> {
        let leaver = GossipId::of_keys(leaver_keys);
        let id = leave_id(&root.chat_id(), &leaver);
        let leave = Self {
            chat_id: root.chat_id(),
            leaver,
            signature: signing_key.sign_id(CONTEXT_LEAVE_SIGNATURE, id.as_bytes(), randomness),
        };
        leave.verify(root, leaver_keys)?;
        Ok(leave)
    }

    /// Parses a received leave (lengths only; the signature is checked by [`Leave::verify`]).
    ///
    /// # Errors
    ///
    /// [`Error::BadLength`] for a field of the wrong length.
    pub(crate) fn from_proto(p: &proto::Leave) -> Result<Self> {
        Ok(Self {
            chat_id: ChatId::from_slice(&p.chat_id)?,
            leaver: GossipId::from_slice(&p.gossip_id)?,
            signature: SignatureBytes::from_slice(&p.signature)?,
        })
    }

    /// The protobuf form.
    #[must_use]
    pub(crate) fn to_proto(&self) -> proto::Leave {
        proto::Leave {
            chat_id: self.chat_id.as_bytes().to_vec(),
            gossip_id: self.leaver.as_bytes().to_vec(),
            signature: self.signature.as_bytes().to_vec(),
        }
    }

    /// `leaveId = H("gossip.groups.leave.1", chat_id, leaverGossipId)`.
    #[must_use]
    pub fn id(&self) -> LeaveId {
        leave_id(&self.chat_id, &self.leaver)
    }

    /// Verifies the leave against the root of the epoch it names and the leaver's keys, which
    /// the leave does not carry (§5.3): the root must be the named epoch, the leaver a member
    /// of it, the keys the leaver's, and the signature valid.
    ///
    /// # Errors
    ///
    /// [`Error::IdMismatch`], [`Error::NotMember`], [`Error::KeysMismatch`] or
    /// [`Error::InvalidSignature`].
    pub fn verify(&self, root: &Root, leaver_keys: &UserPublicKeys) -> Result<()> {
        check_names_epoch(&self.chat_id, root)?;
        if !root.is_member(&self.leaver) {
            return Err(Error::NotMember("the leaver"));
        }
        if GossipId::of_keys(leaver_keys) != self.leaver {
            return Err(Error::KeysMismatch);
        }
        verify_id(
            leaver_keys,
            CONTEXT_LEAVE_SIGNATURE,
            self.id().as_bytes(),
            &self.signature,
        )
    }

    /// The epoch the leave names.
    #[must_use]
    pub fn chat_id(&self) -> ChatId {
        self.chat_id
    }

    /// The leaver.
    #[must_use]
    pub fn leaver(&self) -> GossipId {
        self.leaver
    }

    /// The signature.
    #[must_use]
    pub fn signature(&self) -> &SignatureBytes {
        &self.signature
    }
}

/// A kick: "this member is removed from this epoch", signed by that epoch's owner (§5.6).
///
/// # Identity
///
/// The object's identity is its ID, [`Kick::id`]: the signature is not hashed, and ML-DSA
/// signing is randomized, so two valid copies of one object may carry different signatures.
/// `==` compares the signature too and tells such copies apart; storage and relaying MUST
/// deduplicate by ID, never by `==`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Kick {
    chat_id: ChatId,
    removed: GossipId,
    signature: SignatureBytes,
}

impl Kick {
    /// Signs the kick of `removed` from the epoch `root`, with the key of `root`'s owner (for
    /// a handover, the old owner, who owns the parent).
    ///
    /// # Errors
    ///
    /// [`Error::NotMember`] if `removed` is not a member of `root`, and
    /// [`Error::InvalidSignature`] if `owner_signing_key` is not the key of `root`'s owner.
    pub fn sign(
        root: &Root,
        removed: GossipId,
        owner_signing_key: &dyn Signer,
        randomness: [u8; SIGNING_RANDOMNESS_SIZE],
    ) -> Result<Self> {
        let id = kick_id(&root.chat_id(), &removed);
        let kick = Self {
            chat_id: root.chat_id(),
            removed,
            signature: owner_signing_key.sign_id(CONTEXT_KICK_SIGNATURE, id.as_bytes(), randomness),
        };
        kick.verify(root)?;
        Ok(kick)
    }

    /// Parses a received kick (lengths only; the signature is checked by [`Kick::verify`]).
    ///
    /// # Errors
    ///
    /// [`Error::BadLength`] for a field of the wrong length.
    pub(crate) fn from_proto(p: &proto::Kick) -> Result<Self> {
        Ok(Self {
            chat_id: ChatId::from_slice(&p.chat_id)?,
            removed: GossipId::from_slice(&p.gossip_id)?,
            signature: SignatureBytes::from_slice(&p.signature)?,
        })
    }

    /// The protobuf form.
    #[must_use]
    pub(crate) fn to_proto(&self) -> proto::Kick {
        proto::Kick {
            chat_id: self.chat_id.as_bytes().to_vec(),
            gossip_id: self.removed.as_bytes().to_vec(),
            signature: self.signature.as_bytes().to_vec(),
        }
    }

    /// `kickId = H("gossip.groups.kick.1", chat_id, removedGossipId)`.
    #[must_use]
    pub fn id(&self) -> KickId {
        kick_id(&self.chat_id, &self.removed)
    }

    /// Verifies the kick with the owner keys of the root of the epoch it names. The removed
    /// member must be a member of that epoch.
    ///
    /// # Errors
    ///
    /// [`Error::IdMismatch`], [`Error::NotMember`] or [`Error::InvalidSignature`].
    pub fn verify(&self, root: &Root) -> Result<()> {
        self.verify_with(root, root.owner_keys())
    }

    /// Verifies the kick against the root of the epoch it names, with the keys of `signer`:
    /// the owner of that epoch, or another identity with authority over it (D.18, decided
    /// by the caller).
    ///
    /// # Errors
    ///
    /// [`Error::IdMismatch`], [`Error::NotMember`] or [`Error::InvalidSignature`].
    pub fn verify_with(&self, root: &Root, signer: &UserPublicKeys) -> Result<()> {
        check_names_epoch(&self.chat_id, root)?;
        if !root.is_member(&self.removed) {
            return Err(Error::NotMember("the removed member"));
        }
        verify_id(
            signer,
            CONTEXT_KICK_SIGNATURE,
            self.id().as_bytes(),
            &self.signature,
        )
    }

    /// Signs the kick of `removed` from the epoch `root` as the identity `signer_keys`, which
    /// need not be `root`'s owner (D.18), and checks the signature with those keys.
    ///
    /// # Errors
    ///
    /// As [`Kick::sign`], against `signer_keys`.
    pub fn sign_as(
        root: &Root,
        removed: GossipId,
        signer: &dyn Signer,
        signer_keys: &UserPublicKeys,
        randomness: [u8; SIGNING_RANDOMNESS_SIZE],
    ) -> Result<Self> {
        let id = kick_id(&root.chat_id(), &removed);
        let kick = Self {
            chat_id: root.chat_id(),
            removed,
            signature: signer.sign_id(CONTEXT_KICK_SIGNATURE, id.as_bytes(), randomness),
        };
        kick.verify_with(root, signer_keys)?;
        Ok(kick)
    }

    /// The epoch the member is removed from.
    #[must_use]
    pub fn chat_id(&self) -> ChatId {
        self.chat_id
    }

    /// The removed member.
    #[must_use]
    pub fn removed(&self) -> GossipId {
        self.removed
    }

    /// The signature.
    #[must_use]
    pub fn signature(&self) -> &SignatureBytes {
        &self.signature
    }
}

/// A dissolve message: "this group is ended", signed by the epoch's owner (§5.8).
///
/// # Identity
///
/// The object's identity is its ID, [`Dissolve::id`]: the signature is not hashed, and ML-DSA
/// signing is randomized, so two valid copies of one object may carry different signatures.
/// `==` compares the signature too and tells such copies apart; storage and relaying MUST
/// deduplicate by ID, never by `==`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Dissolve {
    chat_id: ChatId,
    must_delete: bool,
    signature: SignatureBytes,
}

impl Dissolve {
    /// Signs the dissolve of the epoch `root` with the key of its owner.
    ///
    /// # Errors
    ///
    /// [`Error::InvalidSignature`] if `owner_signing_key` is not the key of `root`'s owner.
    pub fn sign(
        root: &Root,
        must_delete: bool,
        owner_signing_key: &dyn Signer,
        randomness: [u8; SIGNING_RANDOMNESS_SIZE],
    ) -> Result<Self> {
        let id = dissolve_id(&root.chat_id(), must_delete);
        let dissolve = Self {
            chat_id: root.chat_id(),
            must_delete,
            signature: owner_signing_key.sign_id(
                CONTEXT_DISSOLVE_SIGNATURE,
                id.as_bytes(),
                randomness,
            ),
        };
        dissolve.verify(root)?;
        Ok(dissolve)
    }

    /// Parses a received dissolve message (lengths only; the signature is checked by
    /// [`Dissolve::verify`]).
    ///
    /// # Errors
    ///
    /// [`Error::BadLength`] for a field of the wrong length.
    pub(crate) fn from_proto(p: &proto::Dissolve) -> Result<Self> {
        Ok(Self {
            chat_id: ChatId::from_slice(&p.chat_id)?,
            must_delete: p.must_delete,
            signature: SignatureBytes::from_slice(&p.signature)?,
        })
    }

    /// The protobuf form.
    #[must_use]
    pub(crate) fn to_proto(&self) -> proto::Dissolve {
        proto::Dissolve {
            chat_id: self.chat_id.as_bytes().to_vec(),
            must_delete: self.must_delete,
            signature: self.signature.as_bytes().to_vec(),
        }
    }

    /// `dissolveId = H("gossip.groups.dissolve.1", chat_id, must_delete)`.
    #[must_use]
    pub fn id(&self) -> DissolveId {
        dissolve_id(&self.chat_id, self.must_delete)
    }

    /// Verifies the dissolve message with the owner keys of the root of the epoch it names.
    ///
    /// # Errors
    ///
    /// [`Error::IdMismatch`] or [`Error::InvalidSignature`].
    pub fn verify(&self, root: &Root) -> Result<()> {
        check_names_epoch(&self.chat_id, root)?;
        verify_id(
            root.owner_keys(),
            CONTEXT_DISSOLVE_SIGNATURE,
            self.id().as_bytes(),
            &self.signature,
        )
    }

    /// The dissolved epoch.
    #[must_use]
    pub fn chat_id(&self) -> ChatId {
        self.chat_id
    }

    /// Whether members must erase the group ("Dissolve & Delete").
    #[must_use]
    pub fn must_delete(&self) -> bool {
        self.must_delete
    }

    /// The signature.
    #[must_use]
    pub fn signature(&self) -> &SignatureBytes {
        &self.signature
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::keys::sign_id;
    use crate::root::tests::founding;
    use crate::test_support::identity;

    #[test]
    fn leave_signs_verifies_and_round_trips() {
        let alice = identity(1);
        let bob = identity(2);
        let root = founding(&alice, &[&alice, &bob]);
        let leave = Leave::sign(&root, &bob.public, &bob.secret.dsa_signing_key, [3; 32]).unwrap();
        assert_eq!(leave.id(), leave_id(&root.chat_id(), &bob.id));
        assert!(leave.verify(&root, &bob.public).is_ok());
        let back = Leave::from_proto(&leave.to_proto()).unwrap();
        assert_eq!(back, leave);
        assert!(back.verify(&root, &bob.public).is_ok());
    }

    #[test]
    fn leave_rejects() {
        let alice = identity(1);
        let bob = identity(2);
        let carol = identity(3);
        let root = founding(&alice, &[&alice, &bob]);
        let other = founding(&bob, &[&alice, &bob]);
        let leave = Leave::sign(&root, &bob.public, &bob.secret.dsa_signing_key, [3; 32]).unwrap();
        // Wrong epoch.
        assert_eq!(
            leave.verify(&other, &bob.public),
            Err(Error::IdMismatch("chat_id"))
        );
        // Keys of someone else.
        assert_eq!(leave.verify(&root, &alice.public), Err(Error::KeysMismatch));
        // Not a member.
        assert_eq!(
            Leave::sign(&root, &carol.public, &carol.secret.dsa_signing_key, [3; 32]),
            Err(Error::NotMember("the leaver"))
        );
        // Signed with another key.
        assert_eq!(
            Leave::sign(&root, &bob.public, &alice.secret.dsa_signing_key, [3; 32]),
            Err(Error::InvalidSignature)
        );
        // The leaver's signature over the leave ID under another context fails.
        let mut p = leave.to_proto();
        let forged = sign_id(
            &bob.secret.dsa_signing_key,
            CONTEXT_KICK_SIGNATURE,
            leave.id().as_bytes(),
            [0; 32],
        );
        p.signature = forged.as_bytes().to_vec();
        assert_eq!(
            Leave::from_proto(&p).unwrap().verify(&root, &bob.public),
            Err(Error::InvalidSignature)
        );
        // Lengths.
        let mut p = leave.to_proto();
        p.chat_id.pop();
        assert!(matches!(
            Leave::from_proto(&p),
            Err(Error::BadLength { .. })
        ));
        let mut p = leave.to_proto();
        p.gossip_id.push(0);
        assert!(matches!(
            Leave::from_proto(&p),
            Err(Error::BadLength { .. })
        ));
        let mut p = leave.to_proto();
        p.signature.clear();
        assert!(matches!(
            Leave::from_proto(&p),
            Err(Error::BadLength { .. })
        ));
    }

    #[test]
    fn kick_signs_verifies_and_rejects() {
        let alice = identity(1);
        let bob = identity(2);
        let carol = identity(3);
        let root = founding(&alice, &[&alice, &bob]);
        let kick = Kick::sign(&root, bob.id, &alice.secret.dsa_signing_key, [4; 32]).unwrap();
        assert_eq!(kick.id(), kick_id(&root.chat_id(), &bob.id));
        assert!(kick.verify(&root).is_ok());
        let back = Kick::from_proto(&kick.to_proto()).unwrap();
        assert_eq!(back, kick);
        // Only the owner can kick.
        assert_eq!(
            Kick::sign(&root, bob.id, &bob.secret.dsa_signing_key, [4; 32]),
            Err(Error::InvalidSignature)
        );
        // Only a member can be kicked.
        assert_eq!(
            Kick::sign(&root, carol.id, &alice.secret.dsa_signing_key, [4; 32]),
            Err(Error::NotMember("the removed member"))
        );
        // Another epoch.
        let other = founding(&bob, &[&alice, &bob]);
        assert_eq!(kick.verify(&other), Err(Error::IdMismatch("chat_id")));
        // Another member under the same signature.
        let mut p = kick.to_proto();
        p.gossip_id = alice.id.as_bytes().to_vec();
        assert_eq!(
            Kick::from_proto(&p).unwrap().verify(&root),
            Err(Error::InvalidSignature)
        );
        // A leave signature does not pass for a kick, even by the owner over the same ID.
        let mut p = kick.to_proto();
        p.signature = sign_id(
            &alice.secret.dsa_signing_key,
            CONTEXT_LEAVE_SIGNATURE,
            kick.id().as_bytes(),
            [0; 32],
        )
        .as_bytes()
        .to_vec();
        assert_eq!(
            Kick::from_proto(&p).unwrap().verify(&root),
            Err(Error::InvalidSignature)
        );
        let mut p = kick.to_proto();
        p.signature.pop();
        assert!(matches!(Kick::from_proto(&p), Err(Error::BadLength { .. })));
    }

    #[test]
    fn identity_is_the_id_not_equality() {
        // Signing is randomized: two valid copies of one object differ in their signatures.
        let alice = identity(1);
        let bob = identity(2);
        let root = founding(&alice, &[&alice, &bob]);
        let key = &alice.secret.dsa_signing_key;
        let l1 = Leave::sign(&root, &bob.public, &bob.secret.dsa_signing_key, [1; 32]).unwrap();
        let l2 = Leave::sign(&root, &bob.public, &bob.secret.dsa_signing_key, [2; 32]).unwrap();
        assert_ne!(l1, l2);
        assert_eq!(l1.id(), l2.id());
        let k1 = Kick::sign(&root, bob.id, key, [1; 32]).unwrap();
        let k2 = Kick::sign(&root, bob.id, key, [2; 32]).unwrap();
        assert_ne!(k1, k2);
        assert_eq!(k1.id(), k2.id());
        let d1 = Dissolve::sign(&root, false, key, [1; 32]).unwrap();
        let d2 = Dissolve::sign(&root, false, key, [2; 32]).unwrap();
        assert_ne!(d1, d2);
        assert_eq!(d1.id(), d2.id());
        let params = || crate::root::tests::params(&alice, &[&alice, &bob], 0x10);
        let parent = [ChatId::from_bytes([0xd0; 32])];
        let r1 = Root::create_successor(params(), &parent, key, [1; 32]).unwrap();
        let r2 = Root::create_successor(params(), &parent, key, [2; 32]).unwrap();
        assert_ne!(r1, r2);
        assert_eq!(r1.chat_id(), r2.chat_id());
    }

    #[test]
    fn dissolve_signs_verifies_and_rejects() {
        let alice = identity(1);
        let bob = identity(2);
        let root = founding(&alice, &[&alice, &bob]);
        for must_delete in [false, true] {
            let d =
                Dissolve::sign(&root, must_delete, &alice.secret.dsa_signing_key, [5; 32]).unwrap();
            assert_eq!(d.id(), dissolve_id(&root.chat_id(), must_delete));
            assert!(d.verify(&root).is_ok());
            assert_eq!(Dissolve::from_proto(&d.to_proto()).unwrap(), d);
            // Flipping the flag invalidates the signature.
            let mut p = d.to_proto();
            p.must_delete = !must_delete;
            assert_eq!(
                Dissolve::from_proto(&p).unwrap().verify(&root),
                Err(Error::InvalidSignature)
            );
        }
        assert_eq!(
            Dissolve::sign(&root, true, &bob.secret.dsa_signing_key, [5; 32]),
            Err(Error::InvalidSignature)
        );
        let d = Dissolve::sign(&root, false, &alice.secret.dsa_signing_key, [5; 32]).unwrap();
        let other = founding(&bob, &[&alice, &bob]);
        assert_eq!(d.verify(&other), Err(Error::IdMismatch("chat_id")));
        let mut p = d.to_proto();
        p.chat_id.push(0);
        assert!(matches!(
            Dissolve::from_proto(&p),
            Err(Error::BadLength { .. })
        ));
    }
}
