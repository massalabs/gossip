import { useCallback } from 'react';
import { useAccountStore } from '../stores/accountStore';
import { restMessageProtocol } from '@massalabs/gossip-sdk';
import { getSdk } from '../stores/sdkStore';

/**
 * Hook to manually renew a discussion (e.g., from settings page).
 * Changes node and re-initiates the discussion.
 */
export function useManualRenewDiscussion() {
  const userProfile = useAccountStore(s => s.userProfile);

  return useCallback(
    async (contactUserId: string): Promise<void> => {
      if (!userProfile?.userId || !getSdk().isSessionOpen) {
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
        await getSdk().discussions.renew(contactUserId);
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
