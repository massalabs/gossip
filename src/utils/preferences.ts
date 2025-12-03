/**
 * Preferences Storage Utilities
 *
 * Wrapper around Capacitor Preferences API for cross-platform storage.
 * - On web: Falls back to localStorage (accessible by service worker)
 * - On mobile: Uses native storage (accessible by background runner via CapacitorKV)
 */

import { Preferences } from '@capacitor/preferences';
import { encodeToBase64 } from './base64';

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
 */
export async function setLastSyncTimestamp(): Promise<void> {
  const now = Date.now();

  try {
    await Preferences.set({
      key: LAST_SYNC_TIMESTAMP_KEY,
      value: String(now),
    });
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
    await Preferences.set({
      key: API_BASE_URL_KEY,
      value: baseUrl,
    });
  } catch {
    // Silently ignore; this is best-effort for background sync support
  }
}

/**
 * Store active seekers in Preferences for background runner access.
 * This allows the background runner to read seekers without IndexedDB.
 * @param seekers - Array of seeker Uint8Arrays to store
 */
export async function setActiveSeekersInPreferences(
  seekers: Uint8Array[]
): Promise<void> {
  try {
    const serializedSeekers = seekers.map(seeker => encodeToBase64(seeker));
    await Preferences.set({
      key: ACTIVE_SEEKERS_KEY,
      value: JSON.stringify(serializedSeekers),
    });
  } catch {
    // Silently ignore; failure to persist should not break DB updates.
  }
}
