# Gossip Groups: plausibly deniable group chats

Protocol specification, wire version 1.

This document is self-contained.
It specifies trusted group chats for Gossip over asynchronous peer-to-peer Agraphon sessions.
A group has one owner, who alone changes its member list; its messages are unsigned and deniable.
Direct chats are the two-member case of the same protocol: a conversation between two people is a
group of two, and there is no other conversation format (§2.1).
Normative rules use **MUST**, **MUST NOT**, **SHOULD** and **MAY**.
Short *Why* notes explain the reason for a rule in place; they are not additional requirements.

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

*Why:* protobuf keeps the wire format extensible and compact, while the fixed CBOR projection keeps
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
  In protocol rules the word *chat* means an epoch, as in `chat_id`.
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

*Why:* unsigned messages keep every message deniable, while a signed root gives all members one
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

*Why:* one format for all conversations gives direct chats the same deniability, editing and
deletion as groups, and a type that means one thing can be handled, limited and reasoned about on
its own.

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

*Why:* a timestamp inside the ID gives every device the same age for an event, so retention and
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

| Field | Rule |
| --- | --- |
| `version` | the root's version prefix, `1` (§13.1) |
| `type` | `successor` (0) or `handover` (1) (§4.7) |
| `name` | the group name: UTF-8, 0 to 256 bytes (§5.11) |
| `parents` | 1 to 32 parent commitments, 32 bytes each, distinct, sorted ascending (§4.5) |
| `members` | 1 to 512 GossipIDs, distinct, sorted ascending by raw bytes (§4.4) |
| `group_secret` | 32 fresh random bytes |
| `owner` | the owner's complete `UserPublicKeys`, serialized with bincode (§4.3) |
| `epoch_challenge` | 32 fresh random bytes (§4.5) |
| `ref_chat_id_challenge` | 32 fresh random bytes (§4.5) |
| `created_at` | the creator's clock at creation, u64 Unix milliseconds; a claim |
| `signature` | an ML-DSA-65 signature over the root ID (below) |

The root has no event ID, no parents in the DAG sense and no payload.
Its only identifier is the **root ID**, which is also the epoch's `chat_id`:

```text
chat_id = H("gossip.groups.root.1",
            version, type, name, parents, members, group_secret, owner,
            epoch_challenge, ref_chat_id_challenge, created_at)
```

In this projection `version`, `type` and `created_at` are unsigned integers, `name` is a text
string, `parents` and `members` are arrays of byte strings in their sorted order, and the other
fields are byte strings.
The signature and the ID itself are not hashed.

The **signature** is computed over the 32 bytes of the root ID, with the ML-DSA-65 signing context
`gossip.groups.root.signature.1`.
Who signs depends on the root's type (§4.7).
The signature travels with the root and is checked by every device that receives it.

The member list, the name and the owner are fixed for the epoch's lifetime.
Changing any of them means creating a new root.

*Why:* hashing every field into the ID means that two different member lists, names, secrets,
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

*Why:* fetching only when a key is needed could leave a device unable to reach anyone in a group
whose members are rarely online.

A wrong answer to a key query gets the heaviest penalty of the peer score (§11.8).

A device MUST NOT send group frames to a member until that member has authenticated over the
session, through the signed Agraphon `AuthBlob` whose `UserPublicKeys` derive to the expected
GossipID.

### 4.4 Member limit

An epoch has **at most 512 members**, the owner included.

The limit is provisional, like those of §17.4.
It is not set by the container: the fixed part of a root (owner keys, signature, secret,
challenges, time and wrappers) is about 6.7 KB, and each member costs 34 encoded bytes, so about
1,490 members would fit one empty 57,344-byte container (§13.10).
At 512 members a root is about 24 KB (25,417 bytes with 32 parents and the longest name).

*Why:* with GossipIDs only, the cost of a large group is no longer the root but the keys.
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

*Why:* a new member learns no parent ID, while a member who already holds a parent can verify the
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
A device computes and stores `ref_chat_id → chat_id` when it installs a root.
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

1. chooses the member list, which includes the owner, and the name;
2. generates the group secret and the two challenges;
3. computes the parent commitments (§4.5, §5.10);
4. sets `created_at = max(now, L + 1)`, where `L` is the greatest `created_at` among all the roots
   of that group it holds (for a new group, `created_at = now`), computes the root ID and signs it;
5. sends the full root, directly over Agraphon, to **every other member**;
6. sends in the same plaintext, to each member who is also in the parent epoch, the kicks of the
   members it removed (§5.6).

*Why direct delivery:* every member must receive the full root once, whoever sends it, so the total
volume is the same in every scheme (about members × root size).
Sending directly adds no query and does not depend on a third peer being online.

**Relay.** A member that has adopted or accepted a root announces it by a **root notice**: a notice
entry carrying only the `chat_id` (§13.5).
A peer that lacks the root fetches it by chat lookup (§12.7) and checks it against that ID.

- A root notice is sent only to peers in that root's member list.
- Only a device that holds the full root and may serve it announces it.
- A root notice is acted on although the epoch is unknown to the receiver (§13.7).

*Why:* a member whose connection with the owner is broken gets the root only through this relay, so
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
- it may remove members, the old owner included, and change the name;
- it never adds a member.

On receiving a root, a device MUST, in order:

1. validate the encoding, the type, the name (valid UTF-8, at most 256 bytes), the parents (1 to 32
   distinct 32-byte commitments, sorted) and the members (1 to 512 distinct nonzero 32-byte
   GossipIDs, sorted);
2. compute the root ID and, if the root was fetched after a notice, a page entry or a lookup, check
   that it equals the announced `chat_id`;
3. parse the owner keys, hash them to the owner's GossipID and check that the owner is a member;
4. check that it is itself a member;
5. check that the immediate Agraphon peer that delivered the root is a member;
6. match the parent commitments against what it holds (§4.5);
7. verify the signature:
   - **successor:** with the ML-DSA-65 key of the root's own `owner` field;
   - **handover:** the device MUST hold the parent; it verifies with the ML-DSA-65 key of that
     parent's owner, and checks that the new owner differs from the parent's owner and that every
     member of the new root is a member of the parent.

A root that fails any of these checks is discarded, and counts as a failed announcement against
the peer that supplied it (§11.8).
A handover root whose parent the device does not hold is discarded without that penalty, and the
parent is looked up (§4.8).

**Continuity.** For a successor root, each held parent is then checked for authority.
The root's owner has authority over a held parent when:

- the parent's owner is the same identity as the root's owner; or
- the parent's owner is a **previous owner in the root's own line**: it signed a handover root that
  the device holds, on the path leading to one of the root's parents (§5.9).

A held parent over which the root's owner has no verified authority is treated as unmatched: the
root does not continue it.

*Why a handover root never adds members:* a new member holds no parent, so it could only check the
signature against the root's own `owner` field, which holds the new owner's keys and not the
signer's.

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
4. **Kicked, dissolved or waiting.** A parent is an epoch the device holds in one of these states:
   - *kicked* (§5.6) or *dissolved and kept* (§5.8): the root is an **invitation**;
   - *waiting for a kick* (§5.4): the root is kept without a prompt, under the rules of §5.4.
5. **No parent matched.** The root is an **invitation**, after the parent lookup below.

*Why case 2 has no prompt:* the owner is the party trusted with membership and the continuation is
verifiable; a prompt on every change is friction, and a member who ignores it drops out.
The cost is accepted: when the owner adds someone, that person learns the GossipIDs of all current
members without those members being asked, and a member who objects can only leave afterwards.

*Why case 3 has no prompt:* a group that the user left keeps producing roots, and a prompt each
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
- during the first `PROMPT_DELAY` (five minutes) after receiving the root, the invitation prompt is
  shown only on an explicit answer: the **owner** of the root answers "not available", or three
  distinct members do;
- after `PROMPT_DELAY` without a result, the prompt is shown anyway and the lookup keeps running in
  the background;
- if the lookup succeeds while the prompt is open, the device adopts the root under case 2 and
  closes the prompt; if the user had already accepted, the two conversations are joined;
- a decline made while the lookup is still running cannot be undone: a leave or request that was
  sent stays sent.

*Why the owner's answer settles it:* the owner created the root and holds all its parents.

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

*Why the union is not preselected:* adding back a removed member by accident gives them the new
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

*Why only the latest epochs:* listing every shared epoch would grow with every membership change of
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

| Object | Signed by | Meaning | Section |
| --- | --- | --- | --- |
| leave | the member who leaves | "I leave this epoch's group" | §5.3 |
| kick | the owner | "this member is removed from this epoch" | §5.6 |
| dissolve | the owner | "this group is ended" | §5.8 |

Every device MUST verify a signed object before storing or relaying it.
Message events stay unsigned.

### 5.2 Leaving and declining

There are three ways to leave a group or to decline an invitation.
They are named by who sees them:

| Spec term | What happens | Seen by |
| --- | --- | --- |
| **signed leave** | a leave message signed by the member, relayed by every member (§5.3) | everyone |
| **owner-only request** | an unsigned request sent to the owner alone (§5.4) | the owner |
| **silent close** | the group is closed on this device and nobody is told (§14.2) | no one |

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
owner-only request reaches that state only after its waiting state (§5.4).

*Why "invited again" in choice 3:* nobody removed the user, who therefore stays in the member list.
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
3. M is a member of every epoch on **at least one** path from E to C.

A device that holds E and C but not every root between them cannot check condition 3; the leave is
then not live for it.

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

- it is sent in full to the leaver when that leaver contacts the device in that epoch (§10.4);
- it is returned to a removal lookup (§12.8) from a member of that epoch.

*Why keep it:* a leaver whose device was restored from an earlier backup does not know it left.
It still acts as a member of that epoch, and the kept leave, which it can verify with its own key,
tells it.
Liveness alone decides whether a leave removes anyone, so keeping an old leave cannot replay it.

**When a leave applies.** The owner's device acts on a leave exactly when it is live for it, and
then creates a successor without M (§5.5).
Other members do not act on it; they only relay it.

The rule covers these cases:

- *Late leaver.* M is in X and never received Y, where M is still listed.
  M can only sign a leave for X.
  X is an ancestor of Y and M is in both, so the leave removes M from Y.
- *Replay.* M left from X and was removed in Y; later M is added again in Z and accepts.
  The old leave for X never expires, but Y does not contain M, so every path from X to Z or to any
  later epoch is broken and the leave is used up for good.
- *Leaving again.* Adding a member back always creates a new epoch, so a second leave names a new
  epoch and has a different `leaveId`.
  Two legitimate leaves never collide.
- *Forks.* If M was removed in one branch but kept in another, and the resolution root keeps M, the
  leave applies again and removes M.
  That matches M's side: M closed the group and rejects those roots (§4.8).

*Why no random field:* it is not needed to tell two legitimate leaves apart, and it would let one
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

*Why every root is kept:* with only the newest one, a competing successor of an already dropped
root would look like a new invitation, and a kick naming the other branch could not be checked.

*Why the request follows an owner change without a special rule:* the waiting device adopts a
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

**At a handover** (§5.7) the old owner's device applies every live leave and every request it
holds in the handover root itself, without waiting.

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

**Creation.** When the owner's device creates a root, it creates one kick for each parent epoch and
each member of that parent who is not in the new root, except members whose live signed leave it
holds.
For a handover root the signer is the old owner, who owns the parent.

**Delivery.**

- The owner sends each kick in full to the member it names.
- The owner sends **all** the kicks in full to every member who is in both the parent and the new
  root, in the same plaintext as the new root (§4.6); kicks that do not fit go in following
  plaintexts.
- A member that holds a kick announces it by notice `[chat_id, kickId]` like any relayed object
  (§10.2), to members of the new epoch who were in the parent.
  A member that missed the owner's send fetches it by signed-object lookup (§12.8).
- When a peer that was removed from an epoch sends a retained member any frame for that epoch, the
  retained member answers with the full kick naming that peer, or with that peer's signed leave
  (§5.3), whichever it holds (§10.4).
  It sends this answer at most three times per removed peer per day and per epoch; each retained
  member counts on its own.
  If it holds neither, it first sends other members a removal lookup (§12.8) and forwards what it
  receives.

Retained members stop serving a removed member because of the new root (§10.4), not because of the
kick; the kick exists to tell the removed member.

**Keeping.** A device keeps a kick for as long as it keeps the root of the epoch it names, and
deletes both together.
There is no exception for a member who was added back, and no rule that keeps only the latest kick
of a member: a member who was offline through a removal, a return and a second removal is still at
the first epoch and needs the kick naming that epoch.

**On the removed member's device.** A valid kick that names the device itself and its **current**
epoch has this effect:

- the group becomes a read-only archive: the history stays readable, with a line "You were removed
  from this group", and the composer is disabled; the user can delete the group's data;
- the device stops everything it starts itself in that epoch: sending, relaying, notices, scans and
  neighbor upkeep;
- it still applies deletion events for that epoch (§10.4) and drops everything else it receives
  there;
- it answers queries about that epoch "not available";
- from then on, every root that lists the device is an **invitation** (§4.8), whatever its parents.

A kick that names an epoch which is not the device's current epoch is ignored, except in the
waiting state (§5.4).
A kick for an epoch the device does not hold cannot be checked and is dropped.

*Why a kick for another epoch is ignored:* after a fork made by the owner, a root listing the
device can arrive before the kick.
The device has then adopted that root on the owner's own signature, and a kick for the older epoch
contradicts it.
The owner's resolution root settles who is in, and comes with a kick naming the epoch the member is
then at.

*Why the group is not closed automatically:* an owner could otherwise erase the history on a
member's device by removing that member.

### 5.7 Changing the owner

Ownership passes by a **handover root** (§4.7): a root signed by the current owner A whose `owner`
field names another member B.

- The handover is immediate.
  B is not asked, and becomes the owner as soon as a device adopts the root.
- A signs the root while still the owner, so the outgoing owner never has to sign anything after
  leaving.
- The handover root may remove members, A included, and may change the name.
  "Hand over and leave" is therefore one root, after which A's device closes the group.
  A may also hand over and stay as an ordinary member ("Transfer ownership").
- It never adds a member (§4.7); B adds members afterwards with a successor root.
  The owner's device refuses to build a handover root that adds anyone.
- It has exactly one parent.
  An owner with competing ends first resolves them (§4.9), then hands over from that epoch.
- A's device applies in it every live leave and every owner-only request it holds (§5.5).

*Why no acceptance step:* it is deferred (§17.5).
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

- The owner's device sends it in full to all members of the named epoch.
- Every member relays it like a signed leave: notice `[chat_id, dissolveId]` and signed-object
  lookup (§12.8), among members of the named epoch.
- Every device verifies it with the owner keys of that epoch's root.
- It applies only when it names the device's **current** epoch.
  A dissolve message naming another epoch is ignored.

**Effect with `must_delete` false** ("Dissolve & Keep archived"):

- the group is ended and read-only, with the line "This group was dissolved by its owner";
- inside the conversation, and on its entry in the list, the user gets **Archive** and **Delete**;
- the device keeps announcing the dissolve message and answering lookups for it.

**Effect with `must_delete` true** ("Dissolve & Delete"):

- the device erases the group's messages at once, in the named epoch and in every earlier epoch it
  holds that leads to the named one by parent links; side branches that do not lead to it are not
  erased;
- it keeps the named root and the dissolve message for two weeks, only to announce the message and
  answer lookups for it, then deletes them;
- it then keeps only a **dissolved marker** (§14.2).

If a device receives both forms for the same epoch, it deletes.

**After a dissolve**, in both forms, a later valid root that lists the device is an **invitation**
(§4.8).
After "Keep archived", an accepted root continues the conversation with its history, as after a
kick.
After "Delete", an accepted root shows as a new group without the old history.

*Why not the automatic rejection of §4.8:* that rule respects a choice the user made.
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

*Why no fixed winner:* any rule based on the roots' content, such as the greatest or the earliest
`created_at`, is controlled by the former owner, who could always produce the winning handover and
take the group back.

### 5.10 Adding a member back, and links

When a member M is removed at epoch X and later added back at epoch Z, the ordinary parent of Z is
an epoch M never held, and M cannot be given the roots in between: they hold the member lists and
secrets of epochs M was not in.

**The extra parent.** When the owner's device adds back someone who was a member before, it adds
one more parent commitment to the new root: the last epoch that person was a member of.

- On M's device, Z then has a parent it holds, so the invitation, once accepted, continues the same
  conversation (§4.8).
- Members who hold X see one more parent, an ancestor they already have.
  Members who do not hold X see one unmatched commitment and ignore it.
- One extra parent is needed per distinct last epoch among the people added back, within the limit
  of 32 parents.

**Blind spot.** The owner's device must hold X to commit to it.
An owner who joined the group after M was removed, or who no longer holds X, cannot make the link.
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

**At the junction.** After M accepts the invitation, the conversation shows:

- the old history as it was, ending with "You were removed from this group";
- one line: "You were not a member between \<time the kick was received\> and \<the time `T` of the
  new root (§7.5)\>. Messages from that period are not available.";
- the line "\<owner\> added you back", followed by the new messages.

The read-only state ends and the composer is enabled again.

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

*Why:* bounded parents keep events small while still recording causal context for recovery.

### 6.2 Message event

A message event carries:

| Field | Rule |
| --- | --- |
| `version` | the event's version prefix, `1` (§13.1) |
| event type | `GROUP_MESSAGE_EVENT` |
| `eventId` | `ts ‖ random` (§3) |
| `chat_id` | the epoch (§4.1) |
| `secret_proof` | §4.2 |
| `parents` | §6.1 |
| `payload` | the message result, an extensible protobuf message (below) |

**Payload** for every type except `delete`:

| Field | Rule |
| --- | --- |
| `syncObjId` | 32 bytes; random for ordinary messages |
| `type` | see the table below |
| `author` | the claimed author's GossipID; MUST be a member of the epoch |
| `created_at` | claimed creation time; display ordering key |
| `last_modified_at` | claimed modification time; version ranking key |
| `body` | type-specific |
| `edited` | claimed edited flag, independent of the timestamps |
| `metadata` | map from text keys to byte values; empty when unused |

| Tag | Type | Body |
| --- | --- | --- |
| 0 | `text` | UTF-8 text |
| 1 | `forward` | `[content_type, content]`: a content-only copy (§7.6) |
| 2 | `reaction` | defined by the content specification |
| 3 | `media` | defined by the content specification; requires a `mimetype` |
| 4 | `delete` | no body (see below) |

**Delete** is a tombstone carrying only `syncObjId` and `type = 4`, plus an optional
`last_modified_at` present only while a scheduled deletion is pending (§7.4).
It has no author, creation date, body, edited flag or metadata.

**Result projection.** The CBOR projection of a payload is:

```text
fullMessage = [chat_id, syncObjId, type, author, created_at, last_modified_at, body, edited,
               metadata]
```

where `body` projects to a text string for `text`, to `[content_type, content]` for `forward`, to a
byte string for `reaction` and `media`, and `metadata` projects to a CBOR map from text strings to
byte strings.
A delete projects to `[chat_id, syncObjId, 4]`, without its pending `last_modified_at`.

**Result hash** (local only, never stored or transmitted):

```text
resultHash = H("gossip.groups.message.result.1", fullMessage)
```

The event ID, event timestamp, secret proof and parents are not part of the result.

**Metadata** is preserved exactly (including unknown entries) when storing and relaying an accepted
result.
It is part of the result hash.
Within a protocol version, new fields are added to metadata; new payload fields require a new
protocol version (§13.8).
Each metadata key defines the encoding of its value.
Metadata conveys no membership authority.

**Claimed authors.** The claimed author MUST be a member of the epoch; others are rejected.
Independently, the immediate Agraphon peer MUST be a member; it need not be the claimed author.

*Why:* members may fabricate messages in each other's names (deniability), but outsiders cannot be
named as authors.

### 6.3 Receiving a message event

A device accepts a message event only if:

- the epoch is installed and accepted, and the immediate peer is a member of it;
- the immediate peer is not a removed peer for that epoch, and the group is not in a state that
  drops incoming events (§10.4);
- the encoding, parents and payload are valid;
- the secret proof matches;
- the claimed author is a member of the epoch;
- the event timestamp and the payload timestamps pass admission (§7.2).

## 7. Message semantics

### 7.1 Merging results

A device stores one current result per `(chat_id, syncObjId)`, plus pending future versions (§7.3).
For an incoming event under a **new** event ID:

- A valid delete is **absorbing**: once applied, no non-delete result restores the message,
  regardless of timestamps or arrival order.
  A delete that arrives before any content still creates the tombstone.
- Between non-delete results, the greatest `(last_modified_at, resultHash)` wins.
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

*Why:* monotonic edit times let an edit win locally even across clock rollback.
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

*Why:* deletion is terminal and events cannot be withdrawn, so only the earliest scheduled deletion
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
- Deleted messages and pending future content are hidden.
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

  *Why:* the line never sits above an old-epoch message the device already showed, every device
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

**Resolving a reference.** A device resolves a reference against the roots it holds (§4.5).
If none matches, it MAY send a chat lookup by `ref_chat_id` (§12.7), which returns the root only to
a member of that epoch.
To load a resolved target, the device performs a sync-object lookup in the target's epoch (§12.5),
subject to §10.4.

**Display.** A preview has two lines: "\<author\> in \<group name\>", then the shortened, wrapped
content.
"in \<group name\>" is dropped when the target is in the same group.

- The **header** of a message shows the previews of the messages it replies to.
  The **footer** shows backlinks: the previews of the messages that reply to it.
  Both use the same component.
- A preview is shown whenever the reader holds the target, whatever its group.
  Selecting it opens that conversation at that message.
- If the reference matches no root the device holds, nothing is shown, and the preview appears if a
  lookup later succeeds.
  "Message unavailable" is never displayed.
- If the root is held but the target is not loaded, the preview shows a loading state with the
  retry progress (stage n of 20, §11.4), then a failed state.
  There is no retry button; a later notice, scan result or reconnection can restart the retrieval
  (§11.5).
- If the target is in a group the user has hidden, nothing is shown.
- Up to 4 previews are rendered normally.
  With more than 4, they are shown in pages of 4 that are swiped horizontally, with a pagination
  control and a "show all" button.
- A single-click toggle switches between most recent first and least recent first; it starts on
  most recent first.

*Why no "Not a member" answer:* such an answer would be a first-hand statement that the epoch
exists and that the responder was in it, and would let a later member map an earlier member list by
asking every peer.

Caveat: a reference is the same value everywhere.
Members of the reply's epoch who are not in the target's epoch see an opaque value and can tell
when two replies point to the same unknown epoch, nothing more.

**Forwards** are content-only copies in the destination chat.
Their body is `[content_type, content]`, a permitted copied content value.
They contain no source chat, source sync-object ID or reference, and no original author; the
claimed author is the forwarder.
Destination metadata is rebuilt from an allowlist of understood content-only fields.
Reply, provenance, source and unknown fields are dropped, with a warning if content is unsupported.
Recipients MUST NOT need access to the source to render a forward.
Media in a forward must be copied into fresh destination-authorized objects; the mechanism is part
of the content specification.

*Why:* references would leak source metadata and fail for recipients without source access.

**Reactions and media** are separate message types whose schemas belong to the deferred content
specification.
Binding constraints for that specification:

- standalone media has a required `mimetype`;
- other messages reference media elements from their metadata, with explicit source context and
  stable element identity;
- inline media inside text uses an ordered sequence of text spans and media-reference spans, not
  offsets;
- forwarded media is rebound into the destination chat;
- media size and transfer limits are defined there, not by the text limits in this document.

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

*Why:* aging by the event's own timestamp gives every device the same expiry for the same event, so
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

*Why:* the altered message stays visible locally, but this device stops serving any version of it,
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

*Why:* if a device altered "hello" to "bye" locally and pruned the event, a duplicate "hello" under
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
  *Why:* neighbors hold copies even if the sender goes offline right after sending.
- **Relayed events and fabricated messages** (attributed to another member): send gossip notices
  only, and answer explicit requests with the full event.
  *Why:* fabrication then looks like an honest relay.
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

| Published | In which epoch | To whom |
| --- | --- | --- |
| A new message | the current epoch (Y) | its members (A, C, D) |
| An edit or a Retry (§9.4) of a message of X | X | the members of X who are in the current epoch (A, C) |
| A deletion of a message of X | X | every member of X (A, B, C) |

*Why:* an edit carries new content, which a removed member should not get; a deletion removes
content, and should reach everyone who had the message.

**Serving a removed peer.** The table binds every device and every way of handing out the events of
a superseded epoch: first send, relay, notices, lookups and tip pages.
To a removed peer, a device hands out **deletion events only**.
Any other request is answered "not available", and tip pages list deletion events only.
There is no exception for messages sent before the removal.
The device also answers the removed peer with the kick that names it or with that peer's signed
leave, at most three times per day (§5.6).

**Accepting from a removed peer.** A device drops everything a removed peer sends in the superseded
epoch: new messages, edits and deletions alike, including deletions of that peer's own messages.
The filter is on the delivering peer, so an event relayed by a member that has not adopted the
successor yet is still accepted.

*Why:* a removed member must not be able to affect the group any more than it already has, even
where that costs convergence between devices that had processed different events before adopting
the successor.

**Reaching the right peers in an older epoch.** Neighbors are chosen in the current epoch (§10.1).

- An edit in an older epoch goes to the neighbors who are members of that epoch.
  If none is, it goes to another member of both that epoch and the current one, chosen at random,
  in addition to the extra recipients of §10.2.
- The author of a deletion in an older epoch sends the full event to its neighbors who are members
  of that epoch **and directly to every removed peer of that epoch**.
  Relays use notices as usual, and scans cover failures.

*Why push deletions to every removed peer:* removed members are nobody's neighbors, so nothing
else would bring them the deletion quickly.
The cost is accepted: up to 511 ciphertexts for one deletion, each about 3.8 KB, because the
session adds about 3.6 KB to every ciphertext whatever it carries.
A notice would save nothing.

**Groups in a special state.** A device whose group is a read-only archive after a kick (§5.6)
applies deletion events for that epoch and drops every other incoming event.
A device in the waiting state (§5.4), and a device whose group was dissolved (§5.8), drop every
incoming event.

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

*Why:* exponential growth fits asynchronous peers that may be offline for days, the local jitter
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

*Why:* retention counts from the event's own timestamp, so after `ts + RETENTION` no honest peer
serves the event any more and further requests would be wasted traffic.

### 11.7 No refetch of pruned IDs

A known pruned ID is never actively requested again, whether it appears in a notice, a parent
reference, a tip page or any other discovery.
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

*Why a pause in addition to the score:* for an unknown epoch the announcer is the only peer the
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
- If the responder does not hold the anchor, it answers "not available".
  This is legitimate (§11.8): being late on a root is not a fault.
  The requester then sends that peer a root notice for the anchor (§4.6) and runs the scan with
  another peer.

**What is listed.** The responder takes every epoch of the group that contains the anchor,
according to its own grouping (§5.10), and keeps those the requester is a member of.
Each entry of the list is a pair `[chat_id, id]` with its kind (§13.5), so the requester knows which
epoch each entry belongs to.

- For an epoch from which the requester is a removed peer, only deletion events are listed (§10.4).
- An epoch with no retained events has no tips, so the size of a scan follows what is pending, not
  the number of membership changes.
- An entry whose `chat_id` the requester does not hold is handled as a root notice (§4.6); it is
  ignored if it matches a closed-chat marker.

**Tips.** A tip is an available event that no known accepted event references as a parent (plus the
cycle frontier entries of §6.1).

**Order.** The responder builds the list before freezing it:

1. first every signed leave that is live for it (§5.3), and the dissolve message of its current
   epoch if it holds one (§5.8), in ascending ID order;
2. then the events, from two queues over all the listed epochs: deletion events, by event ID
   ascending, and the other events, by event ID descending (newest event timestamp first).
   It takes the next three deletion events, then the next other event, and repeats, the same 3:1
   ratio as §13.9; when one queue runs out, the other fills the rest.

IDs are never invented or reshuffled afterwards.

*Why:* leaves and a dissolve change who is in the group, so they travel first; there are at most
511 per epoch.
Deletions travel ahead of other events so that removals are processed early when many pages are
needed, but new content is never starved behind a long run of deletions.

**Pages.** A page holds at most 128 entries and is a `[scanId, offset, count, entries]` payload.

- `count` is the number of entries remaining from `offset`, including this page.
  At offset 0 it is the total; a page is final exactly when `count` equals the number of entries it
  carries.
- A valid empty end page is `count = 0, entries = []`.
- An empty page with a positive count is invalid.
- Out-of-range offsets are rejected.
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

*Why:* neighbor scans recover what the usual peers hold, while scans of random non-neighbors reach
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

### 12.5 Sync-object lookups

Messages can be looked up by `syncObjId` as well as by `eventId`.

- The responder returns any available event carrying its current result for that message; if none
  is available, the answer is N/A, even if the message is still displayed.
- A responder never creates an event or restores a pruned one to answer.
- A request from outside the epoch's membership is dropped silently (§13.7), and a removed peer
  is answered under §10.4.

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

| Form | Data | Used for |
| --- | --- | --- |
| by ID | `chat_id` | a root that was announced or listed (§4.6, §4.11) |
| by reference | `ref_chat_id` | the epoch of a reply target (§7.6) |
| by parent | `chat_id, parentCommitment` | an unmatched parent of a root the requester holds (§4.8) |

- The responder answers only a requester that shares at least one accepted epoch with it, as for
  shared-chats discovery (§4.11); any other request is dropped silently.
- **By ID:** the responder looks for an accepted root with that ID.
- **By reference:** it looks for an accepted root with that `ref_chat_id` (§4.5).
- **By parent:** `chat_id` names a root that both peers must be members of; the responder looks,
  among the roots it holds, for the one whose commitment under that root's `epoch_challenge` equals
  `parentCommitment`.
- In every form, the responder returns the root only if the requester is a member of **that**
  root.
  Otherwise it answers "not available", whether or not it holds a matching root.

*Why:* the same answer for "not held" and "held, but you are not a member" stops anyone who learned
an ID, a reference or a commitment from testing who belongs to that epoch.

There is no "Not a member" answer (§7.6); status code 1 stays reserved and is never sent.
"Not available" to a lookup by reference or by parent carries no penalty (§11.8).

### 12.8 Signed-object lookups

A leave, a kick or a dissolve message that was announced is looked up by `[chat_id, kind, id]`.
A **removal lookup** asks by `[chat_id, memberGossipId]` for every removal record of that member in
that epoch: the answer is the kick, the leave, or both, each as its own response to the same entry,
or "not available" when the responder holds neither.
A device uses it when it must answer a removed peer and holds no record for it (§5.6).

- The responder answers only a requester that is a member of the named epoch; other requests are
  dropped silently.
- It returns the full signed object if it holds it and still serves it (§5.3, §5.6, §5.8), and "not
  available" otherwise.
- A returned object MUST hash to the requested ID and pass verification; otherwise it is an invalid
  answer (§11.4).

### 12.9 Key queries

A key query asks for the `UserPublicKeys` of a GossipID, as `[chat_id, gossipId]`.

- The responder answers only if it holds the named epoch and the requester, the responder and the
  subject are all members of it; other requests are dropped silently.
- It returns the keys it holds for that identity, or "not available".
- The requester MUST check that the returned keys hash to the requested GossipID.
  An answer that does not is invalid, and gets the heaviest penalty of the peer score (§11.8).

*Why no backend lookup:* asking the backend for a member's keys would reveal to it who shares a
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

| Session message type | Carries |
| --- | --- |
| group | one group plaintext, and nothing else |
| keep-alive | nothing; it only keeps the session alive |

A receiver MUST ignore a group plaintext found under any other type, and MUST NOT treat a
keep-alive as carrying content.
A sender MUST NOT place group traffic in a keep-alive or in any type other than the group type.

The varint uses the protobuf unsigned varint encoding.
The receiver reads the version **before** parsing anything else and parses the container with that
version's schema.
The container holds a list of complete `Frame`s; several frames for one recipient (events, queries,
responses, notices) may share one ciphertext and one seeker.

Each frame holds exactly one kind:

| Kind | Frame |
| --- | --- |
| `event` | one blob: a root (§4.1), a signed object (§5.1) or a message event (§6.2) |
| `query` | queries (§13.3) |
| `response` | responses (§13.4) |
| `notice` | gossip notices (§13.5) |
| `neighbor_request` | §13.6 |
| `neighbor_response` | §13.6 |
| `leave_request` | §13.6 |

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

*Why:* events outlive the plaintext that carried them, so a device that has upgraded must still be
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

| Operation | Data |
| --- | --- |
| chat lookup by ID | `chat_id` |
| chat lookup by reference | `ref_chat_id` |
| chat lookup by parent | `chat_id, parentCommitment` |
| shared-chats scan | `scanId, offset` |
| event lookup | `chat_id, eventId` |
| sync-object lookup | `chat_id, syncObjId` |
| signed-object lookup | `chat_id, kind, id` |
| removal lookup | `chat_id, gossipId` |
| tips scan | `chat_id` (the anchor), `scanId, offset` |
| key query | `chat_id, gossipId` |

Requesters emit distinct entries.
Receivers still answer every entry position independently, and limits count all entries.
The `request_id` is an identifier, not a credential, and is never hashed.

### 13.4 Response frames

A response carries the query's `request_id`, `idx` and one result.
`idx` is the zero-based position of the answered entry in the original request; answers may be
reordered.

| Result | Content |
| --- | --- |
| event | a blob (§13.1): a full root, signed object or message event with its version prefix |
| page | `[scanId, offset, count, entries]` |
| keys | the `UserPublicKeys` of the requested GossipID, serialized with bincode |
| status | a status code |

| Status | Code | Meaning |
| --- | --- | --- |
| `not_available` | 0 | authorized, but not available here |
| reserved | 1 | reserved and never sent (§12.7) |
| `restart` | 2 | the scan state is gone; start a fresh scan |
| `expired` | 3 | the query was past its receiver deadline |
| `malformed` | 4 | the entry could not be parsed |
| `unsupported` | 5 | the plaintext's protocol version is higher than the receiver supports |
| `busy` | 6 | refused for resource reasons; retry later |

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

| Kind | `id` | Announces |
| --- | --- | --- |
| event | 24-byte `eventId` | a message event |
| root | empty | the root whose ID is `chat_id` |
| leave | 32-byte `leaveId` | a signed leave (§5.3) |
| kick | 32-byte `kickId` | a kick (§5.6) |
| dissolve | 32-byte `dissolveId` | a dissolve message (§5.8) |

Entries may mix epochs, and each is authorized independently.
Page entries of a tips scan (§12.1) use the same form.

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
- A peer that is not a member of the relevant epoch is ignored silently.
  Shared-chats scans and chat lookups have no epoch context and follow §4.11 and §12.7 instead.
- A member of a superseded epoch that is a removed peer is served and heard under §10.4.
- Errors, counts and timing state are allocated only after authorization.
- Frames for unknown, unaccepted or closed epochs are dropped without staging.
  Three things are exempt and follow their own paths: a root (§4.7, §4.8), a root notice (§4.6) and
  a page entry of an unknown epoch (§12.1).
- An unparseable container or frame is rejected entirely.
  Otherwise, invalid entries are isolated, answered with a permitted status after authorization,
  and the other entries are processed without renumbering.

### 13.8 Versions and extensions

- A plaintext whose prefix version is unsupported is rejected before any protobuf parsing.
  There is no negotiation.
- When that version is **higher** than any version the receiver supports, it answers with one
  plaintext at its own highest version holding one response frame, with an empty `request_id`,
  `idx = 0` and status **unsupported**, at most once per peer and received version per 24 hours.
  This tells the sender which version the receiver speaks; the sender decides what to do with it.
  A plaintext with a lower unsupported version is dropped silently.
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
  The only extension point within a version is message metadata, whose unknown entries are
  preserved (§6.2).
- This protocol is not compatible with earlier draft group designs, and no migration is defined.
  Existing direct-message behavior is unaffected.

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

*Why:* deletions should propagate early, but no category may starve the other.

### 13.10 Size limits

| Limit | Value |
| --- | --- |
| Group plaintext (version prefix, all protobuf frames and events) | 57,344 bytes |
| Encrypted binary packet, as stored under a seeker | 65,536 bytes |
| Message text (also the content of a forwarded text) | 16,384 bytes of UTF-8 |
| Message metadata, all entries together, as encoded | 16,384 bytes |
| Entries per query frame | 16 |
| Entries per logical response allocation | 128 |
| Notice | 128 entries and 16 KiB |
| Page | 128 entries and 16 KiB |
| Root | must fit one empty container |
| Members per epoch | 512 (§4.4) |
| Parent commitments per root | 32 (§4.5) |
| Group name | 256 bytes (§5.11) |
| Reply targets per message | 32 (§7.6) |

Every complete frame and every single event, root or signed object MUST fit an empty container.
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
- **Why 57,344.** A full container encrypts to at most 60,978 bytes (measured, see below), which
  leaves about 4.5 KiB under the packet ceiling for future growth of the session layer.
- **Text and metadata** are limits on one message version, checked on creation, on reception and
  on every edit, local-only edits included. An event over either limit is malformed.
  Metadata is measured as the size of the metadata field in its canonical protobuf encoding,
  computed from the decoded entries, so that every device obtains the same number.
  A message with both at their limits, 16 parents and 32 reply targets is 33,383 bytes.

The notice entry and byte limits, the page byte limit, the member
limit, the parent limit and the limits of §17.4 other than the hint cache are provisional and must
be profiled before release.

For sizing: the session layer adds at most 3,634 bytes to a group plaintext (two ML-KEM-768
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
- **Current objects** keyed by `(chat_id, syncObjId)`, with their current result and pending
  versions.
  The stored fields of each available event are the only stored copy of that event's content.
- **Retrieval tasks** with per-peer candidate rows: trigger kind and time, attempts, outstanding
  and N/A state; the per-peer waiting lists and pauses of §11.8.
- **Scan state and tombstones**, and **request correlation references**.
- **Peer-knowledge hints.**
- **Encrypted outbox.**
- **Closed-chat markers** and **dissolved markers** (a chat ID only).

Local fields are never transmitted or hashed.
Only explicit protocol projections are serialized, never a whole stored record.
Known pruned IDs, processed facts and needed parent links are kept until the group is closed.

### 14.2 Hiding, deleting and closing

- **Hide or archive** is presentation only.
  Synchronization, sharing and keys continue; notifications follow the separate mute setting.
- **Closing a group.** The device removes the roots, the group secrets, message state, stubs,
  signed objects, pending tasks, hints and links of that group, and keeps only a minimal non-secret
  **closed-chat marker** for each of its ends (the chat ID).
  Other groups, shared sessions and sequence-dependent ciphertext are kept.
  The UI warns that recovery obligations and deletion knowledge are lost.
- A group is closed by "Ignore and Delete", by a signed leave or decline once it is sent, by the
  end of the waiting state (§5.2, §5.4) and by **Delete** on a kicked or dissolved group.
- **Closed-chat marker.** A root that continues a closed epoch is rejected automatically and
  recorded as closed too (§4.8).
  The device drops every frame for a closed epoch silently, except its root delivered in full by a
  member, for example with Retry synchronisation (§9.4): the device then validates it and asks
  Accept or Decline again.
  The prompt says that this group was closed on this device before and warns that deleted content
  may reappear because local deletion memory is gone.
  Accept clears the marker and installs the epoch as a first Accept would.
- **Dissolved marker.** It is left by "Dissolve & Delete" (§5.8).
  The device drops every frame for that epoch, its root included.
  It does not reject successors: a later root that lists the device is an invitation.

*Why markers:* keeping nothing but a chat ID leaves no member list or secret behind, while frames
of that epoch are dropped instead of silently recreating the group.

**Emergency wipe.** Wiping the device or the application's data is never blocked or delayed by any
rule of this document, for an owner or for anyone else.
For a group whose owner wiped their device, the group has no active owner: messages still flow, but
nobody can add or remove members and leaves are not processed.
The user is still listed as the owner, and is the owner again after logging in again and receiving
the root from a member, or after restoring a backup.

Caveats:

- A marker shows, on an unlocked device, that a declined, left, deleted or dissolved group existed.
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

Overflow returns **busy** or pauses work.
It never marks events invalid or pruned.

### 17.5 Deferred work

- The content and media specification (media, reactions, inline spans, forwarded-media copying,
  media limits).
- The peer score formula and replacement thresholds (§11.8).
- Optional proactive neighbor rotation.
- Score-weighted choice of extra dissemination recipients.
- A direct-evidence-only fallback for hints, if ancestor inference proves impractical.
- Shared mutable group settings, including configurable retention.
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

| Domain | Use |
| --- | --- |
| `gossip.groups.root.1` | root ID, which is the `chat_id` (§4.1) |
| `gossip.groups.predecessor.1` | parent commitment (§4.5) |
| `gossip.groups.reference.1` | `ref_chat_id` (§4.5) |
| `gossip.groups.leave.1` | `leaveId` (§5.3) |
| `gossip.groups.kick.1` | `kickId` (§5.6) |
| `gossip.groups.dissolve.1` | `dissolveId` (§5.8) |
| `gossip.groups.message.secret_proof.1` | `secret_proof` |
| `gossip.groups.message.result.1` | message result hash |
| `gossip.groups.sync_obj_name.1` | sync-object ID of a registered name |

### Signing contexts

ML-DSA-65 signing contexts are distinct from every hash domain.

| Context | Signed message |
| --- | --- |
| `gossip.groups.root.signature.1` | the 32-byte root ID |
| `gossip.groups.leave.signature.1` | the 32-byte `leaveId` |
| `gossip.groups.kick.signature.1` | the 32-byte `kickId` |
| `gossip.groups.dissolve.signature.1` | the 32-byte `dissolveId` |

### Registered names

None yet.
Future protocol-named message objects use names under `gossip.groups.message.*`.

## Appendix B: Timing constants

| Constant | Value |
| --- | --- |
| Message retention | 2 weeks + 5 min after the event timestamp (fixed) |
| Lookup deadline | event timestamp + retention |
| Event timestamp admission | now + 5 min |
| `created_at`, `last_modified_at` | ≤ event timestamp + 2 weeks |
| Query clock tolerance | `sent_at` ≤ now + 5 min |
| Receiver deadline | `sent_at + 1.05 × ttl + 5 min` |
| First TTL / growth / cap | 60 s / × 3.142 (ceil) / 24 h |
| Local jitter | uniform ±5 %, floored to ms |
| Unanswered stages before pause | 20 |
| Scan tombstone | 24 h after drop |
| Periodic recovery lanes | 4 per group: neighbor, random, neighbor, random; 1 scan each per 24 h |
| Periodic lane offset | floor(6 h × r) ms, r uniform in [0.95, 1.05] |
| Scheduled-delete timers | wait ≤ 2 h; fallback 30 min (5 min when open) |
| Hint expiry | 28 days |
| Invitation delay `PROMPT_DELAY` | 5 min after receiving the root (§4.8) |
| Successor after a leave or request | 30 s without a new one; at most 5 min after the first (§5.5) |
| Owner-only request resend | every 24 h (§5.4) |
| Waiting for a kick | at most 2 weeks (§5.4) |
| Root and dissolve message kept after "Dissolve & Delete" | 2 weeks (§5.8) |
| Failed announcements before a pause (provisional) | 3 within 24 h; pause 1 h, doubling, at most 24 h |

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
    bytes content = 9;                  // REACTION, MEDIA (content specification)
  }
  map<string, bytes> metadata = 10;     // empty for DELETE
}

message Forward {
  MessageType content_type = 1;
  bytes content = 2;
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

*Current text:* a scan lists first every live leave and the dissolve message of the responder's
current epoch, and never lists kicks.

*Context:* live leaves first was decided.
The dissolve message was added beside them because it is as urgent.
Kicks reach retained members with the root and reach the removed member by direct sends (§5.6), so
listing them would only spend page space.

- **A (recommended):** keep the current text.
- **B:** also list kicks, after the leaves.
- **C:** list live leaves only; the dissolve message spreads by notices alone.

### D.2 What a device does when it receives its own signed leave (§5.3)

*Current text:* none.
A peer sends a kept leave back to the leaver that contacts it (§5.3, §5.6), which happens when the
leaver's device was restored from a backup made before it left.

*Context:* the leave is signed with the device's own key and names its current epoch, so it can
verify it.
The original leave closed the group and deleted its data (§14.2), but a user who restored a backup
may have done so to get the history back.

- **A (recommended):** as for a kick: the group becomes a read-only archive with the line "You left
  this group", the composer is disabled, and the user can delete the group's data.
- **B:** the device closes the group at once and deletes its data, as the original leave did.
- **C:** the device asks the user: "You left this group from another copy of this account. Delete
  it here too?"

### D.3 A root whose owner's authority cannot be verified (§4.7, §4.8)

*Current text:* a successor root whose owner has no verified authority over a parent the device
holds does not continue that parent; it is treated as unmatched, so as an invitation.
When the user accepts such an invitation, the root starts a **separate** group that the user may
link by hand (§5.10).

*Context:* this is stricter than the earlier wording "once accepted, the history continues in the
same chat", which is kept for the case where authority is verified.
Without the rule, any member who knows an epoch's ID and challenge could attach a group of its own
to another group's history on a device that missed a handover.

- **A (recommended):** keep the current text.
- **B:** an accepted invitation always continues the held parent, verified or not.
- **C:** as A, and the device keeps trying to fetch the missing handover roots; when authority
  becomes verifiable, it joins the two groups automatically.

### D.4 Provisional numbers for roots and failed announcements (§11.8, §17.4)

*Current text:* at most 4 root fetches in progress per peer; a waiting list of at most 256 IDs per
peer; 3 failed announcements from a peer within 24 hours pause fetching from its announcements for
1 hour, doubling at each repeat up to 24 hours.

*Context:* none of these values was measured.
They bound what one peer can make a device fetch or remember.

- **A (recommended):** keep them as provisional values, to be tuned by the simulations of §17.
- **B:** other values.

### D.5 Packing order in responses (§13.9)

*Current text:* roots, signed objects and key answers are packed before other answers.

*Context:* they are small and few, and other answers often cannot be used without them (an event of
an epoch whose root is missing is not accepted).

- **A (recommended):** keep the current text.
- **B:** no priority; the ordinary order of §13.9 applies to everything.

### D.6 A neighbor request for an epoch the receiver does not hold (§10.1, §13.6)

*Current text:* the request is declined with no suggestions.

*Context:* the receiver cannot name members of an epoch it does not hold.
Declining tells the requester to try another member; the root itself spreads by root notices.

- **A (recommended):** keep the current text.
- **B:** drop the request silently.
- **C:** decline and ask the requester for the root (a chat lookup by ID).

### D.7 Constraints on a handover root (§4.7)

*Current text:* the new owner MUST differ from the parent's owner, and the members MUST be a subset
of the parent's members.
A root that breaks either rule is invalid.

*Context:* it was decided that a handover root has one parent, may remove members and rename, and
may not add members.
The two checks state this for the receiver.
"New owner differs" keeps the two root types apart: a root that keeps the owner is a successor.

- **A (recommended):** keep the current text.
- **B:** drop the "new owner differs" check.

### D.8 An edit in an older epoch when no neighbor is eligible (§10.4)

*Current text:* the edit goes to one random member of both epochs, plus the usual extra recipients.

*Context:* it was decided that such an edit goes to neighbors who are in the older epoch, or
otherwise to another peer in both.
How many "another peer" means was left open.

- **A (recommended):** one random member of both epochs.
- **B:** as many as the usual number of neighbors.

### D.9 "Left" or "removed" in the view (§7.5)

*Current text:* a member dropped by a root is shown as having left when the device holds that
member's signed leave for a parent epoch, and as removed otherwise.

*Context:* a member who used the owner-only request is shown as removed, which is the intended
cover.
A device that never received the leave shows "removed" until it does.

- **A (recommended):** keep the current text.
- **B:** always show "is no longer in the group", whatever the cause.

### D.10 One kick per parent epoch (§5.6)

*Current text:* when a root has several parents, the owner creates one kick for each parent that
lists the removed member.

*Context:* a kick names one epoch, and a device ignores a kick that does not name its current
epoch.
After a fork, removed members may be on different branches, so each branch needs its own kick.

- **A (recommended):** keep the current text.
- **B:** a single kick naming one parent, chosen by the owner.

### D.11 Version numbers (§13.1, Appendix C)

*Current text:* the wire version stays `1` and the protobuf package stays `gossip.groups.v1`.

*Context:* no earlier draft was released, so no device speaks an older version.

- **A (recommended):** keep the current text.
- **B:** start at another number.

### D.12 Terms (§1)

*Current text:* "epoch" is a fixed member list with its own `chat_id`; "group" is the logical chat
made of linked epochs; in protocol rules "chat" means an epoch.

- **A (recommended):** keep the current text.
- **B:** other terms.

### D.13 Which epoch a signed leave names (§5.3)

*Current text:* the leaver's current epoch, or the epoch of the invitation being declined.

*Context:* a leaver can only sign for an epoch whose root it holds.
The liveness rule carries a leave for an older epoch forward to the current one.

- **A (recommended):** keep the current text.
- **B:** a leaver with competing ends signs one leave per end.

### D.14 The statements of the security section (§16)

§16 still holds the text of the previous draft.
The revised section is planned to state the following.

*What is signed, and what it proves*

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
7. **Signatures are ML-DSA-65 only,** with no second classical signature.

*What the owner and former owners can do*

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

*What removal does and does not guarantee*

13. Removal takes effect device by device, as each one adopts the successor.
    A removed member keeps what they already had.
14. Edits are not sent to removed members.
    Deletions are pushed to them on a best-effort basis.

*What others can infer*

15. **Reply references:** the same value for every reference to one epoch, so repeated references
    can be linked.
    A reply across chats is readable by members of both.
16. **Parent commitments:** their number shows a merge or a re-added member.
    Anyone who knows a candidate epoch ID and the challenge can test it.
17. **Key queries:** answers are checked against the GossipID, and a wrong answer is the most
    heavily penalised.

*What stays on a device*

18. Closed-chat markers, the marker left by "Dissolve & Delete", the roots kept for up to two weeks
    while waiting for a kick or relaying a dissolve, kicks and signed leaves kept with their root,
    and the local name.

*Known blind spots*

19. The link for a re-added member fails when the owner does not hold that member's last epoch.
20. "Dissolve & Delete" is best effort: offline peers, backups, unofficial clients and compromised
    devices may keep copies.

- **A (recommended):** this list is complete and correct.
- **B:** changes or additions.

### D.15 Canonical encoding of `UserPublicKeys` (§3, §4.3, §12.9)

*Found during implementation.*

*Current text:* the owner field of a root and a key answer are "`UserPublicKeys`, serialized with
bincode", and are checked by deriving the GossipID.

*Context:* the existing parser accepts extra bytes after a valid key bundle, and deriving the
GossipID serializes the parsed keys again.
Bytes that are not the canonical encoding therefore pass the check, and the same owner keys could
give several root IDs.
The code refuses any input that does not equal the re-serialized keys.

- **A (recommended):** state that the owner field and key answers MUST be the canonical bincode
  encoding, and that a receiver MUST refuse bytes that differ from the re-serialized keys.
- **B:** leave the text as it is and rely on the implementation.

### D.16 Nonzero GossipIDs in a member list (§4.1, §4.7)

*Found during implementation.*

*Current text:* §4.7 step 1 requires every GossipID of the member list to be nonzero; the table of
§4.1 does not mention it.

*Context:* the two places should agree.
The code applies the rule of §4.7.

- **A (recommended):** add "nonzero" to the `members` row of §4.1.
- **B:** remove the requirement from §4.7.

### D.17 Signed-object IDs do not include a version (§5.3, §5.6, §5.8, §13.1)

*Found during implementation.*

*Current text:* a leave, a kick and a dissolve message travel with a version prefix, but `leaveId`,
`kickId` and `dissolveId` hash no version, while the root ID does.

*Context:* nothing is wrong at version 1.
If a later version gave one of these objects different fields, the old and the new form would share
an ID.

- **A (recommended):** add one sentence: a later version that changes the fields of a signed object
  MUST also use a new hash domain for its ID.
- **B:** add the version to the three IDs now, which changes them.
- **C:** leave the text as it is.

### D.18 Who signs the kick when a new owner resolves a fork (§5.6, §5.9)

*Found during review of the implementation.*

*Current text:* a kick is signed by the owner of the epoch it names (§5.6).
After a handover from A to B, B may resolve a fork by taking A's branch as a parent (§5.9).

*Context:* members of A's branch that B's root drops need kicks naming A's epoch, which by §5.6
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

*Found during review of the implementation.*

*Current text:* the field is `optional` in the schema, with a comment only for deletions.
The code refuses a non-deletion without it.

- **A (recommended):** state in §6.2 that for every type except a deletion the field MUST be
  present; an event without it is malformed.
- **B:** an absent field reads as 0, as for other scalar fields.

### D.20 What a forward may carry (§6.2, §7.6)

*Found during review of the implementation.*

*Current text:* a forward holds "a permitted copied content value", without defining "permitted".
The code refuses a forward whose inner type is a forward or a deletion, and a forwarded text that
is not valid UTF-8.

- **A (recommended):** state the code's rule in §7.6.
- **B:** any inner type and any bytes are accepted.

### D.21 A `replyTo` list that is malformed (§7.6)

*Found during review of the implementation.*

*Current text:* a list has 1 to 32 targets and one with more than 32 is malformed; a receiver never
rejects a message because of its references.
The text does not say what happens to the **message** when the list is empty, too long, has a
target of the wrong length or does not decode.
The code treats the whole event as malformed.

*Context:* "never rejects because of its references" is about targets that cannot be resolved, not
about a list that breaks the format.

- **A (recommended):** the event is malformed, and §7.6 says so, including for an empty list.
- **B:** the message is kept and the list is ignored.

### D.22 The result hash projection (§6.2)

*Found during review of the implementation.*

*Current text:* `H("...result.1", fullMessage)`, where `fullMessage` is itself a list.
It can be read as a nested list `[domain, [chat_id, ...]]` or a flat one `[domain, chat_id, ...]`.
The code uses the nested form, which is the literal reading.

- **A (recommended):** state the nested form.
- **B:** the flat form, which changes the hash.

### D.23 One invalid entry in a notice or a page (§13.5, §13.7)

*Found during review of the implementation.*

*Current text:* §13.7 says invalid entries are isolated, which is clear for query entries only.
The code refuses a whole notice or page when one entry has an ID of the wrong length.

- **A (recommended):** the invalid entry is skipped and the others are used; the sender is
  penalised as for one malformed item.
- **B:** the whole frame is refused.

### D.24 A frame that holds two kinds (§13.1)

*Found during review of the implementation.*

*Current text:* "each frame holds exactly one kind".
Protobuf lets an encoder write two cases of one `oneof`, and decoders keep the last.
The code accepts this and keeps the last.

- **A (recommended):** a second, different case of the same `oneof` makes the message malformed,
  for every `oneof` of the schema.
- **B:** the last case wins, and §1 says so.

### D.25 Arithmetic near the top of the integer range (§1, §7.2)

*Found during review of the implementation.*

*Current text:* §1 allows "checked or widened" arithmetic.
For `ts + MAX_SCHEDULE` the two give different outcomes at the top of the 64-bit range: malformed
for good, or temporarily invalid.

- **A (recommended):** widened arithmetic is required for time bounds, so the outcome is the same
  everywhere.
- **B:** leave the text as it is; the values concerned are not reachable in practice.

### D.26 Several scheduled deletions of one message (§7.4)

*Found by simulation during implementation (code at commit `614a2345`, seed 7, 160 steps).*

*Current text:* "only the earliest pending deletion is kept; later scheduled deletions are pruned
immediately".

*Context:* the result depends on arrival order.
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

*Found during implementation; the recommendation was changed after review.*

*Current text:* the cycle-frontier rule of §6.1 speaks of a component with "no available child"
outside it; the tip definition of §12.1 says "no known accepted event references it".
The two differ once a child has been pruned.

*Context:* with "accepted", a pruned child still hides its parent from the tips, and a pruned event
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

*Found during implementation.*

*Current text:* a local-only change "prunes every event of that message".
Read literally, a local-only edit would also prune a real scheduled deletion that is still pending,
which cancels that deletion on the device.

*Context:* the code keeps pending scheduled deletions through a local-only edit, since they hold no
content, and prunes them only on a local-only deletion.

- **A (recommended):** the code's rule.
- **B:** the literal rule: the pending deletion is pruned too.

### D.29 An edit dated later than now (§7.2, §7.3)

*Found during implementation; the code follows the current text.*

*Current text:* an edit sets `last_modified_at = max(now, previous + 1)`, and a version becomes
active only when its date is reached.

*Context:* after two edits in the same millisecond, or after the clock moved back, the new date is
later than `now`, so the user's own edit waits as a hidden future version until that date.
If `previous + 1` is beyond `now + MAX_SCHEDULE`, the edit cannot be published at all.
The *Why* note "an edit wins locally even across clock rollback" is therefore true only after a
wait.

- **A (recommended):** keep the rule and correct the *Why* note; the device shows its own waiting
  edit as "pending" in the meantime.
- **B:** a version created by the device itself is shown at once on that device, whatever its date.
- **C:** another rule.

### D.30 Content stored twice in the logical records (§14.1)

*Found during implementation.*

*Current text:* "the stored fields of each available event are the only stored copy of that event's
content", while the current object also holds the current result.

- **A (recommended):** say that the current object **refers** to the event that carries the current
  result, and holds no copy of the content.
- **B:** allow the copy and require both to be deleted together.

### D.31 The form in which a scheduled deletion is served (§7.4, §9.3)

*Found during review of the implementation; it refines D.26.*

*Current text:* a scheduled deletion is served with its date until it applies, then without it.

*Context:* under the first implementation the form depended on other deletions and on local state.
After a local-only deletion, a scheduled deletion that arrived again was stored and served at once
in its immediate form, so a device fetching it deleted the message up to two weeks early, against
"MUST NOT absorb the message before its time".

- **A (recommended):** the served form depends only on the event and the clock: a scheduled
  deletion keeps its scheduled form until its **own** due time, whether it is pending or held
  beside a tombstone, and is normalised then.
  A local-only deletion keeps pending scheduled deletions, as a local-only edit does (D.28).
- **B:** keep the form tied to the state of the message.

### D.32 Limits on pending versions, pending deletions and rejection markers (§8.2, §9.6, §17.4)

*Found during review of the implementation.*

*Current text:* §8.2 says the storage of pending events "is reserved at admission" and gives no
number; §9.6 expects capacity to force out temporary-rejection markers.

*Context:* a member can park any number of scheduled versions or deletions for two weeks, and they
cannot be evicted.
A limit applied at arrival makes honest devices differ when they reach it at different moments, so
the rule must be one every device computes the same way.

- **A (recommended):** per message, a device keeps at most 16 pending versions and 16 pending
  deletions: those with the earliest dates, ties broken by result hash; others are pruned.
  Rejection markers are evicted oldest first under storage pressure.
  The numbers are provisional.
- **B:** no limit in this version.

### D.33 A full event arriving under a pruned ID with other parents (§9.5)

*Found during review of the implementation.*

*Current text:* §9.5 compares only the payload; §7.1 says an ID "keeps its first valid
interpretation entirely".

*Context:* the first implementation restored such an event with its new parents while its tips
were still computed from the first parents.

- **A (recommended):** the event is restored only when its parents equal the stored parent links;
  otherwise the ID stays pruned.
- **B:** the payload alone decides.

### D.34 A local-only edit dated in the future (§9.1, §7.5)

*Found during review of the implementation.*

*Current text:* a local-only edit may set any dates.

*Context:* with a `last_modified_at` in the future, the message disappears from the user's own view
until that date, and honest edits dated before it lose on this device.

- **A (recommended):** a local-only edit MUST NOT set `last_modified_at` later than now.
- **B:** allowed, and the text says the message is hidden until then.

### D.35 "Indistinguishable from ordinary retention pruning" (§9.3)

*Found during review of the implementation.*

*Current text:* a stub left by a local-only change "is indistinguishable from ordinary retention
pruning".

*Context:* retention cannot prune an event inside its two-week window, and eviction takes the
oldest first.
A recent stub beside older events still held, or a current result with no event carrying it, can
be told apart by someone who inspects the device.
Peers can also see that a recent tip is missing from the device's next parent list.

- **A (recommended):** weaken the claim: the stub looks like eviction under storage pressure, and
  the text states what an inspector or a peer can still notice.
- **B:** make eviction order not strictly oldest first, so that recent stubs are ordinary.

### D.36 Two limits inherent in the merge rules (§7.1, §7.4)

*Found during review of the implementation; no change is proposed.*

- A device whose clock runs fast normalises a scheduled deletion early and serves its immediate
  form, which deletes the message at once on devices that had not seen it.
- Any member can create any number of permanent tombstones by deleting identifiers that name no
  message.

- **A (recommended):** state both in the security section.
- **B:** bound them, by rules to be designed.

### D.37 Page counts when an entry is skipped (§12.1, §13.5)

*Found during implementation; it depends on D.23.*

*Current text:* a page is final when `count` equals "the number of entries it carries", and the next
offset follows the entries received.

*Context:* if invalid entries are skipped (D.23), counting only the valid ones would make a final
page look unfinished and shift the next offset.
An entry of an unknown kind is an unknown enum value, which §1 says refuses the whole frame, so
only an ID of the wrong length is skipped.

- **A (recommended):** "entries it carries" means entries as received, skipped ones included.
- **B:** a page with any invalid entry is refused whole (D.23, choice B).


### D.38 A lane that is still scanning at its turn (§12.3)

*Found by simulation of the implementation.*

*Current text:* the lanes start in turn, and a start "waits until it is eligible".

*Context:* a lane scanning a member that never answers stays pending through all its stages, about
two weeks.
Read literally, the other lanes wait behind it, so one silent member stops periodic recovery for
the whole group.
The code skips the turn.

- **A (recommended):** a lane still pending at its turn skips that turn; the other lanes go on.
- **B:** bound how long a lane may stay pending, then abandon its scan.
- **C:** keep the text.

### D.39 Resends after `expired` (§11.4)

*Found by simulation of the implementation.*

*Current text:* the requester resends after an `expired` status, with no bound.

*Context:* a peer that always answers `expired` keeps the requester sending forever.
A fixed small bound is wrong the other way: a member back from a long absence gets honest
`expired` answers to queries that waited in its mailbox, and a bound of 2 left it unable to
recover in the simulation.

- **A (recommended):** unlimited resends when the status is plausible, that is when the request
  was at or past its deadline minus 5 minutes when the status arrived; otherwise at most 2 per
  stage.
- **B:** a fixed bound per stage in all cases.
- **C:** no bound (current text).

### D.40 Scan restarts (§12.2)

*Found during implementation.*

*Current text:* on `restart` the requester starts a fresh scan; nothing bounds how often.

*Context:* a peer answering `restart` to every page keeps the scan running forever.

- **A (recommended):** at most 3 restarts of one scan with one peer since the last page that made
  progress; then the scan ends as failed.
  The number is provisional.
- **B:** no bound.

### D.41 The stub left when a retrieval task reaches its deadline (§11.6)

*Found during implementation.*

*Current text:* at the deadline the device "prunes the ID to a generic stub".

*Context:* for an ID that was only announced and never held, a stored stub is one record per fake
ID a hostile member announces.
The deadline is computed from the ID, so the device needs no record to refuse it later.
The code stores nothing.

- **A (recommended):** say the stub is implicit for an ID that was never held: nothing is stored.
- **B:** a stored stub, with a limit on their number.

### D.42 A member that announces IDs it never supplies (§11.8, §17.4)

*Found by simulation of the implementation. This is the largest open point of the retrieval
design.*

*Current text:* the score counts supplied items and penalties; a timeout is not a penalty.
Device-wide fairness is left to the implementation.

*Context:* a member that announces fake IDs and stays silent pays nothing.
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

*Found during implementation.*

*Current text:* a receiver ignores a query whose `sent_at` is more than 5 minutes ahead of its
clock.

*Context:* such a device never recovers anything and cannot tell why.

- **A (recommended):** the receiver answers with a status (`expired`, or a new one) instead of
  staying silent, within the usual limits.
- **B:** keep the silence.

### D.44 One attempt at a time with long waits (§11.2, §11.4)

*Found by simulation of the implementation; no change is made in the code.*

*Context:* a task asks one candidate at a time, and later stages wait up to 24 hours.
One unresponsive candidate costs up to a day per stage, which is where the remaining convergence
delays in the simulation come from.

- **A (recommended):** keep it for this version and state the delay; revisit with measurements.
- **B:** allow two candidates in parallel from the second stage on.

### D.45 "A conflicting immutable context is rejected" (§12.2)

*Found during implementation.*

*Context:* the key of a scan already holds everything the text calls its context, so the
implementer found no case the sentence can apply to.

- **A (recommended):** remove the sentence, or name the fields it means.
- **B:** keep it.

### D.46 Details the code had to choose (§10, §11, §13.9, §17.4)

*Found during implementation. Each is a guess where the text gives no value; listed together so
they can be confirmed or changed.*

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
- Candidate order: responsive members before unresponsive ones; then peers that triggered the
  task, then neighbors, then members with a session, then others; then score, then trigger time.
  §11.2 gives the tiers only.
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

*Recorded so they are not forgotten; no decision is needed unless one is dropped.*

- §12.1: "run the scan with another peer" for scans outside the lanes.
- §17.4: the traversal budget is applied to ancestor sampling only, not to the tip computation,
  which needs the full tip set at once.
- D.8: the fallback for an edit in an older epoch with no eligible neighbor (it needs several
  epochs).

- **A (recommended):** implement the first and third; for the second, say in §17.4 that the tip
  set is exempt and bounded by the limits on held events.
- **B:** apply the budget to tips too, with a rule for a partial tip set.

### D.48 Small points from the merge fixes (§9.1, §14.2)

*Found during review of the implementation.*

- D.34 is applied strictly: a local-only edit is also refused when the automatic date
  `previous + 1` would be later than now.
- Rejection markers are evicted in order of the oldest event timestamp first.

- **A (recommended):** state both.
- **B:** other rules, to be given.

### D.49 Does a resend restart the wait of its stage (§11.4, §12.3)

*Found during review of the implementation; it caused a convergence failure in simulation.*

*Current text:* a resend after a reconnection or an `expired` status does "not change the stage, TTL
progression or jitter". The local wait is not named.

*Context:* the first implementation restarted the wait at each resend.
A member that resets its session more often than the stage's TTL then holds a task or a scan
forever, and one honest device never got an edit the others held.

- **A (recommended):** a resend keeps the stage's original local deadline. The code does this.
- **B:** a resend restarts the wait, with a bound on resends per stage.

### D.50 Largest event against the frame that carries it (§13.10)

*Found during review of the implementation.*

*Current text:* an event is admitted if it fits an empty container as an event frame.

*Context:* a lookup answer carries the event in a response frame, which adds `request_id` and
`idx`.
An event of the largest admitted size cannot be served by lookup at all; the first implementation
crashed on it.
The limit must be one every device computes the same way, since it decides validity.

- **A (recommended):** an event is admitted only if it fits an empty container inside the largest
  frame that can carry it (a response frame with the longest `request_id` and `idx`). The code does
  this: with the 57,344-byte container the largest event blob is 57,307 bytes.
- **B:** keep the limit and serve such an event in a plaintext of its own with a special frame.

### D.51 A tips scan from a peer that is not a member (§12.1, §13.7)

*Found during review of the implementation.*

*Current text:* §12.1 answers "not available" for an anchor the device does not hold; §13.7 keeps
silent toward a peer that is not a member of a held epoch.

*Context:* together they tell any peer with a session whether the device holds a given epoch:
"not available" means no, silence means yes.

- **A (recommended):** a requester that is not a member of the held epoch gets the same answer as
  for an unheld anchor. The code does this.
- **B:** silence in both cases (an honest member then cannot tell "not held" from a lost message).

### D.52 `busy` without a bound (§11.4, §13.4, §17.4)

*Found during review of the implementation.*

*Current text:* `busy` asks the requester to come back later; no bound, and the text does not say
whether it counts as an answer.

*Context:* a member that answers `busy` to everything was asked 2,885 times in three simulated
days, kept its standing, and as a neighbor stopped both neighbor lanes.

- **A (recommended):** `busy` is not an answer for the score or for responsiveness; after 3 in a
  row from one peer for one task or scan, it counts as a timeout. The code does this; the number
  is provisional.
- **B:** leave it to implementations.

### D.53 An announced ID dated far in the future (§11.6, §17.4)

*Found during review of the implementation.*

*Current text:* the lookup deadline of an ID is computed from its timestamp, with no upper bound on
that timestamp. A full queue "pauses paging"; nothing is said about IDs from notices and parent
references.

*Context:* 65,536 IDs dated ten years ahead never expire and fill the queue of missing IDs for
good; later missing IDs of the group are then dropped.

- **A (recommended):** a task ends at the earlier of the ID's deadline and its creation plus the
  retention period, and a full queue never loses the parent reference of an accepted event. The
  code does this.
- **B:** refuse an announced ID dated beyond a fixed margin after now.

### D.54 Queued answers and version notices (§13.8, §17.4)

*Found during review of the implementation.*

*Current text:* one version notice per peer and version; over budget the answer is `busy`. Neither
has a bound.

*Context:* each over-budget query entry queued one stored `busy` answer, and each distinct version
number one stored notice, without limit.

- **A (recommended):** a cap on queued answers per peer, beyond which entries are dropped, and a
  cap on version notices per peer. The code does this with provisional numbers: 256 queued answers
  per peer, one queued version notice per peer, and the last 4 versions remembered.
- **B:** leave it to implementations.

### D.55 What a notice reveals about processing (§11.7)

*Found during review of the implementation; no change is made in the code.*

*Context:* a member can send a notice for an ID and learn, from whether a lookup comes back,
whether the device has already processed that ID.
This is known to members only and concerns held-or-seen, not content.

- **A (recommended):** state it in the security section.
- **B:** look up a random share of already processed IDs as cover.

### D.56 Neighbor capacity and ending a relation (§10.1)

*Found during review of the implementation; no change is made in the code.*

*Context:* "capacity" is not defined; the code takes it equal to the target of 10.
In a large group where everyone already has 10 neighbors, a newcomer is declined by all.
There is no message to end a relation, so the sets become one-sided, and the use of suggestions is
not specified (a declining member can steer the choice).

- **A (recommended):** capacity above the target (for example twice), an explicit end of a
  relation, and suggestions used only as candidates ranked like the others.
- **B:** keep the text and state the limits.

### D.57 Is a page entry an announcement (§11.8, §12.2)

*Found during review of the implementation.*

*Context:* "not available" after announcing is penalised, but §12.2 lets a frozen list keep IDs
pruned since it was frozen, so an honest responder can be penalised for its own page.

- **A (recommended):** a page entry is not an announcement for the penalty. The code does this.
- **B:** it is, and a frozen list drops pruned IDs.

### D.58 Ancestors marked as seen by a relay (§10.3)

*Raised during review; plausible, not shown by a test.*

*Context:* when a peer delivers an event, its ancestors are marked as seen by that peer, though a
relay may not hold those parents.

- **A (recommended):** check with a test when several epochs are in place, then decide.
- **B:** mark only the delivered event.

### D.59 Hand over and leave in one root (§4.7 step 5, §5.9)

*Found during implementation of membership.*

*Current text:* a root is accepted when its deliverer is a member of it (§4.7 step 5). A handover
may drop the outgoing owner from the member list.

*Context:* the outgoing owner is then not a member of the root it delivers, so every receiver
refused it.

- **A (recommended):** a handover root is also accepted when delivered by the owner of its held
  parent. The code does this.
- **B:** hand over first, leave in a second step.
- **C:** the new owner delivers the root.

### D.60 Is an accepted root announced (§4.6, §4.8)

*Found during implementation of membership.*

*Current text:* §4.6 says an accepted root is announced by root notice; §4.8 says Accept "sends
nothing" and the other members are not told.

- **A (recommended):** only automatic adoptions are announced; accepting an invitation sends
  nothing. The code does this.
- **B:** every adoption is announced.

### D.61 A leave that names an earlier epoch (§5.6, D.2, D.13)

*Found by simulation of the implementation.*

*Context:* a member that missed epochs signs its leave of an older one, and the owner applies it
with no kick.
Nothing then names the epoch the member was removed from, so a device of that member restored from
a backup is never told.

- **A (recommended):** such a leave counts as live for the epoch it names: it is sent back to the
  leaver, accepted as an answer to a removal lookup, and D.2 reads "live for the current epoch".
  The code does this.
- **B:** the owner also creates a kick for the current epoch.

### D.62 A member removed while several epochs behind (§5.6)

*Found by simulation of the implementation.*

*Context:* the member is still at an old epoch that no record names, and it cannot verify a kick
that names a root it does not hold.
The same holds for a device restored to before its own leave.

- **A (recommended):** a retained member sends it, in full, the roots between its epoch and the
  one it was removed from (at most 16 per reply; it is a member of each), together with the kick
  or leave. The code does this. Roots are pushed because a removed peer can no longer look them up
  (D.74).
- **B:** rely on shared-chats scans after a reinstall only.

### D.63 The former owner's branch after a handover (§5.9, §4.9)

*Found by simulation of the implementation.*

*Current text:* the new owner "may resolve" the former owner's branch.

*Context:* if it never does, members that are only on that branch are left behind without notice.

- **A (recommended):** it is a fork under §4.9: the new owner is prompted and sends nothing in the
  group until it is resolved. The code does this.
- **B:** keep "may", and state the consequence.

### D.64 A root entry in tip lists (§12.1)

*Found during implementation of membership.*

*Context:* a member that missed a root and its notices cannot learn it while the new epoch has no
events, because a tip list of the older epoch names none.

- **A (recommended):** a tip list carries a root entry for the responder's current epoch when the
  requester is a member of that epoch and it is not the anchor. The code does this.
- **B:** rely on root notices and shared-chats scans.

### D.65 A kick or dissolve held before its epoch is current (§5.4, §5.8)

*Found during implementation of membership.*

*Current text:* "a kick naming another epoch is ignored".

*Context:* a device that receives the kick before it adopts the epoch would ignore it for ever.

- **A (recommended):** it is kept with its root and applied when that epoch becomes current. The
  code does this.
- **B:** ignored, and learnt again through the replies of §5.6.

### D.66 Joining conversations (§5.10)

*Found by simulation of the implementation; the text is silent.*

- Every invitation that is an ancestor of an accepted root is joined to it, even when its parent's
  group is read-only.
- A joined group stays read-only until its current epoch moves past the point it was removed at.
- Accepting a root that rejoins a group follows that root's owner, unless a handover deposed it.
- An invitation with no held parent is joined to a root the user accepted later only when that
  root continues it with authority: a successor by the same owner, or a handover it signed.

- **A (recommended):** state these three rules. The code does this.
- **B:** other rules, to be given.

### D.67 Kick signer after a handover: gap in choice A (D.18)

*Found during implementation; it adds to D.18.*

*Context:* the code follows D.18 choice A: a kick naming epoch E is valid when signed by E's owner
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

*Found during implementation. Listed together so they can be confirmed or changed.*

- Root fetches: "4 in progress per peer" is approximated by at most 260 root tasks per peer (4 plus
  the waiting list of 256); beyond that a shared-chats scan of that peer starts.
- §5.5 step 1 ("first finish what is already received") is not implemented.
- Hints and the queue of missing IDs are counted per epoch, not per group.
- A notice entry is bounded at 80 bytes.
- A leave that is no longer live is served only to its leaver and to removal lookups; a
  signed-object lookup for it gets "not available".
- "Ask to be kicked" on an invitation installs that root as a group in the waiting state.
- The requester side of a chat lookup by reference is not built yet.

- **A (recommended):** confirm them one by one.
- **B:** leave them to implementations.

### D.69 A handover gives authority over which parents (§4.7)

*Found during review of the implementation. A security defect of the text.*

*Current text:* a root is continuous when its signer owns each parent or is the new owner after "a
previous owner in the root's line". Nothing ties that previous owner to the same group.

*Context:* A owns two groups G1 and G2 with the same members and hands G1 to B.
B can then sign a root naming the current epochs of both; every device adopted it without a
prompt, G2 passed under B, and B could dissolve it with deletion.

- **A (recommended):** a handover gives authority only over parents in the same group as the
  handover's parent, judged group by group before the new root is considered; a parent the signer
  has no authority over is unmatched, as §4.7 says for any parent, and is never joined. The code
  does this. Refusing the whole root was tried first: it split the new owner's own line on a
  device that held a former owner's epoch without the handover.
- **B:** a root never joins two groups unless its signer owns the current epoch of each directly.

### D.70 Adding back a member that closed the group (§4.8 case 3, §5.2, §5.10)

*Found during review of the implementation. The text contradicts itself.*

*Current text:* a re-add root names the member's last epoch as an extra parent (§5.10). A root
with a closed parent is rejected silently (§4.8 case 3).

*Context:* the extra parent is exactly the epoch the member closed, so after "Ignore and Delete"
or deleting a kicked archive, the member can never be invited again and sees nothing.

- **A (recommended):** the silent rejection applies only when every parent is closed; a root with
  a parent that is neither held nor closed is an ordinary invitation. The code does this.
  A resolution root in a closed line, with a parent the device never received, then prompts too.
- **B:** a re-add root carries no extra parent; the histories are not joined.

### D.71 An old leave made live again by a re-add (§5.3 "Replay", §5.10)

*Found during review of the implementation.*

*Context:* the extra parent links the epoch the member left to the new one, and the member is in
both, so its old signed leave is live again: the owner's device removed it again by itself.

- **A (recommended):** a leave is not live for a root that re-adds its leaver (a root with a parent
  the leaver is not a member of), and is dead once a held root on the line omitted the leaver. The
  code does this.
- **B:** a leave carries a counter or the re-add root names the leaves it voids.

### D.72 A former owner's roots after a handover (§5.9, §4.6 step 4, D.63)

*Found during review of the implementation; it corrects D.63.*

*Context:* with D.63 choice A, a former owner signs a new successor of an epoch it used to own
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

*Found during review of the implementation.*

*Current text:* a root notice for an unknown ID starts a chat lookup toward its sender.

*Context:* any peer with a session that learnt a chat ID can test whether a contact holds or
closed that epoch: silence means yes, a lookup means no.

- **A (recommended):** a root notice is acted on only when its sender shares an active accepted
  epoch with the device; otherwise nothing happens. The code does this.
- **B:** always send the lookup, also for held IDs (cover traffic).

### D.74 Removal records and removed peers (§10.4, §12.8, §5.6, §4.11)

*Found during review of the implementation.*

*Current text:* §12.8 answers "a member of the named epoch"; §10.4 answers a removed peer "not
available" except for its own removal. §5.4 does not say what a waiting device answers, and §4.11
does not say whether waiting, kicked or dissolved epochs are listed in shared-chats scans.

*Context:* a removed member could fetch the kicks and leaves of the other removed members, and a
kicked device kept serving its root and listing its epochs.

- **A (recommended):** a removed peer gets only its own kick or leave; a device that is kicked,
  left or waiting in a group answers as if it did not hold it; scans list only epochs of groups
  where the device is an active member. The code does this. Deletion events are still served to a
  removed peer, as §10.4 says, and a dissolved group kept as an archive still serves its roots, so
  that a member back after the dissolve can learn of it.
- **B:** other rules, to be given.

### D.75 Limits on invitations and parent lookups (§4.8, §11.8, §17.4)

*Found during review of the implementation.*

*Context:* nothing bounds pending invitations, the depth of a parent chain, or roots held before
their parent is known. A stranger sent 40 self-signed roots and created 41 epoch records and 1,281
lookups; a chain of 60 roots received newest first crashed the first implementation.
Members are also queried before the user answers the prompt, which weakens "Ignore and Delete
(visible to no one)".

- **A (recommended):** limits per sender and per device on pending invitations, hidden parents,
  parent lookups and unverified handover roots, with expiry; before a root is verified, its parent
  is looked up only from the peer that delivered it. The code does this with provisional numbers:
  16 pending invitations per sender and 256 per device; 256 parents fetched for one invitation;
  4 unverified handover roots per sender and 64 per device; 32 unverified leaves per sender; at
  most 64 roots examined per operation when catching up on a chain.
- **B:** as A, and no lookup at all before the user accepts.

### D.76 Dissolve with deletion: what is kept and erased (§5.8)

*Found during review of the implementation.*

*Context:* the text does not say whether older roots are kept two weeks with the named one, nor
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

*Recorded for the security section and for D.14.*

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

*Found while binding the engine into the app. These are decisions about the app, listed here so
they are settled with the rest.*

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

*Found by simulation of the implementation.*

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

### D.80 Points from the first runs of the app (§14.2, §4.8, §5.10, §7.5)

*Found by running the app on a PWA and an Android emulator, and by the simulation check added
afterwards.*

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

### D.81 Direct chats as groups of two: what is still open (§2.1)

*Settled in §2.1:* every conversation is a group; a client does not support the earlier one-to-one
format; a device that moves to this protocol archives its earlier one-to-one conversations; older
clients are unsupported.

*Still open:*

- **Owner of a pair.** A group has one owner, who alone changes the member list. Which of the two
  owns a direct chat, and what happens when the other wants to add a third person.
- **Starting one.** A group starts with an invitation prompt; a contact is made by a contact
  request. Whether a direct chat needs both prompts, or the contact request stands for the
  invitation.
- **The archive.** What an archived one-to-one conversation looks like and whether it is linked
  to the direct chat that follows it.

- **A (recommended):** decide them one by one before the direct-chat change is built.

### D.82 Points from applying the size limits (§13.10, §17.4)

*Found while applying the limits of §13.10.*

- A forwarded text counts as text and has the same 16,384-byte limit. Media and reaction bodies
  are bounded by the container only.
- The response budget of §17.4 (1 MiB burst, 256 KiB per minute) was written for the 262,144-byte
  container. It is unchanged, and now equals about 18 and 4.6 full containers where it equalled 4
  and 1.

- **A (recommended):** confirm the first; scale the budget of the second with the container.
- **B:** keep the budget as it is.
