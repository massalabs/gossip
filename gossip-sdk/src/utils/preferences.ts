/**
 * Preferences Storage Utilities
 *
 * Wrapper around storage APIs for cross-platform compatibility.
 * In SDK context (Node.js), these operations are no-ops.
 *
 * - On web: Uses injected adapter or Capacitor Preferences
 * - On mobile: Uses injected adapter or native storage via Capacitor
 * - In Node.js/SDK: No-ops (data is in-memory only)
 *
 * IMPORTANT: On Android, BackgroundRunner uses a separate SharedPreferences file.
 * Data written by @capacitor/preferences ("CapacitorStorage") is NOT visible to the
 * BackgroundRunner ("net.massa.gossip.background.sync"). These helpers bridge writes
 * to BackgroundRunner storage when running on native platforms.
 */

import { encodeToBase64 } from './base64';

export interface PreferencesAdapter {
  get: (key: string) => Promise<string | null>;
  set: (key: string, value: string) => Promise<void>;
  remove?: (key: string) => Promise<void>;
}

export interface ForegroundChecker {
  isForeground: () => Promise<boolean>;
}

let preferencesAdapter: PreferencesAdapter | null = null;
let foregroundChecker: ForegroundChecker | null = null;

export function setPreferencesAdapter(
  adapter: PreferencesAdapter | null
): void {
  preferencesAdapter = adapter;
}

export function setForegroundChecker(checker: ForegroundChecker | null): void {
  foregroundChecker = checker;
}

// Preferences keys
const ACTIVE_SEEKERS_KEY = 'gossip-active-seekers';
const API_BASE_URL_KEY = 'gossip-api-base-url';
const LAST_SYNC_TIMESTAMP_KEY = 'gossip-last-sync-timestamp';

/**
 * Get the last sync timestamp from Preferences.
 * @returns The last sync timestamp in milliseconds, or 0 if never synced
 */
export async function getLastSyncTimestamp(): Promise<number> {
  if (preferencesAdapter) {
    const result = await preferencesAdapter.get(LAST_SYNC_TIMESTAMP_KEY);
    if (result) {
      const timestamp = parseInt(result, 10);
      if (!Number.isNaN(timestamp)) {
        return timestamp;
      }
    }
    return 0;
  }

  if (typeof document === 'undefined') {
    return 0;
  }

  try {
    const { Preferences } = await import('@capacitor/preferences');
    const result = await Preferences.get({ key: LAST_SYNC_TIMESTAMP_KEY });
    if (result.value) {
      const timestamp = parseInt(result.value, 10);
      if (!Number.isNaN(timestamp)) {
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

  if (preferencesAdapter) {
    await preferencesAdapter.set(LAST_SYNC_TIMESTAMP_KEY, value);
    return;
  }

  if (typeof document === 'undefined') {
    return;
  }

  try {
    const { Capacitor } = await import('@capacitor/core');
    if (Capacitor.isNativePlatform()) {
      const foreground = await isForeground();
      if (!foreground) {
        return;
      }

      try {
        const { backgroundRunnerStorageService } =
          await import('../services/backgroundRunnerStorage');
        await backgroundRunnerStorageService.set(
          LAST_SYNC_TIMESTAMP_KEY,
          value
        );
      } catch {
        // Silently ignore
      }
      return;
    }
  } catch {
    // Ignore and fall back to Preferences
  }

  try {
    const { Preferences } = await import('@capacitor/preferences');
    await Preferences.set({ key: LAST_SYNC_TIMESTAMP_KEY, value });
  } catch {
    // Silently ignore; failure to persist should not break the app
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
  if (preferencesAdapter) {
    await preferencesAdapter.set(API_BASE_URL_KEY, baseUrl);
    return;
  }

  if (typeof document === 'undefined') {
    return;
  }

  try {
    const { Preferences } = await import('@capacitor/preferences');
    await Preferences.set({ key: API_BASE_URL_KEY, value: baseUrl });
  } catch {
    // Silently ignore; this is best-effort for background sync support
  }

  try {
    const { Capacitor } = await import('@capacitor/core');
    if (Capacitor.isNativePlatform()) {
      try {
        const { backgroundRunnerStorageService } =
          await import('../services/backgroundRunnerStorage');
        await backgroundRunnerStorageService.set(API_BASE_URL_KEY, baseUrl);
      } catch {
        // Silently ignore
      }
    }
  } catch {
    // Silently ignore
  }
}

/**
 * Store active seekers for background runner access.
 *
 * The main app reads seekers from IndexedDB, not Preferences, so we only need to
 * write to BackgroundRunner storage via the storage bridge on native platforms.
 * Without this bridge, BackgroundRunner storage is empty and background sync fails.
 *
 * If a PreferencesAdapter is provided, it is used instead of Capacitor storage.
 * In SDK/Node.js context, this is a no-op since there's no background runner.
 *
 * @param seekers - Array of seeker Uint8Arrays to store
 */
export async function setActiveSeekersInPreferences(
  seekers: Uint8Array[]
): Promise<void> {
  const serializedSeekers = seekers.map(seeker => encodeToBase64(seeker));
  const value = JSON.stringify(serializedSeekers);

  if (preferencesAdapter) {
    await preferencesAdapter.set(ACTIVE_SEEKERS_KEY, value);
    return;
  }

  if (typeof document === 'undefined') {
    return;
  }

  try {
    const { Capacitor } = await import('@capacitor/core');
    if (Capacitor.isNativePlatform()) {
      const foreground = await isForeground();
      if (!foreground) {
        return;
      }

      try {
        const { backgroundRunnerStorageService } =
          await import('../services/backgroundRunnerStorage');
        await backgroundRunnerStorageService.set(ACTIVE_SEEKERS_KEY, value);
      } catch {
        // BackgroundRunner storage not available, silently ignore
      }
    }
  } catch {
    // Capacitor not available, silently ignore
  }
}

async function isForeground(): Promise<boolean> {
  if (foregroundChecker) {
    return foregroundChecker.isForeground();
  }

  const { isAppInForeground } = await import('./appState');
  return isAppInForeground();
}
