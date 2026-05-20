import React, { useRef, useState } from 'react';

interface ErrorDisplayProps {
  error: string | null;
  onDismiss?: () => void;
}

export const ErrorDisplay: React.FC<ErrorDisplayProps> = ({
  error,
  onDismiss,
}) => {
  const touchStartX = useRef(0);
  const [swipeOffset, setSwipeOffset] = useState(0);
  const [dismissed, setDismissed] = useState(false);

  const handleTouchStart = (e: React.TouchEvent) => {
    touchStartX.current = e.touches[0].clientX;
    setSwipeOffset(0);
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    const delta = e.touches[0].clientX - touchStartX.current;
    // Only allow swipe right
    if (delta > 0) setSwipeOffset(delta);
  };

  const handleTouchEnd = () => {
    if (swipeOffset > 100) {
      setDismissed(true);
      setTimeout(() => {
        onDismiss?.();
        setDismissed(false);
        setSwipeOffset(0);
      }, 300);
    } else {
      setSwipeOffset(0);
    }
  };

  const visible = error && !dismissed;

  return (
    <div
      className={`rounded-xl border-2 border-red-200 dark:border-red-800 bg-red-50/80 dark:bg-red-900/20 overflow-hidden transition-all duration-300 ${
        visible ? 'max-h-40 opacity-100 p-3' : 'max-h-0 opacity-0 p-0 border-0'
      }`}
      style={{
        transform: swipeOffset > 0 ? `translateX(${swipeOffset}px)` : undefined,
        opacity: swipeOffset > 0 ? 1 - swipeOffset / 200 : undefined,
        transition: swipeOffset > 0 ? 'none' : undefined,
      }}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
    >
      <p className="text-sm text-red-700 dark:text-red-300">{error}</p>
    </div>
  );
};
