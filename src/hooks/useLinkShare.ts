import { useState, useCallback, useEffect, useRef } from 'react';
import toast from 'react-hot-toast';
import {
  canShareInvitationViaOtherApp,
  shareInvitation,
} from '../services/shareService';

export function useLinkShare(deepLinkUrl: string): {
  copiedLink: boolean;
  isSharingLink: boolean;
  canShareViaOtherApp: boolean;
  handleCopyLink: () => Promise<void>;
  handleShareLink: () => Promise<void>;
} {
  const [copiedLink, setCopiedLink] = useState(false);
  const [isSharingLink, setIsSharingLink] = useState(false);
  const [canShareViaOtherApp, setCanShareViaOtherApp] = useState(false);
  const copiedLinkTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
    null
  );

  const handleCopyLink = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(deepLinkUrl);
      setCopiedLink(true);

      if (copiedLinkTimeoutRef.current) {
        clearTimeout(copiedLinkTimeoutRef.current);
      }

      copiedLinkTimeoutRef.current = setTimeout(() => {
        setCopiedLink(false);
        copiedLinkTimeoutRef.current = null;
      }, 2000);
    } catch (error) {
      console.error('Failed to copy invitation link:', error);
      toast.error('Failed to copy invitation link. Please try again.');
    }
  }, [deepLinkUrl]);

  const handleShareLink = useCallback(async () => {
    try {
      setIsSharingLink(true);
      await shareInvitation({ deepLinkUrl });
    } catch (error) {
      console.error('Failed to share invitation link:', error);
      toast.error('Failed to share invitation link. Please try again.');
    } finally {
      setIsSharingLink(false);
    }
  }, [deepLinkUrl]);

  useEffect(() => {
    setCanShareViaOtherApp(canShareInvitationViaOtherApp());

    return () => {
      if (copiedLinkTimeoutRef.current) {
        clearTimeout(copiedLinkTimeoutRef.current);
      }
    };
  }, []);

  return {
    copiedLink,
    isSharingLink,
    canShareViaOtherApp,
    handleCopyLink,
    handleShareLink,
  };
}
