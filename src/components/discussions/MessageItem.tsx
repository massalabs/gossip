import React, { useState, useEffect, useRef } from 'react';
import {
  ArrowRightCircle,
  Check as CheckIcon,
  AlertTriangle,
  XCircle,
} from 'react-feather';
import { Message, MessageDirection, MessageStatus } from '../../db';
import { formatTime } from '../../utils/timeUtils';
import { messageService } from '../../services/message';

// Swipe gesture constants
const SWIPE_MAX_DISTANCE = 80; // Maximum distance (in pixels) the message can be swiped
const SWIPE_RESISTANCE = 0.3; // Resistance factor applied to swipe distance for smoother feel
const SWIPE_THRESHOLD = 50; // Minimum swipe distance (in pixels) required to trigger reply action
const SWIPE_INDICATOR_THRESHOLD = 10; // Minimum swipe distance before showing reply indicator
const SWIPE_INDICATOR_MAX_WIDTH = 60; // Maximum width (in pixels) for the reply indicator

interface MessageItemProps {
  message: Message;
  onReplyTo?: (message: Message) => void;
  onScrollToMessage?: (messageId: number) => void;
  onResend?: (message: Message) => void;
  id?: string;
}

const MessageItem: React.FC<MessageItemProps> = ({
  message,
  onReplyTo,
  onScrollToMessage,
  onResend,
  id,
}) => {
  const canReply = !!onReplyTo;
  const isOutgoing = message.direction === MessageDirection.OUTGOING;
  const [originalMessage, setOriginalMessage] = useState<Message | null>(null);
  const [isLoadingOriginal, setIsLoadingOriginal] = useState(false);
  const [originalNotFound, setOriginalNotFound] = useState(false);

  // Swipe gesture state
  const [swipeOffset, setSwipeOffset] = useState(0);
  const touchStartX = useRef<number | null>(null);
  const touchStartY = useRef<number | null>(null);
  const isSwiping = useRef(false);
  const swipeCompleted = useRef(false); // Track if a swipe was just completed to prevent click
  const messageRef = useRef<HTMLDivElement | null>(null);

  // Load original message if this is a reply
  useEffect(() => {
    if (message.replyTo?.originalSeeker) {
      setIsLoadingOriginal(true);
      setOriginalNotFound(false);

      // Find message by seeker using message service
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
      // If we have originalContent but no seeker, the original message is not found
      setOriginalMessage(null);
      setOriginalNotFound(true);
      setIsLoadingOriginal(false);
    } else {
      setOriginalMessage(null);
      setOriginalNotFound(false);
      setIsLoadingOriginal(false);
    }
  }, [message.replyTo, message.ownerUserId]);

  const handleDoubleClick = (e: React.MouseEvent) => {
    e.preventDefault();
    if (canReply && onReplyTo) {
      onReplyTo(message);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // Support Enter and Space keys for keyboard accessibility
    if ((e.key === 'Enter' || e.key === ' ') && canReply && onReplyTo) {
      e.preventDefault(); // Prevent page scroll on Space
      onReplyTo(message);
    }
  };

  const handleTouchStart = (e: React.TouchEvent) => {
    if (!canReply) return;
    const touch = e.touches[0];
    touchStartX.current = touch.clientX;
    touchStartY.current = touch.clientY;
    isSwiping.current = false;
    swipeCompleted.current = false; // Reset on new touch start
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    if (!canReply) return;
    if (touchStartX.current === null || touchStartY.current === null) return;

    const touch = e.touches[0];
    const deltaX = touch.clientX - touchStartX.current;
    const deltaY = touch.clientY - touchStartY.current;

    // Only allow horizontal swipe (right direction) for all messages
    // Check if horizontal movement is greater than vertical (to avoid triggering on scroll)
    if (Math.abs(deltaX) > Math.abs(deltaY) && deltaX > 0) {
      isSwiping.current = true;
      // Limit swipe distance and add resistance
      const swipe = Math.min(deltaX * SWIPE_RESISTANCE, SWIPE_MAX_DISTANCE);
      setSwipeOffset(swipe);
    } else if (Math.abs(deltaX) > 5 || Math.abs(deltaY) > 5) {
      // Reset offset if user is swiping in wrong direction (left or vertically)
      setSwipeOffset(0);
    }
  };

  const handleTouchEnd = () => {
    if (!canReply) {
      setSwipeOffset(0);
      touchStartX.current = null;
      touchStartY.current = null;
      isSwiping.current = false;
      return;
    }
    // Track if a swipe was completed to prevent click handler from triggering
    const wasSwipeCompleted = swipeOffset >= SWIPE_THRESHOLD;

    if (wasSwipeCompleted && onReplyTo) {
      // Trigger reply action
      onReplyTo(message);
      swipeCompleted.current = true;
    }

    // Reset swipe state immediately
    setSwipeOffset(0);
    touchStartX.current = null;
    touchStartY.current = null;
    isSwiping.current = false;
  };

  const handleReplyContextClick = (e: React.MouseEvent) => {
    e.stopPropagation(); // Prevent triggering the message click
    if (originalMessage?.id && onScrollToMessage) {
      onScrollToMessage(originalMessage.id);
    }
  };

  const handleReplyContextKeyDown = (e: React.KeyboardEvent) => {
    // Support Enter and Space keys for keyboard accessibility
    if (
      (e.key === 'Enter' || e.key === ' ') &&
      originalMessage?.id &&
      onScrollToMessage
    ) {
      e.preventDefault(); // Prevent page scroll on Space
      e.stopPropagation(); // Prevent triggering the message click
      onScrollToMessage(originalMessage.id);
    }
  };

  const handleClick = (e: React.MouseEvent) => {
    e.preventDefault();
  };

  return (
    <div
      id={id}
      className={`flex items-end gap-2 ${isOutgoing ? 'justify-end' : 'justify-start'} group relative`}
      onTouchStart={canReply ? handleTouchStart : undefined}
      onTouchMove={canReply ? handleTouchMove : undefined}
      onTouchEnd={canReply ? handleTouchEnd : undefined}
    >
      {/* TODO: Add on group chat */}
      {/* {!isOutgoing && (
          <div className="w-6 h-8 shrink-0 mb-1 opacity-0 opacity-100 transition-opacity">
            {showAvatar && <ContactAvatar contact={contact} size={8} />}
          </div>
        )} */}
      <div
        ref={messageRef}
        className={`relative max-w-[78%] sm:max-w-[70%] md:max-w-[65%] lg:max-w-[60%] px-4 py-4 rounded-3xl font-medium text-[15px] leading-tight animate-bubble-in transition-transform ${
          isOutgoing
            ? 'ml-auto mr-3 bg-accent dark:text-accent-foreground text-white rounded-br-[4px]'
            : 'ml-3 mr-auto bg-card dark:bg-surface-secondary text-card-foreground rounded-bl-[4px] shadow-sm'
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
        aria-label={canReply ? 'Reply to message' : undefined}
        style={{
          transform:
            swipeOffset > 0 ? `translateX(${swipeOffset}px)` : 'translateX(0)',
        }}
      >
        {/* Reply indicator that appears when swiping */}
        {swipeOffset > SWIPE_INDICATOR_THRESHOLD && (
          <div
            className={`absolute left-0 top-0 bottom-0 flex items-center justify-center ${
              isOutgoing ? 'bg-accent/20' : 'bg-card/20'
            } rounded-l-2xl transition-opacity`}
            style={{
              width: `${Math.min(swipeOffset, SWIPE_INDICATOR_MAX_WIDTH)}px`,
              opacity: Math.min(swipeOffset / SWIPE_INDICATOR_MAX_WIDTH, 1),
            }}
            aria-label="Swipe to reply indicator"
          >
            <ArrowRightCircle
              className="w-5 h-5 text-muted-foreground"
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
                ? 'cursor-pointer hover:bg-black/5 dark:hover:bg-white/5 rounded-r transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2'
                : ''
            }`}
            {...(message.replyTo.originalSeeker && onScrollToMessage
              ? {
                  onClick: handleReplyContextClick,
                  onKeyDown: handleReplyContextKeyDown,
                  tabIndex: 0,
                  role: 'button',
                  'aria-label': 'Jump to original message',
                }
              : {})}
          >
            {originalNotFound && (
              <div className="flex items-center gap-1 mb-2">
                <span
                  className="inline-flex items-center gap-1"
                  title="Original message not found in database"
                >
                  <AlertTriangle
                    className="w-3.5 h-3.5 text-destructive shrink-0"
                    aria-hidden="true"
                  />
                  {/* Show text on mobile, tooltip on desktop */}
                  <span className="text-xs text-destructive md:hidden">
                    (Original message not found)
                  </span>
                </span>
              </div>
            )}
            {isLoadingOriginal ? (
              <p
                className={`text-xs ${
                  isOutgoing
                    ? 'dark:text-accent-foreground/60 text-white/80'
                    : 'text-muted-foreground/80'
                }`}
              >
                Loading...
              </p>
            ) : (
              <p
                className={`text-xs truncate ${
                  isOutgoing
                    ? 'dark:text-accent-foreground/60 text-white/80'
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

        {/* Message */}
        <p className="whitespace-pre-wrap wrap-break-word pr-6">
          {message.content}
        </p>

        {/* Timestamp and Status */}
        <div
          className={`flex items-center justify-end gap-1.5 mt-1.5 ${
            isOutgoing
              ? 'dark:text-accent-foreground/80 text-white/90'
              : 'text-muted-foreground'
          }`}
        >
          <span className="text-[11px] font-medium">
            {formatTime(message.timestamp)}
          </span>
          {isOutgoing && (
            <div className="flex items-center gap-1">
              {message.status === MessageStatus.SENDING && (
                <div className="flex items-center gap-1">
                  <div className="w-2.5 h-2.5 border border-current border-t-transparent rounded-full animate-spin"></div>
                  <span className="text-[10px] font-medium">Sending</span>
                </div>
              )}
              {message.status === MessageStatus.SENT && (
                <CheckIcon className="w-3.5 h-3.5" />
              )}
              {message.status === MessageStatus.FAILED && (
                <div className="flex items-center gap-1.5">
                  <XCircle className="w-3.5 h-3.5 dark:text-accent-foreground/90 text-white/90" />
                  <span className="text-[10px] font-medium">Failed</span>
                  {onResend && (
                    <button
                      onClick={() => onResend(message)}
                      onKeyDown={e => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          onResend(message);
                        }
                      }}
                      className="ml-1 px-1.5 py-0.5 text-[10px] font-medium bg-accent-foreground/20 hover:bg-accent-foreground/30 rounded transition-colors dark:text-accent-foreground text-white focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-1"
                      title="Resend message"
                      aria-label="Resend message"
                    >
                      Resend
                    </button>
                  )}
                </div>
              )}
              {(message.status === MessageStatus.DELIVERED ||
                message.status === MessageStatus.READ) && (
                <CheckIcon className="w-3.5 h-3.5" />
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default MessageItem;
