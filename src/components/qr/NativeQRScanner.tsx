import React, { useEffect } from 'react';
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
  useEffect(() => {
    const startNativeScanner = async () => {
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
        } else {
          onError(error);
        }
      }
    };

    startNativeScanner();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // Only run once on mount

  return <></>;
};

export default NativeQRScanner;
