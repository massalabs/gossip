# Two-Layer Message Store Refactor

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the single `messagesByContact` array (mixing optimistic and confirmed messages) with two separate layers that are merged at read time, eliminating all race-condition guards.

**Architecture:** The store maintains `confirmedByContact` (updated only by polls) and `optimisticByContact` (updated only by sends). `getMessagesForContact()` merges them on read via a pure function. No `reconcile()`, no `activeSendCount`, no duplicate detection in swap. The `pendingToRealId` map tells the merge which optimistic messages are already confirmed.

**Tech Stack:** Zustand, Vitest 4, React 19

---

## What gets deleted

- `reconcile()` function (~90 lines)
- `isConfirmed()` function
- `messagesChanged()` helper
- `activeSendCount` guard
- Duplicate detection in swap (`existingRealIdx`)
- All `activeSendCount > 0` checks in `fetchAll`, `fetchForContact`, `onEvent`

## What stays

- `pendingToRealId` — needed by merge to know which optimistic are confirmed
- `clientSeq` + `getStableKey()` — needed for Virtuoso key stability
- `STATUS_RANK` + `statusRank()` — needed by merge for status display
- Reactions logic (unchanged — separate concern)
- All public API signatures (no consumer changes)

## New data flow

```
sendMessage()  → optimisticByContact.set(cid, [..., msg])
                 ↓ SDK returns
                 → pendingToRealId.set(optId, realId)
                 → optimisticByContact: remove the optimistic msg
                 (next poll will add it to confirmed)

poll/event     → confirmedByContact.set(cid, dbMessages)
                 (no merge, no reconcile — just store DB data)

getMessages()  → merge(confirmed, optimistic, pendingToRealId)
                 pure function, ~15 lines
```

---

### Task 1: Add two-layer store fields and merge function

**Files:**

- Modify: `src/stores/messageStore.tsx`

**Step 1: Write the merge function and update types**

Replace the store state with two separate maps and write the merge function:

```ts
interface MessageStoreState {
  confirmedByContact: Map<string, Message[]>;
  optimisticByContact: Map<string, Message[]>;
  reactionsByContact: Map<string, Message[]>;
  currentContactUserId: string | null;
  isLoading: boolean;
  pollTimer: ReturnType<typeof setInterval> | null;
  eventHandler: (() => void) | null;
  cancelDebounce: (() => void) | null;
  isInitializing: boolean;

  init: () => Promise<void>;
  setCurrentContact: (contactUserId: string | null) => void;
  sendMessage: (
    contactUserId: string,
    content: string,
    replyToId?: number,
    forwardFromMessageId?: number
  ) => Promise<void>;
  getMessagesForContact: (contactUserId: string) => Message[];
  getReactionsForMessage: (
    contactUserId: string,
    messageDbId: number
  ) => ReactionGroup[];
  sendReaction: (
    contactUserId: string,
    emoji: string,
    messageDbId: number
  ) => void;
  removeReaction: (contactUserId: string, reactionDbId: number) => void;
  clearMessages: (contactUserId: string) => void;
  cleanup: () => void;
}
```

The merge function (replaces `reconcile`, ~15 lines):

```ts
/**
 * Merge confirmed (DB) and optimistic (client) messages for rendering.
 * Pure function — no side effects, no races.
 *
 * An optimistic message is excluded if pendingToRealId maps its id to
 * a confirmed message id (= SDK returned, DB has it or will soon).
 */
function mergeMessages(confirmed: Message[], optimistic: Message[]): Message[] {
  if (optimistic.length === 0) return confirmed;

  const confirmedIds = new Set<number>();
  for (const m of confirmed) if (m.id != null) confirmedIds.add(m.id);

  const pending = optimistic.filter(opt => {
    const realId = pendingToRealId.get(opt.id!);
    // If mapped AND confirmed array has it → already confirmed, skip
    if (realId != null && confirmedIds.has(realId)) return false;
    // If mapped but confirmed doesn't have it yet → keep optimistic
    // (stale poll, DB will catch up)
    if (realId != null) return true;
    // No mapping → still in-flight, keep
    return true;
  });

  if (pending.length === 0) return confirmed;

  return [...confirmed, ...pending].sort(
    (a, b) => a.timestamp.getTime() - b.timestamp.getTime()
  );
}
```

**Step 2: Rewrite `getMessagesForContact` to use merge**

```ts
getMessagesForContact: (contactUserId: string) => {
  const confirmed = get().confirmedByContact.get(contactUserId) || EMPTY_MESSAGES;
  const optimistic = get().optimisticByContact.get(contactUserId) || EMPTY_MESSAGES;
  return mergeMessages(confirmed, optimistic);
},
```

**Step 3: Rewrite `sendMessage` — write to optimistic layer only**

```ts
sendMessage: async (contactUserId, content, replyToId, forwardFromMessageId) => {
  // ... guards unchanged ...

  const seq = ++optimisticIdCounter;
  const optimisticMessage: Message = {
    ownerUserId: userProfile.userId,
    contactUserId,
    content,
    type: MessageType.TEXT,
    direction: MessageDirection.OUTGOING,
    status: MessageStatus.SENT,
    timestamp: new Date(),
    id: -seq,
  };
  clientSeq.set(-seq, seq);

  // Add to optimistic layer (never touched by polls)
  const currentOpt = get().optimisticByContact.get(contactUserId) || [];
  const newOptMap = new Map(get().optimisticByContact);
  newOptMap.set(contactUserId, [...currentOpt, optimisticMessage]);
  set({ optimisticByContact: newOptMap });

  // Fire-and-forget
  void (async () => {
    try {
      // ... discussion.get, replyTo, forwardOf logic unchanged ...

      const result = await getSdk().messages.send(message);

      if (result.message?.id) {
        const realMsg = result.message;
        pendingToRealId.set(optimisticMessage.id!, realMsg.id!);
        const seqVal = clientSeq.get(optimisticMessage.id!);
        if (seqVal != null) {
          clientSeq.set(realMsg.id!, seqVal);
          clientSeq.delete(optimisticMessage.id!);
        }

        // Remove from optimistic layer.
        // The merge function will exclude it (pendingToRealId has the mapping).
        // The next poll will add it to confirmed.
        set(state => {
          const opts = state.optimisticByContact.get(contactUserId);
          if (!opts) return state;
          const filtered = opts.filter(m => m.id !== optimisticMessage.id);
          const newMap = new Map(state.optimisticByContact);
          newMap.set(contactUserId, filtered);
          return { optimisticByContact: newMap };
        });
      } else if (!result.success) {
        console.error('Failed to send message:', result.error);
      }
    } catch (error) {
      console.error('Failed to send message:', error);
    }
  })();
},
```

**No `activeSendCount`. No duplicate detection. No swap.**

**Step 4: Rewrite poll functions — write to confirmed layer only**

`fetchForContact`:

```ts
const fetchForContact = async (contactUserId: string) => {
  if (isFetchingSingle) return;
  isFetchingSingle = true;
  try {
    const sdk = getSdk();
    if (!sdk.isSessionOpen) return;

    const dbMessages = await sdk.messages.getVisibleMessages(contactUserId);

    // Clean up pendingToRealId for confirmed messages
    const dbIdSet = new Set(
      dbMessages.map(m => m.id).filter(Boolean) as number[]
    );
    for (const [optId, realId] of pendingToRealId) {
      if (dbIdSet.has(realId)) pendingToRealId.delete(optId);
    }

    // Write to confirmed layer — reference-stable update
    const current = get().confirmedByContact.get(contactUserId) || [];
    if (confirmedChanged(current, dbMessages)) {
      const newMap = new Map(get().confirmedByContact);
      newMap.set(contactUserId, dbMessages);
      set({ confirmedByContact: newMap });
    }
  } catch (error) {
    console.error('Messages fetch error:', error);
  } finally {
    isFetchingSingle = false;
  }
};
```

`fetchAll`: same pattern — iterate discussions, write DB messages to `confirmedByContact`, reactions to `reactionsByContact` (preserving optimistic reactions as before).

**No `activeSendCount > 0` guard. Polls and sends are independent.**

**Step 5: Update `sendReaction` to use confirmed layer for target lookup**

`sendReaction` currently reads `messagesByContact` to find the target message. Change to read from `getMessagesForContact()` (the merged view) since the target might be optimistic.

```ts
sendReaction: (contactUserId, emoji, messageDbId) => {
  const messages = get().getMessagesForContact(contactUserId);
  // ... rest unchanged
},
```

Same for `getReactionsForMessage`.

**Step 6: Update `clearMessages` and `cleanup`**

```ts
clearMessages: (contactUserId) => {
  const newConfirmed = new Map(get().confirmedByContact);
  const newOptimistic = new Map(get().optimisticByContact);
  const newReactions = new Map(get().reactionsByContact);
  newConfirmed.delete(contactUserId);
  newOptimistic.delete(contactUserId);
  newReactions.delete(contactUserId);
  set({
    confirmedByContact: newConfirmed,
    optimisticByContact: newOptimistic,
    reactionsByContact: newReactions,
  });
},

cleanup: () => {
  // ... timer/handler cleanup unchanged ...
  pendingToRealId.clear();
  clientSeq.clear();
  set({
    pollTimer: null,
    eventHandler: null,
    cancelDebounce: null,
    confirmedByContact: new Map(),
    optimisticByContact: new Map(),
    reactionsByContact: new Map(),
    currentContactUserId: null,
    isLoading: false,
  });
},
```

**Step 7: Delete old code**

Remove: `reconcile()`, `isConfirmed()`, `messagesChanged()`, `activeSendCount`, all `activeSendCount > 0` guards, swap duplicate detection block.

**Step 8: Add `confirmedChanged` helper**

Simple reference-stable comparison (replaces `messagesChanged` but for confirmed-only):

```ts
const confirmedChanged = (
  existing: Message[],
  incoming: Message[]
): boolean => {
  if (incoming.length !== existing.length) return true;
  return existing.some((msg, i) => {
    const other = incoming[i];
    return (
      msg.id !== other.id ||
      msg.content !== other.content ||
      msg.status !== other.status ||
      !!(msg.metadata as { edited?: boolean })?.edited !==
        !!(other.metadata as { edited?: boolean })?.edited
    );
  });
};
```

**Step 9: Run existing tests**

Run: `npx vitest run test/stores/messageStore.spec.ts`

Many tests will fail because they reference `messagesByContact`. Update them to use `confirmedByContact` and `optimisticByContact` for setup, and `getMessagesForContact()` for assertions.

**Step 10: Commit**

```
refactor: two-layer message store (confirmed + optimistic)
```

---

### Task 2: Update all tests for two-layer architecture

**Files:**

- Modify: `test/stores/messageStore.spec.ts`

**Key changes in tests:**

1. **Store setup**: Replace `messagesByContact` with `confirmedByContact` + `optimisticByContact`

2. **Assertions**: Use `getMessagesForContact()` (merged view) instead of reading `messagesByContact` directly

3. **Tests to simplify/remove:**
   - "no duplicate ids when poll adds DB message before swap completes" → race is impossible now, remove
   - "poll during in-flight send preserves message reference" → no guard needed, simplify
   - "race: poll with stale data does not drop recently-swapped message" → still valid via pendingToRealId in merge

4. **Tests to add:**
   - "merge excludes optimistic when confirmed has the mapped real id"
   - "merge keeps optimistic when pendingToRealId maps to id not yet in confirmed"
   - "merge returns confirmed array directly when no optimistic"
   - "poll and send don't interfere (no activeSendCount needed)"

**Step 1: Update all tests**

**Step 2: Run**

Run: `npx vitest run test/stores/messageStore.spec.ts`

**Step 3: Commit**

```
test: update tests for two-layer message store
```

---

### Task 3: Update browser tests

**Files:**

- Modify: `test/stores/messageStore-optimistic.browser.spec.tsx`
- Modify: `test/components/discussions/MessageItem.browser.spec.tsx`

Browser tests use the store's public API (`sendMessage`, `getMessagesForContact`) which hasn't changed. They should mostly pass without changes. Verify and fix any that break.

**Step 1: Run browser tests**

Run: `npx vitest run --config vite.config.ts --project browser test/stores/messageStore-optimistic.browser.spec.tsx test/components/discussions/MessageItem.browser.spec.tsx`

**Step 2: Fix any failures**

**Step 3: Commit**

```
test: verify browser tests pass with two-layer store
```

---

### Task 4: Remove `activeSendCount` and cleanup

**Files:**

- Modify: `src/stores/messageStore.tsx`

Verify `activeSendCount` is fully removed (should be done in Task 1, but double-check). Also verify no references to `messagesByContact` remain.

**Step 1: Search for remnants**

```bash
grep -n 'activeSendCount\|messagesByContact\|reconcile\|isConfirmed' src/stores/messageStore.tsx
```

Should return 0 results.

**Step 2: Run full test suite**

```bash
npx vitest run test/stores/messageStore.spec.ts
npx vitest run --config vite.config.ts --project browser test/stores/messageStore-optimistic.browser.spec.tsx test/components/discussions/MessageItem.browser.spec.tsx
```

**Step 3: Commit (if any changes)**

```
cleanup: remove remaining references to old single-layer architecture
```

---

## Summary

| What                | Before                                  | After                                              |
| ------------------- | --------------------------------------- | -------------------------------------------------- |
| Store fields        | `messagesByContact` (mixed)             | `confirmedByContact` + `optimisticByContact`       |
| Poll writes to      | `messagesByContact` via `reconcile()`   | `confirmedByContact` directly                      |
| Send writes to      | `messagesByContact` (optimistic + swap) | `optimisticByContact` (add) then remove on confirm |
| Read                | `messagesByContact` directly            | `mergeMessages()` pure function                    |
| `reconcile()`       | ~90 lines, races                        | deleted                                            |
| `activeSendCount`   | 3 guards                                | deleted                                            |
| Duplicate detection | swap checks `existingRealIdx`           | impossible by design                               |
| `isConfirmed()`     | heuristic matching                      | deleted                                            |
| Lines of code       | ~200 (reconcile + guards + swap)        | ~30 (merge + simple remove)                        |
