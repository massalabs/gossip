/// <reference lib="webworker" />
import {
  cleanupOutdatedCaches,
  createHandlerBoundToURL,
  precacheAndRoute,
} from 'workbox-precaching';
import { clientsClaim, setCacheNameDetails } from 'workbox-core';
import { NavigationRoute, registerRoute } from 'workbox-routing';
import { protocolConfig } from './config/protocol';
import { defaultSyncConfig } from './config/sync';
import {
  RestMessageProtocol,
  type EncryptedMessage,
  GossipDatabase,
} from 'gossip-sdk';

// Create database instance for service worker
const db = new GossipDatabase();
import {
  getLastSyncTimestamp,
  setLastSyncTimestamp,
} from './utils/preferences';
import { APP_BUILD_ID } from './config/version';

declare let self: ServiceWorkerGlobalScope;

// Service Worker configuration constants
// Import from centralized config for easy adjustment
const FALLBACK_SYNC_INTERVAL_MS = defaultSyncConfig.fallbackSyncIntervalMs;

// Minimum interval between syncs to avoid redundant work (in milliseconds)
// If a sync was performed within this window, skip the current sync
const MIN_SYNC_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes

setCacheNameDetails({
  prefix: 'gossip',
  suffix: `-v${APP_BUILD_ID}`,
  precache: 'precache',
  runtime: 'runtime',
});

// Service Worker event types
interface SyncEvent extends Event {
  tag: string;
  waitUntil(promise: Promise<void>): void;
}

interface NotificationEvent extends Event {
  notification: Notification;
  waitUntil(promise: Promise<void>): void;
}

// Service Worker message reception logic
class ServiceWorkerMessageReception {
  private protocol: RestMessageProtocol;

  constructor() {
    // Use the shared RestMessageProtocol with the same config as the main app
    this.protocol = new RestMessageProtocol(
      protocolConfig.baseUrl,
      protocolConfig.timeout,
      protocolConfig.retryAttempts
    );
  }

  async fetchAllDiscussions(): Promise<{
    success: boolean;
    newMessagesCount: number;
  }> {
    try {
      // Get all active seekers from the database
      // These are updated by the main app after each fetchMessages() call
      const seekers = await db.getActiveSeekers();
      if (!seekers || seekers.length === 0) {
        return {
          success: true,
          newMessagesCount: 0,
        };
      }

      // Fetch messages for all seekers at once using the message protocol
      let encryptedMessages: EncryptedMessage[] = [];
      try {
        encryptedMessages = await this.protocol.fetchMessages(seekers);
      } catch (error) {
        console.error(
          'Service Worker: Failed to fetch messages via protocol:',
          error
        );
        // Return success: false if fetch fails
        return {
          success: false,
          newMessagesCount: 0,
        };
      }

      // Store encrypted messages in IndexedDB for the main app to process
      let actuallyAddedCount = 0;
      if (encryptedMessages.length > 0) {
        try {
          const now = new Date();
          await db.pendingEncryptedMessages.bulkAdd(
            encryptedMessages.map(msg => ({
              seeker: msg.seeker,
              ciphertext: msg.ciphertext,
              fetchedAt: now,
            }))
          );
          // All messages were added successfully
          actuallyAddedCount = encryptedMessages.length;
        } catch (error) {
          // Handle BulkError: some items may have been added successfully
          if (error instanceof Error && error.name === 'BulkError') {
            // Dexie BulkError has failures array and we can calculate success count
            const bulkError = error as unknown as {
              failures: Array<{ index: number }>;
              successCount?: number;
            };
            // Calculate how many were actually added
            // If successCount is available, use it; otherwise calculate from failures
            if (typeof bulkError.successCount === 'number') {
              actuallyAddedCount = bulkError.successCount;
            } else {
              // Calculate: total - failures = successes
              actuallyAddedCount =
                encryptedMessages.length - bulkError.failures.length;
            }
          } else if (
            error instanceof Error &&
            error.message.includes('ConstraintError')
          ) {
            // Single ConstraintError means none were added
            actuallyAddedCount = 0;
          } else {
            // Other errors - log them
            console.error(
              'Service Worker: Failed to store encrypted messages:',
              error
            );
            actuallyAddedCount = 0;
          }
        }
      }

      return {
        success: true,
        newMessagesCount: actuallyAddedCount,
      };
    } catch (error) {
      console.error('Failed to fetch messages for all discussions:', error);
      return {
        success: false,
        newMessagesCount: 0,
      };
    }
  }

  async fetchAnnouncements(): Promise<{
    success: boolean;
    newAnnouncementsCount: number;
  }> {
    try {
      // Fetch announcements from the API
      const announcements = await this.protocol.fetchAnnouncements();

      // Store announcements in IndexedDB for the main app to process
      let actuallyAddedCount = 0;
      if (announcements.length > 0) {
        try {
          const now = new Date();
          await db.pendingAnnouncements.bulkAdd(
            announcements.map(announcement => ({
              announcement: announcement.data,
              fetchedAt: now,
              counter: announcement.counter,
            }))
          );
          // All announcements were added successfully
          actuallyAddedCount = announcements.length;
        } catch (error) {
          // Handle BulkError: some items may have been added successfully
          if (error instanceof Error && error.name === 'BulkError') {
            // Dexie BulkError has failures array and we can calculate success count
            const bulkError = error as unknown as {
              failures: Array<{ index: number }>;
              successCount?: number;
            };
            // Calculate how many were actually added
            // If successCount is available, use it; otherwise calculate from failures
            if (typeof bulkError.successCount === 'number') {
              actuallyAddedCount = bulkError.successCount;
            } else {
              // Calculate: total - failures = successes
              actuallyAddedCount =
                announcements.length - bulkError.failures.length;
            }
          } else if (
            error instanceof Error &&
            error.message.includes('ConstraintError')
          ) {
            // Single ConstraintError means none were added
            actuallyAddedCount = 0;
          } else {
            // Other errors - log them
            console.error(
              'Service Worker: Failed to store announcements:',
              error
            );
            actuallyAddedCount = 0;
          }
        }
      }

      return {
        success: true,
        newAnnouncementsCount: actuallyAddedCount,
      };
    } catch (error) {
      console.error(
        'Service Worker: Failed to fetch announcements via protocol:',
        error
      );
      return {
        success: false,
        newAnnouncementsCount: 0,
      };
    }
  }
}

const messageReception = new ServiceWorkerMessageReception();

// ============================================================================
// EVENT LISTENER REGISTRATIONS
// All event listeners must be registered during initial script evaluation
// ============================================================================

// Handle messages from the main app
self.addEventListener('message', event => {
  // Handle SKIP_WAITING message for prompt update behavior
  // This allows the main app to trigger service worker activation
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
    return;
  }

  // Handle SEND_NOTIFICATION message for showing notifications from service worker
  // This is required for Android PWA and preferred for all platforms
  // see: https://developer.mozilla.org/en-US/docs/Web/API/Notifications_API#browser_compatibility
  if (event.data && event.data.type === 'SEND_NOTIFICATION') {
    const { title, body, tag, requireInteraction, data } =
      event.data.payload || {};

    if (!title) {
      console.error('Service Worker: SEND_NOTIFICATION missing title');
      return;
    }

    event.waitUntil(
      (async () => {
        await showNotificationIfAllowed(title, {
          body: body || '',
          icon: '/favicon/favicon-96x96.png',
          badge: '/favicon/favicon-96x96.png',
          tag: tag || 'gossip-notification',
          requireInteraction: requireInteraction || false,
          data: data || {},
        });
      })()
    );
    return;
  }
});

async function handleSyncEvent(event: SyncEvent): Promise<void> {
  if (event.tag === 'gossip-message-sync') {
    // Check if app is active - if so, skip sync (main app handles it)
    event.waitUntil(
      (async () => {
        const isActive = await hasActiveClients();
        if (isActive) {
          // App is active - main app handles sync, skip this one
          return;
        }

        // Check timestamp to avoid redundant sync
        if (!(await shouldPerformSync())) {
          return;
        }

        // App is in background - perform sync
        try {
          await performSyncAndNotify();
          // Update last sync timestamp after successful sync
          await setLastSyncTimestamp();
        } catch (error) {
          console.error('Service Worker: Periodic sync failed', error);
        }
      })()
    );
  }
}

// Register periodic background sync
self.addEventListener('sync', (event: Event) => {
  handleSyncEvent(event as SyncEvent);
});

self.addEventListener('periodicsync', (event: Event) => {
  handleSyncEvent(event as SyncEvent);
});

// Skip waiting and activate immediately when new service worker is installed
self.addEventListener('install', event => {
  // Skip waiting to activate the new service worker immediately
  // This ensures updates are applied without requiring all pages to close
  event.waitUntil(self.skipWaiting());
});

// Start fallback sync when service worker activates
self.addEventListener('activate', event => {
  event.waitUntil(
    Promise.resolve().then(() => {
      // Use Workbox's clientsClaim to take control of all clients immediately
      // This is more reliable than manual self.clients.claim()
      clientsClaim();

      // On mobile, service workers may be terminated, so we rely more on
      // Periodic Background Sync API. The fallback timer is less reliable.
      startFallbackSync();
    })
  );
});

// Handle notification clicks
self.addEventListener('notificationclick', (event: NotificationEvent) => {
  event.notification.close();

  // Get the target URL from notification data, default to discussions
  const notificationData = event.notification.data as
    | { type?: string; url?: string; contactUserId?: string }
    | undefined;
  let targetUrl = '/discussions';

  if (notificationData?.url) {
    targetUrl = notificationData.url;
  } else if (notificationData?.contactUserId) {
    // Navigate to specific discussion if contactUserId is provided
    targetUrl = `/discussion/${notificationData.contactUserId}`;
  }

  event.waitUntil(
    (async (): Promise<void> => {
      const clientList = await self.clients.matchAll({
        type: 'window',
        includeUncontrolled: true,
      });

      // Try to find an existing window and navigate it
      for (const client of clientList as WindowClient[]) {
        // Check if this is our app (same origin)
        const clientUrl = new URL(client.url);
        const swUrl = new URL(self.registration.scope);
        if (clientUrl.origin === swUrl.origin && 'focus' in client) {
          // Navigate to target URL and focus
          let navigatedClient: WindowClient | null = null;
          try {
            navigatedClient = await client.navigate(targetUrl);
          } catch (_error) {
            // Navigation failed (e.g., CORS or other restrictions)
            // Try the next client instead
            continue;
          }

          if (navigatedClient) {
            try {
              await navigatedClient.focus();
            } catch (_error) {
              // Focus failed, but navigation succeeded, so we're done
            }
            return;
          }
        }
      }
      // No existing window found, open a new one
      if (self.clients.openWindow) {
        await self.clients.openWindow(targetUrl);
      }
    })()
  );
});

// ============================================================================
// FUNCTION DEFINITIONS
// ============================================================================

/**
 * Check if enough time has passed since the last sync.
 * Returns true if sync should proceed, false if it should be skipped.
 * Uses timestamp stored in Capacitor Preferences (accessible by service worker and background runner).
 * Also checks if the device is online.
 */
async function shouldPerformSync(): Promise<boolean> {
  const lastSyncTime = await getLastSyncTimestamp();
  if (lastSyncTime === 0) {
    // No previous sync recorded, proceed
    return true;
  }

  const timeSinceLastSync = Date.now() - lastSyncTime;
  if (timeSinceLastSync < MIN_SYNC_INTERVAL_MS) {
    console.log(
      `Service Worker: Skipping sync - too soon since last sync (${Math.round(timeSinceLastSync / 1000)}s ago, minimum is ${Math.round(MIN_SYNC_INTERVAL_MS / 1000)}s)`
    );
    return false;
  }

  return true;
}

/**
 * Build notification body text for new messages/announcements
 */
function buildNewItemsBody(
  messageCount: number,
  announcementCount: number
): string {
  if (messageCount > 0 && announcementCount > 0) {
    return `You have ${messageCount} new message${messageCount > 1 ? 's' : ''} and ${announcementCount} new contact request${announcementCount > 1 ? 's' : ''}`;
  }
  if (messageCount > 0) {
    return `You have ${messageCount} new message${messageCount > 1 ? 's' : ''}`;
  }
  if (announcementCount > 0) {
    return `You have ${announcementCount} new contact request${announcementCount > 1 ? 's' : ''}`;
  }
  return '';
}

/**
 * Show a unified notification for messages/announcements
 */
async function showNewItemsNotification(
  messageCount: number,
  announcementCount: number
): Promise<void> {
  const body = buildNewItemsBody(messageCount, announcementCount);
  if (!body) return;

  const title = announcementCount > 0 ? 'New contact request' : 'New message';
  await showNotificationIfAllowed(title, {
    body,
    icon: '/favicon/favicon-96x96.png',
    badge: '/favicon/favicon-96x96.png',
    tag: 'gossip-sw-notification',
    requireInteraction: false,
    data: {
      type: 'new-messages',
      url: '/discussions',
    },
  });
}

/**
 * Check if the app has active window clients (app is open)
 *
 * Note: On mobile PWAs, the app may be considered "visible" even when in the background
 * if it's installed as a standalone app. This function checks for focused/visible state.
 */
async function hasActiveClients(): Promise<boolean> {
  try {
    // Try with controlled clients first
    let clients = await self.clients.matchAll({
      type: 'window',
      includeUncontrolled: false,
    });

    // If no controlled clients, try with uncontrolled (in case service worker just registered)
    if (clients.length === 0) {
      clients = await self.clients.matchAll({
        type: 'window',
        includeUncontrolled: true,
      });
    }

    if (clients.length === 0) {
      return false;
    }

    // Check if any client is focused or visible
    // On mobile PWAs, visibilityState may be 'visible' even when app is backgrounded,
    // but focused should be false when truly in background
    return clients.some(client => {
      const windowClient = client as WindowClient;
      // Prefer focused check - more reliable on mobile
      // If focused is explicitly true, app is definitely active
      // We use strict equality to avoid treating undefined as active
      return windowClient.focused === true;
    });
  } catch (error) {
    console.error('Service Worker: Error checking active clients', error);
    return false;
  }
}

/**
 * Show notification if permission is granted
 * Catches permission errors gracefully
 */
async function showNotificationIfAllowed(
  title: string,
  options: NotificationOptions
): Promise<void> {
  try {
    await self.registration.showNotification(title, options);
  } catch (error) {
    // Silently handle permission errors
    if (
      !(
        error instanceof TypeError &&
        error.message.includes('notification permission')
      )
    ) {
      console.error('Service Worker: Failed to show notification:', error);
    }
  }
}

/**
 * Perform sync and, if needed, show a notification or notify clients
 */
async function performSyncAndNotify(): Promise<void> {
  try {
    // const [messageResult, announcementResult] = await Promise.all([
    //   messageReception.fetchAllDiscussions(),
    //   messageReception.fetchAnnouncements(),
    // ]);

    // Disable announcements sync for now
    const messageResult = await messageReception.fetchAllDiscussions();
    const announcementResult = {
      success: true,
      newAnnouncementsCount: 0,
    };

    const hasNewMessages =
      messageResult.success && messageResult.newMessagesCount > 0;
    const hasNewAnnouncements =
      announcementResult.success &&
      announcementResult.newAnnouncementsCount > 0;

    if (hasNewMessages || hasNewAnnouncements) {
      // Show notification for new messages/discussions
      const isActive = await hasActiveClients();
      if (!isActive) {
        // App is in background - show notification
        await showNewItemsNotification(
          messageResult.newMessagesCount,
          announcementResult.newAnnouncementsCount
        );
      }
    }
  } catch (error) {
    console.error('Service Worker: Sync failed', error);
  }
}

/**
 * Get the service worker global scope with sync timer properties
 */
function getServiceWorkerScope(): ServiceWorkerGlobalScope & {
  echoSyncTimer?: ReturnType<typeof setTimeout>;
  echoSyncStarting?: boolean;
} {
  return self as ServiceWorkerGlobalScope & {
    echoSyncTimer?: ReturnType<typeof setTimeout>;
    echoSyncStarting?: boolean;
  };
}

/**
 * Reschedule the next check (when app is active, no sync needed)
 * Main app handles sync via useAppStateRefresh
 */
function rescheduleNextCheck(): void {
  const sw = getServiceWorkerScope();
  const timeoutId = setTimeout(() => {
    scheduleNextSync();
  }, FALLBACK_SYNC_INTERVAL_MS);
  sw.echoSyncTimer = timeoutId;
  sw.echoSyncStarting = false;
}

/**
 * Schedule background sync (when app is in background/closed)
 */
function scheduleBackgroundSync(): void {
  const sw = getServiceWorkerScope();
  const timeoutId = setTimeout(async () => {
    // Check timestamp to avoid redundant sync
    if (!(await shouldPerformSync())) {
      // Still schedule next sync check
      scheduleNextSync();
      return;
    }

    await performSyncAndNotify();
    // Update last sync timestamp after successful sync
    await setLastSyncTimestamp();
    // Schedule next sync (will re-check app state)
    scheduleNextSync();
  }, FALLBACK_SYNC_INTERVAL_MS);
  sw.echoSyncTimer = timeoutId;
  sw.echoSyncStarting = false;
}

/**
 * Dynamic sync scheduler that adjusts interval based on app state
 * When app is active: schedules a check at FALLBACK_SYNC_INTERVAL_MS to detect when app goes to background
 *   (main app handles sync via useAppStateRefresh, so no sync is performed)
 * When app is in background/closed: performs sync and schedules next check
 */
function scheduleNextSync(): void {
  // Clear any existing timer
  const sw = getServiceWorkerScope();
  const existingTimer = sw.echoSyncTimer;
  if (existingTimer) {
    clearTimeout(existingTimer);
  }

  hasActiveClients()
    .then((isActive: boolean) => {
      if (isActive) {
        // App is active - main app handles sync via useAppStateRefresh
        // Just reschedule to check again later (in case app goes to background)
        rescheduleNextCheck();
      } else {
        // App is in background - perform sync
        scheduleBackgroundSync();
      }
    })
    .catch(error => {
      // hasActiveClients() should never reject (it catches errors internally),
      // but if the Promise chain fails for any reason, assume app is not active and sync
      console.error('Service Worker: Error scheduling sync', error);
      scheduleBackgroundSync();
    });
}

// Fallback timer-based sync with dynamic intervals
// Note: On mobile devices, service workers may be terminated, making this less reliable
function startFallbackSync() {
  // Check if we're in service worker context
  if (typeof self === 'undefined' || !self.registration) {
    console.error(
      'Service Worker: Not in service worker context, skipping fallback sync setup'
    );
    return;
  }

  // Use a flag to prevent race conditions when called multiple times in quick succession
  const sw = self as ServiceWorkerGlobalScope & {
    echoSyncTimer?: ReturnType<typeof setTimeout>;
    echoSyncStarting?: boolean;
  };

  // Check if scheduler is already starting - skip to prevent race conditions
  if (sw.echoSyncStarting) {
    return;
  }

  // Clear any stale timer from previous runs
  const existingTimer = sw.echoSyncTimer;
  if (existingTimer) {
    clearTimeout(existingTimer);
    sw.echoSyncTimer = undefined;
  }

  // Set flag synchronously before async operations
  sw.echoSyncStarting = true;

  // Start the dynamic sync scheduler
  // The flag will be cleared in scheduleNextSync once the timer is actually set
  scheduleNextSync();
}

// ============================================================================
// INITIALIZATION CODE
// Code that runs after all event listeners are registered
// ============================================================================

// Start sync immediately when service worker loads (if already activated)
// This handles the case where the service worker is already active when the page loads
// Use a small delay to ensure registration is ready
// Note: This may run in addition to the activate event, but startFallbackSync() will handle duplicates
setTimeout(() => {
  if (self.registration.active) {
    startFallbackSync();
  }
}, 100);

// self.__WB_MANIFEST is the default injection point
// Add revision info to index.html to avoid Workbox warning
const manifest = self.__WB_MANIFEST.map(entry => {
  // If entry is a string, convert to object format
  const url = typeof entry === 'string' ? entry : entry.url;

  // Add revision to index.html if it doesn't have one
  if (url === 'index.html' || url === '/index.html') {
    return {
      url,
      revision:
        typeof entry === 'object' && entry.revision
          ? entry.revision
          : APP_BUILD_ID, // Use build ID as revision
    };
  }

  // Return entry as-is (already has revision or doesn't need one)
  return entry;
});

precacheAndRoute(manifest);

// clean old assets
cleanupOutdatedCaches();

/** @type {RegExp[] | undefined} */
let allowlist;
// in dev mode, we disable precaching to avoid caching issues
if (import.meta.env.DEV) allowlist = [/^\/$/];

// to allow work offline
registerRoute(
  new NavigationRoute(createHandlerBoundToURL('index.html'), { allowlist })
);
