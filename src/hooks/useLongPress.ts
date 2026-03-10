import { useRef, useCallback, useEffect } from 'react';

interface UseLongPressOptions {
  onLongPress: () => void;
  delay?: number;
  threshold?: number;
  disabled?: boolean;
  /** Skip preventDefault on touchEnd after long press (needed for Android native selection handles) */
  preventDefaultOnEnd?: boolean;
}

export function useLongPress({
  onLongPress,
  delay = 500,
  threshold = 10,
  disabled = false,
  preventDefaultOnEnd = true,
}: UseLongPressOptions) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startPos = useRef<{ x: number; y: number } | null>(null);
  const longPressTriggered = useRef(false);

  const clear = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const trigger = useCallback(() => {
    longPressTriggered.current = true;
    try {
      navigator.vibrate?.(10);
    } catch {
      // Vibration not available
    }
    onLongPress();
  }, [onLongPress]);

  const onTouchStart = useCallback(
    (e: React.TouchEvent) => {
      if (disabled) return;
      longPressTriggered.current = false;
      const touch = e.touches[0];
      startPos.current = { x: touch.clientX, y: touch.clientY };
      timerRef.current = setTimeout(trigger, delay);
    },
    [disabled, trigger, delay]
  );

  const onTouchMove = useCallback(
    (e: React.TouchEvent) => {
      if (disabled || !startPos.current) return;
      const touch = e.touches[0];
      const dx = touch.clientX - startPos.current.x;
      const dy = touch.clientY - startPos.current.y;
      if (Math.sqrt(dx * dx + dy * dy) > threshold) {
        clear();
      }
    },
    [disabled, threshold, clear]
  );

  const onTouchEnd = useCallback(
    (e: React.TouchEvent) => {
      clear();
      // Prevent browser from synthesizing mousedown/click after a long press,
      // which would blur the focused input and dismiss the keyboard.
      if (longPressTriggered.current && preventDefaultOnEnd) {
        e.preventDefault();
      }
      startPos.current = null;
    },
    [clear, preventDefaultOnEnd]
  );

  // iOS fires touchcancel when it takes over for scrolling — clear the timer
  const onTouchCancel = useCallback(() => {
    clear();
    startPos.current = null;
  }, [clear]);

  const onContextMenu = useCallback(
    (e: React.MouseEvent) => {
      if (disabled) return;
      e.preventDefault();
      if (longPressTriggered.current) return;
      longPressTriggered.current = true;
      onLongPress();
    },
    [disabled, onLongPress]
  );

  // Cancel pending timer on unmount
  useEffect(() => () => clear(), [clear]);

  return {
    onTouchStart,
    onTouchMove,
    onTouchEnd,
    onTouchCancel,
    onContextMenu,
    longPressTriggered,
  };
}
