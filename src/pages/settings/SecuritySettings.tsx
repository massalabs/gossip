import { logger } from '../../utils/logger.ts';
import React, { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { Capacitor } from '@capacitor/core';
import PageLayout from '../../components/ui/Layout/PageLayout';
import PageHeader from '../../components/ui/PageHeader';
import Button from '../../components/ui/Button';
import OptionBottomSheet from '../../components/ui/OptionBottomSheet';
import ICloudSyncModal from '../../components/ui/ICloudSyncModal';
import BiometricPasswordModal from '../../components/settings/BiometricPasswordModal';
import { useAppStore } from '../../stores/appStore';
import { useAccountStore } from '../../stores/accountStore';
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
  const configureBiometricLogin = useAccountStore(
    state => state.configureBiometricLogin
  );

  const [isTimeoutModalOpen, setIsTimeoutModalOpen] = useState(false);
  const [isPasswordModalOpen, setIsPasswordModalOpen] = useState(false);
  const [isICloudModalOpen, setIsICloudModalOpen] = useState(false);
  const [pendingPassword, setPendingPassword] = useState('');
  const [isBiometricSetupLoading, setIsBiometricSetupLoading] = useState(false);
  const [biometricMessage, setBiometricMessage] = useState<{
    type: 'success' | 'error';
    text: string;
  } | null>(null);

  const timeoutLabel = useMemo(() => {
    const option = TIMEOUT_OPTIONS.find(o => o.value === autoLockTimeout);
    return option ? t(option.labelKey) : t('security.auto_lock_off');
  }, [autoLockTimeout, t]);

  const handleBack = () => {
    navigate(ROUTES.settings());
  };

  const performBiometricSetup = async (
    password: string,
    syncToICloud: boolean
  ) => {
    setIsBiometricSetupLoading(true);
    setBiometricMessage(null);
    try {
      await configureBiometricLogin(password, syncToICloud);
      setBiometricMessage({
        type: 'success',
        text: t('security.biometric_success'),
      });
    } catch (error) {
      logger.error('Failed to configure biometric login:', error);
      const message = error instanceof Error ? error.message : '';
      setBiometricMessage({
        type: 'error',
        text: message.startsWith('Authentication failed')
          ? t('security.biometric_password_invalid')
          : t('security.biometric_failed'),
      });
    } finally {
      setPendingPassword('');
      setIsBiometricSetupLoading(false);
    }
  };

  const handlePasswordConfirm = async (password: string) => {
    setIsPasswordModalOpen(false);
    if (Capacitor.getPlatform() === 'ios') {
      setPendingPassword(password);
      setIsICloudModalOpen(true);
      return;
    }
    await performBiometricSetup(password, false);
  };

  return (
    <PageLayout
      header={<PageHeader title={t('security.title')} onBack={handleBack} />}
      className="app-max-w mx-auto"
      contentClassName="px-6 py-6 space-y-6"
    >
      <div className="bg-card border border-border rounded-xl overflow-hidden">
        <div className="px-4 pt-4 pb-2">
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
            {t('security.biometric_title')}
          </p>
        </div>
        <div className="px-4 pb-3 space-y-3">
          <p className="text-sm text-muted-foreground">
            {t('security.biometric_description')}
          </p>
          <div className="p-3 rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800">
            <p className="text-xs text-amber-700 dark:text-amber-300">
              {t('security.biometric_warning')}
            </p>
          </div>
          {biometricMessage && (
            <div
              className={`p-3 rounded-lg border ${
                biometricMessage.type === 'success'
                  ? 'bg-green-50 dark:bg-green-900/20 border-green-200 dark:border-green-800 text-green-700 dark:text-green-300'
                  : 'bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-800 text-red-700 dark:text-red-300'
              }`}
            >
              <p className="text-xs">{biometricMessage.text}</p>
            </div>
          )}
        </div>
        <div className="px-4 py-3 border-t border-border">
          <Button
            onClick={() => {
              setBiometricMessage(null);
              setIsPasswordModalOpen(true);
            }}
            disabled={isBiometricSetupLoading}
            loading={isBiometricSetupLoading}
            variant="outline"
            size="custom"
            fullWidth
            className="h-11 rounded-full text-sm font-medium"
          >
            {!isBiometricSetupLoading &&
              t('security.biometric_use_for_account')}
          </Button>
        </div>
      </div>

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

      <BiometricPasswordModal
        isOpen={isPasswordModalOpen}
        isSubmitting={isBiometricSetupLoading}
        onConfirm={handlePasswordConfirm}
        onClose={() => setIsPasswordModalOpen(false)}
      />
      <ICloudSyncModal
        isOpen={isICloudModalOpen}
        onClose={() => {
          setIsICloudModalOpen(false);
          setPendingPassword('');
        }}
        onConfirm={syncToICloud => {
          const password = pendingPassword;
          setPendingPassword('');
          void performBiometricSetup(password, syncToICloud);
        }}
      />
    </PageLayout>
  );
};

export default SecuritySettings;
