// src/components/AppUrlListener.tsx
import { useCallback, useEffect, useState } from 'react';
import { Capacitor, PluginListenerHandle } from '@capacitor/core';
import { App } from '@capacitor/app';
import { extractInvitePath, parseInvite } from '../utils/qrCodeParser';
import { useAppStore } from '../stores/appStore';

// Timing constants for native app detection
const NATIVE_APP_OPEN_DELAY = 150; // Wait for DOM to be ready before triggering protocol handler
const APP_SWITCH_DETECTION_DELAY = 300; // Wait to see if native app opened before falling back to web

export const AppUrlListener: React.FC = () => {
  const setPendingDeepLinkInfo = useAppStore(s => s.setPendingDeepLinkInfo);
  const [listeners, setListeners] = useState<NodeJS.Timeout[]>([]);
  const [capacitorListener, setCapacitorListener] = useState<
    PluginListenerHandle[]
  >([]);

  const openNativeApp = useCallback(
    async (invitePath: string): Promise<boolean> => {
      return new Promise<boolean>(resolve => {
        const anchor = document.createElement('a');
        anchor.href = 'gossip:/' + invitePath; // Note: single slash because invitePath starts with /
        anchor.style.display = 'none';
        document.body.appendChild(anchor);
        let hasProcessed = false;

        // Wait for DOM to be ready, then attempt to open native app
        const timeout = setTimeout(() => {
          anchor.click();

          // If native app opens, page will lose focus
          // If not, we fallback to processing in web app after a delay
          const timeout2 = setTimeout(() => {
            if (!hasProcessed) {
              hasProcessed = true;
            }
            anchor.remove();
            resolve(hasProcessed);
          }, APP_SWITCH_DETECTION_DELAY);

          setListeners(prev => [...prev, timeout2]);
        }, NATIVE_APP_OPEN_DELAY);

        setListeners(prev => [...prev, timeout]);
      });
    },

    []
  );

  const processInviteWeb = useCallback(
    async (inviteUrl: string) => {
      const invitePath = extractInvitePath(inviteUrl);
      if (!invitePath) return;

      if (!(await openNativeApp(invitePath))) {
        try {
          await setPendingDeepLinkInfo(parseInvite(invitePath));
          window.history.replaceState(null, '', '/');
        } catch (error) {
          const errorMessage =
            error instanceof Error
              ? error.message
              : 'Unknown error processing invite';

          console.error('Failed to process invite:', errorMessage);
        }
      }
    },
    [openNativeApp, setPendingDeepLinkInfo]
  );

  const processInviteNative = useCallback(async () => {
    const listener = await App.addListener('appUrlOpen', async event => {
      const parsed = parseInvite(event.url);
      await setPendingDeepLinkInfo(parsed);
    });

    setCapacitorListener(prev => [...prev, listener]);
  }, [setPendingDeepLinkInfo]);

  /**
   * Web: Process invite URLs on initial load (unless already handled by first effect)
   * Native: Listen for app URL open events (deep links)
   */
  useEffect(() => {
    if (Capacitor.isNativePlatform()) {
      processInviteNative();
    }

    void processInviteWeb(window.location.href);
  }, [processInviteNative, processInviteWeb]);

  useEffect(() => {
    return () => {
      listeners.forEach(listener => clearTimeout(listener));
      capacitorListener.forEach(listener => listener.remove());
    };
  }, [listeners, capacitorListener]);

  return null;
};
