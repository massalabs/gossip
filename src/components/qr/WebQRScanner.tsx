import React, { useCallback, useState } from 'react';
import { Scanner } from '@yudiel/react-qr-scanner';
import type { IDetectedBarcode } from '@yudiel/react-qr-scanner';
import { QRScannerProps } from './types';
import ScannerBackButton from './ScannerBackButton';

const WebQRScanner: React.FC<QRScannerProps> = ({
  onScan,
  onError,
  onClose,
}) => {
  const [isScanning, setIsScanning] = useState(true);

  const handleScan = useCallback(
    (detectedCodes: IDetectedBarcode[]) => {
      const firstCode = detectedCodes[0];
      setIsScanning(false);
      onScan(firstCode.rawValue);
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
    <div className="relative app-max-w mx-auto h-full">
      {onClose && <ScannerBackButton onClose={onClose} />}
      {isScanning && (
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
      )}
    </div>
  );
};

export default WebQRScanner;
