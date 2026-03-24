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

  const allDiscussions = useMemo<Discussion[]>(() => {
    if (!contact.userId) return [];
    return getDiscussionsForContact(contact.userId).sort(
      (a, b) => b.createdAt.getTime() - a.createdAt.getTime()
    );
  }, [contact.userId, getDiscussionsForContact]);

  const discussion = useMemo<Discussion | null>(() => {
    // Get the most recent discussion (active or pending)
    return (
      allDiscussions.find(d => {
        const status: SessionStatus =
          sessionsStatuses.get(d.contactUserId) ??
          sdk.discussions.getStatus(d.contactUserId);
        return [
          SessionStatus.Active,
          SessionStatus.SelfRequested,
          SessionStatus.PeerRequested,
        ].includes(status);
      }) ?? null
    );
  }, [allDiscussions, sessionsStatuses, sdk.discussions]);

  // The most recent discussion for this contact regardless of session status,
  // used for navigation (e.g. settings) even when the session is not yet active.
  const anyDiscussionId = allDiscussions[0]?.id ?? null;
  const anyDiscussionRetentionDuration =
    allDiscussions[0]?.messageRetentionDuration ?? null;

  return {
    discussion,
    anyDiscussionId,
    anyDiscussionRetentionDuration,
    isLoading: false,
  };
};
