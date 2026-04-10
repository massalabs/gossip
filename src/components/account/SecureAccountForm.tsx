import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Zap } from 'react-feather';
import { validatePassword } from '@massalabs/gossip-sdk';
import {
  validateUsernameFormat,
  USERNAME_MAX_LENGTH,
} from '../../utils/validation';
import PageHeader from '../ui/PageHeader';
import PageLayout from '../ui/PageLayout';
import Button from '../ui/Button';
import RoundedInput from '../ui/RoundedInput';
import { scrollFieldIntoView } from '../../utils/scrollFieldIntoView';

interface SecureAccountFormProps {
  onSubmit: (creds: { username: string; password: string }) => void;
  onBack: () => void;
}

const SecureAccountForm: React.FC<SecureAccountFormProps> = ({
  onSubmit,
  onBack,
}) => {
  const { t } = useTranslation('auth');

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [isUsernameValid, setIsUsernameValid] = useState(false);
  const [isPasswordValid, setIsPasswordValid] = useState(false);
  const [usernameError, setUsernameError] = useState<string | null>(null);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [showPasswords, setShowPasswords] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleUsernameChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setUsername(value);
    const result = validateUsernameFormat(value);
    setIsUsernameValid(result.valid);
    setUsernameError(result.error || null);
  };

  const handlePasswordChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setPassword(value);
    const result = validatePassword(value);
    setIsPasswordValid(result.valid);
    setPasswordError(result.error || null);
  };

  const passwordsMatch = password === confirmPassword;
  const canSubmit =
    isUsernameValid && isPasswordValid && passwordsMatch && !isSubmitting;

  const handleFormSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    e.stopPropagation();

    const usernameResult = validateUsernameFormat(username);

    if (!usernameResult.valid) {
      setIsUsernameValid(false);
      setUsernameError(usernameResult.error);
      return;
    }

    if (!canSubmit) return;
    setIsSubmitting(true);
    onSubmit({ username, password });
  };

  return (
    <PageLayout
      header={
        <PageHeader
          title={t('secure_setup.add_account_title')}
          onBack={onBack}
        />
      }
      className="app-max-w mx-auto"
      contentClassName="p-4"
    >
      <div className="bg-background rounded-lg p-6 space-y-6">
        <form onSubmit={handleFormSubmit} className="space-y-6">
          <div>
            <label className="block text-sm font-medium text-foreground mb-1.5">
              {t('create.username')}
            </label>
            <RoundedInput
              type="text"
              value={username}
              onChange={handleUsernameChange}
              placeholder={t('create.enter_username')}
              error={!!usernameError}
              maxLength={USERNAME_MAX_LENGTH}
            />
            <p
              className={`text-xs mt-1 h-4 ${usernameError ? 'text-red-500 dark:text-red-400' : 'invisible'}`}
            >
              {usernameError || '\u00A0'}
            </p>
          </div>

          <div>
            <label className="block text-sm font-medium text-foreground mb-1.5">
              {t('create.password')}
            </label>
            <RoundedInput
              type="password"
              value={password}
              onChange={handlePasswordChange}
              onFocus={scrollFieldIntoView}
              placeholder={t('create.enter_password')}
              error={!!passwordError}
              showPasswordToggle={true}
              showPassword={showPasswords}
              onShowPasswordChange={setShowPasswords}
            />
            <p
              className={`text-xs mt-1 h-4 ${passwordError ? 'text-red-500 dark:text-red-400' : 'invisible'}`}
            >
              {passwordError || '\u00A0'}
            </p>
          </div>

          <div>
            <label className="block text-sm font-medium text-foreground mb-1.5">
              {t('create.confirm_password_label')}
            </label>
            <RoundedInput
              type="password"
              value={confirmPassword}
              onChange={e => setConfirmPassword(e.target.value)}
              onFocus={scrollFieldIntoView}
              placeholder={t('create.confirm_password')}
              error={confirmPassword.length > 0 && !passwordsMatch}
              showPasswordToggle={false}
              showPassword={showPasswords}
            />
            <p
              className={`text-xs mt-1 h-4 ${confirmPassword.length > 0 && !passwordsMatch ? 'text-red-500 dark:text-red-400' : 'invisible'}`}
            >
              {confirmPassword.length > 0 && !passwordsMatch
                ? t('create.passwords_do_not_match')
                : '\u00A0'}
            </p>
          </div>

          <Button
            type="submit"
            disabled={!canSubmit}
            loading={isSubmitting}
            variant="primary"
            size="custom"
            fullWidth
            className="h-11 rounded-full text-sm font-medium flex items-center justify-center gap-2"
          >
            {!isSubmitting && (
              <>
                <Zap className="w-5 h-5" />
                <span>{t('secure_setup.create_account')}</span>
              </>
            )}
          </Button>
        </form>
      </div>
    </PageLayout>
  );
};

export default SecureAccountForm;
