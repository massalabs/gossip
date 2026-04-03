import React, { useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { Capacitor } from '@capacitor/core';
import PageLayout from '../../components/ui/PageLayout';
import PageHeader from '../../components/ui/PageHeader';
import Button from '../../components/ui/Button';
import Toggle from '../../components/ui/Toggle';
import BackgroundSyncSettings from '../../components/settings/BackgroundSyncSettings';
import BackgroundSyncPrivacyNotice from '../../components/settings/BackgroundSyncPrivacyNotice';
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
  const [isRequestingPermission, setIsRequestingPermission] = useState(false);

  const handleBack = () => {
    navigate(ROUTES.settings());
  };

  const handleNotificationToggle = useCallback((enabled: boolean) => {
    notificationService.setEnabled(enabled);
    setNotificationPrefs(notificationService.getPreferences());
  }, []);

  const handleRequestNotificationPermission = useCallback(async () => {
    setIsRequestingPermission(true);
    try {
      await notificationService.requestPermission();
      setNotificationPrefs(notificationService.getPreferences());
    } finally {
      setIsRequestingPermission(false);
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
          {notificationPrefs.permission.granted ? (
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
          <div className="px-4 py-4">
            <p className="text-xs text-muted-foreground">
              {t('notifications.blocked_message')}
            </p>
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
                  'Test User',
                  'Test Message',
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
