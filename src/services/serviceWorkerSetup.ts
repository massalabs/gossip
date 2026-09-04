import { logger } from '../utils/logger.ts';
/**
 * Service Worker Setup
 *
 * Handles service worker registration, message listening, and sync scheduler initialization.
 */

import { notificationService } from './notifications';
import { defaultSyncConfig } from '../config/sync';
import {
  setApiBaseUrlForBackgroundSync,
  syncBackgroundSyncPresetToRunner,
} from '../utils/preferences';
import { logSyncDiagnostics } from '../utils/syncDiagnostics';
import { protocolConfig } from '../config/protocol';
import { Capacitor } from '@capacitor/core';
import { networkObserverService } from './networkObserver';

/**
 * Setup service worker: register, listen for messages, and start sync scheduler
 * Also initializes background sync (notifications, periodic sync)
 */
export async function setupServiceWorker(): Promise<void> {
  // Service worker registration is only possible when the API exists
  // (e.g. iOS WKWebView does not expose navigator.serviceWorker)
  if ('serviceWorker' in navigator) {
    // Setup controller change listener to reload page when new service worker takes control
    setupControllerChangeListener();

    // Register service worker and setup sync scheduler
    await registerAndStartSync();
  }

  // Initialize background sync: notification permission, periodic sync, network observer
  // Must always run — it does native-critical work (persisting the API base URL for the
  // BackgroundRunner, syncing the sync preset, starting the network observer) that is
  // needed even when service workers are unavailable (e.g. iOS WKWebView).
  await initializeBackgroundSync();
}

/**
 * Setup controller change listener to reload page when new service worker takes control
 */
function setupControllerChangeListener(): void {
  let refreshing = false;
  // With skipWaiting + clientsClaim, controllerchange also fires on the very
  // first service worker activation. Only reload when a previous controller
  // existed (i.e. an update took over) to avoid discarding UI state on first visit.
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    // Reload the page when a new service worker takes control
    // This ensures the page uses the new service worker code immediately
    if (hadController && !refreshing) {
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
    logger.error('App: Error checking service worker registrations:', error);
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
    // Register service worker - it will automatically start sync scheduler on activate event
    // No pre-flight verification needed: registration itself fails if the file doesn't exist
    await navigator.serviceWorker.register(swUrl, {
      scope: '/',
      type: swType,
    });

    return;
  } catch (error) {
    logger.error(`Failed to register service worker at ${swUrl}:`, error);
  }

  // If we get here, all attempts failed
  logger.error(
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
    logger.error('App: Error waiting for service worker ready:', error);
  }
}

/**
 * Initialize background sync: notifications, periodic sync, and network observer.
 */
async function initializeBackgroundSync(): Promise<void> {
  try {
    // Store API base URL for native background runner access
    // The background runner can't access import.meta.env, so we persist it via Preferences
    await setApiBaseUrlForBackgroundSync(protocolConfig.baseUrl);
    await syncBackgroundSyncPresetToRunner();
    logSyncDiagnostics('Background sync preferences initialized', {
      baseUrl: protocolConfig.baseUrl,
    });

    // Sync notification permission state
    if (Capacitor.isNativePlatform()) {
      // Native: Capacitor permission flow (no user-gesture requirement)
      await notificationService.requestPermission();
    } else {
      // Web: never prompt without a user gesture (Firefox auto-denies such
      // requests). Only refresh the current permission state; the actual
      // request happens from a user interaction in the UI.
      notificationService.getPermissionStatus();
    }

    // Register periodic background sync (Web API - optional, expected to fail on mobile)
    // This is wrapped in its own try-catch because failures are expected and non-critical
    await registerPeriodicSync();

    // Start network observer for immediate sync on connectivity changes
    // This triggers background-runner when network becomes available (even in background)
    await initializeNetworkObserver();
  } catch (error) {
    // Only log truly unexpected errors (not periodic sync failures)
    logger.error('[App] Failed to initialize background sync service:', error);
  }
}

/**
 * Initialize network observer for immediate sync on network state changes.
 *
 * On native platforms (iOS/Android), this:
 * 1. Monitors network state changes at the native level (works in background)
 * 2. Acquires a wake lock (Android) or background task (iOS) when network becomes available
 * 3. Triggers the BackgroundRunner to execute the sync script
 *
 * This ensures messages are fetched immediately when connectivity is restored,
 * even if the app is in background or the device was in deep sleep.
 */
async function initializeNetworkObserver(): Promise<void> {
  if (!networkObserverService.isAvailable()) {
    logger.info('[App] Network observer not available on this platform');
    return;
  }

  try {
    await networkObserverService.startObserving();
    logger.info('[App] Network observer initialized');
  } catch (error) {
    // Non-critical - log and continue
    logger.error('[App] Failed to initialize network observer:', error);
  }
}

/**
 * Register periodic background sync (Web API - optional fallback for PWA)
 *
 * NOTE: This is the WEB Periodic Background Sync API, NOT the native Capacitor BackgroundRunner.
 * This API has very limited support and is expected to fail on:
 * - Most mobile devices (especially Xiaomi, Samsung, Huawei)
 * - Mobile WebViews (Capacitor apps)
 * - Browsers that don't support the experimental API
 *
 * The native Capacitor BackgroundRunner handles actual background sync on mobile.
 * This is just an optional enhancement for desktop PWA users.
 */
async function registerPeriodicSync(): Promise<void> {
  // Skip on native platforms - BackgroundRunner handles this
  if (Capacitor.isNativePlatform()) {
    // Native apps use Capacitor BackgroundRunner, not web APIs
    return;
  }

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

    if (periodicSync) {
      // Check permission status
      let permissionStatus: PermissionStatus | null = null;
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        permissionStatus = await (navigator as any).permissions.query({
          name: 'periodic-background-sync',
        });
      } catch {
        // Permission query not supported - expected on most browsers
        return;
      }

      if (permissionStatus?.state === 'granted') {
        await periodicSync.register('gossip-message-sync', {
          minInterval: PERIODIC_SYNC_MIN_INTERVAL_MS,
        });
      }
      // If permission is 'prompt' or 'denied', silently skip - registration
      // would be rejected without an explicit grant
    } else {
      // Fallback for browsers that don't support periodicSync but support
      // one-shot Background Sync
      const syncAPI = (
        registration as ServiceWorkerRegistration & {
          sync?: { register: (tag: string) => Promise<void> };
        }
      ).sync;

      if (syncAPI) {
        try {
          await syncAPI.register('gossip-message-sync');
        } catch {
          // Background Sync registration failed - expected on mobile
        }
      }
    }
  } catch {
    // Silently handle errors - this API is optional and expected to fail on most mobile devices
    // The native Capacitor BackgroundRunner handles actual background sync
  }
}
