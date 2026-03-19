import { useState, useEffect, useCallback } from 'react';
import type { GossipSdk, Contact } from '@massalabs/gossip-sdk';

interface UseForwardPreviewParams {
  gossip: GossipSdk;
  contact: Contact | undefined;
  initialForwardFromMessageId: number | undefined;
  setReplyingTo: (msg: import('@massalabs/gossip-sdk').Message | null) => void;
}

export function useForwardPreview({
  gossip,
  contact,
  initialForwardFromMessageId,
  setReplyingTo,
}: UseForwardPreviewParams) {
  const [forwardPreviewText, setForwardPreviewText] = useState<string | null>(
    null
  );
  const [forwardPreviewMode, setForwardPreviewMode] = useState<
    'forward' | 'reply'
  >('forward');
  const [forwardFromMessageId, setForwardFromMessageId] = useState<
    number | undefined
  >(initialForwardFromMessageId);

  useEffect(() => {
    let cancelled = false;

    const loadForwardPreview = async () => {
      if (forwardFromMessageId == null) {
        setForwardPreviewText(null);
        setForwardPreviewMode('forward');
        return;
      }

      // Reply and forward are mutually exclusive
      setReplyingTo(null);
      const original = await gossip.messages.get(forwardFromMessageId);
      if (!cancelled) {
        setForwardPreviewText(original?.content ?? null);
        if (original && contact && original.contactUserId === contact.userId) {
          setForwardPreviewMode('reply');
        } else {
          setForwardPreviewMode('forward');
        }
      }
    };

    loadForwardPreview();

    return () => {
      cancelled = true;
    };
  }, [forwardFromMessageId, contact, gossip, setReplyingTo]);

  const clearForward = useCallback(() => {
    setForwardFromMessageId(undefined);
    setForwardPreviewText(null);
  }, []);

  return {
    forwardFromMessageId,
    setForwardFromMessageId,
    forwardPreviewText,
    forwardPreviewMode,
    clearForward,
  };
}
