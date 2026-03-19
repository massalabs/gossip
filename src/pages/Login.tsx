import React, { useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useAccountStore } from '../stores/accountStore';
import { UserProfile } from '@massalabs/gossip-sdk';
import AccountImport from '../components/account/AccountImport';
import Button from '../components/ui/Button';
import RoundedInput from '../components/ui/RoundedInput';
import { useNavigate } from 'react-router-dom';
import { ROUTES } from '../constants/routes';
import { PrivacyGraphic } from '../components/graphics';
import { useDevAutoLogin } from '../hooks/useDevAutoLogin';

// Biometric auth was intentionally removed as part of the bordercrypt migration.
// Bordercrypt requires a password to derive the slot key on every unlock;
// biometric auth cannot provide the password, so it is no longer a valid path.
// Existing users who had biometric auth will be prompted for their password.
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
