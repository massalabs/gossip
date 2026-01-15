/**
 * Message Operations SDK
 *
 * Functions for sending, receiving, and managing messages.
 *
 * @example
 * ```typescript
 * import { sendMessage, fetchMessages, getMessages } from 'gossip-sdk';
 *
 * // Send a message
 * const result = await sendMessage(message, session);
 *
 * // Fetch new messages from server
 * const fetchResult = await fetchMessages(session);
 *
 * // Get messages from database
 * const messages = await getMessages(ownerUserId, contactUserId);
 * ```
 */

import { messageService } from '@/services/message';
import { db } from '@/db';
import type { Message } from '@/db';
import type { MessageResult, SendMessageResult } from '@/services/message';
import type { SessionModule } from '@/wasm';

// Re-export result types
export type { MessageResult, SendMessageResult };

/**
 * Send a message to a contact.
 * The message is encrypted and sent via the message protocol.
 *
 * @param message - Message object to send (without id)
 * @param session - The SessionModule instance for the current user
 * @returns Result with success status and sent message
 *
 * @example
 * ```typescript
 * const message = {
 *   ownerUserId: myUserId,
 *   contactUserId: theirUserId,
 *   content: 'Hello!',
 *   type: MessageType.TEXT,
 *   direction: MessageDirection.OUTGOING,
 *   status: MessageStatus.SENDING,
 *   timestamp: new Date(),
 * };
 *
 * const result = await sendMessage(message, session);
 * if (result.success) {
 *   console.log('Message sent:', result.message?.id);
 * } else {
 *   console.error('Failed:', result.error);
 * }
 * ```
 */
export async function sendMessage(
  message: Message,
  session: SessionModule
): Promise<SendMessageResult> {
  return await messageService.sendMessage(message, session);
}

/**
 * Fetch new messages from the server.
 * Decrypts messages and stores them in the database.
 *
 * @param session - The SessionModule instance for the current user
 * @returns Result with count of new messages fetched
 *
 * @example
 * ```typescript
 * const result = await fetchMessages(session);
 * if (result.success) {
 *   console.log(`Fetched ${result.newMessagesCount} new messages`);
 * }
 * ```
 */
export async function fetchMessages(
  session: SessionModule
): Promise<MessageResult> {
  return await messageService.fetchMessages(session);
}

/**
 * Resend failed messages.
 * Attempts to resend messages that failed to send previously.
 *
 * @param messages - Map from contactUserId to array of messages to retry
 * @param session - The SessionModule instance for the current user
 *
 * @example
 * ```typescript
 * const failedMessages = new Map([
 *   [contactUserId, [message1, message2]],
 * ]);
 * await resendMessages(failedMessages, session);
 * ```
 */
export async function resendMessages(
  messages: Map<string, Message[]>,
  session: SessionModule
): Promise<void> {
  return await messageService.resendMessages(messages, session);
}

/**
 * Find message by seeker.
 * Useful for finding the original message when processing replies.
 *
 * @param seeker - Message seeker (Uint8Array)
 * @param ownerUserId - Owner user ID
 * @returns Message or undefined if not found
 *
 * @example
 * ```typescript
 * const originalMessage = await findMessageBySeeker(seeker, myUserId);
 * if (originalMessage) {
 *   console.log('Found original:', originalMessage.content);
 * }
 * ```
 */
export async function findMessageBySeeker(
  seeker: Uint8Array,
  ownerUserId: string
): Promise<Message | undefined> {
  return await messageService.findMessageBySeeker(seeker, ownerUserId);
}

/**
 * Get messages from the database.
 * Optionally filter by contact user ID.
 *
 * @param ownerUserId - Owner user ID
 * @param contactUserId - Optional contact user ID to filter by
 * @returns Array of messages sorted by id
 *
 * @example
 * ```typescript
 * // Get all messages for a user
 * const allMessages = await getMessages(myUserId);
 *
 * // Get messages for a specific contact
 * const contactMessages = await getMessages(myUserId, contactUserId);
 * ```
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
 * Get a specific message by ID.
 *
 * @param messageId - Message ID
 * @returns Message or undefined if not found
 *
 * @example
 * ```typescript
 * const message = await getMessage(123);
 * if (message) {
 *   console.log('Message:', message.content);
 * }
 * ```
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

/**
 * Get messages for a contact with pagination.
 *
 * @param ownerUserId - Owner user ID
 * @param contactUserId - Contact user ID
 * @param limit - Maximum number of messages to return (default: 50)
 * @returns Array of messages (most recent first)
 *
 * @example
 * ```typescript
 * // Get last 20 messages
 * const messages = await getMessagesForContact(myUserId, contactUserId, 20);
 * ```
 */
export async function getMessagesForContact(
  ownerUserId: string,
  contactUserId: string,
  limit = 50
): Promise<Message[]> {
  try {
    return await db.getMessagesForContactByOwner(
      ownerUserId,
      contactUserId,
      limit
    );
  } catch (error) {
    console.error('Error getting messages for contact:', error);
    return [];
  }
}
