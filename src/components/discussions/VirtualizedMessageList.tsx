import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Virtuoso, VirtuosoHandle } from 'react-virtuoso';
import type { ListRange } from 'react-virtuoso';
import {
  Message,
  Discussion,
  DiscussionDirection,
  MessageDirection,
  MessageStatus,
} from '../../db';
import { useDiscussionViewStore } from '../../stores/discussionViewStore';
import MessageItem from './MessageItem';
import LoadingState from './LoadingState';
import EmptyState from './EmptyState';

interface MessageListProps {
  // Contact user id used to key view state in the discussionViewStore
  contactUserId: string;
  messages: Message[];
  discussion?: Discussion | null;
  isLoading: boolean;
  onReplyTo?: (message: Message) => void;
}

const VirtualizedMessageList: React.FC<MessageListProps> = props => {
  const { contactUserId, messages, discussion, isLoading, onReplyTo } = props;

  const virtuosoRef = useRef<VirtuosoHandle | null>(null);
  const prevDiscussionIdRef = useRef<number | null>(null);
  const prevMessagesLengthRef = useRef<number>(messages.length);

  const [scrollParent, setScrollParent] = useState<HTMLElement | null>(null);
  const [highlightedMessageId, setHighlightedMessageId] = useState<
    number | null
  >(null);
  const highlightTimeoutRef = useRef<number | null>(null);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const [showScrollToLatest, setShowScrollToLatest] = useState(false);
  const [unseenNewCount, setUnseenNewCount] = useState(0);
  const hasInitializedMessagesRef = useRef(false);
  // Index of the first new incoming message that arrived while the
  // user was scrolled up (used for the “X new messages” button).
  const firstNewMessageIndexRef = useRef<number | null>(null);

  const setViewState = useDiscussionViewStore.use.setViewState();
  const resetViewState = useDiscussionViewStore.use.resetViewState();

  const firstUnreadIndex = useMemo((): number => {
    // Prefer direct status information when available: first incoming
    // message whose status is not READ.
    for (let i = 0; i < messages.length; i += 1) {
      const message = messages[i];
      if (
        message.direction === MessageDirection.INCOMING &&
        message.status !== MessageStatus.READ
      ) {
        return i;
      }
    }

    // Fallback: if discussion reports unreadCount but messages are already
    // marked as READ (e.g. from a previous session), approximate by
    // assuming the last `unreadCount` messages are the unread ones.
    if (discussion?.unreadCount && discussion.unreadCount > 0) {
      const idx = messages.length - discussion.unreadCount;
      return idx < 0 ? 0 : idx;
    }

    return -1;
  }, [discussion?.unreadCount, messages]);

  const initialTopMostItemIndex = useMemo(() => {
    if (!messages.length) return undefined;
    if (firstUnreadIndex !== -1) {
      // Position first unread message at the top of the viewport so the
      // user can scroll down through new messages.
      return {
        index: firstUnreadIndex,
        align: 'start' as const,
        behavior: 'auto' as const,
      };
    }
    return messages.length - 1;
  }, [firstUnreadIndex, messages.length]);

  // Resolve the external scroll container used by ScrollableContent
  useEffect(() => {
    const el = document.getElementById('messagesContainer');
    if (el instanceof HTMLElement) {
      setScrollParent(el);
    }
  }, []);

  // Reset highlight and scroll state when discussion changes
  useEffect(() => {
    const currentDiscussionId = discussion?.id || null;
    if (prevDiscussionIdRef.current !== currentDiscussionId) {
      prevDiscussionIdRef.current = currentDiscussionId;
      prevMessagesLengthRef.current = messages.length;
      setHighlightedMessageId(null);
      setIsAtBottom(true);
      setShowScrollToLatest(false);
      setUnseenNewCount(0);
      hasInitializedMessagesRef.current = false;
      firstNewMessageIndexRef.current = null;
      if (contactUserId) {
        resetViewState(contactUserId);
      }
    }
  }, [contactUserId, discussion?.id, messages.length, resetViewState]);

  // Cleanup highlight timeout on unmount
  useEffect(() => {
    return () => {
      if (highlightTimeoutRef.current !== null) {
        window.clearTimeout(highlightTimeoutRef.current);
      }
    };
  }, []);

  const handleScrollToMessage = useCallback(
    (messageId: number) => {
      if (!virtuosoRef.current) return;
      const index = messages.findIndex(m => m.id === messageId);
      if (index === -1) {
        // If message is not in the current list, do nothing but log for debugging
        // This can happen if the original message is not in the loaded window
        console.warn(`Message with id ${messageId} not found in list`);
        return;
      }

      virtuosoRef.current.scrollToIndex({
        index,
        align: 'center',
        behavior: 'smooth',
      });

      setHighlightedMessageId(messageId);

      if (highlightTimeoutRef.current !== null) {
        window.clearTimeout(highlightTimeoutRef.current);
      }

      highlightTimeoutRef.current = window.setTimeout(() => {
        setHighlightedMessageId(current =>
          current === messageId ? null : current
        );
      }, 2000);
    },
    [messages]
  );

  // Track new messages while user is scrolled up
  useEffect(() => {
    if (!messages.length) {
      prevMessagesLengthRef.current = 0;
      setUnseenNewCount(0);
      setShowScrollToLatest(false);
      firstNewMessageIndexRef.current = null;
      return;
    }

    const prevLength = prevMessagesLengthRef.current;
    const currentLength = messages.length;

    if (!hasInitializedMessagesRef.current) {
      hasInitializedMessagesRef.current = true;
      prevMessagesLengthRef.current = currentLength;
      return;
    }

    // Detect newly appended messages
    if (currentLength > prevLength) {
      const firstNewIndex = Math.max(prevLength, 0);
      const newMessages = messages.slice(prevLength);
      const hasOutgoing = newMessages.some(
        msg => msg.direction === MessageDirection.OUTGOING
      );
      const incomingNewMessages = newMessages.filter(
        msg => msg.direction === MessageDirection.INCOMING
      );

      // If we just sent a message, always scroll to the latest message immediately
      if (hasOutgoing && virtuosoRef.current) {
        virtuosoRef.current.scrollToIndex({
          index: currentLength - 1,
          align: 'end',
          behavior: 'auto',
        });
        setIsAtBottom(true);
        setUnseenNewCount(0);
        setShowScrollToLatest(false);
        prevMessagesLengthRef.current = currentLength;
        return;
      }

      // Only show "new messages" when there are new incoming messages
      if (incomingNewMessages.length > 0) {
        if (!isAtBottom) {
          // Remember where the new messages started so we can jump
          // back to the first new one, even if their status changes.
          if (firstNewMessageIndexRef.current === null) {
            firstNewMessageIndexRef.current = firstNewIndex;
          }
          setUnseenNewCount(count => count + incomingNewMessages.length);
          setShowScrollToLatest(true);
        } else {
          // When at bottom, followOutput will handle scrolling; don't show counter
          setUnseenNewCount(0);
        }
      }
    } else if (currentLength < prevLength) {
      // Messages were truncated or reloaded; reset counters
      setUnseenNewCount(0);
      setShowScrollToLatest(false);
      firstNewMessageIndexRef.current = null;
    }

    if (isAtBottom) {
      setUnseenNewCount(0);
      firstNewMessageIndexRef.current = null;
    }

    prevMessagesLengthRef.current = currentLength;
  }, [isAtBottom, messages]);

  // Sync view-related state into the global discussionViewStore so
  // other components (e.g. headers, input bars) can react to scroll
  // position and unread information for this discussion.
  useEffect(() => {
    if (!contactUserId) return;
    setViewState(contactUserId, {
      isAtBottom,
      showScrollToLatest,
      unseenNewCount,
      firstNewIndex: firstNewMessageIndexRef.current,
    });
  }, [
    contactUserId,
    isAtBottom,
    setViewState,
    showScrollToLatest,
    unseenNewCount,
  ]);

  const handleRangeChanged = useCallback(
    (range: ListRange) => {
      const lastIndex = messages.length ? messages.length - 1 : -1;
      if (lastIndex === -1) {
        setShowScrollToLatest(false);
        return;
      }

      // Show helper button whenever the user is noticeably scrolled up from
      // the latest message, regardless of whether Virtuoso considers us
      // technically "at bottom" (to avoid threshold edge cases).
      const scrolledUpEnough = range.endIndex < Math.max(0, lastIndex - 2);

      if (scrolledUpEnough) {
        setShowScrollToLatest(true);
      } else if (!unseenNewCount) {
        // Hide the button when close to the bottom and there are no unseen new messages
        setShowScrollToLatest(false);
      }
    },
    [messages.length, unseenNewCount]
  );

  const handleScrollToLatest = useCallback(() => {
    if (!virtuosoRef.current || !messages.length) return;

    let targetIndex: number;
    let align: 'start' | 'end' = 'end';

    if (
      firstNewMessageIndexRef.current !== null &&
      firstNewMessageIndexRef.current >= 0 &&
      firstNewMessageIndexRef.current < messages.length
    ) {
      // First, prefer jumping to the first new incoming message that
      // arrived while the user was scrolled up.
      targetIndex = firstNewMessageIndexRef.current;
      align = 'start';
    } else if (firstUnreadIndex !== -1) {
      // Position first unread message at the top of viewport
      targetIndex = firstUnreadIndex;
      align = 'start';
    } else {
      targetIndex = messages.length - 1;
      // For the very last message, align to end (bottom)
      align = 'end';
    }

    virtuosoRef.current.scrollToIndex({
      index: targetIndex,
      align,
      behavior: 'smooth',
    });
    setShowScrollToLatest(false);
    setUnseenNewCount(0);
    firstNewMessageIndexRef.current = null;
  }, [firstUnreadIndex, messages.length]);

  const handleAtBottomStateChange = useCallback((atBottom: boolean) => {
    setIsAtBottom(atBottom);
    if (atBottom) {
      setShowScrollToLatest(false);
      setUnseenNewCount(0);
    }
  }, []);

  const itemContent = useCallback(
    (_index: number, message: Message) => (
      <div className="py-2">
        <MessageItem
          id={`message-${message.id}`}
          message={message}
          onReplyTo={onReplyTo}
          onScrollToMessage={handleScrollToMessage}
          isHighlighted={highlightedMessageId === message.id}
        />
      </div>
    ),
    [handleScrollToMessage, highlightedMessageId, onReplyTo]
  );

  const hasContent =
    messages.length > 0 || !!discussion?.announcementMessage?.length;

  const announcementNode = useMemo(() => {
    if (!discussion?.announcementMessage || !discussion.createdAt) return null;

    return (
      <div
        className={`mb-4 flex ${
          discussion.direction === DiscussionDirection.INITIATED
            ? 'justify-end'
            : 'justify-start'
        }`}
      >
        <div
          className={`max-w-[85%] sm:max-w-[75%] md:max-w-[70%] px-4 py-3 rounded-3xl text-sm leading-tight ${
            discussion.direction === DiscussionDirection.INITIATED
              ? 'bg-accent text-accent-foreground rounded-br-[4px]'
              : 'bg-card dark:bg-surface-secondary text-card-foreground rounded-bl-[4px] shadow-sm'
          }`}
        >
          <p className="text-xs text-center font-light opacity-80 mb-1.5">
            Announcement message:
          </p>
          <p className="whitespace-pre-wrap wrap-break-word">
            {discussion.announcementMessage}
          </p>
        </div>
      </div>
    );
  }, [discussion]);

  if (isLoading) {
    return <LoadingState />;
  }

  if (!hasContent) {
    return <EmptyState />;
  }

  return (
    <div className="relative px-4 md:px-6 lg:px-8 py-6 space-y-4">
      {announcementNode}
      <Virtuoso
        ref={virtuosoRef}
        data={messages}
        initialTopMostItemIndex={initialTopMostItemIndex}
        alignToBottom
        atBottomStateChange={handleAtBottomStateChange}
        followOutput={isAtBottom ? 'auto' : false}
        customScrollParent={scrollParent ?? undefined}
        itemContent={itemContent}
        components={
          {
            //   // Small spacer so last message isn't hidden behind the input bar,
            //   // but without adding too much extra empty space.
            //   Footer: () => <div className="h-12" />,
          }
        }
        rangeChanged={handleRangeChanged}
      />
      {showScrollToLatest && (
        <button
          type="button"
          onClick={handleScrollToLatest}
          className="fixed right-4 bottom-24 md:right-6 md:bottom-28 px-3 py-1.5 rounded-full bg-accent text-accent-foreground text-xs font-medium shadow-lg flex items-center gap-1 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
        >
          <span>
            {unseenNewCount > 0
              ? `${unseenNewCount} new message${unseenNewCount > 1 ? 's' : ''}`
              : 'Scroll to latest'}
          </span>
          <span className="text-lg leading-none">↓</span>
        </button>
      )}
    </div>
  );
};

export default VirtualizedMessageList;
