import { useState, useEffect, useMemo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Capacitor } from '@capacitor/core';
import { useAccountStore } from '../stores/accountStore';
import { getSdk } from '../stores/sdkStore';
import {
  validatePassword,
  validateUsernameFormat,
} from '@massalabs/gossip-sdk';
import { biometricService } from '../services/biometricService';
import { BIOMETRIC_STORAGE_KEY } from '../constants/biometric';

export interface AccountCreationCreatedContext {
  username: string;
  useBiometrics: boolean;
  iCloudSync: boolean;
}

export interface UseAccountCreationFormOptions {
  /** Called after successful init + SDK flush. */
  onAccountCreated: (ctx: AccountCreationCreatedContext) => void;
  /** When true, initializeAccount won't set isInitialized — caller manages it. */
  skipSetInitialized?: boolean;
}

export function useAccountCreationForm({
  onAccountCreated,
  skipSetInitialized,
}: UseAccountCreationFormOptions) {
  const { t } = useTranslation('auth');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [biometricAvailable, setBiometricAvailable] = useState(false);
  const [biometricChecked, setBiometricChecked] = useState(false);
  const [usePassword, setUsePassword] = useState(false);
  const [showICloudModal, setShowICloudModal] = useState(false);
  const [showPasswords, setShowPasswords] = useState(false);

  const usernameValidation = useMemo(
    () => validateUsernameFormat(username),
    [username]
  );
  const passwordValidation = useMemo(
    () => validatePassword(password),
    [password]
  );
  const passwordsMatch = password === confirmPassword;
  const canSubmit = usePassword
    ? usernameValidation.valid &&
      passwordValidation.valid &&
      passwordsMatch &&
      !isSubmitting
    : usernameValidation.valid && !isSubmitting;

  const { initializeAccountWithBiometrics, initializeAccount } =
    useAccountStore();

  const isIOS = Capacitor.getPlatform() === 'ios';

  useEffect(() => {
    const checkBiometricMethods = async () => {
      try {
        const { available } = await biometricService.checkAvailability();
        if (!available) {
          setUsePassword(true);
          setBiometricChecked(true);
          return;
        }

        // Don't offer biometric if a credential already exists —
        // only one biometric credential is stored, creating another would overwrite it.
        const alreadyExists = await biometricService.hasExistingCredential(
          BIOMETRIC_STORAGE_KEY
        );
        if (alreadyExists) {
          setUsePassword(true);
          setBiometricChecked(true);
          return;
        }

        setBiometricAvailable(true);
        setBiometricChecked(true);
      } catch (_err) {
        setUsePassword(true);
        setBiometricChecked(true);
      }
    };

    void checkBiometricMethods();
  }, []);

  const handleUsernameChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      setUsername(e.target.value);
      setError(null);
    },
    []
  );

  const handlePasswordChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      setPassword(e.target.value);
      setError(null);
    },
    []
  );

  const createAccount = useCallback(
    async (enableICloudSync = false) => {
      setIsSubmitting(true);
      setError(null);

      const initOpts = skipSetInitialized
        ? { setInitialized: false }
        : undefined;

      try {
        if (usePassword || !biometricAvailable) {
          await initializeAccount(username, password, initOpts);
        } else {
          await initializeAccountWithBiometrics(
            username,
            enableICloudSync,
            initOpts
          );
        }

        await getSdk().flush();

        // Clear sensitive data from state ASAP
        setPassword('');
        setConfirmPassword('');

        onAccountCreated({
          username,
          useBiometrics: !usePassword && biometricAvailable,
          iCloudSync: enableICloudSync,
        });
      } catch (err) {
        const errorMsg =
          err instanceof Error ? err.message : t('create.failed');
        setError(errorMsg);
        setIsSubmitting(false);
      }
    },
    [
      onAccountCreated,
      skipSetInitialized,
      usePassword,
      biometricAvailable,
      initializeAccount,
      initializeAccountWithBiometrics,
      username,
      password,
      t,
    ]
  );

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      e.stopPropagation();

      if (!usernameValidation.valid || !canSubmit) {
        return;
      }

      const actualUsePassword = usePassword || !biometricAvailable;

      if (!actualUsePassword && isIOS && biometricAvailable) {
        setShowICloudModal(true);
      } else {
        await createAccount(false);
      }
    },
    [
      usernameValidation.valid,
      canSubmit,
      usePassword,
      biometricAvailable,
      isIOS,
      createAccount,
    ]
  );

  const handleICloudSyncChoice = useCallback(
    (enableSync: boolean) => {
      void createAccount(enableSync);
    },
    [createAccount]
  );

  return {
    t,
    username,
    password,
    confirmPassword,
    setConfirmPassword,
    isSubmitting,
    error,
    biometricAvailable,
    biometricChecked,
    usePassword,
    setUsePassword,
    showICloudModal,
    setShowICloudModal,
    showPasswords,
    setShowPasswords,
    usernameValidation,
    passwordValidation,
    passwordsMatch,
    canSubmit,
    handleUsernameChange,
    handlePasswordChange,
    handleSubmit,
    handleICloudSyncChoice,
  };
}

export type AccountCreationFormFields = ReturnType<
  typeof useAccountCreationForm
>;
