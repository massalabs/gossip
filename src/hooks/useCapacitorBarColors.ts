import { Capacitor, SystemBars, SystemBarsStyle } from '@capacitor/core';
import { useUiStore } from '../stores/uiStore';

// Inject safe area insets as CSS variables

export const initStatusBar = async () => {
  if (!Capacitor.isNativePlatform()) return;

  const updateStyle = async (theme: 'light' | 'dark') => {
    const style =
      theme === 'dark' ? SystemBarsStyle.Dark : SystemBarsStyle.Light;
    await SystemBars.setStyle({ style });
  };

  await updateStyle(useUiStore.getState().resolvedTheme);

  useUiStore.subscribe((state, prevState) => {
    if (state.resolvedTheme !== prevState.resolvedTheme) {
      updateStyle(state.resolvedTheme);
    }
  });
};
