import { useCallback } from 'react';
import { useAccountStore } from '../stores/accountStore';
import { gossipSdk } from 'gossip-sdk';
import { Discussion, db as appDb, DiscussionStatus } from '../db';

export const useDiscussionList = () => {
  const userProfile = useAccountStore(s => s.userProfile);

  const handleAcceptDiscussionRequest = useCallback(
    async (discussion: Discussion, newName?: string) => {
      if (!gossipSdk.isSessionOpen) throw new Error('SDK session not open');
      try {
        if (discussion.id == null) return;
        // If the user provided a new contact name, update it first
        if (newName && userProfile?.userId) {
          try {
            await appDb.contacts
              .where('[ownerUserId+userId]')
              .equals([userProfile.userId, discussion.contactUserId])
              .modify({ name: newName });
          } catch (e) {
            console.error('Failed to update contact name:', e);
          }
        }
        await gossipSdk.discussions.accept(discussion);
      } catch (error) {
        console.error('Failed to accept discussion:', error);
      }
    },
    [userProfile?.userId]
  );

  const handleRefuseDiscussionRequest = useCallback(
    async (discussion: Discussion) => {
      try {
        if (discussion.id == null) return;
        await appDb.discussions.update(discussion.id, {
          status: DiscussionStatus.CLOSED,
          unreadCount: 0,
          updatedAt: new Date(),
        });
      } catch (error) {
        console.error('Failed to refuse discussion:', error);
      }
    },
    []
  );

  // Only return handlers that are actually used - state and selectors should be accessed directly from stores
  return {
    handleAcceptDiscussionRequest,
    handleRefuseDiscussionRequest,
  };
};
