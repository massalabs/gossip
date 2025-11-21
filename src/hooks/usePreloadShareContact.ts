import { useState, useEffect } from 'react';
import QRCodeStyling from 'qr-code-styling';
import { generateQRCodeUrl } from '../utils/qrCodeUrl';

/**
 * Hook to prefetch ShareContact component and pregenerate QR code
 * @param userId - The user ID to generate QR code for
 * @param userName - Optional user name to include in QR code
 * @returns The pregenerated QR code as a data URL string, or null if not ready
 */
export const usePreloadShareContact = (
  userId: string | undefined,
  userName?: string | null
): string | null => {
  const [pregeneratedQR, setPregeneratedQR] = useState<string | null>(null);

  useEffect(() => {
    // Prefetch the chunk
    import(/* prefetch */ '../components/settings/ShareContact');

    // Pre-generate the QR code in the background
    const generateQR = async () => {
      if (!userId) return;

      // Use generateQRCodeUrl to include username in the QR code
      const qrData = generateQRCodeUrl(userId, userName);

      const qrCodeStyling = new QRCodeStyling({
        width: 300,
        height: 300,
        data: qrData,
        image: '/favicon/favicon-96x96.png',
        dotsOptions: { type: 'extra-rounded', color: '#000' },
        cornersSquareOptions: { type: 'extra-rounded' },
        cornersDotOptions: { type: 'dot' },
        imageOptions: { margin: 15, imageSize: 0.25, crossOrigin: 'anonymous' },
      });

      // Generate the SVG directly as a string (or dataURL)
      const svg = await qrCodeStyling.getRawData('svg');
      if (svg) {
        const reader = new FileReader();
        reader.onload = () => setPregeneratedQR(reader.result as string);
        reader.readAsDataURL(svg as Blob);
      }
    };

    generateQR();
  }, [userId, userName]);

  return pregeneratedQR;
};
