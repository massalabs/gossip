import React, { useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import PageLayout from '../../components/ui/PageLayout';
import PageHeader from '../../components/ui/PageHeader';
import Button from '../../components/ui/Button';
import Toggle from '../../components/ui/Toggle';
import { useAppStore } from '../../stores/appStore';
import { gossipDb } from '@massalabs/gossip-sdk';
import { clearAppStorage } from '../../utils/localStorage';
import { useAccountStore } from '../../stores/accountStore';
import { useVersionCheck } from '../../hooks/useVersionCheck';
import { ROUTES } from '../../constants/routes';
import {
  AlertTriangle,
  Settings as SettingsIconFeather,
  Terminal,
} from 'react-feather';

const DebugSettings: React.FC = () => {
  const navigate = useNavigate();
  const showDebugOption = useAppStore(s => s.showDebugOption);
  const setShowDebugOption = useAppStore(s => s.setShowDebugOption);
  const debugOverlayVisible = useAppStore(s => s.debugOverlayVisible);
  const setDebugOverlayVisible = useAppStore(s => s.setDebugOverlayVisible);
  const disableNativeScreenshot = useAppStore(s => s.disableNativeScreenshot);
  const setDisableNativeScreenshot = useAppStore(
    s => s.setDisableNativeScreenshot
  );
  const { resetAccount } = useAccountStore();
  const { isVersionDifferent, handleForceUpdate } = useVersionCheck();

  const handleBack = () => {
    navigate(ROUTES.settings());
  };

  const handleResetAllAccounts = useCallback(async () => {
    try {
      await resetAccount();
      clearAppStorage();
      await gossipDb().deleteDb();
      window.location.reload();
    } catch (error) {
      console.error('Failed to reset all accounts:', error);
    }
  }, [resetAccount]);

  const handleResetAllDiscussionsAndMessages = useCallback(async () => {
    try {
      const db = gossipDb();
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

  return (
    <PageLayout
      header={<PageHeader title="Debug" onBack={handleBack} />}
      className="app-max-w mx-auto"
      contentClassName="px-6 py-6"
    >
      <div className="space-y-6">
        <div className="bg-card rounded-xl border border-border overflow-hidden">
          <div className="h-[54px] flex items-center px-4 justify-between border-b border-border">
            <div className="flex items-center flex-1">
              <SettingsIconFeather className="text-foreground mr-4" />
              <span className="text-base font-medium text-foreground flex-1 text-left">
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
              <div className="h-[54px] flex items-center px-4 justify-between border-b border-border">
                <div className="flex items-center flex-1">
                  <Terminal className="text-foreground mr-4" size={20} />
                  <span className="text-base font-medium text-foreground flex-1 text-left">
                    Show Console Button
                  </span>
                </div>
                <Toggle
                  checked={debugOverlayVisible}
                  onChange={setDebugOverlayVisible}
                  ariaLabel="Show console button"
                />
              </div>
              <div className="h-[54px] flex items-center px-4 justify-between border-b border-border">
                <div className="flex items-center flex-1">
                  <SettingsIconFeather className="text-foreground mr-4" />
                  <span className="text-base font-medium text-foreground flex-1 text-left">
                    Disable screenshot protection
                  </span>
                </div>
                <Toggle
                  checked={disableNativeScreenshot}
                  onChange={setDisableNativeScreenshot}
                  ariaLabel="Disable screenshot protection"
                />
              </div>
            </>
          )}
          <Button
            variant="outline"
            size="custom"
            className="w-full h-[54px] flex items-center px-4 justify-start rounded-none border-0 border-b border-border"
            onClick={handleResetAllAccounts}
          >
            <AlertTriangle className="mr-4" />
            <span className="text-base font-medium flex-1 text-left">
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
            <span className="text-base font-medium flex-1 text-left">
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
            <span className="text-base font-medium flex-1 text-left">
              Clear Cache & Database
            </span>
          </Button>
        )}
      </div>
    </PageLayout>
  );
};

export default DebugSettings;
