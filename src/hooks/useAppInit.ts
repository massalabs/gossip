import { useEffect } from 'react';
import { useTheme } from './useTheme';
import { useOnlineStore } from '../stores/useOnlineStore';
import { getSdk } from '../stores/sdkStore';
import { useScreenshotProtection } from './useScreenshotProtection';

/**
 * Initializes app-level concerns: theme, online status, and DB flush on background.
 */
export function useAppInit() {
  const { initTheme } = useTheme();
  const { initOnlineStore } = useOnlineStore();
  useScreenshotProtection();

  useEffect(() => {
    let cleanup: (() => void) | undefined;

    const init = async () => {
      const [themeCleanup] = await Promise.all([
        initTheme(),
        initOnlineStore(),
      ]);
      cleanup = themeCleanup;
    };

    void init();

    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        getSdk()
          .flush()
          .catch(e => console.warn('[flush] error on background:', e));
      }
    };
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      cleanup?.();
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [initTheme, initOnlineStore]);
}
