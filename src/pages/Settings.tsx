import React, { useState, useCallback } from 'react';
import BaseModal from '../components/ui/BaseModal';
import PageHeader from '../components/ui/PageHeader';
import { useAccountStore } from '../stores/accountStore';
import { useAppStore } from '../stores/appStore';
import { useTheme } from '../hooks/useTheme';
import { formatUserId } from '../utils/userId';
import appLogo from '../assets/gossip_face.svg';
import AccountBackup from '../components/account/AccountBackup';
import Button from '../components/ui/Button';
import Toggle from '../components/ui/Toggle';
import InfoRow from '../components/ui/InfoRow';
import CopyClipboard from '../components/ui/CopyClipboard';
import { db } from '../db';
import { useVersionCheck } from '../hooks/useVersionCheck';
import { STORAGE_KEYS, clearAppStorage } from '../utils/localStorage';
import {
  DangerIcon,
  AccountBackupIcon,
  ShareContactIcon,
  DarkModeIcon,
  LightModeIcon,
  DebugIcon,
  RefreshIcon,
  LogoutIcon,
  DeleteIcon,
  CameraIcon,
} from '../components/ui/icons';
import { APP_VERSION } from '../config/version';
import { useLocalStorage } from '../hooks/useLocalStorage';
import { useNavigate } from 'react-router-dom';
import ShareContact from '../components/settings/ShareContact';
import ScanQRCode from '../components/settings/ScanQRCode';
import { usePreloadShareContact } from '../hooks/usePreloadShareContact';

enum SettingsView {
  SHOW_ACCOUNT_BACKUP = 'SHOW_ACCOUNT_BACKUP',
  SHARE_CONTACT = 'SHARE_CONTACT',
  SCAN_QR_CODE = 'SCAN_QR_CODE',
}

const Settings = (): React.ReactElement => {
  const { userProfile, getMnemonicBackupInfo, logout, resetAccount } =
    useAccountStore();
  const [appBuildId] = useLocalStorage(STORAGE_KEYS.APP_BUILD_ID, null);
  const showDebugOption = useAppStore(s => s.showDebugOption);
  const setShowDebugOption = useAppStore(s => s.setShowDebugOption);
  const { setTheme, resolvedTheme } = useTheme();
  const [activeView, setActiveView] = useState<SettingsView | null>(null);
  const [isResetModalOpen, setIsResetModalOpen] = useState(false);
  const { isVersionDifferent, handleForceUpdate } = useVersionCheck();
  const navigate = useNavigate();
  const pregeneratedQR = usePreloadShareContact(
    userProfile?.userId,
    userProfile?.username
  );

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
      navigate('/');
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

  switch (activeView) {
    case SettingsView.SHOW_ACCOUNT_BACKUP:
      return <AccountBackup onBack={() => setActiveView(null)} />;
    case SettingsView.SHARE_CONTACT:
      return (
        <ShareContact
          onBack={() => setActiveView(null)}
          pregeneratedQR={pregeneratedQR || ''}
        />
      );
    case SettingsView.SCAN_QR_CODE:
      return (
        <ScanQRCode
          onBack={() => setActiveView(null)}
          onScanSuccess={(userId, name) => {
            setActiveView(null);
            navigate(
              `/new-contact?userId=${encodeURIComponent(userId)}${name ? `&name=${encodeURIComponent(name)}` : ''}`
            );
          }}
        />
      );
    default:
      break;
  }

  return (
    <div className="bg-card h-full overflow-auto">
      <div className="h-full">
        {/* Header */}
        <PageHeader title="Settings" />
        {/* Account Profile Section */}

        <div className="bg-white dark:bg-gray-800 rounded-lg p-6 mt-4">
          <div className="flex items-start gap-4 mb-4">
            <img
              src={appLogo}
              className="w-16 h-16 rounded-lg object-cover"
              alt="Profile"
            />
            <div className="flex-1 min-w-0">
              <h3 className="text-base font-semibold text-black dark:text-white mb-2">
                {userProfile?.username || 'Account name'}
              </h3>
              {userProfile?.userId && (
                <div className="mb-2 flex items-baseline gap-2">
                  <p className="text-xs text-gray-500 dark:text-gray-400 shrink-0">
                    User ID:
                  </p>
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-medium text-gray-600 dark:text-gray-400 truncate">
                      {formatUserId(userProfile.userId, 5, 3)}
                    </p>
                    <CopyClipboard
                      text={userProfile.userId}
                      title="Copy user ID"
                    />
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Settings Options */}
        <div className="px-4 space-y-2 pb-20">
          <div className="py-2">
            <InfoRow label="Version" value={APP_VERSION} />
            {showDebugOption && (
              <InfoRow
                label="Build ID"
                value={appBuildId || 'unknown'}
                valueClassName="text-xs text-muted-foreground font-mono"
              />
            )}
          </div>
          {/* Account Backup Button */}
          <Button
            variant="outline"
            size="custom"
            className="w-full h-[54px] flex items-center px-4 justify-start rounded-lg"
            onClick={() => setActiveView(SettingsView.SHOW_ACCOUNT_BACKUP)}
          >
            <AccountBackupIcon className="mr-4" />
            <span className="text-base font-semibold flex-1 text-left">
              Account Backup
            </span>
            {mnemonicBackupInfo?.backedUp && (
              <div className="w-2 h-2 bg-success rounded-full ml-auto"></div>
            )}
          </Button>
          {/* Share Contact Button */}
          <Button
            variant="outline"
            size="custom"
            className="w-full h-[54px] flex items-center px-4 justify-start rounded-lg"
            onClick={() => setActiveView(SettingsView.SHARE_CONTACT)}
          >
            <ShareContactIcon className="mr-4" />
            <span className="text-base font-semibold flex-1 text-left">
              Share Contact
            </span>
          </Button>
          {/* Scan QR Code Button */}
          <Button
            variant="outline"
            size="custom"
            className="w-full h-[54px] flex items-center px-4 justify-start rounded-lg"
            onClick={() => setActiveView(SettingsView.SCAN_QR_CODE)}
          >
            <CameraIcon className="mr-4" />
            <span className="text-base font-semibold flex-1 text-left">
              Scan QR Code
            </span>
          </Button>
          {/* Security Button */}
          {/* <Button
            variant="outline"
            size="custom"
            className="w-full h-[54px] flex items-center px-4 justify-start rounded-lg"
            onClick={() => {}}
            disabled
          >
            <SecurityIcon className="mr-4" />
            <span className="text-base font-semibold flex-1 text-left">
              Security
            </span>
          </Button> */}
          {/* Notifications Button */}
          {/* <Button
            variant="outline"
            size="custom"
            className="w-full h-[54px] flex items-center px-4 justify-start rounded-lg"
            onClick={() => {}}
            disabled
          >
            <NotificationsIcon className="mr-4" />
            <span className="text-base font-semibold flex-1 text-left">
              Notifications
            </span>
          </Button> */}
          {/* Privacy Button */}
          {/* <Button
            variant="outline"
            size="custom"
            className="w-full h-[54px] flex items-center px-4 justify-start rounded-lg"
            onClick={() => {}}
            disabled
          >
            <PrivacyIcon className="mr-4" />
            <span className="text-base font-semibold flex-1 text-left">
              Privacy
            </span>
          </Button> */}
          {/* Theme Toggle */}
          <div className="bg-card border border-border rounded-lg h-[54px] flex items-center px-4 justify-start w-full shadow-sm">
            {resolvedTheme === 'dark' ? (
              <DarkModeIcon className="text-foreground mr-4" />
            ) : (
              <LightModeIcon className="text-foreground mr-4" />
            )}
            <span className="text-base font-semibold text-foreground flex-1 text-left">
              {resolvedTheme === 'dark' ? 'Dark Mode' : 'Light Mode'}
            </span>
            <Toggle
              checked={resolvedTheme === 'dark'}
              onChange={checked => setTheme(checked ? 'dark' : 'light')}
              ariaLabel="Toggle theme"
            />
          </div>
          {/* Debug Options Toggle */}
          <div className="bg-card border border-border rounded-lg h-[54px] flex items-center px-4 justify-start w-full shadow-sm">
            <DebugIcon className="text-foreground mr-4" />
            <span className="text-base font-semibold text-foreground flex-1 text-left">
              Show Debug Options
            </span>
            <Toggle
              checked={showDebugOption}
              onChange={setShowDebugOption}
              ariaLabel="Show debug options"
            />
          </div>
          {/* Debug Options - Only show when showDebugOption is true */}
          {showDebugOption && (
            <div className="space-y-2 pl-10">
              <Button
                variant="outline"
                className="w-full"
                onClick={handleResetAllAccounts}
              >
                <DangerIcon className="mr-4" />
                <span className="text-base font-semibold flex-1 text-left">
                  Reset App
                </span>
              </Button>
              <Button
                variant="outline"
                className="w-full"
                onClick={handleResetAllDiscussionsAndMessages}
              >
                <DangerIcon className="mr-4" />
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
              className="w-full h-[54px] flex items-center px-4 justify-start rounded-lg text-destructive border-destructive hover:bg-destructive/10"
              onClick={handleForceUpdate}
            >
              <RefreshIcon className="mr-4" />
              <span className="text-base font-semibold flex-1 text-left">
                Clear Cache & Database
              </span>
            </Button>
          )}
          {/* Logout Button */}
          <Button
            variant="outline"
            size="custom"
            className="w-full h-[54px] flex items-center px-4 justify-start rounded-lg text-foreground border-border hover:bg-muted"
            onClick={handleLogout}
          >
            <LogoutIcon className="mr-4" />
            <span className="text-base font-semibold flex-1 text-left">
              Logout
            </span>
          </Button>
          {/* Reset Account Button */}
          <Button
            variant="outline"
            size="custom"
            className="w-full h-[54px] flex items-center px-4 justify-start rounded-lg text-red-500 dark:text-red-400 border-red-200 dark:border-red-800 hover:bg-red-50 dark:hover:bg-red-900/20"
            onClick={() => setIsResetModalOpen(true)}
          >
            <DeleteIcon className="mr-4" />
            <span className="text-base font-semibold flex-1 text-left">
              Delete Account
            </span>
          </Button>
        </div>
      </div>
      <BaseModal
        isOpen={isResetModalOpen}
        onClose={() => setIsResetModalOpen(false)}
        title="Delete account?"
      >
        <div className="space-y-4">
          <p className="text-sm text-gray-700 dark:text-gray-300">
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
              className="flex-1 h-11 rounded-lg font-semibold"
            >
              Delete
            </Button>
            <Button
              onClick={() => setIsResetModalOpen(false)}
              variant="secondary"
              size="custom"
              className="flex-1 h-11 rounded-lg bg-gray-100 dark:bg-gray-700 text-gray-900 dark:text-white font-semibold"
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
