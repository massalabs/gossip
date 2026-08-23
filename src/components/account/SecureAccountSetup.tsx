import { logger } from '../../utils/logger.ts';
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Capacitor } from '@capacitor/core';
import {
  Shield,
  AlertTriangle,
  CheckCircle,
  Circle,
  Plus,
  Check,
} from 'react-feather';
import { useAccountStore } from '../../stores/accountStore';
import {
  checkBiometricAvailability,
  configureBiometricLoginWithRollback,
} from '../../services/biometricService';
import { MAX_SECURE_ACCOUNTS } from '../../config/features';
import PageHeader from '../ui/PageHeader';
import PageLayout from '../ui/Layout/PageLayout';
import Button from '../ui/Button';
import ICloudSyncModal from '../ui/ICloudSyncModal';
import { PrivacyGraphic } from '../graphics';
import SecureAccountForm from './SecureAccountForm';
import {
  readStagedPassword,
  stageAccount,
  stagedPasswordsEqual,
  StagedAccount,
  wipeStagedAccounts,
} from './stagedAccount';

interface SecureAccountSetupProps {
  initialAccount: StagedAccount;
  onComplete: () => void | Promise<void>;
  onRestart: (message: string) => void;
}

const SecureAccountSetup: React.FC<SecureAccountSetupProps> = ({
  initialAccount,
  onComplete,
  onRestart,
}) => {
  const { t } = useTranslation('auth');
  const initializeAccount = useAccountStore(state => state.initializeAccount);
  const logout = useAccountStore(state => state.logout);

  const [stagedAccounts, setStagedAccounts] = useState<StagedAccount[]>([
    initialAccount,
  ]);
  const [selectedBiometricIndex, setSelectedBiometricIndex] = useState<
    number | null
  >(null);
  const [biometricAvailable, setBiometricAvailable] = useState<boolean | null>(
    null
  );
  const [addingAccount, setAddingAccount] = useState(false);
  const [isFinalizing, setIsFinalizing] = useState(false);
  const [lockRecoveryPending, setLockRecoveryPending] = useState(false);
  const [showICloudModal, setShowICloudModal] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    checkBiometricAvailability()
      .then(({ available }) => setBiometricAvailable(available))
      .catch(() => setBiometricAvailable(false));
  }, []);

  const remainingSlots = MAX_SECURE_ACCOUNTS - stagedAccounts.length;
  const canAddMore = remainingSlots > 0;

  const handleAddAccount = (creds: { username: string; password: string }) => {
    const account = stageAccount(creds.username, creds.password);
    const collides = stagedAccounts.some(existing =>
      stagedPasswordsEqual(existing, account)
    );

    if (collides) {
      account.passwordBytes.fill(0);
      setAddingAccount(false);
      setError(t('secure_setup.password_in_use'));
      return;
    }

    setStagedAccounts(previous => [...previous, account]);
    setAddingAccount(false);
    setError(null);
  };

  const lockPersistedAccountsAndComplete = async () => {
    setIsFinalizing(true);
    setLockRecoveryPending(false);
    try {
      await logout({ lockedByUser: false });
      await onComplete();
    } catch (logoutError) {
      logger.error(
        'Failed to lock persisted onboarding accounts:',
        logoutError
      );
      setLockRecoveryPending(true);
      setIsFinalizing(false);
    }
  };

  const finalizeAccounts = async (syncToICloud = false) => {
    setIsFinalizing(true);
    setError(null);

    let persistedAccounts = 0;
    let failure: unknown;
    let rollbackBiometric: (() => Promise<void>) | undefined;

    try {
      if (selectedBiometricIndex !== null) {
        const selected = stagedAccounts[selectedBiometricIndex];
        const result = await configureBiometricLoginWithRollback(
          readStagedPassword(selected),
          syncToICloud
        );
        if (!result.success) {
          throw new Error(result.error || 'Biometric setup failed');
        }
        rollbackBiometric = result.rollback;
      }

      for (const account of stagedAccounts) {
        await initializeAccount(account.username, readStagedPassword(account));
        persistedAccounts += 1;
      }
    } catch (caught) {
      failure = caught;
      logger.error('Error finalizing secure account setup:', caught);

      // Replacement happens before persistence so biometric cancellation never
      // leaves committed accounts. Restore the prior singleton credential if
      // persistence failed before the selected account reached its commit point.
      if (
        rollbackBiometric &&
        selectedBiometricIndex !== null &&
        persistedAccounts <= selectedBiometricIndex
      ) {
        try {
          await rollbackBiometric();
        } catch (rollbackError) {
          logger.error(
            'Failed to restore biometric login after onboarding error:',
            rollbackError
          );
        }
      }
    } finally {
      // The wipe happens before routing or rendering another interactive screen
      // and covers successful persistence, biometric cancellation, and every
      // account-creation failure path.
      wipeStagedAccounts(stagedAccounts);
    }

    if (failure) {
      if (persistedAccounts > 0) {
        // At least one account reached the commit point. Lock before routing to
        // login; a failure must enter lock-only recovery rather than exposing
        // the last open session or retrying with wiped staged credentials.
        await lockPersistedAccountsAndComplete();
      } else {
        try {
          await logout({ lockedByUser: false });
        } catch (logoutError) {
          logger.error('Failed to lock after onboarding error:', logoutError);
        }
        onRestart(
          failure instanceof Error ? failure.message : t('create.failed')
        );
      }
      return;
    }

    if (stagedAccounts.length > 1) {
      // Multiple isolated accounts cannot remain selected implicitly. Return to
      // login and let the supplied password discover the intended slot. If
      // locking fails, never rerun persistence with already-wiped credentials.
      await lockPersistedAccountsAndComplete();
      return;
    }
    await onComplete();
  };

  const handleFinalize = () => {
    if (selectedBiometricIndex !== null && Capacitor.getPlatform() === 'ios') {
      setShowICloudModal(true);
      return;
    }
    void finalizeAccounts(false);
  };

  if (lockRecoveryPending) {
    return (
      <PageLayout
        header={<PageHeader title={t('secure_setup.lock_failed_title')} />}
        className="app-max-w mx-auto"
        contentClassName="p-4 flex flex-col justify-center"
      >
        <div className="text-center space-y-6">
          <AlertTriangle className="w-12 h-12 text-amber-500 mx-auto" />
          <p className="text-sm text-muted-foreground">
            {t('secure_setup.lock_failed')}
          </p>
          <Button
            onClick={() => void lockPersistedAccountsAndComplete()}
            variant="primary"
            size="custom"
            fullWidth
            className="h-12 rounded-full text-sm font-medium"
          >
            {t('secure_setup.retry_lock')}
          </Button>
        </div>
      </PageLayout>
    );
  }

  if (addingAccount) {
    return (
      <SecureAccountForm
        onSubmit={handleAddAccount}
        onBack={() => setAddingAccount(false)}
      />
    );
  }

  if (isFinalizing) {
    return (
      <div className="bg-background flex items-center justify-center h-full">
        <div className="text-center">
          <PrivacyGraphic size={120} loading={true} />
          <p className="text-sm text-muted-foreground mt-4">
            {t('secure_setup.finalizing')}
          </p>
        </div>
      </div>
    );
  }

  const hasAdditionalAccounts = stagedAccounts.length > 1;

  return (
    <PageLayout
      header={
        <PageHeader title={t('secure_setup.title')} onBack={handleFinalize} />
      }
      className="app-max-w mx-auto"
      contentClassName="p-4"
    >
      {hasAdditionalAccounts ? (
        <div className="p-4 border rounded-lg bg-blue-50 dark:bg-blue-900/20 border-blue-200 dark:border-blue-800 mb-6">
          <div className="flex items-start gap-3">
            <Shield className="h-5 w-5 text-blue-500 shrink-0 mt-0.5" />
            <p className="text-sm text-blue-700 dark:text-blue-300 leading-relaxed">
              {t('secure_setup.info')}
            </p>
          </div>
        </div>
      ) : (
        <div className="p-4 border rounded-lg bg-amber-50 dark:bg-amber-900/20 border-amber-200 dark:border-amber-800 mb-6">
          <div className="flex items-start gap-3">
            <AlertTriangle className="h-5 w-5 text-amber-500 shrink-0 mt-0.5" />
            <p className="text-sm text-amber-700 dark:text-amber-300 leading-relaxed">
              {t('secure_setup.warning_create_more')}
            </p>
          </div>
        </div>
      )}

      <div className="mb-6">
        {stagedAccounts.map((account, index) => (
          <div key={index} className="flex items-center py-3 px-2">
            <CheckCircle className="w-4 h-4 text-green-500 mr-3 shrink-0" />
            <span className="text-sm text-foreground font-medium">
              {account.username}
            </span>
          </div>
        ))}
      </div>

      {biometricAvailable && (
        <div className="bg-card border border-border rounded-xl p-4 mb-6 space-y-3">
          <div>
            <h2 className="text-sm font-semibold text-foreground">
              {t('biometric_setup.title')}
            </h2>
            <p className="text-sm text-muted-foreground mt-1">
              {t('biometric_setup.onboarding_info')}
            </p>
          </div>
          <div className="p-3 rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800">
            <p className="text-xs text-amber-700 dark:text-amber-300">
              {t('biometric_setup.onboarding_warning')}
            </p>
          </div>
          <p className="text-sm font-medium text-foreground">
            {t('biometric_setup.select_account')}
          </p>
          <div className="space-y-1">
            {stagedAccounts.map((account, index) => {
              const selected = selectedBiometricIndex === index;
              return (
                <button
                  key={index}
                  type="button"
                  onClick={() =>
                    setSelectedBiometricIndex(selected ? null : index)
                  }
                  className="w-full flex items-center gap-3 rounded-lg px-3 py-3 text-left hover:bg-muted transition-colors"
                  aria-pressed={selected}
                >
                  {selected ? (
                    <CheckCircle className="w-5 h-5 text-primary shrink-0" />
                  ) : (
                    <Circle className="w-5 h-5 text-muted-foreground shrink-0" />
                  )}
                  <span className="text-sm font-medium text-foreground">
                    {account.username}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {biometricAvailable === false && (
        <div className="bg-card rounded-lg p-4 mb-6 border border-border">
          <p className="text-muted-foreground text-sm">
            {t('create.biometric_not_supported')}
          </p>
        </div>
      )}

      {error && (
        <div className="p-4 mb-4 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg">
          <p className="text-red-600 dark:text-red-400 text-sm">{error}</p>
        </div>
      )}

      <div className="space-y-3">
        {canAddMore ? (
          <Button
            onClick={() => setAddingAccount(true)}
            variant="outline"
            size="custom"
            fullWidth
            className="h-12 rounded-full text-sm font-medium gap-2"
          >
            <Plus className="w-4 h-4" />
            {t('secure_setup.add_account', { remaining: remainingSlots })}
          </Button>
        ) : (
          <p className="text-sm text-muted-foreground text-center">
            {t('secure_setup.max_reached')}
          </p>
        )}

        <Button
          onClick={handleFinalize}
          variant={hasAdditionalAccounts ? 'primary' : 'outline'}
          size="custom"
          fullWidth
          className="h-12 rounded-full text-sm font-medium gap-2"
        >
          {hasAdditionalAccounts && <Check className="w-4 h-4" />}
          {hasAdditionalAccounts
            ? t('secure_setup.done')
            : t('secure_setup.skip')}
        </Button>
      </div>

      <ICloudSyncModal
        isOpen={showICloudModal}
        onClose={() => setShowICloudModal(false)}
        onConfirm={syncToICloud => {
          void finalizeAccounts(syncToICloud);
        }}
      />
    </PageLayout>
  );
};

export default SecureAccountSetup;
