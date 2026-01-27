import React, { useEffect, useState, useCallback, useRef } from 'react';
import QRCodeStyling from 'qr-code-styling';
import { Check, Copy } from 'react-feather';

import { PrivacyGraphic } from '../graphics';
import { formatUserId } from '@massalabs/gossip-sdk';

interface ShareContactQRProps {
  deepLinkUrl: string;
  userId: string;
  mnsDomains?: string[];
  onQRCodeGenerated?: (qrDataUrl: string) => void;
}

const ShareContactQR: React.FC<ShareContactQRProps> = ({
  deepLinkUrl,
  userId,
  mnsDomains,
  onQRCodeGenerated,
}) => {
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [copiedMnsDomains, setCopiedMnsDomains] = useState<Set<string>>(
    new Set()
  );
  const [isCopiedUserId, setIsCopiedUserId] = useState(false);
  const [containerWidth, setContainerWidth] = useState<number>(0);
  const containerRef = useRef<HTMLDivElement>(null);

  // Get shortened MNS domain for display
  const getShortenedMns = useCallback(
    (domain: string) => {
      if (containerWidth === 0) {
        return domain.length > 20 ? `${domain.slice(0, 17)}...` : domain;
      }
      const availableTextWidth = containerWidth - 60;
      const charsPerWidth = Math.floor(availableTextWidth / 7.5);
      if (domain.length > charsPerWidth) {
        return `${domain.slice(0, charsPerWidth - 3)}...`;
      }
      return domain;
    },
    [containerWidth]
  );

  // Get shortened user ID for display
  const getShortenedUserId = useCallback(() => {
    if (containerWidth === 0) {
      return formatUserId(userId, 4, 4);
    }
    const availableTextWidth = containerWidth - 60;
    const charsPerWidth = Math.floor(availableTextWidth / 7.5);
    const prefixLength = 7; // "gossip1"
    const ellipsisLength = 3; // "..."
    const availableForData = charsPerWidth - prefixLength - ellipsisLength;
    const minChars = 3;
    const totalDataChars = Math.max(minChars * 2, availableForData);
    const prefixChars = Math.max(minChars, Math.floor(totalDataChars / 2));
    const suffixChars = Math.max(minChars, Math.ceil(totalDataChars / 2));
    return formatUserId(userId, prefixChars, suffixChars);
  }, [userId, containerWidth]);

  const shortenedUserId = getShortenedUserId();

  const handleCopyMns = useCallback(async (domain: string) => {
    try {
      await navigator.clipboard.writeText(domain);
      setCopiedMnsDomains(prev => new Set(prev).add(domain));
      setTimeout(() => {
        setCopiedMnsDomains(prev => {
          const next = new Set(prev);
          next.delete(domain);
          return next;
        });
      }, 2000);
    } catch (err) {
      console.error('Failed to copy MNS domain:', err);
    }
  }, []);

  const handleCopyUserId = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(userId);
      setIsCopiedUserId(true);
      setTimeout(() => setIsCopiedUserId(false), 2000);
    } catch (err) {
      console.error('Failed to copy user ID:', err);
    }
  }, [userId]);

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

      {/* MNS Domains and User ID with copy functionality */}
      <div className="flex flex-col gap-2 w-full max-w-xs" ref={containerRef}>
        {mnsDomains && mnsDomains.length > 0 && (
          <div className="flex flex-col gap-1.5">
            <p className="text-[10px] font-medium text-muted-foreground text-left tracking-wider">
              MNS:
            </p>
            {mnsDomains.map(domain => {
              const isCopied = copiedMnsDomains.has(domain);
              return (
                <button
                  key={domain}
                  onClick={() => handleCopyMns(domain)}
                  className="group relative flex items-center justify-between gap-2 px-3 py-2 bg-card rounded-xl border border-border hover:border-accent hover:bg-accent/5 active:scale-[0.98] transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 focus:ring-offset-background w-full"
                  title="Click to copy MNS domain"
                >
                  <span className="text-xs font-semibold text-foreground font-mono tracking-tight flex-1 text-left min-w-0 truncate">
                    {getShortenedMns(domain)}
                  </span>
                  <div className="shrink-0 flex items-center justify-center w-6 h-6">
                    {isCopied ? (
                      <Check className="w-4 h-4 text-success transition-all" />
                    ) : (
                      <Copy className="w-4 h-4 text-muted-foreground group-hover:text-accent transition-colors" />
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        )}
        <div className="flex flex-col gap-1.5">
          <p className="text-[10px] font-medium text-muted-foreground text-left tracking-wider">
            User ID:
          </p>
          <button
            onClick={handleCopyUserId}
            className="group relative flex items-center justify-between gap-2 px-3 py-2 bg-card rounded-xl border border-border hover:border-accent hover:bg-accent/5 active:scale-[0.98] transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 focus:ring-offset-background w-full"
            title="Click to copy user ID"
          >
            <span className="text-xs font-semibold text-foreground font-mono tracking-tight flex-1 text-left min-w-0 truncate">
              {shortenedUserId}
            </span>
            <div className="shrink-0 flex items-center justify-center w-6 h-6">
              {isCopiedUserId ? (
                <Check className="w-4 h-4 text-success transition-all" />
              ) : (
                <Copy className="w-4 h-4 text-muted-foreground group-hover:text-accent transition-colors" />
              )}
            </div>
          </button>
        </div>
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
