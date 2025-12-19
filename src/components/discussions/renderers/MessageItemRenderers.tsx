import React from 'react';
import { Message, DiscussionDirection } from '../../../db';
import { MessageGroupInfo } from '../../../utils/messageGrouping';
import MessageItem from '../MessageItem';
import DateSeparator from '../DateSeparator';

// =============================================================================
// Announcement Renderer
// =============================================================================

interface AnnouncementRendererProps {
  content: string;
  direction: DiscussionDirection;
}

export const AnnouncementRenderer: React.FC<AnnouncementRendererProps> = ({
  content,
  direction,
}) => (
  <div
    className={`mb-4 px-4 md:px-6 lg:px-8 flex ${
      direction === DiscussionDirection.INITIATED
        ? 'justify-end'
        : 'justify-start'
    }`}
  >
    <div
      className={`max-w-[85%] sm:max-w-[75%] md:max-w-[70%] px-4 py-3 rounded-3xl text-sm leading-tight ${
        direction === DiscussionDirection.INITIATED
          ? 'bg-accent text-accent-foreground rounded-br-lg'
          : 'bg-card dark:bg-surface-secondary text-card-foreground rounded-bl-lg shadow-sm'
      }`}
    >
      <p className="text-xs text-center font-light opacity-80 mb-1.5">
        Announcement message:
      </p>
      <p className="whitespace-pre-wrap wrap-break-word">{content}</p>
    </div>
  </div>
);

// =============================================================================
// Date Separator Renderer
// =============================================================================

interface DateRendererProps {
  date: Date;
}

export const DateRenderer: React.FC<DateRendererProps> = ({ date }) => (
  <div className="px-4 md:px-6 lg:px-8">
    <DateSeparator date={date} />
  </div>
);

// =============================================================================
// Message Renderer
// =============================================================================

interface MessageRendererProps {
  message: Message;
  showTimestamp: boolean;
  groupInfo: MessageGroupInfo;
  onReplyTo?: (message: Message) => void;
  onScrollToMessage?: (messageId: number) => void;
}

export const MessageRenderer: React.FC<MessageRendererProps> = ({
  message,
  showTimestamp,
  groupInfo,
  onReplyTo,
  onScrollToMessage,
}) => (
  <div className="px-4 md:px-6 lg:px-8">
    <MessageItem
      id={`message-${message.id}`}
      message={message}
      onReplyTo={onReplyTo}
      onScrollToMessage={onScrollToMessage}
      showTimestamp={showTimestamp}
      isFirstInGroup={groupInfo.isFirstInGroup}
      isLastInGroup={groupInfo.isLastInGroup}
    />
  </div>
);

// =============================================================================
// Spacer Renderer
// =============================================================================

export const SpacerRenderer: React.FC = () => (
  <div className="h-4" aria-hidden="true" />
);
