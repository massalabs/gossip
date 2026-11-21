import { logger } from '../../utils/logger.ts';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Capacitor } from '@capacitor/core';
import { App } from '@capacitor/app';
import toast from 'react-hot-toast';
import { encodeToBase64 } from '@massalabs/gossip-sdk';
import PageHeader from '../ui/PageHeader';
import PageLayout from '../ui/Layout/PageLayout';
import Button from '../ui/Button';
import { PrivacyGraphic } from '../graphics';
import AccountCreationForm, {
  AccountCreationResult,
} from './AccountCreationForm';
import {
  buildOnboardingAccount,
  type OnboardingAccountBuild,
} from './commitOnboardingAccount';
import {
  readStagedPassword,
  stageAccount,
  wipeStagedAccounts,
  type StagedAccount,
} from './stagedAccount';
import { useAccountStore } from '../../stores/accountStore';
import {
  checkBiometricAvailability,
  configureBiometricLoginWithRollback,
} from '../../services/biometricService';
import { generateDefaultUsername } from '../../utils/validation';
import type { OnboardingStorageModeLease } from '../../services/portableImportAuthorization';

type Phase = 'checking' | 'working' | 'form';
/** What the creating screen says it is doing. */
type Step = 'building' | 'saving' | 'opening';

interface SecureAccountCreationProps {
  onComplete: () => void | Promise<void>;
  onBack: () => void;
  onCredentialOperationChange?: (active: boolean) => void;
  creationModeLease?: OnboardingStorageModeLease;
  /** 'import' restores an identity from its recovery phrase. Default: 'create' */
  mode?: 'create' | 'import';
}

/**
 * The account secret of a biometric-only account. The user never sees it:
 * it lives in the device biometric credential store and unlocks the account
 * exactly like a typed password would.
 */
function generateAccountSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  try {
    return encodeToBase64(bytes);
  } finally {
    bytes.fill(0);
  }
}

/**
 * Single-step account creation.
 *
 * New account, biometrics available: one biometric prompt stores a random
 * account secret, the account is created with it, and the user lands in the
 * app. Otherwise (no biometrics, prompt cancelled, or recovery-phrase import)
 * the user chooses a password. Username, biometric choice for password
 * accounts, and additional accounts all live in Settings.
 */
const SecureAccountCreation: React.FC<SecureAccountCreationProps> = ({
  onComplete,
  onBack,
  onCredentialOperationChange,
  creationModeLease,
  mode = 'create',
}) => {
  const { t } = useTranslation('auth');
  const [phase, setPhase] = useState<Phase>(
    mode === 'create' ? 'checking' : 'form'
  );
  const [biometricAvailable, setBiometricAvailable] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [step, setStep] = useState<Step>('building');
  const operationChangeRef = useRef(onCredentialOperationChange);
  operationChangeRef.current = onCredentialOperationChange;
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;
  const leaseRef = useRef(creationModeLease);
  leaseRef.current = creationModeLease;
  // Survives React StrictMode's simulated remount so the biometric prompt
  // is only ever raised once per screen.
  const startedRef = useRef(false);
  const activeOperations = useRef(0);

  const runCredentialOperation = useCallback(
    async <T,>(operation: () => Promise<T>): Promise<T> => {
      activeOperations.current += 1;
      if (activeOperations.current === 1) operationChangeRef.current?.(true);
      try {
        return await operation();
      } finally {
        activeOperations.current -= 1;
        if (activeOperations.current === 0) {
          operationChangeRef.current?.(false);
        }
      }
    },
    []
  );

  /**
   * Wait for the in-memory build, commit it, then log straight into the
   * account. Throws (after undoing the biometric credential) when nothing
   * was created; resolves once the user is on their way into the app.
   */
  const createAndEnter = useCallback(
    async (
      account: StagedAccount,
      building: Promise<OnboardingAccountBuild>,
      rollbackBiometric?: () => Promise<void>
    ): Promise<void> => {
      try {
        let login;
        try {
          setStep('building');
          const build = await building;
          setStep('saving');
          login = await build.commit(leaseRef.current);
        } catch (commitError) {
          if (rollbackBiometric) {
            try {
              await rollbackBiometric();
            } catch (rollbackError) {
              logger.error(
                'Failed to undo biometric credential:',
                rollbackError
              );
            }
          }
          throw commitError;
        }

        setStep('opening');
        try {
          // `fresh` hands over what creation already derived and proved;
          // loadAccount owns its key from here, success or failure.
          await useAccountStore.getState().loadAccount({
            type: 'password',
            password: readStagedPassword(account),
            fresh: login,
          });
        } catch (loginError) {
          // The account is durably created. Falling through sends the user
          // to the login screen, where the same credential unlocks it.
          logger.error('Automatic login after creation failed:', loginError);
        }
      } finally {
        wipeStagedAccounts([account]);
      }
      await onCompleteRef.current();
    },
    []
  );

  const createWithBiometrics = useCallback(async () => {
    setPhase('working');
    setError(null);
    await runCredentialOperation(async () => {
      const account = stageAccount(
        generateDefaultUsername(),
        generateAccountSecret()
      );
      // No password the user knows yet: Settings offers to set one.
      account.passwordless = true;
      // The secret already exists, so the account is built in memory while
      // the biometric prompt is on screen. Nothing is durable until the
      // prompt has succeeded and the build is committed.
      const building = buildOnboardingAccount(account);
      building.catch(() => {});
      const biometric = await configureBiometricLoginWithRollback(
        readStagedPassword(account),
        false
      );
      if (!biometric.success) {
        await building.then(
          build => build.abort(),
          () => {}
        );
        wipeStagedAccounts([account]);
        if (biometric.rollback) {
          try {
            await biometric.rollback();
          } catch (rollbackError) {
            logger.error(
              'Failed to restore biometric credential:',
              rollbackError
            );
          }
        }
        // Nothing was created. Offer the password path instead.
        setError(
          biometric.error === 'cancelled'
            ? null
            : t('create.biometric_fallback')
        );
        setPhase('form');
        return;
      }

      try {
        await createAndEnter(account, building, biometric.rollback);
      } catch {
        setError(t('create.failed'));
        setPhase('form');
      }
    });
  }, [createAndEnter, runCredentialOperation, t]);

  useEffect(() => {
    if (mode !== 'create' || startedRef.current) return;
    startedRef.current = true;
    void checkBiometricAvailability()
      .then(({ available }) => available)
      .catch(() => false)
      .then(available => {
        setBiometricAvailable(available);
        if (available) {
          void createWithBiometrics();
        } else {
          setPhase('form');
        }
      });
  }, [mode, createWithBiometrics]);

  // Creation cannot be interrupted once it started: swallow Android back.
  useEffect(() => {
    if (phase !== 'working' || Capacitor.getPlatform() !== 'android') return;

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
  }, [phase, t]);

  const handleSubmit = async (result: AccountCreationResult) => {
    setError(null);
    await runCredentialOperation(async () => {
      const account = stageAccount(
        generateDefaultUsername(),
        result.password,
        result.mnemonic
      );
      // Rethrows on failure so the form resets its own loading state.
      setPhase('working');
      try {
        await createAndEnter(account, buildOnboardingAccount(account));
      } catch (creationError) {
        setError(t('create.failed'));
        setPhase('form');
        throw creationError;
      }
    });
  };

  if (phase !== 'form') {
    return (
      <div className="bg-background flex items-center justify-center h-full">
        <div className="text-center">
          <PrivacyGraphic size={120} loading={true} />
          <p className="text-sm text-muted-foreground mt-4">
            {t(`create.progress_${step}`)}
          </p>
        </div>
      </div>
    );
  }

  return (
    <PageLayout
      header={
        <PageHeader
          title={t(
            mode === 'import' ? 'create.import_account' : 'create.title'
          )}
          onBack={onBack}
        />
      }
      className="app-max-w mx-auto"
      contentClassName="p-4"
    >
      {error && (
        <div className="p-4 mb-4 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg">
          <p className="text-red-600 dark:text-red-400 text-sm">{error}</p>
        </div>
      )}
      <AccountCreationForm
        onSubmit={handleSubmit}
        standalone={false}
        mode={mode}
        footer={
          mode === 'create' && biometricAvailable ? (
            <Button
              type="button"
              variant="ghost"
              size="custom"
              fullWidth
              className="h-11 mt-2 rounded-full text-sm font-medium"
              onClick={() => void createWithBiometrics()}
            >
              {t('create.use_biometrics')}
            </Button>
          ) : undefined
        }
      />
    </PageLayout>
  );
};

export default SecureAccountCreation;
