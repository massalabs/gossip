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
Core              MeshCore  ← StubMeshCore today, the Rust gossip-mobile node later
Radio             MeshRadio ← BleMeshRadio (Android) / CoreBluetoothMeshRadio (iOS)
```

- The **radio** only finds neighbours and moves chunks of at most `ATT MTU − 3` bytes.
  It reports `linkUp(linkId, mtu)`, `linkDown(linkId)` and `frameIn(linkId, bytes)`, and
  takes `sendFrame(linkId, bytes)` and `closeLink(linkId)`.
- The **core** does everything else: chunking and reassembly, the link handshake, trust,
  replication, the wanted list, the upstream bridge and storage.
- The **bridge** joins the two for the whole process.

### Swap point for the Rust node

`MeshCoreFactory.create` (Android `mesh/MeshCore.kt`, iOS `plugins/meshNode/MeshCore.swift`)
returns `StubMeshCore`. Once `gossip-mobile` ships its UniFFI bindings, return an adapter
over them there; nothing else refers to the stub. The stub keeps what the app sends in
memory and answers fetches from it, but does not speak on links.

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

1. Build with `VITE_MESH=true`. Without it the mesh code is never started.
2. Turn it on for the user with `setMeshEnabled(true)` from `services/meshNode.ts`. The
   settings screen will do this; until then, call it from the console of a dev build.
3. At the next start, `main.tsx` starts the node and gives the SDK a
   `CompositeMessageProtocol` of REST then mesh. If the node cannot start (no permission,
   no Bluetooth), the app runs on REST alone.

Bridging (uploading mesh blobs to the internet node) is off until the user opts in.
