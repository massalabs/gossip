import { useEffect, useRef } from 'react';
import { Message, MessageDirection, MessageStatus, db } from '../db';
import { useAccountStore } from '../stores/accountStore';

/**
 * Custom hook to automatically mark incoming messages as read when they come into view
 * @param message - The message to potentially mark as read
 */
export function useMarkMessageAsRead(message: Message) {
  const messageRef = useRef<HTMLDivElement | null>(null);
  const hasBeenMarkedAsReadRef = useRef<boolean>(false);

  useEffect(() => {
    // Reset the mark-as-read flag when the message changes
    hasBeenMarkedAsReadRef.current = false;
  }, [message.id]);

  useEffect(() => {
    const { userProfile } = useAccountStore.getState();
    const messageElement = messageRef.current;

    // Only set up observer for incoming messages that are DELIVERED (unread)
    if (
      !messageElement ||
      message.direction !== MessageDirection.INCOMING ||
      message.status !== MessageStatus.DELIVERED ||
      !userProfile?.userId ||
      hasBeenMarkedAsReadRef.current
    ) {
      return;
    }

    const observer = new IntersectionObserver(
      entries => {
        entries.forEach(entry => {
          if (
            entry.isIntersecting &&
            message.status === MessageStatus.DELIVERED &&
            !hasBeenMarkedAsReadRef.current
          ) {
            // Mark this specific message as read
            hasBeenMarkedAsReadRef.current = true;
            db.transaction('rw', [db.messages, db.discussions], async () => {
              // Update message status
              await db.messages.update(message.id!, {
                status: MessageStatus.READ,
              });

              // Decrement discussion unread count
              await db.discussions
                .where('[ownerUserId+contactUserId]')
                .equals([message.ownerUserId, message.contactUserId])
                .modify(discussion => {
                  if (discussion.unreadCount > 0) {
                    discussion.unreadCount -= 1;
                  }
                });
            }).catch(error => {
              console.error('Failed to mark message as read:', error);
              // Reset flag on error so it can be retried
              hasBeenMarkedAsReadRef.current = false;
            });
          }
        });
      },
      {
        threshold: 0.5, // Message is considered "viewed" when 50% visible
        rootMargin: '0px 0px -50px 0px', // Require message to be 50px into viewport from bottom before marking as read
      }
    );

    observer.observe(messageElement);

    return () => {
      observer.disconnect();
    };
  }, [
    message.direction,
    message.status,
    message.contactUserId,
    message.ownerUserId,
    message.id,
  ]);

  return messageRef;
}
