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
 * const messages = await getMessages(userId, contactUserId);
 * ```
 */

import { messageService } from './services/message';
import { db, type Message } from './db';
import type { SessionModule } from './wasm';
import type { MessageResult, SendMessageResult } from './services/message';

// Re-export result types
export type { MessageResult, SendMessageResult };

/**
 * Send a message to a contact.
 *
 * @param message - The message to send
 * @param session - The SessionModule instance
 * @returns Result with success status and sent message
 *
 * @example
 * ```typescript
 * const result = await sendMessage({
 *   ownerUserId: myUserId,
 *   contactUserId: theirUserId,
 *   content: 'Hello!',
 *   type: MessageType.TEXT,
 *   direction: MessageDirection.OUTGOING,
 *   status: MessageStatus.SENDING,
 *   timestamp: new Date(),
 * }, session);
 *
 * if (result.success) {
 *   console.log('Message sent:', result.message?.id);
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
 *
 * @param session - The SessionModule instance
 * @returns Result with success status and new message count
 *
 * @example
 * ```typescript
 * const result = await fetchMessages(session);
 * if (result.success) {
 *   console.log('Fetched', result.newMessagesCount, 'new messages');
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
 *
 * @param messages - Map of contact IDs to arrays of failed messages
 * @param session - The SessionModule instance
 *
 * @example
 * ```typescript
 * const failedMessages = new Map([
 *   [contactUserId, [msg1, msg2]],
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
 * Find a message by its seeker.
 *
 * @param seeker - The seeker bytes
 * @param ownerUserId - The owner user ID
 * @returns Message or undefined if not found
 *
 * @example
 * ```typescript
 * const message = await findMessageBySeeker(seekerBytes, myUserId);
 * if (message) {
 *   console.log('Found message:', message.content);
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
 * Get messages for an owner, optionally filtered by contact.
 *
 * @param ownerUserId - The owner user ID
 * @param contactUserId - Optional contact user ID to filter by
 * @returns Array of messages
 *
 * @example
 * ```typescript
 * // Get all messages
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
      return await db.getMessagesForContactByOwner(ownerUserId, contactUserId);
    }
    // Get all messages for owner
    return await db.messages.where('ownerUserId').equals(ownerUserId).toArray();
  } catch (error) {
    console.error('Error getting messages:', error);
    return [];
  }
}

/**
 * Get a specific message by ID.
 *
 * @param messageId - The message ID
 * @returns Message or null if not found
 *
 * @example
 * ```typescript
 * const message = await getMessage(123);
 * if (message) {
 *   console.log('Message content:', message.content);
 * }
 * ```
 */
export async function getMessage(messageId: number): Promise<Message | null> {
  try {
    const message = await db.messages.get(messageId);
    return message ?? null;
  } catch (error) {
    console.error('Error getting message:', error);
    return null;
  }
}

/**
 * Get messages for a contact with optional limit.
 *
 * @param ownerUserId - The owner user ID
 * @param contactUserId - The contact user ID
 * @param limit - Maximum number of messages to return (default: 50)
 * @returns Array of messages (most recent first)
 *
 * @example
 * ```typescript
 * const recentMessages = await getMessagesForContact(myUserId, contactUserId, 20);
 * ```
 */
export async function getMessagesForContact(
  ownerUserId: string,
  contactUserId: string,
  limit: number = 50
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
