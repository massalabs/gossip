import { logger } from '../utils/logger.ts';
/**
 * BackgroundRunner Storage Service
 *
 * Provides a bridge between main app storage (CapacitorStorage) and
 * BackgroundRunner storage (net.massa.gossip.background.sync).
 *
 * The BackgroundRunner uses a separate SharedPreferences file on Android
 * and a separate UserDefaults suite on iOS, so data written by
 * @capacitor/preferences is NOT visible to it.
 *
 * This service allows any native service to write data that needs to be
 * accessed by the BackgroundRunner (e.g., seekers, timestamps, API URLs).
 */

import { Capacitor, registerPlugin } from '@capacitor/core';

interface BackgroundRunnerStoragePlugin {
  /**
   * Write a key-value pair to the BackgroundRunner's storage.
   * This bridges the gap between main app storage and BackgroundRunner storage.
   *
   * @param options - Object with key and optional value
   */
  get(options: { key: string }): Promise<{ value?: string | null }>;
  cancelNotifications(): Promise<void>;
  clearIfValue(options: { key: string; expected: string }): Promise<void>;
  set(options: {
    key: string;
    value?: string | null;
    strict?: boolean;
    scope?: 'runner' | 'app';
  }): Promise<void>;
}

// Register the plugin
const BackgroundRunnerStorage = registerPlugin<BackgroundRunnerStoragePlugin>(
  'BackgroundRunnerStorage'
);

class BackgroundRunnerStorageService {
  /**
   * Check if running on a native platform
   */
  isAvailable(): boolean {
    return Capacitor.isNativePlatform();
  }

  /**
   * Write a key-value pair to the BackgroundRunner's storage.
   * This bridges the gap between main app storage (CapacitorStorage) and
   * BackgroundRunner storage (net.massa.gossip.background.sync).
   *
   * IMPORTANT: The BackgroundRunner uses a separate SharedPreferences file,
   * so data written by @capacitor/preferences is NOT visible to it.
   * Use this method to store data that needs to be accessed by background sync.
   *
   * @param key - The storage key
   * @param value - The value to store (null/undefined to remove)
   */
  async getStrict(key: string): Promise<string | null> {
    if (!this.isAvailable()) return null;
    const result = await BackgroundRunnerStorage.get({ key });
    return result && typeof result.value === 'string' ? result.value : null;
  }

  async cancelNotifications(): Promise<void> {
    if (!this.isAvailable()) return;
    await BackgroundRunnerStorage.cancelNotifications();
  }

  async clearIfValue(key: string, expected: string): Promise<void> {
    if (!this.isAvailable()) return;
    await BackgroundRunnerStorage.clearIfValue({ key, expected });
  }

  async setAppStrict(key: string, value?: string | null): Promise<void> {
    if (!this.isAvailable()) return;
    await BackgroundRunnerStorage.set({
      key,
      value,
      strict: true,
      scope: 'app',
    });
  }

  async setStrict(key: string, value?: string | null): Promise<void> {
    if (!this.isAvailable()) return;
    await BackgroundRunnerStorage.set({ key, value, strict: true });
  }

  async set(key: string, value?: string | null): Promise<void> {
    if (!this.isAvailable()) {
      return;
    }

    try {
      await BackgroundRunnerStorage.set({ key, value });
    } catch (error) {
      logger.warn(
        '[BackgroundRunnerStorage] Failed to write to BackgroundRunner storage:',
        error
      );
    }
  }
}

// Export singleton instance
export const backgroundRunnerStorageService =
  new BackgroundRunnerStorageService();
