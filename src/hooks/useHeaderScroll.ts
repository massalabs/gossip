import { useEffect, RefObject, useRef } from 'react';
import { useUiStore } from '../stores/uiStore';

interface UseHeaderScrollOptions {
  /** Direct DOM node reference */
  scrollContainer?: HTMLElement | null;
  /** Ref to a scrollable container (alternative to scrollContainer) */
  scrollContainerRef?: RefObject<HTMLElement | null>;
  /** DOM element ID (alternative to ref) */
  scrollContainerId?: string;
}

/**
 * Hook to detect scroll position of content and update header background state globally.
 * Accepts a DOM node, a ref, or a DOM ID.
 * Uses requestAnimationFrame to throttle updates for better scroll performance.
 */
export const useHeaderScroll = (options?: UseHeaderScrollOptions) => {
  const setHeaderIsScrolled = useUiStore(s => s.setHeaderIsScrolled);
  const rafIdRef = useRef<number | null>(null);
  const lastScrollTopRef = useRef<number>(0);

  // Resolve the scroll container from the various input types
  const scrollContainer =
    options?.scrollContainer ?? options?.scrollContainerRef?.current ?? null;
  const scrollContainerId = options?.scrollContainerId;

  useEffect(() => {
    let scrollableContainer: HTMLElement | null = scrollContainer;

    if (!scrollableContainer && scrollContainerId) {
      scrollableContainer = document.getElementById(scrollContainerId);
    }

    if (!scrollableContainer) return;

    const handleScroll = () => {
      const scrollTop = scrollableContainer!.scrollTop;

      // Only update if scroll position actually changed
      if (scrollTop === lastScrollTopRef.current) return;
      lastScrollTopRef.current = scrollTop;

      // Cancel any pending animation frame
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current);
      }

      // Use requestAnimationFrame to throttle updates and batch state changes
      rafIdRef.current = requestAnimationFrame(() => {
        setHeaderIsScrolled(scrollTop > 0);
        rafIdRef.current = null;
      });
    };

    // Set initial state
    lastScrollTopRef.current = scrollableContainer.scrollTop;
    setHeaderIsScrolled(scrollableContainer.scrollTop > 0);

    // Attach scroll listener to the content container
    scrollableContainer.addEventListener('scroll', handleScroll, {
      passive: true,
    });

    return () => {
      scrollableContainer?.removeEventListener('scroll', handleScroll);
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current);
      }
    };
  }, [setHeaderIsScrolled, scrollContainer, scrollContainerId]);
};
