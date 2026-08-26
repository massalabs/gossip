import { logger } from '../../utils/logger.ts';
import React, { useState, useEffect, useCallback } from 'react';
import { Capacitor } from '@capacitor/core';
import { useTranslation } from 'react-i18next';
import { useAccountStore } from '../../stores/accountStore';
import {
  checkBiometricAvailability,
  authenticateBiometricLogin,
} from '../../services/biometricService';
import Button from '../../components/ui/Button';
import { ROUTES } from '../../constants/routes';
import { LoginProps } from './types';
import { useLoginForm } from './useLoginForm';
import { PasswordForm } from './PasswordForm';
import { ErrorDisplay } from './ErrorDisplay';
import { LoginLayout } from './LoginLayout';

// ─────────────────────────────────────────────────────────────────
// Secure-storage Login: manual or biometric-recovered account password
// ─────────────────────────────────────────────────────────────────

export const SecureLogin: React.FC<LoginProps> = React.memo(
  ({ onAccountSelected, persistentError = null, onErrorChange }) => {
    const { t } = useTranslation('auth');
    const loadAccount = useAccountStore(state => state.loadAccount);
    const [biometricAvailable, setBiometricAvailable] = useState(false);
    const [biometricMethod, setBiometricMethod] = useState<
      'capacitor' | 'webauthn' | 'none'
    >('none');
    const [biometricLoading, setBiometricLoading] = useState(false);

    const {
      isLoading: passwordLoading,
      password,
      setPassword,
      passwordInputRef,
      handlePasswordAuth,
      navigate,
    } = useLoginForm({
      onAccountSelected,
      onErrorChange,
    });

    useEffect(() => {
      // PD: surface the biometric button whenever the device has the
      // hardware (Touch ID / Face ID / fingerprint), regardless of
      // whether a credential is registered. Gating on
      // `hasExistingCredential` would leak account state via the UI:
      // an observer (or the user looking over the shoulder) could tell
      // "this device has a biometric account configured" vs "not".
      // Tapping the button when no credential exists still prompts the
      // OS biometric (uniform timing) and falls through to the
      // "biometric_failed_use_password" error path — same UX as a
      // wrong-account tap, by design.
      const check = async () => {
        const { available, method } = await checkBiometricAvailability();
        if (!available) return;
        setBiometricAvailable(true);
        setBiometricMethod(method ?? 'none');
      };
      check().catch(() => {});
    }, []);

    const handleBiometricAuth = useCallback(async () => {
      setBiometricLoading(true);
      onErrorChange?.(null);

      try {
        const result = await authenticateBiometricLogin(biometricMethod);

        if (!result.success || !result.data?.password) {
          throw new Error(result.error || 'Biometric authentication failed');
        }

        await loadAccount({
          type: 'password',
          password: result.data.password,
        });

        const state = useAccountStore.getState();
        if (state.userProfile) {
          onAccountSelected();
        } else {
          throw new Error('Failed to load account');
        }
      } catch (error) {
        // Never purge the singleton credential after login failure. It may
        // reference a deliberately deleted account, and pre-profile login
        // cannot determine that without creating an account-association oracle.
        // Leave replacement to an explicit setup action in an authenticated
        // account.
        logger.error('Biometric authentication failed:', error);
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

    return (
      <LoginLayout title={t('login.welcome')} subtitle="">
        <div
          className={`overflow-hidden transition-all duration-300 ${
            biometricAvailable ? 'max-h-40 opacity-100' : 'max-h-0 opacity-0'
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
          clearError={() => onErrorChange?.(null)}
        />

        <ErrorDisplay
          error={persistentError}
          onDismiss={() => onErrorChange?.(null)}
        />

        {['web', 'android', 'ios'].includes(Capacitor.getPlatform()) && (
          <Button
            type="button"
            variant="outline"
            fullWidth
            className="h-[51px] rounded-full"
            disabled={biometricLoading || passwordLoading}
            onClick={() => navigate(ROUTES.portableBackup())}
          >
            {t('login.backup_all_accounts')}
          </Button>
        )}
      </LoginLayout>
    );
  }
);

SecureLogin.displayName = 'SecureLogin';
