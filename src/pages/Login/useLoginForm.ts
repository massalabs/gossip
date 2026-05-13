import { logger } from '../../utils/logger.ts';
import { useState, useRef, useMemo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { useAccountStore } from '../../stores/accountStore';
import { useDevAutoLogin } from '../../hooks/useDevAutoLogin';
import { ROUTES } from '../../constants/routes';
import { UserProfile } from '@massalabs/gossip-sdk';

interface UseLoginFormOptions {
  onAccountSelected: () => void;
  onErrorChange?: (error: string | null) => void;
  accountInfo?: UserProfile | null;
  /** userId to include in the password login method */
  userId?: string;
}

export function useLoginForm({
  onAccountSelected,
  onErrorChange,
  accountInfo,
  userId,
}: UseLoginFormOptions) {
  const { t } = useTranslation('auth');
  const loadAccount = useAccountStore(state => state.loadAccount);
  const navigate = useNavigate();

  const [isLoading, setIsLoading] = useState(false);
  const [password, setPassword] = useState('');
  const [showAccountImport, setShowAccountImport] = useState(false);
  const passwordInputRef = useRef<HTMLInputElement>(null);

  const handlePasswordAuth = useCallback(
    async (e?: React.MouseEvent | React.KeyboardEvent) => {
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

        await loadAccount({ type: 'password', password, userId });
        setPassword('');

        const state = useAccountStore.getState();
        if (state.userProfile) {
          onAccountSelected();
        } else {
          throw new Error('Failed to load account');
        }
      } catch (error) {
        logger.error('Password authentication failed:', error);
        onErrorChange?.(t('login.invalid_password'));
        setPassword('');
        if (window.location.pathname !== ROUTES.welcome()) {
          navigate(ROUTES.welcome());
        }
      } finally {
        setIsLoading(false);
      }
    },
    [
      password,
      loadAccount,
      onAccountSelected,
      onErrorChange,
      navigate,
      t,
      userId,
    ]
  );

  const devAutoLoginCallbacks = useMemo(
    () => ({
      onSuccess: onAccountSelected,
      onError: (msg: string) => onErrorChange?.(msg),
      setLoading: setIsLoading,
    }),
    [onAccountSelected, onErrorChange]
  );
  useDevAutoLogin(accountInfo ?? null, devAutoLoginCallbacks);

  return {
    isLoading,
    setIsLoading,
    password,
    setPassword,
    showAccountImport,
    setShowAccountImport,
    passwordInputRef,
    handlePasswordAuth,
    navigate,
  };
}
