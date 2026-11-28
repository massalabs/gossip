import { logger } from '../../utils/logger.ts';
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import PageHeader from '../ui/PageHeader';
import PageLayout from '../ui/Layout/PageLayout';
import AccountCreationForm, {
  AccountCreationResult,
} from './AccountCreationForm';
import SecureAccountSetup from './SecureAccountSetup';
import { stageAccount, StagedAccount } from './stagedAccount';
import { generateDefaultUsername } from '../../utils/validation';
import type { OnboardingStorageModeLease } from '../../services/portableImportAuthorization';

type Step = 'form' | 'setup';

interface MultiAccountCreationProps {
  onComplete: () => void | Promise<void>;
  onBack: () => void;
  onCredentialOperationChange?: (active: boolean) => void;
  creationModeLease?: OnboardingStorageModeLease;
}

/**
 * Advanced onboarding: stage several isolated accounts, each with its own
 * password, and commit them together so that none can be told apart from an
 * unused slot. Ends on the login screen, where the password typed selects
 * the account.
 */
const MultiAccountCreation: React.FC<MultiAccountCreationProps> = ({
  onComplete,
  onBack,
  onCredentialOperationChange,
  creationModeLease,
}) => {
  const { t } = useTranslation('auth');
  const [step, setStep] = useState<Step>('form');
  const [error, setError] = useState<string | null>(null);
  const [initialAccount, setInitialAccount] = useState<StagedAccount | null>(
    null
  );

  const handleSubmit = async (result: AccountCreationResult) => {
    setError(null);

    try {
      setInitialAccount(
        stageAccount(
          result.username ?? generateDefaultUsername(),
          result.password,
          result.mnemonic
        )
      );
      setStep('setup');
    } catch (err) {
      logger.error('Error staging account:', err);
      setError(err instanceof Error ? err.message : t('create.failed'));
      setStep('form');
      // Rethrow so AccountCreationForm's doSubmit takes its error path and
      // resets its own isCreating/loading state
      throw err;
    }
  };

  const handleRestart = (message: string) => {
    setInitialAccount(null);
    setError(message);
    setStep('form');
  };

  if (step === 'setup' && initialAccount) {
    return (
      <SecureAccountSetup
        initialAccount={initialAccount}
        onComplete={onComplete}
        onRestart={handleRestart}
        onCredentialOperationChange={onCredentialOperationChange}
        creationModeLease={creationModeLease}
      />
    );
  }

  return (
    <PageLayout
      header={<PageHeader title={t('create.title')} onBack={onBack} />}
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
        multiAccount
      />
    </PageLayout>
  );
};

export default MultiAccountCreation;
