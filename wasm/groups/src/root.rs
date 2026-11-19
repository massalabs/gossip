//! The root: the signed record that founds an epoch (§4.1 to §4.7).

use core::fmt;

use auth::UserPublicKeys;
use crypto_dsa::{SIGNATURE_SIZE, SIGNING_RANDOMNESS_SIZE, SigningKey};

use crate::cbor::Value;
use crate::constants::{
    CONTEXT_ROOT_SIGNATURE, DOMAIN_ROOT, EVENT_VERSION, MAX_MEMBERS, MAX_NAME_BYTES,
    MAX_ROOT_PARENTS, MIN_MEMBERS, MIN_ROOT_PARENTS,
};
use crate::error::{Error, Result};
use crate::hash::{h, parent_commitment, ref_chat_id};
use crate::ids::{
    Challenge, ChatId, GossipId, GroupSecret, ParentCommitment, RefChatId, check_sorted_distinct,
};
use crate::keys::{SignatureBytes, parse_user_public_keys, sign_id, verify_id};
use crate::wire::{self, proto};

/// The type of a root (§4.7). It is hashed into the root ID.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum RootType {
    /// The ordinary root, signed by the owner named in its own `owner` field; also used to
    /// found a group and to resolve a fork.
    Successor = 0,
    /// A root signed by the owner of its single parent, naming a new owner (§5.7).
    Handover = 1,
}

impl RootType {
    /// The value hashed and sent on the wire.
    #[must_use]
    pub const fn code(self) -> u64 {
        self as u64
    }
}

/// What the creator chooses for a new root (§4.6), apart from its parents.
pub struct RootParams {
    /// The group name: UTF-8, at most 256 bytes.
    pub name: String,
    /// The members, the owner included, in any order; they are sorted when the root is built.
    pub members: Vec<GossipId>,
    /// 32 fresh random bytes.
    pub group_secret: GroupSecret,
    /// The owner's complete keys.
    pub owner: UserPublicKeys,
    /// 32 fresh random bytes.
    pub epoch_challenge: Challenge,
    /// 32 fresh random bytes, independent of `epoch_challenge`.
    pub ref_chat_id_challenge: Challenge,
    /// The creator's clock at creation, see [`next_root_created_at`].
    pub created_at: u64,
}

/// What a device knows about the delivery of a root it received (§4.7 steps 2, 4, 5 and 7).
pub struct ReceiveContext<'a> {
    /// The `chat_id` announced by the notice, page entry or lookup that led to fetching the
    /// root, if any.
    pub announced: Option<ChatId>,
    /// The receiving device's own GossipID.
    pub own_id: GossipId,
    /// The authenticated immediate Agraphon peer that delivered the root.
    pub peer: GossipId,
    /// For a handover root, the held root matching its parent commitment, if the device holds
    /// one.
    pub handover_parent: Option<&'a Root>,
}

/// A structurally valid root (§4.7 steps 1 and 3 passed).
///
/// Holding a `Root` does not mean its signature was checked: see [`Root::verify_signature`]
/// and [`Root::verify_received`].
#[derive(Clone)]
pub struct Root {
    version: u64,
    root_type: RootType,
    name: String,
    parents: Vec<ParentCommitment>,
    members: Vec<GossipId>,
    group_secret: GroupSecret,
    owner_bytes: Vec<u8>,
    owner_keys: UserPublicKeys,
    owner_id: GossipId,
    epoch_challenge: Challenge,
    ref_chat_id_challenge: Challenge,
    created_at: u64,
    signature: SignatureBytes,
    chat_id: ChatId,
}

/// `created_at = max(now, L + 1)` for a new root, where `L` is the greatest `created_at`
/// among the roots of the group the device holds; `now` for a new group (§4.6 step 4).
///
/// # Errors
///
/// [`Error::Overflow`] if `L + 1` does not fit a u64.
pub fn next_root_created_at(now: u64, greatest_held: Option<u64>) -> Result<u64> {
    match greatest_held {
        None => Ok(now),
        Some(l) => {
            let next = l.checked_add(1).ok_or(Error::Overflow("created_at"))?;
            Ok(now.max(next))
        }
    }
}

/// The root ID (§4.1):
///
/// ```text
/// chat_id = H("gossip.groups.root.1", version, type, name, parents, members, group_secret,
///             owner, epoch_challenge, ref_chat_id_challenge, created_at)
/// ```
#[allow(clippy::too_many_arguments)]
fn compute_chat_id(
    version: u64,
    root_type: RootType,
    name: &str,
    parents: &[ParentCommitment],
    members: &[GossipId],
    group_secret: &GroupSecret,
    owner_bytes: &[u8],
    epoch_challenge: &Challenge,
    ref_chat_id_challenge: &Challenge,
    created_at: u64,
) -> ChatId {
    ChatId::from_bytes(h(
        DOMAIN_ROOT,
        vec![
            Value::Uint(version),
            Value::Uint(root_type.code()),
            Value::Text(name),
            Value::Array(parents.iter().map(|p| Value::Bytes(p.as_bytes())).collect()),
            Value::Array(members.iter().map(|m| Value::Bytes(m.as_bytes())).collect()),
            Value::Bytes(group_secret.as_bytes()),
            Value::Bytes(owner_bytes),
            Value::Bytes(epoch_challenge.as_bytes()),
            Value::Bytes(ref_chat_id_challenge.as_bytes()),
            Value::Uint(created_at),
        ],
    ))
}

fn check_count(field: &'static str, n: usize, min: usize, max: usize) -> Result<()> {
    if n < min {
        return Err(Error::TooFew { field, min, got: n });
    }
    if n > max {
        return Err(Error::TooMany { field, max, got: n });
    }
    Ok(())
}

/// Sorts a list and refuses duplicates (used when building, not when receiving).
fn sorted_distinct<T: Ord + Copy>(field: &'static str, items: &[T]) -> Result<Vec<T>> {
    let mut v = items.to_vec();
    v.sort_unstable();
    if v.windows(2).any(|w| w[0] == w[1]) {
        return Err(Error::Duplicate(field));
    }
    Ok(v)
}

impl Root {
    /// Builds and signs a successor root (§4.6, §4.7) naming `parents`, the chat IDs of the
    /// epochs it continues. To found a new group, `parents` is a single fresh random dummy ID
    /// that the caller then discards (§4.5).
    ///
    /// The signature is checked with the owner's key before the root is returned, so a
    /// signing key that does not belong to `params.owner` is refused.
    ///
    /// # Errors
    ///
    /// Any structural rule of §4.1 and §4.7 step 1, [`Error::Duplicate`] for a repeated member
    /// or parent, [`Error::OwnerNotMember`], [`Error::InvalidSignature`] for a wrong key, and
    /// [`Error::DoesNotFitContainer`] (§4.6).
    pub fn create_successor(
        params: RootParams,
        parents: &[ChatId],
        owner_signing_key: &SigningKey,
        randomness: [u8; SIGNING_RANDOMNESS_SIZE],
    ) -> Result<Self> {
        let root = Self::build(RootType::Successor, params, parents)?;
        root.sign_and_check(owner_signing_key, randomness, None)
    }

    /// Builds and signs a handover root (§4.7, §5.7) continuing `parent`, signed with the key
    /// of `parent`'s owner while `params.owner` names the new owner.
    ///
    /// # Errors
    ///
    /// As [`Root::create_successor`], plus [`Error::HandoverSameOwner`] and
    /// [`Error::HandoverAddsMember`].
    pub fn create_handover(
        params: RootParams,
        parent: &Root,
        parent_owner_signing_key: &SigningKey,
        randomness: [u8; SIGNING_RANDOMNESS_SIZE],
    ) -> Result<Self> {
        let root = Self::build(RootType::Handover, params, &[parent.chat_id])?;
        root.sign_and_check(parent_owner_signing_key, randomness, Some(parent))
    }

    fn build(root_type: RootType, params: RootParams, parents: &[ChatId]) -> Result<Self> {
        let commitments: Vec<ParentCommitment> = parents
            .iter()
            .map(|p| parent_commitment(&params.epoch_challenge, p))
            .collect();
        let commitments = sorted_distinct("parents", &commitments)?;
        let members = sorted_distinct("members", &params.members)?;
        let unsigned = proto::GroupRoot {
            r#type: root_type as i32,
            name: params.name,
            parents: commitments.iter().map(|p| p.as_bytes().to_vec()).collect(),
            members: members.iter().map(|m| m.as_bytes().to_vec()).collect(),
            group_secret: params.group_secret.as_bytes().to_vec(),
            owner: params.owner.to_bytes(),
            epoch_challenge: params.epoch_challenge.as_bytes().to_vec(),
            ref_chat_id_challenge: params.ref_chat_id_challenge.as_bytes().to_vec(),
            created_at: params.created_at,
            // Placeholder of the right size; the signature is not hashed.
            signature: vec![0; SIGNATURE_SIZE],
        };
        Self::from_proto(EVENT_VERSION, unsigned)
    }

    fn sign_and_check(
        mut self,
        signing_key: &SigningKey,
        randomness: [u8; SIGNING_RANDOMNESS_SIZE],
        parent: Option<&Root>,
    ) -> Result<Self> {
        self.signature = sign_id(
            signing_key,
            CONTEXT_ROOT_SIGNATURE,
            self.chat_id.as_bytes(),
            randomness,
        );
        self.verify_signature(parent)?;
        Ok(self)
    }

    /// Validates a received root (§4.7 step 1, then step 3) and computes its ID.
    ///
    /// `version` is the root's event version prefix. Step 1 covers the type, the name (UTF-8,
    /// at most 256 bytes), the parents (1 to 32 distinct 32-byte commitments, ascending; exactly
    /// one for a handover root), the members (1 to 512 distinct nonzero 32-byte GossipIDs,
    /// ascending), the length of every fixed-size field and the container limit (§4.6). Step 3
    /// parses the owner keys, hashes them to the owner's GossipID and checks that the owner is
    /// a member.
    ///
    /// # Errors
    ///
    /// The first rule broken.
    pub(crate) fn from_proto(version: u64, mut p: proto::GroupRoot) -> Result<Self> {
        if version != EVENT_VERSION {
            return Err(Error::UnsupportedEventVersion(version));
        }
        let root_type = match proto::RootType::try_from(p.r#type) {
            Ok(proto::RootType::Successor) => RootType::Successor,
            Ok(proto::RootType::Handover) => RootType::Handover,
            Err(_) => return Err(Error::Malformed("unknown root type")),
        };
        if p.name.len() > MAX_NAME_BYTES {
            return Err(Error::TooMany {
                field: "name",
                max: MAX_NAME_BYTES,
                got: p.name.len(),
            });
        }
        check_count(
            "parents",
            p.parents.len(),
            MIN_ROOT_PARENTS,
            MAX_ROOT_PARENTS,
        )?;
        let parents = p
            .parents
            .iter()
            .map(|b| ParentCommitment::from_slice(b))
            .collect::<Result<Vec<_>>>()?;
        check_sorted_distinct("parents", &parents)?;
        if root_type == RootType::Handover && parents.len() != 1 {
            return Err(Error::HandoverParentCount);
        }
        check_count("members", p.members.len(), MIN_MEMBERS, MAX_MEMBERS)?;
        let members = p
            .members
            .iter()
            .map(|b| GossipId::from_slice(b))
            .collect::<Result<Vec<_>>>()?;
        if members.iter().any(GossipId::is_zero) {
            return Err(Error::ZeroId("members"));
        }
        check_sorted_distinct("members", &members)?;
        let group_secret = GroupSecret::from_slice(&p.group_secret)?;
        let epoch_challenge = Challenge::from_slice(&p.epoch_challenge)?;
        let ref_chat_id_challenge = Challenge::from_slice(&p.ref_chat_id_challenge)?;
        let signature = SignatureBytes::from_slice(&p.signature)?;
        if p.owner.is_empty() {
            return Err(Error::Missing("owner"));
        }
        // §4.6: a root MUST fit one empty container.
        if !wire::fits_empty_container(wire::event_blob_len(
            version,
            prost::Message::encoded_len(&p),
        )) {
            return Err(Error::DoesNotFitContainer);
        }

        let chat_id = compute_chat_id(
            version,
            root_type,
            &p.name,
            &parents,
            &members,
            &group_secret,
            &p.owner,
            &epoch_challenge,
            &ref_chat_id_challenge,
            p.created_at,
        );

        let (owner_keys, owner_id) = parse_user_public_keys(&p.owner)?;
        if members.binary_search(&owner_id).is_err() {
            return Err(Error::OwnerNotMember);
        }

        let root = Self {
            version,
            root_type,
            name: core::mem::take(&mut p.name),
            parents,
            members,
            group_secret,
            owner_bytes: core::mem::take(&mut p.owner),
            owner_keys,
            owner_id,
            epoch_challenge,
            ref_chat_id_challenge,
            created_at: p.created_at,
            signature,
            chat_id,
        };
        Ok(root)
    }

    /// The protobuf form of this root.
    #[must_use]
    pub(crate) fn to_proto(&self) -> proto::GroupRoot {
        proto::GroupRoot {
            r#type: self.root_type as i32,
            name: self.name.clone(),
            parents: self.parents.iter().map(|p| p.as_bytes().to_vec()).collect(),
            members: self.members.iter().map(|m| m.as_bytes().to_vec()).collect(),
            group_secret: self.group_secret.as_bytes().to_vec(),
            owner: self.owner_bytes.clone(),
            epoch_challenge: self.epoch_challenge.as_bytes().to_vec(),
            ref_chat_id_challenge: self.ref_chat_id_challenge.as_bytes().to_vec(),
            created_at: self.created_at,
            signature: self.signature.as_bytes().to_vec(),
        }
    }

    /// Step 7 of §4.7: verifies the signature over the root ID with the context
    /// `gossip.groups.root.signature.1`.
    ///
    /// - Successor: with the ML-DSA-65 key of the root's own `owner`; `parent` is ignored.
    /// - Handover: `parent` must be the held root matching the single parent commitment. The
    ///   signature is verified with the key of that parent's owner; the new owner must differ
    ///   from the parent's owner and every member must be a member of the parent.
    ///
    /// # Errors
    ///
    /// [`Error::HandoverParentMissing`] when a handover root's parent is not given (the root
    /// is discarded without penalty and the parent is looked up, §4.7), otherwise
    /// [`Error::ParentMismatch`], [`Error::InvalidSignature`], [`Error::HandoverSameOwner`] or
    /// [`Error::HandoverAddsMember`].
    pub fn verify_signature(&self, parent: Option<&Root>) -> Result<()> {
        match self.root_type {
            RootType::Successor => verify_id(
                &self.owner_keys,
                CONTEXT_ROOT_SIGNATURE,
                self.chat_id.as_bytes(),
                &self.signature,
            ),
            RootType::Handover => {
                let parent = parent.ok_or(Error::HandoverParentMissing)?;
                if !self.names_parent(&parent.chat_id) {
                    return Err(Error::ParentMismatch);
                }
                verify_id(
                    &parent.owner_keys,
                    CONTEXT_ROOT_SIGNATURE,
                    self.chat_id.as_bytes(),
                    &self.signature,
                )?;
                if self.owner_id == parent.owner_id {
                    return Err(Error::HandoverSameOwner);
                }
                if !self.members.iter().all(|m| parent.is_member(m)) {
                    return Err(Error::HandoverAddsMember);
                }
                Ok(())
            }
        }
    }

    /// Steps 2, 4, 5 and 7 of §4.7 for a root this device received (steps 1 and 3 ran when the
    /// `Root` was built). Step 6, matching the parents, is [`Root::match_parents`]; it never
    /// rejects a root.
    ///
    /// # Errors
    ///
    /// [`Error::IdMismatch`] if the root is not the announced one, [`Error::NotMember`] if the
    /// device or the delivering peer is not a member, then as [`Root::verify_signature`].
    pub fn verify_received(&self, ctx: &ReceiveContext<'_>) -> Result<()> {
        if let Some(announced) = ctx.announced
            && announced != self.chat_id
        {
            return Err(Error::IdMismatch("chat_id"));
        }
        if !self.is_member(&ctx.own_id) {
            return Err(Error::NotMember("this device"));
        }
        if !self.is_member(&ctx.peer) {
            return Err(Error::NotMember("the delivering peer"));
        }
        self.verify_signature(ctx.handover_parent)
    }

    /// The commitment this root would carry for the epoch `parent` (§4.5).
    #[must_use]
    pub fn commitment_for(&self, parent: &ChatId) -> ParentCommitment {
        parent_commitment(&self.epoch_challenge, parent)
    }

    /// Whether one of this root's parent commitments names the epoch `parent`.
    #[must_use]
    pub fn names_parent(&self, parent: &ChatId) -> bool {
        self.parents
            .binary_search(&self.commitment_for(parent))
            .is_ok()
    }

    /// Step 6 of §4.7: the candidates (held roots and closed-chat markers) that one of this
    /// root's commitments names, in the order given.
    pub fn match_parents<'a>(
        &self,
        candidates: impl IntoIterator<Item = &'a ChatId>,
    ) -> Vec<ChatId> {
        candidates
            .into_iter()
            .filter(|c| self.names_parent(c))
            .copied()
            .collect()
    }

    /// The direct case of the continuity rule (§4.7): the parent's owner is the same identity
    /// as this root's owner. The other case, a previous owner in this root's own line, needs
    /// the held handover roots and is not decided here.
    #[must_use]
    pub fn has_same_owner_as(&self, parent: &Root) -> bool {
        self.owner_id == parent.owner_id
    }

    /// Whether `id` is in the member list.
    #[must_use]
    pub fn is_member(&self, id: &GossipId) -> bool {
        self.members.binary_search(id).is_ok()
    }

    /// The root ID, which is the epoch's `chat_id`.
    #[must_use]
    pub fn chat_id(&self) -> ChatId {
        self.chat_id
    }

    /// The epoch's opaque reference (§4.5).
    #[must_use]
    pub fn ref_chat_id(&self) -> RefChatId {
        ref_chat_id(&self.ref_chat_id_challenge, &self.chat_id)
    }

    /// The root's event version.
    #[must_use]
    pub fn version(&self) -> u64 {
        self.version
    }

    /// The root type.
    #[must_use]
    pub fn root_type(&self) -> RootType {
        self.root_type
    }

    /// The group name.
    #[must_use]
    pub fn name(&self) -> &str {
        &self.name
    }

    /// The parent commitments, ascending.
    #[must_use]
    pub fn parents(&self) -> &[ParentCommitment] {
        &self.parents
    }

    /// The members, ascending.
    #[must_use]
    pub fn members(&self) -> &[GossipId] {
        &self.members
    }

    /// The epoch's group secret.
    #[must_use]
    pub fn group_secret(&self) -> &GroupSecret {
        &self.group_secret
    }

    /// The owner's keys.
    #[must_use]
    pub fn owner_keys(&self) -> &UserPublicKeys {
        &self.owner_keys
    }

    /// The owner field as carried: `bincode(UserPublicKeys)`.
    #[must_use]
    pub fn owner_bytes(&self) -> &[u8] {
        &self.owner_bytes
    }

    /// The owner's GossipID.
    #[must_use]
    pub fn owner_id(&self) -> GossipId {
        self.owner_id
    }

    /// The challenge of the parent commitments.
    #[must_use]
    pub fn epoch_challenge(&self) -> &Challenge {
        &self.epoch_challenge
    }

    /// The challenge of the epoch reference.
    #[must_use]
    pub fn ref_chat_id_challenge(&self) -> &Challenge {
        &self.ref_chat_id_challenge
    }

    /// The creator's claimed creation time.
    #[must_use]
    pub fn created_at(&self) -> u64 {
        self.created_at
    }

    /// The signature.
    #[must_use]
    pub fn signature(&self) -> &SignatureBytes {
        &self.signature
    }
}

impl PartialEq for Root {
    /// Two roots are equal when they have the same ID, which covers every field but the
    /// signature, and the same signature.
    fn eq(&self, other: &Self) -> bool {
        self.chat_id == other.chat_id && self.signature == other.signature
    }
}

impl Eq for Root {}

impl fmt::Debug for Root {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Root")
            .field("chat_id", &self.chat_id)
            .field("type", &self.root_type)
            .field("name", &self.name)
            .field("parents", &self.parents.len())
            .field("members", &self.members.len())
            .field("owner", &self.owner_id)
            .field("created_at", &self.created_at)
            .finish_non_exhaustive()
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::test_support::{Identity, identity};

    pub(crate) fn params(owner: &Identity, members: &[&Identity], seed: u8) -> RootParams {
        RootParams {
            name: "Team".to_owned(),
            members: members.iter().map(|m| m.id).collect(),
            group_secret: GroupSecret::from_bytes([seed; 32]),
            owner: owner.public.clone(),
            epoch_challenge: Challenge::from_bytes([seed.wrapping_add(1); 32]),
            ref_chat_id_challenge: Challenge::from_bytes([seed.wrapping_add(2); 32]),
            created_at: 1_700_000_000_000,
        }
    }

    /// A root founding a new group of `members`, owned by `owner`.
    pub(crate) fn founding(owner: &Identity, members: &[&Identity]) -> Root {
        Root::create_successor(
            params(owner, members, 0x10),
            &[ChatId::from_bytes([0xd0; 32])],
            &owner.secret.dsa_signing_key,
            [0x5a; 32],
        )
        .unwrap()
    }

    fn modified(root: &Root, f: impl FnOnce(&mut proto::GroupRoot)) -> Result<Root> {
        let mut p = root.to_proto();
        f(&mut p);
        Root::from_proto(root.version(), p)
    }

    #[test]
    fn root_id_vector() {
        let alice = identity(1);
        let bob = identity(2);
        let root = founding(&alice, &[&alice, &bob]);
        assert_eq!(
            hex::encode(alice.id.as_bytes()),
            "617651957a1958415121d7824168fee9b34c3ff739627f114c3aba508676ffbe"
        );
        assert_eq!(
            hex::encode(root.chat_id().as_bytes()),
            "a7860cd85958ddae1c4df0521022889dff605b29bad270b842636817432f67a3"
        );
        assert_eq!(
            hex::encode(root.ref_chat_id().as_bytes()),
            "65e2eb398ff1f6368cc7cecca3865a6df3301b92b86abc605221adfbaeb34de9"
        );
        assert_eq!(
            hex::encode(root.parents()[0].as_bytes()),
            hex::encode(
                parent_commitment(
                    &Challenge::from_bytes([0x11; 32]),
                    &ChatId::from_bytes([0xd0; 32])
                )
                .as_bytes()
            )
        );
    }

    #[test]
    fn root_id_projection_matches_section_4_1() {
        let alice = identity(1);
        let root = founding(&alice, &[&alice]);
        let expected = h(
            DOMAIN_ROOT,
            vec![
                Value::Uint(1),
                Value::Uint(0),
                Value::Text("Team"),
                Value::Array(vec![Value::Bytes(root.parents()[0].as_bytes())]),
                Value::Array(vec![Value::Bytes(alice.id.as_bytes())]),
                Value::Bytes(&[0x10; 32]),
                Value::Bytes(&alice.public.to_bytes()),
                Value::Bytes(&[0x11; 32]),
                Value::Bytes(&[0x12; 32]),
                Value::Uint(1_700_000_000_000),
            ],
        );
        assert_eq!(root.chat_id().as_bytes(), &expected);
    }

    #[test]
    fn root_id_projection_written_by_hand() {
        let alice = identity(1);
        let root = founding(&alice, &[&alice]);
        let owner = alice.public.to_bytes();
        // The owner keys take a two-byte length: major type 2, additional information 25.
        let owner_len = u16::try_from(owner.len()).unwrap();
        assert!(owner_len >= 256);
        let bytes32 = |b: &[u8; 32]| [&[0x58, 0x20][..], b].concat();
        let projection = [
            // An array of 11 items, then the domain as text of 20 bytes.
            &[0x8b, 0x74][..],
            b"gossip.groups.root.1",
            // version 1, type 0 (successor), name "Team" as text.
            &[0x01, 0x00, 0x64],
            b"Team",
            // parents: an array of one commitment.
            &[0x81],
            &bytes32(root.parents()[0].as_bytes()),
            // members: an array of one GossipID.
            &[0x81],
            &bytes32(alice.id.as_bytes()),
            // group_secret, then the owner keys as bytes.
            &bytes32(&[0x10; 32]),
            &[0x59],
            &owner_len.to_be_bytes(),
            &owner,
            // epoch_challenge, then ref_chat_id_challenge.
            &bytes32(&[0x11; 32]),
            &bytes32(&[0x12; 32]),
            // created_at 1,700,000,000,000 as an eight-byte unsigned integer.
            &[0x1b, 0x00, 0x00, 0x01, 0x8b, 0xcf, 0xe5, 0x68, 0x00],
        ]
        .concat();
        assert_eq!(
            root.chat_id().as_bytes(),
            blake3::hash(&projection).as_bytes()
        );
    }

    #[test]
    fn created_roots_verify_and_round_trip() {
        let alice = identity(1);
        let bob = identity(2);
        let root = founding(&alice, &[&bob, &alice]);
        assert_eq!(root.members(), {
            let mut m = vec![alice.id, bob.id];
            m.sort();
            m
        });
        assert!(root.verify_signature(None).is_ok());
        let back = Root::from_proto(1, root.to_proto()).unwrap();
        assert_eq!(back, root);
        assert_eq!(back.owner_id(), alice.id);
        assert!(back.verify_signature(None).is_ok());
    }

    #[test]
    fn every_field_changes_the_id() {
        let alice = identity(1);
        let bob = identity(2);
        let root = founding(&alice, &[&alice, &bob]);
        let id = root.chat_id();
        type Change = Box<dyn Fn(&mut proto::GroupRoot)>;
        let changes: Vec<Change> = vec![
            Box::new(|p| p.name = "Other".into()),
            Box::new(|p| p.parents[0][0] ^= 1),
            Box::new(|p| p.group_secret[0] ^= 1),
            Box::new(|p| p.epoch_challenge[0] ^= 1),
            Box::new(|p| p.ref_chat_id_challenge[0] ^= 1),
            Box::new(|p| p.created_at += 1),
        ];
        for change in changes {
            let r = modified(&root, |p| change(p)).unwrap();
            assert_ne!(r.chat_id(), id);
            // The signature over the old ID no longer verifies.
            assert_eq!(r.verify_signature(None), Err(Error::InvalidSignature));
        }
        // The signature itself is not hashed.
        let r = modified(&root, |p| p.signature[0] ^= 1).unwrap();
        assert_eq!(r.chat_id(), id);
        assert_eq!(r.verify_signature(None), Err(Error::InvalidSignature));
    }

    #[test]
    fn structural_rules_reject() {
        let alice = identity(1);
        let bob = identity(2);
        let root = founding(&alice, &[&alice, &bob]);

        assert_eq!(
            Root::from_proto(2, root.to_proto()).map(|_| ()),
            Err(Error::UnsupportedEventVersion(2))
        );
        assert!(matches!(
            modified(&root, |p| p.r#type = 2),
            Err(Error::Malformed(_))
        ));
        assert!(modified(&root, |p| p.name = "é".repeat(128)).is_ok());
        assert_eq!(
            modified(&root, |p| p.name = "x".repeat(257)).map(|_| ()),
            Err(Error::TooMany {
                field: "name",
                max: 256,
                got: 257
            })
        );
        // Parents: count, length, order, distinctness.
        assert!(matches!(
            modified(&root, |p| p.parents.clear()),
            Err(Error::TooFew {
                field: "parents",
                ..
            })
        ));
        assert!(matches!(
            modified(&root, |p| p.parents =
                (0u8..33).map(|i| vec![i; 32]).collect()),
            Err(Error::TooMany {
                field: "parents",
                ..
            })
        ));
        assert!(
            modified(&root, |p| p.parents =
                (0u8..32).map(|i| vec![i; 32]).collect())
            .is_ok()
        );
        assert!(matches!(
            modified(&root, |p| {
                p.parents[0].pop();
            }),
            Err(Error::BadLength { .. })
        ));
        assert_eq!(
            modified(&root, |p| p.parents = vec![vec![2; 32], vec![1; 32]]).map(|_| ()),
            Err(Error::NotSortedDistinct("parents"))
        );
        assert_eq!(
            modified(&root, |p| p.parents = vec![vec![1; 32], vec![1; 32]]).map(|_| ()),
            Err(Error::NotSortedDistinct("parents"))
        );
        // Members: count, length, zero, order, distinctness.
        assert!(matches!(
            modified(&root, |p| p.members.clear()),
            Err(Error::TooFew {
                field: "members",
                ..
            })
        ));
        assert!(matches!(
            modified(&root, |p| {
                p.members = (1u16..=513)
                    .map(|i| {
                        let mut m = vec![0; 32];
                        m[30..].copy_from_slice(&i.to_be_bytes());
                        m
                    })
                    .collect();
            }),
            Err(Error::TooMany {
                field: "members",
                ..
            })
        ));
        assert!(matches!(
            modified(&root, |p| p.members[0].push(0)),
            Err(Error::BadLength { .. })
        ));
        assert_eq!(
            modified(&root, |p| p.members.insert(0, vec![0; 32])).map(|_| ()),
            Err(Error::ZeroId("members"))
        );
        assert_eq!(
            modified(&root, |p| p.members.reverse()).map(|_| ()),
            Err(Error::NotSortedDistinct("members"))
        );
        assert_eq!(
            modified(&root, |p| {
                let m = p.members[0].clone();
                p.members.insert(0, m);
            })
            .map(|_| ()),
            Err(Error::NotSortedDistinct("members"))
        );
        // Fixed-size fields.
        assert!(matches!(
            modified(&root, |p| {
                p.group_secret.pop();
            }),
            Err(Error::BadLength {
                field: "group_secret",
                ..
            })
        ));
        assert!(matches!(
            modified(&root, |p| p.epoch_challenge.push(0)),
            Err(Error::BadLength {
                field: "challenge",
                ..
            })
        ));
        assert!(matches!(
            modified(&root, |p| p.ref_chat_id_challenge.clear()),
            Err(Error::BadLength {
                field: "challenge",
                ..
            })
        ));
        assert!(matches!(
            modified(&root, |p| {
                p.signature.pop();
            }),
            Err(Error::BadLength {
                field: "signature",
                ..
            })
        ));
        // Owner.
        assert_eq!(
            modified(&root, |p| p.owner.clear()).map(|_| ()),
            Err(Error::Missing("owner"))
        );
        assert_eq!(
            modified(&root, |p| p.owner.push(0)).map(|_| ()),
            Err(Error::NonCanonicalKeys)
        );
        assert_eq!(
            modified(&root, |p| p.owner.truncate(100)).map(|_| ()),
            Err(Error::InvalidKeys)
        );
        assert_eq!(
            modified(&root, |p| p
                .members
                .retain(|m| m.as_slice() != alice.id.as_bytes()))
            .map(|_| ()),
            Err(Error::OwnerNotMember)
        );
    }

    #[test]
    fn member_limit_and_container_limit() {
        let alice = identity(1);
        let mut members: Vec<GossipId> = (1u16..512)
            .map(|i| {
                let mut m = [0u8; 32];
                m[30..].copy_from_slice(&i.to_be_bytes());
                GossipId::from_bytes(m)
            })
            .collect();
        members.push(alice.id);
        let mut p = params(&alice, &[], 0x10);
        p.members = members;
        let root = Root::create_successor(
            p,
            &[ChatId::from_bytes([0xd0; 32])],
            &alice.secret.dsa_signing_key,
            [0; 32],
        )
        .unwrap();
        assert_eq!(root.members().len(), 512);
        // About 24 KB at 512 members (§4.4).
        let blob_len = wire::event_blob_len(1, prost::Message::encoded_len(&root.to_proto()));
        assert!(blob_len > 20_000 && blob_len < 26_000, "{blob_len}");
    }

    #[test]
    fn oversized_root_does_not_fit_a_container() {
        let alice = identity(1);
        let root = founding(&alice, &[&alice]);
        // A name is limited to 256 bytes and the lists are bounded, so only an inflated owner
        // field can exceed the container.
        let mut p = root.to_proto();
        p.owner = vec![0; 300_000];
        assert_eq!(
            Root::from_proto(1, p).map(|_| ()),
            Err(Error::DoesNotFitContainer)
        );
    }

    #[test]
    fn builder_rejects_duplicates_non_members_and_wrong_keys() {
        let alice = identity(1);
        let bob = identity(2);
        let mut p = params(&alice, &[&alice, &bob, &bob], 0x10);
        assert_eq!(
            Root::create_successor(
                p,
                &[ChatId::from_bytes([1; 32])],
                &alice.secret.dsa_signing_key,
                [0; 32]
            )
            .map(|_| ()),
            Err(Error::Duplicate("members"))
        );
        p = params(&alice, &[&alice], 0x10);
        assert_eq!(
            Root::create_successor(
                p,
                &[ChatId::from_bytes([1; 32]), ChatId::from_bytes([1; 32])],
                &alice.secret.dsa_signing_key,
                [0; 32]
            )
            .map(|_| ()),
            Err(Error::Duplicate("parents"))
        );
        p = params(&alice, &[&bob], 0x10);
        assert_eq!(
            Root::create_successor(
                p,
                &[ChatId::from_bytes([1; 32])],
                &alice.secret.dsa_signing_key,
                [0; 32]
            )
            .map(|_| ()),
            Err(Error::OwnerNotMember)
        );
        p = params(&alice, &[&alice], 0x10);
        assert_eq!(
            Root::create_successor(
                p,
                &[ChatId::from_bytes([1; 32])],
                &bob.secret.dsa_signing_key,
                [0; 32]
            )
            .map(|_| ()),
            Err(Error::InvalidSignature)
        );
        p = params(&alice, &[&alice], 0x10);
        p.name = "n".repeat(257);
        assert!(matches!(
            Root::create_successor(
                p,
                &[ChatId::from_bytes([1; 32])],
                &alice.secret.dsa_signing_key,
                [0; 32]
            ),
            Err(Error::TooMany { field: "name", .. })
        ));
    }

    #[test]
    fn successor_of_a_held_parent() {
        let alice = identity(1);
        let bob = identity(2);
        let carol = identity(3);
        let first = founding(&alice, &[&alice, &bob]);
        let second = Root::create_successor(
            params(&alice, &[&alice, &carol], 0x20),
            &[first.chat_id()],
            &alice.secret.dsa_signing_key,
            [1; 32],
        )
        .unwrap();
        assert!(second.names_parent(&first.chat_id()));
        assert!(!second.names_parent(&ChatId::from_bytes([0xd0; 32])));
        let unrelated = ChatId::from_bytes([9; 32]);
        assert_eq!(
            second.match_parents([&unrelated, &first.chat_id()]),
            vec![first.chat_id()]
        );
        assert!(second.has_same_owner_as(&first));
        assert!(second.verify_signature(None).is_ok());
    }

    #[test]
    fn handover_rules() {
        let alice = identity(1);
        let bob = identity(2);
        let carol = identity(3);
        let parent = founding(&alice, &[&alice, &bob, &carol]);

        // Alice hands over to Bob and leaves.
        let handover = Root::create_handover(
            params(&bob, &[&bob, &carol], 0x30),
            &parent,
            &alice.secret.dsa_signing_key,
            [2; 32],
        )
        .unwrap();
        assert_eq!(handover.root_type(), RootType::Handover);
        assert_eq!(handover.owner_id(), bob.id);
        assert!(handover.verify_signature(Some(&parent)).is_ok());
        // Not the held parent: cannot be checked, no penalty.
        assert_eq!(
            handover.verify_signature(None),
            Err(Error::HandoverParentMissing)
        );
        // Checked against the root's own owner, the signature fails: a handover never passes
        // for a successor.
        let other = founding(&bob, &[&bob, &carol]);
        assert_eq!(
            handover.verify_signature(Some(&other)),
            Err(Error::ParentMismatch)
        );
        // The type is hashed: turning it into a successor changes the ID.
        let mut p = handover.to_proto();
        p.r#type = 0;
        let as_successor = Root::from_proto(1, p).unwrap();
        assert_ne!(as_successor.chat_id(), handover.chat_id());
        assert_eq!(
            as_successor.verify_signature(None),
            Err(Error::InvalidSignature)
        );

        // The builder refuses to add a member or to keep the owner.
        let dave = identity(4);
        assert_eq!(
            Root::create_handover(
                params(&bob, &[&bob, &dave], 0x31),
                &parent,
                &alice.secret.dsa_signing_key,
                [2; 32]
            )
            .map(|_| ()),
            Err(Error::HandoverAddsMember)
        );
        assert_eq!(
            Root::create_handover(
                params(&alice, &[&alice, &bob], 0x32),
                &parent,
                &alice.secret.dsa_signing_key,
                [2; 32]
            )
            .map(|_| ()),
            Err(Error::HandoverSameOwner)
        );
        // Signed by the new owner instead of the parent's owner.
        assert_eq!(
            Root::create_handover(
                params(&bob, &[&bob], 0x33),
                &parent,
                &bob.secret.dsa_signing_key,
                [2; 32]
            )
            .map(|_| ()),
            Err(Error::InvalidSignature)
        );

        // A handover root must have exactly one parent.
        let mut p = handover.to_proto();
        p.parents = vec![vec![1; 32], vec![2; 32]];
        assert_eq!(
            Root::from_proto(1, p).map(|_| ()),
            Err(Error::HandoverParentCount)
        );
    }

    #[test]
    fn received_root_checks() {
        let alice = identity(1);
        let bob = identity(2);
        let carol = identity(3);
        let root = founding(&alice, &[&alice, &bob]);
        let ctx = |announced, own_id, peer| ReceiveContext {
            announced,
            own_id,
            peer,
            handover_parent: None,
        };
        assert!(root.verify_received(&ctx(None, bob.id, alice.id)).is_ok());
        assert!(
            root.verify_received(&ctx(Some(root.chat_id()), bob.id, alice.id))
                .is_ok()
        );
        assert_eq!(
            root.verify_received(&ctx(Some(ChatId::from_bytes([0; 32])), bob.id, alice.id)),
            Err(Error::IdMismatch("chat_id"))
        );
        assert_eq!(
            root.verify_received(&ctx(None, carol.id, alice.id)),
            Err(Error::NotMember("this device"))
        );
        assert_eq!(
            root.verify_received(&ctx(None, bob.id, carol.id)),
            Err(Error::NotMember("the delivering peer"))
        );
    }

    #[test]
    fn created_at_rule() {
        assert_eq!(next_root_created_at(100, None), Ok(100));
        assert_eq!(next_root_created_at(100, Some(50)), Ok(100));
        assert_eq!(next_root_created_at(100, Some(100)), Ok(101));
        assert_eq!(next_root_created_at(100, Some(500)), Ok(501));
        assert_eq!(
            next_root_created_at(100, Some(u64::MAX)),
            Err(Error::Overflow("created_at"))
        );
    }
}
