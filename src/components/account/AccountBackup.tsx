import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Copy, AlertTriangle } from 'react-feather';
import { useAccountStore } from '../../stores/accountStore';
import PageHeader from '../ui/PageHeader';
import PageLayout from '../ui/Layout/PageLayout';
import TabSwitcher from '../ui/TabSwitcher';
import Button from '../ui/Button';
import RoundedInput from '../ui/RoundedInput';
import { Account } from '@massalabs/massa-web3';

interface AccountBackupProps {
  onBack: () => void;
}

const AccountBackup: React.FC<AccountBackupProps> = ({ onBack }) => {
  const { t } = useTranslation('settings');
  const { userProfile, showBackup } = useAccountStore();
  const [method, setMethod] = useState<'mnemonic' | 'privateKey'>('mnemonic');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const [password, setPassword] = useState('');
  const [passwordError, setPasswordError] = useState('');
  const [backupInfo, setBackupInfo] = useState<{
    mnemonic: string;
    account: Account;
  } | null>(null);
  const [privateKeyString, setPrivateKeyString] = useState<string | null>(null);

  const requiresPassword = userProfile?.security?.authMethod === 'password';

  const handleShow = async () => {
    try {
      setIsLoading(true);
      setError('');
      setPasswordError('');

      if (requiresPassword && !password.trim()) {
        setPasswordError(t('backup.password_required'));
        return;
      }
      const backupInfo = await showBackup(
        requiresPassword ? password : undefined
      );
      setBackupInfo(backupInfo);
      setPrivateKeyString(backupInfo.account.privateKey.toString());
    } catch (e) {
      console.error('Error showing backup:', e);
      const message = t('backup.show_failed');
      setError(message);
      setPasswordError(message);
    } finally {
      setIsLoading(false);
    }
  };

  const copyText = async (text?: string | null) => {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
    } catch (_e) {
      // ignore
    }
  };

  return (
    <PageLayout
      header={<PageHeader title={t('backup.title')} onBack={onBack} />}
      className="app-max-w mx-auto"
      contentClassName="p-4 space-y-6"
    >
      {/* Tabs - Only show when backup info is displayed */}
      {backupInfo && (
        <div className="mb-4">
          <p className="text-xl font-medium text-foreground mb-3">
            {t('backup.method')}
          </p>
          <TabSwitcher
            options={[
              {
                value: 'mnemonic',
                label: t('backup.mnemonic'),
              },
              {
                value: 'privateKey',
                label: t('backup.private_key'),
              },
            ]}
            value={method}
            onChange={setMethod}
          />
        </div>
      )}

      {/* Input/auth section */}
      {((method === 'mnemonic' && !backupInfo) ||
        (method === 'privateKey' && !privateKeyString)) && (
        <div className="bg-card rounded-lg p-6 space-y-6 border border-border">
          {requiresPassword ? (
            <>
              <div>
                <label className="block text-xl font-medium text-foreground mb-3">
                  {t('backup.enter_password')}
                </label>
                <RoundedInput
                  type="password"
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  placeholder={t('backup.password_placeholder')}
                  error={!!passwordError}
                  disabled={isLoading}
                />
                {(error || passwordError) && (
                  <p className="text-destructive text-xs mt-1">
                    {error || passwordError}
                  </p>
                )}
              </div>
              <Button
                onClick={handleShow}
                disabled={isLoading || !password.trim()}
                loading={isLoading}
                variant="primary"
                size="custom"
                fullWidth
                className="h-11 text-sm font-medium"
              >
                {!isLoading && t('backup.show_backup')}
              </Button>
            </>
          ) : (
            <Button
              onClick={handleShow}
              disabled={isLoading}
              loading={isLoading}
              variant="primary"
              size="custom"
              fullWidth
              className="h-11 text-sm font-medium"
            >
              {!isLoading && t('backup.show_backup')}
            </Button>
          )}
        </div>
      )}

      {/* Display Mnemonic */}
      {method === 'mnemonic' && backupInfo && (
        <div className="bg-card rounded-lg p-6 space-y-4 border border-border">
          <div className="flex items-center justify-between">
            <h4 className="text-xl font-medium text-foreground">
              {t('backup.mnemonic_title')}
            </h4>
            <Button
              onClick={() => copyText(backupInfo.mnemonic)}
              variant="ghost"
              size="custom"
              className="text-sm font-medium text-muted-foreground hover:text-foreground flex items-center gap-2 p-0"
            >
              <Copy className="w-4 h-4" />
              {t('common:copy')}
            </Button>
          </div>
          <div className="bg-muted rounded-lg p-4">
            <p className="text-sm text-foreground break-all leading-relaxed">
              {backupInfo.mnemonic}
            </p>
          </div>
          <div className="p-4 border rounded-lg bg-warning/20 border-warning/40">
            <div className="flex items-start gap-3">
              <div className="shrink-0 mt-0.5">
                <AlertTriangle className="h-5 w-5 text-warning" />
              </div>
              <p className="text-sm text-foreground leading-relaxed font-medium">
                {t('backup.never_share')}
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Display Private Key */}
      {method === 'privateKey' && privateKeyString && (
        <div className="bg-card rounded-lg p-6 space-y-4 border border-border">
          <div className="flex items-center justify-between">
            <h4 className="text-xl font-medium text-foreground">
              {t('backup.private_key')}
            </h4>
            <Button
              onClick={() => copyText(privateKeyString)}
              variant="ghost"
              size="custom"
              className="text-sm font-medium text-muted-foreground hover:text-foreground flex items-center gap-2 p-0"
            >
              <Copy className="w-4 h-4" />
              {t('common:copy')}
            </Button>
          </div>
          <div className="bg-muted rounded-lg p-4">
            <p className="text-sm text-foreground break-all leading-relaxed">
              {privateKeyString}
            </p>
          </div>
          <div className="p-4 border rounded-lg bg-warning/20 border-warning/40">
            <div className="flex items-start gap-3">
              <div className="shrink-0 mt-0.5">
                <AlertTriangle className="h-5 w-5 text-warning" />
              </div>
              <div className="space-y-2">
                <p
                  className="text-sm text-foreground leading-relaxed font-medium"
                  dangerouslySetInnerHTML={{
                    __html: t('backup.private_key_warning'),
                  }}
                />
                <p className="text-sm text-foreground leading-relaxed font-medium">
                  {t('backup.never_share')}
                </p>
              </div>
            </div>
          </div>
        </div>
      )}
    </PageLayout>
  );
};

export default AccountBackup;
