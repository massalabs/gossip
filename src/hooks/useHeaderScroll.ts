import { useEffect, RefObject } from 'react';
import { useAppStore } from '../stores/appStore';

interface UseHeaderScrollOptions {
  scrollContainerRef?: RefObject<HTMLElement | null>;
  scrollContainerId?: string;
}

/**
 * Hook to detect scroll position of content and update header background state globally
 * Pass a ref to the scrollable content container
 */
export const useHeaderScroll = (options?: UseHeaderScrollOptions) => {
  const setHeaderIsScrolled = useAppStore(s => s.setHeaderIsScrolled);

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
      setHeaderIsScrolled(scrollTop > 0);
    };

    // Set initial state
    handleScroll();

    // Attach scroll listener to the content container
    scrollableContainer.addEventListener('scroll', handleScroll, {
      passive: true,
    });

    return () => {
      scrollableContainer?.removeEventListener('scroll', handleScroll);
    };
  }, [
    setHeaderIsScrolled,
    options?.scrollContainerRef,
    options?.scrollContainerId,
  ]);
};
