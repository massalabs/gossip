import React, { useMemo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Clock } from 'react-feather';
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
  const { t } = useTranslation('discussions');
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
          {t('announcement')}
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
                  aria-label={t('message_item.link_opens_new_tab', {
                    content: segment.content,
                  })}
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
  onDelete?: (message: Message) => void;
  onEdit?: (message: Message) => void;
  onScrollToMessage?: (messageId: number) => void;
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
  contact?: Pick<Contact, 'name' | 'avatar'>;
  isHighlighted?: boolean;
  isSelecting?: boolean;
  isSelected?: boolean;
  onToggleSelect?: (messageId: number) => void;
}

export const MessageRenderer: React.FC<MessageRendererProps> = ({
  message,
  showTimestamp,
  groupInfo,
  onReplyTo,
  onForward,
  onDelete,
  onEdit,
  onScrollToMessage,
  onReact,
  onToggleReaction,
  getReactionsForMessage,
  contact,
  isHighlighted,
  isSelecting,
  isSelected,
  onToggleSelect,
}) => {
  const isIncoming = message.direction === MessageDirection.INCOMING;
  const reactions =
    message.id != null && getReactionsForMessage
      ? getReactionsForMessage(message.id)
      : [];

  return (
    <div
      className={`px-4 md:px-6 lg:px-8 transition-colors duration-150 ${isSelecting && isSelected ? 'bg-accent/10' : ''}`}
    >
      <MessageItem
        id={`message-${message.id}`}
        message={message}
        onReplyTo={onReplyTo}
        onForward={onForward}
        onDelete={onDelete}
        onEdit={onEdit}
        onScrollToMessage={onScrollToMessage}
        onReact={onReact}
        onToggleReaction={onToggleReaction}
        reactions={reactions}
        showTimestamp={showTimestamp}
        isFirstInGroup={groupInfo.isFirstInGroup}
        isLastInGroup={groupInfo.isLastInGroup}
        showAvatar={isIncoming && groupInfo.isLastInGroup}
        contact={isIncoming ? contact : undefined}
        isHighlighted={isHighlighted}
        isSelecting={isSelecting}
        isSelected={isSelected}
        onToggleSelect={onToggleSelect}
      />
    </div>
  );
};

// =============================================================================
// Retention Separator Renderer
// =============================================================================

const RETENTION_LABELS: Record<number, string> = {
  300: 'settings.auto_delete_5m',
  3600: 'settings.auto_delete_1h',
  28800: 'settings.auto_delete_8h',
  86400: 'settings.auto_delete_1d',
  604800: 'settings.auto_delete_1w',
  2592000: 'settings.auto_delete_1mo',
};

interface RetentionSeparatorRendererProps {
  retentionDuration: number;
}

export const RetentionSeparatorRenderer: React.FC<
  RetentionSeparatorRendererProps
> = ({ retentionDuration }) => {
  const { t } = useTranslation('discussions');
  const labelKey = RETENTION_LABELS[retentionDuration];
  const durationLabel = labelKey ? t(labelKey) : `${retentionDuration}s`;

  return (
    <div className="flex items-center gap-2 px-4 py-2 my-1">
      <div className="flex-1 h-px bg-border" />
      <span className="inline-flex items-center gap-1 text-xs text-muted-foreground shrink-0 px-2">
        <Clock className="w-3 h-3 shrink-0" />
        {t('retention_separator', { duration: durationLabel })}
      </span>
      <div className="flex-1 h-px bg-border" />
    </div>
  );
};

// =============================================================================
// Spacer Renderer
// =============================================================================

export const SpacerRenderer: React.FC = () => (
  <div className="h-4" aria-hidden="true" />
);
