/**
 * Preferences Storage Utilities
 *
 * App-specific storage utilities for Capacitor native platforms.
 * Syncs data to Capacitor Preferences and BackgroundRunner storage.
 */

import { Capacitor } from '@capacitor/core';
import { Preferences } from '@capacitor/preferences';
import { encodeToBase64 } from '@massalabs/gossip-sdk';
import { isAppInForeground } from './appState';
import { backgroundRunnerStorageService } from '../services/backgroundRunnerStorage';

// Preferences keys
const ACTIVE_SEEKERS_KEY = 'gossip-active-seekers';
const API_BASE_URL_KEY = 'gossip-api-base-url';
const LAST_SYNC_TIMESTAMP_KEY = 'gossip-last-sync-timestamp';
const BACKGROUND_SYNC_PRESET_PREF_KEY = 'gossip-background-sync-preset';

/** KV key consumed by `public/runners/background-sync.js` — keep in sync. */
export const BACKGROUND_SYNC_PRESET_KV_KEY = 'gossip-sync-preset';

export type BackgroundSyncPreset = 'balanced' | 'max';

/**
 * Write a key-value pair to BackgroundRunner storage (Android).
 * This bridges the gap between host app storage (CapacitorStorage) and
 * BackgroundRunner storage (net.massa.gossip.background.sync).
 */
async function setBackgroundRunnerStorage(
  key: string,
  value?: string | null
): Promise<void> {
  await backgroundRunnerStorageService.set(key, value);
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

const DEFAULT_BACKGROUND_SYNC_PRESET: BackgroundSyncPreset = 'max';

/**
 * User preference for background fetch throttling (native Background Runner).
 * `max` = minimum delay between sync attempts (more reactive). `balanced` = longer gap (fewer redundant fetches when the OS fires often).
 */
export async function getBackgroundSyncPreset(): Promise<BackgroundSyncPreset> {
  try {
    const { value } = await Preferences.get({
      key: BACKGROUND_SYNC_PRESET_PREF_KEY,
    });
    if (value === 'balanced' || value === 'max') {
      return value;
    }
  } catch {
    // ignore
  }
  return DEFAULT_BACKGROUND_SYNC_PRESET;
}

export async function setBackgroundSyncPreset(
  preset: BackgroundSyncPreset
): Promise<void> {
  await Preferences.set({
    key: BACKGROUND_SYNC_PRESET_PREF_KEY,
    value: preset,
  });
  if (Capacitor.isNativePlatform()) {
    await setBackgroundRunnerStorage(BACKGROUND_SYNC_PRESET_KV_KEY, preset);
  }
}

/**
 * Copy the current preset into Background Runner storage so the headless script can read it.
 * Call after startup and whenever the app may have updated Preferences without going through setBackgroundSyncPreset.
 */
export async function syncBackgroundSyncPresetToRunner(): Promise<void> {
  if (!Capacitor.isNativePlatform()) {
    return;
  }
  const preset = await getBackgroundSyncPreset();
  await setBackgroundRunnerStorage(BACKGROUND_SYNC_PRESET_KV_KEY, preset);
}
