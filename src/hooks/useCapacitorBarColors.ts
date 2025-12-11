import { Capacitor } from '@capacitor/core';
import { Style } from '@capacitor/status-bar';
import { EdgeToEdge } from '@capawesome/capacitor-android-edge-to-edge-support';
import { useUiStore } from '../stores/uiStore';

/**
 * Get CSS variable value (handles var(--variable-name) syntax)
 * Returns the computed value, ensuring the DOM is ready
 */
const getCSSVariableValue = (varName: string): string => {
  const root = document.documentElement;
  const cleanVarName = varName.replace(/var\(|\)/g, '').trim();
  const value = getComputedStyle(root).getPropertyValue(cleanVarName).trim();

  // If value is empty, try to get it from the root element's style
  if (!value) {
    const fallback = root.style.getPropertyValue(cleanVarName).trim();
    if (fallback) return fallback;
  }

  return value;
};

/**
 * Convert RGB/RGBA to hex color
 */
const rgbToHex = (rgb: string): string => {
  const match = rgb.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*[\d.]+)?\)/);
  if (!match) return rgb;

  const r = parseInt(match[1], 10).toString(16).padStart(2, '0');
  const g = parseInt(match[2], 10).toString(16).padStart(2, '0');
  const b = parseInt(match[3], 10).toString(16).padStart(2, '0');
  return `#${r}${g}${b}`;
};

/**
 * Normalize color to hex format
 * Handles RGB, CSS variables, and ensures valid hex output
 */
const normalizeColor = (color: string, fallback: string): string => {
  // Convert RGB to hex if needed
  if (color.startsWith('rgb')) {
    return rgbToHex(color);
  }

  // If it's not hex and not rgb, try to resolve it as CSS variable
  if (!color.startsWith('#')) {
    const resolved = getComputedStyle(document.documentElement)
      .getPropertyValue(color.replace('var(', '').replace(')', '').trim())
      .trim();
    if (resolved) {
      return resolved.startsWith('rgb') ? rgbToHex(resolved) : resolved;
    }
  }

  // Ensure we have a valid hex color, use fallback if not
  if (!color || color === '' || !color.startsWith('#')) {
    return fallback;
  }

  return color;
};

/**
 * Interface for bar colors
 */
interface BarColors {
  topBarBgColor: string;
  topBarTextColor: Style;
  navBarBgColor: string;
  navBarTextColor: Style;
}

/**
 * Get bar colors based on UI state
 * Determines colors for status bar and navigation bar based on current UI conditions
 */
export const getBarsColors = (
  headerVisible: boolean,
  headerIsScrolled: boolean,
  resolvedTheme: 'light' | 'dark'
): BarColors => {
  let topBarBgColor: string;
  let navBarBgColor: string;

  if (headerVisible) {
    topBarBgColor = headerIsScrolled
      ? getCSSVariableValue('--header-scrolled')
      : getCSSVariableValue('--card');
  } else {
    topBarBgColor = getCSSVariableValue('--background');
  }

  // Navigation bar background color always uses muted color to match bottom navigation
  // The bottom navigation uses bg-muted class, so nav bar should match this color
  navBarBgColor = getCSSVariableValue('--muted');

  // Normalize colors to hex format with theme-based fallbacks
  const darkBgFallback = '#18181b';
  const lightBgFallback = '#fafbfc';
  const bgFallback =
    resolvedTheme === 'dark' ? darkBgFallback : lightBgFallback;

  topBarBgColor = normalizeColor(topBarBgColor, bgFallback);
  navBarBgColor = normalizeColor(navBarBgColor, bgFallback);

  const topBarTextColor = resolvedTheme === 'dark' ? Style.Dark : Style.Light;
  const navBarTextColor = resolvedTheme === 'dark' ? Style.Dark : Style.Light;

  return {
    topBarBgColor,
    topBarTextColor,
    navBarBgColor,
    navBarTextColor,
  };
};

/**
 * Update top bar (status bar) colors
 * Applies the provided colors to the native status bar
 */
export const updateBarsColors = async (barsColors: BarColors) => {
  if (!Capacitor.isNativePlatform()) return;

  await new Promise(resolve => requestAnimationFrame(resolve));
  await EdgeToEdge.setBackgroundColor({ color: barsColors.navBarBgColor });
};
// Store the unsubscribe function to prevent multiple subscriptions
let unsubscribeBarColors: (() => void) | null = null;

export const initStatusBar = async () => {
  if (!Capacitor.isNativePlatform()) return;

  // Clean up existing subscription if it exists to prevent multiple subscriptions
  if (unsubscribeBarColors) {
    unsubscribeBarColors();
    unsubscribeBarColors = null;
  }

  unsubscribeBarColors = useUiStore.subscribe((state, prevState) => {
    const headerChanged = state.headerVisible !== prevState.headerVisible;
    const bottomNavChanged =
      state.bottomNavVisible !== prevState.bottomNavVisible;

    const themeChanged = state.resolvedTheme !== prevState.resolvedTheme;

    if (headerChanged || bottomNavChanged || themeChanged) {
      const barColors = getBarsColors(
        state.headerVisible,
        state.headerIsScrolled,
        state.resolvedTheme
      );

      updateBarsColors(barColors);
    }
  });
};
