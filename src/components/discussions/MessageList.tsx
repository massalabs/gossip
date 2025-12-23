import React, { useRef, useCallback, useEffect } from 'react';
import { Virtuoso, VirtuosoHandle } from 'react-virtuoso';
import { Message, Discussion } from '../../db';

import LoadingState from './LoadingState';
import EmptyState from './EmptyState';

import {
  VirtualItem,
  useMessageGroups,
  useVirtualItems,
} from './hooks/useMessageListItems';

import {
  AnnouncementRenderer,
  DateRenderer,
  MessageRenderer,
  SpacerRenderer,
} from './renderers/MessageItemRenderers';

// =============================================================================
// Types
// =============================================================================

interface MessageListProps {
  messages: Message[];
  discussion?: Discussion | null;
  isLoading: boolean;
  onReplyTo?: (message: Message) => void;
  onScrollToMessage?: (messageId: number) => void;
  onAtBottomChange?: (atBottom: boolean) => void;
}

export interface MessageListHandle {
  scrollToBottom: () => void;
  scrollToIndex: (index: number) => void;
  isAtBottom: boolean;
}

// =============================================================================
// Main Component
// =============================================================================

const MessageList = React.forwardRef<MessageListHandle, MessageListProps>(
  (
    {
      messages,
      discussion,
      isLoading,
      onReplyTo,
      onScrollToMessage,
      onAtBottomChange,
    },
    ref
  ) => {
    const virtuosoRef = useRef<VirtuosoHandle>(null);
    const prevMessageCountRef = useRef<number>(0);
    const isAtBottomRef = useRef<boolean>(true);

    // Derived state via hooks
    const messageGroups = useMessageGroups(messages);
    const virtualItems = useVirtualItems(messages, messageGroups, discussion);

    // Scroll to bottom when new messages are added (if user was at bottom)
    useEffect(() => {
      const prevCount = prevMessageCountRef.current;
      const currentCount = messages.length;

      if (currentCount > prevCount && isAtBottomRef.current) {
        requestAnimationFrame(() => {
          virtuosoRef.current?.scrollToIndex({
            index: virtualItems.length - 1,
            behavior: 'smooth',
          });
        });
      }

      prevMessageCountRef.current = currentCount;
    }, [messages.length, virtualItems.length]);

    // Track if user is at bottom
    const handleAtBottomStateChange = useCallback(
      (atBottom: boolean) => {
        isAtBottomRef.current = atBottom;
        onAtBottomChange?.(atBottom);
      },
      [onAtBottomChange]
    );

    // Expose imperative methods via ref
    React.useImperativeHandle(ref, () => ({
      scrollToBottom: () => {
        virtuosoRef.current?.scrollToIndex({
          index: virtualItems.length - 1,
          behavior: 'auto',
        });
      },
      scrollToIndex: (index: number) => {
        virtuosoRef.current?.scrollToIndex({
          index,
          behavior: 'smooth',
          align: 'center',
        });
      },
      get isAtBottom() {
        return isAtBottomRef.current;
      },
    }));

    // Render individual item
    const itemContent = useCallback(
      (index: number) => {
        const item: VirtualItem | undefined = virtualItems[index];
        if (!item) return null;

        switch (item.type) {
          case 'announcement':
            return (
              <AnnouncementRenderer
                key="announcement"
                content={item.content}
                direction={item.direction}
              />
            );

          case 'date':
            return <DateRenderer key={item.key} date={item.date} />;

          case 'spacer':
            return <SpacerRenderer key="spacer" />;

          case 'message':
            return (
              <MessageRenderer
                key={item.message.id}
                message={item.message}
                showTimestamp={item.showTimestamp}
                groupInfo={item.groupInfo}
                onReplyTo={onReplyTo}
                onScrollToMessage={onScrollToMessage}
              />
            );

          default:
            return null;
        }
      },
      [virtualItems, onReplyTo, onScrollToMessage]
    );

    // Loading state
    if (isLoading) {
      return <LoadingState />;
    }

    // Empty state - only show if no messages AND no announcement
    if (messages.length === 0 && !discussion?.announcementMessage) {
      return (
        <div className="px-4 md:px-6 lg:px-8 py-6">
          <EmptyState />
        </div>
      );
    }

    // Main render
    return (
      <div className="h-full flex flex-col overflow-hidden min-h-0">
        {virtualItems.length > 0 && (
          <Virtuoso
            ref={virtuosoRef}
            style={{ flex: 1 }}
            className="pt-6"
            totalCount={virtualItems.length}
            itemContent={itemContent}
            initialTopMostItemIndex={virtualItems.length - 1}
            alignToBottom
            atBottomThreshold={150}
            atBottomStateChange={handleAtBottomStateChange}
            increaseViewportBy={{ top: 200, bottom: 200 }}
          />
        )}
      </div>
    );
  }
);

MessageList.displayName = 'MessageList';

export default MessageList;
