import React, { useMemo, useEffect, useRef } from 'react';
import * as ReactScroll from 'react-scroll';
import { Message, Discussion } from '../../db';
import MessageItem from './MessageItem';
import LoadingState from './LoadingState';
import EmptyState from './EmptyState';

const { Element } = ReactScroll;

interface MessageListProps {
  messages: Message[];
  discussion?: Discussion | null;
  isLoading: boolean;
  onResend: (message: Message) => void;
  onReplyTo?: (message: Message) => void;
  onScrollToMessage?: (messageId: number) => void;
}

const MessageList: React.FC<MessageListProps> = ({
  messages,
  discussion,
  isLoading,
  onResend,
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

  // Memoize the message items to prevent re-rendering all messages when one is added
  const messageItems = useMemo(() => {
    return messages.map(message => {
      return (
        <MessageItem
          key={message.id}
          id={`message-${message.id}`}
          message={message}
          onResend={onResend}
          onReplyTo={onReplyTo}
          onScrollToMessage={onScrollToMessage}
        />
      );
    });
  }, [messages, onResend, onReplyTo, onScrollToMessage]);

  // Auto-scroll to bottom when new messages are added
  useEffect(() => {
    if (isLoading) return;

    const lastMessage = messages[messages.length - 1];
    const currentLastMessageId = lastMessage?.id || null;
    const prevLastMessageId = prevLastMessageIdRef.current;

    // Scroll on initial load or when the last message changes (new message added)
    const shouldScroll =
      !hasInitiallyScrolledRef.current ||
      (currentLastMessageId !== null &&
        currentLastMessageId !== prevLastMessageId);

    if (shouldScroll) {
      // Use requestAnimationFrame to ensure DOM is updated
      requestAnimationFrame(() => {
        // Try react-scroll first, fallback to native scroll
        const container = document.getElementById('messagesContainer');
        if (container) {
          const messagesEnd = container.querySelector('[name="messagesEnd"]');
          if (messagesEnd) {
            messagesEnd.scrollIntoView({ behavior: 'smooth', block: 'end' });
          } else {
            // Fallback: scroll to bottom
            container.scrollTop = container.scrollHeight;
          }
        }
      });
      hasInitiallyScrolledRef.current = true;
    }

    prevLastMessageIdRef.current = currentLastMessageId;
  }, [messages.length, isLoading, messages]);

  if (isLoading) {
    return <LoadingState />;
  }

  return (
    <div className="px-4 md:px-6 lg:px-8 py-6 space-y-4">
      {/* Display announcement message if it exists */}
      {discussion?.announcementMessage && (
        <div className="flex justify-center mb-4">
          <div className="max-w-[85%] sm:max-w-[75%] md:max-w-[70%] px-4 py-3 bg-muted/50 border border-border rounded-xl">
            <p className="text-xs font-medium text-muted-foreground mb-1.5">
              Announcement message:
            </p>
            <p className="text-sm text-foreground whitespace-pre-wrap wrap-break-word">
              {discussion.announcementMessage}
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
