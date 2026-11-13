# Offline mesh node

The Rust node that runs inside the phone app and moves Gossip blobs between phones over
Bluetooth Low Energy. `gossip-mobile` is the node and its UniFFI surface; the other
crates are what it is built from. The native layers that drive it are described in
[OFFLINE-MESH.md](../../OFFLINE-MESH.md).

| Crate           | Role                                                              |
| --------------- | ----------------------------------------------------------------- |
| `gossip-mobile` | The node: link handshake and encryption, chunks, bridge, bindings |
| `gossip-repl`   | Blob replication over any link, wanted seekers, guided forwarding |
| `gossip-pools`  | The stored pools (bulletin, key-value, hash) on redb              |
| `gossip-trust`  | Trust between phones on a link: policy, registry, proof of work   |
| `gossip-wire`   | Wire types, ids and bounded (de)serializers                       |

## Where this code comes from

It is copied from the gossip-node repository, branch `mesh/node`, commit `bd30315`.
That repository also holds the internet node, which this application does not use: the
phones talk to the Gossip API over HTTP, and to each other over Bluetooth.

Only what the phone build needs is here. Compared with the original crates:

- the crates outside `gossip-mobile`'s dependencies are left out (`gossip-net`,
  `gossip-api`, `gossip-node`, `gossip-sim`, `gossip-trust-social`,
  `gossip-trust-stake`, `gossip-stake-methods`);
- `gossip-wire` has no `peernet` feature: the PeerNet trait implementations are
  removed, `TransportType` is always the local type, and `PeerId::generate` is an
  inherent function;
- `gossip-trust` has no `explain` module and no `allowlist` and `noop` schemes;
- `gossip-mobile` has no `uniffi-bindgen` binary: the workspace's `uniffi-bindgen`
  crate generates the bindings;
- the crates are members of the `wasm/` workspace: they take their shared dependencies
  and their lockfile from it, and declare edition 2021 themselves;
- the client fixture one `gossip-pools` test reads is copied to
  `gossip-pools/tests/fixtures/`.

`docs/MESH.md` (the mesh protocol, its threat model and defaults) and `docs/MOBILE.md`
(the node's API and settings) are copied unchanged. Their links to other documents of
that repository (`API.md`, `WIRE-PROTOCOL.md`, `SIMULATION.md`, `MESH-PLAN.md`) do not
resolve here. Where they describe the internet node a bridge uploads to, read the Gossip
API, version 2: it serves the same client contract.

The link protocol is unchanged (`GMSH.2.1`), so a phone built from this copy and one
built from the original crates talk to each other.

## Rust version

The crates need Rust 1.98 or newer and say so in their manifests (`rust-version`), so an
older compiler refuses to build them. This is not a formality: the node locks its storage
file with `File::try_lock`, which the standard library only implements for Android from
1.98. Built with an older compiler, the library loads but the node never starts on a
phone, and reports "the pools file is in use".

## Building and testing

The app build compiles the node for Android and iOS (see OFFLINE-MESH.md). To work on
the crates alone:

```bash
cargo test --manifest-path wasm/Cargo.toml \
  -p gossip-wire -p gossip-trust -p gossip-repl -p gossip-pools -p gossip-mobile
```
