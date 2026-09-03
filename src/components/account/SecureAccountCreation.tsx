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
import type { OnboardingStorageModeLease } from '../../services/portableImportAuthorization';

type Step = 'form' | 'setup';

interface SecureAccountCreationProps {
  onComplete: () => void | Promise<void>;
  onBack: () => void;
  onCredentialOperationChange?: (active: boolean) => void;
  creationModeLease?: OnboardingStorageModeLease;
}

const SecureAccountCreation: React.FC<SecureAccountCreationProps> = ({
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
        stageAccount(result.username, result.password, result.mnemonic)
      );
      setStep('setup');
    } catch (err) {
      logger.error('Error staging account:', err);
      setError(err instanceof Error ? err.message : t('create.failed'));
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
        allowMnemonicImport
      />
    </PageLayout>
  );
};

export default SecureAccountCreation;
