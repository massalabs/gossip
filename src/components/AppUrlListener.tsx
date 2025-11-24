import { useEffect, useCallback, useRef } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { Capacitor } from '@capacitor/core';
import { App, URLOpenListenerEvent } from '@capacitor/app';
import { setPendingDeepLink } from '../utils/deepLinkStorage';

/**
 * Unified deep link handler that works for both web and native platforms
 *
 * Web: Handles direct navigation to URLs like https://gossip.app/invite/userId/name
 * Native: Listens for Capacitor's appUrlOpen events
 *
 * For HashRouter, URLs come in format: https://domain.com/#/invite/userId/name
 *
 * Behavior:
 * - If invite detected in URL: save deep link, clean URL, navigate to /
 * - usePendingDeepLink hook will handle navigating to /new-contact when authenticated
 */
export const AppUrlListener = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const isNative = Capacitor.isNativePlatform();
  const processedRef = useRef<string | null>(null);

  // Parse URL and extract path for navigation
  const parseUrlToPath = (urlString: string): string | null => {
    let path = '';

    try {
      const url = new URL(urlString);

      // Priority 1: Check for hash (HashRouter format)
      if (url.hash) {
        // Extract path after hash: #/invite/userId/name -> /invite/userId/name
        path = url.hash.substring(1); // Remove the #
      } else {
        // Priority 2: Use pathname (Universal link format)
        path = url.pathname;
      }
    } catch (_e) {
      // Fallback: try to extract path manually using regex
      // Look for /invite/ pattern in the URL
      const inviteMatch = urlString.match(/\/invite\/[^?#\s]+/);
      if (inviteMatch) {
        path = inviteMatch[0];
      } else {
        // Try to extract hash if present
        const hashMatch = urlString.match(/#(\/.+)/);
        if (hashMatch) {
          path = hashMatch[1];
        }
      }
    }

    // Ensure path starts with /
    if (path && !path.startsWith('/')) {
      path = '/' + path;
    }

    return path || null;
  };

  // Handle invite route: save deep link, clean URL, navigate to /
  const handleInviteRoute = useCallback(
    async (path: string) => {
      // Check if we're on an invite route: /invite/:userId/:name
      const inviteMatch = path.match(/^\/invite\/([^/]+)\/?(.*)$/);

      if (!inviteMatch) {
        return;
      }

      const [, userId, name] = inviteMatch;

      if (!userId) {
        console.log('No userId in invite route, navigating to /');
        navigate('/', { replace: true });
        return;
      }

      // Create deep link
      const deepLink = `/invite/${userId}${name ? `/${name}` : ''}`;
      const routeKey = deepLink;

      // Prevent processing the same route multiple times
      if (processedRef.current === routeKey) {
        console.log('Already processed this invite route, skipping');
        return;
      }

      processedRef.current = routeKey;

      console.log('Invite detected, saving deep link:', deepLink);
      console.log('Current URL before navigation:', window.location.href);

      // Always save deep link and navigate to / (clean URL)
      await setPendingDeepLink(deepLink);

      console.log('Navigating to / to clean URL');
      navigate('/', { replace: true });

      // Verify URL was updated after navigation
      setTimeout(() => {
        console.log('URL after navigation:', window.location.href);
        console.log('Hash after navigation:', window.location.hash);
      }, 100);
    },
    [navigate]
  );

  useEffect(() => {
    // Native: Listen for Capacitor appUrlOpen events
    if (isNative) {
      const handleAppUrlOpen = (event: URLOpenListenerEvent) => {
        console.log('App opened with URL:', event.url);
        const path = parseUrlToPath(event.url);
        if (path) {
          handleInviteRoute(path);
        }
      };

      App.addListener('appUrlOpen', handleAppUrlOpen);

      return () => {
        App.removeAllListeners();
      };
    }
  }, [isNative, handleInviteRoute]);

  // Web: Handle initial URL on page load (one-time check)
  useEffect(() => {
    if (!isNative && typeof window !== 'undefined') {
      // Check initial URL on page load
      const checkInitialUrl = () => {
        const hash = window.location.hash;
        const pathname = window.location.pathname;
        let currentPath = '';

        // Priority 1: Check hash (HashRouter format: #/invite/userId/name)
        if (hash && hash.startsWith('#/')) {
          currentPath = hash.substring(1); // Remove #, keep the /
        } else if (hash) {
          // Handle hash without leading slash
          currentPath = hash.substring(1);
          if (!currentPath.startsWith('/')) {
            currentPath = '/' + currentPath;
          }
        }
        // Priority 2: Check pathname for non-hash URLs (universal links: /invite/userId/name)
        // For HashRouter, if pathname has a route, we need to convert it to hash format
        else if (pathname && pathname !== '/') {
          currentPath = pathname;
          // Convert pathname to hash format for HashRouter
          // This handles cases where someone visits /invite/userId/name directly
          console.log('Converting pathname to hash route:', pathname);
          window.history.replaceState(null, '', `#${pathname}`);
        }

        // Check if we're on an invite route
        if (currentPath) {
          const inviteMatch = currentPath.match(/^\/invite\/([^/]+)\/?(.*)$/);
          if (inviteMatch) {
            handleInviteRoute(currentPath);
          }
        }
      };

      // Run immediately and also after a small delay to catch React Router initialization
      checkInitialUrl();
      const timeoutId = setTimeout(checkInitialUrl, 100);

      return () => clearTimeout(timeoutId);
    }
  }, [isNative, handleInviteRoute]);

  // Web: Handle route changes (HashRouter)
  // With HashRouter, location.pathname contains the route (React Router strips the #)
  useEffect(() => {
    if (!isNative) {
      // For HashRouter, location.pathname already contains the route without #
      const currentPath = location.pathname;

      // Check if we're on an invite route
      const inviteMatch = currentPath.match(/^\/invite\/([^/]+)\/?(.*)$/);

      if (inviteMatch) {
        console.log('Route change detected invite:', currentPath);
        handleInviteRoute(currentPath);
      } else {
        // Reset processed ref when not on invite route
        processedRef.current = null;
      }
    }
  }, [location.pathname, isNative, handleInviteRoute]);

  // This component doesn't render anything
  return null;
};
