import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import QRScanner from '../ui/QRScanner';
import PageHeader from '../ui/PageHeader';
import { parseQRCode } from '../../utils/qrCodeParser';
import { Capacitor } from '@capacitor/core';

interface ScanQRCodeProps {
  onBack: () => void;
  onScanSuccess?: (userId: string, name?: string) => void;
}

const ScanQRCode: React.FC<ScanQRCodeProps> = ({ onBack, onScanSuccess }) => {
  const navigate = useNavigate();
  const [isProcessing, setIsProcessing] = useState(false);

  const handleScanSuccess = async (qrText: string) => {
    if (isProcessing) return;

    setIsProcessing(true);

    // Provide haptic feedback on native platforms
    if (Capacitor.isNativePlatform()) {
      try {
        const { Haptics, ImpactStyle } = await import('@capacitor/haptics');
        await Haptics.impact({ style: ImpactStyle.Medium });
      } catch (_err) {
        // Haptics not available, ignore
      }
    }

    // Parse the QR code
    console.log('Raw QR code text:', qrText);
    const parsed = parseQRCode(qrText);
    console.log('Parsed QR code:', parsed);

    if (!parsed || !parsed.userId) {
      // Invalid QR code
      setIsProcessing(false);
      console.warn('Invalid QR code scanned:', qrText);
      // Could show an error message here
      return;
    }

    console.log('QR code parsed successfully:', {
      userId: parsed.userId,
      name: parsed.name,
      hasName: !!parsed.name,
    });

    // If onScanSuccess callback is provided, use it
    if (onScanSuccess) {
      // Pass both userId and name (even if name is undefined)
      onScanSuccess(parsed.userId, parsed.name);
      return;
    }

    // Otherwise, navigate to NewContact page with pre-filled data
    const params = new URLSearchParams();
    params.set('userId', parsed.userId);
    if (parsed.name) {
      params.set('name', parsed.name);
    }

    navigate(`/new-contact?${params.toString()}`);
  };

  const handleError = (error: string) => {
    console.error('QR Scanner error:', error);
    // Error is already displayed in the QRScanner component
  };

  // Responsive qrbox size - larger on desktop/laptop screens
  const getQRBoxSize = () => {
    if (typeof window !== 'undefined') {
      const width = window.innerWidth;
      // Mobile: 280px, Tablet: 400px, Desktop: 500px
      if (width >= 1024) return { width: 500, height: 500 };
      if (width >= 768) return { width: 400, height: 400 };
      return { width: 280, height: 280 };
    }
    return { width: 280, height: 280 };
  };

  const qrboxSize = getQRBoxSize();

  return (
    <div className="bg-card h-full overflow-hidden flex flex-col max-w-md mx-auto">
      <PageHeader title="Scan QR Code" onBack={onBack} />

      {/* Scanner Container - Full height minus header */}
      <div className="flex-1 relative min-h-0">
        <QRScanner
          onScanSuccess={handleScanSuccess}
          onError={handleError}
          fps={10}
          qrbox={qrboxSize}
          aspectRatio={1.0}
        />
      </div>

      {/* Instructions */}
      <div className="absolute bottom-20 left-4 right-4 pointer-events-none z-10">
        <div className="bg-card/90 backdrop-blur-sm border border-border rounded-lg p-4 shadow-lg max-w-md mx-auto">
          <p className="text-sm text-foreground text-center">
            Position the QR code within the frame
          </p>
        </div>
      </div>
    </div>
  );
};

export default ScanQRCode;
