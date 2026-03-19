import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Zap } from 'react-feather';
import {
  validatePassword,
  validateUsernameFormat,
} from '@massalabs/gossip-sdk';
import PageHeader from '../ui/PageHeader';
import PageLayout from '../ui/PageLayout';
import Button from '../ui/Button';
import RoundedInput from '../ui/RoundedInput';

interface HiddenAccountCreationProps {
  onComplete: (credentials: { username: string; password: string }) => void;
  onBack: () => void;
}

const HiddenAccountCreation: React.FC<HiddenAccountCreationProps> = ({
  onComplete,
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
  const canSubmit = isUsernameValid && isPasswordValid && passwordsMatch;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    onComplete({ username, password });
  };

  return (
    <PageLayout
      header={<PageHeader title={t('hidden_account.title')} onBack={onBack} />}
      className="app-max-w mx-auto"
      contentClassName="p-4"
    >
      <p className="text-sm text-muted-foreground mb-6">
        {t('hidden_account.description')}
      </p>

      <div className="bg-background rounded-lg p-6 space-y-6">
        <form onSubmit={handleSubmit} className="space-y-6">
          <div>
            <label className="block text-xl font-medium text-black dark:text-white mb-3">
              {t('create.username')}
            </label>
            <RoundedInput
              type="text"
              value={username}
              onChange={handleUsernameChange}
              placeholder={t('create.enter_username')}
              error={!!usernameError}
              maxLength={20}
            />
            {usernameError && (
              <p className="text-red-500 dark:text-red-400 text-xs mt-1">
                {usernameError}
              </p>
            )}
          </div>

          <div>
            <label className="block text-xl font-medium text-black dark:text-white mb-3">
              {t('create.password')}
            </label>
            <RoundedInput
              type="password"
              value={password}
              onChange={handlePasswordChange}
              placeholder={t('create.enter_password')}
              error={!!passwordError}
              showPasswordToggle={true}
              showPassword={showPasswords}
              onShowPasswordChange={setShowPasswords}
            />
            {passwordError && (
              <p className="text-red-500 dark:text-red-400 text-xs mt-1">
                {passwordError}
              </p>
            )}
          </div>

          <div>
            <label className="block text-xl font-medium text-black dark:text-white mb-3">
              {t('create.confirm_password_label')}
            </label>
            <RoundedInput
              type="password"
              value={confirmPassword}
              onChange={e => setConfirmPassword(e.target.value)}
              placeholder={t('create.confirm_password')}
              error={confirmPassword.length > 0 && !passwordsMatch}
              showPasswordToggle={false}
              showPassword={showPasswords}
            />
            {confirmPassword.length > 0 && !passwordsMatch && (
              <p className="text-red-500 dark:text-red-400 text-xs mt-1">
                {t('create.passwords_do_not_match')}
              </p>
            )}
          </div>

          {/* Warning */}
          <div className="p-4 border rounded-lg bg-amber-50 dark:bg-amber-900/20 border-amber-200 dark:border-amber-800">
            <div className="flex items-start gap-3">
              <div className="shrink-0 mt-0.5">
                <AlertTriangle className="h-5 w-5 text-amber-500" />
              </div>
              <p className="text-sm text-amber-700 dark:text-amber-300 leading-relaxed">
                {t('hidden_account.warning')}
              </p>
            </div>
          </div>

          <Button
            type="submit"
            disabled={!canSubmit}
            variant="primary"
            size="custom"
            fullWidth
            className="h-11 rounded-full text-sm font-medium flex items-center justify-center gap-2"
          >
            <Zap className="w-5 h-5" />
            <span>{t('hidden_account.create')}</span>
          </Button>
        </form>
      </div>
    </PageLayout>
  );
};

export default HiddenAccountCreation;
