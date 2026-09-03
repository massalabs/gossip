import React from 'react';
import { useTranslation } from 'react-i18next';
import PageHeader from '../ui/PageHeader';
import PageLayout from '../ui/Layout/PageLayout';
import AccountCreationForm, {
  type AccountCreationResult,
} from './AccountCreationForm';

interface SecureAccountFormProps {
  onSubmit: (result: AccountCreationResult) => void | Promise<void>;
  onBack: () => void;
}

const SecureAccountForm: React.FC<SecureAccountFormProps> = ({
  onSubmit,
  onBack,
}) => {
  const { t } = useTranslation('auth');

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
      <AccountCreationForm
        onSubmit={async result => onSubmit(result)}
        standalone={false}
        allowMnemonicImport
      />
    </PageLayout>
  );
};

export default SecureAccountForm;
