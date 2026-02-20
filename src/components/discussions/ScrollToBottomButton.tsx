import React from 'react';
import { ChevronDown } from 'react-feather';
import Button from '../ui/Button';

interface ScrollToBottomButtonProps {
  onClick: () => void;
  isVisible: boolean;
}

const ScrollToBottomButton: React.FC<ScrollToBottomButtonProps> = ({
  onClick,
  isVisible,
}) => {
  return (
    <div
      className={`absolute bottom-24 right-4 z-10 transition-all duration-200 ${
        isVisible
          ? 'opacity-100 translate-y-0'
          : 'opacity-0 translate-y-4 pointer-events-none'
      }`}
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
