import { logger } from '../../utils/logger.ts';
import React, { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Key, PlusCircle, Zap } from 'react-feather';
import { validateMnemonic, validatePassword } from '@massalabs/gossip-sdk';
import {
  validateUsernameFormat,
  USERNAME_MAX_LENGTH,
} from '../../utils/validation';
import PageHeader from '../ui/PageHeader';
import PageLayout from '../ui/Layout/PageLayout';
import Button from '../ui/Button';
import RoundedInput from '../ui/RoundedInput';
import PasswordConfirmModal from './PasswordConfirmModal';
import PrivacyNotice from './PrivacyNotice';
import { scrollFieldIntoView } from '../../utils/scrollFieldIntoView';
import TabSwitcher from '../ui/TabSwitcher';

export interface AccountCreationResult {
  username: string;
  password: string;
  mnemonic?: string;
}

interface AccountCreationFormProps {
  onSubmit: (result: AccountCreationResult) => Promise<void>;
  onBack?: () => void;
  /** When true, wraps in PageLayout with header. Default: true */
  standalone?: boolean;
  /** Expose per-account create/import identity tabs. */
  allowMnemonicImport?: boolean;
}

type ValidationResult = { valid: boolean; error?: string };

function FieldErrorHint({
  hasError,
  message,
  id,
}: {
  hasError: boolean;
  message: string;
  id?: string;
}) {
  return (
    <p
      id={id}
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
  inputId,
  errorHintId,
}: {
  label: React.ReactNode;
  children: React.ReactNode;
  errorHint: { hasError: boolean; message: string };
  inputId?: string;
  errorHintId?: string;
}) {
  return (
    <div>
      <label
        htmlFor={inputId}
        className="block text-sm font-medium text-foreground mb-1.5"
      >
        {label}
      </label>
      {children}
      <FieldErrorHint
        hasError={errorHint.hasError}
        message={errorHint.message}
        id={errorHintId}
      />
    </div>
  );
}

const normalizeMnemonic = (value: string) =>
  value.trim().toLowerCase().split(/\s+/).join(' ');

const AccountCreationForm: React.FC<AccountCreationFormProps> = ({
  onSubmit,
  onBack,
  standalone = true,
  allowMnemonicImport = false,
}) => {
  const { t } = useTranslation('auth');

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [isUsernameValid, setIsUsernameValid] = useState(false);
  const [isPasswordValid, setIsPasswordValid] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [usernameError, setUsernameError] = useState<string | null>(null);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [showPasswordConfirmModal, setShowPasswordConfirmModal] =
    useState(false);
  const [showPasswords, setShowPasswords] = useState(false);
  const [identityMode, setIdentityMode] = useState<'create' | 'import'>(
    'create'
  );
  const [mnemonic, setMnemonic] = useState('');
  const [mnemonicError, setMnemonicError] = useState<string | null>(null);

  // Cache only the non-sensitive result. The normalized mnemonic remains a
  // submission-local value rather than an additional long-lived React value.
  const mnemonicIsValid = useMemo(
    () =>
      identityMode === 'create' ||
      validateMnemonic(normalizeMnemonic(mnemonic)),
    [identityMode, mnemonic]
  );

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

  const handleUsernameChange = useMemo(
    () =>
      handleValidatedChange(
        validateUsernameFormat,
        setUsername,
        setIsUsernameValid,
        setUsernameError
      ),
    [handleValidatedChange]
  );

  const handlePasswordChange = useMemo(
    () =>
      handleValidatedChange(
        validatePassword,
        setPassword,
        setIsPasswordValid,
        setPasswordError
      ),
    [handleValidatedChange]
  );

  const passwordsMatch = password === confirmPassword;
  const canSubmit =
    isUsernameValid &&
    isPasswordValid &&
    passwordsMatch &&
    mnemonicIsValid &&
    !isCreating;

  const confirmMismatch = confirmPassword.length > 0 && !passwordsMatch;

  const doSubmit = async () => {
    setIsCreating(true);
    setError(null);

    try {
      await onSubmit({
        username,
        password,
        ...(identityMode === 'import'
          ? { mnemonic: normalizeMnemonic(mnemonic) }
          : {}),
      });
      setPassword('');
      setConfirmPassword('');
      setMnemonic('');
    } catch (err) {
      logger.error('Error creating account:', err);
      setError(t('create.failed'));
      setIsCreating(false);
    }
  };

  const handleFormSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    e.stopPropagation();

    const usernameResult = validateUsernameFormat(username);
    if (!usernameResult.valid) {
      setIsUsernameValid(false);
      setUsernameError(usernameResult.error);
      return;
    }

    if (identityMode === 'import' && !mnemonicIsValid) {
      setMnemonicError(t('create.mnemonic_invalid'));
      return;
    }
    if (!canSubmit) return;

    setShowPasswordConfirmModal(true);
  };

  const handlePasswordConfirm = async () => {
    setShowPasswordConfirmModal(false);
    await doSubmit();
  };

  const formContent = (
    <>
      {allowMnemonicImport && (
        <TabSwitcher
          options={[
            {
              value: 'create',
              label: t('create.new_tab'),
              icon: <PlusCircle className="w-4 h-4" />,
            },
            {
              value: 'import',
              label: t('create.import_tab'),
              icon: <Key className="w-4 h-4" />,
            },
          ]}
          value={identityMode}
          onChange={value => {
            setIdentityMode(value);
            setMnemonic('');
            setMnemonicError(null);
            setError(null);
          }}
          className="mb-4"
        />
      )}
      <div className="bg-background rounded-lg p-6 ">
        <form onSubmit={handleFormSubmit} className="space-y-1">
          {identityMode === 'import' && (
            <FormFieldRow
              label={t('create.mnemonic_label')}
              inputId="account-mnemonic"
              errorHintId="account-mnemonic-error"
              errorHint={{
                hasError: !!mnemonicError,
                message: mnemonicError || '',
              }}
            >
              <textarea
                id="account-mnemonic"
                aria-invalid={!!mnemonicError}
                aria-describedby="account-mnemonic-error"
                value={mnemonic}
                onChange={event => {
                  const value = event.target.value;
                  setMnemonic(value);
                  setMnemonicError(
                    value.length > 0 &&
                      !validateMnemonic(normalizeMnemonic(value))
                      ? t('create.mnemonic_invalid')
                      : null
                  );
                  setError(null);
                }}
                onFocus={scrollFieldIntoView}
                placeholder={t('create.mnemonic_placeholder')}
                disabled={isCreating}
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                className={`w-full min-h-28 resize-none rounded-2xl border bg-card px-4 py-3 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus-visible:ring-2 ${
                  mnemonicError
                    ? 'border-destructive/60 focus-visible:ring-destructive/30'
                    : 'border-border focus-visible:ring-ring/30'
                }`}
              />
            </FormFieldRow>
          )}

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
              maxLength={USERNAME_MAX_LENGTH}
              disabled={isCreating}
            />
          </FormFieldRow>

          <PrivacyNotice
            tone="warning"
            title={t('create.unique_password_title')}
            content={t('create.unique_password_warning')}
            className="mb-3"
          />

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
                <span>
                  {identityMode === 'import'
                    ? t('create.import_account')
                    : t('create.title')}
                </span>
              </>
            )}
          </Button>
        </form>
      </div>
      <PasswordConfirmModal
        isOpen={showPasswordConfirmModal}
        onConfirm={handlePasswordConfirm}
        onCancel={() => setShowPasswordConfirmModal(false)}
        confirmLabel={
          identityMode === 'import'
            ? t('create.password_confirm_import')
            : undefined
        }
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
