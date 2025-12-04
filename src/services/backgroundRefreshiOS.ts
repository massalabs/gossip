/**
 * iOS Background Refresh Service
 *
 * Handles checking and managing iOS Background App Refresh status.
 * This is critical for reliable background sync on iOS devices.
 *
 * Background App Refresh can be disabled by:
 * - User in Settings > General > Background App Refresh
 * - Low Power Mode (automatically disables background refresh)
 * - Parental controls or MDM restrictions
 */

import { Capacitor, registerPlugin } from '@capacitor/core';

export type BackgroundRefreshStatus =
  | 'available'
  | 'denied'
  | 'restricted'
  | 'unknown';

export interface BackgroundRefreshStatusResult {
  status: BackgroundRefreshStatus;
  isEnabled: boolean;
  userCanEnable: boolean;
}

export interface LowPowerModeResult {
  isEnabled: boolean;
}

export interface IOSBackgroundSyncStatus {
  backgroundRefreshStatus: BackgroundRefreshStatus;
  isBackgroundRefreshEnabled: boolean;
  userCanEnableBackgroundRefresh: boolean;
  isLowPowerModeEnabled: boolean;
  isBackgroundSyncReliable: boolean;
}

interface BackgroundRefreshPluginInterface {
  getBackgroundRefreshStatus(): Promise<BackgroundRefreshStatusResult>;
  openSettings(): Promise<void>;
  isLowPowerModeEnabled(): Promise<LowPowerModeResult>;
  getFullStatus(): Promise<IOSBackgroundSyncStatus>;
}

const BackgroundRefreshPlugin =
  registerPlugin<BackgroundRefreshPluginInterface>('BackgroundRefresh');

class BackgroundRefreshService {
  private static instance: BackgroundRefreshService;
  private cachedStatus: IOSBackgroundSyncStatus | null = null;
  private lastCheckTime: number = 0;
  private static readonly CACHE_DURATION_MS = 30 * 1000; // 30 seconds

  static getInstance(): BackgroundRefreshService {
    if (!BackgroundRefreshService.instance) {
      BackgroundRefreshService.instance = new BackgroundRefreshService();
    }
    return BackgroundRefreshService.instance;
  }

  /**
   * Check if we're running on iOS native platform.
   */
  private isIOSNative(): boolean {
    return Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'ios';
  }

  /**
   * Get the comprehensive background sync status for iOS.
   * Returns a default "available" status on non-iOS platforms.
   */
  async getFullStatus(): Promise<IOSBackgroundSyncStatus> {
    if (!this.isIOSNative()) {
      return {
        backgroundRefreshStatus: 'available',
        isBackgroundRefreshEnabled: true,
        userCanEnableBackgroundRefresh: true,
        isLowPowerModeEnabled: false,
        isBackgroundSyncReliable: true,
      };
    }

    // Return cached status if recent enough
    const now = Date.now();
    if (
      this.cachedStatus &&
      now - this.lastCheckTime < BackgroundRefreshService.CACHE_DURATION_MS
    ) {
      return this.cachedStatus;
    }

    try {
      const status = await BackgroundRefreshPlugin.getFullStatus();
      this.cachedStatus = status;
      this.lastCheckTime = now;
      return status;
    } catch (error) {
      console.error('Failed to get iOS background refresh status:', error);
      return {
        backgroundRefreshStatus: 'unknown',
        isBackgroundRefreshEnabled: false,
        userCanEnableBackgroundRefresh: false,
        isLowPowerModeEnabled: false,
        isBackgroundSyncReliable: false,
      };
    }
  }

  /**
   * Refresh the status (bypass cache).
   */
  async refreshStatus(): Promise<IOSBackgroundSyncStatus> {
    this.cachedStatus = null;
    this.lastCheckTime = 0;
    return this.getFullStatus();
  }

  /**
   * Get just the background refresh status.
   */
  async getBackgroundRefreshStatus(): Promise<BackgroundRefreshStatusResult> {
    if (!this.isIOSNative()) {
      return { status: 'available', isEnabled: true, userCanEnable: true };
    }

    try {
      return await BackgroundRefreshPlugin.getBackgroundRefreshStatus();
    } catch (error) {
      console.error('Failed to get background refresh status:', error);
      return { status: 'unknown', isEnabled: false, userCanEnable: false };
    }
  }

  /**
   * Check if Low Power Mode is enabled.
   */
  async isLowPowerModeEnabled(): Promise<boolean> {
    if (!this.isIOSNative()) {
      return false;
    }

    try {
      const result = await BackgroundRefreshPlugin.isLowPowerModeEnabled();
      return result.isEnabled;
    } catch {
      return false;
    }
  }

  /**
   * Open iOS Settings for this app.
   */
  async openSettings(): Promise<boolean> {
    if (!this.isIOSNative()) {
      return false;
    }

    try {
      await BackgroundRefreshPlugin.openSettings();
      return true;
    } catch (error) {
      console.error('Failed to open iOS settings:', error);
      return false;
    }
  }

  /**
   * Check if background sync is reliable (enabled and not in low power mode).
   */
  async isBackgroundSyncReliable(): Promise<boolean> {
    const status = await this.getFullStatus();
    return status.isBackgroundSyncReliable;
  }

  /**
   * Get a user-friendly message explaining any issues with background sync.
   * Returns null if there are no issues.
   */
  getStatusMessage(status: IOSBackgroundSyncStatus): string | null {
    // Check low power mode first as it overrides everything
    if (status.isLowPowerModeEnabled) {
      return 'Low Power Mode is enabled. Background sync is paused to save battery. Disable Low Power Mode in Settings > Battery for reliable message notifications.';
    }

    switch (status.backgroundRefreshStatus) {
      case 'denied':
        return 'Background App Refresh is disabled for Gossip. Enable it in Settings > General > Background App Refresh to receive messages when the app is closed.';
      case 'restricted':
        return 'Background App Refresh is restricted by your device settings (parental controls or device management). Contact your administrator if you need background notifications.';
      case 'available':
        return null; // No issue
      default:
        return null;
    }
  }

  /**
   * Check if the current platform is iOS native.
   */
  isIOS(): boolean {
    return this.isIOSNative();
  }
}

// Export singleton instance
export const backgroundRefreshService = BackgroundRefreshService.getInstance();
