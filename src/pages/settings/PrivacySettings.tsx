import { logger } from '../../utils/logger.ts';
import React, { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import PageLayout from '../../components/ui/Layout/PageLayout';
import PageHeader from '../../components/ui/PageHeader';
import OptionBottomSheet from '../../components/ui/OptionBottomSheet';
import { useAppStore } from '../../stores/appStore';
import { ROUTES } from '../../constants/routes';
import { RETENTION_OPTIONS } from '../../constants/retention';

const PrivacySettings: React.FC = () => {
  const { t } = useTranslation(['settings', 'discussions']);
  const navigate = useNavigate();
  const defaultRetentionDuration = useAppStore(s => s.defaultRetentionDuration);
  const setDefaultRetentionDuration = useAppStore(
    s => s.setDefaultRetentionDuration
  );

  const [isRetentionModalOpen, setIsRetentionModalOpen] = useState(false);

  const handleRetentionChange = async (duration: number | null) => {
    try {
      await setDefaultRetentionDuration(duration);
      setIsRetentionModalOpen(false);
    } catch (error) {
      logger.error('Failed to persist default retention setting:', error);
    }
  };

  const retentionLabel = useMemo(() => {
    const option = RETENTION_OPTIONS.find(
      o => o.value === defaultRetentionDuration
    );
    return option
      ? t(option.labelKey)
      : t('discussions:settings.auto_delete_off');
  }, [defaultRetentionDuration, t]);

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
          <span className="text-accent-soft-foreground">{retentionLabel}</span>
        </button>
      </div>

      <OptionBottomSheet
        isOpen={isRetentionModalOpen}
        title={t('privacy.default_retention_title')}
        options={RETENTION_OPTIONS.map(o => ({
          label: t(o.labelKey),
          value: o.value,
        }))}
        selectedValue={defaultRetentionDuration}
        onSelect={value => void handleRetentionChange(value)}
        onClose={() => setIsRetentionModalOpen(false)}
      />
    </PageLayout>
  );
};

export default PrivacySettings;
