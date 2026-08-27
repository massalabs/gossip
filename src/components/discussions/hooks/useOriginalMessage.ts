import { logger } from '../../../utils/logger.ts';
import { useState, useEffect, useMemo, useCallback } from 'react';
import { Message, encodeUserId } from '@massalabs/gossip-sdk';
import { useGossipSdk } from '../../../hooks/useGossipSdk';
import { useMessageStore } from '../../../stores/messageStore';
import { messageIdEquals } from '../../../stores/messageStore.helpers';
import { parseLinks } from '../../../utils/linkUtils';

interface UseOriginalMessageOptions {
  message: Message;
  onScrollToMessage?: (messageId: number) => void;
}

export function useOriginalMessage({
  message,
  onScrollToMessage,
}: UseOriginalMessageOptions) {
  const sdk = useGossipSdk();
  const [dbOriginal, setDbOriginal] = useState<Message | null>(null);
  const [isLoadingOriginal, setIsLoadingOriginal] = useState(false);
  const [originalNotFound, setOriginalNotFound] = useState(false);

  const citedMsgId = message.replyTo?.originalMsgId;
  const citedContactId = message.forwardOf?.originalContactId;

  let originalContactUserId = message.contactUserId;
  if (citedContactId && citedContactId.length === 32) {
    try {
      originalContactUserId = encodeUserId(citedContactId);
    } catch {
      // keep default
    }
  }

  // Reactive lookup in the store — picks up optimistic updates (e.g. delete).
  // Messages that cite nothing select `undefined` so a store update doesn't
  // re-render every plain message in the list.
  const storeMessages = useMessageStore(state =>
    citedMsgId ? state.messagesByContact.get(originalContactUserId) : undefined
  );
  const storeMatch = useMemo(() => {
    if (!citedMsgId || !storeMessages) return undefined;
    return storeMessages.find(m => messageIdEquals(m.messageId, citedMsgId));
  }, [citedMsgId, storeMessages]);

  // Fall back to DB for messages not in the store (e.g. older messages not loaded)
  useEffect(() => {
    if (storeMatch) {
      setDbOriginal(null);
      setOriginalNotFound(false);
      setIsLoadingOriginal(false);
      return;
    }

    if (citedMsgId && sdk.isSessionOpen) {
      setIsLoadingOriginal(true);
      setOriginalNotFound(false);

      // Items are virtualized: a slow lookup can resolve after this row
      // unmounted or switched to another message — drop the stale result.
      let cancelled = false;
      const findMessage = async () => {
        try {
          const msg = await sdk.messages.findMessageByMsgId(
            citedMsgId,
            message.ownerUserId,
            originalContactUserId
          );
          if (cancelled) return;

          if (msg) {
            setDbOriginal(msg);
            setOriginalNotFound(false);
          } else {
            setDbOriginal(null);
            setOriginalNotFound(true);
          }
        } catch (e) {
          if (cancelled) return;
          logger.error('Error finding message by seeker:', e);
          setDbOriginal(null);
          setOriginalNotFound(true);
        } finally {
          if (!cancelled) setIsLoadingOriginal(false);
        }
      };

      findMessage();
      return () => {
        cancelled = true;
      };
    } else if (message.replyTo || message.forwardOf) {
      setDbOriginal(null);
      setOriginalNotFound(true);
      setIsLoadingOriginal(false);
    } else {
      setDbOriginal(null);
      setOriginalNotFound(false);
      setIsLoadingOriginal(false);
    }
  }, [
    citedMsgId,
    storeMatch,
    message.replyTo,
    message.forwardOf,
    message.ownerUserId,
    originalContactUserId,
    sdk,
  ]);

  // Store match wins over DB result (more up-to-date)
  const originalMessage = storeMatch ?? dbOriginal;

  const handleReplyContextClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      if (originalMessage?.id && onScrollToMessage) {
        onScrollToMessage(originalMessage.id);
      }
    },
    [originalMessage?.id, onScrollToMessage]
  );

  const handleReplyContextKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (
        (e.key === 'Enter' || e.key === ' ') &&
        originalMessage?.id &&
        onScrollToMessage
      ) {
        e.preventDefault();
        e.stopPropagation();
        onScrollToMessage(originalMessage.id);
      }
    },
    [originalMessage?.id, onScrollToMessage]
  );

  // Parse links in reply original content
  const replyOriginalContent = originalMessage?.content || '';
  const parsedReplyLinks = useMemo(
    () => parseLinks(replyOriginalContent),
    [replyOriginalContent]
  );

  // Parse links in forward original content
  const forwardOriginalContent =
    originalMessage?.content || message.forwardOf?.originalContent || '';
  const parsedForwardLinks = useMemo(
    () => parseLinks(forwardOriginalContent),
    [forwardOriginalContent]
  );

  const canNavigateToForwarded =
    !!originalMessage?.id && typeof onScrollToMessage === 'function';

  // Stable object: this result is passed as a prop to the memoized
  // MessageBubble — a fresh object every render would defeat its memo.
  return useMemo(
    () => ({
      originalMessage,
      isLoadingOriginal,
      originalNotFound,
      handleReplyContextClick,
      handleReplyContextKeyDown,
      parsedReplyLinks,
      parsedForwardLinks,
      canNavigateToForwarded,
    }),
    [
      originalMessage,
      isLoadingOriginal,
      originalNotFound,
      handleReplyContextClick,
      handleReplyContextKeyDown,
      parsedReplyLinks,
      parsedForwardLinks,
      canNavigateToForwarded,
    ]
  );
}
