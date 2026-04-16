import React, { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import PageLayout from '../../components/ui/Layout/PageLayout';
import PageHeader from '../../components/ui/PageHeader';
import { useAppStore } from '../../stores/appStore';
import { ROUTES } from '../../constants/routes';

const PrivacySettings: React.FC = () => {
  const { t } = useTranslation(['settings', 'discussions']);
  const navigate = useNavigate();
  const defaultRetentionDuration = useAppStore(s => s.defaultRetentionDuration);
  const setDefaultRetentionDuration = useAppStore(
    s => s.setDefaultRetentionDuration
  );

  const [isRetentionModalOpen, setIsRetentionModalOpen] = useState(false);

  const RETENTION_OPTIONS = useMemo(
    () => [
      {
        labelKey: 'discussions:settings.auto_delete_off',
        value: null as number | null,
      },
      { labelKey: 'discussions:settings.auto_delete_5m', value: 300 },
      { labelKey: 'discussions:settings.auto_delete_1h', value: 3600 },
      { labelKey: 'discussions:settings.auto_delete_8h', value: 28800 },
      { labelKey: 'discussions:settings.auto_delete_1d', value: 86400 },
      { labelKey: 'discussions:settings.auto_delete_1w', value: 604800 },
      { labelKey: 'discussions:settings.auto_delete_1mo', value: 2592000 },
    ],
    []
  );

  const retentionLabel = useMemo(() => {
    const option = RETENTION_OPTIONS.find(
      o => o.value === defaultRetentionDuration
    );
    return option
      ? t(option.labelKey)
      : t('discussions:settings.auto_delete_off');
  }, [defaultRetentionDuration, t, RETENTION_OPTIONS]);

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
          <span className="text-primary">{retentionLabel}</span>
        </button>
      </div>

      {isRetentionModalOpen && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/50"
          onClick={() => setIsRetentionModalOpen(false)}
        >
          <div
            className="bg-background w-full max-w-md rounded-t-2xl p-6 pb-8"
            onClick={e => e.stopPropagation()}
          >
            <h3 className="text-base font-semibold text-foreground mb-4">
              {t('privacy.default_retention_title')}
            </h3>
            <div className="flex flex-col gap-1">
              {RETENTION_OPTIONS.map(option => (
                <button
                  key={String(option.value)}
                  onClick={() => {
                    setDefaultRetentionDuration(option.value);
                    setIsRetentionModalOpen(false);
                  }}
                  className={`w-full text-left px-4 py-3 rounded-lg text-sm transition-colors ${
                    defaultRetentionDuration === option.value
                      ? 'bg-primary/10 text-primary font-medium'
                      : 'hover:bg-muted text-foreground'
                  }`}
                >
                  {t(option.labelKey)}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </PageLayout>
  );
};

export default PrivacySettings;
