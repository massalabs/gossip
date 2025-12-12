import React, { useEffect, useRef, useState, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Capacitor } from '@capacitor/core';
import { parseInvite } from '../utils/qrCodeParser';
import { useAppStore } from '../stores/appStore';
import Button from '../components/ui/Button';
import PageHeader from '../components/ui/PageHeader';
import HeaderWrapper from '../components/ui/HeaderWrapper';
import { PrivacyGraphic } from '../components/graphics';
import {
  GOOGLE_PLAY_STORE_URL,
  APPLE_APP_STORE_URL,
  LAST_APK_GITHUB_URL,
} from '../constants/links';
import { ChevronRight, GitHub, Smartphone } from 'react-feather';
import toast from 'react-hot-toast';

// Timing constants
const NATIVE_APP_OPEN_DELAY = 150; // Wait for DOM ready + layout
const APP_SWITCH_DETECTION_DELAY = 300; // Time to detect if native app took over

export const InvitePage: React.FC = () => {
  const { userId } = useParams<{ userId: string }>();
  const navigate = useNavigate();
  const setPendingDeepLinkInfo = useAppStore(s => s.setPendingDeepLinkInfo);
  const [isOpeningApp, setIsOpeningApp] = useState(false);
  const [appOpenFailed, setAppOpenFailed] = useState(false);
  const cleanupFunctionsRef = useRef<Set<() => void>>(new Set());

  const addCleanup = useCallback((cleanup: () => void) => {
    cleanupFunctionsRef.current.add(cleanup);
  }, []);

  useEffect(() => {
    if (!userId) {
      toast.error('Invalid invite');
      navigate('/');
    }
  }, [userId, navigate]);

  /**
   * Attempts to open the native app via button click.
   * Returns a Promise that resolves to true if the native app successfully opened
   * (detected via visibility change), or false if the app failed to open within the detection timeout.
   */
  const tryOpenNativeApp = useCallback(
    (invitePath: string): Promise<boolean> => {
      return new Promise<boolean>(resolve => {
        // Cancel any pending timers/listeners from previous attempts to
        // avoid accumulating cleanup functions and duplicated side effects.
        const existingCleanups = cleanupFunctionsRef.current;
        existingCleanups.forEach(fn => {
          try {
            fn();
          } catch (err) {
            console.warn('Cleanup error before new native open attempt:', err);
          }
        });
        existingCleanups.clear();

        const anchor = document.createElement('a');
        anchor.href = `gossip://${invitePath.slice(1)}`;
        anchor.style.display = 'none';
        anchor.rel = 'noopener noreferrer';
        document.body.appendChild(anchor);

        let resolved = false;

        const performCleanup = () => {
          if (resolved) return;
          resolved = true;
          anchor.remove();
          resolve(false);

          // Run and clear any registered cleanup functions so that
          // visibility listeners and timers are removed even when the
          // fallback timeout fires (no visibilitychange event).
          const cleanups = cleanupFunctionsRef.current;
          cleanups.forEach(fn => {
            try {
              fn();
            } catch (err) {
              console.warn('Cleanup error after native open attempt:', err);
            }
          });
          cleanups.clear();
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

        addCleanup(() => clearTimeout(openTimer));
        addCleanup(() => {
          if (!resolved) {
            anchor.remove();
          }
        });
      });
    },
    [addCleanup]
  );

  /**
   * Handle opening in native app
   */
  const handleOpenInApp = useCallback(async () => {
    if (!userId) return;

    setIsOpeningApp(true);
    const invitePath = `/invite/${userId}`;
    const opened = await tryOpenNativeApp(invitePath);

    if (opened) {
      // App opened successfully - user will be switched to the app
      // No need to show any UI as they won't see this page
    } else {
      setIsOpeningApp(false);
      setAppOpenFailed(true);
      toast.error(
        'Could not open the app. You can continue in the web app instead.'
      );
    }
  }, [userId, tryOpenNativeApp]);

  /**
   * Handle continuing in web app
   */
  const handleContinueInWeb = useCallback(async () => {
    if (!userId) return;

    try {
      const inviteData = parseInvite(`/invite/${userId}`);
      await setPendingDeepLinkInfo(inviteData);
      navigate('/');
    } catch (err) {
      console.error('Failed to process invite:', err);
    }
  }, [userId, setPendingDeepLinkInfo, navigate]);

  /**
   * Handle install from iOS App Store
   */
  const handleInstallIOS = useCallback(() => {
    window.open(APPLE_APP_STORE_URL, '_blank');
  }, []);

  /**
   * Handle install from Google Play Store
   */
  const handleInstallAndroid = useCallback(() => {
    window.open(GOOGLE_PLAY_STORE_URL, '_blank');
  }, []);

  /**
   * Handle download APK directly
   */
  const handleDownloadAPK = useCallback(() => {
    window.open(LAST_APK_GITHUB_URL, '_blank');
  }, []);

  // Auto-click the "Open in App" button on mount
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) {
      const timer = setTimeout(() => {
        handleOpenInApp();
      }, NATIVE_APP_OPEN_DELAY);

      return () => clearTimeout(timer);
    }
  }, [handleOpenInApp]);

  // Cleanup on unmount
  useEffect(() => {
    const cleanupFunctions = cleanupFunctionsRef.current;
    return () => {
      cleanupFunctions.forEach(fn => {
        try {
          fn();
        } catch (err) {
          console.warn('Cleanup error:', err);
        }
      });
      cleanupFunctions.clear();
    };
  }, []);

  return (
    <div className="min-h-screen bg-background">
      <HeaderWrapper>
        <PageHeader title="Invite" onBack={() => navigate('/')} />
      </HeaderWrapper>
      <div className="flex flex-col items-center justify-center px-6 py-8 sm:py-12 max-w-lg mx-auto">
        <div className="w-full space-y-6 animate-fade-in">
          {/* Hero Section */}
          <div className="bg-card border border-border rounded-2xl p-8 sm:p-10 text-center shadow-sm">
            <div className="mb-6 -mx-4 sm:-mx-6">
              <PrivacyGraphic size={120} className="py-4" />
            </div>
            <h2 className="text-2xl sm:text-3xl font-semibold text-foreground mb-3">
              You've been invited!
            </h2>
            <p className="text-muted-foreground text-base mb-8">
              Open this invite in the Gossip app to start chatting with your
              contact.
            </p>

            {/* Primary Actions */}
            <div className="space-y-3 mb-6">
              <Button
                onClick={handleOpenInApp}
                disabled={isOpeningApp}
                loading={isOpeningApp}
                variant={appOpenFailed ? 'outline' : 'primary'}
                fullWidth
                size="lg"
                className="font-semibold rounded-full"
              >
                {isOpeningApp ? 'Opening...' : 'Open in App'}
              </Button>

              <Button
                onClick={handleContinueInWeb}
                variant={appOpenFailed ? 'primary' : 'outline'}
                fullWidth
                size="lg"
                className="rounded-full"
              >
                Continue in Web App
              </Button>
            </div>
          </div>

          {/* Install Section */}
          <div className="bg-card border border-border rounded-2xl p-6 sm:p-8 shadow-sm">
            <div className="text-center mb-6">
              <h3 className="text-lg font-semibold text-foreground mb-2">
                Don't have the app?
              </h3>
              <p className="text-sm text-muted-foreground">
                Install Gossip to get the best experience
              </p>
            </div>

            <div className="space-y-3">
              <Button
                onClick={handleInstallIOS}
                variant="ghost"
                fullWidth
                size="lg"
                className="justify-start gap-3 hover:bg-accent/50"
              >
                <Smartphone className="w-6 h-6" />
                <span className="flex-1 text-left">Install for iOS</span>
                <ChevronRight className="w-5 h-5 text-muted-foreground" />
              </Button>

              <Button
                onClick={handleInstallAndroid}
                variant="ghost"
                fullWidth
                size="lg"
                className="justify-start gap-3 hover:bg-accent/50"
              >
                <Smartphone className="w-6 h-6" />
                <span className="flex-1 text-left">Install for Android</span>
                <ChevronRight className="w-5 h-5 text-muted-foreground" />
              </Button>

              <Button
                onClick={handleDownloadAPK}
                variant="ghost"
                fullWidth
                size="lg"
                className="justify-start gap-3 hover:bg-accent/50"
              >
                <GitHub className="w-6 h-6" />
                <span className="flex-1 text-left">Download Last Release</span>
                <ChevronRight className="w-5 h-5 text-muted-foreground" />
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
