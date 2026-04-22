import React, {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useCallback,
} from 'react';
import { useLocation, Routes } from 'react-router-dom';
import { OverlayReadyContext } from './OverlayReadyContext';
import { ExitAnimationContext } from './ExitAnimationContext';
import { useUiStore } from '../../stores/uiStore';

// =============================================================================
// Constants
// =============================================================================

/** Max time to wait for overlay content before sliding anyway */
const READY_TIMEOUT_MS = 400;

// =============================================================================
// Component
// =============================================================================

interface AnimatedRoutesProps {
  children: React.ReactNode;
}

/** Routes that slide as overlays over the base page */
const isSlideRoute = (path: string) =>
  /^\/discussion\/[^/]+$/.test(path) ||
  path === '/self-discussion' ||
  path === '/settings/share-contact';

/**
 * Two-layer route system:
 *
 * - **Base layer**: always mounted (discussions list never unmounts).
 * - **Overlay**: discussion slides in/out on top via CSS animation.
 * - **Fade**: crossfade for non-slide routes (settings, etc.)
 */
const AnimatedRoutes: React.FC<AnimatedRoutesProps> = ({ children }) => {
  const location = useLocation();
  const prevPathRef = useRef(location.pathname);
  const setHeaderIsScrolled = useUiStore(s => s.setHeaderIsScrolled);

  const isOverlay = isSlideRoute(location.pathname);

  // Base layer: last non-overlay location
  const baseLocationRef = useRef(
    isOverlay ? { ...location, pathname: '/discussions' } : location
  );
  if (!isOverlay) {
    baseLocationRef.current = location;
  }

  // Overlay state
  const [overlayLocation, setOverlayLocation] = useState(
    isOverlay ? location : null
  );
  // Controls whether the slide animation plays (false = off-screen waiting to render)
  const [slideReady, setSlideReady] = useState(!isOverlay);
  // Skip animation when returning from a detour (instant mount)
  const [skipSlideAnim, setSkipSlideAnim] = useState(false);
  // Exit animation: keep old overlay content while animating out
  const [exitContent, setExitContent] = useState<React.ReactNode>(null);
  const overlayContentRef = useRef<React.ReactNode>(null);

  // Fade state
  const [fadeIn, setFadeIn] = useState(true);

  // Tracks when user navigates away from a slide route to a non-base page
  // (e.g. discussion → contact details). When they return, skip the slide animation.
  const detourFromSlideRef = useRef(false);

  // Ready signal from overlay content
  const readyReceivedRef = useRef(false);
  const mountTimeRef = useRef(0);

  const signalReady = useCallback(() => {
    if (readyReceivedRef.current) return;
    readyReceivedRef.current = true;

    if (import.meta.env.DEV) {
      const elapsed = performance.now() - mountTimeRef.current;
      console.log(`[AnimatedRoutes] overlay ready in ${elapsed.toFixed(0)}ms`);
    }

    setSlideReady(true);
  }, []);

  // Reset scroll-aware header state pre-paint on every route change.
  // Combined with the "first-paint no-transition" gate in PageLayout/HeaderBar,
  // this prevents the stale "scrolled" bg from animating away on return.
  useLayoutEffect(() => {
    setHeaderIsScrolled(false);
  }, [location.pathname, setHeaderIsScrolled]);

  // Route change detection
  useEffect(() => {
    const prev = prevPathRef.current;
    prevPathRef.current = location.pathname;

    if (location.pathname === prev) return;

    const entering = isSlideRoute(location.pathname);
    const leaving = isSlideRoute(prev);

    if (import.meta.env.DEV) {
      console.log('[AnimatedRoutes]', {
        prev,
        next: location.pathname,
        entering,
        leaving,
        detour: detourFromSlideRef.current,
      });
    }

    // Was the user on a slide route before this detour?
    const returningFromDetour =
      entering && !leaving && detourFromSlideRef.current;

    if (returningFromDetour) {
      detourFromSlideRef.current = false;
    }

    if (returningFromDetour) {
      // Returning to a slide route from a detour (contact details, settings, etc.)
      // → instant mount, no slide animation
      setSkipSlideAnim(true);
      setOverlayLocation(location);
      setSlideReady(true);
      setExitContent(null);
    } else if (entering) {
      // Fresh push from base: mount overlay off-screen, wait for ready signal
      setSkipSlideAnim(false);
      readyReceivedRef.current = false;
      mountTimeRef.current = performance.now();
      setOverlayLocation(location);
      setSlideReady(false);
      setExitContent(null);
    } else if (leaving) {
      const goingToBase =
        location.pathname === '/' || location.pathname === '/discussions';
      if (goingToBase) {
        // Pop back to base: slide out
        detourFromSlideRef.current = false;
        setExitContent(overlayContentRef.current);
        setOverlayLocation(null);
        setSlideReady(false);
      } else {
        // Navigating to another page (e.g. contact details): instant swap
        detourFromSlideRef.current = true;
        setOverlayLocation(null);
        setExitContent(null);
        setSlideReady(false);
      }
    } else {
      // Fade
      setOverlayLocation(null);
      setExitContent(null);
      setSlideReady(false);
      setFadeIn(false);
      requestAnimationFrame(() => setFadeIn(true));
    }
  }, [location]);

  // Safety timeout: if overlay content never signals ready, slide anyway
  useEffect(() => {
    if (!overlayLocation || slideReady) return;
    const timer = setTimeout(() => {
      if (!readyReceivedRef.current) {
        if (import.meta.env.DEV) {
          console.warn(
            `[AnimatedRoutes] ready timeout (${READY_TIMEOUT_MS}ms) — sliding anyway`
          );
        }
        readyReceivedRef.current = true;
        setSlideReady(true);
      }
    }, READY_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [overlayLocation, slideReady]);

  // Clear exit content after animation
  useEffect(() => {
    if (!exitContent) return;
    const timer = setTimeout(() => setExitContent(null), 500);
    return () => clearTimeout(timer);
  }, [exitContent]);

  // Build overlay content — wrapped in ready context
  const readyContextValue = React.useMemo(
    () => ({ signalReady }),
    [signalReady]
  );

  const overlayContent = overlayLocation ? (
    <OverlayReadyContext.Provider value={readyContextValue}>
      <Routes location={overlayLocation}>{children}</Routes>
    </OverlayReadyContext.Provider>
  ) : null;
  overlayContentRef.current = overlayContent;

  return (
    <div className="h-full relative overflow-hidden bg-background">
      {/* Base — unmounted when a slide overlay is fully displayed.
          Remounts during exit animation so the slide-out reveals content.
          State kept in stores (discussionStore, etc.); scroll position resets. */}
      {(!isOverlay || exitContent) && (
        <div
          className={`absolute inset-0 bg-background ${
            !isOverlay && !exitContent
              ? `transition-opacity duration-150 ease-in-out ${fadeIn ? 'opacity-100' : 'opacity-0'}`
              : ''
          }`}
          style={{ zIndex: 1 }}
        >
          <Routes location={baseLocationRef.current}>{children}</Routes>
        </div>
      )}

      {/* Overlay — discussion entering */}
      {overlayContent && (
        <div
          className={`absolute inset-0 ${slideReady && !skipSlideAnim ? 'animate-slide-enter-right' : ''}`}
          style={{
            willChange: skipSlideAnim ? undefined : 'transform',
            zIndex: 10,
            transform:
              slideReady || skipSlideAnim ? undefined : 'translateX(100%)',
          }}
        >
          {overlayContent}
        </div>
      )}

      {/* Exit — discussion leaving */}
      {exitContent && (
        <div
          className="absolute inset-0 animate-slide-exit-right"
          style={{ willChange: 'transform', zIndex: 10 }}
          onAnimationEnd={() => setExitContent(null)}
        >
          <ExitAnimationContext.Provider value={true}>
            {exitContent}
          </ExitAnimationContext.Provider>
        </div>
      )}
    </div>
  );
};

export default AnimatedRoutes;
