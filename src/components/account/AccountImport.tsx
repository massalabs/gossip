import React, { useState } from 'react';
import { useAccountStore } from '../../stores/accountStore';
import { validateMnemonic } from '../../crypto/bip39';
import { validatePassword } from '../../utils/validation';
import Button from '../ui/Button';

interface AccountImportProps {
  onBack: () => void;
  onComplete: () => void;
}

const AccountImport: React.FC<AccountImportProps> = ({
  onBack,
  onComplete,
}) => {
  const { restoreAccountFromMnemonic } = useAccountStore();
  const [mnemonic, setMnemonic] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [useBiometrics, setUseBiometrics] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [error, setError] = useState('');
  const [step, setStep] = useState<'mnemonic' | 'details'>('mnemonic');

  const handleMnemonicSubmit = () => {
    setError('');
    if (!mnemonic.trim()) {
      setError('Please enter a mnemonic phrase');
      return;
    }
    const trimmedMnemonic = mnemonic.trim().toLowerCase();
    if (!validateMnemonic(trimmedMnemonic)) {
      setError(
        'Invalid mnemonic phrase. Please check your words and try again.'
      );
      return;
    }
    setMnemonic(trimmedMnemonic);
    setStep('details');
  };

  const handleImport = async () => {
    try {
      setIsImporting(true);
      setError('');

      // Validate inputs
      if (!username.trim()) {
        setError('Username is required');
        return;
      }

      if (username.length < 3) {
        setError('Username must be at least 3 characters long');
        return;
      }

      if (!useBiometrics) {
        if (!password.trim()) {
          setError('Password is required');
          return;
        }

        const pwdValidation = validatePassword(password);
        if (!pwdValidation.valid) {
          setError(pwdValidation.error || 'Invalid password');
          return;
        }
      }

      // Restore account from mnemonic
      if (useBiometrics) {
        await restoreAccountFromMnemonic(username, mnemonic, {
          useBiometrics: true,
        });
      } else {
        await restoreAccountFromMnemonic(username, mnemonic, {
          useBiometrics: false,
          password,
        });
      }

      onComplete();
    } catch (error) {
      console.error('Error importing account:', error);
      setError(
        error instanceof Error
          ? error.message
          : 'Failed to import account. Please try again.'
      );
    } finally {
      setIsImporting(false);
    }
  };

  const renderMnemonicStep = () => (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-semibold text-black dark:text-white mb-2">
          Import with Mnemonic
        </h3>
        <p className="text-sm text-gray-600 dark:text-gray-300 leading-relaxed">
          Enter your 24-word mnemonic phrase to import your account. Make sure
          to enter the words in the correct order.
        </p>
        <div className="mt-4">
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
            Mnemonic Phrase
          </label>
          <textarea
            value={mnemonic}
            onChange={e => setMnemonic(e.target.value)}
            placeholder="Enter your mnemonic phrase here..."
            className="w-full h-32 px-4 py-3 border border-gray-200 dark:border-gray-700 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm resize-none text-black dark:text-white bg-white dark:bg-gray-800 placeholder-gray-500 dark:placeholder-gray-400"
            disabled={isImporting}
          />
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
            Separate words with spaces. The phrase is case-insensitive.
          </p>
        </div>
      </div>

      {error && (
        <div className="p-4 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg">
          <p className="text-red-600 dark:text-red-400 text-sm">{error}</p>
        </div>
      )}

      <div className="space-y-3">
        <Button
          onClick={handleMnemonicSubmit}
          disabled={isImporting || !mnemonic.trim()}
          variant="primary"
          size="custom"
          fullWidth
          className="h-12 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg"
        >
          Continue
        </Button>
      </div>
    </div>
  );

  const renderDetailsStep = () => (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-semibold text-black mb-2">
          Account Details
        </h3>
        <p className="text-sm text-gray-600 leading-relaxed">
          Choose a username and security method for your imported account.
        </p>
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
          Username
        </label>
        <input
          type="text"
          value={username}
          onChange={e => setUsername(e.target.value)}
          placeholder="Enter your username"
          className="w-full h-12 px-4 border border-gray-200 dark:border-gray-700 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm text-black dark:text-white bg-white dark:bg-gray-800 placeholder-gray-500 dark:placeholder-gray-400"
          disabled={isImporting}
        />
      </div>

      {/* Security Method Selection */}
      <div>
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-3">
          Security Method
        </label>
        <div className="space-y-3">
          <label className="flex items-center p-4 border border-gray-200 dark:border-gray-700 rounded-lg cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800">
            <input
              type="radio"
              name="security"
              checked={useBiometrics}
              onChange={() => setUseBiometrics(true)}
              className="w-4 h-4 text-blue-600 border-gray-300 focus:ring-blue-500"
            />
            <div className="ml-3">
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 bg-blue-100 dark:bg-blue-900/40 rounded-full flex items-center justify-center">
                  <svg
                    className="w-4 h-4 text-blue-600"
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
                <span className="font-medium text-gray-900 dark:text-gray-100">
                  Biometric Authentication
                </span>
              </div>
              <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
                Use fingerprint, face ID, or Windows Hello
              </p>
            </div>
          </label>

          <label className="flex items-center p-4 border border-gray-200 dark:border-gray-700 rounded-lg cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800">
            <input
              type="radio"
              name="security"
              checked={!useBiometrics}
              onChange={() => setUseBiometrics(false)}
              className="w-4 h-4 text-blue-600 border-gray-300 focus:ring-blue-500"
            />
            <div className="ml-3">
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 bg-gray-100 dark:bg-gray-700 rounded-full flex items-center justify-center">
                  <svg
                    className="w-4 h-4 text-gray-600 dark:text-gray-300"
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
                <span className="font-medium text-gray-900 dark:text-gray-100">
                  Password
                </span>
              </div>
              <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
                Use a password to secure your account
              </p>
            </div>
          </label>
        </div>
      </div>

      {/* Password field - only show if not using biometrics */}
      {!useBiometrics && (
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
              Password
            </label>
            <input
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder="Enter your password"
              className="w-full h-12 px-4 border border-gray-200 dark:border-gray-700 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm text-black dark:text-white bg-white dark:bg-gray-800 placeholder-gray-500 dark:placeholder-gray-400"
              disabled={isImporting}
            />
            {password && !validatePassword(password).valid && (
              <p className="text-red-500 dark:text-red-400 text-xs mt-1">
                {validatePassword(password).error}
              </p>
            )}
          </div>
        </div>
      )}

      {error && (
        <div className="p-4 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg">
          <p className="text-red-600 dark:text-red-400 text-sm">{error}</p>
        </div>
      )}

      <div className="space-y-3">
        <Button
          onClick={handleImport}
          disabled={
            isImporting ||
            !username.trim() ||
            (!useBiometrics && !validatePassword(password).valid)
          }
          loading={isImporting}
          variant="primary"
          size="custom"
          fullWidth
          className="h-12 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg"
        >
          {!isImporting && 'Import Account'}
        </Button>
      </div>
    </div>
  );

  return (
    <div className="bg-background">
      <div className="max-w-md mx-auto">
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
              Import Account
            </h1>
          </div>
        </div>

        {/* Content */}
        <div className="px-4 py-6">
          {step === 'mnemonic' && renderMnemonicStep()}
          {step === 'details' && renderDetailsStep()}
        </div>
      </div>
    </div>
  );
};

export default AccountImport;
