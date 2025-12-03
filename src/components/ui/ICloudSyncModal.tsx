import React from 'react';
import { Check, Info } from 'react-feather';
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
  const handleEnable = () => {
    onConfirm(true);
    onClose();
  };

  const handleDisable = () => {
    onConfirm(false);
    onClose();
  };

  return (
    <BaseModal isOpen={isOpen} onClose={onClose} title="iCloud Keychain Sync">
      <div className="space-y-4">
        <div className="space-y-3">
          <p className="text-sm text-foreground">
            Would you like to sync your account credentials with iCloud
            Keychain?
          </p>

          <div className="bg-muted rounded-lg p-4 space-y-2">
            <h4 className="text-sm font-semibold text-foreground flex items-center gap-2">
              <Check className="w-4 h-4 text-success" aria-hidden="true" />
              Benefits
            </h4>
            <ul className="text-xs text-muted-foreground space-y-1 ml-6">
              <li>• Access your account from all your Apple devices</li>
              <li>• Automatic backup to iCloud</li>
              <li>• Seamless sync across iPhone, iPad, and Mac</li>
            </ul>
          </div>

          <div className="bg-muted rounded-lg p-4 space-y-2">
            <h4 className="text-sm font-semibold text-foreground flex items-center gap-2">
              <Info className="w-4 h-4 text-primary" aria-hidden="true" />
              Note
            </h4>
            <p className="text-xs text-muted-foreground">
              iCloud Keychain must be enabled on your device for sync to work.
              Your credentials are encrypted and secure.
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
            Enable iCloud Sync
          </Button>
          <Button
            onClick={handleDisable}
            variant="outline"
            size="custom"
            fullWidth
            className="h-11 rounded-xl text-sm font-medium"
          >
            Keep Local Only
          </Button>
        </div>
      </div>
    </BaseModal>
  );
};

export default ICloudSyncModal;
