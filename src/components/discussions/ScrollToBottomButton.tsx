import React from 'react';
import { ChevronDown } from 'react-feather';
import Button from '../ui/Button';

const GAP = 12;

interface ScrollToBottomButtonProps {
  onClick: () => void;
  isVisible: boolean;
  bottomOffset?: number;
}

const ScrollToBottomButton: React.FC<ScrollToBottomButtonProps> = ({
  onClick,
  isVisible,
  bottomOffset = 0,
}) => {
  return (
    <div
      className={`absolute right-4 z-10 transition-all duration-200 ${
        isVisible
          ? 'opacity-100 translate-y-0'
          : 'opacity-0 translate-y-4 pointer-events-none'
      }`}
      style={{ bottom: bottomOffset + GAP }}
      aria-hidden={!isVisible}
    >
      <Button
        variant="circular"
        size="custom"
        className="w-12 h-12 bg-primary hover:bg-primary/90 text-primary-foreground shadow-lg border border-border"
        onClick={onClick}
        ariaLabel="Scroll to bottom"
        title="Scroll to latest messages"
        tabIndex={isVisible ? 0 : -1}
      >
        <ChevronDown size={20} />
      </Button>
    </div>
  );
};

export default ScrollToBottomButton;
