# Changelog

## 0.4.0

### Breaking changes

- Adding a contact no longer creates a chat. A contact request carries no chat
  and no message timer; either side starts a chat afterwards with
  `conversations.startDirectChat()`.
- A contact request is always shown to the other person, whatever their own
  record of the sender is.
- A send resolves as soon as the first transport has taken the message. It no
  longer waits for the backend. A message carried only by the mesh is posted to
  the backend later.
- The mesh service UUID carries the mesh version in its last byte. Devices on
  an earlier build do not join this mesh.

### Added

- `conversations.addAsContact()`: makes a chat member a contact on this device
  only. Nothing is sent.
- `conversations.sendContactRequest()`: sends an ordinary contact request to a
  contact added on this device whose connection has lapsed.
- `conversations.declineContactRequest()`.
- `groups.sendMessage()` and `groups.editMessage()` accept an `author`: the
  message or the edit is published under another member's name, the way a
  relayed one is.
- `groups.sendMessageLocally()`: a message on this device only, also in a chat
  the device can only read.
- `groups.archived()` and `groups.setArchived()`: a mark on this device only.

See `docs/plausibly-deniable-group-chats.md` for the reasons and the known
limits.

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
- Secure-storage onboarding now requires the atomic candidate lifecycle exposed
  by `secureStorageBeginOnboardingCandidate()`,
  `secureStorageCommitOnboardingCandidate()`, and
  `secureStorageAbortOnboardingCandidate()`. Every created account must be
  locked before one final commit or abort, and commit/abort reject with
  `SESSION_OPEN` while an SDK session remains open. Fresh stores also require
  versioned backend account-generation metadata.

### Security and reliability

- Account passwords are mandatory and biometric login stores one password-only
  credential without account metadata.
- Onboarding and portable import commit the same source-neutral generation
  record with a fresh random epoch for idempotent encrypted-account migration.
- Onboarding prepares all accounts and fresh cover slots in a bounded in-memory
  candidate, then installs the complete three-slot generation atomically.
  Process death before activation exposes no account; death after activation
  preserves the whole batch.
- Onboarding rollback and transient/session key disposal preserve cleanup and
  ownership boundaries.
- Secure-storage allocation, cover traffic, namespace writes, SQL transactions,
  lock, flush, and close share durable recovery and FIFO ordering boundaries.
- Public-key publication preserves confirmed POST times across local persistence
  retries without redundant network publication.
