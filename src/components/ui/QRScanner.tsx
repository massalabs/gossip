import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Html5Qrcode } from 'html5-qrcode';

interface QRScannerProps {
  onScanSuccess: (result: string) => void;
  onError?: (error: string) => void;
  fps?: number;
  qrbox?: { width: number; height: number };
  aspectRatio?: number;
}

const QRScanner: React.FC<QRScannerProps> = ({
  onScanSuccess,
  onError,
  fps = 10,
  qrbox = { width: 250, height: 250 },
  aspectRatio = 1.0,
}) => {
  const scannerRef = useRef<HTMLDivElement>(null);
  const html5QrCodeRef = useRef<Html5Qrcode | null>(null);
  const [isScanning, setIsScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasPermission, setHasPermission] = useState<boolean | null>(null);

  // Get camera ID (prefer back camera on mobile)
  const getCameraId = async (): Promise<string | null> => {
    try {
      const devices = await Html5Qrcode.getCameras();
      if (devices && devices.length > 0) {
        // Prefer back camera on mobile devices
        const backCamera = devices.find(
          device =>
            device.label.toLowerCase().includes('back') ||
            device.label.toLowerCase().includes('rear') ||
            device.label.toLowerCase().includes('environment')
        );
        if (backCamera) {
          return backCamera.id;
        }
        // Fallback to first available camera
        return devices[0].id;
      }
      return null;
    } catch (err) {
      console.error('Error getting cameras:', err);
      return null;
    }
  };

  const stopScanning = useCallback(async () => {
    if (html5QrCodeRef.current) {
      try {
        await html5QrCodeRef.current.stop();
        await html5QrCodeRef.current.clear();
        // Clear the container to remove any leftover elements
        if (scannerRef.current) {
          scannerRef.current.innerHTML = '';
        }
      } catch (err) {
        console.error('Error stopping QR scanner:', err);
      } finally {
        html5QrCodeRef.current = null;
        setIsScanning(false);
      }
    }
  }, [html5QrCodeRef, scannerRef]);

  const startScanning = useCallback(async () => {
    if (!scannerRef.current || html5QrCodeRef.current) {
      return;
    }

    try {
      const cameraId = await getCameraId();
      if (!cameraId) {
        const errorMsg =
          'No camera found. Please ensure your device has a camera.';
        setError(errorMsg);
        onError?.(errorMsg);
        setHasPermission(false);
        return;
      }

      const html5QrCode = new Html5Qrcode(scannerRef.current.id);
      html5QrCodeRef.current = html5QrCode;

      await html5QrCode.start(
        cameraId,
        {
          fps,
          qrbox,
          aspectRatio,
        },
        decodedText => {
          // Successfully scanned - stop scanning immediately to prevent multiple scans
          void stopScanning();
          onScanSuccess(decodedText);
        },
        errorMessage => {
          // Ignore scanning errors (they're frequent while scanning)
          // Only log if it's not a "not found" error
          if (!errorMessage.includes('No QR code found')) {
            // Silently handle scanning errors
          }
        }
      );

      setIsScanning(true);
      setHasPermission(true);
      setError(null);
    } catch (err) {
      const errorMessage =
        err instanceof Error
          ? err.message
          : 'Failed to start camera. Please check permissions.';
      setError(errorMessage);
      setHasPermission(false);
      onError?.(errorMessage);
      console.error('Error starting QR scanner:', err);
    }
  }, [fps, qrbox, aspectRatio, onError, stopScanning, onScanSuccess]);

  useEffect(() => {
    // Small delay to ensure container is ready
    const timer = setTimeout(() => {
      startScanning();
    }, 100);

    return () => {
      clearTimeout(timer);
      stopScanning();
    };
  }, [startScanning, stopScanning]);

  return (
    <div className="relative w-full h-full bg-black overflow-hidden">
      {/* Scanner Container */}
      <div
        id="qr-scanner-container"
        ref={scannerRef}
        className="w-full h-full relative"
      />

      {/* Scanning Overlay */}
      {isScanning && (
        <div className="absolute inset-0 pointer-events-none z-10">
          {/* Guide Lines */}
          <div className="absolute inset-0 flex items-center justify-center">
            <div
              className="border-2 border-primary rounded-lg relative"
              style={{
                width: `${qrbox.width}px`,
                height: `${qrbox.height}px`,
                maxWidth: '90vw',
                maxHeight: '90vh',
              }}
            >
              {/* Corner indicators */}
              <div className="absolute -top-1 -left-1 w-6 h-6 border-t-4 border-l-4 border-primary rounded-tl-lg" />
              <div className="absolute -top-1 -right-1 w-6 h-6 border-t-4 border-r-4 border-primary rounded-tr-lg" />
              <div className="absolute -bottom-1 -left-1 w-6 h-6 border-b-4 border-l-4 border-primary rounded-bl-lg" />
              <div className="absolute -bottom-1 -right-1 w-6 h-6 border-b-4 border-r-4 border-primary rounded-br-lg" />
            </div>
          </div>

          {/* Dimmed overlay outside scanning area */}
          <div
            className="absolute inset-0 bg-black/50"
            style={{
              clipPath: `polygon(
                0% 0%,
                0% 100%,
                calc(50% - ${qrbox.width / 2}px) 100%,
                calc(50% - ${qrbox.width / 2}px) calc(50% - ${qrbox.height / 2}px),
                calc(50% + ${qrbox.width / 2}px) calc(50% - ${qrbox.height / 2}px),
                calc(50% + ${qrbox.width / 2}px) calc(50% + ${qrbox.height / 2}px),
                calc(50% - ${qrbox.width / 2}px) calc(50% + ${qrbox.height / 2}px),
                calc(50% - ${qrbox.width / 2}px) 100%,
                100% 100%,
                100% 0%
              )`,
            }}
          />
        </div>
      )}

      {/* Error State */}
      {error && (
        <div className="absolute bottom-20 left-4 right-4 bg-destructive text-destructive-foreground p-4 rounded-lg shadow-lg">
          <p className="text-sm font-medium">{error}</p>
        </div>
      )}

      {/* Permission State */}
      {hasPermission === false && !error && (
        <div className="absolute bottom-20 left-4 right-4 bg-card border border-border text-foreground p-4 rounded-lg shadow-lg">
          <p className="text-sm font-medium text-center">
            Camera permission is required to scan QR codes.
          </p>
        </div>
      )}
    </div>
  );
};

export default QRScanner;
