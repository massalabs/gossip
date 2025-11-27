import React, { useEffect, useCallback } from 'react';
import {
  CapacitorBarcodeScanner,
  CapacitorBarcodeScannerTypeHint,
} from '@capacitor/barcode-scanner';
import { QRScannerProps } from './types';
import toast from 'react-hot-toast';

const NativeQRScanner: React.FC<QRScannerProps> = ({ onScan, onError }) => {
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
      const error = err instanceof Error ? err.message : String(err);
      // TODO: improve error handling
      toast.error(`Failed to scan barcode: ${error}`);
      onError?.(error);
    }
  }, [onScan, onError]);

  useEffect(() => {
    startNativeScanner();
  }, [startNativeScanner]);

  return <></>;
};

export default NativeQRScanner;
