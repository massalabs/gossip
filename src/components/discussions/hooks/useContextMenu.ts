import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { CornerUpLeft, Share, Share2, Copy, Trash2 } from 'react-feather';
import { createElement } from 'react';
import { shareMessage } from '../../../services/shareService';
import type { useLongPress } from '../../../hooks/useLongPress';
import type { MessageContextMenuItem } from '../../ui/MessageContextMenu';
import type { Message } from '@massalabs/gossip-sdk';
import { Capacitor } from '@capacitor/core';

interface UseContextMenuOptions {
  message: Message;
  isOutgoing: boolean;
  isDeleted: boolean;
  isSelecting: boolean;
  bubbleRef: React.RefObject<HTMLDivElement>;
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
  longPress,
  onReplyTo,
  onForward,
  onDelete,
  onEdit,
}: UseContextMenuOptions) {
  const { t } = useTranslation('discussions');

  const [isContextMenuOpen, setIsContextMenuOpen] = useState(false);
  const [isEmojiPickerOpen, setIsEmojiPickerOpen] = useState(false);
  const contextMenuOpenRef = useRef(false);

  const openContextMenu = useCallback(() => {
    if (!bubbleRef.current || contextMenuOpenRef.current || isDeleted) return;
    contextMenuOpenRef.current = true;
    setIsContextMenuOpen(true);
  }, [isDeleted, bubbleRef]);

  const closeContextMenu = useCallback(() => {
    contextMenuOpenRef.current = false;
    setIsContextMenuOpen(false);
  }, []);

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
      // Desktop / web: open the same actions menu as a bubble click (no touch long-press state).
      // If a touch long-press just ran, skip — iOS can emit a synthetic contextmenu and we must
      // not open the menu twice (same as longPress.onContextMenu duplicate guard).
      if (!isAndroid && !isSelecting && !longPress.longPressTriggered.current) {
        openContextMenu();
        return;
      }
      longPress.onContextMenu(e);
    },
    [isAndroid, longPress, isDeleted, isSelecting, openContextMenu]
  );

  // Context menu items — depend on stable scalars, not the full message object
  const contextMenuItems = useMemo<MessageContextMenuItem[]>(() => {
    const items: MessageContextMenuItem[] = [];
    if (onReplyTo && !isDeleted) {
      items.push({
        label: t('message_item.reply'),
        icon: createElement(CornerUpLeft, { className: 'w-4 h-4' }),
        onClick: () => onReplyTo(message),
      });
    }
    if (onForward && !isDeleted) {
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
    if (onEdit && isOutgoing && !isDeleted && message.id != null) {
      items.push({
        label: t('message_item.edit'),
        icon: createElement(CornerUpLeft, { className: 'w-4 h-4' }),
        onClick: () => onEdit(message),
      });
    }
    if (onDelete && isOutgoing && !isDeleted && message.id != null) {
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
    isEmojiPickerOpen,
    setIsEmojiPickerOpen,
    openContextMenu,
    closeContextMenu,
    contextMenuItems,
    handleContextMenu,
  };
}
