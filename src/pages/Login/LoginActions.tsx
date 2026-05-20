import React from 'react';
import { useTranslation } from 'react-i18next';
import Button from '../../components/ui/Button';

interface LoginActionsProps {
  onCreateNewAccount: () => void;
}

export const LoginActions: React.FC<LoginActionsProps> = ({
  onCreateNewAccount,
}) => {
  const { t } = useTranslation('auth');

  return (
    <div className="space-y-2">
      <Button
        onClick={onCreateNewAccount}
        variant="outline"
        size="custom"
        fullWidth
        className="h-[51px] rounded-full text-sm"
      >
        {t('login.create_account')}
      </Button>
    </div>
  );
};
