import { useCallback } from 'react';
import { useUiStore } from '../stores/uiStore';
import { initStatusBar } from './useCapacitorBarColors';
import { Theme } from '../stores/uiStore';
import { resolveTheme } from '../utils/themeUtils';
import { Capacitor, PluginListenerHandle } from '@capacitor/core';
import { App } from '@capacitor/app';

// Store the media query listener cleanup function
let mediaQueryListener: ((event: MediaQueryListEvent) => void) | null = null;
let mediaQuery: MediaQueryList | null = null;
// Store the theme subscription cleanup function
let unsubscribeTheme: (() => void) | null = null;
// Store the app state listener cleanup function
let appStateListener: PluginListenerHandle | null = null;
// Store the visibility change listener cleanup function
let visibilityChangeListener: (() => void) | null = null;

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
const initSystemThemeListener = async () => {
  // Clean up existing listener if it exists
  if (mediaQueryListener && mediaQuery) {
    mediaQuery.removeEventListener('change', mediaQueryListener);
    mediaQueryListener = null;
    mediaQuery = null;
  }

  // Set up media query listener for web and native platforms
  if (typeof window !== 'undefined' && window.matchMedia) {
    mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    mediaQueryListener = () => handleSystemThemeChange();
    mediaQuery.addEventListener('change', mediaQueryListener);
  }

  // On native platforms, also listen for app state changes and visibility changes
  // This ensures we detect theme changes when the app comes to foreground
  if (Capacitor.isNativePlatform()) {
    // Clean up existing app state listener
    if (appStateListener) {
      await appStateListener.remove();
      appStateListener = null;
    }

    // Listen for app state changes to re-check system theme
    appStateListener = await App.addListener('appStateChange', async state => {
      if (state.isActive) {
        // App came to foreground, re-check system theme
        const currentTheme = useUiStore.getState().theme;
        if (currentTheme === 'system') {
          // Small delay to ensure system theme is updated
          setTimeout(() => {
            handleSystemThemeChange();
          }, 100);
        }
      }
    });
  }

  // Also listen for visibility changes (works on both web and native)
  // This catches cases where the app tab/window becomes visible again
  if (typeof document !== 'undefined') {
    // Clean up existing visibility listener
    if (visibilityChangeListener) {
      document.removeEventListener(
        'visibilitychange',
        visibilityChangeListener
      );
      visibilityChangeListener = null;
    }

    visibilityChangeListener = () => {
      if (!document.hidden) {
        // Document became visible, re-check system theme
        const currentTheme = useUiStore.getState().theme;
        if (currentTheme === 'system') {
          handleSystemThemeChange();
        }
      }
    };

    document.addEventListener('visibilitychange', visibilityChangeListener);
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

    // Clean up existing app state listener if it exists
    if (appStateListener) {
      await appStateListener.remove();
      appStateListener = null;
    }

    // Clean up existing visibility listener if it exists
    if (visibilityChangeListener && typeof document !== 'undefined') {
      document.removeEventListener(
        'visibilitychange',
        visibilityChangeListener
      );
      visibilityChangeListener = null;
    }

    // Initialize system theme listener
    await initSystemThemeListener();

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
      // Also update when resolvedTheme changes (e.g., from system theme change)
      if (state.resolvedTheme !== prevState.resolvedTheme) {
        // Theme was resolved, ensure status bar is updated
        // This is handled by the status bar subscription, but we trigger it here too
        if (Capacitor.isNativePlatform()) {
          // Status bar will be updated via its subscription to resolvedTheme
        }
      }
    });

    if (Capacitor.isNativePlatform()) {
      await initStatusBar();
    }

    // Return cleanup function
    return async () => {
      if (unsubscribeTheme) {
        unsubscribeTheme();
        unsubscribeTheme = null;
      }
      if (mediaQueryListener && mediaQuery) {
        mediaQuery.removeEventListener('change', mediaQueryListener);
        mediaQueryListener = null;
        mediaQuery = null;
      }
      if (appStateListener) {
        await appStateListener.remove();
        appStateListener = null;
      }
      if (visibilityChangeListener && typeof document !== 'undefined') {
        document.removeEventListener(
          'visibilitychange',
          visibilityChangeListener
        );
        visibilityChangeListener = null;
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
