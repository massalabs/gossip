import { useEffect, useRef } from 'react';
import { Message, MessageDirection, MessageStatus, db } from '../db';
import { useAccountStore } from '../stores/accountStore';

/**
 * Custom hook to automatically mark incoming messages as read when they come into view
 * @param message - The message to potentially mark as read
 */
export function useMarkMessageAsRead(message: Message) {
  const messageRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const { userProfile } = useAccountStore.getState();
    const messageElement = messageRef.current;

    // Only set up observer for incoming messages that are DELIVERED (unread)
    if (
      !messageElement ||
      message.direction !== MessageDirection.INCOMING ||
      message.status !== MessageStatus.DELIVERED ||
      !userProfile?.userId
    ) {
      return;
    }

    const observer = new IntersectionObserver(
      entries => {
        entries.forEach(entry => {
          if (
            entry.isIntersecting &&
            message.status === MessageStatus.DELIVERED
          ) {
            // Mark this specific message as read
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
            });
          }
        });
      },
      {
        threshold: 0.5, // Message is considered "viewed" when 50% visible
        rootMargin: '0px 0px -50px 0px', // Trigger when message is near the top
      }
    );

    observer.observe(messageElement);

    return () => {
      observer.disconnect();
    };
  }, [
    message.id,
    message.direction,
    message.status,
    message.contactUserId,
    message.ownerUserId,
  ]);

  return messageRef;
}
