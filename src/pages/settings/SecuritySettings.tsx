import React, { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import PageLayout from '../../components/ui/Layout/PageLayout';
import PageHeader from '../../components/ui/PageHeader';
import OptionBottomSheet from '../../components/ui/OptionBottomSheet';
import { useAppStore } from '../../stores/appStore';
import { ROUTES } from '../../constants/routes';

const TIMEOUT_OPTIONS: { labelKey: string; value: number | null }[] = [
  { labelKey: 'security.auto_lock_off', value: null },
  { labelKey: 'security.auto_lock_1m', value: 60 },
  { labelKey: 'security.auto_lock_5m', value: 300 },
  { labelKey: 'security.auto_lock_15m', value: 900 },
  { labelKey: 'security.auto_lock_30m', value: 1800 },
  { labelKey: 'security.auto_lock_1h', value: 3600 },
];

const SecuritySettings: React.FC = () => {
  const { t } = useTranslation('settings');
  const navigate = useNavigate();
  const autoLockTimeout = useAppStore(s => s.autoLockTimeout);
  const setAutoLockTimeout = useAppStore(s => s.setAutoLockTimeout);

  const [isTimeoutModalOpen, setIsTimeoutModalOpen] = useState(false);

  const timeoutLabel = useMemo(() => {
    const option = TIMEOUT_OPTIONS.find(o => o.value === autoLockTimeout);
    return option ? t(option.labelKey) : t('security.auto_lock_off');
  }, [autoLockTimeout, t]);

  const handleBack = () => {
    navigate(ROUTES.settings());
  };

  return (
    <PageLayout
      header={<PageHeader title={t('security.title')} onBack={handleBack} />}
      className="app-max-w mx-auto"
      contentClassName="px-6 py-6 space-y-6"
    >
      {/* Auto-lock section */}
      <div className="bg-card border border-border rounded-xl overflow-hidden">
        <div className="px-4 pt-4 pb-2">
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
            {t('security.auto_lock_title')}
          </p>
        </div>
        <div className="px-4 pb-3">
          <p className="text-sm text-muted-foreground">
            {t('security.auto_lock_description')}
          </p>
        </div>
        <button
          onClick={() => setIsTimeoutModalOpen(true)}
          className="w-full flex items-center justify-between text-sm font-medium text-foreground hover:bg-muted px-4 py-3 transition-colors border-t border-border"
        >
          <span>{t('security.auto_lock_current')}</span>
          <span className="text-accent-soft-foreground">{timeoutLabel}</span>
        </button>
      </div>

      <OptionBottomSheet
        isOpen={isTimeoutModalOpen}
        title={t('security.auto_lock_title')}
        options={TIMEOUT_OPTIONS.map(o => ({
          label: t(o.labelKey),
          value: o.value,
        }))}
        selectedValue={autoLockTimeout}
        onSelect={value => {
          setAutoLockTimeout(value);
          setIsTimeoutModalOpen(false);
        }}
        onClose={() => setIsTimeoutModalOpen(false)}
      />
    </PageLayout>
  );
};

export default SecuritySettings;
