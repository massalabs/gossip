import React, { useRef, useCallback, useEffect } from 'react';
import { MessageDirection } from '../../db';
import { Virtuoso, VirtuosoHandle } from 'react-virtuoso';
import { Message, Discussion } from '../../db';

import LoadingState from './LoadingState';
import EmptyState from './EmptyState';

import {
  VirtualItem,
  useMessageGroups,
  useVirtualItems,
} from './hooks/useMessageListItems';
import { findFirstUnreadMessage } from '../../utils/messages';

import {
  AnnouncementRenderer,
  DateRenderer,
  MessageRenderer,
  SpacerRenderer,
} from './renderers/MessageItemRenderers';

// =============================================================================
// Constants
// =============================================================================

// Number of messages to show above the first unread message when scrolling to it
const MESSAGES_ABOVE_UNREAD = 3;

// Delay in milliseconds before initial scroll positioning to ensure messages are loaded
const INITIAL_SCROLL_DELAY_MS = 100;

// =============================================================================
// Types
// =============================================================================

interface MessageListProps {
  messages: Message[];
  discussion?: Discussion | null;
  isLoading: boolean;
  onReplyTo?: (message: Message) => void;
  onForward?: (message: Message) => void;
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
      onForward,
      onScrollToMessage,
      onAtBottomChange,
    },
    ref
  ) => {
    const virtuosoRef = useRef<VirtuosoHandle>(null);
    const prevMessageCountRef = useRef<number>(0);
    const isAtBottomRef = useRef<boolean>(true);
    const initialPositioningDoneRef = useRef<boolean>(false);
    // Store latest values in refs to avoid stale closures in setTimeout
    const messagesRef = useRef<Message[]>(messages);
    const virtualItemsRef = useRef<VirtualItem[]>([]);

    // Derived state via hooks
    const messageGroups = useMessageGroups(messages);
    const virtualItems = useVirtualItems(messages, messageGroups, discussion);

    // Update refs when values change
    messagesRef.current = messages;
    virtualItemsRef.current = virtualItems;

    // Find the first unread message for visual indicator and initial positioning
    const firstUnreadMessage = findFirstUnreadMessage(messages);

    // Handle initial positioning and scroll to bottom when new messages are added
    useEffect(() => {
      const prevCount = prevMessageCountRef.current;
      const currentCount = messages.length;

      // If this is the initial load and we haven't positioned yet, wait a bit then position
      if (
        currentCount > 0 &&
        prevCount === 0 &&
        !initialPositioningDoneRef.current
      ) {
        // Add a delay to ensure messages are fully loaded and Virtuoso is ready
        const timeoutId = setTimeout(() => {
          // Use refs to get latest values inside timeout to avoid stale closures
          const currentMessages = messagesRef.current;
          const currentVirtualItems = virtualItemsRef.current;
          const currentFirstUnreadMessage =
            findFirstUnreadMessage(currentMessages);

          if (!initialPositioningDoneRef.current) {
            initialPositioningDoneRef.current = true;

            if (currentFirstUnreadMessage) {
              // Scroll to the first unread message
              const unreadVirtualIndex = currentVirtualItems.findIndex(
                item =>
                  item.type === 'message' &&
                  item.message.id === currentFirstUnreadMessage.id
              );
              if (unreadVirtualIndex >= 0) {
                const targetIndex = Math.max(
                  0,
                  unreadVirtualIndex - MESSAGES_ABOVE_UNREAD
                );
                virtuosoRef.current?.scrollToIndex({
                  index: targetIndex,
                  behavior: 'auto', // Use auto for initial positioning
                });
              }
            } else {
              // No unread messages, scroll to bottom
              virtuosoRef.current?.scrollToIndex({
                index: currentVirtualItems.length - 1,
                behavior: 'auto', // Use auto for initial positioning
              });
            }
          }
        }, INITIAL_SCROLL_DELAY_MS);

        return () => clearTimeout(timeoutId);
      }
      // Scroll to bottom when new messages are added
      else if (currentCount > prevCount) {
        // Check if the newest message is outgoing (sent by user) - always scroll for sent messages
        const currentMessages = messagesRef.current;
        const currentVirtualItems = virtualItemsRef.current;
        const newestMessage = currentMessages[currentMessages.length - 1];
        const shouldScrollToBottom =
          newestMessage?.direction === MessageDirection.OUTGOING ||
          isAtBottomRef.current;

        if (shouldScrollToBottom) {
          requestAnimationFrame(() => {
            virtuosoRef.current?.scrollToIndex({
              index: currentVirtualItems.length - 1,
              behavior: 'smooth',
            });
          });
        }
      }

      prevMessageCountRef.current = currentCount;
    }, [messages.length, virtualItems.length, firstUnreadMessage?.id]);

    // Reset initial positioning when switching between discussions
    useEffect(() => {
      initialPositioningDoneRef.current = false;
    }, [discussion?.id]);

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
                onForward={onForward}
                onScrollToMessage={onScrollToMessage}
              />
            );

          default:
            return null;
        }
      },
      [virtualItems, onReplyTo, onForward, onScrollToMessage]
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
            alignToBottom={false} // We handle positioning manually
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
