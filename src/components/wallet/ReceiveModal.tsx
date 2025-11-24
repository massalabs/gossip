import React, { useState } from 'react';
import { useAccountStore } from '../../stores/accountStore';
import Button from '../ui/Button';
import BaseModal from '../ui/BaseModal';
import QrCodePlaceholder from '../qr/QrCodePlaceholder';
import { formatMassaAddress } from '../../utils/addressUtils';

interface ReceiveModalProps {
  isOpen: boolean;
  onClose: () => void;
}

const ReceiveModal: React.FC<ReceiveModalProps> = ({ isOpen, onClose }) => {
  const { account } = useAccountStore();
  const [copied, setCopied] = useState(false);

  const fullAddress = account?.address?.toString() ?? '';
  const displayAddress = formatMassaAddress(fullAddress);

  const handleCopyAddress = async () => {
    try {
      await navigator.clipboard.writeText(fullAddress);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy address:', err);
    }
  };

  const handleShare = () => {
    // Placeholder for share functionality
    alert('Share functionality will be implemented soon!');
  };

  return (
    <BaseModal isOpen={isOpen} onClose={onClose} title="Receive">
      {/* QR Code Placeholder */}
      <QrCodePlaceholder />

      {/* Address Section */}
      <div>
        <label className="block text-sm font-medium text-foreground mb-2">
          Your Address
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
                <svg
                  className="w-4 h-4"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M5 13l4 4L19 7"
                  />
                </svg>
                Copied!
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <svg
                  className="w-4 h-4"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"
                  />
                </svg>
                Copy
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
          <svg
            className="w-5 h-5"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.367 2.684 3 3 0 00-5.367-2.684z"
            />
          </svg>
          Share with Contact
        </Button>
      </div>

      {/* Info Text */}
      <div className="text-center">
        <p className="text-sm text-muted-foreground">
          Share this address to receive payments. Only send MAS and supported
          tokens to this address.
        </p>
      </div>
    </BaseModal>
  );
};

export default ReceiveModal;
