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

// Keys used for BackgroundRunner storage (via CapacitorKV)
const ACTIVE_SEEKERS_KEY = 'gossip-active-seekers';
const API_BASE_URL_KEY = 'gossip-api-base-url';
const LAST_SYNC_TIMESTAMP_KEY = 'gossip-last-sync-timestamp';

// Fallback API URL if not stored in preferences
const DEFAULT_API_BASE_URL = 'https://gossip.massa.net/api';

// Minimum interval between syncs to avoid redundant work
// If a sync was performed within this window, skip the current sync
const MIN_SYNC_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes

/**
 * Retrieve active seekers from BackgroundRunner storage.
 * Reads from BackgroundRunner's storage (net.massa.gossip.background.sync)
 * which is written to by the main app via BackgroundRunnerStorage plugin.
 *
 * Returns an array of base64-encoded seeker strings, or an empty array if none found.
 */
async function getActiveSeekers() {
  try {
    if (typeof CapacitorKV === 'undefined' || !CapacitorKV?.get) {
      return [];
    }

    const rawValue = await CapacitorKV.get(ACTIVE_SEEKERS_KEY);
    const value = extractKVValue(rawValue);

    if (!value) {
      return [];
    }

    const seekers = JSON.parse(value);
    return seekers;
  } catch (err) {
    console.log('[BackgroundSync] Failed to get active seekers:', String(err));
    return [];
  }
}

/**
 * Extract value from CapacitorKV result.
 * Handles both iOS format ({ value: "..." }) and Android format ("...")
 */
function extractKVValue(rawValue) {
  if (!rawValue) return null;
  if (typeof rawValue === 'object' && 'value' in rawValue) {
    return rawValue.value;
  }
  return rawValue;
}

/**
 * Retrieve the API base URL from BackgroundRunner storage or use default.
 */
async function getApiBaseUrl() {
  try {
    if (typeof CapacitorKV !== 'undefined' && CapacitorKV?.get) {
      const rawValue = await CapacitorKV.get(API_BASE_URL_KEY);
      const storedUrl = extractKVValue(rawValue);
      if (storedUrl) {
        return storedUrl;
      }
    }
  } catch (err) {
    console.log(
      '[BackgroundSync] Failed to get API URL from storage:',
      String(err)
    );
  }
  return DEFAULT_API_BASE_URL;
}

/**
 * Retrieve the last sync timestamp from BackgroundRunner storage.
 * Returns 0 if not found or on error.
 */
async function getLastSyncTimestamp() {
  try {
    if (typeof CapacitorKV !== 'undefined' && CapacitorKV?.get) {
      const rawValue = await CapacitorKV.get(LAST_SYNC_TIMESTAMP_KEY);
      const value = extractKVValue(rawValue);
      if (value) {
        const timestamp = parseInt(value, 10);
        if (!isNaN(timestamp)) {
          return timestamp;
        }
      }
    }
  } catch (err) {
    // Silently ignore
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
    // Silently ignore
  }
}

/**
 * Update active seekers by removing seekers that returned messages.
 * This prevents duplicate notifications for the same messages on subsequent syncs.
 * @param {string[]} currentSeekers - Current list of active seekers (base64-encoded)
 * @param {Array<{key: string, value: string}>} messages - Messages returned from API
 * @returns {Promise<void>}
 */
async function removeSeekersWithMessages(currentSeekers, messages) {
  try {
    if (typeof CapacitorKV === 'undefined' || !CapacitorKV?.set) {
      return;
    }

    // Extract unique seekers from messages (each message has a 'key' field with the seeker)
    const seekersWithMessages = new Set();
    for (const message of messages) {
      if (message && message.key) {
        seekersWithMessages.add(message.key);
      }
    }

    // If no messages, nothing to remove
    if (seekersWithMessages.size === 0) {
      return;
    }

    // Filter out seekers that returned messages
    const remainingSeekers = currentSeekers.filter(
      seeker => !seekersWithMessages.has(seeker)
    );

    // Update stored active seekers
    const updatedValue = JSON.stringify(remainingSeekers);
    await CapacitorKV.set(ACTIVE_SEEKERS_KEY, updatedValue);

    console.log(
      '[BackgroundSync] Removed',
      seekersWithMessages.size,
      'seeker(s) that returned messages. Remaining:',
      remainingSeekers.length
    );
  } catch (err) {
    console.log(
      '[BackgroundSync] Failed to update active seekers:',
      String(err)
    );
    // Silently ignore - don't fail the sync if we can't update seekers
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
  // Normalize baseUrl: remove trailing slashes to avoid double slashes
  const normalizedBaseUrl = baseUrl.replace(/\/+$/, '');
  const url = `${normalizedBaseUrl}/messages/fetch`;
  const requestBody = JSON.stringify({ seekers });

  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: requestBody,
    });
  } catch (fetchErr) {
    console.log('[BackgroundSync] Fetch error:', String(fetchErr));
    throw fetchErr;
  }

  if (!response.ok) {
    const errorText = await response
      .text()
      .catch(() => 'Unable to read error body');
    console.log(
      '[BackgroundSync] HTTP error:',
      response.status,
      errorText.substring(0, 100)
    );
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }

  let data;
  try {
    const responseText = await response.text();
    data = JSON.parse(responseText);
  } catch (parseErr) {
    console.log('[BackgroundSync] Parse error:', String(parseErr));
    throw parseErr;
  }

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
  } catch (err) {
    console.log(
      '[BackgroundSync] Failed to schedule notification:',
      String(err)
    );
  }
}

/**
 * Check network connectivity before attempting sync.
 * Uses the navigator.onLine property if available.
 * @returns {boolean} - True if online or unknown, false if definitely offline
 */
function isNetworkAvailable() {
  // navigator.onLine may not be available in all background contexts
  if (typeof navigator !== 'undefined' && 'onLine' in navigator) {
    return navigator.onLine;
  }
  // If we can't determine, assume online and let fetch fail if not
  return true;
}

addEventListener('backgroundSync', async (resolve, reject, args) => {
  try {
    // Check network connectivity first
    if (!isNetworkAvailable()) {
      console.log('[BackgroundSync] Network unavailable, skipping sync');
      resolve();
      return;
    }

    // Check if we should perform sync (timestamp check to avoid redundant work)
    const shouldSync = await shouldPerformSync();
    if (!shouldSync) {
      resolve();
      return;
    }

    // Retrieve active seekers from BackgroundRunner storage
    const activeSeekers = await getActiveSeekers();

    if (activeSeekers.length === 0) {
      console.log('[BackgroundSync] No active seekers, skipping sync');
      resolve();
      return;
    }

    // Get API base URL
    const apiBaseUrl = await getApiBaseUrl();

    // Fetch messages from the protocol API
    let messages = [];
    try {
      messages = await fetchMessages(apiBaseUrl, activeSeekers);
    } catch (err) {
      console.log('[BackgroundSync] Fetch failed:', String(err));
      resolve();
      return;
    }

    // If new messages were found, show a notification and remove seekers
    if (messages.length > 0) {
      await showNewMessageNotification(messages.length);
      console.log('[BackgroundSync] Found', messages.length, 'new message(s)');

      // Remove seekers that returned messages to avoid duplicate notifications
      await removeSeekersWithMessages(activeSeekers, messages);
    }

    // Update last sync timestamp after successful fetch
    await setLastSyncTimestamp();

    resolve();
  } catch (error) {
    console.log('[BackgroundSync] Task failed:', String(error));
    reject(error);
  }
});
