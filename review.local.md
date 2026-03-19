# PR #483 Review — Fixes Needed

## Security

### 1. Pending credentials not cleared on error

**File:** `src/stores/pendingAccountSetup.ts`
**Issue:** Passwords held as plaintext strings in module-level variable. If the setup flow errors and `clearPendingMainCredentials()` is never called, they linger indefinitely in memory.
**Fix:** Add a safety timeout or call `clearPendingMainCredentials()` in a `finally` block in `PlausibleDeniabilitySetup.createAccounts()`.

- [ ] Fixed

### 2. Hidden account session blob never persisted

**File:** `src/stores/accountStore.tsx` — `createHiddenAccount`
**Issue:** Uses `onPersist: async () => {}` — a no-op. If any operation between `openSession()` and `closeSession()` calls `markDirty()` + `persistIfNeeded()`, the session state is silently lost.
**Fix:** Either pass a real `onPersist` or add a comment explaining why it's safe (e.g., "session is closed immediately after, `closeSession()` handles final persist").

- [ ] Fixed

### 3. InitErrorScreen IDB cleanup doesn't touch OPFS

**File:** `src/components/InitErrorScreen.tsx`
**Issue:** "Clear data & reload" deletes `gossip-*` IDB databases but leaves OPFS bordercrypt blocks/keypairs orphaned. On next launch, bordercrypt finds existing data and expects unlock, but the IDB state is gone.
**Fix:** Also clear OPFS directory (`navigator.storage.getDirectory()` → remove `gossip-db`), or document why it's not needed.

- [ ] Fixed

---

## Correctness

### 4. Write coalescing merge — byte alignment for non-page-aligned chunks

**File:** `gossip-sdk/src/db/bordercrypt-vfs.ts` — `flushDirtyPages()`
**Issue:** The merge loop concatenates chunks sequentially (`pos += chunk.byteLength`) but doesn't account for gaps within a "contiguous" range. If `offset <= rangeEnd` but `offset > rangeStart + sum(prevChunks)`, the merged buffer has incorrect byte positioning.
**Fix:** Use absolute offsets relative to `rangeStart` when placing chunks into the merged buffer:

```ts
merged.set(chunk, chunkOffset - rangeStart);
```

- [ ] Fixed

### 5. Fire-and-forget send — failed messages shown as SENT forever

**File:** `src/stores/messageStore.tsx` — `sendMessage`
**Issue:** `void (async () => { ... })()` — if `sdk.messages.send()` throws, the optimistic message stays in the store as `SENT` with a negative ID. No retry, no error indicator. User sees a delivered message that never left the device.
**Fix:** On send failure, update the optimistic message status to a visible error state, or remove it from the store and show a toast.

- [ ] Fixed

### 6. Optimistic message matching — false positive on duplicate content

**File:** `src/stores/messageStore.tsx` — `isConfirmed()`
**Issue:** Uses content + direction + 5s timestamp window. If user sends the same message twice within 5 seconds, the second DB confirmation could match the first optimistic message.
**Fix:** Add `messageId` to the matching criteria, or use the SDK-returned `messageId` from `send()` result to tag the optimistic message.

- [ ] Fixed

### 7. Discussion lookup removed from sendMessage fast path

**File:** `gossip-sdk/src/services/message.ts` — `sendMessage`
**Issue:** The discussion existence check was removed. If the discussion was deleted between the UI action and the send, the fast path encrypts and POSTs to a peer with no discussion record.
**Fix:** Re-add the discussion lookup, or validate it exists before entering the fast path.

- [ ] Fixed

### 8. Test assertion weakened

**File:** `gossip-sdk/test/integration/discussion-flow.spec.ts:1644`
**Issue:** `toBeGreaterThan` → `toBeGreaterThanOrEqual` to fix timing flakiness. The fix papers over a race rather than fixing the test setup.
**Fix:** Capture `now` after `updateState()` completes, or use `Date.now() - 1` before the call. Keep the strict assertion.

- [ ] Fixed

---

## Reliability

### 9. Optimistic discussion add — no rollback on failure

**File:** `src/hooks/useContactForm.ts`
**Issue:** `optimisticAddDiscussion` adds to store and navigates immediately. If `gossip.contacts.add()` fails, the discussion remains in the store. `toast.error()` fires but the phantom discussion is never removed.
**Fix:** On failure, remove the optimistic discussion from the store.

- [ ] Fixed

### 10. Optimistic accept — no rollback on failure

**File:** `src/hooks/useDiscussionList.ts`
**Issue:** `optimisticAcceptDiscussion` sets status to Active immediately. If `gossip.discussions.accept()` fails, the discussion shows as active but isn't.
**Fix:** On failure, revert the session status.

- [ ] Fixed

### 11. dbLock drain via getCount() is fragile

**File:** `src/stores/accountStore.tsx` — `createHiddenAccount`
**Issue:** `sdk.profiles.getCount()` in a try-catch to drain pending DB queries before slot switch. If the DB returns an error for a different reason, it's silently swallowed.
**Fix:** Add a dedicated `awaitDbIdle()` or `dbLock.then()` method, or at minimum add a comment explaining why this hack is acceptable.

- [ ] Fixed

---

## Code Quality

### 12. Biometric auth removed entirely

**File:** `src/pages/Login.tsx`
**Issue:** Biometric auth code is completely deleted, not guarded behind storage type. Users who set up biometric auth before this change lose access to it. If bordercrypt is the only storage path going forward, this is fine — but it's a breaking change for existing users.
**Fix:** If intentional, document the migration path. If not, guard biometric code behind `!sdk.needsUnlock` or storage type check.

- [ ] Fixed / Acknowledged

### 13. Dev account picker commented out

**File:** `src/pages/Onboarding.tsx`
**Issue:** 15 lines of commented-out code for the dev account picker. Dead code.
**Fix:** Delete it or put it behind a feature flag.

- [ ] Fixed

### 14. Duplicate send logic in fast path vs stateUpdate

**File:** `gossip-sdk/src/services/message.ts`
**Issue:** The fast path (serialize → encrypt → send → update SENT) duplicates logic that `stateUpdate` also handles. Two code paths to maintain.
**Fix:** Extract shared send logic into a helper, or add a comment acknowledging the duplication and why it's acceptable (perf).

- [ ] Fixed / Acknowledged

### 15. PRAGMA synchronous=OFF on non-bordercrypt paths

**File:** `gossip-sdk/src/db/sqlite.ts` — `PRAGMAS`
**Issue:** `synchronous=OFF` was added to the shared PRAGMAS used by IDB/OPFS/memory paths. The comment says "xSync is a no-op" — is this true for `IDBBatchAtomicVFS`? If not, this changes crash safety for the non-bordercrypt browser path.
**Fix:** Verify IDBBatchAtomicVFS xSync behavior. If it does real work, keep `synchronous=OFF` only in `PRAGMAS_BORDERCRYPT`.

- [ ] Fixed / Verified

### 16. WASM binary committed to repo

**File:** `gossip-sdk/src/assets/generated/wasm-bordercrypt/bordercrypt_bg.wasm`
**Issue:** Binary blob checked in. Can be reproduced via `npm run wasm:build:bordercrypt`.
**Fix:** Consider adding to `.gitignore` and building in CI, or document why it's committed (e.g., not all contributors have Rust toolchain).

- [ ] Fixed / Acknowledged
