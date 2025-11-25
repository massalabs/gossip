import { create } from 'zustand';
import { Message, db } from '../db';
import { createSelectors } from './utils/createSelectors';
import { useAccountStore } from './accountStore';
import { messageService } from '../services/message';
import { notificationService } from '../services/notifications';
import { liveQuery, Subscription } from 'dexie';

interface MessageStoreState {
  // Messages keyed by contactUserId (Map for efficient lookups)
  messagesByContact: Map<string, Message[]>;
  // Current contact being viewed
  currentContactUserId: string | null;
  // Loading state (only one discussion can be viewed at a time)
  isLoading: boolean;
  // Sending state (global, since you can only send to one contact at a time)
  isSending: boolean;
  // Syncing state (global)
  isSyncing: boolean;
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
  resendMessage: (message: Message) => Promise<void>;
  syncMessages: (contactUserId?: string) => Promise<void>;
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
  isSyncing: false,
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
      db.messages.where('ownerUserId').equals(ownerUserId).sortBy('timestamp')
    );

    const subscriptionObj = query.subscribe({
      next: allMessages => {
        console.log('Global live query received messages:', allMessages.length);
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
          const existing = currentMap.get(contactId) || [];
          if (messagesChanged(existing, msgs)) {
            hasChanges = true;
          }
        });
        // Also check for removed contacts (unlikely, but complete)
        currentMap.forEach((_, contactId) => {
          if (!newMap.has(contactId)) hasChanges = true;
        });

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
    const { userProfile } = useAccountStore.getState();
    if (!userProfile?.userId || !content.trim() || get().isSending) return;

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
        type: 'text',
        direction: 'outgoing',
        status: 'sending',
        timestamp: new Date(),
        replyTo,
      };

      // Persist to DB
      const messageId = await db.addMessage(message);
      const messageWithId = { ...message, id: messageId };

      // Send via service
      const result = await messageService.sendMessage(messageWithId);

      // Update status
      if (result.message) {
        get().updateMessage(contactUserId, messageId, {
          status: result.message.status,
        });
      } else if (!result.success) {
        get().updateMessage(contactUserId, messageId, { status: 'failed' });
        throw new Error(result.error);
      }
    } catch (error) {
      console.error('Failed to send message:', error);
      throw error;
    } finally {
      set({ isSending: false });
    }
  },

  // Resend a failed message
  resendMessage: async (message: Message) => {
    set({ isSending: true });
    const result = await messageService.resendMessage(message);
    if (result.error) {
      // Update status to failed again
      console.error('Failed to resend message:', result.error);
    }
    set({ isSending: false });
  },

  // Sync messages (fetch new ones from server)
  syncMessages: async (contactUserId?: string) => {
    const { userProfile } = useAccountStore.getState();
    if (!userProfile?.userId) return;

    if (get().isSyncing) return;
    set({ isSyncing: true });

    try {
      const fetchResult = await messageService.fetchMessages();

      if (fetchResult.success && fetchResult.newMessagesCount > 0) {
        // Reload messages for the current contact if specified, or all contacts
        if (contactUserId) {
          // Show notification if app is in background
          if (document.hidden) {
            const contact = await db
              .getContactByOwnerAndUserId(userProfile.userId, contactUserId)
              .catch(() => null);
            if (contact) {
              await notificationService.showDiscussionNotification(
                contact.name,
                'New message received'
              );
            }
          }
        }
      }
    } catch (error) {
      console.error('Failed to sync messages:', error);
    } finally {
      set({ isSyncing: false });
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
      isSyncing: false,
    });
  },
}));

export const useMessageStore = createSelectors(useMessageStoreBase);
