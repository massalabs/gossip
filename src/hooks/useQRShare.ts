import { useState, useCallback } from 'react';
import toast from 'react-hot-toast';
import { shareQRCode } from '../services/shareService';

export function useQRShare(): {
  qrDataUrl: string | null;
  setQrDataUrl: (url: string | null) => void;
  isSharingQR: boolean;
  handleShareQR: () => Promise<void>;
} {
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [isSharingQR, setIsSharingQR] = useState(false);

  const handleShareQR = useCallback(async () => {
    if (!qrDataUrl) return;

    try {
      setIsSharingQR(true);
      await shareQRCode({
        qrDataUrl,
        fileName: 'contact-qr-code.png',
      });
    } catch (error) {
      console.error('Failed to share QR code:', error);
      toast.error('Failed to share QR code. Please try again.');
    } finally {
      setIsSharingQR(false);
    }
  }, [qrDataUrl]);

  return { qrDataUrl, setQrDataUrl, isSharingQR, handleShareQR };
}
