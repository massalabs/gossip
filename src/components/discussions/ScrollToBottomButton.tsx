import React from 'react';
import { useTranslation } from 'react-i18next';
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
  const { t } = useTranslation('discussions');
  return (
    <div
      className={`absolute right-4 bottom-3 z-10 transition-all duration-200 ${
        isVisible
          ? 'opacity-100 translate-y-0'
          : 'opacity-0 translate-y-4 pointer-events-none'
      }`}
      aria-hidden={!isVisible}
    >
      <Button
        variant="circular"
        size="custom"
        className="w-12 h-12 bg-primary hover:brightness-110 text-primary-foreground shadow-[0px_0px_11px_1px_rgba(0,0,0,0.1)]"
        onClick={onClick}
        ariaLabel={t('scroll_to_bottom')}
        title={t('scroll_to_bottom')}
        tabIndex={isVisible ? 0 : -1}
      >
        <ChevronDown size={20} />
      </Button>
    </div>
  );
};

export default ScrollToBottomButton;
