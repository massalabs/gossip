import React, { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useAccountStore } from '../../stores/accountStore';
import {
  checkBiometricAvailability,
  hasExistingCredential,
  authenticateSecureLogin,
} from '../../services/biometricService';
import Button from '../../components/ui/Button';
import { ROUTES } from '../../constants/routes';
import { BIOMETRIC_STORAGE_KEY } from '../../constants/biometric';
import { LoginProps } from './types';
import { useLoginForm } from './useLoginForm';
import AccountImport from '../../components/account/AccountImport';
import { PasswordForm } from './PasswordForm';
import { ErrorDisplay } from './ErrorDisplay';
import { LoginActions } from './LoginActions';
import { LoginLayout } from './LoginLayout';
import { useKeyboardStore } from '../../stores/keyboardStore';

// ─────────────────────────────────────────────────────────────────
// Secure-storage Login: password + biometric derived encryption key
// ─────────────────────────────────────────────────────────────────

export const SecureLogin: React.FC<LoginProps> = React.memo(
  ({
    onCreateNewAccount,
    onAccountSelected,
    accountInfo,
    persistentError = null,
    onErrorChange,
  }) => {
    const { t } = useTranslation('auth');
    const loadAccount = useAccountStore(state => state.loadAccount);
    const [biometricAvailable, setBiometricAvailable] = useState(false);
    const [biometricMethod, setBiometricMethod] = useState<
      'capacitor' | 'webauthn' | 'none'
    >('none');
    const [biometricLoading, setBiometricLoading] = useState(false);
    const [inputFocused, setInputFocused] = useState(false);
    const keyboardOpen = useKeyboardStore(s => s.isVisible) || inputFocused;

    const {
      isLoading: passwordLoading,
      password,
      setPassword,
      showAccountImport,
      setShowAccountImport,
      passwordInputRef,
      handlePasswordAuth,
      navigate,
    } = useLoginForm({
      onAccountSelected,
      onErrorChange,
      accountInfo,
    });

    useEffect(() => {
      const check = async () => {
        const { available, method } = await checkBiometricAvailability();
        if (!available) return;

        const exists = await hasExistingCredential(BIOMETRIC_STORAGE_KEY);
        if (!exists) return;

        setBiometricAvailable(true);
        setBiometricMethod(method ?? 'none');
      };
      check().catch(() => {});
    }, []);

    const handleBiometricAuth = useCallback(async () => {
      setBiometricLoading(true);
      onErrorChange?.(null);

      try {
        const result = await authenticateSecureLogin(biometricMethod);

        if (!result.success || !result.data?.encryptionKey) {
          throw new Error(result.error || 'Biometric authentication failed');
        }

        await loadAccount({
          type: 'encryptionKey',
          encryptionKey: result.data.encryptionKey,
        });

        const state = useAccountStore.getState();
        if (state.userProfile) {
          onAccountSelected();
        } else {
          throw new Error('Failed to load account');
        }
      } catch (error) {
        console.error('Biometric authentication failed:', error);
        onErrorChange?.(t('login.biometric_failed_use_password'));
        if (window.location.pathname !== ROUTES.welcome()) {
          navigate(ROUTES.welcome());
        }
        requestAnimationFrame(() => passwordInputRef.current?.focus());
      } finally {
        setBiometricLoading(false);
      }
    }, [
      biometricMethod,
      loadAccount,
      onAccountSelected,
      onErrorChange,
      navigate,
      t,
      passwordInputRef,
    ]);

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
      <LoginLayout title={t('login.welcome')} subtitle="">
        <div
          className={`overflow-hidden transition-all duration-300 ${
            biometricAvailable && !keyboardOpen
              ? 'max-h-40 opacity-100'
              : 'max-h-0 opacity-0'
          }`}
        >
          <Button
            type="button"
            onClick={handleBiometricAuth}
            disabled={biometricLoading || passwordLoading}
            loading={biometricLoading}
            variant="outline"
            fullWidth
            className="h-[51px] rounded-full"
          >
            {!biometricLoading && <span>{t('login.biometric')}</span>}
          </Button>
          <div className="flex items-center gap-3 my-2">
            <div className="flex-1 border-t border-border" />
            <span className="text-xs text-muted-foreground">
              {t('login.or')}
            </span>
            <div className="flex-1 border-t border-border" />
          </div>
        </div>

        <PasswordForm
          password={password}
          onPasswordChange={setPassword}
          onSubmit={handlePasswordAuth}
          isLoading={passwordLoading}
          disabled={biometricLoading}
          hasError={!!persistentError}
          onFocusChange={setInputFocused}
          clearError={() => onErrorChange?.(null)}
        />

        <ErrorDisplay
          error={persistentError}
          onImport={() => setShowAccountImport(true)}
          onDismiss={() => onErrorChange?.(null)}
        />

        <div
          className={`overflow-hidden transition-all duration-300 ${
            keyboardOpen ? 'max-h-0 opacity-0' : 'max-h-40 opacity-100'
          }`}
        >
          <LoginActions
            onCreateNewAccount={onCreateNewAccount}
            onImport={() => setShowAccountImport(true)}
          />
        </div>
      </LoginLayout>
    );
  }
);

SecureLogin.displayName = 'SecureLogin';
