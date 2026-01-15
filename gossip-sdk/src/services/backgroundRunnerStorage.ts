/**
 * BackgroundRunner Storage Service
 *
 * Provides a bridge between main app storage (CapacitorStorage) and
 * BackgroundRunner storage (net.massa.gossip.background.sync).
 *
 * In SDK/Node.js context, this service is a no-op since there's no background runner.
 */

/**
 * Check if running on a native platform with Capacitor
 */
async function isNativePlatform(): Promise<boolean> {
  try {
    const { Capacitor } = await import('@capacitor/core');
    return Capacitor.isNativePlatform();
  } catch {
    return false;
  }
}

class BackgroundRunnerStorageService {
  /**
   * Check if running on a native platform
   */
  async isAvailable(): Promise<boolean> {
    return isNativePlatform();
  }

  /**
   * Write a key-value pair to the BackgroundRunner's storage.
   * This bridges the gap between main app storage (CapacitorStorage) and
   * BackgroundRunner storage (net.massa.gossip.background.sync).
   *
   * In SDK/Node.js context, this is a no-op.
   *
   * @param key - The storage key
   * @param value - The value to store (null/undefined to remove)
   */
  async set(key: string, value?: string | null): Promise<void> {
    if (!(await this.isAvailable())) {
      return;
    }

    try {
      const { registerPlugin } = await import('@capacitor/core');

      interface BackgroundRunnerStoragePlugin {
        set(options: { key: string; value?: string | null }): Promise<void>;
      }

      const BackgroundRunnerStorage =
        registerPlugin<BackgroundRunnerStoragePlugin>(
          'BackgroundRunnerStorage'
        );
      await BackgroundRunnerStorage.set({ key, value });
    } catch (error) {
      console.warn(
        '[BackgroundRunnerStorage] Failed to write to BackgroundRunner storage:',
        error
      );
    }
  }
}

// Export singleton instance
export const backgroundRunnerStorageService =
  new BackgroundRunnerStorageService();
