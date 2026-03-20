import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useAccountStore } from '../stores/accountStore';
import { UserProfile, EncryptionKey } from '@massalabs/gossip-sdk';
import AccountImport from '../components/account/AccountImport';
import Button from '../components/ui/Button';
import RoundedInput from '../components/ui/RoundedInput';
import { useNavigate } from 'react-router-dom';
import { ROUTES } from '../constants/routes';
import { PrivacyGraphic } from '../components/graphics';
import { useDevAutoLogin } from '../hooks/useDevAutoLogin';
import { biometricService } from '../services/biometricService';
import {
  BIOMETRIC_STORAGE_KEY,
  BIOMETRIC_SALT,
  WEBAUTHN_CREDENTIAL_ID_KEY,
} from '../constants/biometric';

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
    const { t } = useTranslation('auth');
    const loadAccount = useAccountStore(state => state.loadAccount);
    const navigate = useNavigate();
    const [isLoading, setIsLoading] = useState(false);
    const [password, setPassword] = useState('');
    const [showAccountImport, setShowAccountImport] = useState(false);
    const [biometricAvailable, setBiometricAvailable] = useState(false);
    const [biometricMethod, setBiometricMethod] = useState<
      'capacitor' | 'webauthn' | 'none'
    >('none');

    useEffect(() => {
      const checkBiometric = async () => {
        const { available, method } =
          await biometricService.checkAvailability();
        if (!available) return;

        // Only show biometric login if a credential actually exists
        const exists = await biometricService.hasExistingCredential(
          BIOMETRIC_STORAGE_KEY
        );
        if (!exists) return;

        setBiometricAvailable(true);
        setBiometricMethod(method ?? 'none');
      };
      checkBiometric().catch(() => {});
    }, []);

    const handleBiometricAuth = useCallback(async () => {
      setIsLoading(true);
      onErrorChange?.(null);

      try {
        const webauthnCredentialId =
          biometricMethod === 'webauthn'
            ? (localStorage.getItem(WEBAUTHN_CREDENTIAL_ID_KEY) ?? undefined)
            : undefined;

        const result = await biometricService.authenticate(
          biometricMethod as 'capacitor' | 'webauthn',
          biometricMethod === 'capacitor'
            ? BIOMETRIC_STORAGE_KEY
            : webauthnCredentialId,
          biometricMethod === 'webauthn' ? BIOMETRIC_SALT : undefined
        );

        if (!result.success || !result.data?.encryptionKey) {
          throw new Error(result.error || 'Biometric authentication failed');
        }

        const encryptionKey: EncryptionKey = result.data.encryptionKey;
        await loadAccount(undefined, undefined, encryptionKey);

        const state = useAccountStore.getState();
        if (state.userProfile) {
          onAccountSelected();
        } else {
          throw new Error('Failed to load account');
        }
      } catch (error) {
        console.error('Biometric authentication failed:', error);
        onErrorChange?.(
          error instanceof Error
            ? error.message
            : 'Biometric authentication failed'
        );
        if (window.location.pathname !== ROUTES.welcome()) {
          navigate(ROUTES.welcome());
        }
      } finally {
        setIsLoading(false);
      }
    }, [
      biometricMethod,
      loadAccount,
      onAccountSelected,
      onErrorChange,
      navigate,
    ]);

    // Dev auto-login: skip password prompt in dev mode
    const devAutoLoginCallbacks = useMemo(
      () => ({
        onSuccess: onAccountSelected,
        onError: (msg: string) => onErrorChange?.(msg),
        setLoading: setIsLoading,
      }),
      [onAccountSelected, onErrorChange]
    );
    useDevAutoLogin(accountInfo, devAutoLoginCallbacks);

    const handlePasswordAuth = async (
      e?: React.MouseEvent | React.KeyboardEvent
    ) => {
      e?.preventDefault();
      e?.stopPropagation();

      setIsLoading(true);
      onErrorChange?.(null);

      try {
        if (!password.trim()) {
          onErrorChange?.(t('login.password_required'));
          setIsLoading(false);
          return;
        }

        await loadAccount(password);
        setPassword('');

        const state = useAccountStore.getState();
        if (state.userProfile) {
          onAccountSelected();
        } else {
          throw new Error('Failed to load account');
        }
      } catch (error) {
        console.error('Password authentication failed:', error);
        onErrorChange?.(t('login.invalid_password'));
        setPassword('');
        if (window.location.pathname !== ROUTES.welcome()) {
          navigate(ROUTES.welcome());
        }
      } finally {
        setIsLoading(false);
      }
    };

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
      <div className="bg-background flex h-full app-max-w px-4 py-8 md:py-0 flex-col items-center justify-center">
        <div className="flex flex-col items-center justify-center w-full gap-10">
          <div className="w-full max-w-md text-center space-y-4">
            <div className="space-y-2">
              <div className="my-10">
                <PrivacyGraphic size={200} />
              </div>
              <h1 className="text-[28px] md:text-[32px] font-semibold tracking-tight text-gray-900 dark:text-white">
                {t('login.welcome')}
              </h1>
              <p className="text-sm text-gray-600 dark:text-gray-400">
                {t('login.enter_password')}
              </p>
            </div>
          </div>

          <div className="w-full max-w-md space-y-2">
            <div className="space-y-2">
              {biometricAvailable && (
                <>
                  <Button
                    type="button"
                    onClick={handleBiometricAuth}
                    disabled={isLoading}
                    variant="outline"
                    fullWidth
                    className="h-[51px] rounded-full"
                  >
                    <span>{t('login.biometric', 'Use biometric')}</span>
                  </Button>
                  <div className="flex items-center gap-3 my-2">
                    <div className="flex-1 border-t border-border" />
                    <span className="text-xs text-muted-foreground">
                      {t('login.or', 'or')}
                    </span>
                    <div className="flex-1 border-t border-border" />
                  </div>
                </>
              )}
              <RoundedInput
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
                placeholder={t('login.password')}
                error={!!persistentError}
                disabled={isLoading}
              />
              <Button
                type="button"
                onClick={handlePasswordAuth}
                disabled={isLoading || !password.trim()}
                loading={isLoading}
                variant="primary"
                fullWidth
                className="h-[51px] rounded-full disabled:bg-primary/20"
              >
                {!isLoading && <span>{t('login.login')}</span>}
              </Button>
            </div>

            {persistentError && (
              <div className="rounded-xl border-2 border-red-200 dark:border-red-800 bg-red-50/80 dark:bg-red-900/20 p-3">
                <p className="text-sm text-red-700 dark:text-red-300">
                  {persistentError}
                </p>
              </div>
            )}

            <div className="grid grid-cols-2 gap-2">
              <Button
                onClick={onCreateNewAccount}
                variant="outline"
                size="custom"
                className="h-[51px] rounded-full text-sm"
              >
                {t('login.create_account')}
              </Button>
              <Button
                onClick={() => setShowAccountImport(true)}
                variant="outline"
                size="custom"
                className="h-[51px] rounded-full text-sm"
              >
                {t('login.import_mnemonic')}
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
