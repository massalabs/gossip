import React, {
  useState,
  useEffect,
  useRef,
  useMemo,
  useCallback,
} from 'react';
import {
  CornerUpLeft,
  Share,
  Copy,
  ChevronDown,
  Check as CheckIcon,
  AlertTriangle,
  Trash2,
} from 'react-feather';
import { useLongPress } from '../../hooks/useLongPress';
import MessageContextMenu from '../ui/MessageContextMenu';
import type { MessageContextMenuItem } from '../ui/MessageContextMenu';
import { formatTime } from '../../utils/timeUtils';
import {
  Message,
  MessageStatus,
  MessageDirection,
  MessageType,
  encodeUserId,
} from '@massalabs/gossip-sdk';
import { useGossipSdk } from '../../hooks/useGossipSdk';
import { parseLinks, openUrl } from '../../utils/linkUtils';
import { useMarkMessageAsRead } from '../../hooks/useMarkMessageAsRead';
import { getKeyboardHeight } from '../../hooks/useKeyboardVisible';
import { Capacitor } from '@capacitor/core';
import ContactAvatar from '../avatar/ContactAvatar';
import type { Contact } from '@massalabs/gossip-sdk';

// Swipe gesture constants - base values for incoming messages
const SWIPE_MAX_DISTANCE = 80;
const SWIPE_RESISTANCE = 0.5;
const SWIPE_THRESHOLD = 40;
const SWIPE_INDICATOR_THRESHOLD = 8;
const SWIPE_INDICATOR_MAX_WIDTH = 60;

// Swipe gesture constants - more sensitive for outgoing (right-aligned) messages
const SWIPE_MAX_DISTANCE_OUTGOING = 90;
const SWIPE_RESISTANCE_OUTGOING = 0.65;
const SWIPE_THRESHOLD_OUTGOING = 30;
const SWIPE_INDICATOR_THRESHOLD_OUTGOING = 6;

// Touch slop - prevents unintentional triggers when scrolling
const TOUCH_SLOP = 15;
const TOUCH_SLOP_OUTGOING = 12;

interface MessageItemProps {
  message: Message;
  onReplyTo?: (message: Message) => void;
  onScrollToMessage?: (messageId: number) => void;
  onForward?: (message: Message) => void;
  onDelete?: (message: Message) => void;
  onEdit?: (message: Message) => void;
  id?: string;
  showTimestamp?: boolean;
  isFirstInGroup?: boolean;
  isLastInGroup?: boolean;
  showAvatar?: boolean;
  contact?: Pick<Contact, 'name' | 'avatar'>;
  isHighlighted?: boolean;
}

const MessageItem: React.FC<MessageItemProps> = ({
  message,
  onReplyTo,
  onScrollToMessage,
  onForward,
  onDelete,
  onEdit,
  id,
  showTimestamp = true,
  isFirstInGroup = true,
  isLastInGroup = true,
  showAvatar = false,
  contact,
  isHighlighted = false,
}) => {
  const sdk = useGossipSdk();
  const canReply = !!onReplyTo;
  const canForward = !!onForward;
  const isOutgoing = message.direction === MessageDirection.OUTGOING;
  const isDeleted = message.type === MessageType.DELETED;
  const isEdited =
    !!message.metadata &&
    (message.metadata as { edited?: boolean }).edited === true;
  const [originalMessage, setOriginalMessage] = useState<Message | null>(null);
  const [isLoadingOriginal, setIsLoadingOriginal] = useState(false);
  const [originalNotFound, setOriginalNotFound] = useState(false);

  // Swipe gesture state
  const [swipeOffset, setSwipeOffset] = useState(0);
  const swipeOffsetRef = useRef(0);
  const [isAnimatingBack, setIsAnimatingBack] = useState(false);
  const animTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const touchStartX = useRef<number | null>(null);
  const touchStartY = useRef<number | null>(null);
  const isSwiping = useRef(false);
  const swipeCompleted = useRef(false);
  // Handle automatic message read marking
  const markAsReadRef = useMarkMessageAsRead(message);
  const bubbleRef = useRef<HTMLDivElement>(null);
  const combinedBubbleRef = useCallback(
    (node: HTMLDivElement | null) => {
      bubbleRef.current = node;
      markAsReadRef.current = node;
    },
    [markAsReadRef]
  );
  const touchSlopExceeded = useRef(false);
  const hasTriggeredHaptic = useRef(false);

  // Context menu state
  const [isContextMenuOpen, setIsContextMenuOpen] = useState(false);
  const [contextMenuTranslateX, setContextMenuTranslateX] = useState(0);
  const [contextMenuTranslateY, setContextMenuTranslateY] = useState(0);
  const [menuPosition, setMenuPosition] = useState<{
    top: number;
    left?: number;
    right?: number;
  } | null>(null);
  const [bubbleRect, setBubbleRect] = useState<{
    top: number;
    left: number;
    width: number;
    height: number;
    borderRadius?: string;
  } | null>(null);
  const [contextMenuPlacement, setContextMenuPlacement] = useState<
    'above' | 'below'
  >('below');
  const contextMenuOpenRef = useRef(false);
  // Snapshot the keyboard height at touchstart — on iOS the keyboard may start
  // dismissing during the 500ms long-press delay, zeroing the live value before
  // openContextMenu fires.
  const kbHeightSnapshotRef = useRef(0);

  const openContextMenu = useCallback(() => {
    if (!bubbleRef.current || contextMenuOpenRef.current) return;
    const rect = bubbleRef.current.getBoundingClientRect();
    const itemCount =
      (canReply && !isDeleted ? 1 : 0) +
        (canForward && !isDeleted ? 1 : 0) +
        (!isDeleted ? 1 : 0) +
        (onEdit && isOutgoing && !isDeleted && message.id != null ? 1 : 0) +
        (onDelete && isOutgoing && !isDeleted && message.id != null ? 1 : 0) ||
      1;
    const rowH = 48;
    const menuHeight = Math.max(itemCount * rowH, rowH);
    const gap = 8;
    const sab =
      parseFloat(
        getComputedStyle(document.documentElement).getPropertyValue('--sab')
      ) || 0;
    const pad = 16 + sab;
    const kbAdjust =
      Capacitor.getPlatform() === 'ios' ? kbHeightSnapshotRef.current : 0;
    const vh = Math.min(
      document.documentElement.clientHeight,
      window.visualViewport?.height ?? Infinity,
      window.innerHeight - kbAdjust
    );
    const viewportBottom = vh - pad;
    const tall = rect.height > vh * 0.5;

    const tx = isOutgoing ? -6 : 6;
    let ty = -6;
    let menuY: number;
    let placement: 'above' | 'below' = 'below';

    const placeBelow = rect.bottom + gap;
    const placeAbove = rect.top - gap - menuHeight;
    const fitsBelow = placeBelow + menuHeight <= viewportBottom;
    const fitsAbove = placeAbove >= pad;

    if (tall) {
      menuY = placeBelow;
      if (!fitsBelow) {
        if (fitsAbove) {
          menuY = placeAbove;
          placement = 'above';
        } else {
          menuY = Math.max(pad, viewportBottom - menuHeight);
        }
      }
    } else {
      if (fitsBelow) {
        menuY = placeBelow;
      } else if (fitsAbove) {
        menuY = placeAbove;
        placement = 'above';
      } else {
        menuY = Math.max(pad, viewportBottom - menuHeight);
        const overflow = placeBelow + menuHeight - viewportBottom;
        ty -= Math.min(overflow, Math.max(0, rect.bottom - pad - 80));
      }
      if (rect.top + ty < pad) ty = pad - rect.top;
    }

    setContextMenuPlacement(placement);
    setContextMenuTranslateX(tx);
    setContextMenuTranslateY(ty);
    setMenuPosition({
      top: menuY,
      ...(isOutgoing
        ? { right: window.innerWidth - rect.right }
        : { left: rect.left }),
    });
    // Read the actual computed border-radius so the spotlight hole matches exactly
    const computed = getComputedStyle(bubbleRef.current);
    setBubbleRect({
      top: rect.top + ty,
      left: rect.left + tx,
      width: rect.width,
      height: rect.height,
      borderRadius: `${computed.borderTopLeftRadius} ${computed.borderTopRightRadius} ${computed.borderBottomRightRadius} ${computed.borderBottomLeftRadius}`,
    });
    contextMenuOpenRef.current = true;
    setIsContextMenuOpen(true);
  }, [
    canReply,
    canForward,
    isOutgoing,
    isDeleted,
    onEdit,
    onDelete,
    message.id,
  ]);

  const closeContextMenu = useCallback(() => {
    contextMenuOpenRef.current = false;
    setIsContextMenuOpen(false);
    setContextMenuTranslateX(0);
    setContextMenuTranslateY(0);
    setMenuPosition(null);
    setBubbleRect(null);
    setContextMenuPlacement('below');
  }, []);

  // Close context menu if the list scrolls (e.g. desktop mouse wheel)
  useEffect(() => {
    if (!isContextMenuOpen) return;
    const scroller = bubbleRef.current?.closest('[data-virtuoso-scroller]');
    if (!scroller) return;
    const onScroll = () => closeContextMenu();
    scroller.addEventListener('scroll', onScroll, { passive: true });
    return () => scroller.removeEventListener('scroll', onScroll);
  }, [isContextMenuOpen, closeContextMenu]);

  // Text selection on long press
  const [isTextSelectable, setIsTextSelectable] = useState(false);
  const longPressPosRef = useRef<{ x: number; y: number } | null>(null);

  const enableTextSelection = useCallback(() => {
    if (!bubbleRef.current || contextMenuOpenRef.current) return;
    // Enable selection immediately so caretRangeFromPoint works
    bubbleRef.current.style.userSelect = 'text';
    (
      bubbleRef.current.style as unknown as Record<string, string>
    ).webkitUserSelect = 'text';
    setIsTextSelectable(true);

    // On Android, skip programmatic selection — the native contextmenu event
    // will fire right after and show selection handles ("picos") natively.
    if (Capacitor.getPlatform() === 'android') return;

    requestAnimationFrame(() => {
      const pos = longPressPosRef.current;
      if (!pos) return;
      const range = document.caretRangeFromPoint(pos.x, pos.y);
      if (!range) return;
      const sel = window.getSelection();
      if (!sel) return;
      sel.removeAllRanges();
      sel.addRange(range);
      try {
        sel.modify('move', 'backward', 'word');
        sel.modify('extend', 'forward', 'word');
      } catch {
        // modify not available — selection stays at caret
      }
    });
  }, []);

  const clearTextSelection = useCallback(() => {
    window.getSelection()?.removeAllRanges();
    setIsTextSelectable(false);
    if (bubbleRef.current) {
      bubbleRef.current.style.userSelect = '';
      (
        bubbleRef.current.style as unknown as Record<string, string>
      ).webkitUserSelect = '';
    }
  }, []);

  // Deselect when tapping outside the bubble
  useEffect(() => {
    if (!isTextSelectable) return;
    const handleOutsideTouch = (e: TouchEvent) => {
      if (bubbleRef.current && !bubbleRef.current.contains(e.target as Node)) {
        clearTextSelection();
      }
    };
    // Delay so the long-press touchend doesn't immediately clear
    const timer = setTimeout(() => {
      document.addEventListener('touchstart', handleOutsideTouch);
    }, 100);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('touchstart', handleOutsideTouch);
    };
  }, [isTextSelectable, clearTextSelection]);

  const isAndroid = Capacitor.getPlatform() === 'android';
  const longPress = useLongPress({
    onLongPress: enableTextSelection,
    // On Android, don't preventDefault on touchEnd — it interferes with native selection handles
    preventDefaultOnEnd: !isAndroid,
  });

  // On Android, let the native contextmenu event through when text selection
  // is active so the browser shows selection handles.
  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
      if (isAndroid && longPress.longPressTriggered.current) {
        // Don't prevent default — let native selection handles appear
        return;
      }
      longPress.onContextMenu(e);
    },
    [isAndroid, longPress]
  );
  // Suppress click after gestures (swipe / long-press / scroll)
  const suppressClickRef = useRef(false);

  // Context menu items — depend on stable scalars, not the full message object
  const contextMenuItems = useMemo<MessageContextMenuItem[]>(() => {
    const items: MessageContextMenuItem[] = [];
    if (onReplyTo && !isDeleted) {
      items.push({
        label: 'Reply',
        icon: <CornerUpLeft className="w-4 h-4" />,
        onClick: () => onReplyTo(message),
      });
    }
    if (onForward && !isDeleted) {
      items.push({
        label: 'Forward',
        icon: <Share className="w-4 h-4" />,
        onClick: () => onForward(message),
      });
    }
    if (!isDeleted) {
      items.push({
        label: 'Copy',
        icon: <Copy className="w-4 h-4" />,
        onClick: () => {
          navigator.clipboard.writeText(message.content).catch(() => {
            /* clipboard not available */
          });
        },
      });
    }
    if (onEdit && isOutgoing && !isDeleted && message.id != null) {
      items.push({
        label: 'Edit',
        icon: <CornerUpLeft className="w-4 h-4" />,
        onClick: () => onEdit(message),
      });
    }
    if (onDelete && isOutgoing && !isDeleted && message.id != null) {
      items.push({
        label: 'Delete',
        icon: <Trash2 className="w-4 h-4" />,
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

  // Clean up animation timer on unmount
  useEffect(() => {
    return () => {
      if (animTimerRef.current) clearTimeout(animTimerRef.current);
    };
  }, []);

  // Load original message if this is a reply or forward
  useEffect(() => {
    const citedMsgId = message.replyTo?.originalMsgId;
    const citedContactId = message.forwardOf?.originalContactId;
    let originalContactUserId = message.contactUserId;

    if (citedContactId && citedContactId.length === 32) {
      try {
        originalContactUserId = encodeUserId(citedContactId);
      } catch (error) {
        console.warn('Failed to encode cited contact ID', error);
      }
    }

    if (citedMsgId && sdk.isSessionOpen) {
      setIsLoadingOriginal(true);
      setOriginalNotFound(false);

      const findMessage = async () => {
        try {
          const msg = await sdk.messages.findMessageByMsgId(
            citedMsgId,
            message.ownerUserId,
            originalContactUserId
          );

          if (msg) {
            setOriginalMessage(msg);
            setOriginalNotFound(false);
          } else {
            setOriginalMessage(null);
            setOriginalNotFound(true);
          }
        } catch (e) {
          console.error('Error finding message by seeker:', e);
          setOriginalMessage(null);
          setOriginalNotFound(true);
        } finally {
          setIsLoadingOriginal(false);
        }
      };

      findMessage();
    } else if (message.replyTo || message.forwardOf) {
      setOriginalMessage(null);
      setOriginalNotFound(true);
      setIsLoadingOriginal(false);
    } else {
      setOriginalMessage(null);
      setOriginalNotFound(false);
      setIsLoadingOriginal(false);
    }
  }, [
    message.replyTo,
    message.forwardOf,
    message.ownerUserId,
    message.contactUserId,
    sdk,
  ]);

  const handleBubbleClick = useCallback(() => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    if (isTextSelectable) {
      clearTextSelection();
      return;
    }
    openContextMenu();
  }, [openContextMenu, isTextSelectable, clearTextSelection]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'F10' && e.shiftKey) {
        e.preventDefault();
        openContextMenu();
      }
    },
    [openContextMenu]
  );

  const handleTouchStart = useCallback(
    (e: React.TouchEvent) => {
      // Snapshot keyboard height before it can dismiss during long-press delay
      kbHeightSnapshotRef.current = getKeyboardHeight();
      const touch = e.touches[0];
      longPressPosRef.current = { x: touch.clientX, y: touch.clientY };
      longPress.onTouchStart(e);
      if (isTextSelectable || (!canReply && !canForward)) return;
      touchStartX.current = touch.clientX;
      touchStartY.current = touch.clientY;
      isSwiping.current = false;
      swipeCompleted.current = false;
      touchSlopExceeded.current = false;
      hasTriggeredHaptic.current = false;
      setIsAnimatingBack(false);
    },
    [isTextSelectable, canReply, canForward, longPress]
  );

  const handleTouchMove = useCallback(
    (e: React.TouchEvent) => {
      longPress.onTouchMove(e);
      if (!canReply && !canForward) return;
      if (touchStartX.current === null || touchStartY.current === null) return;

      const touch = e.touches[0];
      const deltaX = touch.clientX - touchStartX.current;
      const deltaY = touch.clientY - touchStartY.current;
      const distanceSquared = deltaX * deltaX + deltaY * deltaY;

      const touchSlop = isOutgoing ? TOUCH_SLOP_OUTGOING : TOUCH_SLOP;
      const touchSlopSquared = touchSlop * touchSlop;
      const isHorizontalSwipe = Math.abs(deltaX) > Math.abs(deltaY);

      if (!touchSlopExceeded.current) {
        if (distanceSquared >= touchSlopSquared && isHorizontalSwipe) {
          touchSlopExceeded.current = true;
        } else if (distanceSquared >= touchSlopSquared && !isHorizontalSwipe) {
          setSwipeOffset(0);
          return;
        } else {
          return;
        }
      }

      if (isHorizontalSwipe) {
        // Prevent iOS from scrolling the parent container during swipe
        e.preventDefault();
        isSwiping.current = true;
        const resistance = isOutgoing
          ? SWIPE_RESISTANCE_OUTGOING
          : SWIPE_RESISTANCE;
        const maxDistance = isOutgoing
          ? SWIPE_MAX_DISTANCE_OUTGOING
          : SWIPE_MAX_DISTANCE;
        const rawSwipe = deltaX * resistance;
        // Clamp to >= 0 (right-swipe only, no left-swipe)
        const clampedSwipe = Math.max(0, Math.min(rawSwipe, maxDistance));
        swipeOffsetRef.current = clampedSwipe;
        setSwipeOffset(clampedSwipe);

        // Trigger haptic when crossing the threshold
        const threshold = isOutgoing
          ? SWIPE_THRESHOLD_OUTGOING
          : SWIPE_THRESHOLD;
        if (clampedSwipe >= threshold && !hasTriggeredHaptic.current) {
          hasTriggeredHaptic.current = true;
        }
      } else if (Math.abs(deltaX) > 5 || Math.abs(deltaY) > 5) {
        setSwipeOffset(0);
      }
    },
    [canReply, canForward, isOutgoing, longPress]
  );

  const handleTouchEnd = useCallback(
    (e: React.TouchEvent) => {
      longPress.onTouchEnd(e);

      if (!canReply && !canForward) {
        setSwipeOffset(0);
        touchStartX.current = null;
        touchStartY.current = null;
        isSwiping.current = false;
        touchSlopExceeded.current = false;
        return;
      }

      // If long-press fired, suppress tap and reset
      if (longPress.longPressTriggered.current) {
        suppressClickRef.current = true;
        setIsAnimatingBack(true);
        swipeOffsetRef.current = 0;
        setSwipeOffset(0);
        touchStartX.current = null;
        touchStartY.current = null;
        isSwiping.current = false;
        touchSlopExceeded.current = false;
        hasTriggeredHaptic.current = false;
        if (animTimerRef.current) clearTimeout(animTimerRef.current);
        animTimerRef.current = setTimeout(() => setIsAnimatingBack(false), 300);
        return;
      }

      const threshold = isOutgoing ? SWIPE_THRESHOLD_OUTGOING : SWIPE_THRESHOLD;
      const isRightSwipeCompleted = swipeOffsetRef.current >= threshold;

      if (isRightSwipeCompleted && onReplyTo) {
        onReplyTo(message);
        swipeCompleted.current = true;
      }

      // Suppress tap after any swipe gesture
      if (touchSlopExceeded.current || isSwiping.current) {
        suppressClickRef.current = true;
      }

      // Animate back with spring effect
      setIsAnimatingBack(true);
      swipeOffsetRef.current = 0;
      setSwipeOffset(0);
      touchStartX.current = null;
      touchStartY.current = null;
      isSwiping.current = false;
      touchSlopExceeded.current = false;
      hasTriggeredHaptic.current = false;

      // Remove animation class after animation completes
      if (animTimerRef.current) clearTimeout(animTimerRef.current);
      animTimerRef.current = setTimeout(() => setIsAnimatingBack(false), 300);
    },
    [canReply, canForward, isOutgoing, onReplyTo, message, longPress]
  );

  const handleTouchCancel = useCallback(() => {
    longPress.onTouchCancel();
    setSwipeOffset(0);
    swipeOffsetRef.current = 0;
    touchStartX.current = null;
    touchStartY.current = null;
    isSwiping.current = false;
    touchSlopExceeded.current = false;
  }, [longPress]);

  const handleReplyContextClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      if (originalMessage?.id && onScrollToMessage) {
        onScrollToMessage(originalMessage.id);
      }
    },
    [originalMessage?.id, onScrollToMessage]
  );

  const handleReplyContextKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (
        (e.key === 'Enter' || e.key === ' ') &&
        originalMessage?.id &&
        onScrollToMessage
      ) {
        e.preventDefault();
        e.stopPropagation();
        onScrollToMessage(originalMessage.id);
      }
    },
    [originalMessage?.id, onScrollToMessage]
  );

  const handleLinkClick = useCallback(
    (e: React.MouseEvent<HTMLAnchorElement>) => {
      // Stop propagation to prevent double-click to reply from triggering
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
  const parsedLinks = useMemo(
    () => parseLinks(message.content),
    [message.content]
  );

  // Parse links in reply original content
  const replyOriginalContent = originalMessage?.content || '';
  const parsedReplyLinks = useMemo(
    () => parseLinks(replyOriginalContent),
    [replyOriginalContent]
  );

  // Parse links in forward original content
  const forwardOriginalContent =
    originalMessage?.content || message.forwardOf?.originalContent || '';
  const parsedForwardLinks = useMemo(
    () => parseLinks(forwardOriginalContent),
    [forwardOriginalContent]
  );

  // Calculate spacing based on grouping
  // Last message in group gets more margin to separate from next group
  const spacingClass = isLastInGroup ? 'mb-1' : 'mb-0.5';

  // Memoize border radius calculation
  const borderRadiusClass = useMemo(() => {
    if (isFirstInGroup && isLastInGroup) {
      return isOutgoing
        ? 'rounded-3xl rounded-br-md'
        : 'rounded-3xl rounded-bl-md';
    } else if (isFirstInGroup) {
      return isOutgoing
        ? 'rounded-t-3xl rounded-bl-3xl rounded-br-md'
        : 'rounded-t-3xl rounded-br-3xl rounded-bl-md';
    } else if (isLastInGroup) {
      return isOutgoing
        ? 'rounded-b-3xl rounded-tl-3xl rounded-tr-md'
        : 'rounded-b-3xl rounded-tl-md rounded-tr-3xl';
    } else {
      return isOutgoing
        ? 'rounded-tr-md rounded-br-md rounded-tl-3xl rounded-bl-3xl'
        : 'rounded-tr-3xl rounded-tl-md rounded-br-3xl rounded-bl-md';
    }
  }, [isFirstInGroup, isLastInGroup, isOutgoing]);

  const indicatorThreshold = isOutgoing
    ? SWIPE_INDICATOR_THRESHOLD_OUTGOING
    : SWIPE_INDICATOR_THRESHOLD;

  const canNavigateToForwarded =
    !!originalMessage?.id && typeof onScrollToMessage === 'function';

  return (
    <div
      id={id}
      className={`flex items-end gap-1 ${isOutgoing ? 'justify-end' : 'justify-start'} group relative ${spacingClass} ${isHighlighted ? 'search-highlight' : ''}`}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
      onTouchCancel={handleTouchCancel}
      onContextMenu={handleContextMenu}
      style={{ touchAction: 'manipulation' }}
      role="listitem"
      aria-label={`${isOutgoing ? 'Sent' : 'Received'} message`}
    >
      {/* Incoming avatar or spacer */}
      {!isOutgoing && contact && (
        <div className="w-8 shrink-0 ml-1">
          {showAvatar ? (
            <ContactAvatar contact={contact} size={8} />
          ) : (
            <div className="w-8 h-8" />
          )}
        </div>
      )}
      <div
        ref={combinedBubbleRef}
        className={`relative max-w-[80%] sm:max-w-[70%] md:max-w-[65%] lg:max-w-[60%] px-3.5 py-3 font-normal text-[15px] leading-tight animate-bubble-in ${isTextSelectable ? 'select-text' : 'select-none'} ${borderRadiusClass} ${
          isOutgoing
            ? 'ml-auto mr-3 bg-accent text-accent-foreground'
            : `${contact ? '' : 'ml-3'} mr-auto bg-surface-secondary text-card-foreground`
        } ${
          !isDeleted && canReply ? 'cursor-pointer focus:outline-none' : ''
        } ${isContextMenuOpen ? 'shadow-lg' : ''} ${
          isDeleted ? 'opacity-80' : ''
        }`}
        onClick={handleBubbleClick}
        onKeyDown={handleKeyDown}
        tabIndex={0}
        role="button"
        aria-label="Tap for actions"
        style={{
          transform: isContextMenuOpen
            ? `translate(${contextMenuTranslateX}px, ${contextMenuTranslateY}px)`
            : swipeOffset !== 0
              ? `translateX(${swipeOffset}px)`
              : 'translateX(0)',
          filter: isContextMenuOpen ? 'brightness(0.95)' : undefined,
          transition: isContextMenuOpen
            ? 'transform 0.4s cubic-bezier(0.16, 1, 0.3, 1), box-shadow 0.2s ease-out, border-radius 0.3s ease-out, filter 0.2s ease-out'
            : isAnimatingBack
              ? 'transform 0.3s cubic-bezier(0.34, 1.56, 0.64, 1)'
              : 'none',
        }}
      >
        {/* Reply indicator (right swipe) */}
        {swipeOffset > indicatorThreshold && canReply && (
          <div
            className={`absolute left-0 top-0 bottom-0 flex items-center justify-center ${
              isOutgoing ? 'bg-accent/20' : 'bg-card/20'
            } rounded-l-2xl`}
            style={{
              width: `${Math.min(swipeOffset, SWIPE_INDICATOR_MAX_WIDTH)}px`,
              opacity: Math.min(swipeOffset / SWIPE_INDICATOR_MAX_WIDTH, 1),
              transition: isAnimatingBack ? 'all 0.3s ease-out' : 'none',
            }}
            aria-hidden="true"
          >
            <CornerUpLeft
              className={`w-5 h-5 text-muted-foreground transition-transform ${
                swipeOffset >=
                (isOutgoing ? SWIPE_THRESHOLD_OUTGOING : SWIPE_THRESHOLD)
                  ? 'scale-110'
                  : 'scale-100'
              }`}
              aria-hidden="true"
            />
          </div>
        )}

        {/* Reply Context */}
        {message.replyTo && (
          <div
            className={`mb-2 pb-2 border-l-2 pl-2 ${
              isOutgoing
                ? 'border-accent-foreground/30'
                : 'border-card-foreground/30'
            } ${originalNotFound ? 'border-destructive/50' : ''} ${
              message.replyTo.originalMsgId && onScrollToMessage
                ? 'cursor-pointer hover:bg-black/5 dark:hover:bg-white/5 rounded-r transition-colors active:scale-[0.98] focus:outline-none'
                : ''
            }`}
            {...(message.replyTo.originalMsgId && onScrollToMessage
              ? {
                  onClick: handleReplyContextClick,
                  onKeyDown: handleReplyContextKeyDown,
                  tabIndex: 0,
                  role: 'button',
                  'aria-label': 'Tap to jump to original message',
                }
              : {})}
          >
            {originalNotFound && (
              <div className="flex items-center gap-1 mb-2">
                <span
                  className="inline-flex items-center gap-1"
                  title="Original message not found"
                >
                  <AlertTriangle
                    className="w-3.5 h-3.5 text-destructive shrink-0"
                    aria-hidden="true"
                  />
                  <span className="text-xs text-destructive md:hidden">
                    (Original not found)
                  </span>
                </span>
              </div>
            )}
            {isLoadingOriginal ? (
              <p
                className={`text-xs truncate ${
                  isOutgoing
                    ? 'text-accent-foreground/80'
                    : 'text-muted-foreground/80'
                }`}
              >
                &nbsp;
              </p>
            ) : (
              <p
                className={`text-xs truncate ${
                  isOutgoing
                    ? 'text-accent-foreground/80'
                    : 'text-muted-foreground/80'
                } ${originalNotFound ? 'italic opacity-70' : ''}`}
              >
                {parsedReplyLinks.length > 0
                  ? parsedReplyLinks.map((segment, index) => {
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
                    })
                  : originalMessage?.content || 'Original message'}
              </p>
            )}
          </div>
        )}

        {/* Forwarded Context */}
        {message.forwardOf && (
          <div
            className={`mb-2 pb-2 border-l-2 pl-2 ${
              isOutgoing
                ? 'border-accent-foreground/30'
                : 'border-card-foreground/30'
            } ${
              canNavigateToForwarded
                ? 'cursor-pointer hover:bg-black/5 dark:hover:bg-white/5 rounded-r transition-colors active:scale-[0.98] focus:outline-none'
                : ''
            }`}
            {...(canNavigateToForwarded
              ? {
                  onClick: handleReplyContextClick,
                  onKeyDown: handleReplyContextKeyDown,
                  tabIndex: 0,
                  role: 'button',
                  'aria-label': 'Tap to jump to original message',
                }
              : {})}
          >
            {isLoadingOriginal ? (
              <>
                <p
                  className={`text-[11px] font-medium mb-0.5 ${
                    isOutgoing
                      ? 'text-accent-foreground/80'
                      : 'text-muted-foreground/80'
                  }`}
                >
                  &nbsp;
                </p>
                <p
                  className={`text-xs truncate ${
                    isOutgoing
                      ? 'text-accent-foreground/80'
                      : 'text-muted-foreground/80'
                  }`}
                >
                  &nbsp;
                </p>
              </>
            ) : (
              <>
                <p
                  className={`text-[11px] font-medium mb-0.5 ${
                    isOutgoing
                      ? 'text-accent-foreground/80'
                      : 'text-muted-foreground/80'
                  }`}
                >
                  Forwarded message:
                </p>
                <p
                  className={`text-xs truncate ${
                    isOutgoing
                      ? 'text-accent-foreground/80'
                      : 'text-muted-foreground/80'
                  }`}
                >
                  {parsedForwardLinks.length > 0
                    ? parsedForwardLinks.map((segment, index) => {
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
                      })
                    : originalMessage?.content ||
                      message.forwardOf.originalContent ||
                      'Original message'}
                </p>
              </>
            )}
          </div>
        )}

        {/* Message Content */}
        {isDeleted ? (
          <p className="whitespace-pre-wrap wrap-break-word pr-6 italic text-muted-foreground text-[13px]">
            Message deleted
          </p>
        ) : (
          <p className="whitespace-pre-wrap wrap-break-word pr-6">
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
        )}

        {/* Timestamp, Edited Label and Status — incoming "edited" must show even when
            showTimestamp is false (grouped bubble); otherwise receivers never see it. */}
        {(showTimestamp || isOutgoing || isEdited) && (
          <div
            className={`flex items-center justify-end gap-1.5 mt-1.5 ${
              isOutgoing ? 'text-accent-foreground/80' : 'text-muted-foreground'
            }`}
          >
            {showTimestamp && (
              <span className="text-[11px] font-medium">
                {formatTime(message.timestamp)}
              </span>
            )}
            {isEdited && (
              <span className="text-[10px] italic opacity-75 ml-1">edited</span>
            )}
            {isOutgoing && (
              <div
                className="flex items-center gap-1"
                aria-label={`Status: ${message.status}`}
              >
                {(message.status === MessageStatus.WAITING_SESSION ||
                  message.status === MessageStatus.READY) && (
                  <div className="flex items-center gap-1">
                    <div
                      className="w-2.5 h-2.5 border border-current border-t-transparent rounded-full animate-spin"
                      aria-hidden="true"
                    />
                    <span className="text-[10px] font-medium">Sending</span>
                  </div>
                )}
                {message.status === MessageStatus.SENT && (
                  <CheckIcon className="w-3.5 h-3.5" aria-label="Sent" />
                )}
                {(message.status === MessageStatus.DELIVERED ||
                  message.status === MessageStatus.READ) && (
                  <div
                    className="relative inline-flex items-center w-4 h-3.5"
                    aria-label="Delivered"
                  >
                    <CheckIcon className="w-3.5 h-3.5 absolute left-0" />
                    <CheckIcon className="w-3.5 h-3.5 absolute left-[5px] top-[1.5px]" />
                  </div>
                )}
              </div>
            )}
          </div>
        )}
        {/* Hover arrow for desktop context menu */}
        <button
          type="button"
          onClick={e => {
            e.stopPropagation();
            openContextMenu();
          }}
          className="absolute top-1.5 right-2 p-0.5 opacity-0 group-hover:opacity-100 transition-opacity hidden md:flex items-center justify-center"
          aria-label="Message actions"
        >
          <ChevronDown className="w-3.5 h-3.5 text-muted-foreground" />
        </button>
      </div>

      <MessageContextMenu
        items={contextMenuItems}
        isOpen={isContextMenuOpen}
        onClose={closeContextMenu}
        isOutgoing={isOutgoing}
        position={menuPosition}
        placement={contextMenuPlacement}
        translateY={contextMenuTranslateY}
        bubbleRect={bubbleRect}
      />
    </div>
  );
};

export default MessageItem;
