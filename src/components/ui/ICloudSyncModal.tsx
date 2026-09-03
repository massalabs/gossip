import React from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Check } from 'react-feather';
import BaseModal from './BaseModal';
import Button from './Button';

interface ICloudSyncModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: (enableSync: boolean) => void;
}

const ICloudSyncModal: React.FC<ICloudSyncModalProps> = ({
  isOpen,
  onClose,
  onConfirm,
}) => {
  const { t } = useTranslation('auth');

  const handleConfirm = (enableSync: boolean) => {
    onConfirm(enableSync);
    onClose();
  };

  return (
    <BaseModal
      isOpen={isOpen}
      onClose={onClose}
      title={t('biometric_setup.icloud_title')}
    >
      <div className="space-y-4">
        <p className="text-sm text-foreground">
          {t('biometric_setup.icloud_prompt')}
        </p>

        <div className="bg-muted rounded-lg p-4 space-y-2">
          <h4 className="text-sm font-semibold text-foreground flex items-center gap-2">
            <Check className="w-4 h-4 text-success" aria-hidden="true" />
            {t('biometric_setup.icloud_benefit_title')}
          </h4>
          <p className="text-xs text-muted-foreground">
            {t('biometric_setup.icloud_benefit')}
          </p>
        </div>

        <div className="p-4 rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800">
          <div className="flex items-start gap-2">
            <AlertTriangle
              className="w-4 h-4 text-amber-500 shrink-0 mt-0.5"
              aria-hidden="true"
            />
            <p className="text-xs text-amber-700 dark:text-amber-300">
              {t('biometric_setup.icloud_warning')}
            </p>
          </div>
        </div>

        <div className="flex flex-col gap-2 pt-2">
          <Button
            onClick={() => handleConfirm(true)}
            variant="primary"
            size="custom"
            fullWidth
            className="h-11 rounded-xl text-sm font-medium"
          >
            {t('biometric_setup.icloud_enable')}
          </Button>
          <Button
            onClick={() => handleConfirm(false)}
            variant="outline"
            size="custom"
            fullWidth
            className="h-11 rounded-xl text-sm font-medium"
          >
            {t('biometric_setup.icloud_local')}
          </Button>
        </div>
      </div>
    </BaseModal>
  );
};

export default ICloudSyncModal;
