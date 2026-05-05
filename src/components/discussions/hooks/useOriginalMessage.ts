import { useState, useEffect, useMemo, useCallback } from 'react';
import { Message, encodeUserId } from '@massalabs/gossip-sdk';
import { useGossipSdk } from '../../../hooks/useGossipSdk';
import { useMessageStore } from '../../../stores/messageStore';
import { useSelfMessageStore } from '../../../stores/selfMessageStore';
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
  const repliedMessageInSelfDiscussionId =
    sdk.selfMessages.repliedMessageId(message);
  const citedContactId = message.forwardOf?.originalContactId;

  let originalContactUserId = message.contactUserId;
  if (citedContactId && citedContactId.length === 32) {
    try {
      originalContactUserId = encodeUserId(citedContactId);
    } catch {
      // keep default
    }
  }

  // Reactive lookup in the store — picks up optimistic updates (e.g. delete)
  const storeSelfMessages = useSelfMessageStore(state => state.messages);
  const storeMessages = useMessageStore(state =>
    state.messagesByContact.get(originalContactUserId)
  );
  const storeMatch = useMemo(() => {
    if (repliedMessageInSelfDiscussionId != null && storeSelfMessages) {
      return storeSelfMessages.find(
        m => m.id === repliedMessageInSelfDiscussionId
      );
    }
    if (!citedMsgId || !storeMessages) return undefined;
    return storeMessages.find(m => messageIdEquals(m.messageId, citedMsgId));
  }, [
    repliedMessageInSelfDiscussionId,
    citedMsgId,
    storeMessages,
    storeSelfMessages,
  ]);

  // Fall back to DB for messages not in the store (e.g. older messages not loaded)
  useEffect(() => {
    if (storeMatch) {
      setDbOriginal(null);
      setOriginalNotFound(false);
      setIsLoadingOriginal(false);
      return;
    }

    if (
      sdk.isSessionOpen &&
      (repliedMessageInSelfDiscussionId != null || citedMsgId)
    ) {
      setIsLoadingOriginal(true);
      setOriginalNotFound(false);

      const findMessage = async () => {
        try {
          const msg =
            repliedMessageInSelfDiscussionId != null
              ? await sdk.messages.get(repliedMessageInSelfDiscussionId)
              : await sdk.messages.findMessageByMsgId(
                  citedMsgId as Uint8Array,
                  message.ownerUserId,
                  originalContactUserId
                );

          if (msg) {
            setDbOriginal(msg);
            setOriginalNotFound(false);
          } else {
            setDbOriginal(null);
            setOriginalNotFound(true);
          }
        } catch (e) {
          console.error('Error finding message by seeker:', e);
          setDbOriginal(null);
          setOriginalNotFound(true);
        } finally {
          setIsLoadingOriginal(false);
        }
      };

      findMessage();
    } else if (
      message.replyTo ||
      message.forwardOf ||
      repliedMessageInSelfDiscussionId != null
    ) {
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
    repliedMessageInSelfDiscussionId,
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
