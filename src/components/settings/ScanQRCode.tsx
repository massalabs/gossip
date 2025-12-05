import React, { useState } from 'react';
import { parseInvite } from '../../utils/qrCodeParser';
import toast from 'react-hot-toast';
import { Capacitor } from '@capacitor/core';
import WebQRScanner from '../qr/WebQRScanner';
import NativeQRScanner from '../qr/NativeQRScanner';

interface ScanQRCodeProps {
  onBack: () => void;
  onScanSuccess: (userId: string) => void;
}

const ScanQRCode: React.FC<ScanQRCodeProps> = ({ onBack, onScanSuccess }) => {
  const [isProcessing, setIsProcessing] = useState(false);

  const handleScanSuccess = async (qrText: string) => {
    if (isProcessing) return;
    setIsProcessing(true);

    try {
      const { userId } = parseInvite(qrText);
      onScanSuccess(userId);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Invalid QR code format';
      toast.error(`Failed to parse QR code: ${message}`);
    } finally {
      setIsProcessing(false);
    }
  };

  const handleError = (err: string) => {
    if (!err.includes('process was cancelled')) {
      toast.error(`Failed to scan QR code: ${err}`);
    }
    onBack();
  };

  const isNative = Capacitor.isNativePlatform();

  if (isNative) {
    return (
      <NativeQRScanner
        onScan={handleScanSuccess}
        onError={handleError}
        onClose={onBack}
      />
    );
  }

  return (
    <WebQRScanner
      onScan={handleScanSuccess}
      onError={handleError}
      onClose={onBack}
    />
  );
};

export default ScanQRCode;
