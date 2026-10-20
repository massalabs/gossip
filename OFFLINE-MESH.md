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
repository alone still builds and runs. A build with the stub hides the mesh: at launch
`probeMeshAvailability` asks the plugin's `capabilities()` whether the Rust node is there,
and without it the settings say the mesh is unavailable and the radio never starts.
Release builds refuse the stub: Gradle fails a release task without `gossip-mobile`
unless `GOSSIP_MESH_OPTIONAL=1`, and Swift fails a non-debug build without the
`GossipMobile` module unless `GOSSIP_MESH_OPTIONAL` is an active compilation condition.

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
`fetchBulletin`, `getKeys`, `setWanted`, `setUpstream`, `status`, `wipe`, `forgetKeys`
and `lock`, see [Plausible deniability](#plausible-deniability)):

- `linkUp`, `linkDown` and `frameIn`, called in order from one thread;
- a sink it calls back: `sendFrame` (which may refuse when a link's queue is full),
  `closeLink` (to drop a duplicate peer id or a failed handshake, since both phones may
  connect to each other), and `arrival` (blobs for wanted seekers and relayed
  announcements, which the app feeds to `ingestMessages` and `ingestAnnouncements`);
- chunks no larger than `mtu − 3` for each link, with the `mtu` given in `linkUp`.

Links speak `GMSH.2.1`: the Rust core encrypts every link after its first message and
gives each link a fresh peer id, so the radio moves opaque chunks and never looks inside
them. `status().peerId` is always empty and the app does not use it.

### Pool key and wipe

The node keeps other people's traffic and refuses to start without a key for its pools
(`pool_key_hex`, 32 bytes). The native layer draws one per installation and adds it to
the configuration each time the core starts; the configuration it remembers for restarts
never holds it.

- **Android** (`MeshPoolKey.kt`): the key is wrapped by a non-exportable AES-GCM key of
  the Android Keystore and kept in `GossipMeshPrefs`, which backups and device transfer
  exclude.
- **iOS** (`MeshPoolKey` in `MeshNodeBridge.swift`): a Keychain item with
  `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` (readable when CoreBluetooth
  relaunches the app in the background, never in a backup or a migration), not
  synchronizable.

If the key is lost (Keystore reset), a new one is drawn and the old pools, which no
longer open, are deleted. `wipe` replaces the key: the node destroys its key file and
pools and restarts under the new key (`wipe(newConfigJson)`), so nothing is left wrapped
under the old one. A node that is not running has its data directory deleted instead, so
deleting every account wipes the mesh whether it is on or off. A wipe whose restart fails
leaves the node stopped and its directory empty. Only deleting every account wipes the
node; a lock or another account does not need it (see
[Plausible deniability](#plausible-deniability)).

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
- The node's store (`files/mesh`) and the mesh switches (`GossipMeshPrefs.xml`, which
  also holds a random install id) are excluded from backups and device transfer, so a
  restored phone does not restart the mesh on its own.
- Other phones may open at most 4 of the 8 links, and a central whose link closed waits
  60 s before it may connect again. Long (prepared) writes and writes at an offset are
  refused. A link with more than 512 KiB received but not yet read by the core is closed.
- BLE addresses are not logged.

**iOS** (`ios/App/App/plugins/meshNode/`)

- Background modes `bluetooth-central` and `bluetooth-peripheral`, with state
  restoration for both managers. `MeshNodePlugin.load()` restarts the node and the radio
  at launch when the mesh was on, so a background relaunch by CoreBluetooth finds them.
- In the background iOS moves the advertised UUID to its overflow area and slows
  scanning: two backgrounded iPhones find each other poorly. The mesh works best with
  the app open.
- A peripheral cannot disconnect a central on iOS, so rotation only drops links this
  phone opened as central, and closing a link opened by the other phone only stops using it.
  Such a central is then ignored for 60 s if it subscribes again, and other phones may hold
  at most 4 of the 8 links. Writes at an offset are refused, and a link with more than
  512 KiB received but not yet read by the core is closed.
- The store (`Application Support/mesh`) and the install id file (`mesh-install-id`) are
  excluded from backups. The "mesh on" switch holds the install id it was set on, so a
  restored phone does not restart the mesh on its own.

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
  blobs and fetch their wanted seekers when it has internet. The consent is saved with the
  native install id, so a phone restored from a backup is asked again.
- **Power mode** sets the radio's duty cycle.
- **Prepare for an offline event** (`MeshPrepareSettings.tsx`) is a checklist: mesh on,
  sessions active with every contact, battery optimisation off (Android) or the app kept
  open (iOS), auto-lock, and how to add someone offline.

Both toggles carry the privacy warnings: a phone with the mesh on advertises a fixed
Gossip service UUID, and a bridge uploads other people's traffic from its own connection.

### In the conversation

- An outgoing message that only the mesh took (no internet node did) is stored with
  `metadata.via = 'mesh'` and shows a Bluetooth mark next to its ✓ until it is delivered.
  The composite tells the message service which transports took each send
  (`takeAcceptedBy`). The row keeps its ciphertext, in the account's own storage, and
  every refresh round posts it to the server once one answers (`repostMeshOnly`, with
  `internetOnly` routing, which the mesh never sees); then `via` goes and the ciphertext
  with it. The node no longer uploads the phone's own blobs unless it bridges (it cannot
  tell them from relayed ones), so this is what gets a message out when the phone, not a
  bridge, reaches the internet. An announcement only the mesh took stays queued the same
  way, flagged `internetOnly`, without its addressed copy.
- An incoming message read more than 10 minutes after its sender dated it, or that the
  session flagged `stale`, is stored with `metadata.delayed = true` and shows "delayed".

### Adding someone without internet

In person, the contact code of **Share contact → In person** carries the keys
themselves, over an animated QR code or Bluetooth, so neither phone needs the
mesh, the internet or published keys ([CONTACT-EXCHANGE.md](CONTACT-EXCHANGE.md)).
The contact request and its acceptance then travel over the mesh like any
announcement.

The app never puts its keys on the mesh. An earlier "Let people nearby add me"
switch did, for 10 minutes, and was removed: key sets spread to the whole mesh,
tying the phone to its user id for anyone who received them. A typed or invited
user id is resolved through the server only.

Without internet, someone outside cannot start a new conversation with someone
inside: contact requests sit on the server's public board, which bridges do not
bring into the mesh (they fetch only wanted seekers). Messages between existing
contacts do cross a bridge both ways.

### What stays on the mesh

Lookahead seekers and addressed re-announcements exist for the mesh only. They are put
on the wanted list, and addressed re-announcements are posted and fetched, only while
the mesh is on, through `meshOnly` routing, which the REST transport refuses. An
addressed re-announcement mailbox moves every 6 hours and holds the announcement
encrypted under a key of the pair, so its bytes differ from the board copy.

The node keeps them off the internet too:

- A `meshOnly` send becomes `sendBlob({ …, localOnly: true })`: the blob is local-only,
  so neither this phone nor a bridge that relays it uploads it, and the SDK never reposts
  it to a server.
- Lookahead and mailbox seekers go to `setWanted({ seekers, localSeekers })` as
  `localSeekers` (`setWantedSeekers(seekers, localSeekers)` in the SDK, which gives the
  second list to mesh transports only): they are flooded flagged local-only, and no bridge,
  nor this phone, asks an internet node for them.

The flag is honoured by honest phones and bridges; a modified one can ignore it and
upload what it relays (gossip-node `docs/MESH.md`, "Local-only blobs and seekers"). The
mailbox rotation and the separate ciphertext still limit what that reveals.

## Plausible deniability

The app can hold several accounts, one of them a decoy. The threat: someone arrested is
made to unlock the phone and to give a Gossip password, and gives the decoy's. Whoever
holds the phone can then run the app as its owner, use its keystore keys, and copy every
file it owns. The account storage is already deniable (release builds use
`VITE_SECURE_STORAGE`). The mesh part must add nothing: once Gossip has been locked, by
hand, by auto-lock or from the notification, nothing in it may show that another
account exists; and a decoy opened while the mesh runs must use it as if it were the
only account, with no wipe, restart or delay.

What the node holds (gossip-node `docs/MESH.md`, "Plausible deniability"):

- **No mark on the phone's own blobs.** `sendBlob` stores a blob exactly as a neighbour's
  relayed copy would be stored: same scope, same trust bucket, no arrival time, no source.
  A phone uploads mesh blobs only when it bridges; the SDK posts its own messages to the
  server itself (see [In the conversation](#in-the-conversation)), from the account's
  storage, and only while that account is open.
- **The wanted list in memory only.** Nothing writes it to disk; the file development
  builds kept is overwritten and deleted at start.
- **A lock** (`MeshNode.lock`, `lock()` on the node) empties the wanted list and deletes
  the key sets shared nearby. The rest stays: the phone keeps relaying, what the account
  sent is still delivered, and what arrives for it waits on this phone and the phones
  nearby until it opens again and asks.

What the app does:

- Every lock, logout or account change calls `lockMesh` (the SDK's `closeSession` has
  emptied the wanted list already). Opening any account just uses the running node: the
  session sets its own wanted list and sends as usual. `wipeMesh` is for deleting every
  account only. The `gossip-mesh-owner` preference of development builds (a user id in
  the clear) is deleted at startup.
- **Auto-lock in the background.** The WebView's JavaScript is paused while the app is in
  the background or the screen is off, so the JS auto-lock (`useAutoLock`) only acts when
  someone opens the app. The app tells the native side the timeout while an account is
  open (`AppLock.configure`); auto-lock is 5 minutes by default (a choice made before
  stays).
  - **Android** (`AppLock.kt`): going to the background arms an alarm on the elapsed
    clock (`setExactAndAllowWhileIdle`, `ELAPSED_REALTIME_WAKEUP`: it counts deep sleep
    and fires in Doze; without the exact-alarm grant, `setAndAllowWhileIdle`, which Doze
    may defer); coming back disarms it, or locks before the window shows when the time
    has passed. The alarm wakes the process whether the mesh is on or off. A lock locks
    the node (`MeshNodeBridge.lockNode`), locks the account storage natively
    (`lockSession` on the secure-storage queue), and finishes the app's tasks
    (`AppTask.finishAndRemoveTask`): the WebView is destroyed with everything decrypted in
    it, the task leaves Recents, and the next open starts the app afresh on the login
    screen. The process lives on while the mesh service runs.
    Destroying the WebView was chosen over an event to the paused page because a paused
    page may not run it. Screenshots and the Recents thumbnail are already blocked
    (`FLAG_SECURE`, through the privacy-screen plugin, on unless turned off in the debug
    settings).
  - The mesh notification has a **Lock** action that does the same without opening the
    app.
  - **iOS** (`AppLockPlugin.swift`): iOS suspends a backgrounded app within seconds, so no
    timer is sure to fire. The plugin checks the deadline (on `CLOCK_MONOTONIC`, which
    counts sleep) every 10 s while the app runs (a background task, or the mesh's
    Bluetooth background modes waking it) and before the app comes back to the
    foreground; a lock locks the node and the storage natively and reloads the WebView.
    A suspended app that nothing wakes is locked when it is next opened, before its UI
    shows, not at the deadline. There is no notification on iOS, so no Lock action.

Limits:

- **Timing.** Until the lock, the account is open: someone who takes the phone within the
  timeout, unlocked, gets the open account. The settings tell users to keep auto-lock at
  5 minutes, to let 5 minutes pass (or lock from the notification) before handing the
  phone over, and to set biometric login to the decoy's password.
- **Memory.** A lock drops the wanted list and the shared keys' hashes, the native
  storage keys and the WebView, but freed memory is not zeroed; a memory image of the
  running phone taken soon after may still hold them.
- **iOS** locks late when the app stays suspended (above), and the native code there has
  not been built on this branch (no macOS here).
- **Messages not yet on the server** wait in the account's storage, encrypted with it,
  until the account opens with a server in reach. A message a bridge uploaded first is
  posted again, and the server keeps the copy it has (an identical one, or `409` for
  another value at the seeker, which also ends the retries).
- **A phone without a decoy**, or a modified app, is outside this: the property is that
  locked Gossip shows nothing, not that an open one hides anything.
- **Neighbours** saw this phone send blobs first and advertise its seekers while the
  account was open; that is an observation made in radio range, outside the phone.
