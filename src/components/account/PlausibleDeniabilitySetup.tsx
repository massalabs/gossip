import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Shield, CheckCircle, Plus, Check, ArrowRight } from 'react-feather';
import PageHeader from '../ui/PageHeader';
import PageLayout from '../ui/PageLayout';
import Button from '../ui/Button';
import HiddenAccountCreation from './HiddenAccountCreation';
import { useAccountStore } from '../../stores/accountStore';
import { getSdk } from '../../stores/sdkStore';
import { clearPendingMainCredentials } from '../../stores/pendingAccountSetup';

const MAX_SLOTS = 5;
// Bordercrypt slot indices are 0-based; UI slot numbers are 1-based display labels
const BORDERCRYPT_SLOTS = Array.from({ length: MAX_SLOTS }, (_, i) => i);

interface PendingAccount {
  username: string;
  password: string;
}

interface SlotAssignment {
  slotNumber: number;
  username: string;
}

type Phase = 'collecting' | 'creating' | 'summary';

interface PlausibleDeniabilitySetupProps {
  mainCredentials: PendingAccount;
  onComplete: () => void;
}

function shuffleArray<T>(arr: T[]): T[] {
  const result = [...arr];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

const PlausibleDeniabilitySetup: React.FC<PlausibleDeniabilitySetupProps> = ({
  mainCredentials,
  onComplete,
}) => {
  const { t } = useTranslation('auth');
  const initializeAccount = useAccountStore(s => s.initializeAccount);
  const createHiddenAccount = useAccountStore(s => s.createHiddenAccount);

  const [phase, setPhase] = useState<Phase>('collecting');
  const [accounts, setAccounts] = useState<PendingAccount[]>([mainCredentials]);
  const [addingAccount, setAddingAccount] = useState(false);
  const [slotAssignments, setSlotAssignments] = useState<SlotAssignment[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);

  const canAddMore = accounts.length < MAX_SLOTS;
  const hasHiddenAccounts = accounts.length > 1;

  const handleAddAccount = (creds: { username: string; password: string }) => {
    setAccounts(prev => [...prev, creds]);
    setAddingAccount(false);
  };

  const createAccounts = async () => {
    setPhase('creating');
    setIsCreating(true);
    setError(null);

    try {
      // Randomly assign bordercrypt slots (0-based) to accounts
      const bcSlots = shuffleArray(BORDERCRYPT_SLOTS);
      // UI display uses 1-based slot numbers
      const assignments: SlotAssignment[] = accounts.map((acc, i) => ({
        slotNumber: bcSlots[i] + 1,
        username: acc.username,
      }));

      // Create the main account (allocates bordercrypt slot 0)
      await initializeAccount(accounts[0].username, accounts[0].password);

      // Create hidden accounts in their own bordercrypt slots
      for (let i = 1; i < accounts.length; i++) {
        await createHiddenAccount(
          bcSlots[i],
          accounts[i].username,
          accounts[i].password
        );
      }

      // Lock and redirect to login
      const sdk = getSdk();
      if (sdk.isSessionOpen) {
        await sdk.closeSession();
      }
      await sdk.bordercryptLock();

      // Clear in-memory state — user will pick an account from login screen
      useAccountStore.setState({
        userProfile: null,
        encryptionKey: null,
        account: null,
        isLoading: false,
      });

      setSlotAssignments(assignments);
      setPhase('summary');
    } catch (err) {
      setError(err instanceof Error ? err.message : t('create.failed'));
      setPhase('collecting');
    } finally {
      clearPendingMainCredentials();
      setIsCreating(false);
    }
  };

  const handleSkip = async () => {
    setIsCreating(true);
    setError(null);

    try {
      await initializeAccount(accounts[0].username, accounts[0].password);
      onComplete();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('create.failed'));
    } finally {
      clearPendingMainCredentials();
      setIsCreating(false);
    }
  };

  // Sub-screen: adding a hidden account
  if (addingAccount) {
    return (
      <HiddenAccountCreation
        onComplete={handleAddAccount}
        onBack={() => setAddingAccount(false)}
      />
    );
  }

  // Phase: creating accounts (spinner)
  if (phase === 'creating') {
    return (
      <PageLayout
        header={<PageHeader title={t('plausible_deniability.title')} />}
        className="app-max-w mx-auto"
        contentClassName="flex items-center justify-center"
      >
        <div className="text-center">
          <div className="w-8 h-8 border-2 border-muted border-t-primary rounded-full animate-spin mx-auto mb-4" />
          <p className="text-muted-foreground">
            {t('plausible_deniability.creating')}
          </p>
        </div>
      </PageLayout>
    );
  }

  // Phase: summary (slot assignments)
  if (phase === 'summary') {
    return (
      <PageLayout
        header={<PageHeader title={t('plausible_deniability.title')} />}
        className="app-max-w mx-auto"
        contentClassName="p-4"
      >
        <div className="text-center mb-8">
          <div className="w-16 h-16 bg-green-100 dark:bg-green-900/30 rounded-full flex items-center justify-center mx-auto mb-4">
            <CheckCircle className="w-8 h-8 text-green-500" />
          </div>
          <h2 className="text-xl font-semibold text-foreground">
            {t('plausible_deniability.summary_title')}
          </h2>
        </div>

        <div className="bg-card rounded-xl border border-border p-4 mb-8">
          {slotAssignments.map(assignment => (
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
                  {t('plausible_deniability.slot', {
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
          {t('plausible_deniability.continue')}
        </Button>
      </PageLayout>
    );
  }

  // Phase: collecting accounts (no slot numbers)
  return (
    <PageLayout
      header={
        <PageHeader
          title={t('plausible_deniability.title')}
          onBack={handleSkip}
        />
      }
      className="app-max-w mx-auto"
      contentClassName="p-4"
    >
      {/* Info box */}
      <div className="p-4 border rounded-lg bg-blue-50 dark:bg-blue-900/20 border-blue-200 dark:border-blue-800 mb-6">
        <div className="flex items-start gap-3">
          <div className="shrink-0 mt-0.5">
            <Shield className="h-5 w-5 text-blue-500" />
          </div>
          <p className="text-sm text-blue-700 dark:text-blue-300 leading-relaxed">
            {t('plausible_deniability.info')}
          </p>
        </div>
      </div>

      {/* Accounts list — no slot numbers during collection */}
      <div className="mb-6">
        {accounts.map((acc, idx) => (
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

      {/* Actions */}
      <div className="space-y-3">
        {canAddMore && (
          <Button
            onClick={() => setAddingAccount(true)}
            variant="outline"
            size="custom"
            fullWidth
            className="h-12 rounded-full text-sm font-medium gap-2"
          >
            <Plus className="w-4 h-4" />
            {t('plausible_deniability.add_hidden')}
          </Button>
        )}

        {hasHiddenAccounts ? (
          <Button
            onClick={createAccounts}
            variant="primary"
            size="custom"
            fullWidth
            disabled={isCreating}
            className="h-12 rounded-full text-sm font-medium gap-2"
          >
            <Check className="w-4 h-4" />
            {t('plausible_deniability.done')}
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
            {!isCreating && t('plausible_deniability.skip')}
          </Button>
        )}
      </div>
    </PageLayout>
  );
};

export default PlausibleDeniabilitySetup;
