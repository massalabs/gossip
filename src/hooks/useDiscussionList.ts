import { useCallback } from 'react';
import { useAccountStore } from '../stores/accountStore';
import { useGossipSdk } from './useGossipSdk';
import type { Discussion } from '@massalabs/gossip-sdk';
export const useDiscussionList = () => {
  const gossip = useGossipSdk();
  const userProfile = useAccountStore(s => s.userProfile);

  const handleAcceptDiscussionRequest = useCallback(
    async (discussion: Discussion, newName?: string) => {
      try {
        if (discussion.id == null) return;
        // If the user provided a new contact name, update it first
        if (newName && userProfile?.userId) {
          try {
            await gossip.contacts.updateName(
              userProfile.userId,
              discussion.contactUserId,
              newName
            );
          } catch (e) {
            console.error('Failed to update contact name:', e);
          }
        }
        await gossip.discussions.accept(discussion);
      } catch (error) {
        console.error('Failed to accept discussion:', error);
      }
    },
    [userProfile?.userId, gossip]
  );

  const handleRefuseDiscussionRequest = useCallback(
    async (discussion: Discussion) => {
      try {
        if (userProfile?.userId == null) return;
        await gossip.contacts.delete(
          userProfile.userId,
          discussion.contactUserId
        );
      } catch (error) {
        console.error('Failed to refuse discussion:', error);
      }
    },
    [userProfile?.userId, gossip.contacts]
  );

  // Only return handlers that are actually used - state and selectors should be accessed directly from stores
  return {
    handleAcceptDiscussionRequest,
    handleRefuseDiscussionRequest,
  };
};
