import React, { useState } from 'react';
import { Lock, Shield } from 'react-feather';
import { useAccountStore } from '../../stores/accountStore';
import { validateMnemonic } from '../../crypto/bip39';
import { validatePassword } from '../../utils/validation';
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
  const [useBiometrics, setUseBiometrics] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [error, setError] = useState('');
  const [step, setStep] = useState<'mnemonic' | 'details'>('mnemonic');

  const handleMnemonicSubmit = () => {
    setError('');
    if (!mnemonic.trim()) {
      setError('Please enter a mnemonic phrase');
      return;
    }
    const trimmedMnemonic = mnemonic.trim().toLowerCase();
    if (!validateMnemonic(trimmedMnemonic)) {
      setError(
        'Invalid mnemonic phrase. Please check your words and try again.'
      );
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
        setError('Username is required');
        return;
      }

      if (username.length < 3) {
        setError('Username must be at least 3 characters long');
        return;
      }

      if (!useBiometrics) {
        if (!password.trim()) {
          setError('Password is required');
          return;
        }

        const pwdValidation = validatePassword(password);
        if (!pwdValidation.valid) {
          setError(pwdValidation.error || 'Invalid password');
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
      setError(
        error instanceof Error
          ? error.message
          : 'Failed to import account. Please try again.'
      );
    } finally {
      setIsImporting(false);
    }
  };

  const renderMnemonicStep = () => (
    <div className=" rounded-lg p-6 space-y-6">
      <div>
        <h3 className="text-xl font-semibold text-foreground mb-2">
          Import with Mnemonic
        </h3>
        <p className="text-sm text-muted-foreground leading-relaxed">
          Enter your 24-word mnemonic phrase to import your account. Make sure
          to enter the words in the correct order.
        </p>
        <div className="mt-4">
          <label className="block text-sm font-medium text-foreground mb-2">
            Mnemonic Phrase
          </label>
          <textarea
            value={mnemonic}
            onChange={e => setMnemonic(e.target.value)}
            placeholder="Enter your mnemonic phrase here..."
            className="w-full h-32 px-4 py-3 border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary text-sm resize-none text-foreground bg-background placeholder-muted-foreground"
            disabled={isImporting}
          />
          <p className="text-xs text-muted-foreground mt-1">
            Separate words with spaces. The phrase is case-insensitive.
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
          Continue
        </Button>
      </div>
    </div>
  );

  const renderDetailsStep = () => (
    <div className="bg-card rounded-lg p-6 space-y-6">
      <div>
        <h3 className="text-xl font-semibold text-foreground mb-2">
          Account Details
        </h3>
        <p className="text-sm text-muted-foreground leading-relaxed">
          Choose a username and security method for your imported account.
        </p>
      </div>

      <div>
        <label className="block text-xl font-medium text-foreground mb-3">
          Username
        </label>
        <RoundedInput
          type="text"
          value={username}
          onChange={e => setUsername(e.target.value)}
          placeholder="Enter your username"
          disabled={isImporting}
        />
      </div>

      {/* Security Method Selection */}
      <div>
        <p className="text-xl font-medium text-foreground mb-5">
          Security Method
        </p>
        <TabSwitcher
          options={[
            {
              value: 'biometrics',
              label: 'Biometrics',
              icon: <Shield className="w-4 h-4" />,
            },
            {
              value: 'password',
              label: 'Password',
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
            Password
          </label>
          <RoundedInput
            type="password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            placeholder="Enter your password"
            error={password ? !validatePassword(password).valid : false}
            disabled={isImporting}
          />
          {password && !validatePassword(password).valid && (
            <p className="text-destructive text-xs mt-1">
              {validatePassword(password).error}
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
            (!useBiometrics && !validatePassword(password).valid)
          }
          loading={isImporting}
          variant="primary"
          size="custom"
          fullWidth
          className="h-12 text-sm font-medium rounded-full"
        >
          {!isImporting && 'Import Account'}
        </Button>
      </div>
    </div>
  );

  return (
    <PageLayout
      header={<PageHeader title="Import Account" onBack={onBack} />}
      className="app-max-w mx-auto"
      contentClassName="p-4"
    >
      {step === 'mnemonic' && renderMnemonicStep()}
      {step === 'details' && renderDetailsStep()}
    </PageLayout>
  );
};

export default AccountImport;
