import React, { useState } from 'react';
import { useAccountStore } from '../../stores/accountStore';
import { useAppStore } from '../../stores/appStore';
import { DevAccount } from '../../hooks/useDevAutoLogin';
import Button from '../ui/Button';

interface DevAccountPickerProps {
  accounts: DevAccount[];
  onSkip?: () => void;
}

const DevAccountPicker: React.FC<DevAccountPickerProps> = ({
  accounts,
  onSkip,
}) => {
  const [loading, setLoading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const restoreAccountFromMnemonic = useAccountStore(
    s => s.restoreAccountFromMnemonic
  );
  const devPassword = import.meta.env.VITE_DEV_PASSWORD;

  const handlePick = async (account: DevAccount) => {
    setLoading(account.name);
    setError(null);
    try {
      await restoreAccountFromMnemonic(account.name, account.mnemonic, {
        useBiometrics: false,
        password: devPassword || 'devdevde',
      });
      useAppStore.getState().setIsInitialized(true);
    } catch (err) {
      console.error('[dev] Failed to restore account:', err);
      setError(
        `Failed to restore ${account.name}: ${err instanceof Error ? err.message : 'Unknown error'}`
      );
      setLoading(null);
    }
  };

  return (
    <div className="flex h-full flex-col items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm space-y-6">
        <div className="text-center space-y-2">
          <div className="inline-block rounded-lg bg-amber-100 dark:bg-amber-900/30 px-3 py-1 text-xs font-mono text-amber-700 dark:text-amber-400">
            DEV MODE
          </div>
          <h1 className="text-2xl font-semibold text-foreground">
            Choose your identity
          </h1>
          <p className="text-sm text-muted-foreground">
            Each device picks a different one. Persists across reloads.
          </p>
        </div>

        <div className="space-y-3">
          {onSkip && (
            <Button
              variant="outline"
              fullWidth
              disabled={loading !== null}
              onClick={onSkip}
              className="rounded-2xl"
            >
              Continue normal onboarding
            </Button>
          )}
          {accounts.map(account => (
            <button
              key={account.name}
              onClick={() => handlePick(account)}
              disabled={loading !== null}
              className="w-full rounded-2xl border-2 border-border bg-card p-4 text-left transition-all hover:border-primary hover:bg-accent/50 disabled:opacity-50"
            >
              <div className="flex items-center justify-between">
                <span className="text-lg font-medium text-foreground">
                  {account.name}
                </span>
                {loading === account.name && (
                  <div className="h-5 w-5 animate-spin rounded-full border-2 border-primary border-t-transparent" />
                )}
              </div>
            </button>
          ))}
        </div>

        {error && (
          <div className="rounded-xl border-2 border-red-200 dark:border-red-800 bg-red-50/80 dark:bg-red-900/20 p-3">
            <p className="text-sm text-red-700 dark:text-red-300">{error}</p>
          </div>
        )}
      </div>
    </div>
  );
};

export default DevAccountPicker;
