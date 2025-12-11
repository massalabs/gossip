import { useEffect, RefObject, useRef } from 'react';
import { useUiStore } from '../stores/uiStore';

interface UseHeaderScrollOptions {
  scrollContainerRef?: RefObject<HTMLElement | null>;
  scrollContainerId?: string;
}

/**
 * Hook to detect scroll position of content and update header background state globally
 * Pass a ref to the scrollable content container
 * Uses requestAnimationFrame to throttle updates for better scroll performance
 */
export const useHeaderScroll = (options?: UseHeaderScrollOptions) => {
  const setHeaderIsScrolled = useUiStore(s => s.setHeaderIsScrolled);
  const rafIdRef = useRef<number | null>(null);
  const lastScrollTopRef = useRef<number>(0);

  useEffect(() => {
    // Find the scrollable container
    let scrollableContainer: HTMLElement | null = null;

    if (options?.scrollContainerId) {
      scrollableContainer = document.getElementById(options.scrollContainerId);
    } else if (options?.scrollContainerRef?.current) {
      scrollableContainer = options.scrollContainerRef.current;
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
  }, [
    setHeaderIsScrolled,
    options?.scrollContainerRef,
    options?.scrollContainerId,
  ]);
};
