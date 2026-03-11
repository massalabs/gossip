import React, { useEffect, useRef, useState } from 'react';
import { HelpCircle } from 'react-feather';
import { PopoverPosition } from '../utils';

interface PopoverProps {
  message: string;
  position?: PopoverPosition;
  ariaLabel?: string;
}
const Popover: React.FC<PopoverProps> = ({
  message,
  position = PopoverPosition.RIGHT,
  ariaLabel = 'Show help',
}) => {
  const [showPopover, setShowPopover] = useState(false);
  const popoverRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [offset, setOffset] = useState({ x: 0, y: 0 });

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

  // Ensure the popover stays within viewport bounds by nudging it if needed
  useEffect(() => {
    if (!showPopover || !panelRef.current) {
      setOffset({ x: 0, y: 0 });
      return;
    }

    const updateOffset = () => {
      const panel = panelRef.current;
      if (!panel) return;

      const rect = panel.getBoundingClientRect();
      const padding = 8; // minimum distance from viewport edges

      let dx = 0;
      let dy = 0;

      if (rect.left < padding) {
        dx = padding - rect.left;
      } else if (rect.right > window.innerWidth - padding) {
        dx = window.innerWidth - padding - rect.right;
      }

      if (rect.top < padding) {
        dy = padding - rect.top;
      } else if (rect.bottom > window.innerHeight - padding) {
        dy = window.innerHeight - padding - rect.bottom;
      }

      setOffset({ x: dx, y: dy });
    };

    updateOffset();
    window.addEventListener('resize', updateOffset);
    return () => {
      window.removeEventListener('resize', updateOffset);
    };
  }, [showPopover, position, message]);

  const getPopoverPositionClasses = () => {
    switch (position) {
      case PopoverPosition.TOP:
        return 'bottom-full mb-2 left-1/2 -translate-x-1/2';
      case PopoverPosition.BOTTOM:
        return 'top-full mt-2 left-1/2 -translate-x-1/2';
      case PopoverPosition.LEFT:
        return 'right-full mr-2 top-1/2 -translate-y-1/2';
      case PopoverPosition.RIGHT:
      default:
        return 'left-full ml-2 top-1/2 -translate-y-1/2';
    }
  };

  const getArrowClasses = () => {
    switch (position) {
      case PopoverPosition.TOP:
        return {
          outer:
            'left-1/2 top-full -translate-x-1/2 translate-y-1 w-0 h-0 border-l-4 border-l-transparent border-r-4 border-r-transparent border-t-4 border-t-border',
          inner:
            'left-1/2 top-full -translate-x-1/2 translate-y-0.5 w-0 h-0 border-l-4 border-l-transparent border-r-4 border-r-transparent border-t-4 border-t-card',
        };
      case PopoverPosition.BOTTOM:
        return {
          outer:
            'left-1/2 bottom-full -translate-x-1/2 -translate-y-1 w-0 h-0 border-l-4 border-l-transparent border-r-4 border-r-transparent border-b-4 border-b-border',
          inner:
            'left-1/2 bottom-full -translate-x-1/2 -translate-y-0.5 w-0 h-0 border-l-4 border-l-transparent border-r-4 border-r-transparent border-b-4 border-b-card',
        };
      case PopoverPosition.LEFT:
        return {
          outer:
            'right-0 top-1/2 translate-x-1 -translate-y-1/2 w-0 h-0 border-t-4 border-t-transparent border-b-4 border-b-transparent border-l-4 border-l-border',
          inner:
            'right-0 top-1/2 translate-x-0.5 -translate-y-1/2 w-0 h-0 border-t-4 border-t-transparent border-b-4 border-b-transparent border-l-4 border-l-card',
        };
      case PopoverPosition.RIGHT:
      default:
        return {
          outer:
            'left-0 top-1/2 -translate-x-1 -translate-y-1/2 w-0 h-0 border-t-4 border-t-transparent border-b-4 border-b-transparent border-r-4 border-r-border',
          inner:
            'left-0 top-1/2 -translate-x-0.5 -translate-y-1/2 w-0 h-0 border-t-4 border-t-transparent border-b-4 border-b-transparent border-r-4 border-r-card',
        };
    }
  };

  const arrowClasses = getArrowClasses();

  return (
    <div className="relative" ref={popoverRef}>
      <button
        type="button"
        onClick={() => setShowPopover(!showPopover)}
        className="w-6 h-6 flex items-center justify-center rounded-full text-muted-foreground hover:text-foreground transition-colors touch-manipulation"
        aria-label={ariaLabel}
      >
        <HelpCircle className="w-4 h-4" />
      </button>
      {showPopover && (
        <div
          ref={panelRef}
          className={`absolute z-50 w-64 max-w-[calc(100vw-2rem)] p-3 bg-card border border-border rounded-lg shadow-lg pointer-events-auto ${getPopoverPositionClasses()}`}
          style={{
            marginLeft: offset.x,
            marginTop: offset.y,
          }}
        >
          <p className="text-sm text-foreground">{message}</p>
          {/* Arrow pointing to help button */}
          <div className={`absolute ${arrowClasses.outer}`} />
          <div className={`absolute ${arrowClasses.inner}`} />
        </div>
      )}
    </div>
  );
};

export default Popover;
