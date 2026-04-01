import { Message, MessageDirection } from '@massalabs/gossip-sdk';
import type { ReactionGroup, MessageStoreState } from './messageStore.types';

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
export const EMPTY_REACTIONS: ReactionGroup[] = [];

// ---------------------------------------------------------------------------
// Immutable Map updates
// ---------------------------------------------------------------------------

export function patchContact(
  map: Map<string, Message[]>,
  contactId: string,
  updater: (msgs: Message[]) => Message[] | null
): Map<string, Message[]> | null {
  const updated = updater(map.get(contactId) || []);
  if (updated === null) return null;
  const next = new Map(map);
  next.set(contactId, updated);
  return next;
}

export function findAndPatch(
  map: Map<string, Message[]>,
  predicate: (m: Message) => boolean,
  patch: (m: Message) => Message
): Map<string, Message[]> | null {
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

export function upsertMessage(msgs: Message[], message: Message): Message[] {
  if (message.messageId) {
    const idx = msgs.findIndex(m =>
      messageIdEquals(m.messageId, message.messageId)
    );
    if (idx >= 0) {
      const updated = [...msgs];
      updated[idx] = {
        ...msgs[idx],
        ...message,
        id: msgs[idx].id || message.id,
      };
      return updated;
    }
  }
  if (message.id) {
    const idx = msgs.findIndex(m => m.id === message.id);
    if (idx >= 0) {
      const updated = [...msgs];
      updated[idx] = { ...msgs[idx], ...message };
      return updated;
    }
  }
  return [...msgs, message];
}

// ---------------------------------------------------------------------------
// Reaction groups cache
// ---------------------------------------------------------------------------

export function computeReactionGroups(
  reactions: Message[],
  messages: Message[]
): Map<string, ReactionGroup[]> {
  const msgIdSet = new Set<string>();
  for (const m of messages) {
    if (m.messageId) msgIdSet.add(messageIdKey(m.messageId));
  }

  const latestByTarget = new Map<
    string,
    { incoming?: Message; outgoing?: Message }
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
  messagesByContact: Map<string, Message[]>,
  reactionsByContact: Map<string, Message[]>
): Map<string, ReactionGroup[]> {
  const messages = messagesByContact.get(contactId) || [];
  const reactions = reactionsByContact.get(contactId) || [];
  const next = new Map(cache);
  for (const m of messages) {
    if (m.messageId) next.delete(messageIdKey(m.messageId));
  }
  for (const [key, value] of computeReactionGroups(reactions, messages)) {
    next.set(key, value);
  }
  return next;
}

export function recomputeFullCache(
  messagesByContact: Map<string, Message[]>,
  reactionsByContact: Map<string, Message[]>
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
// Optimistic mutation with rollback
// ---------------------------------------------------------------------------

export type SetFn = (
  fn: (state: MessageStoreState) => Partial<MessageStoreState>
) => void;

export async function optimisticMutation(
  set: SetFn,
  apply: () => void,
  persist: () => Promise<boolean>,
  rollback: () => void
) {
  apply();
  try {
    const ok = await persist();
    if (!ok) rollback();
  } catch {
    rollback();
  }
}

export function rollbackInsert(
  set: SetFn,
  contactUserId: string,
  message: Message
) {
  set(state => {
    const map = patchContact(state.messagesByContact, contactUserId, msgs =>
      [...msgs, message].sort(
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
      msgs.map(m => (m.id === messageId ? original : m))
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
    rxnMap.set(contact, [...existing, message]);
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
  predicate: (r: Message) => boolean
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
