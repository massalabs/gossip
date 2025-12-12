import React, { useState, useEffect } from 'react';
// Removed static logo in favor of animated PrivacyGraphic
import { Capacitor } from '@capacitor/core';
import { CheckCircle, Lock, Shield, Zap } from 'react-feather';
import { useAccountStore } from '../../stores/accountStore';
import {
  validatePassword,
  validateUsernameFormat,
  validateUsernameFormatAndAvailability,
} from '../../utils/validation';
import PageHeader from '../ui/PageHeader';
import HeaderWrapper from '../ui/HeaderWrapper';
import ScrollableContent from '../ui/ScrollableContent';
import TabSwitcher from '../ui/TabSwitcher';
import Button from '../ui/Button';
import RoundedInput from '../ui/RoundedInput';
import ICloudSyncModal from '../ui/ICloudSyncModal';
import { biometricService } from '../../services/biometricService';

interface AccountCreationProps {
  onComplete: () => void;
  onBack: () => void;
}

const AccountCreation: React.FC<AccountCreationProps> = ({
  onComplete,
  onBack,
}) => {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [isUsernameValid, setIsUsernameValid] = useState(false);
  const [isPasswordValid, setIsPasswordValid] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [usernameError, setUsernameError] = useState<string | null>(null);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [biometricAvailable, setBiometricAvailable] = useState(false);
  const [usePassword, setUsePassword] = useState(true); // Default to password for safety
  const [accountCreationStarted, setAccountCreationStarted] = useState(false);
  const [showICloudModal, setShowICloudModal] = useState(false);

  const { initializeAccountWithBiometrics, initializeAccount } =
    useAccountStore();

  const isIOS = Capacitor.getPlatform() === 'ios';

  useEffect(() => {
    const checkBiometricMethods = async () => {
      try {
        const { available } = await biometricService.checkAvailability();
        setBiometricAvailable(available);
        setUsePassword(!available);
      } catch (_error) {
        setBiometricAvailable(false);
        setUsePassword(true);
      }
    };

    checkBiometricMethods();
  }, []);

  const handleUsernameChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setUsername(value);
    const result = validateUsernameFormat(value);
    setIsUsernameValid(result.valid);
    setUsernameError(result.error || null);
    setError(null);
  };

  const handlePasswordChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setPassword(value);
    const result = validatePassword(value);
    setIsPasswordValid(result.valid);
    setPasswordError(result.error || null);
    setError(null);
  };

  const canSubmit = usePassword
    ? isUsernameValid && isPasswordValid && !isCreating
    : isUsernameValid && !isCreating;

  // No re-authentication in create flow

  const createAccount = async (enableICloudSync = false) => {
    setIsCreating(true);
    setAccountCreationStarted(true);
    setError(null);

    try {
      if (usePassword || !biometricAvailable) {
        await initializeAccount(username, password);
      } else {
        await initializeAccountWithBiometrics(username, enableICloudSync);
      }

      onComplete();
    } catch (err) {
      const errorMsg =
        err instanceof Error ? err.message : 'Failed to create account';
      setError(errorMsg);
      setIsCreating(false);
      setAccountCreationStarted(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    e.stopPropagation();

    // Handle when user presses enter without triggering blur event
    const usernameResult =
      await validateUsernameFormatAndAvailability(username);

    if (!usernameResult.valid) {
      setIsUsernameValid(false);
      setUsernameError(usernameResult.error);
      return;
    }

    // Should not happen, because button is disabled if !canSubmit
    if (!canSubmit) {
      return;
    }

    const actualUsePassword = usePassword || !biometricAvailable;

    // For iOS biometric accounts, show iCloud sync modal first
    if (!actualUsePassword && isIOS && biometricAvailable) {
      setShowICloudModal(true);
    } else {
      // For password accounts or non-iOS, create immediately
      await createAccount(false);
    }
  };

  const handleICloudSyncChoice = (enableSync: boolean) => {
    createAccount(enableSync);
  };

  return (
    <div className="h-full flex flex-col app-max-w mx-auto">
      {/* Header */}
      <HeaderWrapper>
        <PageHeader title="Create Account" onBack={onBack} />
      </HeaderWrapper>

      <ScrollableContent className="flex-1 overflow-y-auto">
        <div className="p-4">
          {/* Authentication Method Toggle */}
          {biometricAvailable && (
            <div className="rounded-lg p-6">
              <p className="text-xl font-medium text-black dark:text-white mb-5">
                Authentication Method
              </p>
              <TabSwitcher
                options={[
                  {
                    value: 'biometrics',
                    label: 'Biometrics',
                    icon: <Shield className="w-4 h-4" />,
                  },
                  {
                    value: 'password',
                    label: 'Password',
                    icon: <Lock className="w-4 h-4" />,
                  },
                ]}
                value={usePassword ? 'password' : 'biometrics'}
                onChange={value => setUsePassword(value === 'password')}
              />
            </div>
          )}
          {/* WebAuthn Support Check */}
          {!biometricAvailable && (
            <div className="bg-white dark:bg-gray-800 rounded-lg p-4 mb-4 border border-blue-200 dark:border-blue-800">
              <p className="text-blue-600 dark:text-blue-400 text-sm">
                Biometric authentication is not supported on this device. Using
                password authentication instead.
              </p>
            </div>
          )}
          {/* Account Form */}
          <div className="bg-background rounded-lg p-6 space-y-6">
            <form onSubmit={handleSubmit} className="space-y-6">
              <div>
                <label className="block text-xl font-medium text-black dark:text-white mb-3">
                  Username
                </label>
                <RoundedInput
                  type="text"
                  value={username}
                  onChange={handleUsernameChange}
                  placeholder="Enter username"
                  error={!!usernameError}
                  maxLength={20}
                  disabled={isCreating}
                />
                {usernameError && (
                  <p className="text-red-500 dark:text-red-400 text-xs mt-1">
                    {usernameError}
                  </p>
                )}
              </div>

              {/* Password field - only show when using password authentication */}
              {usePassword && (
                <div>
                  <label className="block text-xl font-medium text-black dark:text-white mb-3">
                    Password
                  </label>
                  <RoundedInput
                    type="password"
                    value={password}
                    onChange={handlePasswordChange}
                    placeholder="Enter password"
                    error={!!passwordError}
                    disabled={isCreating}
                  />
                  {passwordError && (
                    <p className="text-red-500 dark:text-red-400 text-xs mt-1">
                      {passwordError}
                    </p>
                  )}
                </div>
              )}

              {/* Authentication Info */}
              <div className="p-4 border rounded-lg bg-green-50 dark:bg-green-900/20 border-green-200 dark:border-green-800">
                <div className="flex items-start gap-3">
                  <div className="shrink-0 mt-0.5">
                    <CheckCircle className="h-5 w-5 text-green-500" />
                  </div>
                  <div>
                    <p className="text-sm text-green-700 dark:text-green-300 leading-relaxed">
                      {usePassword
                        ? 'Your account will be secured using a password. Make sure to choose a strong password.'
                        : 'Your account will be secured using biometric authentication (fingerprint, face ID, or Windows Hello).'}
                    </p>
                  </div>
                </div>
              </div>

              {error && (
                <div className="p-4 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg">
                  <p className="text-red-600 dark:text-red-400 text-sm">
                    {error}
                  </p>
                </div>
              )}

              <Button
                type="submit"
                disabled={!canSubmit || isCreating || accountCreationStarted}
                loading={isCreating || accountCreationStarted}
                variant="primary"
                size="custom"
                fullWidth
                className="h-11 text-sm font-medium flex items-center justify-center gap-2"
              >
                {!(isCreating || accountCreationStarted) && (
                  <>
                    <Zap className="w-5 h-5" />
                    <span>Create Account</span>
                  </>
                )}
              </Button>
            </form>
          </div>
        </div>
      </ScrollableContent>

      <ICloudSyncModal
        isOpen={showICloudModal}
        onClose={() => setShowICloudModal(false)}
        onConfirm={handleICloudSyncChoice}
      />
    </div>
  );
};

export default AccountCreation;
