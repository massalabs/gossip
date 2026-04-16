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
import { messageIdKey } from './messageStore.helpers';

interface SelfMessageStore {
  messages: Message[];
  /** Reactions keyed by target message's messageIdKey */
  reactions: Map<string, ReactionGroup[]>;
  isLoading: boolean;
  isSending: boolean;
  loadMessages: () => Promise<void>;
  loadReactions: () => Promise<void>;
  sendMessage: (content: string) => Promise<void>;
  editMessage: (id: number, newContent: string) => Promise<void>;
  deleteMessage: (id: number) => Promise<void>;
  sendReaction: (emoji: string, targetMessageDbId: number) => Promise<void>;
  removeReaction: (reactionId: number) => Promise<void>;
  getReactionsForMessage: (targetMessageId: Uint8Array) => ReactionGroup[];
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
      set({ messages });
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
      const map = new Map<string, ReactionGroup[]>();
      for (const {
        id,
        messageId: reactionMessageId,
        emoji,
        originalMessageId,
      } of raw) {
        const key = messageIdKey(originalMessageId);
        const existing: ReactionGroup[] = map.get(key) ?? [];
        const groupIndex = existing.findIndex(g => g.emoji === emoji);
        if (groupIndex >= 0) {
          existing[groupIndex] = {
            ...existing[groupIndex],
            count: existing[groupIndex].count + 1,
            myReactionId: id,
            myReactionMessageId: reactionMessageId,
          };
        } else {
          existing.push({
            emoji,
            count: 1,
            myReactionId: id,
            myReactionMessageId: reactionMessageId,
          });
        }
        map.set(key, existing);
      }
      set({ reactions: map });
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

    // Optimistic: add to state before SDK call
    const optimistic: Message = {
      ownerUserId: userProfile.userId,
      contactUserId: '__self__',
      content: trimmed,
      type: MessageType.TEXT,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.SENT,
      timestamp: new Date(),
    };
    set(state => ({ messages: [...state.messages, optimistic] }));
    set({ isSending: false });

    try {
      const message = await sdk.selfMessages.send(trimmed);
      // Replace optimistic with persisted (has real id)
      set(state => ({
        messages: state.messages.map(m => (m === optimistic ? message : m)),
      }));
    } catch (error) {
      console.error('Failed to send self message', error);
      // Remove optimistic message
      set(state => ({
        messages: state.messages.filter(m => m !== optimistic),
      }));
    }
  },

  editMessage: async (id: number, newContent: string) => {
    const sdk = getSdk();
    if (!sdk.isSessionOpen) return;

    // Optimistic update
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
      // Revert by reloading
      const messages = await sdk.selfMessages.getMessages();
      set({ messages });
    }
  },

  deleteMessage: async (id: number) => {
    const sdk = getSdk();
    if (!sdk.isSessionOpen) return;

    // Optimistic: remove from state
    const removed = get().messages.find(m => m.id === id);
    set(state => ({
      messages: state.messages.filter(m => m.id !== id),
    }));

    try {
      await sdk.selfMessages.deleteMessage(id);
    } catch (error) {
      console.error('Failed to delete self message', error);
      // Rollback
      if (removed) {
        set(state => ({
          messages: [...state.messages, removed].sort(
            (a, b) => a.timestamp.getTime() - b.timestamp.getTime()
          ),
        }));
      }
    }
  },

  sendReaction: async (emoji: string, targetMessageDbId: number) => {
    const sdk = getSdk();
    if (!sdk.isSessionOpen) return;

    const target = get().messages.find(m => m.id === targetMessageDbId);
    if (!target?.messageId) return;
    const key = messageIdKey(target.messageId);

    // Optimistic update with a temporary negative ID
    const tempId = -Date.now();
    set(state => {
      const map = new Map(state.reactions);
      const existing: ReactionGroup[] = map.get(key) ?? [];
      const groupIndex = existing.findIndex(g => g.emoji === emoji);
      if (groupIndex >= 0) {
        const updated = [...existing];
        updated[groupIndex] = {
          ...updated[groupIndex],
          count: updated[groupIndex].count + 1,
          myReactionId: tempId,
        };
        map.set(key, updated);
      } else {
        map.set(key, [...existing, { emoji, count: 1, myReactionId: tempId }]);
      }
      return { reactions: map };
    });

    try {
      const reaction = await sdk.selfMessages.sendReaction(
        emoji,
        targetMessageDbId
      );
      // Replace temp ID with real DB/messageId
      set(state => {
        const map = new Map(state.reactions);
        const groups = map.get(key);
        if (groups) {
          map.set(
            key,
            groups.map(g =>
              g.myReactionId === tempId
                ? {
                    ...g,
                    myReactionId: reaction.id,
                    myReactionMessageId: reaction.messageId,
                  }
                : g
            )
          );
        }
        return { reactions: map };
      });
    } catch (error) {
      console.error('Failed to send self reaction', error);
      // Revert optimistic update
      set(state => {
        const map = new Map(state.reactions);
        const groups = map.get(key);
        if (groups) {
          const updated = groups
            .map(g =>
              g.myReactionId === tempId
                ? { ...g, count: g.count - 1, myReactionId: undefined }
                : g
            )
            .filter(g => g.count > 0);
          if (updated.length === 0) map.delete(key);
          else map.set(key, updated);
        }
        return { reactions: map };
      });
    }
  },

  removeReaction: async (reactionId: number) => {
    const sdk = getSdk();
    if (!sdk.isSessionOpen) return;

    // Optimistic update — find and save the group for potential revert
    type RevertInfo = { key: string; group: ReactionGroup };
    const revertInfoHolder: { value: RevertInfo | null } = { value: null };
    set(state => {
      const map = new Map(state.reactions);
      map.forEach((groups, key) => {
        const groupIndex = groups.findIndex(g => g.myReactionId === reactionId);
        if (groupIndex >= 0) {
          revertInfoHolder.value = { key, group: groups[groupIndex] };
          const target = groups[groupIndex];
          const updated = groups
            .map(g =>
              g === target
                ? { ...g, count: g.count - 1, myReactionId: undefined }
                : g
            )
            .filter(g => g.count > 0);
          if (updated.length === 0) map.delete(key);
          else map.set(key, updated);
        }
      });
      return { reactions: map };
    });

    try {
      await sdk.selfMessages.removeReaction(reactionId);
    } catch (error) {
      console.error('Failed to remove self reaction', error);
      // Revert optimistic update
      if (revertInfoHolder.value) {
        const { key, group } = revertInfoHolder.value;
        set(state => {
          const map = new Map(state.reactions);
          const existing: ReactionGroup[] = map.get(key) ?? [];
          map.set(key, [...existing, group]);
          return { reactions: map };
        });
      }
    }
  },

  getReactionsForMessage: (targetMessageId: Uint8Array): ReactionGroup[] => {
    return get().reactions.get(messageIdKey(targetMessageId)) ?? [];
  },

  clearMessages: () => {
    set({ messages: [], reactions: new Map() });
  },
}));

export const useSelfMessageStore = createSelectors(useSelfMessageStoreBase);
