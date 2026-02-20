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

const POLL_INTERVAL_MS = 3000;

interface MessageStoreState {
  // Messages keyed by contactUserId (Map for efficient lookups)
  messagesByContact: Map<string, Message[]>;
  // Current contact being viewed
  currentContactUserId: string | null;
  // Loading state (only one discussion can be viewed at a time)
  isLoading: boolean;
  // Sending state (global, since you can only send to one contact at a time)
  isSending: boolean;
  // Polling timer and event handler
  pollTimer: ReturnType<typeof setInterval> | null;
  eventHandler: (() => void) | null;
  cancelDebounce: (() => void) | null;

  init: () => Promise<void>;
  isInitializing: boolean;

  // Actions
  setCurrentContact: (contactUserId: string | null) => void;
  sendMessage: (
    contactUserId: string,
    content: string,
    replyToId?: number,
    forwardFromMessageId?: number
  ) => Promise<void>;
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
    newMessages.length > existing.length || // New messages at the end
    existing.some((existingMsg, index) => {
      const newMsg = newMessages[index];
      if (!newMsg) return true; // New message added
      return (
        existingMsg.id !== newMsg.id ||
        existingMsg.content !== newMsg.content ||
        existingMsg.status !== newMsg.status
      );
    })
  );
};

const useMessageStoreBase = create<MessageStoreState>((set, get) => ({
  // Initial state
  messagesByContact: new Map(),
  currentContactUserId: null,
  isLoading: false,
  isSending: false,
  pollTimer: null,
  eventHandler: null,
  cancelDebounce: null,
  isInitializing: false,

  // Set current contact (for viewing messages)
  setCurrentContact: (contactUserId: string | null) => {
    const current = get().currentContactUserId;
    // Only update if contact actually changed
    if (current === contactUserId) return;

    set({ currentContactUserId: contactUserId });
  },

  // Initialize the store with polling + event-driven refetch
  init: async () => {
    const { userProfile } = useAccountStore.getState();
    const ownerUserId = userProfile?.userId;

    if (!ownerUserId || get().pollTimer || get().isInitializing) return;

    set({ isInitializing: true });

    let isFetching = false;
    const fetchAllMessages = async () => {
      if (isFetching) return;
      isFetching = true;
      try {
        const sdk = getSdk();
        if (!sdk.isSessionOpen) return;

        // Get all contacts from the discussion store to know which contacts have messages
        const discussions = await sdk.discussions.list(ownerUserId);
        const contactUserIds = discussions.map(d => d.contactUserId);

        // Fetch messages for all contacts
        const newMap = new Map<string, Message[]>();
        for (const contactUserId of contactUserIds) {
          const allMessages = await sdk.messages.getMessages(contactUserId);
          const filtered = allMessages
            .filter(m => m.type !== MessageType.KEEP_ALIVE)
            .sort((a, b) => (a.id ?? 0) - (b.id ?? 0));
          if (filtered.length > 0) {
            newMap.set(contactUserId, filtered);
          }
        }

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

        // Also check for removed contacts
        if (!hasChanges) {
          currentMap.forEach((_, contactId) => {
            if (!newMap.has(contactId)) hasChanges = true;
          });
        }

        if (hasChanges) {
          set({ messagesByContact: newMap });
        }
      } catch (error) {
        console.error('Messages fetch error:', error);
      } finally {
        isFetching = false;
      }
    };

    // Immediate fetch
    await fetchAllMessages();

    // Polling interval
    const timer = setInterval(fetchAllMessages, POLL_INTERVAL_MS);

    // Event-driven immediate refetch (debounced to collapse rapid events)
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    const onEvent = () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(fetchAllMessages, 100);
    };
    const cancelDebounce = () => {
      if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
    };
    const sdk = getSdk();
    sdk.on(SdkEventType.MESSAGE_RECEIVED, onEvent);
    sdk.on(SdkEventType.MESSAGE_SENT, onEvent);
    sdk.on(SdkEventType.MESSAGE_READ, onEvent);
    sdk.on(SdkEventType.SESSION_CREATED, onEvent);
    sdk.on(SdkEventType.SESSION_ACCEPTED, onEvent);

    set({
      pollTimer: timer,
      eventHandler: onEvent,
      cancelDebounce,
      isInitializing: false,
    });
  },

  // Send a message
  sendMessage: async (
    contactUserId: string,
    content: string,
    replyToId?: number,
    forwardFromMessageId?: number
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
      const discussion = await getSdk().discussions.get(
        userProfile.userId,
        contactUserId
      );

      if (!discussion) {
        throw new Error('Discussion not found');
      }

      // Create message with sending status
      let replyTo: Message['replyTo'] = undefined;
      let forwardOf: Message['forwardOf'] = undefined;

      if (replyToId) {
        // Look up the original message to get its seeker
        const originalMessage = await getSdk().messages.get(replyToId);
        if (!originalMessage) {
          throw new Error('Original message not found');
        }
        if (!originalMessage.messageId) {
          throw new Error('Cannot reply to a message that has no messageId');
        }
        replyTo = {
          originalMsgId: originalMessage.messageId,
        };
      }

      if (forwardFromMessageId) {
        const originalMessage =
          await getSdk().messages.get(forwardFromMessageId);
        if (!originalMessage) {
          console.warn(
            'Forward target message not found, sending as regular message'
          );
        } else if (!originalMessage.messageId) {
          throw new Error('Cannot forward a message that has no messageId');
        } else if (originalMessage.contactUserId === contactUserId) {
          // Forwarding within the same discussion → treat as a reply
          replyTo = {
            originalMsgId: originalMessage.messageId!,
          };
        } else {
          // Forwarding to a different discussion → use forward metadata
          let originalContactId: Uint8Array;
          try {
            originalContactId = decodeUserId(originalMessage.contactUserId);
          } catch {
            throw new Error('Invalid original contact userId');
          }

          forwardOf = {
            originalContent: originalMessage.content,
            originalContactId,
          };
        }
      }

      const message: Omit<Message, 'id'> = {
        ownerUserId: userProfile.userId,
        contactUserId,
        content,
        type: MessageType.TEXT,
        direction: MessageDirection.OUTGOING,
        status: MessageStatus.WAITING_SESSION,
        timestamp: new Date(),
        replyTo,
        forwardOf,
      };

      // Send via service
      const result = await getSdk().messages.send(message);
      if (!result.success) {
        if (result.message) {
          console.warn(
            `Message has been added to pending queue waiting to be resent. Cause: ${result.error}`
          );
        } else {
          console.error('Failed to send message, got error:', result.error);
        }
      }
    } catch (error) {
      console.error('Failed to send message:', error);
      throw error;
    } finally {
      set({ isSending: false });
    }
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
    const timer = get().pollTimer;
    if (timer) clearInterval(timer);
    get().cancelDebounce?.();
    const handler = get().eventHandler;
    if (handler) {
      try {
        const sdk = getSdk();
        sdk.off(SdkEventType.MESSAGE_RECEIVED, handler);
        sdk.off(SdkEventType.MESSAGE_SENT, handler);
        sdk.off(SdkEventType.MESSAGE_READ, handler);
        sdk.off(SdkEventType.SESSION_CREATED, handler);
        sdk.off(SdkEventType.SESSION_ACCEPTED, handler);
      } catch {
        // SDK might not be available during cleanup
      }
    }
    set({
      pollTimer: null,
      eventHandler: null,
      cancelDebounce: null,
      messagesByContact: new Map(),
      currentContactUserId: null,
      isLoading: false,
      isSending: false,
    });
  },
}));

export const useMessageStore = createSelectors(useMessageStoreBase);
