import React, { useState, useCallback, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { Capacitor, type PluginListenerHandle } from '@capacitor/core';
import { App } from '@capacitor/app';
import PageLayout from '../../components/ui/Layout/PageLayout';
import PageHeader from '../../components/ui/PageHeader';
import Button from '../../components/ui/Button';
import Toggle from '../../components/ui/Toggle';
import BackgroundSyncSettings from '../../components/settings/BackgroundSyncSettings';
import BackgroundSyncPrivacyNotice from '../../components/settings/BackgroundSyncPrivacyNotice';
import { backgroundRefreshService } from '../../services/backgroundRefreshiOS';
import { batteryOptimizationService } from '../../services/batteryOptimization';
import {
  notificationService,
  type NotificationPreferences,
} from '../../services/notifications';
import { useAppStore } from '../../stores/appStore';
import { ROUTES } from '../../constants/routes';
import { Bell } from 'react-feather';

const NotificationsSettings: React.FC = () => {
  const { t } = useTranslation('settings');
  const navigate = useNavigate();
  const showDebugOption = useAppStore(s => s.showDebugOption);
  const [notificationPrefs, setNotificationPrefs] =
    useState<NotificationPreferences>(() =>
      notificationService.getPreferences()
    );
  // On native, the initial `getPreferences()` call returns a stale default
  // (permission state is fetched asynchronously). Hide the permission control
  // until the first real read resolves so we don't flash an "Enable" button
  // for a user who already granted permission.
  const [prefsLoaded, setPrefsLoaded] = useState(
    () => !Capacitor.isNativePlatform()
  );
  const [isRequestingPermission, setIsRequestingPermission] = useState(false);

  const handleBack = () => {
    navigate(ROUTES.settings());
  };

  const refreshPrefs = useCallback(async () => {
    const prefs = await notificationService.fetchPreferences();
    setNotificationPrefs(prefs);
    setPrefsLoaded(true);
  }, []);

  useEffect(() => {
    void refreshPrefs();
  }, [refreshPrefs]);

  // Re-read when the user returns from the system Settings app — permission
  // may have been granted or revoked outside our process.
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    let handle: PluginListenerHandle | null = null;
    void (async () => {
      handle = await App.addListener('appStateChange', state => {
        if (state.isActive) {
          void refreshPrefs();
        }
      });
    })();
    return () => {
      if (handle) void handle.remove();
    };
  }, [refreshPrefs]);

  const handleNotificationToggle = useCallback(
    (enabled: boolean) => {
      notificationService.setEnabled(enabled);
      void refreshPrefs();
    },
    [refreshPrefs]
  );

  const handleRequestNotificationPermission = useCallback(async () => {
    setIsRequestingPermission(true);
    try {
      await notificationService.requestPermission();
      await refreshPrefs();
    } finally {
      setIsRequestingPermission(false);
    }
  }, [refreshPrefs]);

  const handleOpenSystemSettings = useCallback(async () => {
    if (Capacitor.getPlatform() === 'ios') {
      await backgroundRefreshService.openSettings();
    } else if (Capacitor.getPlatform() === 'android') {
      await batteryOptimizationService.openAppSettings();
    }
  }, []);

  if (!notificationService.isSupported()) {
    return (
      <PageLayout
        header={
          <PageHeader title={t('notifications.title')} onBack={handleBack} />
        }
        className="app-max-w mx-auto"
        contentClassName="px-6 py-6"
      >
        <div className="bg-card rounded-xl border border-border p-4">
          <p className="text-sm text-muted-foreground">
            {t('notifications.not_supported')}
          </p>
        </div>
      </PageLayout>
    );
  }

  return (
    <PageLayout
      header={
        <PageHeader title={t('notifications.title')} onBack={handleBack} />
      }
      className="app-max-w mx-auto"
      contentClassName="px-6 py-6"
    >
      <div className="bg-card border border-border rounded-xl overflow-hidden">
        <div className="h-[54px] flex items-center px-4 justify-start w-full border-b border-border">
          <Bell className="text-foreground mr-4" />
          <span className="text-base font-medium text-foreground flex-1 text-left">
            {t('notifications.title')}
          </span>
          {!prefsLoaded ? null : notificationPrefs.permission.granted ? (
            <Toggle
              checked={notificationPrefs.enabled}
              onChange={handleNotificationToggle}
              ariaLabel={t('notifications.toggle')}
            />
          ) : notificationPrefs.permission.denied ? (
            <span className="text-xs text-muted-foreground">
              {t('notifications.blocked')}
            </span>
          ) : (
            <Button
              variant="primary"
              size="sm"
              onClick={handleRequestNotificationPermission}
              disabled={isRequestingPermission}
            >
              {isRequestingPermission
                ? t('notifications.requesting')
                : t('notifications.enable')}
            </Button>
          )}
        </div>
        {notificationPrefs.permission.denied && (
          <div className="px-4 py-4 space-y-3">
            <p className="text-xs text-muted-foreground">
              {Capacitor.isNativePlatform()
                ? t('notifications.blocked_message_native')
                : t('notifications.blocked_message_web')}
            </p>
            {Capacitor.isNativePlatform() && (
              <Button
                variant="outline"
                size="sm"
                onClick={handleOpenSystemSettings}
              >
                {t('notifications.open_settings')}
              </Button>
            )}
          </div>
        )}
        {/* Test Notification - Only show when debug mode is enabled */}
        {showDebugOption &&
          notificationPrefs.permission.granted &&
          notificationPrefs.enabled && (
            <Button
              variant="outline"
              size="custom"
              className="w-full h-[54px] flex items-center px-4 justify-start rounded-none border-0 border-t border-border"
              onClick={async () => {
                await notificationService.showDiscussionNotification(
                  'test-user-id'
                );
              }}
            >
              <Bell className="mr-4" />
              <span className="text-base font-medium flex-1 text-left">
                {t('edit_username_modal.test_notification')}
              </span>
            </Button>
          )}
      </div>

      {notificationPrefs.permission.granted && notificationPrefs.enabled && (
        <>
          {/* Background Sync Settings (Battery Optimization) - Only on native platforms */}
          {Capacitor.isNativePlatform() && (
            <div className="mt-6">
              <BackgroundSyncSettings showDebugInfo={showDebugOption} />
            </div>
          )}

          <div className="mt-6">
            <BackgroundSyncPrivacyNotice />
          </div>
        </>
      )}
    </PageLayout>
  );
};

export default NotificationsSettings;
