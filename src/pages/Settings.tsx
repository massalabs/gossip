import { logger } from '../utils/logger.ts';
import React, { useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import BaseModal from '../components/ui/BaseModal';
import PageLayout from '../components/ui/Layout/PageLayout';
import PageHeader from '../components/ui/PageHeader';
import { useAccountStore } from '../stores/accountStore';
import { useGossipSdk } from '../hooks/useGossipSdk';
import Button from '../components/ui/Button';
import UserIdDisplay from '../components/ui/UserIdDisplay';
import CopyClipboard from '../components/ui/CopyClipboard';
import { ROUTES } from '../constants/routes';
import {
  Lock,
  Trash2,
  X,
  Bell,
  Moon,
  Info,
  Settings as SettingsIconFeather,
  Share2,
  User,
  Edit2,
  Globe,
  Type,
  Shield,
  Clock,
  MessageSquare,
} from 'react-feather';
import { useNavigate } from 'react-router-dom';

import UserProfileAvatar from '../components/avatar/UserProfileAvatar';
import { useAppStore } from '../stores/appStore';
import { useNClicksTrigger } from '../hooks/useNClicksTrigger';
import AccountBackup from '../components/account/AccountBackup';
import ShareContact from '../components/settings/ShareContact';
import UsernameEditModal from '../components/settings/UsernameEditModal';

enum SettingsView {
  MAIN = 'MAIN',
  ACCOUNT_BACKUP = 'ACCOUNT_BACKUP',
  SHARE_CONTACT = 'SHARE_CONTACT',
}

// Debug mode unlock constants
const REQUIRED_TAPS = 7;
const TAP_TIMEOUT_MS = 2000; // Reset counter after 2 seconds of inactivity

const Settings = (): React.ReactElement => {
  const { t } = useTranslation('settings');
  const gossip = useGossipSdk();
  const {
    userProfile,
    getMnemonicBackupInfo,
    logout,
    resetAccount,
    updateUsername,
  } = useAccountStore();

  const showDebugOption = useAppStore(s => s.showDebugOption);
  const setShowDebugOption = useAppStore(s => s.setShowDebugOption);
  const mnsEnabled = useAppStore(s => s.mnsEnabled);
  const [showUserId, setShowUserId] = useState(false);
  const [isResetModalOpen, setIsResetModalOpen] = useState(false);
  const [isUsernameModalOpen, setIsUsernameModalOpen] = useState(false);
  const [activeView, setActiveView] = useState<SettingsView>(SettingsView.MAIN);
  const navigate = useNavigate();
  const mnsDomains = useAppStore(s => s.mnsDomains);

  // Debug mode unlock: N-tap gesture on profile image
  const { ping: handleProfileImageTap } = useNClicksTrigger({
    clickNumber: REQUIRED_TAPS,
    callback: () => {
      setShowDebugOption(!showDebugOption);
    },
    pingTimeout: TAP_TIMEOUT_MS,
  });

  const mnemonicBackupInfo = getMnemonicBackupInfo();

  const handleBack = useCallback(() => {
    setActiveView(SettingsView.MAIN);
  }, []);

  const handleResetAccount = useCallback(async () => {
    try {
      await resetAccount();
      navigate(ROUTES.default());
    } catch (error) {
      logger.error('Failed to reset account:', error);
    }
  }, [resetAccount, navigate]);

  const handleLockApp = async () => {
    try {
      await logout();
    } catch (error) {
      logger.error('Failed to lock app:', error);
    }
  };

  const handleUpdateUsername = useCallback(
    async (newUsername: string) => {
      try {
        await updateUsername(newUsername);
      } catch (error) {
        logger.error('Failed to update username:', error);
        throw error;
      }
    },
    [updateUsername]
  );

  if (activeView === SettingsView.ACCOUNT_BACKUP) {
    return <AccountBackup onBack={handleBack} />;
  }

  if (activeView === SettingsView.SHARE_CONTACT) {
    return (
      <ShareContact
        onBack={handleBack}
        userId={userProfile!.userId}
        userName={userProfile!.username}
        publicKey={gossip.publicKeys}
        mnsDomains={
          mnsEnabled && mnsDomains.length > 0 ? mnsDomains : undefined
        }
      />
    );
  }

  return (
    <PageLayout
      header={
        <PageHeader
          title={t('title')}
          onBack={() => navigate(ROUTES.discussions())}
        />
      }
      className="app-max-w mx-auto"
      contentClassName="px-6 py-6"
    >
      {/* Account Profile Hero — pro chat-app style */}
      <div className="bg-card rounded-2xl border border-border shadow-sm dark:shadow-none p-5 mb-6">
        <div className="flex items-center gap-4">
          <button
            type="button"
            onClick={handleProfileImageTap}
            className="shrink-0 cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded-full transition-opacity active:opacity-70"
            aria-label={t('profile')}
          >
            <UserProfileAvatar
              name={userProfile?.username ?? ''}
              size={16}
              interactive={false}
            />
          </button>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5 mb-1">
              <h2 className="text-xl font-bold text-foreground truncate">
                {userProfile?.username || t('account_name')}
              </h2>
              <button
                onClick={() => setIsUsernameModalOpen(true)}
                className="shrink-0 p-1 rounded-lg hover:bg-muted transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                aria-label={t('edit_username')}
              >
                <Edit2 className="w-3.5 h-3.5 text-muted-foreground" />
              </button>
            </div>
            {userProfile?.userId && (
              <div className="space-y-0.5">
                {mnsEnabled && mnsDomains.length > 0
                  ? mnsDomains.map(domain => (
                      <div
                        key={domain}
                        className="flex items-center gap-1.5 min-w-0"
                      >
                        <p className="text-xs font-mono text-muted-foreground truncate flex-1 min-w-0">
                          {domain}
                        </p>
                        <CopyClipboard
                          text={domain}
                          title={t('copy_mns_domain')}
                          iconSize="w-3 h-3"
                        />
                      </div>
                    ))
                  : null}
                {(!mnsEnabled || mnsDomains.length === 0) && (
                  <UserIdDisplay
                    userId={userProfile.userId}
                    visible={showUserId}
                    onChange={setShowUserId}
                    textSize="xs"
                    textClassName="text-muted-foreground font-mono"
                    showCopy
                    showHideToggle
                    prefixChars={4}
                    suffixChars={4}
                  />
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Settings Sections */}
      <div className="space-y-6">
        {/* Account Backup & Share Contact Group */}
        <div className="bg-card rounded-xl border border-border shadow-sm dark:shadow-none overflow-hidden">
          <Button
            variant="outline"
            size="custom"
            className="w-full h-[52px] flex items-center px-4 justify-start rounded-none border-0 border-b border-border/60"
            onClick={() => setActiveView(SettingsView.ACCOUNT_BACKUP)}
          >
            <User className="mr-5 w-5 h-5" />
            <span className="text-[15px] font-medium flex-1 text-left">
              {t('menu.account_backup')}
            </span>
            {mnemonicBackupInfo?.backedUp && (
              <div className="w-2 h-2 bg-success rounded-full ml-auto"></div>
            )}
          </Button>
          <Button
            variant="outline"
            size="custom"
            className="w-full h-[52px] flex items-center px-4 justify-start rounded-none border-0"
            onClick={() => setActiveView(SettingsView.SHARE_CONTACT)}
          >
            <Share2 className="mr-5 w-5 h-5" />
            <span className="text-[15px] font-medium flex-1 text-left">
              {t('menu.share_contact')}
            </span>
          </Button>
        </div>

        {/* Notifications & Appearance Group */}
        <div className="bg-card rounded-xl border border-border shadow-sm dark:shadow-none overflow-hidden">
          <Button
            variant="outline"
            size="custom"
            className="w-full h-[52px] flex items-center px-4 justify-start rounded-none border-0 border-b border-border/60"
            onClick={() => navigate(ROUTES.settingsNotifications())}
          >
            <Bell className="mr-5 w-5 h-5" />
            <span className="text-[15px] font-medium flex-1 text-left">
              {t('menu.notifications')}
            </span>
          </Button>
          <Button
            variant="outline"
            size="custom"
            className="w-full h-[52px] flex items-center px-4 justify-start rounded-none border-0 border-b border-border/60"
            onClick={() => navigate(ROUTES.settingsAppearance())}
          >
            <Moon className="mr-5 w-5 h-5" />
            <span className="text-[15px] font-medium flex-1 text-left">
              {t('menu.appearance')}
            </span>
          </Button>
          <Button
            variant="outline"
            size="custom"
            className="w-full h-[52px] flex items-center px-4 justify-start rounded-none border-0 border-b border-border/60"
            onClick={() => navigate(ROUTES.settingsLanguage())}
          >
            <Type className="mr-5 w-5 h-5" />
            <span className="text-[15px] font-medium flex-1 text-left">
              {t('menu.language')}
            </span>
          </Button>
          <Button
            variant="outline"
            size="custom"
            className="w-full h-[52px] flex items-center px-4 justify-start rounded-none border-0 border-b border-border/60"
            onClick={() => navigate(ROUTES.settingsPrivacy())}
          >
            <Shield className="mr-5 w-5 h-5" />
            <span className="text-[15px] font-medium flex-1 text-left">
              {t('menu.privacy')}
            </span>
          </Button>
          <Button
            variant="outline"
            size="custom"
            className="w-full h-[52px] flex items-center px-4 justify-start rounded-none border-0"
            onClick={() => navigate(ROUTES.settingsSecurity())}
          >
            <Clock className="mr-5 w-5 h-5" />
            <span className="text-[15px] font-medium flex-1 text-left">
              {t('menu.security')}
            </span>
          </Button>
        </div>

        {/* Web 3 Group */}
        <div className="bg-card rounded-xl border border-border shadow-sm dark:shadow-none overflow-hidden">
          <Button
            variant="outline"
            size="custom"
            className="w-full h-[52px] flex items-center px-4 justify-start rounded-none border-0"
            onClick={() => navigate(ROUTES.settingsWeb3())}
          >
            <Globe className="mr-5 w-5 h-5" />
            <span className="text-[15px] font-medium flex-1 text-left">
              {t('menu.web3')}
            </span>
          </Button>
        </div>

        {/* About & Debug Group */}
        <div className="bg-card rounded-xl border border-border shadow-sm dark:shadow-none overflow-hidden">
          <Button
            variant="outline"
            size="custom"
            className={`w-full h-[54px] flex items-center px-4 justify-start rounded-none border-0 ${
              showDebugOption ? 'border-b border-border' : ''
            }`}
            onClick={() => navigate(ROUTES.settingsAbout())}
          >
            <Info className="mr-5 w-5 h-5" />
            <span className="text-[15px] font-medium flex-1 text-left">
              {t('menu.about')}
            </span>
          </Button>
          <Button
            variant="outline"
            size="custom"
            className={`w-full h-[54px] flex items-center px-4 justify-start rounded-none border-0 border-b border-border`}
            onClick={() =>
              window.open(
                'https://cryptpad.fr/form/#/2/form/view/ZzlOcdHn5aACC2omt+QoCLoDohBgdZtWSIXjxmguPDs/embed/',
                '_blank'
              )
            }
          >
            <MessageSquare className="mr-4" />

            <span className="text-base font-semibold flex-1 text-left">
              {t('menu.feedback')}
            </span>
          </Button>

          {showDebugOption && (
            <Button
              variant="outline"
              size="custom"
              className="w-full h-[52px] flex items-center px-4 justify-start rounded-none border-0"
              onClick={() => navigate(ROUTES.settingsDebug())}
            >
              <SettingsIconFeather className="mr-5 w-5 h-5" />
              <span className="text-[15px] font-medium flex-1 text-left">
                {t('menu.debug')}
              </span>
            </Button>
          )}
        </div>

        {/* Account Actions */}
        <div className="bg-card rounded-xl border border-border shadow-sm dark:shadow-none overflow-hidden">
          <Button
            variant="outline"
            size="custom"
            className="w-full h-[54px] flex items-center px-4 justify-start rounded-none border-0 border-b border-border text-foreground"
            onClick={handleLockApp}
          >
            <Lock className="mr-5 w-5 h-5" />
            <span className="text-[15px] font-medium flex-1 text-left">
              {t('menu.lock_account')}
            </span>
          </Button>
          <Button
            variant="outline"
            size="custom"
            className="w-full h-[54px] flex items-center px-4 justify-start rounded-none border-0 text-destructive border-destructive hover:bg-destructive/10"
            onClick={() => setIsResetModalOpen(true)}
          >
            <Trash2 className="mr-5 w-5 h-5" />
            <span className="text-[15px] font-medium flex-1 text-left">
              {t('delete_account.button')}
            </span>
          </Button>
        </div>
      </div>
      <BaseModal
        isOpen={isResetModalOpen}
        onClose={() => setIsResetModalOpen(false)}
        title={t('delete_account.title')}
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
            <p className="text-sm text-foreground leading-relaxed">
              {t('delete_account.confirm')}
            </p>
            <p className="text-sm text-muted-foreground leading-relaxed">
              {t('delete_account.warning')}
            </p>
          </div>
          <div className="flex gap-3">
            <Button
              onClick={() => setIsResetModalOpen(false)}
              variant="outline"
              size="custom"
              className="flex-1 h-12 rounded-full font-medium"
            >
              {t('common:cancel')}
            </Button>
            <Button
              onClick={async () => {
                setIsResetModalOpen(false);
                await handleResetAccount();
              }}
              variant="danger"
              size="custom"
              className="flex-1 h-12 rounded-full font-medium"
            >
              {t('common:delete')}
            </Button>
          </div>
        </div>
      </BaseModal>
      {userProfile && (
        <UsernameEditModal
          isOpen={isUsernameModalOpen}
          currentUsername={userProfile.username}
          currentUserId={userProfile.userId}
          onConfirm={handleUpdateUsername}
          onClose={() => setIsUsernameModalOpen(false)}
        />
      )}
    </PageLayout>
  );
};

export default Settings;
