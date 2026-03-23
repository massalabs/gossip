import { useEffect } from 'react';
import { useTheme } from './useTheme';
import { useOnlineStore } from '../stores/useOnlineStore';
import { useScreenshotProtection } from './useScreenshotProtection';

/**
 * Initializes app-level concerns: theme, online status.
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

    return () => {
      cleanup?.();
    };
  }, [initTheme, initOnlineStore]);
}
