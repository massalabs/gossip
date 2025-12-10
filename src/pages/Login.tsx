import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useAccountStore } from '../stores/accountStore';
import { UserProfile } from '../db';
import { biometricService } from '../services/biometricService';
import AccountSelection from '../components/account/AccountSelection';
import AccountImport from '../components/account/AccountImport';
import Button from '../components/ui/Button';
import { useNavigate } from 'react-router-dom';
import { useVersionCheck } from '../hooks/useVersionCheck';
import { ROUTES } from '../constants/routes';

interface LoginProps {
  onCreateNewAccount: () => void;
  onAccountSelected: () => void;
  accountInfo?: UserProfile | null;
  persistentError?: string | null;
  onErrorChange?: (error: string | null) => void;
}

const Login: React.FC<LoginProps> = React.memo(
  ({
    onCreateNewAccount,
    onAccountSelected,
    accountInfo,
    persistentError = null,
    onErrorChange,
  }) => {
    const loadAccount = useAccountStore(state => state.loadAccount);
    const navigate = useNavigate();
    const { isVersionDifferent } = useVersionCheck();
    const [isLoading, setIsLoading] = useState(false);
    const [password, setPassword] = useState('');
    const [usePassword, setUsePassword] = useState(false);
    const [showAccountSelection, setShowAccountSelection] = useState(false);
    const [showAccountImport, setShowAccountImport] = useState(false);
    const [selectedAccountInfo, setSelectedAccountInfo] =
      useState<UserProfile | null>(null);
    const [autoAuthTriggered, setAutoAuthTriggered] = useState(false);
    const [biometricMethodAvailable, setBiometricMethodAvailable] = useState<
      ('capacitor' | 'webauthn' | 'none') | null
    >(null);
    const lastAutoAuthCredentialIdRef = useRef<string | null>(null);
    const autoAuthAttempted = useRef(false);

    const currentAccount = selectedAccountInfo || accountInfo;

    useEffect(() => {
      const shouldUsePassword =
        currentAccount?.security?.authMethod === 'password';
      if (usePassword !== shouldUsePassword) {
        setUsePassword(shouldUsePassword);
      }
    }, [currentAccount, usePassword]);

    useEffect(() => {
      (async () => {
        try {
          const { method } = await biometricService.checkAvailability();
          if (!method) return;
          setBiometricMethodAvailable(method);
        } catch {
          // ignore
        }
      })();
    }, []);

    const handleBiometricAuth = useCallback(async () => {
      try {
        setIsLoading(true);
        onErrorChange?.(null);

        if (!biometricMethodAvailable) {
          throw new Error('Biometric authentication is not available');
        }

        await loadAccount(undefined, currentAccount?.userId);
        onAccountSelected();
      } catch (error) {
        onErrorChange?.(
          error instanceof Error
            ? error.message
            : 'Biometric authentication failed'
        );
      } finally {
        setIsLoading(false);
      }
    }, [
      currentAccount,
      biometricMethodAvailable,
      onErrorChange,
      loadAccount,
      onAccountSelected,
    ]);

    // Auto-trigger biometric auth when account is selected from account picker
    useEffect(() => {
      // Skip biometric auth if app update is required
      if (isVersionDifferent) return;
      if (autoAuthTriggered || !selectedAccountInfo) return;
      const authMethod = selectedAccountInfo.security?.authMethod;
      if (authMethod === 'password') return;
      if (lastAutoAuthCredentialIdRef.current === selectedAccountInfo.userId)
        return;
      if (!biometricMethodAvailable) return;

      lastAutoAuthCredentialIdRef.current = selectedAccountInfo.userId;
      setAutoAuthTriggered(true);
      handleBiometricAuth();
    }, [
      isVersionDifferent,
      autoAuthTriggered,
      selectedAccountInfo,
      biometricMethodAvailable,
      handleBiometricAuth,
    ]);

    // Auto-trigger biometric auth on mount if account (from accountInfo) has biometric auth enabled
    // Only triggers for accountInfo, not selectedAccountInfo (which is handled by the effect above)
    useEffect(() => {
      // Skip biometric auth if app update is required
      if (isVersionDifferent) return;
      // Skip if already attempted, no accountInfo, or user has manually selected a different account
      if (
        autoAuthAttempted.current ||
        !accountInfo ||
        selectedAccountInfo ||
        !biometricMethodAvailable
      )
        return;

      const authMethod = accountInfo.security?.authMethod;

      // Only auto-trigger for biometric auth methods (not password)
      if (authMethod === 'capacitor' || authMethod === 'webauthn') {
        autoAuthAttempted.current = true;
        handleBiometricAuth();
      }
    }, [
      isVersionDifferent,
      accountInfo,
      selectedAccountInfo,
      handleBiometricAuth,
      biometricMethodAvailable,
    ]);

    const handlePasswordAuth = async (
      e?: React.MouseEvent | React.KeyboardEvent
    ) => {
      e?.preventDefault();
      e?.stopPropagation();

      setIsLoading(true);
      onErrorChange?.(null);

      try {
        if (!password.trim()) {
          onErrorChange?.('Password is required');
          setIsLoading(false);
          return;
        }

        await loadAccount(password, currentAccount?.userId);

        const state = useAccountStore.getState();
        if (state.userProfile) {
          onAccountSelected();
        } else {
          throw new Error('Failed to load account');
        }
      } catch (error) {
        console.error('Password authentication failed:', error);
        const errorMessage = 'Invalid password. Please try again.';
        onErrorChange?.(errorMessage);
        setPassword('');
        if (window.location.pathname !== ROUTES.welcome()) {
          navigate(ROUTES.welcome());
        }
      } finally {
        setIsLoading(false);
      }
    };

    const handleChangeAccount = () => {
      setShowAccountSelection(true);
    };

    const handleAccountSelected = (account: UserProfile) => {
      setSelectedAccountInfo(account);
      setShowAccountSelection(false);
      onErrorChange?.(null);
      setPassword('');
    };

    const handleBackFromSelection = () => {
      setShowAccountSelection(false);
    };

    const handleBackFromImport = () => {
      setShowAccountImport(false);
    };

    const handleImportComplete = () => {
      setShowAccountImport(false);
      onAccountSelected();
    };

    const displayUsername = currentAccount?.username;

    // Always try biometric first if available, regardless of account type
    const shouldTryBiometricFirst = biometricMethodAvailable;

    // For password accounts, we want to show biometric option as primary
    const accountSupportsBiometrics = !usePassword;
    const shouldShowBiometricOption =
      shouldTryBiometricFirst || accountSupportsBiometrics;

    if (showAccountSelection) {
      return (
        <AccountSelection
          onBack={handleBackFromSelection}
          onCreateNewAccount={onCreateNewAccount}
          onAccountSelected={handleAccountSelected}
        />
      );
    }

    if (showAccountImport) {
      return (
        <AccountImport
          onBack={handleBackFromImport}
          onComplete={handleImportComplete}
        />
      );
    }

    return (
      <div className="bg-background flex h-full app-max-w px-4 py-8 md:py-0 flex-col items-center justify-center">
        <div className="flex flex-col items-center justify-center w-full gap-10">
          {/* Left column: logo + hero copy */}
          <div className="w-full max-w-md text-center space-y-4">
            <div className="space-y-2">
              <img
                src="/logo.svg"
                alt="Gossip"
                className="mx-auto dark:invert my-10"
              />
              <h1 className="text-[28px] md:text-[32px] font-semibold tracking-tight text-gray-900 dark:text-white">
                {displayUsername ? (
                  <>
                    Welcome back,{' '}
                    <span className="text-blue-700 dark:text-blue-400 text-4xl">
                      {displayUsername}
                    </span>
                  </>
                ) : (
                  'Welcome to Gossip'
                )}
              </h1>
              <p className="text-sm text-gray-600 dark:text-gray-400">
                Sign in quickly and securely.
              </p>
            </div>
          </div>

          {/* Right column: unified auth card */}
          <div className="w-full max-w-md rounded-2xl bg-white/80 dark:bg-gray-900/60 border border-gray-200/80 dark:border-gray-700/60 p-5 shadow-sm backdrop-blur space-y-5">
            {/* Biometric authentication - show if account supports it */}
            {shouldShowBiometricOption && accountSupportsBiometrics && (
              <div className="space-y-3">
                <Button
                  onClick={handleBiometricAuth}
                  disabled={isLoading}
                  loading={isLoading}
                  variant="primary"
                  size="custom"
                  fullWidth
                  className="h-11 rounded-xl text-sm font-medium"
                >
                  {!isLoading && <span>Login with biometrics</span>}
                </Button>
                {!biometricMethodAvailable && (
                  <p className="text-xs text-amber-700 dark:text-amber-400">
                    Biometrics not detected. We will try anyway.
                  </p>
                )}
              </div>
            )}

            {/* Password authentication - show if biometrics not available OR for password accounts */}
            {(!biometricMethodAvailable || usePassword) && (
              <div className="space-y-3">
                <input
                  type="password"
                  value={password}
                  onChange={e => {
                    setPassword(e.target.value);
                    if (persistentError && onErrorChange) {
                      onErrorChange(null);
                    }
                  }}
                  onKeyDown={e => {
                    if (e.key === 'Enter' && password.trim() && !isLoading) {
                      e.preventDefault();
                      handlePasswordAuth(e);
                    }
                  }}
                  placeholder="Password"
                  className={`w-full h-12 px-4 rounded-xl border text-sm focus:outline-none focus:ring-2 transition text-gray-900 dark:text-white bg-white dark:bg-gray-800 ${
                    persistentError
                      ? 'border-red-300 dark:border-red-600 focus:ring-red-200 dark:focus:ring-red-900/40'
                      : 'border-gray-200 dark:border-gray-700 focus:ring-blue-200 dark:focus:ring-blue-900/40'
                  }`}
                  disabled={isLoading}
                />
                <Button
                  type="button"
                  onClick={handlePasswordAuth}
                  disabled={isLoading || !password.trim()}
                  loading={isLoading}
                  variant="primary"
                  fullWidth
                >
                  {!isLoading && <span>Login</span>}
                </Button>
              </div>
            )}

            {persistentError && (
              <div className="rounded-xl border-2 border-red-200 dark:border-red-800 bg-red-50/80 dark:bg-red-900/20 p-3">
                <p className="text-sm text-red-700 dark:text-red-300">
                  {persistentError}
                </p>
              </div>
            )}

            <div className="border-t border-gray-200/80 dark:border-gray-700/60 pt-4 space-y-2">
              <Button
                onClick={handleChangeAccount}
                variant="outline"
                size="custom"
                fullWidth
                className="h-10 rounded-xl text-sm"
              >
                Switch account
              </Button>
              <Button
                onClick={onCreateNewAccount}
                variant="outline"
                size="custom"
                fullWidth
                className="h-10 rounded-xl text-sm"
              >
                Create new account
              </Button>
              <Button
                onClick={() => setShowAccountImport(true)}
                variant="outline"
                size="custom"
                fullWidth
                className="h-10 rounded-xl text-sm"
              >
                Import account
              </Button>
            </div>
          </div>
        </div>
      </div>
    );
  }
);

Login.displayName = 'Login';

export default Login;
