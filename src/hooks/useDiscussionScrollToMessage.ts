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
  id: number,
  messages: Message[],
  discussion?: Discussion
): number => {
  const messageIndex = messages.findIndex(msg => msg.id === id);
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
    (id: number) => {
      (async () => {
        const target = await gossip.messages.get(id);
        if (!target) {
          console.warn(`Message not found in database`);
          return;
        }

        if (target.contactUserId !== contactUserId) {
          navigate(ROUTES.discussion({ userId: target.contactUserId }), {
            state: { scrollToMessageId: id },
          });
          return;
        }

        const virtualIndex = getVirtualIndexForMessage(
          id,
          messages,
          discussion
        );
        if (virtualIndex === -1) {
          console.warn(
            `Message not found in current messages array. It may not be loaded yet.`
          );
          return;
        }

        messageListRef.current?.scrollToIndex(virtualIndex);

        if (!isSearchOpenRef.current) {
          const domId = `message-${id}`;
          setTimeout(() => {
            const element = document.getElementById(domId);
            if (element) {
              element.classList.add('highlight-message');

              if (highlightTimeoutRef.current) {
                clearTimeout(highlightTimeoutRef.current);
              }

              highlightTimeoutRef.current = setTimeout(() => {
                const el = document.getElementById(domId);
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
