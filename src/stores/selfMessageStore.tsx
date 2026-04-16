import { create } from 'zustand';
import {
  Message,
  MessageDirection,
  MessageStatus,
  MessageType,
} from '@massalabs/gossip-sdk';
import { createSelectors } from './utils/createSelectors';
import { getSdk } from './sdkStore';
import { useAccountStore } from './accountStore';
import { ReactionGroup } from './messageStore';
import {
  groupReactions,
  addOptimisticReaction,
  replaceReactionId,
  decrementReaction,
  findReactionById,
  restoreReactionGroup,
  type ReactionsMap,
} from './selfMessageStore.helpers';

interface SelfMessageStore {
  messages: Message[];
  reactions: ReactionsMap;
  isLoading: boolean;
  isSending: boolean;
  loadMessages: () => Promise<void>;
  loadReactions: () => Promise<void>;
  sendMessage: (content: string) => Promise<void>;
  editMessage: (id: number, newContent: string) => Promise<void>;
  deleteMessage: (id: number) => Promise<void>;
  sendReaction: (emoji: string, messageDbId: number) => Promise<void>;
  removeReaction: (reactionId: number) => Promise<void>;
  getReactionsForMessage: (messageDbId: number) => ReactionGroup[];
  clearMessages: () => void;
}

const useSelfMessageStoreBase = create<SelfMessageStore>((set, get) => ({
  messages: [],
  reactions: new Map(),
  isLoading: false,
  isSending: false,

  loadMessages: async () => {
    const sdk = getSdk();
    if (!sdk.isSessionOpen) return;

    set({ isLoading: true });
    try {
      const messages = await sdk.selfMessages.getMessages();
      // Preserve any in-flight optimistic messages (no id yet) so a concurrent
      // send isn't wiped by this load.
      set(state => {
        const optimistic = state.messages.filter(m => m.id == null);
        return { messages: [...messages, ...optimistic] };
      });
    } catch (error) {
      console.error('Failed to load self messages', error);
    } finally {
      set({ isLoading: false });
    }
  },

  loadReactions: async () => {
    const sdk = getSdk();
    if (!sdk.isSessionOpen) return;

    try {
      const raw = await sdk.selfMessages.getReactions();
      set({ reactions: groupReactions(raw) });
    } catch (error) {
      console.error('Failed to load self reactions', error);
    }
  },

  sendMessage: async (content: string) => {
    const trimmed = content.trim();
    if (!trimmed) return;

    const sdk = getSdk();
    if (!sdk.isSessionOpen) return;
    const userProfile = useAccountStore.getState().userProfile;
    if (!userProfile?.userId) return;

    set({ isSending: true });

    // Client-generated messageId so the React key (msg-${messageId}) stays
    // stable across the optimistic → persisted patch. The SDK itself doesn't
    // store messageId for self-messages, so we preserve ours after the write.
    const localMessageId = crypto.getRandomValues(new Uint8Array(12));
    const optimistic: Message = {
      ownerUserId: userProfile.userId,
      contactUserId: '__self__',
      content: trimmed,
      type: MessageType.TEXT,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.SENT,
      timestamp: new Date(),
      messageId: localMessageId,
    };
    set(state => ({ messages: [...state.messages, optimistic] }));
    set({ isSending: false });

    try {
      const message = await sdk.selfMessages.send(trimmed);
      set(state => ({
        messages: state.messages.map(m =>
          m === optimistic ? { ...message, messageId: localMessageId } : m
        ),
      }));
    } catch (error) {
      console.error('Failed to send self message', error);
      set(state => ({
        messages: state.messages.filter(m => m !== optimistic),
      }));
    }
  },

  editMessage: async (id: number, newContent: string) => {
    const sdk = getSdk();
    if (!sdk.isSessionOpen) return;

    const original = get().messages.find(m => m.id === id);
    if (!original) return;

    set(state => ({
      messages: state.messages.map(m =>
        m.id === id
          ? {
              ...m,
              content: newContent,
              metadata: { ...(m.metadata as object), edited: true },
            }
          : m
      ),
    }));

    try {
      await sdk.selfMessages.editMessage(id, newContent);
    } catch (error) {
      console.error('Failed to edit self message', error);
      // Revert just this message in-place so concurrent optimistic sends
      // aren't wiped by a full reload.
      set(state => ({
        messages: state.messages.map(m => (m.id === id ? original : m)),
      }));
    }
  },

  deleteMessage: async (id: number) => {
    const sdk = getSdk();
    if (!sdk.isSessionOpen) return;

    const removed = get().messages.find(m => m.id === id);
    set(state => ({
      messages: state.messages.filter(m => m.id !== id),
    }));

    try {
      await sdk.selfMessages.deleteMessage(id);
    } catch (error) {
      console.error('Failed to delete self message', error);
      if (removed) {
        set(state => ({
          messages: [...state.messages, removed].sort(
            (a, b) => a.timestamp.getTime() - b.timestamp.getTime()
          ),
        }));
      }
    }
  },

  sendReaction: async (emoji: string, messageDbId: number) => {
    const sdk = getSdk();
    if (!sdk.isSessionOpen) return;

    const tempId = -Date.now();
    set(state => ({
      reactions: addOptimisticReaction(
        state.reactions,
        messageDbId,
        emoji,
        tempId
      ),
    }));

    try {
      const reaction = await sdk.selfMessages.sendReaction(emoji, messageDbId);
      set(state => ({
        reactions: replaceReactionId(
          state.reactions,
          messageDbId,
          tempId,
          reaction.id
        ),
      }));
    } catch (error) {
      console.error('Failed to send self reaction', error);
      set(state => ({
        reactions: decrementReaction(
          state.reactions,
          messageDbId,
          g => g.myReactionId === tempId
        ),
      }));
    }
  },

  removeReaction: async (reactionId: number) => {
    const sdk = getSdk();
    if (!sdk.isSessionOpen) return;

    const revertInfo = findReactionById(get().reactions, reactionId);
    if (!revertInfo) return;

    set(state => ({
      reactions: decrementReaction(
        state.reactions,
        revertInfo.messageId,
        g => g.myReactionId === reactionId
      ),
    }));

    try {
      await sdk.selfMessages.removeReaction(reactionId);
    } catch (error) {
      console.error('Failed to remove self reaction', error);
      set(state => ({
        reactions: restoreReactionGroup(
          state.reactions,
          revertInfo.messageId,
          revertInfo.group
        ),
      }));
    }
  },

  getReactionsForMessage: (messageDbId: number): ReactionGroup[] => {
    return get().reactions.get(messageDbId) ?? [];
  },

  clearMessages: () => {
    set({ messages: [], reactions: new Map() });
  },
}));

export const useSelfMessageStore = createSelectors(useSelfMessageStoreBase);
