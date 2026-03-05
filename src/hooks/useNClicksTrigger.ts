import { useCallback, useEffect, useRef, useState } from 'react';

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

  const [, setCount] = useState(0);
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
    setCount(prev => {
      const next = prev + 1;

      if (next >= clickNumber) {
        if (timeoutRef.current) {
          clearTimeout(timeoutRef.current);
        }
        // Fire callback and reset counter
        callbackRef.current?.();
        return 0;
      }

      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }

      if (pingTimeout > 0) {
        timeoutRef.current = setTimeout(() => {
          setCount(0);
        }, pingTimeout);
      }

      return next;
    });
  }, [clickNumber, pingTimeout]);

  return { ping };
}
