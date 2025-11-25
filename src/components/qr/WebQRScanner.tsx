import React, { useCallback } from 'react';
import { Scanner } from '@yudiel/react-qr-scanner';
import type { IDetectedBarcode } from '@yudiel/react-qr-scanner';
import { QRScannerProps } from './types';
import ScannerBackButton from './ScannerBackButton';

const WebQRScanner: React.FC<QRScannerProps> = ({
  onScan,
  onError,
  onClose,
}) => {
  const handleScan = useCallback(
    (detectedCodes: IDetectedBarcode[]) => {
      if (detectedCodes && detectedCodes.length > 0) {
        const firstCode = detectedCodes[0];
        onScan(firstCode.rawValue);
      }
    },
    [onScan]
  );

  const handleError = useCallback(
    (error: unknown) => {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      onError?.(errorMessage);
    },
    [onError]
  );

  return (
    <div className="relative max-w-md mx-auto h-full">
      {onClose && <ScannerBackButton onClose={onClose} />}
      <Scanner
        onScan={handleScan}
        onError={handleError}
        scanDelay={200}
        formats={['qr_code']}
        sound={false}
        constraints={{
          facingMode: 'environment',
        }}
        components={{
          torch: true,
          finder: true,
        }}
      />
    </div>
  );
};

export default WebQRScanner;
