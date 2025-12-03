import React, { useEffect, useRef, useState } from 'react';
import { HelpCircle } from 'react-feather';

interface PopoverProps {
  message: string;
  ariaLabel?: string;
}

const Popover: React.FC<PopoverProps> = ({
  message,
  ariaLabel = 'Show help',
}) => {
  const [showPopover, setShowPopover] = useState(false);
  const popoverRef = useRef<HTMLDivElement>(null);

  // Close popover when clicking outside or touching outside (mobile support)
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent | TouchEvent) => {
      if (
        popoverRef.current &&
        !popoverRef.current.contains(event.target as Node)
      ) {
        setShowPopover(false);
      }
    };

    if (showPopover) {
      // Support both mouse and touch events for mobile
      document.addEventListener('mousedown', handleClickOutside);
      document.addEventListener('touchstart', handleClickOutside);
      return () => {
        document.removeEventListener('mousedown', handleClickOutside);
        document.removeEventListener('touchstart', handleClickOutside);
      };
    }
  }, [showPopover]);

  return (
    <div className="relative" ref={popoverRef}>
      <button
        type="button"
        onClick={() => setShowPopover(!showPopover)}
        className="w-6 h-6 flex items-center justify-center rounded-full bg-secondary hover:bg-secondary/80 active:bg-secondary/60 text-muted-foreground transition-colors touch-manipulation"
        aria-label={ariaLabel}
      >
        <HelpCircle className="w-4 h-4" />
      </button>
      {showPopover && (
        <div className="absolute left-full ml-2 top-1/2 -translate-y-1/2 z-50 w-64 max-w-[calc(100vw-2rem)] p-3 bg-card border border-border rounded-lg shadow-lg pointer-events-auto">
          <p className="text-sm text-foreground">{message}</p>
          {/* Arrow pointing to help button */}
          <div className="absolute left-0 top-1/2 -translate-x-1 -translate-y-1/2 w-0 h-0 border-t-4 border-t-transparent border-b-4 border-b-transparent border-r-4 border-r-border"></div>
          <div className="absolute left-0 top-1/2 -translate-x-0.5 -translate-y-1/2 w-0 h-0 border-t-4 border-t-transparent border-b-4 border-b-transparent border-r-4 border-r-card"></div>
        </div>
      )}
    </div>
  );
};

export default Popover;
