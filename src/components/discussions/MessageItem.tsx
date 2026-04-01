import React, { useRef, useMemo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import MessageContextMenu, {
  type ReactionGroup as ContextMenuReactionGroup,
} from '../ui/MessageContextMenu';
import EmojiPickerModal from '../ui/EmojiPickerModal';
import ReactionBar from './ReactionBar';
import MessageBubble from './MessageBubble';
import SelectionCheckbox from './SelectionCheckbox';
import MessageAvatar from './MessageAvatar';
import {
  Message,
  MessageStatus,
  MessageDirection,
  MessageType,
} from '@massalabs/gossip-sdk';
import { useMarkMessageAsRead } from '../../hooks/useMarkMessageAsRead';
import { Capacitor } from '@capacitor/core';
import type { Contact } from '@massalabs/gossip-sdk';

import { useSwipeToReply } from './hooks/useSwipeToReply';
import { useContextMenu } from './hooks/useContextMenu';
import { useTextSelection } from './hooks/useTextSelection';
import { useOriginalMessage } from './hooks/useOriginalMessage';
import { useLongPress } from '../../hooks/useLongPress';

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
      <SelectionCheckbox
        isVisible={isSelecting && !isDeleted}
        isSelected={isSelected}
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
      />

      {!isOutgoing && contact && (
        <MessageAvatar contact={contact} showAvatar={showAvatar} />
      )}

      <MessageBubble
        message={message}
        bubbleRef={combinedBubbleRef}
        isOutgoing={isOutgoing}
        isDeleted={isDeleted}
        isEdited={isEdited}
        isSending={isSending}
        showTimestamp={showTimestamp}
        isTextSelectable={textSelection.isTextSelectable}
        isContextMenuOpen={contextMenu.isContextMenuOpen}
        canReply={canReply}
        hasContact={!!contact}
        hasMultipleReactions={reactions.length > 1}
        borderRadiusClass={borderRadiusClass}
        swipeOffset={swipe.swipeOffset}
        isAnimatingBack={swipe.isAnimatingBack}
        indicatorThreshold={swipe.indicatorThreshold}
        original={original}
        onClick={handleBubbleClick}
        onKeyDown={handleKeyDown}
        openContextMenu={contextMenu.openContextMenu}
        isSelecting={isSelecting}
      />

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
