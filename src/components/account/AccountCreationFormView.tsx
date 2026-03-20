import React from 'react';
import { CheckCircle, Lock, Shield, Zap } from 'react-feather';
import PageHeader from '../ui/PageHeader';
import PageLayout from '../ui/PageLayout';
import TabSwitcher from '../ui/TabSwitcher';
import Button from '../ui/Button';
import RoundedInput from '../ui/RoundedInput';
import ICloudSyncModal from '../ui/ICloudSyncModal';
import type { AccountCreationFormFields } from '../../hooks/useAccountCreationForm';

export type AccountCreationFormViewProps = AccountCreationFormFields & {
  onBack: () => void;
};

const AccountCreationFormView: React.FC<AccountCreationFormViewProps> = ({
  onBack,
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
}) => {
  if (isSubmitting) {
    return (
      <PageLayout
        header={<PageHeader title={t('create.title')} />}
        className="app-max-w mx-auto"
        contentClassName="flex items-center justify-center"
      >
        <div className="text-center">
          <div className="w-10 h-10 border-2 border-muted border-t-primary rounded-full animate-spin mx-auto mb-6" />
          <h2 className="text-lg font-medium text-foreground mb-2">
            {t('create.creating')}
          </h2>
          <p className="text-sm text-muted-foreground">
            {t('create.creating_info')}
          </p>
        </div>
      </PageLayout>
    );
  }

  if (!biometricChecked) {
    return (
      <PageLayout
        header={<PageHeader title={t('create.title')} onBack={onBack} />}
        className="app-max-w mx-auto"
        contentClassName="flex items-center justify-center"
      >
        <div className="w-8 h-8 border-2 border-muted border-t-primary rounded-full animate-spin" />
      </PageLayout>
    );
  }

  return (
    <PageLayout
      header={<PageHeader title={t('create.title')} onBack={onBack} />}
      className="app-max-w mx-auto"
      contentClassName="p-4"
    >
      {biometricAvailable && (
        <div className="mb-6">
          <p className="text-xl font-medium text-black dark:text-white mb-4">
            {t('create.auth_method')}
          </p>
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
            value={usePassword ? 'password' : 'biometrics'}
            onChange={value => setUsePassword(value === 'password')}
          />
        </div>
      )}
      {!biometricAvailable && (
        <div className="bg-white dark:bg-gray-800 rounded-lg p-4 mb-4 border border-blue-200 dark:border-blue-800">
          <p className="text-blue-600 dark:text-blue-400 text-sm">
            {t('create.biometric_not_supported')}
          </p>
        </div>
      )}
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
              error={username.length > 0 && !!usernameValidation.error}
              maxLength={20}
              disabled={isSubmitting}
            />
            {username.length > 0 && usernameValidation.error && (
              <p className="text-red-500 dark:text-red-400 text-xs mt-1">
                {usernameValidation.error}
              </p>
            )}
          </div>

          {usePassword && (
            <div>
              <label className="block text-xl font-medium text-black dark:text-white mb-3">
                {t('create.password')}
              </label>
              <RoundedInput
                type="password"
                value={password}
                onChange={handlePasswordChange}
                placeholder={t('create.enter_password')}
                error={password.length > 0 && !!passwordValidation.error}
                disabled={isSubmitting}
                showPasswordToggle={true}
                showPassword={showPasswords}
                onShowPasswordChange={setShowPasswords}
              />
              {password.length > 0 && passwordValidation.error && (
                <p className="text-red-500 dark:text-red-400 text-xs mt-1">
                  {passwordValidation.error}
                </p>
              )}
            </div>
          )}

          {usePassword && (
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
                disabled={isSubmitting}
                showPasswordToggle={false}
                showPassword={showPasswords}
              />
              {confirmPassword.length > 0 && !passwordsMatch && (
                <p className="text-red-500 dark:text-red-400 text-xs mt-1">
                  {t('create.passwords_do_not_match')}
                </p>
              )}
            </div>
          )}

          <div className="p-4 border rounded-lg bg-green-50 dark:bg-green-900/20 border-green-200 dark:border-green-800">
            <div className="flex items-start gap-3">
              <div className="shrink-0 mt-0.5">
                <CheckCircle className="h-5 w-5 text-green-500" />
              </div>
              <div>
                <p className="text-sm text-green-700 dark:text-green-300 leading-relaxed">
                  {usePassword
                    ? t('create.password_security_info')
                    : t('create.biometric_security_info')}
                </p>
              </div>
            </div>
          </div>

          {error && (
            <div className="p-4 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg">
              <p className="text-red-600 dark:text-red-400 text-sm">{error}</p>
            </div>
          )}

          <Button
            type="submit"
            disabled={!canSubmit || isSubmitting}
            loading={isSubmitting}
            variant="primary"
            size="custom"
            fullWidth
            className="h-11 rounded-full text-sm font-medium flex items-center justify-center gap-2"
          >
            {!isSubmitting && (
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
        onConfirm={handleICloudSyncChoice}
      />
    </PageLayout>
  );
};

export default AccountCreationFormView;
