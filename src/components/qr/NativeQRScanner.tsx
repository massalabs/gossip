import React, { useEffect, useRef } from 'react';
import {
  CapacitorBarcodeScanner,
  CapacitorBarcodeScannerTypeHint,
} from '@capacitor/barcode-scanner';
import {
  formatQrScanErrorForLog,
  normalizeNativeQrError,
} from '../../utils/qrScanErrors';
import { QRScannerProps } from './types';

const NativeQRScanner: React.FC<QRScannerProps> = ({
  onScan,
  onError,
  onClose,
}) => {
  const scanStartedRef = useRef(false);

  useEffect(() => {
    // Guard against StrictMode double-mount opening the scanner twice
    if (scanStartedRef.current) return;
    scanStartedRef.current = true;

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
        const normalized = normalizeNativeQrError(err);
        const line = formatQrScanErrorForLog(normalized);
        if (normalized.isCancelled) {
          // Expected when the user leaves the scanner or the OS ends the session (e.g. custom ROMs).
          // Use debug level so logcat / dev-console are not noisy; full detail is still in the debug overlay.
          console.debug(line, normalized);
          onClose();
        } else {
          console.warn(line, err);
          onError(normalized.message);
        }
      }
    };

    startNativeScanner();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // Only run once on mount

  return <></>;
};

export default NativeQRScanner;
