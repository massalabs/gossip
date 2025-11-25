import React, { useState, useEffect, useCallback } from 'react';
import { useAccountStore } from '../../stores/accountStore';
import { UserProfile } from '../../db';
import { formatDate } from '../../utils/timeUtils';
import Button from '../ui/Button';

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
        <div className="w-10 h-10 bg-blue-100 dark:bg-blue-900/40 rounded-full flex items-center justify-center">
          <svg
            className="w-5 h-5 text-blue-600 dark:text-blue-400"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"
            />
          </svg>
        </div>
      );
    } else {
      return (
        <div className="w-10 h-10 bg-gray-100 dark:bg-gray-700 rounded-full flex items-center justify-center">
          <svg
            className="w-5 h-5 text-gray-600 dark:text-gray-300"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z"
            />
          </svg>
        </div>
      );
    }
  };

  if (isLoading) {
    return (
      <div className="bg-background flex items-center justify-center">
        <div className="text-center">
          <div className="w-8 h-8 border-2 border-gray-300 dark:border-gray-700 border-t-blue-600 rounded-full animate-spin mx-auto mb-4"></div>
          <p className="text-gray-600 dark:text-gray-300">
            Loading accounts...
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-background">
      <div className="max-w-md mx-auto">
        {/* Header */}
        <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-800">
          <div className="flex items-center gap-4">
            <Button
              onClick={onBack}
              variant="ghost"
              size="custom"
              className="p-2 text-gray-600 dark:text-gray-300 hover:text-gray-800 dark:hover:text-gray-100"
            >
              <svg
                className="w-6 h-6"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M15 19l-7-7 7-7"
                />
              </svg>
            </Button>
            <h1 className="text-xl font-semibold text-black dark:text-white">
              Select Account
            </h1>
          </div>
        </div>

        {/* Content */}
        <div className="px-4 py-6">
          {error && (
            <div className="mb-4 p-4 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg">
              <p className="text-red-600 dark:text-red-400 text-sm">{error}</p>
            </div>
          )}

          {accounts.length === 0 ? (
            <div className="text-center py-8">
              <div className="w-16 h-16 bg-gray-100 dark:bg-gray-700 rounded-full flex items-center justify-center mx-auto mb-4">
                <svg
                  className="w-8 h-8 text-gray-400 dark:text-gray-300"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"
                  />
                </svg>
              </div>
              <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-2">
                No Accounts Found
              </h3>
              <p className="text-gray-600 dark:text-gray-300 mb-6">
                You don't have any accounts yet. Create a new account to get
                started.
              </p>
              <Button
                onClick={onCreateNewAccount}
                variant="primary"
                size="custom"
                fullWidth
                className="h-12 bg-blue-600 dark:bg-blue-700 hover:bg-blue-700 dark:hover:bg-blue-800 text-white text-sm font-medium rounded-lg"
              >
                Create New Account
              </Button>
            </div>
          ) : (
            <div className="space-y-4">
              <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">
                Choose an Account
              </h2>

              {/* Account List */}
              <div className="space-y-3">
                {accounts.map(account => (
                  <div
                    key={account.userId}
                    className={`p-4 border rounded-lg cursor-pointer transition-colors ${
                      selectedAccount?.userId === account.userId
                        ? 'border-blue-500 dark:border-blue-400 bg-blue-50 dark:bg-blue-900/20'
                        : 'border-gray-200 dark:border-gray-700 hover:border-gray-300 dark:hover:border-gray-600'
                    }`}
                    onClick={() => handleAccountSelect(account)}
                  >
                    <div className="flex items-center gap-3">
                      {getAccountIcon(account)}
                      <div className="flex-1">
                        <h3 className="font-semibold text-gray-900 dark:text-white">
                          {account.username}
                        </h3>
                        <p className="text-sm text-gray-600 dark:text-gray-400">
                          {formatAccountType(account)} • Created{' '}
                          {account.createdAt
                            ? formatDate(new Date(account.createdAt))
                            : 'Unknown'}
                        </p>
                      </div>
                      {selectedAccount?.userId === account.userId && (
                        <div className="w-5 h-5 bg-blue-600 dark:bg-blue-500 rounded-full flex items-center justify-center">
                          <svg
                            className="w-3 h-3 text-white"
                            fill="currentColor"
                            viewBox="0 0 20 20"
                          >
                            <path
                              fillRule="evenodd"
                              d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                              clipRule="evenodd"
                            />
                          </svg>
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>

              {/* Authentication happens on WelcomeBack after selection */}

              {/* Create New Account Button */}
              <Button
                onClick={onCreateNewAccount}
                variant="outline"
                size="custom"
                fullWidth
                className="h-12 rounded-lg text-sm font-medium"
              >
                Create New Account
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default AccountSelection;
