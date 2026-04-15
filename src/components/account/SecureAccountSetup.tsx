import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Shield, CheckCircle, Plus, Check } from 'react-feather';
import { useAccountStore } from '../../stores/accountStore';
import { MAX_SECURE_ACCOUNTS } from '../../config/features';
import PageHeader from '../ui/PageHeader';
import PageLayout from '../ui/Layout/PageLayout';
import Button from '../ui/Button';
import { PrivacyGraphic } from '../graphics';
import SecureAccountForm from './SecureAccountForm';

interface CreatedAccount {
  username: string;
}

interface SecureAccountSetupProps {
  mainUsername: string;
  onComplete: () => void;
}

const SecureAccountSetup: React.FC<SecureAccountSetupProps> = ({
  mainUsername,
  onComplete,
}) => {
  const { t } = useTranslation('auth');
  const { initializeAccount, logout } = useAccountStore();

  const [createdAccounts, setCreatedAccounts] = useState<CreatedAccount[]>([
    { username: mainUsername },
  ]);
  const [addingAccount, setAddingAccount] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [isFinalizing, setIsFinalizing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canAddMore = createdAccounts.length < MAX_SECURE_ACCOUNTS;

  const handleAddAccount = async (creds: {
    username: string;
    password: string;
  }) => {
    setAddingAccount(false);
    setIsCreating(true);
    setError(null);

    try {
      await initializeAccount(creds.username, creds.password);
      setCreatedAccounts(prev => [...prev, { username: creds.username }]);
    } catch (err) {
      console.error('Error creating secure account:', err);
      setError(err instanceof Error ? err.message : t('create.failed'));
    } finally {
      setIsCreating(false);
    }
  };

  const handleFinalize = async () => {
    setIsFinalizing(true);
    setError(null);

    try {
      // Close the current session — user will log in fresh from SecureLogin
      await logout({ lockedByUser: false });
      onComplete();
    } catch (err) {
      console.error('Error finalizing setup:', err);
      setError(err instanceof Error ? err.message : t('create.failed'));
      setIsFinalizing(false);
    }
  };

  const handleSkip = () => {
    if (createdAccounts.length > 1) {
      // Multiple accounts created — finalize (logout + redirect to login)
      handleFinalize();
    } else {
      // Only main account — stay authenticated
      onComplete();
    }
  };

  if (addingAccount) {
    return (
      <SecureAccountForm
        onSubmit={handleAddAccount}
        onBack={() => setAddingAccount(false)}
      />
    );
  }

  if (isCreating || isFinalizing) {
    return (
      <div className="bg-background flex items-center justify-center h-full">
        <div className="text-center">
          <PrivacyGraphic size={120} loading={true} />
          <p className="text-sm text-muted-foreground mt-4">
            {isFinalizing ? t('secure_setup.finalizing') : t('create.creating')}
          </p>
        </div>
      </div>
    );
  }

  const hasAdditionalAccounts = createdAccounts.length > 1;

  return (
    <PageLayout
      header={
        <PageHeader title={t('secure_setup.title')} onBack={handleSkip} />
      }
      className="app-max-w mx-auto"
      contentClassName="p-4"
    >
      <div className="p-4 border rounded-lg bg-blue-50 dark:bg-blue-900/20 border-blue-200 dark:border-blue-800 mb-6">
        <div className="flex items-start gap-3">
          <div className="shrink-0 mt-0.5">
            <Shield className="h-5 w-5 text-blue-500" />
          </div>
          <p className="text-sm text-blue-700 dark:text-blue-300 leading-relaxed">
            {t('secure_setup.info')}
          </p>
        </div>
      </div>

      <div className="mb-6">
        {createdAccounts.map((acc, idx) => (
          <div key={idx} className="flex items-center py-3 px-2">
            <CheckCircle className="w-4 h-4 text-green-500 mr-3 shrink-0" />
            <span className="text-sm text-foreground font-medium">
              {acc.username}
            </span>
          </div>
        ))}
      </div>

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
            {t('secure_setup.add_account')}
          </Button>
        ) : (
          <p className="text-sm text-muted-foreground text-center">
            {t('secure_setup.max_reached')}
          </p>
        )}

        {hasAdditionalAccounts ? (
          <Button
            onClick={handleFinalize}
            variant="primary"
            size="custom"
            fullWidth
            className="h-12 rounded-full text-sm font-medium gap-2"
          >
            <Check className="w-4 h-4" />
            {t('secure_setup.done')}
          </Button>
        ) : (
          <Button
            onClick={handleSkip}
            variant="outline"
            size="custom"
            fullWidth
            className="h-12 rounded-full text-sm font-medium"
          >
            {t('secure_setup.skip')}
          </Button>
        )}
      </div>
    </PageLayout>
  );
};

export default SecureAccountSetup;
