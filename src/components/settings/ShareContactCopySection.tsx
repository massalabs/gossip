import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Check, Copy, Share2 } from 'react-feather';
import Button from '../ui/Button';
import { shareInvitation } from '../../services/shareService';

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
  const [isSharing, setIsSharing] = useState(false);
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
      console.error('Failed to invitation link:', err);
    }
  }, [deepLinkUrl]);

  const handleShareInvitation = useCallback(async () => {
    try {
      setIsSharing(true);
      await shareInvitation({
        deepLinkUrl,
      });
    } catch (err) {
      console.error('Failed to share invitation:', err);
    } finally {
      setIsSharing(false);
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
    <div className="bg-card rounded-xl border border-border overflow-hidden">
      <Button
        variant="outline"
        size="custom"
        className="w-full h-[54px] flex items-center px-4 justify-start rounded-none border-0 border-b border-border"
        onClick={handleShareInvitation}
        disabled={isSharing}
        loading={isSharing}
      >
        <Share2 className="w-5 h-5 mr-4" />
        <span className="text-base font-normal flex-1 text-left">
          Share Invitation
        </span>
      </Button>
      <Button
        variant="outline"
        size="custom"
        className="w-full h-[54px] flex items-center px-4 justify-start rounded-none border-0 border-b border-border"
        onClick={handleCopyUserId}
      >
        {copiedUserId ? (
          <Check className="w-5 h-5 mr-4 text-success" />
        ) : (
          <Copy className="w-5 h-5 mr-4" />
        )}
        <span
          className={`text-base font-normal flex-1 text-left ${copiedUserId ? 'text-success' : ''}`}
        >
          {copiedUserId ? 'User ID Copied!' : 'Copy User ID'}
        </span>
      </Button>
      <Button
        variant="outline"
        size="custom"
        className="w-full h-[54px] flex items-center px-4 justify-start rounded-none border-0"
        onClick={handleCopyQRUrl}
      >
        {copiedQRUrl ? (
          <Check className="w-5 h-5 mr-4 text-success" />
        ) : (
          <Copy className="w-5 h-5 mr-4" />
        )}
        <span
          className={`text-base font-normal flex-1 text-left ${copiedQRUrl ? 'text-success' : ''}`}
        >
          {copiedQRUrl ? 'Invitation Link Copied!' : 'Copy Invitation Link'}
        </span>
      </Button>
    </div>
  );
};

export default ShareContactCopySection;
