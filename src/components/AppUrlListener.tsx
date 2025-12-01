// src/components/AppUrlListener.tsx
import { useCallback, useEffect, useRef } from 'react';
import { Capacitor, PluginListenerHandle } from '@capacitor/core';
import { App, URLOpenListenerEvent } from '@capacitor/app';
import { LocalNotifications } from '@capacitor/local-notifications';
import { useNavigate } from 'react-router-dom';
import { extractInvitePath, parseInvite } from '../utils/qrCodeParser';
import { useAppStore } from '../stores/appStore';

export const AppUrlListener: React.FC = () => {
  const setPendingDeepLinkInfo = useAppStore(s => s.setPendingDeepLinkInfo);
  const navigate = useNavigate();

  const cleanupFunctionsRef = useRef<Set<() => void>>(new Set());

  const addCleanup = useCallback((cleanup: () => void) => {
    cleanupFunctionsRef.current.add(cleanup);
  }, []);

  const handleAppUrlOpen = useCallback(
    async (event: URLOpenListenerEvent) => {
      try {
        const invitePath = extractInvitePath(event.url);
        if (invitePath) {
          await setPendingDeepLinkInfo(parseInvite(invitePath));
          window.history.replaceState(null, '', '/');
        }
      } catch (err) {
        console.error('Failed to handle appUrlOpen:', err);
      }
    },
    [setPendingDeepLinkInfo]
  );

  /**
   * Set up native deep link listener (Capacitor appUrlOpen)
   */
  const setupNativeListener = useCallback(async () => {
    try {
      const listener: PluginListenerHandle = await App.addListener(
        'appUrlOpen',
        handleAppUrlOpen
      );

      addCleanup(() => listener.remove());
    } catch (err) {
      console.error('Failed to setup native listener:', err);
    }
  }, [handleAppUrlOpen, addCleanup]);

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
    }
  }, [setupNativeListener, setupNativeNotificationListener]);

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
