/**
 * App State Utilities
 *
 * Utilities for checking app foreground/background state across platforms.
 * In SDK context (Node.js), defaults to returning true (foreground).
 */

/**
 * Check if the app is currently in the foreground.
 *
 * - In Node.js/SDK context: Returns true (assumes foreground for automation)
 * - In browser with Capacitor: Uses Capacitor's App API
 * - In browser without Capacitor: Uses document.hidden property
 *
 * @returns true if app is in foreground, false if in background
 */
export async function isAppInForeground(): Promise<boolean> {
  // Check if we're in Node.js environment (no document, no Capacitor)
  if (typeof document === 'undefined') {
    // In Node.js/SDK context, assume foreground for operations
    return true;
  }

  // Try to use Capacitor if available
  try {
    const { Capacitor } = await import('@capacitor/core');
    if (Capacitor.isNativePlatform()) {
      const { App } = await import('@capacitor/app');
      const state = await App.getState();
      return state.isActive;
    }
  } catch {
    // Capacitor not available, fall through to browser check
  }

  // In browser: use document.hidden
  return !document.hidden;
}
