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
  Check as CheckIcon,
  AlertTriangle,
} from 'react-feather';
import { formatTime } from '../../utils/timeUtils';
import {
  Message,
  MessageStatus,
  MessageDirection,
  encodeUserId,
} from '@massalabs/gossip-sdk';
import { useGossipSdk } from '../../hooks/useGossipSdk';
import { parseLinks, openUrl } from '../../utils/linkUtils';
import { useMarkMessageAsRead } from '../../hooks/useMarkMessageAsRead';
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
  // Handle automatic message read marking
  const messageRef = useMarkMessageAsRead(message);
  const touchSlopExceeded = useRef(false);
  const hasTriggeredHaptic = useRef(false);

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
          const msg = await sdk.messages.findByMsgId(
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
      if (!canReply && !canForward) return;
      const touch = e.touches[0];
      touchStartX.current = touch.clientX;
      touchStartY.current = touch.clientY;
      isSwiping.current = false;
      swipeCompleted.current = false;
      touchSlopExceeded.current = false;
      hasTriggeredHaptic.current = false;
      setIsAnimatingBack(false);
    },
    [canReply, canForward]
  );

  const handleTouchMove = useCallback(
    (e: React.TouchEvent) => {
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
        isSwiping.current = true;
        const resistance = isOutgoing
          ? SWIPE_RESISTANCE_OUTGOING
          : SWIPE_RESISTANCE;
        const maxDistance = isOutgoing
          ? SWIPE_MAX_DISTANCE_OUTGOING
          : SWIPE_MAX_DISTANCE;
        const rawSwipe = deltaX * resistance;
        const clampedSwipe = Math.max(
          -maxDistance,
          Math.min(rawSwipe, maxDistance)
        );
        setSwipeOffset(clampedSwipe);

        // Trigger haptic when crossing the threshold
        const threshold = isOutgoing
          ? SWIPE_THRESHOLD_OUTGOING
          : SWIPE_THRESHOLD;
        if (
          Math.abs(clampedSwipe) >= threshold &&
          !hasTriggeredHaptic.current
        ) {
          hasTriggeredHaptic.current = true;
        }
      } else if (Math.abs(deltaX) > 5 || Math.abs(deltaY) > 5) {
        setSwipeOffset(0);
      }
    },
    [canReply, canForward, isOutgoing]
  );

  const handleTouchEnd = useCallback(() => {
    if (!canReply && !canForward) {
      setSwipeOffset(0);
      touchStartX.current = null;
      touchStartY.current = null;
      isSwiping.current = false;
      touchSlopExceeded.current = false;
      return;
    }

    const threshold = isOutgoing ? SWIPE_THRESHOLD_OUTGOING : SWIPE_THRESHOLD;
    const isRightSwipeCompleted = swipeOffset >= threshold;
    const isLeftSwipeCompleted = swipeOffset <= -threshold;

    if (isRightSwipeCompleted && onReplyTo) {
      onReplyTo(message);
      swipeCompleted.current = true;
    } else if (isLeftSwipeCompleted && onForward) {
      onForward(message);
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
  }, [
    canReply,
    canForward,
    isOutgoing,
    swipeOffset,
    onReplyTo,
    onForward,
    message,
  ]);

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
      onTouchStart={canReply ? handleTouchStart : undefined}
      onTouchMove={canReply ? handleTouchMove : undefined}
      onTouchEnd={canReply ? handleTouchEnd : undefined}
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
        ref={messageRef}
        className={`relative max-w-[80%] sm:max-w-[70%] md:max-w-[65%] lg:max-w-[60%] px-3.5 py-3 font-normal text-[15px] leading-tight animate-bubble-in ${borderRadiusClass} ${
          isOutgoing
            ? 'ml-auto mr-3 bg-accent text-accent-foreground'
            : `${contact ? '' : 'ml-3'} mr-auto bg-surface-secondary text-card-foreground`
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
            swipeOffset !== 0
              ? `translateX(${swipeOffset}px)`
              : 'translateX(0)',
          transition: isAnimatingBack
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

        {/* Forward indicator (left swipe) */}
        {swipeOffset < -indicatorThreshold && canForward && (
          <div
            className={`absolute right-0 top-0 bottom-0 flex items-center justify-center ${
              isOutgoing ? 'bg-accent/20' : 'bg-card/20'
            } rounded-r-2xl`}
            style={{
              width: `${Math.min(
                Math.abs(swipeOffset),
                SWIPE_INDICATOR_MAX_WIDTH
              )}px`,
              opacity: Math.min(
                Math.abs(swipeOffset) / SWIPE_INDICATOR_MAX_WIDTH,
                1
              ),
              transition: isAnimatingBack ? 'all 0.3s ease-out' : 'none',
            }}
            aria-hidden="true"
          >
            <Share
              className={`w-5 h-5 text-muted-foreground transition-transform ${
                Math.abs(swipeOffset) >=
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
                ? 'cursor-pointer hover:bg-black/5 dark:hover:bg-white/5 rounded-r transition-colors active:scale-[0.98] focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2'
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
                ? 'cursor-pointer hover:bg-black/5 dark:hover:bg-white/5 rounded-r transition-colors active:scale-[0.98] focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2'
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

        {/* Timestamp and Status */}
        {(showTimestamp || isOutgoing) && (
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
      </div>
    </div>
  );
};

export default MessageItem;
