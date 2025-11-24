import React, { useState } from 'react';
import { parseQRCode } from '../../utils/qrCodeParser';
import toast from 'react-hot-toast';
import { Capacitor } from '@capacitor/core';
import WebQRScanner from '../qr/WebQRScanner';
import NativeQRScanner from '../qr/NativeQRScanner';

interface ScanQRCodeProps {
  onBack: () => void;
  onScanSuccess: (userId: string, name: string) => void;
}

const ScanQRCode: React.FC<ScanQRCodeProps> = ({ onBack, onScanSuccess }) => {
  const [isProcessing, setIsProcessing] = useState(false);
  const handleScanSuccess = async (qrText: string) => {
    if (isProcessing) return;
    setIsProcessing(true);

    try {
      const parsed = parseQRCode(qrText);
      if (!parsed?.userId) {
        setIsProcessing(false);
        return;
      }
      onScanSuccess(parsed.userId, parsed.name ?? '');
    } catch (error) {
      // TODO: Add proper error message
      toast.error(`Failed to parse QR code: ${error}`);
    } finally {
      setIsProcessing(false);
    }
  };

  const handleError = (err: unknown) => {
    const error = err instanceof Error ? err.message : String(err);
    // TODO: Add proper error message
    toast.error(`Failed to scan QR code: ${error}`);
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
