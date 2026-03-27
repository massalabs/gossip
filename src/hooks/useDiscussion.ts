import { useMemo } from 'react';
import { Contact, SessionStatus } from '@massalabs/gossip-sdk';
import type { Discussion } from '@massalabs/gossip-sdk';
import { useDiscussionStore } from '../stores/discussionStore';
import { useGossipSdk } from './useGossipSdk';

interface UseDiscussionProps {
  contact: Contact;
}

export const useDiscussion = ({ contact }: UseDiscussionProps) => {
  const sdk = useGossipSdk();
  const getDiscussionsForContact = useDiscussionStore(
    s => s.getDiscussionsForContact
  );
  const sessionsStatuses = useDiscussionStore(s => s.sessionsStatuses);

  const discussion = useMemo<Discussion | null>(() => {
    if (!contact.userId) return null;

    const discussions = getDiscussionsForContact(contact.userId);

    // Get the most recent discussion (active or pending)
    return (
      discussions
        .filter(d => {
          const status: SessionStatus =
            sessionsStatuses.get(d.contactUserId) ??
            sdk.discussions.getStatus(d.contactUserId);
          return [
            SessionStatus.Active,
            SessionStatus.SelfRequested,
            SessionStatus.PeerRequested,
          ].includes(status);
        })
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0] ??
      null
    );
  }, [
    contact.userId,
    getDiscussionsForContact,
    sessionsStatuses,
    sdk.discussions,
  ]);

  return {
    discussion,
    isLoading: false,
  };
};
