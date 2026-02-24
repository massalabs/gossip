import { useCallback } from 'react';
import { useAccountStore } from '../stores/accountStore';
import { restMessageProtocol } from '@massalabs/gossip-sdk';
import { useGossipSdk } from './useGossipSdk';

/**
 * Hook to manually renew a discussion (e.g., from settings page).
 * Changes node and re-initiates the discussion.
 */
export function useManualRenewDiscussion() {
  const userProfile = useAccountStore(s => s.userProfile);
  const gossip = useGossipSdk();

  return useCallback(
    async (contactUserId: string): Promise<void> => {
      if (!userProfile?.userId || !gossip.isSessionOpen) {
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
        await gossip.discussions.renew(contactUserId);
      } catch (error) {
        console.error(
          `Failed to renew discussion with ${contactUserId}:`,
          error
        );
      }
    },
    [userProfile?.userId, gossip]
  );
}
