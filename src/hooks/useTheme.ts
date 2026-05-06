import { useCallback } from 'react';
import { useUiStore } from '../stores/uiStore';
import { Theme } from '../stores/uiStore';
import {
  applyResolvedThemeToDocument,
  resolveTheme,
} from '../utils/themeUtils';
import { initStatusBar } from './useCapacitorBarColors';

// Store the media query listener cleanup function
let mediaQueryListener: ((event: MediaQueryListEvent) => void) | null = null;
let mediaQuery: MediaQueryList | null = null;

/**
 * Sync resolved theme + DOM when preference is "system" (OS theme changes).
 * User theme changes go through uiStore.setTheme (also updates DOM).
 */
const applySystemResolvedTheme = (theme: Theme) => {
  const resolved = resolveTheme(theme);
  useUiStore.getState().setResolvedTheme(resolved);
  applyResolvedThemeToDocument(resolved);
};

/**
 * Handle system theme changes
 * Updates the theme when system preference changes (only if theme is set to 'system')
 */
const handleSystemThemeChange = () => {
  const theme = useUiStore.getState().theme;
  if (theme === 'system') {
    applySystemResolvedTheme(theme);
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

    // Clean up existing media query listener if it exists
    if (mediaQueryListener && mediaQuery) {
      mediaQuery.removeEventListener('change', mediaQueryListener);
      mediaQueryListener = null;
      mediaQuery = null;
    }

    // Initialize system theme listener
    initSystemThemeListener();

    // First paint before persist rehydrate may still use default theme; sync DOM once.
    applySystemResolvedTheme(useUiStore.getState().theme);

    // User theme changes update DOM in uiStore.setTheme. Only re-wire OS listener here.
    const unsubscribe = useUiStore.subscribe((state, prevState) => {
      if (state.theme !== prevState.theme) {
        if (state.theme === 'system' || prevState.theme === 'system') {
          initSystemThemeListener();
        }
      }
    });

    return () => {
      unsubscribe();
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
