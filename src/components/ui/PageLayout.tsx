import React, { useRef, useEffect } from 'react';
import { useUiStore } from '../../stores/uiStore';
import { useHeaderScroll } from '../../hooks/useHeaderScroll';

interface PageLayoutProps {
  /** Header content - can be a simple title string or custom JSX */
  header?: React.ReactNode;
  /** Page content */
  children: React.ReactNode;
  /** Additional class for the page container */
  className?: string;
  /** Additional class for the scrollable content area */
  contentClassName?: string;
  /** Whether the header should change background on scroll (default: true) */
  scrollAwareHeader?: boolean;
  /** Ref to the scroll container (exposed for pages that need it) */
  scrollRef?: React.RefObject<HTMLDivElement | null>;
}

/**
 * PageLayout - Unified layout component for pages with a header
 *
 * Features:
 * - Safe area padding for status bar (top) automatically applied
 * - Scroll-aware header with dynamic background and shadow
 * - Scrollable content area with proper flex layout
 * - Consistent styling across all pages
 *
 * Usage:
 * ```tsx
 * // Simple header with title
 * <PageLayout header={<PageHeader title="Settings" onBack={() => navigate(-1)} />}>
 *   <div>Content here</div>
 * </PageLayout>
 *
 * // Custom header
 * <PageLayout header={<div className="flex justify-between">...</div>}>
 *   <div>Content here</div>
 * </PageLayout>
 *
 * // No header (just safe area + content)
 * <PageLayout>
 *   <div>Content here</div>
 * </PageLayout>
 * ```
 */
const PageLayout: React.FC<PageLayoutProps> = ({
  header,
  children,
  className = '',
  contentClassName = '',
  scrollAwareHeader = true,
  scrollRef,
}) => {
  const headerIsScrolled = useUiStore(s => s.headerIsScrolled);
  const setHeaderVisible = useUiStore(s => s.setHeaderVisible);
  const internalScrollRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = scrollRef || internalScrollRef;

  // Track header visibility in store
  useEffect(() => {
    if (header) {
      setHeaderVisible(true);
      return () => setHeaderVisible(false);
    }
  }, [header, setHeaderVisible]);

  // Setup scroll detection for header background
  useHeaderScroll(
    scrollAwareHeader && header ? { scrollContainerRef } : undefined
  );

  const bgClass =
    scrollAwareHeader && headerIsScrolled ? 'bg-muted' : 'bg-card';
  const shadowStyle =
    scrollAwareHeader && headerIsScrolled
      ? '0 2px 4px -1px rgba(0, 0, 0, 0.06), 0 4px 6px -1px rgba(0, 0, 0, 0.1)'
      : 'none';

  return (
    <div className={`h-full flex flex-col bg-background ${className}`.trim()}>
      {/* Header with safe area */}
      {header && (
        <div
          className={`px-header-padding pt-safe-t h-header-safe flex items-center shrink-0 relative z-10 ${bgClass}`}
          style={{
            boxShadow: shadowStyle,
            transition:
              'background-color 200ms cubic-bezier(0.4, 0, 0.2, 1), box-shadow 200ms cubic-bezier(0.4, 0, 0.2, 1)',
          }}
        >
          {header}
        </div>
      )}

      {/* Scrollable content */}
      <div
        ref={scrollContainerRef as React.RefObject<HTMLDivElement>}
        className={`flex-1 min-h-0 overflow-y-auto ${contentClassName}`.trim()}
      >
        {children}
      </div>
    </div>
  );
};

export default PageLayout;
