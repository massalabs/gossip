import { useEffect, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { App } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';
import { useAccountStore } from '../stores/accountStore';
import { useAppStore } from '../stores/appStore';
import {
  setPendingDeepLink,
  getPendingDeepLink,
} from '../utils/deepLinkStorage';

/**
 * Only handles cases that routes can't:
 * 1. Initial page load with /add/{userId} in pathname (from Netlify redirect)
 * 2. Native app deep links (Capacitor)
 * 3. Redirect param after authentication
 *
 * Routes handle everything else:
 * - /add/:userId when authenticated → redirects to /new-contact
 * - /add/:userId when unauthenticated → redirects to /welcome?redirect=/add/...
 */
export const DeepLinkHandler: React.FC = () => {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { userProfile } = useAccountStore();
  const { isInitialized } = useAppStore();
  const initialPathProcessedRef = useRef(false);
  const redirectProcessedRef = useRef<string | null>(null);

  // Handle initial page load with /add/{userId} in pathname (from Netlify redirect)
  // Only process once on mount if pathname contains /add/
  useEffect(() => {
    // Only process if we haven't already processed the initial pathname
    if (initialPathProcessedRef.current) {
      return;
    }

    const pathname = window.location.pathname;
    if (!pathname.includes('/add/')) {
      initialPathProcessedRef.current = true; // Mark as processed even if no deep link
      return; // No deep link in pathname, nothing to do
    }

    // Extract userId from pathname
    const match = pathname.match(/\/add\/([^/?]+)/);
    if (!match) {
      initialPathProcessedRef.current = true;
      return;
    }

    const userId = match[1];

    // Extract name from query string (window.location.search) or from hash (HashRouter)
    let name: string | null = null;

    // Check regular search params first
    if (window.location.search) {
      const urlParams = new URLSearchParams(window.location.search);
      name = urlParams.get('name');
    }

    // Also check hash for HashRouter (format: #/add/{userId}?name={name})
    if (!name) {
      const hash = window.location.hash.replace('#', '');
      const hashParts = hash.split('?');
      if (hashParts.length > 1) {
        const hashParams = new URLSearchParams(hashParts[1]);
        name = hashParams.get('name');
      }
    }

    // Decode name if found
    if (name) {
      try {
        name = decodeURIComponent(name);
      } catch (e) {
        console.warn('[DeepLinkHandler] Failed to decode name:', e);
      }
    }

    console.log('[DeepLinkHandler] Extracted from URL:', {
      pathname,
      search: window.location.search,
      hash: window.location.hash,
      userId,
      name,
    });

    // Clean up URL immediately
    const newUrl = `${window.location.origin}${window.location.pathname.replace(/\/add\/.*$/, '') || '/'}`;
    window.history.replaceState(null, '', newUrl);

    // If authenticated, navigate to route (which will handle redirect)
    if (userProfile) {
      navigate(
        `/add/${userId}${name ? `?name=${encodeURIComponent(name)}` : ''}`,
        {
          replace: true,
        }
      );
      initialPathProcessedRef.current = true;
    } else if (isInitialized) {
      // If not authenticated but initialized, store deep link and redirect to welcome
      const deepLinkPath = `/add/${userId}${name ? `?name=${encodeURIComponent(name)}` : ''}`;
      console.log(
        '[DeepLinkHandler] Storing deep link for unauthenticated user:',
        {
          deepLinkPath,
          isNative: Capacitor.isNativePlatform(),
        }
      );

      // Always store in Preferences first (works for both native and web)
      void setPendingDeepLink(deepLinkPath)
        .then(() => {
          console.log(
            '[DeepLinkHandler] Successfully stored in Preferences:',
            deepLinkPath
          );
        })
        .catch(error => {
          console.error(
            '[DeepLinkHandler] Failed to store in Preferences:',
            error
          );
        });

      // Then navigate with URL params (for web) or without (for native)
      if (Capacitor.isNativePlatform()) {
        navigate('/welcome', { replace: true });
      } else {
        // Double-encode the redirect to preserve query params in the redirect URL
        // The redirect URL itself contains query params: /add/{userId}?name={name}
        // So we need to encode it so it can be passed as a query param value
        const encodedRedirect = encodeURIComponent(deepLinkPath);
        const redirectUrl = `/welcome?redirect=${encodedRedirect}`;
        console.log(
          '[DeepLinkHandler] Navigating to welcome with redirect param:',
          {
            deepLinkPath,
            encodedRedirect,
            redirectUrl,
          }
        );
        navigate(redirectUrl, {
          replace: true,
        });
      }
      initialPathProcessedRef.current = true;
    }
    // If in onboarding (not initialized), wait - it will be processed after authentication
    // Don't mark as processed yet, so we can handle it when isInitialized becomes true
  }, [navigate, userProfile, isInitialized]);

  // Handle case where isInitialized changes from false to true (after onboarding)
  // and we have a pending deep link in the pathname
  useEffect(() => {
    if (!isInitialized || initialPathProcessedRef.current) {
      return;
    }

    const pathname = window.location.pathname;
    if (!pathname.includes('/add/')) {
      initialPathProcessedRef.current = true;
      return;
    }

    const match = pathname.match(/\/add\/([^/?]+)(?:\?name=([^&]+))?/);
    if (!match) {
      initialPathProcessedRef.current = true;
      return;
    }

    const userId = match[1];
    const name = match[2] ? decodeURIComponent(match[2]) : null;
    const deepLinkPath = `/add/${userId}${name ? `?name=${encodeURIComponent(name)}` : ''}`;

    // Clean up URL
    const newUrl = `${window.location.origin}${window.location.pathname.replace(/\/add\/.*$/, '') || '/'}`;
    window.history.replaceState(null, '', newUrl);

    if (Capacitor.isNativePlatform()) {
      // Store in Capacitor Preferences for native (survives app kill)
      void setPendingDeepLink(deepLinkPath).then(() => {
        navigate('/welcome', { replace: true });
        initialPathProcessedRef.current = true;
      });
    } else {
      // Use URL params for web (stateless) + store in Preferences as backup
      void setPendingDeepLink(deepLinkPath).then(() => {
        navigate(`/welcome?redirect=${encodeURIComponent(deepLinkPath)}`, {
          replace: true,
        });
        initialPathProcessedRef.current = true;
      });
    }
  }, [isInitialized, navigate]);

  // Handle pending deep link after authentication
  // Checks both URL params (web) and Capacitor Preferences (native)
  useEffect(() => {
    // Only process when user is authenticated
    if (!userProfile) {
      redirectProcessedRef.current = null; // Reset when logged out
      return;
    }

    const processRedirect = async () => {
      let redirect: string | null = null;

      // Debug: Parse hash manually first (HashRouter stores everything in hash)
      const hash = window.location.hash.replace('#', '');
      const hashParts = hash.split('?');
      const hashParamsFromHash =
        hashParts.length > 1
          ? new URLSearchParams(hashParts[1])
          : new URLSearchParams();

      // Check hash params first (HashRouter format: #/welcome?redirect=/add/user123)
      redirect = hashParamsFromHash.get('redirect');

      // Also check useSearchParams (might work in some cases)
      if (!redirect) {
        redirect = searchParams.get('redirect');
      }

      // Also check regular search params (in case they're in pathname)
      if (!redirect && window.location.search) {
        const urlParams = new URLSearchParams(window.location.search);
        redirect = urlParams.get('redirect');
      }

      // Decode the redirect if it was encoded (may be double-encoded)
      if (redirect) {
        try {
          // Try decoding multiple times in case it's double-encoded
          let decoded = redirect;
          let previous = '';
          while (decoded !== previous) {
            previous = decoded;
            decoded = decodeURIComponent(decoded);
          }
          redirect = decoded;
          console.log('[DeepLinkHandler] Decoded redirect:', {
            original: redirect,
            decoded,
            containsName: decoded.includes('?name='),
          });
        } catch (e) {
          console.warn('[DeepLinkHandler] Failed to decode redirect:', e);
        }
      }

      // Debug: Log all possible redirect sources
      console.log('[DeepLinkHandler] Checking redirect after auth:', {
        hasUserProfile: !!userProfile,
        redirectFromHashParams: hashParamsFromHash.get('redirect'),
        redirectFromSearchParams: searchParams.get('redirect'),
        redirectFromSearch: window.location.search
          ? new URLSearchParams(window.location.search).get('redirect')
          : null,
        finalRedirect: redirect,
        currentHash: window.location.hash,
        currentPathname: window.location.pathname,
        currentSearch: window.location.search,
        fullUrl: window.location.href,
        isNative: Capacitor.isNativePlatform(),
      });

      // If no URL param, check Capacitor Preferences (works for both native and web)
      // This is a fallback in case URL params are lost during route switch
      if (!redirect) {
        try {
          redirect = await getPendingDeepLink();
          console.log('[DeepLinkHandler] Redirect from Preferences:', redirect);
        } catch (error) {
          console.error(
            '[DeepLinkHandler] Error reading from Preferences:',
            error
          );
        }
      }

      // Only process if we have a redirect and haven't processed this specific one yet
      if (redirect && redirectProcessedRef.current !== redirect) {
        console.log('[DeepLinkHandler] Processing redirect:', {
          redirect,
          containsName: redirect.includes('?name='),
        });

        // Remove redirect param from URL if present
        if (searchParams.get('redirect')) {
          const newParams = new URLSearchParams(searchParams);
          newParams.delete('redirect');
          setSearchParams(newParams, { replace: true });
        } else {
          // Also clean up from hash if it's there
          const hash = window.location.hash.replace('#', '');
          const hashParts = hash.split('?');
          if (hashParts[1]) {
            const hashParams = new URLSearchParams(hashParts[1]);
            hashParams.delete('redirect');
            const newHash =
              hashParts[0] +
              (hashParams.toString() ? `?${hashParams.toString()}` : '');
            window.history.replaceState(
              null,
              '',
              `${window.location.pathname}${newHash ? `#${newHash}` : ''}`
            );
          }
        }

        // Navigate to redirect path - make sure to preserve query params in the redirect URL
        setTimeout(() => {
          console.log('[DeepLinkHandler] Navigating to redirect:', redirect);
          // The redirect path might already contain query params, so navigate directly
          navigate(redirect!, { replace: true });
          redirectProcessedRef.current = redirect;
        }, 100); // Small delay to ensure route context is ready
      } else {
        console.log('[DeepLinkHandler] No redirect to process:', {
          hasRedirect: !!redirect,
          redirectValue: redirect,
          alreadyProcessed: redirectProcessedRef.current === redirect,
          processedValue: redirectProcessedRef.current,
        });
      }
    };

    void processRedirect();
  }, [userProfile, searchParams, setSearchParams, navigate]);

  // Handle native app deep links (Capacitor)
  useEffect(() => {
    if (Capacitor.isNativePlatform()) {
      const processDeepLink = (url: string) => {
        try {
          const urlObj = new URL(url);
          const path = urlObj.pathname + urlObj.search;
          if (path.includes('/add/')) {
            const match = path.match(/\/add\/([^/?]+)(?:\?name=([^&]+))?/);
            if (match) {
              const userId = match[1];
              const name = match[2] ? decodeURIComponent(match[2]) : null;

              if (userProfile) {
                navigate(
                  `/add/${userId}${name ? `?name=${encodeURIComponent(name)}` : ''}`,
                  { replace: true }
                );
              } else {
                const deepLinkPath = `/add/${userId}${name ? `?name=${encodeURIComponent(name)}` : ''}`;
                if (isInitialized) {
                  // Store in Capacitor Preferences for native (survives app kill)
                  // Use URL params for web (stateless)
                  if (Capacitor.isNativePlatform()) {
                    void setPendingDeepLink(deepLinkPath).then(() => {
                      navigate('/welcome', { replace: true });
                    });
                  } else {
                    // Store in Preferences as backup + use URL params
                    void setPendingDeepLink(deepLinkPath).then(() => {
                      navigate(
                        `/welcome?redirect=${encodeURIComponent(deepLinkPath)}`,
                        { replace: true }
                      );
                    });
                  }
                }
              }
            }
          }
        } catch {
          // If it's not a full URL, try using it as a path
          if (url.includes('/add/')) {
            const match = url.match(/\/add\/([^/?]+)(?:\?name=([^&]+))?/);
            if (match) {
              const userId = match[1];
              const name = match[2] ? decodeURIComponent(match[2]) : null;

              if (userProfile) {
                navigate(
                  `/add/${userId}${name ? `?name=${encodeURIComponent(name)}` : ''}`,
                  { replace: true }
                );
              } else {
                const deepLinkPath = `/add/${userId}${name ? `?name=${encodeURIComponent(name)}` : ''}`;
                if (isInitialized) {
                  // Store in Capacitor Preferences for native (survives app kill)
                  // Use URL params for web (stateless)
                  if (Capacitor.isNativePlatform()) {
                    void setPendingDeepLink(deepLinkPath).then(() => {
                      navigate('/welcome', { replace: true });
                    });
                  } else {
                    // Store in Preferences as backup + use URL params
                    void setPendingDeepLink(deepLinkPath).then(() => {
                      navigate(
                        `/welcome?redirect=${encodeURIComponent(deepLinkPath)}`,
                        { replace: true }
                      );
                    });
                  }
                }
              }
            }
          }
        }
      };

      // Handle app launched via deep link (when app was closed)
      App.getLaunchUrl()
        .then(res => {
          if (res?.url) {
            processDeepLink(res.url);
          }
        })
        .catch(() => {
          // No launch URL, app was opened normally
        });

      // Listen for deep links when app is already open
      const listenerHandle = App.addListener(
        'appUrlOpen',
        (data: { url: string }) => {
          processDeepLink(data.url);
        }
      );

      return () => {
        void listenerHandle.then(handle => handle.remove());
      };
    }
  }, [navigate, userProfile, isInitialized]);

  return null;
};
