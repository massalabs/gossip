import React, { useMemo, useCallback } from 'react';
import {
  Message,
  MessageDirection,
  DiscussionDirection,
} from '@massalabs/gossip-sdk';
import type { Contact } from '@massalabs/gossip-sdk';
import { MessageGroupInfo } from '../../../utils/messageGrouping';
import MessageItem from '../MessageItem';
import DateSeparator from '../DateSeparator';
import { parseLinks, openUrl } from '../../../utils/linkUtils';

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
}) => {
  const handleLinkClick = useCallback(
    (e: React.MouseEvent<HTMLAnchorElement>) => {
      e.preventDefault();
      e.stopPropagation();
      // Open URL using our utility function that works on both web and native
      const url = e.currentTarget.href;
      if (url) {
        openUrl(url);
      }
    },
    []
  );

  // Memoize parsed links to avoid re-parsing on every render
  const parsedLinks = useMemo(() => parseLinks(content), [content]);

  return (
    <div
      className={`mb-4 px-4 md:px-6 lg:px-8 flex ${
        direction === DiscussionDirection.INITIATED
          ? 'justify-end'
          : 'justify-start'
      }`}
    >
      <div className="max-w-[85%] sm:max-w-[75%] md:max-w-[70%] px-4 py-3 rounded-2xl text-sm leading-tight bg-muted text-foreground border-l-2 border-primary">
        <p className="text-xs font-medium opacity-60 mb-1.5 italic">
          Announcement
        </p>
        <p className="whitespace-pre-wrap wrap-break-word">
          {parsedLinks.map((segment, index) => {
            if (segment.type === 'link') {
              return (
                <a
                  key={index}
                  href={segment.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={handleLinkClick}
                  aria-label={`${segment.content} (opens in a new tab)`}
                  className="underline hover:opacity-80 transition-opacity break-all cursor-pointer"
                  style={{
                    textDecorationColor: 'currentColor',
                    textDecorationThickness: '1px',
                  }}
                >
                  {segment.content}
                </a>
              );
            }
            return <span key={index}>{segment.content}</span>;
          })}
        </p>
      </div>
    </div>
  );
};

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
  onForward?: (message: Message) => void;
  onScrollToMessage?: (messageId: number) => void;
  contact?: Pick<Contact, 'name' | 'avatar'>;
  isHighlighted?: boolean;
}

export const MessageRenderer: React.FC<MessageRendererProps> = ({
  message,
  showTimestamp,
  groupInfo,
  onReplyTo,
  onForward,
  onScrollToMessage,
  contact,
  isHighlighted,
}) => {
  const isIncoming = message.direction === MessageDirection.INCOMING;

  return (
    <div className="px-4 md:px-6 lg:px-8">
      <MessageItem
        id={`message-${message.id}`}
        message={message}
        onReplyTo={onReplyTo}
        onForward={onForward}
        onScrollToMessage={onScrollToMessage}
        showTimestamp={showTimestamp}
        isFirstInGroup={groupInfo.isFirstInGroup}
        isLastInGroup={groupInfo.isLastInGroup}
        showAvatar={isIncoming && groupInfo.isLastInGroup}
        contact={isIncoming ? contact : undefined}
        isHighlighted={isHighlighted}
      />
    </div>
  );
};

// =============================================================================
// Spacer Renderer
// =============================================================================

export const SpacerRenderer: React.FC = () => (
  <div className="h-4" aria-hidden="true" />
);
