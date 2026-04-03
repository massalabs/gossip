import React from 'react';
import { useSwipeBack } from '../../hooks/useSwipeBack';

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

  return (
    <div
      className={`h-full app-max-w mx-auto flex flex-col relative select-none ${className}`}
      style={{ WebkitTouchCallout: 'none' }}
      onTouchStart={swipeBack.onTouchStart}
      onTouchEnd={swipeBack.onTouchEnd}
      onPointerDown={e => {
        const tag = (e.target as HTMLElement).tagName;
        if (tag !== 'INPUT' && tag !== 'TEXTAREA') {
          e.preventDefault();
        }
      }}
    >
      <div className="shrink-0">{header}</div>

      <div className="flex-1 min-h-0 flex flex-col">
        <div className="flex-1 min-h-0 overflow-hidden relative">
          {children}
        </div>
        {beforeFooter}
        {footer}
      </div>

      {overlay}
    </div>
  );
};

export default DiscussionLayout;
