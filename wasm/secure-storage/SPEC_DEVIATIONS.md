# Spec deviations

Implementation differences from the [bordercrypt spec](https://github.com/massalabs/gossip/discussions/380).

## SESSION_COUNT = 3 (spec: 5)

Reduced for mobile performance — each block write triggers SESSION_COUNT PQ
rerandomizations. 3 slots provides 2 decoy sessions per real session.

## Root domain: `secureStorage` (spec: `bordercrypt`)

Historical rename. All domain strings use `{domain}:secureStorage:...` instead
of `{domain}:bordercrypt:...`.

## Namespace extension

Block scopes include `:n{namespace}` (e.g. `...session:v0:i0:n0:b5`) which is
absent from the spec. This enables multiple independent block streams per
session (namespace 0 for the DB, namespace 1 for the session blob, etc.).
The namespace byte is also injected as a KDF input_item for defense-in-depth.

## Unlock does not cache total_data_length

The spec's `unlock_session` reads block 0 to cache `total_data_length`.
The implementation separates this into `unlock_session` (returns keys only) +
`load_namespace_state` (reads block 0 per namespace). This supports the
multi-namespace extension.
