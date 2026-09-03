import { logger } from '../../utils/logger.ts';
import React, { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useAccountStore } from '../../stores/accountStore';
import { UserProfile } from '@massalabs/gossip-sdk';
import {
  authenticateBiometricLogin,
  checkBiometricAvailability,
} from '../../services/biometricService';
import AccountSelection from '../../components/account/AccountSelection';
import Button from '../../components/ui/Button';
import { LoginProps } from './types';
import { useLoginForm } from './useLoginForm';
import { PasswordForm } from './PasswordForm';
import { ErrorDisplay } from './ErrorDisplay';
import { LoginActions } from './LoginActions';
import { LoginLayout } from './LoginLayout';

// ─────────────────────────────────────────────────────────────────
// Classic Login: account selection + global biometric password
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
    const [showAccountSelection, setShowAccountSelection] = useState(false);
    const [selectedAccountInfo, setSelectedAccountInfo] =
      useState<UserProfile | null>(null);
    const [biometricMethod, setBiometricMethod] = useState<
      'capacitor' | 'webauthn' | 'none'
    >('none');
    const [biometricAvailable, setBiometricAvailable] = useState(false);
    const [biometricLoading, setBiometricLoading] = useState(false);

    const currentAccount = selectedAccountInfo || accountInfo;

    const {
      isLoading: passwordLoading,
      password,
      setPassword,
      handlePasswordAuth,
    } = useLoginForm({
      onAccountSelected,
      onErrorChange,
      userId: currentAccount?.userId,
    });

    useEffect(() => {
      const check = async () => {
        const { available, method } = await checkBiometricAvailability();
        if (!available || !method || method === 'none') return;
        setBiometricAvailable(true);
        setBiometricMethod(method);
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

        // Deliberately omit userId. The singleton credential stores only a
        // password, and accountStore probes classic profiles for its match.
        await loadAccount({
          type: 'password',
          password: result.data.password,
        });
        onAccountSelected();
      } catch (error) {
        logger.error('Biometric authentication failed:', error);
        const message = error instanceof Error ? error.message : 'unknown';
        if (message === 'cancelled') {
          onErrorChange?.(null);
        } else if (message === 'biometric_locked') {
          onErrorChange?.(t('login.biometric_locked'));
        } else {
          onErrorChange?.(t('login.biometric_failed_use_password'));
        }
      } finally {
        setBiometricLoading(false);
      }
    }, [biometricMethod, loadAccount, onAccountSelected, onErrorChange, t]);

    const handleAccountSelected = (account: UserProfile) => {
      setSelectedAccountInfo(account);
      setShowAccountSelection(false);
      onErrorChange?.(null);
      setPassword('');
    };

    if (showAccountSelection) {
      return (
        <AccountSelection
          onBack={() => setShowAccountSelection(false)}
          onCreateNewAccount={onCreateNewAccount}
          onAccountSelected={handleAccountSelected}
        />
      );
    }

    return (
      <LoginLayout
        title={
          currentAccount?.username
            ? t('login.welcome_back')
            : t('login.welcome')
        }
        username={currentAccount?.username}
      >
        {biometricAvailable && (
          <>
            <Button
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
          </>
        )}

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
            <LoginActions onCreateNewAccount={onCreateNewAccount} />
          </div>
        </div>
      </LoginLayout>
    );
  }
);

ClassicLogin.displayName = 'ClassicLogin';
