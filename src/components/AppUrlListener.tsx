// src/components/AppUrlListener.tsx
import { useCallback, useEffect } from 'react';
import { Capacitor } from '@capacitor/core';
import { App } from '@capacitor/app';
import { extractInvitePath, parseInvite } from '../utils/qrCodeParser';
import { useAppStore } from '../stores/appStore';

// Timing constants for native app detection
const NATIVE_APP_OPEN_DELAY = 150; // Wait for DOM to be ready before triggering protocol handler
const APP_SWITCH_DETECTION_DELAY = 300; // Wait to see if native app opened before falling back to web

export const AppUrlListener: React.FC = () => {
  const setPendingDeepLinkInfo = useAppStore(s => s.setPendingDeepLinkInfo);

  const openNativeApp = useCallback(
    async (invitePath: string): Promise<boolean> => {
      const anchor = document.createElement('a');
      anchor.href = 'gossip:/' + invitePath; // Note: single slash because fullPath starts with /
      anchor.style.display = 'none';
      document.body.appendChild(anchor);
      let hasProcessed = false;

      // Wait for DOM to be ready, then attempt to open native app
      setTimeout(() => {
        anchor.click();

        // If native app opens, page will lose focus
        // If not, we fallback to processing in web app after a delay
        setTimeout(() => {
          if (!hasProcessed) {
            hasProcessed = true;
          }
          anchor.remove();
        }, APP_SWITCH_DETECTION_DELAY);
      }, NATIVE_APP_OPEN_DELAY);
      return hasProcessed;
    },
    []
  );

  const processInviteWeb = useCallback(
    async (inviteUrl: string) => {
      const invitePath = extractInvitePath(inviteUrl);
      if (!invitePath) return;

      if (!(await openNativeApp(invitePath))) {
        await setPendingDeepLinkInfo(parseInvite(invitePath));
        window.history.replaceState(null, '', '/');
      }
    },
    [openNativeApp, setPendingDeepLinkInfo]
  );

  const processInviteNative = useCallback(async () => {
    const listener = await App.addListener('appUrlOpen', async event => {
      const parsed = parseInvite(event.url);
      await setPendingDeepLinkInfo(parsed);
    });

    return () => listener.remove();
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

  return null;
};
