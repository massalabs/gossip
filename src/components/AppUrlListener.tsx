import { useCallback, useEffect, useRef } from 'react';
import { Capacitor } from '@capacitor/core';
import { App, URLOpenListenerEvent } from '@capacitor/app';
import { LocalNotifications } from '@capacitor/local-notifications';
import { useNavigate } from 'react-router-dom';
import { extractInvitePath, parseInvite } from '../utils/qrCodeParser';
import { useAppStore } from '../stores/appStore';

export const AppUrlListener: React.FC = () => {
  const navigate = useNavigate();
  const setPendingDeepLinkInfo = useAppStore(s => s.setPendingDeepLinkInfo);

  const cleanupFunctionsRef = useRef<Set<() => void>>(new Set());

  const addCleanup = useCallback((cleanup: () => void) => {
    cleanupFunctionsRef.current.add(cleanup);
  }, []);

  /**
   * Handle OS-level deep links delivered via Capacitor appUrlOpen
   * Only processes invite URLs; actual navigation is handled by usePendingDeepLink.
   */
  const handleAppUrlOpen = useCallback(
    async (event: URLOpenListenerEvent) => {
      try {
        const invitePath = extractInvitePath(event.url);
        if (!invitePath) return;

        const parsed = parseInvite(invitePath);
        await setPendingDeepLinkInfo(parsed);

        // Reset browser history URL so React Router can control navigation
        window.history.replaceState(null, '', '/');
      } catch (err) {
        console.error('Failed to handle appUrlOpen deep link:', err);
      }
    },
    [setPendingDeepLinkInfo]
  );

  /**
   * Set up native notification action listener (Capacitor LocalNotifications)
   * Handles taps on native notifications and navigates to the appropriate view.
   */
  const setupNativeNotificationListener = useCallback(async () => {
    try {
      const handle = await LocalNotifications.addListener(
        'localNotificationActionPerformed',
        event => {
          try {
            const extra = event.notification.extra as
              | { url?: string; contactUserId?: string }
              | undefined;

            let targetUrl = '/discussions';

            if (extra?.url) {
              targetUrl = extra.url;
            } else if (extra?.contactUserId) {
              targetUrl = `/discussion/${extra.contactUserId}`;
            }

            navigate(targetUrl, { replace: true });
          } catch (err) {
            console.error('Failed to handle native notification action:', err);
          }
        }
      );

      addCleanup(() => {
        void handle.remove();
      });
    } catch (err) {
      console.error(
        'Failed to setup native notification action listener:',
        err
      );
    }
  }, [addCleanup, navigate]);

  useEffect(() => {
    if (!Capacitor.isNativePlatform()) {
      return;
    }

    void setupNativeNotificationListener();

    // Restore OS deep link handling via appUrlOpen
    const sub = App.addListener('appUrlOpen', handleAppUrlOpen);
    addCleanup(() => {
      void sub.then(listener => listener.remove());
    });

    // Empty dependency array - set up once on mount only
  }, [handleAppUrlOpen, setupNativeNotificationListener, addCleanup]);

  useEffect(() => {
    const cleanupFunctions = cleanupFunctionsRef.current;

    return () => {
      cleanupFunctions.forEach(fn => {
        try {
          fn();
        } catch (err) {
          // Swallow cleanup errors to avoid unmount crashes
          console.warn('Cleanup error:', err);
        }
      });

      cleanupFunctions.clear();
    };
  }, []);

  return null;
};
