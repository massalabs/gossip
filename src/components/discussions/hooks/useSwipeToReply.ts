import { useState, useRef, useEffect, useCallback } from 'react';
import type { Message } from '@massalabs/gossip-sdk';
import type { useLongPress } from '../../../hooks/useLongPress';

// Swipe gesture constants - base values for incoming messages
const SWIPE_MAX_DISTANCE = 80;
export const SWIPE_RESISTANCE = 0.5;
export const SWIPE_THRESHOLD = 40;
const SWIPE_INDICATOR_THRESHOLD = 8;

// Swipe gesture constants - more sensitive for outgoing (right-aligned) messages
const SWIPE_MAX_DISTANCE_OUTGOING = 90;
export const SWIPE_RESISTANCE_OUTGOING = 0.65;
export const SWIPE_THRESHOLD_OUTGOING = 30;
const SWIPE_INDICATOR_THRESHOLD_OUTGOING = 6;

// Touch slop - prevents unintentional triggers when scrolling
const TOUCH_SLOP = 15;
const TOUCH_SLOP_OUTGOING = 12;
const POST_GESTURE_SUPPRESS_MS = 700;

interface UseSwipeToReplyOptions {
  isOutgoing: boolean;
  isDeleted: boolean;
  isSelecting: boolean;
  isTextSelectable: boolean;
  canReply: boolean;
  canForward: boolean;
  onReplyTo?: (message: Message) => void;
  message: Message;
  longPress: ReturnType<typeof useLongPress>;
  suppressClickRef: React.MutableRefObject<boolean>;
  suppressClicksUntilRef: React.MutableRefObject<number>;
  longPressPosRef: React.MutableRefObject<{ x: number; y: number } | null>;
}

export function useSwipeToReply({
  isOutgoing,
  isDeleted,
  isSelecting,
  isTextSelectable,
  canReply,
  canForward,
  onReplyTo,
  message,
  longPress,
  suppressClickRef,
  suppressClicksUntilRef,
  longPressPosRef,
}: UseSwipeToReplyOptions) {
  const [swipeOffset, setSwipeOffset] = useState(0);
  const swipeOffsetRef = useRef(0);
  const [isAnimatingBack, setIsAnimatingBack] = useState(false);
  const animTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const touchStartX = useRef<number | null>(null);
  const touchStartY = useRef<number | null>(null);
  const isSwiping = useRef(false);
  const swipeCompleted = useRef(false);
  const touchSlopExceeded = useRef(false);
  const hasTriggeredHaptic = useRef(false);

  // Clean up animation timer on unmount
  useEffect(() => {
    return () => {
      if (animTimerRef.current) clearTimeout(animTimerRef.current);
    };
  }, []);

  const handleTouchStart = useCallback(
    (e: React.TouchEvent) => {
      if (isDeleted) return;
      const touch = e.touches[0];
      longPressPosRef.current = { x: touch.clientX, y: touch.clientY };
      longPress.onTouchStart(e);
      if (isSelecting || isTextSelectable || (!canReply && !canForward)) return;
      touchStartX.current = touch.clientX;
      touchStartY.current = touch.clientY;
      isSwiping.current = false;
      swipeCompleted.current = false;
      touchSlopExceeded.current = false;
      hasTriggeredHaptic.current = false;
      setIsAnimatingBack(false);
    },
    [
      isSelecting,
      isTextSelectable,
      canReply,
      canForward,
      longPress,
      isDeleted,
      longPressPosRef,
    ]
  );

  const handleTouchMove = useCallback(
    (e: React.TouchEvent) => {
      if (isDeleted) return;
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
        // Clamp to <= 0 (left-swipe only, no right-swipe)
        const clampedSwipe = Math.min(0, Math.max(rawSwipe, -maxDistance));
        swipeOffsetRef.current = clampedSwipe;
        setSwipeOffset(clampedSwipe);

        // Trigger haptic when crossing the threshold
        const threshold = isOutgoing
          ? SWIPE_THRESHOLD_OUTGOING
          : SWIPE_THRESHOLD;
        if (-clampedSwipe >= threshold && !hasTriggeredHaptic.current) {
          hasTriggeredHaptic.current = true;
        }
      } else if (Math.abs(deltaX) > 5 || Math.abs(deltaY) > 5) {
        setSwipeOffset(0);
      }
    },
    [canReply, canForward, isOutgoing, longPress, isDeleted]
  );

  const handleTouchEnd = useCallback(
    (e: React.TouchEvent) => {
      if (isDeleted) return;
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
        suppressClicksUntilRef.current = Date.now() + POST_GESTURE_SUPPRESS_MS;
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
      const isLeftSwipeCompleted = -swipeOffsetRef.current >= threshold;

      if (isLeftSwipeCompleted && onReplyTo) {
        onReplyTo(message);
        swipeCompleted.current = true;
      }

      // Suppress tap after any swipe gesture
      if (touchSlopExceeded.current || isSwiping.current) {
        suppressClickRef.current = true;
        suppressClicksUntilRef.current = Date.now() + POST_GESTURE_SUPPRESS_MS;
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
    [
      canReply,
      canForward,
      isOutgoing,
      onReplyTo,
      message,
      longPress,
      isDeleted,
      suppressClickRef,
      suppressClicksUntilRef,
    ]
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

  const indicatorThreshold = isOutgoing
    ? SWIPE_INDICATOR_THRESHOLD_OUTGOING
    : SWIPE_INDICATOR_THRESHOLD;

  return {
    swipeOffset,
    isAnimatingBack,
    handleTouchStart,
    handleTouchMove,
    handleTouchEnd,
    handleTouchCancel,
    indicatorThreshold,
  };
}
