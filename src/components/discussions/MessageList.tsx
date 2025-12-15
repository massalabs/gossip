import React, { useMemo, useEffect, useRef, useLayoutEffect } from 'react';
import { Element } from 'react-scroll';
import { Message, Discussion, DiscussionDirection } from '../../db';
import { formatDateTime } from '../../utils/timeUtils';
import MessageItem from './MessageItem';
import LoadingState from './LoadingState';
import EmptyState from './EmptyState';

interface MessageListProps {
  messages: Message[];
  discussion?: Discussion | null;
  isLoading: boolean;
  onReplyTo?: (message: Message) => void;
  onScrollToMessage?: (messageId: number) => void;
}

const MessageList: React.FC<MessageListProps> = ({
  messages,
  discussion,
  isLoading,
  onReplyTo,
  onScrollToMessage,
}) => {
  const prevLastMessageIdRef = useRef<number | null>(null);
  const hasInitiallyScrolledRef = useRef<boolean>(false);
  const prevDiscussionIdRef = useRef<number | null>(null);

  // Reset scroll state when discussion changes
  useEffect(() => {
    const currentDiscussionId = discussion?.id || null;
    if (prevDiscussionIdRef.current !== currentDiscussionId) {
      hasInitiallyScrolledRef.current = false;
      prevLastMessageIdRef.current = null;
      prevDiscussionIdRef.current = currentDiscussionId;
    }
  }, [discussion?.id]);

  // Set initial scroll position to bottom before first paint (prevents visible scroll)
  useLayoutEffect(() => {
    if (isLoading || hasInitiallyScrolledRef.current) return;

    const container = document.getElementById('messagesContainer');
    if (container && messages.length > 0) {
      // Set scroll position synchronously before paint
      container.scrollTop = container.scrollHeight;
      hasInitiallyScrolledRef.current = true;
    }
  }, [isLoading, messages.length]);

  // Memoize the message items to prevent re-rendering all messages when one is added
  const messageItems = useMemo(() => {
    return messages.map(message => {
      return (
        <MessageItem
          key={message.id}
          id={`message-${message.id}`}
          message={message}
          onReplyTo={onReplyTo}
          onScrollToMessage={onScrollToMessage}
        />
      );
    });
  }, [messages, onReplyTo, onScrollToMessage]);

  // Auto-scroll to bottom when new messages are added (after initial render)
  useEffect(() => {
    if (isLoading || !hasInitiallyScrolledRef.current) return;

    const lastMessage = messages[messages.length - 1];
    const currentLastMessageId = lastMessage?.id || null;
    const prevLastMessageId = prevLastMessageIdRef.current;

    // Only scroll when a new message is added (not on initial load)
    if (
      currentLastMessageId !== null &&
      currentLastMessageId !== prevLastMessageId
    ) {
      // Use requestAnimationFrame to ensure DOM is updated, then scroll instantly
      requestAnimationFrame(() => {
        const container = document.getElementById('messagesContainer');
        if (container) {
          // Use instant scroll (no smooth behavior) for better performance
          // This prevents lag when new messages arrive
          container.scrollTop = container.scrollHeight;
        }
      });
    }

    prevLastMessageIdRef.current = currentLastMessageId;
  }, [messages.length, isLoading, messages]);

  if (isLoading) {
    return <LoadingState />;
  }

  return (
    <div className="px-4 md:px-6 lg:px-8 py-6 space-y-4">
      {/* Display announcement message if it exists */}
      {discussion?.announcementMessage && discussion.createdAt && (
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
            <p className="mt-1.5 text-[11px] text-muted-foreground dark:text-accent-foreground text-right">
              {formatDateTime(discussion.createdAt)}
            </p>
          </div>
        </div>
      )}

      {messages.length === 0 && !discussion?.announcementMessage ? (
        <EmptyState />
      ) : (
        messageItems
      )}
      <Element name="messagesEnd" />
    </div>
  );
};

export default MessageList;
