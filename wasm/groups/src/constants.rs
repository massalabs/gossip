//! The fixed numbers of wire version 1 (§2.2), also reachable as [`crate::fixed`]: the
//! registry of Appendix A, the version numbers of §13.1, and every limit and time that decides
//! validity or a deadline other devices rely on (§3, §4, §6, §7, §11.3, §13.10). Nothing here
//! is local policy: changing a number means a new wire version. What this device chooses for
//! itself (what it sends, how long it waits, how much it keeps) is in
//! [`crate::node::policy`], never here, and no constant serves both roles.

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
/// Sync-object ID of a reaction (§7.6).
pub const DOMAIN_REACTION: &str = "gossip.groups.reaction.1";

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
/// (number 10 of `MessagePayload`) with every entry written in full, computed from the
/// decoded map. For each entry: the field key (1 byte), the varint length of the entry,
/// then the key as field 1 and the value as field 2 (each 1 byte of field key, a varint
/// length and the bytes), both counted even when empty: the largest standard encoding, an
/// upper bound for every protobuf library. Every device computes the same value from the
/// decoded map, whatever encoding it received; see [`crate::wire::metadata_len`].
///
/// The framing is counted, so that many small entries cannot make the encoded metadata
/// several times larger than the limit.
pub const MAX_METADATA_BYTES: usize = 16_384;
/// Metadata key that carries reply targets (§7.6, Appendix C).
pub const METADATA_KEY_REPLY_TO: &str = "replyTo";
/// Maximum size of the emoji of a reaction, in encoded UTF-8 bytes; at least one byte (§7.6).
pub const MAX_EMOJI_BYTES: usize = 64;
/// Maximum size of the mimetype of a media message, `type/subtype`, in bytes (§7.6).
pub const MAX_MIMETYPE_BYTES: usize = 127;

/// Maximum size of a group plaintext: version prefix, all frames and events (§13.10).
///
/// 56 KiB, so that a full plaintext, once wrapped in a session message of the group type and
/// encrypted in the session (at most 3,632 bytes more), fits one 65,536-byte mesh payload.
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
/// Clock tolerance for an event timestamp: `ts ≤ now + 5 min` (§7.2).
pub const EVENT_TIMESTAMP_TOLERANCE_MS: u64 = 300_000;
/// The largest `ttl` of a received query: 24 h; a query with a larger one is ignored
/// (§11.3, §13.3).
pub const MAX_TTL_MS: u64 = 86_400_000;
/// The clock tolerance of a received query: `sent_at ≤ now + 5 min`, and the margin of its
/// receiver deadline (§11.3).
pub const QUERY_CLOCK_TOLERANCE_MS: u64 = 300_000;

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
            DOMAIN_REACTION,
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
        // A mesh payload is at most 65,536 bytes. Wrapping a group plaintext in a session
        // message of the group type and encrypting it in the session adds at most 3,632 bytes,
        // as measured by gossip-sdk/test/integration/group-plaintext-size.spec.ts.
        const MESH_PAYLOAD_BYTES: usize = 65_536;
        const SESSION_OVERHEAD_BYTES: usize = 3_632;
        const { assert!(MAX_PLAINTEXT_BYTES + SESSION_OVERHEAD_BYTES <= MESH_PAYLOAD_BYTES) };
    }

    /// Every fixed number of wire version 1, by literal (§2.2): an accidental change fails
    /// here. The field numbers and enum values are pinned in `wire::proto`.
    #[test]
    fn every_fixed_number_is_pinned() {
        let strings = [
            (DOMAIN_ROOT, "gossip.groups.root.1"),
            (DOMAIN_PREDECESSOR, "gossip.groups.predecessor.1"),
            (DOMAIN_REFERENCE, "gossip.groups.reference.1"),
            (DOMAIN_LEAVE, "gossip.groups.leave.1"),
            (DOMAIN_KICK, "gossip.groups.kick.1"),
            (DOMAIN_DISSOLVE, "gossip.groups.dissolve.1"),
            (DOMAIN_SECRET_PROOF, "gossip.groups.message.secret_proof.1"),
            (DOMAIN_RESULT, "gossip.groups.message.result.1"),
            (DOMAIN_SYNC_OBJ_NAME, "gossip.groups.sync_obj_name.1"),
            (DOMAIN_REACTION, "gossip.groups.reaction.1"),
            (CONTEXT_ROOT_SIGNATURE, "gossip.groups.root.signature.1"),
            (CONTEXT_LEAVE_SIGNATURE, "gossip.groups.leave.signature.1"),
            (CONTEXT_KICK_SIGNATURE, "gossip.groups.kick.signature.1"),
            (
                CONTEXT_DISSOLVE_SIGNATURE,
                "gossip.groups.dissolve.signature.1",
            ),
            (METADATA_KEY_REPLY_TO, "replyTo"),
        ];
        for (got, want) in strings {
            assert_eq!(got, want);
        }
        let numbers: [(u64, u64); 27] = [
            (PROTOCOL_VERSION, 1),
            (EVENT_VERSION, 1),
            (ID_SIZE as u64, 32),
            (EVENT_ID_SIZE as u64, 24),
            (EVENT_ID_RANDOM_SIZE as u64, 16),
            (REQUEST_ID_SIZE as u64, 16),
            (MAX_NAME_BYTES as u64, 256),
            (MIN_ROOT_PARENTS as u64, 1),
            (MAX_ROOT_PARENTS as u64, 32),
            (MIN_MEMBERS as u64, 1),
            (MAX_MEMBERS as u64, 512),
            (MAX_EVENT_PARENTS as u64, 16),
            (MAX_REPLY_TARGETS as u64, 32),
            (MAX_TEXT_BYTES as u64, 16_384),
            (MAX_METADATA_BYTES as u64, 16_384),
            (MAX_EMOJI_BYTES as u64, 64),
            (MAX_MIMETYPE_BYTES as u64, 127),
            (MAX_PLAINTEXT_BYTES as u64, 57_344),
            (MAX_EVENT_BLOB_BYTES as u64, 57_307),
            (MAX_QUERY_ENTRIES as u64, 16),
            (MAX_NOTICE_ENTRIES as u64, 128),
            (MAX_NOTICE_BYTES as u64, 16_384),
            (MAX_PAGE_ENTRIES as u64, 128),
            (MAX_PAGE_BYTES as u64, 16_384),
            (MAX_NEIGHBOR_SUGGESTIONS as u64, 10),
            (RETENTION_MS, 1_209_900_000),
            (MAX_SCHEDULE_MS, 1_209_600_000),
        ];
        for (i, (got, want)) in numbers.into_iter().enumerate() {
            assert_eq!(got, want, "number {i}");
        }
        assert_eq!(EVENT_TIMESTAMP_TOLERANCE_MS, 300_000);
        assert_eq!(MAX_TTL_MS, 86_400_000);
        assert_eq!(QUERY_CLOCK_TOLERANCE_MS, 300_000);
    }

    #[test]
    fn schedule_bound_is_retention_minus_five_minutes() {
        assert_eq!(MAX_SCHEDULE_MS, RETENTION_MS - 5 * 60 * 1000);
    }
}
