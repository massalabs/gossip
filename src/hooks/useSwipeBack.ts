import { useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';

const SWIPE_THRESHOLD = 80;

/**
 * Returns touch handlers that navigate back on a right swipe.
 * Only triggers when horizontal movement dominates vertical (no scroll interference).
 */
export function useSwipeBack() {
  const navigate = useNavigate();
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

      // Only trigger on dominant horizontal right swipe exceeding threshold
      if (dx > SWIPE_THRESHOLD && Math.abs(dy) < Math.abs(dx)) {
        navigate(-1);
      }
    },
    [navigate]
  );

  return { onTouchStart, onTouchEnd };
}
