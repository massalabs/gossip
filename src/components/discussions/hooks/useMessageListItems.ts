import { useMemo } from 'react';
import {
  Message,
  DiscussionDirection,
  MessageType,
} from '@massalabs/gossip-sdk';
import type { Discussion } from '@massalabs/gossip-sdk';
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

export type RetentionSeparatorItem = {
  type: 'retention-separator';
  retentionDuration: number;
  retentionPolicySetAt: number;
};

export type VirtualItem =
  | AnnouncementItem
  | DateItem
  | MessageVirtualItem
  | SpacerItem
  | RetentionSeparatorItem;

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
 * Builds the virtualized item list from messages and discussion.
 * Includes: announcement (if exists) + date separators + messages + spacer.
 *
 * @param retentionInfo - Optional retention policy info to inject a separator.
 *   For regular discussions this is derived from the discussion object.
 *   For the self-discussion it can be passed explicitly since no Discussion is available.
 */
export function useVirtualItems(
  messages: Message[],
  messageGroups: MessageGroupInfo[],
  discussion?: Discussion | null,
  retentionInfo?: { setAt: number; duration: number } | null
): VirtualItem[] {
  const effectiveSetAt =
    discussion?.retentionPolicySetAt ?? retentionInfo?.setAt ?? null;
  const effectiveDuration =
    discussion?.messageRetentionDuration ?? retentionInfo?.duration ?? null;

  return useMemo(() => {
    const items: VirtualItem[] = [];
    let separatorInserted = false;

    messages.forEach((message, index) => {
      const prevMessage = index > 0 ? messages[index - 1] : null;
      const nextMessage =
        index < messages.length - 1 ? messages[index + 1] : null;
      const isLastMessage = index === messages.length - 1;

      const groupInfo: MessageGroupInfo = messageGroups[index] || {
        isFirstInGroup: true,
        isLastInGroup: true,
      };

      // Inject retention separator at the right position in the timeline
      if (
        !separatorInserted &&
        effectiveSetAt != null &&
        effectiveDuration != null
      ) {
        const prevTs = prevMessage?.timestamp.getTime() ?? -Infinity;
        const currTs = message.timestamp.getTime();
        if (prevTs < effectiveSetAt && currTs >= effectiveSetAt) {
          items.push({
            type: 'retention-separator',
            retentionDuration: effectiveDuration,
            retentionPolicySetAt: effectiveSetAt,
          });
          separatorInserted = true;
        }
      }

      // Show date separator if this is the first message or if the day changed
      if (
        !prevMessage ||
        isDifferentDay(message.timestamp, prevMessage.timestamp)
      ) {
        items.push({
          type: 'date',
          date: message.timestamp,
          key: `date-${message.messageId ? message.messageId.join(',') : (message.id ?? message.timestamp.getTime())}`,
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

    // If all messages are before retentionPolicySetAt (or there are no messages),
    // still show the separator at the end so the user sees that the policy is active.
    if (
      !separatorInserted &&
      effectiveSetAt != null &&
      effectiveDuration != null
    ) {
      items.push({
        type: 'retention-separator',
        retentionDuration: effectiveDuration,
        retentionPolicySetAt: effectiveSetAt,
      });
    }

    // Add spacer at the end for safe space above the input
    items.push({ type: 'spacer' });

    return items;
  }, [
    messages,
    messageGroups,
    discussion?.direction,
    effectiveSetAt,
    effectiveDuration,
  ]);
}
