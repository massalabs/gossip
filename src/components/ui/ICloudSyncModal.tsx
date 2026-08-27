import React from 'react';
import { Check, Info } from 'react-feather';
import { useTranslation } from 'react-i18next';
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

  const handleEnable = () => {
    onConfirm(true);
    onClose();
  };

  const handleDisable = () => {
    onConfirm(false);
    onClose();
  };

  return (
    <BaseModal isOpen={isOpen} onClose={onClose} title={t('icloud_sync.title')}>
      <div className="space-y-4">
        <div className="space-y-3">
          <p className="text-sm text-foreground">{t('icloud_sync.question')}</p>

          <div className="bg-muted rounded-lg p-4 space-y-2">
            <h4 className="text-sm font-semibold text-foreground flex items-center gap-2">
              <Check className="w-4 h-4 text-success" aria-hidden="true" />
              {t('icloud_sync.benefits_title')}
            </h4>
            <ul className="text-xs text-muted-foreground space-y-1 ml-6">
              <li>• {t('icloud_sync.benefit_devices')}</li>
              <li>• {t('icloud_sync.benefit_backup')}</li>
              <li>• {t('icloud_sync.benefit_sync')}</li>
            </ul>
          </div>

          <div className="bg-muted rounded-lg p-4 space-y-2">
            <h4 className="text-sm font-semibold text-foreground flex items-center gap-2">
              <Info
                className="w-4 h-4 text-muted-foreground"
                aria-hidden="true"
              />
              {t('icloud_sync.note_title')}
            </h4>
            <p className="text-xs text-muted-foreground">
              {t('icloud_sync.note_body')}
            </p>
          </div>
        </div>

        <div className="flex flex-col gap-2 pt-2">
          <Button
            onClick={handleEnable}
            variant="primary"
            size="custom"
            fullWidth
            className="h-11 rounded-xl text-sm font-medium"
          >
            {t('icloud_sync.enable')}
          </Button>
          <Button
            onClick={handleDisable}
            variant="outline"
            size="custom"
            fullWidth
            className="h-11 rounded-xl text-sm font-medium"
          >
            {t('icloud_sync.keep_local')}
          </Button>
        </div>
      </div>
    </BaseModal>
  );
};

export default ICloudSyncModal;
