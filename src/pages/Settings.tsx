import React, { useState, useCallback, useRef, useEffect } from 'react';
import BaseModal from '../components/ui/BaseModal';
import HeaderWrapper from '../components/ui/HeaderWrapper';
import PageHeader from '../components/ui/PageHeader';
import ScrollableContent from '../components/ui/ScrollableContent';
import { useAccountStore } from '../stores/accountStore';
import Button from '../components/ui/Button';
import UserIdDisplay from '../components/ui/UserIdDisplay';
import AccountBackup from '../components/account/AccountBackup';
import ShareContact from '../components/settings/ShareContact';
import { ROUTES } from '../constants/routes';
import {
  LogOut,
  Trash2,
  X,
  Bell,
  Moon,
  Info,
  Settings as SettingsIconFeather,
  User,
} from 'react-feather';
import { useNavigate } from 'react-router-dom';

import ProfilePicture from '../assets/gossip_face.svg';
import { useAppStore } from '../stores/appStore';

enum SettingsView {
  MAIN = 'MAIN',
  ACCOUNT_BACKUP = 'ACCOUNT_BACKUP',
  SHARE_CONTACT = 'SHARE_CONTACT',
}

// Debug mode unlock constants
const REQUIRED_TAPS = 7;
const TAP_TIMEOUT_MS = 2000; // Reset counter after 2 seconds of inactivity

const Settings = (): React.ReactElement => {
  const { userProfile, getMnemonicBackupInfo, logout, resetAccount, ourPk } =
    useAccountStore();
  const showDebugOption = useAppStore(s => s.showDebugOption);
  const setShowDebugOption = useAppStore(s => s.setShowDebugOption);
  const [showUserId, setShowUserId] = useState(false);
  const [isResetModalOpen, setIsResetModalOpen] = useState(false);
  const [activeView, setActiveView] = useState<SettingsView>(SettingsView.MAIN);
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

  const mnemonicBackupInfo = getMnemonicBackupInfo();

  const handleBack = useCallback(() => {
    setActiveView(SettingsView.MAIN);
  }, []);

  const handleResetAccount = useCallback(async () => {
    try {
      await resetAccount();
      navigate(ROUTES.default());
    } catch (error) {
      console.error('Failed to reset account:', error);
    }
  }, [resetAccount, navigate]);

  const handleLogout = async () => {
    try {
      await logout();
    } catch (error) {
      console.error('Failed to logout:', error);
    }
  };

  if (activeView === SettingsView.ACCOUNT_BACKUP) {
    return <AccountBackup onBack={handleBack} />;
  }

  if (activeView === SettingsView.SHARE_CONTACT) {
    return (
      <ShareContact
        onBack={handleBack}
        userId={userProfile!.userId}
        userName={userProfile!.username}
        publicKey={ourPk!}
      />
    );
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

        {/* Settings Sections */}
        <div className="space-y-6">
          {/* Account Backup & Share Contact Group */}
          <div className="bg-card rounded-xl border border-border overflow-hidden">
            <Button
              variant="outline"
              size="custom"
              className="w-full h-[54px] flex items-center px-4 justify-start rounded-none border-0 border-b border-border"
              onClick={() => setActiveView(SettingsView.ACCOUNT_BACKUP)}
            >
              <User className="mr-4" />
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
              className="w-full h-[54px] flex items-center px-4 justify-start rounded-none border-0"
              onClick={() => setActiveView(SettingsView.SHARE_CONTACT)}
            >
              <SettingsIconFeather className="mr-4" />
              <span className="text-base font-semibold flex-1 text-left">
                Share Contact
              </span>
            </Button>
          </div>

          {/* Security Section - Commented out as there is nothing inside for now */}
          {/* <div className="bg-card rounded-xl border border-border overflow-hidden">
            <Button
              variant="outline"
              size="custom"
              className="w-full h-[54px] flex items-center px-4 justify-start rounded-none border-0"
              onClick={() => navigate(ROUTES.settingsSecurity())}
            >
              <Shield className="mr-4" />
              <span className="text-base font-semibold flex-1 text-left">
                Security
              </span>
            </Button>
          </div> */}

          {/* Notifications & Appearance Group */}
          <div className="bg-card rounded-xl border border-border overflow-hidden">
            <Button
              variant="outline"
              size="custom"
              className="w-full h-[54px] flex items-center px-4 justify-start rounded-none border-0 border-b border-border"
              onClick={() => navigate(ROUTES.settingsNotifications())}
            >
              <Bell className="mr-4" />
              <span className="text-base font-semibold flex-1 text-left">
                Notifications
              </span>
            </Button>
            <Button
              variant="outline"
              size="custom"
              className="w-full h-[54px] flex items-center px-4 justify-start rounded-none border-0"
              onClick={() => navigate(ROUTES.settingsAppearance())}
            >
              <Moon className="mr-4" />
              <span className="text-base font-semibold flex-1 text-left">
                Appearance
              </span>
            </Button>
          </div>

          {/* About & Debug Group */}
          <div className="bg-card rounded-xl border border-border overflow-hidden">
            <Button
              variant="outline"
              size="custom"
              className={`w-full h-[54px] flex items-center px-4 justify-start rounded-none border-0 ${
                showDebugOption ? 'border-b border-border' : ''
              }`}
              onClick={() => navigate(ROUTES.settingsAbout())}
            >
              <Info className="mr-4" />
              <span className="text-base font-semibold flex-1 text-left">
                About
              </span>
            </Button>
            {showDebugOption && (
              <Button
                variant="outline"
                size="custom"
                className="w-full h-[54px] flex items-center px-4 justify-start rounded-none border-0"
                onClick={() => navigate(ROUTES.settingsDebug())}
              >
                <SettingsIconFeather className="mr-4" />
                <span className="text-base font-semibold flex-1 text-left">
                  Debug
                </span>
              </Button>
            )}
          </div>

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
        title="Delete account"
      >
        <div className="space-y-6">
          <div className="flex flex-col items-center mb-4">
            <div className="w-20 h-20 rounded-full flex items-center justify-center mb-4 bg-high-danger-red/5 border border-high-danger-red">
              <X
                className="w-10 h-10"
                style={{ color: 'var(--high-danger-red)' }}
              />
            </div>
          </div>
          <div className="space-y-2 text-center">
            <p className="text-sm text-foreground">
              Are you sure you want to delete this account?
            </p>
            <p className="text-sm text-muted-foreground">
              This action cannot be undone
            </p>
          </div>
          <div className="flex gap-3">
            <Button
              onClick={() => setIsResetModalOpen(false)}
              variant="outline"
              size="custom"
              className="flex-1 h-12 rounded-full font-medium"
            >
              Cancel
            </Button>
            <button
              onClick={async () => {
                setIsResetModalOpen(false);
                await handleResetAccount();
              }}
              className="flex-1 h-12 rounded-full font-medium text-white hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed"
              style={{ backgroundColor: 'var(--high-danger-red)' }}
            >
              Delete
            </button>
          </div>
        </div>
      </BaseModal>
    </div>
  );
};

export default Settings;
