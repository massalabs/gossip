import { useEffect, useRef } from 'react';
import { Capacitor } from '@capacitor/core';
import { App } from '@capacitor/app';
import { useAppStore } from '../stores/appStore';
import { useAccountStore } from '../stores/accountStore';

/**
 * Check whether the elapsed background time warrants a lock.
 * Pure function — no side effects, easy to unit-test.
 *
 * @returns true if the app should be locked
 */
export function shouldLock(
  backgroundTimestampMs: number | null,
  nowMs: number,
  timeoutSeconds: number
): boolean {
  if (backgroundTimestampMs === null) return false;
  const elapsedSeconds = (nowMs - backgroundTimestampMs) / 1000;
  return elapsedSeconds >= timeoutSeconds;
}

/**
 * Auto-lock the app after a period of inactivity (time spent in background).
 *
 * Uses performance.now() (monotonic clock) to prevent bypass via clock changes.
 * On native: listens to Capacitor App state changes.
 * On web: listens to document visibilitychange events.
 *
 * When auto-lock triggers, it calls logout with lockedByUser: false so that
 * biometric auto-login is triggered on return (unlike manual lock).
 */
export function useAutoLock() {
  const autoLockTimeout = useAppStore(s => s.autoLockTimeout);
  const userProfile = useAccountStore(s => s.userProfile);
  const logout = useAccountStore(s => s.logout);
  const backgroundTimestampRef = useRef<number | null>(null);

  useEffect(() => {
    // Only active when user is logged in and auto-lock is enabled
    if (!userProfile || autoLockTimeout === null) return;

    const onBackground = () => {
      backgroundTimestampRef.current = performance.now();
    };

    const onForeground = () => {
      if (
        shouldLock(
          backgroundTimestampRef.current,
          performance.now(),
          autoLockTimeout
        )
      ) {
        logout({ lockedByUser: false });
      }
      backgroundTimestampRef.current = null;
    };

    if (Capacitor.isNativePlatform()) {
      // Native: use Capacitor App state change listener
      const listener = App.addListener('appStateChange', ({ isActive }) => {
        if (isActive) {
          onForeground();
        } else {
          onBackground();
        }
      });

      return () => {
        listener.then(l => l.remove());
      };
    } else {
      // Web: use document visibility change
      const handleVisibilityChange = () => {
        if (document.hidden) {
          onBackground();
        } else {
          onForeground();
        }
      };

      document.addEventListener('visibilitychange', handleVisibilityChange);
      return () => {
        document.removeEventListener(
          'visibilitychange',
          handleVisibilityChange
        );
      };
    }
  }, [autoLockTimeout, userProfile, logout]);
}
