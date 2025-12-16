/**
 * Message Operations SDK
 *
 * Functions for sending, receiving, and managing messages
 */

import { messageService } from '../../src/services/message';
import { db } from '../../src/db';
import type { Message, MessageResult, SendMessageResult } from '../../src/db';
import type { SessionModule } from '../../src/wasm';
import type { UserSecretKeys } from '../../src/assets/generated/wasm/gossip_wasm';

/**
 * Send a message
 * @param message - Message object to send
 * @param session - The SessionModule instance
 * @returns Result with success status and message
 */
export async function sendMessage(
  message: Omit<Message, 'id'>,
  session: SessionModule
): Promise<SendMessageResult> {
  return await messageService.sendMessage(message, session);
}

/**
 * Fetch new messages for a specific discussion
 * @param userId - Owner user ID
 * @param ourSk - Our secret keys
 * @param session - The SessionModule instance
 * @returns Result with count of new messages fetched
 */
export async function fetchMessages(
  userId: string,
  ourSk: UserSecretKeys,
  session: SessionModule
): Promise<MessageResult> {
  return await messageService.fetchMessages(userId, ourSk, session);
}

/**
 * Resend failed messages
 * @param messages - Map from contactUserId to array of messages to retry
 * @param session - The SessionModule instance
 * @returns Promise that resolves when complete
 */
export async function resendMessages(
  messages: Map<string, Message[]>,
  session: SessionModule
): Promise<void> {
  return await messageService.resendMessages(messages, session);
}

/**
 * Find message by seeker
 * @param seeker - Message seeker (Uint8Array)
 * @param ownerUserId - Owner user ID
 * @returns Message or undefined if not found
 */
export async function findMessageBySeeker(
  seeker: Uint8Array,
  ownerUserId: string
): Promise<Message | undefined> {
  return await messageService.findMessageBySeeker(seeker, ownerUserId);
}

/**
 * Get messages from database
 * @param ownerUserId - Owner user ID
 * @param contactUserId - Optional contact user ID to filter by
 * @returns Array of messages
 */
export async function getMessages(
  ownerUserId: string,
  contactUserId?: string
): Promise<Message[]> {
  try {
    if (contactUserId) {
      return await db.messages
        .where('[ownerUserId+contactUserId]')
        .equals([ownerUserId, contactUserId])
        .sortBy('id');
    } else {
      return await db.messages
        .where('ownerUserId')
        .equals(ownerUserId)
        .sortBy('id');
    }
  } catch (error) {
    console.error('Error getting messages:', error);
    return [];
  }
}

/**
 * Get a specific message by ID
 * @param messageId - Message ID
 * @returns Message or undefined if not found
 */
export async function getMessage(
  messageId: number
): Promise<Message | undefined> {
  try {
    return await db.messages.get(messageId);
  } catch (error) {
    console.error('Error getting message:', error);
    return undefined;
  }
}
