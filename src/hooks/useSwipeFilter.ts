import { useCallback, useRef } from 'react';
import { type DiscussionFilter } from '../stores/discussionStore';

const FILTERS: DiscussionFilter[] = ['all', 'unread', 'pending'];
const SWIPE_THRESHOLD = 50;

/**
 * Returns touch handlers that cycle through discussion filters on horizontal swipe.
 *
 * - Swipe left → next filter (all → unread → pending)
 * - Swipe right → previous filter (pending → unread → all)
 */
export function useSwipeFilter(
  filter: DiscussionFilter,
  setFilter: (f: DiscussionFilter) => void
) {
  const startX = useRef(0);
  const startY = useRef(0);

  const onTouchStart = useCallback((e: React.TouchEvent) => {
    startX.current = e.touches[0].clientX;
    startY.current = e.touches[0].clientY;
  }, []);

  const onTouchEnd = useCallback(
    (e: React.TouchEvent) => {
      const dx = e.changedTouches[0].clientX - startX.current;
      const dy = e.changedTouches[0].clientY - startY.current;

      // Only trigger if horizontal swipe is dominant and exceeds threshold
      if (Math.abs(dx) < SWIPE_THRESHOLD || Math.abs(dy) > Math.abs(dx)) {
        return;
      }

      const idx = FILTERS.indexOf(filter);
      if (dx < 0 && idx < FILTERS.length - 1) {
        // Swipe left → next filter
        setFilter(FILTERS[idx + 1]);
      } else if (dx > 0 && idx > 0) {
        // Swipe right → previous filter
        setFilter(FILTERS[idx - 1]);
      }
    },
    [filter, setFilter]
  );

  return { onTouchStart, onTouchEnd };
}
