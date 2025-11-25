import React from 'react';
import BaseModal from './BaseModal';
import Button from './Button';

interface VersionUpdateModalProps {
  isOpen: boolean;
  onClose: () => void;
  onAccept: () => void;
}

const VersionUpdateModal: React.FC<VersionUpdateModalProps> = ({
  isOpen,
  onClose,
  onAccept,
}) => {
  return (
    <BaseModal isOpen={isOpen} onClose={onClose} title="App Update Detected">
      <div className="space-y-4">
        <p className="text-sm text-foreground">
          A new version of the app has been detected. To ensure the best
          experience, we recommend clearing your database and cache. This will
          remove all local data and require you to sign in again.
        </p>
        <div className="flex gap-3">
          <Button
            onClick={onAccept}
            variant="primary"
            size="custom"
            className="flex-1 h-11 rounded-lg font-semibold"
          >
            Clean Now
          </Button>
          <Button
            onClick={onClose}
            variant="secondary"
            size="custom"
            className="flex-1 h-11 rounded-lg bg-gray-100 dark:bg-gray-700 text-gray-900 dark:text-white font-semibold"
          >
            Later
          </Button>
        </div>
      </div>
    </BaseModal>
  );
};

export default VersionUpdateModal;
