import React, { useEffect, useState } from 'react';
import { AlertTriangle } from 'react-feather';
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
        className={`relative w-full app-max-w md:app-max-w mx-4 bg-card rounded-2xl shadow-2xl transform transition-all duration-300 ease-out ${mounted ? 'translate-y-0 opacity-100' : 'translate-y-4 opacity-0'}`}
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
              <AlertTriangle className="w-5 h-5 text-yellow-600 dark:text-yellow-400 mt-0.5 mr-2 shrink-0" />
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
