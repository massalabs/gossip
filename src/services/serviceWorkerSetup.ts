/**
 * Service Worker Setup
 *
 * Handles service worker registration, message listening, and sync scheduler initialization.
 */

import { notificationService } from './notifications';
import { defaultSyncConfig } from '../config/sync';
import { setApiBaseUrlForBackgroundSync } from '../db';
import { protocolConfig } from '../config/protocol';
/**
 * Setup service worker: register, listen for messages, and start sync scheduler
 * Also initializes background sync (notifications, periodic sync, online listener)
 */
export async function setupServiceWorker(): Promise<void> {
  if (!('serviceWorker' in navigator)) {
    return;
  }

  // Setup controller change listener to reload page when new service worker takes control
  setupControllerChangeListener();

  // Register service worker and setup sync scheduler
  await registerAndStartSync();

  // Initialize background sync: request notification permission, register periodic sync, setup online listener
  await initializeBackgroundSync();
}

/**
 * Setup controller change listener to reload page when new service worker takes control
 */
function setupControllerChangeListener(): void {
  let refreshing = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    // Reload the page when a new service worker takes control
    // This ensures the page uses the new service worker code immediately
    if (!refreshing) {
      refreshing = true;
      window.location.reload();
    }
  });
}

/**
 * Register service worker and start sync scheduler
 */
async function registerAndStartSync(): Promise<void> {
  try {
    const registrations = await navigator.serviceWorker.getRegistrations();

    if (registrations.length === 0) {
      // No registration found, register manually
      await registerServiceWorker();
    } else {
      // Service worker already registered
      await handleExistingRegistration();
    }
  } catch (error) {
    console.error('App: Error checking service worker registrations:', error);
  }
}

/**
 * Register a new service worker
 */
async function registerServiceWorker(): Promise<void> {
  // According to VitePWA docs: https://vite-pwa-org.netlify.app/guide/development.html#injectmanifest-strategy
  // In dev mode: '/dev-sw.js?dev-sw' with type: 'module'
  // In production: '/sw.js' with type: 'classic'
  const swUrl =
    import.meta.env.MODE === 'production' ? '/sw.js' : '/dev-sw.js?dev-sw';
  const swType = import.meta.env.MODE === 'production' ? 'classic' : 'module';

  try {
    // In dev mode, VitePWA serves the service worker dynamically
    // Skip the HEAD check and register directly - the browser will handle errors
    // In production, we can optionally verify the file exists first
    if (import.meta.env.MODE === 'production') {
      // Optional: verify file exists in production
      try {
        const response = await fetch(swUrl, { method: 'HEAD' });
        if (!response.ok) {
          console.warn(
            `Service worker at ${swUrl} returned status ${response.status}`
          );
          return;
        }
      } catch (fetchError) {
        console.warn(
          `Could not verify service worker at ${swUrl}:`,
          fetchError
        );
        // Continue anyway - registration will fail if file doesn't exist
      }
    }

    // Register service worker - it will automatically start sync scheduler on activate event
    await navigator.serviceWorker.register(swUrl, {
      scope: '/',
      type: swType,
    });

    return;
  } catch (error) {
    console.error(`Failed to register service worker at ${swUrl}:`, error);
  }

  // If we get here, all attempts failed
  console.error(
    'App: Failed to register service worker. Sync will only work when app is open.'
  );
}

/**
 * Handle existing service worker registration
 */
async function handleExistingRegistration(): Promise<void> {
  try {
    const registration = await navigator.serviceWorker.getRegistration();
    if (!registration) {
      return;
    }

    // Service worker will automatically start sync scheduler on activate event
    // or when it loads if already activated (handled in sw.ts)
    // No need to send message - it's handled automatically
    await navigator.serviceWorker.ready;
  } catch (error) {
    console.error('App: Error waiting for service worker ready:', error);
  }
}

/**
 * Initialize background sync: notifications, periodic sync, and online listener
 */
async function initializeBackgroundSync(): Promise<void> {
  try {
    // Store API base URL for native background runner access
    // The background runner can't access import.meta.env, so we persist it via Preferences
    await setApiBaseUrlForBackgroundSync(protocolConfig.baseUrl);

    // Request notification permission
    await notificationService.requestPermission();

    // Register periodic background sync
    await registerPeriodicSync();
  } catch (error) {
    console.error('[App] Failed to initialize background sync service:', error);
  }
}

/**
 * Register periodic background sync
 * Note: On mobile devices, browsers may throttle or delay syncs significantly
 * Requesting 5 minutes, but actual syncs may be much less frequent
 */
async function registerPeriodicSync(): Promise<void> {
  const hasSyncAPI = 'sync' in window.ServiceWorkerRegistration.prototype;

  if (!hasSyncAPI) {
    return;
  }

  try {
    const registration = await navigator.serviceWorker.ready;

    // Use centralized sync config
    const PERIODIC_SYNC_MIN_INTERVAL_MS =
      defaultSyncConfig.periodicSyncMinIntervalMs;

    // Register periodic sync with minInterval parameter
    // Type assertion needed for experimental API
    const periodicSync = (
      registration as ServiceWorkerRegistration & {
        periodicSync?: {
          register: (
            tag: string,
            options?: { minInterval?: number }
          ) => Promise<void>;
        };
      }
    ).periodicSync;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const status = await (navigator as any).permissions.query({
      name: 'periodic-background-sync',
    });
    if (periodicSync && status.state === 'granted') {
      await periodicSync.register('gossip-message-sync', {
        minInterval: PERIODIC_SYNC_MIN_INTERVAL_MS,
      });
    } else {
      // Fallback for browsers that don't support periodicSync but support sync
      const syncAPI = (
        registration as ServiceWorkerRegistration & {
          sync?: { register: (tag: string) => Promise<void> };
        }
      ).sync;

      if (syncAPI) {
        await syncAPI.register('gossip-message-sync');
      }
    }
  } catch (error) {
    // Handle permission errors gracefully (expected in development/localhost)
    if (error instanceof DOMException && error.name === 'NotAllowedError') {
      // Fallback timer-based sync will handle background syncing
      return;
    }
    // Log unexpected errors
    console.error('[App] Error registering periodic sync:', error);
  }
}
