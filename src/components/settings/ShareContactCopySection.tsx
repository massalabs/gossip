import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Check, Copy } from 'react-feather';
import Button from '../ui/Button';

interface ShareContactCopySectionProps {
  userId: string;
  deepLinkUrl: string;
}

const ShareContactCopySection: React.FC<ShareContactCopySectionProps> = ({
  userId,
  deepLinkUrl,
}) => {
  const [copiedUserId, setCopiedUserId] = useState(false);
  const [copiedQRUrl, setCopiedQRUrl] = useState(false);
  const userIdTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const qrUrlTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleCopyUserId = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(userId);
      setCopiedUserId(true);
      if (userIdTimeoutRef.current) {
        clearTimeout(userIdTimeoutRef.current);
      }
      userIdTimeoutRef.current = setTimeout(() => {
        setCopiedUserId(false);
        userIdTimeoutRef.current = null;
      }, 2000);
    } catch (err) {
      console.error('Failed to copy user ID:', err);
    }
  }, [userId]);

  const handleCopyQRUrl = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(deepLinkUrl);
      setCopiedQRUrl(true);
      if (qrUrlTimeoutRef.current) {
        clearTimeout(qrUrlTimeoutRef.current);
      }
      qrUrlTimeoutRef.current = setTimeout(() => {
        setCopiedQRUrl(false);
        qrUrlTimeoutRef.current = null;
      }, 2000);
    } catch (err) {
      console.error('Failed to copy QR code URL:', err);
    }
  }, [deepLinkUrl]);

  useEffect(() => {
    return () => {
      if (userIdTimeoutRef.current) {
        clearTimeout(userIdTimeoutRef.current);
      }
      if (qrUrlTimeoutRef.current) {
        clearTimeout(qrUrlTimeoutRef.current);
      }
    };
  }, []);

  return (
    <div className="flex flex-col gap-2">
      <Button variant="outline" onClick={handleCopyUserId}>
        {copiedUserId ? (
          <Check className="w-5 h-5 mr-4 text-success" />
        ) : (
          <Copy className="w-5 h-5 mr-4" />
        )}
        <span
          className={`text-base font-semibold flex-1 text-left ${copiedUserId ? 'text-success' : ''}`}
        >
          {copiedUserId ? 'User ID Copied!' : 'Copy User ID'}
        </span>
      </Button>
      <Button variant="outline" onClick={handleCopyQRUrl}>
        {copiedQRUrl ? (
          <Check className="w-5 h-5 mr-4 text-success" />
        ) : (
          <Copy className="w-5 h-5 mr-4" />
        )}
        <span
          className={`text-base font-semibold flex-1 text-left ${copiedQRUrl ? 'text-success' : ''}`}
        >
          {copiedQRUrl ? 'QR Code URL Copied!' : 'Copy QR Code Invite'}
        </span>
      </Button>
    </div>
  );
};

export default ShareContactCopySection;
