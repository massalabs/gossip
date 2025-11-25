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
      const { userId, name } = parseInvite(invitePath);
      const deepLink = `${INVITE_BASE_URL}/${userId}/${name}}`;

      await setPendingDeepLink(deepLink);
    } catch (error) {
      console.error('Error parsing invite:', error);
    }
  }, []);

  useEffect(() => {
    const handle = async () => {
      if (!Capacitor.isNativePlatform()) {
        const url = window.location.href;
        if (url.includes('/invite/')) {
          await processInvite(url);
          window.history.replaceState(null, '', '/');
        }
      } else {
        App.addListener(
          'appUrlOpen',
          async event => await processInvite(event.url)
        );
        return () => {
          App.removeAllListeners();
        };
      }
    };
    handle();
  }, [processInvite]);

  return null;
};
