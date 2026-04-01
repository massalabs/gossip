import { useState, useEffect, useRef, useCallback } from 'react';
import { Capacitor } from '@capacitor/core';

interface UseTextSelectionOptions {
  bubbleRef: React.RefObject<HTMLDivElement>;
  contextMenuOpenRef: React.MutableRefObject<boolean>;
}

export function useTextSelection({
  bubbleRef,
  contextMenuOpenRef,
}: UseTextSelectionOptions) {
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
  }, [bubbleRef, contextMenuOpenRef]);

  const clearTextSelection = useCallback(() => {
    window.getSelection()?.removeAllRanges();
    setIsTextSelectable(false);
    if (bubbleRef.current) {
      bubbleRef.current.style.userSelect = '';
      (
        bubbleRef.current.style as unknown as Record<string, string>
      ).webkitUserSelect = '';
    }
  }, [bubbleRef]);

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
  }, [isTextSelectable, clearTextSelection, bubbleRef]);

  return {
    isTextSelectable,
    longPressPosRef,
    enableTextSelection,
    clearTextSelection,
  };
}
