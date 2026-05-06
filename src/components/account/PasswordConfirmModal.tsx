import React from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle } from 'react-feather';
import BaseModal from '../ui/BaseModal';
import Button from '../ui/Button';

interface PasswordConfirmModalProps {
  isOpen: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

const PasswordConfirmModal: React.FC<PasswordConfirmModalProps> = ({
  isOpen,
  onConfirm,
  onCancel,
}) => {
  const { t } = useTranslation('auth');

  return (
    <BaseModal
      isOpen={isOpen}
      onClose={onCancel}
      title={t('create.password_confirm_title')}
    >
      <div className="space-y-6">
        <div className="flex items-start gap-3 p-4 rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800">
          <div className="shrink-0 mt-0.5">
            <AlertTriangle className="h-5 w-5 text-amber-500" />
          </div>
          <p className="text-sm text-amber-700 dark:text-amber-300 leading-relaxed">
            {t('create.password_confirm_message')}
          </p>
        </div>

        <div className="flex flex-col gap-2">
          <Button
            onClick={onConfirm}
            variant="primary"
            size="custom"
            fullWidth
            className="h-11 rounded-xl text-sm font-medium"
          >
            {t('create.password_confirm_validate')}
          </Button>
          <Button
            onClick={onCancel}
            variant="outline"
            size="custom"
            fullWidth
            className="h-11 rounded-xl text-sm font-medium"
          >
            {t('create.password_confirm_back')}
          </Button>
        </div>
      </div>
    </BaseModal>
  );
};

export default PasswordConfirmModal;
