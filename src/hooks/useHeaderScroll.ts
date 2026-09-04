import { useEffect, RefObject, useRef } from 'react';
import { useUiStore } from '../stores/uiStore';

type SetHeaderIsScrolled = (scrolled: boolean) => void;

/**
 * Shared core: rAF-throttled scroll listener that mirrors `scrollTop > 0`
 * into the global `headerIsScrolled` flag. Returns the cleanup.
 */
function attachHeaderScrollListener(
  container: HTMLElement,
  setHeaderIsScrolled: SetHeaderIsScrolled
): () => void {
  let rafId: number | null = null;
  let lastScrollTop = container.scrollTop;

  const handleScroll = () => {
    const scrollTop = container.scrollTop;
    // Only update if scroll position actually changed
    if (scrollTop === lastScrollTop) return;
    lastScrollTop = scrollTop;

    if (rafId !== null) cancelAnimationFrame(rafId);
    // requestAnimationFrame throttles updates and batches state changes
    rafId = requestAnimationFrame(() => {
      setHeaderIsScrolled(container.scrollTop > 0);
      rafId = null;
    });
  };

  // Set initial state
  setHeaderIsScrolled(container.scrollTop > 0);
  container.addEventListener('scroll', handleScroll, { passive: true });

  return () => {
    container.removeEventListener('scroll', handleScroll);
    if (rafId !== null) cancelAnimationFrame(rafId);
  };
}

interface UseHeaderScrollOptions {
  /** Direct DOM node reference */
  scrollContainer?: HTMLElement | null;
  /** Ref to a scrollable container (alternative to scrollContainer) */
  scrollContainerRef?: RefObject<HTMLElement | null>;
  /** DOM element ID (alternative to ref) */
  scrollContainerId?: string;
}

/**
 * Detect the scroll position of a page's content container and update the
 * global header background state. Accepts a DOM node, a ref, or a DOM ID.
 */
export const useHeaderScroll = (options?: UseHeaderScrollOptions) => {
  const setHeaderIsScrolled = useUiStore(s => s.setHeaderIsScrolled);

  // Resolve the scroll container from the various input types
  const scrollContainer =
    options?.scrollContainer ?? options?.scrollContainerRef?.current ?? null;
  const scrollContainerId = options?.scrollContainerId;

  useEffect(() => {
    const container =
      scrollContainer ??
      (scrollContainerId ? document.getElementById(scrollContainerId) : null);
    if (!container) return;
    return attachHeaderScrollListener(container, setHeaderIsScrolled);
  }, [setHeaderIsScrolled, scrollContainer, scrollContainerId]);
};

/**
 * Variant for the chat pages: the scrollable element (`.scroll-container`,
 * rendered by the virtualized message list) mounts a beat after the page,
 * so it is looked up inside `containerRef` after a short delay and
 * re-resolved when the discussion or message count changes. Resets the
 * global flag on unmount so the next page's header doesn't inherit this
 * chat's "scrolled" background.
 */
export function useHeaderScrollDetection(
  containerRef: RefObject<HTMLElement | null>,
  messagesLength: number,
  discussionId: string | number | undefined,
  disabled?: boolean
) {
  const detachRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (disabled) return;
    if (!containerRef.current) return;

    const setHeaderIsScrolled = useUiStore.getState().setHeaderIsScrolled;

    const timeoutId = setTimeout(() => {
      const container = (containerRef.current?.querySelector(
        '.scroll-container'
      ) ?? null) as HTMLElement | null;
      if (container) {
        detachRef.current = attachHeaderScrollListener(
          container,
          setHeaderIsScrolled
        );
      }
    }, 100);

    return () => {
      clearTimeout(timeoutId);
      detachRef.current?.();
      detachRef.current = null;
      // Reset global state on unmount so the next page's header doesn't
      // inherit this chat's "scrolled" bg.
      setHeaderIsScrolled(false);
    };
  }, [containerRef, messagesLength, discussionId, disabled]);
}
