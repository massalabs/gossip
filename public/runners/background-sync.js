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

/* global addEventListener, CapacitorNotifications, CapacitorKV, fetch */

function logDebug() {
  // BackgroundRunner has no access to the app bundle or shared TS logger.
  // Keep this as a no-op so release runners never emit protocol metadata.
}

// Keys used for BackgroundRunner storage (via CapacitorKV)
const ACTIVE_SEEKERS_KEY = 'gossip-active-seekers';
const API_BASE_URL_KEY = 'gossip-api-base-url';
const LAST_SYNC_TIMESTAMP_KEY = 'gossip-last-sync-timestamp';
const SYNC_LOCK_KEY = 'gossip-sync-lock-time';
const ACCOUNT_CLEANUP_BLOCK_KEY = 'gossip-account-cleanup-blocked-v1';
const ACCOUNT_OUTPUT_GENERATION_KEY = 'gossip-account-output-generation-v1';
// Must match BACKGROUND_SYNC_PRESET_KV_KEY in src/utils/preferences.ts
const SYNC_PRESET_KEY = 'gossip-sync-preset';

// Fallback API URL if not stored in preferences
const DEFAULT_API_BASE_URL = 'https://gossip.massa.net/api';

// Minimum interval between syncs — depends on user preset (read from KV)
const MIN_SYNC_INTERVAL_MAX_MS = 1 * 60 * 1000; // 1 minute — max reactivity
const MIN_SYNC_INTERVAL_BALANCED_MS = 5 * 60 * 1000; // 5 minutes — fewer redundant fetches

/**
 * Retrieve active seekers from BackgroundRunner storage.
 * Reads from BackgroundRunner's storage (net.massa.gossip.background.sync)
 * which is written to by the main app via BackgroundRunnerStorage plugin.
 *
 * Returns an array of base64-encoded seeker strings, or an empty array if none found.
 */
async function getAccountOutputGeneration() {
  if (typeof CapacitorKV === 'undefined' || !CapacitorKV?.get) return null;
  try {
    return (
      extractKVValue(await CapacitorKV.get(ACCOUNT_OUTPUT_GENERATION_KEY)) ??
      '0'
    );
  } catch {
    return null;
  }
}

async function isAccountCleanupBlocked() {
  if (typeof CapacitorKV === 'undefined' || !CapacitorKV?.get) return true;
  try {
    const value = extractKVValue(
      await CapacitorKV.get(ACCOUNT_CLEANUP_BLOCK_KEY)
    );
    return typeof value === 'string' && value.length > 0;
  } catch {
    return true;
  }
}

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
    logDebug('[BackgroundSync] Failed to get active seekers:', String(err));
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
    logDebug(
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
  } catch (err) {
    logDebug('[BackgroundSync] Failed to update active seekers:', String(err));
    // Silently ignore - don't fail the sync if we can't update seekers
  }
}

/**
 * Minimum time between successful sync attempts (user preset in KV).
 */
async function getMinSyncIntervalMs() {
  try {
    if (typeof CapacitorKV === 'undefined' || !CapacitorKV?.get) {
      return MIN_SYNC_INTERVAL_MAX_MS;
    }
    const raw = await CapacitorKV.get(SYNC_PRESET_KEY);
    const v = extractKVValue(raw);
    if (v === 'balanced') {
      return MIN_SYNC_INTERVAL_BALANCED_MS;
    }
  } catch (err) {
    logDebug('[BackgroundSync] Preset read failed:', String(err));
  }
  return MIN_SYNC_INTERVAL_MAX_MS;
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

  const minMs = await getMinSyncIntervalMs();
  const timeSinceLastSync = Date.now() - lastSyncTimestamp;
  if (timeSinceLastSync < minMs) {
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
    logDebug('[BackgroundSync] Fetch error:', String(fetchErr));
    throw fetchErr;
  }

  if (!response.ok) {
    const errorText = await response
      .text()
      .catch(() => 'Unable to read error body');
    logDebug(
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
    logDebug('[BackgroundSync] Parse error:', String(parseErr));
    throw parseErr;
  }

  return data || [];
}

/**
 * Show a notification for new messages.
 * @param {number} messageCount - Number of new messages
 */
async function showNewMessageNotification(messageCount, outputGeneration) {
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

    const notificationId = Date.now() % 100000; // Unique ID based on timestamp

    await CapacitorNotifications.schedule([
      {
        id: notificationId,
        title,
        body,
        smallIcon: 'ic_notification',
        autoCancel: true,
        gossipOutputGeneration: outputGeneration,
        scheduleAt: new Date(Date.now() + 1_000),
      },
    ]);
  } catch (err) {
    logDebug('[BackgroundSync] Failed to schedule notification:', String(err));
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

// Maximum time to wait before releasing sync lock (90 seconds)
// This acts as a safety timeout in case the sync doesn't complete.
// Normal syncs should complete in seconds, so 90 seconds is generous.
const SYNC_LOCK_TIMEOUT_MS = 90 * 1000;

async function ownsSyncLock(token) {
  if (!token || typeof CapacitorKV === 'undefined' || !CapacitorKV?.get) {
    return false;
  }
  const current = extractKVValue(await CapacitorKV.get(SYNC_LOCK_KEY));
  return current === token;
}

/** Acquire an owner-tagged lock and verify that our write won. */
async function acquireSyncLock() {
  try {
    if (
      typeof CapacitorKV === 'undefined' ||
      !CapacitorKV?.get ||
      !CapacitorKV?.set
    ) {
      logDebug('[BackgroundSync] CapacitorKV unavailable; failing closed');
      return null;
    }
    const currentTime = Date.now();
    const lockValue = extractKVValue(await CapacitorKV.get(SYNC_LOCK_KEY));
    if (lockValue) {
      const lockTime = parseInt(lockValue, 10);
      const lockAge = currentTime - lockTime;
      if (!isNaN(lockTime) && lockAge >= 0 && lockAge < SYNC_LOCK_TIMEOUT_MS) {
        return null;
      }
    }
    const token = `${currentTime}:${Math.random().toString(36).slice(2)}`;
    await CapacitorKV.set(SYNC_LOCK_KEY, token);
    return (await ownsSyncLock(token)) ? token : null;
  } catch (err) {
    logDebug('[BackgroundSync] Could not acquire sync lock:', String(err));
    return null;
  }
}

async function refreshSyncLock(token) {
  try {
    const owner = token.substring(token.indexOf(':') + 1);
    const refreshed = `${Date.now()}:${owner}`;
    await CapacitorKV.set(SYNC_LOCK_KEY, refreshed);
    return (await ownsSyncLock(refreshed)) ? refreshed : null;
  } catch {
    return null;
  }
}

/** Atomically remove the lock only if this execution still owns it. */
async function releaseSyncLock(token) {
  try {
    if (typeof CapacitorKV === 'undefined' || !CapacitorKV?.set) return;
    await CapacitorKV.set(SYNC_LOCK_KEY, `release:${token}`);
  } catch (err) {
    logDebug('[BackgroundSync] Could not release sync lock:', String(err));
  }
}

let syncExecutionTail = Promise.resolve();

addEventListener('backgroundSync', async (resolve, reject, args) => {
  const predecessor = syncExecutionTail;
  let releaseExecution;
  syncExecutionTail = new Promise(release => {
    releaseExecution = release;
  });
  await predecessor;

  let lockToken = null;
  let lockHeartbeat = null;
  let lockHeartbeatTask = Promise.resolve();
  try {
    // Acquire sync lock first to prevent concurrent executions
    lockToken = await acquireSyncLock();
    if (!lockToken) {
      logDebug(
        '[BackgroundSync] Sync lock is held, skipping sync (another sync is running)'
      );
      resolve();
      return;
    }
    lockHeartbeat = setInterval(() => {
      lockHeartbeatTask = lockHeartbeatTask.then(async () => {
        if (!lockToken) return;
        lockToken = await refreshSyncLock(lockToken);
      });
    }, 10_000);

    if (await isAccountCleanupBlocked()) {
      resolve();
      return;
    }

    // Check network connectivity
    if (!isNetworkAvailable()) {
      logDebug('[BackgroundSync] Network unavailable, skipping sync');
      resolve();
      return;
    }

    // Check if we should perform sync (timestamp check to avoid redundant work)
    const shouldSync = await shouldPerformSync();
    if (!shouldSync) {
      resolve();
      return;
    }

    if (!(await ownsSyncLock(lockToken))) {
      resolve();
      return;
    }

    const outputGeneration = await getAccountOutputGeneration();
    if (outputGeneration === null) {
      resolve();
      return;
    }

    // Retrieve active seekers from BackgroundRunner storage
    const activeSeekers = await getActiveSeekers();

    if (activeSeekers.length === 0) {
      logDebug('[BackgroundSync] No active seekers, skipping sync');
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
      logDebug('[BackgroundSync] Fetch failed:', String(err));
      resolve();
      return;
    }

    if (!(await ownsSyncLock(lockToken))) {
      resolve();
      return;
    }

    // Recheck after asynchronous network work. Cleanup sets this tombstone
    // before waiting for our lock, so no old-account result can escape.
    if (await isAccountCleanupBlocked()) {
      resolve();
      return;
    }

    // If new messages were found, show a notification and remove seekers
    if (messages.length > 0) {
      await showNewMessageNotification(messages.length, outputGeneration);
      logDebug(`[BackgroundSync] Found ${messages.length} new message(s)`);

      // Remove seekers that returned messages to avoid duplicate notifications
      await removeSeekersWithMessages(activeSeekers, messages);
    }

    // Update last sync timestamp after successful fetch
    await setLastSyncTimestamp();

    resolve();
  } catch (error) {
    logDebug('[BackgroundSync] Task failed:', String(error));
    reject(error);
  } finally {
    // Always release the lock when sync completes (success or failure)
    if (lockHeartbeat) clearInterval(lockHeartbeat);
    await lockHeartbeatTask;
    if (lockToken) {
      await releaseSyncLock(lockToken);
    }
    releaseExecution();
  }
});
