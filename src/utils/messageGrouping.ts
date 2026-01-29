import { Message } from '@massalabs/gossip-sdk'

/**
 * Maximum time gap (in minutes) between messages to consider them part of the same group
 */
export const MESSAGE_GROUP_TIME_WINDOW_MINUTES = 5;

/**
 * Check if two messages should be grouped together
 * Messages are grouped if:
 * - They are from the same sender (same direction)
 * - They are within the time window
 * - The previous message is not a reply (replies break groups)
 */
export function shouldGroupMessages(
  current: Message,
  previous: Message | null
): boolean {
  if (!previous) return false;

  // Messages from different senders cannot be grouped
  if (current.direction !== previous.direction) return false;

  // Replies break message groups
  if (current.replyTo || previous.replyTo) return false;

  // Check if messages are within the time window
  // Use Math.abs() to handle potential out-of-order messages gracefully
  const timeDiffMs = current.timestamp.getTime() - previous.timestamp.getTime();
  const timeDiffMinutes = Math.abs(timeDiffMs / 60000);

  return timeDiffMinutes <= MESSAGE_GROUP_TIME_WINDOW_MINUTES;
}

/**
 * Calculate grouping information for a list of messages
 * Returns an array of objects indicating whether each message is first/last in its group
 */
export interface MessageGroupInfo {
  isFirstInGroup: boolean;
  isLastInGroup: boolean;
}

export function calculateMessageGroups(
  messages: Message[]
): MessageGroupInfo[] {
  if (messages.length === 0) return [];

  const groups: MessageGroupInfo[] = [];

  messages.forEach((message, index) => {
    const prevMessage = index > 0 ? messages[index - 1] : null;
    const nextMessage =
      index < messages.length - 1 ? messages[index + 1] : null;

    const isFirstInGroup =
      !prevMessage || !shouldGroupMessages(message, prevMessage);
    const isLastInGroup =
      !nextMessage || !shouldGroupMessages(nextMessage, message);

    groups.push({
      isFirstInGroup,
      isLastInGroup,
    });
  });

  return groups;
}
