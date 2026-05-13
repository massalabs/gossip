import { logger } from '../utils/logger.ts';
import { useCallback, useEffect, useRef, RefObject } from 'react';
import { NavigateFunction } from 'react-router-dom';
import { Discussion, GossipSdk, Message } from '@massalabs/gossip-sdk';
import { ROUTES } from '../constants/routes';
import { isDifferentDay } from '../utils/timeUtils';
import { MessageListHandle } from '../components/discussions/MessageList';

interface UseDiscussionScrollToMessageParams {
  gossip: GossipSdk;
  navigate: NavigateFunction;
  contactUserId?: string;
  messages: Message[];
  discussion?: Discussion;
  messageListRef: RefObject<MessageListHandle | null>;
  isSearchOpen: boolean;
}

const getVirtualIndexForMessage = (
  messageId: number,
  messages: Message[],
  discussion?: Discussion
): number => {
  const messageIndex = messages.findIndex(msg => msg.id === messageId);
  if (messageIndex === -1) {
    return -1;
  }

  let virtualIndex = 0;

  if (discussion?.lastAnnouncementMessage && discussion.createdAt) {
    virtualIndex++;
  }

  for (let i = 0; i < messageIndex; i++) {
    const message = messages[i];
    const prevMessage = i > 0 ? messages[i - 1] : null;

    if (
      !prevMessage ||
      isDifferentDay(message.timestamp, prevMessage.timestamp)
    ) {
      virtualIndex++;
    }

    virtualIndex++;
  }

  const prevMessage = messageIndex > 0 ? messages[messageIndex - 1] : null;
  const targetMessage = messages[messageIndex];
  if (
    !prevMessage ||
    isDifferentDay(targetMessage.timestamp, prevMessage.timestamp)
  ) {
    virtualIndex++;
  }

  return virtualIndex;
};

export const useDiscussionScrollToMessage = ({
  gossip,
  navigate,
  contactUserId,
  messages,
  discussion,
  messageListRef,
  isSearchOpen,
}: UseDiscussionScrollToMessageParams) => {
  const isSearchOpenRef = useRef(isSearchOpen);
  const highlightTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  isSearchOpenRef.current = isSearchOpen;

  useEffect(() => {
    return () => {
      if (highlightTimeoutRef.current) {
        clearTimeout(highlightTimeoutRef.current);
      }
    };
  }, []);

  const handleScrollToMessage = useCallback(
    (messageId: number) => {
      (async () => {
        const target = await gossip.messages.get(messageId);
        if (!target) {
          logger.warn(`Message with id ${messageId} not found in database`);
          return;
        }

        if (target.contactUserId !== contactUserId) {
          navigate(ROUTES.discussion({ userId: target.contactUserId }), {
            state: { scrollToMessageId: messageId },
          });
          return;
        }

        const virtualIndex = getVirtualIndexForMessage(
          messageId,
          messages,
          discussion
        );
        if (virtualIndex === -1) {
          logger.warn(
            `Message ${messageId} not found in current messages array. It may not be loaded yet.`
          );
          return;
        }

        messageListRef.current?.scrollToIndex(virtualIndex);

        if (!isSearchOpenRef.current) {
          setTimeout(() => {
            const element = document.getElementById(`message-${messageId}`);
            if (element) {
              element.classList.add('highlight-message');

              if (highlightTimeoutRef.current) {
                clearTimeout(highlightTimeoutRef.current);
              }

              highlightTimeoutRef.current = setTimeout(() => {
                const el = document.getElementById(`message-${messageId}`);
                if (el) {
                  el.classList.remove('highlight-message');
                }
              }, 2000);
            }
          }, 200);
        }
      })();
    },
    [gossip, contactUserId, messages, discussion, navigate, messageListRef]
  );

  return { handleScrollToMessage };
};
