import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useAccountStore } from '../../stores/accountStore';
import { UserProfile } from '@massalabs/gossip-sdk';
import { checkBiometricAvailability } from '../../services/biometricService';
import AccountSelection from '../../components/account/AccountSelection';
import Button from '../../components/ui/Button';
import { LoginProps } from './types';
import { useLoginForm } from './useLoginForm';
import AccountImport from '../../components/account/AccountImport';
import { PasswordForm } from './PasswordForm';
import { ErrorDisplay } from './ErrorDisplay';
import { LoginActions } from './LoginActions';
import { LoginLayout } from './LoginLayout';
import { useKeyboardStore } from '../../stores/keyboardStore';

// ─────────────────────────────────────────────────────────────────
// Classic Login: account selection, auto-auth biometric, password
// ─────────────────────────────────────────────────────────────────

export const ClassicLogin: React.FC<LoginProps> = React.memo(
  ({
    onCreateNewAccount,
    onAccountSelected,
    accountInfo,
    persistentError = null,
    onErrorChange,
  }) => {
    const { t } = useTranslation('auth');

    const loadAccount = useAccountStore(state => state.loadAccount);
    const lockedByUser = useAccountStore(state => state.lockedByUser);
    const [usePassword, setUsePassword] = useState(false);
    const [showAccountSelection, setShowAccountSelection] = useState(false);
    const [selectedAccountInfo, setSelectedAccountInfo] =
      useState<UserProfile | null>(null);
    const [autoAuthTriggered, setAutoAuthTriggered] = useState(false);
    const [biometricMethodAvailable, setBiometricMethodAvailable] = useState<
      ('capacitor' | 'webauthn' | 'none') | null
    >(null);
    const lastAutoAuthCredentialIdRef = useRef<string | null>(null);
    const autoAuthAttempted = useRef(false);

    const currentAccount = selectedAccountInfo || accountInfo;
    const [inputFocused, setInputFocused] = useState(false);
    const keyboardOpen = useKeyboardStore(s => s.isVisible) || inputFocused;

    const {
      isLoading,
      setIsLoading,
      password,
      setPassword,
      showAccountImport,
      setShowAccountImport,
      handlePasswordAuth,
    } = useLoginForm({
      onAccountSelected,
      onErrorChange,
      accountInfo: currentAccount,
      userId: currentAccount?.userId,
    });

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
          const { method } = await checkBiometricAvailability();
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

        await loadAccount({
          type: 'biometric',
          userId: currentAccount?.userId,
        });
        onAccountSelected();
      } catch (error) {
        console.error('Biometric authentication failed:', error);
        const message = error instanceof Error ? error.message : 'unknown';
        if (message === 'cancelled') {
          onErrorChange?.(null);
        } else if (message === 'biometric_locked') {
          onErrorChange?.(t('login.biometric_locked'));
        } else {
          onErrorChange?.(t('login.biometric_failed'));
        }
      } finally {
        setIsLoading(false);
      }
    }, [
      currentAccount,
      biometricMethodAvailable,
      onErrorChange,
      loadAccount,
      onAccountSelected,
      setIsLoading,
      t,
    ]);

    // Auto-trigger biometric auth when account is selected from account picker
    useEffect(() => {
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
      autoAuthTriggered,
      selectedAccountInfo,
      biometricMethodAvailable,
      handleBiometricAuth,
    ]);

    // Auto-trigger biometric auth on mount if account has biometric auth enabled
    useEffect(() => {
      if (
        autoAuthAttempted.current ||
        lockedByUser ||
        !accountInfo ||
        selectedAccountInfo ||
        !biometricMethodAvailable
      )
        return;

      const authMethod = accountInfo.security?.authMethod;
      if (authMethod === 'capacitor' || authMethod === 'webauthn') {
        autoAuthAttempted.current = true;
        handleBiometricAuth();
      }
    }, [
      accountInfo,
      selectedAccountInfo,
      lockedByUser,
      handleBiometricAuth,
      biometricMethodAvailable,
    ]);

    const handleAccountSelected = (account: UserProfile) => {
      setSelectedAccountInfo(account);
      setShowAccountSelection(false);
      onErrorChange?.(null);
      setPassword('');
    };

    const displayUsername = currentAccount?.username;
    const accountSupportsBiometrics = !usePassword;
    const shouldShowBiometricOption =
      biometricMethodAvailable || accountSupportsBiometrics;

    if (showAccountSelection) {
      return (
        <AccountSelection
          onBack={() => setShowAccountSelection(false)}
          onCreateNewAccount={onCreateNewAccount}
          onAccountSelected={handleAccountSelected}
        />
      );
    }

    if (showAccountImport) {
      return (
        <AccountImport
          onBack={() => setShowAccountImport(false)}
          onComplete={() => {
            setShowAccountImport(false);
            onAccountSelected();
          }}
        />
      );
    }

    return (
      <LoginLayout
        title={displayUsername ? t('login.welcome_back') : t('login.welcome')}
        username={displayUsername}
        // subtitle={t('login.sign_in')}
      >
        <div
          className={`overflow-hidden transition-all duration-300 ${
            shouldShowBiometricOption &&
            accountSupportsBiometrics &&
            !keyboardOpen
              ? 'max-h-40 opacity-100'
              : 'max-h-0 opacity-0'
          }`}
        >
          <div className="space-y-3">
            <Button
              onClick={handleBiometricAuth}
              disabled={isLoading}
              loading={isLoading}
              variant="primary"
              size="custom"
              fullWidth
              className="h-[51px] rounded-full text-sm font-medium"
            >
              {!isLoading && <span>{t('login.biometric_auth')}</span>}
            </Button>
            {!biometricMethodAvailable && (
              <p className="text-xs text-amber-700 dark:text-amber-400">
                {t('login.biometric_not_detected')}
              </p>
            )}
          </div>
        </div>

        {(!biometricMethodAvailable || usePassword) && (
          <PasswordForm
            password={password}
            onPasswordChange={setPassword}
            onSubmit={handlePasswordAuth}
            isLoading={isLoading}
            hasError={!!persistentError}
            clearError={() => onErrorChange?.(null)}
            onFocusChange={setInputFocused}
          />
        )}

        <ErrorDisplay
          error={persistentError}
          onImport={() => setShowAccountImport(true)}
          onDismiss={() => onErrorChange?.(null)}
        />

        <div>
          <div className="space-y-2">
            <Button
              onClick={() => setShowAccountSelection(true)}
              variant="outline"
              size="custom"
              fullWidth
              className="h-[51px] rounded-full text-sm"
            >
              {t('login.switch_account')}
            </Button>
            <LoginActions
              onCreateNewAccount={onCreateNewAccount}
              onImport={() => setShowAccountImport(true)}
            />
          </div>
        </div>
      </LoginLayout>
    );
  }
);

ClassicLogin.displayName = 'ClassicLogin';
