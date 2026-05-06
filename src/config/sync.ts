/**
 * Background Sync Configuration (web / PWA service worker)
 *
 * Centralized intervals for Periodic Background Sync and related timers in
 * `serviceWorkerSetup.ts` + `sw.ts`. These apply to **browser sessions** (desktop
 * PWA or mobile browser), not to the Capacitor native shell — on iOS/Android
 * apps, `@capacitor/background-runner` and `public/runners/background-sync.js`
 * own scheduling (see `capacitor.config.ts`).
 *
 * **PWA reality:** Chromium may honour `minInterval` only loosely; Safari often
 * does not expose Periodic Background Sync; mobile WebViews may kill the service
 * worker. Treat these numbers as *hints*, not SLAs.
 */

export interface SyncConfig {
  /**
   * Minimum interval for Periodic Background Sync API (in milliseconds)
   * This is a request to the browser - actual syncs may be less frequent
   * Recommended: 5-15 minutes for mobile, but expect delays
   */
  periodicSyncMinIntervalMs: number;

  /**
   * Interval for fallback timer-based sync when app is in background (in milliseconds)
   * Used when Periodic Background Sync is not available or unreliable
   * Note: Service workers may be terminated on mobile, making this less reliable
   * Recommended: 5-15 minutes
   */
  fallbackSyncIntervalMs: number;

  /**
   * Interval for sync when app is open and active (in milliseconds)
   * Much more aggressive since the app is actively being used
   * Recommended: 10-30 seconds for responsive updates
   */
  activeSyncIntervalMs: number;
}

export const defaultSyncConfig: SyncConfig = {
  // Chrome enforces a minimum (~15m); actual cadence can be much slower.
  periodicSyncMinIntervalMs: 15 * 60 * 1000,

  // Fallback timer interval when app is in background (5 minutes)
  // On mobile, service workers may be terminated, so this is less reliable
  fallbackSyncIntervalMs: 5 * 60 * 1000, // 5 minutes

  // Aggressive sync interval when app is open and active (10 seconds)
  // Much more responsive when user is actively using the app
  activeSyncIntervalMs: 2 * 1000, // 2 seconds
};
