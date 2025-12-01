// src/components/AppUrlListener.tsx
import { useCallback, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { Capacitor, PluginListenerHandle } from '@capacitor/core';
import { App } from '@capacitor/app';
import { LocalNotifications } from '@capacitor/local-notifications';
import { useNavigate } from 'react-router-dom';
import { extractInvitePath, parseInvite } from '../utils/qrCodeParser';
import { useAppStore } from '../stores/appStore';
import { ROUTES } from '../constants/routes';

export const AppUrlListener: React.FC = () => {
  const navigate = useNavigate();
  const setPendingDeepLinkInfo = useAppStore(s => s.setPendingDeepLinkInfo);
  const navigate = useNavigate();

  const cleanupFunctionsRef = useRef<Set<() => void>>(new Set());

  const addCleanup = useCallback((cleanup: () => void) => {
    cleanupFunctionsRef.current.add(cleanup);
  }, []);

  /**
   * Process invite in web context - navigate to invite page
   */
  const handleWebInvite = useCallback(
    async (url: string) => {
      const invitePath = extractInvitePath(url);
      if (!invitePath) return;

      // Extract userId from invite path
      const match = invitePath.match(/^\/invite\/([^/#?\s]+)$/i);
      if (!match) return;

      const userId = decodeURIComponent(match[1]);

      // Navigate to invite page - it will handle the auto-open logic
      navigate(ROUTES.invite({ userId }), { replace: true });
    },
    [navigate]
  );

  /**
   * Set up native deep link listener (Capacitor appUrlOpen)
   */
  const setupNativeListener = useCallback(async () => {
    try {
      const listener: PluginListenerHandle = await App.addListener(
        'appUrlOpen',
        async event => {
          try {
            const inviteData = parseInvite(event.url);
            if (inviteData) {
              await setPendingDeepLinkInfo(inviteData);
              window.history.replaceState(null, '', '/');
            }
          } catch (err) {
            console.error('Failed to handle native appUrlOpen:', err);
          }
        }
      );

      addCleanup(() => listener.remove());
    } catch (err) {
      console.error('Failed to setup native listener:', err);
    }
  }, [setPendingDeepLinkInfo, addCleanup]);

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
    if (Capacitor.isNativePlatform()) {
      void setupNativeListener();
      void setupNativeNotificationListener();
    } else {
      void handleWebInvite(window.location.href);
    }
  }, [setupNativeListener, setupNativeNotificationListener, handleWebInvite]);

  useEffect(() => {
    return () => {
      cleanupFunctionsRef.current.forEach(fn => {
        try {
          fn();
        } catch (err) {
          // Swallow cleanup errors to avoid unmount crashes
          console.warn('Cleanup error:', err);
        }
      });

      // eslint-disable-next-line react-hooks/exhaustive-deps
      cleanupFunctionsRef.current.clear();
    };
  }, []);

  return null;
};
