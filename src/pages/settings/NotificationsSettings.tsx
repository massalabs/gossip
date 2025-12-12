import React, { useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import HeaderWrapper from '../../components/ui/HeaderWrapper';
import PageHeader from '../../components/ui/PageHeader';
import ScrollableContent from '../../components/ui/ScrollableContent';
import Button from '../../components/ui/Button';
import Toggle from '../../components/ui/Toggle';
import {
  notificationService,
  type NotificationPreferences,
} from '../../services/notifications';
import { ROUTES } from '../../constants/routes';
import { Bell } from 'react-feather';

const NotificationsSettings: React.FC = () => {
  const navigate = useNavigate();
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
      <div className="h-full flex flex-col bg-background app-max-w mx-auto">
        <HeaderWrapper>
          <PageHeader title="Notifications" onBack={handleBack} />
        </HeaderWrapper>
        <ScrollableContent className="flex-1 overflow-y-auto px-6 py-6">
          <div className="bg-card rounded-xl border border-border p-4">
            <p className="text-sm text-muted-foreground">
              Notifications are not supported on this device.
            </p>
          </div>
        </ScrollableContent>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col bg-background app-max-w mx-auto">
      <HeaderWrapper>
        <PageHeader title="Notifications" onBack={handleBack} />
      </HeaderWrapper>
      <ScrollableContent className="flex-1 overflow-y-auto px-6 py-6">
        <div className="bg-card border border-border rounded-xl overflow-hidden">
          <div className="h-[54px] flex items-center px-4 justify-start w-full border-b border-border">
            <Bell className="text-foreground mr-4" />
            <span className="text-base font-semibold text-foreground flex-1 text-left">
              Notifications
            </span>
            {notificationPrefs.permission.granted ? (
              <Toggle
                checked={notificationPrefs.enabled}
                onChange={handleNotificationToggle}
                ariaLabel="Toggle notifications"
              />
            ) : notificationPrefs.permission.denied ? (
              <span className="text-xs text-muted-foreground">Blocked</span>
            ) : (
              <Button
                variant="primary"
                size="sm"
                onClick={handleRequestNotificationPermission}
                disabled={isRequestingPermission}
              >
                {isRequestingPermission ? 'Requesting...' : 'Enable'}
              </Button>
            )}
          </div>
          {notificationPrefs.permission.denied && (
            <div className="px-4 py-4">
              <p className="text-xs text-muted-foreground">
                Notifications are blocked. Please enable them in your browser
                settings.
              </p>
            </div>
          )}
        </div>
      </ScrollableContent>
    </div>
  );
};

export default NotificationsSettings;
