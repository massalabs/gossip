# Radio transport for group messages (extension to wire version 1)

Status: draft extension to [Plausibly deniable group chats](./plausibly-deniable-group-chats.md)
(the "group spec"), implemented in `wasm/groups/src/radio.rs` and the node's
`publish_radio_text` / `receive_radio`. Section numbers (§) refer to the group spec.

## 1. Scope

Members of a group keep exchanging short text messages when there is no internet, through
MeshCore LoRa radios paired with their phones. A radio message is a message event of the
group (§6.2), carried in a compact form that every member of its epoch rebuilds exactly.
Once rebuilt it is received, merged, stored and relayed like any other event, so a group
survives a change of transport.

Not carried by radio: roots, kicks, leaves, dissolve messages, notices, queries and any
event other than a new text message. Membership changes need the server or the Bluetooth
mesh.

## 2. Carrier

The datagram is the payload of a MeshCore channel datagram (`PAYLOAD_TYPE_GRP_DATA`,
companion command `0x3E`), at most **165 bytes**, flooded on a MeshCore channel:

- by default the shared channel named `gossip`, secret `SHA-256("#gossip-radio-1")[0..16]`,
  the same on every radio, carrying nothing but these datagrams;
- optionally, for a group that opts in, a channel of its own whose secret is
  `H("gossip.groups.radio.channel.1", rk)[0..16]` (§4 below), changed with each epoch.

The MeshCore `data_type` is `0xFFFF` until a value is registered with MeshCore.
MeshCore's own encryption of the channel is an outer layer only; nothing here relies on it.

## 3. Datagram

```text
version (1) ‖ ts (8) ‖ nonce (4) ‖ tag (4) ‖ AES-256-SIV(key, nonce = 0¹⁶, aad = header)(type (1) ‖ text)
```

| Field     | Size | Rule                                                               |
| --------- | ---- | ------------------------------------------------------------------ |
| `version` | 1    | `1`; any other value is ignored                                    |
| `ts`      | 8    | big-endian u64 Unix milliseconds: the event timestamp              |
| `nonce`   | 4    | fresh random bytes chosen by the author                            |
| `tag`     | 4    | lets members find the epoch and the author (§4 below)              |
| sealed    | rest | AES-256-SIV with a 16-byte tag; the header (first 17 bytes) as AAD |
| `type`    | 1    | `0` = text; any other value is ignored                             |
| `text`    | rest | UTF-8, at most **131 bytes**                                       |

## 4. Keys and derived values

All hashes are `H` (§1.2) under new domains (Appendix A additions):

```text
rk          = H("gossip.groups.radio.epoch.1", chat_id, group_secret)
items       = rk, author, ts, nonce          (author: 32-byte GossipID, ts: unsigned integer)
tag         = H("gossip.groups.radio.tag.1", items)[0..4]
key         = H("gossip.groups.radio.key.a.1", items) ‖ H("gossip.groups.radio.key.b.1", items)
eventId     = ts (8, big-endian) ‖ H("gossip.groups.radio.event.1", items)[0..16]
syncObjId   = H("gossip.groups.radio.sync_obj.1", items)
```

The group secret reaches every member inside the root, over Agraphon sessions (§4.6), so
radio keys share their post-quantum protection.

## 5. Rebuilding the event

A device holding epoch E with root R computes, for each member `m` of R, the tag over
`(rk_E, m, ts, nonce)`. On a match it opens the sealed part with that key; a failure (a
4-byte collision) moves on to the next member and epoch. On success the event is:

| Field              | Value                   |
| ------------------ | ----------------------- |
| `eventId`          | §4 above                |
| `chat_id`          | E                       |
| `secret_proof`     | recomputed (§4.2)       |
| `parents`          | none (§6.1 allows zero) |
| `syncObjId`        | §4 above                |
| `type`             | `text`                  |
| `author`           | `m`                     |
| `created_at`       | `ts`                    |
| `last_modified_at` | `ts`                    |
| `body`             | the text                |
| `edited`           | false                   |
| `metadata`         | empty                   |

The author's own device creates the event with exactly these values (no parents, derived
IDs) and publishes the same event online, so its content is identical on every transport
(§9.5). Field values, not encodings, define the event (§1.1).

## 6. Receiving and relaying

The rebuilt event is received with no deliverer: the peer checks of §6.3 do not apply;
membership was shown by the epoch's radio key. Every other check of §6.3 applies.

- **Current epoch.** A newly accepted event of the device's current epoch is relayed online
  as a relayed event, by notices (§10.2).
- **Older epoch.** An event of an epoch that this device knows to be superseded is kept and
  shown with a warning ("sent with an older group key; a removed member may have read it"),
  and is **not relayed online**: removed members hold that epoch's radio key, and the rule of
  §10.4 cannot be applied to a datagram that names no deliverer. A device that has not
  adopted the successor yet relays it, as §10.4 already accepts from such members.
- **Replays** rebuild the same event ID and are ignored (§7.1).
- A device sends by radio only in its current epoch.

## 7. Security properties

- Only members of the epoch read or write radio messages; the radio and the MeshCore mesh
  see the clear header only.
- Post-quantum, as the group secret.
- Deniable as group messages: no signatures; any member can forge another member's radio
  message, as any member can already fabricate group messages (§6.2, §16.1).
- Forward secrecy per epoch only: anyone holding the epoch's group secret can derive every
  radio key of that epoch, as they can read the epoch's stored history.
- On air: the header (timestamp, nonce, tag) and the datagram length are visible; the
  default channel shows that Gossip is in use; messages are flooded.
- Not provided: radio acknowledgements, kicks by radio, catch-up over radio (missed events
  are fetched once another transport returns).

## 8. Open points

1. Register a MeshCore `data_type`.
2. Edits, deletions and reactions by radio (a type byte is reserved for them).
3. Forwarding internet messages to radio-only members.
4. Per-message forward secrecy against device compromise.
