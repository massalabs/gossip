import React from 'react';

interface ScrollLockIndicatorProps {
  isVisible: boolean;
  hiddenCount: number;
}

export const ScrollLockIndicator: React.FC<ScrollLockIndicatorProps> = ({
  isVisible,
  hiddenCount,
}) => {
  if (!isVisible) return null;

  return (
    <div className="absolute bottom-5 left-1/2 -translate-x-1/2 bg-card/95 text-foreground px-4 py-2 rounded-full text-xs shadow-md border border-border animate-pulse">
      Scroll locked · {hiddenCount} hidden
    </div>
  );
};
