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

// const RESEND_INTERVAL_MS = 3000; // 3 seconds

/**
 * Hook to resend failed blobs (announcements and messages) when the user is logged in.
 * Optionally tracks failed blobs from the database and stores them in state.
 * @param trackFailedBlobs - If true, tracks failed blobs from the DB and stores them in state. Defaults to false.
 */
export function useResendFailedBlobs(trackFailedBlobs: boolean = false) {
  const { userProfile, ourPk, ourSk, session } = useAccountStore();
  const isResending = useRef(false);

  // State for tracking failed items (only populated if trackFailedBlobs is true)
  const [retryMessagesByContact, setRetryMessagesByContact] = useState<
    Map<string, Message[]>
  >(new Map());
  const [brokenDiscussions, setBrokenDiscussions] = useState<Discussion[]>([]);
  const [sendFailedDiscussions, setSendFailedDiscussions] = useState<
    Discussion[]
  >([]);

  // Ref to hold the resend function (avoids unnecessary re-renders in effects)
  const resendFailedBlobsRef = useRef<(() => Promise<void>) | undefined>(
    undefined
  );

  // Reinitiate broken discussions
  const reinitiateBrokenDiscussions = useCallback(async () => {
    if (
      !userProfile?.userId ||
      !brokenDiscussions.length ||
      !session ||
      !ourPk ||
      !ourSk
    ) {
      if (!session || !ourPk || !ourSk) {
        console.warn(
          'Cannot reinitiate discussions: WASM keys or session unavailable'
        );
      }
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

  // Resend failed announcements
  const resendFailedAnnouncements = useCallback(async () => {
    if (!sendFailedDiscussions.length || !session) {
      if (!session) {
        console.warn(
          'Cannot resend failed announcements: session not initialized'
        );
      }
      return;
    }

    try {
      await announcementService.resendAnnouncements(
        sendFailedDiscussions,
        session
      );
    } catch (error) {
      console.error('Failed to resend failed announcements:', error);
    }
  }, [sendFailedDiscussions, session]);

  // Resend failed messages
  const resendMessages = useCallback(async () => {
    if (!retryMessagesByContact.size || !session) {
      if (!session) {
        console.warn('Cannot resend messages: session not initialized');
      }
      return;
    }

    try {
      await messageService.resendMessages(retryMessagesByContact, session);
    } catch (error) {
      console.error('Failed to resend failed messages:', error);
    }
  }, [retryMessagesByContact, session]);

  // Manual renewal for a specific discussion (with node change)
  const manualRenewDiscussion = useCallback(
    async (contactUserId: string): Promise<void> => {
      if (!userProfile?.userId || !session || !ourPk || !ourSk) {
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
        await renewDiscussion(
          userProfile.userId,
          contactUserId,
          session,
          ourPk,
          ourSk
        );
      } catch (error) {
        console.error(
          `Failed to renew discussion with ${contactUserId}:`,
          error
        );
      }
    },
    [userProfile?.userId, session, ourPk, ourSk]
  );

  // Combined resend function (prevents concurrent resends)
  const resendFailedBlobs = useCallback(async (): Promise<void> => {
    if (isResending.current) return;
    isResending.current = true;

    await reinitiateBrokenDiscussions();
    await resendFailedAnnouncements();
    await resendMessages();

    isResending.current = false;
  }, [reinitiateBrokenDiscussions, resendFailedAnnouncements, resendMessages]);

  // Update ref with latest resend function
  useEffect(() => {
    resendFailedBlobsRef.current = resendFailedBlobs;
  }, [resendFailedBlobs]);

  // Set up live queries to track failed items (only if tracking is enabled)
  useEffect(() => {
    if (!userProfile?.userId || !trackFailedBlobs) {
      setRetryMessagesByContact(new Map());
      setBrokenDiscussions([]);
      setSendFailedDiscussions([]);
      return;
    }

    const subscriptions: Subscription[] = [];

    // Live query for failed messages and broken discussions (using transaction for efficiency)
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
          return { failedMessages, brokenDiscussions };
        }
      );
    }).subscribe({
      next: ({ failedMessages, brokenDiscussions }) => {
        setBrokenDiscussions(brokenDiscussions);

        const brokenDiscussionIds = new Set(
          brokenDiscussions.map(d => d.contactUserId)
        );
        const map = new Map<string, Message[]>();

        failedMessages.forEach(message => {
          if (!message.id || brokenDiscussionIds.has(message.contactUserId))
            return;

          const existing = map.get(message.contactUserId) || [];
          existing.push(message);
          map.set(message.contactUserId, existing);
        });

        setRetryMessagesByContact(map);
      },
      error: error =>
        console.error(
          'Failed to observe failed messages and broken discussions:',
          error
        ),
    });
    subscriptions.push(failedMessagesAndBrokenSub);

    // Live query for send-failed discussions
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

    return () => subscriptions.forEach(sub => sub.unsubscribe());
  }, [userProfile?.userId, trackFailedBlobs]);

  // Commented out periodic resend (uncomment and adjust if needed)
  // useEffect(() => {
  //   if (!trackFailedBlobs || !userProfile?.userId) return;
  //
  //   console.log('User logged in, starting periodic failed blob resend task');
  //   const resendInterval = setInterval(() => {
  //     resendFailedBlobsRef.current?.().catch(error => {
  //       console.error('Failed to resend blobs periodically:', error);
  //     });
  //   }, RESEND_INTERVAL_MS);
  //
  //   return () => {
  //     clearInterval(resendInterval);
  //     console.log('Periodic failed blob resend interval cleared');
  //   };
  // }, [userProfile?.userId, trackFailedBlobs]);

  // Return minimal set if not tracking, full set otherwise
  if (!trackFailedBlobs) {
    return { manualRenewDiscussion };
  }

  return {
    resendFailedBlobs: resendFailedBlobsRef.current,
    reinitiateBrokenDiscussions,
    resendFailedAnnouncements,
    resendMessages,
    manualRenewDiscussion,
  };
}
