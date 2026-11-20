import { logger } from '../../utils/logger.ts';
import React, { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import PageLayout from '../../components/ui/Layout/PageLayout';
import PageHeader from '../../components/ui/PageHeader';
import OptionBottomSheet from '../../components/ui/OptionBottomSheet';
import { useAppStore } from '../../stores/appStore';
import { ROUTES } from '../../constants/routes';
import {
  MESSAGE_TIMER_OPTIONS,
  messageTimerLabel,
  timerToRetentionSeconds,
} from '../../constants/messageTimer';
import { useDefaultMessageTimer } from '../../hooks/useDefaultMessageTimer';

const PrivacySettings: React.FC = () => {
  const { t } = useTranslation(['settings', 'discussions', 'groups']);
  const navigate = useNavigate();
  // The default message timer of the chats this account founds (§7.7),
  // stored in seconds; the earlier "1 month" reads as 28 days.
  const defaultTimer = useDefaultMessageTimer();
  const setDefaultRetentionDuration = useAppStore(
    s => s.setDefaultRetentionDuration
  );

  const [isRetentionModalOpen, setIsRetentionModalOpen] = useState(false);

  const handleRetentionChange = async (timer: number) => {
    try {
      await setDefaultRetentionDuration(timerToRetentionSeconds(timer));
      setIsRetentionModalOpen(false);
    } catch (error) {
      logger.error('Failed to persist default retention setting:', error);
    }
  };

  const retentionLabel = useMemo(
    () => messageTimerLabel(defaultTimer, t),
    [defaultTimer, t]
  );

  return (
    <PageLayout
      header={
        <PageHeader
          title={t('privacy.title')}
          onBack={() => navigate(ROUTES.settings())}
        />
      }
      className="app-max-w mx-auto"
      contentClassName="px-6 py-6 space-y-6"
    >
      <div className="bg-card border border-border rounded-xl overflow-hidden">
        <div className="px-4 pt-4 pb-2">
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
            {t('privacy.default_retention_title')}
          </p>
        </div>
        <div className="px-4 pb-3">
          <p className="text-sm text-muted-foreground">
            {t('privacy.default_retention_description')}
          </p>
        </div>
        <button
          onClick={() => setIsRetentionModalOpen(true)}
          className="w-full flex items-center justify-between text-sm font-medium text-foreground hover:bg-muted px-4 py-3 transition-colors border-t border-border"
        >
          <span>{t('discussions:settings.auto_delete_current')}</span>
          <span
            className="text-accent-soft-foreground"
            data-testid="default-timer-value"
          >
            {retentionLabel}
          </span>
        </button>
      </div>

      <OptionBottomSheet
        isOpen={isRetentionModalOpen}
        title={t('privacy.default_retention_title')}
        options={MESSAGE_TIMER_OPTIONS.map(ms => ({
          label: messageTimerLabel(ms, t),
          value: ms,
        }))}
        selectedValue={defaultTimer}
        onSelect={value => void handleRetentionChange(value ?? 0)}
        onClose={() => setIsRetentionModalOpen(false)}
      />
    </PageLayout>
  );
};

export default PrivacySettings;
