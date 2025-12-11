import React, { useState, useCallback } from 'react';
import BaseModal from '../components/ui/BaseModal';
import { useAccountStore } from '../stores/accountStore';
import { useAppStore } from '../stores/appStore';
import { useTheme } from '../hooks/useTheme';
import AccountBackup from '../components/account/AccountBackup';
import Button from '../components/ui/Button';
import Toggle from '../components/ui/Toggle';
import InfoRow from '../components/ui/InfoRow';
import UserIdDisplay from '../components/ui/UserIdDisplay';
import { useVersionCheck } from '../hooks/useVersionCheck';
import { STORAGE_KEYS, clearAppStorage } from '../utils/localStorage';
import { ROUTES } from '../constants/routes';
import {
  AlertTriangle,
  Camera,
  Copy,
  LogOut,
  RefreshCcw,
  Settings as SettingsIconFeather,
  Trash2,
  Bell,
} from 'react-feather';
import { APP_VERSION } from '../config/version';
import { useLocalStorage } from '../hooks/useLocalStorage';
import { useNavigate } from 'react-router-dom';
import ShareContact from '../components/settings/ShareContact';
import ScanQRCode from '../components/settings/ScanQRCode';
import { db } from '../db';
import {
  notificationService,
  type NotificationPreferences,
} from '../services/notifications';
import BackgroundSyncSettings from '../components/settings/BackgroundSyncSettings';
import ThemeSelect from '../components/settings/ThemeSelect';

import ProfilePicture from '../assets/gossip_face.svg';

enum SettingsView {
  SHOW_ACCOUNT_BACKUP = 'SHOW_ACCOUNT_BACKUP',
  SHARE_CONTACT = 'SHARE_CONTACT',
  SCAN_QR_CODE = 'SCAN_QR_CODE',
}

const Settings = (): React.ReactElement => {
  const { userProfile, getMnemonicBackupInfo, logout, resetAccount, ourPk } =
    useAccountStore();
  const [appBuildId] = useLocalStorage(STORAGE_KEYS.APP_BUILD_ID, null);
  const showDebugOption = useAppStore(s => s.showDebugOption);
  const setShowDebugOption = useAppStore(s => s.setShowDebugOption);
  const [showUserId, setShowUserId] = useState(false);
  const { theme, setTheme, resolvedTheme } = useTheme();
  const [activeView, setActiveView] = useState<SettingsView | null>(null);
  const [isResetModalOpen, setIsResetModalOpen] = useState(false);
  const { isVersionDifferent, handleForceUpdate } = useVersionCheck();
  const navigate = useNavigate();

  // Notification preferences state
  const [notificationPrefs, setNotificationPrefs] =
    useState<NotificationPreferences>(() =>
      notificationService.getPreferences()
    );
  const [isRequestingPermission, setIsRequestingPermission] = useState(false);

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

  const mnemonicBackupInfo = getMnemonicBackupInfo();

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

  const handleResetAccount = useCallback(async () => {
    try {
      await resetAccount();
      navigate(ROUTES.default());
    } catch (error) {
      console.error('Failed to reset account:', error);
    }
  }, [resetAccount, navigate]);

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

  const handleLogout = async () => {
    try {
      await logout();
    } catch (error) {
      console.error('Failed to logout:', error);
    }
  };

  const handleScanSuccess = useCallback(
    (userId: string) => {
      navigate(ROUTES.newContact(), {
        state: { userId },
        replace: true,
      });
    },
    [navigate]
  );

  switch (activeView) {
    case SettingsView.SHOW_ACCOUNT_BACKUP:
      return <AccountBackup onBack={() => setActiveView(null)} />;
    case SettingsView.SHARE_CONTACT:
      return (
        <ShareContact
          onBack={() => setActiveView(null)}
          userId={userProfile!.userId}
          userName={userProfile!.username}
          publicKey={ourPk!}
        />
      );
    case SettingsView.SCAN_QR_CODE:
      return (
        <ScanQRCode
          onBack={() => setActiveView(null)}
          onScanSuccess={handleScanSuccess}
        />
      );
    default:
      break;
  }

  return (
    <div className="bg-background h-full overflow-auto app-max-w mx-auto">
      {/* Header */}
      <div className="px-6 py-4 border-b border-border bg-card">
        <h1 className="text-xl font-semibold text-foreground">Settings</h1>
      </div>
      {/* Main Content */}
      <div className="px-6 py-6">
        {/* Account Profile Section */}
        <div className="bg-card rounded-xl border border-border p-6 mb-6">
          <div className="flex items-start gap-4">
            <img
              src={ProfilePicture}
              className="w-16 h-16 rounded-xl object-cover"
              alt="Profile"
            />
            <div className="flex-1 min-w-0">
              <h3 className="text-base font-semibold text-foreground mb-2">
                {userProfile?.username || 'Account name'}
              </h3>
              {userProfile?.userId && (
                <div className="mb-2 flex items-baseline gap-2">
                  <p className="text-xs text-muted-foreground shrink-0">
                    User ID:
                  </p>
                  <UserIdDisplay
                    userId={userProfile.userId}
                    visible={showUserId}
                    onChange={setShowUserId}
                    textSize="sm"
                    textClassName="text-muted-foreground"
                    showCopy
                    showHideToggle
                  />
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Settings Options */}
        <div className="space-y-6">
          {/* Version Info */}
          <div className="bg-card rounded-xl border border-border p-4">
            <InfoRow
              label="Version"
              value={APP_VERSION}
              containerClassName="bg-transparent"
            />
            {showDebugOption && (
              <InfoRow
                label="Build ID"
                value={appBuildId || 'unknown'}
                valueClassName="text-xs text-muted-foreground font-mono"
                containerClassName="bg-transparent mt-2"
              />
            )}
          </div>

          {/* Account Actions */}
          <div className="bg-card rounded-xl border border-border overflow-hidden">
            <Button
              variant="outline"
              size="custom"
              className="w-full h-[54px] flex items-center px-4 justify-start rounded-none border-0 border-b border-border last:border-b-0"
              onClick={() => setActiveView(SettingsView.SHOW_ACCOUNT_BACKUP)}
            >
              <Copy className="mr-4" />
              <span className="text-base font-semibold flex-1 text-left">
                Account Backup
              </span>
              {mnemonicBackupInfo?.backedUp && (
                <div className="w-2 h-2 bg-success rounded-full ml-auto"></div>
              )}
            </Button>
            <Button
              variant="outline"
              size="custom"
              className="w-full h-[54px] flex items-center px-4 justify-start rounded-none border-0 border-b border-border last:border-b-0"
              onClick={() => setActiveView(SettingsView.SHARE_CONTACT)}
            >
              <SettingsIconFeather className="mr-4" />
              <span className="text-base font-semibold flex-1 text-left">
                Share Contact
              </span>
            </Button>
            <Button
              variant="outline"
              size="custom"
              className="w-full h-[54px] flex items-center px-4 justify-start rounded-none border-0"
              onClick={() => setActiveView(SettingsView.SCAN_QR_CODE)}
            >
              <Camera className="mr-4" />
              <span className="text-base font-semibold flex-1 text-left">
                Scan QR Code
              </span>
            </Button>
          </div>
          {/* Notifications Section */}
          {notificationService.isSupported() && (
            <div className="bg-card border border-border rounded-xl overflow-hidden">
              {/* Notification Toggle */}
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
              {/* Permission Status Info */}
              {notificationPrefs.permission.denied && (
                <div className="px-4 py-4">
                  <p className="text-xs text-muted-foreground">
                    Notifications are blocked. Please enable them in your
                    browser settings.
                  </p>
                </div>
              )}
            </div>
          )}
          {/* Background Sync Settings (Android only) */}
          <BackgroundSyncSettings showDebugInfo={showDebugOption} />
          {/* Theme Select */}
          <ThemeSelect
            theme={theme}
            resolvedTheme={resolvedTheme}
            onThemeChange={setTheme}
          />
          {/* Debug Options */}
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
            {showDebugOption && (
              <>
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
              </>
            )}
          </div>
          {/* Clear Cache & Database Button - Only show when version differs */}
          {isVersionDifferent && (
            <Button
              variant="outline"
              size="custom"
              className="w-full h-[54px] flex items-center px-4 justify-start rounded-xl text-destructive border-destructive hover:bg-destructive/10"
              onClick={handleForceUpdate}
            >
              <RefreshCcw className="mr-4" />
              <span className="text-base font-semibold flex-1 text-left">
                Clear Cache & Database
              </span>
            </Button>
          )}
          {/* Account Actions */}
          <div className="bg-card rounded-xl border border-border overflow-hidden">
            <Button
              variant="outline"
              size="custom"
              className="w-full h-[54px] flex items-center px-4 justify-start rounded-none border-0 border-b border-border text-foreground"
              onClick={handleLogout}
            >
              <LogOut className="mr-4" />
              <span className="text-base font-semibold flex-1 text-left">
                Logout
              </span>
            </Button>
            <Button
              variant="outline"
              size="custom"
              className="w-full h-[54px] flex items-center px-4 justify-start rounded-none border-0 text-destructive border-destructive hover:bg-destructive/10"
              onClick={() => setIsResetModalOpen(true)}
            >
              <Trash2 className="mr-4" />
              <span className="text-base font-semibold flex-1 text-left">
                Delete Account
              </span>
            </Button>
          </div>
        </div>
      </div>
      <BaseModal
        isOpen={isResetModalOpen}
        onClose={() => setIsResetModalOpen(false)}
        title="Delete account?"
      >
        <div className="space-y-4">
          <p className="text-sm text-foreground">
            This will delete all your data and cannot be undone.
          </p>
          <div className="flex gap-3">
            <Button
              onClick={async () => {
                setIsResetModalOpen(false);
                await handleResetAccount();
              }}
              variant="danger"
              size="custom"
              className="flex-1 h-11 rounded-xl font-semibold"
            >
              Delete
            </Button>
            <Button
              onClick={() => setIsResetModalOpen(false)}
              variant="secondary"
              size="custom"
              className="flex-1 h-11 rounded-xl font-semibold"
            >
              Cancel
            </Button>
          </div>
        </div>
      </BaseModal>
    </div>
  );
};

export default Settings;
