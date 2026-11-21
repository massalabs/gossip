# Gossip Groups: plausibly deniable group chats

Protocol specification, wire version 1.

This document is self-contained.
It specifies trusted group chats for Gossip over asynchronous peer-to-peer Agraphon sessions.
A group has one owner, who alone changes its member list; its messages are unsigned and deniable.
Direct chats are the two-member case of the same protocol: a conversation between two people is a
group of two, and there is no other conversation format (§2.1).
Normative rules use **MUST**, **MUST NOT**, **SHOULD** and **MAY**.
Short _Why_ notes explain the reason for a rule in place; they are not additional requirements.

**Status: experimental.** Several prerequisites (crash-safe session/outbox integration, measured
resource limits, residual-state testing) are not yet met; see §17.
No production-ready or security-complete claim may be made until they are.

**Open decisions.** Some rules are written but not yet confirmed, and §16 is not yet revised;
Appendix D lists them with their choices.

## 1. Conventions

### 1.1 Serialization

All group-protocol wire data is serialized with Protocol Buffers (proto3), after a varint protocol
version prefix (§13.1).
The schema is in Appendix C. Protobuf bytes are never hashed: two encodings of the same field
values are the same frame.

Receivers MUST reject a frame that contains unknown fields, unknown enum values or an unknown
`oneof` case, except inside a query entry, where only that entry is rejected (§13.7, §13.8).
Identifiers are protobuf `bytes` fields of the exact length stated in §3; any other length is
malformed.
A proto3 scalar that a rule requires to be absent MUST hold its default value.

All integers are unsigned 64-bit values unless stated otherwise.
Arithmetic on them MUST be checked or widened; results that cannot be represented MUST cause
rejection, never wraparound, silent clamping or lossy conversion.
All timestamps are u64 Unix milliseconds; all durations are u64 milliseconds.

All text is UTF-8.
Text that is not valid UTF-8 makes the object that carries it malformed, and every text limit
counts encoded bytes, not characters.

### 1.2 Hashing

`H` is BLAKE3 with a 32-byte output (the Massa hash primitive).
Every protocol hash is computed over a deterministic CBOR array (RFC 8949
§4.2.1, core deterministic encoding) whose first element is a domain string:

```text
H(domain, a, b, ...) = BLAKE3(CBOR([domain, a, b, ...]))
```

Hash inputs are CBOR projections built from the parsed protobuf fields, as defined at each use.
They use only unsigned integers, byte strings, UTF-8 text strings, arrays, maps, booleans and null.
Identifiers are CBOR byte strings.

Hash inputs MUST NOT include local bookkeeping, the hashed object's own ID or response-wrapper
correlation fields.
Hashes and event IDs compare as unsigned big-endian integers, which equals lexicographic byte
order.

_Why:_ protobuf keeps the wire format extensible and compact, while the fixed CBOR projection keeps
every hash reproducible across implementations, whatever protobuf encoder produced the bytes.

### 1.3 Naming

Protocol strings use the form `gossip.groups.<level>.<level>…`.
Dots separate levels; an underscore joins the words of one multi-word level (`sync_obj_name`,
`secret_proof`).
Hash domains end in a version suffix (`.1`).
Signing contexts use the same form and end in `.signature.1`.
Registered object names are unversioned.
The full registry is in Appendix A.

### 1.4 Terminology

- **Epoch:** one fixed member list with one group secret and one event DAG, founded by one root and
  identified by its `chat_id`.
  In protocol rules the word _chat_ means an epoch, as in `chat_id`.
- **Group:** what the user sees as one conversation: the epochs connected by parent links (§4.5),
  plus the links the user made by hand (§5.10).
  It is also called the logical chat.
- **Root:** the signed record that founds an epoch (§4.1).
  It is not a DAG node.
- **Owner:** the member named in a root's `owner` field; the only identity that can create the
  group's next roots.
- **Successor:** a root that names an epoch as one of its parents; also the epoch it founds.
- **Superseded epoch:** an epoch for which the device has installed a successor.
- **End:** an installed epoch with no installed successor (§4.9).
- **Current epoch:** the end of a group in which the device sends new messages (§4.9, §5.9).
- **Signed object:** a leave, a kick or a dissolve message (§5.1), identified by a 32-byte hash.
- **Message event:** a `GROUP_MESSAGE_EVENT`; one DAG node carrying one message result.
- **Event:** a message event, identified by its `eventId`.
- **Sync object:** the logical message an event updates, identified by its `syncObjId` within the
  epoch.
- **Result:** the complete current value of a sync object.
  Events carry complete results, never commands.
- **Tip:** an available event that no known accepted event references as a parent (§12.1).
- **Gossip notice:** an announcement of an event, a root or a signed object by its ID, without its
  content.
- **Available:** an event whose full content this device currently retains and may serve.
- **Pruned:** a message event whose content access was removed; a generic ID stub remains.
- **Member:** a GossipID in an epoch's member list.
- **Removed peer:** for a superseded epoch, a member of that epoch who is not a member of the
  device's current epoch (§10.4).
- **Neighbor:** a member with whom we hold a neighbor connection for a group (§10.1).
- **Local-only:** never transmitted or hashed.

## 2. Model overview

A **group** is what the user sees as one conversation.
It is made of **epochs**.
An epoch has a fixed member list, a group secret and one event DAG, and is identified by its
`chat_id`.

Each epoch is founded by a **root**: a record signed by the group's **owner**, whose ID is a hash
of its content.
Changing the member list, the group name or the owner means creating a new root, which names the
epoch it continues through a parent commitment (§4.5).
Only the owner can create a root; every member can relay one.

Message events hold ordinary content: they are unsigned, can be edited, deleted, relayed or
fabricated by any member of their epoch, and each names up to 16 childless events of its epoch as
parents.
Each message event carries a complete result.
Devices merge results deterministically, idempotently, associatively and commutatively, so honest
devices that receive the same results converge regardless of arrival order (honest events form a
CRDT).

Peers announce events and roots through gossip notices, fetch missing events by ID or by sync
object, discover missed events by scanning the tips of neighbors and random members and walking
parent links, and periodically repeat this as a last-resort recovery.
There is one such recovery system per group, whatever its number of epochs (§12.1).

Four kinds of record are signed, all with ML-DSA-65: the root, the kick and the dissolve message
(by the owner), and the leave message (by the member who leaves).
Message events are never signed.
Membership is enforced by the authenticated Agraphon peer, by the member list of the signed root,
and by knowledge of the epoch's group secret.

A member leaves by a signed leave message, by an unsigned request to the owner, or silently (§5.2).
The owner removes members, hands the group over to another member, or dissolves it (§5).

_Why:_ unsigned messages keep every message deniable, while a signed root gives all members one
verifiable member list and lets a group change its members without becoming an unrelated chat.

### 2.1 Sessions are channels, conversations are groups

An Agraphon session between two devices is a **communication channel** and nothing more.
It carries group traffic between two members; it is not itself a conversation and shows nothing
to the user.

- Every conversation is a group, a conversation between two people included.
- A client of this protocol does not send, receive or display the earlier one-to-one conversation
  format. A device or a backup that moves to this protocol archives its earlier one-to-one
  conversations: they stay readable on that device and are never written to again.
- A client that has not moved to this protocol is unsupported: it cannot take part in a group, and
  no rule here is shaped to accommodate it.
- Each kind of thing sent in a session has **its own message type** (§13.1). A type is never
  reused to carry something else: a keep-alive keeps a session alive and carries nothing.

- Keep-alives belong to the session layer and to a **connection**, never to a conversation: a
  device keeps its connections with peers alive, whatever groups use them. The group layer sits on
  top and neither sends nor interprets keep-alives.

_Why:_ one format for all conversations gives direct chats the same deniability, editing and
deletion as groups, and a type that means one thing can be handled, limited and reasoned about on
its own.

Direct chats, contacts, automatic connections and the migration of earlier conversations are
specified in §5.12.

### 2.2 Compatibility within wire version 1

Every implementation of wire version 1, whatever its release, MUST interoperate with every other
without breaking it. A later release may improve its own local behaviour: its timing, its choice of
peers, its retries. This is expected to help mixed groups too. No device detects or depends on the
release of a peer: this is an expectation, not a rule anything relies on.
The rules of this document are therefore of two kinds.

**Fixed for the whole of wire version 1.** They cannot change without a new wire version:

- every format: identifiers, hash projections, signatures and their contexts, protobuf schemas,
  frames, status codes, size limits that decide validity;
- every validity and authorization rule: what makes a root, a signed object, an event or a frame
  valid or malformed, and who may be answered;
- how a device answers each query and how it reacts to each frame and status it receives;
- when a device stays silent, wherever the text says the choice protects deniability, for example
  toward a peer that is not a member.

The wire format is closed and final once the first release is out: no frame kind, query
operation, status, field or enum value is ever added to wire version 1. Anything of wire version 1
that is not valid under these rules is rejected and counts against its sender (§11.8). A plaintext
of a higher wire version is not processed and never penalised; when it comes from a contact the
user accepted, it is answered once with a notice that names the version this device speaks
(§13.8).

**May change, case by case.**

- **Merge rules.** A release may change them, for a bug fix, a better algorithm or a different
  tradeoff between security and convergence. Devices on different releases may then settle on
  different results for the same events. A change MUST NOT create an interaction that never
  settles between a device on the old rule and one on the new: each must reach a stable state and
  stop sending.
- **Silence elsewhere.** Where staying silent does not protect deniability, a release may start or
  stop answering, one case at a time. A requester never depends on it either way: silence is a
  valid outcome of any request.

**Local policy.** A release may change these freely, and peers MUST NOT rely on another device's
choice:

- how many neighbors a device keeps and how it chooses and replaces them;
- how it scores peers and ranks candidates;
- periods, delays, time-to-live progressions, jitter and retry counts;
- how many peers it asks, in what order, and how much it sends per period;
- its own budgets, queue sizes and when it answers `busy`.

Two obligations make the split hold:

- **A requester tolerates any policy.** `busy`, "not available", `expired`, `restart`, silence, a
  shorter page or fewer suggestions than expected are all valid answers at any rate, and never
  make a peer malformed. No rule may assume a peer's neighbor count, timing, fan-out or limits.
- **Penalties attach to fixed rules only.** A device penalises what is malformed, unauthorized or
  false under the fixed rules. Being asked or told more or less often than its own policy would do
  is answered with the fixed statuses (`busy`, silence), never treated as a protocol violation.

Numbers in this document that belong to local policy are defaults. Where a number is fixed, the
text says so or the number decides validity.

_Why:_ improving recovery, scoring and pacing release after release must make a group more stable
as its members update, without ever cutting off those who have not.

## 3. Identifiers and constants

- Identifier: `eventId`
  - Size: 24 bytes
  - Generation: 8-byte big-endian timestamp ‖ 16 cryptographically random bytes

- Identifier: `chat_id` (the root ID, the epoch ID)
  - Size: 32 bytes
  - Generation: hash of the root's content (§4.1)

- Identifier: `secret_proof`
  - Size: 32 bytes
  - Generation: §4.2

- Identifier: GossipID
  - Size: 32 bytes
  - Generation: `BLAKE3(bincode(UserPublicKeys))` of the identity

- Identifier: `syncObjId`
  - Size: 32 bytes
  - Generation: cryptographically random, or a registered name hash

- Identifier: `group_secret`
  - Size: 32 bytes
  - Generation: cryptographically random, fresh per epoch

- Identifier: `epoch_challenge`, `ref_chat_id_challenge`
  - Size: 32 bytes each
  - Generation: cryptographically random, independent, fresh per epoch (§4.5)

- Identifier: parent commitment
  - Size: 32 bytes
  - Generation: §4.5

- Identifier: `ref_chat_id`
  - Size: 32 bytes
  - Generation: §4.5

- Identifier: `leaveId`, `kickId`, `dissolveId`
  - Size: 32 bytes each
  - Generation: §5.3, §5.6, §5.8

- Identifier: `scanId`
  - Size: 32 bytes
  - Generation: cryptographically random, chosen by the requester

- Identifier: `request_id`
  - Size: 16 bytes
  - Generation: cryptographically random, chosen by the requester, fresh for every query frame sent
    (including resends)

**Event IDs.** The first 8 bytes of an event ID are its **event timestamp** `ts`: the creator's
clock at creation, as a big-endian u64 of Unix milliseconds.
The remaining 16 bytes are fresh random bytes.
Because the timestamp comes first, byte order of event IDs is chronological order of their claimed
creation, with random tie-breaking.
The event timestamp is a claim, not a proof.

_Why:_ a timestamp inside the ID gives every device the same age for an event, so retention and
ordering no longer depend on when each device happened to receive it.

**Hash IDs.** A root, a leave, a kick and a dissolve message are identified by a 32-byte hash of
their content.
They are not DAG nodes: they are never a parent or a tip, and their IDs are never used where an
event ID is expected.
The different lengths (24 and 32 bytes) keep the two kinds apart.

A registered name's sync-object ID is:

```text
syncObjId = H("gossip.groups.sync_obj_name.1", name)
```

Registered names are fully qualified under `gossip.groups.message.*` (for example a future group
picture, `gossip.groups.message.picture`), contain no protocol version, and keep their meaning
forever.
None are registered yet (Appendix A).

Event lookup identity is always `(chat_id, eventId)` and sync-object identity is
`(chat_id, syncObjId)`.
Equal ID bytes in different epochs are unrelated.

The message retention period `RETENTION` is the protocol constant 1,209,900,000 ms (two weeks plus
five minutes).
The scheduling limit `MAX_SCHEDULE` is the protocol constant 1,209,600,000 ms (two weeks).
The invitation delay `PROMPT_DELAY` is the protocol constant 300,000 ms (five minutes, §4.8).
The other timing constants are in Appendix B.

## 4. Epochs and roots

### 4.1 The root

A root founds one epoch.
It carries:

| Field                   | Rule                                                                                                                              |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `version`               | the root's version prefix, `1` (§13.1)                                                                                            |
| `type`                  | `successor` (0) or `handover` (1) (§4.7)                                                                                          |
| `name`                  | the group name: UTF-8, 0 to 256 bytes (§5.11)                                                                                     |
| `parents`               | 1 to 32 parent commitments, 32 bytes each, distinct, sorted ascending (§4.5)                                                      |
| `members`               | 1 to 512 GossipIDs, distinct, nonzero, sorted ascending by raw bytes (§4.4)                                                       |
| `group_secret`          | 32 fresh random bytes                                                                                                             |
| `owner`                 | the owner's complete `UserPublicKeys`, serialized with bincode (§4.3)                                                             |
| `epoch_challenge`       | 32 fresh random bytes (§4.5)                                                                                                      |
| `ref_chat_id_challenge` | 32 fresh random bytes (§4.5)                                                                                                      |
| `created_at`            | the creator's clock at creation, u64 Unix milliseconds; a claim                                                                   |
| `migrate_from`          | optional: the protocol version of the conversation this group continues (§5.12, Appendix A); `0` is the earlier one-to-one format |
| `message_timer`         | the message timer: u64 milliseconds; `0`, absent on the wire, keeps messages forever                                              |
| `settings`              | the settings map: text keys to byte values, at most 128 entries, empty when unused (below)                                        |
| `signature`             | an ML-DSA-65 signature over the root ID (below)                                                                                   |

The root has no event ID, no parents in the DAG sense and no payload.
Its only identifier is the **root ID**, which is also the epoch's `chat_id`:

```text
chat_id = H("gossip.groups.root.1",
            version, type, name, parents, members, group_secret, owner,
            epoch_challenge, ref_chat_id_challenge, created_at, migrate_from,
            message_timer, settings)
```

In this projection `version`, `type`, `created_at` and `message_timer` are unsigned integers,
`name` is a text string, `parents` and `members` are arrays of byte strings in their sorted order,
`migrate_from` is an array holding its one unsigned integer when the field is present and the
empty array when it is absent, `settings` is a CBOR map from text strings to byte strings in the
canonical key order (§1.2), as a message's metadata (§6.2), and the other fields are byte strings.
`message_timer` is hashed as `0` when it is absent, and `settings` as the empty map.
The signature and the ID itself are not hashed.

The **signature** is computed over the 32 bytes of the root ID, with the ML-DSA-65 signing context
`gossip.groups.root.signature.1`.
Who signs depends on the root's type (§4.7).
The signature travels with the root and is checked by every device that receives it.

The member list, the name, the owner, the message timer and the settings map are fixed for the
epoch's lifetime.
Changing any of them means creating a new root.

**The message timer** has one single form: a plain proto3 integer, absent on the wire when it is
`0`, read as `0` when absent, and always hashed as an unsigned integer. Every value is valid: a
root is never invalid because of its timer. What it does is in §7.7.
_Why one form:_ two forms of "no timer" would give two root IDs for the same content.

**The settings map** is handled exactly as a message's metadata map: the same hash form and key
order, and the same size measure (§13.10, every entry counting its key field and its value field).
Its limits decide validity:

- at most 128 entries, and at most 16,384 bytes by that measure;
- each key is valid UTF-8 of 1 to 64 bytes;
- a key given twice makes the root malformed;
- absent and empty are the same thing.

Version 1 knows no key. A device keeps and hashes every entry, relays it unchanged, and never acts
on one; an unknown key never makes a root invalid.
_Why:_ only the owner can set or change a future group setting, because the map is hashed and
signed with the root. Unknown keys are kept so that a later release can define settings without a
new wire version. A key given twice is refused because protobuf decoders differ on which value
they keep, and the two would hash different maps.

**Carried forward.** When the owner's device builds the next root (a member change, a rename, a
handover, the automatic successor after a leave or a request, a fork resolution), it copies the
message timer and the whole settings map of its current epoch unchanged, entries it does not
understand included, unless the owner changes the timer in that action (§7.7).
_Why:_ an owner on an older release must not silently erase settings made by a newer one.
A receiver puts no validity rule between a root's timer or settings and those of its parents.
_Why:_ such a rule could not be checked by a member that lacks the parents (§4.5), and two
members would then judge the same root differently.

_Why:_ hashing every field into the ID means that two different member lists, names, secrets,
owners or parents can never claim the same epoch, that a relayer cannot alter a field under a valid
signature, and that the ID stays unpredictable to anyone who has not seen the secret.
One identifier serves as root ID, epoch ID and `chat_id`, because every use of `chat_id` only needs
"the name of this epoch".

### 4.2 Secret proof

Every message event carries:

```text
secret_proof = H("gossip.groups.message.secret_proof.1", chat_id, group_secret, eventId)
```

Receivers MUST recompute it and reject the event on a mismatch.

It proves that whoever built the event knew the epoch's group secret, and it ties that proof to the
event's own ID, so it cannot be moved onto another event ID.
It covers no content and identifies no author, so any member of the epoch can produce it for any
event.
An unchanged event can be replayed with its proof, which is harmless because events under a known
ID keep their first valid interpretation (§7.1).

Each epoch has its own secret, so a member removed from a group cannot compute the proof for events
of later epochs.

### 4.3 Owner, members and keys

**Owner.** The root carries the owner's complete `UserPublicKeys`: the ML-DSA-65 verification key
(1,952 bytes), the ML-KEM-768 key (1,184 bytes), the Massa key and the EVM key, about 3.2 KB,
serialized with bincode as the identity code does.
The field MUST be the canonical bincode encoding: a receiver parses it, encodes the parsed keys
again and refuses the root when the two differ; a key answer (§12.9) is checked the same way.
_Why:_ otherwise the same keys with bytes appended would give a second root ID for the same
content (D.15).
A recipient hashes them to the owner's GossipID and verifies the signature with the ML-DSA-65 key.
No lookup is needed to verify a root.
The owner MUST be a member of the root.

**Members.** A member is listed by its GossipID only.
The root carries no key of the other members.

**Key query.** A device obtains the full keys of a member with a key query (§12.9): it asks a peer
for the `UserPublicKeys` of a GossipID.

- The GossipID is the hash of the keys, so every answer is checked before use: an answer whose hash
  differs from the requested GossipID is invalid.
- A key query is scoped to an epoch that the requester, the responder and the subject all belong
  to, so it reveals nothing the requester could not already know.
- Verified keys are cached per identity and reused across epochs and groups.
- Keys a device already holds for an identity (an existing contact or session) need no query.

**When to fetch.** A device MUST start fetching, at once, every key it does not already hold:

- when it accepts an invitation;
- when it adopts a root that continues an epoch it already holds.

_Why:_ fetching only when a key is needed could leave a device unable to reach anyone in a group
whose members are rarely online.

A wrong answer to a key query gets the heaviest penalty of the peer score (§11.8).

A device MUST NOT send group frames to a member until that member has authenticated over the
session, through the signed Agraphon `AuthBlob` whose `UserPublicKeys` derive to the expected
GossipID.

### 4.4 Member limit

An epoch has **at most 512 members**, the owner included.

The limit is fixed for wire version 1 (§2.2): a larger group needs a new wire version.
It is not set by the container: the fixed part of a root (owner keys, signature, secret,
challenges, time and wrappers) is about 6.7 KB, and each member costs 34 encoded bytes, so about
1,490 members would fit one empty 57,344-byte container (§13.10).
At 512 members a root is about 24 KB (25,417 bytes with 32 parents and the longest name).
With a full settings map, the longest timer and `migrate_from`, the largest root is a 41,823-byte
event blob: 41,832 bytes pushed alone in a plaintext and 41,860 bytes as the answer to a chat
lookup, which leaves 15,484 bytes of the container unused.

_Why:_ with GossipIDs only, the cost of a large group is no longer the root but the keys.
At 512 members a new member downloads about 1.6 MB of keys, and the backend holds about 840 MB of
key answers across the group for two weeks.

Larger groups are deferred (§17.5).

### 4.5 Parent commitments and references

**Parent commitments.** A root names each epoch it continues by a commitment:

```text
parentCommitment = H("gossip.groups.predecessor.1", epoch_challenge, parentChatId)
```

`epoch_challenge` is the challenge of the **new** root.
`parents` is the sorted array of these commitments.

- An ordinary successor has one parent.
- A root that resolves competing branches has one parent per competing end (§4.9).
- A root that adds back a former member has one more parent per distinct last epoch of the people
  added back (§5.10).
- A root that founds a new group has exactly one commitment, computed from a fresh random 32-byte
  dummy ID that is then discarded.

A device finds a parent by computing the commitment of each root it holds, and of each closed-chat
marker (§14.2), under the new root's challenge.
A commitment that matches nothing the device holds is **unmatched**.

_Why:_ a new member learns no parent ID, while a member who already holds a parent can verify the
link.
The single dummy makes a new group look like an ordinary one-parent continuation.

Limits: anyone who knows a candidate parent ID and the challenge can test it; the number of
commitments shows that branches were merged or that someone was added back; an unmatched single
commitment never proves that an epoch is the first of its group.

**References.** An epoch's opaque self-reference is:

```text
ref_chat_id = H("gossip.groups.reference.1", ref_chat_id_challenge, chat_id)
```

with the challenge of the epoch being referenced.
A device computes and stores `ref_chat_id → chat_id` for every root it holds, installed or as an
invitation not answered yet, and keeps the reference in the closed-chat marker when it closes the
epoch (§14.2).
Replies use it to name the epoch of their target (§7.6).
It hides the epoch ID from anyone who is not a member of that epoch, but it is linkable: all
references to one epoch are equal.

### 4.6 Creating and delivering a root

**Who creates.** Any user may found a new group, and is its owner.
Only the owner of a group can create its further roots.
Every member can relay a root.

The owner's device creates a root only:

- to found a new group;
- from its current epoch, to change the member list or the name (a successor root) or to hand the
  group over (a handover root, §5.7);
- as the resolution of all the competing ends it holds (§4.9).

It MUST NOT build a root on an older epoch.

To create a root, the owner's device:

1. chooses the member list, which includes the owner, and the name, and keeps the message timer
   and the settings map (§4.1 "Carried forward");
2. generates the group secret and the two challenges;
3. computes the parent commitments (§4.5, §5.10);
4. sets `created_at = max(now, L + 1)`, where `L` is the greatest `created_at` among all the roots
   of that group it holds (for a new group, `created_at = now`), computes the root ID and signs it;
5. sends the full root, directly over Agraphon, to **every other member**;
6. sends in the same plaintext, to each member who is also in the parent epoch, the kicks of the
   members it removed (§5.6).

_Why direct delivery:_ every member must receive the full root once, whoever sends it, so the total
volume is the same in every scheme (about members × root size).
Sending directly adds no query and does not depend on a third peer being online.

**Relay.** A member that has adopted or accepted a root announces it by a **root notice**: a notice
entry carrying only the `chat_id` (§13.5).
A peer that lacks the root fetches it by chat lookup (§12.7) and checks it against that ID.

- A root notice is sent only to peers in that root's member list.
- Only a device that holds the full root and may serve it announces it.
- A root notice is acted on although the epoch is unknown to the receiver (§13.7).

_Why:_ a member whose connection with the owner is broken gets the root only through this relay, so
it is part of normal delivery.
Relaying by notice, not by resending the full root to everyone, keeps the backend, which stores
every blob for two weeks, from holding a number of copies that grows with the square of the group.

A root MUST fit one empty container (§13.10).

### 4.7 Root types and verification

There are two root types.
The type is a hashed field, so a device always knows which checks to run and one type cannot pass
for the other.

**Successor root** (the ordinary one; also used to found a group and to resolve a fork):

- it is signed by the owner named in its **own** `owner` field;
- it may add and remove members and change the name;
- it never changes the owner (§5.9 gives the single exception, for a fork).

**Handover root** (§5.7):

- it has **exactly one** parent;
- it is signed by the owner of that **parent**, while its own `owner` field names the new owner;
- its member list is exactly the parent's, except that the old owner, who signs it, may be absent
  from it; it may change the name;
- it never adds a member and never removes any member other than the old owner.

On receiving a root, a device MUST, in order:

1. validate the encoding, the type, the name (valid UTF-8, at most 256 bytes), the parents (1 to 32
   distinct 32-byte commitments, sorted), the members (1 to 512 distinct nonzero 32-byte
   GossipIDs, sorted) and the settings map (§4.1);
2. compute the root ID and, if the root was fetched after a notice, a page entry or a lookup, check
   that it equals the announced `chat_id`;
3. parse the owner keys, hash them to the owner's GossipID and check that the owner is a member;
4. check that it is itself a member;
5. check that the immediate Agraphon peer that delivered the root is a member; a handover root is
   also accepted from the owner of its held parent, who signed it and may have left in it
   ("Hand over and leave", §5.7, D.59);
6. match the parent commitments against what it holds (§4.5);
7. verify the signature:
   - **successor:** with the ML-DSA-65 key of the root's own `owner` field;
   - **handover:** the device MUST hold the parent; it verifies with the ML-DSA-65 key of that
     parent's owner, and checks that the new owner differs from the parent's owner and that every
     member of the new root is a member of the parent.

A root that fails any of these checks is discarded, and counts as a failed announcement against
the peer that supplied it (§11.8).
A handover root whose parent the device does not hold cannot be checked yet. It is **kept**,
unverified and without penalty, while its parent is looked up from the peer that delivered it, and
is checked again once the parent is held; it is dropped after two weeks if the parent never comes.
The number kept is bounded per delivering peer and per device (§17.4).
_Why kept and not discarded:_ the root may arrive before its parent, for example from the outgoing
owner of a "Hand over and leave"; discarding it would lose the handover until someone delivered it
again.
_Why the new owner must differ from the parent's owner:_ it keeps the two root types apart; a root
that keeps the owner is a successor (D.7).

**Continuity.** For a successor root, each held parent is then checked for authority.
The root's owner has authority over a held parent when:

- the parent's owner is the same identity as the root's owner; or
- the parent's owner is a **previous owner in the root's own line**: it signed a handover root that
  the device holds, on the path leading to one of the root's parents (§5.9).

A held parent over which the root's owner has no verified authority is treated as unmatched: the
root does not continue it.

_Why a handover root never adds members:_ a new member holds no parent, so it could only check the
signature against the root's own `owner` field, which holds the new owner's keys and not the
signer's.

_Why it removes no one but the old owner:_ every member of the parent is then a member of the
handover epoch and entitled to its root. When the new owner later removes someone, the kick names
an epoch the new owner owns, so a kick is always signed by the owner of the epoch it names (§5.6)
and a removed member can always check it.

A root for a `chat_id` that is already installed is a duplicate and changes nothing.

### 4.8 Adopting a root

What a device does with a valid root depends on what it holds.
The first matching case applies.

1. **The root's own ID is known.**
   - Installed: duplicate, nothing changes.
   - Closed by the user (§14.2): a full root delivered directly by a member prompts again, as
     below; a notice or page entry for it is ignored.
   - Erased by a dissolve (§5.8): dropped.
2. **Retained member.** A parent is an epoch the device holds and had accepted, the root's owner
   has verified authority over it (§4.7), and that epoch is not in one of the states of case 4.
   The device adopts the root automatically, with no prompt, and the root becomes an end of that
   group (§4.9).
   The conversation shows a line saying who was added or removed, and any change of name or owner,
   with the root's claimed time.
3. **Closed by the user.** No parent qualifies for case 2, and a parent matches a closed-chat
   marker.
   The root is rejected with no prompt and its own ID is recorded as closed, so that the next root
   down the line is rejected too.
4. **Kicked, left, dissolved, waiting or superseded.** A parent is an epoch the device holds in one
   of these states (judged by the group of the first such parent):
   - _kicked_ (§5.6), _left and kept read-only_ (D.2) or _dissolved and kept_ (§5.8): the root is
     an **invitation** to rejoin that group;
   - _waiting for a kick_ (§5.4), or a _superseded chat of two_ (§5.12): the root is adopted
     without a prompt and announced to no one, so that the current epoch names the right owner.
5. **No parent matched.** The root is an **invitation**, after the parent lookup below.

_Why case 2 has no prompt:_ the owner is the party trusted with membership and the continuation is
verifiable; a prompt on every change is friction, and a member who ignores it drops out.
The cost is accepted: when the owner adds someone, that person learns the GossipIDs of all current
members without those members being asked, and a member who objects can only leave afterwards.

_Why case 3 has no prompt:_ a group that the user left keeps producing roots, and a prompt each
time would nag the user for ever and could be used to pester them.
The way back is for the owner to remove and later add the person again (§5.10).

**Parent lookup.** In case 5 the device cannot tell whether it is a new member or a retained member
that missed an epoch: it may hold X, have been offline while Y replaced X, and now receive Z, whose
parent is Y.
Before prompting, it therefore looks up the unmatched parents (§12.7):

- the lookup is an ordinary retrieval task (§11), starting with the peer that delivered the root;
  an unanswered request is not an answer, and the task simply continues;
- when a parent arrives, it is verified and matched in turn, and the lookup is repeated up the
  chain until it reaches an epoch the device holds; the device then adopts the whole chain under
  case 2;
- whenever a parent of an invitation becomes installed, by a lookup or any other way, the
  invitation ends exactly as the root would have, had it arrived after that parent: adopted under
  case 2, kept without a prompt under case 4 for a group waiting for a kick, an invitation to rejoin
  under case 4 for a kicked or dissolved group. A root the user closed before (case 1) stays an
  invitation.
  _Why:_ the same root in the same group state must end the same way whatever the order in which
  roots arrive; otherwise a waiting device that got the child before its parent prompted the user
  with an old epoch it would have kept silently in the other order;
- whenever a group the device was no longer active in becomes active again (the user accepts an
  invitation to rejoin it, or a later root), each other invitation to rejoin that group is decided
  again the same way: it now continues an active group, so it is adopted under case 2.
  _Why:_ two roots that both continue the epoch the device was kicked from are both invitations to
  rejoin; a root that arrives after the user accepted one of them is adopted under case 2, so one
  that arrived before must end the same way rather than stay an invitation for good;
- during the first `PROMPT_DELAY` (five minutes) after receiving the root, the invitation prompt is
  shown only on an explicit answer: the **owner** of the root answers "not available", or three
  distinct members do;
- after `PROMPT_DELAY` without a result, the prompt is shown anyway and the lookup keeps running in
  the background;
- if the lookup succeeds while the prompt is open, the device adopts the root under case 2 and
  closes the prompt; if the user had already accepted, the two conversations are joined;
- a decline made while the lookup is still running cannot be undone: a leave or request that was
  sent stays sent.

_Why the owner's answer settles it:_ the owner created the root and holds all its parents.

**Invitation.** The recipient MUST be asked to **Accept** or **Decline** in the UI.
The prompt shows the owner as **verified** (the signature proves it), the group name, the member
list and, when different from the owner, the immediate peer that delivered the root (**"received
from"**).
A first invitation and an invitation to rejoin are treated the same.

- **Accept** installs the epoch and sends nothing.
  The device then fetches the keys it lacks (§4.3) and scans tips (§12.3).
  If a parent of the root is an epoch the device holds and the root's owner has verified authority
  over it, the conversation continues in the same group (§5.10).
  Otherwise the root starts a separate group on this device, which the user may link by hand
  (§5.10).
- **Decline** opens the choices of §5.2.

**A refused invitation.** When the user refuses an invitation, by a decline or by "Ignore and
Delete" (§5.2), the roots the parent lookup fetched for it go with it, each leaving a closed-chat
marker with its reference, as the invitation does (§14.2). A fetched parent that something else
the device holds still names (another pending invitation, an installed epoch, a waiting group) is
kept. A copy of a dropped parent announced again is then ignored, and a reply naming one is
recognised without asking anyone (§7.6).
_Why:_ those roots are hidden records that nothing points to any more, and they hold the member
lists and names of earlier epochs of a chat the user refused. "Ignore and Delete", the action meant
to leave the least trace, must not leave them behind.

Until an epoch is installed, frames for it other than its root are dropped without staging.
The owner's own device installs a root as accepted when creating it.
Other members are not told whether a member accepted.

### 4.9 Competing branches

An **end** is an epoch the device holds and has installed, with no installed successor.
A group normally has one end.
Two or more ends that descend from a common epoch are **competing**.
Only the owner creates roots, so competing ends come from the owner: by accident (a device restored
from a backup) or on purpose.

**Current epoch.** A device's current epoch in a group is the end where it sends new messages.
With one end, it is that end.
With competing ends that name the same owner, the **interim rule** applies: the end with the
greatest `(created_at, chat_id)` is the current epoch.
The other ends stay readable as side branches and still accept incoming messages.
§5.9 gives the rule when the ends name different owners.

**A device that is not the owner** sends the owner a root notice for each competing end it holds,
so that the owner fetches what it lacks.

**The owner's device**, once it holds two valid competing ends, shows a prompt to resolve them.
Until it does, it keeps processing events under the interim rule but MUST NOT send new events in
that group.
Receiving is never blocked.

**Resolution root.** A successor root whose parents are **all** the competing ends.
The owner's choice shows only in its member list.
Everyone kept converges on it; anyone left out is removed like any removed member (§5.6).
More than 32 competing ends are resolved in steps.

**Resolution UI.** With n competing ends, the owner is offered n + 1 pages, each with an editable
member list:

- **Page 0, the default: merge.**
  Members who are in **every** branch are preselected.
  Members who are in **only some** branches are listed apart, with the branches they are in, and
  MUST be decided explicitly, one by one or with "include all" / "exclude all", before the root can
  be sent.
  With identical member lists it is a single confirmation.
- **Pages 1 to n:** one per branch, in the order of their `created_at`, to start from that branch's
  list.

Members whose leave applies are left out of every page (§5.5).

_Why the union is not preselected:_ adding back a removed member by accident gives them the new
secret and cannot be undone; dropping someone by accident can.

### 4.10 Lifetime of a root

A root never expires and is never pruned while its group is retained.
It is served in full, only to members of its epoch, in answer to a chat lookup (§12.7) and on Retry
synchronisation (§9.4).
It is announced by root notice only (§4.6), never by an event notice.

### 4.11 Shared-chats discovery

A device can ask a peer which groups they share:

- the responder answers only a requester that is a member of at least one epoch the responder has
  accepted and still retains; any other request is dropped silently, and the check is repeated on
  every continuation;
- the responder lists an epoch when it has accepted and still retains it, its member list includes
  **both** the requester and itself, and the responder holds no successor of it that also lists the
  requester;
- closed and unaccepted epochs are never listed, and never count for the check above;
- other epochs, their IDs, counts and pagination state are never disclosed;
- results are paged chat IDs in ascending byte order, using the page pattern of §12.1, keyed by
  `(authenticated peer, scanId)`; if a listed epoch becomes undisclosable mid-scan, the responder
  answers **restart**.

The list therefore holds, for each shared group, the latest epochs from the requester's point of
view: the current epoch, each open side branch, and the last epoch of a group the requester was
removed from, which is where the kick applies (§5.6).

The requester fetches each unknown root by chat lookup (§12.7), handles it under §4.7 and §4.8, and
walks back through its parents with the parent lookup.
Chat IDs that match the requester's closed-chat markers are ignored.

A device MAY send this query to any peer; it SHOULD send it to its contacts after reinstalling and
when the user asks to look for shared groups.

_Why only the latest epochs:_ listing every shared epoch would grow with every membership change of
every shared group, for ever, while a device that holds the latest epoch can fetch the earlier ones
itself.

Caveat: the answer tells a fellow member which of the groups they share the responder has accepted
and still keeps.
A shared group missing from the list reveals that the responder declined, deleted or never accepted
it.
This is accepted: the responder's silence in that group reveals the same.

## 5. Membership and ownership

### 5.1 Who changes the member list

Only the owner changes the member list, by creating a root (§4.6).
A member cannot remove itself from a root; it can only ask, in one of the ways of §5.2.

Three signed objects accompany membership changes, besides the root.
Each has a 32-byte hash ID with no timestamp and no random value, is signed with ML-DSA-65 over
that ID, is never a parent or a tip, and does not expire with the retention period:

| Object   | Signed by             | Meaning                                  | Section |
| -------- | --------------------- | ---------------------------------------- | ------- |
| leave    | the member who leaves | "I leave this epoch's group"             | §5.3    |
| kick     | the owner             | "this member is removed from this epoch" | §5.6    |
| dissolve | the owner             | "this group is ended"                    | §5.8    |

Every device MUST verify a signed object before storing or relaying it.
Message events stay unsigned.

### 5.2 Leaving and declining

There are three ways to leave a group or to decline an invitation.
They are named by who sees them:

| Spec term              | What happens                                                         | Seen by   |
| ---------------------- | -------------------------------------------------------------------- | --------- |
| **signed leave**       | a leave message signed by the member, relayed by every member (§5.3) | everyone  |
| **owner-only request** | an unsigned request sent to the owner alone (§5.4)                   | the owner |
| **silent close**       | the group is closed on this device and nobody is told (§14.2)        | no one    |

Accepting an invitation is silent; declining is explicit and works like leaving.

**Invitation prompt.** Buttons: **Accept** / **Decline**.
Decline opens a popup with four choices:

1. **Decline (visible to everyone)**
   "Maximum reliability, minimum deniability. Everyone knows you declined, and that your GossipID
   matches the claimed leave."
2. **Ask to be kicked (visible only to chat owner)**
   "Good balance of reliability and deniability. You may get accidentally re-added later on rare
   occasions. The member list stays on this device as a local trace until the owner removes you,
   for up to 2 weeks. Messages are deleted at once."
3. **Ignore and Delete (visible to no one)**
   "Minimum reliability, maximum deniability. You may get invited again regularly on active chats
   with a lot of member list changes, especially where other members share other chats with you."
4. **Cancel**, which returns to the Accept / Decline prompt.

**A group the user had accepted.** Buttons: **Leave** / **Cancel (Stay)**.
Leave opens a popup with four choices:

1. **Leave (visible to everyone)**
   "Maximum reliability, minimum deniability. Everyone knows you left, and that your GossipID
   matches the claimed leave."
2. **Ask to be kicked (visible only to chat owner)**, with the text above.
3. **Ignore and Delete (visible to no one)**, with the text above.
4. **Cancel (Stay)**, which closes the popup and changes nothing.

Choice 1 is the signed leave, choice 2 the owner-only request and choice 3 the silent close.
The owner of a group gets a different popup (§5.8).
The order and wording of the buttons are provisional.

All three ways end with the group closed on the device and a closed-chat marker (§14.2); the
owner-only request reaches that state only after its waiting state (§5.4). On an invitation not
answered yet, a decline and "Ignore and Delete" also drop the roots fetched as its parents, each
with its own marker (§4.8): the earlier epochs' member lists do not stay behind.

_Why "invited again" in choice 3:_ nobody removed the user, who therefore stays in the member list.
The device rejects each new root by itself while it can match it to an epoch it closed (§4.8); if
it misses one epoch in the chain, the next root looks new and prompts.

### 5.3 The signed leave

```text
leaveId = H("gossip.groups.leave.1", chat_id, leaverGossipId)
```

A leave carries the `chat_id` of the epoch it names, the leaver's GossipID and the signature.
The signature is the leaver's ML-DSA-65 signature over the 32 bytes of `leaveId`, with the signing
context `gossip.groups.leave.signature.1`.
It is not hashed.

The ID hashes no version. It inherits the version through the `chat_id`, whose root hashes its own
version (§4.1). A later version that changes the fields of a leave, kick or dissolve MUST use a new
hash label for its ID (a new hash domain, Appendix A).
_Why:_ otherwise an old and a new form of one object could share an ID (D.17).

- A member has exactly one possible leave per epoch; receiving it twice changes nothing.
- The leaver's keys are not carried: a verifier uses the keys it holds (§4.3) or a key query.
- A receiver verifies the signature and that the leaver is a member of the named epoch.
- A leave is about 3.4 KB, and about 7 KB once encrypted alone.

**Sending.** The leave names the leaver's current epoch, or the epoch of the invitation being
declined.
The leaver's device sends the full leave to all members of that epoch, then closes the group
(§14.2).

**When a leave is live.** A leave for epoch E by member M is **live** for a device whose current
epoch is C when all three hold:

1. the device holds the root of E;
2. E is C itself, or C descends from E through parent links;
3. M is a member of **every** epoch the device holds between E and C: once any epoch in between
   left M out, the leave is used up, whatever later root lists M again.

A device that holds E and C but not every root between them cannot check condition 3. For **its
own** leave, the leave is then not live for it; for any other member's leave, condition 3 is judged
on the epochs the device holds, and the leave is live.
A device knows a root between is missing when a root on the line from E to C names a parent it does
not hold.
_Why for its own leave:_ a member added back holds the epoch it left and the root that adds it back,
never the epoch between that dropped it. Without this rule its own old leave would look live again
on its own device, and make it read-only in the group it was just added back to.
_Why only for its own leave:_ applied to every leave, the rule made liveness depend on which
parents a device holds. An owner with such a gap (a member added back, or one that was on one side
only of a resolved fork) never acted on a late leaver's leave naming an earlier epoch: the leaver
stayed listed, the others waited for a successor that never came, and such devices stopped relaying
the leave.
_Known cost:_ an owner with a gap can apply an old leave of a member that was added back since, and
remove that member again. This is visible to everyone, and the owner can add the member back.
That adding back links the member's device to its conversation only through an epoch over which
the owner's authority can be verified there (§5.10): the owner of a gap is often a new owner holding
a former owner's branch, which lists the member latest but which the member's device cannot verify,
and naming that branch started a second conversation on the member's device.

- While a leave is live, a device announces it (§10.2), lists it in tip scans (§12.1) and fetches
  it when it is announced.
- When it is not live, the device does not announce it, does not list it in tip scans and ignores
  notices for it without fetching.
- A notice carries `[chat_id, leaveId]`, and a device that holds that root can compute every
  member's possible `leaveId`, find which member the notice is about, and decide from the roots
  alone before fetching anything.

**Keeping.** A device keeps a valid leave for as long as it keeps the root of the epoch it names,
and deletes both together, whether or not the leave is live.
A leave that is kept but not live has two uses only:

- it is sent in full to the leaver when that leaver contacts the device in that epoch (§5.6, §10.4),
  under the same rules and daily limit as a kick, **even when the leaver was added back since** and
  is a member of the current epoch;
- it is returned to a removal lookup (§12.8) from a member of that epoch.

When a device answers a member's tips scan "not available" and is about to tell it of its current
epoch by a root notice (§12.1), and that root adds the member back after a leave the device keeps,
it first sends the leave in full, then the root in full, in that order.

_Why send it to a member added back:_ a device of that member restored from a backup made before
the leave still acts as a member of the epoch it left. Given the root that adds it back first, it
would take that root as the next epoch of its group, silently, as if it had never left. With its
leave first, it shows the group as left, the root then comes as an invitation joined to the same
conversation (§4.8 case 4, §5.10), and the user accepts it again. Both go as full objects because
full objects are carried after the answers of a plaintext, in the order they were queued: a root
given as a lookup answer would be read before the leave. The same member, up to date, also gets its
leave back when it looks up history of the epoch it left; it already holds it, so the cost is a few
repeated sends a day at most.

_Why keep it:_ a leaver whose device was restored from an earlier backup does not know it left.
It still acts as a member of that epoch, and the kept leave, which it can verify with its own key,
tells it.
Liveness alone decides whether a leave removes anyone, so keeping an old leave cannot replay it.

**When a leave applies.** The owner's device acts on a leave exactly when it is live for it, and
then creates a successor without M (§5.5).
Other members do not act on it; they only relay it.

The rule covers these cases:

- _Late leaver._ M is in X and never received Y, where M is still listed.
  M can only sign a leave for X.
  X is an ancestor of Y and M is in both, so the leave removes M from Y.
- _Replay._ M left from X and was removed in Y; later M is added again in Z and accepts.
  The old leave for X never expires, but Y does not contain M, so the leave is used up for good,
  although Z names X as an extra parent (§5.10) and M is in both.
- _Leaving again._ Adding a member back always creates a new epoch, so a second leave names a new
  epoch and has a different `leaveId`.
  Two legitimate leaves never collide.
- _Forks._ If M was removed in one branch but kept in another, and the resolution root keeps M, the
  leave is used up, since one epoch in between left M out: M stays listed until the owner removes
  it by hand. A resolution and an add-back have the same shape, and the rule must let an add-back
  stand. The case is rare: when merging, the owner's device already leaves out every member whose
  leave it holds (§5.5).

_Why no random field:_ it is not needed to tell two legitimate leaves apart, and it would let one
member produce any number of distinct valid leaves for one epoch, which every member would store
and relay.

**Spreading.** Leaves are relayed like events (§10.2): a notice entry `[chat_id, leaveId]`, and a
signed-object lookup (§12.8) that returns the full leave.
Notices and lookup answers go only to members of the named epoch.
Announcing a leave and then answering "not available" costs the small penalty of an ordinary event
(§11.8).

### 5.4 The owner-only request

The owner-only request is an unsigned frame (§13.6) sent to the owner alone, over the requester's
own session.
It is not an event, has no ID and is never relayed.

- The owner's device accepts it only when the immediate Agraphon peer is the member it concerns.
- It is deniable: only the owner learns of it, and the owner holds nothing it can prove to a third
  party.
  To the other members the resulting root looks like a removal decided by the owner.
- It is weaker than a signed leave: it needs a working session with the owner, and the owner's
  device to come online.

**The waiting state.** On choosing "Ask to be kicked", the device:

1. sends the request to the owner of its current epoch;
2. deletes the group's messages at once and keeps only the group's roots;
3. moves the group out of the normal list, into a **"Waiting for kick"** tab on the discussions
   list screen.
   The tab is shown only while at least one group is waiting.
   The entry shows the group name and "Waiting for the owner to remove you", with no history.

While waiting, the device:

- sends the request again every 24 hours, to the owner of its current epoch;
- drops everything it receives for that group **except roots, kicks and dissolve messages**;
- keeps every root of that group, those it held when asking and each one it receives, and applies
  the rules of §4.9 and §5.9 to them, so that its current epoch names the right owner;
- starts nothing itself in that group, except the lookup of a missing parent root (§4.8);
- keeps every connection of that group (§5.12): the kick can come from the owner or from any
  member, who all hold it;
- lets the user switch, from the entry, to "Leave (visible to everyone)" (or "Decline (visible to
  everyone)" for an invitation) or to "Ignore and Delete (visible to no one)".

The user cannot cancel the request and stay: the owner may already have acted on it.

The state ends in one of two ways:

- **A kick arrives.** The kick is the confirmation; there is no separate acknowledgement.
  For a waiting device, a valid kick naming **any** root it holds for that group counts, whichever
  branch it is on.
  The roots are deleted, the entry disappears, and only the closed-chat marker remains.
- **Two weeks pass without a kick.** The device does the same as "Ignore and Delete": the roots are
  deleted, the entry disappears, and the user stays in the member list.

_To keep in mind:_ after two weeks without a kick, the device leaves quietly **on its own**, as
"Ignore and Delete" does. The chat is then closed, so its connections, all kept while waiting, are
dropped as for any closed chat (§5.12), and the user still appears in the member list to the
others, for as long as the owner does not remove them.

_Why every root is kept:_ with only the newest one, a competing successor of an already dropped
root would look like a new invitation, and a kick naming the other branch could not be checked.

_Why the request follows an owner change without a special rule:_ the waiting device adopts a
handover root like any member, so its next daily request goes to the new owner.
An old owner that receives a request ignores it.

### 5.5 When the owner's device creates the successor

For a live leave and for an owner-only request alike, the owner's device creates the successor
without a prompt, as follows:

1. it first finishes everything it has already received for that group: downloaded frames and scan
   pages in progress;
2. it waits until 30 seconds have passed with no new leave or request arriving;
3. it creates one successor root without **all** the members whose leave or request it holds at
   that moment;
4. it never waits more than 5 minutes after the first leave or request, even if events keep
   arriving.

**During an unresolved fork** (§4.9) no automatic successor is created.
The leaves and requests wait and are applied by the resolution root: its member list leaves those
members out, and in the resolution UI they are not selectable on any page.
A leave counts there if it is live for **at least one** of the competing ends.

**At a handover** (§5.7) nothing is applied: a handover removes no one but the old owner. The new
owner applies the live leaves it holds once it owns the group, and members waiting to be removed
send their next daily request to the new owner.

### 5.6 The kick

A removed member is told of the removal by a kick.

```text
kickId = H("gossip.groups.kick.1", chat_id, removedGossipId)
```

A kick carries the `chat_id` of the epoch the member is removed **from**, the removed member's
GossipID and the signature.
The signature is the ML-DSA-65 signature of that epoch's owner over the 32 bytes of `kickId`, with
the signing context `gossip.groups.kick.signature.1`.
The ID of the new epoch is never shown to the removed member.

As for a leave (§5.3), `kickId` hashes no version and inherits it through the `chat_id`. A later
version that changes the fields of a leave, kick or dissolve MUST use a new hash label for its ID.

**Creation.** When the owner's device creates a root, it creates one kick for each parent epoch and
each member of that parent who is not in the new root, except members whose live signed leave it
holds.
A handover root creates no kick: it removes no one but its signer.
A kick is valid only when signed by the owner of the epoch it names; no other identity may sign
one, whatever handovers followed.
An owner's device never creates a kick naming an epoch it does not own.

**The former owner.** A device answers the former owner of a handover it holds with that handover
root, as it answers a removed member with its kick and under the same limits. A device restored
from a backup made before its own handover learns from it that it is no longer the owner, and
that it left if the root no longer lists it.

_Known limit:_ people who are members only of a former owner's competing branch, and whom the new
owner drops when merging that branch, cannot be sent a kick they could check, and are not told.

**Delivery.**

- The owner sends each kick in full to the member it names.
- The owner sends **all** the kicks in full to every member who is in both the parent and the new
  root, in the same plaintext as the new root (§4.6); kicks that do not fit go in following
  plaintexts.
- A member that holds a kick announces it by notice `[chat_id, kickId]` like any relayed object
  (§10.2), to members of the new epoch who were in the parent.
  A member that missed the owner's send fetches it by signed-object lookup (§12.8).
- When a peer that was removed from an epoch sends a retained member a query, a notice or a
  message event that names that epoch, the retained member answers with the full kick naming that
  peer, or with that peer's signed leave (§5.3), whichever it holds (§10.4).
  - The frames that count: every query that names the epoch (event, sync-object and tips scan,
    and the three membership lookups: signed object, removal and keys, §12.8, §12.9), every notice
    entry that names it (of an event, a root or a signed object), a message event in an event
    frame, and a neighbor request.
  - Never a response: it answers the retained member's own question, and answering it could start
    a loop.
  - Never a frame that names no epoch: a shared-chats scan or a chat lookup (the exception of
    §4.11 for the last epoch that lists the peer stays).
  - A lookup whose answer already carries the peer's own kick or leave does not send it a second
    time.
  - Only a member active in the group answers this way; a device that is kicked, left, waiting or
    dissolved sends nothing (§10.4), except that an archive ("Dissolve & Keep archived") still
    gives a removed peer its own kick or leave.
    It sends this answer at most three times per removed peer per day and per epoch; each retained
    member counts on its own.
    This daily limit is local policy; the list of frames that count is fixed.
    If it holds neither, it first sends other members a removal lookup (§12.8) and forwards what it
    receives.

  _Why one wide rule:_ which frames a later client sends first is local policy and may change,
  while this list is fixed for the wire version; with every frame that names the epoch counted, a
  removed peer is always told whatever it sends first. A pushed record is not a question, so it
  starts no loop.

Retained members stop serving a removed member because of the new root (§10.4), not because of the
kick; the kick exists to tell the removed member.

**Keeping.** A device keeps a kick for as long as it keeps the root of the epoch it names, and
deletes both together.
There is no exception for a member who was added back, and no rule that keeps only the latest kick
of a member: a member who was offline through a removal, a return and a second removal is still at
the first epoch and needs the kick naming that epoch.

A kept kick is used as a kept leave is (§5.3 "Keeping"): it is sent in full to the member it names
when that member contacts the device in that epoch, under the same rules and daily limit, **even
when the member was added back since** and is a member of the current epoch; and when a device is
about to tell that member of a root that adds it back by a root notice (§12.1), it first sends the
kick in full, then the root in full, in that order. The kick applies only to the epoch it names, so
it never removes the member from the root that adds it back.
_Why:_ one rule for both ways of going out of a group. A device of that member restored from a
backup made before its removal still acts in the epoch it was removed from; given the root that
adds it back first, it would rejoin silently, without the prompt every other member added back
gets. With its kick first it shows the group as removed, the root comes as an invitation joined to
the same conversation (§4.8 case 4, §5.10), and its history then matches what every other member
saw.

**On the removed member's device.** A valid kick that names the device itself and its **current**
epoch has this effect:

- the group becomes a read-only archive: the history stays readable, with a line "You were removed
  from this group", and the composer is disabled; the user can delete the group's data;
- the device stops everything it starts itself in that epoch: sending, relaying, notices, scans and
  neighbor upkeep;
- it still applies deletion events for that epoch (§10.4), still verifies and stores kicks, leaves
  and dissolve messages naming an epoch it holds, and applies a dissolve message naming that
  epoch: "Dissolve & Delete" erases its archive; it drops every other event it receives there;
- it answers queries about that epoch exactly as a device that does not hold it would (§10.4):
  "not available" to a lookup from a peer that shares an active chat with it, silence to any
  other peer, "not available" to a tips scan;
- from then on, every root that lists the device is an **invitation** (§4.8), whatever its parents.

A kick that names an epoch which is not the device's current epoch is ignored, except in the
waiting state (§5.4).
A kick for an epoch the device does not hold cannot be checked and is dropped.

_Why a kick for another epoch is ignored:_ after a fork made by the owner, a root listing the
device can arrive before the kick.
The device has then adopted that root on the owner's own signature, and a kick for the older epoch
contradicts it.
The owner's resolution root settles who is in, and comes with a kick naming the epoch the member is
then at.

_Why the group is not closed automatically:_ an owner could otherwise erase the history on a
member's device by removing that member.

_Why a dissolve still applies to the removed member's archive:_ "Dissolve & Delete" is meant to erase the chat on every device that holds the epoch;
otherwise the removed member's device would keep the only transcript of a chat everyone else
erased. It is consistent with single deletion events, which already reach removed peers (§10.4),
and the owner gains no power it did not have: it could have dissolved with deletion just before the
kick.
_Known drawback:_ a removed member's archive stays within the owner's reach after the removal. The
owner can erase that member's copy of an epoch it holds although it is no longer in the group; only
a dissolve naming an epoch the member holds reaches it, never a dissolve of a later epoch (§16.8).

### 5.7 Changing the owner

Ownership passes by a **handover root** (§4.7): a root signed by the current owner A whose `owner`
field names another member B.

- The handover is immediate.
  B is not asked, and becomes the owner as soon as a device adopts the root.
- A signs the root while still the owner, so the outgoing owner never has to sign anything after
  leaving.
- The handover root keeps the member list, except that A may be absent from it, and may change the
  name. "Hand over and leave" is therefore one root, after which A's device closes the group.
  Any other change of members is made before or after the handover, by a successor root.
  A may also hand over and stay as an ordinary member ("Transfer ownership").
- It never adds a member (§4.7); B adds members afterwards with a successor root.
  The owner's device refuses to build a handover root that adds anyone.
- It has exactly one parent.
  An owner with competing ends first resolves them (§4.9), then hands over from that epoch.
- A's device applies in it every live leave and every owner-only request it holds (§5.5).

_Why no acceptance step:_ it is deferred (§17.5).
The risk is accepted: if B never comes online or does not act as owner, the member list is frozen.
Messages still flow, but nobody can add or remove members and leaves are never processed.

### 5.8 The owner leaving, and dissolving a group

**The owner's Leave popup.** When the user is the owner of the group, Leave opens:

1. **Hand over and leave (visible to everyone)**
   "Pick the next owner. They become the owner at once and you are removed. Everyone knows you left
   and who you named. This cannot be undone."
2. **Cancel (Stay)**

followed by a separator and a section titled **Danger zone**, whose choices are shown in red and
each ask once more before acting:

3. **Dissolve & Keep archived (visible to everyone)**
   "Ends the group for everyone. Nothing is deleted on anyone's device. This cannot be undone."
4. **Dissolve & Delete (visible to everyone)**
   "Ends the group and attempts to delete it on every member's device on a best effort basis for
   peers that are reachable, copies may still exist (offline peer, backups, unofficial clients,
   compromised devices)."
5. **Ignore and Delete (visible to no one)**
   "Deletes the group from this device and tells no one. The group is left without an owner: nobody
   can add or remove members, and members who leave are never removed. You remain listed as the
   owner and may get the group back if a member sends it to you again."

If the owner is the only member, the popup offers only **Delete group** and **Cancel**.
"Transfer ownership" is a separate action outside this popup (§5.7).

An emergency wipe of the device is never blocked or delayed by any of this (§14.2).

**The dissolve message.**

```text
dissolveId = H("gossip.groups.dissolve.1", chat_id, must_delete)
```

A dissolve message carries the `chat_id` of the epoch it names, the boolean `must_delete` and the
signature: the ML-DSA-65 signature of that epoch's owner over the 32 bytes of `dissolveId`, with
the signing context `gossip.groups.dissolve.signature.1`.
As for a leave (§5.3), `dissolveId` hashes no version and inherits it through the `chat_id`. A
later version that changes the fields of a leave, kick or dissolve MUST use a new hash label for
its ID.

- The owner's device sends it in full to all members of the named epoch.
- Every member relays it like a signed leave: notice `[chat_id, dissolveId]` and signed-object
  lookup (§12.8), among members of the named epoch.
- Every device verifies it with the owner keys of that epoch's root.
- It applies only when it names the device's **current** epoch.
  A dissolve message naming another epoch is ignored.
- A device that is already no longer active in the group when the dissolve arrives (kicked, left,
  or waiting for a kick) applies it **silently**: it does not relay or announce it, and it stays in
  its state, so it goes on answering as a device that does not hold the epoch (§10.4). With
  `must_delete` true it still erases the group's messages as below; with `must_delete` false
  nothing it does changes. Only a device that was active when it applied the dissolve keeps,
  announces and serves the named root and the message as below.
  _Why:_ announcing the dissolve, or serving its root and a page afterwards, told the members that
  this device had kept the chat, which a device that deleted its copy never does. The owner pushes
  the message in full to every member, and the active members relay and serve it, so a device that
  missed it still learns it from them.

**Effect with `must_delete` false** ("Dissolve & Keep archived"):

- the group is ended and read-only, with the line "This group was dissolved by its owner";
- inside the conversation, and on its entry in the list, the user gets **Archive** and **Delete**;
- the device keeps announcing the dissolve message and answering lookups for it.

**Effect with `must_delete` true** ("Dissolve & Delete"):

- the device erases the group's messages at once, in the named epoch and in every earlier epoch it
  holds that leads to the named one by parent links; side branches that do not lead to it are not
  erased;
- it keeps the named root and the dissolve message for two weeks, counted from the moment this
  device applied the dissolve, only to announce the message and answer lookups for it, then
  deletes them; every member device does so, the owner's included;
- it then keeps only a **dissolved marker** (§14.2).

If a device receives both forms for the same epoch, it deletes.

**After a dissolve**, in both forms, a later valid root that lists the device is an **invitation**
(§4.8).
After "Keep archived", an accepted root continues the conversation with its history, as after a
kick.
After "Delete", an accepted root shows as a new group without the old history.

**Serving what a dissolved group keeps.** In both forms, for as long as it keeps them, a device
serves the named root and the dissolve message to a member of that root, whether or not the two
share another chat. A member's tips scan is answered with a page that lists only the dissolve
message and the root of the current epoch when it is not the anchor: no message event.
After "Dissolve & Delete", once the two weeks are over, the device answers as one that never held
the epoch.
_Why:_ this is how a device that missed the dissolve learns it; answering such a scan "not
available" left 9 of 300 simulated devices that never applied the dissolve. Listing only these two
entries matches what a dissolved group already serves. No event ID is given, so nothing of the
messages is revealed and the asker asks for nothing it would be refused. A device that missed the
dissolve may share nothing else with this one, so the root is served without that condition.

_Why not the automatic rejection of §4.8:_ that rule respects a choice the user made.
After a dissolve the user chose nothing; the owner did.

A handover root can only be checked against its parent.
A device that erased the group keeps that parent for two weeks; after that it can no longer check a
handover root and rejects it, and it gets the invitation from the next successor root the new owner
signs.

### 5.9 Forks whose branches name different owners

A former owner's key can still sign roots that continue epochs it used to own.
Competing ends (§4.9) can therefore name different owners, in two ways.

**Old owner against new owner.** A handed over to B on one branch; on another branch A is still the
owner.
The handover wins:

- a device that has adopted a handover from A no longer takes a root signed by A as owner as its
  current epoch in that group; such roots are installed as readable side branches;
- a device that followed A's branch first and receives the handover later makes B's branch its
  current epoch, whatever the `created_at` values say;
- B may resolve the fork: a successor root signed by B may take A's branch as a parent, because A
  is a previous owner in B's own line (§4.7);
- a device that cannot check this, because it does not hold the handover root, treats B's
  resolution root as an invitation (§4.8).

A former owner can therefore never take a group back from the owner it handed to.

**Two new owners.** A handed over to B on one branch and to C on another.
Neither is a previous owner of the other, and A signed both.
There is no automatic winner: each device keeps as its current line the handover it adopted first.

- The other line stays a readable side branch of the same group and still accepts incoming
  messages.
  Its owner cannot resolve the fork on that device.
- On any one device this is a single conversation, never two entries in the list.
- The fork is never merged by an owner.
  The members of the two lines stop seeing each other's new messages, unless they are listed in
  both.

_Why no fixed winner:_ any rule based on the roots' content, such as the greatest or the earliest
`created_at`, is controlled by the former owner, who could always produce the winning handover and
take the group back.

### 5.10 Adding a member back, and links

When a member M is removed at epoch X and later added back at epoch Z, the ordinary parent of Z is
an epoch M never held, and M cannot be given the roots in between: they hold the member lists and
secrets of epochs M was not in.

**The extra parent.** When the owner's device adds back someone who was a member before, it adds
one more parent commitment to the new root: the last epoch that person was a member of over which
the owner has authority as that person's device judges it (§4.7, D.69): an epoch of the owner
itself, or of a previous owner whose handover root is among that epoch's own ancestors.
Among the epochs of the line the new root continues that list the person and meet that condition,
it is one that no later such epoch continues; of several, the latest by `created_at`, then by chat
ID.
If none does, no extra parent is named for that person, and the new root reaches it as an ordinary
invitation.
_Why authority:_ the person's device links the new root only through a parent over which it can
verify the owner's authority, and it does not hold the roots between (the new owner's own root that
resolved a former owner's branch, for instance). A former owner's branch resolved into the new
owner's line lists the person, but no handover leads to it: named, it left the new root with no
parent the person could match, and the root started a second conversation on its device
(membership simulation, seed 22). An epoch from before a handover the person does not hold fails
the same test on its device, so naming it would link nothing either.

- On M's device, Z then has a parent it holds, so the invitation, once accepted, continues the same
  conversation (§4.8).
- Members who hold X see one more parent, an ancestor they already have.
  Members who do not hold X see one unmatched commitment and ignore it.
- One extra parent is needed per distinct last epoch among the people added back, within the limit
  of 32 parents.

**Blind spot.** The owner's device must hold X to commit to it, and must have authority over it as
above.
An owner who joined the group after M was removed, who no longer holds X, or who received the group
by a handover after M was removed, cannot make the link.
M's device then shows two separate groups.
The same happens when M's device cannot verify the new owner's authority over X (§4.8).
This is a known limit of the linking mechanism.

**Linking by hand.** The user can pick **"Link with another chat"** on one group and choose
another.
The device then treats them as one group, with the newer line holding the current epoch.

- The link is local and reversible; the user can unlink at any time.
- Nothing is sent, and no other device learns of it.
- A wrong link has no effect outside the device: a device answers scans from its own grouping, and
  a requester only receives entries for epochs it is a member of (§12.1).
- A scan anchored in one group lists nothing of a group linked to it where the device is no longer
  active (kicked, left, waiting for a kick, dissolved).
  _Why:_ the link is local, so a device that deleted that group lists nothing of it either; listing
  it would tell a member of both groups that the device kept the history (§10.4).

**At the junction.** After M accepts the invitation, the conversation shows:

- the old history as it was, ending with "You were removed from this group";
- one line: "You were not a member between \<time the kick was received\> and \<the time `T` of the
  new root (§7.5)\>. Messages from that period are not available.";
- the line "\<owner\> added you back", followed by the new messages.

The read-only state ends and the composer is enabled again.

**History of the earlier epochs.** A member added back fetches the history of the earlier epochs of
the group that list it, by the ordinary scans and lookups of its group (§12.1, §11.1), and the
other members serve it, since it is a member of their current epoch (§10.4). It never gets the
epochs between that left it out: it holds neither their roots nor their secrets.
_Why:_ those epochs are part of its conversation; a device restored from a backup made before it
left, for example, misses the messages sent in the epoch it left between the backup and the leave.
_Known limit:_ a message it processed and dropped while it was removed is not fetched again (D.79).

### 5.11 Group name

Every root, of both types, has a `name` field: UTF-8, 0 to 256 bytes (§4.1).

- It is hashed into the root ID, so it is covered by the signature and is the same for every member
  of the epoch.
  Only members see it.
- Renaming creates a new epoch: a successor root with the new name, or a handover root.
- An empty name is allowed; the interface then shows a name built from the members.
- The protocol does not normalise the name: the bytes are hashed, stored and relayed as given.

**Local name.** The user may give a group a name of their own.
It is stored only on the device and is never sent; the official name stays in the root.

- When a local name is set, the list, the conversation header and reply previews show it.
- The group's information screen shows both, labelled "Your name for this chat" and "Group name".
- When the owner renames the group, the conversation shows a line "\<owner\> renamed the group to
  \<new name\>", whether or not a local name is set, and the local name is kept.

**Displaying a name safely.** The interface MUST apply the following to any name before showing it.
The result is for display only; stored and relayed bytes are never changed.

1. Treat the name as untrusted plain text: never interpret it as markup, a link or a format string.
2. Replace every control character (C0, C1 and U+007F) and every line or paragraph separator with a
   space, so that a name is always one line.
3. Remove explicit direction controls (U+202A to U+202E, U+2066 to U+2069, U+200E, U+200F and
   U+061C), and isolate the name from the direction of the surrounding text, so that a name cannot
   reorder the text around it.
4. Remove invisible characters (zero-width space, word joiner, U+FEFF, and zero-width joiner and
   non-joiner outside a valid emoji or script sequence), then trim leading and trailing white
   space.
   If nothing visible is left, treat the name as empty.
5. Normalise to NFC for display and for comparison in the interface.
6. Shorten by grapheme cluster, never inside one, and mark the cut with an ellipsis.
7. Keep stacked combining marks from drawing outside the name's own line.
8. Never rely on the name to identify a group: look-alike characters cannot be detected reliably.
   Where identity matters, such as the invitation prompt, show the verified owner and the member
   list beside the name.

The same rules apply to a local name.

### 5.12 Direct chats, contacts, connections and migration

**Conversation format versions.** They are the protocol version numbers of Appendix A: `0` is the
earlier one-to-one format; `1` is this protocol. A version-1 device acts only on `0`.

**Direct chats.** A direct chat is a group that was created with two members.
Whoever creates it owns it, and it is an ordinary group in every respect: its owner may add
members, rename it or hand it over.

**Connections and contacts.** A connection is a session with a peer (§2.1).
A device keeps, for each peer it has a connection with, whether its user **accepted** that peer as
a contact or the connection is **automatic**.

- A connection asked by a member of a group this device has accepted is opened automatically and
  silently. The claim is checked against the member list of a group the device holds and has
  accepted, never against a group it was only invited to. No conversation is created.
- A connection asked by anyone else needs the user's consent, on the invitation screen below.
- An automatic connection is revoked once no chat that keeps connections lists its peer, as a
  member or a removed peer, and nothing pushed whole is still owed to it (below). A peer the user
  accepted, or a member of another chat where the device is active, is never revoked by this
  rule. The check runs after every membership change and after every hand-off to the transport.

Which chats keep the connections with their members (D.86):

| State of the device in the chat                                      | Does the chat keep its connections?                                                                                                                                                                                    |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Active member                                                        | Yes. A member the owner removed stays listed by the epochs held, so that the replies owed to it (§5.6) and the deletions still served to it (§10.4) keep working.                                                      |
| Waiting to be kicked (§5.4)                                          | Yes, all of them: the kick can come from the owner or from any member, who all hold it, and dropping them would also show the other members that the user asked to leave. Until the kick arrives or the two weeks end. |
| After the wait ends: a kick arrived, or two weeks passed without one | No: the chat is closed. Without a kick the device leaves quietly as "Ignore and Delete" does (the roots deleted, the entry gone, the user still in the member list for the others).                                    |
| Kicked, history kept read-only                                       | No.                                                                                                                                                                                                                    |
| Left visibly (§5.3), history kept read-only                          | No, but only once the signed leave has been handed to the transport for every member it must reach.                                                                                                                    |
| Superseded (a chat of two replaced)                                  | No; its peer is a member of the chat that replaces it.                                                                                                                                                                 |
| Chat deleted                                                         | No.                                                                                                                                                                                                                    |
| Archive of a chat dissolved while active ("Keep archived", §5.8)     | Yes.                                                                                                                                                                                                                   |

An invitation not answered yet, and a handover root kept while its parent is looked up, keep
listing their members as before.

_Why a chat the device is out of keeps none, read-only or not:_ a member that shares only that
chat with the device sees the device's keep-alives continue or stop. Were they kept with a
read-only history and dropped with a deleted chat, that member could tell "kept the history" from
"deleted the chat", which the device must hide (§10.4, D.74).
_Cost:_ a kept read-only history no longer receives the later deletions, or a "Dissolve & Delete",
from members it shares nothing else with: the same loss as a device that deleted the chat.
_Why the leave is waited for:_ a visible leave closes the chat and is then pushed whole to every
member (§5.3); revoking the session before it is handed to the transport would lose it. The SDK
also keeps a connection while a ciphertext for that peer waits in its outbox.

_Note:_ a member whose connection is opened automatically learns that this device accepted the
group; the scans that follow an acceptance already show it (D.77).

**A new contact.** Accepting a contact request is the consent for a chat with that person.
An accepted contact counts as an earlier conversation of format version 0 with that person, even
when it holds nothing but the request. The requester's device then creates a group of the two,
which it owns, with `migrate_from = 0`, and the accepting device adopts that root without a prompt.

**One automatic chat per pair.** Every group a device creates by itself, after a contact request
or by migrating an earlier conversation, carries `migrate_from = 0`, and at most one such group
exists between two people. A group a user creates deliberately never carries the field: it is
always a new conversation, and a user may have any number of them with the same single person.

**Migrating an earlier conversation.**

- A device that moves to this protocol turns each earlier one-to-one conversation into an
  **archive**: it converts its own stored messages into its new local format and shows them
  read-only. Nothing of the earlier conversation is sent to anyone.
- An archive offers **Migrate to a new group** and **Archive**. "Archive" moves it to an archived
  list; it can still be opened and migrated later, and is still linked if the other person
  migrates.
- "Migrate" creates a group of two, the user and the contact of that conversation, with
  `migrate_from = 0`, and links it to the archive on this device: the two are displayed as one
  continuous conversation, the archive first.
- A device sets `migrate_from` only on a root that creates a group of exactly two members.
  The field never decides validity: a device cannot tell a root that creates a group from one
  whose parent it lacks, so a well-encoded `migrate_from` is always valid, and is simply ignored
  wherever the conditions below do not hold.

A device that receives a root with `migrate_from` treats it as a migration only when all of these
hold:

1. the group has exactly two members: the receiver itself and one other person;
2. that other person is the owner who signed the root;
3. the receiver itself holds an earlier conversation of that format version with that same person;
4. the root is of type successor, has one parent, and that parent matches no epoch the receiver
   holds; the format version is one the receiver knows; and the receiver holds no accepted group
   already created this way with that person.

It then shows the invitation inside that earlier conversation, with Accept and Decline, and on the
conversation's row in the list; accepting links the group to the archive as above.
When a condition fails, `migrate_from` is ignored and the root is an ordinary invitation.
A device hides its own "Migrate" action as soon as it holds such an invitation, and before
offering "Migrate" it first processes what it has received, so that the other person's invitation
takes precedence.

**Two automatic chats for one pair.** An _automatic chat_ is a group created with `migrate_from`
between two people. A device may come to hold two for the same pair with the same `migrate_from`,
neither continued by a later root: its own, and one created by the other person.

A device remembers, for each automatic chat it created, whether the other person has ever **taken
part** in it. This is one local boolean, set by the first notice, event or query the device
receives from that person inside that chat. It is never sent, never compared with any date, and
not deduced from retained events.

**A chat competes only while both people are still listed in it.** If the automatic chat a device
holds no longer lists the other person, because they declined visibly, left or were removed, that
chat is history only. A new automatic chat from that person is then always shown as the invitation
to continue below: one of the two ended the earlier chat on purpose, so the other must consent.

When both chats still list both people, the device first applies the tie rule: the chat whose
owner's GossipID sorts first (raw bytes, ascending) is the one to keep.

- **If mine is the one to keep,** the other chat becomes history, without a prompt, whatever the
  boolean says.
- **If theirs is the one to keep and the other person has never taken part in mine,** the device
  switches to theirs without a prompt.
- **If theirs is the one to keep and the other person has taken part in mine,** their chat is
  shown as an invitation to continue the conversation: _"[Name] wants to continue this
  conversation in a new group."_ Accepting makes their chat the current one; declining changes
  nothing.
- A second automatic chat created by the owner of the chat I already hold (that person
  reinstalled the account into an empty device, or restored a backup made before that chat) is an
  ordinary invitation. Accepting it makes it the current chat: the chat I hold becomes its
  read-only history, listed before it, as below. Declining changes nothing. This applies only while
  the chat I hold still lists exactly the two of us and its current epoch is still owned by that
  person; otherwise accepting links nothing.

**Nothing is erased.** The chat that is not kept becomes read-only history of the same
conversation: its messages stay on each device that holds them. The kept chat records, as local
data that is neither sent nor hashed, the ordered list of what came before it for that pair: the
identifier of the earlier one-to-one conversation and the chats it replaced. They are displayed as
one conversation, oldest first. This applies only to automatic chats of two people; no other
groups are ever merged.

**What a replaced chat still sends.** A device that supersedes a chat of two still sends what it
had queued for it, so that the other person gets the chat it replaces, but of its roots and signed
objects only those of its first epoch. A later epoch reaching a device that lacks its parent, such
as an account reinstalled into an empty device, cannot be told from a new group there and would be
shown as an ordinary invitation to a chat no longer used. Conversely, a device that holds the first
root of an automatic chat only as the parent fetched for another invitation (a later epoch reached
it first) treats that root as received directly: it pairs with the device's own chat as above.

The cases, with L the person whose GossipID sorts first, H the other, and G_L and G_H the chats
each created. "Asked" means the invitation to continue above.

| #   | Situation                                                                         | L's device                             | H's device                                 | Continues in                               |
| --- | --------------------------------------------------------------------------------- | -------------------------------------- | ------------------------------------------ | ------------------------------------------ |
| 1   | Both create at the same moment                                                    | not asked: keeps G_L                   | not asked: switches to G_L                 | G_L                                        |
| 2a  | H creates after L accepted H's contact request; L has none yet                    | not asked: the contact was the consent |                                            | G_H                                        |
| 2b  | H migrates an earlier conversation with history; L has none yet                   | asked                                  |                                            | G_H if L accepts                           |
| 3   | H creates and writes in G_H while L is offline; L had created G_L                 | not asked: keeps G_L, G_H is history   | not asked: switches to G_L, G_H is history | G_L                                        |
| 4a  | L ignored H's invitation without answering; later L creates G_L                   | not asked: keeps G_L                   | not asked: switches to G_L, G_H is history | G_L                                        |
| 4b  | L declined visibly, or H removed L, so G_H no longer lists L; later L creates G_L | not asked: keeps G_L                   | asked                                      | G_L if H accepts                           |
| 5   | L took part in G_H, then sends a new G_L                                          |                                        | asked                                      | G_H; G_L if H accepts                      |
| 6   | H sends a new G_H, whether or not H took part in G_L                              | not asked: keeps G_L, G_H is history   |                                            | G_L                                        |
| 7   | H joined G_L, then restores an old backup and creates G_H                         | not asked: keeps G_L                   | not asked: switches to G_L                 | G_L                                        |
| 8   | L joined G_H, then restores an old backup and creates G_L                         | not asked: keeps G_L                   | asked                                      | each on its own until H accepts, then G_L  |
| 9   | H restores a backup from before L took part; L sends G_L                          |                                        | not asked: switches to G_L, G_H is history | G_L                                        |
| 10  | H holds G_L, which L created; L reinstalls into an empty device and creates G_L2  |                                        | asked (an ordinary invitation)             | each on its own until H accepts, then G_L2 |

_Why:_ two people who start the same chat at the same moment must end on one chat without being
asked, but a chat both have used must not be replaced by one of them without the other's consent,
since owning the chat is what allows adding people to it. The other person's first traffic in my
chat is the only sign I ever get that they accepted it.

An account reinstalled from its recovery phrase into an empty device is a backup made before
anything. When the other person holds its own chat, rows 7 to 9 apply; when it holds a chat the
reinstalled person created, row 10 applies, and again after every later reinstall. Row 10 also
holds with L and H swapped.

_Why an ordinary invitation:_ a device cannot tell an owner that lost the chat it holds from one
that starts a second one on purpose, so the user decides; accepting is the only sign, and the chat
accepted last is the current one, with no date compared.

**The invitation screen.** Every invitation uses one screen made of sections shown as they apply:
who asks; adding that person as a contact; the group, its owner and its members; the earlier
conversation it continues; warnings (§4.8, §5.11); and the choices.
A person who is not a contact and asks for a chat is shown once, on that screen, as asking both to
become a contact and to open the chat.
An invitation is named as the conversation list would name that group: a chat of two without a
name by the other person's name, never "Unnamed group".

## 6. Events

### 6.1 Parent rules

- The root is not a DAG node: it is never a parent, a tip or the target of an event lookup.
  An event's link to its epoch is its `chat_id`.
- A message event has 0 to 16 parents.
- Parents are distinct 24-byte event IDs of the same epoch, sorted ascending; receivers MUST
  require that canonical form.
  A direct self-parent is malformed.
- A publisher uses all eligible local tips of the epoch when there are at most 16, and otherwise a
  uniform random sample of 16 distinct eligible tips.
  Eligible tips exclude unavailable, pruned and temporarily invalid events.
  With no eligible tip, the event has zero parents.
- Missing parents are retrieval dependencies; an event can be applied without a complete path to
  the first events of its epoch.
- An event is not rejected because its known ancestry contains a cycle.
  Traversal collapses strongly connected components into an acyclic condensation; a source
  component with no available child outside it exposes its available members as discovery frontier.
- A tip is an available event that no available event references as a parent; a pruned child does
  not hide its parent (§12.1, D.27).

_Why:_ bounded parents keep events small while still recording causal context for recovery.

### 6.2 Message event

A message event carries:

| Field          | Rule                                                       |
| -------------- | ---------------------------------------------------------- |
| `version`      | the event's version prefix, `1` (§13.1)                    |
| event type     | `GROUP_MESSAGE_EVENT`                                      |
| `eventId`      | `ts ‖ random` (§3)                                         |
| `chat_id`      | the epoch (§4.1)                                           |
| `secret_proof` | §4.2                                                       |
| `parents`      | §6.1                                                       |
| `payload`      | the message result, an extensible protobuf message (below) |

**Payload** for every type except `delete`:

| Field              | Rule                                                                                                                       |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| `syncObjId`        | 32 bytes; random for ordinary messages                                                                                     |
| `type`             | see the table below                                                                                                        |
| `author`           | the claimed author's GossipID; MUST be a member of the epoch                                                               |
| `created_at`       | claimed creation time; display ordering key                                                                                |
| `last_modified_at` | claimed modification time; version ranking key; MUST be present on every type except a deletion, or the event is malformed |
| `body`             | type-specific                                                                                                              |
| `edited`           | claimed edited flag, independent of the timestamps                                                                         |
| `metadata`         | map from text keys to byte values; empty when unused; a key given twice makes the event malformed                          |

| Tag | Type       | Body                                                  |
| --- | ---------- | ----------------------------------------------------- |
| 0   | `text`     | UTF-8 text                                            |
| 1   | `forward`  | `[content_type, content]`: a content-only copy (§7.6) |
| 2   | `reaction` | `[target, emoji, action]` (§7.6)                      |
| 3   | `media`    | `[mimetype, data]` (§7.6)                             |
| 4   | `delete`   | no body (see below)                                   |

**Delete** is a tombstone carrying only `syncObjId` and `type = 4`, plus an optional
`last_modified_at` present only while a scheduled deletion is pending (§7.4).
It has no author, creation date, body, edited flag or metadata.

**Result projection.** The CBOR projection of a payload is:

```text
fullMessage = [chat_id, syncObjId, type, author, created_at, last_modified_at, body, edited,
               metadata]
```

where `body` projects to a text string for `text`, to `[content_type, content]` for `forward`, to
`[target, emoji, action]` for `reaction` (a byte string, a text string and an unsigned integer), to
`[mimetype, data]` for `media` (a text string and a byte string), and `metadata` projects to a
CBOR map from text strings to byte strings.
A delete projects to `[chat_id, syncObjId, 4]`, without its pending `last_modified_at`.

**Result hash** (local only, never stored or transmitted):

```text
resultHash = H("gossip.groups.message.result.1", chat_id, syncObjId, type, author, created_at,
               last_modified_at, body, edited, metadata)
```

The items of `fullMessage` are poured directly into the hashed list after the domain (the flat
form): the list hashed is `[domain, chat_id, syncObjId, type, author, created_at,
last_modified_at, body, edited, metadata]`, ten items, never `[domain, fullMessage]`. For a delete
it is `[domain, chat_id, syncObjId, 4]`, four items. No item is optional: every content result has
the nine items in these positions (`metadata` is an empty map when unused, and `last_modified_at`
is always present on such a result), and a delete never carries its pending `last_modified_at`.
The list therefore reads one way only.
_Why flat:_ a pure convention, chosen so that every hash of the protocol is the domain followed by
its items (D.22).

Worked example: in epoch `chat_id = 0x11…11` (32 bytes), a text "hello" with `syncObjId =
0x77…77`, author `0x22…22`, `created_at = T`, `last_modified_at = T + 1`, `edited` true and
metadata `{"z": h'01', "aa": h'02'}` is hashed over the CBOR array

```text
8a                                  array of 10
  78 1e "gossip.groups.message.result.1"
  58 20 11…11                        chat_id
  58 20 77…77                        syncObjId
  00                                 type text
  58 20 22…22                        author
  1b <T, 8 bytes>                    created_at
  1b <T + 1, 8 bytes>                last_modified_at
  65 "hello"                         body
  f5                                 edited
  a2 61 "z" 41 01 62 "aa" 41 02      metadata, canonical key order
```

and with `T = 1,700,000,000,000` its BLAKE3 hash is
`c338cd5ad15710a66cf559e7423d726988df5faeaadb86bd94d50da09c51f8c3`.

The event ID, event timestamp, secret proof and parents are not part of the result.

**Metadata** is preserved exactly (including unknown entries) when storing and relaying an accepted
result.
It is part of the result hash.
Within a protocol version, new fields are added to metadata; new payload fields require a new
protocol version (§13.8).
Each metadata key defines the encoding of its value.
A key given twice in the metadata of one payload makes the event malformed, exactly as in the
settings map of a root (§4.1), with the same penalty as any malformed event.
_Why:_ one single way to write each message, so that every implementation reads the same content
from the same bytes. Protobuf keeps the last value of a repeated map key; an implementation keeping
the first would read a different message. An honest device writes metadata from a map and never
repeats a key.
Metadata conveys no membership authority.

**Claimed authors.** The claimed author MUST be a member of the epoch; others are rejected.
Independently, the immediate Agraphon peer MUST be a member; it need not be the claimed author.

_Why:_ members may fabricate messages in each other's names (deniability), but outsiders cannot be
named as authors.

### 6.3 Receiving a message event

A device accepts a message event only if:

- the epoch is installed and accepted, and the immediate peer is a member of it;
- the immediate peer is not a removed peer for that epoch, and the group is not in a state that
  drops incoming events (§10.4);
- the encoding, parents and payload are valid;
- the secret proof matches;
- the claimed author is a member of the epoch;
- the event timestamp and the payload timestamps pass admission (§7.2);
- it is not a message past the moment of the message timer of its epoch (§7.7).

## 7. Message semantics

### 7.1 Merging results

A device stores one current result per `(chat_id, syncObjId)`, plus pending future versions (§7.3).
For an incoming event under a **new** event ID:

- A valid delete is **absorbing**: once applied, no non-delete result restores the message,
  regardless of timestamps or arrival order.
  A delete that arrives before any content still creates the tombstone.
- Between non-delete results, the greatest `(last_modified_at, resultHash)` wins.
- **Reactions** (§7.6) differ in two ways. A delete has **no effect** on a reaction: whatever
  tombstone exists for its `syncObjId`, a reaction's state is decided only by its own versions.
  And between two versions of a reaction with the same `last_modified_at`, a version whose action
  is _remove_ wins over one whose action is _add_; only then does `resultHash` decide.
- **Wins:** replace the stored result, prune the superseded events and keep the incoming event
  available.
- **Loses:** prune the incoming event; the stored winner and its available events are unchanged.
- **Identical:** keep the incoming event available as an additional event carrying the current
  result; several distinct events may carry the same result, each with its own parents and
  retention.

An already-retained event ID keeps its **first valid interpretation** entirely; later conflicting
packets under the same ID are ignored.
The only exception is the scheduled-to-immediate deletion normalization (§7.4).
Different devices that received different first interpretations may disagree; no conflict archive
is kept.

Arrivals under an already-known, pruned event ID follow §9.5.

### 7.2 Timestamps

- A new message sets `created_at = last_modified_at = now`; a new message scheduled for time `S`
  sets `created_at = last_modified_at = S`.
- A normal published edit keeps `created_at`, sets `edited = true` and sets
  `last_modified_at = max(now, previous last_modified_at + 1)`, where the previous value is that of
  the **current applied** result, never of a pending scheduled version (§7.3).
  A scheduled edit uses its chosen time `S` instead.
- Every new event's timestamp `ts` is the creator's `now`.
- A message event's timestamp `ts` MUST be at most local `now + 5 minutes`, both for outgoing
  events and on receipt.
  There is no lower bound, not even the epoch's creation time: an event with an old timestamp
  simply expires sooner (§8.1), and a lower bound would lock out honest members whose clocks run
  slow.
  A root's `created_at` is not checked: a root never expires, and a strict bound would lose real
  invitations from owners whose clocks run fast.
- A received message event whose `ts` is beyond that bound has its content dropped unapplied and is
  marked `temporarily_invalid` (§9.6); it is not used as a parent or advertised as a tip.
- `created_at` and `last_modified_at` (including a scheduled-deletion time) MUST be at most
  `ts + MAX_SCHEDULE`, boundary included, both for outgoing events and on receipt.
  This bound does not involve the receiver's clock, so an event that fails it is permanently
  malformed and rejected.
  There is no lower bound: an old `created_at` or `last_modified_at` is legitimate.
- `last_modified_at ≥ created_at` is not enforced: a local-only edit may set any dates and Retry
  republishes them unchanged, and the display rule (§7.5) hides a result whose `created_at` is
  still in the future.
- Allowed timestamps are accepted as claimed, without local correction.

_Why:_ monotonic edit times let an edit win locally even across clock rollback.
The event timestamp is always the creation time, even for a scheduled message, so it needs only
clock-skew tolerance; the tight bound stops a fast or dishonest clock from extending an event's
retention or pushing it to the front of tip scans.
An honest creator takes `ts` and every scheduled date from the same clock at the same moment, so
measuring the scheduling bound from `ts` never rejects an honest event, and it guarantees that
every event activates while it is still served:

```text
last_modified_at ≤ ts + MAX_SCHEDULE    (bound above)
MAX_SCHEDULE      = RETENTION − 5 min

therefore:
last_modified_at ≤ ts + RETENTION − 5 min   (activation)
                 < ts + RETENTION           (end of availability = lookup deadline, §8.1, §11.6)
```

### 7.3 Scheduled future versions

A device keeps the effective current result plus **every** admitted pending future version of a
message.
A version becomes effective when its time arrives and then merges normally; superseded past content
is discarded.
A later future version never discards an earlier pending one.

Example: with content A today, edit B for Tuesday and edit C for Friday, display A until Tuesday, B
until Friday, then C.

Pending versions never become a past-edit archive.

### 7.4 Scheduled deletions

A delete event with `last_modified_at` is a scheduled deletion.

- Without `last_modified_at`, the deletion is immediate.
- If `last_modified_at` ≤ local now, the deletion is applied immediately.
- Otherwise it stays pending and MUST NOT absorb the message before its time.
- When applied, the device stores and serves the immediate form (without `last_modified_at`) under
  the **same** event ID and parents, re-encoded under the event's own version (§13.1).
  This is the only permitted same-ID change: it removes a field that is outside the result hash.
- For each message, only the **earliest** pending deletion is kept; later scheduled deletions of
  the same message are pruned immediately.
  An earlier one arriving later replaces the pending one.
- An immediate deletion absorbs the message at once and clears pending deletion work.
  Postponing an applied deletion, or any other date rewrite, is rejected.

**Lifecycle.** Pending deletions are persisted with their time in a durable time-sorted index.
On startup or resume, and before relevant message access or publication, the device applies all due
deletions atomically.
It then schedules each remaining one idempotently, with each wait clamped to 2 hours.
While connected it runs a fallback scan every 30 minutes, and every 5 minutes for an open chat.
Timer callbacks only wake the shared apply path, which rechecks state.

_Why:_ deletion is terminal and events cannot be withdrawn, so only the earliest scheduled deletion
matters.

### 7.5 Display

- The messages of a group, from all its epochs and side branches, are shown in one chronological
  view, ordered by ascending `(created_at, resultHash)`.
- A message with `edited = true` shows **"Edited at"** followed by its `last_modified_at`;
  otherwise it shows `created_at`.
  `edited` is a claim, not proof.
- A message is displayed only once `now ≥ max(last_modified_at, created_at)`.
  Merging and activation still depend on `last_modified_at` only (§7.3); a current result whose
  `created_at` is still in the future is applied but stays hidden.
- Deleted messages, messages past the moment of the message timer (§7.7) and pending future
  content are hidden.
- Roots and signed objects are not messages.
  They produce lines in the view.
  A signed object's line is placed at the time the object was received.
  A root's line is placed at, and shows, the time `T`, computed **once** when the device adopts the
  root, stored with it and never recomputed:

  ```text
  T = max(M + 1, min(root.created_at, t_adopt))
  ```

  `M` is the greatest `created_at` among the visible messages the device holds at that moment in
  the root's parent epochs; when it holds none, `T = min(root.created_at, t_adopt)`.
  `t_adopt` is the device's clock at adoption.
  A message of a parent epoch that arrives later is placed by its own `created_at`, above or below
  the line; the line does not move.
  Devices may compute slightly different `T` for one root; this affects display only.

  _Why:_ the line never sits above an old-epoch message the device already showed, every device
  normally shows the owner's date, and an owner with a fast clock cannot push the line into the
  future.

  The lines are:
  - who was added or removed by a root, and any change of name or owner (§4.8, §5.11); a removed
    member whose signed leave the device held is shown as having left;
  - "You were removed from this group" (§5.6);
  - "This group was dissolved by its owner" (§5.8);
  - the lines of §5.10 when the device is added back.

- Two groups are shown as one conversation only when they are linked (§5.10).

### 7.6 Replies, forwards, reactions and media

**Replies** are carried in metadata as `replyTo`, a list of 1 to 32 targets.
Each target is a pair:

```text
[ref_chat_id, syncObjId]
```

where `ref_chat_id` is the reference of the target's epoch (§4.5), also when that epoch is the
reply's own.
A list with more than 32 targets is malformed.
A `replyTo` entry that is present but holds no target, more than 32, or a target that does not
decode makes the whole event malformed (D.21); "never rejected because of its references" applies
to well-formed targets that cannot be resolved.
_Why:_ one single way to write each message.
The limit bounds the list of one message; the number of messages that reply to one message is not
bounded.

A reply is a new message, so it is published in the current epoch of the group it is written in
(§10.4).
It carries no quote: every preview is built from the reader's own copy of the target.

- **What a reply may point to.** Any message the sender holds, in the same group or in another
  one.
  Only a member of the target's epoch can compute its reference.
- **Several targets.** A device MUST accept and display any valid list.
  It need not offer a way to send more than one target; that interface is deferred (§17.5).
  Each target is resolved on its own, and targets may be in different groups.
- **A receiver never rejects a message because of its references.**
  A reference it cannot resolve may name an epoch it was never in, and validity must not depend on
  which roots a device holds.

**Not active in the first release.** Every version-1 device **answers** a chat lookup by
reference (§12.7). The first release does not **send** one, and does not fetch a quoted target
because a reply names it: nothing that follows from "Resolving a reference" to "What comes back"
is sent. This is local policy (§2.2), off by default, to be turned on in a later release once these
points are settled:

- the fetch of a quoted target in an installed epoch asks every eligible member; it should be
  bounded to the peers of the round;
- the limits on the references looked up count per delivering peer; they should be per chat;
- the count of rounds restarts once every reply naming a reference is deleted and sent again; it
  should hold across such a deletion;
- the reply's author field, an unsigned claim, chooses the second peer asked;
- a reply held only in a read-only chat must start nothing, on every path.

Turning it on later is compatible: nothing of it is on the wire beyond the lookup that every device
already answers. What stays on in the first release is what makes it safe to turn on: the
closed-chat and dissolved markers keep the reference of the root they close (§14.2), and the
references of the held roots and of the invitations not answered yet are computed. A quote is
shown, as below, when the device already holds its target. The rules below are the design for the
release that turns it on.

**Resolving a reference** (not active in the first release). A device resolves a reference against
what it holds (§4.5): the roots it installed, the invitations it has not answered, and its
closed-chat markers (§14.2).

- **An installed epoch.** To load a target it lacks, the device performs a sync-object lookup in
  the target's epoch (§12.5), subject to §10.4. Nothing is fetched in a read-only group.
- **An invitation not answered yet.** Nothing is sent. The target is fetched as above once the
  user accepts. _Why:_ nothing is sent in an epoch the user has not accepted (§4.8).
- **A closed chat**, whatever closed it, "Ignore and Delete" included. Nothing is sent, ever.
- **No match.** The device sends a chat lookup by `ref_chat_id` (§12.7), which returns the root
  only to a member of that epoch.

_Why never ask for a closed chat:_ when the marker kept the chat ID only, a reply naming that chat
made the device ask, the root came back and was dropped, and the next reply made it ask again. A
peer could see the device throw the root away. With the reference kept in the marker the device
never asks, which is exactly what a device holding an unanswered invitation does: "ignored and
deleted" and "not answered yet" look the same.

**When.** Only on receipt of the reply, after a short random wait; never on display or reading.
No action of the interface starts a lookup or a fetch of a target.
_Why:_ a lookup made when the user opens the message would tell a peer when it was read.

**Whom.** At most three peers per round, among the members of the reply's epoch that may receive
anything of it (§10.4), this device excluded, in this order:

1. the peer that delivered the reply to this device;
2. the reply's author, when that is another peer: the author field is an unsigned claim, used only
   for this order;
3. the other members, those with a session first, each drawn by score (§11.8).

**How often.** With no root back, the device tries again at most once a week, four rounds in all
for one reference, and only while it holds a reply naming that reference. Once no such reply is
held (deleted, or past its moment, §7.7), it stops and forgets the reference. After the fourth
round it stops for good: a new reply naming the same reference does not start the count again.
"Not available" carries no penalty (§11.8). These numbers, and the bounds on the references looked
up at once, are local policy (§2.2, §17.4).

**What comes back.** A returned root must have the reference asked: the device computes it again,
and any other root is an invalid answer (§11.4, §13.4). A root that matches goes through the normal
reception of §4.8, with no special case: a skipped epoch of a group the device is in joins that
group's history without a prompt (case 2); the root of a group the user was added to, whose
invitation never arrived, is an invitation, prompted as any other (case 5). A closed chat cannot
come back this way, since it is never asked for.

**Display.** A preview has two lines: "\<author\> in \<group name\>", then the shortened, wrapped
content.
"in \<group name\>" is dropped when the target is in the same group.

- The **header** of a message shows the previews of the messages it replies to.
  The **footer** shows backlinks: the previews of the messages that reply to it.
  Both use the same component.
- A preview is shown whenever the reader holds the target, whatever its group.
  Selecting it opens that conversation at that message.
- Until the device holds the target's epoch, installed, nothing is shown; the preview appears once
  the device holds the target's epoch and the target.
  "Message unavailable" is never displayed.
- If the epoch is installed but the target is not loaded, the preview shows a loading state with
  the retry progress (stage n of 20, §11.4), then a failed state.
  There is no retry button; a later notice, scan result or reconnection can restart the retrieval
  (§11.5).
- If the target is in a group the user has hidden, nothing is shown.
- Up to 4 previews are rendered normally.
  With more than 4, they are shown in pages of 4 that are swiped horizontally, with a pagination
  control and a "show all" button.
- A single-click toggle switches between most recent first and least recent first; it starts on
  most recent first.

_Why no "Not a member" answer:_ such an answer would be a first-hand statement that the epoch
exists and that the responder was in it, and would let a later member map an earlier member list by
asking every peer.

Caveat: a reference is the same value everywhere.
Members of the reply's epoch who are not in the target's epoch see an opaque value and can tell
when two replies point to the same unknown epoch, nothing more.

Known limits of resolving references:

- An invitation can appear because of a reply: the root fetched by reference may be that of a
  group the user was added to whose invitation never arrived.
- The quote of a message in a chat not accepted yet appears only after accepting.
- A skipped epoch fetched this way joins its group like any adopted epoch and is then synced in
  full (§12.3), not only the quoted message.
- What a peer learns from being asked: only that this device does not hold the epoch behind a
  value that peer already saw in the reply. A peer that is in that epoch already knows whether the
  asker is a member.

**Forwards** are content-only copies in the destination chat.
Their body is `[content_type, content]`, a permitted copied content value: `content_type` is `text`
or `media`, never a forward, a reaction or a deletion; a forwarded text is valid UTF-8 of at most
16,384 bytes, and forwarded media is the canonical encoding of a media body. Anything else makes the
event malformed (D.20).
They contain no source chat, source sync-object ID or reference, and no original author; the
claimed author is the forwarder.
Destination metadata is rebuilt from an allowlist of understood content-only fields.
Reply, provenance, source and unknown fields are dropped, with a warning if content is unsupported.
Recipients MUST NOT need access to the source to render a forward.
Media in a forward must be copied into fresh destination-authorized objects; the mechanism is part
of the content specification.

_Why:_ references would leak source metadata and fail for recipients without source access.

**Reactions.** A reaction is a message event of type `reaction`. Its body holds:

| Field    | Rule                                                                   |
| -------- | ---------------------------------------------------------------------- |
| `target` | the `syncObjId` of the message reacted to, 32 bytes, in the same epoch |
| `emoji`  | UTF-8 text, 1 to 64 bytes                                              |
| `action` | `add` (0) or `remove` (1)                                              |

The person reacting is the event's `author` field.

- **Identity.** The reaction's `syncObjId` MUST be

  ```text
  syncObjId = H("gossip.groups.reaction.1", target, author, emoji)
  ```

  A reaction whose `syncObjId` is anything else is malformed. A reaction is therefore unique per
  message, per author and per emoji: a second one with the same three values is another version of
  the same object, never a second reaction.

- **Versions.** Adding and removing are versions of that one object, ranked like any message
  (§7.1, §7.2): the greater `last_modified_at` wins, and a new version takes the later of now and
  the previous date plus one, so a date in the future freezes nothing. On equal dates a _remove_
  wins over an _add_ (§7.1).
- **No deletion.** A delete naming a reaction's `syncObjId` has no effect on it (§7.1): a reaction
  can be removed and added again, never deleted for good.
- **What is checked.** The lengths, that `emoji` is well-formed UTF-8, and the identity above.
  Whether the text is an emoji is not checked: that changes with each Unicode release, and devices
  must agree on validity. Whether the target exists is not checked either.
- **What a device may keep.** After a _remove_, the `syncObjId` and the date are enough.
- **Message timer.** In an epoch with a message timer, a reaction is erased by the timer, record
  included (§7.7).
- **Display.** A reaction is shown on its target while its current version is an _add_. The author
  is a claim, like every author here; a device shows at most one reaction per author and emoji
  because the identity allows only one. A reaction whose target is not shown is not shown.
- A reaction is never forwarded: a forward whose content type is `reaction` is malformed.

**Media.** A media message is a message event of type `media`. Its body holds:

| Field      | Rule                                              |
| ---------- | ------------------------------------------------- |
| `mimetype` | says what `data` is; see below                    |
| `data`     | any bytes, possibly none; opaque to this protocol |

- **The mimetype** MUST have the form `type/subtype`, at most 127 bytes in all. `type` and
  `subtype` each start with a lowercase letter or a digit and continue with lowercase letters,
  digits, `.`, `+` or `-`. No parameters follow it. A media message whose mimetype has another
  form is malformed.
- **Nothing else is checked.** Whether the mimetype is a known one, and whether `data` matches it,
  never decide validity. A device that does not know a mimetype stores, serves and relays the
  message like any other, and shows a placeholder.
- **Size.** No limit applies to media as such. The only bound is that the event fits its
  envelope (§13.10), like every event.
- A forward whose content type is `media` carries the same two fields and is checked the same way.

_Why a mimetype and nothing more:_ it is how kinds of content are added within this wire version.
A later release may define a new one, whether standard (`text/vcard` for a contact card) or its
own under the vendor tree (`application/vnd.…`), and every device of version 1 carries it without
understanding it. In particular the data may be a **reference** instead of the content itself: a
description of a file (its size, its hash, a key, where to fetch it) whose bytes travel by other
means, which is how files larger than an event can be shared without any change to this protocol.
Names, captions and similar details go in the metadata (§6.2).

A mimetype extends what a message can be, never how the protocol behaves: queries, merging and
membership are untouched by it. A device SHOULD fetch what a reference points to only when its
user asks, since fetching from elsewhere is seen by whoever serves it.

### 7.7 Message timer

The root of each epoch carries a **message timer** `T`, in milliseconds (§4.1). It is a local
rule: nothing is ever sent because of it.

**The moment.** A message of the epoch is deleted on each device at its **moment**:

```text
moment = created_at + T
```

- `created_at` is the creation date of the message's current result (§6.2); an honest edit keeps
  it (§7.2), so an honest edit never extends a message. A version with another creation date (a
  local-only change of the date and a Retry, or a hostile member) can move the moment; see the
  known limits below.
- `T` is the timer of the root of the epoch the message event belongs to. Each message keeps the
  timer of its own epoch: a later root with another timer changes nothing for the messages of
  earlier epochs.
  _Why:_ applying a newer timer to older messages was rejected, because one change of the timer
  could then delete a whole chat by accident.
- `T = 0`: never. The sum is exact (§1); a moment past the top of the integer range never comes.
- A deletion event has no moment of its own: it goes with the message it deletes (below).
- A reaction has a moment of its own, `created_at + T` of its epoch; see "Reactions" below.

**At the moment** the device erases the message. Nothing about it remains on the device: no
result, no tombstone, no stub of any of its events, no parent link of them, no pending version, no
pending scheduled deletion, and no peer-knowledge hint that names one of its events. Every record
goes in the same commit (§15.2). The moment is kept in the durable time-sorted index of §7.4 and
wakes the device like a scheduled deletion; the view hides the message from its moment even
before that runs.

The database overwrites what an erasure frees; the encrypted storage below it can keep an earlier
copy for a short time (§16.10).

_Why local:_ every device computes the same moment from the same dates, so all converge with no
exchange: devices that were offline, read-only groups (kicked, left, superseded) and archives of
dissolved groups included. _Why erased rather than kept as a tombstone:_ a stub, a parent link or
a tombstone would show, on an unlocked device, that a message existed and when, for as long as the
group is kept; the timer is there so that nothing is left. _Why this is safe:_ stubs and
tombstones exist so that a deleted event is not fetched again and a deleted message does not come
back; under the timer the dates do that job, since every copy offered after the moment is refused
by its own dates (below), whether the device held it or not. What a peer can see is what §9.3
allows: a lookup of one of its events is answered "not available"; it is no tip; a sync-object
lookup finds no event carrying it.

**What erasure leaves alone, and why.**

- An event still held that names an erased event as a parent keeps its own parent links: they are
  its record, served with it (D.33). They do not make the device look the erased event up: parents
  are looked up when a child is first accepted (§6.3, §11.1), never for a child already held. The
  tips and the cycle frontier do not change: they are computed from the available events, and an
  erased event was not available any more (§6.1, §12.1, D.27). The child goes at its own moment.

**A message deleted before its moment.** A message deleted by a deletion event (from anyone, or
published by this device) or by a local-only deletion (§9.2), after the device processed it, keeps
its tombstone, its deletion events, the stubs of its events and their parent links until its
moment rounded up, and is then erased like a message the timer deleted:

```text
erase_at = ceil((created_at + T) / step) × step
```

| `T`                  | `step`                |
| -------------------- | --------------------- |
| `T` ≤ 1 hour         | 5 minutes             |
| 1 hour < `T` ≤ 1 day | 1 hour                |
| 1 day < `T` ≤ 1 week | 1 day (24 hours)      |
| `T` > 1 week         | 1 week (7 × 24 hours) |

- The multiples are counted from the Unix origin in milliseconds: plain arithmetic, no calendar,
  no time zone. The arithmetic is exact (§1): a rounded date past the top of the integer range
  never comes, and the tombstone is then kept as long as the group.
- When the versions of the message carry different creation dates, the latest moment among them
  counts (below), then it is rounded. A later version that the tombstone absorbs counts too.
- The rounding applies only to the date kept beside a deleted message. A message nobody deleted
  is erased at its exact moment.
- Until `erase_at` the tombstone does its job: the message cannot come back. After it, a copy
  offered late is refused by its own dates, as for any erased message.
- `T = 0`: nothing changes; the tombstone is kept as long as the group (§7.1).

_Why:_ deleting a message by hand must not leave more trace than letting the timer run. Kept as
without a timer, the tombstone would say, for as long as the group is kept, that a message
existed. _Why rounded:_ the exact moment would keep the exact creation date of the message beside
its tombstone. _Cost:_ the device keeps one coarse date beside the tombstone until then.

**A deletion for a message the device never processed.** A deletion carries no date, so a device
that receives one for a message it never processed (erased already, never received, or not yet
received) cannot know the message's moment. In an epoch with a timer:

- the record the deletion creates is **quiet**: the device keeps it to itself. It never announces
  its events (§10.2) and never lists them in a tips scan (§12.1). It still answers a direct request
  for one of them (an event lookup or a sync-object lookup), and still pushes the deletion in full
  to every removed peer of the epoch when it processes it, as any deletion is pushed to them
  (§10.4).
- It is erased, with every record of it, at the time the deletion was processed plus `T`, rounded
  up with the table above. Another deletion of the same message while the record exists changes
  nothing.
- The first time any version of the message itself is processed for that record, even a copy the
  tombstone blocks on arrival, the record becomes **shareable** again: `erase_at` is computed from
  the message's creation date by the rule above, and the device offers the deletion normally from
  then on. A copy refused by its dates (past its moment) is not processed and changes nothing.
- `T = 0`: every record is shareable, and behaves as without a timer.

This is the local field `shareable` of the current object (§14.1). It is written at exactly three
moments: every record starts `true`; a deletion that creates a record for a message never
processed, in an epoch with a timer, sets it `false`; the first version of the message processed
for that record sets it back to `true`. While it is `false` the device never announces nor lists
the record's events to current members, always answers a direct request for them, and pushes a
deletion it processes in full to the removed peers of the epoch (§10.4).

_Why the processing time plus `T`:_ it is a safe bound, because an honest message is never created
after its own deletion. _Why quiet:_ that deadline restarts whenever the deletion is received
anew. If devices in this state offered it to each other, they would renew each other's copies
forever: one device that was offline is enough to stagger the deadlines. A device that holds the
message has a fixed deadline, the same on every device, so offering is safe there. _Why a direct
request is still answered:_ a peer asks only when something finite gave it the ID (a child event
or a reply, each with its own moment), so answering cannot keep the deletion alive. _Why the push to
removed peers:_ a removed peer relays nothing (§10.4), so the push cannot restart the renewal; without
it, removed members would stop receiving deletions, which must reach everyone who had the message.
_Side effect:_ a pushed deletion naming an epoch the receiver does not hold acts as a root notice
(§4.6), so the push is also how a deposed or removed device that missed a successor can learn that
a newer epoch exists. This is a side effect, not a guarantee: a dependable way for such a device
to learn of a successor root remains an open improvement for later.

**When the versions disagree.** Honest versions of a message share one creation date, so its
moment is that of each version. When versions carry different creation dates (the known limit
below), the device deletes the message at the moment of its current result, as a local-only
deletion (§9.2, §9.3), and erases it once every version it knows is past its own moment. _Why:_ an
erased event is unknown again; a version offered later is then refused only if its own moment has
passed. Erasing at the earlier moment would let a version with a later creation date come back and
be shown.

**Reactions.** A reaction is erased, record included, at whichever comes first:

- the moment its target is erased by the timer on this device;
- its own moment, `created_at + T` of its epoch, in any case.

Removing and adding a reaction again keeps its creation date while its record exists (§7.6), so
toggling never extends its life; once it is erased, adding it again starts a new life. _Why:_ a
reaction's `syncObjId = H(target, author, emoji)` can be checked by anyone who guesses the three
values, so a kept record says who reacted to what with which emoji, long after the target is gone.
_Why its own moment as well:_ a device that does not hold the target cannot know the target's
moment; the reaction's own date bounds it, since a reaction is made after its target exists.

**A message or reaction that arrives after its moment** (or a pending version that takes effect
after it) is dropped at once and never shown. Nothing about it is stored: no row, no stub, no
parent link, and its parents are not looked up. Offered again by a late peer, it is refused again
the same way, from its dates alone, whether or not the device ever held it. The lookup that fetched
it is complete, without penalty for the peer that supplied it, and the device neither relays it
nor records a hint for it, so two devices never pass it back and forth.
_Why nothing is stored:_ a record of an expired message would be a trace of it; and since the
refusal depends only on the dates, every arrival gets the same answer.

**What an erased event still costs.** An erased ID is unknown again, so the rule that a known
pruned ID is never fetched (§11.7) no longer covers it:

- a notice or a tip page from a peer whose clock is behind, which still holds the event, makes the
  device fetch it once per offer, until that peer's clock reaches the moment;
- a child that arrives after the moment and names it, made by a peer before the moment, starts one
  lookup task, which asks each member at most once (every honest device erased the event at the
  same moment, so each answers "not available") and then pauses until new evidence (§11.2, §11.5),
  and ends at the lookup deadline (§11.6). This is what a device that never held the event already
  did before erasure existed.

**Changing the timer.** Only the owner changes it, by a successor root that keeps the members, the
name and the settings (§4.1, §4.6), like a rename. The interface shows each epoch's timer and when
the epoch started, so that it can say from which point messages disappear after which time.

Known limits:

- A device whose clock is ahead deletes earlier, and answers "not available" earlier, than the
  others; one whose clock is behind keeps the message longer.
- When the versions of one message carry different creation dates (only after a local-only change
  of the date and a Retry, §9.1, §9.4, or from a hostile member), a device that receives the
  winning version only after its moment may show another version until that version's own moment.
  Every device ends without the message at the latest moment of its versions.
- A reaction that a device receives after its target was erased there, but before the reaction's
  own moment, is stored again until that moment, hidden: the device no longer knows its target's
  moment. The same holds on a device that never held the target.
- A pending scheduled deletion is erased with its message. A peer whose clock is behind may still
  serve it for a while, and a device that fetches it then stores it as the deletion of a message
  it never processed: a quiet record, kept for `T` after it was processed, rounded up, and offered
  to no one (above). The same holds for a deletion event that arrives after the moment of its
  message. A deletion carries no date that would let a device refuse it safely: its target's
  creation date is not in it.
- A notice of an event, sent just before its moment and received just after, makes the receiver
  fetch it; the sender answers "not available" and gets the small penalty of an announcement it
  did not supply (§11.8).
- Erased records leave the logical records of §14.1. Whether the storage below keeps freed bytes
  (free pages of a database, a journal) is a property of that storage, as for any deletion (§16.3).
- Copies outside the protocol (backups, screenshots, unofficial clients) are out of reach (§16).

## 8. Retention

### 8.1 Message retention

Message events, including deletion events, stay available to serve for `RETENTION` (two weeks plus
five minutes) after their event timestamp.
Retention never removes the stored current result or a tombstone, and never applies to roots or
signed objects (§4.10, §5.1).

- Every message event, scheduled or not, is available until `ts + RETENTION`.
- A pending scheduled version is kept locally until it activates, even after `ts + RETENTION`, but
  is no longer served after that time.
- An event received after its availability has ended is still validated and merged, then pruned at
  once (or kept unserved until activation, if pending).
- An event restored under §9.5 is available only while its window is still open.

_Why:_ aging by the event's own timestamp gives every device the same expiry for the same event, so
every honest device stops serving it at the same moment, and the lookup deadline (§11.6) can equal
it exactly.
Scheduled events need no longer window: one obtained while available is applied locally when its
time comes, which needs nothing from the network, and `MAX_SCHEDULE < RETENTION` (§7.2) makes every
event activate before it stops being served.

### 8.2 Capacity eviction

Independently of retention, a device MAY evict available message events under storage pressure,
oldest event timestamp first, including deletion events.
Pending scheduled events are exempt; their storage is reserved at admission.
Current results, tombstones, processed stubs and needed parent links are kept.
Capacity eviction can shorten recovery.

## 9. Local changes

### 9.1 Local-only edits

A user may change the stored result of any message locally: content, claimed author, both dates,
metadata and the `edited` flag.
No event or notice is sent, and no indicator is added automatically.
A content edit automatically sets `last_modified_at = max(now, previous + 1)`, with the previous
value taken from the current applied result as in §7.2, unless the user explicitly entered a date,
which then wins.
The UI MUST NOT accept a `created_at` or `last_modified_at` beyond `now + MAX_SCHEDULE`, so that a
Retry of the altered result (§9.4) always satisfies the bound of §7.2.
Later received results still merge normally against the altered result.

### 9.2 Local-only deletion

A user may locally replace a message with its tombstone, which is absorbing as usual.

### 9.3 Withdrawing shareability

After a local-only change, the device prunes every event of that message: content access is removed
and only a generic ID stub and its parent links remain.
Requests for those events answer N/A.
Pending plaintext work referring to them is invalidated.
No original copy, local-edit marker or pruning reason is kept.
The stub is indistinguishable from ordinary retention pruning.

Already encrypted packets may still carry the earlier content (§15.3).

_Why:_ the altered message stays visible locally, but this device stops serving any version of it,
so it cannot leak the alteration or contradict it.

### 9.4 Retry synchronisation

The UI offers **Retry synchronisation** on messages of any accepted group, regardless of whether
they were altered; eligibility is rechecked when the action runs.

- **Message:** republish the stored complete result in a fresh event of the message's own epoch
  (new event ID with the current timestamp, current tips as parents), unchanged, to the peers
  allowed by §10.4.
  Peers merge it normally.
- **Group:** resend the exact root of the group's current epoch to its other members.

### 9.5 Events arriving under an already-known ID

A full event can arrive under an event ID the device already knows (for example a pruned stub, or a
late answer).
After normal validation:

- **Not yet processed** (only the ID was known): merge normally, even after the lookup deadline.
- **Processed, payload projection identical to the current result:** restore its availability if
  its retention window is still open; do not reapply it or send notices, but include it in tip
  scans when it qualifies.
- **Processed, payload projection different:** keep it pruned, even if it would win; store no extra
  old copy.

A notice or parent reference to a pruned ID never triggers a fetch (§11.7).

_Why:_ if a device altered "hello" to "bye" locally and pruned the event, a duplicate "hello" under
the old ID must not become servable: serving "bye" under it would leak the edit, and keeping
"hello" would retain old plaintext.

### 9.6 Temporarily invalid events

A future-time rejection (§7.2) is recoverable, not a pruned stub.
The device keeps a local marker with the scoped ID and retry bookkeeping, but not the rejected
content, claimed object or parent links.
A later notice or parent reference can reactivate retrieval, which revalidates fresh content from
scratch.
Reactivation uses the normal retry renewal (§11.5).
The marker is cleared on the first valid acceptance of that event.
The marker lives while the group is retained; if capacity forces it out, a later advertisement may
recreate the work.

## 10. Dissemination

### 10.1 Neighbors

- A neighbor is a member of a group's current epoch with whom we hold a neighbor connection for
  that group.
  There is one neighbor set per group, whatever its number of epochs.
- Each group seeks `min(10, memberCount − 1)` neighbors, never counting ourselves, where
  `memberCount` is that of the current epoch.
- When the current epoch changes, neighbors that are not members of the new one are dropped and
  replaced.
- Agraphon sessions are shared across groups; holding a session does not make a peer a neighbor,
  and a device MUST always attempt to reuse suitable existing sessions with eligible members before
  opening new ones.
- The list changes with responsiveness: peers that keep failing to answer are replaced, preferring
  eligible members already connected through other groups.
  An occasional delayed answer is not a failure.
- The peer score (§11.8) ranks candidates; its formula is deferred, and until it is specified
  unmeasured peers have a default score of 0.5.
- Responsive neighbors are not rotated proactively.

**Neighbor requests.** A peer asks to become our neighbor with `neighbor_request` (§13.6), naming
its current epoch.
If we hold that epoch and have capacity in its group, we accept.
If we do not hold that epoch, we decline with no suggestions; the requester then announces the root
to us (§4.6).
Otherwise we decline and suggest up to ten distinct members of that epoch, excluding ourselves and
the requester:

- up to five non-neighbors first, then fill the remaining places from our neighbors;
- within each pool, sample by score without replacement, using repeated proportional draws, with a
  uniform draw when all remaining weights are zero;
- return fewer if the pools are smaller.

Requests from non-members are silently dropped.

### 10.2 Publishing and relaying

Every rule below is limited to the peers that may receive the item (§10.4, and for roots and signed
objects §4.6 and §5).

- **Own messages:** send the full event to every neighbor that is a member of the event's epoch.
  _Why:_ neighbors hold copies even if the sender goes offline right after sending.
- **Relayed events and fabricated messages** (attributed to another member): send gossip notices
  only, and answer explicit requests with the full event.
  _Why:_ fabrication then looks like an honest relay.
- **Roots and signed objects:** their first send is defined in §4.6, §5.3, §5.6 and §5.8.
  A device that received one relays it by notice only, and answers explicit requests with the full
  object.
- Every dissemination also goes to up to `min(2, eligible − currentEligibleNeighbors)` distinct
  eligible non-neighbors, chosen uniformly at random once per dissemination, where the eligible
  peers are those that may receive the item.
  They receive the same form (full or notice).
  These temporary recipients do not become neighbors; their responses feed the peer score.
- Query answers and the owner's deliveries of a root do not trigger extra recipients.
- A device MUST NOT announce an event, a root or a signed object unless it currently holds its full
  content and may serve it.
- A device MUST NOT announce an event of a quiet record (`shareable = false`, §7.7, §14.1); it
  still answers a direct request for it, and still pushes a deletion of it in full to the removed
  peers of its epoch (§10.4).
  Receiving a notice never makes an item announceable; it must first be fetched, validated,
  processed and still be available.

### 10.3 Peer-knowledge hints

Hints let a device skip redundant outgoing notices.
For peer Bob, a device marks event E (and a bounded sample of E's locally known ancestors) as seen
by Bob when:

- it sends full E to Bob, once the backend confirms the ciphertext was published (local queuing is
  not enough);
- Bob sends it a valid full E, including inside a query answer;
- Bob sends it a gossip notice for E (honest peers announce only events they hold in full).

Sending a notice, query requests and N/A answers never create hints.
Query requests never clear hints, and an event with older parents never clears hints for other
branches.

**Ancestor sampling:** starting from E, walk locally known validated parent links at most five
levels.
At each level, build the pool of known parents of the previous level's selected nodes, and sample
without replacement up to 16, 8, 4, 2 and 1 nodes.
That is at most 32 updates including E, examining at most 496 parent references.

**Storage:** hints persist across restarts.
Each expires 28 days after it is first recorded; neither use nor new evidence extends it.
Capacity is 65,536 entries per group, shared across its peers, with least-recently-used eviction;
there is no global cap.

Hints only suppress notices.
They never set processed or validity, never cancel needed retrieval, and never stop an authorized
query from being answered according to actual availability.

### 10.4 Sending and serving across epochs

Every epoch of a group stays usable for as long as its events are retained; there are no stages.
What changes after a successor is who may receive and send what.

**Removed peers.** For a device, a peer is **removed from epoch X** when X is superseded on that
device and the peer is a member of X but not of the device's current epoch.
The test is against the current epoch, not against every epoch in between: someone removed and
later added back is no longer a removed peer.

**Where a device publishes.** Take X = {A, B, C}, superseded by Y = {A, C, D}, the current epoch; B
was removed.

| Published                                   | In which epoch        | To whom                                              |
| ------------------------------------------- | --------------------- | ---------------------------------------------------- |
| A new message                               | the current epoch (Y) | its members (A, C, D)                                |
| An edit or a Retry (§9.4) of a message of X | X                     | the members of X who are in the current epoch (A, C) |
| A deletion of a message of X                | X                     | every member of X (A, B, C)                          |

_Why:_ an edit carries new content, which a removed member should not get; a deletion removes
content, and should reach everyone who had the message.

**Serving a removed peer.** The table binds every device and every way of handing out the events of
a superseded epoch: first send, relay, notices, lookups and tip pages.
To a removed peer, a device hands out **deletion events only**.
Any other request is answered "not available", and tip pages list deletion events only.
There is no exception for messages sent before the removal.
The device also answers the removed peer with the kick that names it or with that peer's signed
leave, at most three times per day (§5.6).

**Accepting from a removed peer.** A device drops every message event a removed peer sends in the
superseded epoch: new messages, edits and deletions alike, including deletions of that peer's own
messages.
The filter is on the delivering peer, so an event relayed by a member that has not adopted the
successor yet is still accepted.

_Why:_ a removed member must not be able to affect the group any more than it already has, even
where that costs convergence between devices that had processed different events before adopting
the successor.

Signed objects are the exception: a root, a kick, a leave or a dissolve message that a removed peer
sends in full is accepted when valid, its notices of them are acted on, and the device may fetch
from that peer what it announced.
_Why:_ a signed object proves itself, whoever carries it, and a removed peer cannot forge one.
Refusing it would lose a membership fact when that peer is the only device online that holds it,
and would refuse its own leave coming from it. The cost is that a lookup tells that peer this device
lacked one membership object, which says nothing about messages or about who wrote them.

**Reaching the right peers in an older epoch.** Neighbors are chosen in the current epoch (§10.1).

- An edit in an older epoch goes to the neighbors who are members of that epoch.
  If none is, it goes to another member of both that epoch and the current one, chosen at random,
  in addition to the extra recipients of §10.2.
- The author of a deletion in an older epoch sends the full event to its neighbors who are members
  of that epoch **and directly to every removed peer of that epoch**.
  Relays use notices as usual, and scans cover failures.
- A device that processes a deletion it holds as a quiet record (§7.7, §14.1) sends the full event
  directly to every removed peer of that epoch, under the same conditions as any relay of it, and
  to no current member.

_Why push deletions to every removed peer:_ removed members are nobody's neighbors, so nothing
else would bring them the deletion quickly.
The cost is accepted: up to 511 ciphertexts for one deletion, each about 3.8 KB, because the
session adds about 3.6 KB to every ciphertext whatever it carries.
A notice would save nothing.

**Groups in a special state.** A device whose group is a read-only archive after a kick (§5.6),
or after it left and keeps the group read-only, applies deletion events for that epoch, verifies
and stores kicks, leaves and dissolve messages naming an epoch it holds, applies a dissolve message
naming that epoch silently ("Dissolve & Delete" erases its archive; it stays kicked or left and
announces nothing, §5.8), and drops every other incoming event.
A device in the waiting state (§5.4), and a device whose group was dissolved (§5.8), drop every
incoming event except roots, kicks and dissolve messages.
_Why:_ "Dissolve & Delete" is meant to erase the chat on every device that holds the epoch;
otherwise the removed member's device would keep the only transcript of a chat everyone else
erased. It is consistent with single deletion events, which already reach removed peers (§10.4),
and the owner gains no power it did not have: it could have dissolved with deletion just before the
kick.
_Known drawback:_ a removed member's archive stays within the owner's reach after the removal. The
owner can erase that member's copy of an epoch it holds although it is no longer in the group; only
a dissolve naming an epoch the member holds reaches it, never a dissolve of a later epoch (§16.8).

A device that holds an epoch but is no longer active in its group (kicked, left, waiting for a
kick, dissolved) answers a member exactly as a device that does not hold the epoch would, query by
query: "not available" to an event, sync-object, signed-object, removal or key lookup from a peer
that shares an active chat with it, silence to any other peer (§13.7), and "not available" to a
tips scan (§12.1). It sends a removed peer nothing either (§5.6).
It also starts nothing for that epoch: no event, sync-object, signed-object, removal, key or parent
lookup, whatever a member announces in a notice or a page, and the lookups it had in progress stop
sending when the group goes inactive. They are kept, and go on if the group becomes active again
(the device is added back and accepts); so does a lookup it needs meanwhile for an event it still
accepts, such as the missing parent of a deletion pushed to it, which asks no one until then. A sync-object lookup the user asks for there ends at once,
not found.
_Why kept:_ a member added back, or a device restored from a backup, would otherwise lose the IDs it
learnt before, which a scan does not always bring back (an older event reached only through a
version since pruned); in the membership simulation, dropping them left a restored member added
back without part of an older epoch's messages in 23 of 300 runs. Kept, they cost no traffic while the group is
inactive.
The missing parent of a pushed deletion is the clearest case: the deletion references it, so it is
no tip any more and no scan lists it (§12.1); left unasked, it kept a member added back on the
older version of a message edited while it was away (6 of 300 runs).
A kick, a leave or a deletion of that epoch pushed to it is kept, but announced or relayed to no
one.
What it had queued, or already assembled, for that epoch when the group went inactive is decided
again before it goes (§15.1): its events, notices and neighbor requests are dropped; an answer gets
what a device that does not hold the epoch gives ("not available", or silence where such a device
is silent; a neighbor request is declined without suggestions); a frozen tips-scan list of that
group is dropped; a sync-object lookup in progress ends, not found; and a removed peer is owed
nothing more.
_Why:_ a device that deleted the chat drops or answers all of this the same way (§13.7); otherwise
work taken a moment before the kick would still tell a member that the device kept the history.
The exceptions stay: a request to be kicked goes (§5.4), a superseded chat of two still sends the
events queued before the switch (§5.12), an archive still serves what §5.8 lists, and a key answer
decided on receipt, which names no epoch, goes as decided.
What such a device still needs reaches it pushed in full: its own kick or leave (§5.6), deletion
events (above), a dissolve message (§5.8) and the roots that concern it.
_Why:_ a lookup or a notice tells the peer that gets it that the device still holds the epoch,
while a device that deleted the chat or never held it sends nothing. A root notice naming the epoch
was already ignored, as by a device that holds or closed it (§16.7).
The exceptions: a dissolved group still serves its roots and its dissolve message, and answers a
member's tips scan with a page of these two entries only (§5.8); an archive ("Dissolve & Keep
archived") gives a removed peer its own kick or leave (§12.8).
_Why:_ the answer is the one a device that deleted the chat, or never held it, gives; so a member
cannot tell "kept the history" from "deleted the chat", and nobody waits on silence.

**Limits.**

- The rules take effect device by device: a member that has not received the successor yet still
  treats a removed peer as a full member.
- A removed member can still obtain earlier messages of the old epoch from other removed members,
  which never learn of the successor.
- Members added later never see the earlier epochs, nor edits or deletions of their messages.

## 11. Retrieval and recovery

### 11.1 Lookup tasks

A missing event becomes one retrieval task per `(chat_id, eventId)`, shared by all references and
notices, whichever peer sent them.
The task records which peers were tried, are pending, answered N/A or supplied the event.
A full event that validates resolves the task, even if its result then loses.
Roots and signed objects have their own tasks (§11.8).

### 11.2 Candidates

Retrieval is staged, one peer at a time, never broadcast:

1. the peer that sent the notice, or the peer that delivered the child event that references the
   missing parent;
2. other eligible neighbors of the group that are members of the event's epoch;
3. other members of that epoch, preferring existing suitable sessions (including neighbors from
   other groups).

Neighbors are ranked lexicographically, descending, by:

1. whether they sent a notice for the event or a child referencing it;
2. their score;
3. the local receipt time of that trigger (newer first).

Neighbors without a trigger tie on the last criterion.
Exact ties are broken uniformly at random.
Trigger receipt times are local, per candidate, cleared when the task resolves or the event is
pruned, and never transmitted.

A peer with an outstanding request for the task is not reselected until it answers or its request
expires.
A peer that already supplied the event is not asked again.
A peer that answers comes before every peer that stopped answering, whatever the tier.
Among the peers that answer, a peer already asked for the item goes behind every eligible member
not yet asked for it, before any re-ask (local policy, §2.2), when it answered "not available"
since it last announced the item, or let a request time out without having announced it or
delivered a child naming it.
A new announcement of the item by that peer puts it back in its tier: it is new evidence (§11.5).
A `busy` or an `expired` answer does not count: a `busy` peer is asked again about a minute later
(D.46).
A timeout does not move a peer that announced the item: it is asked again once its request has
expired, until three timeouts in a row make it a peer that stopped answering.
_Why a timeout does not count for an announcer:_ a timeout says nothing of the item, while the
announcement still stands. Moved behind the members not yet asked, the only holder waited behind
every member never measured (each offline one costing a full stage), and the task could pause after
its last stage without asking it again.
_Why:_ a peer that went inactive in the group, or never held the item, gives the same answer every
time, while a member not yet asked may hold it; a simulated device kept asking such peers for a day
and hardly asked the member that held the events. The order keeps responsive peers first, so that a
holder that was busy once, or let one request time out, is not asked again only after each member
that stopped answering, one stage each, which took the simulated device most of an hour per
offline member.

### 11.3 Query timing

Every query carries `sent_at` (claimed send time) and `ttl` (nominal duration), both u64
milliseconds.

- A receiver ignores queries with `ttl = 0`, `ttl` over 24 hours, or `sent_at` more than 5 minutes
  in its future.
- A receiver may answer while `20 * now <= 20 * sent_at + 21 * ttl + 6000000`, which is
  `now <= sent_at + 1.05 × ttl + 5 minutes` computed exactly.
  Beyond that it sends an **expired** acknowledgement instead of content.
- The first TTL is 60,000 ms.
  After an unanswered timeout, the next nominal TTL is
  `min(86400000, ceil(current × 3142 / 1000))`.
- The requester waits locally `floor(nominalTTL × r)` milliseconds, where `r` is drawn uniformly
  from `[0.95, 1.05]` for each stage and kept for resends of that stage.
  Only the nominal TTL is transmitted.
- On a local timeout, the requester immediately tries the next candidate with the next TTL; there
  is no extra backoff sleep.

_Why:_ exponential growth fits asynchronous peers that may be offline for days, the local jitter
decorrelates traffic, and the receiver's margin covers that jitter plus 5 minutes of clock skew.

### 11.4 Attempts, answers and resends

- A logical query allows **20 unanswered stages** (the first attempt plus 19 retries), then pauses.
- Any valid actual answer (content, N/A or a mix) resets that query's stage and TTL progression.
  The answer does not mean the content was obtained.
- Independent queries, including concurrent tip scans with different neighbors, have independent
  progression.
- Before every resend, the requester removes items it has since obtained; nothing is resent when
  nothing remains.
- An **expired** acknowledgement, or a reconnection, triggers an immediate resend to that peer of
  the still-relevant query, with fresh `sent_at` and the current nominal TTL.
  Such resends do not change the stage, TTL progression or jitter.
  The duplicate-answer risk is accepted.
- Expiry reduces stale and duplicate answers but cannot prevent them: clocks differ, a peer may
  answer near the deadline, transport may deliver a timely answer late, and the resends above
  deliberately risk concurrent replies.
- A valid answer that arrives late is still processed and resets its query's progression; other
  peers' outstanding requests stay outstanding.
- An invalid answer (malformed, wrong ID, failed secret proof) is ignored: the peer is marked
  failed for this pass and the next candidate is tried at once at the current stage, which advances
  only on normal expiry.

### 11.5 Pause and renewal

A paused task keeps its identity.
A later notice, discovery result or reconnection that supplies a candidate starts a fresh 20-stage
run at the first TTL.
Repeated triggers during an active run are coalesced, and after another pause new evidence or a new
connection opportunity is required.
Renewal never extends the lookup deadline (§11.6).

### 11.6 Lookup deadline

For a missing message event, retrieval may continue until its event timestamp plus `RETENTION`,
read from the first 8 bytes of the missing event ID.
This is exactly when every honest device stops serving it (§8.1).

- The deadline covers active and paused time and is never renewed.
- A missing ID whose deadline has already passed is not requested at all; it is pruned to a generic
  stub at once.
- At the deadline the device stops new requests and resends, and prunes the ID to a generic stub.
  Requests already sent keep their own validity, and a valid late full answer is still processed.

_Why:_ retention counts from the event's own timestamp, so after `ts + RETENTION` no honest peer
serves the event any more and further requests would be wasted traffic.

### 11.7 No refetch of pruned IDs

A known pruned ID is never actively requested again, whether it appears in a notice, a parent
reference, a tip page or any other discovery.
An ID that the message timer erased is unknown again; §7.7 says what that costs.
Only unknown IDs enter retrieval.
A full event that arrives independently is still handled under §9.5.
Temporarily invalid events are not pruned and stay recoverable (§9.6).

Caveat: after a lookup deadline prunes an ID, a later announcement no longer fetches it, so a
relevant update or deletion can be missed.

### 11.8 Roots, signed objects and the peer score

**Retrieval.** A missing root is one retrieval task per `chat_id`, shared by every peer that
announced it or listed it in a page; a missing signed object is one task per `(chat_id, kind, id)`.
Their candidates are the peers that announced them, then the other members of the epoch when the
device holds its root.
Roots and signed objects do not expire, so these tasks have no lookup deadline (§11.6); they pause
and renew under §11.5.

**Limit on root fetches.** A device keeps at most 4 root fetches in progress per peer.
The other IDs that the peer announced wait in a per-peer list of at most 256 IDs.
Waiting means "not asked yet", never "forgotten".
IDs that are already installed, closed or being fetched take no place in the list.
If the list overflows, the device recovers the rest with a shared-chats scan of that peer (§4.11),
unless the peer is paused (below).
Both numbers are provisional (§17.4).

**Failed announcements.** An announcement fails when the announcer answers "not available", or
returns something that fails verification, for a root it announced or an epoch it listed in a
shared-chats page.

- After 3 failed announcements within 24 hours, root notices and shared-chats pages from that peer
  are not acted on for 1 hour; the pause doubles on each repeat, up to 24 hours.
  These numbers are provisional (§17.4).
- Other traffic with that peer is unaffected.

_Why a pause in addition to the score:_ for an unknown epoch the announcer is the only peer the
device can ask, so ranking alone cannot stop the waste.

These answers are legitimate and are **not** failed announcements: "not available" to a tip scan
whose anchor the responder does not hold (§12.1), to a chat lookup by `ref_chat_id`, and to a
parent lookup (§12.7).

**Peer score.** The score is per peer, across groups.
Its formula is deferred (§17.5); this document fixes its direction and the order of its penalties:

1. a wrong answer to a key query (§4.3) gets the heaviest penalty;
2. a failed root announcement gets a large penalty: it is rarely excusable, only when the peer
   deleted or closed the group in between;
3. an announced event or signed object that is then "not available" gets a small penalty: there are
   legitimate causes, such as an edit, a deletion, a local modification or pruning;
4. items that are supplied raise the score, so an honest peer recovers on average.

## 12. Discovery

### 12.1 Tip scans

Discovery asks a peer (a neighbor, or a random member in the periodic lanes of §12.3) for the tips
of one **group**, then retrieves unknown events and recursively their unknown parents.
It never enumerates every retained event.

**Anchor.** The request names an anchor: the requester's current epoch in that group.

- The responder answers only if it holds the anchor and both peers are members of it.
- A responder whose group is dissolved lists only its dissolve message and the root of its
  current epoch when it is not the anchor, never a message event (§5.8).
- If the responder does not hold the anchor, it answers "not available".
  This is legitimate (§11.8): being late on a root is not a fault.
  The requester then sends that peer a root notice for the anchor (§4.6) and runs the scan with
  another peer.

**What is listed.** The responder takes every epoch of the group that contains the anchor,
according to its own grouping (§5.10), and keeps those the requester is a member of.
Each entry of the list is a pair `[chat_id, id]` with its kind (§13.5), so the requester knows which
epoch each entry belongs to.

- For an epoch from which the requester is a removed peer, only deletion events are listed (§10.4).
- A leave or a dissolve message is listed only when the requester is a member of the epoch it
  names.
  _Why:_ it is a membership fact of that epoch, which only its members may learn, like every other
  object of it.
- An epoch with no retained events has no tips, so the size of a scan follows what is pending, not
  the number of membership changes.
- The events of a quiet record (`shareable = false`, §7.7, §14.1) are never listed: the tips of
  the list are computed without them, so that an event they name as a parent is listed if nothing
  else names it. A direct request for one of them is still answered.
- An entry whose `chat_id` the requester does not hold is handled as a root notice (§4.6); it is
  ignored if it matches a closed-chat marker.

**Tips.** A tip is an available event that no **available** event references as a parent (plus the
cycle frontier entries of §6.1).
_Why "available" and not "accepted":_ a pruned event answers "not available", so its parent links
cannot be learned from anyone. Example: E1 creates message 1; X1 creates message 2 with parent E1;
X2 edits message 2 with parent X1, and every device prunes X1 as superseded. If X1 still hid E1, the
only tip would be X2; a device that was offline fetches X2, asks for X1, gets "not available"
everywhere, and never learns E1, which still carries a current message. With "available", E1 is a
tip again once X1 is pruned (D.27).

**Order.** The responder builds the list before freezing it:

1. first every signed leave that is live for it (§5.3), and the dissolve message of its current
   epoch if it holds one (§5.8), in ascending ID order;
2. then the events, from two queues over all the listed epochs: deletion events, by event ID
   ascending, and the other events, by event ID descending (newest event timestamp first).
   It takes the next three deletion events, then the next other event, and repeats, the same 3:1
   ratio as §13.9; when one queue runs out, the other fills the rest.

IDs are never invented or reshuffled afterwards.

_Why:_ leaves and a dissolve change who is in the group, so they travel first; there are at most
511 per epoch.
Deletions travel ahead of other events so that removals are processed early when many pages are
needed, but new content is never starved behind a long run of deletions.

**Pages.** A page holds at most 128 entries and is a `[scanId, offset, count, entries]` payload.

- `count` is the number of entries remaining from `offset`, including this page.
  At offset 0 it is the total; a page is final exactly when `count` equals the number of entries it
  carries.
- A valid empty end page is `count = 0, entries = []`.
- An empty page with a positive count is invalid.
- A request whose offset is past the end of the frozen list is answered `malformed`.
  _Why:_ an empty last page or `restart` would hide the requester's own bug, which only it can fix.
- A page with one entry that cannot be read (an ID of the wrong length) is malformed as a whole
  (§13.5): nothing of it is used, its sender is penalised once, and the scan ends as for any
  invalid page.
- The requester treats a page whose `offset + count` differs from the total implied by an earlier
  page of the same scan as malformed: the scan ends and the sender is penalised.
  _Why:_ the list is frozen, so a moving total means entries skipped or repeated; an honest
  responder whose list is gone answers `restart` instead.
- Any in-range offset is accepted; pages need not align to 128, since byte limits may shorten them.
- Pages carry IDs only; the requester fetches the unknown items.
- The requester MUST reject a page whose `scanId` or `offset` differs from the correlated request
  entry.

The requester may request later pages without waiting for the items from earlier pages, and SHOULD
prioritize page requests over content requests.

### 12.2 Frozen lists

- The first valid offset-0 request with a new scan ID freezes the ordered ID list.
  Later pages refer to that list; new tips go into a later scan.
- Only references are frozen, never content.
  If a listed event is pruned, its position stays and a request for it answers N/A.
- Scan state is keyed by `(authenticated peer, anchor chat_id, scanId)`.
  The scan ID is an identifier, not a credential; every request is re-authorized.
- A duplicate offset-0 request with the same key reuses the frozen list.
  A conflicting immutable context is rejected.
- Every new scan uses a fresh random 32-byte scan ID chosen by the requester.

**Lifetime.** The responder keeps a frozen list until `sent_at + 1.05 × ttl + 5 minutes` of the
most recently **received** valid request of that scan.
That arrival order is used even if it shortens the deadline.
There is no separate inactivity timer.
After dropping a list it keeps an identifier-only tombstone, with the same key, for 24 more hours,
then forgets it.

A continuation whose list was dropped or is unknown, including an offset-0 request while the
tombstone exists, receives **restart**; the requester then begins a fresh scan with a new ID.
An expired request receives **expired** first; an immediate resend then receives **restart** if the
list is gone.
Under resource pressure, a responder refuses new scans with **busy** rather than evicting live
scans; only explicit shutdown or storage failure may drop a live scan, and its continuations then
receive **restart**.

The requester keeps its own scan reference until the same bound, so a valid late page can resume
the scan.
A page that arrives after the requester has dropped its reference is ignored; a fresh scan is
started if still needed.

The same frozen-list rules apply to shared-chats scans (§4.11), keyed by
`(authenticated peer, scanId)`.

### 12.3 Recovery triggers and cadence

Each trigger below scans the group's tips with the chosen peer.
There is one set of triggers per group, whatever its number of epochs.

1. **Accepting an invitation, or adopting a root:** scan two members (or as many as exist)
   concurrently, preferring existing suitable sessions.
2. **Connection reset:** both peers scan each other immediately and resend pending item queries.
3. **Expired acknowledgement:** resend the still-relevant scan at its current TTL.
4. **Periodic recovery:** four lanes per group, each scanning one peer per 24 hours, nominally 6
   hours apart, alternating kinds: neighbor, random, neighbor, random.
   That is up to four peers synced per day.
   - **Neighbor lanes (2)** visit neighbors in a persisted shuffled cycle, skipping removed ones
     and adding new ones among the unvisited; the cycle is reshuffled once exhausted.
   - **Random lanes (up to 2)** each scan one member of the current epoch that is not a current
     neighbor, chosen uniformly at random when the lane starts, never ourselves.
     If no such member exists, the slot is skipped; a neighbor is never substituted.
     These peers do not become neighbors; their responses feed the future score.
   - The next interval is measured from a scan's completion (answered or exhausted), in wall-clock
     time including offline time.
   - Each lane keeps completion + 24 h as its earliest next start; its offset from the previous
     lane applies when that lane is eligible, otherwise the start waits until it is.
   - When a periodic scan starts fresh, the next lane in the order starts `floor(6 h × r)`
     milliseconds later, `r` uniform in `[0.95, 1.05]`, even if the first is still pending.
   - Lane due times, active operations and the rotation cursor are persisted.
     After being offline, a device runs one overdue round, not one per missed day.
   - Phase starts at the device's first time online, never at a fixed hour.

_Why:_ neighbor scans recover what the usual peers hold, while scans of random non-neighbors reach
members outside the neighbor set and so can find events from a part of the group that the neighbor
connections never reach.

Overlapping triggers for the same peer and group share one operation and one retry state.
A reconnection resends it but neither resets its retries nor completes it.

No timestamp cutoff is used: a scan always lists all current tips, because claimed dates can be old
and clocks differ.

### 12.4 Event lookups

Event-ID lookups are exact: a responder never substitutes another event under the requested ID.
A root is never returned by an event lookup; it has its own lookup (§12.7).
In a superseded epoch, §10.4 decides what a requester may be given.
A lookup this device cannot or may not serve is answered under §13.7.

### 12.5 Sync-object lookups

Messages can be looked up by `syncObjId` as well as by `eventId`.

- The responder returns any available event carrying its current result for that message; if none
  is available, the answer is N/A, even if the message is still displayed.
- A responder never creates an event or restores a pruned one to answer.
- A request this device cannot or may not serve is answered under §13.7: "not available" to a
  peer that shares an active chat with it, silence to any other; a removed peer is answered under
  §10.4.

An answer is the responder's current view, not proof of the global latest value.
A lookup operation completes on its answer.
Later explicit requests or recovery triggers start a new operation.
Concurrent callers for the same target share one operation per generation.

### 12.6 Shared-chats scans

The shared-chats query of §4.11 uses the page pattern of §12.1 over chat IDs: each entry carries a
`chat_id` of kind root and no other ID.
It needs no epoch context.
It is answered only for an authenticated peer that shares at least one accepted epoch with the
responder (§4.11); other peers are ignored silently and learn nothing, not even an empty list.

### 12.7 Chat lookups

A chat lookup asks for a root.
It has three forms:

| Form         | Data                        | Used for                                                 |
| ------------ | --------------------------- | -------------------------------------------------------- |
| by ID        | `chat_id`                   | a root that was announced or listed (§4.6, §4.11)        |
| by reference | `ref_chat_id`               | the epoch of a reply target (§7.6)                       |
| by parent    | `chat_id, parentCommitment` | an unmatched parent of a root the requester holds (§4.8) |

- The responder answers only a requester that shares at least one accepted epoch with it, as for
  shared-chats discovery (§4.11); any other request is dropped silently.
- **By ID:** the responder looks for an accepted root with that ID.
- **By reference:** it looks for an accepted root with that `ref_chat_id` (§4.5), and answers
  exactly as it would answer a lookup of that root by ID: a group dissolved and kept as an archive
  serves its roots both ways, and a device no longer active in the group answers "not available",
  as for a reference it does not hold (§10.4).
  _Why:_ the same root gets the same answer whichever way it is asked.
  When a requester sends it, to whom, how often, and what it never asks for: §7.6.
  Every version-1 device answers it; the first release does not send it (local policy, off by
  default, to be turned on in a later release, §7.6).
- **By parent:** `chat_id` names a root that both peers must be members of; the responder looks,
  among the roots it holds, for the one whose commitment under that root's `epoch_challenge` equals
  `parentCommitment`.
- In every form, the responder returns the root only if the requester is a member of **that**
  root.
  Otherwise it answers "not available", whether or not it holds a matching root.

_Why:_ the same answer for "not held" and "held, but you are not a member" stops anyone who learned
an ID, a reference or a commitment from testing who belongs to that epoch.

There is no "Not a member" answer (§7.6); status code 1 stays reserved and is never sent.
"Not available" to a lookup by reference or by parent carries no penalty (§11.8).

### 12.8 Signed-object lookups

A leave, a kick or a dissolve message that was announced is looked up by `[chat_id, kind, id]`.
A **removal lookup** asks by `[chat_id, memberGossipId]` for every removal record of that member in
that epoch: the answer is the kick, the leave, or both, each as its own response to the same entry,
or "not available" when the responder holds neither.
A device uses it when it must answer a removed peer and holds no record for it (§5.6).

- The responder serves only a requester that is a member of the named epoch, and only while its
  group is active there; other requests are answered as for an epoch it does not hold, under
  §13.7.
- It returns the full signed object if it holds it and still serves it (§5.3, §5.6, §5.8), and "not
  available" otherwise.
- An archive ("Dissolve & Keep archived") answers a removed peer's removal lookup of its **own**
  record with its kick or leave, as it answers the signed-object lookup of the same record; a lookup
  of another member's record is answered under §13.7.
  _Why:_ the same record gets the same answer whichever way it is asked. The dissolve names a later
  epoch the removed peer is not in, so nothing else would ever end its membership of the epoch it
  was removed from. Only its own record is given, so nothing leaks.
- A returned object MUST hash to the requested ID and pass verification; otherwise it is an invalid
  answer (§11.4).

### 12.9 Key queries

A key query asks for the `UserPublicKeys` of a GossipID, as `[chat_id, gossipId]`.

- The responder serves keys only if it holds the named epoch, its group is active there (§10.4),
  and the requester, the responder and the subject are all members of it; other requests are
  answered under §13.7.
- It returns the keys it holds for that identity, or "not available".
- The requester MUST check that the returned keys hash to the requested GossipID.
  An answer that does not is invalid, and gets the heaviest penalty of the peer score (§11.8).

_Why no backend lookup:_ asking the backend for a member's keys would reveal to it who shares a
group with whom.

## 13. Wire protocol

### 13.1 Container

A group plaintext is the protocol version followed by one protobuf `Container`:

```text
plaintext = varint(PROTOCOL_VERSION) ‖ protobuf(Container)
```

It travels in an Agraphon session as a session message of the type reserved for group traffic,
and of no other type.
Session messages are typed, and each type has one meaning:

| Session message type | Carries                                  |
| -------------------- | ---------------------------------------- |
| group                | one group plaintext, and nothing else    |
| keep-alive           | nothing; it only keeps the session alive |

A receiver MUST ignore a group plaintext found under any other type, and MUST NOT treat a
keep-alive as carrying content.
A sender MUST NOT place group traffic in a keep-alive or in any type other than the group type.

The varint uses the protobuf unsigned varint encoding.
The receiver reads the version **before** parsing anything else and parses the container with that
version's schema.
The container holds a list of complete `Frame`s; several frames for one recipient (events, queries,
responses, notices) may share one ciphertext and one seeker.

Each frame holds exactly one kind:

| Kind                | Frame                                                                     |
| ------------------- | ------------------------------------------------------------------------- |
| `event`             | one blob: a root (§4.1), a signed object (§5.1) or a message event (§6.2) |
| `query`             | queries (§13.3)                                                           |
| `response`          | responses (§13.4)                                                         |
| `notice`            | gossip notices (§13.5)                                                    |
| `neighbor_request`  | §13.6                                                                     |
| `neighbor_response` | §13.6                                                                     |
| `leave_request`     | §13.6                                                                     |

**Event blobs.** Every root, signed object and message event, wherever it travels (an `event`
frame or inside a response), is an opaque byte string with its own version prefix:

```text
eventBlob = varint(eventVersion) ‖ protobuf(Event)
```

The receiver reads the event's version first, then parses the rest with that version's schema.

**Version rules.** There are exactly two version fields, both prefixes:

- The **plaintext prefix** versions everything built for that send: the container, queries,
  responses, notices and neighbor frames.
  No protobuf message carries a version field.
- The **event prefix** versions one event for its whole life.
  It MUST be less than or equal to the plaintext prefix; a higher one makes that event malformed.
- An event is validated under the rules of its own version.
  An event whose version the receiver does not support is rejected on its own; the rest of the
  plaintext is still processed.
- An event is served and relayed under its **own** version, with the same fields and therefore the
  same ID, never re-encoded under a newer version.
  A device need not keep the bytes it received: it may store the version and the fields in any
  layout and encode them again when it sends.
  No hash covers the encoded bytes (every ID is a hash projection of the fields, §1, and a
  signature covers an ID), so two encodings of the same fields are the same event.
  An activated scheduled deletion (§7.4) changes once: it is served, under its own version,
  without its `last_modified_at`.

_Why:_ events outlive the plaintext that carried them, so a device that has upgraded must still be
able to relay older events unchanged; everything else is built fresh for each send and needs only
the plaintext's version.
Keeping the event's version outside its protobuf encoding lets a receiver choose the right schema
before parsing it.

Queries, responses, notices and neighbor frames are not DAG nodes and cannot be parents.
Events returned inside a response keep their own identities and are validated normally.
Session announcements and keep-alives belong to the peer transport and never appear as group
frames.

### 13.2 Event frames

An event frame is a `Frame` of kind `event` holding one blob (§13.1): a root, a signed object or a
message event.
They are laid out as:

```text
[version]
[GROUP_ROOT]
[type: successor or handover]
[name]
[parents: 1 to 32 parent commitments]
[members: GossipID of each member]
[group_secret]
[owner: UserPublicKeys of the owner]
[epoch_challenge]
[ref_chat_id_challenge]
[created_at]
[migrate_from: optional, the protocol version of the conversation it continues]
[message_timer: u64 milliseconds, absent when 0]
[settings: text keys to byte values, at most 128 entries]
[signature]
```

```text
[version]
[GROUP_MESSAGE_EVENT]
[eventId = big-endian timestamp ‖ random]
[chat_id]
[secret_proof]
[parents: IDs of up to 16 childless events of this epoch]
[payload]
```

```text
[version] [LEAVE]    [chat_id] [gossip_id of the leaver]         [signature]
[version] [KICK]     [chat_id] [gossip_id of the removed member] [signature]
[version] [DISSOLVE] [chat_id] [must_delete]                     [signature]
```

### 13.3 Query frames

A query carries a `request_id`, `sent_at`, `ttl` and at most 16 entries.
Each entry is one operation:

| Operation                | Data                                     |
| ------------------------ | ---------------------------------------- |
| chat lookup by ID        | `chat_id`                                |
| chat lookup by reference | `ref_chat_id`                            |
| chat lookup by parent    | `chat_id, parentCommitment`              |
| shared-chats scan        | `scanId, offset`                         |
| event lookup             | `chat_id, eventId`                       |
| sync-object lookup       | `chat_id, syncObjId`                     |
| signed-object lookup     | `chat_id, kind, id`                      |
| removal lookup           | `chat_id, gossipId`                      |
| tips scan                | `chat_id` (the anchor), `scanId, offset` |
| key query                | `chat_id, gossipId`                      |

Requesters emit distinct entries.
Receivers still answer every entry position independently, and limits count all entries.
The `request_id` is an identifier, not a credential, and is never hashed.

### 13.4 Response frames

A response carries the query's `request_id`, `idx` and one result.
`idx` is the zero-based position of the answered entry in the original request; answers may be
reordered.

| Result | Content                                                                             |
| ------ | ----------------------------------------------------------------------------------- |
| event  | a blob (§13.1): a full root, signed object or message event with its version prefix |
| page   | `[scanId, offset, count, entries]`                                                  |
| keys   | the `UserPublicKeys` of the requested GossipID, serialized with bincode             |
| status | a status code                                                                       |

| Status          | Code | Meaning                                                               |
| --------------- | ---- | --------------------------------------------------------------------- |
| `not_available` | 0    | authorized, but not available here                                    |
| reserved        | 1    | reserved and never sent (§12.7)                                       |
| `restart`       | 2    | the scan state is gone; start a fresh scan                            |
| `expired`       | 3    | the query was past its receiver deadline                              |
| `malformed`     | 4    | the entry could not be parsed                                         |
| `unsupported`   | 5    | the plaintext's protocol version is higher than the receiver supports |
| `busy`          | 6    | refused for resource reasons; retry later                             |

Statuses carry no reason text.
**expired** is not an answer for retry purposes.

**Correlation.** The requester keeps a reference per `(peer, request_id, idx)` until that request's
own `sent_at + 1.05 × ttl + 5 minutes`, independent of the lookup task.
Each resend creates its own reference.
Only the first valid answer per wire entry counts for retry resets.
Duplicates may still supply event bytes, which are validated separately.
Responses that can no longer be correlated are dropped as responses.
The only uncorrelated response is the version notice of §13.8 (empty `request_id`, status
**unsupported**), which records the peer's highest supported version.
A returned item MUST match what was requested: the epoch and event ID or sync-object ID of an
event, the hash ID of a root or signed object, the reference or parent commitment of a chat lookup,
the GossipID of a key query.
Otherwise it is an invalid answer (§11.4).

### 13.5 Notices

A notice holds at most 128 entries and at most 16 KiB.
Each entry is `[chat_id, kind, id]`:

| Kind     | `id`                 | Announces                      |
| -------- | -------------------- | ------------------------------ |
| event    | 24-byte `eventId`    | a message event                |
| root     | empty                | the root whose ID is `chat_id` |
| leave    | 32-byte `leaveId`    | a signed leave (§5.3)          |
| kick     | 32-byte `kickId`     | a kick (§5.6)                  |
| dissolve | 32-byte `dissolveId` | a dissolve message (§5.8)      |

Entries may mix epochs, and each is authorized independently.
Page entries of a tips scan (§12.1) use the same form.

One entry that cannot be read (an ID of the wrong length for its kind, a `chat_id` that is not 32
bytes) makes the whole notice or page malformed: nothing of it is used, and the sender is penalised
once, as for one malformed item.
_Why:_ version-1 input that is not valid is rejected and counts against its sender. An honest
device builds these lists from identifiers it already checked, so it never sends such an entry and
cannot be framed by one; a spoiled list gives a hostile peer nothing more than sending no list.

### 13.6 Neighbor and leave-request frames

```text
neighbor_request  = [chat_id]
neighbor_response = [chat_id, accepted, suggestions]
leave_request     = [chat_id]
```

`chat_id` of a neighbor request is the requester's current epoch (§10.1).
`accepted` is a boolean.
`suggestions` holds at most ten distinct GossipIDs, chosen under §10.1, and is empty when accepted.

`leave_request` is the owner-only request of §5.4.
`chat_id` is the requester's current epoch.
It is processed only by the owner of that epoch, and only when the immediate peer is a member of
it; it is never relayed and never answered.

### 13.7 Authorization

- Every frame is authorized using the **authenticated immediate Agraphon peer**, never a claimed
  author.
- A peer that is not a member of the relevant epoch is ignored silently, with one exception:
  **One answer for a lookup that cannot be served (§13.7).** An event, sync-object,
  signed-object, removal or key lookup that this device cannot or may not serve is answered "not
  available" when the asker shares an active accepted chat with this device, and with silence
  otherwise. The answer is the same, byte for byte and with the same effect on the asker's budgets,
  whether the device never held the epoch, holds it but the asker is not a member, holds it in a
  group where it is no longer active, or holds it active without the object.
  _Why:_ nobody waits on silence, and one answer in every case means a member still cannot tell
  "kept the history" from "deleted the chat". A peer that shares no active chat learns nothing
  either way, as before.
  The exceptions already settled stay: a removed peer gets its own kick or leave (§5.6, §10.4); a
  dissolved group serves its roots and its dissolve message, an archive also a removed member's
  own record (§5.8, §12.8).
  The answer stays the same when it is assembled later (§15.1). An event or sync-object lookup
  taken while it could be served is decided again at assembly: if the epoch was deleted, or its
  group went inactive, in between, it gets the answer above, never the event and never silence
  where a device that never held the epoch answers.
  When the epoch is deleted, a queued root, signed-object or page answer gets the answer a device
  that never held it gives, decided as on receipt: "not available", or silence where such a device
  is silent; a queued neighbor response becomes a decline without suggestions (D.6).
  A key answer names no epoch: decided on receipt, it goes as decided. A "not available" decided on receipt ages as
  content does: assembled past the request's deadline (§11.3), it is `expired` too.
  _Why:_ otherwise the answer would tell apart, by its timing, a lookup the device could serve from
  one it could not.
- Shared-chats scans and chat lookups have no epoch context and follow §4.11 and §12.7 instead.
- A member of a superseded epoch that is a removed peer is served and heard under §10.4.
- Errors, counts and timing state are allocated only after authorization.
- Frames for unknown, unaccepted or closed epochs are dropped without staging.
  Three things are exempt and follow their own paths: a root (§4.7, §4.8), a root notice (§4.6) and
  a page entry of an unknown epoch (§12.1).
- An unparseable container or frame is rejected entirely, and so is a notice or a page with one
  entry that cannot be read (§13.5).
  The entries of a query are isolated instead: an invalid entry is answered `malformed` after
  authorization, and the other entries get their normal answers, without renumbering.

### 13.8 Versions and extensions

- A plaintext whose prefix version is unsupported is rejected before any protobuf parsing.
  There is no negotiation.
- **The version notice.** When that version is **higher** than any version the receiver supports,
  the receiver does not process the plaintext and does not penalise its sender. It answers with
  one plaintext at its own highest version holding one response frame, with an empty `request_id`,
  `idx = 0` and status **unsupported**.
  - It is sent **only to a peer the user explicitly accepted as a contact** (§5.12), whether or
    not they share a group. A peer whose connection is automatic, or any other peer, gets silence.
  - The version prefix is read **before** any other check, the size check included: a later
    version may use a larger container, and must still be answered.
  - It is sent at most once per peer and received version per 24 hours (a default, §2.2).
  - A plaintext with a lower unsupported version is dropped silently.
- **What the notice is for.** It is the upgrade path of this protocol. Suppose a later wire
  version exists, Alice's device speaks it and Bob's does not. Alice's device sends Bob an
  invitation in the later version. Without the notice Bob's device stays silent, and Alice's
  cannot tell "Bob has not updated" from "Bob is offline", "Bob has not answered" or "Bob ignored
  it": all are silence. With the notice it learns at once that Bob speaks version 1, and can fall
  back to version 1 for him or tell Alice that Bob must update.
  A later version could do without it, by sending both versions to a peer whose version it does
  not know; the notice saves that, and it could not be added to version 1 after its release.
- **What the notice reveals.** That this device speaks version 1 of this protocol, to a contact its
  user accepted. Nothing about any group, and nothing to anyone else.
- A device that receives the notice takes no action required by this version; it MUST NOT treat it
  as an error or penalise its sender (§2.2).
- Events carried under a newer prefix follow the version rules of §13.1.
- Every plaintext and every event carries its protocol version, so the schema of a version is
  closed: an unknown field, enum value (such as a message type or status) or `oneof` case (such as
  a frame kind or query operation) is malformed.
  A frame with one is rejected, except when it lies inside a query entry: only that entry is
  answered **malformed** and the other entries are processed (§13.7).
  Anything unknown in the `Container`, `Frame` or `Query` itself, outside its entries, rejects the
  whole frame.
- An event with an unknown message type is rejected like any other malformed event; it is not
  stored, relayed or used as a parent.
- New message types, frame kinds, query operations, fields or status codes require a new protocol
  version.
  The only extension points within a version are message metadata and the settings map of a
  root, whose unknown entries are preserved (§6.2, §4.1).
- This protocol is not compatible with earlier draft group designs.
  The earlier one-to-one conversation format is not part of it: its conversations are archived and
  may be continued as groups (§5.12).
- Within wire version 1, releases stay compatible as §2.2 requires.

### 13.9 Scheduling and packing

Lookups are budgeted by requested entries, not bytes.
Scan page responses are scheduled independently of these lookup quotas.
Each requested ID consumes one slot when issued.

- **Responses:** roots, signed objects and key answers are sent first.
  Then come 3 deletion entries per 1 final-lane entry.
  The final lane orders ordinary messages before statuses; every status (N/A, `restart`,
  `expired`, `malformed`, `busy`) counts as a status.
- Unused share passes to the other ready category; a single ready category may fill a whole batch.
- A logical response allocation holds at most 128 entries.
  Fractional shares carry over between batches as credit, only for categories with ready work.
  Allocation windows are per authenticated peer, across its groups.
- Within a category, answers are round-robin across outstanding requests, ascending by `idx` inside
  each.
- Each batch is emitted in the order roots and signed objects, deletions, ordinary messages,
  statuses, then packed greedily
  into ciphertexts by whole entries.
  The allocation continues across ciphertext boundaries.
- Requests never carry deletion hints, and IDs are never invented to fill a share.

_Why:_ deletions should propagate early, but no category may starve the other.

### 13.10 Size limits

| Limit                                                            | Value                                                      |
| ---------------------------------------------------------------- | ---------------------------------------------------------- |
| Group plaintext (version prefix, all protobuf frames and events) | 57,344 bytes                                               |
| Encrypted binary packet, as stored under a seeker                | 65,536 bytes                                               |
| Message text (also the content of a forwarded text)              | 16,384 bytes of UTF-8                                      |
| Message metadata, all entries together, as encoded               | 16,384 bytes                                               |
| Settings map of a root, measured as metadata                     | 128 entries and 16,384 bytes; keys of 1 to 64 bytes (§4.1) |
| Entries per query frame                                          | 16                                                         |
| Entries per logical response allocation                          | 128                                                        |
| Notice                                                           | 128 entries and 16 KiB                                     |
| Page                                                             | 128 entries and 16 KiB                                     |
| Root                                                             | must fit one empty container                               |
| Members per epoch                                                | 512 (§4.4)                                                 |
| Parent commitments per root                                      | 32 (§4.5)                                                  |
| Group name                                                       | 256 bytes (§5.11)                                          |
| Reply targets per message                                        | 32 (§7.6)                                                  |

Every complete frame and every single event, root or signed object MUST fit an empty container.
For an event, root or signed object this means an event blob of at most 57,307 bytes (D.50), and
the length compared is that of the blob **as received**. A copy over the limit is malformed and
counts against the peer that sent it; it names no event to the receiver, so a proper copy of the
same event from another peer is still accepted.
_Why the received length:_ every receiver sees it and can check it before decoding, so all
receivers of one copy agree. The canonical length is never longer than the received one, since
padding, repeated fields and written default values only lengthen an encoding; checking it as well
refuses nothing more.
A send is rejected before encryption if either limit would be exceeded.
Oversized items are rejected by both sender and receiver, never fragmented.
Size checks use encoded bytes, not characters.

The container, the encrypted packet ceiling, the text and metadata limits and the hint cache bounds
are fixed.

- **One packet, every transport.** 65,536 bytes is the largest payload a phone relays over the
  Bluetooth mesh. Every packet a client stores under a seeker MUST fit it, so that a session's
  chain of seekers can never be interrupted for a peer reachable only by mesh. A client checks
  this before encrypting, since encryption advances the session; a server MAY refuse a larger
  packet.
- **Why 57,344.** A full container encrypts to at most 60,976 bytes (measured, see below), which
  leaves about 4.5 KiB under the packet ceiling for future growth of the session layer.
- **Text and metadata** are limits on one message version, checked on creation, on reception and
  on every edit, local-only edits included. An event over either limit is malformed.
  Metadata is measured from the decoded entries, so that every device obtains the same number,
  as the metadata field with every map entry written in full, its key field and its value field
  both counted even when empty. For each entry:

  ```text
  1 + varint(L) + L,   where   L = (1 + varint(len key) + len key) + (1 + varint(len value) + len value)
  ```

  (one byte of field key, the varint length of the entry, then the key as field 1 and the value as
  field 2, each with one byte of field key and a varint length); the metadata size is the sum over
  the entries.
  _Why both fields always:_ some protobuf libraries write an empty key or value and others leave it
  out. Counting both gives the size of the largest standard encoding, an upper bound for every
  library, so two implementations agree on an event at the 16,384-byte boundary and neither
  rejects and penalises what the other accepts.
  A message with both at their limits, 16 parents and 32 reply targets is 33,383 bytes.

Every limit in the table above is fixed for wire version 1 (§2.2): a receiver rejects what exceeds
it, so none can be raised later. The byte limit of a notice or a page is a second guard only: 128
entries at their largest take about 9.2 KiB, so a list within the entry limit never reaches it.
The limits of §17.4 are local policy and may change from release to release.

For sizing: the session layer and the group message type add at most 3,632 bytes to a group plaintext (two ML-KEM-768
ciphertexts, a fresh ML-KEM-768 public key, a signed envelope and framing; no padding), whatever
the size of the plaintext and the state of the session.
An implementation MUST keep a test that encrypts a full container and fails above 65,536 bytes.
A notice with one entry is about 70 bytes of plaintext, a deletion event with one parent about 170
bytes, and a signed object about 3.4 KB.

## 14. Storage and local lifecycle

### 14.1 Local records

A device keeps at least these logical records.
Physical layout is an implementation detail.

- **Epoch record:** the root's version, fields and signature (so it can be resent under its own
  version, §13.1), the time `T` of its line (§7.5), the derived `chat_id` and
  `ref_chat_id`, acceptance state, and which group the epoch belongs to.
- **Group record:** its epochs and their parent links, its ends and current epoch, links made by
  hand, its state (active, read-only after a kick, dissolved, waiting for a kick), the local name
  and local settings.
- **Signed objects:** leaves and kicks, each kept as long as the root of the epoch it names (§5.3,
  §5.6), and dissolve messages, with their version, fields and signature.
- **Key cache:** verified `UserPublicKeys` per identity.
- **Event rows** keyed by `(chat_id, eventId)`: references to available data (the event's version and fields),
  local `processed`, `validity`, availability window, pending due time, and temporary-rejection
  marker.
  Message rows keep only a stub after pruning.
- **Parent edges.**
- **Current objects** keyed by `(chat_id, syncObjId)`, with their current result, the moment of
  the message timer (§7.7), when the timer erases the object with the stubs of its events it
  erases then (in an epoch with a timer only; for a deleted message, its moment rounded up, §7.7),
  pending versions, and **`shareable`**.
  - `shareable` says whether the device may offer the record's events on its own initiative.
    `true`: it announces them and lists them in tips scans; the normal state of every record.
    `false` (a **quiet** record): it neither announces them nor lists them, still answers a
    direct request (a lookup by ID) for them, and pushes a deletion of it in full to the removed
    peers of the epoch (§10.4), which relay nothing.
  - It is written at exactly three moments: (1) every record starts `true`; (2) it is set to
    `false` when a deletion event creates the record for a message the device has never
    processed, in an epoch with a timer, and the record is then erased at the time the deletion
    was processed plus `T`, rounded up; (3) it is set back to `true` the first time any version of
    the message itself is processed for that record, even a copy the tombstone blocks, and the
    erasure is then computed from the message's creation date. With no timer it is always `true`.
  - It has no default: every place that creates or writes a record states it, so that no write
    can forget it. A forgotten `false` would let a quiet deletion be renewed between devices
    forever (§7.7).
  - _Why:_ a deletion carries no date, so a device without the message bounds its moment by the
    processing time plus `T`. That bound restarts whenever the deletion is received anew, so
    devices in this state must not offer it to each other; a device holding the message has a
    fixed deadline, the same everywhere, and may. A direct request is answered because a peer
    asks only when something finite gave it the ID (§7.7).
    The stored fields of each available event are the only stored copy of that event's content.
- **Retrieval tasks** with per-peer candidate rows: trigger kind and time, attempts, outstanding
  and N/A state; the per-peer waiting lists and pauses of §11.8.
- **Scan state and tombstones**, and **request correlation references**.
- **Peer-knowledge hints.**
- **Encrypted outbox.**
- **Closed-chat markers** and **dissolved markers**: a chat ID and the reference of its root
  (§14.2).

Local fields are never transmitted or hashed.
Only explicit protocol projections are serialized, never a whole stored record.
Known pruned IDs, processed facts and needed parent links are kept until the group is closed,
except what the message timer erases (§7.7).

### 14.2 Hiding, deleting and closing

- **Hide or archive** is presentation only.
  Synchronization, sharing and keys continue; notifications follow the separate mute setting.
- **Closing a group.** The device removes the roots, the group secrets, message state, stubs,
  signed objects, pending tasks, hints and links of that group, and keeps only a minimal non-secret
  **closed-chat marker** for each of its ends: the chat ID, and the reference of its root (§4.5),
  computed when closing while the root is still held.
  A marker recorded before the reference was kept has the chat ID only and stays valid; it takes
  the reference of the first root it refuses.
  Other groups, shared sessions and sequence-dependent ciphertext are kept.
  The UI warns that recovery obligations and deletion knowledge are lost.
- A group is closed by "Ignore and Delete", by a signed leave or decline once it is sent, by the
  end of the waiting state (§5.2, §5.4) and by **Delete** on a kicked or dissolved group.
  An invitation deleted before it is answered ("Ignore and Delete") leaves a marker as one declined
  does, and so does each root fetched as a parent of an invitation that is declined or deleted,
  unless something else the device holds still names it (§4.8).
  _Why:_ the action meant to leave the least trace must not leave the earlier epochs' member lists
  behind.
- **Closed-chat marker.** A root that continues a closed epoch is rejected automatically and
  recorded as closed too (§4.8).
  The device drops every frame for a closed epoch silently, except its root delivered in full by a
  member, for example with Retry synchronisation (§9.4): the device then validates it and asks
  Accept or Decline again.
  The prompt says that this group was closed on this device before and warns that deleted content
  may reappear because local deletion memory is gone.
  Accept clears the marker and installs the epoch as a first Accept would.
- **Dissolved marker.** It is left by "Dissolve & Delete" (§5.8), with the chat ID and the
  reference of the root.
  The device drops every frame for that epoch, its root included.
  It does not reject successors: a later root that lists the device is an invitation.

_Why markers:_ keeping nothing but a chat ID and a reference leaves no member list or secret
behind, while frames of that epoch are dropped instead of silently recreating the group.
_Why the reference:_ a reply naming the closed epoch is then recognised without asking anyone for
it (§7.6); asking would let a peer see the device drop the root it gets back.

**Emergency wipe.** Wiping the device or the application's data is never blocked or delayed by any
rule of this document, for an owner or for anyone else.
For a group whose owner wiped their device, the group has no active owner: messages still flow, but
nobody can add or remove members and leaves are not processed.
The user is still listed as the owner, and is the owner again after logging in again and receiving
the root from a member, or after restoring a backup.

Caveats:

- A marker shows, on an unlocked device, that a declined, left, deleted or dissolved group existed,
  and its reference shows which held replies point to it.
- While a group waits for a kick, and for two weeks after "Dissolve & Delete", its roots, which
  hold member lists but no message, stay on the device (§5.4, §5.8).
- A local name is never sent, but it is stored on the device (§5.11).
- A member can resend a root repeatedly, and each delivery prompts again; the UI MAY group or
  rate-limit these prompts.

## 15. Transport integration

### 15.1 Deferred assembly

Pending sends (full events, notices, responses) are queued as scoped event references plus the
intended transmission kind, never as saved result bytes.
Immediately before encryption, the group layer rechecks recipient authorization, availability, the
matching current or pending result and relevance, then hands one assembled plaintext batch to the
transport.
A revision check or serialization at that handoff prevents a concurrent prune from producing a new
stale send.
State changes that invalidate pending work do so atomically with the change.
A group that goes inactive or is closed makes stale every plaintext in flight that carries work of
it, so that this work is decided again (§10.4).

### 15.2 Atomicity

- **Group state:** one logical application step commits result and tombstone updates, processed and
  validity flags, availability, pending activation and date erasure, frontier index changes and
  invalidation of pending work in one database transaction.
- **Receiving:** a device validates every entry of a received container, then commits all accepted
  entries in one transaction.
  Rejected entries never roll back valid ones.
- **Session and outbox:** Agraphon session state and the group database are separate stores.
  Advancing the session and durably storing the resulting ciphertext MUST therefore go through a
  recoverable journal, with operation identity, pre/post state recovery and publication gating.
  Fault-injection testing must show that recovery never encrypts twice or advances the session
  twice for one packet.
  This is a release blocker.

### 15.3 Ciphertext and acknowledgements

- Ciphertext is retried as stored; it is never rewritten.
- Packets encrypted before a prune or local alteration may still carry the earlier content.
- There is no packet recall.
  Explicit cancellation, for example by resetting the peer session, is deferred.
- Backend publication confirmation and peer transport acknowledgements are distinct outcomes.
  Neither means read, delivered to all members, applied or erased, and UI labels name only the
  milestone actually known.
- One session per peer is shared across all groups; its failure affects all of them.

## 16. Security properties and limits

> **Not yet updated.** This section still describes the previous draft, in which nothing was
> signed and a chat never changed its members.
> It is being revised separately and MUST NOT be read as describing the roots, signed objects,
> owner role and epochs of §4 and §5.
> The statements planned for the revised section are listed in Appendix D, decision D.14.

### 16.1 Deniable attribution

No group record is signed.
Every member can create a valid message attributed to any other member, and can compute the secret
proof of any event.
Agraphon authenticates only the immediate peer.
Fabricated messages are sent like relays (notice, then answer requests), so the sending pattern
does not single out the fabricator.

The create event's `author` is likewise an unauthenticated claim.
A member can show others the create event, but it proves nothing about who made it.

### 16.2 Membership enforcement

Membership rests on two checks: the immediate Agraphon peer must be a member, and every message
event must carry a secret proof only holders of the group secret can compute.
Any member can leak the group secret to an outsider, but the outsider still cannot deliver frames,
because its own Agraphon identity is not a member.

There is no protection against a member who creates a chat with misleading membership; every
invitee decides with Accept or Decline.

A creator can put a wrong ML-KEM key for a member into the create event.
Session announcements encrypted to that key then reach whoever holds it instead.
No group content is exposed, because group frames wait for the member's signed `AuthBlob` (§4.3);
the result is a session that never authenticates, and the device falls back to keys obtained
through the normal contact path.

### 16.3 Local-inspection target

**Attacker:** someone with the unlocked app after a local alteration has completed, able to inspect
all accessible state: messages, events and links, hints, queues, session state, database contents,
caches and logs.

**Target:** that state is consistent with a legitimate **and reasonably probable** ordinary
history.
In particular:

- there is one current result and no retained original;
- there is no local-origin, fabrication or pruning-reason marker;
- pruned stubs look like ordinary retention pruning.

**Outside the target:**

- observing the edit as it happens;
- before-and-after snapshots;
- continued operation or synchronization afterwards;
- other devices, notifications and screenshots;
- database pages, journals, WAL and backups;
- ciphertext already encrypted.

Retained deletion events and closed-chat markers are known residues.
This is a design target to evaluate, not a proof.

### 16.4 Traffic analysis

Connectivity and timing are observable.
Jitter, backoff, staggered periodic scans, neighbor rotation and Tor are expected to decorrelate
most activity, but no anonymity bound is claimed.
Further protection is deferred.
This is a separate concern from local inspection.

### 16.5 Convergence and deletion

Honest devices converge when every relevant result and deletion reaches them while still available.
Local alterations and same-ID equivocation are outside this guarantee.
There is no convergence under malicious members.

User-facing wording for deletion is: **"Deletion is applied locally and synchronization is
attempted; other copies may remain."** Remote erasure is never claimed.

### 16.6 Not claimed

- membership deniability;
- convergence under malicious members;
- remote or forensic erasure;
- packet recall;
- recovery after every shareable copy is gone;
- a globally latest message version;
- traffic-analysis resistance.

### 16.7 Known limitation: an invitation can probe whether a device holds a chat

**The limitation.** Take Bob, and Alice, a contact of Bob who has learnt the identifier of some
chat X and wants to know whether Bob is in it. Alice builds a root that lists Bob as a member
and names X as its parent, signs it, and delivers it to Bob as an invitation.

Before showing Bob the prompt, Bob's device tries to obtain the parent (§4.8), so that it can
recognise an epoch that continues a chat Bob is already in, and adopt it without asking:

- if Bob's device does not hold X, it sends a lookup for it to Alice's device;
- if Bob's device holds X, or Bob closed it, it sends nothing.

Alice therefore learns, from whether a lookup comes back, whether Bob holds or once closed X.
The lookup also shows that the invitation reached Bob's device before Bob answered it.

**What it takes.** Alice must be someone whose invitations reach Bob's device, and must already
know X's identifier, which is unpredictable to anyone who never saw a root or a message of X or of
the epoch that continues it. Alice learns one bit about one chat per invitation, and nothing
about its members or content.

**Why version 1 accepts it.** Closing it costs either a convenience honest members rely on or a
mechanism that is hard to make exact; see below. The same kind of probe was closed where it was
free to close: neighbor requests (§10.1), tip scans from non-members (§12.1) and root notices from
peers that share nothing (§4.6).

**Fixes a later wire version could adopt, and what each costs.**

- **No lookup before the user accepts.** Bob's device sends nothing until Bob has answered, then
  fetches the parent.
  - It closes the probe completely, and makes "Ignore and Delete" invisible to the sender.
  - _Drawback:_ a member that missed one epoch and receives the next can no longer be recognised
    before the prompt, so that member is asked to accept a continuation of a chat it is already
    in. Every membership change that reaches a device out of order becomes a prompt.
- **Always look up, as cover.** Bob's device sends the lookup whether or not it holds X.
  - It keeps the adoption without a prompt.
  - _Drawbacks:_ the lookup is only the first step. When the parent is not held and the sender
    answers "not available", the device goes on to ask the other listed members and shows the
    prompt after a delay or enough answers; when it is held, none of that happens. To hide the
    difference the device must act out the whole sequence in both cases, with the same messages
    and the same timing, and any step that differs reopens the probe. It also still shows that the
    invitation arrived, and lets anyone trigger useless traffic at will.
- **Ask someone else.** Bob's device looks the parent up from members of chats it holds, never
  from the sender.
  - _Drawback:_ it only helps when Bob holds a chat whose members can answer, which is exactly the
    case that needs no lookup; otherwise there is nobody to ask but the sender.
- **Bind the parent to the invitation.** The root would carry a value that only a member of the
  parent epoch can compute for this recipient, so that a device can check the claim offline.
  - _Drawback:_ it changes the root format and the parent commitment (§4.5), and a commitment a
    recipient can check against one known epoch is itself a way to test membership offline,
    unless it is keyed by a secret of that epoch that an outsider cannot have. This needs a design
    and a proof, not a patch.

### 16.8 Known limitation: a removed member's archive stays within the owner's reach

A device kicked from an epoch, or that left it and keeps it read-only, still applies a dissolve
message naming that epoch, silently, and "Dissolve & Delete" erases its archive (§5.6, §5.8,
§10.4). It does not announce the dissolve and does not serve its root afterwards, so the dissolve
does not show the members that it had kept the epoch. The owner of an
epoch can therefore erase a removed member's copy of it at any time after the removal, although
that member is no longer in the group. Only a dissolve naming an epoch the member holds reaches it;
a dissolve of a later epoch does not.

This is accepted: deletion is meant to reach every device that holds the epoch, single deletion
events already reach removed peers, and the owner could have dissolved with deletion just before
the kick.

### 16.9 Accepted cost: one signature scheme

Roots, kicks, leaves and dissolve messages are signed with ML-DSA-65 only, with the account's
identity key (§2, D.83). If a flaw is found in ML-DSA-65, there is **no fallback inside wire version
1**: anyone able to forge these signatures can sign roots, kicks and dissolve messages in another
member's name, and the account identity is broken as well. Recovery takes a new protocol version,
which a break of the identity key needs in any case.

### 16.10 Known limitation: the encrypted storage keeps an erased block for a short time

When the message timer erases a message (§7.7), or a user deletes one, the database overwrites the
space it frees with zeros (`secure_delete`). Nothing of the message can then be read back from the
account's database, free pages included.

One layer down, the encrypted storage writes the changed block again, under the same key, and does
not destroy the block's previous ciphertext at once:

- on phones, the storage file keeps it until later writes reuse that space; in a test, that took
  the next one or two commits or cover-traffic rounds, which come every 10 to 30 seconds;
- on the web, it depends on the browser;
- a phone's file system and flash memory can keep physical copies that no app controls.

So for a short time after an erasure, someone who holds **both** a raw copy of the storage taken in
that window **and** the account's password can still recover the erased content. Without the
password, nothing changes.

This is accepted. Closing it needs a change inside the storage layer, or a storage format where
every write uses a fresh key. The first would flush the old versions of a block, with a trigger
still to be designed so that the flush does not itself show that something was erased. Both are
outside this protocol and are proposed separately (D.87).

## 17. Readiness, validation and future work

### 17.1 Release prerequisites

Before release, each of these must be demonstrated, with recorded evidence per supported backend:

- exact protocol projections and protobuf parsing rules;
- the crash-safe session/outbox journal;
- idempotent receive recovery;
- pending-activation behavior;
- residual-state checks, with fault injection at every durable boundary.

### 17.2 Residual-state tests

Cover:

- local edit and delete;
- supersession;
- age and capacity pruning;
- future activation and date erasure;
- erasure by the message timer (§7.7), with and without children still held, of reactions, and a
  crash during it;
- duplicate and late restorations;
- declined, left and deleted (closed) groups;
- kicked, dissolved and waiting groups, and the markers and roots they leave;
- stale plaintext references;
- existing ciphertext;
- a crash at each transition.

Inspect against the §16.3 boundary:

- results;
- event and payload access;
- stubs and edges;
- hints;
- pending work;
- indexes and caches;
- previews, notifications and logs;
- journal and session artifacts.

### 17.3 Workloads and acceptance targets

- **Message rates:** 100, 1,000 and 10,000 messages per day, including edits, deletes, concurrent
  tips and a two-week offline return.
- **Group sizes:** 2, 10, 100 and 512 members (the maximum, §4.4).
- **Membership changes:** adding and removing one member, and ten members at once, at each group
  size; a new member's key download (about 1.6 MB at 512 members).
- **Traffic:** at most 16 KiB of discovery metadata per full page.
  Under 1 MiB per device per group per day of idle control traffic when queries are answered.
  Active and catch-up traffic is reported separately.
- **Responsiveness:** no unbounded foreground work, under 50 ms per scheduled work slice on a
  declared reference device, and no lost current results under pressure.

### 17.4 Provisional resource limits

- Resource: Live scans
  - Limit: 4 per peer, 64 per device, 16 MiB of frozen IDs in total

- Resource: Active lookup entries
  - Limit: 16 per peer, 64 per device; one ordinary supplier per item

- Resource: Queued missing IDs
  - Limit: 65,536 per group, 262,144 per device; back-pressure pauses paging

- Resource: Per-peer request budget
  - Limit: burst 128 entries, refill 16 per minute

- Resource: Per-peer response budget
  - Limit: burst 1 MiB, refill 256 KiB per minute

- Resource: Aggregate device work
  - Limit: a separate device-wide ceiling with fair rotation across peers; value to be profiled

- Resource: DAG traversal
  - Limit: 4,096 edges per scheduling turn

- Resource: Peer-knowledge hints
  - Limit: 65,536 per group, 28-day expiry

- Resource: Root fetches in progress
  - Limit: 4 per peer, with a waiting list of 256 announced IDs per peer (§11.8)

- Resource: Failed announcements
  - Limit: 3 within 24 h, then a pause of 1 h, doubling up to 24 h (§11.8)

- Resource: Unverified handover roots kept while their parent is looked up (§4.7)
  - Limit: 64 per delivering peer, 1,024 per device, each kept two weeks at most
  - The limit per peer is a total across every chat: the chat a handover root belongs to cannot be
    known before its parent is held. A root is about 24 KB at 512 members and at most the
    57,307-byte event blob, so the worst case is about 22 MB kept, 59 MB at the container ceiling.
    These are local policy and may change in any release.

Overflow returns **busy** or pauses work.
It never marks events invalid or pruned.

### 17.5 Deferred work

- Content beyond §7.6: inline spans, the mimetypes an application defines (file references among
  them), and how media is copied when forwarded.
- The peer score formula and replacement thresholds (§11.8).
- Optional proactive neighbor rotation.
- Score-weighted choice of extra dissemination recipients.
- A direct-evidence-only fallback for hints, if ancestor inference proves impractical.
- Shared mutable group settings, including configurable retention. They go in the settings map of
  the root (§4.1), which version 1 already carries and keeps.
- Groups larger than 512 members.
- Untrusted groups: an admin list in the root (admins must be members), permission checks on every
  change, and author fields on deletions.
- An interface for replying to several messages at once; the wire format already carries up to 32
  targets (§7.6).
- An acceptance step before a handover takes effect (§5.7).
- Relaying a signed leave from a device that does not hold the whole path (§5.3): such a device
  would relay the leave when the leaver is in both the named epoch and its current epoch, and stop
  two weeks after first receiving it.
  To be considered only if the current rule proves unreliable in practice.
- Suggesting a link between two groups ("This looks like a continuation of …"), when a new group
  has the same owner as an archived one and most of the same members; "most of the same members"
  must be defined first (§5.10).
- Traffic-analysis protections.
- Explicit ciphertext cancellation.
- Using requester-chosen scan IDs to relax transport ordering requirements (for example pipelining
  follow-up requests before earlier pages are processed).

## Appendix A: Registry

### Hash domains

| Domain                                 | Use                                    |
| -------------------------------------- | -------------------------------------- |
| `gossip.groups.root.1`                 | root ID, which is the `chat_id` (§4.1) |
| `gossip.groups.predecessor.1`          | parent commitment (§4.5)               |
| `gossip.groups.reference.1`            | `ref_chat_id` (§4.5)                   |
| `gossip.groups.leave.1`                | `leaveId` (§5.3)                       |
| `gossip.groups.kick.1`                 | `kickId` (§5.6)                        |
| `gossip.groups.dissolve.1`             | `dissolveId` (§5.8)                    |
| `gossip.groups.message.secret_proof.1` | `secret_proof`                         |
| `gossip.groups.message.result.1`       | message result hash                    |
| `gossip.groups.sync_obj_name.1`        | sync-object ID of a registered name    |
| `gossip.groups.reaction.1`             | sync-object ID of a reaction (§7.6)    |

### Signing contexts

ML-DSA-65 signing contexts are distinct from every hash domain.

| Context                              | Signed message           |
| ------------------------------------ | ------------------------ |
| `gossip.groups.root.signature.1`     | the 32-byte root ID      |
| `gossip.groups.leave.signature.1`    | the 32-byte `leaveId`    |
| `gossip.groups.kick.signature.1`     | the 32-byte `kickId`     |
| `gossip.groups.dissolve.signature.1` | the 32-byte `dissolveId` |

### Registered names

None yet.
Future protocol-named message objects use names under `gossip.groups.message.*`.

### Protocol version numbers

`migrate_from` (§4.1, §5.12) holds a protocol version number, with the numbering of the wire
version (§13.1):

| Value   | Meaning                                                      |
| ------- | ------------------------------------------------------------ |
| `0`     | before version 1: the earlier one-to-one conversation format |
| `n ≥ 1` | wire version `n`                                             |

A version-1 device acts only on `0`. It keeps and hashes any other value without acting on it.
The field never makes a root invalid.
_Why:_ a later version may continue its own conversations, and a version-1 device must still
accept and relay such a root unchanged.

## Appendix B: Timing constants

| Constant                                                                                | Value                                                                                                                              |
| --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Message retention                                                                       | 2 weeks + 5 min after the event timestamp (fixed)                                                                                  |
| Lookup deadline                                                                         | event timestamp + retention                                                                                                        |
| Event timestamp admission                                                               | now + 5 min                                                                                                                        |
| `created_at`, `last_modified_at`                                                        | ≤ event timestamp + 2 weeks                                                                                                        |
| Query clock tolerance                                                                   | `sent_at` ≤ now + 5 min                                                                                                            |
| Receiver deadline                                                                       | `sent_at + 1.05 × ttl + 5 min`                                                                                                     |
| First TTL / growth / cap                                                                | 60 s / × 3.142 (ceil) / 24 h                                                                                                       |
| Local jitter                                                                            | uniform ±5 %, floored to ms                                                                                                        |
| Unanswered stages before pause                                                          | 20                                                                                                                                 |
| Scan tombstone                                                                          | 24 h after drop                                                                                                                    |
| Periodic recovery lanes                                                                 | 4 per group: neighbor, random, neighbor, random; 1 scan each per 24 h                                                              |
| Periodic lane offset                                                                    | floor(6 h × r) ms, r uniform in [0.95, 1.05]                                                                                       |
| Scheduled-delete timers                                                                 | wait ≤ 2 h; fallback 30 min (5 min when open)                                                                                      |
| Message timer                                                                           | per epoch, in its root: a message is deleted at `created_at + T` (§7.7)                                                            |
| Hint expiry                                                                             | 28 days                                                                                                                            |
| Invitation delay `PROMPT_DELAY`                                                         | 5 min after receiving the root (§4.8)                                                                                              |
| Successor after a leave or request                                                      | 30 s without a new one; at most 5 min after the first (§5.5)                                                                       |
| Owner-only request resend                                                               | every 24 h (§5.4)                                                                                                                  |
| Waiting for a kick                                                                      | at most 2 weeks (§5.4)                                                                                                             |
| Root and dissolve message kept after "Dissolve & Delete"                                | 2 weeks (§5.8)                                                                                                                     |
| Failed announcements before a pause (provisional)                                       | 3 within 24 h; pause 1 h, doubling, at most 24 h                                                                                   |
| Chat lookup by reference (local policy; not sent in the first release, always answered) | after a wait of up to 1 min from the reply's receipt; at most 3 peers per round; one round per week; 4 rounds per reference (§7.6) |

## Appendix C: Protobuf schema

```proto
syntax = "proto3";
package gossip.groups.v1;

// plaintext = varint(PROTOCOL_VERSION) || Container
// eventBlob = varint(eventVersion) || Event
// No message carries a version field; versions are only these two prefixes.
// All strings are UTF-8.
message Container {
  repeated Frame frames = 1;
}

message Frame {
  oneof kind {
    bytes event = 1;                   // eventBlob
    Query query = 2;
    Response response = 3;
    Notice notice = 4;
    NeighborRequest neighbor_request = 5;
    NeighborResponse neighbor_response = 6;
    LeaveRequest leave_request = 7;
  }
}

message Event {
  oneof kind {
    GroupRoot group_root = 1;                  // GROUP_ROOT
    GroupMessageEvent group_message_event = 2; // GROUP_MESSAGE_EVENT
    Leave leave = 3;                           // LEAVE
    Kick kick = 4;                             // KICK
    Dissolve dissolve = 5;                     // DISSOLVE
  }
}

enum RootType {
  SUCCESSOR = 0;
  HANDOVER = 1;
}

message GroupRoot {
  RootType type = 1;
  string name = 2;                 // 0..256 bytes
  repeated bytes parents = 3;      // 1..32 parent commitments, 32 bytes each, ascending
  repeated bytes members = 4;      // 1..512 GossipIDs, 32 bytes each, ascending
  bytes group_secret = 5;          // 32 bytes
  bytes owner = 6;                 // bincode(UserPublicKeys) of the owner; a member
  bytes epoch_challenge = 7;       // 32 bytes
  bytes ref_chat_id_challenge = 8; // 32 bytes
  uint64 created_at = 9;
  bytes signature = 10;            // ML-DSA-65 over the root ID; not hashed
  optional uint64 migrate_from = 11; // only on a root that creates a group of two (§5.12)
  uint64 message_timer = 12;       // milliseconds; 0 (absent) keeps messages forever (§4.1, §7.7)
  map<string, bytes> settings = 13; // at most 128 entries and 16,384 bytes; keys 1..64 bytes;
                                    // a key given twice is malformed (§4.1)
}

message Leave {
  bytes chat_id = 1;               // 32 bytes: the epoch the member leaves
  bytes gossip_id = 2;             // 32 bytes: the leaver
  bytes signature = 3;             // ML-DSA-65 by the leaver over leaveId
}

message Kick {
  bytes chat_id = 1;               // 32 bytes: the epoch the member is removed from
  bytes gossip_id = 2;             // 32 bytes: the removed member
  bytes signature = 3;             // ML-DSA-65 by that epoch's owner over kickId
}

message Dissolve {
  bytes chat_id = 1;               // 32 bytes: the dissolved epoch
  bool must_delete = 2;
  bytes signature = 3;             // ML-DSA-65 by that epoch's owner over dissolveId
}

message GroupMessageEvent {
  bytes event_id = 1;              // 24 bytes
  bytes chat_id = 2;               // 32 bytes
  bytes secret_proof = 3;          // 32 bytes
  repeated bytes parents = 4;      // 0..16 event IDs, ascending
  MessagePayload payload = 5;
}

enum MessageType {
  TEXT = 0;
  FORWARD = 1;
  REACTION = 2;
  MEDIA = 3;
  DELETE = 4;
}

message MessagePayload {
  bytes sync_obj_id = 1;                // 32 bytes
  MessageType type = 2;
  bytes author = 3;                     // GossipID; absent for DELETE
  uint64 created_at = 4;                // absent for DELETE
  optional uint64 last_modified_at = 5; // DELETE: present only while scheduled
  bool edited = 6;                      // absent for DELETE
  oneof body {                          // absent for DELETE
    string text = 7;
    Forward forward = 8;
    Reaction reaction = 11;             // REACTION
    Media media = 12;                   // MEDIA
  }
  map<string, bytes> metadata = 10;     // empty for DELETE
}

message Reaction {
  bytes target = 1;                     // 32 bytes: syncObjId of the message reacted to
  string emoji = 2;                     // 1..64 bytes
  ReactionAction action = 3;
}

enum ReactionAction {
  ADD = 0;
  REMOVE = 1;
}

message Media {
  string mimetype = 1;                  // type/subtype, at most 127 bytes
  bytes data = 2;                       // opaque
}

message Forward {
  MessageType content_type = 1;         // TEXT or MEDIA
  bytes content = 2;                    // TEXT: UTF-8 text; MEDIA: an encoded Media, canonical
}

message ReplyTo {                       // value of metadata key "replyTo"
  repeated ReplyTarget targets = 1;     // 1..32
}

message ReplyTarget {
  bytes ref_chat_id = 1;                // 32 bytes: reference of the target's epoch
  bytes sync_obj_id = 2;                // 32 bytes
}

enum ObjectKind {
  EVENT = 0;
  ROOT = 1;
  LEAVE = 2;
  KICK = 3;
  DISSOLVE = 4;
}

message Query {
  bytes request_id = 1;                 // 16 random bytes
  uint64 sent_at = 2;
  uint64 ttl = 3;
  repeated QueryEntry entries = 4;      // at most 16
}

message QueryEntry {
  oneof op {
    ChatLookup chat_lookup = 1;
    SharedChatsScan shared_chats_scan = 2;
    EventLookup event_lookup = 3;
    SyncObjLookup sync_obj_lookup = 4;
    TipsScan tips_scan = 5;
    ObjectLookup object_lookup = 6;
    KeyQuery key_query = 7;
    RemovalLookup removal_lookup = 8;
  }
}

message ChatLookup {
  oneof by {
    bytes chat_id = 1;                  // by ID
    bytes ref_chat_id = 2;              // by reference
    ParentRef parent = 3;               // by parent
  }
}

message ParentRef {
  bytes chat_id = 1;                    // the root whose parent is wanted
  bytes commitment = 2;                 // one of its parent commitments
}

message SharedChatsScan { bytes scan_id = 1; uint64 offset = 2; }
message EventLookup { bytes chat_id = 1; bytes event_id = 2; }
message SyncObjLookup { bytes chat_id = 1; bytes sync_obj_id = 2; }
message TipsScan { bytes chat_id = 1; bytes scan_id = 2; uint64 offset = 3; } // chat_id: anchor
message ObjectLookup { bytes chat_id = 1; ObjectKind kind = 2; bytes id = 3; } // LEAVE, KICK, DISSOLVE
message RemovalLookup { bytes chat_id = 1; bytes gossip_id = 2; } // answers: KICK and/or LEAVE
message KeyQuery { bytes chat_id = 1; bytes gossip_id = 2; }

message Response {
  bytes request_id = 1;
  uint32 idx = 2;
  oneof result {
    bytes event = 3;                    // eventBlob; its version <= the plaintext's
    Page page = 4;
    Status status = 5;
    bytes keys = 6;                     // bincode(UserPublicKeys)
  }
}

message Page {
  bytes scan_id = 1;
  uint64 offset = 2;
  uint64 count = 3;
  repeated Entry entries = 4;           // at most 128
}

enum Status {
  NOT_AVAILABLE = 0;
  reserved 1;                           // never sent
  RESTART = 2;
  EXPIRED = 3;
  MALFORMED = 4;
  UNSUPPORTED = 5;
  BUSY = 6;
}

message Notice {
  repeated Entry entries = 1;           // at most 128
}

message Entry {
  bytes chat_id = 1;                    // 32 bytes
  ObjectKind kind = 2;
  bytes id = 3;                         // EVENT: 24 bytes; ROOT: empty; others: 32 bytes
}

message NeighborRequest { bytes chat_id = 1; }

message NeighborResponse {
  bytes chat_id = 1;
  bool accepted = 2;
  repeated bytes suggestions = 3;       // at most 10 GossipIDs
}

message LeaveRequest { bytes chat_id = 1; }
```

## Appendix D: Open decisions

The rules below are written into this document but have **not been confirmed**.
Each entry gives where the rule is, the context, the choices and a recommendation.
Until an entry is decided, the text of the section it names is the provisional rule.

### D.1 What a tips scan lists among signed objects (§12.1)

_Current text:_ a scan lists first every live leave and the dissolve message of the responder's
current epoch, and never lists kicks.

_Context:_ live leaves first was decided.
The dissolve message was added beside them because it is as urgent.
Kicks reach retained members with the root and reach the removed member by direct sends (§5.6), so
listing them would only spend page space.

- **A (recommended):** keep the current text.
- **B:** also list kicks, after the leaves.
- **C:** list live leaves only; the dissolve message spreads by notices alone.

_Settled:_ choice A, frozen as coded. §12.1 also states the two rules that were in the code only:
a leave or dissolve is listed only for a requester that is a member of the epoch it names, and a
page whose total moves is malformed.

### D.2 What a device does when it receives its own signed leave (§5.3)

_Current text:_ none.
A peer sends a kept leave back to the leaver that contacts it (§5.3, §5.6), which happens when the
leaver's device was restored from a backup made before it left.

_Context:_ the leave is signed with the device's own key and names its current epoch, so it can
verify it.
The original leave closed the group and deleted its data (§14.2), but a user who restored a backup
may have done so to get the history back.

- **A (recommended):** as for a kick: the group becomes a read-only archive with the line "You left
  this group", the composer is disabled, and the user can delete the group's data.
- **B:** the device closes the group at once and deletes its data, as the original leave did.
- **C:** the device asks the user: "You left this group from another copy of this account. Delete
  it here too?"

### D.3 A root whose owner's authority cannot be verified (§4.7, §4.8)

_Current text:_ a successor root whose owner has no verified authority over a parent the device
holds does not continue that parent; it is treated as unmatched, so as an invitation.
When the user accepts such an invitation, the root starts a **separate** group that the user may
link by hand (§5.10).

_Context:_ this is stricter than the earlier wording "once accepted, the history continues in the
same chat", which is kept for the case where authority is verified.
Without the rule, any member who knows an epoch's ID and challenge could attach a group of its own
to another group's history on a device that missed a handover.

- **A (recommended):** keep the current text.
- **B:** an accepted invitation always continues the held parent, verified or not.
- **C:** as A, and the device keeps trying to fetch the missing handover roots; when authority
  becomes verifiable, it joins the two groups automatically.

### D.4 Provisional numbers for roots and failed announcements (§11.8, §17.4)

_Current text:_ at most 4 root fetches in progress per peer; a waiting list of at most 256 IDs per
peer; 3 failed announcements from a peer within 24 hours pause fetching from its announcements for
1 hour, doubling at each repeat up to 24 hours.

_Context:_ none of these values was measured.
They bound what one peer can make a device fetch or remember.

- **A (recommended):** keep them as provisional values, to be tuned by the simulations of §17.
- **B:** other values.

### D.5 Packing order in responses (§13.9)

_Current text:_ roots, signed objects and key answers are packed before other answers.

_Context:_ they are small and few, and other answers often cannot be used without them (an event of
an epoch whose root is missing is not accepted).

- **A (recommended):** keep the current text.
- **B:** no priority; the ordinary order of §13.9 applies to everything.

### D.6 A neighbor request for an epoch the receiver does not hold (§10.1, §13.6)

_Settled:_ a request naming an epoch the device does not hold, and a request from someone who is
not a member of an epoch it holds, both get the same decline with no suggestions. The two cases
cannot be told apart. A member asking a device that holds the epoch is answered as §10.1 says.

_Current text:_ the request is declined with no suggestions.

_Context:_ the receiver cannot name members of an epoch it does not hold.
Declining tells the requester to try another member; the root itself spreads by root notices.

- **A (recommended):** keep the current text.
- **B:** drop the request silently.
- **C:** decline and ask the requester for the root (a chat lookup by ID).

### D.7 Constraints on a handover root (§4.7)

_Settled:_ a handover keeps the member list, except that the old owner may leave in it (§4.7).

_Current text:_ the new owner MUST differ from the parent's owner, and the members MUST be a subset
of the parent's members.
A root that breaks either rule is invalid.

_Context:_ it was decided that a handover root has one parent, may remove members and rename, and
may not add members.
The two checks state this for the receiver.
"New owner differs" keeps the two root types apart: a root that keeps the owner is a successor.

- **A (recommended):** keep the current text.
- **B:** drop the "new owner differs" check.

_Settled as well:_ choice A, as coded: the new owner differs from the parent's owner, which keeps the
two root types apart.

### D.8 An edit in an older epoch when no neighbor is eligible (§10.4)

_Current text:_ the edit goes to one random member of both epochs, plus the usual extra recipients.

_Context:_ it was decided that such an edit goes to neighbors who are in the older epoch, or
otherwise to another peer in both.
How many "another peer" means was left open.

- **A (recommended):** one random member of both epochs.
- **B:** as many as the usual number of neighbors.

### D.9 "Left" or "removed" in the view (§7.5)

_Current text:_ a member dropped by a root is shown as having left when the device holds that
member's signed leave for a parent epoch, and as removed otherwise.

_Context:_ a member who used the owner-only request is shown as removed, which is the intended
cover.
A device that never received the leave shows "removed" until it does.

- **A (recommended):** keep the current text.
- **B:** always show "is no longer in the group", whatever the cause.

### D.10 One kick per parent epoch (§5.6)

_Current text:_ when a root has several parents, the owner creates one kick for each parent that
lists the removed member.

_Context:_ a kick names one epoch, and a device ignores a kick that does not name its current
epoch.
After a fork, removed members may be on different branches, so each branch needs its own kick.

- **A (recommended):** keep the current text.
- **B:** a single kick naming one parent, chosen by the owner.

### D.11 Version numbers (§13.1, Appendix C)

_Current text:_ the wire version stays `1` and the protobuf package stays `gossip.groups.v1`.

_Context:_ no earlier draft was released, so no device speaks an older version.

- **A (recommended):** keep the current text.
- **B:** start at another number.

### D.12 Terms (§1)

_Current text:_ "epoch" is a fixed member list with its own `chat_id`; "group" is the logical chat
made of linked epochs; in protocol rules "chat" means an epoch.

- **A (recommended):** keep the current text.
- **B:** other terms.

### D.13 Which epoch a signed leave names (§5.3)

_Current text:_ the leaver's current epoch, or the epoch of the invitation being declined.

_Context:_ a leaver can only sign for an epoch whose root it holds.
The liveness rule carries a leave for an older epoch forward to the current one.

- **A (recommended):** keep the current text.
- **B:** a leaver with competing ends signs one leave per end.

### D.14 The statements of the security section (§16)

§16 still holds the text of the previous draft.
The revised section is planned to state the following.

_What is signed, and what it proves_

1. **Root:** the owner provably created an epoch with that member list, name and parents.
   The owner has no deniability about owning the group.
   For members it is the owner's claim only.
2. **Group name:** not deniable, since it is inside the signed root.
3. **Signed leave or decline:** permanent, transferable proof that the leaver was a member of that
   epoch.
   Every member keeps it for as long as it keeps that epoch's root.
4. **Kick and dissolve:** the owner's statements.
   They prove nothing new about a member.
5. **Messages:** still unsigned, deniable, and open to fabrication by any member.
6. **"Ask to be kicked":** deniable.
   Only the owner learns of it and holds no proof.
7. **Signatures are ML-DSA-65 only,** with no second classical signature: no fallback inside
   version 1 if ML-DSA-65 is broken (§16.9, D.83).

_What the owner and former owners can do_

8. **The owner** can remove anyone, and with "Dissolve & Delete" can erase the history on every
   honest device.
9. **A former owner** can still sign for epochs it used to own.
   Devices that have adopted the handover ignore it.
   Lagging devices can be misled, or have the chat dissolved, until they receive the handover.
10. **Two handovers from one owner** to different people leave a fork that nobody merges.
11. **Handover is immediate.**
    If the new owner never appears, or the owner wipes their device, the member list is frozen.
12. **The owner dates its roots.**
    Receivers do not check the date; they bound only where its line is shown (§7.5).

_What removal does and does not guarantee_

13. Removal takes effect device by device, as each one adopts the successor.
    A removed member keeps what they already had.
14. Edits are not sent to removed members.
    Deletions are pushed to them on a best-effort basis.

_What others can infer_

15. **Reply references:** the same value for every reference to one epoch, so repeated references
    can be linked.
    A reply across chats is readable by members of both.
16. **Parent commitments:** their number shows a merge or a re-added member.
    Anyone who knows a candidate epoch ID and the challenge can test it.
17. **Key queries:** answers are checked against the GossipID, and a wrong answer is the most
    heavily penalised.

_Connections_

21. **A chat the device is out of keeps no connection** (§5.12, D.86): kicked, left or
    superseded, whether the history is kept read-only or deleted, so that a member sharing nothing
    else with the device cannot tell the two apart by its keep-alives. A kept history then misses
    the later deletions and a "Dissolve & Delete" from such members, as a deleted chat does. The
    waiting state keeps every connection until the kick or the end of the two weeks, when the
    device leaves quietly as "Ignore and Delete" does and its connections go.

_What stays on a device_

18. Closed-chat markers, the marker left by "Dissolve & Delete", the roots kept for up to two weeks
    while waiting for a kick or relaying a dissolve, kicks and signed leaves kept with their root,
    and the local name.

_Known blind spots_

19. The link for a re-added member fails when the owner does not hold that member's last epoch.
20. "Dissolve & Delete" is best effort: offline peers, backups, unofficial clients and compromised
    devices may keep copies.

- **A (recommended):** this list is complete and correct.
- **B:** changes or additions.

### D.15 Canonical encoding of `UserPublicKeys` (§3, §4.3, §12.9)

_Found during implementation._

_Current text:_ the owner field of a root and a key answer are "`UserPublicKeys`, serialized with
bincode", and are checked by deriving the GossipID.

_Context:_ the existing parser accepts extra bytes after a valid key bundle, and deriving the
GossipID serializes the parsed keys again.
Bytes that are not the canonical encoding therefore pass the check, and the same owner keys could
give several root IDs.
The code refuses any input that does not equal the re-serialized keys.
The `auth` parser no longer accepts extra bytes or another encoding of the keys either; the check
of the groups crate stays as a second line of defence.

- **A (recommended):** state that the owner field and key answers MUST be the canonical bincode
  encoding, and that a receiver MUST refuse bytes that differ from the re-serialized keys.
- **B:** leave the text as it is and rely on the implementation.

_Settled:_ choice A, as coded; §4.3 states it. Why: otherwise the same keys with trailing bytes
give a second root for the same content.

### D.16 Nonzero GossipIDs in a member list (§4.1, §4.7)

_Found during implementation._

_Current text:_ §4.7 step 1 requires every GossipID of the member list to be nonzero; the table of
§4.1 does not mention it.

_Context:_ the two places should agree.
The code applies the rule of §4.7.

- **A (recommended):** add "nonzero" to the `members` row of §4.1.
- **B:** remove the requirement from §4.7.

_Settled:_ choice A, as coded; §4.1 states it: a member GossipID of all zeros is invalid.

### D.17 Signed-object IDs do not include a version (§5.3, §5.6, §5.8, §13.1)

_Settled:_ choice A. §5.3, §5.6 and §5.8 say that the three IDs hash no version, inherit it
through the `chat_id`, and that a later version that changes the fields of a leave, kick or
dissolve MUST use a new hash label for its ID. Why: the IDs stay as they are, and the rule alone
keeps an old and a new form apart.

_Found during implementation._

_Current text:_ a leave, a kick and a dissolve message travel with a version prefix, but `leaveId`,
`kickId` and `dissolveId` hash no version, while the root ID does.

_Context:_ nothing is wrong at version 1.
If a later version gave one of these objects different fields, the old and the new form would share
an ID.

- **A (recommended):** add one sentence: a later version that changes the fields of a signed object
  MUST also use a new hash domain for its ID.
- **B:** add the version to the three IDs now, which changes them.
- **C:** leave the text as it is.

### D.18 Who signs the kick when a new owner resolves a fork (§5.6, §5.9)

_Settled:_ a kick is valid only when signed by the owner of the epoch it names (§5.6). The case below remains a known limit, stated in §5.6.

_Found during review of the implementation._

_Current text:_ a kick is signed by the owner of the epoch it names (§5.6).
After a handover from A to B, B may resolve a fork by taking A's branch as a parent (§5.9).

_Context:_ members of A's branch that B's root drops need kicks naming A's epoch, which by §5.6
only A can sign.
B cannot produce them, so those members are never told.
The removed member is never shown the new root, but it may hold the handover root that made B the
owner.

- **A (recommended):** a kick naming an epoch is valid when signed by that epoch's owner, **or** by
  an identity to which a handover root passes ownership from an ancestor of that epoch, when the
  verifier holds that handover root.
  A removed member that does not hold the handover root looks it up before accepting the kick.
- **B:** no kick in this case; the removed members only stop being served.
- **C:** B's resolution root is delivered to the removed members as proof, giving up the rule that
  they never see the new epoch's ID.

### D.19 Presence of `last_modified_at` on a message that is not a deletion (§6.2, Appendix C)

_Found during review of the implementation._

_Current text:_ the field is `optional` in the schema, with a comment only for deletions.
The code refuses a non-deletion without it.

- **A (recommended):** state in §6.2 that for every type except a deletion the field MUST be
  present; an event without it is malformed.
- **B:** an absent field reads as 0, as for other scalar fields.

_Settled:_ choice A, as coded; §6.2 states it. Why: read as 0, the version would silently lose to
every other version.

### D.20 What a forward may carry (§6.2, §7.6)

_Found during review of the implementation._

_Current text:_ a forward holds "a permitted copied content value", without defining "permitted".
The code refuses a forward whose inner type is a forward or a deletion, and a forwarded text that
is not valid UTF-8.

- **A (recommended):** state the code's rule in §7.6.
- **B:** any inner type and any bytes are accepted.

_Settled:_ choice A, as coded; §7.6 states it: text or media only, a text valid UTF-8 within 16,384
bytes. Why: one single way to write each message.

### D.21 A `replyTo` list that is malformed (§7.6)

_Found during review of the implementation._

_Current text:_ a list has 1 to 32 targets and one with more than 32 is malformed; a receiver never
rejects a message because of its references.
The text does not say what happens to the **message** when the list is empty, too long, has a
target of the wrong length or does not decode.
The code treats the whole event as malformed.

_Context:_ "never rejects because of its references" is about targets that cannot be resolved, not
about a list that breaks the format.

- **A (recommended):** the event is malformed, and §7.6 says so, including for an empty list.
- **B:** the message is kept and the list is ignored.

_Settled:_ choice A, as coded; §7.6 states it. Why: one single way to write each message.

### D.22 The result hash projection (§6.2)

_Found during review of the implementation._

_Current text:_ `H("...result.1", fullMessage)`, where `fullMessage` is itself a list.
It can be read as a nested list `[domain, [chat_id, ...]]` or a flat one `[domain, chat_id, ...]`.
The code uses the nested form, which is the literal reading.

- **A (recommended):** state the nested form.
- **B:** the flat form, which changes the hash.

_Settled:_ choice B, the user's choice: a pure convention. §6.2 states the list exactly, with a
worked example; the code and its vectors follow it.

### D.23 One invalid entry in a notice or a page (§13.5, §13.7)

_Found during review of the implementation._

_Current text (before this was settled):_ §13.7 said invalid entries are isolated, which is clear
for query entries only. The code skipped an entry with an ID of the wrong length and used the
others.

- **A:** the invalid entry is skipped and the others are used; the sender is penalised as for one
  malformed item.
- **B:** the whole frame is refused.

_Settled:_ choice B for notices and pages (§13.5, §13.7, §12.1): nothing of the list is used, the
sender is penalised once, a scan in progress ends as for an invalid page. Why: version-1 input that
is not valid is rejected and counts against its sender; an honest device builds these lists from
identifiers it already checked, so it never sends one and cannot be framed; a spoiled list gives a
hostile peer nothing more than sending no list. A query is unchanged: an entry that cannot be read
gets `malformed`, the others their normal answers.

### D.24 A frame that holds two kinds (§13.1)

_Found during review of the implementation._

_Current text (before this was settled):_ "each frame holds exactly one kind".
Protobuf lets an encoder write two cases of one `oneof`, and decoders keep the last.
The code now refuses it at every level, as choice A says.

- **A (recommended):** a second, different case of the same `oneof` makes the message malformed,
  for every `oneof` of the schema.
- **B:** the last case wins, and §1 says so.

_Settled:_ choice A, as coded. Why: a stock protobuf decoder keeps the last case and another
decoder may keep the first, so two implementations could read different messages from the same
bytes.

### D.25 Arithmetic near the top of the integer range (§1, §7.2)

_Found during review of the implementation._

_Current text:_ §1 allows "checked or widened" arithmetic.
For `ts + MAX_SCHEDULE` the two give different outcomes at the top of the 64-bit range: malformed
for good, or temporarily invalid.

- **A (recommended):** widened arithmetic is required for time bounds, so the outcome is the same
  everywhere.
- **B:** leave the text as it is; the values concerned are not reachable in practice.

_Settled:_ choice A, as coded: time bounds use exact 128-bit arithmetic, so every device reaches the
same outcome at the top of the range.

### D.26 Several scheduled deletions of one message (§7.4)

_Found by simulation during implementation (code at commit `614a2345`, seed 7, 160 steps)._

_Current text:_ "only the earliest pending deletion is kept; later scheduled deletions are pruned
immediately".

_Context:_ the result depends on arrival order.
A later scheduled deletion is pruned when it arrives while an earlier one is pending, but is kept
as one more event carrying the tombstone when it arrives after the earlier one has applied.
A duplicate arriving after the tombstone (§9.5) can also restore a pruned deletion on some devices
only.
Honest devices then serve different deletion events and list different tips, for good.
The code keeps every scheduled deletion pending; when the earliest applies, the others are applied
with it in their immediate form.
The cost is a few more events that hold no content.

- **A (recommended):** the code's rule: every scheduled deletion is kept until the earliest applies,
  then all are applied.
- **B:** keep the current text and accept that devices may differ in which deletion events they
  hold.

### D.27 "Available child" or "accepted child" for tips and the cycle frontier (§6.1, §12.1)

_Settled:_ choice B; §6.1 and §12.1 now state it, with the example below as the reason.

_Found during implementation; the recommendation was changed after review._

_Current text:_ the cycle-frontier rule of §6.1 speaks of a component with "no available child"
outside it; the tip definition of §12.1 says "no known accepted event references it".
The two differ once a child has been pruned.

_Context:_ with "accepted", a pruned child still hides its parent from the tips, and a pruned event
answers "not available", so its parent links cannot be learned by anyone.
Example with honest devices only: E1 creates message 1; X1 creates message 2 with parent E1; X2
edits message 2 with parent X1, and every device prunes X1 as superseded.
The only tip is X2.
A device that was offline fetches X2, asks for X1, gets "not available" everywhere and stops: it
never learns E1, which still carries a current message.
Every edit and every deletion of an edited message cuts discovery this way.
With "available", E1 becomes a tip again when X1 is pruned.
A device that pruned locally then names older events as parents, but under "accepted" it would
name none at all, which shows as much.

- **A:** "accepted" in both places (the first implementation).
- **B (recommended):** "available" in both places: an event is a tip when no **available** event
  references it.
- **C:** keep "accepted" and let a pruned event answer a lookup with its parent links, which is a
  change to the wire format.

### D.28 A local-only edit and a pending scheduled deletion (§9.3)

_Found during implementation._

_Current text:_ a local-only change "prunes every event of that message".
Read literally, a local-only edit would also prune a real scheduled deletion that is still pending,
which cancels that deletion on the device.

_Context:_ the code keeps pending scheduled deletions through a local-only edit, since they hold no
content, and prunes them only on a local-only deletion.

- **A (recommended):** the code's rule.
- **B:** the literal rule: the pending deletion is pruned too.

### D.29 An edit dated later than now (§7.2, §7.3)

_Found during implementation; the code follows the current text._

_Current text:_ an edit sets `last_modified_at = max(now, previous + 1)`, and a version becomes
active only when its date is reached.

_Context:_ after two edits in the same millisecond, or after the clock moved back, the new date is
later than `now`, so the user's own edit waits as a hidden future version until that date.
If `previous + 1` is beyond `now + MAX_SCHEDULE`, the edit cannot be published at all.
The _Why_ note "an edit wins locally even across clock rollback" is therefore true only after a
wait.

- **A (recommended):** keep the rule and correct the _Why_ note; the device shows its own waiting
  edit as "pending" in the meantime.
- **B:** a version created by the device itself is shown at once on that device, whatever its date.
- **C:** another rule.

### D.30 Content stored twice in the logical records (§14.1)

_Found during implementation._

_Current text:_ "the stored fields of each available event are the only stored copy of that event's
content", while the current object also holds the current result.

- **A (recommended):** say that the current object **refers** to the event that carries the current
  result, and holds no copy of the content.
- **B:** allow the copy and require both to be deleted together.

### D.31 The form in which a scheduled deletion is served (§7.4, §9.3)

_Found during review of the implementation; it refines D.26._

_Current text:_ a scheduled deletion is served with its date until it applies, then without it.

_Context:_ under the first implementation the form depended on other deletions and on local state.
After a local-only deletion, a scheduled deletion that arrived again was stored and served at once
in its immediate form, so a device fetching it deleted the message up to two weeks early, against
"MUST NOT absorb the message before its time".

- **A (recommended):** the served form depends only on the event and the clock: a scheduled
  deletion keeps its scheduled form until its **own** due time, whether it is pending or held
  beside a tombstone, and is normalised then.
  A local-only deletion keeps pending scheduled deletions, as a local-only edit does (D.28).
- **B:** keep the form tied to the state of the message.

### D.32 Limits on pending versions, pending deletions and rejection markers (§8.2, §9.6, §17.4)

_Found during review of the implementation._

_Current text:_ §8.2 says the storage of pending events "is reserved at admission" and gives no
number; §9.6 expects capacity to force out temporary-rejection markers.

_Context:_ a member can park any number of scheduled versions or deletions for two weeks, and they
cannot be evicted.
A limit applied at arrival makes honest devices differ when they reach it at different moments, so
the rule must be one every device computes the same way.

- **A (recommended):** per message, a device keeps at most 16 pending versions and 16 pending
  deletions: those with the earliest dates, ties broken by result hash; others are pruned.
  Rejection markers are evicted oldest first under storage pressure.
  The numbers are provisional.
- **B:** no limit in this version.

### D.33 A full event arriving under a pruned ID with other parents (§9.5)

_Found during review of the implementation._

_Current text:_ §9.5 compares only the payload; §7.1 says an ID "keeps its first valid
interpretation entirely".

_Context:_ the first implementation restored such an event with its new parents while its tips
were still computed from the first parents.

- **A (recommended):** the event is restored only when its parents equal the stored parent links;
  otherwise the ID stays pruned.
- **B:** the payload alone decides.

### D.34 A local-only edit dated in the future (§9.1, §7.5)

_Found during review of the implementation._

_Current text:_ a local-only edit may set any dates.

_Context:_ with a `last_modified_at` in the future, the message disappears from the user's own view
until that date, and honest edits dated before it lose on this device.

- **A (recommended):** a local-only edit MUST NOT set `last_modified_at` later than now.
- **B:** allowed, and the text says the message is hidden until then.

### D.35 "Indistinguishable from ordinary retention pruning" (§9.3)

_Found during review of the implementation._

_Current text:_ a stub left by a local-only change "is indistinguishable from ordinary retention
pruning".

_Context:_ retention cannot prune an event inside its two-week window, and eviction takes the
oldest first.
A recent stub beside older events still held, or a current result with no event carrying it, can
be told apart by someone who inspects the device.
Peers can also see that a recent tip is missing from the device's next parent list.

- **A (recommended):** weaken the claim: the stub looks like eviction under storage pressure, and
  the text states what an inspector or a peer can still notice.
- **B:** make eviction order not strictly oldest first, so that recent stubs are ordinary.

### D.36 Two limits inherent in the merge rules (§7.1, §7.4)

_Found during review of the implementation; no change is proposed._

- A device whose clock runs fast normalises a scheduled deletion early and serves its immediate
  form, which deletes the message at once on devices that had not seen it.
- Any member can create any number of permanent tombstones by deleting identifiers that name no
  message.

- **A (recommended):** state both in the security section.
- **B:** bound them, by rules to be designed.

### D.37 Page counts when an entry is skipped (§12.1, §13.5)

_Found during implementation; it depends on D.23._

_Current text:_ a page is final when `count` equals "the number of entries it carries", and the next
offset follows the entries received.

_Context:_ if invalid entries are skipped (D.23), counting only the valid ones would make a final
page look unfinished and shift the next offset.
An entry of an unknown kind is an unknown enum value, which §1 says refuses the whole frame, so
only an ID of the wrong length is skipped.

- **A (recommended):** "entries it carries" means entries as received, skipped ones included.
- **B:** a page with any invalid entry is refused whole (D.23, choice B).

_Settled:_ choice B, with D.23: no entry is ever skipped, so the question no longer arises, and the
count of skipped entries is gone.

### D.38 A lane that is still scanning at its turn (§12.3)

_Found by simulation of the implementation._

_Current text:_ the lanes start in turn, and a start "waits until it is eligible".

_Context:_ a lane scanning a member that never answers stays pending through all its stages, about
two weeks.
Read literally, the other lanes wait behind it, so one silent member stops periodic recovery for
the whole group.
The code skips the turn.

- **A (recommended):** a lane still pending at its turn skips that turn; the other lanes go on.
- **B:** bound how long a lane may stay pending, then abandon its scan.
- **C:** keep the text.

### D.39 Resends after `expired` (§11.4)

_Found by simulation of the implementation._

_Current text:_ the requester resends after an `expired` status, with no bound.

_Context:_ a peer that always answers `expired` keeps the requester sending forever.
A fixed small bound is wrong the other way: a member back from a long absence gets honest
`expired` answers to queries that waited in its mailbox, and a bound of 2 left it unable to
recover in the simulation.

- **A (recommended):** unlimited resends when the status is plausible, that is when the request
  was at or past its deadline minus 5 minutes when the status arrived; otherwise at most 2 per
  stage.
- **B:** a fixed bound per stage in all cases.
- **C:** no bound (current text).

### D.40 Scan restarts (§12.2)

_Found during implementation._

_Current text:_ on `restart` the requester starts a fresh scan; nothing bounds how often.

_Context:_ a peer answering `restart` to every page keeps the scan running forever.

- **A (recommended):** at most 3 restarts of one scan with one peer since the last page that made
  progress; then the scan ends as failed.
  The number is provisional.
- **B:** no bound.

### D.41 The stub left when a retrieval task reaches its deadline (§11.6)

_Found during implementation._

_Current text:_ at the deadline the device "prunes the ID to a generic stub".

_Context:_ for an ID that was only announced and never held, a stored stub is one record per fake
ID a hostile member announces.
The deadline is computed from the ID, so the device needs no record to refuse it later.
The code stores nothing.

- **A (recommended):** say the stub is implicit for an ID that was never held: nothing is stored.
- **B:** a stored stub, with a limit on their number.

### D.42 A member that announces IDs it never supplies (§11.8, §17.4)

_Found by simulation of the implementation. This is the largest open point of the retrieval
design._

_Current text:_ the score counts supplied items and penalties; a timeout is not a penalty.
Device-wide fairness is left to the implementation.

_Context:_ a member that announces fake IDs and stays silent pays nothing.
Each fake ID costs up to one lookup per other member, lives up to 14 days, fills responders'
request budgets and the queue of 65,536 IDs, and in the simulation it delayed honest retrieval by
days.
The code adds rules of its own: a task none of whose untried announcers is responsive with a score
of at least 0.5 may use only a quarter of the lookup slots; responsive candidates are asked first;
a task waits for a responsive member rather than ask one that stopped answering.
Any sign of life from a member (an answer, a notice, an accepted event, a query) makes it
responsive again; `busy` does not.
An announcement whose event turns up counts like a supply, and a "not available" penalty is
withdrawn when the event turns up later; a member stays credible after up to 4 failed
announcements.
When the queue of missing IDs is full, the missing parent of an accepted event evicts a task of
the restricted kind.
These rules are not in the text and a hostile member may try to turn them against honest ones.
One known cost: a member that deletes messages locally answers "not available" for what it
announced, and can lose standing with its peers; telling it apart would break deniability.

- **A (recommended):** specify an unresponsiveness factor in the score and a quota for tasks
  announced only by peers that did not supply what they announced, with the code's rules as the
  starting point, after their review.
- **B:** leave it to implementations, and state the attack in the security section.
- **C:** apply the root-announcement pause to events as well (simple, but it slows honest flows).

### D.43 A device whose clock runs fast gets no answers (§11.3)

_Found during implementation._

_Current text:_ a receiver ignores a query whose `sent_at` is more than 5 minutes ahead of its
clock.

_Context:_ such a device never recovers anything and cannot tell why.

- **A:** the receiver answers with a status (`expired`, or a new one) instead of staying silent,
  within the usual limits.
- **B:** keep the silence.

_Settled:_ choice B; no new status. Why: the app can detect a wrong clock locally. This silence
protects no deniability, so a later release may still answer `expired` under §2.2. A "your clock is
ahead" status could be abused to make a device doubt its own clock.

### D.44 One attempt at a time with long waits (§11.2, §11.4)

_Found by simulation of the implementation; no change is made in the code._

_Context:_ a task asks one candidate at a time, and later stages wait up to 24 hours.
One unresponsive candidate costs up to a day per stage, which is where the remaining convergence
delays in the simulation come from.

- **A (recommended):** keep it for this version and state the delay; revisit with measurements.
- **B:** allow two candidates in parallel from the second stage on.

### D.45 "A conflicting immutable context is rejected" (§12.2)

_Found during implementation._

_Context:_ the key of a scan already holds everything the text calls its context, so the
implementer found no case the sentence can apply to.

- **A (recommended):** remove the sentence, or name the fields it means.
- **B:** keep it.

### D.46 Details the code had to choose (§10, §11, §13.9, §17.4)

_Found during implementation. Each is a guess where the text gives no value; listed together so
they can be confirmed or changed._

- Score: `(supplied + 1) / (supplied + penalty + 2)`, both halved when their total passes 1,024.
  Penalty weights: wrong key answer 64, wrong root 16, malformed 4, "not available" after
  announcing 1.
- "Per-peer request budget": the number of query entries a peer may make this device answer; over
  it the answer is `busy`. The response budget counts bytes of answers.
- `busy`: the peer is asked again about a minute later. A `malformed` status ends the peer's turn
  for this run without a penalty.
- Neighbors: pending requests count against capacity; requests and declines expire after 24
  hours; a removed peer is neither suggested nor accepted; a neighbor is replaced once its queries
  have waited 2 days in total without an answer, and candidates rank responsive members first.
- Candidate order: responsive members before unresponsive ones; then members not yet asked
  before those that answered "not available" since they last announced the item, or let a request
  time out without having announced it (§11.2); then peers that triggered the task, then neighbors, then members with a session, then
  others; then score, then trigger time. §11.2 gives the tiers only.
- Dissemination: "own message" means a deletion or a message this device authored; an edit or
  retry of another member's message goes out as notices.
- A sync-object lookup goes on after "not available" and ends "not found" when no candidate is
  left (§12.5 says it "completes on its answer").
- Packing order in a plaintext: control frames, pages, answers, queries (page requests first),
  full events, notices.
- At most 64 plaintexts handed to the transport per poll, rotating across peers.

- **A (recommended):** confirm them one by one when the numbers of D.4 are settled.
- **B:** leave them to implementations.

### D.47 Rules not implemented yet (§12.1, §17.4, D.8)

_Recorded so they are not forgotten; no decision is needed unless one is dropped._

- §12.1: "run the scan with another peer" for scans outside the lanes.
- §17.4: the traversal budget is applied to ancestor sampling only, not to the tip computation,
  which needs the full tip set at once.
- D.8: the fallback for an edit in an older epoch with no eligible neighbor (it needs several
  epochs).

- **A (recommended):** implement the first and third; for the second, say in §17.4 that the tip
  set is exempt and bounded by the limits on held events.
- **B:** apply the budget to tips too, with a rule for a partial tip set.

### D.48 Small points from the merge fixes (§9.1, §14.2)

_Found during review of the implementation._

- D.34 is applied strictly: a local-only edit is also refused when the automatic date
  `previous + 1` would be later than now.
- Rejection markers are evicted in order of the oldest event timestamp first.

- **A (recommended):** state both.
- **B:** other rules, to be given.

### D.49 Does a resend restart the wait of its stage (§11.4, §12.3)

_Found during review of the implementation; it caused a convergence failure in simulation._

_Current text:_ a resend after a reconnection or an `expired` status does "not change the stage, TTL
progression or jitter". The local wait is not named.

_Context:_ the first implementation restarted the wait at each resend.
A member that resets its session more often than the stage's TTL then holds a task or a scan
forever, and one honest device never got an edit the others held.

- **A (recommended):** a resend keeps the stage's original local deadline. The code does this.
- **B:** a resend restarts the wait, with a bound on resends per stage.

### D.50 Largest event against the frame that carries it (§13.10)

_Settled:_ choice A. The length compared with 57,307 bytes is that of the event blob as received; a
copy over it is malformed and counts against its sender, and a proper copy of the same event from
another peer is still accepted. The canonical length is never longer, so checking it too refuses
nothing more (§13.10).

_Found during review of the implementation._

_Current text:_ an event is admitted if it fits an empty container as an event frame.

_Context:_ a lookup answer carries the event in a response frame, which adds `request_id` and
`idx`.
An event of the largest admitted size cannot be served by lookup at all; the first implementation
crashed on it.
The limit must be one every device computes the same way, since it decides validity.

- **A (recommended):** an event is admitted only if it fits an empty container inside the largest
  frame that can carry it (a response frame with the longest `request_id` and `idx`). The code does
  this: with the 57,344-byte container the largest event blob is 57,307 bytes.
- **B:** keep the limit and serve such an event in a plaintext of its own with a special frame.

### D.51 A tips scan from a peer that is not a member (§12.1, §13.7)

_Found during review of the implementation._

_Current text:_ §12.1 answers "not available" for an anchor the device does not hold; §13.7 keeps
silent toward a peer that is not a member of a held epoch.

_Context:_ together they tell any peer with a session whether the device holds a given epoch:
"not available" means no, silence means yes.

- **A (recommended):** a requester that is not a member of the held epoch gets the same answer as
  for an unheld anchor. The code does this.
- **B:** silence in both cases (an honest member then cannot tell "not held" from a lost message).

_Settled:_ choice A, as coded. A device no longer active in the group answers a tips scan the same
way (D.74). Lookups tied to an epoch now follow the same idea (§13.7): "not available" in every
case where the device cannot or may not serve, to a peer that shares an active chat with it.

### D.52 `busy` without a bound (§11.4, §13.4, §17.4)

_Found during review of the implementation._

_Current text:_ `busy` asks the requester to come back later; no bound, and the text does not say
whether it counts as an answer.

_Context:_ a member that answers `busy` to everything was asked 2,885 times in three simulated
days, kept its standing, and as a neighbor stopped both neighbor lanes.

- **A (recommended):** `busy` is not an answer for the score or for responsiveness; after 3 in a
  row from one peer for one task or scan, it counts as a timeout. The code does this; the number
  is provisional.
- **B:** leave it to implementations.

### D.53 An announced ID dated far in the future (§11.6, §17.4)

_Found during review of the implementation._

_Current text:_ the lookup deadline of an ID is computed from its timestamp, with no upper bound on
that timestamp. A full queue "pauses paging"; nothing is said about IDs from notices and parent
references.

_Context:_ 65,536 IDs dated ten years ahead never expire and fill the queue of missing IDs for
good; later missing IDs of the group are then dropped.

- **A (recommended):** a task ends at the earlier of the ID's deadline and its creation plus the
  retention period, and a full queue never loses the parent reference of an accepted event. The
  code does this.
- **B:** refuse an announced ID dated beyond a fixed margin after now.

### D.54 Queued answers and version notices (§13.8, §17.4)

_Found during review of the implementation._

_Current text:_ one version notice per peer and version; over budget the answer is `busy`. Neither
has a bound.

_Context:_ each over-budget query entry queued one stored `busy` answer, and each distinct version
number one stored notice, without limit.

- **A (recommended):** a cap on queued answers per peer, beyond which entries are dropped, and a
  cap on version notices per peer. The code does this with provisional numbers: 256 queued answers
  per peer, one queued version notice per peer, and the last 4 versions remembered.
- **B:** leave it to implementations.

### D.55 What a notice reveals about processing (§11.7)

_Found during review of the implementation; no change is made in the code._

_Context:_ a member can send a notice for an ID and learn, from whether a lookup comes back,
whether the device has already processed that ID.
This is known to members only and concerns held-or-seen, not content.

- **A (recommended):** state it in the security section.
- **B:** look up a random share of already processed IDs as cover.

### D.56 Neighbor capacity and ending a relation (§10.1)

_Found during review of the implementation; no change is made in the code._

_Context:_ "capacity" is not defined; the code takes it equal to the target of 10.
In a large group where everyone already has 10 neighbors, a newcomer is declined by all.
There is no message to end a relation, so the sets become one-sided, and the use of suggestions is
not specified (a declining member can steer the choice).

- **A (recommended):** capacity above the target (for example twice), an explicit end of a
  relation, and suggestions used only as candidates ranked like the others.
- **B:** keep the text and state the limits.

### D.57 Is a page entry an announcement (§11.8, §12.2)

_Found during review of the implementation._

_Context:_ "not available" after announcing is penalised, but §12.2 lets a frozen list keep IDs
pruned since it was frozen, so an honest responder can be penalised for its own page.

- **A (recommended):** a page entry is not an announcement for the penalty. The code does this.
- **B:** it is, and a frozen list drops pruned IDs.

### D.58 Ancestors marked as seen by a relay (§10.3)

_Raised during review; plausible, not shown by a test._

_Context:_ when a peer delivers an event, its ancestors are marked as seen by that peer, though a
relay may not hold those parents.

- **A (recommended):** check with a test when several epochs are in place, then decide.
- **B:** mark only the delivered event.

### D.59 Hand over and leave in one root (§4.7 step 5, §5.9)

_Settled:_ choice A; the old owner may leave in its handover (§4.7, §5.7).

_Found during implementation of membership._

_Current text:_ a root is accepted when its deliverer is a member of it (§4.7 step 5). A handover
may drop the outgoing owner from the member list.

_Context:_ the outgoing owner is then not a member of the root it delivers, so every receiver
refused it.

- **A (recommended):** a handover root is also accepted when delivered by the owner of its held
  parent. The code does this.
- **B:** hand over first, leave in a second step.
- **C:** the new owner delivers the root.

§4.7 step 5 now states it. A handover root whose parent is not held is kept within limits while the
parent is looked up, not discarded (§4.7, §17.4).

### D.60 Is an accepted root announced (§4.6, §4.8)

_Found during implementation of membership._

_Current text:_ §4.6 says an accepted root is announced by root notice; §4.8 says Accept "sends
nothing" and the other members are not told.

- **A (recommended):** only automatic adoptions are announced; accepting an invitation sends
  nothing. The code does this.
- **B:** every adoption is announced.

### D.61 A leave that names an earlier epoch (§5.6, D.2, D.13)

_Found by simulation of the implementation._

_Context:_ a member that missed epochs signs its leave of an older one, and the owner applies it
with no kick.
Nothing then names the epoch the member was removed from, so a device of that member restored from
a backup is never told.

- **A (recommended):** such a leave counts as live for the epoch it names: it is sent back to the
  leaver, accepted as an answer to a removal lookup, and D.2 reads "live for the current epoch".
  The code does this.
- **B:** the owner also creates a kick for the current epoch.

### D.62 A member removed while several epochs behind (§5.6)

_Settled:_ choice A. The same push serves a member that left and was added back, whose device is
restored from a backup made before it left: it is sent its kept leave, and, when a member is about
to tell it of the root that adds it back by a root notice, the leave first and then that root, both
in full (§5.3 "Keeping"). Why: given the root first, the restored device would take it as its next
epoch, silently, as if it had never left; with its leave first it shows the group as left and gets
the root as an invitation to accept again.

_Found by simulation of the implementation._

_Context:_ the member is still at an old epoch that no record names, and it cannot verify a kick
that names a root it does not hold.
The same holds for a device restored to before its own leave.

- **A (recommended):** a retained member sends it, in full, the roots between its epoch and the
  one it was removed from (at most 16 per reply; it is a member of each), together with the kick
  or leave. The code does this. Roots are pushed because a removed peer can no longer look them up
  (D.74).
- **B:** rely on shared-chats scans after a reinstall only.

### D.63 The former owner's branch after a handover (§5.9, §4.9)

_Found by simulation of the implementation._

_Current text:_ the new owner "may resolve" the former owner's branch.

_Context:_ if it never does, members that are only on that branch are left behind without notice.

- **A (recommended):** it is a fork under §4.9: the new owner is prompted and sends nothing in the
  group until it is resolved. The code does this.
- **B:** keep "may", and state the consequence.

### D.64 A root entry in tip lists (§12.1)

_Found during implementation of membership._

_Context:_ a member that missed a root and its notices cannot learn it while the new epoch has no
events, because a tip list of the older epoch names none.

- **A (recommended):** a tip list carries a root entry for the responder's current epoch when the
  requester is a member of that epoch and it is not the anchor. The code does this.
- **B:** rely on root notices and shared-chats scans.

_Settled:_ choice A, as coded.

### D.65 A kick or dissolve held before its epoch is current (§5.4, §5.8)

_Found during implementation of membership._

_Current text:_ "a kick naming another epoch is ignored".

_Context:_ a device that receives the kick before it adopts the epoch would ignore it for ever.

- **A (recommended):** it is kept with its root and applied when that epoch becomes current. The
  code does this.
- **B:** ignored, and learnt again through the replies of §5.6.

### D.66 Joining conversations (§5.10)

_Found by simulation of the implementation; the text is silent._

- Every invitation that is an ancestor of an accepted root is joined to it, even when its parent's
  group is read-only.
- A joined group stays read-only until its current epoch moves past the point it was removed at.
- Accepting a root that rejoins a group follows that root's owner, unless a handover deposed it.
- An invitation with no held parent is joined to a root the user accepted later only when that
  root continues it with authority: a successor by the same owner, or a handover it signed.

- **A (recommended):** state these three rules. The code does this.
- **B:** other rules, to be given.

### D.67 Kick signer after a handover: gap in choice A (D.18)

_Settled with D.18:_ see §5.6.

_Found during implementation; it adds to D.18._

_Context:_ the code follows D.18 choice A: a kick naming epoch E is valid when signed by E's owner
or by an identity that a held handover passes ownership to, from E or an ancestor of E.
A removed member that does not hold the handover root, and is not listed in it, can never fetch
it, since a chat lookup answers members only. It is then never told of its removal.

The code also makes the authority transitive across successors (A hands to B, B makes a
successor, B hands to D: D may sign), which covers a handover from a later epoch of the same owner
and is broader than "from an ancestor". A kick a device cannot verify for lack of the handover is
not counted against the member that relayed it.

- **A (recommended):** decide D.18 with this in mind; choices B or C of D.18 close the gap.
- **B:** keep choice A and send the handover root with the kick, as an exception to the lookup
  rule.

### D.68 Details the membership code had to choose (§4.8, §5.5, §12)

_Found during implementation. Listed together so they can be confirmed or changed._

- Root fetches: "4 in progress per peer" is approximated by at most 260 root tasks per peer (4 plus
  the waiting list of 256); beyond that a shared-chats scan of that peer starts.
- §5.5 step 1 ("first finish what is already received") is not implemented.
- Hints and the queue of missing IDs are counted per epoch, not per group.
- A notice entry is bounded at 80 bytes.
- A leave that is no longer live is served only to its leaver and to removal lookups; a
  signed-object lookup for it gets "not available".
- "Ask to be kicked" on an invitation installs that root as a group in the waiting state.
- _Settled, not active in the first release:_ the requester side of a chat lookup by reference is
  built as §7.6 states: on receipt of a reply only, three peers per round at most, once a week,
  four rounds at most, never for an epoch the device can place (installed, an invitation not
  answered yet, or closed). Version-1 devices answer the lookup; the first release does not send
  it, nor fetch a quoted target because a reply names it (local policy, off by default). It is to be
  turned on in a later release once these points are settled: bounding the fetch of a quoted target
  to the round's peers; limits per chat; counting rounds across the deletion and re-sending of the
  replies; the unsigned author field choosing the second peer; a reply held only in a read-only chat
  starting nothing. The markers keep their references meanwhile.

- **A (recommended):** confirm them one by one.
- **B:** leave them to implementations.

### D.69 A handover gives authority over which parents (§4.7)

_Settled:_ choice A.

_Found during review of the implementation. A security defect of the text._

_Current text:_ a root is continuous when its signer owns each parent or is the new owner after "a
previous owner in the root's line". Nothing ties that previous owner to the same group.

_Context:_ A owns two groups G1 and G2 with the same members and hands G1 to B.
B can then sign a root naming the current epochs of both; every device adopted it without a
prompt, G2 passed under B, and B could dissolve it with deletion.

- **A (recommended):** a handover gives authority only over parents in the same group as the
  handover's parent, judged group by group before the new root is considered; a parent the signer
  has no authority over is unmatched, as §4.7 says for any parent, and is never joined. The code
  does this. Refusing the whole root was tried first: it split the new owner's own line on a
  device that held a former owner's epoch without the handover.
- **B:** a root never joins two groups unless its signer owns the current epoch of each directly.

### D.70 Adding back a member that closed the group (§4.8 case 3, §5.2, §5.10)

_Found during review of the implementation. The text contradicts itself._

_Current text:_ a re-add root names the member's last epoch as an extra parent (§5.10). A root
with a closed parent is rejected silently (§4.8 case 3).

_Context:_ the extra parent is exactly the epoch the member closed, so after "Ignore and Delete"
or deleting a kicked archive, the member can never be invited again and sees nothing.

- **A (recommended):** the silent rejection applies only when every parent is closed; a root with
  a parent that is neither held nor closed is an ordinary invitation. The code does this.
  A resolution root in a closed line, with a parent the device never received, then prompts too.
- **B:** a re-add root carries no extra parent; the histories are not joined.

### D.71 An old leave made live again by a re-add (§5.3 "Replay", §5.10)

_Settled:_ choice A; §5.3 now states it.

_Found during review of the implementation._

_Context:_ the extra parent links the epoch the member left to the new one, and the member is in
both, so its old signed leave is live again: the owner's device removed it again by itself.

- **A (recommended):** a leave is not live for a root that re-adds its leaver (a root with a parent
  the leaver is not a member of), and is dead once a held root on the line omitted the leaver. The
  code does this.
- **B:** a leave carries a counter or the re-add root names the leaves it voids.

### D.72 A former owner's roots after a handover (§5.9, §4.6 step 4, D.63)

_Settled:_ choice A. Which end is current is also settled as written in §4.9 and §5.9: among one
owner's ends the greatest `(created_at, chat_id)`; a handover deposes the former owner whatever the
dates; of two handovers from one owner each device follows the one it received first. A rule that
made the lowest new owner's GossipID win was considered and rejected: it would let a former owner
move the group to another member long after the handover.

_Found during review of the implementation; it corrects D.63._

_Context:_ with D.63 choice A, a former owner signs a new successor of an epoch it used to own
whenever it wants, and the new owner is blocked each time until it resolves.
With `created_at = u64::MAX` on that root, the new owner's next date `L + 1` overflowed and the
group was frozen for good.
Each resolution also made the new owner sign one kick per member of that branch, a list the former
owner chooses.

- **A (recommended):** a deposed owner's branch never blocks sending or automatic successors; it
  is shown as an optional resolution. `L` leaves out the roots of deposed owners other than the
  device's own, and `L + 1` saturates. The code does this.
- **B:** roots signed by a deposed owner after the handover are ignored; this needs a way to date
  them, which the protocol does not have.

### D.73 A root notice from a peer that shares nothing (§4.6, §13.7, §12.7)

_Found during review of the implementation._

_Current text:_ a root notice for an unknown ID starts a chat lookup toward its sender.

_Context:_ any peer with a session that learnt a chat ID can test whether a contact holds or
closed that epoch: silence means yes, a lookup means no.

- **A (recommended):** a root notice is acted on only when its sender shares an active accepted
  epoch with the device; otherwise nothing happens. The code does this.
- **B:** always send the lookup, also for held IDs (cover traffic).

### D.74 Removal records and removed peers (§10.4, §12.8, §5.6, §4.11)

_Settled, for inactive devices and removed peers:_

- A device that holds an epoch but is no longer active in its group (kicked, left, waiting,
  dissolved) answers a member exactly as a device that does not hold the epoch would, query by
  query: "not available" to a lookup from a peer that shares an active chat with it, silence to
  any other (§13.7), "not available" to a tips scan; it sends a removed peer nothing. It starts
  no lookup for that epoch, whatever a member announces, sends nothing for the ones in progress
  while the group is inactive (they go on if it becomes active again), and announces no kick or
  leave of that epoch pushed to it; what it needs is pushed to it in full (§10.4). Why: a lookup or a notice would tell its recipient that it kept the epoch.
  Why: a member must not be able to tell "kept the history" from "deleted the chat"; nobody waits
  on silence, and the same answer in every case keeps the two apart for no one. (This replaced
  silence to lookups, which cost each asker one timeout per inactive device; a simulated device
  kept asking such peers for a day.) The exceptions stay: a
  dissolved group serves its roots and its dissolve message; an archive gives a removed peer its own
  kick or leave; the shared-chats scan rules below. Only a device that was active when it
  applied the dissolve keeps that dissolved state: one already kicked, left or waiting applies a
  dissolve silently and stays as it was (§5.8).
- Any query, notice or message event from a removed peer that names the epoch makes a retained
  member send it its kick or leave, the three membership lookups included; never a response, never a
  frame that names no epoch; a lookup that already returns the peer's own record does not send it
  twice; the daily limit is local policy (§5.6). Why: one simple rule, fixed for the wire version,
  that keeps a removed peer informed whatever frame a later client sends first; a pushed record is
  no question, so no loop can start.
- Signed objects and their notices from a removed peer are accepted, and may be fetched from it;
  only its message events are dropped (§10.4). Why: a signed object proves itself whoever carries
  it; refusing it would lose a membership fact when that peer is the only one online that holds it.

_Settled, for a dissolved group:_ in both forms, while it keeps them, a device serves the named
root and the dissolve message to a member of that root, whether or not they share another chat,
and answers a member's tips scan with a page that lists only the dissolve message and the root of
its current epoch, never a message event (§5.8, §12.1). "Dissolve & Delete" keeps them two weeks
from the moment each device applied the dissolve; every member device keeps them, not only the
owner's. Why: it is how a device that missed the dissolve learns it ("not available" left 9 of 300
simulated devices never applying it), it matches what a dissolved group already serves, and no
event ID is given, so nothing of the messages is revealed and nothing is asked for in vain.

_Settled, for the shared-chats scan:_ the scan lists, for a chat the asker is no longer in, the
last epoch in which the asker is listed, whether it was removed from it or left it. A lookup of
that root by that asker is answered, since it was a member of that epoch, and the kick or the kept
leave naming that epoch is sent with it. Nothing about any later epoch is given. A device that
holds nothing of the chat installs it read-only, as "you were removed" or "you left". The scan
answers `restart` when a chat it listed stops being listable before all pages are sent, so that a
device never names a chat its user has since left or deleted.

_Found during review of the implementation._

_Current text:_ §12.8 answers "a member of the named epoch"; §10.4 answers a removed peer "not
available" except for its own removal. §5.4 does not say what a waiting device answers, and §4.11
does not say whether waiting, kicked or dissolved epochs are listed in shared-chats scans.

_Context:_ a removed member could fetch the kicks and leaves of the other removed members, and a
kicked device kept serving its root and listing its epochs.

- **A (recommended):** a removed peer gets only its own kick or leave; a device that is kicked,
  left or waiting in a group answers as if it did not hold it; scans list only epochs of groups
  where the device is an active member. The code does this. Deletion events are still served to a
  removed peer, as §10.4 says, and a dissolved group kept as an archive still serves its roots, so
  that a member back after the dissolve can learn of it.
- **B:** other rules, to be given.

### D.75 Limits on invitations and parent lookups (§4.8, §11.8, §17.4)

_Settled:_ choice A; the limits stay provisional numbers of local policy. The probe it leaves open is
stated in §16.7 with the fixes a later version could adopt.

_Found during review of the implementation._

_Context:_ nothing bounds pending invitations, the depth of a parent chain, or roots held before
their parent is known. A stranger sent 40 self-signed roots and created 41 epoch records and 1,281
lookups; a chain of 60 roots received newest first crashed the first implementation.
Members are also queried before the user answers the prompt, which weakens "Ignore and Delete
(visible to no one)".

- **A (recommended):** limits per sender and per device on pending invitations, hidden parents,
  parent lookups and unverified handover roots, with expiry; before a root is verified, its parent
  is looked up only from the peer that delivered it. The code does this with provisional numbers:
  16 pending invitations per sender and 256 per device; 256 parents fetched for one invitation;
  4 unverified handover roots per sender and 64 per device (since raised to 64 and 1,024, §17.4); 32
  unverified leaves per sender; at most 64 roots examined per operation when catching up on a
  chain.
- **B:** as A, and no lookup at all before the user accepts.

### D.76 Dissolve with deletion: what is kept and erased (§5.8)

_Found during review of the implementation._

_Context:_ the text does not say whether older roots are kept two weeks with the named one, nor
what happens to side branches; it says side branches are not erased.

- **A (recommended):** only the named root is kept, and served, for two weeks; side branches are
  not erased; an erased epoch leaves a dissolved marker so that its root cannot come back as an
  invitation. The code does this.
  A group stays dissolved once its dissolved epoch is erased: the group record keeps the deposed
  owner, so a former owner's side branch cannot make the group active again.
  Known limit: in about 4 in 10 simulated runs with a dissolve and deletion, some device keeps a
  stale active conversation of the dissolved group that nobody else writes in. Recognising it
  would need the parent links of erased roots, which costs deniability; §5.8 already says the
  deletion is best effort.
- **B:** the whole group is erased, side branches included.

### D.77 Points raised by the review with no change in the code

_Recorded for the security section and for D.14._

- A link made by hand between two groups is visible to a peer that scans both (§5.10 against
  §12.1).
- A former owner's kick or dissolve of an epoch it owned still applies to devices that have not
  yet received the handover (§5.6, §5.8).
- A handover root whose parent is a closed marker cannot be verified, so the closed line breaks
  there and the next successor prompts (§4.7 against §4.8 case 3).
- The scans and key queries a device sends right after accepting reveal the acceptance to the
  peers it asks, although Accept itself sends nothing.
- Accepting a root installs its ancestors, which the user never saw; the prompt should show the
  owner that will be followed.

- **A (recommended):** state them.
- **B:** design rules for some of them.

### D.78 Carrying group traffic in the app (§13, §15.2, §14.2)

_Found while binding the engine into the app. These are decisions about the app, listed here so
they are settled with the rest._

- **Carrier. Settled:** group traffic has its own session message type; a keep-alive carries
  nothing (§2.1, §13.1). The first implementation placed it in a keep-alive so that older clients
  would drop it silently; older clients are unsupported, so that reason does not hold.
- **Size on the mesh. Settled:** every packet fits one mesh payload of 65,536 bytes; the container
  is 57,344 bytes, text and metadata 16,384 bytes each (§13.10).
- **Session journal (§15.2).** Not built. The session state is made durable before the ciphertext
  is stored, and a ciphertext is never dropped once encrypted; a crash before that loses a
  ciphertext that never left the device. Choices: accept this and amend §15.2 (recommended, the
  one-to-one path has no journal either), or build the journal before release.
- **Members without a session.** The app opens no session by itself, so a group is limited to
  contacts with an active session. Choices: keep this for the first version (recommended), or let
  the app open sessions from the keys in a root.
- **Shared budget.** Group traffic uses the one-to-one session's lag budget and bypasses the mesh
  keep-alive interval. Choices: a separate throttle on the mesh, or none.
- **One account in two tabs.** In the web secure-storage mode nothing prevents it, and it already
  endangers one-to-one sessions. Choice proposed: an exclusive lock per account.
- **What stays after closing a group.** The closed or dissolved markers and one device counter
  (`next_seq`), which shows only that the device once used groups. SQLite itself may keep deleted
  rows in its files.
- **Unread state** of a group is kept in memory only. Choices: keep, or a local field in the
  engine erased with the group.

- **A (recommended):** decide them one by one.

### D.79 Points from the last membership fixes (§5.3, §10.4, §11.7, §12.3)

_Found by simulation of the implementation._

- A leave sent back to its leaver is preceded by the root of the epoch it names; a device restored
  from a backup could not verify it otherwise.
- The two members scanned after adopting a root (§12.3, first trigger) are drawn by score, members
  with a session first, not uniformly: two hostile members drawn together hid a dissolve.
- A dissolved group kept as an archive still gives a removed peer its own kick or leave.
- A member removed and added back does not fetch again what it dropped while removed (§10.4 says
  it "is no longer a removed peer", §11.7 says an ID once processed is not looked up again). Its
  older epochs then differ from the other members', which the junction line of §5.10 covers only
  loosely.
- Messages of an older epoch can also differ between two devices when that epoch sits in another
  conversation on one of them (an allowed split, or the archive of a removed device), because a
  scan follows the responder's own grouping (§12.1).

- **A (recommended):** state the first three as rules (the code follows them) and the last two as
  known limits.
- **B:** for the fourth, let a member added back fetch again what it dropped.

_Settled:_ choice A. For the third point, an archive gives a removed peer its own kick or leave to a
removal lookup too, as to a signed-object lookup (§12.8): the same record gets the same answer
whichever way it is asked, and nothing else would ever end that peer's membership of the epoch it
was removed from. A member added back fetches the history of the earlier epochs that list it
(§5.10): what it never processed, such as the messages a device restored from an old backup
missed, is fetched like any missing event. The fourth point stays a known limit: what it processed
and dropped while removed is not fetched again.

### D.80 Points from the first runs of the app (§14.2, §4.8, §5.10, §7.5)

_Found by running the app on a PWA and an Android emulator, and by the simulation check added
afterwards._

- **Closed markers.** §14.2 keeps a marker "for each of its ends". A member that left and was added
  back was then offered the group's first epoch again as a fresh invitation: its scan listed that
  epoch's events, it fetched the root, and no marker named it. Accepting it made a second copy of
  the group, and the same then happened to the owner. The code now keeps a marker for every epoch
  of a closed group, and an invitation waiting on a parent that turns out to be closed is rejected
  with it.
- **"Last epoch that person was a member of" (§5.10).** Chosen by date, it could be a former
  owner's root dated at the end of time (D.72), which the member cannot verify. The code takes the
  last such epoch in the line the new root continues, by ancestry.
- **Who a line names.** A handover root is signed by its parent's owner, so that owner is the
  actor of its lines, not the new owner. An outgoing owner that drops itself in its handover is
  shown as having left.
- **Lines for joining (§7.5 has none).** "created the group" is shown only on the device that
  created it; every other member reads "<owner> added you", since a member cannot tell a founding
  root from a successor whose parents it lacks. A member added back reads "<owner> added you back"
  after "You were not a member between…".
- **Changes shown by a root with two parents (re-add).** They are read against the parents that no
  other parent continues; read against both, members removed long ago showed as removed again.
- Known limit: a device restored from an old backup can be offered, as a rejoin, epochs of its old
  line that it never held. Accepting makes no second copy.

- **A (recommended):** state these rules. The code follows them.
- **B:** other rules, to be given.

### D.81 Direct chats: details chosen while writing §5.12

_§2.1 and §5.12 are settled. These details were chosen to complete them and are not confirmed._

- A message of the earlier one-to-one format received from an unsupported client is ignored.
- A link made by a migration is local, like the manual links of §5.10: each device links to its
  own archive.
- Declining a migration invitation leaves the archive as it is, and "Migrate" is offered again.

- **A (recommended):** confirm them one by one.

### D.82 Points from applying the size limits (§13.10, §17.4)

_Found while applying the limits of §13.10._

- A forwarded text counts as text and has the same 16,384-byte limit. Media and reaction bodies
  are bounded by the container only.
- The response budget of §17.4 (1 MiB burst, 256 KiB per minute) was written for the 262,144-byte
  container. It is unchanged, and now equals about 18 and 4.6 full containers where it equalled 4
  and 1.

- **A (recommended):** confirm the first; scale the budget of the second with the container.
- **B:** keep the budget as it is.

### D.83 Additions to the wire format, refused (§2.2, §4.7, §10.1, §11.3, §11.7, §12.1, §13.1, §13.4)

_Settled:_ none of them is added. The format of version 1 stays fully closed (§2.2, §13.8).

- **An ignorable hints field in the container**, which a device could fill with advice for its
  peers and a receiver could skip. Why not: the container is closed, so an unknown field is
  malformed (§1.1); a field that a receiver may skip is an extension point inside version 1, and
  two releases would then act differently on the same bytes. What such hints would carry is local
  policy (§2.2), which a later release improves without telling anyone.
- **A "clock ahead" status** for a query whose `sent_at` is too far ahead (D.43). Why not: the app
  can detect a wrong clock locally, and such a status could be used to make a device doubt its own
  clock. Silence stays the answer.
- **A pruned event answered with its parent links** (D.27, choice C). Why not: a pruned event must
  answer as an event the device does not hold, so that a withdrawn or deleted message leaves
  nothing a peer can tell apart (§9.3); the tip rule over available events already keeps
  discovery going (§12.1).
- **A retry delay carried with `busy`** (§13.4). Why not: the requester's own backoff already
  works (D.46, D.52); how long to wait is local policy (§2.2); and a hostile responder could use a
  delay it names to keep a peer away from the group for as long as it likes.
- **A frame that ends a neighbor link** (§10.1). Why not: a link that only one side still keeps
  goes on delivering; a dead link must be found by behaviour anyway, for the peers that simply go
  offline; and how many links a device keeps is local policy.
- **A second, classical signature beside ML-DSA-65** on roots, kicks, leaves and dissolve
  messages (§4.7, §5.3, §5.6, §5.8). Why not: the only signing key a device has is the account's
  identity key, with the crypto libraries the project allows; signed objects stay small; and a
  break of ML-DSA-65 breaks the account identity itself, which needs a new protocol version in any
  case. The accepted cost is stated in §16.9.

### D.84 The message timer and the settings map: points to confirm (§4.1, §6.2, §7.6, §7.7)

_Found while implementing the two root fields._

- **No rule between a root and its parents.** A receiver checks nothing between a root's timer
  or settings and those of its parents (§4.1). Chosen because a member that lacks the parents
  could not check it.
- **A resolution root copies from the current epoch.** When competing ends carry different
  timers or settings, the owner's resolution root copies those of its current epoch (§4.9).
- **Reactions and the timer.** _Settled, choice B, in this form:_ a reaction is erased, record
  included, when the timer erases its target or at its own moment, whichever comes first (§7.7).
  The state that is not the absorbing tombstone is no state at all: the record goes, and a copy
  offered after the reaction's own moment is refused by its dates. Why: a kept reaction says who
  reacted to what with which emoji, and its identity can be checked by anyone who guesses them.
- **A key given twice.** _Settled, choice B:_ a key given twice makes a message malformed, as it
  makes a root malformed in the settings map (§4.1, §6.2). Why: one single way to write each
  message, so that every implementation reads the same content from the same bytes.

### D.85 What the message timer erases (§7.7, §14.1, §11.7)

_Found while making the timer leave nothing._

_Earlier text:_ at the moment the device deleted the message as a local-only deletion, and kept,
until the group was closed, the tombstone, a stub of every event of the message, their parent
links and pending scheduled deletions.

_Settled:_ the message is erased with every record of it (§7.7). The points that had to be
decided:

- **Erase at the moment, or keep a stub while a child still held names it.** Erase at the moment.
  A child already held never makes its device look a parent up (§11.1), and the tips are computed
  from the available events only (§12.1), so a stub kept for the child would protect nothing. The
  child keeps its own parent links, which are its record.
- **Which moment, when versions disagree.** The latest moment of the versions the device knows.
  An earlier one would let a version with a later creation date come back and be shown.
- **Pending scheduled deletions.** Erased with the message. A late peer can bring one back; the
  device then keeps it as a quiet record, offered to no one and erased `T` after it was processed,
  rounded up (§7.7, §14.1; this replaces "a tombstone, as without a timer"). Refusing a deletion
  by its dates was considered and not done: a deletion does not carry its target's creation date,
  so any such rule could keep a deleted scheduled message alive.
- **A message deleted by hand or by a deletion event before its moment.** _Revised:_ erased with
  its tombstone at its moment rounded up to a step of the timer (§7.7), so that deleting by hand
  leaves no more trace than letting the timer run. The earlier text kept it as without a timer.
- **The storage contract.** A change set now deletes rows, parent edges and objects, besides
  writing them; the bindings carry `removedRows`, `removedEdges` and `removedObjects`, and the SDK
  deletes each record in the same transaction. A stored object written before this change has no
  erasure date: the timer deletes it as it did and never erases it.
- **Peer-knowledge hints.** Those naming an erased event are dropped with it: a hint says that a
  peer saw that event.
- **What is left for a short time.** A frozen tip list that named an erased event keeps naming it
  until it is dropped, at most 10 minutes later (§12.2); a request correlation reference lives
  until its deadline. Both are references only, with no content.

### D.86 Which chats keep the device's connections (§5.12, §5.4, §10.4)

_Found by review: a member that shares only one chat with a device saw the device's keep-alives
continue when the device, kicked, kept the history read-only, and stop when it deleted the chat._

_Earlier text:_ an automatic connection was revoked once no epoch the device still held listed
the peer, read-only groups included.

_Settled:_ once a device is out of a chat (kicked, or its own leave sent) or the chat is
superseded, that chat no longer keeps the device's automatic connections, whether the user keeps
the history read-only or deletes the chat. The table of §5.12 gives every state. The points that
had to be decided:

- **The waiting state keeps them all.** The kick can come from any member, who all hold it, and
  dropping the connections would show the other members that the user asked to leave. After two
  weeks without a kick the device leaves quietly on its own, as "Ignore and Delete" does: the
  chat is closed, its connections go, and the user still appears in the member list to the
  others.
- **A visible leave is sent first.** The signed leave is pushed whole to every member after the
  chat is closed; the connection with a member goes only once the leave was handed to the
  transport for it (the engine), and once no ciphertext for it waits in the outbox (the SDK).
- **The archive of a chat dissolved while active keeps them**, as already decided.
- **Only peers the device shares nothing else with are dropped:** an accepted contact, or a member
  of another chat where the device is active, stays connected.
- **Cost:** a kept read-only history no longer receives the later deletions or a "Dissolve &
  Delete" from members it shares nothing else with, the same loss as a device that deleted the
  chat.
- **A member added back** receives the new root from the owner, accepts it, and then opens its
  connections to the members again as co-members of an accepted group; each member takes the new
  session as that of a member announcing itself anew. _Known limit:_ the root reaches it only over a
  session it still holds with the owner, such as an accepted contact's. An owner it shared nothing
  else with was dropped with the chat, and the owner, which still holds its own side, is not told:
  the member then learns of the re-add only once a session with the owner is renewed, as a device
  that deleted the chat does.

### D.87 What the encrypted storage keeps after an erasure (§7.7, §16.10)

_Found while testing what an erased message leaves on the device._

_Settled, accepted as a known limit of this release:_ the database zeroes what an erasure frees
(`secure_delete`), and the encrypted storage below it can keep the previous ciphertext of a
rewritten block for a short time, readable with the account's password (§16.10). Closing it is
left to the storage layer: flushing the old versions of a block, with a trigger that does not
itself signal an erasure, or a format where every write uses a fresh key. Both are proposed
separately from this protocol.

### D.88 An account reinstalled into an empty device (§5.12)

_Found in a live run: an account reinstalled from its recovery phrase into an empty device, a
second time, left each of its contacts with two active chats of two with it, because a second
automatic chat from the owner of the chat held was an ordinary invitation and accepting it kept
both. The reinstalled account was also offered, as an "Unnamed group" invitation, a later epoch of
a chat its contact had just replaced._

_Settled:_

- A new automatic chat from the owner of the chat of two a device holds stays an ordinary
  invitation; accepting it supersedes the chat held, which becomes its read-only history (§5.12,
  row 10). Declining changes nothing.
- Superseding a chat of two pushes, of what was queued for it, only the roots and signed objects
  of its first epoch; a first root fetched as the parent of another invitation pairs with the
  device's own chat as one received directly.
- An invitation is named as the conversation list names that group.

_Points chosen:_

- The invitation is not shown as an invitation to continue: it looks as before, and only the
  acceptance links it.
- Nothing is sent when a chat is superseded, or when the invitation is accepted, beyond what any
  acceptance sends.

_Known limits:_

- Until the user accepts, the two devices are on different chats: messages written in the chat
  held reach no device of the reinstalled person.
- Each reinstall shows one more prompt; a hostile owner can show one per new chat, as with any
  invitation, and an accepted one moves the conversation; every earlier chat stays readable and is
  listed before the current one.
- A later epoch that reached the reinstalled device while the chat was still active, and whose
  first root it never fetched, stays an ordinary invitation there.
- The other person's copy of a replaced chat lacks its later epochs when they were still queued
  at the switch: what was written there after a timer change is missing from that copy.

_Decision:_ link on accept, as described above, chosen by the owner on 2026-11-21.

_Alternatives not taken:_

- Replace the chat held silently when the new one arrives: not wanted, as the conversation must
  never switch without the user's consent.
- Only document the two chats: parallel chats of two with the same person would pile up with each
  reinstall.
