import { useUiStore } from '../stores/uiStore';
import { initStatusBar } from './useCapacitorBarColors';
import { Theme } from '../stores/uiStore';
import { resolveTheme } from '../utils/themeUtils';
import { Capacitor } from '@capacitor/core';

// Store the media query listener cleanup function
let mediaQueryListener: ((event: MediaQueryListEvent) => void) | null = null;
let mediaQuery: MediaQueryList | null = null;
// Store the theme subscription cleanup function
let unsubscribeTheme: (() => void) | null = null;

/**
 * Update theme and apply it to the DOM
 */
const updateTheme = async (theme: Theme) => {
  const root = document.documentElement;
  const resolved = resolveTheme(theme);

  useUiStore.getState().setResolvedTheme(resolved);

  if (resolved === 'dark') {
    root.classList.add('dark');
  } else {
    root.classList.remove('dark');
  }
};

/**
 * Handle system theme changes
 * Updates the theme when system preference changes (only if theme is set to 'system')
 */
const handleSystemThemeChange = () => {
  const theme = useUiStore.getState().theme;
  if (theme === 'system') {
    void updateTheme(theme);
  }
};

/**
 * Initialize system theme listener
 * Sets up a listener for system theme changes
 */
const initSystemThemeListener = () => {
  // Clean up existing listener if it exists
  if (mediaQueryListener && mediaQuery) {
    mediaQuery.removeEventListener('change', mediaQueryListener);
    mediaQueryListener = null;
    mediaQuery = null;
  }

  // Only set up listener if we're in a browser environment
  if (typeof window !== 'undefined' && window.matchMedia) {
    mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    mediaQueryListener = () => handleSystemThemeChange();
    mediaQuery.addEventListener('change', mediaQueryListener);
  }
};

/**
 * React hook to access and modify theme
 */
export function useTheme() {
  const theme = useUiStore(s => s.theme);
  const resolvedTheme = useUiStore(s => s.resolvedTheme);
  const setTheme = useUiStore(s => s.setTheme);

  const initTheme = async () => {
    // Clean up existing subscription if it exists
    if (unsubscribeTheme) {
      unsubscribeTheme();
      unsubscribeTheme = null;
    }

    // Initialize system theme listener
    initSystemThemeListener();

    // Apply initial theme
    await updateTheme(theme);

    // Subscribe to theme changes from store
    unsubscribeTheme = useUiStore.subscribe((state, prevState) => {
      if (state.theme !== prevState.theme) {
        void updateTheme(state.theme);
        // Re-initialize listener when theme changes to/from system
        if (state.theme === 'system' || prevState.theme === 'system') {
          initSystemThemeListener();
        }
      }
    });

    if (Capacitor.isNativePlatform()) {
      await initStatusBar();
    }
  };

  return {
    theme,
    setTheme,
    resolvedTheme,
    initTheme,
  };
}
