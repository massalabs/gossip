import React, { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Capacitor } from '@capacitor/core';
import { Lock, Shield, Zap } from 'react-feather';
import {
  validatePassword,
  validateUsernameFormat,
} from '@massalabs/gossip-sdk';
import { useGossipSdk } from '../../hooks/useGossipSdk';
import PageHeader from '../ui/PageHeader';
import PageLayout from '../ui/PageLayout';
import TabSwitcher from '../ui/TabSwitcher';
import Button from '../ui/Button';
import RoundedInput from '../ui/RoundedInput';
import ICloudSyncModal from '../ui/ICloudSyncModal';
import { checkBiometricAvailability } from '../../services/biometricService';
import { scrollFieldIntoView } from '../../utils/scrollFieldIntoView';

export interface AccountCreationResult {
  username: string;
  useBiometrics: boolean;
  password?: string;
  iCloudSync?: boolean;
}

interface AccountCreationFormProps {
  onSubmit: (result: AccountCreationResult) => Promise<void>;
  onBack?: () => void;
  /** When true, wraps in PageLayout with header. Default: true */
  standalone?: boolean;
}

type ValidationResult = { valid: boolean; error?: string };

function FieldErrorHint({
  hasError,
  message,
}: {
  hasError: boolean;
  message: string;
}) {
  return (
    <p
      className={`text-xs text-center mt-1 h-4 ${hasError ? 'text-destructive' : 'invisible'}`}
    >
      {hasError ? message : '\u00A0'}
    </p>
  );
}

/** Label + champ + message d’erreur (toujours les 3 blocs alignés). */
function FormFieldRow({
  label,
  children,
  errorHint,
}: {
  label: React.ReactNode;
  children: React.ReactNode;
  errorHint: { hasError: boolean; message: string };
}) {
  return (
    <div>
      <label className="block text-sm font-medium text-foreground mb-1.5">
        {label}
      </label>
      {children}
      <FieldErrorHint
        hasError={errorHint.hasError}
        message={errorHint.message}
      />
    </div>
  );
}

const AccountCreationForm: React.FC<AccountCreationFormProps> = ({
  onSubmit,
  onBack,
  standalone = true,
}) => {
  const { t } = useTranslation('auth');

  const gossip = useGossipSdk();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [isUsernameValid, setIsUsernameValid] = useState(false);
  const [isPasswordValid, setIsPasswordValid] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [usernameError, setUsernameError] = useState<string | null>(null);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [canUseBiometrics, setCanUseBiometrics] = useState(false);
  const [authMode, setAuthMode] = useState<'password' | 'biometrics'>(
    'password'
  );
  const [showICloudModal, setShowICloudModal] = useState(false);
  const [showPasswords, setShowPasswords] = useState(false);

  const isIOS = Capacitor.getPlatform() === 'ios';

  useEffect(() => {
    checkBiometricAvailability()
      .then(({ available }) => {
        setCanUseBiometrics(available);
        if (available) setAuthMode('biometrics');
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    setError(null);
    setUsernameError(null);
    setPasswordError(null);
  }, [authMode]);

  const handleValidatedChange = useCallback(
    (
      validator: (value: string) => ValidationResult,
      setValue: React.Dispatch<React.SetStateAction<string>>,
      setValid: React.Dispatch<React.SetStateAction<boolean>>,
      setFieldError: React.Dispatch<React.SetStateAction<string | null>>
    ) =>
      (e: React.ChangeEvent<HTMLInputElement>) => {
        const value = e.target.value;
        setValue(value);
        const result = validator(value);
        setValid(result.valid);
        setFieldError(result.error || null);
        setError(null);
      },
    []
  );

  const handleUsernameChange = handleValidatedChange(
    validateUsernameFormat,
    setUsername,
    setIsUsernameValid,
    setUsernameError
  );

  const handlePasswordChange = handleValidatedChange(
    validatePassword,
    setPassword,
    setIsPasswordValid,
    setPasswordError
  );

  const passwordsMatch = password === confirmPassword;
  const usePassword = authMode === 'password';
  const canSubmit = usePassword
    ? isUsernameValid && isPasswordValid && passwordsMatch && !isCreating
    : isUsernameValid && !isCreating;

  const confirmMismatch = confirmPassword.length > 0 && !passwordsMatch;

  const doSubmit = async (iCloudSync = false) => {
    setIsCreating(true);
    setError(null);

    try {
      await onSubmit({
        username,
        useBiometrics: !usePassword,
        password: usePassword ? password : undefined,
        iCloudSync,
      });
    } catch (err) {
      console.error('Error creating account:', err);
      setError(t('create.failed'));
      setIsCreating(false);
    }
  };

  const handleFormSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    e.stopPropagation();

    const usernameResult = await gossip.profiles.validateUsername(username);
    if (!usernameResult.valid) {
      setIsUsernameValid(false);
      setUsernameError(usernameResult.error);
      return;
    }

    if (!canSubmit) return;

    if (!usePassword && isIOS) {
      setShowICloudModal(true);
    } else {
      await doSubmit(false);
    }
  };

  const formContent = (
    <>
      {canUseBiometrics && (
        <TabSwitcher
          options={[
            {
              value: 'biometrics',
              label: t('create.biometrics'),
              icon: <Shield className="w-4 h-4" />,
            },
            {
              value: 'password',
              label: t('create.password'),
              icon: <Lock className="w-4 h-4" />,
            },
          ]}
          value={authMode}
          onChange={value => setAuthMode(value as 'password' | 'biometrics')}
        />
      )}
      {!canUseBiometrics && (
        <div className="bg-card rounded-lg p-4 mb-4 border border-border">
          <p className="text-muted-foreground text-sm">
            {t('create.biometric_not_supported')}
          </p>
        </div>
      )}
      <div className="bg-background rounded-lg p-6 ">
        <form onSubmit={handleFormSubmit} className="space-y-1">
          <FormFieldRow
            label={t('create.username')}
            errorHint={{
              hasError: !!usernameError,
              message: usernameError || '',
            }}
          >
            <RoundedInput
              type="text"
              value={username}
              onChange={handleUsernameChange}
              placeholder={t('create.enter_username')}
              error={!!usernameError}
              maxLength={20}
              disabled={isCreating}
            />
          </FormFieldRow>

          {usePassword && (
            <>
              <FormFieldRow
                label={t('create.password')}
                errorHint={{
                  hasError: !!passwordError,
                  message: passwordError || '',
                }}
              >
                <RoundedInput
                  type="password"
                  value={password}
                  onChange={handlePasswordChange}
                  onFocus={scrollFieldIntoView}
                  placeholder={t('create.enter_password')}
                  error={!!passwordError}
                  disabled={isCreating}
                  showPasswordToggle={true}
                  showPassword={showPasswords}
                  onShowPasswordChange={setShowPasswords}
                />
              </FormFieldRow>

              <FormFieldRow
                label={t('create.confirm_password_label')}
                errorHint={{
                  hasError: confirmMismatch,
                  message: confirmMismatch
                    ? t('create.passwords_do_not_match')
                    : '',
                }}
              >
                <RoundedInput
                  type="password"
                  value={confirmPassword}
                  onChange={e => setConfirmPassword(e.target.value)}
                  onFocus={scrollFieldIntoView}
                  placeholder={t('create.confirm_password')}
                  error={confirmMismatch}
                  disabled={isCreating}
                  showPasswordToggle={false}
                  showPassword={showPasswords}
                />
              </FormFieldRow>
            </>
          )}

          {error && (
            <div className="p-4 bg-destructive/10 border border-destructive/30 rounded-lg">
              <p className="text-destructive text-sm">{error}</p>
            </div>
          )}

          <Button
            type="submit"
            disabled={!canSubmit || isCreating}
            loading={isCreating}
            variant="primary"
            size="custom"
            fullWidth
            className="h-11 rounded-full text-sm font-medium flex items-center justify-center gap-2"
          >
            {!isCreating && (
              <>
                <Zap className="w-5 h-5" />
                <span>{t('create.title')}</span>
              </>
            )}
          </Button>
        </form>
      </div>
      <ICloudSyncModal
        isOpen={showICloudModal}
        onClose={() => setShowICloudModal(false)}
        onConfirm={(enableSync: boolean) => doSubmit(enableSync)}
      />
    </>
  );

  if (!standalone) return formContent;

  return (
    <PageLayout
      header={<PageHeader title={t('create.title')} onBack={onBack} />}
      className="app-max-w mx-auto overflow-auto"
      contentClassName="p-4"
    >
      {formContent}
    </PageLayout>
  );
};

export default AccountCreationForm;
