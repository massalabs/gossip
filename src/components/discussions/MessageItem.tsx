import React, { useState, useEffect, useRef } from 'react';
import { Message } from '../../db';
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
  onResend: (message: Message) => void;
  onReplyTo?: (message: Message) => void;
  onScrollToMessage?: (messageId: number) => void;
  id?: string;
}

const MessageItem: React.FC<MessageItemProps> = ({
  message,
  onResend,
  onReplyTo,
  onScrollToMessage,
  id,
}) => {
  const isOutgoing = message.direction === 'outgoing';
  const [originalMessage, setOriginalMessage] = useState<Message | null>(null);
  const [isLoadingOriginal, setIsLoadingOriginal] = useState(false);
  const [originalNotFound, setOriginalNotFound] = useState(false);

  // Swipe gesture state
  const [swipeOffset, setSwipeOffset] = useState(0);
  const touchStartX = useRef<number | null>(null);
  const touchStartY = useRef<number | null>(null);
  const isSwiping = useRef(false);
  const swipeCompleted = useRef(false); // Track if a swipe was just completed to prevent click
  const isFocused = useRef(false); // Track if the element is currently focused
  const wasFocusedBeforeClick = useRef(false); // Track if element was focused before click
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

  const handleMouseDown = () => {
    // Capture focus state before click event fires
    wasFocusedBeforeClick.current = isFocused.current;
  };

  const handleClick = () => {
    // Only trigger on click if:
    // 1. A swipe was not just completed
    // 2. The element was already focused before the click (to allow focusing without triggering reply)
    if (!swipeCompleted.current && wasFocusedBeforeClick.current && onReplyTo) {
      onReplyTo(message);
    }
    // Reset swipe completed flag after checking
    swipeCompleted.current = false;
  };

  const handleFocus = () => {
    isFocused.current = true;
  };

  const handleBlur = () => {
    isFocused.current = false;
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // Support Enter and Space keys for keyboard accessibility
    if ((e.key === 'Enter' || e.key === ' ') && onReplyTo) {
      e.preventDefault(); // Prevent page scroll on Space
      onReplyTo(message);
    }
  };

  const handleTouchStart = (e: React.TouchEvent) => {
    const touch = e.touches[0];
    touchStartX.current = touch.clientX;
    touchStartY.current = touch.clientY;
    isSwiping.current = false;
    swipeCompleted.current = false; // Reset on new touch start
  };

  const handleTouchMove = (e: React.TouchEvent) => {
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

  return (
    <div
      id={id}
      className={`flex items-end gap-2 ${isOutgoing ? 'justify-end' : 'justify-start'} group relative`}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
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
            ? 'ml-auto mr-3 bg-accent text-accent-foreground rounded-br-[4px]'
            : 'ml-3 mr-auto bg-card text-card-foreground rounded-bl-[4px] shadow-sm'
        } ${onReplyTo ? 'cursor-pointer hover:opacity-90 transition-opacity focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2' : ''}`}
        onMouseDown={handleMouseDown}
        onClick={handleClick}
        onKeyDown={handleKeyDown}
        onFocus={handleFocus}
        onBlur={handleBlur}
        tabIndex={onReplyTo ? 0 : undefined}
        role={onReplyTo ? 'button' : undefined}
        aria-label={onReplyTo ? 'Reply to message' : undefined}
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
            <svg
              className="w-5 h-5 text-muted-foreground"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6"
              />
            </svg>
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
                  <svg
                    className="w-3.5 h-3.5 text-destructive shrink-0"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                    aria-hidden="true"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
                    />
                  </svg>
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
                    ? 'text-accent-foreground/60'
                    : 'text-muted-foreground/80'
                }`}
              >
                Loading...
              </p>
            ) : (
              <p
                className={`text-xs truncate ${
                  isOutgoing
                    ? 'text-accent-foreground/60'
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
            isOutgoing ? 'text-accent-foreground/80' : 'text-muted-foreground'
          }`}
        >
          <span className="text-[11px] font-medium">
            {formatTime(message.timestamp)}
          </span>
          {isOutgoing && (
            <div className="flex items-center gap-1">
              {message.status === 'sending' && (
                <div className="flex items-center gap-1">
                  <div className="w-2.5 h-2.5 border border-current border-t-transparent rounded-full animate-spin"></div>
                  <span className="text-[10px] font-medium">Sending</span>
                </div>
              )}
              {message.status === 'sent' && (
                <svg
                  className="w-3.5 h-3.5"
                  fill="currentColor"
                  viewBox="0 0 20 20"
                >
                  <path
                    fillRule="evenodd"
                    d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                    clipRule="evenodd"
                  />
                </svg>
              )}
              {message.status === 'failed' && (
                <div className="flex items-center gap-1.5">
                  <svg
                    className="w-3.5 h-3.5 text-accent-foreground/90"
                    fill="currentColor"
                    viewBox="0 0 20 20"
                  >
                    <path
                      fillRule="evenodd"
                      d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z"
                      clipRule="evenodd"
                    />
                  </svg>
                  <span className="text-[10px] font-medium">Failed</span>
                  <button
                    onClick={() => onResend(message)}
                    className="ml-1 px-1.5 py-0.5 text-[10px] font-medium bg-accent-foreground/20 hover:bg-accent-foreground/30 rounded transition-colors text-accent-foreground"
                    title="Resend message"
                  >
                    Resend
                  </button>
                </div>
              )}
              {(message.status === 'delivered' ||
                message.status === 'read') && (
                <svg
                  className="w-3.5 h-3.5"
                  fill="currentColor"
                  viewBox="0 0 20 20"
                >
                  <path
                    fillRule="evenodd"
                    d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                    clipRule="evenodd"
                  />
                </svg>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default MessageItem;
