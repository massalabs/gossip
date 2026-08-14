import {
  Message,
  MessageStatus,
  MessageDirection,
} from '@massalabs/gossip-sdk';

/**
 * Find the first unread message in a list of messages
 * @param messages - Array of messages sorted chronologically (oldest first)
 * @returns The first unread incoming message (DELIVERED status) or null if none found
 */
export function findFirstUnreadMessage(messages: Message[]): Message | null {
  // Messages are sorted by ID, so chronological order
  // Find the first incoming message with DELIVERED status (unread)
  for (const message of messages) {
    if (
      message.direction === MessageDirection.INCOMING &&
      message.status === MessageStatus.DELIVERED
    ) {
      return message;
    }
  }
  return null;
}

/**
 * Check if a discussion has any unread messages
 * @param messages - Array of messages for the discussion
 * @returns true if there are unread incoming messages
 */
export function hasUnreadMessages(messages: Message[]): boolean {
  return messages.some(
    message =>
      message.direction === MessageDirection.INCOMING &&
      message.status === MessageStatus.DELIVERED
  );
}

/**
 * Flatten the text a user can see in a message bubble for forwarding.
 * Forwarded messages render their cited body before the optional comment, so
 * re-forwarding must preserve both rather than forwarding only `content`.
 */
export function getForwardSourceContent(
  message: Pick<Message, 'content' | 'forwardOf'>
): string {
  const parts = [message.forwardOf?.originalContent, message.content].filter(
    (part): part is string => typeof part === 'string' && part.length > 0
  );
  return parts.join('\n\n');
}
