import { logger } from '../../utils/logger.ts';
import {
  isUnsupportedStorageVersionError,
  requestUnsupportedStorageReset,
  resetAllAccountStorage,
} from '../../services/unsupportedStorageReset';
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
import { MessagingSessionRecoveryRequiredError } from '@massalabs/gossip-sdk';

// ─────────────────────────────────────────────────────────────────
// Secure-storage Login: manual or biometric-recovered account password
// ─────────────────────────────────────────────────────────────────

export const SecureLogin: React.FC<LoginProps> = React.memo(
  ({ onAccountSelected, persistentError = null, onErrorChange }) => {
    const { t } = useTranslation('auth');
    const loadAccount = useAccountStore(state => state.loadAccount);
    const privateMigrationPhase = useAccountStore(
      state => state.privateMigrationPhase
    );
    const [biometricAvailable, setBiometricAvailable] = useState(false);
    const [biometricMethod, setBiometricMethod] = useState<
      'capacitor' | 'webauthn' | 'none'
    >('none');
    const [biometricLoading, setBiometricLoading] = useState(false);
    const [showSessionResetConfirm, setShowSessionResetConfirm] =
      useState(false);
    const [showStorageResetConfirm, setShowStorageResetConfirm] =
      useState(false);
    const [storageResetBusy, setStorageResetBusy] = useState(false);
    const [storageResetFailed, setStorageResetFailed] = useState(false);

    const {
      isLoading: passwordLoading,
      password,
      setPassword,
      passwordInputRef,
      handlePasswordAuth,
      messagingRecoveryRequired,
      beginMessagingSessionRecovery,
      retryMessagingSessions,
      resetMessagingSessions,
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
      let recoveredPassword: string | null = null;

      try {
        const result = await authenticateBiometricLogin(biometricMethod);

        if (!result.success || !result.data?.password) {
          throw new Error(result.error || 'Biometric authentication failed');
        }

        recoveredPassword = result.data.password;
        await loadAccount({
          type: 'password',
          password: recoveredPassword,
        });

        const state = useAccountStore.getState();
        if (state.userProfile) {
          onAccountSelected();
        } else {
          throw new Error('Failed to load account');
        }
      } catch (error) {
        if (isUnsupportedStorageVersionError(error)) {
          requestUnsupportedStorageReset();
          return;
        }
        if (
          error instanceof MessagingSessionRecoveryRequiredError &&
          recoveredPassword !== null
        ) {
          beginMessagingSessionRecovery(recoveredPassword);
          return;
        }
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
      beginMessagingSessionRecovery,
      loadAccount,
      onAccountSelected,
      onErrorChange,
      navigate,
      t,
      passwordInputRef,
    ]);

    if (messagingRecoveryRequired) {
      return (
        <LoginLayout title={t('session_recovery.title')} subtitle="">
          <div className="space-y-5 text-center">
            <p className="text-sm text-muted-foreground">
              {t('session_recovery.body')}
            </p>
            <p className="text-sm text-muted-foreground">
              {t('session_recovery.keys_warning')}
            </p>
            <ErrorDisplay
              error={persistentError}
              onDismiss={() => onErrorChange?.(null)}
            />
            <div className="space-y-3">
              <Button
                type="button"
                variant="primary"
                fullWidth
                loading={passwordLoading}
                disabled={passwordLoading}
                onClick={() => void retryMessagingSessions()}
              >
                {t('session_recovery.retry')}
              </Button>
              <Button
                type="button"
                variant="outline"
                fullWidth
                disabled={passwordLoading}
                onClick={() => setShowSessionResetConfirm(true)}
              >
                {t('session_recovery.reset')}
              </Button>
            </div>
          </div>
          {showSessionResetConfirm && (
            <div className="mt-6 space-y-4 rounded-2xl border border-amber-500/30 bg-amber-500/10 p-4">
              <p className="text-sm font-medium text-foreground">
                {t('session_recovery.confirm_body')}
              </p>
              <div className="flex gap-3">
                <Button
                  type="button"
                  variant="outline"
                  fullWidth
                  disabled={passwordLoading}
                  onClick={() => setShowSessionResetConfirm(false)}
                >
                  {t('session_recovery.cancel')}
                </Button>
                <Button
                  type="button"
                  variant="primary"
                  fullWidth
                  loading={passwordLoading}
                  disabled={passwordLoading}
                  onClick={() => void resetMessagingSessions()}
                >
                  {t('session_recovery.confirm')}
                </Button>
              </div>
            </div>
          )}
        </LoginLayout>
      );
    }

    if (showStorageResetConfirm) {
      return (
        <LoginLayout title={t('storage_reset.title')} subtitle="">
          <div className="space-y-5">
            <p className="text-sm font-medium text-destructive">
              {t('storage_reset.warning')}
            </p>
            <Button
              type="button"
              variant="danger"
              fullWidth
              loading={storageResetBusy}
              disabled={storageResetBusy}
              onClick={() => {
                setStorageResetBusy(true);
                setStorageResetFailed(false);
                void resetAllAccountStorage().catch(() => {
                  setStorageResetBusy(false);
                  setStorageResetFailed(true);
                });
              }}
            >
              {t('storage_reset.confirm')}
            </Button>
            <p className="text-sm text-muted-foreground">
              {t('storage_reset.scope')}
            </p>
            {storageResetFailed && (
              <p role="alert" className="text-sm text-destructive">
                {t('storage_reset.failed')}
              </p>
            )}
            {/* Keep the safe target where a rapid second tap is most likely;
                the irreversible action is intentionally higher on this page. */}
            <div className="pt-16">
              <Button
                type="button"
                variant="outline"
                fullWidth
                disabled={storageResetBusy}
                onClick={() => setShowStorageResetConfirm(false)}
              >
                {t('storage_reset.cancel')}
              </Button>
            </div>
          </div>
        </LoginLayout>
      );
    }

    if (privateMigrationPhase) {
      return (
        <LoginLayout title={t('private_migration.title')} subtitle="">
          <div
            className="flex min-h-52 flex-col items-center justify-center gap-6 text-center"
            role="status"
            aria-live="polite"
          >
            <div
              className="h-12 w-12 animate-spin rounded-full border-[3px] border-border border-t-primary"
              aria-hidden="true"
            />
            <p className="text-sm font-medium text-foreground">
              {t(`private_migration.phase_${privateMigrationPhase}`)}
            </p>
          </div>
        </LoginLayout>
      );
    }

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
          inputRef={passwordInputRef}
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

        <Button
          type="button"
          variant="outline"
          fullWidth
          className="h-[51px] rounded-full border-destructive/40 text-destructive"
          disabled={biometricLoading || passwordLoading}
          onClick={() => {
            setStorageResetFailed(false);
            setShowStorageResetConfirm(true);
          }}
        >
          {t('storage_reset.action')}
        </Button>
      </LoginLayout>
    );
  }
);

SecureLogin.displayName = 'SecureLogin';
