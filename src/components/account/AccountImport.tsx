import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Lock, Shield } from 'react-feather';
import { useAccountStore } from '../../stores/accountStore';
import { validateMnemonic, validatePassword } from '@massalabs/gossip-sdk';
import Button from '../ui/Button';
import PageHeader from '../ui/PageHeader';
import PageLayout from '../ui/PageLayout';
import RoundedInput from '../ui/RoundedInput';
import TabSwitcher from '../ui/TabSwitcher';

interface AccountImportProps {
  onBack: () => void;
  onComplete: () => void;
}

const AccountImport: React.FC<AccountImportProps> = ({
  onBack,
  onComplete,
}) => {
  const { restoreAccountFromMnemonic } = useAccountStore();
  const [mnemonic, setMnemonic] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [useBiometrics, setUseBiometrics] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [error, setError] = useState('');
  const [step, setStep] = useState<'mnemonic' | 'details'>('mnemonic');
  const [showPasswords, setShowPasswords] = useState(false);
  const { t } = useTranslation('auth');

  const handleMnemonicSubmit = () => {
    setError('');
    if (!mnemonic.trim()) {
      setError(t('import.mnemonic_empty'));
      return;
    }
    const trimmedMnemonic = mnemonic.trim().toLowerCase();
    if (!validateMnemonic(trimmedMnemonic)) {
      setError(t('import.mnemonic_invalid'));
      return;
    }
    setMnemonic(trimmedMnemonic);
    setStep('details');
  };

  const handleImport = async () => {
    try {
      setIsImporting(true);
      setError('');

      // Validate inputs
      if (!username.trim()) {
        setError(t('create.username_required'));
        return;
      }

      if (username.length < 3) {
        setError(t('create.username_min_length'));
        return;
      }

      if (!useBiometrics) {
        if (!password.trim()) {
          setError(t('login.password_required'));
          return;
        }

        const pwdValidation = validatePassword(password);
        if (!pwdValidation.valid) {
          setError(pwdValidation.error || t('login.invalid_password'));
          return;
        }

        if (password !== confirmPassword) {
          setError(t('create.passwords_do_not_match'));
          return;
        }
      }

      // Restore account from mnemonic
      if (useBiometrics) {
        await restoreAccountFromMnemonic(username, mnemonic, {
          useBiometrics: true,
        });
      } else {
        await restoreAccountFromMnemonic(username, mnemonic, {
          useBiometrics: false,
          password,
        });
      }

      onComplete();
    } catch (error) {
      console.error('Error importing account:', error);
      setError(error instanceof Error ? error.message : t('import.failed'));
    } finally {
      setIsImporting(false);
    }
  };

  const renderMnemonicStep = () => (
    <div className=" rounded-lg p-6 space-y-6">
      <div>
        <h3 className="text-xl font-semibold text-foreground mb-2">
          {t('import.title')}
        </h3>
        <p className="text-sm text-muted-foreground leading-relaxed">
          {t('import.description')}
        </p>
        <div className="mt-4">
          <label className="block text-sm font-medium text-foreground mb-2">
            {t('import.mnemonic_phrase')}
          </label>
          <textarea
            value={mnemonic}
            onChange={e => setMnemonic(e.target.value)}
            placeholder={t('import.mnemonic_placeholder')}
            className="w-full h-32 px-4 py-3 border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary text-sm resize-none text-foreground bg-background placeholder-muted-foreground"
            disabled={isImporting}
          />
          <p className="text-xs text-muted-foreground mt-1">
            {t('import.mnemonic_hint')}
          </p>
        </div>
      </div>

      {error && (
        <div className="p-4 bg-destructive/10 border border-destructive rounded-lg">
          <p className="text-destructive text-sm">{error}</p>
        </div>
      )}

      <div className="space-y-3">
        <Button
          onClick={handleMnemonicSubmit}
          disabled={isImporting || !mnemonic.trim()}
          variant="primary"
          size="custom"
          fullWidth
          className="h-12 text-sm font-medium rounded-full"
        >
          {t('common:continue')}
        </Button>
      </div>
    </div>
  );

  const renderDetailsStep = () => (
    <div className="bg-card rounded-lg p-6 space-y-6">
      <div>
        <h3 className="text-xl font-semibold text-foreground mb-2">
          {t('import.account_details')}
        </h3>
        <p className="text-sm text-muted-foreground leading-relaxed">
          {t('import.account_details_desc')}
        </p>
      </div>

      <div>
        <label className="block text-xl font-medium text-foreground mb-3">
          {t('create.username')}
        </label>
        <RoundedInput
          type="text"
          value={username}
          onChange={e => setUsername(e.target.value)}
          placeholder={t('import.enter_username')}
          disabled={isImporting}
        />
      </div>

      {/* Security Method Selection */}
      <div>
        <p className="text-xl font-medium text-foreground mb-5">
          {t('import.security_method')}
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
          value={useBiometrics ? 'biometrics' : 'password'}
          onChange={value => setUseBiometrics(value === 'biometrics')}
        />
      </div>

      {/* Password field - only show if not using biometrics */}
      {!useBiometrics && (
        <div>
          <label className="block text-xl font-medium text-foreground mb-3">
            {t('create.password')}
          </label>
          <RoundedInput
            type="password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            placeholder={t('import.enter_password')}
            error={password ? !validatePassword(password).valid : false}
            disabled={isImporting}
            showPasswordToggle={true}
            showPassword={showPasswords}
            onShowPasswordChange={setShowPasswords}
          />
          {password && !validatePassword(password).valid && (
            <p className="text-destructive text-xs mt-1">
              {validatePassword(password).error}
            </p>
          )}
        </div>
      )}

      {/* Confirm Password field */}
      {!useBiometrics && (
        <div>
          <label className="block text-xl font-medium text-foreground mb-3">
            {t('create.confirm_password_label')}
          </label>
          <RoundedInput
            type="password"
            value={confirmPassword}
            onChange={e => setConfirmPassword(e.target.value)}
            placeholder={t('create.confirm_password')}
            error={confirmPassword.length > 0 && password !== confirmPassword}
            disabled={isImporting}
            showPasswordToggle={false}
            showPassword={showPasswords}
          />
          {confirmPassword.length > 0 && password !== confirmPassword && (
            <p className="text-destructive text-xs mt-1">
              {t('create.passwords_do_not_match')}
            </p>
          )}
        </div>
      )}

      {error && (
        <div className="p-4 bg-destructive/10 border border-destructive rounded-lg">
          <p className="text-destructive text-sm">{error}</p>
        </div>
      )}

      <div className="space-y-3">
        <Button
          onClick={handleImport}
          disabled={
            isImporting ||
            !username.trim() ||
            (!useBiometrics &&
              (!validatePassword(password).valid ||
                password !== confirmPassword))
          }
          loading={isImporting}
          variant="primary"
          size="custom"
          fullWidth
          className="h-12 text-sm font-medium rounded-full"
        >
          {!isImporting && t('import.import_button')}
        </Button>
      </div>
    </div>
  );

  return (
    <PageLayout
      header={<PageHeader title={t('import.page_title')} onBack={onBack} />}
      className="app-max-w mx-auto"
      contentClassName="p-4"
    >
      {step === 'mnemonic' && renderMnemonicStep()}
      {step === 'details' && renderDetailsStep()}
    </PageLayout>
  );
};

export default AccountImport;
