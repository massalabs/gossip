/**
 * Service Worker Setup
 *
 * Handles service worker registration, message listening, and sync scheduler initialization.
 */

import { useAccountStore } from '../stores/accountStore';
import { notificationService } from './notifications';
import { triggerManualSync } from './messageSync';
import { defaultSyncConfig } from '../config/sync';

/**
 * Setup service worker: register, listen for messages, and start sync scheduler
 * Also initializes background sync (notifications, periodic sync, online listener)
 */
export async function setupServiceWorker(): Promise<void> {
  if (!('serviceWorker' in navigator)) {
    return;
  }

  // Setup message listener for service worker messages (e.g., REQUEST_SEEKERS from service worker)
  setupMessageListener();

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
 * Setup message listener for service worker messages
 */
function setupMessageListener(): void {
  navigator.serviceWorker.addEventListener('message', async event => {
    if (event.data && event.data.type === 'REQUEST_SEEKERS') {
      console.log('REQUEST_SEEKERS');
      try {
        // Get all active seekers from the session
        const { session } = useAccountStore.getState();
        console.log('session', session);
        if (!session) {
          // No session available, respond with empty array
          if (event.ports && event.ports[0]) {
            event.ports[0].postMessage({ seekers: [] });
          }
          return;
        }

        const seekers = session.getMessageBoardReadKeys();
        console.log('seekers received', seekers.length);
        // Convert Uint8Array[] to number[][] for JSON serialization
        const seekersArray = seekers.map(seeker => Array.from(seeker));

        // Respond via the message channel port
        if (event.ports && event.ports[0]) {
          event.ports[0].postMessage({ seekers: seekersArray });
        }
      } catch (error) {
        console.error('Failed to get seekers for service worker:', error);
        // Respond with empty array on error
        if (event.ports && event.ports[0]) {
          event.ports[0].postMessage({ seekers: [] });
        }
      }
    }

    // Handle notification from service worker when new messages are detected
    if (event.data && event.data.type === 'NEW_MESSAGES_DETECTED') {
      try {
        await triggerManualSync();
      } catch (error) {
        console.error('Failed to refresh app state on new messages:', error);
      }
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
 * Send START_SYNC_SCHEDULER message to service worker
 */
function startSyncScheduler(registration: ServiceWorkerRegistration): void {
  if (registration.active) {
    registration.active.postMessage({ type: 'START_SYNC_SCHEDULER' });
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
    console.log(
      `Attempting to register service worker at: ${swUrl} (type: ${swType})`
    );

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

    console.log(`Registering service worker at: ${swUrl}`);
    const registration = await navigator.serviceWorker.register(swUrl, {
      scope: '/',
      type: swType,
    });

    console.log('Service worker registered successfully:', {
      installing: !!registration.installing,
      waiting: !!registration.waiting,
      active: !!registration.active,
      scope: registration.scope,
    });

    // If there's a waiting service worker, it should activate automatically
    // due to skipWaiting() in the install event, but we'll handle it here too
    if (registration.waiting) {
      console.log(
        'Service worker is waiting - it should activate automatically'
      );
      // The waiting service worker should activate automatically due to skipWaiting()
      // but we'll listen for activation just in case
      registration.waiting.addEventListener('statechange', event => {
        const sw = event.target as ServiceWorker;
        console.log(`Service worker state changed to: ${sw.state}`);
        if (sw.state === 'activated') {
          startSyncScheduler(registration);
        }
      });
    }

    // Wait for service worker to be ready and start sync scheduler
    if (registration.installing) {
      registration.installing.addEventListener('statechange', event => {
        const sw = event.target as ServiceWorker;
        console.log(`Service worker state changed to: ${sw.state}`);
        if (sw.state === 'activated') {
          startSyncScheduler(registration);
        }
      });
    } else if (registration.active) {
      console.log('Service worker is already active');
      startSyncScheduler(registration);
    }

    // Success! Exit the loop
    return;
  } catch (error) {
    console.error(`Failed to register service worker at ${swUrl}:`, error);
    // Continue to next URL
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

    // Check if there's a waiting service worker
    if (registration.waiting) {
      console.log(
        'Found waiting service worker - it should activate automatically'
      );
      // The waiting service worker should activate automatically due to skipWaiting()
      // but we'll listen for activation
      registration.waiting.addEventListener('statechange', event => {
        const sw = event.target as ServiceWorker;
        if (sw.state === 'activated') {
          startSyncScheduler(registration);
        }
      });
    }

    // Wait for ready and send start message
    const readyRegistration = await navigator.serviceWorker.ready;
    startSyncScheduler(readyRegistration);
  } catch (error) {
    console.error('App: Error waiting for service worker ready:', error);
  }
}

/**
 * Initialize background sync: notifications, periodic sync, and online listener
 */
async function initializeBackgroundSync(): Promise<void> {
  try {
    // Request notification permission
    await notificationService.requestPermission();

    // Register periodic background sync
    await registerPeriodicSync();

    console.log('Background sync service initialized');

    // Auto-retry pending announcements when coming back online
    window.addEventListener('online', () => {
      void triggerManualSync();
    });
  } catch (error) {
    console.error('Failed to initialize background sync service:', error);
  }
}

/**
 * Register periodic background sync
 * Note: On mobile devices, browsers may throttle or delay syncs significantly
 * Requesting 5 minutes, but actual syncs may be much less frequent
 */
async function registerPeriodicSync(): Promise<void> {
  if (!('sync' in window.ServiceWorkerRegistration.prototype)) {
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

    if (periodicSync) {
      await periodicSync.register('gossip-message-sync', {
        minInterval: PERIODIC_SYNC_MIN_INTERVAL_MS,
      });
    } else {
      // Fallback for browsers that don't support periodicSync but support sync
      await (
        registration as ServiceWorkerRegistration & {
          sync: { register: (tag: string) => Promise<void> };
        }
      ).sync.register('gossip-message-sync');
    }
  } catch (error) {
    // Silently handle permission errors (expected in many browsers)
    // Only log unexpected errors
    if (!(error instanceof DOMException && error.name === 'NotAllowedError')) {
      console.error('Failed to register periodic background sync:', error);
    }
  }
}
