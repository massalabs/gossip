import { Theme, ResolvedTheme } from '../stores/uiStore';

/**
 * Resolves a theme value to either 'light' or 'dark'.
 * If theme is 'system', checks the user's system preference.
 */
export function resolveTheme(theme: Theme): ResolvedTheme {
  if (theme === 'system') {
    return typeof window !== 'undefined' &&
      window.matchMedia('(prefers-color-scheme: dark)').matches
      ? 'dark'
      : 'light';
  }
  return theme;
}
