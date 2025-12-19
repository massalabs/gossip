import React, { useEffect, useState, useCallback, useRef } from 'react';
import QRCodeStyling from 'qr-code-styling';
import { Check, Copy } from 'react-feather';

import { PrivacyGraphic } from '../graphics';
import { formatUserId } from '../../utils/userId';

interface ShareContactQRProps {
  deepLinkUrl: string;
  userId: string;
  onQRCodeGenerated?: (qrDataUrl: string) => void;
}

const ShareContactQR: React.FC<ShareContactQRProps> = ({
  deepLinkUrl,
  userId,
  onQRCodeGenerated,
}) => {
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [isCopied, setIsCopied] = useState(false);
  const [containerWidth, setContainerWidth] = useState<number>(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const copyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Adapt shortened user ID length based on container width
  const getShortenedUserId = useCallback(() => {
    if (containerWidth === 0) {
      // Default values before measurement - be conservative
      return formatUserId(userId, 4, 4);
    }

    // Adjust characters based on available width
    // Account for: padding (px-3 = 12px each side = 24px), gap (8px), icon (24px), and some margin = ~60px total
    const availableTextWidth = containerWidth - 60;

    // Rough estimate: each character is ~7px in monospace at text-xs with tracking-tight
    // Be conservative and use 7.5px per char to ensure it fits
    const charsPerWidth = Math.floor(availableTextWidth / 7.5);

    // Split between prefix and suffix, leaving room for "..." (3 chars) and "gossip1" prefix (7 chars)
    // So we need: "gossip1" + prefixChars + "..." + suffixChars
    const prefixLength = 7; // "gossip1"
    const ellipsisLength = 3; // "..."
    const availableForData = charsPerWidth - prefixLength - ellipsisLength;

    // Ensure minimum of 3 chars each, and split available space
    const minChars = 3;
    const totalDataChars = Math.max(minChars * 2, availableForData);
    const prefixChars = Math.max(minChars, Math.floor(totalDataChars / 2));
    const suffixChars = Math.max(minChars, Math.ceil(totalDataChars / 2));

    return formatUserId(userId, prefixChars, suffixChars);
  }, [userId, containerWidth]);

  const shortenedUserId = getShortenedUserId();

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(userId);
      setIsCopied(true);

      if (copyTimeoutRef.current) {
        clearTimeout(copyTimeoutRef.current);
      }
      copyTimeoutRef.current = setTimeout(() => {
        setIsCopied(false);
        copyTimeoutRef.current = null;
      }, 2000);
    } catch (err) {
      console.error('Failed to copy user ID:', err);
    }
  }, [userId]);

  useEffect(() => {
    return () => {
      if (copyTimeoutRef.current) {
        clearTimeout(copyTimeoutRef.current);
      }
    };
  }, []);

  // Measure container width and update on resize
  useEffect(() => {
    const updateWidth = () => {
      if (containerRef.current) {
        setContainerWidth(containerRef.current.offsetWidth);
      }
    };

    // Initial measurement
    updateWidth();

    // Listen for resize events
    window.addEventListener('resize', updateWidth);

    // Use ResizeObserver for more accurate measurements
    const resizeObserver = new ResizeObserver(entries => {
      for (const entry of entries) {
        setContainerWidth(entry.contentRect.width);
      }
    });

    if (containerRef.current) {
      resizeObserver.observe(containerRef.current);
    }

    return () => {
      window.removeEventListener('resize', updateWidth);
      resizeObserver.disconnect();
    };
  }, []);

  useEffect(() => {
    let isMounted = true;

    const generateQR = async () => {
      // Always use a dark QR code on a light background (ignore theme)
      const foregroundColor = '#1a1a1d'; // dark
      const backgroundColor = '#ffffff'; // light

      const qrCodeStyling = new QRCodeStyling({
        width: 280,
        height: 280,
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
            const dataUrl = reader.result as string;
            setQrDataUrl(dataUrl);
            onQRCodeGenerated?.(dataUrl);
          }
        };
        reader.readAsDataURL(svg as Blob);
      }
    };

    generateQR();

    return () => {
      isMounted = false;
    };
  }, [deepLinkUrl, onQRCodeGenerated]);

  return (
    <div className="my-4 flex flex-col items-center gap-3">
      {/* Always use a white background for the QR code container to ensure high contrast and reliable scanning, regardless of theme */}

      {/* Shortened User ID with copy functionality */}
      <div className="flex flex-col gap-1.5 w-full max-w-xs" ref={containerRef}>
        <p className="text-[10px] font-medium text-muted-foreground text-left tracking-wider">
          User ID:
        </p>
        <button
          onClick={handleCopy}
          className="group relative flex items-center justify-between gap-2 px-3 py-2 bg-card rounded-xl border border-border hover:border-accent hover:bg-accent/5 active:scale-[0.98] transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 focus:ring-offset-background w-full"
          title="Click to copy user ID"
        >
          <span className="text-xs font-semibold text-foreground font-mono tracking-tight flex-1 text-left min-w-0 truncate">
            {shortenedUserId}
          </span>
          <div className="shrink-0 flex items-center justify-center w-6 h-6">
            {isCopied ? (
              <Check className="w-4 h-4 text-success transition-all" />
            ) : (
              <Copy className="w-4 h-4 text-muted-foreground group-hover:text-accent transition-colors" />
            )}
          </div>
        </button>
      </div>

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
