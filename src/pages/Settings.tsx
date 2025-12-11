import React, { useState, useCallback, useRef, useEffect } from 'react';
import BaseModal from '../components/ui/BaseModal';
import HeaderWrapper from '../components/ui/HeaderWrapper';
import PageHeader from '../components/ui/PageHeader';
import ScrollableContent from '../components/ui/ScrollableContent';
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

// Debug mode unlock constants
const REQUIRED_TAPS = 7;
const TAP_TIMEOUT_MS = 2000; // Reset counter after 2 seconds of inactivity

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

  // Debug mode unlock: 7-tap gesture on profile image
  const [tapCount, setTapCount] = useState(0);
  const tapTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showDebugOptionRef = useRef(showDebugOption);

  // Keep ref in sync with state
  useEffect(() => {
    showDebugOptionRef.current = showDebugOption;
  }, [showDebugOption]);

  // Reset tap counter after timeout
  useEffect(() => {
    if (tapCount > 0) {
      if (tapTimeoutRef.current) {
        clearTimeout(tapTimeoutRef.current);
      }
      tapTimeoutRef.current = setTimeout(() => {
        setTapCount(0);
      }, TAP_TIMEOUT_MS);
    }

    return () => {
      if (tapTimeoutRef.current) {
        clearTimeout(tapTimeoutRef.current);
      }
    };
  }, [tapCount]);

  // Handle profile image tap for debug mode unlock
  const handleProfileImageTap = useCallback(() => {
    setTapCount(prevCount => {
      const newTapCount = prevCount + 1;

      if (newTapCount >= REQUIRED_TAPS) {
        // Toggle debug mode using ref to avoid closure dependency
        setShowDebugOption(!showDebugOptionRef.current);
        if (tapTimeoutRef.current) {
          clearTimeout(tapTimeoutRef.current);
        }
        return 0; // Reset counter
      }

      return newTapCount;
    });
  }, [setShowDebugOption]);

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
    <div className="h-full flex flex-col bg-background app-max-w mx-auto">
      {/* Header */}
      <HeaderWrapper>
        <PageHeader title="Settings" />
      </HeaderWrapper>
      {/* Main Content */}
      <ScrollableContent className="flex-1 overflow-y-auto px-6 py-6">
        {/* Account Profile Section */}
        <div className="bg-card rounded-xl border border-border p-6 mb-6">
          <div className="flex items-start gap-4">
            <button
              onClick={handleProfileImageTap}
              className="cursor-pointer focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 rounded-full transition-opacity active:opacity-70"
              aria-label="Profile"
            >
              <img
                src={ProfilePicture}
                className="w-16 h-16 rounded-full object-cover"
                alt="Profile"
              />
            </button>
            <div className="flex-1 min-w-0">
              <div className="mb-2 flex items-baseline gap-2">
                <p className="text-xs text-muted-foreground shrink-0">Name:</p>
                <h3 className="text-base font-semibold text-foreground truncate">
                  {userProfile?.username || 'Account name'}
                </h3>
              </div>
              {userProfile?.userId && (
                <div className="flex items-center gap-2 min-w-0">
                  <p className="text-xs text-muted-foreground shrink-0">
                    User ID:
                  </p>
                  <div className="flex-1 min-w-0">
                    <UserIdDisplay
                      userId={userProfile.userId}
                      visible={showUserId}
                      onChange={setShowUserId}
                      textSize="sm"
                      textClassName="text-muted-foreground"
                      showCopy
                      showHideToggle
                      className="w-full"
                      prefixChars={3}
                      suffixChars={3}
                    />
                  </div>
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

          {showDebugOption && (
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
          )}

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
      </ScrollableContent>
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
