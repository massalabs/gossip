import React, {
  useRef,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { MessageDirection, Message } from '@massalabs/gossip-sdk';
import type { Discussion, Contact } from '@massalabs/gossip-sdk';
import { Virtuoso, VirtuosoHandle } from 'react-virtuoso';

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

// Stable Virtuoso components object — created once, never changes.
// The Header renders a spacer whose height tracks --keyboard-height via CSS variable,
// so when the keyboard opens the list gains scrollable space at the top for messages
// that shifted behind the header via the CSS transform.
const virtuosoComponents = {
  Header: () => <div style={{ height: 'var(--keyboard-height, 0px)' }} />,
};

// =============================================================================
// Types
// =============================================================================

interface MessageListProps {
  messages: Message[];
  discussion?: Discussion | null;
  contact?: Pick<Contact, 'name' | 'avatar'>;
  isLoading: boolean;
  onReplyTo?: (message: Message) => void;
  onForward?: (message: Message) => void;
  onDelete?: (message: Message) => void;
  onEdit?: (message: Message) => void;
  onScrollToMessage?: (messageId: number) => void;
  onAtBottomChange?: (atBottom: boolean) => void;
  highlightedMessageId?: number | null;
  isSelecting?: boolean;
  selectedMessageIds?: Set<number>;
  onToggleSelect?: (messageId: number) => void;
  onReact?: (message: Message, emoji: string) => void;
  onToggleReaction?: (
    message: Message,
    emoji: string,
    myReactionId?: number
  ) => void;
  getReactionsForMessage?: (messageDbId: number) => {
    emoji: string;
    count: number;
    myReactionId?: number;
  }[];
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
      contact,
      isLoading,
      onReplyTo,
      onForward,
      onDelete,
      onEdit,
      onScrollToMessage,
      onAtBottomChange,
      highlightedMessageId,
      isSelecting,
      selectedMessageIds,
      onToggleSelect,
      onReact,
      onToggleReaction,
      getReactionsForMessage,
    },
    ref
  ) => {
    const virtuosoRef = useRef<VirtuosoHandle>(null);
    const prevMessageCountRef = useRef<number>(0);
    const isAtBottomRef = useRef<boolean>(true);
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

    // Compute initial position so Virtuoso renders at the right place instantly
    // (no visible scroll animation on entering a discussion)
    const initialTopMostItemIndex = useMemo(() => {
      if (virtualItems.length === 0) return 0;
      if (firstUnreadMessage) {
        const idx = virtualItems.findIndex(
          item =>
            item.type === 'message' && item.message.id === firstUnreadMessage.id
        );
        if (idx >= 0) return Math.max(0, idx - MESSAGES_ABOVE_UNREAD);
      }
      return virtualItems.length - 1;
    }, [virtualItems, firstUnreadMessage]);

    // Hide the list until Virtuoso has finished its initial positioning pass.
    // Without this, the user sees a brief flash of items at the wrong scroll
    // position (and the scroll-to-bottom button flickers).
    const [ready, setReady] = useState(false);
    const readyRef = useRef(false);
    const prevDiscussionIdRef = useRef(discussion?.id);

    // Synchronous reset during render so the container is hidden BEFORE
    // the DOM update — prevents a single visible frame at the wrong position.
    if (prevDiscussionIdRef.current !== discussion?.id) {
      prevDiscussionIdRef.current = discussion?.id;
      readyRef.current = false;
      if (ready) setReady(false);
    }

    // After Virtuoso mounts and positions, reveal the list
    useEffect(() => {
      if (readyRef.current) return;
      if (virtualItems.length === 0) return;
      const id = setTimeout(() => {
        readyRef.current = true;
        setReady(true);
      }, 50);
      return () => clearTimeout(id);
    }, [discussion?.id, virtualItems.length]);

    // Reset message count tracking when switching discussions
    useEffect(() => {
      prevMessageCountRef.current = 0;
    }, [discussion?.id]);

    // Scroll to bottom when new messages arrive (not on initial load)
    useEffect(() => {
      const prevCount = prevMessageCountRef.current;
      const currentCount = messages.length;
      prevMessageCountRef.current = currentCount;

      if (prevCount === 0 || currentCount <= prevCount) return;

      const newestMessage = messagesRef.current[messagesRef.current.length - 1];
      const shouldScrollToBottom =
        newestMessage?.direction === MessageDirection.OUTGOING ||
        isAtBottomRef.current;

      if (shouldScrollToBottom) {
        requestAnimationFrame(() => {
          virtuosoRef.current?.scrollToIndex({
            index: virtualItemsRef.current.length - 1,
            behavior: 'smooth',
          });
        });
      }
    }, [messages.length, virtualItems.length]);

    // Track if user is at bottom — suppress during initial positioning
    // to prevent the scroll-to-bottom button from flashing.
    const handleAtBottomStateChange = useCallback(
      (atBottom: boolean) => {
        isAtBottomRef.current = atBottom;
        if (readyRef.current) {
          onAtBottomChange?.(atBottom);
        }
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

    // Stable key per virtual item — prevents Virtuoso from confusing items
    // when the list shifts (new messages, status changes, etc.)
    const computeItemKey = useCallback(
      (index: number) => {
        const item: VirtualItem | undefined = virtualItems[index];
        if (!item) return index;
        switch (item.type) {
          case 'announcement':
            return `announcement-${index}`;
          case 'date':
            return item.key;
          case 'spacer':
            return 'spacer';
          case 'message': {
            if (item.message.id != null) return `msg-${item.message.id}`;
            const tempKey = `${item.message.timestamp.getTime()}-${item.message.direction}-${item.message.content.slice(0, 16)}`;
            return `msg-temp-${tempKey}`;
          }
          default:
            return index;
        }
      },
      [virtualItems]
    );

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
                key={item.message.id ?? `temp-msg-${index}`}
                message={item.message}
                showTimestamp={item.showTimestamp}
                groupInfo={item.groupInfo}
                onReplyTo={onReplyTo}
                onForward={onForward}
                onDelete={onDelete}
                onEdit={onEdit}
                onScrollToMessage={onScrollToMessage}
                onReact={onReact}
                onToggleReaction={onToggleReaction}
                getReactionsForMessage={getReactionsForMessage}
                contact={contact}
                isHighlighted={item.message.id === highlightedMessageId}
                isSelecting={isSelecting}
                isSelected={
                  item.message.id != null &&
                  selectedMessageIds?.has(item.message.id)
                }
                onToggleSelect={onToggleSelect}
              />
            );

          default:
            return null;
        }
      },
      [
        virtualItems,
        onReplyTo,
        onForward,
        onDelete,
        onEdit,
        onScrollToMessage,
        onReact,
        onToggleReaction,
        getReactionsForMessage,
        contact,
        highlightedMessageId,
        isSelecting,
        selectedMessageIds,
        onToggleSelect,
      ]
    );

    // Loading state
    if (isLoading) {
      return <LoadingState />;
    }

    // Empty state - only show if no messages AND no announcement
    if (messages.length === 0 && !discussion?.lastAnnouncementMessage) {
      return (
        <div className="px-4 md:px-6 lg:px-8 py-6">
          <EmptyState />
        </div>
      );
    }

    // Main render
    return (
      <div
        className="h-full flex flex-col overflow-hidden min-h-0"
        style={{ visibility: ready ? 'visible' : 'hidden' }}
      >
        {virtualItems.length > 0 && (
          <Virtuoso
            key={discussion?.id}
            ref={virtuosoRef}
            style={{ flex: 1 }}
            className="pt-6"
            totalCount={virtualItems.length}
            computeItemKey={computeItemKey}
            itemContent={itemContent}
            initialTopMostItemIndex={initialTopMostItemIndex}
            atBottomThreshold={150}
            atBottomStateChange={handleAtBottomStateChange}
            increaseViewportBy={{ top: 200, bottom: 200 }}
            components={virtuosoComponents}
          />
        )}
      </div>
    );
  }
);

MessageList.displayName = 'MessageList';

export default MessageList;
