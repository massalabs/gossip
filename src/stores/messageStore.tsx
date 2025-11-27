import { create } from 'zustand';
import {
  Message,
  db,
  MessageDirection,
  MessageStatus,
  MessageType,
} from '../db';
import { createSelectors } from './utils/createSelectors';
import { useAccountStore } from './accountStore';
import { messageService } from '../services/message';
import { liveQuery, Subscription } from 'dexie';
import { EncryptedMessage } from '../api/messageProtocol/types';

export interface RetryMessages {
  id: number;
  encryptedMessage?: EncryptedMessage;
  content: string;
  type: MessageType;
}

interface MessageStoreState {
  // Messages keyed by contactUserId (Map for efficient lookups)
  messagesByContact: Map<string, Message[]>;
  // Current contact being viewed
  currentContactUserId: string | null;
  // Loading state (only one discussion can be viewed at a time)
  isLoading: boolean;
  // Sending state (global, since you can only send to one contact at a time)
  isSending: boolean;
  // Subscription for liveQuery
  subscription: Subscription | null;

  init: () => Promise<void>;
  isInitializing: boolean;

  // Actions
  setCurrentContact: (contactUserId: string | null) => void;
  sendMessage: (
    contactUserId: string,
    content: string,
    replyToId?: number
  ) => Promise<void>;
  resendMessages: () => Promise<void>;
  addMessage: (contactUserId: string, message: Message) => void;
  updateMessage: (
    contactUserId: string,
    messageId: number,
    updates: Partial<Message>
  ) => void;
  getMessagesForContact: (contactUserId: string) => Message[];
  clearMessages: (contactUserId: string) => void;
  cleanup: () => void;
}

// Empty array constant to avoid creating new arrays on each call
const EMPTY_MESSAGES: Message[] = [];

// Helper to check if messages actually changed
const messagesChanged = (
  existing: Message[],
  newMessages: Message[]
): boolean => {
  return (
    existing.length !== newMessages.length ||
    existing.some((existing, index) => {
      const newMsg = newMessages[index];
      if (!newMsg) return true; // New message added
      return (
        existing.id !== newMsg.id ||
        existing.content !== newMsg.content ||
        existing.status !== newMsg.status
      );
    }) ||
    newMessages.length > existing.length // New messages at the end
  );
};

// Helper to update messages map immutably
const updateMessagesMap = (
  currentMap: Map<string, Message[]>,
  contactUserId: string,
  updater: (messages: Message[]) => Message[]
): Map<string, Message[]> => {
  const newMap = new Map(currentMap);
  const existing = newMap.get(contactUserId) || [];
  newMap.set(contactUserId, updater(existing));
  return newMap;
};

const useMessageStoreBase = create<MessageStoreState>((set, get) => ({
  // Initial state
  messagesByContact: new Map(),
  currentContactUserId: null,
  isLoading: false,
  isSending: false,
  subscription: null,
  isInitializing: false,

  // Set current contact (for viewing messages)
  setCurrentContact: (contactUserId: string | null) => {
    const current = get().currentContactUserId;
    // Only update if contact actually changed
    if (current === contactUserId) return;

    set({ currentContactUserId: contactUserId });
  },

  // New: Initialize the store with a global liveQuery subscription
  init: async () => {
    const { userProfile } = useAccountStore.getState();
    const ownerUserId = userProfile?.userId;

    if (!ownerUserId || get().subscription || get().isInitializing) return; // Already initialized

    set({ isInitializing: true });
    // Set up a single liveQuery for all messages of the owner
    const query = liveQuery(() =>
      db.messages.where('ownerUserId').equals(ownerUserId).sortBy('id')
    );

    const subscriptionObj = query.subscribe({
      next: allMessages => {
        // Group messages by contactUserId
        const newMap = new Map<string, Message[]>();
        allMessages.forEach(msg => {
          const contactId = msg.contactUserId;
          const existing = newMap.get(contactId) || [];
          newMap.set(contactId, [...existing, msg]);
        });

        // Check for changes before updating to avoid unnecessary sets
        let hasChanges = false;
        const currentMap = get().messagesByContact;

        newMap.forEach((msgs, contactId) => {
          if (!hasChanges) {
            const existing = currentMap.get(contactId) || [];
            if (messagesChanged(existing, msgs)) {
              hasChanges = true;
            }
          }
        });

        // Also check for removed contacts (unlikely, but complete)
        if (!hasChanges) {
          currentMap.forEach((_, contactId) => {
            if (!newMap.has(contactId)) hasChanges = true;
          });
        }

        if (hasChanges) {
          set({ messagesByContact: newMap });
        }
      },
      error: error => {
        console.error('Global live query error:', error);
      },
      complete: () => {
        set({ isLoading: false });
      },
    });

    set({ subscription: subscriptionObj, isInitializing: false }); // Loading during initial fetch
  },

  // Send a message
sendMessage: async (
  contactUserId: string,
  content: string,
  replyToId?: number
) => {
  const { userProfile, session } = useAccountStore.getState();
  if (
    !userProfile?.userId ||
    !content.trim() ||
    get().isSending ||
    !session
  )
    return;

    set({ isSending: true });

    try {
      const discussion = await db.getDiscussionByOwnerAndContact(
        userProfile.userId,
        contactUserId
      );

      if (!discussion) {
        throw new Error('Discussion not found');
      }

      // Create message with sending status
      let replyTo: Message['replyTo'] = undefined;
      if (replyToId) {
        // Look up the original message to get its seeker
        const originalMessage = await db.messages.get(replyToId);
        if (!originalMessage) {
          throw new Error('Original message not found');
        }
        if (!originalMessage.seeker) {
          throw new Error(
            'Cannot reply to a message that has not been sent yet'
          );
        }
        replyTo = {
          originalSeeker: originalMessage.seeker,
        };
      }

      const message: Omit<Message, 'id'> = {
        ownerUserId: userProfile.userId,
        contactUserId,
        content,
        type: MessageType.TEXT,
        direction: MessageDirection.OUTGOING,
        status: MessageStatus.SENDING,
        timestamp: new Date(),
        replyTo,
      };

      // Send via service
      const result = await messageService.sendMessage(message, session);
      if (!result.success) {
        console.error(
          'Failed to send message ',
          content,
          ', got error:',
          result.error
        );
      }
    } catch (error) {
      console.error('Failed to send message:', error);
      throw error;
    } finally {
      set({ isSending: false });
    }
  },

  // Add a message to the store
  addMessage: (contactUserId: string, message: Message) => {
    set({
      messagesByContact: updateMessagesMap(
        get().messagesByContact,
        contactUserId,
        existing => [...existing, message]
      ),
    });
  },

  // Update a message in the store
  updateMessage: (
    contactUserId: string,
    messageId: number,
    updates: Partial<Message>
  ) => {
    set({
      messagesByContact: updateMessagesMap(
        get().messagesByContact,
        contactUserId,
        messages =>
          messages.map(m => (m.id === messageId ? { ...m, ...updates } : m))
      ),
    });
  },

  // Get messages for a contact
  getMessagesForContact: (contactUserId: string) => {
    return get().messagesByContact.get(contactUserId) || EMPTY_MESSAGES;
  },

  // Clear messages for a contact
  clearMessages: (contactUserId: string) => {
    const newMap = new Map(get().messagesByContact);
    newMap.delete(contactUserId);
    set({ messagesByContact: newMap });
  },

  cleanup: () => {
    const subscription = get().subscription;
    if (subscription) {
      subscription.unsubscribe();
      set({ subscription: null });
    }
    set({
      messagesByContact: new Map(),
      currentContactUserId: null,
      isLoading: false,
      isSending: false,
    });
  },
}));

export const useMessageStore = createSelectors(useMessageStoreBase);
