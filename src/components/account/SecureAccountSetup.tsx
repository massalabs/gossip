import { logger } from '../../utils/logger.ts';
import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Capacitor } from '@capacitor/core';
import { App } from '@capacitor/app';
import toast from 'react-hot-toast';
import {
  Shield,
  AlertTriangle,
  CheckCircle,
  Circle,
  Plus,
  Check,
} from 'react-feather';
import { useAccountStore } from '../../stores/accountStore';
import { useAppStore } from '../../stores/appStore';
import {
  checkBiometricAvailability,
  configureBiometricLoginWithRollback,
} from '../../services/biometricService';
import { generateMnemonic } from '@massalabs/gossip-sdk';
import { MAX_SECURE_ACCOUNTS } from '../../config/features';
import {
  consumeOnboardingCreationAuthority,
  restoreOnboardingCreationAuthorityAfterRollback,
  type OnboardingStorageModeLease,
} from '../../services/portableImportAuthorization';
import PageHeader from '../ui/PageHeader';
import PageLayout from '../ui/Layout/PageLayout';
import Button from '../ui/Button';
import ICloudSyncModal from '../ui/ICloudSyncModal';
import { PrivacyGraphic } from '../graphics';
import SecureAccountForm from './SecureAccountForm';
import {
  preparePasswordAccount,
  type PreparedPasswordAccount,
  wipePreparedPasswordAccount,
} from '../../stores/utils/auth';
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
  onCredentialOperationChange?: (active: boolean) => void;
  creationModeLease?: OnboardingStorageModeLease;
}

const SecureAccountSetup: React.FC<SecureAccountSetupProps> = ({
  initialAccount,
  onComplete,
  onRestart,
  onCredentialOperationChange,
  creationModeLease,
}) => {
  const { t } = useTranslation('auth');
  const operationChangeRef = useRef(onCredentialOperationChange);
  operationChangeRef.current = onCredentialOperationChange;
  const initializePreparedAccountsAtomically = useAccountStore(
    state => state.initializePreparedAccountsAtomically
  );

  const [stagedAccounts, setStagedAccounts] = useState<StagedAccount[]>([
    initialAccount,
  ]);
  const stagedAccountsRef = useRef<StagedAccount[]>([initialAccount]);
  const mounted = useRef(false);
  const activeCredentialOperations = useRef(0);
  const [selectedBiometricIndex, setSelectedBiometricIndex] = useState<
    number | null
  >(null);
  const [biometricAvailable, setBiometricAvailable] = useState<boolean | null>(
    null
  );
  const [addingAccount, setAddingAccount] = useState(false);
  const [isFinalizing, setIsFinalizing] = useState(false);
  const [showICloudModal, setShowICloudModal] = useState(false);
  const [biometricCommitPending, setBiometricCommitPending] = useState(false);
  const pendingBiometricRollback = useRef<(() => Promise<void>) | undefined>(
    undefined
  );
  const pendingBiometricSync = useRef(false);
  const [error, setError] = useState<string | null>(null);

  stagedAccountsRef.current = stagedAccounts;

  useEffect(() => {
    if (!isFinalizing || Capacitor.getPlatform() !== 'android') return;

    let disposed = false;
    let removeListener: (() => Promise<void>) | undefined;
    void App.addListener('backButton', () => {
      toast(t('secure_setup.finalization_cannot_cancel'));
    }).then(handle => {
      if (disposed) {
        void handle.remove();
        return;
      }
      removeListener = () => handle.remove();
    });

    return () => {
      disposed = true;
      void removeListener?.();
    };
  }, [isFinalizing, t]);

  useEffect(() => {
    mounted.current = true;
    checkBiometricAvailability()
      .then(({ available }) => setBiometricAvailable(available))
      .catch(() => setBiometricAvailable(false));

    return () => {
      mounted.current = false;
      // React StrictMode immediately replays effects in development. Delay the
      // ownership check by one microtask so simulated cleanup cannot wipe
      // credentials from the still-mounted component.
      queueMicrotask(() => {
        if (!mounted.current && activeCredentialOperations.current === 0) {
          wipeStagedAccounts(stagedAccountsRef.current);
          operationChangeRef.current?.(false);
        }
      });
    };
  }, []);

  const runCredentialOperation = async <T,>(
    operation: () => Promise<T>
  ): Promise<T> => {
    activeCredentialOperations.current += 1;
    if (activeCredentialOperations.current === 1) {
      operationChangeRef.current?.(true);
    }
    try {
      return await operation();
    } finally {
      activeCredentialOperations.current -= 1;
      if (activeCredentialOperations.current === 0) {
        if (!mounted.current) {
          wipeStagedAccounts(stagedAccountsRef.current);
        }
        operationChangeRef.current?.(false);
      }
    }
  };

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

    setStagedAccounts(previous => {
      const next = [...previous, account];
      stagedAccountsRef.current = next;
      return next;
    });
    setAddingAccount(false);
    setError(null);
  };

  const completeCommittedSetup = async () => {
    pendingBiometricRollback.current = undefined;
    setBiometricCommitPending(false);
    wipeStagedAccounts(stagedAccountsRef.current);
    await onComplete();
  };

  const restorePendingBiometric = async (): Promise<boolean> => {
    const rollback = pendingBiometricRollback.current;
    if (!rollback) return true;
    try {
      await rollback();
      pendingBiometricRollback.current = undefined;
      return true;
    } catch (rollbackError) {
      logger.error('Failed to restore biometric login:', rollbackError);
      setError(t('secure_setup.biometric_retry_failed'));
      return false;
    }
  };

  const retryCommittedBiometric = async () => {
    setIsFinalizing(true);
    setError(null);
    if (!(await restorePendingBiometric())) {
      setIsFinalizing(false);
      return;
    }
    const selected =
      selectedBiometricIndex === null
        ? null
        : stagedAccountsRef.current[selectedBiometricIndex];
    if (!selected) {
      await completeCommittedSetup();
      return;
    }
    const result = await configureBiometricLoginWithRollback(
      readStagedPassword(selected),
      pendingBiometricSync.current
    );
    if (!result.success) {
      pendingBiometricRollback.current = result.rollback;
      setError(result.error || t('secure_setup.biometric_retry_failed'));
      setIsFinalizing(false);
      return;
    }
    await completeCommittedSetup();
  };

  const continueWithoutBiometric = async () => {
    setIsFinalizing(true);
    setError(null);
    if (!(await restorePendingBiometric())) {
      setIsFinalizing(false);
      return;
    }
    await completeCommittedSetup();
  };

  const finalizeAccounts = async (syncToICloud = false) => {
    setIsFinalizing(true);
    setError(null);

    const preparedAccounts: PreparedPasswordAccount[] = [];
    let failure: unknown;
    let creationAuthorityOwner: string | null = null;

    try {
      // Nothing reaches durable account storage until every confirmed password
      // has decrypted and reopened its exact generated identity/session in RAM.
      for (const account of stagedAccounts) {
        preparedAccounts.push(
          await preparePasswordAccount(
            generateMnemonic(256),
            readStagedPassword(account)
          )
        );
      }

      creationAuthorityOwner =
        consumeOnboardingCreationAuthority(creationModeLease);
      await initializePreparedAccountsAtomically(
        stagedAccounts.map((account, index) => ({
          username: account.username,
          password: readStagedPassword(account),
          prepared: preparedAccounts[index],
        }))
      );
    } catch (caught) {
      failure = caught;
      logger.error('Error finalizing secure account setup:', caught);
    } finally {
      for (const prepared of preparedAccounts) {
        wipePreparedPasswordAccount(prepared);
      }
    }

    if (failure) {
      try {
        restoreOnboardingCreationAuthorityAfterRollback(creationAuthorityOwner);
      } catch (restoreError) {
        logger.error('Failed to restore onboarding authority:', restoreError);
      }
      // The atomic installer either exposes no candidate account or the whole
      // committed generation. Never erase individual slots after an ambiguous
      // commit response, because doing so would reintroduce partial survival.
      wipeStagedAccounts(stagedAccountsRef.current);
      useAppStore.getState().setIsInitialized(false);
      onRestart(t('secure_setup.batch_failed'));
      return;
    }

    useAppStore.getState().setSecureAccountCreationAllowed(false);
    if (selectedBiometricIndex !== null) {
      const selected = stagedAccounts[selectedBiometricIndex];
      const result = await configureBiometricLoginWithRollback(
        readStagedPassword(selected),
        syncToICloud
      );
      if (!result.success) {
        pendingBiometricRollback.current = result.rollback;
        pendingBiometricSync.current = syncToICloud;
        setError(result.error || t('secure_setup.biometric_retry_failed'));
        setBiometricCommitPending(true);
        setIsFinalizing(false);
        return;
      }
    }

    await completeCommittedSetup();
  };

  const handleFinalize = () => {
    if (selectedBiometricIndex !== null && Capacitor.getPlatform() === 'ios') {
      setShowICloudModal(true);
      return;
    }
    void runCredentialOperation(() => finalizeAccounts(false));
  };

  if (biometricCommitPending) {
    return (
      <PageLayout
        header={<PageHeader title={t('secure_setup.biometric_failed_title')} />}
        className="app-max-w mx-auto"
        contentClassName="p-4 flex flex-col justify-center"
      >
        <div className="text-center space-y-6">
          <AlertTriangle className="w-12 h-12 text-amber-500 mx-auto" />
          <p className="text-sm text-muted-foreground">
            {error || t('secure_setup.biometric_failed')}
          </p>
          <Button
            type="button"
            variant="primary"
            fullWidth
            loading={isFinalizing}
            disabled={isFinalizing}
            onClick={() => void runCredentialOperation(retryCommittedBiometric)}
          >
            {t('secure_setup.retry_biometric')}
          </Button>
          <Button
            type="button"
            variant="secondary"
            fullWidth
            disabled={isFinalizing}
            onClick={() =>
              void runCredentialOperation(continueWithoutBiometric)
            }
          >
            {t('secure_setup.continue_password_only')}
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
          void runCredentialOperation(() => finalizeAccounts(syncToICloud));
        }}
      />
    </PageLayout>
  );
};

export default SecureAccountSetup;
