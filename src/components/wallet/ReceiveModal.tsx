import React, { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Check as CheckIcon, Copy, Share2 } from 'react-feather';
import { useAccountStore } from '../../stores/accountStore';
import Button from '../ui/Button';
import BaseModal from '../ui/BaseModal';

import { formatMassaAddress } from '../../utils/addressUtils';
import toast from 'react-hot-toast';

interface ReceiveModalProps {
  isOpen: boolean;
  onClose: () => void;
}

const ReceiveModal: React.FC<ReceiveModalProps> = ({ isOpen, onClose }) => {
  const { account } = useAccountStore();
  const [copied, setCopied] = useState(false);
  const { t } = useTranslation('wallet');
  const timeoutRef = useRef<NodeJS.Timeout | null>(null);

  const fullAddress = account?.address?.toString() ?? '';
  const displayAddress = formatMassaAddress(fullAddress);

  useEffect(() => {
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, []);

  const handleCopyAddress = async () => {
    try {
      await navigator.clipboard.writeText(fullAddress);
      setCopied(true);

      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }

      timeoutRef.current = setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy address:', err);
    }
  };

  const handleShare = () => {
    // Placeholder for share functionality
    toast.success(t('receive.share_coming_soon'), {
      className: 'bg-card text-foreground',
      duration: 1000,
    });
  };

  return (
    <BaseModal isOpen={isOpen} onClose={onClose} title={t('receive.title')}>
      {/* Address Section */}
      <div>
        <label className="block text-sm font-medium text-foreground mb-2">
          {t('receive.your_address')}
        </label>
        <div className="flex items-center gap-2">
          <div className="flex-1 p-3 bg-input border border-border rounded-xl">
            <p className="text-sm text-foreground break-all">
              {displayAddress}
            </p>
          </div>
          <Button
            onClick={handleCopyAddress}
            variant={copied ? 'secondary' : 'primary'}
            className={
              copied
                ? 'bg-success hover:opacity-90 text-success-foreground'
                : ''
            }
          >
            {copied ? (
              <div className="flex items-center gap-2">
                <CheckIcon className="w-4 h-4" />
                {t('receive.copied')}
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <Copy className="w-4 h-4" />
                {t('common:copy')}
              </div>
            )}
          </Button>
        </div>
      </div>

      {/* Share Button */}
      <div>
        <Button
          onClick={handleShare}
          variant="secondary"
          fullWidth
          className="flex items-center justify-center gap-2"
        >
          <Share2 className="w-5 h-5" />
          {t('receive.share_with_contact')}
        </Button>
      </div>

      {/* Info Text */}
      <div className="text-center">
        <p className="text-sm text-muted-foreground">{t('receive.info')}</p>
      </div>
    </BaseModal>
  );
};

export default ReceiveModal;
