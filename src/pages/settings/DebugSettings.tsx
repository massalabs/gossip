import React, { useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import HeaderWrapper from '../../components/ui/HeaderWrapper';
import PageHeader from '../../components/ui/PageHeader';
import ScrollableContent from '../../components/ui/ScrollableContent';
import Button from '../../components/ui/Button';
import Toggle from '../../components/ui/Toggle';
import { useAppStore } from '../../stores/appStore';
import { notificationService } from '../../services/notifications';
import { db } from '../../db';
import { clearAppStorage } from '../../utils/localStorage';
import { useAccountStore } from '../../stores/accountStore';
import { useVersionCheck } from '../../hooks/useVersionCheck';
import { ROUTES } from '../../constants/routes';
import {
  AlertTriangle,
  Bell,
  Settings as SettingsIconFeather,
} from 'react-feather';

const DebugSettings: React.FC = () => {
  const navigate = useNavigate();
  const showDebugOption = useAppStore(s => s.showDebugOption);
  const setShowDebugOption = useAppStore(s => s.setShowDebugOption);
  const { resetAccount } = useAccountStore();
  const { isVersionDifferent, handleForceUpdate } = useVersionCheck();

  const handleBack = () => {
    navigate(ROUTES.settings());
  };

  const handleResetAllAccounts = useCallback(async () => {
    try {
      await resetAccount();
      clearAppStorage();
      await db.deleteDb();
      window.location.reload();
    } catch (error) {
      console.error('Failed to reset all accounts:', error);
    }
  }, [resetAccount]);

  const handleResetAllDiscussionsAndMessages = useCallback(async () => {
    try {
      await db.transaction(
        'rw',
        [db.contacts, db.messages, db.discussions],
        async () => {
          await db.messages.clear();
          await db.discussions.clear();
          await db.contacts.clear();
        }
      );
    } catch (error) {
      console.error('Failed to reset discussions and messages:', error);
    }
  }, []);

  const notificationPrefs = notificationService.getPreferences();

  return (
    <div className="h-full flex flex-col bg-background app-max-w mx-auto">
      <HeaderWrapper>
        <PageHeader title="Debug" onBack={handleBack} />
      </HeaderWrapper>
      <ScrollableContent className="flex-1 overflow-y-auto px-6 py-6">
        <div className="space-y-6">
          <div className="bg-card rounded-xl border border-border overflow-hidden">
            <div className="h-[54px] flex items-center px-4 justify-between border-b border-border">
              <div className="flex items-center flex-1">
                <SettingsIconFeather className="text-foreground mr-4" />
                <span className="text-base font-semibold text-foreground flex-1 text-left">
                  Show Debug Options
                </span>
              </div>
              <Toggle
                checked={showDebugOption}
                onChange={setShowDebugOption}
                ariaLabel="Show debug options"
              />
            </div>
            {notificationService.isSupported() &&
              notificationPrefs.permission.granted &&
              notificationPrefs.enabled && (
                <Button
                  variant="outline"
                  size="custom"
                  className="w-full h-[54px] flex items-center px-4 justify-start rounded-none border-0 border-b border-border"
                  onClick={async () => {
                    await notificationService.showDiscussionNotification(
                      'Test User',
                      'Test Message',
                      'test-user-id'
                    );
                  }}
                >
                  <Bell className="mr-4" />
                  <span className="text-base font-semibold flex-1 text-left">
                    Test Notification
                  </span>
                </Button>
              )}
            <Button
              variant="outline"
              size="custom"
              className="w-full h-[54px] flex items-center px-4 justify-start rounded-none border-0 border-b border-border"
              onClick={handleResetAllAccounts}
            >
              <AlertTriangle className="mr-4" />
              <span className="text-base font-semibold flex-1 text-left">
                Reset App
              </span>
            </Button>
            <Button
              variant="outline"
              size="custom"
              className="w-full h-[54px] flex items-center px-4 justify-start rounded-none border-0"
              onClick={handleResetAllDiscussionsAndMessages}
            >
              <AlertTriangle className="mr-4" />
              <span className="text-base font-semibold flex-1 text-left">
                Clear Messages & Contacts
              </span>
            </Button>
          </div>

          {isVersionDifferent && (
            <Button
              variant="outline"
              size="custom"
              className="w-full h-[54px] flex items-center px-4 justify-start rounded-xl text-destructive border-destructive hover:bg-destructive/10"
              onClick={handleForceUpdate}
            >
              <AlertTriangle className="mr-4" />
              <span className="text-base font-semibold flex-1 text-left">
                Clear Cache & Database
              </span>
            </Button>
          )}
        </div>
      </ScrollableContent>
    </div>
  );
};

export default DebugSettings;
