import { useCallback, useEffect, useRef, useState } from 'react';
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

  const [retryMessagesByContact, setRetryMessagesByContact] = useState<
    Map<string, Message[]>
  >(new Map());
  const [brokenDiscussions, setBrokenDiscussions] = useState<Discussion[]>([]);
  const [sendFailedDiscussions, setSendFailedDiscussions] = useState<
    Discussion[]
  >([]);

  // Watch for failed items in the database
  useEffect(() => {
    if (!userProfile?.userId) {
      setRetryMessagesByContact(new Map());
      setBrokenDiscussions([]);
      setSendFailedDiscussions([]);
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
        setBrokenDiscussions(broken);

        // Group failed messages by contact, excluding broken discussions
        const brokenIds = new Set(broken.map(d => d.contactUserId));
        const grouped = new Map<string, Message[]>();
        for (const msg of failedMessages) {
          if (!msg.id || brokenIds.has(msg.contactUserId)) continue;
          const list = grouped.get(msg.contactUserId) || [];
          list.push(msg);
          grouped.set(msg.contactUserId, list);
        }
        setRetryMessagesByContact(grouped);
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
      next: setSendFailedDiscussions,
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
      for (const discussion of brokenDiscussions) {
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
      if (sendFailedDiscussions.length > 0) {
        try {
          await announcementService.resendAnnouncements(
            sendFailedDiscussions,
            session
          );
        } catch (err) {
          console.error('Failed to resend announcements:', err);
        }
      }

      // Resend failed messages
      if (retryMessagesByContact.size > 0) {
        try {
          await messageService.resendMessages(retryMessagesByContact, session);
        } catch (err) {
          console.error('Failed to resend messages:', err);
        }
      }
    } finally {
      isResending.current = false;
    }
  }, [
    session,
    userProfile?.userId,
    brokenDiscussions,
    sendFailedDiscussions,
    retryMessagesByContact,
  ]);

  return { resendFailedBlobs };
}
