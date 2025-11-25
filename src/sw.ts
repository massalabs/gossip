/// <reference lib="webworker" />
import {
  cleanupOutdatedCaches,
  createHandlerBoundToURL,
  precacheAndRoute,
} from 'workbox-precaching';
import { setCacheNameDetails } from 'workbox-core';
import { NavigationRoute, registerRoute } from 'workbox-routing';
import { protocolConfig } from './config/protocol';
import { defaultSyncConfig } from './config/sync';
import { RestMessageProtocol } from './api/messageProtocol/rest';
import type { EncryptedMessage } from './api/messageProtocol/types';
import { db } from './db';

declare let self: ServiceWorkerGlobalScope;

// Service Worker configuration constants
// Import from centralized config for easy adjustment
const FALLBACK_SYNC_INTERVAL_MS = defaultSyncConfig.fallbackSyncIntervalMs;
const APP_BUILD_ID = import.meta.env.VITE_APP_BUILD_ID ?? 'dev-local';

setCacheNameDetails({
  prefix: 'gossip',
  suffix: `-v${APP_BUILD_ID}`,
  precache: 'precache',
  runtime: 'runtime',
});

// Sync frequency tracking
interface SyncStats {
  lastSyncTime: number;
  syncCount: number;
  syncType: 'periodic' | 'fallback';
  syncIntervals: number[]; // Time between syncs in ms
}

const MAX_SYNC_INTERVALS_TO_TRACK = 10;
const syncStats: SyncStats = {
  lastSyncTime: 0,
  syncCount: 0,
  syncType: 'fallback',
  syncIntervals: [],
};

// Service Worker event types
interface SyncEvent extends Event {
  tag: string;
  waitUntil(promise: Promise<void>): void;
}

interface NotificationEvent extends Event {
  notification: Notification;
  waitUntil(promise: Promise<void>): void;
}

// Import message reception service (will be available in Service Worker context)
// Note: In a real implementation, you'd need to ensure WASM modules work in SW context
// For now, we'll use a simplified version that only fetches encrypted messages

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

  /**
   * Request active seekers from the main app
   * The main app will respond with all active seekers via postMessage
   */
  private async requestSeekersFromMainApp(): Promise<Uint8Array[]> {
    return new Promise(resolve => {
      // Try to get seekers from main app
      const clients = self.clients.matchAll({ type: 'window' });
      let resolved = false;

      clients
        .then(clientList => {
          if (clientList.length === 0) {
            // No clients available, return empty array
            if (!resolved) {
              resolved = true;
              resolve([]);
            }
            return;
          }

          // Request seekers from the first available client
          const client = Array.from(clientList)[0];
          const messageChannel = new MessageChannel();

          // Set timeout in case main app doesn't respond
          const timeoutId = setTimeout(() => {
            if (!resolved) {
              resolved = true;
              resolve([]);
            }
          }, 2000);

          // Set up message listener BEFORE sending postMessage to avoid race condition
          // If the main app responds very quickly, we need the listener to be ready
          messageChannel.port1.onmessage = event => {
            if (!resolved) {
              resolved = true;
              clearTimeout(timeoutId);
              const seekers = event.data?.seekers || [];
              // Convert array of arrays to Uint8Array[]
              const typedSeekers = seekers.map(
                (seeker: number[]) => new Uint8Array(seeker)
              );
              resolve(typedSeekers);
            }
          };

          // Send request to main app with the message channel port
          try {
            client.postMessage(
              {
                type: 'REQUEST_SEEKERS',
              },
              [messageChannel.port2]
            );
          } catch (_error) {
            // If postMessage fails, resolve with empty array
            if (!resolved) {
              resolved = true;
              clearTimeout(timeoutId);
              resolve([]);
            }
          }
        })
        .catch(() => {
          // If matchAll fails, resolve with empty array
          if (!resolved) {
            resolved = true;
            resolve([]);
          }
        });
    });
  }

  async fetchAllDiscussions(): Promise<{
    success: boolean;
    newMessagesCount: number;
  }> {
    try {
      // Request all active seekers from the main app
      // The main app has access to WASM session and can provide all seekers
      const seekers = await this.requestSeekersFromMainApp();

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
              announcement,
              fetchedAt: now,
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

self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();

  // Handle request to start/restart sync scheduler
  if (event.data && event.data.type === 'START_SYNC_SCHEDULER') {
    startFallbackSync();
    return;
  }
});

/**
 * Track sync frequency for monitoring and debugging
 */
function trackSync(syncType: 'periodic' | 'fallback'): void {
  const now = Date.now();
  const timeSinceLastSync =
    syncStats.lastSyncTime > 0 ? now - syncStats.lastSyncTime : 0;

  syncStats.syncCount++;
  syncStats.syncType = syncType;

  if (timeSinceLastSync > 0) {
    syncStats.syncIntervals.push(timeSinceLastSync);
    // Keep only the last N intervals
    if (syncStats.syncIntervals.length > MAX_SYNC_INTERVALS_TO_TRACK) {
      syncStats.syncIntervals.shift();
    }
  }

  syncStats.lastSyncTime = now;
}

// Register periodic background sync
self.addEventListener('sync', (event: Event) => {
  if ((event as SyncEvent).tag === 'gossip-message-sync') {
    // Check if app is active - if so, skip sync (main app handles it)
    (event as SyncEvent).waitUntil(
      hasActiveClients().then(isActive => {
        if (isActive) {
          // App is active - main app handles sync, skip this one
          console.log('Service Worker: Skipping periodic sync - app is active');
          return;
        }

        // App is in background - perform sync
        trackSync('periodic');
        return Promise.all([
          messageReception.fetchAllDiscussions(),
          messageReception.fetchAnnouncements(),
        ])
          .then(([messageResult, announcementResult]) => {
            const hasNewMessages =
              messageResult.success && messageResult.newMessagesCount > 0;
            const hasNewAnnouncements =
              announcementResult.success &&
              announcementResult.newAnnouncementsCount > 0;

            if (hasNewMessages || hasNewAnnouncements) {
              let body = '';
              if (hasNewMessages && hasNewAnnouncements) {
                body = `You have ${messageResult.newMessagesCount} new message${messageResult.newMessagesCount > 1 ? 's' : ''} and ${announcementResult.newAnnouncementsCount} new discussion${announcementResult.newAnnouncementsCount > 1 ? 's' : ''}`;
              } else if (hasNewMessages) {
                body = `You have ${messageResult.newMessagesCount} new message${messageResult.newMessagesCount > 1 ? 's' : ''}`;
              } else if (hasNewAnnouncements) {
                body = `You have ${announcementResult.newAnnouncementsCount} new discussion${announcementResult.newAnnouncementsCount > 1 ? 's' : ''}`;
              }

              // Show notification for new messages/announcements
              self.registration.showNotification('Gossip Messenger', {
                body,
                icon: '/favicon/favicon-96x96.png',
                badge: '/favicon/favicon-96x96.png',
                tag: 'gossip-new-messages',
                requireInteraction: false,
              });
            }
          })
          .catch(error => {
            console.error('Service Worker: Periodic sync failed', error);
          });
      })
    );
  }
});

/**
 * Check if the app has active window clients (app is open)
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
    return clients.some(client => {
      const windowClient = client as WindowClient;
      return (
        windowClient.focused === true ||
        windowClient.visibilityState === 'visible'
      );
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
 * Perform sync operation
 */
async function performSync(): Promise<void> {
  try {
    console.log('Service Worker: Syncing messages...');

    const [messageResult, announcementResult] = await Promise.all([
      messageReception.fetchAllDiscussions(),
      messageReception.fetchAnnouncements(),
    ]);

    const hasNewMessages =
      messageResult.success && messageResult.newMessagesCount > 0;
    const hasNewAnnouncements =
      announcementResult.success &&
      announcementResult.newAnnouncementsCount > 0;

    if (hasNewMessages || hasNewAnnouncements) {
      let body = '';
      if (hasNewMessages && hasNewAnnouncements) {
        body = `You have ${messageResult.newMessagesCount} new message${messageResult.newMessagesCount > 1 ? 's' : ''} and ${announcementResult.newAnnouncementsCount} new discussion${announcementResult.newAnnouncementsCount > 1 ? 's' : ''}`;
      } else if (hasNewMessages) {
        body = `You have ${messageResult.newMessagesCount} new message${messageResult.newMessagesCount > 1 ? 's' : ''}`;
      } else if (hasNewAnnouncements) {
        body = `You have ${announcementResult.newAnnouncementsCount} new discussion${announcementResult.newAnnouncementsCount > 1 ? 's' : ''}`;
      }

      // Show notification for new messages/discussions
      const isActive = await hasActiveClients();
      if (!isActive) {
        // App is in background - show notification
        await showNotificationIfAllowed('Echo Messenger', {
          body,
          icon: '/favicon/favicon-96x96.png',
          badge: '/favicon/favicon-96x96.png',
          tag: 'echo-new-messages',
          requireInteraction: false,
        });
      } else {
        // App is active - notify main app to refresh immediately
        const clients = await self.clients.matchAll({
          type: 'window',
          includeUncontrolled: false,
        });
        for (const client of clients) {
          client.postMessage({
            type: 'NEW_MESSAGES_DETECTED',
            messageCount: messageResult.newMessagesCount,
            announcementCount: announcementResult.newAnnouncementsCount,
          });
        }
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
    trackSync('fallback');
    await performSync();
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
    .then(isActive => {
      if (isActive) {
        // App is active - main app handles sync via useAppStateRefresh
        // Just reschedule to check again later (in case app goes to background)
        rescheduleNextCheck();
        return;
      }

      // App is in background - perform sync
      scheduleBackgroundSync();
    })
    .catch(error => {
      console.error('Service Worker: Error scheduling sync', error);
      // Fallback to default interval on error (only sync if app is not active)
      hasActiveClients()
        .then(isActive => {
          if (!isActive) {
            scheduleBackgroundSync();
          } else {
            // App is active, just reschedule check
            rescheduleNextCheck();
          }
        })
        .catch(() => {
          // If we can't check, assume app is not active and sync
          scheduleBackgroundSync();
        });
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

  // Check if scheduler is already starting or active
  if (sw.echoSyncStarting) {
    // Already starting, skip
    return;
  }

  const existingTimer = sw.echoSyncTimer;
  if (existingTimer) {
    // Timer already active, skip starting a new one
    return;
  }

  // Set flag synchronously before async operations
  sw.echoSyncStarting = true;

  // Start the dynamic sync scheduler
  // The flag will be cleared in scheduleNextSync once the timer is actually set
  scheduleNextSync();
}

// Start fallback sync when service worker activates
self.addEventListener('activate', event => {
  event.waitUntil(
    Promise.resolve().then(() => {
      startFallbackSync();
    })
  );
});

// Start sync immediately when service worker loads (if already activated)
// This handles the case where the service worker is already active when the page loads
// Use a small delay to ensure registration is ready
setTimeout(() => {
  if (self.registration.active) {
    startFallbackSync();
  }
}, 100);

// Handle notification clicks
self.addEventListener('notificationclick', (event: NotificationEvent) => {
  event.notification.close();

  event.waitUntil(
    self.clients
      .matchAll({ type: 'window' })
      .then((clientList: readonly WindowClient[]) => {
        // If app is already open, focus it
        for (const client of clientList) {
          if (client.url === '/' && 'focus' in client) {
            client.focus();
            return;
          }
        }
        // Otherwise, open a new window
        if (self.clients.openWindow) {
          self.clients.openWindow('/');
        }
      })
  );
});

// self.__WB_MANIFEST is the default injection point
precacheAndRoute(self.__WB_MANIFEST);

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
