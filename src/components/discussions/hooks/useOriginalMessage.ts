import { useState, useEffect, useMemo, useCallback } from 'react';
import { Message, encodeUserId } from '@massalabs/gossip-sdk';
import { useGossipSdk } from '../../../hooks/useGossipSdk';
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
  const [originalMessage, setOriginalMessage] = useState<Message | null>(null);
  const [isLoadingOriginal, setIsLoadingOriginal] = useState(false);
  const [originalNotFound, setOriginalNotFound] = useState(false);

  // Load original message if this is a reply or forward
  useEffect(() => {
    const citedMsgId = message.replyTo?.originalMsgId;
    const citedContactId = message.forwardOf?.originalContactId;
    let originalContactUserId = message.contactUserId;

    if (citedContactId && citedContactId.length === 32) {
      try {
        originalContactUserId = encodeUserId(citedContactId);
      } catch (error) {
        console.warn('Failed to encode cited contact ID', error);
      }
    }

    if (citedMsgId && sdk.isSessionOpen) {
      setIsLoadingOriginal(true);
      setOriginalNotFound(false);

      const findMessage = async () => {
        try {
          const msg = await sdk.messages.findMessageByMsgId(
            citedMsgId,
            message.ownerUserId,
            originalContactUserId
          );

          if (msg) {
            setOriginalMessage(msg);
            setOriginalNotFound(false);
          } else {
            setOriginalMessage(null);
            setOriginalNotFound(true);
          }
        } catch (e) {
          console.error('Error finding message by seeker:', e);
          setOriginalMessage(null);
          setOriginalNotFound(true);
        } finally {
          setIsLoadingOriginal(false);
        }
      };

      findMessage();
    } else if (message.replyTo || message.forwardOf) {
      setOriginalMessage(null);
      setOriginalNotFound(true);
      setIsLoadingOriginal(false);
    } else {
      setOriginalMessage(null);
      setOriginalNotFound(false);
      setIsLoadingOriginal(false);
    }
  }, [
    message.replyTo,
    message.forwardOf,
    message.ownerUserId,
    message.contactUserId,
    sdk,
  ]);

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

  return {
    originalMessage,
    isLoadingOriginal,
    originalNotFound,
    handleReplyContextClick,
    handleReplyContextKeyDown,
    parsedReplyLinks,
    parsedForwardLinks,
    canNavigateToForwarded,
  };
}
