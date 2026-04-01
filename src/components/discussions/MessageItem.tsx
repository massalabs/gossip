import React, { useRef, useMemo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import {
  CornerUpLeft,
  ChevronDown,
  Check as CheckIcon,
  AlertTriangle,
  Clock,
} from 'react-feather';
import MessageContextMenu, {
  type ReactionGroup as ContextMenuReactionGroup,
} from '../ui/MessageContextMenu';
import EmojiPickerModal from '../ui/EmojiPickerModal';
import ReactionBar from './ReactionBar';
import { formatTime } from '../../utils/timeUtils';
import {
  Message,
  MessageStatus,
  MessageDirection,
  MessageType,
} from '@massalabs/gossip-sdk';
import { parseLinks, openUrl } from '../../utils/linkUtils';
import { useMarkMessageAsRead } from '../../hooks/useMarkMessageAsRead';
import { Capacitor } from '@capacitor/core';
import ContactAvatar from '../avatar/ContactAvatar';
import type { Contact } from '@massalabs/gossip-sdk';

import {
  useSwipeToReply,
  SWIPE_THRESHOLD,
  SWIPE_THRESHOLD_OUTGOING,
} from './hooks/useSwipeToReply';
import { useContextMenu } from './hooks/useContextMenu';
import { useTextSelection } from './hooks/useTextSelection';
import { useOriginalMessage } from './hooks/useOriginalMessage';
import { useLongPress } from '../../hooks/useLongPress';

const SWIPE_INDICATOR_MAX_WIDTH = 60;
const POST_GESTURE_SUPPRESS_MS = 700;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface MessageItemProps {
  message: Message;
  onReplyTo?: (message: Message) => void;
  onScrollToMessage?: (messageId: number) => void;
  onForward?: (message: Message) => void;
  onDelete?: (message: Message) => void;
  onEdit?: (message: Message) => void;
  onReact?: (message: Message, emoji: string) => void;
  onToggleReaction?: (
    message: Message,
    emoji: string,
    myReactionId?: number,
    myReactionMessageId?: Uint8Array
  ) => void;
  reactions?: ContextMenuReactionGroup[];
  id?: string;
  showTimestamp?: boolean;
  isFirstInGroup?: boolean;
  isLastInGroup?: boolean;
  showAvatar?: boolean;
  contact?: Pick<Contact, 'name' | 'avatar' | 'userId'>;
  isHighlighted?: boolean;
  isSelecting?: boolean;
  isSelected?: boolean;
  onToggleSelect?: (messageId: number) => void;
}

// ---------------------------------------------------------------------------
// Shared link renderer (reply/forward/content all use same pattern)
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
      {segments.map((segment, index) => {
        if (segment.type === 'link') {
          return (
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
          );
        }
        return <span key={index}>{segment.content}</span>;
      })}
    </>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

const MessageItem: React.FC<MessageItemProps> = ({
  message,
  onReplyTo,
  onScrollToMessage,
  onForward,
  onDelete,
  onEdit,
  onReact,
  onToggleReaction,
  reactions = [],
  id,
  showTimestamp = true,
  isFirstInGroup = true,
  isLastInGroup = true,
  showAvatar = false,
  contact,
  isHighlighted = false,
  isSelecting = false,
  isSelected = false,
  onToggleSelect,
}) => {
  const { t } = useTranslation('discussions');
  const isOutgoing = message.direction === MessageDirection.OUTGOING;
  const isDeleted = message.type === MessageType.DELETED;
  const canReply = !!onReplyTo && !isDeleted;
  const canForward = !!onForward && !isDeleted;
  const isSending =
    isOutgoing &&
    (message.status === MessageStatus.WAITING_SESSION ||
      message.status === MessageStatus.READY);
  const isEdited =
    !!message.metadata &&
    (message.metadata as { edited?: boolean }).edited === true;

  // Refs
  const bubbleRef = useRef<HTMLDivElement>(null);
  const markAsReadRef = useMarkMessageAsRead(message);
  const combinedBubbleRef = useCallback(
    (node: HTMLDivElement | null) => {
      bubbleRef.current = node;
      markAsReadRef.current = node;
    },
    [markAsReadRef]
  );
  const suppressClickRef = useRef(false);
  const suppressClicksUntilRef = useRef(0);

  // Extracted hooks
  const textSelection = useTextSelection({
    bubbleRef,
    contextMenuOpenRef: { current: false }, // will be set below
  });

  const isAndroid = Capacitor.getPlatform() === 'android';
  const lastLongPressAtRef = useRef(0);

  const handleLongPress = useCallback(() => {
    if (isDeleted) return;
    const now = Date.now();
    if (now - lastLongPressAtRef.current < POST_GESTURE_SUPPRESS_MS) return;
    lastLongPressAtRef.current = now;
    suppressClickRef.current = true;
    suppressClicksUntilRef.current = now + POST_GESTURE_SUPPRESS_MS;

    if (isSelecting && isSelected) {
      textSelection.enableTextSelection();
    } else {
      if (message.id != null) onToggleSelect?.(message.id);
    }
  }, [
    isSelecting,
    isSelected,
    textSelection,
    onToggleSelect,
    message.id,
    isDeleted,
  ]);

  const longPress = useLongPress({
    onLongPress: handleLongPress,
    preventDefaultOnEnd: !isAndroid,
  });

  const contextMenu = useContextMenu({
    message,
    isOutgoing,
    isDeleted,
    isSelecting,
    bubbleRef,
    longPress,
    onReplyTo,
    onForward,
    onDelete,
    onEdit,
  });

  const swipe = useSwipeToReply({
    isOutgoing,
    isDeleted,
    isSelecting,
    isTextSelectable: textSelection.isTextSelectable,
    canReply,
    canForward,
    onReplyTo,
    message,
    longPress,
    suppressClickRef,
    suppressClicksUntilRef,
    longPressPosRef: textSelection.longPressPosRef,
  });

  const original = useOriginalMessage({ message, onScrollToMessage });

  // Parsed links for content
  const parsedLinks = useMemo(
    () => parseLinks(message.content),
    [message.content]
  );

  const handleLinkClick = useCallback(
    (e: React.MouseEvent<HTMLAnchorElement>) => {
      e.preventDefault();
      e.stopPropagation();
      const url = e.currentTarget.href;
      if (url) openUrl(url);
    },
    []
  );

  const linkAriaLabel = useCallback(
    (content: string) => t('message_item.link_opens_new_tab', { content }),
    [t]
  );

  // Bubble click
  const handleBubbleClick = useCallback(
    (e: React.MouseEvent) => {
      if (isDeleted) return;
      const inSuppressionWindow = Date.now() < suppressClicksUntilRef.current;
      if (suppressClickRef.current || inSuppressionWindow) {
        e.stopPropagation();
        suppressClickRef.current = false;
        return;
      }
      if (isSelecting) return;
      if (textSelection.isTextSelectable) {
        textSelection.clearTextSelection();
        return;
      }
      contextMenu.openContextMenu();
    },
    [contextMenu, textSelection, isSelecting, isDeleted]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (isDeleted) return;
      if (e.key === 'F10' && e.shiftKey) {
        e.preventDefault();
        contextMenu.openContextMenu();
      }
    },
    [contextMenu, isDeleted]
  );

  // Spacing
  const baseSpacingClass = isLastInGroup ? 'mb-1' : 'mb-0.5';
  const spacingClass =
    reactions.length > 0 ? (isLastInGroup ? 'mb-4' : 'mb-3') : baseSpacingClass;

  // Border radius
  const borderRadiusClass = useMemo(() => {
    if (isFirstInGroup && isLastInGroup)
      return isOutgoing
        ? 'rounded-3xl rounded-br-md'
        : 'rounded-3xl rounded-bl-md';
    if (isFirstInGroup)
      return isOutgoing
        ? 'rounded-t-3xl rounded-bl-3xl rounded-br-md'
        : 'rounded-t-3xl rounded-br-3xl rounded-bl-md';
    if (isLastInGroup)
      return isOutgoing
        ? 'rounded-b-3xl rounded-tl-3xl rounded-tr-md'
        : 'rounded-b-3xl rounded-tl-md rounded-tr-3xl';
    return isOutgoing
      ? 'rounded-tr-md rounded-br-md rounded-tl-3xl rounded-bl-3xl'
      : 'rounded-tr-3xl rounded-tl-md rounded-br-3xl rounded-bl-md';
  }, [isFirstInGroup, isLastInGroup, isOutgoing]);

  return (
    <div
      id={id}
      className={`flex items-end gap-1 ${isOutgoing ? 'justify-end' : 'justify-start'} group relative ${spacingClass} ${isHighlighted ? 'search-highlight' : ''} ${isSelecting ? 'cursor-pointer pl-8' : 'pl-0'} transition-[padding-left] duration-200 ease-out`}
      onTouchStart={swipe.handleTouchStart}
      onTouchMove={swipe.handleTouchMove}
      onTouchEnd={swipe.handleTouchEnd}
      onTouchCancel={swipe.handleTouchCancel}
      onContextMenu={contextMenu.handleContextMenu}
      style={{ touchAction: 'manipulation' }}
      role="listitem"
      aria-label={
        isOutgoing
          ? t('message_item.sent_message')
          : t('message_item.received_message')
      }
      onClick={
        isSelecting
          ? () => {
              if (
                !suppressClickRef.current &&
                Date.now() >= suppressClicksUntilRef.current &&
                !isDeleted &&
                message.id != null
              ) {
                onToggleSelect?.(message.id);
              }
              suppressClickRef.current = false;
            }
          : undefined
      }
    >
      {/* Selection checkbox */}
      <div
        className={`absolute left-1 top-0 bottom-0 flex items-center justify-center transition-opacity duration-200 ease-out ${
          isSelecting && !isDeleted
            ? 'opacity-100'
            : 'opacity-0 pointer-events-none'
        }`}
        onClick={e => {
          e.stopPropagation();
          if (
            suppressClickRef.current ||
            Date.now() < suppressClicksUntilRef.current
          ) {
            suppressClickRef.current = false;
            return;
          }
          if (!isDeleted && message.id != null) onToggleSelect?.(message.id);
        }}
        data-testid="select-checkbox"
      >
        <div
          className={`w-5 h-5 rounded-full border-2 flex items-center justify-center transition-colors duration-150 ${
            isSelected
              ? 'bg-accent border-accent'
              : 'border-muted-foreground/40 bg-transparent'
          }`}
        >
          {isSelected && (
            <CheckIcon
              className="w-3 h-3 text-accent-foreground"
              strokeWidth={3}
            />
          )}
        </div>
      </div>

      {/* Incoming avatar */}
      {!isOutgoing && contact && (
        <div className="w-8 shrink-0 ml-1">
          {showAvatar ? (
            <ContactAvatar contact={contact} size={8} />
          ) : (
            <div className="w-8 h-8" />
          )}
        </div>
      )}

      {/* Bubble */}
      <div
        ref={combinedBubbleRef}
        className={`relative max-w-[80%] sm:max-w-[70%] md:max-w-[65%] lg:max-w-[60%] ${reactions.length > 1 ? 'min-w-[8rem]' : ''} px-3.5 py-3 font-normal text-[15px] leading-tight ${textSelection.isTextSelectable ? 'select-text' : 'select-none'} ${borderRadiusClass} ${
          isOutgoing
            ? 'ml-auto mr-3 bg-accent text-accent-foreground'
            : `${contact ? '' : 'ml-3'} mr-auto bg-surface-secondary text-card-foreground`
        } ${!isDeleted && canReply ? 'cursor-pointer focus:outline-none' : ''} ${
          contextMenu.isContextMenuOpen
            ? 'ring-2 ring-accent shadow-lg brightness-105'
            : ''
        } ${isDeleted ? 'opacity-80' : ''}`}
        onClick={handleBubbleClick}
        onKeyDown={handleKeyDown}
        role={isDeleted ? undefined : 'button'}
        aria-label={isDeleted ? undefined : t('message_item.double_tap_reply')}
        style={{
          transform:
            swipe.swipeOffset !== 0
              ? `translateX(${swipe.swipeOffset}px)`
              : 'translateX(0)',
          transition: swipe.isAnimatingBack
            ? 'transform 0.3s cubic-bezier(0.34, 1.56, 0.64, 1), border-radius 0.3s ease-out'
            : 'border-radius 0.3s ease-out',
        }}
      >
        {/* Swipe reply indicator */}
        {-swipe.swipeOffset > swipe.indicatorThreshold && canReply && (
          <div
            className={`absolute right-0 top-0 bottom-0 flex items-center justify-center ${isOutgoing ? 'bg-accent/20' : 'bg-card/20'} rounded-r-2xl`}
            style={{
              width: `${Math.min(-swipe.swipeOffset, SWIPE_INDICATOR_MAX_WIDTH)}px`,
              opacity: Math.min(
                -swipe.swipeOffset / SWIPE_INDICATOR_MAX_WIDTH,
                1
              ),
              transition: swipe.isAnimatingBack ? 'all 0.3s ease-out' : 'none',
            }}
            aria-hidden="true"
          >
            <CornerUpLeft
              className={`w-5 h-5 text-muted-foreground transition-transform ${
                -swipe.swipeOffset >=
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
          <div
            className={`mb-2 pb-2 border-l-2 pl-2 ${isOutgoing ? 'border-accent-foreground/30' : 'border-card-foreground/30'} ${original.originalNotFound ? 'border-destructive/50' : ''} ${
              message.replyTo.originalMsgId && onScrollToMessage
                ? 'cursor-pointer hover:bg-black/5 dark:hover:bg-white/5 rounded-r transition-colors active:scale-[0.98]'
                : ''
            }`}
            {...(message.replyTo.originalMsgId && onScrollToMessage
              ? {
                  onClick: original.handleReplyContextClick,
                  onKeyDown: original.handleReplyContextKeyDown,
                  tabIndex: 0,
                  role: 'button',
                  'aria-label': t('message_item.jump_to_original'),
                }
              : {})}
          >
            {original.originalNotFound && (
              <div className="flex items-center gap-1 mb-2">
                <span
                  className="inline-flex items-center gap-1"
                  title={t('message_item.original_not_found_title')}
                >
                  <AlertTriangle
                    className="w-3.5 h-3.5 text-destructive shrink-0"
                    aria-hidden="true"
                  />
                  <span className="text-xs text-destructive md:hidden">
                    {t('message_item.original_not_found_short')}
                  </span>
                </span>
              </div>
            )}
            <p
              className={`text-xs truncate ${isOutgoing ? 'text-accent-foreground/80' : 'text-muted-foreground/80'} ${original.originalNotFound ? 'italic opacity-70' : ''}`}
            >
              {original.isLoadingOriginal ? (
                t('common:loading')
              ) : original.parsedReplyLinks.length > 0 ? (
                <LinkText
                  segments={original.parsedReplyLinks}
                  onLinkClick={handleLinkClick}
                  linkAriaLabel={linkAriaLabel}
                />
              ) : (
                original.originalMessage?.content ||
                t('message_item.original_message')
              )}
            </p>
          </div>
        )}

        {/* Forward context */}
        {message.forwardOf && (
          <div
            className={`mb-2 pb-2 border-l-2 pl-2 ${isOutgoing ? 'border-accent-foreground/30' : 'border-card-foreground/30'} ${
              original.canNavigateToForwarded
                ? 'cursor-pointer hover:bg-black/5 dark:hover:bg-white/5 rounded-r transition-colors active:scale-[0.98]'
                : ''
            }`}
            {...(original.canNavigateToForwarded
              ? {
                  onClick: original.handleReplyContextClick,
                  onKeyDown: original.handleReplyContextKeyDown,
                  tabIndex: 0,
                  role: 'button',
                  'aria-label': t('message_item.jump_to_original'),
                }
              : {})}
          >
            {original.isLoadingOriginal ? (
              <p
                className={`text-xs ${isOutgoing ? 'text-accent-foreground/80' : 'text-muted-foreground/80'}`}
              >
                {t('common:loading')}
              </p>
            ) : (
              <>
                <p
                  className={`text-[11px] font-medium mb-0.5 ${isOutgoing ? 'text-accent-foreground/80' : 'text-muted-foreground/80'}`}
                >
                  {t('message_item.forwarded_message')}
                </p>
                <p
                  className={`text-xs truncate ${isOutgoing ? 'text-accent-foreground/80' : 'text-muted-foreground/80'}`}
                >
                  {original.parsedForwardLinks.length > 0 ? (
                    <LinkText
                      segments={original.parsedForwardLinks}
                      onLinkClick={handleLinkClick}
                      linkAriaLabel={linkAriaLabel}
                    />
                  ) : (
                    original.originalMessage?.content ||
                    message.forwardOf.originalContent ||
                    t('message_item.original_message')
                  )}
                </p>
              </>
            )}
          </div>
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

        {/* Timestamp + Status */}
        {(showTimestamp || (!isDeleted && (isOutgoing || isEdited))) && (
          <span
            className={`absolute bottom-[13px] right-2.5 flex items-center gap-1 ${isOutgoing ? 'text-accent-foreground/80' : 'text-muted-foreground'}`}
          >
            {isEdited && !isSending && (
              <span className="text-[10px] italic opacity-75">
                {t('message_item.edited')}
              </span>
            )}
            {showTimestamp && !isSending && (
              <span className="text-[11px] font-medium">
                {formatTime(message.timestamp)}
              </span>
            )}
            {isOutgoing && !isDeleted && (
              <span
                className="inline-flex items-center w-4 h-3.5 transition-opacity duration-200"
                aria-label={t('message_item.status', {
                  status: message.status,
                })}
              >
                {isSending && (
                  <Clock
                    className="w-3 h-3"
                    aria-label={t('message_item.sending')}
                  />
                )}
                {message.status === MessageStatus.SENT && (
                  <CheckIcon
                    className="w-3.5 h-3.5"
                    aria-label={t('message_item.sent')}
                  />
                )}
                {(message.status === MessageStatus.DELIVERED ||
                  message.status === MessageStatus.READ) && (
                  <span
                    className="relative inline-flex items-center w-4 h-3.5"
                    aria-label={t('message_item.delivered')}
                  >
                    <CheckIcon className="w-3.5 h-3.5 absolute left-0" />
                    <CheckIcon className="w-3.5 h-3.5 absolute left-[5px] top-[1.5px]" />
                  </span>
                )}
              </span>
            )}
          </span>
        )}

        {/* Desktop context menu arrow */}
        {!isSelecting && !isDeleted && (
          <button
            type="button"
            onClick={e => {
              e.stopPropagation();
              contextMenu.openContextMenu();
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
        hasAvatar={!!contact}
        onToggleReaction={onToggleReaction}
      />

      <MessageContextMenu
        items={contextMenu.contextMenuItems}
        isOpen={contextMenu.isContextMenuOpen}
        onClose={contextMenu.closeContextMenu}
        isOutgoing={isOutgoing}
        reactions={reactions}
        onSelectEmoji={emoji => onReact?.(message, emoji)}
        onOpenEmojiPicker={() => {
          contextMenu.setIsEmojiPickerOpen(true);
          contextMenu.closeContextMenu();
        }}
      />
      <EmojiPickerModal
        isOpen={contextMenu.isEmojiPickerOpen}
        onClose={() => contextMenu.setIsEmojiPickerOpen(false)}
        title={t('message_item.add_reaction')}
        onSelectEmoji={emoji => onReact?.(message, emoji)}
      />
    </div>
  );
};

export default MessageItem;
