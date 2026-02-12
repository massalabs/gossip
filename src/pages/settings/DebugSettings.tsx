import React, { useCallback, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import PageLayout from '../../components/ui/PageLayout';
import PageHeader from '../../components/ui/PageHeader';
import Button from '../../components/ui/Button';
import Toggle from '../../components/ui/Toggle';
import { useAppStore } from '../../stores/appStore';
import { getSdk } from '../../stores/sdkStore';
import { clearAppStorage } from '../../utils/localStorage';
import { useAccountStore } from '../../stores/accountStore';
import { useVersionCheck } from '../../hooks/useVersionCheck';
import { ROUTES } from '../../constants/routes';
import {
  AlertTriangle,
  Settings as SettingsIconFeather,
  Database,
  Loader,
  Terminal,
} from 'react-feather';
import {
  seedTestData,
  clearTestData,
  SeedResult,
} from '../../utils/seedTestData';

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
  const { resetAccount, userProfile } = useAccountStore();
  const { isVersionDifferent, handleForceUpdate } = useVersionCheck();

  const [isSeeding, setIsSeeding] = useState(false);
  const [seedResult, setSeedResult] = useState<SeedResult | null>(null);

  const handleBack = () => {
    navigate(ROUTES.settings());
  };

  const handleResetAllAccounts = useCallback(async () => {
    try {
      await resetAccount();
      clearAppStorage();
      await getSdk().db.deleteDb();
      window.location.reload();
    } catch (error) {
      console.error('Failed to reset all accounts:', error);
    }
  }, [resetAccount]);

  const handleResetAllDiscussionsAndMessages = useCallback(async () => {
    try {
      const db = getSdk().db;
      await db.transaction(
        'rw',
        [db.contacts, db.messages, db.discussions],
        async () => {
          await db.messages.clear();
          await db.discussions.clear();
          await db.contacts.clear();
        }
      );
      setSeedResult(null);
    } catch (error) {
      console.error('Failed to reset discussions and messages:', error);
    }
  }, []);

  const handleSeedSmall = useCallback(async () => {
    if (!userProfile?.userId || isSeeding) return;
    setIsSeeding(true);
    setSeedResult(null);
    try {
      const result = await seedTestData(userProfile.userId, {
        discussionCount: 10,
        minMessagesPerDiscussion: 5,
        maxMessagesPerDiscussion: 20,
      });
      setSeedResult(result);
    } catch (error) {
      console.error('Failed to seed small dataset:', error);
    } finally {
      setIsSeeding(false);
    }
  }, [userProfile?.userId, isSeeding]);

  const handleSeedMedium = useCallback(async () => {
    if (!userProfile?.userId || isSeeding) return;
    setIsSeeding(true);
    setSeedResult(null);
    try {
      const result = await seedTestData(userProfile.userId, {
        discussionCount: 50,
        minMessagesPerDiscussion: 20,
        maxMessagesPerDiscussion: 100,
      });
      setSeedResult(result);
    } catch (error) {
      console.error('Failed to seed medium dataset:', error);
    } finally {
      setIsSeeding(false);
    }
  }, [userProfile?.userId, isSeeding]);

  const handleSeedLarge = useCallback(async () => {
    if (!userProfile?.userId || isSeeding) return;
    setIsSeeding(true);
    setSeedResult(null);
    try {
      const result = await seedTestData(userProfile.userId, {
        discussionCount: 200,
        minMessagesPerDiscussion: 50,
        maxMessagesPerDiscussion: 500,
      });
      setSeedResult(result);
    } catch (error) {
      console.error('Failed to seed large dataset:', error);
    } finally {
      setIsSeeding(false);
    }
  }, [userProfile?.userId, isSeeding]);

  const [clearCount, setClearCount] = useState<number | null>(null);

  const handleClearTestData = useCallback(async () => {
    if (!userProfile?.userId) return;
    try {
      const count = await clearTestData(userProfile.userId);
      setClearCount(count);
      setSeedResult(null);
      // Auto-hide the message after 3 seconds
      setTimeout(() => setClearCount(null), 3000);
    } catch (error) {
      console.error('Failed to clear test data:', error);
    }
  }, [userProfile?.userId]);

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

        {/* Test Data Seeding Section */}
        <div className="bg-card rounded-xl border border-border overflow-hidden">
          <div className="h-[54px] flex items-center px-4 border-b border-border">
            <Database className="text-foreground mr-4" size={20} />
            <span className="text-base font-medium text-foreground">
              Generate Test Data
            </span>
          </div>

          <div className="p-4 space-y-3">
            <p className="text-sm text-muted-foreground">
              Generate fake discussions and messages to test app performance.
            </p>

            <div className="grid grid-cols-3 gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={handleSeedSmall}
                disabled={isSeeding}
                className="flex items-center justify-center gap-1"
              >
                {isSeeding ? (
                  <Loader className="animate-spin" size={14} />
                ) : null}
                Small
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={handleSeedMedium}
                disabled={isSeeding}
                className="flex items-center justify-center gap-1"
              >
                {isSeeding ? (
                  <Loader className="animate-spin" size={14} />
                ) : null}
                Medium
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={handleSeedLarge}
                disabled={isSeeding}
                className="flex items-center justify-center gap-1"
              >
                {isSeeding ? (
                  <Loader className="animate-spin" size={14} />
                ) : null}
                Large
              </Button>
            </div>

            <div className="text-xs text-muted-foreground space-y-1">
              <p>• Small: 10 discussions, 5-20 messages each</p>
              <p>• Medium: 50 discussions, 20-100 messages each</p>
              <p>• Large: 200 discussions, 50-500 messages each</p>
            </div>

            {seedResult && (
              <div className="mt-3 p-3 bg-success/10 border border-success/20 rounded-lg">
                <p className="text-sm text-success font-medium">
                  ✓ Data generated successfully!
                </p>
                <p className="text-xs text-muted-foreground mt-1">
                  {seedResult.contactsCreated} contacts,{' '}
                  {seedResult.discussionsCreated} discussions,{' '}
                  {seedResult.messagesCreated.toLocaleString()} messages
                </p>
                <p className="text-xs text-muted-foreground">
                  Duration: {(seedResult.duration / 1000).toFixed(2)}s
                </p>
              </div>
            )}

            {clearCount !== null && (
              <div className="p-3 bg-muted border border-border rounded-lg">
                <p className="text-sm text-muted-foreground">
                  ✓ Cleared {clearCount} test conversation
                  {clearCount !== 1 ? 's' : ''}
                </p>
              </div>
            )}

            <Button
              variant="ghost"
              size="sm"
              onClick={handleClearTestData}
              className="w-full text-destructive hover:text-destructive hover:bg-destructive/10"
            >
              Clear Test Data Only
            </Button>
            <p className="text-xs text-muted-foreground text-center">
              Only removes contacts with [TEST] prefix
            </p>
          </div>
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
