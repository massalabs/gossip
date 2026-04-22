import { useEffect, RefObject } from 'react';
import { useUiStore } from '../stores/uiStore';

function findScrollContainer(
  containerRef: RefObject<HTMLElement | null>
): HTMLElement | null {
  const container = containerRef.current?.querySelector(
    '.scroll-container'
  ) as HTMLElement;

  if (container) return container;

  const allElements = containerRef.current?.querySelectorAll('*');
  if (allElements) {
    for (const el of Array.from(allElements)) {
      const htmlEl = el as HTMLElement;
      const style = window.getComputedStyle(htmlEl);
      if (
        (style.overflowY === 'auto' || style.overflowY === 'scroll') &&
        htmlEl.scrollHeight > htmlEl.clientHeight
      ) {
        return htmlEl;
      }
    }
  }
  return null;
}

export function useHeaderScrollDetection(
  containerRef: RefObject<HTMLElement | null>,
  messagesLength: number,
  discussionId: string | number | undefined,
  disabled?: boolean
) {
  useEffect(() => {
    if (disabled) return;
    if (!containerRef.current) return;

    let scrollContainer: HTMLElement | null = null;
    let rafId: number | null = null;
    const setHeaderIsScrolled = useUiStore.getState().setHeaderIsScrolled;

    const handleScroll = () => {
      if (!scrollContainer) return;
      if (rafId !== null) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        setHeaderIsScrolled(scrollContainer!.scrollTop > 0);
        rafId = null;
      });
    };

    const timeoutId = setTimeout(() => {
      scrollContainer = findScrollContainer(containerRef);
      if (scrollContainer) {
        setHeaderIsScrolled(scrollContainer.scrollTop > 0);
        scrollContainer.addEventListener('scroll', handleScroll, {
          passive: true,
        });
      }
    }, 100);

    return () => {
      clearTimeout(timeoutId);
      scrollContainer?.removeEventListener('scroll', handleScroll);
      if (rafId !== null) cancelAnimationFrame(rafId);
      // Reset global state on unmount so the next page's header doesn't
      // inherit this chat's "scrolled" bg.
      setHeaderIsScrolled(false);
    };
  }, [containerRef, messagesLength, discussionId, disabled]);
}
