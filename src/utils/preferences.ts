/**
 * Preferences Storage Utilities
 *
 * Wrapper around Capacitor Preferences API for cross-platform storage.
 * - On web: Falls back to localStorage (accessible by service worker)
 * - On mobile: Uses native storage (accessible by background runner via CapacitorKV)
 *
 * IMPORTANT: The BackgroundRunner uses a separate SharedPreferences file on Android!
 * Data written by @capacitor/preferences (to "CapacitorStorage") is NOT visible
 * to the BackgroundRunner (which uses "net.massa.gossip.background.sync").
 * We must write to BOTH storages for background sync to work.
 */

import { Preferences } from '@capacitor/preferences';
import { Capacitor } from '@capacitor/core';
import { encodeToBase64 } from '../../gossip-sdk/src/utils/base64';
import { backgroundRunnerStorageService } from '../services/backgroundRunnerStorage';
import { isAppInForeground } from '../../gossip-sdk/src/utils/appState';

// Preferences keys
const ACTIVE_SEEKERS_KEY = 'gossip-active-seekers';
const API_BASE_URL_KEY = 'gossip-api-base-url';
const LAST_SYNC_TIMESTAMP_KEY = 'gossip-last-sync-timestamp';

/**
 * Get the last sync timestamp from Preferences.
 * @returns The last sync timestamp in milliseconds, or 0 if never synced
 */
export async function getLastSyncTimestamp(): Promise<number> {
  try {
    const result = await Preferences.get({
      key: LAST_SYNC_TIMESTAMP_KEY,
    });
    if (result.value) {
      const timestamp = parseInt(result.value, 10);
      if (!isNaN(timestamp)) {
        return timestamp;
      }
    }
  } catch {
    // Silently ignore
  }
  return 0;
}

/**
 * Set the last sync timestamp.
 * This should be called after a successful sync.
 *
 * - On web: Writes to Preferences (used by service worker)
 * - On native: Writes to BackgroundRunner storage (used by BackgroundRunner)
 *
 * IMPORTANT: On native, only updates BackgroundRunner storage when app is in foreground.
 * When app is in background, the background runner is using the stored timestamp,
 * and we shouldn't overwrite it until the app comes back to foreground.
 */
export async function setLastSyncTimestamp(): Promise<void> {
  const now = Date.now();
  const value = String(now);

  if (Capacitor.isNativePlatform()) {
    // On native: Only write to BackgroundRunner storage (main app doesn't read from Preferences)
    try {
      // Check if app is in foreground before updating BackgroundRunner storage
      // When app is in background, the background runner is using the stored timestamp,
      // and we shouldn't overwrite it until the app comes back to foreground.
      const foreground = await isAppInForeground();

      if (foreground) {
        await backgroundRunnerStorageService.set(
          LAST_SYNC_TIMESTAMP_KEY,
          value
        );
      }
    } catch {
      // Silently ignore
    }
  } else {
    // On web: Write to Preferences (used by service worker)
    try {
      await Preferences.set({
        key: LAST_SYNC_TIMESTAMP_KEY,
        value,
      });
    } catch {
      // Silently ignore; failure to persist should not break the app
    }
  }
}

/**
 * Store the API base URL in Preferences for background runner access.
 * This should be called during app initialization.
 * @param baseUrl - The API base URL to store
 */
export async function setApiBaseUrlForBackgroundSync(
  baseUrl: string
): Promise<void> {
  try {
    await Preferences.set({
      key: API_BASE_URL_KEY,
      value: baseUrl,
    });
  } catch {
    // Silently ignore; this is best-effort for background sync support
  }

  // On native platforms, also write to BackgroundRunner's separate storage
  if (Capacitor.isNativePlatform()) {
    try {
      await backgroundRunnerStorageService.set(API_BASE_URL_KEY, baseUrl);
    } catch {
      // Silently ignore
    }
  }
}

/**
 * Store active seekers for background runner access.
 *
 * The main app reads seekers from IndexedDB, not Preferences, so we only need to
 * write to BackgroundRunner's storage (via the storage bridge).
 *
 * This is the STORAGE BRIDGE - without this, the BackgroundRunner can't read seekers
 * because it uses a different SharedPreferences file (net.massa.gossip.background.sync)
 * than the main app (CapacitorStorage).
 *
 * CONFIRMED: When this bridge is disabled, BackgroundRunner storage is empty (null)
 * and background sync fails. The bridge is necessary for background sync to work.
 *
 * @param seekers - Array of seeker Uint8Arrays to store
 */
export async function setActiveSeekersInPreferences(
  seekers: Uint8Array[]
): Promise<void> {
  const serializedSeekers = seekers.map(seeker => encodeToBase64(seeker));
  const value = JSON.stringify(serializedSeekers);

  // Only write to BackgroundRunner's storage (main app uses IndexedDB)
  // On native platforms, write to BackgroundRunner's separate storage
  if (Capacitor.isNativePlatform()) {
    try {
      // Only update when app is in foreground to avoid overwriting what background runner is using
      const foreground = await isAppInForeground();

      if (foreground) {
        await backgroundRunnerStorageService.set(ACTIVE_SEEKERS_KEY, value);
      } else {
        console.log(
          '[Preferences] App is in background, skipping BackgroundRunner seeker update to avoid overwriting background runner state'
        );
      }
    } catch {
      // Silently ignore; best-effort for background sync
    }
  }
}
