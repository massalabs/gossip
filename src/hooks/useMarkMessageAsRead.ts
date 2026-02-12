import { useEffect, useRef } from 'react';
import { useAccountStore } from '../stores/accountStore';
import {
  Message,
  MessageStatus,
  MessageDirection,
} from '@massalabs/gossip-sdk';
import { useGossipSdk } from './useGossipSdk';

// IntersectionObserver configuration constants
// Use a lower threshold to handle very long messages that are taller than the viewport
// For messages taller than viewport, 50% threshold can never be met, so we use 0.1 (10%)
const MESSAGE_READ_VISIBILITY_THRESHOLD = 0.1; // Message is considered "viewed" when 10% visible
const MESSAGE_READ_BOTTOM_MARGIN = '0px 0px -50px 0px'; // Require message to be 50px into viewport from bottom before marking as read

/**
 * Custom hook to automatically mark incoming messages as read when they come into view
 * @param message - The message to potentially mark as read
 */
export function useMarkMessageAsRead(message: Message) {
  const gossip = useGossipSdk();
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
        entries.forEach(async entry => {
          try {
            // Check if message should be marked as read:
            // 1. Message is intersecting (partially visible) with enough visibility threshold
            // 2. OR message has been scrolled past (bottom edge is above viewport top)
            //    This handles very long messages that are taller than the viewport
            const isIntersectingWithThreshold =
              entry.isIntersecting &&
              entry.intersectionRatio >= MESSAGE_READ_VISIBILITY_THRESHOLD;
            // If bottom of message is above viewport top (negative), it's been scrolled past
            const hasBeenScrolledPast = entry.boundingClientRect.bottom < 0;
            const shouldMarkAsRead =
              isIntersectingWithThreshold || hasBeenScrolledPast;

            if (
              shouldMarkAsRead &&
              message.status === MessageStatus.DELIVERED &&
              !hasBeenMarkedAsReadRef.current
            ) {
              // Mark this specific message as read
              hasBeenMarkedAsReadRef.current = await gossip.messages.markAsRead(
                message.id!
              );
            }
          } catch (error) {
            console.error('Failed to mark message as read:', error);
            // Reset flag on error so it can be retried
            hasBeenMarkedAsReadRef.current = false;
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
    gossip,
  ]);

  return messageRef;
}
