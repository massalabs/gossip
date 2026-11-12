# Mobile node

`gossip-mobile` is the Gossip node embedded in the phone app. It keeps the pools, replicates
blobs with phones nearby over Bluetooth Low Energy (BLE) links that the app's radio code
hands to it, and, when the phone has internet and bridging is on, uploads mesh blobs to
internet nodes and fetches what people in the mesh are waiting for. The protocol is in
[MESH.md](MESH.md); this page is the library: its API, its threads, its configuration and
how to build it.

## What is in it

| Part | Module | Notes |
|---|---|---|
| Pools | `gossip-pools` | Mesh scope, retention and caps of a phone; encrypted at rest (`crypt.rs`) |
| Replication | `gossip-repl` | The same engine as servers, over BLE links, with guided forwarding |
| BLE chunks | `chunk.rs` | Cutting and reassembly, bounds of [MESH.md](MESH.md#chunks) |
| Link handshake | `handshake.rs` | `GMSH.2.1`: ephemeral key exchange, identity, trust round, clock offset |
| Link encryption | `seal.rs` | ChaCha20-Poly1305 per direction, replay window |
| Trust | `gossip-trust` | Proof of work at 12 bits; stake proofs are not verified on phones yet |
| Bridge | `upstream.rs` | The client API of [API.md](API.md) over HTTPS (`ureq`, rustls) |

The crate builds without PeerNet (so without `quiche` and cmake), the HTTP server, the
dashboard and the RISC Zero prover. `cargo tree -p gossip-mobile -e normal` lists none of
them.

## API

The UniFFI interface mirrors the app's `MeshCore` interface (Kotlin
`net.massa.gossip.mesh.MeshCore`, Swift `MeshCore`), method for method, so the app's
adapter is a direct mapping. Generated names: Kotlin package `net.massa.gossip.mesh.ffi`,
Swift module `GossipMobile`.

```kotlin
class MeshNodeCore() {
    fun start(dataDir: String, configJson: String, sink: MeshCoreSink)   // throws MeshException
    fun stop()
    fun linkUp(linkId: Int, mtu: Int)
    fun linkDown(linkId: Int)
    fun frameIn(linkId: Int, frame: ByteArray)
    fun sendBlob(kind: MeshBlobKind, key: ByteArray?, payload: ByteArray,
                 localOnly: Boolean = false): MeshSendResult             // throws
    fun fetch(seekers: List<ByteArray>): List<MeshKeyValue>
    fun fetchBulletin(cursor: String?, limit: Int): List<MeshBulletinItem>
    fun getKeys(hash: ByteArray): ByteArray?
    fun setWanted(seekers: List<ByteArray>, localSeekers: List<ByteArray> = listOf())
    fun setUpstream(urls: List<String>, bridgeEnabled: Boolean)
    fun status(): MeshCoreStatus
    fun forgetKeys(hash: ByteArray): Boolean
    fun lock()
    fun wipe(newConfigJson: String? = null)                              // throws MeshException
}

interface MeshCoreSink {                    // implemented by the app
    fun sendFrame(linkId: Int, frame: ByteArray): Boolean
    fun closeLink(linkId: Int)
    fun arrival(messages: List<MeshKeyValue>, announcements: List<ByteArray>)
}

enum class MeshBlobKind { MESSAGE, ANNOUNCEMENT, KEYS }
data class MeshKeyValue(val key: ByteArray, val value: ByteArray)
data class MeshBulletinItem(val counter: String, val data: ByteArray)
data class MeshSendResult(val id: ByteArray, val counter: String?)
data class MeshCoreStatus(
    val running: Boolean, val meshPeers: Int, val upstreamReachable: Boolean,
    val bridgeEnabled: Boolean, val bulletinCounter: String, val storedBlobs: Long,
    // beyond the app's MeshCoreStatus:
    val linksHandshaking: Int, val meshBlobs: Long, val uploadPending: Long,
    val wantedEntries: Long, val clockOffsetMs: Long, val peerId: String,
)
```

| Call | What it does |
|---|---|
| `start` | Opens `dataDir/mesh-pools.redb` (with its key file `mesh-pools.key`) and starts the engine, the radio writer and the bridge loop. A running node is stopped first. Fails on a bad configuration, a missing `pool_key_hex` (unless `allow_plaintext`), or a pools file it cannot open (the wrong `pool_key_hex`, or the file in use by another node) |
| `stop` | Stops every thread. Links are forgotten; the radio drops them |
| `linkUp` | The radio connected a link with ATT MTU `mtu`. The core starts the link handshake at once; chunks are at most `mtu − 3` bytes |
| `linkDown` | The radio lost the link |
| `frameIn` | One chunk received on a link. Chunks of one link must arrive in order; the core reassembles them |
| `sendBlob` | Stores, exactly as if a neighbour had relayed it (see [MESH.md](MESH.md#plausible-deniability)), a message (`key` = its 34-byte seeker), an announcement or a key set, and offers it to the mesh. The id is the 32-byte blob id; announcements also get their local counter. Refused blobs (bad signature, out of the time window, too large, a second value under a seeker) throw. With `localOnly` the blob is local-only: neither this phone (even when bridging) nor a bridge that relays it uploads it (see [MESH.md](MESH.md#local-only-blobs-and-seekers)). Swift: `sendBlob(kind:key:payload:localOnly:)`, `localOnly` defaulting to `false` |
| `fetch` | Every distinct value stored under each seeker, first stored first. The pools keep the first value (that copy is the one replicated); other values that reached the phone are kept beside it, at most 4 per seeker, so the session layer can pick the one that decrypts |
| `fetchBulletin` | Announcements after `cursor` (a counter from an earlier page, `null` from the start), at most `limit`. Counters are local to the phone |
| `getKeys` | A public key set by its blake3 hash (the user id) |
| `setWanted` | The seekers the app waits for (the list it would send to `POST /messages/fetch`). Replaces the previous list; the node advertises them on the mesh and pushes matching blobs through `arrival`. The list is kept in memory only: a restarted node waits for nothing until the app sets it again. `localSeekers` (default empty) are waited for only from the mesh: they are flooded flagged local-only, bridges do not fetch them upstream and neither does this phone. A seeker in both lists is regular |
| `setUpstream` | Internet nodes (API roots such as `https://api.usegossip.com/api`) and whether to bridge. Bridging means: upload the mesh blobs (those `sendBlob` stored too, which the node cannot tell from relayed ones), fetch wanted seekers, advertise a bridge beacon. Without bridging the upstream is only probed (`upstreamReachable`) |
| `status` | Counters. `meshPeers` counts links whose handshake completed. `peerId` is empty: every link has its own peer id |
| `forgetKeys` | Deletes the key set stored under `hash` (its blake3 hash, the user id), whoever sent it: the app withdraws the keys it shared nearby. Returns whether one was deleted; copies already relayed expire with the mesh retention |
| `lock` | The app locked: empties the wanted list and deletes the key sets given to `sendBlob` since the last lock (their hashes are kept in memory only). Nothing else: the app's other blobs carry no mark and stay to be delivered, and the node keeps relaying. The next session sets its own wanted list. See [MESH.md](MESH.md#plausible-deniability) |
| `wipe` | Destroys the key file first (overwritten, then deleted), then deletes the pools (and a wanted list saved by a development build). A running node restarts empty with the same sink and with `newConfigJson` when given, else the same configuration: pass the configuration with a fresh `pool_key_hex` so that nothing stays wrapped under the old key. Call `setUpstream` and `setWanted` again. A stopped node does nothing: the app deletes its data directory itself. Throws when the restart fails |

### What the core asks of the app

- `sendFrame(link, chunk)` queues one chunk. Returning `false` means the radio's queue is
  full: the core keeps the chunk and retries on that link with a backoff from 5 to 500 ms.
  Control messages (announces, asks, sync, handshake) are queued ahead of blobs on their
  own stream, so a long blob transfer never delays them; wanted lists share the blobs'
  queue.
- `closeLink(link)` asks the radio to drop a link: a failed or timed-out handshake (20 s),
  a refusal, the one of two links to the same phone that both ends drop, a link replaced
  for a newcomer, a chunk or encryption violation, a ban. The core stops using the link at once and ignores anything
  that still arrives on it, which covers the iOS peripheral that cannot disconnect a
  central: the link may stay up on the radio, unused.
- `arrival(messages, announcements)`: blobs for seekers on the wanted list and
  announcements, as soon as they are stored (from the mesh or fetched by the bridge), and
  later values of a wanted seeker. The app also finds them with `fetch` and
  `fetchBulletin`. It is called from a thread of its own (`gm-arrival`), never under a
  core lock, so the app may call the core from it.
- A callback that throws (a Kotlin or Swift exception, which reaches Rust as a panic) is
  caught and logged; it never ends a core thread. `sendFrame` throwing counts as
  `false`.

### Threads

Every method is thread-safe; the radio thread and the plugin may call concurrently.

| Thread | Does |
|---|---|
| Caller of `frameIn` | Reassembly and the handshake steps (proof of work at 12 bits takes well under a millisecond). May call `closeLink` |
| `gm-writer` | Calls `sendFrame`, closes links whose handshake timed out or whose refusal left |
| `gm-events` | Hands arrivals to `gm-arrival`; applies bans |
| `gm-arrival` | Calls `arrival` |
| `gm-bridge` | Every 10 s with an upstream: reachability; when bridging, also uploads, wanted fetches and the beacon |
| Engine (2) | Retrieval and propagation of `gossip-repl` |

Sink methods are called without any core lock held, but `sendFrame` and `closeLink` may
be called from inside `linkUp` and `frameIn` and must not block on the thread that calls
those. `start`, `stop` and `wipe` never interleave; `stop` called from inside a callback
returns without waiting for the thread it was called on.

## Configuration

`configJson` is a JSON object; every field is optional and an empty string means all
defaults.

| Field | Default | Meaning |
|---|---|---|
| `pool_key_hex` | none, required | 32-byte key (64 hex digits) wrapping the pools' data key. Take it from the app's secure storage; replacing it on wipe makes the erasure complete |
| `allow_plaintext` | false | Start without a key, pools in plaintext (tests and development only) |
| `max_links` | 8 | Links with a completed handshake |
| `max_low_trust_links` | 4 | Of those, to peers whose trust is below 0.2 |
| `pow_bits` | 12 | Proof of work offered and proved on mesh links |
| `mesh_retention_ms` | 72 h | Retention of mesh blobs |
| `mesh_max_bytes` | 64 MiB | Mesh storage |
| `mesh_max_blob_count` | 20 000 | Mesh blob count |
| `peer_id_rotation_ms` | 15 min | Lifetime of the duplicate token shown to peers (peer ids are fresh per link) |
| `min_replaced_link_age_ms` | 10 min | A full phone replaces only links at least this old for a newcomer |
| `link_replace_interval_ms` | 2 min | And at most once per this interval |
| `bridge_upload_per_min` | 600 | Upload pace of a bridge |
| `bridge_interval_ms` | 10 s | Bridge loop period |
| `upstream_timeout_ms` | 10 s | One upstream request |
| `guided` | true | Guided forwarding ([MESH.md](MESH.md#guided-forwarding)) |

Replication tuning is fixed to the phone values of [MESH.md](MESH.md#phone-defaults):
announces every second, at most 8 envelopes and 64 KiB per `Blobs`, sync pages of 512 ids.

Every blob that reaches a phone over the mesh is marked for upload, so a phone that walks
out of the area and gets internet bridges what it carried as soon as bridging is on.
Turning bridging on therefore uploads what the phone relayed in the last 72 hours; the
app's bridge setting should say so.

## Encryption at rest

The pools are encrypted and authenticated block by block (`crypt.rs`):

- A random data key encrypts the pools. It is stored in `mesh-pools.key`, wrapped
  (XChaCha20-Poly1305) by a subkey of `pool_key_hex`, together with a random file id.
- The pools file is a header (the logical length) and 4 KiB blocks, each sealed with
  XChaCha20-Poly1305 under a fresh random nonce, bound to the file id and its block index.
  Rewriting a page never reuses a keystream, and a changed, moved or zeroed block fails
  to read. Putting back an older copy of a block is not detected.
- Pools are opened without provenance (`received_at` 0, no source peer), so every blob is
  stored the same way whichever way it came.
- `wipe` overwrites and deletes the key file before anything else: what flash keeps of
  the pools no longer decrypts. Flash may keep an old copy of the key file too, so the
  erasure is complete only when the app also replaces `pool_key_hex` (for example a
  random key in the platform keystore, replaced on wipe).
- The pools file is locked while a node has it open; a second node on the same data
  directory fails to start.
- A pools file without a key file (an older format, or the leftovers of a wipe) is
  discarded at start.

## Building

```bash
scripts/build-mobile.sh android OUT_DIR   # OUT_DIR/jniLibs/<abi>/libgossip_mobile.so, OUT_DIR/kotlin
scripts/build-mobile.sh ios OUT_DIR       # OUT_DIR/GossipMobile.xcframework, OUT_DIR/swift (macOS)
```

- Android uses the NDK in `ANDROID_NDK_HOME`, or the newest under `$ANDROID_HOME/ndk`, API
  level 24, ABIs `arm64-v8a` and `x86_64` (`ABIS` overrides). The release `.so` for
  arm64 is about 6.7 MB.
- iOS builds the device and simulator static libraries and an xcframework. It needs
  macOS: the C and assembly of `blake3` and `ring` do not build for Apple targets on
  Linux, so the iOS build has not been run in CI here.
- Bindings come from the library itself (`uniffi-bindgen generate --library`, UniFFI
  0.31.0, the version the app already uses for secure storage).

## Tests

`cargo test -p gossip-mobile` runs the chunk, handshake and encryption unit tests, and
`tests/phones.rs`: phones wired through a fake radio (link handshake, a message, an
announcement and a key set across two phones; relaying along a chain of three;
duplicate links closed), a bridge against a small HTTP upstream (inside to outside and
outside to inside), uploads only when bridging, the app's blobs like the others, a sent
blob stored byte for byte like the same blob received from a link, a lock that leaves no
wanted seeker in any file (the decrypted pools included, free pages and all) while the
locked phone's message still reaches a bridge and the next session works as usual, a
store from a build that marked own blobs discarded, local-only blobs relayed two hops but
uploaded by nobody, local-only wanted seekers that no bridge (nor the phone itself) asks
upstream for, a wanted list kept in memory only, encryption at rest with `wipe`, link
replacement, a refused upload that does not block the others, a bridge that keeps only
the seekers it asked for, callbacks that throw, and one link carrying a long blob and a
burst of small messages.

## Known gaps

- Massa stake proofs and keyring proofs are not offered on phones yet; peers prove work
  only. Keyring support needs a way to provision keyrings from the app.
- The radio layer must implement service discovery and the central/peripheral roles of
  [MESH.md](MESH.md#roles-and-discovery); the core only sees links and chunks.
- Tor for upstream calls is not there yet.
