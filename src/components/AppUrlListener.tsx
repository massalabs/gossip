// src/components/AppUrlListener.tsx
import { useCallback, useEffect, useRef } from 'react';
import { Capacitor, PluginListenerHandle } from '@capacitor/core';
import { App } from '@capacitor/app';
import { extractInvitePath, parseInvite } from '../utils/qrCodeParser';
import { useAppStore } from '../stores/appStore';

// Timing constants
const NATIVE_APP_OPEN_DELAY = 150; // Wait for DOM ready + layout
const APP_SWITCH_DETECTION_DELAY = 300; // Time to detect if native app took over

export const AppUrlListener: React.FC = () => {
  const setPendingDeepLinkInfo = useAppStore(s => s.setPendingDeepLinkInfo);

  const cleanupFunctionsRef = useRef<Set<() => void>>(new Set());

  const addCleanup = useCallback((cleanup: () => void) => {
    cleanupFunctionsRef.current.add(cleanup);
  }, []);

  /**
   * Attempts to open the native app via hidden <a> tag click.
   * Returns true if native app likely opened, false if we should fall back to web flow.
   */
  const tryOpenNativeApp = useCallback(
    (invitePath: string): Promise<boolean> => {
      return new Promise<boolean>(resolve => {
        const anchor = document.createElement('a');
        anchor.href = `gossip://${invitePath.slice(1)}`;
        anchor.style.display = 'none';
        anchor.rel = 'noopener noreferrer'; // Security best practice
        document.body.appendChild(anchor);

        let resolved = false;

        const performCleanup = () => {
          if (resolved) return;
          resolved = true;
          anchor.remove();
          resolve(false);
        };

        const openTimer = setTimeout(() => {
          if (resolved) return;
          anchor.click();

          const fallbackTimer = setTimeout(() => {
            performCleanup();
          }, APP_SWITCH_DETECTION_DELAY);

          const onVisibilityChange = () => {
            if (document.hidden && !resolved) {
              clearTimeout(fallbackTimer);
              resolved = true;
              anchor.remove();
              resolve(true);
              document.removeEventListener(
                'visibilitychange',
                onVisibilityChange
              );
            }
          };

          document.addEventListener('visibilitychange', onVisibilityChange);
          addCleanup(() =>
            document.removeEventListener('visibilitychange', onVisibilityChange)
          );
          addCleanup(() => clearTimeout(fallbackTimer));
        }, NATIVE_APP_OPEN_DELAY);

        // Register all cleanups
        addCleanup(() => clearTimeout(openTimer));
        addCleanup(() => {
          if (!resolved) {
            anchor.remove();
          }
        });
        addCleanup(performCleanup);
      });
    },
    [addCleanup]
  );

  /**
   * Process invite in web context (fallback when native app not available)
   */
  const handleWebInvite = useCallback(
    async (url: string) => {
      const invitePath = extractInvitePath(url);
      if (!invitePath) return;

      const nativeOpened = await tryOpenNativeApp(invitePath);
      if (nativeOpened) return; // Native app took over

      // Fallback: process in web app
      try {
        const inviteData = parseInvite(invitePath);
        await setPendingDeepLinkInfo(inviteData);
        window.history.replaceState(null, '', '/');
      } catch (err) {
        console.error('Failed to process invite in web fallback:', err);
      }
    },
    [tryOpenNativeApp, setPendingDeepLinkInfo]
  );

  /**
   * Set up native deep link listener (Capacitor)
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

  useEffect(() => {
    if (Capacitor.isNativePlatform()) {
      void setupNativeListener();
    } else {
      void handleWebInvite(window.location.href);
    }
  }, [setupNativeListener, handleWebInvite]);

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
