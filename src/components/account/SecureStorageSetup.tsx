import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Shield, CheckCircle, Plus, Check, ArrowRight } from 'react-feather';
import PageHeader from '../ui/PageHeader';
import PageLayout from '../ui/PageLayout';
import Button from '../ui/Button';
import HiddenAccountCreation from './HiddenAccountCreation';
import { useAccountStore } from '../../stores/accountStore';
import { getSdk } from '../../stores/sdkStore';
import type { SecureStorageSetupCredentials } from '../../stores/secureStorageSetupContext';

const MAX_SLOTS = 5;

interface SlotAssignment {
  slotNumber: number;
  username: string;
}

type Phase = 'initializing' | 'collecting' | 'creating' | 'summary';

interface SecureStorageSetupProps {
  mainCredentials: SecureStorageSetupCredentials;
  onComplete: () => void;
}

function pickRandomSlot(available: number[]): {
  slot: number;
  remaining: number[];
} {
  const idx = Math.floor(Math.random() * available.length);
  const slot = available[idx];
  const remaining = available.filter((_, i) => i !== idx);
  return { slot, remaining };
}

const SecureStorageSetup: React.FC<SecureStorageSetupProps> = ({
  mainCredentials,
  onComplete,
}) => {
  const { t } = useTranslation('auth');
  const createHiddenAccount = useAccountStore(s => s.createHiddenAccount);

  const [phase, setPhase] = useState<Phase>('collecting');
  // slotNumber is 1-indexed for display (slot + 1). Main account is in storage slot 0.
  // availableSlots are 0-indexed storage slots passed to createHiddenAccount.
  const [createdAccounts, setCreatedAccounts] = useState<SlotAssignment[]>([
    { slotNumber: 1, username: mainCredentials.username },
  ]);
  const [availableSlots, setAvailableSlots] = useState<number[]>([1, 2, 3, 4]);
  const [addingAccount, setAddingAccount] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);

  const canAddMore = createdAccounts.length < MAX_SLOTS;

  const handleAddAccount = async (creds: {
    username: string;
    password: string;
  }) => {
    setAddingAccount(false);
    setIsCreating(true);
    setError(null);

    try {
      const { slot, remaining } = pickRandomSlot(availableSlots);

      await createHiddenAccount(slot, creds.username, creds.password);

      await getSdk().flush();

      setCreatedAccounts(prev => [
        ...prev,
        { slotNumber: slot + 1, username: creds.username },
      ]);
      setAvailableSlots(remaining);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('create.failed'));
    } finally {
      setIsCreating(false);
    }
  };

  const finalize = async () => {
    setPhase('creating');
    setIsCreating(true);
    setError(null);

    try {
      const sdk = getSdk();
      if (sdk.isSessionOpen) {
        await sdk.closeSession();
      }
      await sdk.secureStorageLock();

      useAccountStore.setState({
        userProfile: null,
        encryptionKey: null,
        account: null,
        isLoading: false,
      });

      setPhase('summary');
    } catch (err) {
      setError(err instanceof Error ? err.message : t('create.failed'));
      setPhase('collecting');
    } finally {
      setIsCreating(false);
    }
  };

  const handleSkip = async () => {
    if (createdAccounts.length > 1) {
      // Hidden accounts exist — must lock secure storage before leaving
      await finalize();
    } else {
      // Only main account, no hidden — stay authenticated
      onComplete();
    }
  };

  if (addingAccount) {
    return (
      <HiddenAccountCreation
        onComplete={handleAddAccount}
        onBack={() => setAddingAccount(false)}
      />
    );
  }

  if (phase === 'initializing' || phase === 'creating') {
    return (
      <PageLayout
        header={<PageHeader title={t('secure_storage.title')} />}
        className="app-max-w mx-auto"
        contentClassName="flex items-center justify-center"
      >
        <div className="text-center">
          <div className="w-8 h-8 border-2 border-muted border-t-primary rounded-full animate-spin mx-auto mb-4" />
          <p className="text-muted-foreground">
            {t('secure_storage.creating')}
          </p>
        </div>
      </PageLayout>
    );
  }

  if (phase === 'summary') {
    return (
      <PageLayout
        header={<PageHeader title={t('secure_storage.title')} />}
        className="app-max-w mx-auto"
        contentClassName="p-4"
      >
        <div className="text-center mb-8">
          <div className="w-16 h-16 bg-green-100 dark:bg-green-900/30 rounded-full flex items-center justify-center mx-auto mb-4">
            <CheckCircle className="w-8 h-8 text-green-500" />
          </div>
          <h2 className="text-xl font-semibold text-foreground">
            {t('secure_storage.summary_title')}
          </h2>
        </div>

        <div className="bg-card rounded-xl border border-border p-4 mb-8">
          {createdAccounts.map(assignment => (
            <div
              key={assignment.slotNumber}
              className="flex items-center justify-between py-3 px-2"
            >
              <span className="text-sm font-medium text-foreground">
                {assignment.username}
              </span>
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <ArrowRight className="w-3 h-3" />
                <span>
                  {t('secure_storage.slot', {
                    number: assignment.slotNumber,
                  })}
                </span>
              </div>
            </div>
          ))}
        </div>

        <Button
          onClick={onComplete}
          variant="primary"
          size="custom"
          fullWidth
          className="h-12 rounded-full text-sm font-medium"
        >
          {t('secure_storage.continue')}
        </Button>
      </PageLayout>
    );
  }

  const hasHiddenAccounts = createdAccounts.length > 1;

  return (
    <PageLayout
      header={
        <PageHeader title={t('secure_storage.title')} onBack={handleSkip} />
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
            {t('secure_storage.info')}
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
        {canAddMore && (
          <Button
            onClick={() => setAddingAccount(true)}
            variant="outline"
            size="custom"
            fullWidth
            disabled={isCreating}
            className="h-12 rounded-full text-sm font-medium gap-2"
          >
            <Plus className="w-4 h-4" />
            {t('secure_storage.add_hidden')}
          </Button>
        )}

        {hasHiddenAccounts ? (
          <Button
            onClick={finalize}
            variant="primary"
            size="custom"
            fullWidth
            disabled={isCreating}
            className="h-12 rounded-full text-sm font-medium gap-2"
          >
            <Check className="w-4 h-4" />
            {t('secure_storage.done')}
          </Button>
        ) : (
          <Button
            onClick={handleSkip}
            variant="outline"
            size="custom"
            fullWidth
            disabled={isCreating}
            loading={isCreating}
            className="h-12 rounded-full text-sm font-medium"
          >
            {!isCreating && t('secure_storage.skip')}
          </Button>
        )}
      </div>
    </PageLayout>
  );
};

export default SecureStorageSetup;
