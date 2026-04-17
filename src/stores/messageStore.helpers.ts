import {
  Message,
  MessageDirection,
  MessageStatus,
} from '@massalabs/gossip-sdk';
import type {
  ReactionGroup,
  MessageStoreState,
  StoreMessage,
} from './messageStore.types';

// ---------------------------------------------------------------------------
// Uint8Array comparison
// ---------------------------------------------------------------------------

export const messageIdEquals = (
  a: Uint8Array | undefined,
  b: Uint8Array | undefined
): boolean => {
  if (!a || !b || a.length !== b.length) return false;
  return a.every((byte, i) => byte === b[i]);
};

export const messageIdKey = (id: Uint8Array): string => id.join(',');

export const EMPTY_MESSAGES: Message[] = [];
/** Empty list for `reactionsByContact` entries (`StoreMessage[]`). */
export const EMPTY_STORE_MESSAGES: StoreMessage[] = [];
export const EMPTY_REACTIONS: ReactionGroup[] = [];

// ---------------------------------------------------------------------------
// Immutable Map updates
// ---------------------------------------------------------------------------

export function patchContact(
  map: Map<string, StoreMessage[]>,
  contactId: string,
  updater: (msgs: StoreMessage[]) => StoreMessage[] | null
): Map<string, StoreMessage[]> | null {
  const updated = updater(map.get(contactId) || []);
  if (updated === null) return null;
  const next = new Map(map);
  next.set(contactId, updated);
  return next;
}

export function findAndPatch(
  map: Map<string, StoreMessage[]>,
  predicate: (m: StoreMessage) => boolean,
  patch: (m: StoreMessage) => StoreMessage
): Map<string, StoreMessage[]> | null {
  for (const [contact, msgs] of map) {
    const idx = msgs.findIndex(predicate);
    if (idx >= 0) {
      const next = new Map(map);
      const updated = [...msgs];
      updated[idx] = patch(msgs[idx]);
      next.set(contact, updated);
      return next;
    }
  }
  return null;
}

export function upsertMessage(
  msgs: StoreMessage[],
  message: Message
): StoreMessage[] {
  if (message.messageId) {
    const idx = msgs.findIndex(entry =>
      messageIdEquals(entry.messageId, message.messageId)
    );
    if (idx >= 0) {
      const updated = [...msgs];
      updated[idx] = {
        ...updated[idx],
        ...message,
        id: updated[idx].id || message.id,
      };
      return updated;
    }
  }
  if (message.id) {
    const idx = msgs.findIndex(entry => entry.id === message.id);
    if (idx >= 0) {
      const updated = [...msgs];
      updated[idx] = { ...updated[idx], ...message };
      return updated;
    }
  }
  return [...msgs, { ...message }];
}

// ---------------------------------------------------------------------------
// Reaction groups cache
// ---------------------------------------------------------------------------

export function computeReactionGroups(
  reactions: StoreMessage[],
  messages: StoreMessage[]
): Map<string, ReactionGroup[]> {
  const msgIdSet = new Set<string>();
  for (const entry of messages) {
    if (entry.messageId) msgIdSet.add(messageIdKey(entry.messageId));
  }

  const latestByTarget = new Map<
    string,
    { incoming?: StoreMessage; outgoing?: StoreMessage }
  >();
  for (const r of reactions) {
    const targetId = r.reactionOf?.originalMsgId;
    if (!targetId) continue;
    const key = messageIdKey(targetId);
    if (!msgIdSet.has(key)) continue;

    const entry = latestByTarget.get(key) ?? {};
    if (r.direction === MessageDirection.OUTGOING) {
      if (!entry.outgoing || r.timestamp > entry.outgoing.timestamp)
        entry.outgoing = r;
    } else {
      if (!entry.incoming || r.timestamp > entry.incoming.timestamp)
        entry.incoming = r;
    }
    latestByTarget.set(key, entry);
  }

  const result = new Map<string, ReactionGroup[]>();
  for (const [key, { incoming, outgoing }] of latestByTarget) {
    const groups = new Map<string, ReactionGroup>();
    for (const r of [incoming, outgoing]) {
      if (!r) continue;
      const isMine = r.direction === MessageDirection.OUTGOING;
      const existing = groups.get(r.content) ?? { emoji: r.content, count: 0 };
      groups.set(r.content, {
        ...existing,
        count: existing.count + 1,
        myReactionId: isMine && r.id != null ? r.id : existing.myReactionId,
        myReactionMessageId:
          isMine && r.messageId ? r.messageId : existing.myReactionMessageId,
      });
    }
    result.set(key, Array.from(groups.values()));
  }
  return result;
}

export function patchReactionCache(
  cache: Map<string, ReactionGroup[]>,
  contactId: string,
  messagesByContact: Map<string, StoreMessage[]>,
  reactionsByContact: Map<string, StoreMessage[]>
): Map<string, ReactionGroup[]> {
  const messages = messagesByContact.get(contactId) || [];
  const reactions = reactionsByContact.get(contactId) || [];
  const next = new Map(cache);
  for (const entry of messages) {
    if (entry.messageId) next.delete(messageIdKey(entry.messageId));
  }
  for (const [key, value] of computeReactionGroups(reactions, messages)) {
    next.set(key, value);
  }
  return next;
}

export function recomputeFullCache(
  messagesByContact: Map<string, StoreMessage[]>,
  reactionsByContact: Map<string, StoreMessage[]>
): Map<string, ReactionGroup[]> {
  const cache = new Map<string, ReactionGroup[]>();
  for (const [contact, reactions] of reactionsByContact) {
    const messages = messagesByContact.get(contact) || [];
    for (const [key, value] of computeReactionGroups(reactions, messages)) {
      cache.set(key, value);
    }
  }
  return cache;
}

// ---------------------------------------------------------------------------
// Rollback helpers
// ---------------------------------------------------------------------------

export type SetFn = (
  fn: (state: MessageStoreState) => Partial<MessageStoreState>
) => void;

/**
 * Apply an immutable update to the messages of a single contact. No-op when
 * the updater returns null or when the contact has no prior messages entry
 * and the updater leaves it empty.
 */
export function patchMessages(
  set: SetFn,
  contactUserId: string,
  updater: (msgs: StoreMessage[]) => StoreMessage[] | null
): void {
  set(state => {
    const map = patchContact(state.messagesByContact, contactUserId, updater);
    return map ? { messagesByContact: map } : state;
  });
}

/** Mark the message matching localMessageId as FAILED. */
export function markMessageFailed(set: SetFn, storeId: string): void {
  set(state => {
    const map = findAndPatch(
      state.messagesByContact,
      entry => entry.storeId === storeId,
      entry => ({
        ...entry,
        status: MessageStatus.FAILED,
        storeId: undefined,
      })
    );
    return map ? { messagesByContact: map } : state;
  });
}

/**
 * Replace an optimistic message (matched by `storeId`) with the persisted
 * version from the SDK. Clears `storeId`. No-op if no match is found.
 */
export function replaceOptimisticWithPersisted(
  set: SetFn,
  contactUserId: string,
  storeId: string,
  persisted: Message
): void {
  patchMessages(set, contactUserId, msgs => {
    const idx = msgs.findIndex(entry => entry.storeId === storeId);
    if (idx < 0) return null;
    const updated = [...msgs];
    updated[idx] = { ...persisted };
    return updated;
  });
}

export function rollbackInsert(
  set: SetFn,
  contactUserId: string,
  message: Message
) {
  set(state => {
    const map = patchContact(state.messagesByContact, contactUserId, msgs =>
      [...msgs, { ...message }].sort(
        (a, b) => a.timestamp.getTime() - b.timestamp.getTime()
      )
    );
    return map ? { messagesByContact: map } : state;
  });
}

export function rollbackReplace(
  set: SetFn,
  contactUserId: string,
  messageId: number,
  original: Message
) {
  set(state => {
    const map = patchContact(state.messagesByContact, contactUserId, msgs =>
      msgs.map(entry => (entry.id === messageId ? { ...original } : entry))
    );
    return map ? { messagesByContact: map } : state;
  });
}

// ---------------------------------------------------------------------------
// Reaction state updates (shared by events + store actions)
// ---------------------------------------------------------------------------

export function addReactionToState(
  set: SetFn,
  contact: string,
  message: Message,
  deduplicate: boolean
) {
  set(state => {
    const existing = state.reactionsByContact.get(contact) || [];
    if (
      deduplicate &&
      message.messageId &&
      existing.some(m => messageIdEquals(m.messageId, message.messageId))
    ) {
      return state;
    }
    const rxnMap = new Map(state.reactionsByContact);
    rxnMap.set(contact, [...existing, { ...message }]);
    return {
      reactionsByContact: rxnMap,
      reactionGroupsCache: patchReactionCache(
        state.reactionGroupsCache,
        contact,
        state.messagesByContact,
        rxnMap
      ),
    };
  });
}

export function removeReactionFromState(
  set: SetFn,
  contact: string,
  predicate: (r: StoreMessage) => boolean
): boolean {
  let found = false;
  set(state => {
    const existing = state.reactionsByContact.get(contact) || [];
    if (!existing.some(predicate)) return state;
    found = true;
    const rxnMap = new Map(state.reactionsByContact);
    rxnMap.set(
      contact,
      existing.filter(r => !predicate(r))
    );
    return {
      reactionsByContact: rxnMap,
      reactionGroupsCache: patchReactionCache(
        state.reactionGroupsCache,
        contact,
        state.messagesByContact,
        rxnMap
      ),
    };
  });
  return found;
}

/**
 * Remove all reactions that reference a deleted message from state and cache.
 * Returns the updated reactionsByContact map and reactionGroupsCache,
 * or null if nothing changed.
 */
export function clearReactionsForDeletedMessage(
  state: MessageStoreState,
  contactUserId: string,
  originalMsgId: Uint8Array,
  messagesByContact: Map<string, StoreMessage[]>
): Pick<
  MessageStoreState,
  'reactionsByContact' | 'reactionGroupsCache'
> | null {
  const reactions = state.reactionsByContact.get(contactUserId);
  if (!reactions || reactions.length === 0) return null;

  const filtered = reactions.filter(
    r =>
      !r.reactionOf?.originalMsgId ||
      !messageIdEquals(r.reactionOf.originalMsgId, originalMsgId)
  );
  if (filtered.length === reactions.length) return null;

  const rxnMap = new Map(state.reactionsByContact);
  if (filtered.length > 0) rxnMap.set(contactUserId, filtered);
  else rxnMap.delete(contactUserId);
  return {
    reactionsByContact: rxnMap,
    reactionGroupsCache: patchReactionCache(
      state.reactionGroupsCache,
      contactUserId,
      messagesByContact,
      rxnMap
    ),
  };
}
