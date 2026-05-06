import { useSyncExternalStore } from 'react';
import { isNative, type AppContext } from '../utils/platform';

function subscribeMatchMedia(query: string) {
  return (onChange: () => void) => {
    const mql = window.matchMedia(query);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  };
}

function useMatchMedia(query: string): boolean {
  return useSyncExternalStore(
    subscribeMatchMedia(query),
    () => window.matchMedia(query).matches,
    () => false
  );
}

export const useIsPWA = (): boolean => {
  const standaloneDisplay = useMatchMedia('(display-mode: standalone)');
  const iosStandalone =
    (window.navigator as { standalone?: boolean }).standalone === true;
  return standaloneDisplay || iosStandalone;
};

export const useIsTouch = (): boolean => useMatchMedia('(pointer: coarse)');

export const useAppContext = (): AppContext => {
  const pwa = useIsPWA();
  if (isNative()) return 'native';
  return pwa ? 'pwa' : 'browser';
};
