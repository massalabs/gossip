import React, { useEffect, useRef } from 'react';
import QRCodeStyling, { Options } from 'qr-code-styling';
import { useTheme } from '../../hooks/useTheme';
import {
  getForegroundColor,
  getBackgroundColor,
} from '../../utils/qrCodeColors';

// Base QR code options from qr-code-styling, excluding data/width/height which we handle separately
type QRCodeStylingOptions = Omit<
  Options,
  'data' | 'width' | 'height' | 'qrOptions'
> & {
  // Allow qrOptions to be passed but we'll override errorCorrectionLevel
  qrOptions?: Omit<Options['qrOptions'], 'errorCorrectionLevel'>;
};

// React-friendly props interface that extends Options
export interface QRCodeProps extends QRCodeStylingOptions {
  // React-friendly aliases
  value: string; // Maps to Options.data
  size?: number; // Maps to Options.width/height
  level?: 'L' | 'M' | 'Q' | 'H'; // Maps to Options.qrOptions.errorCorrectionLevel
  className?: string; // React-specific, not part of Options
}

const QRCode: React.FC<QRCodeProps> = ({
  value,
  size = 300,
  level = 'H',
  type = 'svg',
  className = '',
  dotsOptions,
  cornersSquareOptions,
  cornersDotOptions,
  backgroundOptions,
  image,
  imageOptions,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const qrCodeRef = useRef<QRCodeStyling | null>(null);
  const { resolvedTheme } = useTheme();

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // Get colors based on theme or use provided colors
    const foregroundColor = getForegroundColor(
      resolvedTheme,
      dotsOptions?.color
    );
    const backgroundColor = getBackgroundColor(
      resolvedTheme,
      backgroundOptions?.color
    );

    // Create QR code instance with custom options
    const qrCodeOptions: Options = {
      type: type === 'svg' ? 'svg' : 'canvas',
      width: size,
      height: size,
      data: value,
      margin: 0,
      qrOptions: {
        errorCorrectionLevel: level,
      },
      dotsOptions: {
        type: dotsOptions?.type || 'rounded',
        color: foregroundColor,
        gradient: dotsOptions?.gradient,
      },
      cornersSquareOptions: {
        type: cornersSquareOptions?.type || 'extra-rounded',
        color: foregroundColor,
        gradient: cornersSquareOptions?.gradient,
      },
      cornersDotOptions: {
        type: cornersDotOptions?.type || 'dot',
        color: foregroundColor,
        gradient: cornersDotOptions?.gradient,
      },
      backgroundOptions: {
        color: backgroundColor,
        round: 0,
        gradient: backgroundOptions?.gradient,
      },
    };

    // Only include image and imageOptions if image is provided
    if (image) {
      qrCodeOptions.image = image;
      if (imageOptions) {
        qrCodeOptions.imageOptions = imageOptions;
      }
    }

    const qrCode = new QRCodeStyling(qrCodeOptions);

    qrCodeRef.current = qrCode;

    // Clear container and append QR code
    container.innerHTML = '';
    qrCode.append(container);

    // Cleanup
    return () => {
      if (container) {
        container.innerHTML = '';
      }
    };
  }, [
    value,
    size,
    level,
    type,
    resolvedTheme,
    dotsOptions?.type,
    dotsOptions?.color,
    dotsOptions?.gradient,
    cornersSquareOptions?.type,
    cornersSquareOptions?.color,
    cornersSquareOptions?.gradient,
    cornersDotOptions?.type,
    cornersDotOptions?.color,
    cornersDotOptions?.gradient,
    backgroundOptions?.color,
    backgroundOptions?.gradient,
    image,
    imageOptions,
  ]);

  return (
    <div
      ref={containerRef}
      className={`flex justify-center items-center ${className}`}
      style={{ width: size, height: size }}
    />
  );
};

export default QRCode;
