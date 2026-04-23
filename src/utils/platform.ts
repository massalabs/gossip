import { Capacitor } from '@capacitor/core';

export const isNative = () => Capacitor.isNativePlatform();

export const isPWA = () =>
  window.matchMedia('(display-mode: standalone)').matches ||
  (window.navigator as { standalone?: boolean }).standalone === true;

export const isTouch = () => window.matchMedia('(pointer: coarse)').matches;

export type AppContext = 'native' | 'pwa' | 'browser';

export const getAppContext = (): AppContext =>
  isNative() ? 'native' : isPWA() ? 'pwa' : 'browser';
