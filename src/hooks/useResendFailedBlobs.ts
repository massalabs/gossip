import { useEffect } from 'react';
import { useAccountStore } from '../stores/accountStore';
import { useMessageStore } from '../stores/messageStore';
import { useDiscussionStore } from '../stores/discussionStore';

const RESEND_INTERVAL_MS = 3000; // 3 seconds

/**
 * Hook to resend failed blobs (announcements and messages) periodically when user is logged in
 * Attempts to resend failed blobs every 3 seconds
 */
export function useResendFailedBlobs() {
  const { userProfile } = useAccountStore();
  const resendMessages = useMessageStore(s => s.resendMessages);
  const resendFailedDiscussions = useDiscussionStore(
    s => s.resendFailedDiscussions
  );
  const reInitiateDiscussion = useDiscussionStore(s => s.reInitiateDiscussion);

  useEffect(() => {
    const resendFailedBlobs = async (): Promise<void> => {
      // Execute operations sequentially - if one fails, others still run
      try {
        await reInitiateDiscussion(); // Reinitiate broken discussions
      } catch (error) {
        console.error('Failed to reinitiate broken discussions:', error);
      }

      try {
        await resendFailedDiscussions(); // Resend failed announcements
      } catch (error) {
        console.error('Failed to resend failed announcements:', error);
      }

      try {
        await resendMessages(); // Resend failed messages
      } catch (error) {
        console.error('Failed to resend failed messages:', error);
      }
    };

    if (userProfile?.userId) {
      console.log('User logged in, starting periodic failed blob resend task');

      const resendInterval = setInterval(() => {
        resendFailedBlobs().catch(error => {
          console.error('Failed to resend blobs periodically:', error);
        });
      }, RESEND_INTERVAL_MS);

      // Cleanup interval when user logs out or component unmounts
      return () => {
        clearInterval(resendInterval);
        console.log('Periodic failed blob resend interval cleared');
      };
    }
  }, [
    userProfile?.userId,
    reInitiateDiscussion,
    resendFailedDiscussions,
    resendMessages,
  ]);
}
