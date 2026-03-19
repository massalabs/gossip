import { useCallback } from 'react';
import { useAccountStore } from '../stores/accountStore';
import { useDiscussionStore } from '../stores/discussionStore';
import { useGossipSdk } from './useGossipSdk';
import type { Discussion } from '@massalabs/gossip-sdk';
import { SessionStatus } from '@massalabs/gossip-sdk';
import toast from 'react-hot-toast';
export const useDiscussionList = () => {
  const gossip = useGossipSdk();
  const userProfile = useAccountStore(s => s.userProfile);

  const handleAcceptDiscussionRequest = useCallback(
    (discussion: Discussion, newName?: string) => {
      if (discussion.id == null) return;

      // Optimistic: show as active immediately
      useDiscussionStore
        .getState()
        .optimisticAcceptDiscussion(discussion.contactUserId);

      // SDK calls in background
      (async () => {
        try {
          if (newName && userProfile?.userId) {
            await gossip.contacts.updateName(discussion.contactUserId, newName);
          }
          await gossip.discussions.accept(discussion);
        } catch (error) {
          console.error('Failed to accept discussion:', error);
          toast.error('Failed to accept discussion. Please try again.');
          // Revert optimistic Active back to PeerRequested
          const store = useDiscussionStore.getState();
          const nextStatuses = new Map(store.sessionsStatuses);
          nextStatuses.set(
            discussion.contactUserId,
            SessionStatus.PeerRequested
          );
          useDiscussionStore.setState({ sessionsStatuses: nextStatuses });
        }
      })();
    },
    [userProfile?.userId, gossip]
  );

  const handleRefuseDiscussionRequest = useCallback(
    async (discussion: Discussion) => {
      try {
        if (userProfile?.userId == null) return;
        await gossip.contacts.delete(discussion.contactUserId);
      } catch (error) {
        console.error('Failed to refuse discussion:', error);
      }
    },
    [userProfile?.userId, gossip]
  );

  // Only return handlers that are actually used - state and selectors should be accessed directly from stores
  return {
    handleAcceptDiscussionRequest,
    handleRefuseDiscussionRequest,
  };
};
