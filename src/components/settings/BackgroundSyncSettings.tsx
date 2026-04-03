/**
 * Background Sync Settings Component
 *
 * Displays background sync status and device-specific warnings for Android and iOS devices.
 * - Android: Battery optimization, background restriction, manufacturer-specific issues
 * - iOS: Background App Refresh status, Low Power Mode
 * Provides actions to fix configuration issues.
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Capacitor, PluginListenerHandle } from '@capacitor/core';
import { App } from '@capacitor/app';
import {
  Battery,
  ExternalLink,
  AlertTriangle,
  RefreshCcw,
  Zap,
} from 'react-feather';
import Button from '../ui/Button';
import Toggle from '../ui/Toggle';
import {
  batteryOptimizationService,
  type BackgroundSyncStatus,
} from '../../services/batteryOptimization';
import { type DeviceReliabilityInfo } from '../../utils/deviceInfo';
import {
  backgroundRefreshService,
  type IOSBackgroundSyncStatus,
} from '../../services/backgroundRefreshiOS';
import {
  type BackgroundSyncPreset,
  getBackgroundSyncPreset,
  setBackgroundSyncPreset,
} from '../../utils/preferences';
import { ForegroundSync } from '../../services/foregroundSync';

interface BackgroundSyncSettingsProps {
  showDebugInfo?: boolean;
}

const BackgroundSyncSettings: React.FC<BackgroundSyncSettingsProps> = ({
  showDebugInfo = false,
}) => {
  const { t } = useTranslation('settings');
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
  const [syncPreset, setSyncPreset] = useState<BackgroundSyncPreset>('max');
  const [foregroundHighReliability, setForegroundHighReliability] =
    useState(false);

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

  useEffect(() => {
    if (!isNative) return;
    void (async () => {
      try {
        const p = await getBackgroundSyncPreset();
        setSyncPreset(p);
      } catch {
        // keep default
      }
    })();
  }, [isNative]);

  useEffect(() => {
    if (!isAndroidNative) {
      return;
    }
    void (async () => {
      try {
        const { enabled } = await ForegroundSync.isEnabled();
        setForegroundHighReliability(enabled);
      } catch {
        // Native plugin missing or error
      }
    })();
  }, [isAndroidNative]);

  const handleSyncPresetChange = useCallback(async (maxReactivity: boolean) => {
    const preset: BackgroundSyncPreset = maxReactivity ? 'max' : 'balanced';
    try {
      await setBackgroundSyncPreset(preset);
      setSyncPreset(preset);
    } catch (error) {
      console.error('Failed to save background sync preset:', error);
    }
  }, []);

  const handleForegroundReliabilityChange = useCallback(
    async (enabled: boolean) => {
      try {
        if (enabled) {
          await ForegroundSync.start();
        } else {
          await ForegroundSync.stop();
        }
        setForegroundHighReliability(enabled);
      } catch (error) {
        console.error('Failed to toggle foreground sync:', error);
      }
    },
    []
  );

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
          {t('background_sync.title')}
        </span>
        {isLoading ? (
          <span className="text-xs text-muted-foreground">
            {t('background_sync.checking')}
          </span>
        ) : hasIssues ? (
          <div className="flex items-center gap-1.5">
            <AlertTriangle
              className="w-4 h-4 text-warning"
              aria-hidden="true"
            />
            <span className="text-xs text-warning">
              {t('background_sync.needs_attention')}
            </span>
          </div>
        ) : null}
      </div>

      {/* Content */}
      <div className="px-4 py-3 space-y-3">
        {isAndroidNative && (
          <div className="space-y-2 pb-3 border-b border-border">
            <div className="flex items-center justify-between gap-3 py-1">
              <span className="text-sm text-foreground flex-1">
                {t('background_sync.preset_max')}
              </span>
              <Toggle
                checked={syncPreset === 'max'}
                onChange={handleSyncPresetChange}
                ariaLabel={t('background_sync.preset_max')}
              />
            </div>
            <p className="text-xs text-muted-foreground leading-relaxed">
              {syncPreset === 'max'
                ? t('background_sync.preset_max_description')
                : t('background_sync.preset_balanced_description')}
            </p>
          </div>
        )}

        {isAndroidNative && (
          <div className="space-y-2 pb-3 border-b border-border">
            <div className="flex items-center justify-between gap-3 py-1">
              <span className="text-sm text-foreground flex-1">
                {t('background_sync.foreground_toggle')}
              </span>
              <Toggle
                checked={foregroundHighReliability}
                onChange={handleForegroundReliabilityChange}
                ariaLabel={t('background_sync.foreground_toggle')}
              />
            </div>
            <p className="text-xs text-muted-foreground leading-relaxed">
              {t('background_sync.foreground_description')}
            </p>
          </div>
        )}

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
                  {t('background_sync.background_refresh')}
                </span>
                {iosStatus.isBackgroundRefreshEnabled ? (
                  <span className="text-xs font-medium text-success">
                    {t('background_sync.enabled')}
                  </span>
                ) : iosStatus.backgroundRefreshStatus === 'denied' ? (
                  <span className="text-xs font-medium text-destructive">
                    {t('background_sync.disabled')}
                  </span>
                ) : iosStatus.backgroundRefreshStatus === 'restricted' ? (
                  <span className="text-xs font-medium text-warning">
                    {t('background_sync.restricted')}
                  </span>
                ) : (
                  <span className="text-xs font-medium text-muted-foreground">
                    {t('background_sync.unknown')}
                  </span>
                )}
              </div>

              {/* Low Power Mode status */}
              <div className="flex items-center justify-between py-1">
                <span className="text-sm text-muted-foreground flex items-center gap-1.5">
                  <Zap className="w-3.5 h-3.5" aria-hidden="true" />
                  {t('background_sync.low_power')}
                </span>
                {iosStatus.isLowPowerModeEnabled ? (
                  <span className="text-xs font-medium text-warning">
                    {t('background_sync.on')}
                  </span>
                ) : (
                  <span className="text-xs font-medium text-success">
                    {t('background_sync.off')}
                  </span>
                )}
              </div>
            </div>

            {/* iOS limitation notice */}
            <p className="text-xs text-muted-foreground leading-relaxed">
              {t('background_sync.ios_limitation')}
            </p>

            {/* iOS Action buttons */}
            {iosHasIssues && iosStatus.userCanEnableBackgroundRefresh && (
              <div className="space-y-2 pt-1">
                <Button
                  variant="primary"
                  size="sm"
                  className="w-full"
                  onClick={handleOpenIOSSettings}
                >
                  {t('background_sync.open_settings')}
                </Button>
              </div>
            )}
          </>
        )}

        {/* ==================== ANDROID SECTION ==================== */}
        {isAndroidNative && (
          <>
            {/* Android Device-specific warning — only when there are issues */}
            {androidHasIssues &&
              deviceInfo?.isProblematic &&
              deviceInfo.warningMessage && (
                <div className="bg-warning/10 border border-warning/20 rounded-lg p-3">
                  <p className="text-sm text-foreground leading-relaxed">
                    {deviceInfo.warningMessage}
                  </p>
                  {deviceInfo.helpUrl && (
                    <Button
                      variant="link"
                      onClick={handleOpenHelp}
                      className="mt-2 flex items-center gap-1.5 text-sm text-accent p-0 h-auto"
                      ariaLabel={t('background_sync.learn_more')}
                    >
                      <ExternalLink className="w-4 h-4" aria-hidden="true" />
                      {t('background_sync.learn_more')}
                    </Button>
                  )}
                </div>
              )}

            {/* Android Status indicators — always visible */}
            {androidStatus && (
              <div className="space-y-2">
                <div className="flex items-center justify-between py-1">
                  <span className="text-sm text-muted-foreground">
                    {t('background_sync.battery_optimization')}
                  </span>
                  {androidStatus.isIgnoringBatteryOptimization ? (
                    <span className="text-xs font-medium text-success">
                      {t('background_sync.yes')}
                    </span>
                  ) : (
                    <span className="text-xs font-medium text-destructive">
                      {t('background_sync.no')}
                    </span>
                  )}
                </div>

                <div className="flex items-center justify-between py-1">
                  <span className="text-sm text-muted-foreground">
                    {t('background_sync.android_restriction')}
                  </span>
                  {!androidStatus.isBackgroundRestricted ? (
                    <div className="flex flex-col items-end gap-0.5">
                      <span className="text-xs font-medium text-success">
                        {t('background_sync.not_restricted')}
                      </span>
                      {isXiaomi && (
                        <span className="text-xs text-muted-foreground italic">
                          {t('background_sync.miui_note')}
                        </span>
                      )}
                    </div>
                  ) : (
                    <span className="text-xs font-medium text-destructive">
                      {t('background_sync.restricted')}
                    </span>
                  )}
                </div>
              </div>
            )}

            {/* Android Action buttons — only when there are issues */}
            {androidHasIssues && (
              <div className="space-y-2 pt-1">
                {!androidStatus?.isIgnoringBatteryOptimization && (
                  <Button
                    variant="primary"
                    size="sm"
                    className="w-full"
                    onClick={handleOpenBatterySettings}
                  >
                    {t('background_sync.disable_battery')}
                  </Button>
                )}
                {androidStatus?.isBackgroundRestricted && (
                  <Button
                    variant="primary"
                    size="sm"
                    className="w-full"
                    onClick={handleOpenBatterySettings}
                  >
                    {t('background_sync.open_settings')}
                  </Button>
                )}
                {isXiaomi && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="w-full"
                    onClick={handleOpenAutoStartSettings}
                    ariaLabel={t('background_sync.enable_autostart')}
                  >
                    {t('background_sync.enable_autostart')}
                  </Button>
                )}
              </div>
            )}

            {/* Battery settings — visible when no issues, so user can re-enable optimization */}
            {androidStatus && !androidHasIssues && (
              <Button
                variant="outline"
                size="sm"
                className="w-full"
                onClick={async () => {
                  await batteryOptimizationService.openAppSettings();
                }}
                ariaLabel={t('background_sync.battery_settings')}
              >
                {t('background_sync.battery_settings')}
              </Button>
            )}
          </>
        )}

        {/* Debug info (both platforms) */}
        {showDebugInfo && (
          <div className="mt-3 pt-3 border-t border-border space-y-1">
            <p className="text-xs font-medium text-muted-foreground mb-2">
              {t('background_sync.debug_info')}
            </p>
            <p className="text-xs text-muted-foreground font-mono">
              Platform: {platform}
            </p>
            <p className="text-xs text-muted-foreground font-mono">
              {t('background_sync.debug_sync_preset', {
                preset: syncPreset,
              })}
            </p>
            {isAndroidNative && (
              <p className="text-xs text-muted-foreground font-mono">
                {t('background_sync.debug_foreground_sync', {
                  value: foregroundHighReliability ? 'on' : 'off',
                })}
              </p>
            )}

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
                {t('background_sync.refresh_status')}
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default BackgroundSyncSettings;
