/**
 * Battery Optimization Service
 *
 * Handles battery optimization checks and settings for Android devices.
 * This is critical for reliable background sync on devices with aggressive
 * battery management (Xiaomi, Huawei, Samsung, etc.).
 */

import { Capacitor, registerPlugin } from '@capacitor/core';
import {
  getDeviceInfo,
  getDeviceReliabilityInfo,
  getBatteryOptimizationHelpUrl,
  isProblematicManufacturer,
  isXiaomiManufacturer,
  type DeviceReliabilityInfo,
} from '../utils/deviceInfo';

// Storage key for dismissing battery optimization prompt
const BATTERY_OPTIMIZATION_DISMISSED_KEY =
  'gossip-battery-optimization-dismissed';
const BATTERY_OPTIMIZATION_CHECK_INTERVAL = 24 * 60 * 60 * 1000; // 24 hours

export interface BackgroundSyncStatus {
  isIgnoringBatteryOptimization: boolean;
  isBackgroundRestricted: boolean;
  isProblematicDevice: boolean;
  isBackgroundSyncReliable: boolean;
  manufacturer: string;
  brand: string;
  model: string;
  sdkVersion: number;
}

export interface BatteryOptimizationState {
  status: BackgroundSyncStatus | null;
  deviceInfo: DeviceReliabilityInfo;
  shouldShowPrompt: boolean;
  isChecking: boolean;
  lastCheckTime: number;
}

/**
 * Native plugin interface for BatteryOptimization.
 *
 * Note: Some methods (isIgnoringBatteryOptimizations, isBackgroundRestricted,
 * getManufacturer) are not called directly - we use getBackgroundSyncStatus()
 * which returns all this information in one call. However, isXiaomiDevice() is
 * called directly in BackgroundSyncSettings to determine if Xiaomi-specific
 * UI should be shown.
 *
 * These granular methods are kept in the interface for:
 * - Documentation of full native plugin capabilities
 * - Future use if granular access is needed
 * - Testing individual native methods in isolation
 */
interface BatteryOptimizationPluginInterface {
  // Granular methods (most accessed via getBackgroundSyncStatus, but isXiaomiDevice is used directly)
  isIgnoringBatteryOptimizations(): Promise<{ isIgnoring: boolean }>;
  isBackgroundRestricted(): Promise<{ isRestricted: boolean }>;
  getManufacturer(): Promise<{
    manufacturer: string;
    brand: string;
    model: string;
    device: string; // Android Build.DEVICE - included for native API completeness
  }>;
  isXiaomiDevice(): Promise<{ isXiaomi: boolean }>; // Used directly in BackgroundSyncSettings

  // Action methods (actively used)
  openBatteryOptimizationSettings(): Promise<void>;
  openAppSettings(): Promise<void>;
  openXiaomiAutoStartSettings(): Promise<void>;

  // Comprehensive status (preferred for efficiency)
  getBackgroundSyncStatus(): Promise<BackgroundSyncStatus>;
}

// Register the native plugin
const BatteryOptimizationPlugin =
  registerPlugin<BatteryOptimizationPluginInterface>('BatteryOptimization');

class BatteryOptimizationService {
  private static instance: BatteryOptimizationService;
  private cachedStatus: BackgroundSyncStatus | null = null;
  private cachedDeviceInfo: DeviceReliabilityInfo | null = null;
  private lastCheckTime: number = 0;
  private initPromise: Promise<BackgroundSyncStatus | null> | null = null;
  private refreshPromise: Promise<BackgroundSyncStatus | null> | null = null;

  private constructor() {
    // Track initialization promise to avoid race conditions
    // Callers can await ensureInitialized() or getStatus() will handle it
    this.initPromise = this.refreshStatus().finally(() => {
      this.initPromise = null;
    });
  }

  static getInstance(): BatteryOptimizationService {
    if (!BatteryOptimizationService.instance) {
      BatteryOptimizationService.instance = new BatteryOptimizationService();
    }
    return BatteryOptimizationService.instance;
  }

  /**
   * Wait for initialization to complete.
   * Useful if you need to ensure the service is ready before accessing cached values.
   */
  async ensureInitialized(): Promise<void> {
    if (this.initPromise) {
      await this.initPromise;
    }
  }

  /**
   * Check if we're running on Android native platform.
   */
  private isAndroidNative(): boolean {
    return (
      Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android'
    );
  }

  /**
   * Refresh the battery optimization status from native code.
   * Uses a Promise-based lock to prevent race conditions - if a refresh is
   * already in progress, returns the existing promise instead of starting a new one.
   */
  async refreshStatus(): Promise<BackgroundSyncStatus | null> {
    if (!this.isAndroidNative()) {
      return null;
    }

    // If a refresh is already in progress, wait for it to complete
    if (this.refreshPromise) {
      return this.refreshPromise;
    }

    // Create and store the refresh promise
    this.refreshPromise = this.doRefreshStatus();

    try {
      return await this.refreshPromise;
    } finally {
      this.refreshPromise = null;
    }
  }

  /**
   * Internal method that performs the actual refresh.
   * Called by refreshStatus() which handles the Promise-based locking.
   */
  private async doRefreshStatus(): Promise<BackgroundSyncStatus | null> {
    try {
      const status = await BatteryOptimizationPlugin.getBackgroundSyncStatus();
      this.cachedStatus = status;
      this.lastCheckTime = Date.now();

      // Also refresh device reliability info
      this.cachedDeviceInfo = await getDeviceReliabilityInfo();

      return status;
    } catch (error) {
      console.error('Failed to get battery optimization status:', error);
      return this.cachedStatus;
    }
  }

  /**
   * Get the current battery optimization status.
   * Uses cached value if available and recent.
   * Waits for initialization if still in progress.
   */
  async getStatus(): Promise<BackgroundSyncStatus | null> {
    if (!this.isAndroidNative()) {
      return null;
    }

    // Wait for initialization to complete if still in progress
    if (this.initPromise) {
      await this.initPromise;
    }

    // Return cached status if it's recent enough
    const timeSinceLastCheck = Date.now() - this.lastCheckTime;
    if (
      this.cachedStatus &&
      timeSinceLastCheck < BATTERY_OPTIMIZATION_CHECK_INTERVAL
    ) {
      return this.cachedStatus;
    }

    return this.refreshStatus();
  }

  /**
   * Get device reliability information.
   */
  async getDeviceReliabilityInfo(): Promise<DeviceReliabilityInfo> {
    if (this.cachedDeviceInfo) {
      return this.cachedDeviceInfo;
    }

    this.cachedDeviceInfo = await getDeviceReliabilityInfo();
    return this.cachedDeviceInfo;
  }

  /**
   * Check if the battery optimization prompt should be shown.
   */
  async shouldShowOptimizationPrompt(): Promise<boolean> {
    if (!this.isAndroidNative()) {
      return false;
    }

    // Check if user has dismissed the prompt
    if (this.isPromptDismissed()) {
      return false;
    }

    const status = await this.getStatus();
    if (!status) {
      return false;
    }

    // Show prompt if battery optimization is not disabled or if background is restricted
    return (
      !status.isIgnoringBatteryOptimization || status.isBackgroundRestricted
    );
  }

  /**
   * Check if the user has dismissed the battery optimization prompt.
   */
  isPromptDismissed(): boolean {
    try {
      const dismissed = localStorage.getItem(
        BATTERY_OPTIMIZATION_DISMISSED_KEY
      );
      if (!dismissed) return false;

      const dismissedData = JSON.parse(dismissed);
      // Allow re-showing after 7 days
      const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
      return dismissedData.timestamp > sevenDaysAgo;
    } catch {
      return false;
    }
  }

  /**
   * Mark the battery optimization prompt as dismissed.
   */
  dismissPrompt(): void {
    try {
      localStorage.setItem(
        BATTERY_OPTIMIZATION_DISMISSED_KEY,
        JSON.stringify({ timestamp: Date.now() })
      );
    } catch {
      // Ignore storage errors
    }
  }

  /**
   * Reset the dismissed state so the prompt can be shown again.
   */
  resetDismissed(): void {
    try {
      localStorage.removeItem(BATTERY_OPTIMIZATION_DISMISSED_KEY);
    } catch {
      // Ignore storage errors
    }
  }

  /**
   * Open the battery optimization settings for this app.
   */
  async openBatteryOptimizationSettings(): Promise<boolean> {
    if (!this.isAndroidNative()) {
      return false;
    }

    try {
      await BatteryOptimizationPlugin.openBatteryOptimizationSettings();
      return true;
    } catch (error) {
      console.error('Failed to open battery optimization settings:', error);
      return false;
    }
  }

  /**
   * Open the app settings page.
   */
  async openAppSettings(): Promise<boolean> {
    if (!this.isAndroidNative()) {
      return false;
    }

    try {
      await BatteryOptimizationPlugin.openAppSettings();
      return true;
    } catch (error) {
      console.error('Failed to open app settings:', error);
      return false;
    }
  }

  /**
   * Open Xiaomi AutoStart settings (only works on MIUI devices).
   */
  async openXiaomiAutoStartSettings(): Promise<boolean> {
    if (!this.isAndroidNative()) {
      return false;
    }

    try {
      await BatteryOptimizationPlugin.openXiaomiAutoStartSettings();
      return true;
    } catch (error) {
      console.error('Failed to open Xiaomi AutoStart settings:', error);
      return false;
    }
  }

  /**
   * Check if this is a Xiaomi/MIUI device.
   */
  async isXiaomiDevice(): Promise<boolean> {
    if (!this.isAndroidNative()) {
      return false;
    }

    try {
      // Use @capacitor/device for manufacturer info
      const deviceInfo = await getDeviceInfo();
      return isXiaomiManufacturer(deviceInfo.manufacturer);
    } catch {
      return false;
    }
  }

  /**
   * Get the help URL for battery optimization instructions.
   */
  async getHelpUrl(): Promise<string | null> {
    const deviceInfo = await this.getDeviceReliabilityInfo();
    return deviceInfo.helpUrl;
  }

  /**
   * Get a summary of the background sync reliability.
   *
   * On non-Android platforms (iOS, web), this returns isReliable: true because
   * those platforms don't have the same aggressive battery optimization that
   * Android has. iOS uses BGAppRefreshTask which is OS-managed, and web/PWA
   * has its own limitations but not battery-related restrictions.
   */
  async getReliabilitySummary(): Promise<{
    isReliable: boolean;
    issues: string[];
    recommendations: string[];
  }> {
    const status = await this.getStatus();
    const deviceInfo = await this.getDeviceReliabilityInfo();

    const issues: string[] = [];
    const recommendations: string[] = [];

    if (!status) {
      // Non-Android platform: battery optimization is not a concern,
      // so we consider background sync reliable by default
      return { isReliable: true, issues: [], recommendations: [] };
    }

    if (!status.isIgnoringBatteryOptimization) {
      issues.push('Battery optimization is enabled');
      recommendations.push('Disable battery optimization for Gossip');
    }

    if (status.isBackgroundRestricted) {
      issues.push('Background activity is restricted');
      recommendations.push('Allow Gossip to run in the background');
    }

    if (deviceInfo.isProblematic) {
      issues.push(
        `${deviceInfo.manufacturer} devices have aggressive battery management`
      );
      if (deviceInfo.warningMessage) {
        recommendations.push(deviceInfo.warningMessage);
      }
    }

    return {
      isReliable: issues.length === 0,
      issues,
      recommendations,
    };
  }
}

// Export singleton instance
export const batteryOptimizationService =
  BatteryOptimizationService.getInstance();

// Export utility functions
export { getBatteryOptimizationHelpUrl, isProblematicManufacturer };
