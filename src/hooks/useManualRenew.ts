import { logger } from '../utils/logger.ts';
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
        logger.warn('Cannot renew discussion: Services or session unavailable');
        return;
      }

      try {
        await restMessageProtocol.changeNode();
      } catch (error) {
        logger.error('Failed to change node:', error);
      }

      try {
        await gossip.discussions.renew(contactUserId);
      } catch (error) {
        logger.error(
          `Failed to renew discussion with ${contactUserId}:`,
          error
        );
      }
    },
    [userProfile?.userId, gossip]
  );
}
