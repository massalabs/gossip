# Offline mesh

This document specifies how Gossip nodes replicate blobs over short-range links, such as
Bluetooth Low Energy (BLE) between phones, when there is no internet. It covers the link
abstraction, BLE framing, the link handshake, blob scopes, the wanted-seekers message,
bridges, clock tolerance, phone defaults and the threat model. The plan that schedules
this work is [MESH-PLAN.md](MESH-PLAN.md).

The internet network described in [WIRE-PROTOCOL.md](WIRE-PROTOCOL.md) is unchanged by
this document. Everything here runs on new link kinds with their own protocol version.

## Goal

During an offline event, such as a gathering or a network shutdown, people keep messaging the
contacts they already have, over a mesh of phones:

- A phone runs an embedded node, with the same pools and replication as a server node.
- The app keeps talking to its node through the same calls it makes to a server. Its
  sessions, seekers, ratchet and contacts do not change.
- Phones replicate blobs to phones in range, which replicate onward, so messages travel
  several hops.
- A phone that also has internet acts as a *bridge*. It uploads mesh blobs to internet
  nodes and fetches, from internet nodes, the blobs that people in the mesh are waiting
  for.

Nodes never see plaintext, in the mesh as on the internet. A relay holds opaque blobs it
cannot attribute to a recipient.

## Terms

| Term | Meaning |
|---|---|
| Link | A bidirectional, ordered, reliable byte channel to one peer: a TCP connection, a BLE connection, an in-memory channel in tests |
| Link kind | `tcp`, `ble` or `mem` |
| Mesh link | A link whose kind is not `tcp` |
| Mesh node | A node with at least one mesh link enabled, typically a phone |
| Bridge | A mesh node that can also reach an internet node over HTTP and has bridging enabled |
| Upstream | The internet nodes a bridge talks to, through the client HTTP API of [API.md](API.md) |
| Scope | Local metadata on a stored blob saying where it may be replicated |
| Mesh time | The node's local clock corrected by the clock offset its mesh peers agree on |

## Link abstraction

The replication engine (announce, ask, fallback asks, anti-entropy, per-neighbour known
sets, budgets) runs over links, and does not depend on how a link carries bytes. A link
provides:

| Property | Meaning |
|---|---|
| Peer id | The authenticated Ed25519 peer id of the other end, after the link handshake |
| Kind | `tcp`, `ble` or `mem` |
| Message capacity | The largest network message the link accepts in one send (for TCP the frame limit; for BLE the mesh message limit below) |
| Bandwidth estimate | Bytes per second the link sustains, measured or configured. The engine sizes batches and budgets with it |
| Send | Enqueue one network message, with a high-priority flag. Never blocks: a full queue is an error and the message is dropped |
| Received messages | Every network message the peer sent, already reassembled |
| Up and down events | The link completed its handshake, or is gone |

Network messages are the `message` encoding of [WIRE-PROTOCOL.md](WIRE-PROTOCOL.md#network-messages).
A link carries whole messages: fragmentation, if any, is below this interface.

## BLE link

### Roles and discovery

Every phone is a GATT peripheral and a GATT central at the same time. It advertises one
128-bit service UUID and scans for it.

| Item | Value |
|---|---|
| Service UUID | `6a8b2f40-5c1d-4e2a-9b7f-3d0c8e1a5f60` |
| Characteristic (write without response, notify) | `6a8b2f41-5c1d-4e2a-9b7f-3d0c8e1a5f60` |
| ATT MTU requested | 517 |

When two phones see each other, the one whose advertised device address compares lower
connects as central; the other only accepts. If the platform hides the address, both may
connect: a node that ends up with two links to the same peer id keeps the one whose
handshake completed first and closes the other.

The central writes chunks to the characteristic; the peripheral sends chunks as
notifications. Both directions use the same chunk format. The platform guarantees order
within one connection. A failed write or notification closes the link: replication is
idempotent and recovers through asks and anti-entropy on the next link.

### Chunks

A chunk is one write or notification, at most `min(ATT MTU − 3, 512)` bytes (512 is the longest attribute value Bluetooth allows; Android cuts anything longer):

```text
chunk  = u8 header ‖ body
header = kind (bits 7–6) ‖ stream (bits 5–0)
kind   = 0b00 single | 0b01 first | 0b10 middle | 0b11 last
single body = message
first  body = u32 BE total length ‖ first part of the message
middle body = next part
last   body = final part
```

- A message that fits in one chunk is sent as `single`.
- Otherwise it is split into `first`, zero or more `middle`, and `last`, all with the same
  stream number.
- The sender has two queues, each sending one message at a time on its own stream: the
  high-priority queue on stream 0, the low-priority queue on stream 1. Chunks of the high
  queue go first, so that a small message (an `Announce`, an `Ask`) is not stuck behind a
  large `Blobs`. `Blobs` and `Wanted` are low priority, everything else, the handshake
  included, is high priority. Since a queue starts a message only once the previous one
  has left, a stream is never reused while the receiver still reassembles it.
- A receiver accepts any stream numbers within the bounds below.
- `total length` must not exceed the mesh message limit (256 KiB). A larger value, a
  `middle` or `last` on an idle stream, a `first` on a busy stream, or a reassembled
  length that differs from `total length` closes the link and counts as one protocol
  violation (two strikes, as on TCP).
- A stream with no new chunk for 30 seconds is dropped silently.
- At most 8 reassemblies are open per link, and at most 512 KiB is buffered per link.
  A chunk that would exceed either bound closes the link. Until the link handshake ends,
  messages are limited to 16 KiB and 32 KiB is buffered. Only received bytes take memory:
  the announced total is not allocated up front.
- Messages received while the handshake is busy with a previous one wait, at most 64 KiB
  per link.

### Link handshake

A mesh link speaks `GMSH.2.1`. It runs the trust round of
[WIRE-PROTOCOL.md](WIRE-PROTOCOL.md#handshake), inside an encrypted channel set up by an
ephemeral key exchange, and has no `ListPeers` (mesh links have no addresses to share):

| # | Both | Initiator then receives | Responder then receives |
|---|---|---|---|
| 0 | `hello` (plaintext) | | |
| 1 | `identity` (sealed, as everything below) | | |
| 2 | `role ‖ trust_offer` | | |
| 3 | | `trust_verdict` | `trust_proofs` |
| 4 | | `trust_proofs` | `trust_verdict` |

```text
hello        = version ‖ X25519 ephemeral public key (32)
identity     = peer_id (33) ‖ u64 BE clock ‖ u8 capabilities ‖ duplicate token (16)
             ‖ signature over identity_hash
identity_hash = blake3("gossip/mesh/link/v2 identity" ‖ transcript ‖ sender ephemeral key
             ‖ peer_id ‖ clock ‖ capabilities ‖ duplicate token)
clock        = sender clock in unix ms, rounded down to 30 s
capabilities = bit 0 bridge (the sender bridges to an upstream now)
             ‖ bit 1 accepts bulletin (the sender stores mesh announcements)
             ‖ bits 2–7 zero
```

- The role is decided by the peer id rule (both sides send role `2`, unknown), since a
  BLE connection has no meaningful dialler: the side whose peer id bytes compare lower is
  the initiator.
- Trust proofs are bound to `transcript` (below) and both peer ids, as on TCP to the
  transcript of the random challenges, so a proof cannot be moved to another link. The
  identity signature covers the transcript too: a relay in the middle, which runs two key
  exchanges, cannot pass one side's identity on to the other.
- A responder that refuses sends its verdict and closes without proving. A handshake not
  done after 20 seconds closes the link.
- A hello with another instance or major version, a minor version below 1, or a key that
  gives no shared secret, fails the handshake. `GMSH.2.1` added the
  [local-only flags](#local-only-blobs-and-seekers) (`LocalBlobs` and the flags byte of
  `Wanted` entries), which a `GMSH.2.0` phone cannot parse, so it does not link with
  `GMSH.2.0` or `GMSH.1.x` phones, none of which were released.
- The receiver of `identity` estimates the peer's clock offset as `peer clock − local
  time`, to the 30-second rounding. Round trips on BLE are well under a second, so they
  are not measured. See [Clock tolerance](#clock-tolerance).

### Link encryption

```text
transcript = blake3("gossip/mesh/link/v2 transcript" ‖ lower ephemeral key ‖ higher one)
shared     = X25519(own ephemeral secret, peer ephemeral key)
key_lo     = blake3_derive_key("gossip/mesh/link/v2 key from the lower ephemeral key",
                               shared ‖ transcript)
key_hi     = blake3_derive_key("gossip/mesh/link/v2 key from the higher ephemeral key",
                               shared ‖ transcript)
sealed     = u64 BE counter ‖ ChaCha20-Poly1305(key, nonce = 0u32 ‖ counter, message)
```

- Every message after the two hellos, handshake and network messages alike, is sealed
  with the key of its sender's direction: `key_lo` for the side whose ephemeral key is the
  lower one, `key_hi` for the other. Counters start at 0 and grow by one per message.
- The receiver accepts each counter once, in any order within a window of 65 536 below the
  highest seen (the two priority queues complete messages out of order). A message that
  does not authenticate, or replays a counter, closes the link.
- An ephemeral key that gives an all-zero shared secret (a low-order point) fails the
  handshake.
- A passive listener sees the version, two fresh public keys, and sizes and timing of
  sealed messages: no peer id, clock, capability, wanted entry or blob. The keys are
  fresh for every link and kept only in memory, so a recorded link cannot be decrypted
  later. An active attacker that links with a phone learns what any peer learns.

### Why a separate version instead of GOSS.2.0

The new message subtypes below exist only on mesh links, and blob scope is local metadata
that never crosses a TCP link. Using a separate instance name, `GMSH`, keeps every deployed
internet node compatible: TCP links stay `GOSS.1.0` with exactly the messages of
[WIRE-PROTOCOL.md](WIRE-PROTOCOL.md), and a TCP peer can never receive a mesh subtype. A
`GOSS.2.0` bump would have forced every server to upgrade for a feature servers do not use.
Bridges reach the internet through the client HTTP API, not through TCP replication, so they
need nothing new from servers either.

On mesh links the following subtypes are added to `blob_message` (every one of them is
a protocol violation on a TCP link):

```text
subtype 5  Wanted = u8 hops ‖ varint(n ≤ 256) ‖ n × wanted_entry
wanted_entry      = seeker (34) ‖ u32 BE lifetime (seconds, ≤ 21600) ‖ u8 flags
flags             = bit 0 local-only ‖ bits 1–7 zero (otherwise a protocol violation)
```

A `Wanted` message received on a TCP link is a protocol violation. Unknown subtypes on a
mesh link are a protocol violation, as on TCP.

For the [compact link-up](#compact-link-up) and [bridge beacons](#bridge-beacons):

```text
subtype 6  HaveSummary   = gcs
subtype 7  WantedSummary = gcs ‖ n × u8 hops ‖ n × u8 lifetime (units of 120 s, 1 to 180)
subtype 8  Beacon        = u8 hops ‖ key (33) ‖ u64 BE issued_at (ms)
                         ‖ u32 BE lifetime (seconds, ≤ 3600) ‖ signature (65)
subtype 9  LocalBlobs    = as Blobs (subtype 2): local-only blobs (GMSH.2.1)
```

Every link starts with the two summaries; a second one of either on the same link is a
protocol violation. Unknown subtypes on a mesh link are protocol violations, as on TCP.

### Peer ids on mesh links

A phone uses a new Ed25519 key, and so a new peer id, for every link. Its peer ids are
never its internet peer id, and two links of the same phone cannot be tied together by
them. Trust proofs are bound to the transcript and the peer ids, so fresh ids need no
change to the trust schemes.

Two phones may still connect twice (each as central of the other). To find out, each side
sends a duplicate token in its identity: 16 random bytes it keeps for 15 minutes, about a
BLE address epoch. When a link completes with a token another ready link already showed,
both ends keep the link with the lower link key (`gcs::link_key` of the two peer ids,
which both compute alike) and close the other. The side that closes a link that never
became ready lets its last handshake message leave first, so that the peer completes too
and reaches the same decision. A peer learns that two of its links go to one phone, which
it knows anyway from the radio.

What these ids do not hide is that a phone runs Gossip: the service UUID does (see the
[threat model](#threat-model)).

## Blob scope

Every stored blob carries a scope: a set of flags saying where it may be replicated.

| Flag | Meaning |
|---|---|
| `internet` | Replicated on TCP links (every blob on a server) |
| `mesh` | Replicated on mesh links |
| `upload` | Waiting to be uploaded upstream by a bridge; cleared once uploaded |
| `local` | Local-only: stays in the mesh, never gets `upload` or `internet` (see [Local-only blobs and seekers](#local-only-blobs-and-seekers)) |

Scope is local metadata and is not part of the envelope, so blob ids are unchanged. Only
`local` crosses mesh links, as the message a blob is served in (`LocalBlobs` instead of
`Blobs`).

### How a blob gets its scope

| Arrival | Scope |
|---|---|
| Received on a TCP link | `internet` |
| Received on a mesh link in `Blobs` | `mesh`, plus `upload` on a node with bridging enabled |
| Received on a mesh link in `LocalBlobs` | `mesh` + `local` |
| Submitted by the local app on a server with mesh enabled | `mesh` + `upload` + `internet` |
| Submitted by the local app on a phone | What a mesh link would give it: `mesh` + `upload`, or `mesh` + `local` for a local-only blob (see [Plausible deniability](#plausible-deniability)) |
| Submitted by the local app on a node without mesh | As today: `internet` |
| Fetched upstream by a bridge for a wanted seeker | `mesh` |
| Fetched upstream for the local app's own seekers | Not stored: returned to the app |

When a blob already stored arrives again by another path, its scope is the union of the
old and the new flags, except that the stored copy keeps its class: a local-only blob
stays local-only (no `upload`, no `internet`) whatever a later copy claims, and a regular
blob never becomes local-only (a third party re-sending it as local must not stop its
upload). A key-value entry is still decided by the first valid value stored
under its seeker, whichever link it came from (the `key_taken` rule of
[API.md](API.md#post-apimessages)). This rule also settles the fork hazard of a client
that re-encrypts under the same seeker after a crash: the first copy seen wins in the
mesh as on a server.

### Replication filter

| Link kind | Announced, served and listed in anti-entropy |
|---|---|
| `tcp` | Blobs whose scope has `internet` |
| `ble`, `mem` | Blobs whose scope has `mesh`, with a payload of at most 64 KiB |

A peer that asks for a blob outside the link's filter gets nothing back for that id, as if
the node did not hold it. The anti-entropy `SyncIds` listing on a mesh link only contains
mesh-scope ids. A blob received on a link is always accepted regardless of the filter.

A node without mesh links (every server) applies no filter and never looks scopes up, so
its behaviour is exactly the one of [WIRE-PROTOCOL.md](WIRE-PROTOCOL.md).

Anti-entropy on a mesh link asks for everything the peer holds within the mesh retention
(`since` = mesh time − mesh retention), not only what was created since the node's own
high-water mark as on TCP. A phone that walks in from another part of the crowd carries
older blobs that nobody nearby has seen; a high-water mark would skip them. The listing
converts times with the mesh retention: a blob that also has the internet scope expires
later and is listed generously, never missed.

### Retention and caps per scope

| Scope | Retention after `created_at` | Cap |
|---|---|---|
| `internet` | `retention_ms` (14 days) | `max_total_bytes`, `max_blob_count` |
| `mesh` without `internet` | `mesh_retention_ms` (72 hours) | `mesh_max_bytes`, `mesh_max_blob_count` |

Setting names are those of the pools configuration (`[pools]` on a server, the mobile
configuration on a phone).

A blob with both flags keeps the longer retention. When the mesh cap is reached, eviction
follows the existing trust order among mesh-scope blobs only, so a flood on mesh links can
never push internet-scope data out, and the reverse. Blobs with `upload` are evicted last
within their trust bucket.

### Storage format

The per-blob metadata record of `gossip-pools` gains one trailing byte:

```text
meta = … existing fields … ‖ u8 scope flags (bit 0 internet, bit 1 mesh, bit 2 upload,
       bit 4 local)
```

Bit 3 marked the local app's blobs in development builds (`own`, with an `own_upload`
index). It reads as unset; the index is deleted on open, and a phone discards a store that
had it (see [Plausible deniability](#plausible-deniability)).

A record without the trailing byte is read as `internet`, so existing pool files open
without a migration step: the schema version moves from 1 to 2 and nothing else is
rewritten. Two new tables index blobs with the `mesh` flag by expiry (the mesh
anti-entropy listing) and blobs with the `upload` flag (the bridge queue). A schema 1
binary refuses a schema 2 file instead of misreading it.

## Wanted seekers

A seeker is a one-time mailbox address that nobody but the two parties can link to a
person. A bridge therefore cannot know which internet blobs someone in the mesh is waiting
for. Mesh nodes tell it, with `Wanted` messages.

### Origin

The app gives its node the seekers it currently expects (the same list it would send to
`POST /api/messages/fetch`). The node adds them to its wanted table with a lifetime of
one hour, renews them every 10 minutes while the app keeps them, and removes the ones the
app drops.

### Table

Each node keeps one table, keyed by seeker:

| Field | Meaning |
|---|---|
| Expires at | Mesh time after which the entry is dropped |
| Hops | The largest hop budget received for this seeker |
| Own | Whether the local app asked for it (never sent on the wire) |
| Local | Local-only: no regular advertisement of it was seen (sent as the entry's flag) |
| Origin | The peer that first brought it, for eviction |

- An incoming entry is merged: the larger hop count wins, and the expiry moves later only
  for a renewal, an expiry more than 5 minutes later than the known one. Lifetimes travel
  relative to the sender's clock, and every hop adds its transit and queueing time, so a
  smaller increase would make two neighbours push the same entry back and forth forever.
- Hop budgets above the largest one an honest phone starts with (32, the own and beacon
  maximum) are clamped to it, and lifetimes of forwarded entries to one hour, the own
  lifetime. A peer claiming more would otherwise become the best direction for every
  seeker it copies, and its entries would outlive honest ones.
- The node remembers which peers advertised each entry, up to 4, ranked by hop count plus
  twice their trust (trust breaks ties and near ties). Those are the directions of
  [guided forwarding](#guided-forwarding).
- Beacon seekers in `Wanted` messages are ignored: beacons only travel signed.
- The table holds at most 32 768 entries. Over that, it goes down to 90 % of the cap at
  once, by fair share: forwarded entries go first, always taken from the peer that brought
  the most of them, its earliest expiry first. A flooder therefore evicts only its own
  entries while honest peers hold fewer. Own entries go last.

### Forwarding

Every 2 seconds, a node sends to each mesh link the entries it did not send on that link
yet, or whose expiry was renewed since, with `hops` decreased by one. Entries are never
sent back to a peer that advertised them. Entries whose hop count reaches
zero are kept locally but not forwarded. The `hops` byte of a message is therefore the
budget left: an entry received with `hops = 1` stops at the receiver.

- An own entry starts with a hop count drawn uniformly from 24 to 32, so that a neighbour
  cannot tell an originator from a relay by the hop count. With guided forwarding an entry
  has to reach the sender of the message, which in a 500 m march is 12 to 50 hops away
  (see [SIMULATION.md](SIMULATION.md#mesh)); 4 to 6 hops only cover the immediate crowd.
- A round sends at most 16 KiB of entries per link (about 430), own entries first, then
  forwarded ones, each shuffled, grouped by hop budget. `Wanted` messages share the
  low-priority queue with blobs, so a large table cannot starve them.
- A node accepts at most 512 entries per minute from one peer, scaled by trust as for blob
  ingest (`0.25 + 0.75 × trust`), and at most 4096 per minute from all peers together, so
  that a device reconnecting under fresh peer ids gains a fresh per-peer budget but not
  more of the total. Entries over budget are dropped without penalty.
- Hop counts still hint at distance: a neighbour receiving an entry with a budget of 32
  knows the sender is its origin (relays send at most 31), with 31 that it is likely, and
  so on. Entries travel inside the [link encryption](#link-encryption), so only a phone
  that links with the origin sees them, and it sees a fresh peer id; what it learns is
  that somebody within radio range waits for that seeker. See the
  [threat model](#threat-model).

### Effects

- A mesh node that stores a blob whose key is a wanted seeker, or learns that a blob it
  already holds is wanted, announces it at once, with high priority, to the mesh links
  that [guided forwarding](#guided-forwarding) selects, instead of waiting for the next
  announcement round.
- A bridge fetches the wanted seekers it does not already hold from upstream, at most
  every 10 seconds, at most 256 seekers per request, and inserts the results with scope
  `mesh` (see [Bridges](#bridges)). Local-only entries, and the app's own local-only
  seekers whatever the table says, are never fetched.
- A wanted entry is not removed when its blob is found: the seeker is used once, the entry
  expires on its own, and keeping it costs 39 bytes.

## Local-only blobs and seekers

Some traffic only makes sense inside the crowd and must not reach the internet: the app's
re-announcement mailbox blobs, and the mailbox and lookahead seekers it waits for. The app
marks them local-only (`sendBlob(…, localOnly = true)`, `setWanted(seekers,
localSeekers)`, see [MOBILE.md](MOBILE.md#api)).

- **Blobs.** A local-only blob is stored with scope `mesh` + `local`: it never
  enters the upload queue, so the phone does not upload it, even when bridging. It
  is served on mesh links in `LocalBlobs` messages instead of `Blobs`, and whoever
  receives it stores it with `mesh` + `local`, never `upload`, so a bridge that relays it
  does not upload it either, however many hops away. The upload loop also skips any
  blob with `local`, as a second check. With guided forwarding, a local-only key-value
  blob nobody routes to is not pushed toward bridges (it has nothing to do there); it
  still spreads by the spray and to the directions of whoever wants its seeker.
- **Wanted entries.** A local-only seeker travels with bit 0 of its entry's flags. A
  bridge does not fetch local-only entries upstream, and a phone never fetches its own
  local-only seekers, whatever its table says. A regular advertisement of the same seeker
  clears the flag for the life of the entry (the entry is then sent again, unflagged); a
  local-only advertisement never sets it on a regular entry. A stranger can thus make a
  bridge ask the internet for a local-only seeker, which it could do itself, but cannot
  stop bridges from fetching what somebody needs.
- **Summaries.** In a `WantedSummary`, a local-only entry is coded as `seeker ‖ 0x01`
  instead of `seeker`, so that a summary only hides entries the peer holds with the same
  flag.

The flag is a request, not a guarantee. A malicious or modified phone that receives a
local-only blob or entry can ignore the flag and upload the blob or query the seeker
upstream, as it could with anything it relays. What protects the content is that it is
end-to-end encrypted and its seekers are one-time and rotate; the flag only keeps honest
phones and bridges from putting it on the internet.

## Compact link-up

When two phones link, each would otherwise send the other its whole wanted table (39 bytes
an entry) and list every mesh blob it could offer (32 bytes an id). In a crowd, two
neighbours already share most of both, so most of those bytes repeat what the peer holds.
The simulation of a 1000-phone march spends 6 GB on wanted tables alone this way
([SIMULATION.md](SIMULATION.md#mesh)). Instead, each side summarises what it holds, and
the other sends only what is missing. Beacons are left out of the summaries: they are few,
and always sent.

### Golomb-coded sets

A summary is a Golomb-coded set (GCS) of 64-bit hashes:

```text
gcs  = u8 p ‖ varint(n) ‖ bytes(bits, ⌈n × (p + 2) / 8⌉)
key  = blake3 derive_key("gossip/mesh/gcs/v1", min(peer id a, peer id b) ‖ max(…))
h(x) = ⌊u64 BE(blake3 keyed_hash(key, x)[0..8]) × n × 2^p / 2^64⌋
```

- Peer ids are the 33-byte encodings of the link's two ends, so both sides compute the same
  key, and a hash crafted on one link means nothing on another.
- The `n` values `h(x)` are sorted. Each difference to the previous one (the first to 0) is
  written Golomb-Rice coded with parameter `p`: the quotient `d >> p` in unary (that many 1
  bits, then a 0), then the low `p` bits, most significant bit first. Bits are packed into
  bytes most significant bit first, and the last byte is padded with zero bits.
- `p` is 4 to 16 and `n` at most 65 536. The byte length is checked against the bound
  above before decoding. A set that does not decode to exactly `n` values below
  `n × 2^p`, or that leaves anything but zero padding, is a protocol violation.
- The receiver decodes the set into a sorted list and looks values up by binary search. A
  value matches the item `x` of the receiver when it equals `h(x)` computed with the
  sender's `n` and `p`. Two items of the sender may share a value, which then appears
  twice in the set.
- A value matches an item the sender does not hold with probability `2^-p`. A false match
  only makes the receiver skip something on this link; the item still reaches the peer
  through other links, renewals and the hourly resync.

### Have summary

`HaveSummary` is a GCS, with `p = 8`, of the ids of the blobs the sender stores with the
`mesh` flag. A sender with more than 65 536 such blobs summarises the 65 536 that expire
last. It replaces the link-up `SyncRequest` on that link:

- Each side sends `HaveSummary` right after the handshake, and no `SyncRequest`.
- On receipt, a node takes the ids it would list to that peer in answer to a link-up
  `SyncRequest` (scope filter and [guided forwarding](#guided-forwarding) included), drops
  those the summary matches, and sends the rest in `Announce` messages sized as usual. The
  peer asks for what it lacks, as for any announcement.
- The hourly resync of [WIRE-PROTOCOL.md](WIRE-PROTOCOL.md#blob-replication) still uses
  `SyncRequest` and `SyncIds`.

### Wanted summary

`WantedSummary` is a GCS, with `p = 10`, of the seekers in the sender's wanted table that
have not expired, followed by one hop byte and one lifetime byte for each value, in the
order of the sorted values. The hop byte is the hop budget the sender would forward the
entry with (0 when it does not forward it). The lifetime byte is its remaining lifetime
divided by 120 seconds, rounded up, from 1 to 180. When several seekers share a value,
every copy of the value carries the largest hop budget and lifetime among them. A table
with more than 65 536 entries cannot occur (the cap is 32 768).

- Each side sends `WantedSummary` right after the handshake.
- Until it has received the peer's summary, a node sends no `Wanted` on that link, for at
  most 10 seconds after the link came up.
- On receipt, for each entry of its own table whose seeker matches a value with hop byte
  `a` and lifetime byte `l`, a node with forwarding budget `b` for that entry records it
  as already sent to that peer, with expiry `now + 120 × l` seconds, when `b ≤ a + 1`.
  The peer's best direction for that seeker advertised `a + 1`, and ours would advertise
  `b`: with `b = a + 1` we would only tie it. An entry with `b ≥ a + 2` is a strictly
  better direction for the peer, so it is not recorded and travels in the next `Wanted`
  round. The usual renewal rule then decides later sends: an entry goes again once its
  expiry is more than 5 minutes after the recorded one, so ties still travel with the
  next renewal.
- The 120-second rounding is below the 5-minute renewal slack, so it never makes two
  neighbours push the same entry back and forth.

A summary costs about `p + 1.5` bits a value: 1.2 bytes per blob id, and 3.4 bytes per
wanted entry with its two bytes of metadata, against 32 and 39 bytes. What the peer lacks
still goes in full, so the saving depends on how much two neighbours share: on a
500-phone march it is a third to 41 % of the wanted bytes
([SIMULATION.md](SIMULATION.md#mesh)).

## Guided forwarding

Flooding every blob to every phone costs, per message, its size times the number of phones,
and all of it shares the airtime of one radio neighbourhood. The simulation shows a
standing crowd of 100 phones within one 25 m cell saturating at two messages per person
per hour, and 300 phones delivering 2 % ([SIMULATION.md](SIMULATION.md#mesh)). Wanted lists
already say where each blob is expected, so mesh nodes use them as directions:

- **Spray.** A key-value blob younger than 5 seconds (by its `created_at`, in mesh time)
  is offered on every mesh link, so that it is close to its sender in several directions
  before routing starts.
- **Toward the recipient.** After that, a key-value blob whose seeker is in the wanted
  table is offered only to the two best directions that advertised the seeker, that is,
  toward the person who waits for it. Two, so that one peer advertising every seeker
  with a large budget cannot take every blob for itself.
- **Toward a bridge.** A key-value blob nobody wants yet (its recipient is outside, or has
  not read the previous message yet) is offered only to the two best directions toward a
  bridge beacon. A bridge offers such blobs nowhere: it uploads them.
- **A little everywhere.** Whatever the directions, 5 % of (blob, peer) pairs are offered
  anyway, picked by a hash of the blob key and the peer id so that every round decides the
  same. No advertisement can blackhole a blob completely.
- **Our own.** A blob whose seeker this node wants for itself is not offered further.
- **Other kinds.** Announcements and key sets are always offered on every mesh link: they
  are rare, and they have to reach people nobody routes to yet.

The same rule decides what a mesh link lists in anti-entropy, so a new link no longer
receives the whole mesh store.

### Bridge beacons

A bridge advertises itself with a signed `Beacon` (subtype 8):

```text
signed = blake3("gossip/mesh/beacon/v1" ‖ key ‖ u64 BE issued_at ‖ u32 BE lifetime)
```

- `key` is a beacon key the bridge changes every hour, neither its link peer ids nor its
  internet identity. The table keeps one beacon per key, under the reserved seeker form
  `0x00 ‖ blake3(key) ‖ 0x00` (real seekers start with `0x20`), with its signed form, and
  forwards it as a `Beacon` with one hop less.
- A beacon starts with a hop budget of 32 and a lifetime of 20 minutes, and is signed
  again when half of it is gone while the upstream answers. A bridge that loses its
  upstream stops renewing, and its beacon expires within 20 minutes.
- A beacon with a bad signature is a protocol violation. One that expired, is dated more
  than 10 minutes ahead of mesh time, or announces a longer lifetime than 20 minutes is
  ignored. A beacon counts as one entry of the wanted budget, and a phone keeps at most
  64 of them.
- The hop budget is outside the signature, since every hop lowers it, so a phone can still
  replay a real beacon with the largest budget. That is why routes use two directions and
  spray (see [Known limitations](#known-limitations)).

### What a wanted list reveals

A wanted list tells mesh neighbours which seekers somebody in range is waiting for. A
server learns the same thing from `POST /api/messages/fetch` today. A neighbour does not
learn who asked, since entries are relayed with randomised hop counts and mixed with other
people's entries, but it can link the seekers of one message (the entries that arrive
together from its first relay). See the [threat model](#threat-model).

## Bridges

A mesh node acts as a bridge when bridging is enabled and at least one upstream answers.
It then advertises the bridge capability in the identity of new links; a phone that only
reaches an upstream does not. Upload pacing and
retries are settings of the mobile bridge (see [MOBILE.md](MOBILE.md)).

### Upload

The bridge uploads every stored blob with the `upload` flag through the client API of the
upstream node. A phone that does not bridge uploads nothing, its app's blobs included: the
node cannot tell them from relayed ones (see [Plausible deniability](#plausible-deniability)).
The app posts its own messages to its server itself once it reaches one.

| Kind | Call |
|---|---|
| Key-value | `POST /api/messages/` |
| Hash | `POST /api/auth` |
| Bulletin | `POST /api/bulletin` |

- A successful call, or `409 key_taken` for a key-value entry, clears the flag.
- Another `4xx` but `429` (for example an upstream with a smaller payload limit) also
  clears it: the blob is refused for good, and retrying it would only hold back the ones
  after it.
- `429` defers the blob alone, with exponential backoff from 30 seconds to 30 minutes per
  blob. A blob in backoff is skipped and the next ones go.
- When no upstream answers at all (network, timeout, `5xx`), the round stops and the blob
  is deferred the same way.
- Uploads are paced at 600 per minute by default, key-value entries first.

Upstream nodes date uploaded blobs with their own `created_at`, so the same data has a
different blob id on the internet than in the mesh. That is expected: the two id spaces
never meet, and key-value and hash entries are deduplicated by key on both sides.

Two bridges may upload the same mesh announcement. Upstream then stores it twice under two
counters. Clients already reject a replayed announcement (the session layer only accepts
an announcement newer than the last one from that peer), so this costs bulletin space, not
correctness.

### Download

- Wanted seekers: as described in [Effects](#effects). Only entries for the seekers the
  bridge asked for are kept, at most as many as it asked for: an upstream cannot push
  other seekers into the mesh. A fetched entry is inserted with a `created_at` of the
  bridge's mesh time, scope `mesh`, and the bridge's own trust as source.
- Bulletin: disabled by default (0 announcements per hour). When enabled, the
  bridge injects up to that many of the newest upstream announcements per hour into the
  mesh. Each announcement is about 9 KB and every client downloads all of them, so this
  only scales while global announcement volume is low. It lets people outside the mesh
  start a conversation with someone inside.

### Bridge visibility

A bridge sends strike traffic from its own internet connection. Its mobile operator and
the upstream node can see that this phone uploads many entries and fetches many seekers.
Content stays encrypted and seekers stay unlinkable to people. Bridging is a separate
opt-in from mesh mode, and the plan adds Tor for upstream calls later.

Every phone marks the blobs it relays for upload, so that it can bridge them as soon as
the person turns bridging on (somebody walking out of the area). Turning bridging on
therefore uploads what the phone relayed in the last 72 hours; the bridge setting says so.

## Clock tolerance

Phones that have been offline for days drift, and a mesh has no NTP. Mesh nodes therefore
use *mesh time* for mesh-scope blobs:

- Each link handshake gives a clock offset estimate for that peer (see
  [Link handshake](#link-handshake)), kept while the link is up and dropped with it.
- Over the current links, the node takes the median offset. If at least 3 links
  contribute and the median is more than 60 seconds away from zero, it is the target
  correction, clamped to ±3 hours; otherwise the target is zero.
- The applied correction moves toward the target by at most 5 seconds per second
  (5 minutes per minute).

Mesh time is used for the `created_at` of blobs the node creates in mesh scope, and for
validating envelopes received on mesh links:

| Check | Internet (`tcp`) | Mesh links |
|---|---|---|
| `created_at` in the future | At most `max_future_skew_ms` (5 minutes) | At most `mesh_max_future_skew_ms` (6 hours) of mesh time |
| Expired | `created_at + retention < now` | Same, with mesh retention and mesh time |

A future-dated envelope on a mesh link is skipped without penalty, as on TCP.

Only current links count, so a device that reconnects under fresh peer ids contributes
one estimate at a time: it moves mesh time only by holding most of a phone's links at
once. Even then the correction stays within 3 hours, half the 6-hour skew: a phone it
shifted still accepts honest fresh blobs, and honest phones still accept the blobs that
phone creates. The slew rate means a few minutes of such links move mesh time by a few
minutes, not hours.

The app's own session layer has its own timestamp checks, which also need relaxing for
mesh delivery. That change is in the app repository, Phase 3 of the plan.

## Trust on mesh links

Mesh links run the same trust round as TCP links, with schemes a phone can afford:

| Scheme | On phones |
|---|---|
| Proof of work | Offered at 12 bits by default (well under a second on a phone) |
| Keyring direct and keyring ring | Offered when a keyring is configured; the main way to give members priority |
| Massa stake | Verified (21 ms) when a peer offers a proof; never proved on a phone |
| Peer allowlist | Available, for small groups who exchange peer ids in advance |

Proof of work scores flat on phones: every phone proves the same 12 bits and any valid
proof gives the full score, so grinding more bits buys an attacker nothing over honest
phones. A peer that proves nothing is still served, at the lowest budgets. At most half of
a phone's mesh links go to peers with trust below 0.2.

A full phone admits a newcomer by replacing its oldest link, when that link is at least
10 minutes old and no link was replaced in the last 2 minutes. Phones that hold every
slot of a phone forever (an eclipse) are therefore replaced at that pace, without the
cost of rotating links on a timer, which the simulation showed halves delivery.
Admission is checked again when a handshake completes, so concurrent handshakes cannot
exceed the cap.

## Phone defaults

| Setting | Default | Where |
|---|---|---|
| Mesh links | 8 | Mobile link manager |
| Links to peers with trust below 0.2 | 4 | Mobile link manager |
| Mesh message limit | 256 KiB | BLE chunk layer |
| Largest mesh payload | 64 KiB | `MeshConfig.max_payload_len` |
| Announce batch period | 1 s | `PropagationConfig.announcement_interval_ms` on a phone |
| Envelopes per `Blobs` | 8, at most 64 KiB | `PropagationConfig.max_blobs_per_message`, `max_blobs_message_bytes` on a phone |
| Sync page | 512 ids | `PropagationConfig.sync_page_size` on a phone |
| Mesh retention | 72 h | `PoolsConfig.mesh_retention_ms` |
| Mesh storage | 64 MiB, 20 000 blobs | `PoolsConfig.mesh_max_bytes`, `mesh_max_blob_count` |
| Future skew of mesh-only blobs | 6 h | `PoolsConfig.mesh_max_future_skew_ms` |
| Wanted forwarding | every 2 s, at most 16 KiB and 4 full messages per link | `MeshConfig.wanted_forward_interval_ms`, `wanted_bytes_per_round`, `wanted_messages_per_round` |
| Own wanted entries | hops 24 to 32, lifetime 1 h | `MeshConfig.own_hops_min`, `own_hops_max`, `own_lifetime_s` |
| Wanted table | 32 768 entries, forwarded lifetime ≤ 1 h, hop budgets ≤ 32 | `MeshConfig.max_wanted_entries`, `max_forwarded_lifetime_s`, `MeshConfig::max_hops` |
| Wanted renewal slack | 5 min | `WANTED_RESEND_SLACK_MS` |
| Guided forwarding, spray | on, 5 s, 2 directions, 5 % of pairs | `MeshConfig.guided`, `spray_ms`, `route_fanout`, `spray_permille` |
| Bridge beacon | 32 hops, 20 min, key changed hourly, at most 64 kept | `MeshConfig.beacon_hops`, `beacon_lifetime_s`, `max_beacons` |
| Wanted ingest | 512 entries per minute per peer at trust 1, 4096 for all peers | `MeshConfig.wanted_ingest_per_min`, `wanted_global_ingest_per_min` |
| Link replacement when full | oldest link, ≥ 10 min old, at most every 2 min | Mobile `min_replaced_link_age_ms`, `link_replace_interval_ms` |
| Bridge upload pace | 600 blobs per minute | Mobile bridge |
| Bridge bulletin injection | 0 per hour (off) | Mobile bridge |
| Mesh peer ids | fresh per link; duplicate token for 15 min | Mobile node, `peer_id_rotation_ms` |
| Mesh clock | 3 current links, ±3 h, 5 min per minute | `MeshClock` |

A phone has only mesh links, so its `PropagationConfig` is the mesh link tuning; a server
keeps the values of `config/config.toml`.

### Radio defaults

The radio layer (Kotlin, Swift) follows these, from the simulation in
[SIMULATION.md](SIMULATION.md#findings-and-chosen-defaults):

| Setting | Default |
|---|---|
| Advertising interval | 1000 ms |
| Scan duty cycle | 10 % |
| Neighbour selection | The strongest discovered phone with a free slot (random does as well) |
| Link rotation | None: a link is replaced only when it breaks |
| PHY | Coded PHY when both phones support it (Android), else 1M |

What a new link receives is encoded compactly, see [Compact link-up](#compact-link-up).

The simulation in [SIMULATION.md](SIMULATION.md#mesh) is where these values are tuned.

## Plausible deniability

The app can hold several accounts, one of them a decoy whose password a user gives up
under duress (the app's own storage is deniable). Whoever then holds the unlocked phone
can run the app as the user, use its keystore keys, and copy every file the app owns. The
mesh part must not let them prove that another account exists once the app has been
locked (by hand or by auto-lock); and a decoy opened while the mesh runs must use it as if
it were the only account. The node therefore keeps nothing that belongs to an account
beyond the open session:

- **Blobs the app sends are stored like relayed ones.** `send_blob` gives a blob the scope
  a mesh link gives (`mesh` + `upload`, or `mesh` + `local`), the trust bucket of a phone
  (every phone proves the same work), and no arrival time or source: a phone's pools are
  opened with `record_provenance` off, so `received_at` is 0 and `source_peer` empty for
  every blob. Same blob, same bytes on disk, whichever way it came (a test compares the
  sender's record with the receiver's). There is no mark to erase, so no older copy of one
  can survive in free pages of the copy-on-write file. The price: a phone uploads mesh
  blobs only when it bridges; the app posts its own messages over the internet itself
  when it gets there.
- **The wanted list lives in memory only.** `set_wanted` is not saved: a node that
  restarts (after a reboot, a crash) waits for nothing until an open session sets it
  again; a reboot ends the session anyway. The file older builds wrote
  (`mesh-wanted.bin`) is overwritten with zeros and deleted on start. Wanted entries never
  go to the pools.
- **A lock** (`lock`) empties the wanted list and deletes the key sets the app shared
  since the last lock (the node remembers their hashes in memory only). Everything else
  stays: the app's messages and announcements are still relayed and uploaded by bridges,
  and what arrives for the account waits on this phone and its neighbours until a session
  asks again.
- **Old stores.** A store written by a development build that marked the app's blobs is
  discarded on start, key file first, so that what is left of it no longer decrypts.

Limits:

- **Memory.** Until a lock, the running node holds the wanted list and the hashes of shared
  keys in memory; a memory dump of the running phone before the lock sees them. A lock
  drops them, but freed memory is not zeroed.
- **Timing.** A blob's `created_at` and its bulletin counter on this phone are close for
  blobs sent here, a little further apart for blobs relayed from afar; telling them apart
  that way is statistical, not proof, but it is not nothing.
- **Neighbours.** Phones nearby saw this phone announce a blob first and advertise its
  seekers; that is a radio-range observation, outside what the phone holds.
- **Flash.** Overwriting a file does not erase old copies the flash or the file system may
  keep; reading them needs a raw image of the flash and its keys, not a copy of the app's
  files.

## Threat model

People who use the mesh are in a crowd, near people who may be hostile, and possibly facing
authorities who can scan radio, seize phones and ask operators for data.

| Threat | What the attacker gets | Mitigation |
|---|---|---|
| A BLE scanner nearby | That a phone runs Gossip (the service UUID is fixed; iOS needs a fixed UUID to discover in the background) | Mesh mode is opt-in and says so. Links are encrypted from the second message on: a scanner that records links sees no peer id, clock, wanted entry or blob. The UUID itself cannot rotate |
| A hostile phone that joins the mesh | Opaque blobs, wanted seekers, traffic timing, a fresh peer id per link | Content is end-to-end encrypted. Seekers are unlinkable to people. Wanted entries are mixed and relayed with random hop counts. Hop counts and signal strength still say that someone within radio range waits for a seeker |
| A hostile phone steering routes | Blobs sent its way instead of toward the recipient or a bridge | Hop budgets clamped, two directions per seeker plus 5 % spray, beacons signed |
| A flood of junk from phones nearby | Wasted bandwidth and storage | Key-value signatures checked at every hop; per-peer and node-wide wanted budgets; fair-share eviction of the wanted table; mesh storage separate from internet storage; at most half the links to low-trust peers; keyring members first |
| Phones filling every slot (eclipse) | A phone isolated from the rest of the mesh | Flat proof-of-work trust (grinding buys nothing); the oldest link is replaced for newcomers every 2 minutes at most |
| Jamming | No mesh | None at this layer. Store-and-forward delivers once a path exists |
| A seized phone | Blobs it relayed, the open session's wanted seekers | Nothing marks the app's own blobs and nothing account-specific outlives a lock ([Plausible deniability](#plausible-deniability)). Pools encrypted and authenticated block by block under a data key wrapped by a key from the app's secure storage; no start without one; short mesh retention; a wipe that destroys the key file first |
| The mobile operator of a bridge, or the upstream node | That this phone uploads and fetches much more than one user would | Bridging is a separate opt-in. Tor for upstream calls is planned |
| A bridge that ignores the local-only flag | Local-only blobs uploaded, local-only seekers queried upstream | None in the protocol: honest phones and bridges honour the flag, a modified one need not. Content stays end-to-end encrypted and seekers are one-time; see [Local-only blobs and seekers](#local-only-blobs-and-seekers) |
| A malicious upstream | Junk sent to a bridge | Only entries for the seekers the bridge asked for are kept; key-value signatures are checked |
| A keyring member's ring proofs | The LSAG key image is the same for every connection under one keyring, so admitted peers can link a member's connections across peer ids | Known limit. A future ring scheme with a key image scoped per epoch removes it |
| A peer lying about its clock | Little: estimates count only while their link is up, need 3 links, are clamped to 3 h and slew slowly | See [Clock tolerance](#clock-tolerance) |

What the mesh does not protect: who is physically near whom, and the fact that people
communicate. It protects what they say and to whom they say it.

## Known limitations

- **Hop budgets are not authenticated.** A phone can claim the largest budget (32) for any
  seeker or beacon it saw, and so look as close to the recipient or the bridge as the
  origin itself. Clamping, two directions and spray keep blobs flowing past it; removing
  the advantage entirely would need signed hop chains, which cost more than the
  advertisements themselves.
- **Fresh identities are cheap.** A device can link under a new peer id every time, for
  the price of a key and 12 bits of work. Per-peer budgets therefore bound what one link
  brings, and the node-wide budgets, fair-share eviction and link replacement bound what
  any number of them bring. The core sees no radio address: limiting links per BLE
  address is the radio layer's job.
- **Rollback at rest.** The pools file detects any change but not an older copy of a
  block put back by someone who can write to the phone's storage.
- **Erasure is as good as the flash.** A wipe overwrites and deletes the key file, but
  flash storage may keep old copies of it. Giving the node a key that the app replaces
  on wipe (from the platform keystore) makes the erasure complete.
- **Inbound queue.** Up to 1024 complete messages wait for the engine. Each is at most
  256 KiB, but the radio delivers far slower than the engine reads, so the queue stays
  short in practice; it is bounded by count, not bytes.
- **Copies on other phones.** `forget_keys` and `lock` delete the phone's copy of a key
  set; copies already relayed expire with the mesh retention.
