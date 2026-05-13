import { logger } from '../../utils/logger.ts';
import React, { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import PageLayout from '../../components/ui/Layout/PageLayout';
import PageHeader from '../../components/ui/PageHeader';
import Button from '../../components/ui/Button';
import Toggle from '../../components/ui/Toggle';
import { useAppStore } from '../../stores/appStore';
import { useGossipSdk } from '../../hooks/useGossipSdk';
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
  const { t } = useTranslation('settings');
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
  const gossip = useGossipSdk();

  const handleBack = () => {
    navigate(ROUTES.settings());
  };

  const handleResetAllAccounts = useCallback(async () => {
    try {
      await resetAccount();
      clearAppStorage();
      try {
        await gossip.clearAllTables();
        await gossip.destroy();
      } catch {
        // SQLite might not be initialized
      }
      window.location.reload();
    } catch (error) {
      logger.error('Failed to reset all accounts:', error);
    }
  }, [resetAccount, gossip]);

  const handleResetAllDiscussionsAndMessages = useCallback(async () => {
    try {
      await gossip.clearConversationTables();
    } catch (error) {
      logger.error('Failed to reset discussions and messages:', error);
    }
  }, [gossip]);

  return (
    <PageLayout
      header={<PageHeader title={t('debug.title')} onBack={handleBack} />}
      className="app-max-w mx-auto"
      contentClassName="px-6 py-6"
    >
      <div className="space-y-6">
        <div className="bg-card rounded-xl border border-border overflow-hidden">
          <div className="h-[54px] flex items-center px-4 justify-between border-b border-border">
            <div className="flex items-center flex-1">
              <SettingsIconFeather className="text-foreground mr-4" />
              <span className="text-base font-medium text-foreground flex-1 text-left">
                {t('debug.show_debug')}
              </span>
            </div>
            <Toggle
              checked={showDebugOption}
              onChange={setShowDebugOption}
              ariaLabel={t('debug.show_debug')}
            />
          </div>
          {showDebugOption && (
            <>
              <div className="h-[54px] flex items-center px-4 justify-between border-b border-border">
                <div className="flex items-center flex-1">
                  <Terminal className="text-foreground mr-4" size={20} />
                  <span className="text-base font-medium text-foreground flex-1 text-left">
                    {t('debug.show_console')}
                  </span>
                </div>
                <Toggle
                  checked={debugOverlayVisible}
                  onChange={setDebugOverlayVisible}
                  ariaLabel={t('debug.show_console')}
                />
              </div>
              <div className="h-[54px] flex items-center px-4 justify-between border-b border-border">
                <div className="flex items-center flex-1">
                  <SettingsIconFeather className="text-foreground mr-4" />
                  <span className="text-base font-medium text-foreground flex-1 text-left">
                    {t('debug.disable_screenshot')}
                  </span>
                </div>
                <Toggle
                  checked={disableNativeScreenshot}
                  onChange={setDisableNativeScreenshot}
                  ariaLabel={t('debug.disable_screenshot')}
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
              {t('debug.reset_app')}
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
              {t('debug.clear_messages')}
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
              {t('debug.clear_cache')}
            </span>
          </Button>
        )}
      </div>
    </PageLayout>
  );
};

export default DebugSettings;
