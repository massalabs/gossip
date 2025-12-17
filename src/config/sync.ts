/**
 * Background Sync Configuration
 *
 * Centralized configuration for service worker background sync intervals.
 * These values can be adjusted based on your requirements and mobile device constraints.
 *
 * Note: On mobile devices, browsers may throttle or delay syncs significantly.
 * Even with a 5-minute request, actual syncs may occur much less frequently.
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
  // Request 5 minutes, but browser may delay significantly on mobile
  periodicSyncMinIntervalMs: 15 * 60 * 1000, // 15 minutes // chrome minimum

  // Fallback timer interval when app is in background (5 minutes)
  // On mobile, service workers may be terminated, so this is less reliable
  fallbackSyncIntervalMs: 5 * 60 * 1000, // 5 minutes

  // Aggressive sync interval when app is open and active (10 seconds)
  // Much more responsive when user is actively using the app
  activeSyncIntervalMs: 2 * 1000, // 2 seconds
};
