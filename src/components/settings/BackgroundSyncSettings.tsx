/**
 * Background Sync Settings Component
 *
 * Displays background sync status and device-specific warnings for Android devices.
 * Provides actions to fix battery optimization issues.
 */

import React, { useState, useEffect, useCallback } from 'react';
import { Capacitor } from '@capacitor/core';
import {
  Battery,
  ExternalLink,
  Shield,
  AlertTriangle,
  RefreshCcw,
} from 'react-feather';
import Button from '../ui/Button';
import {
  batteryOptimizationService,
  type BackgroundSyncStatus,
} from '../../services/batteryOptimization';
import { type DeviceReliabilityInfo } from '../../utils/deviceInfo';

interface BackgroundSyncSettingsProps {
  showDebugInfo?: boolean;
}

const BackgroundSyncSettings: React.FC<BackgroundSyncSettingsProps> = ({
  showDebugInfo = false,
}) => {
  const [status, setStatus] = useState<BackgroundSyncStatus | null>(null);
  const [deviceInfo, setDeviceInfo] = useState<DeviceReliabilityInfo | null>(
    null
  );
  const [isLoading, setIsLoading] = useState(true);
  const [isXiaomi, setIsXiaomi] = useState(false);

  // Check if we're on Android native platform
  const isAndroidNative =
    Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';

  // Load status on mount
  useEffect(() => {
    if (!isAndroidNative) {
      setIsLoading(false);
      return;
    }

    const loadStatus = async () => {
      setIsLoading(true);
      try {
        const [syncStatus, deviceReliabilityInfo, xiaomiCheck] =
          await Promise.all([
            batteryOptimizationService.getStatus(),
            batteryOptimizationService.getDeviceReliabilityInfo(),
            batteryOptimizationService.isXiaomiDevice(),
          ]);

        setStatus(syncStatus);
        setDeviceInfo(deviceReliabilityInfo);
        setIsXiaomi(xiaomiCheck);
      } catch (error) {
        console.error('Failed to load background sync status:', error);
      } finally {
        setIsLoading(false);
      }
    };

    void loadStatus();
  }, [isAndroidNative]);

  // Refresh status
  const handleRefresh = useCallback(async () => {
    if (!isAndroidNative) return;

    setIsLoading(true);
    try {
      // Refresh all data to match initial load behavior
      const [syncStatus, deviceReliabilityInfo, xiaomiCheck] =
        await Promise.all([
          batteryOptimizationService.refreshStatus(),
          batteryOptimizationService.getDeviceReliabilityInfo(),
          batteryOptimizationService.isXiaomiDevice(),
        ]);

      setStatus(syncStatus);
      setDeviceInfo(deviceReliabilityInfo);
      setIsXiaomi(xiaomiCheck);
    } catch (error) {
      console.error('Failed to refresh status:', error);
    } finally {
      setIsLoading(false);
    }
  }, [isAndroidNative]);

  // Refresh status when app becomes visible (e.g., returning from settings)
  useEffect(() => {
    if (!isAndroidNative) return;

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        // User returned to the app, refresh status
        void handleRefresh();
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [isAndroidNative, handleRefresh]);

  // Open battery optimization settings
  const handleOpenBatterySettings = useCallback(async () => {
    await batteryOptimizationService.openBatteryOptimizationSettings();
    // Status will be refreshed automatically when user returns (via visibilitychange)
  }, []);

  // Open Xiaomi AutoStart settings
  const handleOpenAutoStartSettings = useCallback(async () => {
    const success =
      await batteryOptimizationService.openXiaomiAutoStartSettings();
    if (!success) {
      // Fallback to app settings if AutoStart not available
      await batteryOptimizationService.openAppSettings();
    }
    // Status will be refreshed automatically when user returns (via visibilitychange)
  }, []);

  // Open help URL in browser
  const handleOpenHelp = useCallback(() => {
    if (deviceInfo?.helpUrl) {
      window.open(deviceInfo.helpUrl, '_blank', 'noopener,noreferrer');
    }
  }, [deviceInfo?.helpUrl]);

  // Don't show anything on non-Android platforms
  if (!isAndroidNative) {
    return null;
  }

  // Determine if there are issues
  const hasIssues =
    status !== null &&
    (!status.isIgnoringBatteryOptimization || status.isBackgroundRestricted);
  const isReliable = status?.isBackgroundSyncReliable;

  return (
    <div className="bg-card border border-border rounded-lg overflow-hidden shadow-sm">
      {/* Header */}
      <div className="h-[54px] flex items-center px-4 justify-start w-full border-b border-border">
        <Battery className="text-foreground mr-4" aria-hidden="true" />
        <span className="text-base font-semibold text-foreground flex-1 text-left">
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
        {/* Device-specific warning */}
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

        {/* Status indicators */}
        {status && (
          <div className="space-y-2">
            {/* Battery optimization status */}
            <div className="flex items-center justify-between py-1">
              <span className="text-sm text-muted-foreground">
                Battery optimization disabled
              </span>
              {status.isIgnoringBatteryOptimization ? (
                <span className="text-xs font-medium text-success">Yes</span>
              ) : (
                <span className="text-xs font-medium text-destructive">No</span>
              )}
            </div>

            {/* Background restriction status */}
            <div className="flex items-center justify-between py-1">
              <span className="text-sm text-muted-foreground">
                Background allowed
              </span>
              {!status.isBackgroundRestricted ? (
                <span className="text-xs font-medium text-success">Yes</span>
              ) : (
                <span className="text-xs font-medium text-destructive">No</span>
              )}
            </div>
          </div>
        )}

        {/* Action buttons */}
        {hasIssues && (
          <div className="space-y-2 pt-1">
            {/* Battery optimization button */}
            {!status?.isIgnoringBatteryOptimization && (
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

        {/* Debug info */}
        {showDebugInfo && status && (
          <div className="mt-3 pt-3 border-t border-border space-y-1">
            <p className="text-xs font-medium text-muted-foreground mb-2">
              Debug Info
            </p>
            <p className="text-xs text-muted-foreground font-mono">
              Manufacturer: {status.manufacturer || 'unknown'}
            </p>
            <p className="text-xs text-muted-foreground font-mono">
              Brand: {status.brand || 'unknown'}
            </p>
            <p className="text-xs text-muted-foreground font-mono">
              Model: {status.model || 'unknown'}
            </p>
            <p className="text-xs text-muted-foreground font-mono">
              SDK: {status.sdkVersion || 'unknown'}
            </p>
            <p className="text-xs text-muted-foreground font-mono">
              Problematic Device: {status.isProblematicDevice ? 'Yes' : 'No'}
            </p>
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
