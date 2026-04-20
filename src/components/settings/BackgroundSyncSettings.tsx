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

  const handleForegroundReliabilityChange = useCallback(
    async (enabled: boolean) => {
      try {
        if (enabled) {
          // Force the sync preset to `max` whenever the foreground service is
          // turned on — the user opted in to maximum reliability, so use the
          // tightest tick interval.
          await setBackgroundSyncPreset('max');
          setSyncPreset('max');
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

  // Android: toggle the battery-optimization bypass.
  // When the bypass is NOT yet granted, fire the system prompt to grant it.
  // When it IS granted, the prompt intent silently returns (no UI) — so we
  // open the app info page instead, where the user can re-enable optimization.
  const handleToggleBatteryOptBypass = useCallback(async () => {
    if (androidStatus?.isIgnoringBatteryOptimization) {
      await batteryOptimizationService.openAppSettings();
    } else {
      await batteryOptimizationService.openBatteryOptimizationSettings();
    }
  }, [androidStatus?.isIgnoringBatteryOptimization]);

  // Android: open the app info page (used for "Allow background activity" —
  // the background-restriction toggle lives in the app's Battery section).
  const handleOpenAppSettings = useCallback(async () => {
    await batteryOptimizationService.openAppSettings();
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
        {/* ======================= INFO (top) ======================= */}
        {isAndroidNative &&
          androidHasIssues &&
          deviceInfo?.isProblematic &&
          deviceInfo.warningKey && (
            <div className="bg-warning/10 border border-warning/20 rounded-lg p-4">
              <div className="flex items-start gap-3">
                <AlertTriangle
                  className="w-5 h-5 text-warning shrink-0 mt-0.5"
                  aria-hidden="true"
                />
                <div className="flex-1 min-w-0 space-y-3">
                  <p className="text-sm text-foreground leading-relaxed">
                    {t(
                      `background_sync.device_warnings.${deviceInfo.warningKey}`
                    )}
                  </p>
                  {deviceInfo.helpUrl && (
                    <div className="flex justify-end">
                      <button
                        type="button"
                        onClick={handleOpenHelp}
                        aria-label={t('background_sync.learn_more')}
                        className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
                      >
                        {t('background_sync.learn_more')}
                        <ExternalLink className="w-3 h-3" aria-hidden="true" />
                      </button>
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

        {isIOSNative && iosWarningMessage && (
          <div className="bg-warning/10 border border-warning/20 rounded-lg p-4">
            <div className="flex items-start gap-3">
              <AlertTriangle
                className="w-5 h-5 text-warning shrink-0 mt-0.5"
                aria-hidden="true"
              />
              <p className="flex-1 min-w-0 text-sm text-foreground leading-relaxed">
                {iosWarningMessage}
              </p>
            </div>
          </div>
        )}

        {isIOSNative && (
          <p className="text-xs text-muted-foreground leading-relaxed">
            {t('background_sync.ios_limitation')}
          </p>
        )}

        {/* ===================== SWITCHES (bottom) ===================== */}
        {isAndroidNative && androidStatus && (
          <div
            className={
              androidHasIssues &&
              deviceInfo?.isProblematic &&
              deviceInfo.warningKey
                ? 'space-y-3 pt-1 border-t border-border'
                : 'space-y-3'
            }
          >
            {/* PREREQUISITE — background activity allowed. If the OS restricts
                the app in the background, nothing else can run, so hide every
                downstream toggle until this is green. */}
            <div className="space-y-1">
              <div className="flex items-center justify-between gap-3 py-1">
                <span className="text-sm text-foreground flex-1">
                  {t('background_sync.allow_background')}
                </span>
                <Toggle
                  checked={!androidStatus.isBackgroundRestricted}
                  onChange={handleOpenAppSettings}
                  ariaLabel={t('background_sync.allow_background')}
                />
              </div>
              <p className="text-xs text-muted-foreground leading-relaxed">
                {t('background_sync.allow_background_description')}
              </p>
              {isXiaomi && (
                <p className="text-xs text-muted-foreground italic leading-relaxed">
                  {t('background_sync.miui_note')}
                </p>
              )}
            </div>

            {!androidStatus.isBackgroundRestricted && (
              <>
                {/* Battery optimization bypass — opens system settings on tap */}
                <div className="space-y-1">
                  <div className="flex items-center justify-between gap-3 py-1">
                    <span className="text-sm text-foreground flex-1">
                      {t('background_sync.disable_battery')}
                    </span>
                    <Toggle
                      checked={androidStatus.isIgnoringBatteryOptimization}
                      onChange={handleToggleBatteryOptBypass}
                      ariaLabel={t('background_sync.disable_battery')}
                    />
                  </div>
                  <p className="text-xs text-muted-foreground leading-relaxed">
                    {t('background_sync.disable_battery_description')}
                  </p>
                </div>

                {/* Xiaomi AutoStart — state is not observable, tap opens settings */}
                {isXiaomi && (
                  <div className="space-y-1">
                    <div className="flex items-center justify-between gap-3 py-1">
                      <span className="text-sm text-foreground flex-1">
                        {t('background_sync.enable_autostart')}
                      </span>
                      <Toggle
                        checked={false}
                        onChange={handleOpenAutoStartSettings}
                        ariaLabel={t('background_sync.enable_autostart')}
                      />
                    </div>
                  </div>
                )}
              </>
            )}

            {/* Foreground-sync — max-reliability option. Available as soon as
                background activity is allowed; useful on aggressive OEMs even
                when battery-opt is bypassed. Enabling it forces preset `max`. */}
            {!androidStatus.isBackgroundRestricted && (
              <div className="space-y-1">
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
          </div>
        )}

        {isIOSNative && iosStatus && (
          <div className="space-y-3 pt-1 border-t border-border">
            {/* Background App Refresh — opens system settings on tap */}
            <div className="space-y-1 pt-2">
              <div className="flex items-center justify-between gap-3 py-1">
                <span className="text-sm text-foreground flex-1">
                  {t('background_sync.background_refresh')}
                </span>
                <Toggle
                  checked={iosStatus.isBackgroundRefreshEnabled}
                  onChange={handleOpenIOSSettings}
                  disabled={!iosStatus.userCanEnableBackgroundRefresh}
                  ariaLabel={t('background_sync.background_refresh')}
                />
              </div>
            </div>

            {/* Low Power Mode — display-only: cannot be toggled per-app */}
            <div className="space-y-1">
              <div className="flex items-center justify-between gap-3 py-1">
                <span className="text-sm text-foreground flex-1 flex items-center gap-1.5">
                  <Zap className="w-3.5 h-3.5" aria-hidden="true" />
                  {t('background_sync.low_power')}
                </span>
                <Toggle
                  checked={iosStatus.isLowPowerModeEnabled}
                  onChange={() => {
                    /* System-wide setting; no per-app control available. */
                  }}
                  disabled
                  ariaLabel={t('background_sync.low_power')}
                />
              </div>
            </div>
          </div>
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
