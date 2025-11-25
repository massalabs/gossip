import React, { useState } from 'react';
import { useAccountStore } from '../../stores/accountStore';
import PageHeader from '../ui/PageHeader';
import TabSwitcher from '../ui/TabSwitcher';
import Button from '../ui/Button';
import { Account } from '@massalabs/massa-web3';

interface AccountBackupProps {
  onBack: () => void;
}

const AccountBackup: React.FC<AccountBackupProps> = ({ onBack }) => {
  const { userProfile, showBackup } = useAccountStore();
  const [method, setMethod] = useState<'mnemonic' | 'privateKey'>('mnemonic');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const [password, setPassword] = useState('');
  const [passwordError, setPasswordError] = useState('');
  const [backupInfo, setBackupInfo] = useState<{
    mnemonic: string;
    account: Account;
  } | null>(null);
  const [privateKeyString, setPrivateKeyString] = useState<string | null>(null);

  const requiresPassword = userProfile?.security?.authMethod === 'password';

  const handleShow = async () => {
    try {
      setIsLoading(true);
      setError('');
      setPasswordError('');

      if (requiresPassword && !password.trim()) {
        setPasswordError('Password is required');
        return;
      }
      const backupInfo = await showBackup(
        requiresPassword ? password : undefined
      );
      setBackupInfo(backupInfo);
      setPrivateKeyString(backupInfo.account.privateKey.toString());
    } catch (e) {
      const message =
        e instanceof Error ? e.message : 'Failed to show backup information';
      setError(message);
      setPasswordError(message);
    } finally {
      setIsLoading(false);
    }
  };

  const copyText = async (text?: string | null) => {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
    } catch (_e) {
      // ignore
    }
  };

  return (
    <div className="bg-card h-full overflow-auto">
      <PageHeader title="Account Backup" onBack={onBack} />

      <div className="px-4 pb-20 ">
        {/* Tabs */}
        {backupInfo && (
          <div className="bg-white dark:bg-gray-800 rounded-lg p-6">
            <TabSwitcher
              options={[
                {
                  value: 'mnemonic',
                  label: 'Mnemonic',
                },
                {
                  value: 'privateKey',
                  label: 'Private Key',
                },
              ]}
              value={method}
              onChange={setMethod}
            />
          </div>
        )}

        {/* Input/auth */}
        {((method === 'mnemonic' && !backupInfo) ||
          (method === 'privateKey' && !privateKeyString)) && (
          <div className="bg-white dark:bg-gray-800 rounded-lg p-6">
            {requiresPassword ? (
              <>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                  Enter your password
                </label>
                <input
                  type="password"
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  className="w-full px-4 py-3 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-ring focus:border-transparent dark:bg-gray-700 dark:text-white placeholder-gray-500 dark:placeholder-gray-400 mb-4"
                  placeholder="Enter your password"
                />
                {(error || passwordError) && (
                  <div className="text-sm text-red-600 dark:text-red-400 mb-4">
                    {error || passwordError}
                  </div>
                )}
                <Button
                  onClick={handleShow}
                  disabled={isLoading || !password.trim()}
                  loading={isLoading}
                  variant="primary"
                  size="custom"
                  fullWidth
                  className="h-[54px] rounded-lg font-medium"
                >
                  {!isLoading && 'Show Backup'}
                </Button>
              </>
            ) : (
              <Button
                onClick={handleShow}
                disabled={isLoading}
                loading={isLoading}
                variant="primary"
                size="custom"
                fullWidth
                className="h-[54px] rounded-lg font-medium"
              >
                {!isLoading && 'Show Backup'}
              </Button>
            )}
          </div>
        )}

        {/* Display */}
        {method === 'mnemonic' && backupInfo && (
          <div className="bg-white dark:bg-gray-800 rounded-lg p-6">
            <div className="flex items-center justify-between mb-4">
              <h4 className="text-base font-semibold text-black dark:text-white">
                24-Word Mnemonic
              </h4>
              <Button
                onClick={() => copyText(backupInfo.mnemonic)}
                variant="ghost"
                size="custom"
                className="text-sm font-medium text-gray-600 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200 flex items-center gap-2 p-0"
              >
                <svg
                  className="w-4 h-4"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"
                  />
                </svg>
                Copy
              </Button>
            </div>
            <div className="bg-gray-50 dark:bg-gray-700 rounded-lg p-4 mb-4">
              <p className="text-sm text-black dark:text-white break-all leading-relaxed">
                {backupInfo.mnemonic}
              </p>
            </div>
            <p className="text-xs text-yellow-700 dark:text-yellow-400">
              Never share this information. Anyone with it can access your
              account.
            </p>
          </div>
        )}

        {method === 'privateKey' && privateKeyString && (
          <div className="bg-white dark:bg-gray-800 rounded-lg p-6">
            <div className="flex items-center justify-between mb-4">
              <h4 className="text-base font-semibold text-black dark:text-white">
                Private Key
              </h4>
              <Button
                onClick={() => copyText(privateKeyString)}
                variant="ghost"
                size="custom"
                className="text-sm font-medium text-gray-600 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200 flex items-center gap-2 p-0"
              >
                <svg
                  className="w-4 h-4"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"
                  />
                </svg>
                Copy
              </Button>
            </div>
            <div className="bg-gray-50 dark:bg-gray-700 rounded-lg p-4 mb-4">
              <p className="text-sm text-black dark:text-white break-all leading-relaxed">
                {privateKeyString}
              </p>
            </div>
            <div className="mb-4 p-3 bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-lg">
              <p className="text-xs text-yellow-800 dark:text-yellow-300 leading-relaxed">
                <strong>⚠️ Warning:</strong> This Massa private key cannot be
                used to restore your Gossip account. Use this only for external
                wallet compatibility. To restore your Gossip account, you must
                use the 24-word mnemonic phrase.
              </p>
            </div>
            <p className="text-xs text-yellow-700 dark:text-yellow-400">
              Never share this information. Anyone with it can access your
              account.
            </p>
          </div>
        )}
      </div>
    </div>
  );
};

export default AccountBackup;
