import { logger } from '../../utils/logger.ts';
import React, { useEffect, useRef } from 'react';
import { QrScanner, isQrScanCancelled } from '../../services/qrScanner';
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

    QrScanner.scan()
      .then(({ value }) => onScan(value))
      .catch((err: unknown) => {
        if (isQrScanCancelled(err)) {
          onClose();
          return;
        }
        logger.warn('[QRScan] native scan failed', err);
        onError(err instanceof Error ? err.message : String(err));
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // Only run once on mount

  return <></>;
};

export default NativeQRScanner;
