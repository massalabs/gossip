import { logger } from '../../utils/logger.ts';
import { useState, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { useAccountStore } from '../../stores/accountStore';
import { ROUTES } from '../../constants/routes';

interface UseLoginFormOptions {
  onAccountSelected: () => void;
  onErrorChange?: (error: string | null) => void;
  /** userId to include in the password login method */
  userId?: string;
}

export function useLoginForm({
  onAccountSelected,
  onErrorChange,
  userId,
}: UseLoginFormOptions) {
  const { t } = useTranslation('auth');
  const loadAccount = useAccountStore(state => state.loadAccount);
  const navigate = useNavigate();

  const [isLoading, setIsLoading] = useState(false);
  const [password, setPassword] = useState('');
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

  return {
    isLoading,
    setIsLoading,
    password,
    setPassword,
    passwordInputRef,
    handlePasswordAuth,
    navigate,
  };
}
