import { useMemo } from 'react';
import {
  Message,
  DiscussionDirection,
  MessageType,
} from '@massalabs/gossip-sdk';
import type { Discussion } from '../../../db';
import { isDifferentDay } from '../../../utils/timeUtils';
import {
  calculateMessageGroups,
  MessageGroupInfo,
  MESSAGE_GROUP_TIME_WINDOW_MINUTES,
} from '../../../utils/messageGrouping';

// =============================================================================
// Types
// =============================================================================

export type AnnouncementItem = {
  type: 'announcement';
  content: string;
  direction: DiscussionDirection;
};

export type DateItem = {
  type: 'date';
  date: Date;
  key: string;
};

export type MessageVirtualItem = {
  type: 'message';
  message: Message;
  showTimestamp: boolean;
  groupInfo: MessageGroupInfo;
};

export type SpacerItem = {
  type: 'spacer';
};

export type VirtualItem =
  | AnnouncementItem
  | DateItem
  | MessageVirtualItem
  | SpacerItem;

// =============================================================================
// Hooks
// =============================================================================

/**
 * Calculates message grouping info for spacing and avatar display
 */
export function useMessageGroups(messages: Message[]): MessageGroupInfo[] {
  return useMemo(() => calculateMessageGroups(messages), [messages]);
}

/**
 * Determines if a timestamp should be shown for a message
 */
function shouldShowTimestamp(
  message: Message,
  nextMessage: Message | null,
  isLastMessage: boolean
): boolean {
  if (isLastMessage) return true;
  if (!nextMessage) return true;

  const sameDirection = nextMessage.direction === message.direction;
  const timeDiffMs =
    nextMessage.timestamp.getTime() - message.timestamp.getTime();

  // Negative time difference (unusual case) - show timestamp
  if (timeDiffMs < 0) return true;

  const timeDiffMinutes = timeDiffMs / 60000;

  // Show timestamp if direction changes or enough time has passed
  return !sameDirection || timeDiffMinutes >= MESSAGE_GROUP_TIME_WINDOW_MINUTES;
}

/**
 * Builds the virtualized item list from messages and discussion
 * Includes: announcement (if exists) + date separators + messages + spacer
 */
export function useVirtualItems(
  messages: Message[],
  messageGroups: MessageGroupInfo[],
  discussion?: Discussion | null
): VirtualItem[] {
  return useMemo(() => {
    const items: VirtualItem[] = [];

    messages.forEach((message, index) => {
      const prevMessage = index > 0 ? messages[index - 1] : null;
      const nextMessage =
        index < messages.length - 1 ? messages[index + 1] : null;
      const isLastMessage = index === messages.length - 1;

      const groupInfo: MessageGroupInfo = messageGroups[index] || {
        isFirstInGroup: true,
        isLastInGroup: true,
      };

      // Show date separator if this is the first message or if the day changed
      if (
        !prevMessage ||
        isDifferentDay(message.timestamp, prevMessage.timestamp)
      ) {
        items.push({
          type: 'date',
          date: message.timestamp,
          key: `date-${message.id}`,
        });
      }

      if (message.type === MessageType.ANNOUNCEMENT && discussion?.direction) {
        items.push({
          type: 'announcement',
          content: message.content,
          direction: discussion?.direction,
        });
      } else {
        items.push({
          type: 'message',
          message,
          showTimestamp: shouldShowTimestamp(
            message,
            nextMessage,
            isLastMessage
          ),
          groupInfo,
        });
      }
    });

    // Add spacer at the end for safe space above the input
    items.push({ type: 'spacer' });

    return items;
  }, [messages, messageGroups, discussion?.direction]);
}
