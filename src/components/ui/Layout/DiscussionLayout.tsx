import React from 'react';
import { useSwipeBack } from '../../../hooks/useSwipeBack';
import { useKeyboardStore } from '../../../stores/keyboardStore';

interface DiscussionLayoutProps {
  header: React.ReactNode;
  footer: React.ReactNode;
  children: React.ReactNode;
  /** Extra content between the message list and footer (e.g., debug button) */
  beforeFooter?: React.ReactNode;
  /** Extra content after footer (e.g., modals) */
  overlay?: React.ReactNode;
  className?: string;
}

const DiscussionLayout: React.FC<DiscussionLayoutProps> = ({
  header,
  footer,
  children,
  beforeFooter,
  overlay,
  className = 'bg-card',
}) => {
  const swipeBack = useSwipeBack();
  const keyboardOpen = useKeyboardStore(s => s.isVisible);

  return (
    <div
      className={`h-full app-max-w mx-auto flex flex-col relative select-none ${className}`}
      style={{ WebkitTouchCallout: 'none' }}
      onTouchStart={swipeBack.onTouchStart}
      onTouchEnd={swipeBack.onTouchEnd}
      onPointerDown={e => {
        const el = e.target as HTMLElement;
        if (
          el.tagName === 'INPUT' ||
          el.tagName === 'TEXTAREA' ||
          el.closest('button')
        ) {
          return;
        }
        e.preventDefault();
      }}
    >
      <div className="shrink-0">{header}</div>

      <div className={`flex-1 min-h-0 flex flex-col`}>
        <div className="flex-1 min-h-0 overflow-hidden relative">
          {children}
        </div>
        {beforeFooter}
        {footer}
      </div>

      {overlay}

      <div className={`${keyboardOpen ? '' : 'h-[var(--sab)]'} shrink-0`}></div>
    </div>
  );
};

export default DiscussionLayout;
