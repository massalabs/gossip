import React, { useCallback, useState } from 'react';
import { Scanner, setZXingModuleOverrides } from '@yudiel/react-qr-scanner';
import type { IDetectedBarcode } from '@yudiel/react-qr-scanner';
// Pinned to the exact version barcode-detector expects: the JS glue and the
// wasm binary must come from the same zxing-wasm release.
import zxingReaderWasmUrl from 'zxing-wasm/reader/zxing_reader.wasm?url';
import { QRScannerProps } from './types';
import ScannerBackButton from './ScannerBackButton';

// By default barcode-detector fetches the ZXing wasm from a public CDN
// (jsdelivr). Serve the bundled copy instead so scanning never leaves the app:
// no third-party request, works offline, and the binary is the one we shipped.
setZXingModuleOverrides({
  locateFile: (path: string, prefix: string) =>
    path.endsWith('.wasm') ? zxingReaderWasmUrl : prefix + path,
});

// Ask for continuous autofocus explicitly: inside a WebView the camera
// otherwise tends to stay blurry, where ML Kit drove focus natively.
// `focusMode` is not in lib.dom's MediaTrackConstraintSet yet, hence the cast.
const videoConstraints: MediaTrackConstraints = {
  facingMode: 'environment',
  width: { min: 640, ideal: 1920, max: 1920 },
  height: { min: 640, ideal: 1080, max: 1080 },
  advanced: [{ focusMode: 'continuous' } as MediaTrackConstraintSet],
};

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
          // Decode more often and at a higher resolution than the lib
          // defaults (200 ms, 720 px): small or distant QR codes need the
          // extra pixels now that decoding runs in wasm instead of ML Kit.
          scanDelay={100}
          formats={['qr_code']}
          sound={false}
          constraints={videoConstraints}
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
