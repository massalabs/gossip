# Offline mesh: native layer

The offline mesh lets phones exchange Gossip blobs over Bluetooth Low Energy when there
is no internet. The protocol, the node and its defaults are specified in the
gossip-node repository (`docs/MESH.md`, `docs/MESH-PLAN.md`). This file describes the
app side: the native plugin, its layers, and how to turn it on.

## Layers

```text
App (TS)          services/meshNode.ts ── MeshNodeProtocol + CompositeMessageProtocol (gossip-sdk)
                         │ Capacitor plugin "MeshNode"
Native plugin     MeshNodePlugin (Kotlin / Swift)
                         │
Bridge            MeshNodeBridge ── radio events → core (one ordered queue)
                         │          plugin calls → core (another queue)
Core              MeshCore  ← RustMeshCore (gossip-mobile) when built in, else StubMeshCore
Radio             MeshRadio ← BleMeshRadio (Android) / CoreBluetoothMeshRadio (iOS)
```

- The **radio** only finds neighbours and moves chunks of at most `ATT MTU − 3` bytes.
  It reports `linkUp(linkId, mtu)`, `linkDown(linkId)` and `frameIn(linkId, bytes)`, and
  takes `sendFrame(linkId, bytes)` and `closeLink(linkId)`.
- The **core** does everything else: chunking and reassembly, the link handshake, trust,
  replication, the wanted list, the upstream bridge and storage.
- The **bridge** joins the two for the whole process.

### The Rust node and the stub

`MeshCoreFactory.create` (Android `mesh/MeshCore.kt`, iOS `plugins/meshNode/MeshCore.swift`)
returns `RustMeshCore`, an adapter over the `gossip-mobile` UniFFI bindings, when the
build includes them, and `StubMeshCore` otherwise. The stub keeps what the app sends in
memory and answers fetches from it, but does not speak on links, so a checkout of this
repository alone still builds and runs.

`gossip-mobile` lives in the gossip-node repository. The build looks for it at
`$GOSSIP_NODE_DIR`, else `../gossip-node` next to this repository.

- **Android.** When the crate is found, Gradle adds the `meshffi` source set
  (`android/app/src/meshffi/java/…/RustMeshCore.kt` and the generated bindings) and runs
  `buildRustMeshCore` before `preBuild`. That task calls
  `scripts/build-mesh-android.sh`, which builds `libgossip_mobile.so` into `jniLibs` and
  the Kotlin bindings (package `net.massa.gossip.mesh.ffi`) into
  `android/app/src/meshffi/generated`, both gitignored. It uses its own Cargo target
  directory (`android/app/build/gossip-mobile-target`, or `$GOSSIP_MOBILE_TARGET_DIR`).
  `GOSSIP_MESH_STUB=1` forces the stub. The factory finds `RustMeshCore` by name, so the
  main source set never depends on the bindings.
- **iOS (macOS only).** `scripts/build-mesh-ios.sh` builds a static-library
  `GossipMobileFFI.xcframework` and the Swift bindings into `ios/App/GossipMobile/generated`
  (gitignored). Then `pod install`: the Podfile adds the local `GossipMobile` pod only
  once those files exist. It is a separate Swift module because its types share names
  with the app's; `RustMeshCore.swift` is compiled only under `canImport(GossipMobile)`.

`wipe` restarts the Rust node empty, upstream and wanted list included; the adapter
applies them again. The node may call `closeLink` from inside `linkUp` and `frameIn`.

The core must provide, beyond the plugin API (`start`, `stop`, `sendBlob`, `fetch`,
`fetchBulletin`, `getKeys`, `setWanted`, `setUpstream`, `status`, `wipe`):

- `linkUp`, `linkDown` and `frameIn`, called in order from one thread;
- a sink it calls back: `sendFrame` (which may refuse when a link's queue is full),
  `closeLink` (to drop a duplicate peer id or a failed handshake, since both phones may
  connect to each other), and `arrival` (blobs for wanted seekers and relayed
  announcements, which the app feeds to `ingestMessages` and `ingestAnnouncements`);
- chunks no larger than `mtu − 3` for each link, with the `mtu` given in `linkUp`.

## BLE identifiers

| Item                                            | Value                                  |
| ----------------------------------------------- | -------------------------------------- |
| Service UUID                                    | `6a8b2f40-5c1d-4e2a-9b7f-3d0c8e1a5f60` |
| Characteristic (write without response, notify) | `6a8b2f41-5c1d-4e2a-9b7f-3d0c8e1a5f60` |
| ATT MTU requested (Android)                     | 517                                    |
| Links per phone, both roles                     | 8                                      |

The UUID is fixed on purpose: iOS only discovers peers in the background by exact UUID.
It also tells a scanner nearby that the phone runs Gossip, which is why the mesh is opt-in.

## Neighbour choice and power modes

A phone in a crowd hears far more neighbours than it can link to. Candidates above
−95 dBm are picked at random, never by signal strength alone, which would build clusters
of nearby phones that only hear each other. When every slot is taken and someone new is
waiting, one link older than the rotation interval is dropped for a new neighbour, and
the dropped peer is not picked again for a minute.

| Mode                 | Scan on / off | Rotation |
| -------------------- | ------------- | -------- |
| `performance`        | 10 s / 2 s    | 1 min    |
| `balanced` (default) | 5 s / 10 s    | 2 min    |
| `power_saver`        | 3 s / 30 s    | 5 min    |

These are starting values; the node's simulation is where they get tuned.

## Platforms

**Android** (`android/app/src/main/java/net/massa/gossip/mesh/`)

- `MeshService` is a foreground service of type `connectedDevice`. It keeps the radio on
  with the app in the background, and the system restarts it after a kill with the last
  configuration. Relaying needs no keys, so it works with the app locked.
- Permissions: `BLUETOOTH_SCAN` (`neverForLocation`), `BLUETOOTH_ADVERTISE` and
  `BLUETOOTH_CONNECT` on Android 12 and later; `ACCESS_FINE_LOCATION` before, where BLE
  scanning required it. `MeshNode.start` asks for them.
- The node's store (`files/mesh`) is excluded from backups and device transfer.

**iOS** (`ios/App/App/plugins/meshNode/`)

- Background modes `bluetooth-central` and `bluetooth-peripheral`, with state
  restoration for both managers. `MeshNodePlugin.load()` restarts the node and the radio
  at launch when the mesh was on, so a background relaunch by CoreBluetooth finds them.
- In the background iOS moves the advertised UUID to its overflow area and slows
  scanning: two backgrounded iPhones find each other poorly. The mesh works best with
  the app open.
- A peripheral cannot disconnect a central on iOS, so rotation only drops links this
  phone opened as central, and closing a link opened by the other phone only stops using it.
- The store (`Application Support/mesh`) is excluded from backups.

## Turning it on

The mesh is offered on Android and iOS unless the build hides it with `VITE_MESH=false`,
and it is off until the user turns it on in **Settings → Offline mesh**
(`pages/settings/MeshSettings.tsx`):

- **Offline mesh** asks for the Bluetooth permissions, starts the node and puts it in the
  SDK's transports at once. `main.tsx` always builds a `CompositeMessageProtocol` of
  REST then a switchable mesh member, which fails every call while the mesh is off, so
  turning it on or off needs no restart. If the node cannot start (permission refused, no
  Bluetooth) the toggle stays off and says why. The choice is remembered: the app starts
  the node at launch, and on Android `BootReceiver` restarts `MeshService` after a reboot
  with the configuration and upstream it last used.
- **Bridge to the internet** (off by default) lets the node upload other phones' mesh
  blobs and fetch their wanted seekers when it has internet.
- **Power mode** sets the radio's duty cycle.
- **Prepare for a strike** (`MeshPrepareSettings.tsx`) is a checklist: mesh on, sessions
  active with every contact, battery optimisation off (Android) or the app kept open
  (iOS), how to add someone offline, and the keyring note.

Both toggles carry the privacy warnings: a phone with the mesh on advertises a fixed
Gossip service UUID, and a bridge uploads other people's traffic from its own connection.

### In the conversation

- An outgoing message that only the mesh took (no internet node did) is stored with
  `metadata.via = 'mesh'` and shows a Bluetooth mark next to its ✓ until it is delivered.
  The composite tells the message service which transports took each send
  (`takeAcceptedBy`).
- An incoming message read more than 10 minutes after its sender dated it, or that the
  session flagged `stale`, is stored with `metadata.delayed = true` and shows "delayed".

### Adding someone without internet

The app publishes its own public keys to the mesh's key pool when a session opens with
the mesh on. Resolving a scanned or typed user id asks the server and, with the mesh on,
the mesh at the same time; the first answer wins. The key pool is indexed by
`blake3(keys)`, which is the user id, and `fetchKeysFromMesh` checks the keys against the
id again before using them.
