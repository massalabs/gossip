import { useState, useEffect } from 'react';
import QRCodeStyling from 'qr-code-styling';
import { generateQRCodeUrl } from '../utils/qrCodeUrl';
import { useTheme } from './useTheme';
import { getForegroundColor, getBackgroundColor } from '../utils/qrCodeColors';
import { useAccountStore } from '../stores/accountStore';

/**
 * Hook to prefetch ShareContact component and pregenerate QR code
 * @param userId - The user ID to generate QR code for
 * @param userName - Optional user name to include in QR code
 * @returns The pregenerated QR code as a data URL string, or null if not ready
 */
export const usePreloadShareContact = (): string | null => {
  const [pregeneratedQR, setPregeneratedQR] = useState<string | null>(null);
  const { resolvedTheme } = useTheme();
  const { userProfile } = useAccountStore();

  useEffect(() => {
    if (!userProfile) return;
    import(/* prefetch */ '../components/settings/ShareContact');

    const generateQR = async () => {
      const qrData = generateQRCodeUrl(
        userProfile.userId,
        userProfile.username
      );

      // Get theme-aware colors
      const foregroundColor = getForegroundColor(resolvedTheme);
      const backgroundColor = getBackgroundColor(resolvedTheme);

      const qrCodeStyling = new QRCodeStyling({
        width: 300,
        height: 300,
        data: qrData,
        image: '/favicon/favicon-96x96.png',
        dotsOptions: { type: 'extra-rounded', color: foregroundColor },
        cornersSquareOptions: { type: 'extra-rounded', color: foregroundColor },
        cornersDotOptions: { type: 'dot', color: foregroundColor },
        backgroundOptions: { color: backgroundColor, round: 0 },
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
  }, [userProfile, resolvedTheme]);

  return pregeneratedQR;
};
