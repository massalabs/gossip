import React, { useEffect, useState, useCallback } from 'react';
import {
  CapacitorBarcodeScanner,
  CapacitorBarcodeScannerTypeHint,
} from '@capacitor/barcode-scanner';
import { Haptics, ImpactStyle } from '@capacitor/haptics';
import { QRScannerProps } from './types';

const NativeQRScanner: React.FC<QRScannerProps> = ({
  onScan,
  onError,
  onClose,
}) => {
  const [error, setError] = useState<string | null>(null);

  // Vibrate on success
  const celebrate = useCallback(async () => {
    try {
      await Haptics.impact({ style: ImpactStyle.Medium });
    } catch (_error) {
      // Haptics not available
    }
  }, []);

  // Start native scanner
  const startNativeScanner = useCallback(async () => {
    try {
      const result = await CapacitorBarcodeScanner.scanBarcode({
        hint: CapacitorBarcodeScannerTypeHint.QR_CODE,
        scanInstructions: 'Point your camera at a QR code',
        scanButton: true,
      });

      if (result.ScanResult) {
        await celebrate();
        onScan(result.ScanResult);
      }
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      if (!errorMessage.toLowerCase().includes('cancel')) {
        const msg = 'Scanning cancelled or failed';
        setError(msg);
        onError?.(msg);
      }
    }
  }, [onScan, onError, celebrate]);

  useEffect(() => {
    startNativeScanner();
  }, [startNativeScanner]);

  return (
    <div className="fixed inset-0 flex items-center justify-center bg-black text-white z-[9999]">
      {/* Back Button */}
      {onClose && (
        <button
          onClick={onClose}
          className="absolute top-4 left-4 z-20 bg-black/50 backdrop-blur-sm text-white p-3 rounded-full hover:bg-black/70 transition"
          aria-label="Close scanner"
        >
          <svg
            className="w-6 h-6"
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
      )}

      <div className="text-center">
        <div className="animate-pulse mb-4">
          <div className="w-16 h-16 mx-auto border-4 border-white border-t-transparent rounded-full animate-spin" />
        </div>
        <p>Opening camera...</p>
      </div>
      {error && (
        <div className="fixed bottom-8 left-4 right-4 bg-red-600 text-white p-4 rounded-lg text-center">
          {error}
        </div>
      )}
    </div>
  );
};

export default NativeQRScanner;
