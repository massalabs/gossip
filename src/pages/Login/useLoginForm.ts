import { logger } from '../../utils/logger.ts';
import { useState, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { useAccountStore } from '../../stores/accountStore';
import { ROUTES } from '../../constants/routes';
import { MessagingSessionRecoveryRequiredError } from '@massalabs/gossip-sdk';
import {
  isUnsupportedStorageVersionError,
  requestUnsupportedStorageReset,
} from '../../services/unsupportedStorageReset';

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
  const [messagingRecoveryRequired, setMessagingRecoveryRequired] =
    useState(false);
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
        setMessagingRecoveryRequired(false);

        const state = useAccountStore.getState();
        if (state.userProfile) {
          onAccountSelected();
        } else {
          throw new Error('Failed to load account');
        }
      } catch (error) {
        if (isUnsupportedStorageVersionError(error)) {
          setPassword('');
          requestUnsupportedStorageReset();
          return;
        }
        logger.error('Password authentication failed:', error);
        if (error instanceof MessagingSessionRecoveryRequiredError) {
          setMessagingRecoveryRequired(true);
          onErrorChange?.(null);
          return;
        }
        setMessagingRecoveryRequired(false);
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

  const beginMessagingSessionRecovery = useCallback(
    (recoveredPassword: string) => {
      setPassword(recoveredPassword);
      setMessagingRecoveryRequired(true);
      onErrorChange?.(null);
    },
    [onErrorChange]
  );

  const retryMessagingSessions = useCallback(async () => {
    setMessagingRecoveryRequired(false);
    await handlePasswordAuth();
  }, [handlePasswordAuth]);

  const resetMessagingSessions = useCallback(async () => {
    setIsLoading(true);
    onErrorChange?.(null);
    try {
      await loadAccount({
        type: 'password',
        password,
        userId,
        resetMessagingSessions: true,
      });
      setPassword('');
      setMessagingRecoveryRequired(false);
      if (useAccountStore.getState().userProfile) onAccountSelected();
    } catch (error) {
      logger.error('Messaging session reset failed:', error);
      setMessagingRecoveryRequired(false);
      setPassword('');
      onErrorChange?.(t('session_recovery.reset_failed'));
    } finally {
      setIsLoading(false);
    }
  }, [loadAccount, onAccountSelected, onErrorChange, password, t, userId]);

  return {
    isLoading,
    setIsLoading,
    password,
    setPassword,
    passwordInputRef,
    handlePasswordAuth,
    messagingRecoveryRequired,
    beginMessagingSessionRecovery,
    retryMessagingSessions,
    resetMessagingSessions,
    navigate,
  };
}
