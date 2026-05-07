import { SELF_CONTACT_ID, type Message } from '@massalabs/gossip-sdk';

/**
 * Minimal SelfMessageService behavior for browser/unit tests that mock `useGossipSdk`
 * without a full session-backed SDK.
 */
export const mockSelfMessagesService = {
  isSelfMessage(message: Message): boolean {
    return message.contactUserId === SELF_CONTACT_ID;
  },

  repliedMessageId(message: Message): number | null {
    if (!mockSelfMessagesService.isSelfMessage(message)) {
      return null;
    }

    const value = message.metadata?.originalMessageId;
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === 'string') {
      const parsed = Number.parseInt(value, 10);
      return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
  },
};
