import React from 'react';
import { Key, Upload } from 'react-feather';
import { useTranslation } from 'react-i18next';
import Button from '../ui/Button';
import PageHeader from '../ui/PageHeader';
import PageLayout from '../ui/Layout/PageLayout';

interface RestoreChoiceProps {
  onMnemonic: () => void;
  onBackupFile: () => void;
  onBack: () => void;
}

/** Restore an existing identity: recovery phrase or Gossip backup file. */
const RestoreChoice: React.FC<RestoreChoiceProps> = ({
  onMnemonic,
  onBackupFile,
  onBack,
}) => {
  const { t } = useTranslation('auth');
  return (
    <PageLayout
      header={<PageHeader title={t('restore.title')} onBack={onBack} />}
      className="app-max-w mx-auto"
      contentClassName="p-4 space-y-3"
    >
      <div className="rounded-2xl border border-border bg-card p-5 space-y-3 shadow-sm dark:shadow-none">
        <Key className="w-7 h-7 text-primary" />
        <div className="space-y-1">
          <h2 className="font-semibold text-foreground">
            {t('restore.mnemonic_title')}
          </h2>
          <p className="text-sm text-muted-foreground">
            {t('restore.mnemonic_body')}
          </p>
        </div>
        <Button fullWidth onClick={onMnemonic}>
          {t('restore.mnemonic_action')}
        </Button>
      </div>

      <div className="rounded-2xl border border-border bg-card p-5 space-y-3 shadow-sm dark:shadow-none">
        <Upload className="w-7 h-7 text-primary" />
        <div className="space-y-1">
          <h2 className="font-semibold text-foreground">
            {t('onboarding_choice.import_title')}
          </h2>
          <p className="text-sm text-muted-foreground">
            {t('onboarding_choice.import_body')}
          </p>
        </div>
        <Button fullWidth variant="outline" onClick={onBackupFile}>
          {t('onboarding_choice.import')}
        </Button>
      </div>
    </PageLayout>
  );
};

export default RestoreChoice;
