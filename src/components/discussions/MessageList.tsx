import React, {
  useRef,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
} from 'react';
import { MessageDirection, Message } from '@massalabs/gossip-sdk';
import MessageItem from './MessageItem';
import type { Discussion, Contact } from '@massalabs/gossip-sdk';
import { VList, type VListHandle } from 'virtua';

import LoadingState from './LoadingState';
import EmptyState from './EmptyState';
import ScrollToBottomButton from './ScrollToBottomButton';
import { useOverlayReady } from '../ui/OverlayReadyContext';

import {
  VirtualItem,
  useMessageGroups,
  useVirtualItems,
} from './hooks/useMessageListItems';
import { findFirstUnreadMessage } from '../../utils/messages';

import {
  AnnouncementRenderer,
  DateRenderer,
  RetentionSeparatorRenderer,
  SpacerRenderer,
} from './renderers/MessageItemRenderers';

// =============================================================================
// Constants
// =============================================================================

const MESSAGES_ABOVE_UNREAD = 3;
const AT_BOTTOM_THRESHOLD = 50;

const EMPTY_REACTIONS: {
  emoji: string;
  count: number;
  myReactionId?: number;
  myReactionMessageId?: Uint8Array;
}[] = [];

/** Stable key for a message — uses messageId (generated before DB write) so
 *  the key never changes when the DB id is assigned later. */
function getMessageKey(m: Message): string {
  if (m.messageId) return `msg-${m.messageId.join(',')}`;
  if (m.id != null) return `msg-db-${m.id}`;
  return `msg-temp-${m.timestamp.getTime()}-${m.direction}-${m.content.slice(0, 16)}`;
}

// =============================================================================
// Types
// =============================================================================

interface MessageListProps {
  messages: Message[];
  discussion?: Discussion | null;
  retentionInfo?: { setAt: number; duration: number } | null;
  contact?: Pick<Contact, 'name' | 'avatar' | 'userId'>;
  isLoading: boolean;
  onReplyTo?: (message: Message) => void;
  onForward?: (message: Message) => void;
  onDelete?: (message: Message) => void;
  onEdit?: (message: Message) => void;
  onScrollToMessage?: (messageId: number) => void;
  onAtBottomChange?: (atBottom: boolean) => void;
  onScrollToBottom?: () => void;
  showScrollToBottom?: boolean;
  highlightedMessageId?: number | null;
  isSelecting?: boolean;
  selectedMessageIds?: Set<number>;
  onToggleSelect?: (messageId: number) => void;
  onReact?: (message: Message, emoji: string) => void;
  onToggleReaction?: (
    message: Message,
    emoji: string,
    myReactionId?: number,
    myReactionMessageId?: Uint8Array
  ) => void;
  reactionGroups?: Map<
    string,
    {
      emoji: string;
      count: number;
      myReactionId?: number;
      myReactionMessageId?: Uint8Array;
    }[]
  >;
}

export interface MessageListHandle {
  scrollToBottom: () => void;
  scrollToIndex: (index: number) => void;
  isAtBottom: boolean;
}

// =============================================================================
// Helpers
// =============================================================================

/** Calls signalReady on mount — used for early-return paths (loading, empty). */
const SignalReadyOnMount: React.FC<{
  signalReady: () => void;
  children: React.ReactNode;
}> = ({ signalReady, children }) => {
  useEffect(() => {
    signalReady();
  }, [signalReady]);
  return <>{children}</>;
};

// =============================================================================
// Main Component
// =============================================================================

const MessageList = React.forwardRef<MessageListHandle, MessageListProps>(
  (
    {
      messages,
      discussion,
      retentionInfo,
      contact,
      isLoading,
      onReplyTo,
      onForward,
      onDelete,
      onEdit,
      onScrollToMessage,
      onAtBottomChange,
      onScrollToBottom,
      showScrollToBottom = false,
      highlightedMessageId,
      isSelecting,
      selectedMessageIds,
      onToggleSelect,
      onReact,
      onToggleReaction,
      reactionGroups,
    },
    ref
  ) => {
    const { signalReady } = useOverlayReady();
    const vlistRef = useRef<VListHandle>(null);
    const prevMessageCountRef = useRef<number>(0);
    const isAtBottomRef = useRef<boolean>(true);
    const isAutoScrollingRef = useRef(false);
    const messagesRef = useRef<Message[]>(messages);
    const virtualItemsRef = useRef<VirtualItem[]>([]);

    // Derived state via hooks
    const messageGroups = useMessageGroups(messages);
    const virtualItems = useVirtualItems(
      messages,
      messageGroups,
      discussion,
      retentionInfo
    );

    messagesRef.current = messages;
    virtualItemsRef.current = virtualItems;

    const firstUnreadMessage = findFirstUnreadMessage(messages);

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

    // Track new messages for grow-in animation
    const [animatingKeys, setAnimatingKeys] = useState<Set<string>>(new Set());
    const [animationsEnabled, setAnimationsEnabled] = useState(false);
    const knownKeysRef = useRef<Set<string>>(new Set());
    const prevDiscussionIdRef = useRef(discussion?.id);
    const initialScrollDone = useRef(false);

    if (prevDiscussionIdRef.current !== discussion?.id) {
      prevDiscussionIdRef.current = discussion?.id;
      initialScrollDone.current = false;
      setAnimationsEnabled(false);
      knownKeysRef.current = new Set();
    }

    // Detect new messages before paint (useLayoutEffect) to apply
    // the grow-in class on the very first frame — no flash.
    useLayoutEffect(() => {
      if (!animationsEnabled) {
        for (const item of virtualItems) {
          if (item.type !== 'message') continue;
          knownKeysRef.current.add(getMessageKey(item.message));
        }
        return;
      }

      const newKeys: string[] = [];
      for (const item of virtualItems) {
        if (item.type !== 'message') continue;
        const key = getMessageKey(item.message);
        if (!knownKeysRef.current.has(key)) {
          newKeys.push(key);
        }
        knownKeysRef.current.add(key);
      }

      if (newKeys.length > 0) {
        setAnimatingKeys(prev => {
          const next = new Set(prev);
          newKeys.forEach(k => next.add(k));
          return next;
        });
        // Remove class after animation completes (matches CSS duration)
        setTimeout(() => {
          setAnimatingKeys(prev => {
            const next = new Set(prev);
            newKeys.forEach(k => next.delete(k));
            return next;
          });
        }, 400);
      }
    }, [virtualItems, animationsEnabled]);

    // Initial scroll to correct position
    useEffect(() => {
      if (initialScrollDone.current) {
        if (!animationsEnabled && virtualItems.length > 0) {
          setAnimationsEnabled(true);
        }
        return;
      }
      if (virtualItems.length === 0) return;

      requestAnimationFrame(() => {
        vlistRef.current?.scrollToIndex(initialTopMostItemIndex, {
          align: 'start',
        });
        initialScrollDone.current = true;
        setAnimationsEnabled(true);
        signalReady();
      });
    }, [
      discussion?.id,
      virtualItems.length,
      initialTopMostItemIndex,
      animationsEnabled,
      signalReady,
    ]);

    // Reset message count tracking when switching discussions
    useEffect(() => {
      prevMessageCountRef.current = 0;
    }, [discussion?.id]);

    // Scroll to bottom on new messages
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
        isAutoScrollingRef.current = true;
        requestAnimationFrame(() => {
          vlistRef.current?.scrollToIndex(virtualItemsRef.current.length - 1, {
            align: 'end',
            smooth: true,
          });
        });
      }
    }, [messages.length, virtualItems.length]);

    // At-bottom detection
    const handleScroll = useCallback(
      (offset: number) => {
        if (!initialScrollDone.current || isAutoScrollingRef.current) return;
        const el = vlistRef.current;
        if (!el) return;
        const scrollableHeight = el.scrollSize - el.viewportSize;
        const atBottom = scrollableHeight - offset < AT_BOTTOM_THRESHOLD;
        if (atBottom !== isAtBottomRef.current) {
          isAtBottomRef.current = atBottom;
          onAtBottomChange?.(atBottom);
        }
      },
      [onAtBottomChange]
    );

    // Reset auto-scroll guard when smooth scroll finishes
    const handleScrollEnd = useCallback(() => {
      if (isAutoScrollingRef.current) {
        isAutoScrollingRef.current = false;
        isAtBottomRef.current = true;
      }
    }, []);

    // Expose imperative methods
    React.useImperativeHandle(ref, () => ({
      scrollToBottom: () => {
        vlistRef.current?.scrollToIndex(virtualItems.length - 1, {
          align: 'end',
        });
      },
      scrollToIndex: (index: number) => {
        vlistRef.current?.scrollToIndex(index, {
          align: 'center',
          smooth: true,
        });
      },
      get isAtBottom() {
        return isAtBottomRef.current;
      },
    }));

    // Item key helper
    const getItemKey = useCallback(
      (index: number) => {
        const item: VirtualItem | undefined = virtualItems[index];
        if (!item) return `item-${index}`;
        switch (item.type) {
          case 'announcement':
            return `announcement-${index}`;
          case 'date':
            return item.key;
          case 'spacer':
            return 'spacer';
          case 'retention-separator':
            return 'retention-separator';
          case 'message':
            return getMessageKey(item.message);
          default:
            return `item-${index}`;
        }
      },
      [virtualItems]
    );

    // Render a single item
    const renderItem = useCallback(
      (item: VirtualItem, _index: number) => {
        switch (item.type) {
          case 'announcement':
            return (
              <AnnouncementRenderer
                content={item.content}
                direction={item.direction}
              />
            );
          case 'date':
            return <DateRenderer date={item.date} />;
          case 'spacer':
            return <SpacerRenderer />;
          case 'retention-separator':
            return (
              <RetentionSeparatorRenderer
                retentionDuration={item.retentionDuration}
              />
            );
          case 'message': {
            const isIncoming =
              item.message.direction === MessageDirection.INCOMING;
            return (
              <div
                className={`px-4 md:px-6 lg:px-8 transition-colors duration-150 ${isSelecting && item.message.id != null && selectedMessageIds?.has(item.message.id) ? 'bg-accent/10' : ''}`}
              >
                <MessageItem
                  id={`message-${item.message.id}`}
                  message={item.message}
                  onReplyTo={onReplyTo}
                  onForward={onForward}
                  onDelete={onDelete}
                  onEdit={onEdit}
                  onScrollToMessage={onScrollToMessage}
                  onReact={onReact}
                  onToggleReaction={onToggleReaction}
                  reactions={
                    item.message.messageId && reactionGroups
                      ? (reactionGroups.get(item.message.messageId.join(',')) ??
                        EMPTY_REACTIONS)
                      : EMPTY_REACTIONS
                  }
                  showTimestamp={item.showTimestamp}
                  isFirstInGroup={item.groupInfo.isFirstInGroup}
                  isLastInGroup={item.groupInfo.isLastInGroup}
                  showAvatar={isIncoming && item.groupInfo.isLastInGroup}
                  contact={isIncoming ? contact : undefined}
                  isHighlighted={
                    highlightedMessageId != null &&
                    item.message.id === highlightedMessageId
                  }
                  isSelecting={isSelecting}
                  isSelected={
                    item.message.id != null &&
                    selectedMessageIds?.has(item.message.id)
                  }
                  onToggleSelect={onToggleSelect}
                />
              </div>
            );
          }
          default:
            return null;
        }
      },
      [
        onReplyTo,
        onForward,
        onDelete,
        onEdit,
        onScrollToMessage,
        onReact,
        onToggleReaction,
        reactionGroups,
        contact,
        highlightedMessageId,
        isSelecting,
        selectedMessageIds,
        onToggleSelect,
      ]
    );

    if (isLoading) {
      return (
        <SignalReadyOnMount signalReady={signalReady}>
          <div className="h-full bg-discussion-pattern">
            <LoadingState />
          </div>
        </SignalReadyOnMount>
      );
    }

    if (messages.length === 0 && !discussion?.lastAnnouncementMessage) {
      return (
        <SignalReadyOnMount signalReady={signalReady}>
          <div className="h-full bg-discussion-pattern px-4 md:px-6 lg:px-8 py-6">
            <EmptyState />
          </div>
        </SignalReadyOnMount>
      );
    }

    return (
      <div className="relative h-full flex flex-col overflow-hidden min-h-0 bg-discussion-pattern">
        {virtualItems.length > 0 && (
          <VList
            ref={vlistRef}
            className="flex-1 min-h-0 pt-6 scroll-container"
            style={{ overflow: 'auto' }}
            onScroll={handleScroll}
            onScrollEnd={handleScrollEnd}
          >
            {virtualItems.map((item, index) => {
              const key = getItemKey(index);
              return (
                <div
                  key={key}
                  className={animatingKeys.has(key) ? 'msg-appear' : undefined}
                >
                  {renderItem(item, index)}
                </div>
              );
            })}
          </VList>
        )}

        {onScrollToBottom && (
          <ScrollToBottomButton
            onClick={onScrollToBottom}
            isVisible={showScrollToBottom}
          />
        )}
      </div>
    );
  }
);

MessageList.displayName = 'MessageList';

export default MessageList;
