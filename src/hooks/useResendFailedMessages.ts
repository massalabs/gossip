import { useEffect } from 'react';
import { useAccountStore } from '../stores/accountStore';
import { useMessageStore } from '../stores/messageStore';

const RESEND_INTERVAL_MS = 3000; // 3 seconds

/**
 * Hook to resend failed messages periodically when user is logged in
 * Attempts to resend failed messages every 3 seconds
 */
export function useResendFailedMessages() {
  const { userProfile } = useAccountStore();
  const resendMessages = useMessageStore(s => s.resendMessages);

  useEffect(() => {
    if (userProfile?.userId) {
      console.log(
        'User logged in, starting periodic failed message resend task'
      );

      const resendInterval = setInterval(() => {
        resendMessages().catch(error => {
          console.error('Failed to resend messages periodically:', error);
        });
      }, RESEND_INTERVAL_MS);

      // Cleanup interval when user logs out or component unmounts
      return () => {
        clearInterval(resendInterval);
        console.log('Periodic failed message resend interval cleared');
      };
    }
  }, [userProfile?.userId, resendMessages]);
}
