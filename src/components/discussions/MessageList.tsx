import React, { useMemo, useEffect, useRef } from 'react';
import * as ReactScroll from 'react-scroll';
import { Message, Discussion } from '../../db';
import MessageItem from './MessageItem';
import LoadingState from './LoadingState';
import EmptyState from './EmptyState';

const { scroller, Element } = ReactScroll;

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
        scroller.scrollTo('messagesEnd', {
          duration: 300,
          delay: 0,
          smooth: true,
          containerId: 'messagesContainer',
        });
      });
      hasInitiallyScrolledRef.current = true;
    }

    prevLastMessageIdRef.current = currentLastMessageId;
  }, [messages.length, isLoading, messages]);

  if (isLoading) {
    return <LoadingState />;
  }

  return (
    <div
      id="messagesContainer"
      className="flex-1 overflow-y-auto px-4 md:px-6 lg:px-8 py-6 space-y-4"
    >
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
