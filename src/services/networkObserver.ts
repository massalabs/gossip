/**
 * Network Observer Service
 *
 * Monitors network state changes and triggers background sync when connectivity is restored.
 * Uses native plugins that work even when the app is in background.
 *
 * Key features:
 * - Native-level network monitoring (works in background)
 * - Acquires wake lock (Android) / background task (iOS) on network change
 * - Triggers the BackgroundRunner to execute sync script
 */

import {
  Capacitor,
  registerPlugin,
  PluginListenerHandle,
} from '@capacitor/core';

interface NetworkObserverPlugin {
  /**
   * Start observing network state changes.
   * When network becomes available, will acquire wake lock and trigger background sync.
   */
  startObserving(): Promise<void>;

  /**
   * Stop observing network state changes.
   */
  stopObserving(): Promise<void>;

  /**
   * Manually trigger background sync with wake lock.
   * Useful for testing or forcing an immediate sync.
   */
  triggerBackgroundSync(): Promise<void>;

  /**
   * Acquire wake lock for sync (for foreground sync operations).
   */
  acquireWakeLockForSync(): Promise<void>;

  /**
   * Release wake lock.
   */
  releaseWakeLock(): Promise<void>;

  /**
   * Listen for network available events (for foreground notifications).
   */
  addListener(
    eventName: 'networkAvailable',
    handler: (data: { reason: string }) => void
  ): Promise<PluginListenerHandle>;

  /**
   * Listen for network lost events.
   */
  addListener(
    eventName: 'networkLost',
    handler: () => void
  ): Promise<PluginListenerHandle>;

  removeAllListeners(): Promise<void>;
}

// Register the plugin
const NetworkObserver =
  registerPlugin<NetworkObserverPlugin>('NetworkObserver');

class NetworkObserverService {
  private isObserving = false;
  private listeners: PluginListenerHandle[] = [];

  /**
   * Check if running on a native platform
   */
  isAvailable(): boolean {
    return Capacitor.isNativePlatform();
  }

  /**
   * Start observing network changes.
   * When network becomes available in background, the native plugin will:
   * 1. Acquire a wake lock (Android) / background task (iOS)
   * 2. Trigger the BackgroundRunner to execute the sync script
   *
   * Call this when the app initializes.
   */
  async startObserving(): Promise<void> {
    if (!this.isAvailable()) {
      console.log('[NetworkObserver] Not available on this platform');
      return;
    }

    if (this.isObserving) {
      console.log('[NetworkObserver] Already observing');
      return;
    }

    // Set up listeners for foreground notifications (optional)
    const availableListener = await NetworkObserver.addListener(
      'networkAvailable',
      data => {
        console.log(
          `[NetworkObserver] Network available (reason: ${data.reason})`
        );
      }
    );
    this.listeners.push(availableListener);

    const lostListener = await NetworkObserver.addListener(
      'networkLost',
      () => {
        console.log('[NetworkObserver] Network lost');
      }
    );
    this.listeners.push(lostListener);

    // Start native observation
    await NetworkObserver.startObserving();
    this.isObserving = true;

    console.log('[NetworkObserver] Started observing network changes');
  }

  /**
   * Stop observing network changes.
   * Call this when the app is being destroyed (usually not needed).
   */
  async stopObserving(): Promise<void> {
    if (!this.isAvailable() || !this.isObserving) {
      return;
    }

    try {
      await NetworkObserver.stopObserving();

      // Remove all listeners
      for (const listener of this.listeners) {
        await listener.remove();
      }
      this.listeners = [];
      this.isObserving = false;

      console.log('[NetworkObserver] Stopped observing network changes');
    } catch (error) {
      console.error('[NetworkObserver] Failed to stop observing:', error);
    }
  }

  /**
   * Manually trigger background sync with wake lock.
   * Useful for testing or forcing an immediate sync.
   */
  async triggerBackgroundSync(): Promise<void> {
    if (!this.isAvailable()) {
      console.log(
        '[NetworkObserver] Background sync not available on this platform'
      );
      return;
    }

    await NetworkObserver.triggerBackgroundSync();
    console.log('[NetworkObserver] Background sync triggered');
  }

  /**
   * Acquire wake lock for foreground sync operations.
   * Use this when performing sync in foreground to prevent device from sleeping.
   */
  async acquireWakeLockForSync(): Promise<void> {
    if (!this.isAvailable()) {
      return;
    }

    try {
      await NetworkObserver.acquireWakeLockForSync();
      console.log('[NetworkObserver] Wake lock acquired');
    } catch (error) {
      console.warn('[NetworkObserver] Failed to acquire wake lock:', error);
    }
  }

  /**
   * Release wake lock.
   * Usually not needed - wake locks auto-release after timeout.
   */
  async releaseWakeLock(): Promise<void> {
    if (!this.isAvailable()) {
      return;
    }

    try {
      await NetworkObserver.releaseWakeLock();
      console.log('[NetworkObserver] Wake lock released');
    } catch (error) {
      console.warn('[NetworkObserver] Failed to release wake lock:', error);
    }
  }
}

// Export singleton instance
export const networkObserverService = new NetworkObserverService();
