//! The hash projection `H` (§1.2) and every hash-derived identifier.
//!
//! ```text
//! H(domain, a, b, ...) = BLAKE3(CBOR([domain, a, b, ...]))
//! ```
//!
//! The domain is a CBOR text string, identifiers and secrets are byte strings, integers are
//! unsigned integers, and the array is encoded deterministically (see [`crate::cbor`]).

use crate::cbor::Value;
use crate::constants::{
    DOMAIN_DISSOLVE, DOMAIN_KICK, DOMAIN_LEAVE, DOMAIN_PREDECESSOR, DOMAIN_REFERENCE,
    DOMAIN_SECRET_PROOF, DOMAIN_SYNC_OBJ_NAME,
};
use crate::ids::{
    Challenge, ChatId, DissolveId, EventId, GossipId, GroupSecret, KickId, LeaveId,
    ParentCommitment, RefChatId, SecretProof, SyncObjId,
};

/// The CBOR projection hashed by `H`: the array `[domain, items...]`, encoded
/// deterministically.
#[must_use]
pub fn projection(domain: &str, items: Vec<Value<'_>>) -> Vec<u8> {
    let mut array = Vec::with_capacity(items.len() + 1);
    array.push(Value::Text(domain));
    array.extend(items);
    Value::Array(array).encode()
}

/// `H(domain, items...)`: BLAKE3 with a 32-byte output over the projection (§1.2).
#[must_use]
pub fn h(domain: &str, items: Vec<Value<'_>>) -> [u8; 32] {
    *blake3::hash(&projection(domain, items)).as_bytes()
}

/// `parentCommitment = H("gossip.groups.predecessor.1", epoch_challenge, parentChatId)`
/// (§4.5), where `epoch_challenge` is the challenge of the **new** root.
#[must_use]
pub fn parent_commitment(epoch_challenge: &Challenge, parent: &ChatId) -> ParentCommitment {
    ParentCommitment::from_bytes(h(
        DOMAIN_PREDECESSOR,
        vec![
            Value::Bytes(epoch_challenge.as_bytes()),
            Value::Bytes(parent.as_bytes()),
        ],
    ))
}

/// `ref_chat_id = H("gossip.groups.reference.1", ref_chat_id_challenge, chat_id)` (§4.5),
/// with the challenge of the epoch being referenced.
#[must_use]
pub fn ref_chat_id(ref_chat_id_challenge: &Challenge, chat_id: &ChatId) -> RefChatId {
    RefChatId::from_bytes(h(
        DOMAIN_REFERENCE,
        vec![
            Value::Bytes(ref_chat_id_challenge.as_bytes()),
            Value::Bytes(chat_id.as_bytes()),
        ],
    ))
}

/// `secret_proof = H("gossip.groups.message.secret_proof.1", chat_id, group_secret, eventId)`
/// (§4.2).
#[must_use]
pub fn secret_proof(
    chat_id: &ChatId,
    group_secret: &GroupSecret,
    event_id: &EventId,
) -> SecretProof {
    SecretProof::from_bytes(h(
        DOMAIN_SECRET_PROOF,
        vec![
            Value::Bytes(chat_id.as_bytes()),
            Value::Bytes(group_secret.as_bytes()),
            Value::Bytes(event_id.as_bytes()),
        ],
    ))
}

/// `leaveId = H("gossip.groups.leave.1", chat_id, leaverGossipId)` (§5.3).
#[must_use]
pub fn leave_id(chat_id: &ChatId, leaver: &GossipId) -> LeaveId {
    LeaveId::from_bytes(h(
        DOMAIN_LEAVE,
        vec![
            Value::Bytes(chat_id.as_bytes()),
            Value::Bytes(leaver.as_bytes()),
        ],
    ))
}

/// `kickId = H("gossip.groups.kick.1", chat_id, removedGossipId)` (§5.6).
#[must_use]
pub fn kick_id(chat_id: &ChatId, removed: &GossipId) -> KickId {
    KickId::from_bytes(h(
        DOMAIN_KICK,
        vec![
            Value::Bytes(chat_id.as_bytes()),
            Value::Bytes(removed.as_bytes()),
        ],
    ))
}

/// `dissolveId = H("gossip.groups.dissolve.1", chat_id, must_delete)` (§5.8), with
/// `must_delete` a CBOR boolean.
#[must_use]
pub fn dissolve_id(chat_id: &ChatId, must_delete: bool) -> DissolveId {
    DissolveId::from_bytes(h(
        DOMAIN_DISSOLVE,
        vec![Value::Bytes(chat_id.as_bytes()), Value::Bool(must_delete)],
    ))
}

/// `syncObjId = H("gossip.groups.sync_obj_name.1", name)` of a registered name (§3), with the
/// name a CBOR text string.
#[must_use]
pub fn registered_sync_obj_id(name: &str) -> SyncObjId {
    SyncObjId::from_bytes(h(DOMAIN_SYNC_OBJ_NAME, vec![Value::Text(name)]))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn chat() -> ChatId {
        ChatId::from_bytes([0x11; 32])
    }
    fn gid() -> GossipId {
        GossipId::from_bytes([0x22; 32])
    }
    fn challenge() -> Challenge {
        Challenge::from_bytes([0x33; 32])
    }

    #[test]
    fn projection_layout() {
        // ["gossip.groups.leave.1", h'11..', h'22..']
        let p = projection(
            DOMAIN_LEAVE,
            vec![Value::Bytes(&[0x11; 32]), Value::Bytes(&[0x22; 32])],
        );
        let mut expected = vec![0x83, 0x60 + 21];
        expected.extend_from_slice(DOMAIN_LEAVE.as_bytes());
        expected.extend_from_slice(&[0x58, 0x20]);
        expected.extend_from_slice(&[0x11; 32]);
        expected.extend_from_slice(&[0x58, 0x20]);
        expected.extend_from_slice(&[0x22; 32]);
        assert_eq!(p, expected);
        assert_eq!(
            h(
                DOMAIN_LEAVE,
                vec![Value::Bytes(&[0x11; 32]), Value::Bytes(&[0x22; 32])]
            ),
            *blake3::hash(&expected).as_bytes()
        );
    }

    // Fixed test vectors: computed once with this implementation and pinned.
    #[test]
    fn vectors() {
        assert_eq!(
            hex::encode(parent_commitment(&challenge(), &chat()).as_bytes()),
            "b78dada8f48bbd063eb0ba83bd517722d2bbd18dff0d3aaff5507973c7f1bd1b"
        );
        assert_eq!(
            hex::encode(ref_chat_id(&challenge(), &chat()).as_bytes()),
            "8dad61fafedcd7fade8d6e1d66d2312c33293198672d0b83eaca4c6d41db4bf2"
        );
        assert_eq!(
            hex::encode(
                secret_proof(
                    &chat(),
                    &GroupSecret::from_bytes([0x44; 32]),
                    &EventId::new(1_700_000_000_000, [0x55; 16])
                )
                .as_bytes()
            ),
            "f96f0d51179492c6ba9ae549f84672bdf9f9b7a215d54cb00244c2b32928228f"
        );
        assert_eq!(
            hex::encode(leave_id(&chat(), &gid()).as_bytes()),
            "8be3b27e4e622f9c7ab0c6f4b460383f36ef2437a3d71d393d9e78357313b458"
        );
        assert_eq!(
            hex::encode(kick_id(&chat(), &gid()).as_bytes()),
            "c00ac050599dc21b553a2451dd0cedd3ea209a2c7db0f01c4e759517e444fb4d"
        );
        assert_eq!(
            hex::encode(dissolve_id(&chat(), false).as_bytes()),
            "7fd12e6e0c3159fe5506e32346229699f8afa8c10d7b96a5378624c81a0b1d91"
        );
        assert_eq!(
            hex::encode(dissolve_id(&chat(), true).as_bytes()),
            "2d71bddd3a5785f9c0726c225ca6f25def8b46d7be5a76aec129483a992ef180"
        );
        assert_eq!(
            hex::encode(registered_sync_obj_id("gossip.groups.message.picture").as_bytes()),
            "a7bab16213569600fa16199da6d2db6bf659d9ff9f4c2bbdbbb7dffbb4e71ad8"
        );
    }

    #[test]
    fn domains_separate_identical_inputs() {
        // A leave and a kick for the same epoch and member never share an ID.
        assert_ne!(
            leave_id(&chat(), &gid()).as_bytes(),
            kick_id(&chat(), &gid()).as_bytes()
        );
        assert_ne!(dissolve_id(&chat(), false), dissolve_id(&chat(), true));
        // The commitment depends on the challenge and on the parent.
        assert_ne!(
            parent_commitment(&challenge(), &chat()),
            parent_commitment(&Challenge::from_bytes([0x34; 32]), &chat())
        );
        assert_ne!(
            parent_commitment(&challenge(), &chat()).as_bytes(),
            ref_chat_id(&challenge(), &chat()).as_bytes()
        );
    }
}
