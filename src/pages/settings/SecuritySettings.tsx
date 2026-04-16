import React, { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { Capacitor } from '@capacitor/core';
import PageLayout from '../../components/ui/Layout/PageLayout';
import PageHeader from '../../components/ui/PageHeader';
import BackgroundSyncSettings from '../../components/settings/BackgroundSyncSettings';
import { useAppStore } from '../../stores/appStore';
import { ROUTES } from '../../constants/routes';

const SecuritySettings: React.FC = () => {
  const { t } = useTranslation('settings');
  const navigate = useNavigate();
  const showDebugOption = useAppStore(s => s.showDebugOption);
  const autoLockTimeout = useAppStore(s => s.autoLockTimeout);
  const setAutoLockTimeout = useAppStore(s => s.setAutoLockTimeout);
  const platform = Capacitor.getPlatform();
  const isNative = platform !== 'web';

  const [isTimeoutModalOpen, setIsTimeoutModalOpen] = useState(false);

  const TIMEOUT_OPTIONS = useMemo(
    () => [
      { labelKey: 'security.auto_lock_off', value: null as number | null },
      { labelKey: 'security.auto_lock_1m', value: 60 },
      { labelKey: 'security.auto_lock_5m', value: 300 },
      { labelKey: 'security.auto_lock_15m', value: 900 },
      { labelKey: 'security.auto_lock_30m', value: 1800 },
      { labelKey: 'security.auto_lock_1h', value: 3600 },
    ],
    []
  );

  const timeoutLabel = useMemo(() => {
    const option = TIMEOUT_OPTIONS.find(o => o.value === autoLockTimeout);
    return option ? t(option.labelKey) : t('security.auto_lock_off');
  }, [autoLockTimeout, t, TIMEOUT_OPTIONS]);

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
          <span className="text-primary">{timeoutLabel}</span>
        </button>
      </div>

      {/* Background sync section (native only) */}
      {isNative && <BackgroundSyncSettings showDebugInfo={showDebugOption} />}

      {isTimeoutModalOpen && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/50"
          onClick={() => setIsTimeoutModalOpen(false)}
        >
          <div
            className="bg-background w-full max-w-md rounded-t-2xl p-6 pb-8"
            onClick={e => e.stopPropagation()}
          >
            <h3 className="text-base font-semibold text-foreground mb-4">
              {t('security.auto_lock_title')}
            </h3>
            <div className="flex flex-col gap-1">
              {TIMEOUT_OPTIONS.map(option => (
                <button
                  key={String(option.value)}
                  onClick={() => {
                    setAutoLockTimeout(option.value);
                    setIsTimeoutModalOpen(false);
                  }}
                  className={`w-full text-left px-4 py-3 rounded-lg text-sm transition-colors ${
                    autoLockTimeout === option.value
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

export default SecuritySettings;
