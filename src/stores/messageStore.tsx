import { create } from 'zustand';
import {
  Message,
  MessageDirection,
  MessageStatus,
  MessageType,
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
  EMPTY_MESSAGES,
  EMPTY_REACTIONS,
  recomputeFullCache,
  rollbackInsert,
  rollbackReplace,
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

    getSdk().messages.sendOptimistic({
      ownerUserId: useAccountStore.getState().userProfile?.userId ?? '',
      contactUserId,
      content: emoji,
      type: MessageType.REACTION,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.WAITING_SESSION,
      timestamp: new Date(),
      reactionOf: { originalMsgId: target.messageId },
    });
  },

  removeReaction: async (reactionDbId, reactionMessageId?) => {
    const match = (r: Message) =>
      reactionMessageId
        ? messageIdEquals(r.messageId, reactionMessageId)
        : r.id === reactionDbId;

    let matchedContact: string | null = null;
    for (const [contact] of get().reactionsByContact) {
      if (removeReactionFromState(set, contact, match)) {
        matchedContact = contact;
        break;
      }
    }

    const sdk = getSdk();
    let dbId = reactionDbId;
    if (!dbId && reactionMessageId && matchedContact) {
      const ownerUserId = useAccountStore.getState().userProfile?.userId;
      if (ownerUserId) {
        const found = await sdk.messages.findMessageByMsgId(
          reactionMessageId,
          ownerUserId,
          matchedContact
        );
        dbId = found?.id;
      }
    }
    if (dbId) {
      await sdk.messages.deleteMessage(dbId);
    }
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
