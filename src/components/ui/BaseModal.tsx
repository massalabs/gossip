import React, { useState, useEffect, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import Button from './Button';
import { useKeyDown } from '../../hooks/useKeyDown';
import { useFixedKeyboardStyles } from '../../hooks/useKeyboardVisible';
import { X } from 'react-feather';

interface BaseModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
}

const BaseModal: React.FC<BaseModalProps> = ({
  isOpen,
  onClose,
  title,
  children,
}) => {
  // Animation mount flag (animate on open)
  const [mounted, setMounted] = useState(false);
  const { onEsc } = useKeyDown({ enabled: isOpen });
  const keyboardStyles = useFixedKeyboardStyles();

  // Workaround: On iOS, when keyboard is visible, resize modal container
  // to prevent it from being pushed off-screen due to slow keyboard resize.
  // Note: Modal uses fixed positioning, so it needs its own height adjustment.
  // See: https://github.com/ionic-team/capacitor-keyboard/issues/19

  useEffect(() => {
    onEsc(() => onClose());
  }, [onEsc, onClose]);

  useEffect(() => {
    if (isOpen) {
      // next tick to allow transition
      const id = requestAnimationFrame(() => setMounted(true));
      return () => cancelAnimationFrame(id);
    }
    setMounted(false);
  }, [isOpen]);

  if (!isOpen) return null;

  const modalContent = (
    <div
      className="fixed inset-0 z-1000 flex flex-col items-center justify-end md:justify-center md:p-6 pt-safe-t pb-safe-b"
      style={keyboardStyles}
    >
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/50 dark:bg-black/60 transition-opacity"
        onClick={onClose}
      />

      <div
        className={`relative w-full max-w-md bg-card md:rounded-2xl rounded-t-3xl shadow-2xl transform transition-all duration-300 ease-out flex flex-col
        ${mounted ? 'translate-y-0 md:translate-y-0 md:opacity-100' : 'translate-y-full md:translate-y-4 md:opacity-0'}`}
      >
        <div className="flex items-center justify-between p-6 border-b border-gray-200 dark:border-gray-700">
          <h2 className="text-xl font-semibold text-gray-900 dark:text-white">
            {title}
          </h2>
          <Button
            onClick={onClose}
            variant="circular"
            size="custom"
            className="w-8 h-8 flex items-center justify-center"
          >
            <X className="w-5 h-5 text-gray-500" />
          </Button>
        </div>

        <div className="p-6 space-y-6">{children}</div>
      </div>
    </div>
  );

  return createPortal(modalContent, document.body);
};

export default BaseModal;
