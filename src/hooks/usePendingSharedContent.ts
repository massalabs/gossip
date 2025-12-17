import { useEffect } from 'react';
import { Capacitor } from '@capacitor/core';
import { App } from '@capacitor/app';
import { Preferences } from '@capacitor/preferences';
import { useNavigate, useLocation } from 'react-router-dom';
import { useAppStore } from '../stores/appStore';
import { ROUTES } from '../constants/routes';

const PENDING_SHARE_URL_KEY = 'pendingGossipShareUrl';

/**
 * Hook to handle pending shared content after authentication
 * Navigates to discussions page if there's pending shared content
 * The Discussions page will show a banner and handle sharing when a discussion is selected
 *
 * This hook should be called in AuthenticatedRoutes to handle shared content
 * that was received before authentication completed
 */
export const usePendingSharedContent = () => {
  const pendingSharedContent = useAppStore(s => s.pendingSharedContent);
  const setPendingSharedContent = useAppStore(s => s.setPendingSharedContent);
  const navigate = useNavigate();
  const location = useLocation();

  // Read pending shared content from native storage and push into app store
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) {
      return;
    }

    const handlePendingShare = async (rawValue: string) => {
      try {
        // Native layer may store gossip://share?text=<encodedText>; accept plain text fallback
        let decodedText = rawValue;
        try {
          const urlObj = new URL(rawValue);
          const sharedText = urlObj.searchParams.get('text');
          if (sharedText) {
            decodedText = decodeURIComponent(sharedText);
          }
        } catch {
          // rawValue was not a URL; treat as plain text
        }

        if (decodedText) {
          setPendingSharedContent(decodedText);
        }
      } catch (error) {
        console.error('Failed to process pending shared content:', error);
      }
    };

    const checkPendingShareFromStorage = async () => {
      try {
        const result = await Preferences.get({ key: PENDING_SHARE_URL_KEY });
        if (result.value) {
          // Clear it immediately after reading
          await Preferences.remove({ key: PENDING_SHARE_URL_KEY });
          await handlePendingShare(result.value);
          return true;
        }
      } catch (error) {
        console.error('Failed to check pending share from storage:', error);
      }
      return false;
    };

    // Check immediately when the hook mounts (after auth)
    void checkPendingShareFromStorage();

    // Also check when app becomes active (handles share while app is backgrounded)
    const handleAppStateChange = async (state: { isActive: boolean }) => {
      if (state.isActive) {
        await checkPendingShareFromStorage();
      }
    };

    const sub = App.addListener('appStateChange', handleAppStateChange);

    return () => {
      void sub.then(listener => listener.remove());
    };
  }, [setPendingSharedContent]);

  useEffect(() => {
    if (pendingSharedContent) {
      // Only navigate if we're not already on the discussions page to avoid redundant navigation
      if (location.pathname !== ROUTES.discussions()) {
        navigate(ROUTES.discussions(), { replace: true });
      }
    }
  }, [navigate, pendingSharedContent, location.pathname]);
};
