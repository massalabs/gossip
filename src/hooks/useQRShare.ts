import { logger } from '../utils/logger.ts';
import { useState, useCallback } from 'react';
import toast from 'react-hot-toast';
import { shareQRCode } from '../services/shareService';

/** Which grid button triggered the share (so only that button shows loading). */
export type QrShareSource = 'share' | 'qr';

export function useQRShare(): {
  qrDataUrl: string | null;
  setQrDataUrl: (url: string | null) => void;
  /** True while a QR share is in progress (either button). */
  isSharingQR: boolean;
  /** Which button is currently sharing, or null. */
  qrShareSource: QrShareSource | null;
  handleShareQR: (source: QrShareSource) => Promise<void>;
} {
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [qrShareSource, setQrShareSource] = useState<QrShareSource | null>(
    null
  );

  const handleShareQR = useCallback(
    async (source: QrShareSource) => {
      if (!qrDataUrl) return;

      try {
        setQrShareSource(source);
        await shareQRCode({
          qrDataUrl,
          fileName: 'contact-qr-code.png',
        });
      } catch (error) {
        logger.error('Failed to share QR code:', error);
        toast.error('Failed to share QR code. Please try again.');
      } finally {
        setQrShareSource(null);
      }
    },
    [qrDataUrl]
  );

  return {
    qrDataUrl,
    setQrDataUrl,
    isSharingQR: qrShareSource !== null,
    qrShareSource,
    handleShareQR,
  };
}
