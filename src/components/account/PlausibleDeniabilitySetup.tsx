import React, { useState, useEffect, useRef } from 'react';
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
const ALL_SLOTS = Array.from({ length: MAX_SLOTS }, (_, i) => i);

interface SlotAssignment {
  slotNumber: number;
  username: string;
}

type Phase = 'initializing' | 'collecting' | 'creating' | 'summary';

interface PlausibleDeniabilitySetupProps {
  mainCredentials: { username: string; password: string };
  onComplete: () => void;
}

/** Pick a random element from `available`, return it and the remaining array. */
function pickRandomSlot(available: number[]): {
  slot: number;
  remaining: number[];
} {
  const idx = Math.floor(Math.random() * available.length);
  const slot = available[idx];
  const remaining = available.filter((_, i) => i !== idx);
  return { slot, remaining };
}

const PlausibleDeniabilitySetup: React.FC<PlausibleDeniabilitySetupProps> = ({
  mainCredentials,
  onComplete,
}) => {
  const { t } = useTranslation('auth');
  const initializeAccount = useAccountStore(s => s.initializeAccount);
  const createHiddenAccount = useAccountStore(s => s.createHiddenAccount);

  const [phase, setPhase] = useState<Phase>('initializing');
  const [createdAccounts, setCreatedAccounts] = useState<SlotAssignment[]>([]);
  const [availableSlots, setAvailableSlots] = useState<number[]>(ALL_SLOTS);
  const [addingAccount, setAddingAccount] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);

  // Guard against double-execution of the init effect in StrictMode
  const initStarted = useRef(false);

  const canAddMore = createdAccounts.length < MAX_SLOTS;

  // --- Phase: initializing --- Create the main account immediately on mount
  useEffect(() => {
    if (initStarted.current) return;
    initStarted.current = true;

    const createMainAccount = async () => {
      try {
        // Pick a random slot for the main account
        const { slot, remaining } = pickRandomSlot(availableSlots);

        await initializeAccount(
          mainCredentials.username,
          mainCredentials.password
        );

        // Password used — clear immediately
        clearPendingMainCredentials();

        setCreatedAccounts([
          { slotNumber: slot + 1, username: mainCredentials.username },
        ]);
        setAvailableSlots(remaining);
        setPhase('collecting');
      } catch (err) {
        setError(err instanceof Error ? err.message : t('create.failed'));
        // Stay on initializing so the user sees the error; they can go back
        setPhase('collecting');
      }
    };

    void createMainAccount();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- Handle adding a hidden account (called by HiddenAccountCreation) ---
  const handleAddAccount = async (creds: {
    username: string;
    password: string;
  }) => {
    setAddingAccount(false);
    setIsCreating(true);
    setError(null);

    try {
      // Pick a random slot from the remaining available slots
      const { slot, remaining } = pickRandomSlot(availableSlots);

      await createHiddenAccount(slot, creds.username, creds.password);
      // Password used and discarded — creds goes out of scope

      setCreatedAccounts(prev => [
        ...prev,
        { slotNumber: slot + 1, username: creds.username },
      ]);
      setAvailableSlots(remaining);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('create.failed'));
      // Already-created accounts are preserved — only this one failed
    } finally {
      setIsCreating(false);
    }
  };

  // --- "Done" button: lock bordercrypt + show summary ---
  const finalize = async () => {
    setPhase('creating');
    setIsCreating(true);
    setError(null);

    try {
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

      setPhase('summary');
    } catch (err) {
      setError(err instanceof Error ? err.message : t('create.failed'));
      setPhase('collecting');
    } finally {
      setIsCreating(false);
    }
  };

  // --- "Skip" / back button: if main account already created, just complete ---
  const handleSkip = async () => {
    if (createdAccounts.length === 0) {
      // Main account not created yet (init failed) — try creating it now
      setIsCreating(true);
      setError(null);
      try {
        await initializeAccount(
          mainCredentials.username,
          mainCredentials.password
        );
        clearPendingMainCredentials();
        onComplete();
      } catch (err) {
        setError(err instanceof Error ? err.message : t('create.failed'));
      } finally {
        setIsCreating(false);
      }
    } else {
      // Main account already exists — just complete without PD
      onComplete();
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

  // Phase: initializing (creating main account spinner)
  if (phase === 'initializing') {
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

  // Phase: creating (locking bordercrypt spinner)
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
  const hasHiddenAccounts = createdAccounts.length > 1;

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

      {/* Actions */}
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
            {t('plausible_deniability.add_hidden')}
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
