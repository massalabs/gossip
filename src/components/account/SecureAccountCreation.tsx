import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAccountStore } from '../../stores/accountStore';
import PageHeader from '../ui/PageHeader';
import PageLayout from '../ui/Layout/PageLayout';
import { PrivacyGraphic } from '../graphics';
import AccountCreationForm, {
  AccountCreationResult,
} from './AccountCreationForm';
import SecureAccountSetup from './SecureAccountSetup';

type Step = 'form' | 'creating' | 'setup';

interface SecureAccountCreationProps {
  onComplete: () => void;
  onBack: () => void;
}

const SecureAccountCreation: React.FC<SecureAccountCreationProps> = ({
  onComplete,
  onBack,
}) => {
  const { t } = useTranslation('auth');
  const { initializeAccount, initializeAccountWithBiometrics } =
    useAccountStore();
  const [step, setStep] = useState<Step>('form');
  const [error, setError] = useState<string | null>(null);
  const [mainUsername, setMainUsername] = useState('');

  const handleSubmit = async (result: AccountCreationResult) => {
    setError(null);

    try {
      if (result.useBiometrics) {
        // Form stays visible while OS biometric prompt overlays.
        // AccountCreationForm shows a button spinner via its own isCreating state.
        await initializeAccountWithBiometrics(
          result.username,
          result.iCloudSync
        );
      } else {
        // Password: show full-screen loading immediately
        setStep('creating');
        await initializeAccount(result.username, result.password!);
      }
      setMainUsername(result.username);
      setStep('setup');
    } catch (err) {
      console.error('Error creating account:', err);
      setError(err instanceof Error ? err.message : t('create.failed'));
      setStep('form');
    }
  };

  if (step === 'creating') {
    return (
      <div className="bg-background flex items-center justify-center h-full">
        <div className="text-center">
          <PrivacyGraphic size={120} loading={true} />
          <p className="text-sm text-muted-foreground mt-4">
            {t('create.creating')}
          </p>
        </div>
      </div>
    );
  }

  if (step === 'setup') {
    return (
      <SecureAccountSetup mainUsername={mainUsername} onComplete={onComplete} />
    );
  }

  // step === 'form'
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
      <AccountCreationForm onSubmit={handleSubmit} standalone={false} />
    </PageLayout>
  );
};

export default SecureAccountCreation;
