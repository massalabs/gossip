import { useState, useEffect, useMemo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { CornerUpLeft, Share, Share2, Copy, Trash2, Edit } from 'react-feather';
import { createElement } from 'react';
import { shareMessage } from '../../../services/shareService';
import type { useLongPress } from '../../../hooks/useLongPress';
import type { MessageContextMenuItem } from '../../ui/MessageContextMenu';
import type { Message } from '@massalabs/gossip-sdk';
import { Capacitor } from '@capacitor/core';
import { isTouch } from '../../../utils/platform';

interface UseContextMenuOptions {
  message: Message;
  isOutgoing: boolean;
  isDeleted: boolean;
  isSelecting: boolean;
  bubbleRef: React.RefObject<HTMLDivElement | null>;
  contextMenuOpenRef: React.MutableRefObject<boolean>;
  longPress: ReturnType<typeof useLongPress>;
  onReplyTo?: (message: Message) => void;
  onForward?: (message: Message) => void;
  onDelete?: (message: Message) => void;
  onEdit?: (message: Message) => void;
}

export function useContextMenu({
  message,
  isOutgoing,
  isDeleted,
  isSelecting,
  bubbleRef,
  contextMenuOpenRef,
  longPress,
  onReplyTo,
  onForward,
  onDelete,
  onEdit,
}: UseContextMenuOptions) {
  const { t } = useTranslation('discussions');

  const [isContextMenuOpen, setIsContextMenuOpen] = useState(false);

  const openContextMenu = useCallback(() => {
    if (!bubbleRef.current || contextMenuOpenRef.current || isDeleted) return;
    contextMenuOpenRef.current = true;
    setIsContextMenuOpen(true);
  }, [isDeleted, bubbleRef, contextMenuOpenRef]);

  const closeContextMenu = useCallback(() => {
    contextMenuOpenRef.current = false;
    setIsContextMenuOpen(false);
  }, [contextMenuOpenRef]);

  // Close context menu if the list scrolls (e.g. desktop mouse wheel)
  useEffect(() => {
    if (!isContextMenuOpen) return;
    const scroller = bubbleRef.current?.closest('.scroll-container');
    if (!scroller) return;
    const onScroll = () => closeContextMenu();
    scroller.addEventListener('scroll', onScroll, { passive: true });
    return () => scroller.removeEventListener('scroll', onScroll);
  }, [isContextMenuOpen, closeContextMenu, bubbleRef]);

  const isAndroid = Capacitor.getPlatform() === 'android';
  const isWeb = !Capacitor.isNativePlatform();
  // Touch web (PWA / mobile browser) = web + coarse pointer. Mouse-only web
  // stays desktop-like (right-click opens menu).
  const isTouchWeb = isWeb && isTouch();

  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
      if (isDeleted) {
        e.preventDefault();
        return;
      }
      if (isAndroid && longPress.longPressTriggered.current) {
        // Don't prevent default — let native selection handles appear
        return;
      }
      e.preventDefault();
      // Touch web: the browser emits a synthetic contextmenu at ~300ms on
      // long-press, before our 500ms timer completes. Opening the menu here
      // would race the timer and we'd end up with BOTH the context menu open
      // and a selection toggled. Let useLongPress drive the UX; short-press
      // opens the menu via handleBubbleClick in MessageItem.
      if (isTouchWeb) return;
      // Desktop web: right-click always opens the menu, regardless of
      // selection state.
      if (isWeb && !longPress.longPressTriggered.current) {
        openContextMenu();
        return;
      }
      if (!isAndroid && !isSelecting && !longPress.longPressTriggered.current) {
        openContextMenu();
        return;
      }
      longPress.onContextMenu(e);
    },
    [
      isAndroid,
      isWeb,
      isTouchWeb,
      longPress,
      isDeleted,
      isSelecting,
      openContextMenu,
    ]
  );

  // Context menu items — depend on stable scalars, not the full message object
  const contextMenuItems = useMemo<MessageContextMenuItem[]>(() => {
    const items: MessageContextMenuItem[] = [];
    // DB ids are auto-increment starting at 1, so 0 / null / undefined all
    // mean "optimistic, not yet persisted".
    const hasConfirmedId = message.id != null && message.id !== 0;
    if (onReplyTo && !isDeleted && hasConfirmedId) {
      items.push({
        label: t('message_item.reply'),
        icon: createElement(CornerUpLeft, { className: 'w-4 h-4' }),
        onClick: () => onReplyTo(message),
      });
    }
    if (onForward && !isDeleted && hasConfirmedId) {
      items.push({
        label: t('message_item.forward'),
        icon: createElement(Share, { className: 'w-4 h-4' }),
        onClick: () => onForward(message),
      });
    }
    if (!isDeleted) {
      const fwd = message.forwardOf?.originalContent;
      const parts = [fwd, message.content].filter(Boolean);
      const fullText = parts.join('\n\n') || '';
      items.push({
        label: t('message_item.share'),
        icon: createElement(Share2, { className: 'w-4 h-4' }),
        onClick: () => {
          shareMessage(fullText).catch(() => {});
        },
      });
      items.push({
        label: t('message_item.copy'),
        icon: createElement(Copy, { className: 'w-4 h-4' }),
        onClick: () => {
          navigator.clipboard.writeText(fullText).catch(() => {
            /* clipboard not available */
          });
        },
      });
    }
    if (onEdit && isOutgoing && !isDeleted && hasConfirmedId) {
      items.push({
        label: t('message_item.edit'),
        icon: createElement(Edit, { className: 'w-4 h-4' }),
        onClick: () => onEdit(message),
      });
    }
    if (onDelete && !isDeleted && hasConfirmedId) {
      items.push({
        label: t('message_item.delete'),
        icon: createElement(Trash2, { className: 'w-4 h-4' }),
        danger: true,
        onClick: () => onDelete(message),
      });
    }
    return items;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    onReplyTo,
    onForward,
    onDelete,
    isOutgoing,
    isDeleted,
    message.id,
    message.content,
  ]);

  return {
    isContextMenuOpen,
    openContextMenu,
    closeContextMenu,
    contextMenuItems,
    handleContextMenu,
  };
}
