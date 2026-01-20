import { useEffect, useRef } from 'react';
import { Message, MessageDirection, MessageStatus, db } from '../db';
import { useAccountStore } from '../stores/accountStore';

// IntersectionObserver configuration constants
const MESSAGE_READ_VISIBILITY_THRESHOLD = 0.5; // Message is considered "viewed" when 50% visible
const MESSAGE_READ_BOTTOM_MARGIN = '0px 0px -50px 0px'; // Require message to be 50px into viewport from bottom before marking as read

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

  // Get userProfile from store - use selector to ensure effect re-runs when it changes
  const userProfile = useAccountStore(s => s.userProfile);

  useEffect(() => {
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
              // Check current message status from DB to avoid race conditions
              const currentMessage = await db.messages.get(message.id!);
              if (
                !currentMessage ||
                currentMessage.status !== MessageStatus.DELIVERED
              ) {
                // Message was already marked as read or doesn't exist
                hasBeenMarkedAsReadRef.current = false;
                return;
              }

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
        threshold: MESSAGE_READ_VISIBILITY_THRESHOLD,
        rootMargin: MESSAGE_READ_BOTTOM_MARGIN,
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
    userProfile?.userId,
  ]);

  return messageRef;
}
