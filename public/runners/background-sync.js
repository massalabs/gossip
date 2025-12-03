// Background Runner: Gossip background sync
//
// This file runs in a headless JavaScript environment provided by
// @capacitor/background-runner. It does NOT have access to the DOM or your
// web app bundle, so keep logic self‑contained and use the provided
// Capacitor* globals (e.g. CapacitorApp, CapacitorNotifications, CapacitorKV).
//
// The corresponding configuration is defined in `capacitor.config.ts`:
//   event: "backgroundSync"
//   src:   "runners/background-sync.js"
//
// IMPORTANT: Always call resolve() or reject() to let the OS know when
// the background work is finished.

/* global addEventListener, console, CapacitorNotifications, CapacitorKV, fetch */

// Keys used for Capacitor Preferences (CapacitorKV in Background Runner)
const ACTIVE_SEEKERS_KEY = 'gossip-active-seekers';
const API_BASE_URL_KEY = 'gossip-api-base-url';
const LAST_SYNC_TIMESTAMP_KEY = 'gossip-last-sync-timestamp';

// Fallback API URL if not stored in preferences
const DEFAULT_API_BASE_URL = 'https://gossip.massa.net/api';

// Minimum interval between syncs to avoid redundant work
// If a sync was performed within this window, skip the current sync
const MIN_SYNC_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Retrieve active seekers from CapacitorKV (Preferences).
 * Returns an array of base64-encoded seeker strings, or an empty array if none found.
 */
async function getActiveSeekers() {
  try {
    if (typeof CapacitorKV === 'undefined' || !CapacitorKV?.get) {
      console.log('[BackgroundSync] CapacitorKV not available');
      return [];
    }

    const value = await CapacitorKV.get(ACTIVE_SEEKERS_KEY);
    if (!value) {
      console.log('[BackgroundSync] No active seekers stored');
      return [];
    }

    const seekers = JSON.parse(value);
    console.log(
      '[BackgroundSync] Retrieved',
      seekers.length,
      'active seekers from storage'
    );
    return seekers;
  } catch (err) {
    console.log('[BackgroundSync] Failed to get active seekers', String(err));
    return [];
  }
}

/**
 * Retrieve the API base URL from CapacitorKV or use default.
 */
async function getApiBaseUrl() {
  try {
    if (typeof CapacitorKV !== 'undefined' && CapacitorKV?.get) {
      const storedUrl = await CapacitorKV.get(API_BASE_URL_KEY);
      if (storedUrl) {
        return storedUrl;
      }
    }
  } catch (err) {
    console.log(
      '[BackgroundSync] Failed to get API URL from storage',
      String(err)
    );
  }
  return DEFAULT_API_BASE_URL;
}

/**
 * Retrieve the last sync timestamp from CapacitorKV.
 * Returns 0 if not found or on error.
 */
async function getLastSyncTimestamp() {
  try {
    if (typeof CapacitorKV !== 'undefined' && CapacitorKV?.get) {
      const value = await CapacitorKV.get(LAST_SYNC_TIMESTAMP_KEY);
      if (value) {
        const timestamp = parseInt(value, 10);
        if (!isNaN(timestamp)) {
          return timestamp;
        }
      }
    }
  } catch (err) {
    console.log(
      '[BackgroundSync] Failed to get last sync timestamp',
      String(err)
    );
  }
  return 0;
}

/**
 * Store the current timestamp as the last sync time.
 */
async function setLastSyncTimestamp() {
  try {
    if (typeof CapacitorKV !== 'undefined' && CapacitorKV?.set) {
      await CapacitorKV.set(LAST_SYNC_TIMESTAMP_KEY, String(Date.now()));
    }
  } catch (err) {
    console.log(
      '[BackgroundSync] Failed to set last sync timestamp',
      String(err)
    );
  }
}

/**
 * Check if enough time has passed since the last sync.
 * Returns true if sync should proceed, false if it should be skipped.
 */
async function shouldPerformSync() {
  const lastSyncTimestamp = await getLastSyncTimestamp();
  if (lastSyncTimestamp === 0) {
    // No previous sync recorded, proceed
    return true;
  }

  const timeSinceLastSync = Date.now() - lastSyncTimestamp;
  if (timeSinceLastSync < MIN_SYNC_INTERVAL_MS) {
    console.log(
      '[BackgroundSync] Skipping sync - too soon since last sync (' +
        Math.round(timeSinceLastSync / 1000) +
        's ago, minimum is ' +
        Math.round(MIN_SYNC_INTERVAL_MS / 1000) +
        's)'
    );
    return false;
  }

  return true;
}

/**
 * Fetch messages from the protocol API for the given seekers.
 * @param {string} baseUrl - The API base URL
 * @param {string[]} seekers - Array of base64-encoded seekers
 * @returns {Promise<Array<{key: string, value: string}>>} - Array of messages
 */
async function fetchMessages(baseUrl, seekers) {
  const url = `${baseUrl}/messages/fetch`;

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ seekers }),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }

  const data = await response.json();
  return data || [];
}

/**
 * Show a notification for new messages.
 * @param {number} messageCount - Number of new messages
 */
async function showNewMessageNotification(messageCount) {
  try {
    if (
      typeof CapacitorNotifications === 'undefined' ||
      !CapacitorNotifications?.schedule
    ) {
      console.log('[BackgroundSync] CapacitorNotifications not available');
      return;
    }

    const title = 'Gossip';
    const body =
      messageCount === 1
        ? 'You have a new message'
        : `You have ${messageCount} new messages`;

    await CapacitorNotifications.schedule([
      {
        id: Date.now() % 100000, // Unique ID based on timestamp
        title,
        body,
      },
    ]);

    console.log('[BackgroundSync] New message notification scheduled');
  } catch (err) {
    console.log(
      '[BackgroundSync] Failed to schedule notification',
      String(err)
    );
  }
}

addEventListener('backgroundSync', async (resolve, reject, args) => {
  try {
    console.log('[BackgroundSync] Task started', JSON.stringify(args || {}));

    // Check if we should perform sync (timestamp check to avoid redundant work)
    const shouldSync = await shouldPerformSync();
    if (!shouldSync) {
      console.log('[BackgroundSync] Sync skipped due to timestamp check');
      resolve();
      return;
    }

    // Retrieve active seekers from Preferences storage
    const activeSeekers = await getActiveSeekers();

    if (activeSeekers.length === 0) {
      console.log('[BackgroundSync] No active seekers, skipping sync');
      resolve();
      return;
    }

    // Get API base URL
    const apiBaseUrl = await getApiBaseUrl();
    console.log('[BackgroundSync] Using API URL:', apiBaseUrl);

    // Fetch messages from the protocol API
    let messages = [];
    try {
      messages = await fetchMessages(apiBaseUrl, activeSeekers);
      console.log('[BackgroundSync] Fetched', messages.length, 'messages');
    } catch (err) {
      console.log('[BackgroundSync] Failed to fetch messages:', String(err));
      // Don't reject - just log and continue
      resolve();
      return;
    }

    // Update last sync timestamp after successful fetch
    await setLastSyncTimestamp();

    // If new messages were found, show a notification
    if (messages.length > 0) {
      await showNewMessageNotification(messages.length);
    } else {
      console.log('[BackgroundSync] No new messages');
    }

    console.log('[BackgroundSync] Task completed successfully');
    resolve();
  } catch (error) {
    console.log(
      '[BackgroundSync] Task failed',
      typeof error === 'string' ? error : JSON.stringify(error || {})
    );
    reject(error);
  }
});
