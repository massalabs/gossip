# Changelog

## 0.2.0

### Breaking changes

- `Queries.userProfiles.updateById(userId, data)` now returns
  `Promise<boolean>` instead of `Promise<void>`. It resolves to `true` when a
  profile row matched the user ID and `false` when no row existed. Callers that
  only await the operation can continue ignoring the result; typed wrappers and
  test doubles must adopt the boolean return contract.
- `GossipSdk.publicKeys` is a borrowed session-owned WASM wrapper. It is valid
  only while that session is open, becomes invalid when `closeSession()` or
  `destroy()` disposes the session, and must not be freed by callers. Code that
  needs serialized key bytes after logout must copy them before closing.
- Legacy biometric-only credentials and pre-password classic or secure-storage
  account state are intentionally not migrated by this release. Users upgrading
  from those formats must reset local app storage and create their accounts
  again; legacy import is not supported.

### Security and reliability

- Account passwords are mandatory and biometric login stores one password-only
  credential without account metadata.
- Onboarding rollback and transient/session key disposal preserve cleanup and
  ownership boundaries.
- Secure-storage allocation, cover traffic, namespace writes, SQL transactions,
  lock, flush, and close share durable recovery and FIFO ordering boundaries.
- Public-key publication preserves confirmed POST times across local persistence
  retries without redundant network publication.
