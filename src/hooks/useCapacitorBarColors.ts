import { Capacitor } from '@capacitor/core';
import { StatusBar, Style } from '@capacitor/status-bar';
import { NavigationBar } from '@capgo/capacitor-navigation-bar';
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
    console.log('fallback', fallback);
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
  bottomNavVisible: boolean,
  resolvedTheme: 'light' | 'dark'
): BarColors => {
  let topBarBgColor: string;

  if (headerVisible) {
    topBarBgColor = headerIsScrolled
      ? getCSSVariableValue('--header-scrolled')
      : getCSSVariableValue('--card');
  } else {
    topBarBgColor = getCSSVariableValue('--background');
  }

  // Determine navigation bar background color:
  // - If bottom nav visible: use muted color (same as bottom nav)
  // - If bottom nav not visible: use background color
  let navBarBgColor: string;
  if (bottomNavVisible) {
    navBarBgColor = getCSSVariableValue('--muted');
  } else {
    navBarBgColor = getCSSVariableValue('--background');
  }

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
 * Update status bar and navigation bar colors
 * Applies the provided colors to the native status and navigation bars
 */
export const updateBarColors = async ({
  topBarBgColor,
  topBarTextColor,
  navBarBgColor,
  navBarTextColor,
}: BarColors) => {
  if (!Capacitor.isNativePlatform()) return;

  // Use requestAnimationFrame to ensure DOM is fully updated
  await new Promise(resolve => requestAnimationFrame(resolve));

  // Convert text color to StatusBar Style
  const statusBarStyle =
    topBarTextColor === Style.Dark ? Style.Dark : Style.Light;

  // Convert text color to NavigationBar darkButtons
  const navBarDarkButtons = navBarTextColor === Style.Dark;

  const isAndroid = Capacitor.getPlatform() === 'android';

  // Edge-to-edge approach: Status bar color is simulated by header background
  // We only need to set icon style (light/dark) based on background luminance
  await StatusBar.setStyle({ style: statusBarStyle });

  // Optional: Set background color as fallback for older Android versions
  // On Android 15+, this is no-op but doesn't hurt
  // The actual visual color comes from header/nav background extending behind bars
  if (isAndroid) {
    // Use EdgeToEdge plugin for Android (supports Android 15+)
    // This is optional since header background simulates the color
    await EdgeToEdge.setBackgroundColor({ color: topBarBgColor }).catch(err => {
      console.warn('Failed to set EdgeToEdge background color:', err);
    });
  } else {
    // iOS: StatusBar.setBackgroundColor still works
    await StatusBar.setBackgroundColor({ color: topBarBgColor });
  }

  // Update navigation bar using NavigationBar plugin (Android only)
  if (isAndroid) {
    await NavigationBar.setNavigationBarColor({
      color: navBarBgColor,
      darkButtons: navBarDarkButtons,
    }).catch(err => {
      console.warn('Failed to set NavigationBar color:', err);
    });
  }
};

export const initStatusBar = async () => {
  if (!Capacitor.isNativePlatform()) return;

  const isAndroid = Capacitor.getPlatform() === 'android';

  // Enable edge-to-edge mode on Android (required for Android 15+ support)
  if (isAndroid) {
    await EdgeToEdge.enable().catch(err => {
      console.warn('Failed to enable EdgeToEdge mode:', err);
    });

    // Inject safe area insets as CSS variables for Android
    // This allows us to use --safe-area-inset-* in CSS
    try {
      const insets = await EdgeToEdge.getInsets();
      const root = document.documentElement;
      root.style.setProperty('--safe-area-inset-top', `${insets.top}px`);
      root.style.setProperty('--safe-area-inset-bottom', `${insets.bottom}px`);
      root.style.setProperty('--safe-area-inset-left', `${insets.left}px`);
      root.style.setProperty('--safe-area-inset-right', `${insets.right}px`);
    } catch (err) {
      console.warn('Failed to get EdgeToEdge insets:', err);
    }
  }

  const uiStore = useUiStore.getState();

  await updateBarColors(
    getBarsColors(
      uiStore.headerVisible,
      uiStore.headerIsScrolled,
      uiStore.bottomNavVisible,
      uiStore.resolvedTheme
    )
  );

  // Subscribe to UI store changes
  useUiStore.subscribe((state, prevState) => {
    const headerChanged =
      state.headerVisible !== prevState.headerVisible ||
      state.headerIsScrolled !== prevState.headerIsScrolled;
    const bottomNavChanged =
      state.bottomNavVisible !== prevState.bottomNavVisible;
    const themeChanged = state.resolvedTheme !== prevState.resolvedTheme;

    if (headerChanged || bottomNavChanged || themeChanged) {
      void updateBarColors(
        getBarsColors(
          state.headerVisible,
          state.headerIsScrolled,
          state.bottomNavVisible,
          state.resolvedTheme
        )
      );
    }
  });
};
