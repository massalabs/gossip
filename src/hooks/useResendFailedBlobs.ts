import { useCallback, useEffect, useRef, useState } from 'react';
import { liveQuery, Subscription } from 'dexie';
import { useAccountStore } from '../stores/accountStore';
import { RetryMessages } from '../stores/messageStore';
import { announcementService } from '../services/announcement';
import { Discussion, DiscussionStatus, db, MessageStatus } from '../db';
import { renewDiscussion } from '../services/discussion';
import { messageService } from '../services/message';

const RESEND_INTERVAL_MS = 3000; // 3 seconds

/**
 * Hook to resend failed blobs (announcements and messages) periodically when user is logged in
 * Attempts to resend failed blobs every 3 seconds
 */
export function useResendFailedBlobs() {
  const { userProfile, ourPk, ourSk, session } = useAccountStore();
  const isResending = useRef(false);

  /* Messages that need to be retrieved grouped by contact. Does not include messages from broken discussions */
  const [retryMessagesByContact, setRetryMessagesByContact] = useState<
    Map<string, RetryMessages[]>
  >(new Map());

  /* Discussions that are in BROKEN status */
  const [brokenDiscussions, setBrokenDiscussions] = useState<Discussion[]>([]);

  /* Discussions that are in SEND_FAILED status. The announcement has been created but could not be broadcastedon network */
  const [sendFailedDiscussions, setSendFailedDiscussions] = useState<
    Discussion[]
  >([]);

  // useRef used to avoid activating the setInterval useEffect at each render
  const resendFailedBlobsRef = useRef<(() => Promise<void>) | undefined>(
    undefined
  );

  const reinitiateBrokenDiscussions = useCallback(async () => {
    if (!userProfile?.userId) return;
    if (!brokenDiscussions.length) return;
    if (!session || !ourPk || !ourSk) {
      console.warn(
        'Cannot reinitiate discussions: WASM keys or session unavailable'
      );
      return;
    }

    for (const discussion of brokenDiscussions) {
      try {
        await renewDiscussion(
          userProfile.userId,
          discussion.contactUserId,
          session,
          ourPk,
          ourSk
        );
      } catch (error) {
        console.error(
          `Failed to reinitiate discussion with ${discussion.contactUserId}:`,
          error
        );
      }
    }
  }, [brokenDiscussions, ourPk, ourSk, session, userProfile?.userId]);

  const resendFailedAnnouncements = useCallback(async () => {
    if (!sendFailedDiscussions.length) return;
    try {
      await announcementService.resendAnnouncements(sendFailedDiscussions);
    } catch (error) {
      console.error('Failed to resend failed announcements:', error);
    }
  }, [sendFailedDiscussions]);

  const resendMessages = useCallback(async () => {
    if (!retryMessagesByContact.size) return;
    if (!session) {
      console.warn('Cannot resend messages: session not initialized');
      return;
    }
    try {
      await messageService.resendMessages(retryMessagesByContact, session);
    } catch (error) {
      console.error('Failed to resend failed messages:', error);
    }
  }, [retryMessagesByContact, session]);

  /* The retry process is executed at small intervals.
  So for performances reasons, we keep via Live query, retry messages and discussions up to date so that we don't need to 
  retrieve them from db at each interval*/
  useEffect(() => {
    if (!userProfile?.userId) {
      setRetryMessagesByContact(new Map());
      setBrokenDiscussions([]);
      setSendFailedDiscussions([]);
      return;
    }

    const subscriptions: Subscription[] = [];

    // Combined liveQuery for failed messages and broken discussions using a transaction
    const failedMessagesAndBrokenSub = liveQuery(async () => {
      return await db.transaction(
        'r',
        [db.messages, db.discussions],
        async () => {
          const [failedMessages, brokenDiscussions] = await Promise.all([
            db.messages
              .where('[ownerUserId+status]')
              .equals([userProfile.userId, MessageStatus.FAILED])
              .toArray(),
            db.discussions
              .where('[ownerUserId+status]')
              .equals([userProfile.userId, DiscussionStatus.BROKEN])
              .toArray(),
          ]);
          console.log('failedMessages', failedMessages);
          console.log('brokenDiscussions', brokenDiscussions);
          return { failedMessages, brokenDiscussions };
        }
      );
    }).subscribe({
      next: ({ failedMessages, brokenDiscussions }) => {
        // Update broken discussions state
        setBrokenDiscussions(brokenDiscussions);

        // Build set of broken discussion contact IDs for filtering
        const brokenDiscussionIds = new Set(
          brokenDiscussions.map(d => d.contactUserId)
        );

        // Build retry messages map, excluding messages from broken discussions
        const map = new Map<string, RetryMessages[]>();
        failedMessages.forEach(message => {
          if (!message.id) return;

          // Exclude messages from broken discussions
          if (brokenDiscussionIds.has(message.contactUserId)) return;

          const retryEntry: RetryMessages = {
            id: message.id,
            encryptedMessage: message.encryptedMessage,
            content: message.content,
            type: message.type,
          };
          const existing = map.get(message.contactUserId) || [];
          existing.push(retryEntry);
          map.set(message.contactUserId, existing);
        });
        setRetryMessagesByContact(map);
      },
      error: error => {
        console.error(
          'Failed to observe failed messages and broken discussions:',
          error
        );
      },
    });
    subscriptions.push(failedMessagesAndBrokenSub);

    // Separate liveQuery for send-failed discussions
    const sendFailedSub = liveQuery(() =>
      db.discussions
        .where('[ownerUserId+status]')
        .equals([userProfile.userId, DiscussionStatus.SEND_FAILED])
        .toArray()
    ).subscribe({
      next: discussions => setSendFailedDiscussions(discussions),
      error: error =>
        console.error('Failed to observe sendFailed discussions:', error),
    });
    subscriptions.push(sendFailedSub);

    return () => {
      subscriptions.forEach(sub => sub.unsubscribe());
    };
  }, [userProfile?.userId]);

  const resendFailedBlobs = useCallback(async (): Promise<void> => {
    if (isResending.current) return;
    isResending.current = true;
    await reinitiateBrokenDiscussions();
    await resendFailedAnnouncements();
    await resendMessages();
    isResending.current = false;
  }, [reinitiateBrokenDiscussions, resendFailedAnnouncements, resendMessages]);

  useEffect(() => {
    resendFailedBlobsRef.current = resendFailedBlobs;
  }, [resendFailedBlobs]);

  useEffect(() => {
    if (userProfile?.userId) {
      console.log('User logged in, starting periodic failed blob resend task');

      const resendInterval = setInterval(() => {
        resendFailedBlobsRef.current?.().catch(error => {
          console.error('Failed to resend blobs periodically:', error);
        });
      }, RESEND_INTERVAL_MS);

      // Cleanup interval when user logs out or component unmounts
      return () => {
        clearInterval(resendInterval);
        console.log('Periodic failed blob resend interval cleared');
      };
    }
    return undefined;
  }, [userProfile?.userId]);
}
