//! Protocol constants: the registry of Appendix A, the version numbers of §13.1 and the
//! limits of §3, §4, §6, §7 and §13.10.

// ── Hash domains (Appendix A) ────────────────────────────────────────────────

/// Root ID, which is the `chat_id` (§4.1).
pub const DOMAIN_ROOT: &str = "gossip.groups.root.1";
/// Parent commitment (§4.5).
pub const DOMAIN_PREDECESSOR: &str = "gossip.groups.predecessor.1";
/// `ref_chat_id` (§4.5).
pub const DOMAIN_REFERENCE: &str = "gossip.groups.reference.1";
/// `leaveId` (§5.3).
pub const DOMAIN_LEAVE: &str = "gossip.groups.leave.1";
/// `kickId` (§5.6).
pub const DOMAIN_KICK: &str = "gossip.groups.kick.1";
/// `dissolveId` (§5.8).
pub const DOMAIN_DISSOLVE: &str = "gossip.groups.dissolve.1";
/// `secret_proof` (§4.2).
pub const DOMAIN_SECRET_PROOF: &str = "gossip.groups.message.secret_proof.1";
/// Message result hash (§6.2).
pub const DOMAIN_RESULT: &str = "gossip.groups.message.result.1";
/// Sync-object ID of a registered name (§3).
pub const DOMAIN_SYNC_OBJ_NAME: &str = "gossip.groups.sync_obj_name.1";

// ── ML-DSA-65 signing contexts (Appendix A) ─────────────────────────────────

/// Context of the root signature, over the 32-byte root ID.
pub const CONTEXT_ROOT_SIGNATURE: &str = "gossip.groups.root.signature.1";
/// Context of the leave signature, over the 32-byte `leaveId`.
pub const CONTEXT_LEAVE_SIGNATURE: &str = "gossip.groups.leave.signature.1";
/// Context of the kick signature, over the 32-byte `kickId`.
pub const CONTEXT_KICK_SIGNATURE: &str = "gossip.groups.kick.signature.1";
/// Context of the dissolve signature, over the 32-byte `dissolveId`.
pub const CONTEXT_DISSOLVE_SIGNATURE: &str = "gossip.groups.dissolve.signature.1";

// ── Versions (§13.1, D.11) ───────────────────────────────────────────────────

/// The plaintext prefix version this implementation speaks (and the only one it supports).
pub const PROTOCOL_VERSION: u64 = 1;
/// The event prefix version this implementation creates (and the only one it supports).
pub const EVENT_VERSION: u64 = 1;

// ── Identifier sizes (§3) ────────────────────────────────────────────────────

/// Size of every 32-byte identifier (`chat_id`, GossipID, hash IDs, secrets, challenges).
pub const ID_SIZE: usize = 32;
/// Size of an `eventId`: 8-byte big-endian timestamp followed by 16 random bytes.
pub const EVENT_ID_SIZE: usize = 24;
/// Size of the random part of an `eventId`.
pub const EVENT_ID_RANDOM_SIZE: usize = 16;
/// Size of a `request_id`.
pub const REQUEST_ID_SIZE: usize = 16;

// ── Limits (§4, §6, §7.6, §13.10) ────────────────────────────────────────────

/// Maximum size of a group name, in encoded UTF-8 bytes (§4.1, §5.11).
pub const MAX_NAME_BYTES: usize = 256;
/// Minimum number of parent commitments in a root (§4.1).
pub const MIN_ROOT_PARENTS: usize = 1;
/// Maximum number of parent commitments in a root (§4.1, §4.5; provisional).
pub const MAX_ROOT_PARENTS: usize = 32;
/// Minimum number of members of an epoch (§4.1).
pub const MIN_MEMBERS: usize = 1;
/// Maximum number of members of an epoch, the owner included (§4.4; provisional).
pub const MAX_MEMBERS: usize = 512;
/// Maximum number of parents of a message event (§6.1).
pub const MAX_EVENT_PARENTS: usize = 16;
/// Maximum number of reply targets of one message (§7.6).
pub const MAX_REPLY_TARGETS: usize = 32;
/// Maximum size of the text of a message version, in encoded UTF-8 bytes: the body of a
/// `text` result, and the content of a `forward` whose `content_type` is `text` (§6.2).
pub const MAX_TEXT_BYTES: usize = 16_384;
/// Maximum size of the metadata of a message version (§6.2): the size of the `metadata` field
/// (number 10 of `MessagePayload`) in its canonical protobuf encoding, computed from the
/// decoded map. For each entry, in key order: the field key (1 byte), the varint length of
/// the entry, then the key as field 1 and the value as field 2 (each 1 byte of field key, a
/// varint length and the bytes), a field left out when its key or value is empty. Every
/// device computes the same value from the decoded map, whatever encoding it received; see
/// [`crate::wire::metadata_len`].
///
/// The framing is counted, so that many small entries cannot make the encoded metadata
/// several times larger than the limit.
pub const MAX_METADATA_BYTES: usize = 16_384;
/// Metadata key that carries reply targets (§7.6, Appendix C).
pub const METADATA_KEY_REPLY_TO: &str = "replyTo";

/// Maximum size of a group plaintext: version prefix, all frames and events (§13.10).
///
/// 56 KiB, so that a full plaintext, once wrapped and encrypted in a one-to-one session (at
/// most 3,634 bytes more), fits one 65,536-byte mesh payload.
pub const MAX_PLAINTEXT_BYTES: usize = 57_344;
/// Maximum size of an event blob: alone in a response frame with a full `request_id` and the
/// longest `idx`, the largest frame that can carry it, the plaintext is at most
/// [`MAX_PLAINTEXT_BYTES`] (§4.6, §13.10, which state the bound for an event frame: 28 bytes
/// more). Checked against the encoding by the wire tests.
pub const MAX_EVENT_BLOB_BYTES: usize = 57_307;
/// Maximum number of entries in one query frame (§13.3, §13.10).
pub const MAX_QUERY_ENTRIES: usize = 16;
/// Maximum number of entries in a notice (§13.5, §13.10; provisional).
pub const MAX_NOTICE_ENTRIES: usize = 128;
/// Maximum encoded size of a notice (§13.5, §13.10; provisional).
pub const MAX_NOTICE_BYTES: usize = 16 * 1024;
/// Maximum number of entries in a page (§12.1, §13.10).
pub const MAX_PAGE_ENTRIES: usize = 128;
/// Maximum encoded size of a page (§13.10; provisional).
pub const MAX_PAGE_BYTES: usize = 16 * 1024;
/// Maximum number of suggestions in a neighbor response (§13.6).
pub const MAX_NEIGHBOR_SUGGESTIONS: usize = 10;

// ── Timing constants (§3, §7.2, Appendix B) ──────────────────────────────────

/// Message retention period `RETENTION`, in milliseconds (two weeks plus five minutes).
pub const RETENTION_MS: u64 = 1_209_900_000;
/// Scheduling limit `MAX_SCHEDULE`, in milliseconds (two weeks).
pub const MAX_SCHEDULE_MS: u64 = 1_209_600_000;
/// Invitation delay `PROMPT_DELAY`, in milliseconds (five minutes, §4.8).
pub const PROMPT_DELAY_MS: u64 = 300_000;
/// Clock tolerance for an event timestamp: `ts ≤ now + 5 min` (§7.2).
pub const EVENT_TIMESTAMP_TOLERANCE_MS: u64 = 300_000;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn signing_contexts_are_distinct_from_hash_domains() {
        let domains = [
            DOMAIN_ROOT,
            DOMAIN_PREDECESSOR,
            DOMAIN_REFERENCE,
            DOMAIN_LEAVE,
            DOMAIN_KICK,
            DOMAIN_DISSOLVE,
            DOMAIN_SECRET_PROOF,
            DOMAIN_RESULT,
            DOMAIN_SYNC_OBJ_NAME,
        ];
        let contexts = [
            CONTEXT_ROOT_SIGNATURE,
            CONTEXT_LEAVE_SIGNATURE,
            CONTEXT_KICK_SIGNATURE,
            CONTEXT_DISSOLVE_SIGNATURE,
        ];
        let mut all: Vec<&str> = domains.iter().chain(contexts.iter()).copied().collect();
        let before = all.len();
        all.sort_unstable();
        all.dedup();
        assert_eq!(all.len(), before);
        for d in domains {
            assert!(d.starts_with("gossip.groups.") && d.ends_with(".1"));
        }
        for c in contexts {
            assert!(c.starts_with("gossip.groups.") && c.ends_with(".signature.1"));
            // ML-DSA contexts are at most 255 bytes.
            assert!(c.len() <= 255);
        }
    }

    #[test]
    fn a_full_container_fits_one_mesh_payload_once_encrypted() {
        // A mesh payload is at most 65,536 bytes. Wrapping a group plaintext in a keep-alive
        // and encrypting it in the one-to-one session adds at most 3,634 bytes, as measured
        // by gossip-sdk/test/integration/group-plaintext-size.spec.ts.
        const MESH_PAYLOAD_BYTES: usize = 65_536;
        const SESSION_OVERHEAD_BYTES: usize = 3_634;
        const { assert!(MAX_PLAINTEXT_BYTES + SESSION_OVERHEAD_BYTES <= MESH_PAYLOAD_BYTES) };
    }

    #[test]
    fn schedule_bound_is_retention_minus_five_minutes() {
        assert_eq!(MAX_SCHEDULE_MS, RETENTION_MS - 5 * 60 * 1000);
    }
}
