import React from 'react';
import { useTranslation } from 'react-i18next';
import BaseModal from '../ui/BaseModal';
import Button from '../ui/Button';

interface ConfirmSheetProps {
  isOpen: boolean;
  title: string;
  body: string;
  confirmLabel: string;
  onConfirm: () => void;
  onClose: () => void;
}

/**
 * The confirmation of a chat action that cannot be undone (Lucas's screens
 * 11 and 13): a title, what happens, then Cancel and the action.
 */
const ConfirmSheet: React.FC<ConfirmSheetProps> = ({
  isOpen,
  title,
  body,
  confirmLabel,
  onConfirm,
  onClose,
}) => {
  const { t } = useTranslation('groups');
  return (
    <BaseModal isOpen={isOpen} onClose={onClose} title={title}>
      <div className="space-y-4">
        <p className="text-sm text-muted-foreground">{body}</p>
        <div className="flex gap-3">
          <Button
            variant="secondary"
            size="custom"
            className="flex-1 h-11 rounded-full font-semibold"
            onClick={onClose}
          >
            {t('choices.cancel')}
          </Button>
          <Button
            variant="danger"
            size="custom"
            className="flex-1 h-11 rounded-full font-semibold"
            onClick={onConfirm}
          >
            {confirmLabel}
          </Button>
        </div>
      </div>
    </BaseModal>
  );
};

export default ConfirmSheet;
