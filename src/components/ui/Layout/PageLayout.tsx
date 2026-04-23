import React, {
  useContext,
  useState,
  useEffect,
  useLayoutEffect,
  useCallback,
} from 'react';
import { useUiStore } from '../../../stores/uiStore';
import { useHeaderScroll } from '../../../hooks/useHeaderScroll';
import { useIsPWA } from '../../../hooks/usePlatform';
import HeaderBar from '../HeaderBar';
import { ExitAnimationContext } from '../ExitAnimationContext';

interface PageLayoutProps {
  /** Header content - can be a simple title string or custom JSX */
  header?: React.ReactNode;
  /** Sticky content rendered below the header, outside the scrollable area.
   *  Shares the header's scroll-aware background. Use for search bars, filter tabs, etc. */
  subHeader?: React.ReactNode;
  /** Page content */
  children: React.ReactNode;
  /** Additional class for the page container */
  className?: string;
  /** Additional class for the scrollable content area */
  contentClassName?: string;
  /** Whether the header should change background on scroll (default: true) */
  scrollAwareHeader?: boolean;
  /** Callback ref to the scroll container (exposed for pages that need the DOM node) */
  onScrollContainerRef?: (node: HTMLDivElement | null) => void;
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
  subHeader,
  children,
  className = '',
  contentClassName = '',
  scrollAwareHeader = true,
  onScrollContainerRef,
}) => {
  const isExiting = useContext(ExitAnimationContext);
  const setHeaderVisible = useUiStore(s => s.setHeaderVisible);
  const setHeaderIsScrolled = useUiStore(s => s.setHeaderIsScrolled);
  const headerIsScrolled = useUiStore(s => s.headerIsScrolled);
  const showBottomNav = useUiStore(s => s.showBottomNav);
  // In installed PWA mode the phone's system nav bar is fixed and there's no
  // dynamic browser chrome above the home indicator, so the progressive blur
  // has nothing meaningful to blur against and just darkens the edge.
  const isPWA = useIsPWA();

  // Reset scroll-aware bg BEFORE first paint on every mount of a non-exiting
  // PageLayout. Prevents stale "scrolled" state from a previous page bleeding
  // into the initial render.
  useLayoutEffect(() => {
    if (!isExiting) setHeaderIsScrolled(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [scrollContainer, setScrollContainer] = useState<HTMLDivElement | null>(
    null
  );

  // Callback ref: stores node in state + notifies parent
  const scrollRef = useCallback(
    (node: HTMLDivElement | null) => {
      setScrollContainer(node);
      onScrollContainerRef?.(node);
    },
    [onScrollContainerRef]
  );

  // Track header visibility in store
  useEffect(() => {
    if (header) {
      setHeaderVisible(true);
      return () => setHeaderVisible(false);
    }
  }, [header, setHeaderVisible]);

  // Setup scroll detection for header background. Disabled for exiting
  // PageLayouts (slide-out animation) so a stale scrollTop on the leaving
  // page doesn't clobber the base layer's header state.
  useHeaderScroll(
    scrollAwareHeader && header && !isExiting ? { scrollContainer } : undefined
  );

  const subHeaderScrolled = scrollAwareHeader && headerIsScrolled;
  const subHeaderBg = subHeaderScrolled ? 'bg-muted' : 'bg-transparent';
  const subHeaderShadow = subHeaderScrolled
    ? '0 2px 4px -1px rgba(0, 0, 0, 0.06), 0 4px 6px -1px rgba(0, 0, 0, 0.1)'
    : 'none';

  // Same "delay enable" pattern as HeaderBar: avoid animating the initial
  // false-state reset on remount after overlay exit.
  const [enableSubHeaderTransition, setEnableSubHeaderTransition] =
    useState(false);
  useEffect(() => {
    const raf = requestAnimationFrame(() => setEnableSubHeaderTransition(true));
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div
      className={`h-full min-h-0 flex flex-col bg-background ${className}`.trim()}
    >
      {header && (
        <HeaderBar scrollAware={scrollAwareHeader} shadowBelow={!!subHeader}>
          {header}
        </HeaderBar>
      )}
      {subHeader && (
        <div
          className={`shrink-0 relative z-10 pb-3 ${subHeaderBg}`}
          style={{
            boxShadow: subHeaderShadow,
            transition: enableSubHeaderTransition
              ? 'background-color 200ms cubic-bezier(0.4, 0, 0.2, 1), box-shadow 200ms cubic-bezier(0.4, 0, 0.2, 1)'
              : 'none',
          }}
        >
          {subHeader}
        </div>
      )}

      {/* Scrollable content */}
      <div className="flex-1 min-h-0 relative">
        <div
          ref={scrollRef}
          className={`h-full overflow-y-auto ${contentClassName}`.trim()}
        >
          {children}
          <div
            aria-hidden="true"
            style={{ height: 'calc(var(--sab) + 24px)' }}
          />
        </div>
        {!showBottomNav && !isPWA && <BottomProgressiveBlur />}
      </div>
    </div>
  );
};

/**
 * Progressive blur overlay sitting above the home indicator / native bottom bar.
 * Uses 4 stacked backdrop-filter layers with overlapping gradient masks so blur
 * intensity grows toward the bottom edge. Pure CSS, no JS.
 */
const BottomProgressiveBlur: React.FC = () => {
  const layers = [
    { blur: 2, maskStop: '100%' },
    { blur: 6, maskStop: '75%' },
    { blur: 12, maskStop: '50%' },
    { blur: 24, maskStop: '25%' },
  ];
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-x-0 bottom-0"
      style={{ height: 'calc(var(--sab) + 32px)' }}
    >
      {layers.map(({ blur, maskStop }, i) => {
        const mask = `linear-gradient(to top, black 0%, transparent ${maskStop})`;
        return (
          <div
            key={i}
            className="absolute inset-0"
            style={{
              backdropFilter: `blur(${blur}px)`,
              WebkitBackdropFilter: `blur(${blur}px)`,
              maskImage: mask,
              WebkitMaskImage: mask,
            }}
          />
        );
      })}
    </div>
  );
};

export default PageLayout;
