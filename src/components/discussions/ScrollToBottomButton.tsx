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
  if (!isVisible) return null;

  return (
    <div className="absolute bottom-24 right-4 z-10">
      <Button
        variant="circular"
        size="custom"
        className="w-12 h-12 bg-primary hover:bg-primary/90 text-primary-foreground shadow-lg border border-border"
        onClick={onClick}
        ariaLabel="Scroll to bottom"
        title="Scroll to latest messages"
      >
        <ChevronDown size={20} />
      </Button>
    </div>
  );
};

export default ScrollToBottomButton;
