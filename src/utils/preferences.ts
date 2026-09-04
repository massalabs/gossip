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
import { ForegroundSync } from '../services/foregroundSync';

// Preferences keys
const ACTIVE_SEEKERS_KEY = 'gossip-active-seekers';
const API_BASE_URL_KEY = 'gossip-api-base-url';
const LAST_SYNC_TIMESTAMP_KEY = 'gossip-last-sync-timestamp';
const ACCOUNT_CLEANUP_BLOCK_KEY = 'gossip-account-cleanup-blocked-v1';
const ACCOUNT_OUTPUT_GENERATION_KEY = 'gossip-account-output-generation-v1';
const SYNC_LOCK_KEY = 'gossip-sync-lock-time';
const SYNC_LOCK_TIMEOUT_MS = 90_000;
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
export async function blockAccountLinkedSyncState(
  outputEpoch: number
): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;
  // Block first: no runner may observe a new generation with old seekers.
  await backgroundRunnerStorageService.setStrict(
    ACCOUNT_CLEANUP_BLOCK_KEY,
    `blocked:${outputEpoch}`
  );
  const storedGeneration = await backgroundRunnerStorageService.getStrict(
    ACCOUNT_OUTPUT_GENERATION_KEY
  );
  const generation = Number.parseInt(storedGeneration ?? '0', 10);
  await backgroundRunnerStorageService.setStrict(
    ACCOUNT_OUTPUT_GENERATION_KEY,
    String(Number.isFinite(generation) ? generation + 1 : 1)
  );
  // Cancel requests accepted just before the tombstone/generation transition.
  const { notificationService } = await import('../services/notifications');
  await notificationService.clearAllNotifications();
  const deadline = Date.now() + SYNC_LOCK_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const rawLock =
      await backgroundRunnerStorageService.getStrict(SYNC_LOCK_KEY);
    if (!rawLock) return;
    const lockTime = Number.parseInt(rawLock, 10);
    const age = Date.now() - lockTime;
    if (!Number.isFinite(lockTime) || age < 0 || age >= SYNC_LOCK_TIMEOUT_MS) {
      await backgroundRunnerStorageService.setStrict(SYNC_LOCK_KEY, null);
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Background sync did not quiesce');
}

export async function clearAccountLinkedSyncState(): Promise<void> {
  const failures: unknown[] = [];
  try {
    const blocked = await backgroundRunnerStorageService.getStrict(
      ACCOUNT_CLEANUP_BLOCK_KEY
    );
    if (!blocked) await blockAccountLinkedSyncState(0);
  } catch (error) {
    failures.push(error);
  }
  const operations: Promise<void>[] = [
    Preferences.remove({ key: ACTIVE_SEEKERS_KEY }),
    Preferences.remove({ key: LAST_SYNC_TIMESTAMP_KEY }),
  ];
  if (Capacitor.isNativePlatform()) {
    operations.push(
      backgroundRunnerStorageService.setStrict(ACTIVE_SEEKERS_KEY, null),
      backgroundRunnerStorageService.setStrict(LAST_SYNC_TIMESTAMP_KEY, null)
    );
  }
  const results = await Promise.allSettled(operations);
  failures.push(
    ...results
      .filter(result => result.status === 'rejected')
      .map(result => (result as PromiseRejectedResult).reason)
  );
  if (failures.length > 0) {
    throw new Error('Account-linked sync cleanup is incomplete');
  }
}

export async function setActiveSeekersInPreferences(
  seekers: Uint8Array[],
  outputEpoch = 0,
  mayPublish: () => boolean = () => true
): Promise<void> {
  const serializedSeekers = seekers.map(seeker => encodeToBase64(seeker));
  const value = JSON.stringify(serializedSeekers);

  if (Capacitor.isNativePlatform()) {
    const foreground = await isAppInForeground();
    if (!foreground || !mayPublish()) {
      return;
    }
    await backgroundRunnerStorageService.setStrict(ACTIVE_SEEKERS_KEY, value);
    if (!mayPublish()) {
      await backgroundRunnerStorageService.setStrict(ACTIVE_SEEKERS_KEY, null);
      return;
    }
    await backgroundRunnerStorageService.clearIfValue(
      ACCOUNT_CLEANUP_BLOCK_KEY,
      `blocked:${outputEpoch}`
    );
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
    try {
      await ForegroundSync.setSyncPreset({ preset });
    } catch {
      // Native plugin missing or platform without ForegroundSync — ignore.
    }
  }
}

/**
 * Copy the current preset into Background Runner storage AND the native foreground
 * service SharedPreferences so both stay in sync with the JS-side Preferences value.
 * Call after startup and whenever the app may have updated Preferences without going through setBackgroundSyncPreset.
 */
export async function syncBackgroundSyncPresetToRunner(): Promise<void> {
  if (!Capacitor.isNativePlatform()) {
    return;
  }
  const preset = await getBackgroundSyncPreset();
  await setBackgroundRunnerStorage(BACKGROUND_SYNC_PRESET_KV_KEY, preset);
  // Also push to the Android foreground service SharedPrefs so the native tick
  // interval matches the JS-side preset (no-op on iOS via the web stub).
  try {
    await ForegroundSync.setSyncPreset({ preset });
  } catch {
    // Native plugin missing or platform without ForegroundSync — ignore.
  }
}
