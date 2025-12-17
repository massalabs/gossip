/**
 * Background Sync Settings Component
 *
 * Displays background sync status and device-specific warnings for Android and iOS devices.
 * - Android: Battery optimization, background restriction, manufacturer-specific issues
 * - iOS: Background App Refresh status, Low Power Mode
 * Provides actions to fix configuration issues.
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Capacitor, PluginListenerHandle } from '@capacitor/core';
import { App } from '@capacitor/app';
import {
  Battery,
  ExternalLink,
  Shield,
  AlertTriangle,
  RefreshCcw,
  Zap,
} from 'react-feather';
import Button from '../ui/Button';
import {
  batteryOptimizationService,
  type BackgroundSyncStatus,
} from '../../services/batteryOptimization';
import { type DeviceReliabilityInfo } from '../../utils/deviceInfo';
import {
  backgroundRefreshService,
  type IOSBackgroundSyncStatus,
} from '../../services/backgroundRefreshiOS';

interface BackgroundSyncSettingsProps {
  showDebugInfo?: boolean;
}

const BackgroundSyncSettings: React.FC<BackgroundSyncSettingsProps> = ({
  showDebugInfo = false,
}) => {
  // Android state
  const [androidStatus, setAndroidStatus] =
    useState<BackgroundSyncStatus | null>(null);
  const [deviceInfo, setDeviceInfo] = useState<DeviceReliabilityInfo | null>(
    null
  );
  const [isXiaomi, setIsXiaomi] = useState(false);

  // iOS state
  const [iosStatus, setIosStatus] = useState<IOSBackgroundSyncStatus | null>(
    null
  );

  // Common state
  const [isLoading, setIsLoading] = useState(true);

  // Platform detection
  const platform = Capacitor.getPlatform();
  const isNative = Capacitor.isNativePlatform();
  const isAndroidNative = isNative && platform === 'android';
  const isIOSNative = isNative && platform === 'ios';

  // Load status on mount
  useEffect(() => {
    if (!isNative) {
      setIsLoading(false);
      return;
    }

    const loadStatus = async () => {
      setIsLoading(true);
      try {
        if (isAndroidNative) {
          const [syncStatus, deviceReliabilityInfo, xiaomiCheck] =
            await Promise.all([
              batteryOptimizationService.getStatus(),
              batteryOptimizationService.getDeviceReliabilityInfo(),
              batteryOptimizationService.isXiaomiDevice(),
            ]);

          setAndroidStatus(syncStatus);
          setDeviceInfo(deviceReliabilityInfo);
          setIsXiaomi(xiaomiCheck);
        } else if (isIOSNative) {
          const status = await backgroundRefreshService.getFullStatus();
          setIosStatus(status);
        }
      } catch (error) {
        console.error('Failed to load background sync status:', error);
      } finally {
        setIsLoading(false);
      }
    };

    void loadStatus();
  }, [isNative, isAndroidNative, isIOSNative]);

  // Refresh status
  const handleRefresh = useCallback(async () => {
    if (!isNative) return;

    setIsLoading(true);
    try {
      if (isAndroidNative) {
        const [syncStatus, deviceReliabilityInfo, xiaomiCheck] =
          await Promise.all([
            batteryOptimizationService.refreshStatus(),
            batteryOptimizationService.getDeviceReliabilityInfo(),
            batteryOptimizationService.isXiaomiDevice(),
          ]);

        setAndroidStatus(syncStatus);
        setDeviceInfo(deviceReliabilityInfo);
        setIsXiaomi(xiaomiCheck);
      } else if (isIOSNative) {
        const status = await backgroundRefreshService.refreshStatus();
        setIosStatus(status);
      }
    } catch (error) {
      console.error('Failed to refresh status:', error);
    } finally {
      setIsLoading(false);
    }
  }, [isNative, isAndroidNative, isIOSNative]);

  // Store listener handle in a ref to avoid cleanup issues with async setup
  const appStateListenerRef = useRef<PluginListenerHandle | null>(null);

  // Refresh status when app becomes visible (e.g., returning from settings)
  useEffect(() => {
    if (!isNative) return;

    const refreshWithDelay = () => {
      // Delay to ensure native state is updated after returning from system settings
      setTimeout(() => {
        void handleRefresh();
      }, 1000);
    };

    const setupAppStateListener = async () => {
      try {
        const listener = await App.addListener('appStateChange', state => {
          if (state.isActive) {
            refreshWithDelay();
          }
        });
        appStateListenerRef.current = listener;
      } catch (error) {
        console.error('Failed to setup app state listener:', error);
      }
    };

    void setupAppStateListener();

    return () => {
      if (appStateListenerRef.current) {
        void appStateListenerRef.current.remove();
        appStateListenerRef.current = null;
      }
    };
  }, [isNative, handleRefresh]);

  // Android: Open battery optimization settings
  const handleOpenBatterySettings = useCallback(async () => {
    await batteryOptimizationService.openBatteryOptimizationSettings();
  }, []);

  // Android: Open Xiaomi AutoStart settings
  const handleOpenAutoStartSettings = useCallback(async () => {
    const success =
      await batteryOptimizationService.openXiaomiAutoStartSettings();
    if (!success) {
      await batteryOptimizationService.openAppSettings();
    }
  }, []);

  // iOS: Open settings
  const handleOpenIOSSettings = useCallback(async () => {
    await backgroundRefreshService.openSettings();
  }, []);

  // Open help URL in browser
  const handleOpenHelp = useCallback(() => {
    if (deviceInfo?.helpUrl) {
      window.open(deviceInfo.helpUrl, '_blank', 'noopener,noreferrer');
    }
  }, [deviceInfo?.helpUrl]);

  // Don't show anything on non-native platforms
  if (!isNative) {
    return null;
  }

  // Determine if there are issues and reliability status
  const androidHasIssues =
    isAndroidNative &&
    androidStatus !== null &&
    (!androidStatus.isIgnoringBatteryOptimization ||
      androidStatus.isBackgroundRestricted);

  const iosHasIssues =
    isIOSNative && iosStatus !== null && !iosStatus.isBackgroundSyncReliable;

  const hasIssues = androidHasIssues || iosHasIssues;

  const isReliable = isAndroidNative
    ? androidStatus?.isBackgroundSyncReliable
    : isIOSNative
      ? iosStatus?.isBackgroundSyncReliable
      : true;

  // Get iOS warning message
  const iosWarningMessage = iosStatus
    ? backgroundRefreshService.getStatusMessage(iosStatus)
    : null;

  return (
    <div className="bg-card border border-border rounded-xl overflow-hidden">
      {/* Header */}
      <div className="h-[54px] flex items-center px-4 justify-start w-full border-b border-border">
        <Battery className="text-foreground mr-4" aria-hidden="true" />
        <span className="text-base font-medium text-foreground flex-1 text-left">
          Background Sync
        </span>
        {isLoading ? (
          <span className="text-xs text-muted-foreground">Checking...</span>
        ) : isReliable ? (
          <div className="flex items-center gap-1.5">
            <Shield className="w-4 h-4 text-success" aria-hidden="true" />
            <span className="text-xs text-success">Optimized</span>
          </div>
        ) : hasIssues ? (
          <div className="flex items-center gap-1.5">
            <AlertTriangle
              className="w-4 h-4 text-warning"
              aria-hidden="true"
            />
            <span className="text-xs text-warning">Needs attention</span>
          </div>
        ) : null}
      </div>

      {/* Content */}
      <div className="px-4 py-3 space-y-3">
        {/* ==================== iOS SECTION ==================== */}
        {isIOSNative && iosStatus && (
          <>
            {/* iOS Warning message */}
            {iosWarningMessage && (
              <div className="bg-warning/10 border border-warning/20 rounded-lg p-3">
                <p className="text-sm text-foreground leading-relaxed">
                  {iosWarningMessage}
                </p>
              </div>
            )}

            {/* iOS Status indicators */}
            <div className="space-y-2">
              {/* Background App Refresh status */}
              <div className="flex items-center justify-between py-1">
                <span className="text-sm text-muted-foreground">
                  Background App Refresh
                </span>
                {iosStatus.isBackgroundRefreshEnabled ? (
                  <span className="text-xs font-medium text-success">
                    Enabled
                  </span>
                ) : iosStatus.backgroundRefreshStatus === 'denied' ? (
                  <span className="text-xs font-medium text-destructive">
                    Disabled
                  </span>
                ) : iosStatus.backgroundRefreshStatus === 'restricted' ? (
                  <span className="text-xs font-medium text-warning">
                    Restricted
                  </span>
                ) : (
                  <span className="text-xs font-medium text-muted-foreground">
                    Unknown
                  </span>
                )}
              </div>

              {/* Low Power Mode status */}
              <div className="flex items-center justify-between py-1">
                <span className="text-sm text-muted-foreground flex items-center gap-1.5">
                  <Zap className="w-3.5 h-3.5" aria-hidden="true" />
                  Low Power Mode
                </span>
                {iosStatus.isLowPowerModeEnabled ? (
                  <span className="text-xs font-medium text-warning">On</span>
                ) : (
                  <span className="text-xs font-medium text-success">Off</span>
                )}
              </div>
            </div>

            {/* iOS Action buttons */}
            {iosHasIssues && iosStatus.userCanEnableBackgroundRefresh && (
              <div className="space-y-2 pt-1">
                <Button
                  variant="primary"
                  size="sm"
                  className="w-full"
                  onClick={handleOpenIOSSettings}
                >
                  Open Settings
                </Button>
              </div>
            )}
          </>
        )}

        {/* ==================== ANDROID SECTION ==================== */}
        {isAndroidNative && (
          <>
            {/* Android Device-specific warning */}
            {deviceInfo?.isProblematic && deviceInfo.warningMessage && (
              <div className="bg-warning/10 border border-warning/20 rounded-lg p-3">
                <p className="text-sm text-foreground leading-relaxed">
                  {deviceInfo.warningMessage}
                </p>
                {deviceInfo.helpUrl && (
                  <Button
                    variant="link"
                    onClick={handleOpenHelp}
                    className="mt-2 flex items-center gap-1.5 text-sm text-accent p-0 h-auto"
                    ariaLabel="Learn more about battery optimization for your device"
                  >
                    <ExternalLink className="w-4 h-4" aria-hidden="true" />
                    Learn more
                  </Button>
                )}
              </div>
            )}

            {/* Android Status indicators */}
            {androidStatus && (
              <div className="space-y-2">
                {/* Battery optimization status */}
                <div className="flex items-center justify-between py-1">
                  <span className="text-sm text-muted-foreground">
                    Battery optimization disabled
                  </span>
                  {androidStatus.isIgnoringBatteryOptimization ? (
                    <span className="text-xs font-medium text-success">
                      Yes
                    </span>
                  ) : (
                    <span className="text-xs font-medium text-destructive">
                      No
                    </span>
                  )}
                </div>

                {/* Background restriction status */}
                <div className="flex items-center justify-between py-1">
                  <span className="text-sm text-muted-foreground">
                    Android background restriction
                  </span>
                  {!androidStatus.isBackgroundRestricted ? (
                    <div className="flex flex-col items-end gap-0.5">
                      <span className="text-xs font-medium text-success">
                        Not restricted
                      </span>
                      {isXiaomi && (
                        <span className="text-xs text-muted-foreground italic">
                          (MIUI may still restrict)
                        </span>
                      )}
                    </div>
                  ) : (
                    <span className="text-xs font-medium text-destructive">
                      Restricted
                    </span>
                  )}
                </div>
              </div>
            )}

            {/* Android Action buttons */}
            {(androidHasIssues || isXiaomi) && (
              <div className="space-y-2 pt-1">
                {/* Battery optimization button */}
                {!androidStatus?.isIgnoringBatteryOptimization && (
                  <Button
                    variant="primary"
                    size="sm"
                    className="w-full"
                    onClick={handleOpenBatterySettings}
                  >
                    Disable Battery Optimization
                  </Button>
                )}

                {/* Xiaomi-specific AutoStart button */}
                {isXiaomi && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="w-full"
                    onClick={handleOpenAutoStartSettings}
                    ariaLabel="Open MIUI AutoStart settings for Gossip"
                  >
                    Enable AutoStart (MIUI)
                  </Button>
                )}
              </div>
            )}
          </>
        )}

        {/* Debug info (both platforms) */}
        {showDebugInfo && (
          <div className="mt-3 pt-3 border-t border-border space-y-1">
            <p className="text-xs font-medium text-muted-foreground mb-2">
              Debug Info
            </p>
            <p className="text-xs text-muted-foreground font-mono">
              Platform: {platform}
            </p>

            {/* Android debug info */}
            {isAndroidNative && androidStatus && (
              <>
                <p className="text-xs text-muted-foreground font-mono">
                  Manufacturer: {androidStatus.manufacturer || 'unknown'}
                </p>
                <p className="text-xs text-muted-foreground font-mono">
                  Brand: {androidStatus.brand || 'unknown'}
                </p>
                <p className="text-xs text-muted-foreground font-mono">
                  Model: {androidStatus.model || 'unknown'}
                </p>
                <p className="text-xs text-muted-foreground font-mono">
                  SDK: {androidStatus.sdkVersion || 'unknown'}
                </p>
                <p className="text-xs text-muted-foreground font-mono">
                  Problematic Device:{' '}
                  {androidStatus.isProblematicDevice ? 'Yes' : 'No'}
                </p>
              </>
            )}

            {/* iOS debug info */}
            {isIOSNative && iosStatus && (
              <>
                <p className="text-xs text-muted-foreground font-mono">
                  Background Refresh: {iosStatus.backgroundRefreshStatus}
                </p>
                <p className="text-xs text-muted-foreground font-mono">
                  Low Power Mode:{' '}
                  {iosStatus.isLowPowerModeEnabled ? 'Yes' : 'No'}
                </p>
                <p className="text-xs text-muted-foreground font-mono">
                  User Can Enable:{' '}
                  {iosStatus.userCanEnableBackgroundRefresh ? 'Yes' : 'No'}
                </p>
              </>
            )}

            <div className="pt-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={handleRefresh}
                disabled={isLoading}
              >
                <RefreshCcw className="w-4 h-4 mr-2" aria-hidden="true" />
                Refresh Status
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default BackgroundSyncSettings;
