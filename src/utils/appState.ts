/**
 * App State Utilities
 *
 * Utilities for checking app foreground/background state across platforms.
 * Uses Capacitor's App API for reliable state detection on native platforms.
 */

import { App } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';

/**
 * Check if the app is currently in the foreground.
 *
 * - On native platforms: Uses Capacitor's App API (App.getState())
 * - On web: Uses document.hidden property
 *
 * @returns true if app is in foreground, false if in background
 */
export async function isAppInForeground(): Promise<boolean> {
  if (Capacitor.isNativePlatform()) {
    try {
      const state = await App.getState();
      // AppState has an 'isActive' property that indicates if app is in foreground
      return state.isActive;
    } catch (error) {
      // If App API fails, assume foreground to avoid blocking operations
      console.warn(
        '[AppState] Failed to get app state, assuming foreground:',
        error
      );
      return true;
    }
  } else {
    // On web: use document.hidden
    return typeof document !== 'undefined' && !document.hidden;
  }
}
