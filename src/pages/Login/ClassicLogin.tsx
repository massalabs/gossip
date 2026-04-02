import React, {
  useState,
  useEffect,
  useRef,
  useCallback,
  useMemo,
} from 'react';
import { useTranslation } from 'react-i18next';
import { useAccountStore } from '../../stores/accountStore';
import { UserProfile } from '@massalabs/gossip-sdk';
import { biometricService } from '../../services/biometricService';
import AccountSelection from '../../components/account/AccountSelection';
import AccountImport from '../../components/account/AccountImport';
import Button from '../../components/ui/Button';
import RoundedInput from '../../components/ui/RoundedInput';
import { useNavigate } from 'react-router-dom';
import { ROUTES } from '../../constants/routes';
import { PrivacyGraphic } from '../../components/graphics';
import { useDevAutoLogin } from '../../hooks/useDevAutoLogin';
import { LoginProps } from './types';

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
    const lockedByUser = false; // TODO: implement lock-by-user detection
    const navigate = useNavigate();
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
        console.error('Biometric authentication failed:', error);
        onErrorChange?.(t('login.biometric_failed'));
      } finally {
        setIsLoading(false);
      }
    }, [
      currentAccount,
      biometricMethodAvailable,
      onErrorChange,
      loadAccount,
      onAccountSelected,
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
    // Skip if user explicitly locked the app
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

    const devAutoLoginCallbacks = useMemo(
      () => ({
        onSuccess: onAccountSelected,
        onError: (msg: string) => onErrorChange?.(msg),
        setLoading: setIsLoading,
      }),
      [onAccountSelected, onErrorChange]
    );
    useDevAutoLogin(currentAccount, devAutoLoginCallbacks);

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

        await loadAccount(password, currentAccount?.userId);

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

    const handleChangeAccount = () => {
      setShowAccountSelection(true);
    };

    const handleAccountSelected = (account: UserProfile) => {
      setSelectedAccountInfo(account);
      setShowAccountSelection(false);
      onErrorChange?.(null);
      setPassword('');
    };

    const displayUsername = currentAccount?.username;
    const shouldTryBiometricFirst = biometricMethodAvailable;
    const accountSupportsBiometrics = !usePassword;
    const shouldShowBiometricOption =
      shouldTryBiometricFirst || accountSupportsBiometrics;

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
      <div className="bg-background flex h-full app-max-w px-4 py-8 md:py-0 flex-col items-center justify-center">
        <div className="flex flex-col items-center justify-center w-full gap-10">
          <div className="w-full max-w-md text-center space-y-4">
            <div className="space-y-2">
              <div className="my-10">
                <PrivacyGraphic size={200} />
              </div>
              <h1 className="text-[28px] md:text-[32px] font-semibold tracking-tight text-gray-900 dark:text-white">
                {displayUsername ? (
                  <>
                    {t('login.welcome_back')}{' '}
                    <span className="text-blue-700 dark:text-blue-400 text-4xl">
                      {displayUsername}
                    </span>
                  </>
                ) : (
                  t('login.welcome')
                )}
              </h1>
              <p className="text-sm text-gray-600 dark:text-gray-400">
                {t('login.sign_in')}
              </p>
            </div>
          </div>

          <div className="w-full max-w-md space-y-2">
            {shouldShowBiometricOption && accountSupportsBiometrics && (
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
            )}

            {(!biometricMethodAvailable || usePassword) && (
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
            )}

            {persistentError && (
              <div className="rounded-xl border-2 border-red-200 dark:border-red-800 bg-red-50/80 dark:bg-red-900/20 p-3">
                <p className="text-sm text-red-700 dark:text-red-300">
                  {persistentError}
                </p>
                <p className="text-xs text-muted-foreground mt-1">
                  {t('login.forgot_password_hint')}{' '}
                  <button
                    type="button"
                    onClick={() => setShowAccountImport(true)}
                    className="underline hover:text-foreground transition-colors"
                  >
                    {t('login.import_recovery_link')}
                  </button>
                </p>
              </div>
            )}

            <div className="space-y-2">
              <Button
                onClick={handleChangeAccount}
                variant="outline"
                size="custom"
                fullWidth
                className="h-[51px] rounded-full text-sm"
              >
                {t('login.switch_account')}
              </Button>
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
      </div>
    );
  }
);

ClassicLogin.displayName = 'ClassicLogin';
