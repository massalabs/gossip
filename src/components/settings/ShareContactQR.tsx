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
        image: '/favicon/favicon.svg',

        dotsOptions: { type: 'extra-rounded', color: foregroundColor },
        cornersSquareOptions: {
          type: 'extra-rounded',
          color: foregroundColor,
        },
        cornersDotOptions: { type: 'dot', color: foregroundColor },
        backgroundOptions: { color: backgroundColor, round: 0 },
        imageOptions: {
          margin: 10,
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
    <div className="my-10 flex justify-center items-center">
      {/* Always use a white background for the QR code container to ensure high contrast and reliable scanning, regardless of theme */}

      {qrDataUrl ? (
        <img
          src={qrDataUrl}
          alt="Your contact QR code"
          className="rounded-2xl"
        />
      ) : (
        <PrivacyGraphic size={120} loading={true} />
      )}
    </div>
  );
};

export default ShareContactQR;
