import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { CornerUpLeft, ChevronDown } from 'react-feather';
import { Message } from '@massalabs/gossip-sdk';
import { parseLinks, openUrl } from '../../utils/linkUtils';
import CitedMessage, { type CitedMessageOriginal } from './CitedMessage';
import MessageStatusIndicator from './MessageStatus';
import ReactionBar from './ReactionBar';
import type { ReactionGroup } from '../../stores/messageStore';
import {
  SWIPE_THRESHOLD,
  SWIPE_THRESHOLD_OUTGOING,
} from './hooks/useSwipeToReply';

const SWIPE_INDICATOR_MAX_WIDTH = 60;

// ---------------------------------------------------------------------------
// LinkText (inline helper — renders parsed text with clickable links)
// ---------------------------------------------------------------------------

function LinkText({
  segments,
  onLinkClick,
  linkAriaLabel,
}: {
  segments: ReturnType<typeof parseLinks>;
  onLinkClick: (e: React.MouseEvent<HTMLAnchorElement>) => void;
  linkAriaLabel: (content: string) => string;
}) {
  return (
    <>
      {segments.map((segment, index) =>
        segment.type === 'link' ? (
          <a
            key={index}
            href={segment.url}
            target="_blank"
            rel="noopener noreferrer"
            onClick={onLinkClick}
            aria-label={linkAriaLabel(segment.content)}
            className="underline hover:opacity-80 transition-opacity break-all cursor-pointer"
            style={{
              textDecorationColor: 'currentColor',
              textDecorationThickness: '1px',
            }}
          >
            {segment.content}
          </a>
        ) : (
          <span key={index}>{segment.content}</span>
        )
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface MessageBubbleProps {
  message: Message;
  bubbleRef: React.Ref<HTMLDivElement>;
  isOutgoing: boolean;
  isDeleted: boolean;
  isEdited: boolean;
  isSending: boolean;
  showTimestamp: boolean;
  isTextSelectable: boolean;
  isContextMenuOpen: boolean;
  canReply: boolean;
  hasContact: boolean;
  hasMultipleReactions: boolean;
  borderRadiusClass: string;
  // Swipe
  swipeOffset: number;
  isAnimatingBack: boolean;
  indicatorThreshold: number;
  // Original message (reply/forward)
  original: CitedMessageOriginal;
  // Reactions
  reactions: ReactionGroup[];
  onToggleReaction?: (
    message: Message,
    emoji: string,
    myReactionId?: number,
    myReactionMessageId?: Uint8Array
  ) => void;
  // Handlers
  onClick: (e: React.MouseEvent) => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
  openContextMenu: () => void;
  isSelecting: boolean;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

const MessageBubble: React.FC<MessageBubbleProps> = React.memo(
  ({
    message,
    bubbleRef,
    isOutgoing,
    isDeleted,
    isEdited,
    isSending,
    showTimestamp,
    isTextSelectable,
    isContextMenuOpen,
    canReply,
    hasContact,
    hasMultipleReactions,
    borderRadiusClass,
    swipeOffset,
    isAnimatingBack,
    indicatorThreshold,
    original,
    reactions,
    onToggleReaction,
    onClick,
    onKeyDown,
    openContextMenu,
    isSelecting,
  }) => {
    const { t } = useTranslation('discussions');

    const parsedLinks = useMemo(
      () => parseLinks(message.content),
      [message.content]
    );

    const handleLinkClick = React.useCallback(
      (e: React.MouseEvent<HTMLAnchorElement>) => {
        e.preventDefault();
        e.stopPropagation();
        const url = e.currentTarget.href;
        if (url) openUrl(url);
      },
      []
    );

    const linkAriaLabel = React.useCallback(
      (content: string) => t('message_item.link_opens_new_tab', { content }),
      [t]
    );

    return (
      <div
        className={`flex flex-col max-w-[80%] sm:max-w-[70%] md:max-w-[65%] lg:max-w-[60%] ${
          isOutgoing ? 'ml-auto mr-3' : `${hasContact ? '' : 'ml-3'} mr-auto`
        }`}
      >
        <div
          ref={bubbleRef}
          className={`relative ${hasMultipleReactions ? 'min-w-[8rem]' : ''} px-3.5 py-3 font-normal text-[15px] leading-tight ${isTextSelectable ? 'select-text' : 'select-none'} ${borderRadiusClass} ${
            isOutgoing
              ? 'bg-accent text-accent-foreground'
              : 'bg-surface-secondary text-card-foreground'
          } ${!isDeleted && canReply ? 'cursor-pointer focus:outline-none' : ''} ${
            isContextMenuOpen
              ? 'ring-2 ring-accent shadow-lg brightness-105'
              : ''
          } ${isDeleted ? 'opacity-80' : ''}`}
          onClick={onClick}
          onKeyDown={onKeyDown}
          role={isDeleted ? undefined : 'button'}
          aria-label={
            isDeleted ? undefined : t('message_item.double_tap_reply')
          }
          style={{
            transform:
              swipeOffset !== 0
                ? `translateX(${swipeOffset}px)`
                : 'translateX(0)',
            transition: isAnimatingBack
              ? 'transform 0.3s cubic-bezier(0.34, 1.56, 0.64, 1), border-radius 0.3s ease-out'
              : 'border-radius 0.3s ease-out',
          }}
        >
          {/* Swipe reply indicator */}
          {-swipeOffset > indicatorThreshold && canReply && (
            <div
              className={`absolute right-0 top-0 bottom-0 flex items-center justify-center ${isOutgoing ? 'bg-accent/20' : 'bg-card/20'} rounded-r-2xl`}
              style={{
                width: `${Math.min(-swipeOffset, SWIPE_INDICATOR_MAX_WIDTH)}px`,
                opacity: Math.min(-swipeOffset / SWIPE_INDICATOR_MAX_WIDTH, 1),
                transition: isAnimatingBack ? 'all 0.3s ease-out' : 'none',
              }}
              aria-hidden="true"
            >
              <CornerUpLeft
                className={`w-5 h-5 text-muted-foreground transition-transform ${
                  -swipeOffset >=
                  (isOutgoing ? SWIPE_THRESHOLD_OUTGOING : SWIPE_THRESHOLD)
                    ? 'scale-110'
                    : 'scale-100'
                }`}
                aria-hidden="true"
              />
            </div>
          )}

          {/* Reply context */}
          {message.replyTo && (
            <CitedMessage
              isOutgoing={isOutgoing}
              original={original}
              variant="reply"
              onLinkClick={handleLinkClick}
              linkAriaLabel={linkAriaLabel}
            />
          )}

          {/* Forward context */}
          {message.forwardOf && (
            <CitedMessage
              isOutgoing={isOutgoing}
              original={original}
              variant="forward"
              fallbackContent={message.forwardOf.originalContent}
              onLinkClick={handleLinkClick}
              linkAriaLabel={linkAriaLabel}
            />
          )}

          {/* Content */}
          {isDeleted ? (
            <p className="whitespace-pre-wrap wrap-break-word italic text-muted-foreground text-[13px]">
              {t('message_item.deleted')}
              {showTimestamp && (
                <span className="inline-block w-10" aria-hidden="true" />
              )}
            </p>
          ) : (
            <p className="whitespace-pre-wrap wrap-break-word">
              <LinkText
                segments={parsedLinks}
                onLinkClick={handleLinkClick}
                linkAriaLabel={linkAriaLabel}
              />
              {(showTimestamp || (!isDeleted && (isOutgoing || isEdited))) && (
                <span
                  className={`inline-block ${isOutgoing ? 'w-16' : 'w-10'}`}
                  aria-hidden="true"
                />
              )}
            </p>
          )}

          <MessageStatusIndicator
            status={message.status}
            timestamp={message.timestamp}
            isOutgoing={isOutgoing}
            isDeleted={isDeleted}
            isEdited={isEdited}
            isSending={isSending}
            showTimestamp={showTimestamp}
          />

          {/* Desktop context menu arrow */}
          {!isSelecting && !isDeleted && (
            <button
              type="button"
              onClick={e => {
                e.stopPropagation();
                openContextMenu();
              }}
              className="absolute top-1.5 right-2 p-0.5 opacity-0 group-hover:opacity-100 transition-opacity hidden md:flex items-center justify-center"
              aria-label={t('message_item.actions_menu')}
            >
              <ChevronDown className="w-3.5 h-3.5 text-muted-foreground" />
            </button>
          )}
        </div>
        <ReactionBar
          reactions={reactions}
          message={message}
          isOutgoing={isOutgoing}
          onToggleReaction={onToggleReaction}
        />
      </div>
    );
  }
);

MessageBubble.displayName = 'MessageBubble';

export default MessageBubble;
