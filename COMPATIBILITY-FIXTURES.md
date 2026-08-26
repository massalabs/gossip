# Compatibility fixtures

`COMPATIBILITY-FIXTURES.sha256` freezes every released Phase 3 compatibility artifact whose exact
bytes carry a persisted meaning. CI verifies both the hashes and complete manifest coverage.

## Covered artifacts

- every numbered SQL migration in `gossip-sdk/drizzle` and the exact append-only journal indices;
- the portable V1 archive in
  `wasm/secure-storage/tests/fixtures/portable-v1-minimal.gossipbackup`;
- the SessionManager V1 envelope in `wasm/sessions/tests/fixtures/session-manager-v1.bin`; and
- the public account-security V1 vector in `test/fixtures/profileSecurityV1.ts`.

The account-security vector fixes the password KDF, mnemonic encryption, identity derivation, and
expected Gossip, EVM, and Massa identities. It is deliberately public test data, never live user
material.

## Update policy

Do not edit a released migration or regenerate a frozen format fixture to accommodate an incompatible
implementation change. A compatible implementation must continue decoding the old bytes unchanged.
An incompatible change requires a new version, a frozen decoder for the old version, and explicit
migration or rejection tests before adding a new fixture.

Adding a new numbered SQL migration or emitted persisted format requires adding its path and SHA-256
to the manifest. The coverage test intentionally fails when a migration is added without a hash.

To verify the manifest locally:

```sh
npx vitest run --project=node test/compatibility/fixtureHashes.node.spec.ts
```

The behavioral tests remain authoritative: hashes prevent silent fixture edits, while Rust and
browser suites prove decoding, migration lineage, malformed-version rejection, rollback, atomic
replacement, and interruption recovery.
