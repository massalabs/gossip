import React, { useEffect, useState, useCallback } from 'react';
import BaseModal from './BaseModal';
import Button from './Button';
import { useKeyDown } from '../../hooks/useKeyDown';
interface ContactNameModalProps {
  isOpen: boolean;
  title: string;
  initialName: string;
  confirmLabel: string;
  allowEmpty?: boolean;
  showSkip?: boolean;
  error?: string | null;
  onConfirm: (name?: string) => void;
  onClose: () => void;
  onSkip?: () => void;
}

const ContactNameModal: React.FC<ContactNameModalProps> = ({
  isOpen,
  title,
  initialName,
  confirmLabel,
  allowEmpty = false,
  showSkip = false,
  error,
  onConfirm,
  onClose,
  onSkip,
}) => {
  const [name, setName] = useState(initialName);
  const { onEnter } = useKeyDown({ enabled: isOpen });

  useEffect(() => {
    if (isOpen) setName(initialName);
  }, [isOpen, initialName]);

  const handleConfirm = useCallback(() => {
    const trimmed = name.trim();
    if (!allowEmpty && trimmed.length === 0) {
      // Let parent surface the error; still pass empty to indicate invalid attempt
      onConfirm('');
      return;
    }
    onConfirm(trimmed.length > 0 ? trimmed : undefined);
  }, [name, allowEmpty, onConfirm]);

  useEffect(() => {
    onEnter(handleConfirm);
  }, [onEnter, handleConfirm]);

  return (
    <BaseModal isOpen={isOpen} onClose={onClose} title={title}>
      <div className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-foreground mb-1">
            Name
          </label>
          <input
            type="text"
            autoFocus
            value={name}
            onChange={e => setName(e.target.value)}
            className="w-full h-11 px-3 rounded-lg border border-border bg-card dark:bg-input text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            placeholder="Enter a name"
          />
          {error && (
            <p className="mt-1 text-xs text-red-600 dark:text-red-400">
              {error}
            </p>
          )}
        </div>
        <div className="flex gap-3">
          <Button
            onClick={handleConfirm}
            variant="primary"
            size="custom"
            className="flex-1 h-11 rounded-xl text-sm font-medium"
          >
            {confirmLabel}
          </Button>
          {showSkip ? (
            <Button
              onClick={onSkip}
              variant="secondary"
              size="custom"
              className="flex-1 h-11 rounded-lg bg-gray-100 dark:bg-gray-700 text-gray-900 dark:text-white font-semibold"
            >
              Skip
            </Button>
          ) : (
            <Button
              onClick={onClose}
              variant="secondary"
              size="custom"
              className="flex-1 h-11 rounded-lg bg-gray-100 dark:bg-gray-700 text-gray-900 dark:text-white font-semibold"
            >
              Cancel
            </Button>
          )}
        </div>
      </div>
    </BaseModal>
  );
};

export default ContactNameModal;
