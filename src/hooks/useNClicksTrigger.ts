import { useCallback, useEffect, useRef } from 'react';

interface UseNClicksTriggerOptions {
  clickNumber: number;
  callback: () => void | Promise<void>;
  pingTimeout?: number;
}

interface UseNClicksTriggerReturn {
  ping: () => void;
}

/**
 * Generic N-click trigger hook.
 *
 * - Call `ping` every time the target is clicked/tapped.
 * - After `clickNumber` pings (within `pingTimeout`), `callback` is invoked.
 * - If the user stops before reaching `clickNumber` and `pingTimeout` elapses,
 *   the internal counter is reset.
 */
export function useNClicksTrigger(
  options: UseNClicksTriggerOptions
): UseNClicksTriggerReturn {
  const { clickNumber, callback, pingTimeout = 2000 } = options;

  const countRef = useRef(0);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const callbackRef = useRef(callback);

  // Always use the latest callback
  useEffect(() => {
    callbackRef.current = callback;
  }, [callback]);

  // Clear timeout on unmount
  useEffect(() => {
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, []);

  const ping = useCallback(() => {
    const next = countRef.current + 1;

    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }

    if (next >= clickNumber) {
      // Fire callback and reset counter
      countRef.current = 0;
      void callbackRef.current?.();
      return;
    }

    countRef.current = next;

    if (pingTimeout > 0) {
      timeoutRef.current = setTimeout(() => {
        countRef.current = 0;
      }, pingTimeout);
    }
  }, [clickNumber, pingTimeout]);

  return { ping };
}
