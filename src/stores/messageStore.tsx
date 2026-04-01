import { create } from 'zustand';
import {
  Message,
  MessageDirection,
  MessageStatus,
  MessageType,
  decodeUserId,
  SdkEventType,
} from '@massalabs/gossip-sdk';
import { createSelectors } from './utils/createSelectors';
import { useAccountStore } from './accountStore';
import { getSdk } from './sdkStore';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ReactionGroup {
  emoji: string;
  count: number;
  myReactionId?: number;
}

interface MessageStoreState {
  messagesByContact: Map<string, Message[]>;
  reactionsByContact: Map<string, Message[]>;
  reactionGroupsCache: Map<string, ReactionGroup[]>;
  currentContactUserId: string | null;
  cleanupFn: (() => void) | null;
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
  getReactionsForMessage: (messageId: Uint8Array) => ReactionGroup[];
  deleteMessage: (contactUserId: string, messageId: number) => Promise<void>;
  editMessage: (
    contactUserId: string,
    messageId: number,
    newContent: string
  ) => Promise<void>;
  sendReaction: (
    contactUserId: string,
    emoji: string,
    messageDbId: number
  ) => Promise<void>;
  removeReaction: (reactionDbId: number) => Promise<void>;
  clearMessages: (contactUserId: string) => void;
  cleanup: () => void;
}

// ---------------------------------------------------------------------------
// Helpers — immutable Map updates
// ---------------------------------------------------------------------------

const messageIdEquals = (
  a: Uint8Array | undefined,
  b: Uint8Array | undefined
): boolean => {
  if (!a || !b || a.length !== b.length) return false;
  return a.every((byte, i) => byte === b[i]);
};

const messageIdKey = (id: Uint8Array): string => id.join(',');

const EMPTY_MESSAGES: Message[] = [];
const EMPTY_REACTIONS: ReactionGroup[] = [];

/** Update one contact's messages, keeping stable refs for others. */
function patchContact(
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

/** Find a message across all contacts and patch it (early return). */
function findAndPatch(
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

// ---------------------------------------------------------------------------
// Helpers — reaction groups cache
// ---------------------------------------------------------------------------

/** Compute grouped reactions for one contact. */
function computeReactionGroups(
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
      const existing = groups.get(r.content) ?? { emoji: r.content, count: 0 };
      groups.set(r.content, {
        ...existing,
        count: existing.count + 1,
        myReactionId:
          r.direction === MessageDirection.OUTGOING && r.id != null
            ? r.id
            : existing.myReactionId,
      });
    }
    result.set(key, Array.from(groups.values()));
  }
  return result;
}

/** Incremental cache update for a single contact. */
function patchReactionCache(
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

/** Full cache recompute (init / session refetch). */
function recomputeFullCache(
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
// Helpers — rollback
// ---------------------------------------------------------------------------

type SetFn = (
  fn: (state: MessageStoreState) => Partial<MessageStoreState>
) => void;

function rollbackInsert(set: SetFn, contactUserId: string, message: Message) {
  set(state => {
    const map = patchContact(state.messagesByContact, contactUserId, msgs =>
      [...msgs, message].sort(
        (a, b) => a.timestamp.getTime() - b.timestamp.getTime()
      )
    );
    return map ? { messagesByContact: map } : state;
  });
}

function rollbackReplace(
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
// Event handlers (extracted from init for readability)
// ---------------------------------------------------------------------------

type GetFn = () => MessageStoreState;

function createEventHandlers(
  sdk: ReturnType<typeof getSdk>,
  set: SetFn,
  get: GetFn
) {
  const onOptimistic = (message: Message) => {
    if (message.type === MessageType.REACTION) {
      set(state => {
        const contact = message.contactUserId;
        const existing = state.reactionsByContact.get(contact) || [];
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
      return;
    }
    set(state => {
      const map = patchContact(
        state.messagesByContact,
        message.contactUserId,
        msgs => [...msgs, message]
      );
      return map ? { messagesByContact: map } : state;
    });
  };

  const onReceived = (message: Message) => {
    if (message.type === MessageType.REACTION) {
      set(state => {
        const contact = message.contactUserId;
        const existing = state.reactionsByContact.get(contact) || [];
        if (
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
      return;
    }

    // Handle reaction deletion — remove from reactionsByContact
    if (message.type === MessageType.DELETED && message.messageId) {
      let handled = false;
      set(state => {
        const contact = message.contactUserId;
        const existing = state.reactionsByContact.get(contact) || [];
        const idx = existing.findIndex(r =>
          messageIdEquals(r.messageId, message.messageId)
        );
        if (idx < 0) return state;
        handled = true;
        const rxnMap = new Map(state.reactionsByContact);
        rxnMap.set(
          contact,
          existing.filter((_, i) => i !== idx)
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
      if (handled) return;
    }

    set(state => {
      const map = patchContact(
        state.messagesByContact,
        message.contactUserId,
        msgs => {
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
      );
      return map ? { messagesByContact: map } : state;
    });
  };

  const onSent = (message: Message) => {
    set(state => {
      const map = patchContact(
        state.messagesByContact,
        message.contactUserId,
        msgs => {
          let changed = false;
          const updated = msgs.map(m => {
            if (messageIdEquals(m.messageId, message.messageId)) {
              changed = true;
              return { ...m, id: message.id ?? m.id, status: message.status };
            }
            return m;
          });
          return changed ? updated : null;
        }
      );
      return map ? { messagesByContact: map } : state;
    });
  };

  const onWriteFailed = (
    failedMessageId: Uint8Array | undefined,
    entityType: string
  ) => {
    if (entityType !== 'message') return;
    set(state => {
      const map = findAndPatch(
        state.messagesByContact,
        m => messageIdEquals(m.messageId, failedMessageId),
        m => ({ ...m, status: MessageStatus.FAILED })
      );
      return map ? { messagesByContact: map } : state;
    });
  };

  const onRead = (messageDbId: number) => {
    set(state => {
      const map = findAndPatch(
        state.messagesByContact,
        m => m.id === messageDbId,
        m => ({ ...m, status: MessageStatus.READ })
      );
      return map ? { messagesByContact: map } : state;
    });
  };

  const onSessionEvent = async () => {
    const currentContact = get().currentContactUserId;
    if (!currentContact || !sdk.isSessionOpen) return;
    try {
      const messages = await sdk.messages.getVisibleMessages(currentContact);
      const reactions = await sdk.messages.getReactions(currentContact);
      set(state => {
        const msgMap = new Map(state.messagesByContact);
        const rxnMap = new Map(state.reactionsByContact);
        msgMap.set(currentContact, messages);
        if (reactions.length > 0) rxnMap.set(currentContact, reactions);
        else rxnMap.delete(currentContact);
        return {
          messagesByContact: msgMap,
          reactionsByContact: rxnMap,
          reactionGroupsCache: recomputeFullCache(msgMap, rxnMap),
        };
      });
    } catch (error) {
      console.error('Session event refetch error:', error);
    }
  };

  // Subscribe all
  sdk.on(SdkEventType.MESSAGE_OPTIMISTIC, onOptimistic);
  sdk.on(SdkEventType.MESSAGE_RECEIVED, onReceived);
  sdk.on(SdkEventType.MESSAGE_SENT, onSent);
  sdk.on(SdkEventType.MESSAGE_READ, onRead);
  sdk.on(SdkEventType.WRITE_FAILED, onWriteFailed);
  sdk.on(SdkEventType.SESSION_CREATED, onSessionEvent);
  sdk.on(SdkEventType.SESSION_ACCEPTED, onSessionEvent);

  return () => {
    try {
      sdk.off(SdkEventType.MESSAGE_OPTIMISTIC, onOptimistic);
      sdk.off(SdkEventType.MESSAGE_RECEIVED, onReceived);
      sdk.off(SdkEventType.MESSAGE_SENT, onSent);
      sdk.off(SdkEventType.MESSAGE_READ, onRead);
      sdk.off(SdkEventType.WRITE_FAILED, onWriteFailed);
      sdk.off(SdkEventType.SESSION_CREATED, onSessionEvent);
      sdk.off(SdkEventType.SESSION_ACCEPTED, onSessionEvent);
    } catch {
      // SDK might not be available during cleanup
    }
  };
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

const useMessageStoreBase = create<MessageStoreState>((set, get) => ({
  messagesByContact: new Map(),
  reactionsByContact: new Map(),
  reactionGroupsCache: new Map(),
  currentContactUserId: null,
  cleanupFn: null,
  isInitializing: false,

  setCurrentContact: (contactUserId: string | null) => {
    if (get().currentContactUserId === contactUserId) return;
    set({ currentContactUserId: contactUserId });

    if (contactUserId && !get().messagesByContact.has(contactUserId)) {
      const sdk = getSdk();
      if (!sdk.isSessionOpen) return;
      Promise.all([
        sdk.messages.getVisibleMessages(contactUserId),
        sdk.messages.getReactions(contactUserId),
      ]).then(([messages, reactions]) => {
        set(state => {
          const msgMap = new Map(state.messagesByContact);
          const rxnMap = new Map(state.reactionsByContact);
          if (messages.length > 0) msgMap.set(contactUserId, messages);
          if (reactions.length > 0) rxnMap.set(contactUserId, reactions);
          return {
            messagesByContact: msgMap,
            reactionsByContact: rxnMap,
            reactionGroupsCache: recomputeFullCache(msgMap, rxnMap),
          };
        });
      });
    }
  },

  init: async () => {
    const { userProfile } = useAccountStore.getState();
    if (!userProfile?.userId || get().cleanupFn || get().isInitializing) return;

    set({ isInitializing: true });

    const sdk = getSdk();
    if (sdk.isSessionOpen) {
      try {
        const discussions = await sdk.discussions.list();
        const msgMap = new Map<string, Message[]>();
        const rxnMap = new Map<string, Message[]>();
        for (const d of discussions) {
          const msgs = await sdk.messages.getVisibleMessages(d.contactUserId);
          const rxns = await sdk.messages.getReactions(d.contactUserId);
          if (msgs.length > 0) msgMap.set(d.contactUserId, msgs);
          if (rxns.length > 0) rxnMap.set(d.contactUserId, rxns);
        }
        set({
          messagesByContact: msgMap,
          reactionsByContact: rxnMap,
          reactionGroupsCache: recomputeFullCache(msgMap, rxnMap),
        });
      } catch (error) {
        console.error('Messages initial load error:', error);
        set({ isInitializing: false });
        return;
      }
    }

    set({
      cleanupFn: createEventHandlers(sdk, set, get),
      isInitializing: false,
    });
  },

  sendMessage: async (
    contactUserId,
    content,
    replyToId?,
    forwardFromMessageId?
  ) => {
    const { userProfile } = useAccountStore.getState();
    const isForward = !!forwardFromMessageId;
    if (
      !userProfile?.userId ||
      (!content.trim() && !isForward) ||
      !getSdk().isSessionOpen
    )
      return;

    let replyTo: Message['replyTo'];
    let forwardOf: Message['forwardOf'];

    if (replyToId) {
      const orig = await getSdk().messages.get(replyToId);
      if (!orig) throw new Error('Original message not found');
      if (!orig.messageId)
        throw new Error('Cannot reply to a message that has no messageId');
      replyTo = { originalMsgId: orig.messageId };
    }

    if (forwardFromMessageId) {
      const orig = await getSdk().messages.get(forwardFromMessageId);
      if (!orig) {
        console.warn('Forward target not found, sending as regular message');
      } else if (!orig.messageId) {
        throw new Error('Cannot forward a message that has no messageId');
      } else if (orig.contactUserId === contactUserId) {
        replyTo = { originalMsgId: orig.messageId! };
      } else {
        forwardOf = {
          originalContent: orig.content,
          originalContactId: decodeUserId(orig.contactUserId),
        };
      }
    }

    const result = getSdk().messages.sendOptimistic({
      ownerUserId: userProfile.userId,
      contactUserId,
      content,
      type: MessageType.TEXT,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.WAITING_SESSION,
      timestamp: new Date(),
      replyTo,
      forwardOf,
    });
    if (!result.success) console.error('Failed to send message:', result.error);
  },

  getMessagesForContact: contactUserId =>
    get().messagesByContact.get(contactUserId) || EMPTY_MESSAGES,

  getReactionsForMessage: (msgId: Uint8Array) =>
    get().reactionGroupsCache.get(messageIdKey(msgId)) || EMPTY_REACTIONS,

  deleteMessage: async (contactUserId, messageId) => {
    const msgs = get().messagesByContact.get(contactUserId) || EMPTY_MESSAGES;
    const removed = msgs.find(m => m.id === messageId);

    set(state => {
      const map = patchContact(state.messagesByContact, contactUserId, ms =>
        ms.filter(m => m.id !== messageId)
      );
      return map ? { messagesByContact: map } : state;
    });

    try {
      const ok = await getSdk().messages.deleteMessage(messageId);
      if (!ok && removed) rollbackInsert(set, contactUserId, removed);
    } catch {
      if (removed) rollbackInsert(set, contactUserId, removed);
    }
  },

  editMessage: async (contactUserId, messageId, newContent) => {
    const msgs = get().messagesByContact.get(contactUserId) || EMPTY_MESSAGES;
    const original = msgs.find(m => m.id === messageId);

    set(state => {
      const map = patchContact(state.messagesByContact, contactUserId, ms =>
        ms.map(m =>
          m.id === messageId
            ? {
                ...m,
                content: newContent,
                metadata: { ...(m.metadata as object), edited: true },
              }
            : m
        )
      );
      return map ? { messagesByContact: map } : state;
    });

    try {
      const ok = await getSdk().messages.editMessage(messageId, newContent);
      if (!ok && original)
        rollbackReplace(set, contactUserId, messageId, original);
    } catch {
      if (original) rollbackReplace(set, contactUserId, messageId, original);
    }
  },

  sendReaction: async (contactUserId, emoji, messageDbId) => {
    const msgs = get().messagesByContact.get(contactUserId) || EMPTY_MESSAGES;
    const target = msgs.find(m => m.id === messageDbId);
    if (!target?.messageId) {
      console.warn('Cannot react to message without messageId');
      return;
    }

    // Same pipeline as regular messages — onOptimistic routes REACTION to reactionsByContact
    const result = getSdk().messages.sendOptimistic({
      ownerUserId: useAccountStore.getState().userProfile?.userId ?? '',
      contactUserId,
      content: emoji,
      type: MessageType.REACTION,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.WAITING_SESSION,
      timestamp: new Date(),
      reactionOf: { originalMsgId: target.messageId },
    });
    if (!result.success)
      console.error('Failed to send reaction:', result.error);
  },

  removeReaction: async reactionDbId => {
    // Optimistic: remove outgoing reactions for this target from state
    const contactUserId = (() => {
      for (const [contact, rxns] of get().reactionsByContact) {
        if (rxns.some(r => r.id === reactionDbId)) return contact;
      }
      return null;
    })();

    if (contactUserId) {
      set(state => {
        const existing = state.reactionsByContact.get(contactUserId) || [];
        const rxnMap = new Map(state.reactionsByContact);
        rxnMap.set(
          contactUserId,
          existing.filter(
            r =>
              !(
                r.id === reactionDbId ||
                (r.direction === MessageDirection.OUTGOING && !r.id)
              )
          )
        );
        return {
          reactionsByContact: rxnMap,
          reactionGroupsCache: patchReactionCache(
            state.reactionGroupsCache,
            contactUserId,
            state.messagesByContact,
            rxnMap
          ),
        };
      });
    }

    await getSdk().messages.deleteMessage(reactionDbId);
  },

  clearMessages: contactUserId => {
    set(state => {
      const msgMap = new Map(state.messagesByContact);
      const rxnMap = new Map(state.reactionsByContact);
      msgMap.delete(contactUserId);
      rxnMap.delete(contactUserId);
      return {
        messagesByContact: msgMap,
        reactionsByContact: rxnMap,
        reactionGroupsCache: recomputeFullCache(msgMap, rxnMap),
      };
    });
  },

  cleanup: () => {
    get().cleanupFn?.();
    set({
      cleanupFn: null,
      messagesByContact: new Map(),
      reactionsByContact: new Map(),
      reactionGroupsCache: new Map(),
      currentContactUserId: null,
      isInitializing: false,
    });
  },
}));

export const useMessageStore = createSelectors(useMessageStoreBase);
