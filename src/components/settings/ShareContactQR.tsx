import React, { useEffect, useState } from 'react';
import QRCodeStyling from 'qr-code-styling';

import { PrivacyGraphic } from '../graphics';

interface ShareContactQRProps {
  deepLinkUrl: string;
}

const ShareContactQR: React.FC<ShareContactQRProps> = ({ deepLinkUrl }) => {
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);

  useEffect(() => {
    let isMounted = true;

    const generateQR = async () => {
      // Always use a dark QR code on a light background (ignore theme)
      const foregroundColor = '#1a1a1d'; // dark
      const backgroundColor = '#ffffff'; // light

      const qrCodeStyling = new QRCodeStyling({
        width: 300,
        height: 300,
        data: deepLinkUrl,
        image: '/favicon/favicon-96x96.png',
        dotsOptions: { type: 'extra-rounded', color: foregroundColor },
        cornersSquareOptions: {
          type: 'extra-rounded',
          color: foregroundColor,
        },
        cornersDotOptions: { type: 'dot', color: foregroundColor },
        backgroundOptions: { color: backgroundColor, round: 0 },
        imageOptions: {
          margin: 15,
          imageSize: 0.25,
          crossOrigin: 'anonymous',
        },
      });

      // Generate the SVG directly as a data URL for better quality
      const svg = await qrCodeStyling.getRawData('svg');
      if (svg && isMounted) {
        const reader = new FileReader();
        reader.onload = () => {
          if (isMounted) {
            setQrDataUrl(reader.result as string);
          }
        };
        reader.readAsDataURL(svg as Blob);
      }
    };

    generateQR();

    return () => {
      isMounted = false;
    };
  }, [deepLinkUrl]);

  return (
    <div className="bg-card rounded-xl border border-border p-6 mb-6">
      {/* Always use a white background for the QR code container to ensure high contrast and reliable scanning, regardless of theme */}
      <div className="flex justify-center p-6 bg-white rounded-xl min-h-[300px] items-center w-full">
        {qrDataUrl ? (
          <img
            src={qrDataUrl}
            alt="Your contact QR code"
            className="w-[300px] h-[300px]"
          />
        ) : (
          <PrivacyGraphic size={120} loading={true} />
        )}
      </div>
    </div>
  );
};

export default ShareContactQR;
