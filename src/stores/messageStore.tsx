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
// Helpers
// ---------------------------------------------------------------------------

/** Compare two Uint8Array messageIds for equality */
const messageIdEquals = (
  a: Uint8Array | undefined,
  b: Uint8Array | undefined
): boolean => {
  if (!a || !b || a.length !== b.length) return false;
  return a.every((byte, i) => byte === b[i]);
};

const EMPTY_MESSAGES: Message[] = [];

/** Update one contact's messages in a Map, keeping stable refs for others.
 *  Returns new Map or null if updater returned null (no change). */
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

/** Find a message across all contacts and patch it. Early-returns on first match. */
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
  currentContactUserId: string | null;
  isLoading: boolean;
  isSending: boolean;
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
  getReactionsForMessage: (
    contactUserId: string,
    messageDbId: number
  ) => ReactionGroup[];
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
// Store
// ---------------------------------------------------------------------------

const useMessageStoreBase = create<MessageStoreState>((set, get) => ({
  messagesByContact: new Map(),
  reactionsByContact: new Map(),
  currentContactUserId: null,
  isLoading: false,
  isSending: false,
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
          return { messagesByContact: msgMap, reactionsByContact: rxnMap };
        });
      });
    }
  },

  init: async () => {
    const { userProfile } = useAccountStore.getState();
    const ownerUserId = userProfile?.userId;
    if (!ownerUserId || get().cleanupFn || get().isInitializing) return;

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
        set({ messagesByContact: msgMap, reactionsByContact: rxnMap });
      } catch (error) {
        console.error('Messages initial load error:', error);
      }
    }

    // ── Event handlers ──

    const onOptimistic = (message: Message) => {
      if (message.type === MessageType.REACTION) return;
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
          const existing =
            state.reactionsByContact.get(message.contactUserId) || [];
          if (
            message.messageId &&
            existing.some(m => messageIdEquals(m.messageId, message.messageId))
          ) {
            return state;
          }
          const map = new Map(state.reactionsByContact);
          map.set(message.contactUserId, [...existing, message]);
          return { reactionsByContact: map };
        });
        return;
      }

      set(state => {
        const map = patchContact(
          state.messagesByContact,
          message.contactUserId,
          msgs => {
            // Update existing message (edit/delete from peer)
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

    const onWriteConfirmed = (dbId: number, entityType: string) => {
      if (entityType !== 'message') return;
      set(state => {
        const map = findAndPatch(
          state.messagesByContact,
          m => !m.id && m.direction === MessageDirection.OUTGOING,
          m => ({ ...m, id: dbId })
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
          return { messagesByContact: msgMap, reactionsByContact: rxnMap };
        });
      } catch (error) {
        console.error('Session event refetch error:', error);
      }
    };

    sdk.on(SdkEventType.MESSAGE_OPTIMISTIC, onOptimistic);
    sdk.on(SdkEventType.MESSAGE_RECEIVED, onReceived);
    sdk.on(SdkEventType.MESSAGE_SENT, onSent);
    sdk.on(SdkEventType.MESSAGE_READ, onRead);
    sdk.on(SdkEventType.WRITE_CONFIRMED, onWriteConfirmed);
    sdk.on(SdkEventType.WRITE_FAILED, onWriteFailed);
    sdk.on(SdkEventType.SESSION_CREATED, onSessionEvent);
    sdk.on(SdkEventType.SESSION_ACCEPTED, onSessionEvent);

    const cleanupFn = () => {
      try {
        sdk.off(SdkEventType.MESSAGE_OPTIMISTIC, onOptimistic);
        sdk.off(SdkEventType.MESSAGE_RECEIVED, onReceived);
        sdk.off(SdkEventType.MESSAGE_SENT, onSent);
        sdk.off(SdkEventType.MESSAGE_READ, onRead);
        sdk.off(SdkEventType.WRITE_CONFIRMED, onWriteConfirmed);
        sdk.off(SdkEventType.WRITE_FAILED, onWriteFailed);
        sdk.off(SdkEventType.SESSION_CREATED, onSessionEvent);
        sdk.off(SdkEventType.SESSION_ACCEPTED, onSessionEvent);
      } catch {
        // SDK might not be available during cleanup
      }
    };

    set({ cleanupFn, isInitializing: false });
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

    set({ isSending: true });
    try {
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
          console.warn(
            'Forward target message not found, sending as regular message'
          );
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
      if (!result.success)
        console.error('Failed to send message:', result.error);
    } catch (error) {
      console.error('Failed to send message:', error);
      throw error;
    } finally {
      set({ isSending: false });
    }
  },

  getMessagesForContact: contactUserId => {
    return get().messagesByContact.get(contactUserId) || EMPTY_MESSAGES;
  },

  deleteMessage: async (contactUserId, messageId) => {
    const msgs = get().messagesByContact.get(contactUserId) || EMPTY_MESSAGES;
    const removed = msgs.find(m => m.id === messageId);

    // Optimistic remove
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

    // Optimistic update
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
    await getSdk().messages.sendReaction(
      contactUserId,
      emoji,
      target.messageId
    );
  },

  removeReaction: async reactionDbId => {
    const sdk = getSdk();
    const reaction = await sdk.messages.get(reactionDbId);
    if (
      !reaction?.reactionOf?.originalMsgId ||
      reaction.type !== MessageType.REACTION
    ) {
      await sdk.messages.deleteMessage(reactionDbId);
      return;
    }

    const allReactions = await sdk.messages.getReactions(
      reaction.contactUserId
    );
    const targets = allReactions.filter(
      r =>
        r.direction === MessageDirection.OUTGOING &&
        messageIdEquals(
          r.reactionOf?.originalMsgId,
          reaction.reactionOf!.originalMsgId
        ) &&
        r.id != null
    );

    for (const r of targets.length > 0 ? targets : [reaction]) {
      await sdk.messages.deleteMessage(r.id!);
    }
  },

  getReactionsForMessage: (contactUserId, messageDbId) => {
    const reactions =
      get().reactionsByContact.get(contactUserId) || EMPTY_MESSAGES;
    const msgs = get().messagesByContact.get(contactUserId) || EMPTY_MESSAGES;
    const target = msgs.find(m => m.id === messageDbId);
    if (!target?.messageId) return [];

    let latestIncoming: Message | undefined;
    let latestOutgoing: Message | undefined;

    for (const r of reactions) {
      if (!messageIdEquals(r.reactionOf?.originalMsgId, target.messageId))
        continue;
      if (r.direction === MessageDirection.OUTGOING) {
        if (!latestOutgoing || r.timestamp > latestOutgoing.timestamp)
          latestOutgoing = r;
      } else {
        if (!latestIncoming || r.timestamp > latestIncoming.timestamp)
          latestIncoming = r;
      }
    }

    const groups = new Map<string, ReactionGroup>();
    for (const r of [latestIncoming, latestOutgoing].filter(
      Boolean
    ) as Message[]) {
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

    return Array.from(groups.values());
  },

  clearMessages: contactUserId => {
    const msgMap = new Map(get().messagesByContact);
    const rxnMap = new Map(get().reactionsByContact);
    msgMap.delete(contactUserId);
    rxnMap.delete(contactUserId);
    set({ messagesByContact: msgMap, reactionsByContact: rxnMap });
  },

  cleanup: () => {
    get().cleanupFn?.();
    set({
      cleanupFn: null,
      messagesByContact: new Map(),
      reactionsByContact: new Map(),
      currentContactUserId: null,
      isLoading: false,
      isSending: false,
    });
  },
}));

// ---------------------------------------------------------------------------
// Rollback helpers (shared by delete / edit)
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

export const useMessageStore = createSelectors(useMessageStoreBase);
