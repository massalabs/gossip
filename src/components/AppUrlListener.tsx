import { useCallback, useEffect } from 'react';
import { Capacitor } from '@capacitor/core';
import { App } from '@capacitor/app';
import { parseInvite } from '../utils/qrCodeParser';
import { setPendingDeepLink } from '../utils/deepLinkStorage';
import { INVITE_BASE_URL } from '../utils/qrCodeUrl';

export const AppUrlListener = () => {
  const processInvite = useCallback(async (invitePath: string) => {
    if (!invitePath) return;
    try {
      const invite = parseInvite(invitePath);
      const deepLink = `${INVITE_BASE_URL}/${invite.userId}${invite.name ? `/${invite.name}` : ''}`;

      await setPendingDeepLink(deepLink);
    } catch (error) {
      console.error('Error parsing invite:', error);
    }
  }, []);

  const handleWebUrl = useCallback(async () => {
    const url = window.location.href;
    if (url.includes('/invite/')) {
      await processInvite(url);
      window.history.replaceState(null, '', '/');
    }
  }, [processInvite]);

  useEffect(() => {
    if (!Capacitor.isNativePlatform()) {
      handleWebUrl();
    } else {
      const handler = async (event: { url: string }) => {
        await processInvite(event.url);
      };

      App.addListener('appUrlOpen', handler);
      return () => {
        App.removeAllListeners();
      };
    }
  }, [handleWebUrl, processInvite]);

  return null;
};
