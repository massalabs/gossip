import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import QRScanner from '../qr/QRScanner';
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

  // Hide bottom navigation when scanning
  useEffect(() => {
    document.body.classList.add('qr-scanning');
    return () => {
      document.body.classList.remove('qr-scanning');
    };
  }, []);

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

  return (
    <div className="bg-card h-full overflow-hidden flex flex-col max-w-md mx-auto">
      <PageHeader title="Scan QR Code" onBack={onBack} />

      {/* Scanner Container - Full height minus header */}
      <div className="flex-1 relative min-h-0">
        <QRScanner
          onScan={handleScanSuccess}
          onError={handleError}
          onClose={onBack}
        />
      </div>
    </div>
  );
};

export default ScanQRCode;
