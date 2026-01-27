/**
 * Preferences Storage Utilities
 *
 * App-specific storage utilities for Capacitor native platforms.
 * Syncs data to Capacitor Preferences and BackgroundRunner storage.
 */

import { Capacitor } from '@capacitor/core';
import { Preferences } from '@capacitor/preferences';
import { encodeToBase64 } from '.';
import { isAppInForeground } from './appState';

// Preferences keys
const ACTIVE_SEEKERS_KEY = 'gossip-active-seekers';
const API_BASE_URL_KEY = 'gossip-api-base-url';
const LAST_SYNC_TIMESTAMP_KEY = 'gossip-last-sync-timestamp';

/**
 * Write a key-value pair to BackgroundRunner storage (Android).
 * This bridges the gap between host app storage (CapacitorStorage) and
 * BackgroundRunner storage (net.massa.gossip.background.sync).
 */
async function setBackgroundRunnerStorage(
  key: string,
  value?: string | null
): Promise<void> {
  if (!Capacitor.isNativePlatform()) {
    return;
  }

  try {
    const { registerPlugin } = await import('@capacitor/core');

    interface BackgroundRunnerStoragePlugin {
      set(options: { key: string; value?: string | null }): Promise<void>;
    }

    const BackgroundRunnerStorage =
      registerPlugin<BackgroundRunnerStoragePlugin>('BackgroundRunnerStorage');
    await BackgroundRunnerStorage.set({ key, value });
  } catch (error) {
    console.warn(
      '[BackgroundRunnerStorage] Failed to write to BackgroundRunner storage:',
      error
    );
  }
}

/**
 * Get the last sync timestamp from Preferences.
 * @returns The last sync timestamp in milliseconds, or 0 if never synced
 */
export async function getLastSyncTimestamp(): Promise<number> {
  try {
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
 */
export async function setLastSyncTimestamp(): Promise<void> {
  const now = Date.now();
  const value = String(now);

  try {
    if (Capacitor.isNativePlatform()) {
      const foreground = await isAppInForeground();
      if (!foreground) {
        return;
      }
      await setBackgroundRunnerStorage(LAST_SYNC_TIMESTAMP_KEY, value);
      return;
    }
  } catch {
    // Ignore and fall back to Preferences
  }

  try {
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
  try {
    await Preferences.set({ key: API_BASE_URL_KEY, value: baseUrl });
  } catch {
    // Silently ignore; this is best-effort for background sync support
  }

  if (Capacitor.isNativePlatform()) {
    await setBackgroundRunnerStorage(API_BASE_URL_KEY, baseUrl);
  }
}

/**
 * Store active seekers for background runner access.
 *
 * The main app reads seekers from IndexedDB, not Preferences, so we only need to
 * write to BackgroundRunner storage via the storage bridge on native platforms.
 *
 * @param seekers - Array of seeker Uint8Arrays to store
 */
export async function setActiveSeekersInPreferences(
  seekers: Uint8Array[]
): Promise<void> {
  const serializedSeekers = seekers.map(seeker => encodeToBase64(seeker));
  const value = JSON.stringify(serializedSeekers);

  if (Capacitor.isNativePlatform()) {
    const foreground = await isAppInForeground();
    if (!foreground) {
      return;
    }
    await setBackgroundRunnerStorage(ACTIVE_SEEKERS_KEY, value);
  }
}
