import { useCallback } from 'react';
import { useAccountStore } from '../stores/accountStore';
import { restMessageProtocol, gossipSdk } from 'gossip-sdk';

/**
 * Hook to manually renew a discussion (e.g., from settings page).
 * Changes node and re-initiates the discussion.
 */
export function useManualRenewDiscussion() {
  const userProfile = useAccountStore(s => s.userProfile);

  return useCallback(
    async (contactUserId: string): Promise<void> => {
      if (!userProfile?.userId || !gossipSdk.isSessionOpen) {
        console.warn(
          'Cannot renew discussion: Services or session unavailable'
        );
        return;
      }

      try {
        await restMessageProtocol.changeNode();
      } catch (error) {
        console.error('Failed to change node:', error);
      }

      try {
        await gossipSdk.discussions.renew(contactUserId);
      } catch (error) {
        console.error(
          `Failed to renew discussion with ${contactUserId}:`,
          error
        );
      }
    },
    [userProfile?.userId]
  );
}
