import { useState, useEffect, useCallback } from 'react';
import type { GossipSdk } from '@massalabs/gossip-sdk';
import { getForwardSourceContent } from '../utils/messages';

interface UseForwardPreviewParams {
  gossip: GossipSdk;
  initialForwardFromMessageIds: number[] | undefined;
  setReplyingTo: (msg: import('@massalabs/gossip-sdk').Message | null) => void;
}

async function loadForwardSourceContent(
  gossip: GossipSdk,
  messageId: number
): Promise<string | null> {
  // Notes first (SelfMessageService); avoids MessageService plaintext JSON
  // parse of encrypted Notes forwardOf.
  const selfMsg = await gossip.selfMessages.get(messageId);
  if (selfMsg) {
    return getForwardSourceContent(selfMsg) || null;
  }
  const row = await gossip.messages.get(messageId);
  return row ? getForwardSourceContent(row) || null : null;
}

export function useForwardPreview({
  gossip,
  initialForwardFromMessageIds,
  setReplyingTo,
}: UseForwardPreviewParams) {
  const [forwardPreviewText, setForwardPreviewText] = useState<string | null>(
    null
  );
  const [forwardFromMessageIds, setForwardFromMessageIds] = useState<number[]>(
    initialForwardFromMessageIds ?? []
  );

  useEffect(() => {
    let cancelled = false;

    const loadForwardPreview = async () => {
      if (forwardFromMessageIds.length === 0) {
        setForwardPreviewText(null);
        return;
      }

      // Reply and forward are mutually exclusive
      setReplyingTo(null);
      const content = await loadForwardSourceContent(
        gossip,
        forwardFromMessageIds[0]
      );
      if (!cancelled) {
        setForwardPreviewText(content);
      }
    };

    loadForwardPreview();

    return () => {
      cancelled = true;
    };
  }, [forwardFromMessageIds, gossip, setReplyingTo]);

  const clearForward = useCallback(() => {
    setForwardFromMessageIds([]);
    setForwardPreviewText(null);
  }, []);

  return {
    forwardFromMessageIds,
    setForwardFromMessageIds,
    forwardPreviewText,
    forwardPreviewMode: 'forward' as const,
    clearForward,
  };
}
