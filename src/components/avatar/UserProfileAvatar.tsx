import React, { useCallback, useState } from 'react';
import { getProfileHead } from './profileHeads';
import BaseModal from '../ui/BaseModal';
import Popover from '../ui/Popover';
import Button from '../ui/Button';
import { useNClicksTrigger } from '../../hooks/useNClicksTrigger';
import { useAccountStore } from '../../stores/accountStore';

interface UserProfileAvatarProps {
  name?: string;
  size?: number; // allowed: 8, 10, 12, 14, 16 (maps to w-*/h-*)
  className?: string;
  /** When false, renders only the head illustration (no 3-tap delete flow). Use when the parent handles taps (e.g. Settings). */
  interactive?: boolean;
}

const SIZE_CLASS_MAP: Record<number, string> = {
  8: 'w-8 h-8',
  10: 'w-10 h-10',
  12: 'w-12 h-12',
  14: 'w-14 h-14',
  16: 'w-16 h-16',
};

const PADDING_MAP: Record<number, string> = {
  8: 'p-1',
  10: 'p-1.5',
  12: 'p-2',
  14: 'p-2',
  16: 'p-2.5',
};

/**
 * Current user's avatar: brand surface (`bg-primary`), not the hashed palette used for contacts.
 * Head illustration is still deterministic from `name` via `getProfileHead`.
 */
const UserProfileAvatar: React.FC<UserProfileAvatarProps> = ({
  name = '',
  size = 10,
  className = '',
  interactive = true,
}) => {
  const sizeClass = SIZE_CLASS_MAP[size] ?? SIZE_CLASS_MAP[10];
  const paddingClass = PADDING_MAP[size] ?? PADDING_MAP[10];

  const resetAccount = useAccountStore.use.resetAccount();
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  const handleOpenModal = useCallback(() => {
    setIsModalOpen(true);
  }, []);

  const { ping } = useNClicksTrigger({
    clickNumber: 3,
    callback: handleOpenModal,
    pingTimeout: 2000,
  });

  const handleCloseModal = useCallback(() => {
    if (isDeleting) return;
    setIsModalOpen(false);
  }, [isDeleting]);

  const handleConfirmDelete = useCallback(async () => {
    if (isDeleting) return;
    setIsDeleting(true);
    try {
      await resetAccount();
    } catch (error) {
      console.error('Failed to reset account from avatar tap:', error);
    } finally {
      setIsDeleting(false);
      setIsModalOpen(false);
    }
  }, [isDeleting, resetAccount]);

  return (
    <>
      <div
        onClick={interactive ? ping : undefined}
        className={`${sizeClass} ${paddingClass} ${className} shrink-0 rounded-full border border-border bg-primary flex items-center justify-center ${
          interactive
            ? 'cursor-pointer active:opacity-80 transition-opacity'
            : ''
        }`}
      >
        <img
          src={getProfileHead(name)}
          className="w-full h-full object-contain"
          alt="Profile"
        />
      </div>

      {interactive && (
        <BaseModal
          isOpen={isModalOpen}
          onClose={handleCloseModal}
          title="Delete current session"
        >
          <div className="space-y-4">
            <div className="flex items-center justify-between gap-3">
              <p className="text-sm font-semibold text-destructive">
                Attention: Deleting current Session is an irreversible action
              </p>
              <Popover message="If other sessions on the device, they will not be deleted" />
            </div>
            <div className="mt-4 flex gap-3">
              <Button
                variant="outline"
                size="custom"
                className="flex-1 h-11 rounded-full"
                onClick={handleCloseModal}
                disabled={isDeleting}
              >
                Cancel
              </Button>
              <Button
                variant="danger"
                size="custom"
                className="flex-1 h-11 rounded-full"
                onClick={handleConfirmDelete}
                loading={isDeleting}
              >
                Delete session
              </Button>
            </div>
          </div>
        </BaseModal>
      )}
    </>
  );
};

export default UserProfileAvatar;
