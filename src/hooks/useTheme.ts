import { useCallback } from 'react';
import { useUiStore } from '../stores/uiStore';
import { Theme } from '../stores/uiStore';
import { resolveTheme } from '../utils/themeUtils';
import { initStatusBar } from './useCapacitorBarColors';

// Store the media query listener cleanup function
let mediaQueryListener: ((event: MediaQueryListEvent) => void) | null = null;
let mediaQuery: MediaQueryList | null = null;
// Store the theme subscription cleanup function
let unsubscribeTheme: (() => void) | null = null;

/**
 * Update theme and apply it to the DOM
 */
const updateTheme = (theme: Theme) => {
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
    updateTheme(theme);
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

  const initTheme = useCallback(async () => {
    // Initialize status bar style (light/dark icons) based on theme
    await initStatusBar();

    // Clean up existing subscription if it exists
    if (unsubscribeTheme) {
      unsubscribeTheme();
      unsubscribeTheme = null;
    }

    // Clean up existing media query listener if it exists
    if (mediaQueryListener && mediaQuery) {
      mediaQuery.removeEventListener('change', mediaQueryListener);
      mediaQueryListener = null;
      mediaQuery = null;
    }

    // Initialize system theme listener
    initSystemThemeListener();

    // Get current theme from store (not from closure) to ensure we use the latest value
    const currentTheme = useUiStore.getState().theme;
    // Apply initial theme
    updateTheme(currentTheme);

    // Subscribe to theme changes from store
    unsubscribeTheme = useUiStore.subscribe((state, prevState) => {
      if (state.theme !== prevState.theme) {
        updateTheme(state.theme);
        // Re-initialize listener when theme changes to/from system
        if (state.theme === 'system' || prevState.theme === 'system') {
          initSystemThemeListener();
        }
      }
    });

    // Return cleanup function
    return () => {
      if (unsubscribeTheme) {
        unsubscribeTheme();
        unsubscribeTheme = null;
      }
      if (mediaQueryListener && mediaQuery) {
        mediaQuery.removeEventListener('change', mediaQueryListener);
        mediaQueryListener = null;
        mediaQuery = null;
      }
    };
  }, []); // Empty deps - function reads theme from store, not closure

  return {
    theme,
    setTheme,
    resolvedTheme,
    initTheme,
  };
}
