import React, { useState, useCallback, useEffect } from 'react';
import Button from '../ui/Button';

export interface FeeConfig {
  type: 'preset' | 'custom';
  preset?: 'low' | 'standard' | 'high';
  customFee?: string;
}

interface FeeConfigModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: (config: FeeConfig) => void;
  currentConfig: FeeConfig;
}

const FeeConfigModal: React.FC<FeeConfigModalProps> = ({
  isOpen,
  onClose,
  onConfirm,
  currentConfig,
}) => {
  const [config, setConfig] = useState<FeeConfig>(currentConfig);

  const handlePresetChange = useCallback(
    (preset: 'low' | 'standard' | 'high') => {
      setConfig({
        type: 'preset',
        preset,
      });
    },
    []
  );

  const handleCustomToggle = useCallback(() => {
    setConfig({
      type: 'custom',
      customFee: config.customFee || '0.01',
    });
  }, [config.customFee]);

  const handleCustomFeeChange = useCallback((value: string) => {
    setConfig(prev => ({
      ...prev,
      customFee: value,
    }));
  }, []);

  const handleConfirm = useCallback(() => {
    onConfirm(config);
    onClose();
  }, [config, onConfirm, onClose]);

  // Animate on open
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    if (isOpen) {
      const id = requestAnimationFrame(() => setMounted(true));
      return () => cancelAnimationFrame(id);
    }
    setMounted(false);
  }, [isOpen]);

  if (!isOpen) return null;

  const presetFees = {
    low: {
      value: '0.01',
      label: 'Low (0.01 MAS)',
      description: 'Slower confirmation',
    },
    standard: {
      value: '0.03',
      label: 'Standard (0.03 MAS)',
      description: 'Recommended',
    },
    high: {
      value: '0.1',
      label: 'High (0.1 MAS)',
      description: 'Fast confirmation',
    },
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center md:p-6">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/50 dark:bg-black/60 transition-opacity"
        onClick={onClose}
      />

      {/* Modal */}
      <div
        className={`relative w-full max-w-md md:max-w-md mx-4 bg-card rounded-2xl shadow-2xl transform transition-all duration-300 ease-out ${mounted ? 'translate-y-0 opacity-100' : 'translate-y-4 opacity-0'}`}
      >
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-gray-200 dark:border-gray-700">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
            Advanced
          </h3>
          <button
            onClick={onClose}
            className="w-8 h-8 flex items-center justify-center rounded-full hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
          >
            <svg
              className="w-5 h-5 text-gray-500"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>
        </div>

        {/* Content */}
        <div className="p-6">
          {/* Explanation */}
          <div className="mb-6">
            <p className="text-sm text-gray-600 dark:text-gray-400">
              You pay gas fees to reward block validators and maximize your
              chances to see your transaction validated. It is a tip for people
              that support the blockchain network.
            </p>
          </div>

          {/* Fee Type Selection */}
          <div className="space-y-4">
            {/* Preset Option */}
            <div>
              <label className="flex items-center mb-3">
                <input
                  type="radio"
                  name="feeType"
                  checked={config.type === 'preset'}
                  onChange={() =>
                    setConfig({ type: 'preset', preset: 'standard' })
                  }
                  className="w-4 h-4 text-blue-600 border-gray-300 focus:ring-blue-500"
                />
                <span className="ml-2 text-sm font-medium text-gray-900 dark:text-white">
                  Preset
                </span>
              </label>

              {config.type === 'preset' && (
                <div className="ml-6 space-y-2">
                  {Object.entries(presetFees).map(([key, fee]) => (
                    <button
                      key={key}
                      onClick={() =>
                        handlePresetChange(key as 'low' | 'standard' | 'high')
                      }
                      className={`w-full p-3 rounded-xl border transition-colors text-left ${
                        config.preset === key
                          ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20'
                          : 'border-gray-200 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-700'
                      }`}
                    >
                      <div className="flex justify-between items-center">
                        <div>
                          <div className="font-medium text-gray-900 dark:text-white">
                            {fee.label}
                          </div>
                          <div className="text-xs text-gray-500 dark:text-gray-400">
                            {fee.description}
                          </div>
                        </div>
                        {config.preset === key && (
                          <div className="w-5 h-5 bg-blue-500 rounded-full flex items-center justify-center">
                            <svg
                              className="w-3 h-3 text-white"
                              fill="currentColor"
                              viewBox="0 0 20 20"
                            >
                              <path
                                fillRule="evenodd"
                                d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                                clipRule="evenodd"
                              />
                            </svg>
                          </div>
                        )}
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Custom Option */}
            <div>
              <label className="flex items-center mb-3">
                <input
                  type="radio"
                  name="feeType"
                  checked={config.type === 'custom'}
                  onChange={handleCustomToggle}
                  className="w-4 h-4 text-blue-600 border-gray-300 focus:ring-blue-500"
                />
                <span className="ml-2 text-sm font-medium text-gray-900 dark:text-white">
                  Custom fees
                </span>
              </label>

              {config.type === 'custom' && (
                <div className="ml-6">
                  <input
                    type="number"
                    value={config.customFee || ''}
                    onChange={e => handleCustomFeeChange(e.target.value)}
                    placeholder="Custom fees"
                    step="0.001"
                    min="0"
                    className="w-full px-4 py-3 bg-gray-100 dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-xl focus:ring-2 focus:ring-blue-500 focus:border-transparent dark:text-white placeholder-gray-500 dark:placeholder-gray-400"
                  />
                  <div className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                    Enter fee in MAS
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Action Buttons */}
        <div className="flex gap-3 p-6 border-t border-gray-200 dark:border-gray-700">
          <Button onClick={onClose} variant="secondary" fullWidth>
            Cancel
          </Button>
          <Button
            onClick={handleConfirm}
            disabled={
              config.type === 'custom' &&
              (!config.customFee || parseFloat(config.customFee) <= 0)
            }
            variant="primary"
            fullWidth
          >
            Confirm fees
          </Button>
        </div>
      </div>
    </div>
  );
};

export default FeeConfigModal;
