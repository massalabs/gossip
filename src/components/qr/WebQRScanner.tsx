import React, { useState, useCallback, useRef, useEffect } from 'react';
import { Scanner } from '@yudiel/react-qr-scanner';
import type { IDetectedBarcode } from '@yudiel/react-qr-scanner';
import { QRScannerProps } from './types';

const WebQRScanner: React.FC<QRScannerProps> = ({
  onScan,
  onError,
  onClose,
}) => {
  const [torchOn, setTorchOn] = useState(false);
  const [torchSupported, setTorchSupported] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  // Check torch support by finding video element
  useEffect(() => {
    const checkTorch = async () => {
      try {
        const video = document.querySelector<HTMLVideoElement>(
          'video[autoplay][playsinline]'
        );
        if (video && video.srcObject instanceof MediaStream) {
          const track = video.srcObject.getVideoTracks()[0];
          if (track) {
            const capabilities = track.getCapabilities();
            setTorchSupported('torch' in capabilities);
            videoRef.current = video;
          }
        }
      } catch (_error) {
        setTorchSupported(false);
      }
    };

    // Check after a short delay to allow video to initialize
    const timer = setTimeout(checkTorch, 500);
    return () => clearTimeout(timer);
  }, []);

  // Toggle torch/flashlight
  const toggleTorch = useCallback(async () => {
    if (!videoRef.current || !torchSupported) return;
    try {
      const stream = videoRef.current.srcObject as MediaStream;
      if (stream) {
        const track = stream.getVideoTracks()[0];
        if (track) {
          await track.applyConstraints({
            advanced: [{ torch: !torchOn } as MediaTrackConstraints],
          });
          setTorchOn(!torchOn);
        }
      }
    } catch (_error) {
      console.warn('Failed to toggle torch');
    }
  }, [torchOn, torchSupported]);

  const handleScan = useCallback(
    (detectedCodes: IDetectedBarcode[]) => {
      if (detectedCodes && detectedCodes.length > 0) {
        // Use the first detected code's raw value
        const firstCode = detectedCodes[0];
        onScan(firstCode.rawValue);
      }
    },
    [onScan]
  );

  const handleError = useCallback(
    (err: unknown) => {
      const errorMessage =
        err instanceof Error ? err.message : String(err) || 'Unknown error';
      const msg =
        errorMessage.includes('Permission') ||
        errorMessage.includes('NotAllowedError')
          ? 'Camera access denied. Please allow camera permission.'
          : 'Failed to start camera. Please try again.';
      setError(msg);
      onError?.(msg);
    },
    [onError]
  );

  // Monitor for video element to check torch support
  useEffect(() => {
    const observer = new MutationObserver(() => {
      const video = document.querySelector<HTMLVideoElement>(
        'video[autoplay][playsinline]'
      );
      if (
        video &&
        video.srcObject instanceof MediaStream &&
        !videoRef.current
      ) {
        videoRef.current = video;
        const track = video.srcObject.getVideoTracks()[0];
        if (track) {
          const capabilities = track.getCapabilities();
          setTorchSupported('torch' in capabilities);
        }
      }
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
    });

    return () => observer.disconnect();
  }, []);

  return (
    <div className="fixed inset-0 w-full h-screen bg-black overflow-hidden z-9999 max-w-md mx-auto">
      {/* Scanner View */}
      <div className="absolute inset-0">
        <Scanner
          onScan={handleScan}
          onError={handleError}
          constraints={{
            facingMode: 'environment',
          }}
          scanDelay={300}
          formats={['qr_code']}
          sound={false}
          styles={{
            container: {
              width: '100%',
              height: '100%',
              position: 'relative',
            },
            video: {
              width: '100%',
              height: '100%',
              objectFit: 'cover',
            },
          }}
          classNames={{
            container: 'absolute inset-0',
            video: 'w-full h-full object-cover',
          }}
          components={{
            finder: false, // We use our own overlay
            torch: false, // We use our own torch button
            zoom: false,
            onOff: false,
          }}
        />
      </div>

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

      {/* Scan Frame Overlay */}
      <div className="absolute inset-0 pointer-events-none z-10">
        {/* Semi-transparent overlay outside scan area */}
        <div className="absolute inset-0 bg-black/60" />

        {/* Scan frame with corner brackets */}
        <div className="flex items-center justify-center h-full">
          <div className="relative w-64 h-64 md:w-80 md:h-80">
            {/* Corner Brackets - Top Left */}
            <div className="absolute top-0 left-0">
              <div className="absolute top-0 left-0 w-8 h-0.5 bg-white" />
              <div className="absolute top-0 left-0 w-0.5 h-8 bg-white" />
            </div>

            {/* Corner Brackets - Top Right */}
            <div className="absolute top-0 right-0">
              <div className="absolute top-0 right-0 w-8 h-0.5 bg-white" />
              <div className="absolute top-0 right-0 w-0.5 h-8 bg-white" />
            </div>

            {/* Corner Brackets - Bottom Left */}
            <div className="absolute bottom-0 left-0">
              <div className="absolute bottom-0 left-0 w-8 h-0.5 bg-white" />
              <div className="absolute bottom-0 left-0 w-0.5 h-8 bg-white" />
            </div>

            {/* Corner Brackets - Bottom Right */}
            <div className="absolute bottom-0 right-0">
              <div className="absolute bottom-0 right-0 w-8 h-0.5 bg-white" />
              <div className="absolute bottom-0 right-0 w-0.5 h-8 bg-white" />
            </div>
          </div>
        </div>
      </div>

      {/* Torch Button - Only show if torch is supported */}
      {torchSupported && (
        <button
          onClick={toggleTorch}
          className="absolute bottom-24 left-1/2 -translate-x-1/2 bg-white/20 backdrop-blur-sm text-white px-6 py-3 rounded-full flex items-center gap-2 hover:bg-white/30 transition z-20"
        >
          <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
            <path
              d={
                torchOn
                  ? 'M9 15h2v2H9zm0-8h2v6H9zm1-7a7 7 0 00-7 7c0 2.5 1.4 4.7 3.5 6h7c2.1-1.3 3.5-3.5 3.5-6a7 7 0 00-7-7z'
                  : 'M10 2a8 8 0 00-8 8c0 2.8 1.6 5.3 4 6.6V18a1 1 0 001 1h6a1 1 0 001-1v-1.4c2.4-1.3 4-3.8 4-6.6a8 8 0 00-8-8z'
              }
            />
          </svg>
          {torchOn ? 'Torch On' : 'Torch Off'}
        </button>
      )}

      {/* Error Message */}
      {error && (
        <div className="absolute bottom-8 left-4 right-4 bg-red-600 text-white p-4 rounded-lg text-center z-20">
          {error}
        </div>
      )}
    </div>
  );
};

export default WebQRScanner;
