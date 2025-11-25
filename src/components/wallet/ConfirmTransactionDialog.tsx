import React, { useEffect, useState } from 'react';
import { formatMassaAddress } from '../../utils/addressUtils';
import Button from '../ui/Button';

interface ConfirmTransactionDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
  recipient: string;
  amount: string;
  tokenName: string;
  tokenTicker: string;
  estimatedFee: string;
  totalCost: string;
  isLoading: boolean;
}

const ConfirmTransactionDialog: React.FC<ConfirmTransactionDialogProps> = ({
  isOpen,
  onClose,
  onConfirm,
  recipient,
  amount,
  tokenName,
  tokenTicker,
  estimatedFee,
  totalCost,
  isLoading,
}) => {
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    if (isOpen) {
      const id = requestAnimationFrame(() => setMounted(true));
      return () => cancelAnimationFrame(id);
    }
    setMounted(false);
  }, [isOpen]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center md:p-6">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/50 dark:bg-black/60 transition-opacity"
        onClick={!isLoading ? onClose : undefined}
      />

      {/* Dialog */}
      <div
        className={`relative w-full max-w-md md:max-w-md mx-4 bg-card rounded-2xl shadow-2xl transform transition-all duration-300 ease-out ${mounted ? 'translate-y-0 opacity-100' : 'translate-y-4 opacity-0'}`}
      >
        {/* Header */}
        <div className="p-6 border-b border-gray-200 dark:border-gray-700">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-white text-center">
            Confirm Transaction
          </h3>
        </div>

        {/* Content */}
        <div className="p-6 space-y-4">
          {/* Transaction Details */}
          <div className="space-y-3">
            {/* Recipient */}
            <div className="flex items-start py-2 gap-3">
              <span className="w-16 shrink-0 text-sm font-medium text-gray-600 dark:text-gray-400">
                To:
              </span>
              <div className="flex-1 min-w-0">
                <div className="text-sm text-gray-900 dark:text-white truncate">
                  {formatMassaAddress(recipient)}
                </div>
                <div className="text-xs text-gray-500 dark:text-gray-400 break-all leading-snug">
                  {recipient}
                </div>
              </div>
            </div>

            {/* Amount */}
            <div className="flex justify-between items-center py-2">
              <span className="text-sm font-medium text-gray-600 dark:text-gray-400">
                Amount:
              </span>
              <div className="text-right">
                <div className="text-sm font-semibold text-gray-900 dark:text-white">
                  {amount} {tokenTicker}
                </div>
                <div className="text-xs text-gray-500 dark:text-gray-400">
                  {tokenName}
                </div>
              </div>
            </div>

            {/* Fee */}
            <div className="flex justify-between items-center py-2">
              <span className="text-sm font-medium text-gray-600 dark:text-gray-400">
                Network Fee:
              </span>
              <span className="text-sm text-gray-900 dark:text-white">
                {estimatedFee}
              </span>
            </div>

            {/* Total */}
            <div className="flex justify-between items-center py-2 border-t border-gray-200 dark:border-gray-700">
              <span className="text-sm font-semibold text-gray-900 dark:text-white">
                Total:
              </span>
              <span className="text-sm font-semibold text-gray-900 dark:text-white">
                {totalCost}
              </span>
            </div>
          </div>

          {/* Warning */}
          <div className="p-3 bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-xl">
            <div className="flex items-start">
              <svg
                className="w-5 h-5 text-yellow-600 dark:text-yellow-400 mt-0.5 mr-2 shrink-0"
                fill="currentColor"
                viewBox="0 0 20 20"
              >
                <path
                  fillRule="evenodd"
                  d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z"
                  clipRule="evenodd"
                />
              </svg>
              <div>
                <p className="text-sm text-yellow-800 dark:text-yellow-200">
                  Please verify the recipient address and amount before
                  confirming. This transaction cannot be undone.
                </p>
              </div>
            </div>
          </div>
        </div>

        {/* Action Buttons */}
        <div className="flex gap-3 p-6 border-t border-gray-200 dark:border-gray-700">
          <Button
            onClick={onClose}
            disabled={isLoading}
            variant="secondary"
            fullWidth
          >
            Cancel
          </Button>
          <Button
            onClick={onConfirm}
            disabled={isLoading}
            loading={isLoading}
            variant="primary"
            fullWidth
          >
            {isLoading ? 'Confirming...' : 'Confirm'}
          </Button>
        </div>
      </div>
    </div>
  );
};

export default ConfirmTransactionDialog;
