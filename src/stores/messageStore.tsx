import { create } from 'zustand';
import {
  Message,
  MessageDirection,
  MessageStatus,
  MessageType,
  MESSAGE_ID_SIZE,
  decodeUserId,
} from '@massalabs/gossip-sdk';
import { createSelectors } from './utils/createSelectors';
import { useAccountStore } from './accountStore';
import { getSdk } from './sdkStore';

import type { MessageStoreState } from './messageStore.types';
export type { ReactionGroup } from './messageStore.types';

import {
  messageIdEquals,
  messageIdKey,
  patchContact,
  clearReactionsForDeletedMessage,
  rollbackReplace,
  addReactionToState,
  EMPTY_MESSAGES,
  EMPTY_REACTIONS,
  recomputeFullCache,
  removeReactionFromState,
} from './messageStore.helpers';
import { createEventHandlers } from './messageStore.events';

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
      ])
        .then(([messages, reactions]) => {
          // Guard against stale closure
          if (get().currentContactUserId !== contactUserId) return;
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
        })
        .catch(error => {
          console.error('Failed to load messages for contact:', error);
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
    replyToMessageId?,
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

    if (replyToMessageId) {
      const orig = await getSdk().messages.get(replyToMessageId);
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

    const messageId = crypto.getRandomValues(new Uint8Array(MESSAGE_ID_SIZE));
    const message: Omit<Message, 'id'> = {
      ownerUserId: userProfile.userId,
      contactUserId,
      content,
      type: MessageType.TEXT,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.WAITING_SESSION,
      timestamp: new Date(),
      messageId,
      replyTo,
      forwardOf,
    };

    // Optimistic: add to store immediately
    set(state => {
      const map = patchContact(state.messagesByContact, contactUserId, msgs => [
        ...msgs,
        message as Message,
      ]);
      return map ? { messagesByContact: map } : state;
    });

    try {
      const result = await getSdk().messages.send(message);
      if (result.success && result.message?.id != null) {
        // Patch optimistic message with real DB id
        set(state => {
          const map = patchContact(
            state.messagesByContact,
            contactUserId,
            msgs =>
              msgs.map(m =>
                messageIdEquals(m.messageId, messageId)
                  ? { ...m, id: result.message!.id }
                  : m
              )
          );
          return map ? { messagesByContact: map } : state;
        });
      } else if (!result.success) {
        console.error('Failed to send message:', result.error);
        set(state => {
          const map = patchContact(
            state.messagesByContact,
            contactUserId,
            msgs =>
              msgs.map(m =>
                messageIdEquals(m.messageId, messageId)
                  ? { ...m, status: MessageStatus.FAILED }
                  : m
              )
          );
          return map ? { messagesByContact: map } : state;
        });
      }
    } catch (error) {
      console.error('Failed to send message:', error);
      set(state => {
        const map = patchContact(state.messagesByContact, contactUserId, msgs =>
          msgs.map(m =>
            messageIdEquals(m.messageId, messageId)
              ? { ...m, status: MessageStatus.FAILED }
              : m
          )
        );
        return map ? { messagesByContact: map } : state;
      });
    }
  },

  getMessagesForContact: contactUserId =>
    get().messagesByContact.get(contactUserId) || EMPTY_MESSAGES,

  getReactionsForMessage: (msgId: Uint8Array) =>
    get().reactionGroupsCache.get(messageIdKey(msgId)) || EMPTY_REACTIONS,

  deleteMessage: async (contactUserId, id) => {
    // Save original for rollback
    const msgs = get().messagesByContact.get(contactUserId) || [];
    const original = msgs.find(m => m.id === id);

    // Optimistic: mark as deleted in store
    set(state => {
      const msgMap = patchContact(state.messagesByContact, contactUserId, ms =>
        ms.map(m =>
          m.id === id
            ? { ...m, type: MessageType.DELETED, content: '[Message deleted]' }
            : m
        )
      );
      if (!msgMap) return state;
      const originalMsgId = original?.messageId;
      if (originalMsgId) {
        const rxnUpdate = clearReactionsForDeletedMessage(
          state,
          contactUserId,
          originalMsgId,
          msgMap
        );
        if (rxnUpdate) {
          return { messagesByContact: msgMap, ...rxnUpdate };
        }
      }
      return { messagesByContact: msgMap };
    });

    try {
      await getSdk().messages.deleteMessage(id);
    } catch (error) {
      // Rollback on failure
      if (original) {
        rollbackReplace(set, contactUserId, id, original);
      }
      throw error;
    }
  },

  editMessage: async (contactUserId, id, newContent) => {
    // Save original for rollback
    const msgs = get().messagesByContact.get(contactUserId) || [];
    const original = msgs.find(m => m.id === id);

    // Optimistic: update content in store
    set(state => {
      const map = patchContact(state.messagesByContact, contactUserId, ms =>
        ms.map(m =>
          m.id === id
            ? {
                ...m,
                content: newContent,
                metadata: { ...m.metadata, edited: true },
              }
            : m
        )
      );
      return map ? { messagesByContact: map } : state;
    });

    try {
      await getSdk().messages.editMessage(id, newContent);
    } catch (error) {
      // Rollback on failure
      if (original) {
        rollbackReplace(set, contactUserId, id, original);
      }
      throw error;
    }
  },

  reactToMessage: async (contactUserId, emoji, messageDbId) => {
    const target = (
      get().messagesByContact.get(contactUserId) || EMPTY_MESSAGES
    ).find(m => m.id === messageDbId);
    if (!target?.messageId) return;

    const existing = (
      get().reactionsByContact.get(contactUserId) || EMPTY_MESSAGES
    ).find(
      r =>
        r.direction === MessageDirection.OUTGOING &&
        r.reactionOf?.originalMsgId &&
        messageIdEquals(r.reactionOf.originalMsgId, target.messageId)
    );

    if (existing) {
      if (existing.content === emoji) {
        get().removeReaction(existing.id, existing.messageId);
        return;
      }
      get().removeReaction(existing.id, existing.messageId);
    }

    const reactionMsgId = crypto.getRandomValues(
      new Uint8Array(MESSAGE_ID_SIZE)
    );
    const reaction: Message = {
      ownerUserId: useAccountStore.getState().userProfile?.userId ?? '',
      contactUserId,
      content: emoji,
      type: MessageType.REACTION,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.WAITING_SESSION,
      timestamp: new Date(),
      messageId: reactionMsgId,
      reactionOf: { originalMsgId: target.messageId },
    };

    // Optimistic: add reaction to store
    addReactionToState(set, contactUserId, reaction, false);

    // Persist in background
    getSdk()
      .messages.send(reaction)
      .catch(() => {
        removeReactionFromState(set, contactUserId, r =>
          messageIdEquals(r.messageId, reactionMsgId)
        );
      });
  },

  removeReaction: async reactionDbId => {
    const match = (r: Message) => r.id === reactionDbId;

    for (const [contact, reactions] of get().reactionsByContact) {
      const found = reactions.find(match);
      if (found) {
        removeReactionFromState(set, contact, match);
        break;
      }
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
