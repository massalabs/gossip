import { Capacitor, SystemBars, SystemBarsStyle } from '@capacitor/core';
import { useUiStore } from '../stores/uiStore';

// Subscribe to the store only once, no matter how often initStatusBar runs
let themeSubscribed = false;

/**
 * Initialize and sync system bar style (status bar icons) with the current theme.
 * Sets light/dark icons based on the app's resolved theme.
 */
export const initStatusBar = async () => {
  if (!Capacitor.isNativePlatform()) return;

  const updateStyle = async (theme: 'light' | 'dark') => {
    const style =
      theme === 'dark' ? SystemBarsStyle.Dark : SystemBarsStyle.Light;
    await SystemBars.setStyle({ style });
  };

  await updateStyle(useUiStore.getState().resolvedTheme);

  if (themeSubscribed) return;
  themeSubscribed = true;

  useUiStore.subscribe((state, prevState) => {
    if (state.resolvedTheme !== prevState.resolvedTheme) {
      updateStyle(state.resolvedTheme);
    }
  });
};
