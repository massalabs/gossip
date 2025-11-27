import { useCallback } from 'react';
import { useAccountStore } from '../stores/accountStore';
import { Discussion, db, DiscussionStatus } from '../db';
import { acceptDiscussionRequest } from '../services/discussion';

export const useDiscussionList = () => {
  const { userProfile, ourPk, ourSk, session } = useAccountStore();

  const handleAcceptDiscussionRequest = useCallback(
    async (discussion: Discussion, newName?: string) => {
      if (!session || !ourPk || !ourSk)
        throw new Error('Account store not initialized');
      try {
        if (discussion.id == null) return;
        // If the user provided a new contact name, update it first
        if (newName && userProfile?.userId) {
          try {
            await db.contacts
              .where('[ownerUserId+userId]')
              .equals([userProfile.userId, discussion.contactUserId])
              .modify({ name: newName });
          } catch (e) {
            console.error('Failed to update contact name:', e);
          }
        }
        await acceptDiscussionRequest(discussion, session, ourPk, ourSk);
      } catch (error) {
        console.error('Failed to accept discussion:', error);
      }
    },
    [userProfile?.userId, ourPk, ourSk, session]
  );

  const handleRefuseDiscussionRequest = useCallback(
    async (discussion: Discussion) => {
      try {
        if (discussion.id == null) return;
        await db.discussions.update(discussion.id, {
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
