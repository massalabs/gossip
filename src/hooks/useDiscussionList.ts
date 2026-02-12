import { useCallback } from 'react';
import { useAccountStore } from '../stores/accountStore';
import { useGossipSdk } from './useGossipSdk';
import type { Discussion } from '../db';
export const useDiscussionList = () => {
  const sdk = useGossipSdk();
  const userProfile = useAccountStore(s => s.userProfile);

  const handleAcceptDiscussionRequest = useCallback(
    async (discussion: Discussion, newName?: string) => {
      if (!userProfile?.userId) throw new Error('SDK session not open');
      try {
        if (discussion.id == null) return;
        // If the user provided a new contact name, update it first
        if (newName && userProfile?.userId) {
          try {
            await sdk.contacts.updateName(
              userProfile.userId,
              discussion.contactUserId,
              newName
            );
          } catch (e) {
            console.error('Failed to update contact name:', e);
          }
        }
        await sdk.discussions.accept(
          discussion as unknown as Parameters<typeof sdk.discussions.accept>[0]
        );
      } catch (error) {
        console.error('Failed to accept discussion:', error);
      }
    },
    [userProfile?.userId, sdk.discussions]
  );

  const handleRefuseDiscussionRequest = useCallback(
    async (discussion: Discussion) => {
      try {
        if (userProfile?.userId == null) return;
        await sdk.contacts.delete(
          userProfile.userId,
          discussion.contactUserId
        );
      } catch (error) {
        console.error('Failed to refuse discussion:', error);
      }
    },
    [userProfile?.userId, sdk.contacts]
  );

  // Only return handlers that are actually used - state and selectors should be accessed directly from stores
  return {
    handleAcceptDiscussionRequest,
    handleRefuseDiscussionRequest,
  };
};
