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
  patchMessages,
  markMessageFailed,
  replaceOptimisticWithPersisted,
  rollbackReplace,
  addReactionToState,
  clearReactionsForDeletedMessage,
  EMPTY_MESSAGES,
  EMPTY_REACTIONS,
  recomputeFullCache,
  removeReactionFromState,
} from './messageStore.helpers';
import { createEventHandlers } from './messageStore.events';

const MESSAGE_ID_SIZE = 12;

/**
 * Resolve the optional replyTo / forwardOf fields for a new outgoing message.
 * A forward to the same contact collapses into a reply (quoting that contact's
 * own message). A forward to a different contact stays a forward.
 */
async function resolveReplyAndForward(
  contactUserId: string,
  replyToId: number | undefined,
  forwardFromMessageId: number | undefined
): Promise<{
  replyTo: Message['replyTo'];
  forwardOf: Message['forwardOf'];
}> {
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
      replyTo = { originalMsgId: orig.messageId };
    } else {
      forwardOf = {
        originalContent: orig.content,
        originalContactId: decodeUserId(orig.contactUserId),
      };
    }
  }

  return { replyTo, forwardOf };
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

  setCurrentContact: async (newContactId: string | null) => {
    if (get().currentContactUserId === newContactId) return;
    set({ currentContactUserId: newContactId });

    // Only fetch when we need it: valid contact, not already cached, session open.
    if (!newContactId || get().messagesByContact.has(newContactId)) return;
    const sdk = getSdk();
    if (!sdk.isSessionOpen) return;

    try {
      const [messages, reactions] = await Promise.all([
        sdk.messages.getVisibleMessages(newContactId),
        sdk.messages.getReactions(newContactId),
      ]);
      // Guard against stale closure
      if (get().currentContactUserId !== newContactId) return;

      set(state => {
        const msgMap = new Map(state.messagesByContact);
        const rxnMap = new Map(state.reactionsByContact);
        if (messages.length > 0) msgMap.set(newContactId, messages);
        if (reactions.length > 0) rxnMap.set(newContactId, reactions);
        return {
          messagesByContact: msgMap,
          reactionsByContact: rxnMap,
          reactionGroupsCache: recomputeFullCache(msgMap, rxnMap),
        };
      });
    } catch (error) {
      console.error('Failed to load messages for contact:', error);
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

    const { replyTo, forwardOf } = await resolveReplyAndForward(
      contactUserId,
      replyToId,
      forwardFromMessageId
    );

    // Local messageId for React key stability + matching the persisted reply.
    // No `id` yet — the UI uses `id == null` to detect unconfirmed messages
    // and hide id-dependent actions (reply/forward/edit/delete/react/swipe).
    const messageId = crypto.getRandomValues(new Uint8Array(MESSAGE_ID_SIZE));
    const optimisticMsg: Message = {
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

    patchMessages(set, contactUserId, msgs => [...msgs, optimisticMsg]);

    try {
      const result = await getSdk().messages.send(optimisticMsg);
      if (!result.success || !result.message) {
        console.error('Failed to send message:', result.error);
        markMessageFailed(set, messageId);
        return;
      }
      replaceOptimisticWithPersisted(
        set,
        contactUserId,
        messageId,
        result.message
      );
    } catch (error) {
      console.error('Failed to send message:', error);
      markMessageFailed(set, messageId);
    }
  },

  getMessagesForContact: contactUserId =>
    get().messagesByContact.get(contactUserId) || EMPTY_MESSAGES,

  getReactionsForMessage: (msgId: Uint8Array) =>
    get().reactionGroupsCache.get(messageIdKey(msgId)) || EMPTY_REACTIONS,

  deleteMessage: async (contactUserId, messageId) => {
    const msgs = get().messagesByContact.get(contactUserId) || EMPTY_MESSAGES;
    const original = msgs.find(m => m.id === messageId);
    if (!original) return;

    // Atomic: mark as deleted AND clear its reactions in a single set() to
    // avoid an intermediate render where the bubble is deleted but its
    // reactions linger.
    set(state => {
      const msgMap = patchContact(state.messagesByContact, contactUserId, ms =>
        ms.map(m =>
          m.id === messageId
            ? { ...m, type: MessageType.DELETED, content: '[Message deleted]' }
            : m
        )
      );
      if (!msgMap) return state;
      const rxnUpdate = original.messageId
        ? clearReactionsForDeletedMessage(
            state,
            contactUserId,
            original.messageId,
            msgMap
          )
        : null;
      return { messagesByContact: msgMap, ...(rxnUpdate ?? {}) };
    });

    try {
      await getSdk().messages.deleteMessage(messageId);
    } catch (error) {
      console.error('Failed to delete message:', error);
      rollbackReplace(set, contactUserId, messageId, original);
    }
  },

  editMessage: async (contactUserId, messageId, newContent) => {
    const msgs = get().messagesByContact.get(contactUserId) || EMPTY_MESSAGES;
    const original = msgs.find(m => m.id === messageId);
    if (!original) return;

    patchMessages(set, contactUserId, ms =>
      ms.map(m =>
        m.id === messageId
          ? {
              ...m,
              content: newContent,
              metadata: { ...m.metadata, edited: true },
            }
          : m
      )
    );

    try {
      await getSdk().messages.editMessage(messageId, newContent);
    } catch (error) {
      console.error('Failed to edit message:', error);
      rollbackReplace(set, contactUserId, messageId, original);
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

    const reactionMsg: Message = {
      ownerUserId: useAccountStore.getState().userProfile?.userId ?? '',
      contactUserId,
      content: emoji,
      type: MessageType.REACTION,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.WAITING_SESSION,
      timestamp: new Date(),
      messageId: crypto.getRandomValues(new Uint8Array(MESSAGE_ID_SIZE)),
      reactionOf: { originalMsgId: target.messageId },
    };

    // Optimistic: add reaction to store immediately
    addReactionToState(set, contactUserId, reactionMsg, false);

    try {
      await getSdk().messages.send(reactionMsg);
    } catch (error) {
      console.error('Failed to send reaction:', error);
      // Remove the optimistic reaction on failure
      removeReactionFromState(set, contactUserId, r =>
        messageIdEquals(r.messageId, reactionMsg.messageId)
      );
    }
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
