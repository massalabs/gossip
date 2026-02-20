import React from 'react';
import { useUiStore } from '../../stores/uiStore';

interface HeaderBarProps {
  children: React.ReactNode;
  className?: string;
  /** Whether to show scroll-aware background changes (default: true) */
  scrollAware?: boolean;
}

/**
 * HeaderBar - A simple header bar component with safe area and scroll-aware styling.
 *
 * Use this when you need a header bar in a custom layout (e.g., Discussion page).
 * For standard pages, prefer using PageLayout which includes this functionality.
 */
const HeaderBar: React.FC<HeaderBarProps> = ({
  children,
  className = '',
  scrollAware = true,
}) => {
  const headerIsScrolled = useUiStore(s => s.headerIsScrolled);

  const bgClass = scrollAware && headerIsScrolled ? 'bg-muted' : 'bg-card';
  const shadowStyle =
    scrollAware && headerIsScrolled
      ? '0 2px 4px -1px rgba(0, 0, 0, 0.06), 0 4px 6px -1px rgba(0, 0, 0, 0.1)'
      : 'none';

  return (
    <div
      className={`px-header-padding pt-safe-t h-header-safe flex items-center shrink-0 relative z-10 ${bgClass} ${className}`}
      style={{
        boxShadow: shadowStyle,
        transition:
          'background-color 200ms cubic-bezier(0.4, 0, 0.2, 1), box-shadow 200ms cubic-bezier(0.4, 0, 0.2, 1)',
      }}
    >
      {children}
    </div>
  );
};

export default HeaderBar;
