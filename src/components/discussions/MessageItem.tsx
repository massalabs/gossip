import React, {
  useState,
  useEffect,
  useRef,
  useMemo,
  useCallback,
} from 'react';
import {
  ArrowRightCircle,
  Check as CheckIcon,
  AlertTriangle,
} from 'react-feather';
import { Message, MessageDirection, MessageStatus } from '../../db';
import { formatTime } from '../../utils/timeUtils';
import { messageService } from '../../services/message';

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
  id?: string;
  showTimestamp?: boolean;
  isFirstInGroup?: boolean;
  isLastInGroup?: boolean;
}

const MessageItem: React.FC<MessageItemProps> = ({
  message,
  onReplyTo,
  onScrollToMessage,
  id,
  showTimestamp = true,
  isFirstInGroup = true,
  isLastInGroup = true,
}) => {
  const canReply = !!onReplyTo;
  const isOutgoing = message.direction === MessageDirection.OUTGOING;
  const [originalMessage, setOriginalMessage] = useState<Message | null>(null);
  const [isLoadingOriginal, setIsLoadingOriginal] = useState(false);
  const [originalNotFound, setOriginalNotFound] = useState(false);

  // Swipe gesture state
  const [swipeOffset, setSwipeOffset] = useState(0);
  const [isAnimatingBack, setIsAnimatingBack] = useState(false);
  const touchStartX = useRef<number | null>(null);
  const touchStartY = useRef<number | null>(null);
  const isSwiping = useRef(false);
  const swipeCompleted = useRef(false);
  const messageRef = useRef<HTMLDivElement | null>(null);
  const touchSlopExceeded = useRef(false);
  const hasTriggeredHaptic = useRef(false);

  // Load original message if this is a reply
  useEffect(() => {
    if (message.replyTo?.originalSeeker) {
      setIsLoadingOriginal(true);
      setOriginalNotFound(false);

      const findMessage = async () => {
        try {
          const msg = await messageService.findMessageBySeeker(
            message.replyTo!.originalSeeker!,
            message.ownerUserId
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
    } else if (message.replyTo?.originalContent) {
      setOriginalMessage(null);
      setOriginalNotFound(true);
      setIsLoadingOriginal(false);
    } else {
      setOriginalMessage(null);
      setOriginalNotFound(false);
      setIsLoadingOriginal(false);
    }
  }, [message.replyTo, message.ownerUserId]);

  const handleDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      if (canReply && onReplyTo) {
        onReplyTo(message);
      }
    },
    [canReply, onReplyTo, message]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if ((e.key === 'Enter' || e.key === ' ') && canReply && onReplyTo) {
        e.preventDefault();
        onReplyTo(message);
      }
    },
    [canReply, onReplyTo, message]
  );

  const handleTouchStart = useCallback(
    (e: React.TouchEvent) => {
      if (!canReply) return;
      const touch = e.touches[0];
      touchStartX.current = touch.clientX;
      touchStartY.current = touch.clientY;
      isSwiping.current = false;
      swipeCompleted.current = false;
      touchSlopExceeded.current = false;
      hasTriggeredHaptic.current = false;
      setIsAnimatingBack(false);
    },
    [canReply]
  );

  const handleTouchMove = useCallback(
    (e: React.TouchEvent) => {
      if (!canReply) return;
      if (touchStartX.current === null || touchStartY.current === null) return;

      const touch = e.touches[0];
      const deltaX = touch.clientX - touchStartX.current;
      const deltaY = touch.clientY - touchStartY.current;
      const distanceSquared = deltaX * deltaX + deltaY * deltaY;

      const touchSlop = isOutgoing ? TOUCH_SLOP_OUTGOING : TOUCH_SLOP;
      const touchSlopSquared = touchSlop * touchSlop;
      const isHorizontalSwipe =
        Math.abs(deltaX) > Math.abs(deltaY) && deltaX > 0;

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
        isSwiping.current = true;
        const resistance = isOutgoing
          ? SWIPE_RESISTANCE_OUTGOING
          : SWIPE_RESISTANCE;
        const maxDistance = isOutgoing
          ? SWIPE_MAX_DISTANCE_OUTGOING
          : SWIPE_MAX_DISTANCE;
        const swipe = Math.min(deltaX * resistance, maxDistance);
        setSwipeOffset(swipe);

        // Trigger haptic when crossing the threshold
        const threshold = isOutgoing
          ? SWIPE_THRESHOLD_OUTGOING
          : SWIPE_THRESHOLD;
        if (swipe >= threshold && !hasTriggeredHaptic.current) {
          hasTriggeredHaptic.current = true;
        }
      } else if (Math.abs(deltaX) > 5 || Math.abs(deltaY) > 5) {
        setSwipeOffset(0);
      }
    },
    [canReply, isOutgoing]
  );

  const handleTouchEnd = useCallback(() => {
    if (!canReply) {
      setSwipeOffset(0);
      touchStartX.current = null;
      touchStartY.current = null;
      isSwiping.current = false;
      touchSlopExceeded.current = false;
      return;
    }

    const threshold = isOutgoing ? SWIPE_THRESHOLD_OUTGOING : SWIPE_THRESHOLD;
    const wasSwipeCompleted = swipeOffset >= threshold;

    if (wasSwipeCompleted && onReplyTo) {
      onReplyTo(message);
      swipeCompleted.current = true;
    }

    // Animate back with spring effect
    setIsAnimatingBack(true);
    setSwipeOffset(0);
    touchStartX.current = null;
    touchStartY.current = null;
    isSwiping.current = false;
    touchSlopExceeded.current = false;
    hasTriggeredHaptic.current = false;

    // Remove animation class after animation completes
    setTimeout(() => setIsAnimatingBack(false), 300);
  }, [canReply, isOutgoing, swipeOffset, onReplyTo, message]);

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

  const handleClick = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
  }, []);

  // Calculate spacing based on grouping
  // Last message in group gets more margin to separate from next group
  const spacingClass = isLastInGroup ? 'mb-1' : 'mb-0.5';

  // Memoize border radius calculation
  const borderRadiusClass = useMemo(() => {
    if (isFirstInGroup && isLastInGroup) {
      return isOutgoing
        ? 'rounded-3xl rounded-br-lg'
        : 'rounded-3xl rounded-bl-lg';
    } else if (isFirstInGroup) {
      return isOutgoing
        ? 'rounded-t-3xl rounded-bl-3xl rounded-br-lg'
        : 'rounded-t-3xl rounded-br-3xl rounded-bl-lg';
    } else if (isLastInGroup) {
      return isOutgoing
        ? 'rounded-b-3xl rounded-tl-3xl rounded-tr-lg'
        : 'rounded-b-3xl rounded-tl-lg rounded-tr-3xl';
    } else {
      return isOutgoing
        ? 'rounded-tr-lg rounded-br-lg rounded-tl-3xl rounded-bl-3xl'
        : 'rounded-tr-3xl rounded-tl-lg rounded-br-3xl rounded-bl-lg';
    }
  }, [isFirstInGroup, isLastInGroup, isOutgoing]);

  const indicatorThreshold = isOutgoing
    ? SWIPE_INDICATOR_THRESHOLD_OUTGOING
    : SWIPE_INDICATOR_THRESHOLD;

  return (
    <div
      id={id}
      className={`flex items-end gap-2 ${isOutgoing ? 'justify-end' : 'justify-start'} group relative ${spacingClass}`}
      onTouchStart={canReply ? handleTouchStart : undefined}
      onTouchMove={canReply ? handleTouchMove : undefined}
      onTouchEnd={canReply ? handleTouchEnd : undefined}
      role="listitem"
      aria-label={`${isOutgoing ? 'Sent' : 'Received'} message`}
    >
      <div
        ref={messageRef}
        className={`relative max-w-[78%] sm:max-w-[70%] md:max-w-[65%] lg:max-w-[60%] px-4 py-4 font-medium text-[15px] leading-tight animate-bubble-in ${borderRadiusClass} ${
          isOutgoing
            ? 'ml-auto mr-3 bg-accent text-accent-foreground'
            : 'ml-3 mr-auto bg-card dark:bg-surface-secondary text-card-foreground shadow-sm'
        } ${
          canReply
            ? 'cursor-pointer hover:opacity-90 transition-opacity focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2'
            : ''
        }`}
        onDoubleClick={handleDoubleClick}
        onMouseDown={handleClick}
        onKeyDown={handleKeyDown}
        tabIndex={canReply ? 0 : undefined}
        role={canReply ? 'button' : undefined}
        aria-label={canReply ? 'Double-tap to reply' : undefined}
        style={{
          transform:
            swipeOffset > 0 ? `translateX(${swipeOffset}px)` : 'translateX(0)',
          transition: isAnimatingBack
            ? 'transform 0.3s cubic-bezier(0.34, 1.56, 0.64, 1)'
            : 'none',
        }}
      >
        {/* Reply indicator that appears when swiping */}
        {swipeOffset > indicatorThreshold && (
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
            <ArrowRightCircle
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
              message.replyTo.originalSeeker && onScrollToMessage
                ? 'cursor-pointer hover:bg-black/5 dark:hover:bg-white/5 rounded-r transition-colors active:scale-[0.98] focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2'
                : ''
            }`}
            {...(message.replyTo.originalSeeker && onScrollToMessage
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
                className={`text-xs ${
                  isOutgoing
                    ? 'text-accent-foreground/80'
                    : 'text-muted-foreground/80'
                }`}
              >
                Loading...
              </p>
            ) : (
              <p
                className={`text-xs truncate ${
                  isOutgoing
                    ? 'text-accent-foreground/80'
                    : 'text-muted-foreground/80'
                } ${originalNotFound ? 'italic opacity-70' : ''}`}
              >
                {originalMessage?.content ||
                  message.replyTo.originalContent ||
                  'Original message'}
              </p>
            )}
          </div>
        )}

        {/* Message Content */}
        <p className="whitespace-pre-wrap wrap-break-word pr-6">
          {message.content}
        </p>

        {/* Timestamp and Status */}
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
          {isOutgoing && (
            <div
              className="flex items-center gap-1"
              aria-label={`Status: ${message.status}`}
            >
              {(message.status === MessageStatus.SENDING ||
                message.status === MessageStatus.FAILED) && (
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
                <CheckIcon className="w-3.5 h-3.5" aria-label="Delivered" />
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default MessageItem;
