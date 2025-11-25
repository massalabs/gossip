import { useCallback, useEffect } from 'react';
import { Capacitor } from '@capacitor/core';
import { App } from '@capacitor/app';
import { parseInvite } from '../utils/qrCodeParser';
import { useAppStore } from '../stores/appStore';

export const AppUrlListener = () => {
  const setPendingDeepLinkInfo = useAppStore(s => s.setPendingDeepLinkInfo);
  const processInvite = useCallback(
    async (invitePath: string) => {
      if (!invitePath) return;
      try {
        await setPendingDeepLinkInfo(parseInvite(invitePath));
      } catch (error) {
        console.error('Error parsing invite:', error);
      }
    },
    [setPendingDeepLinkInfo]
  );

  useEffect(() => {
    if (!Capacitor.isNativePlatform()) {
      const url = window.location.href;
      if (url.includes('/invite/')) {
        processInvite(url).then(() => {
          window.history.replaceState(null, '', '/');
        });
      }
      return;
    }

    // Native platform: add listener and return cleanup function
    App.addListener(
      'appUrlOpen',
      async event => await processInvite(event.url)
    );

    // Return cleanup function from useEffect, not from async function
    return () => {
      App.removeAllListeners();
    };
  }, [processInvite]);

  return null;
};
