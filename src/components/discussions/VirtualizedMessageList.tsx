import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Virtuoso, VirtuosoHandle } from 'react-virtuoso';
import { Message, Discussion, DiscussionDirection } from '../../db';
import MessageItem from './MessageItem';
import LoadingState from './LoadingState';
import EmptyState from './EmptyState';

interface MessageListProps {
  messages: Message[];
  discussion?: Discussion | null;
  isLoading: boolean;
  onReplyTo?: (message: Message) => void;
}

const VirtualizedMessageList: React.FC<MessageListProps> = ({
  messages,
  discussion,
  isLoading,
  onReplyTo,
}) => {
  const virtuosoRef = useRef<VirtuosoHandle | null>(null);
  const prevLastMessageIdRef = useRef<number | null>(null);
  const hasInitiallyScrolledRef = useRef<boolean>(false);
  const prevDiscussionIdRef = useRef<number | null>(null);
  const [scrollParent, setScrollParent] = useState<HTMLElement | null>(null);
  const [highlightedMessageId, setHighlightedMessageId] = useState<
    number | null
  >(null);
  const highlightTimeoutRef = useRef<number | null>(null);

  // Resolve the external scroll container used by ScrollableContent
  useEffect(() => {
    const el = document.getElementById('messagesContainer');
    if (el instanceof HTMLElement) {
      setScrollParent(el);
    }
  }, []);

  // Reset scroll state when discussion changes
  useEffect(() => {
    const currentDiscussionId = discussion?.id || null;
    if (prevDiscussionIdRef.current !== currentDiscussionId) {
      hasInitiallyScrolledRef.current = false;
      prevLastMessageIdRef.current = null;
      prevDiscussionIdRef.current = currentDiscussionId;
    }
  }, [discussion?.id]);

  // Initial scroll to bottom when messages first load
  useEffect(() => {
    if (isLoading || hasInitiallyScrolledRef.current) return;
    if (!virtuosoRef.current) return;
    if (!messages.length) return;

    virtuosoRef.current.scrollToIndex({
      index: messages.length - 1,
      align: 'end',
      behavior: 'auto',
    });
    hasInitiallyScrolledRef.current = true;
    prevLastMessageIdRef.current = messages[messages.length - 1]?.id ?? null;
  }, [isLoading, messages, messages.length]);

  // Auto-scroll to bottom when a new message is added (after initial render)
  useEffect(() => {
    if (isLoading || !hasInitiallyScrolledRef.current) return;
    if (!virtuosoRef.current) return;
    if (!messages.length) return;

    const lastMessage = messages[messages.length - 1];
    const currentLastMessageId = lastMessage?.id ?? null;
    const prevLastMessageId = prevLastMessageIdRef.current;

    if (
      currentLastMessageId !== null &&
      currentLastMessageId !== prevLastMessageId
    ) {
      virtuosoRef.current.scrollToIndex({
        index: messages.length - 1,
        align: 'end',
        behavior: 'auto',
      });
    }

    prevLastMessageIdRef.current = currentLastMessageId;
  }, [messages, messages.length, isLoading]);

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

  const itemContent = useCallback(
    (_index: number, message: Message) => (
      <MessageItem
        id={`message-${message.id}`}
        message={message}
        onReplyTo={onReplyTo}
        onScrollToMessage={handleScrollToMessage}
        isHighlighted={highlightedMessageId === message.id}
      />
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
    <div className="px-4 md:px-6 lg:px-8 py-6 space-y-4">
      {announcementNode}
      <Virtuoso
        ref={virtuosoRef}
        data={messages}
        customScrollParent={scrollParent ?? undefined}
        itemContent={itemContent}
      />
    </div>
  );
};

export default VirtualizedMessageList;
