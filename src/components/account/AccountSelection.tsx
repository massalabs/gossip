import React, { useState, useEffect, useCallback } from 'react';
import { Shield, Key, Check as CheckIcon, User, Plus } from 'react-feather';
import { useAccountStore } from '../../stores/accountStore';
import { UserProfile } from '@massalabs/gossip-sdk';
import { formatDate } from '../../utils/timeUtils';
import Button from '../ui/Button';
import PageHeader from '../ui/PageHeader';
import PageLayout from '../ui/PageLayout';

interface AccountSelectionProps {
  onBack: () => void;
  onCreateNewAccount: () => void;
  onAccountSelected: (account: UserProfile) => void;
}

const AccountSelection: React.FC<AccountSelectionProps> = ({
  onBack,
  onCreateNewAccount,
  onAccountSelected,
}) => {
  const { getAllAccounts } = useAccountStore();
  const [accounts, setAccounts] = useState<UserProfile[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedAccount, setSelectedAccount] = useState<UserProfile | null>(
    null
  );

  const loadAccounts = useCallback(async () => {
    try {
      setIsLoading(true);
      setError(null);

      // Get all user profiles from the store
      const allProfiles = await getAllAccounts();
      setAccounts(allProfiles);
    } catch (error) {
      console.error('Error loading accounts:', error);
      setError('Failed to load accounts. Please try again.');
    } finally {
      setIsLoading(false);
    }
  }, [getAllAccounts]);

  useEffect(() => {
    loadAccounts();
  }, [loadAccounts]);

  const handleAccountSelect = (account: UserProfile) => {
    // Immediately notify parent; authentication happens on WelcomeBack
    setSelectedAccount(account);
    onAccountSelected(account);
  };

  const formatAccountType = (account: UserProfile) => {
    const authMethod = account.security?.authMethod;
    if (authMethod === 'capacitor' || authMethod === 'webauthn') {
      return 'Biometric';
    } else {
      return 'Password';
    }
  };

  const getAccountIcon = (account: UserProfile) => {
    const authMethod = account.security?.authMethod;
    if (authMethod === 'capacitor' || authMethod === 'webauthn') {
      return (
        <div className="w-10 h-10 bg-primary/10 rounded-full flex items-center justify-center shrink-0">
          <Shield className="w-5 h-5 text-primary" />
        </div>
      );
    } else {
      return (
        <div className="w-10 h-10 bg-muted rounded-full flex items-center justify-center shrink-0">
          <Key className="w-5 h-5 text-muted-foreground" />
        </div>
      );
    }
  };

  if (isLoading) {
    return (
      <PageLayout
        header={<PageHeader title="Select Account" onBack={onBack} />}
        className="app-max-w mx-auto"
        contentClassName="flex items-center justify-center"
      >
        <div className="text-center">
          <div className="w-8 h-8 border-2 border-muted border-t-primary rounded-full animate-spin mx-auto mb-4"></div>
          <p className="text-muted-foreground">Loading accounts...</p>
        </div>
      </PageLayout>
    );
  }

  return (
    <PageLayout
      header={<PageHeader title="Select Account" onBack={onBack} />}
      className="app-max-w mx-auto"
      contentClassName="p-4"
    >
      {error && (
        <div className="mb-4 p-4 bg-destructive/10 border border-destructive rounded-lg">
          <p className="text-destructive text-sm">{error}</p>
        </div>
      )}

      {accounts.length === 0 ? (
        <div className="text-center py-12">
          <div className="w-16 h-16 bg-muted rounded-full flex items-center justify-center mx-auto mb-4">
            <User className="w-8 h-8 text-muted-foreground" />
          </div>
          <h3 className="text-xl font-semibold text-foreground mb-2">
            No Accounts Found
          </h3>
          <p className="text-muted-foreground mb-6">
            You don't have any accounts yet. Create a new account to get
            started.
          </p>
          <Button
            onClick={onCreateNewAccount}
            variant="primary"
            size="custom"
            fullWidth
            className="h-12 text-sm font-medium rounded-full"
          >
            <Plus className="w-4 h-4 mr-2" />
            Create New Account
          </Button>
        </div>
      ) : (
        <div className="space-y-4">
          {/* Create New Account Button */}
          <Button
            onClick={onCreateNewAccount}
            variant="outline"
            size="custom"
            fullWidth
            className="h-12 text-sm font-medium rounded-full"
          >
            <Plus className="w-4 h-4 mr-2" />
            Create New Account
          </Button>

          {/* Account List */}
          <div className="space-y-3">
            {accounts.map(account => (
              <div
                key={account.userId}
                className={`p-4 border rounded-lg cursor-pointer transition-all duration-200 bg-card hover:shadow-sm ${
                  selectedAccount?.userId === account.userId
                    ? 'border-primary bg-primary/10 shadow-sm'
                    : 'border-border hover:border-primary/50'
                }`}
                onClick={() => handleAccountSelect(account)}
              >
                <div className="flex items-center gap-3">
                  {getAccountIcon(account)}
                  <div className="flex-1 min-w-0">
                    <h3 className="font-semibold text-foreground truncate">
                      {account.username}
                    </h3>
                    <p className="text-sm text-muted-foreground">
                      {formatAccountType(account)} • Created{' '}
                      {account.createdAt
                        ? formatDate(new Date(account.createdAt))
                        : 'Unknown'}
                    </p>
                  </div>
                  {selectedAccount?.userId === account.userId && (
                    <div className="w-5 h-5 bg-primary rounded-full flex items-center justify-center shrink-0">
                      <CheckIcon className="w-3 h-3 text-primary-foreground" />
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </PageLayout>
  );
};

export default AccountSelection;
