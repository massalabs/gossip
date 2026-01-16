/**
 * App State Utilities
 *
 * Utilities for checking app foreground/background state across platforms.
 */

import { Capacitor } from '@capacitor/core';

/**
 * Check if the app is currently in the foreground.
 *
 * - In browser with Capacitor: Uses Capacitor's App API
 * - In browser without Capacitor: Uses document.hidden property
 *
 * @returns true if app is in foreground, false if in background
 */
export async function isAppInForeground(): Promise<boolean> {
  // Try to use Capacitor if available
  if (Capacitor.isNativePlatform()) {
    const { App } = await import('@capacitor/app');
    const state = await App.getState();
    return state.isActive;
  }

  // In browser: use document.hidden
  return !document.hidden;
}
