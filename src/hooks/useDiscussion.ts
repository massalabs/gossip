import { useState, useCallback, useEffect, useRef } from 'react';
import { Contact, SessionStatus } from '@massalabs/gossip-sdk';
import type { Discussion } from '@massalabs/gossip-sdk';
import { useDiscussionStore } from '../stores/discussionStore';
import { useGossipSdk } from './useGossipSdk';

interface UseDiscussionProps {
  contact: Contact;
}

export const useDiscussion = ({ contact }: UseDiscussionProps) => {
  const gossip = useGossipSdk();
  const [discussion, setDiscussion] = useState<Discussion | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const isMountedRef = useRef(true);

  useEffect(() => {
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const getDiscussionsForContact = useDiscussionStore(
    s => s.getDiscussionsForContact
  );

  const loadDiscussion = useCallback(async () => {
    if (!contact.userId || !isMountedRef.current) return;

    try {
      setIsLoading(true);
      const discussions = getDiscussionsForContact(contact.userId);

      // Get the most recent discussion (active or pending)
      const latestDiscussion = discussions
        .filter(d =>
          [
            SessionStatus.Active,
            SessionStatus.SelfRequested,
            SessionStatus.PeerRequested,
          ].includes(gossip.discussions.getStatus(d.contactUserId))
        )
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];

      if (latestDiscussion) {
        setDiscussion(latestDiscussion);
      }
    } catch (error) {
      console.error('Failed to load discussion:', error);
    } finally {
      setIsLoading(false);
    }
  }, [contact.userId, getDiscussionsForContact, gossip]);

  useEffect(() => {
    loadDiscussion();
  }, [loadDiscussion]);

  return {
    discussion,
    isLoading,
    loadDiscussion,
  };
};
