import { useCallback, useEffect, useRef } from 'react';
import { liveQuery, Subscription } from 'dexie';
import { useAccountStore } from '../stores/accountStore';
import { announcementService } from '../services/announcement';
import {
  Discussion,
  DiscussionStatus,
  db,
  MessageStatus,
  Message,
} from '../db';
import { renewDiscussion } from '../services/discussion';
import { messageService } from '../services/message';
import { restMessageProtocol } from '../api/messageProtocol';

/**
 * Hook to manually renew a discussion (e.g., from settings page).
 * Changes node and re-initiates the discussion.
 */
export function useManualRenewDiscussion() {
  const { userProfile, session } = useAccountStore();

  return useCallback(
    async (contactUserId: string): Promise<void> => {
      if (!userProfile?.userId || !session) {
        console.warn(
          'Cannot renew discussion: WASM keys or session unavailable'
        );
        return;
      }

      try {
        await restMessageProtocol.changeNode();
      } catch (error) {
        console.error('Failed to change node:', error);
      }

      try {
        await renewDiscussion(contactUserId, session);
      } catch (error) {
        console.error(
          `Failed to renew discussion with ${contactUserId}:`,
          error
        );
      }
    },
    [userProfile?.userId, session]
  );
}

/**
 * Hook that watches for failed blobs and provides a function to retry them.
 * Used by useAppStateRefresh for automatic retry logic.
 */
export function useResendFailedBlobs() {
  const { userProfile, session } = useAccountStore();
  const isResending = useRef(false);

  // Use refs to store the latest values from liveQuery
  // They'll be updated directly by liveQuery callbacks
  const retryMessagesByContactRef = useRef<Map<string, Message[]>>(new Map());
  const brokenDiscussionsRef = useRef<Discussion[]>([]);
  const sendFailedDiscussionsRef = useRef<Discussion[]>([]);

  // Watch for failed items in the database
  useEffect(() => {
    if (!userProfile?.userId) {
      // Clear refs when no user is logged in
      retryMessagesByContactRef.current = new Map();
      brokenDiscussionsRef.current = [];
      sendFailedDiscussionsRef.current = [];
      return;
    }

    const subscriptions: Subscription[] = [];

    // Failed messages and broken discussions
    const failedSub = liveQuery(async () => {
      return db.transaction('r', [db.messages, db.discussions], async () => {
        const [failedMessages, broken] = await Promise.all([
          db.messages
            .where('[ownerUserId+status]')
            .equals([userProfile.userId, MessageStatus.FAILED])
            .toArray(),
          db.discussions
            .where('[ownerUserId+status]')
            .equals([userProfile.userId, DiscussionStatus.BROKEN])
            .toArray(),
        ]);
        return { failedMessages, broken };
      });
    }).subscribe({
      next: ({ failedMessages, broken }) => {
        // Update refs directly - no need for state since we only use refs
        brokenDiscussionsRef.current = broken;
        console.log('failedSub: failedMessages', failedMessages);

        // Group failed messages by contact, excluding broken discussions
        const brokenIds = new Set(broken.map(d => d.contactUserId));
        const grouped = new Map<string, Message[]>();
        for (const msg of failedMessages) {
          if (!msg.id || brokenIds.has(msg.contactUserId)) continue;
          const list = grouped.get(msg.contactUserId) || [];
          list.push(msg);
          grouped.set(msg.contactUserId, list);
        }
        console.log('failedSub: grouped', grouped);
        retryMessagesByContactRef.current = grouped;
      },
      error: err => console.error('Failed to observe failed items:', err),
    });
    subscriptions.push(failedSub);

    // Send-failed discussions (announcement failed to send)
    const sendFailedSub = liveQuery(() =>
      db.discussions
        .where('[ownerUserId+status]')
        .equals([userProfile.userId, DiscussionStatus.SEND_FAILED])
        .toArray()
    ).subscribe({
      next: discussions => {
        // Update ref directly - no need for state since we only use refs
        sendFailedDiscussionsRef.current = discussions;
      },
      error: err =>
        console.error('Failed to observe send-failed discussions:', err),
    });
    subscriptions.push(sendFailedSub);

    return () => subscriptions.forEach(s => s.unsubscribe());
  }, [userProfile?.userId]);

  // Resend all failed items
  const resendFailedBlobs = useCallback(async () => {
    if (isResending.current) return;
    if (!session || !userProfile?.userId) return;

    isResending.current = true;
    try {
      // Reinitiate broken discussions
      // Note: renewDiscussion marks old messages as FAILED in the database
      const currentBrokenDiscussions = brokenDiscussionsRef.current;
      for (const discussion of currentBrokenDiscussions) {
        try {
          await renewDiscussion(discussion.contactUserId, session);
        } catch (err) {
          console.error(
            `Failed to reinitiate discussion ${discussion.contactUserId}:`,
            err
          );
        }
      }

      // Resend failed announcements
      const currentSendFailedDiscussions = sendFailedDiscussionsRef.current;
      if (currentSendFailedDiscussions.length > 0) {
        try {
          await announcementService.resendAnnouncements(
            currentSendFailedDiscussions,
            session
          );
        } catch (err) {
          console.error('Failed to resend announcements:', err);
        }
      }

      // Read retry messages from ref - refs are updated immediately by liveQuery callbacks
      const currentRetryMessages = retryMessagesByContactRef.current;
      // Resend failed messages
      if (currentRetryMessages.size > 0) {
        console.log(
          'resendFailedBlobs: currentRetryMessages',
          currentRetryMessages
        );
        try {
          await messageService.resendMessages(currentRetryMessages, session);
        } catch (err) {
          console.error('Failed to resend messages:', err);
        }
      }
    } finally {
      isResending.current = false;
    }
  }, [session, userProfile?.userId]);

  return { resendFailedBlobs };
}
