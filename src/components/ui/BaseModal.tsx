import React, { useState, useEffect, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import Button from './Button';
import { useKeyDown } from '../../hooks/useKeyDown';
import { CloseIcon } from './icons';

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
    <div className="fixed inset-0 z-1000 flex items-end md:items-center justify-center md:p-6 pb-[76px] pb-safe">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/50 dark:bg-black/60 transition-opacity"
        onClick={onClose}
      />

      {/* Modal */}
      <div
        className={`relative w-full max-w-md md:max-w-md bg-card md:rounded-2xl rounded-t-3xl shadow-2xl transform transition-all duration-300 ease-out 
        ${mounted ? 'translate-y-0 md:translate-y-0 md:opacity-100' : 'translate-y-full md:translate-y-4 md:opacity-0'}`}
      >
        {/* Header */}
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
            <CloseIcon className="w-5 h-5 text-gray-500" />
          </Button>
        </div>

        {/* Content */}
        <div className="p-6 space-y-6">{children}</div>
      </div>
    </div>
  );

  return createPortal(modalContent, document.body);
};

export default BaseModal;
