import { logger } from '../../utils/logger.ts';
import React, { useEffect, useState, useCallback, useRef } from 'react';
import { Check, Copy } from 'react-feather';

import { PrivacyGraphic } from '../graphics';
import { formatUserId } from '@massalabs/gossip-sdk';
import { qrCache, generateQRDataUrl } from './shareContactQrCache';

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
      logger.error('Failed to copy MNS domain:', err);
    }
  }, []);

  const handleCopyUserId = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(userId);
      setIsCopiedUserId(true);
      setTimeout(() => setIsCopiedUserId(false), 2000);
    } catch (err) {
      logger.error('Failed to copy user ID:', err);
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
    // Check cache first — avoids regeneration on slide back/forward
    const cached = qrCache.get(deepLinkUrl);
    if (cached) {
      setQrDataUrl(cached);
      onQRCodeGenerated?.(cached);
      return;
    }

    let isMounted = true;

    generateQRDataUrl(deepLinkUrl)
      .then(dataUrl => {
        if (!isMounted) return;
        qrCache.set(deepLinkUrl, dataUrl);
        setQrDataUrl(dataUrl);
        onQRCodeGenerated?.(dataUrl);
      })
      .catch(err => {
        logger.error('Failed to generate QR:', err);
      });

    return () => {
      isMounted = false;
    };
  }, [deepLinkUrl, onQRCodeGenerated]);

  return (
    <div className="flex flex-col gap-3">
      {/* QR code — hero element */}
      <div className="flex justify-center">
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

      {/* MNS Domains and User ID with copy functionality */}
      <div className="flex flex-col gap-2 w-full" ref={containerRef}>
        {mnsDomains &&
          mnsDomains.length > 0 &&
          mnsDomains.map(domain => {
            const isCopied = copiedMnsDomains.has(domain);
            return (
              <button
                key={domain}
                onClick={() => handleCopyMns(domain)}
                className="group flex items-center justify-between gap-2 h-11 px-3 bg-card rounded-xl border border-border hover:border-accent hover:bg-accent/5 active:scale-[0.98] transition-all duration-200 w-full"
                title="Click to copy MNS domain"
              >
                <span className="text-[10px] font-medium text-muted-foreground tracking-wider shrink-0">
                  MNS
                </span>
                <span className="text-xs font-semibold text-foreground font-mono tracking-tight flex-1 text-left min-w-0 truncate ml-2">
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
        <button
          onClick={handleCopyUserId}
          className="group flex items-center justify-between gap-2 h-11 px-3 bg-card rounded-xl border border-border hover:border-accent hover:bg-accent/5 active:scale-[0.98] transition-all duration-200 w-full"
          title="Click to copy user ID"
        >
          <span className="text-[10px] font-medium text-muted-foreground tracking-wider shrink-0">
            ID
          </span>
          <span className="text-xs font-semibold text-foreground font-mono tracking-tight flex-1 text-left min-w-0 truncate ml-2">
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
  );
};

export default ShareContactQR;
