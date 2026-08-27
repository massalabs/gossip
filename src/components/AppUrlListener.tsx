import { logger } from '../utils/logger.ts';
import { useEffect, useRef } from 'react';
import { Capacitor, PluginListenerHandle } from '@capacitor/core';
import { App, URLOpenListenerEvent } from '@capacitor/app';
import { LocalNotifications } from '@capacitor/local-notifications';
import { useNavigate } from 'react-router-dom';
import { extractInvitePath, tryParseInvite } from '../utils/invite';
import { useAppStore } from '../stores/appStore';
import { ROUTES } from '../constants/routes';

export const AppUrlListener: React.FC = () => {
  const navigate = useNavigate();
  const setPendingDeepLinkInfo = useAppStore(s => s.setPendingDeepLinkInfo);
  const setPendingSharedContent = useAppStore(s => s.setPendingSharedContent);

  // Keep changing values in refs so the mount-only effect below can read the
  // latest ones without re-registering native listeners. `navigate` gets a new
  // identity on every route change in react-router 7, so depending on it
  // directly would add a duplicate native listener per navigation.
  const navigateRef = useRef(navigate);
  const setPendingDeepLinkInfoRef = useRef(setPendingDeepLinkInfo);
  const setPendingSharedContentRef = useRef(setPendingSharedContent);

  useEffect(() => {
    navigateRef.current = navigate;
    setPendingDeepLinkInfoRef.current = setPendingDeepLinkInfo;
    setPendingSharedContentRef.current = setPendingSharedContent;
  });

  useEffect(() => {
    if (!Capacitor.isNativePlatform()) {
      return;
    }

    // Listeners registered by this effect run; cleanup removes exactly these.
    const handles: PluginListenerHandle[] = [];
    let cancelled = false;

    const trackHandle = (handle: PluginListenerHandle) => {
      if (cancelled) {
        // Cleanup already ran before registration resolved - remove immediately
        void handle.remove();
      } else {
        handles.push(handle);
      }
    };

    const handleAppUrlOpen = async (event: URLOpenListenerEvent) => {
      try {
        const url = event.url;

        // Handle iOS share extension: gossip://share?text=...
        if (url.startsWith('gossip://share')) {
          try {
            const urlObj = new URL(url);
            const sharedText = urlObj.searchParams.get('text');
            if (sharedText) {
              setPendingSharedContentRef.current(sharedText);
              navigateRef.current(ROUTES.discussions(), { replace: true });
              return;
            }
          } catch (parseError) {
            logger.error(
              'Failed to parse shared content URL from appUrlOpen:',
              parseError
            );
          }
        }

        const invitePath = extractInvitePath(url);
        if (!invitePath) return;

        const parsed = tryParseInvite(url);
        if (!parsed) {
          logger.error('Failed to parse invite from app URL:', url);
          return;
        }
        await setPendingDeepLinkInfoRef.current(parsed);

        // Reset browser history URL so React Router can control navigation
        window.history.replaceState(null, '', '/');
      } catch (err) {
        logger.error('Failed to handle appUrlOpen event:', err);
      }
    };

    /**
     * Set up native notification action listener (Capacitor LocalNotifications)
     * Handles taps on native notifications and navigates to the appropriate view.
     * Also dismisses the notification when clicked.
     */
    const setupNativeNotificationListener = async () => {
      try {
        const handle = await LocalNotifications.addListener(
          'localNotificationActionPerformed',
          async event => {
            try {
              // Dismiss the notification when clicked
              const notificationId = event.notification.id;
              if (notificationId !== undefined && notificationId !== null) {
                await LocalNotifications.cancel({
                  notifications: [{ id: notificationId }],
                });
              }

              const extra = event.notification.extra as
                | { url?: string; contactUserId?: string }
                | undefined;

              let targetUrl = '/discussions';

              if (extra?.url) {
                targetUrl = extra.url;
              } else if (extra?.contactUserId) {
                targetUrl = `/discussion/${extra.contactUserId}`;
              }

              navigateRef.current(targetUrl, { replace: true });
            } catch (err) {
              logger.error('Failed to handle native notification action:', err);
            }
          }
        );

        trackHandle(handle);
      } catch (err) {
        logger.error(
          'Failed to setup native notification action listener:',
          err
        );
      }
    };

    void setupNativeNotificationListener();

    // Restore OS deep link handling via appUrlOpen
    App.addListener('appUrlOpen', handleAppUrlOpen)
      .then(trackHandle)
      .catch(err => {
        logger.error('Failed to setup appUrlOpen listener:', err);
      });

    return () => {
      cancelled = true;
      for (const handle of handles) {
        handle.remove().catch(err => {
          // Swallow cleanup errors to avoid unmount crashes
          logger.warn('Cleanup error:', err);
        });
      }
      handles.length = 0;
    };
    // Empty dependency array - set up once on mount only; the handlers read
    // the latest navigate/store setters via refs.
  }, []);

  return null;
};
