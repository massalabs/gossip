import React, { useEffect, useCallback } from 'react';
import {
  CapacitorBarcodeScanner,
  CapacitorBarcodeScannerTypeHint,
} from '@capacitor/barcode-scanner';
import { QRScannerProps } from './types';

const NativeQRScanner: React.FC<QRScannerProps> = ({
  onScan,
  onError,
  onClose,
}) => {
  const startNativeScanner = useCallback(async () => {
    try {
      const result = await CapacitorBarcodeScanner.scanBarcode({
        hint: CapacitorBarcodeScannerTypeHint.QR_CODE,
        scanInstructions: 'Point your camera at a QR code',
        scanButton: false,
      });

      // TODO: Improve Scan Result handling
      onScan(result.ScanResult);
    } catch (err: unknown) {
      console.error('NativeQRScanner error', err);
      const error = err instanceof Error ? err.message : String(err);
      if (error.includes('the process was cancelled')) {
        onClose();
      }
      onError(error);
    }
  }, [onScan, onError, onClose]);

  useEffect(() => {
    startNativeScanner();
  }, [startNativeScanner]);

  return <></>;
};

export default NativeQRScanner;
