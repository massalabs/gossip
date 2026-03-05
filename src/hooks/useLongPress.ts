import { useRef, useCallback } from 'react';

interface UseLongPressOptions {
  onLongPress: () => void;
  delay?: number;
  threshold?: number;
  disabled?: boolean;
}

export function useLongPress({
  onLongPress,
  delay = 500,
  threshold = 10,
  disabled = false,
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

  const onTouchEnd = useCallback(() => {
    clear();
    startPos.current = null;
  }, [clear]);

  const onContextMenu = useCallback(
    (e: React.MouseEvent) => {
      if (disabled) return;
      e.preventDefault();
      longPressTriggered.current = true;
      onLongPress();
    },
    [disabled, onLongPress]
  );

  return {
    onTouchStart,
    onTouchMove,
    onTouchEnd,
    onContextMenu,
    longPressTriggered,
  };
}
