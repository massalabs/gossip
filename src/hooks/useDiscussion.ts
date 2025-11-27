import { useState, useCallback, useEffect } from 'react';
import { Contact, Discussion, DiscussionStatus } from '../db';
import { useDiscussionStore } from '../stores/discussionStore';

interface UseDiscussionProps {
  contact: Contact;
}

export const useDiscussion = ({ contact }: UseDiscussionProps) => {
  const [discussion, setDiscussion] = useState<Discussion | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const getDiscussionsForContact = useDiscussionStore(
    s => s.getDiscussionsForContact
  );

  const loadDiscussion = useCallback(async () => {
    if (!contact.userId) return;

    try {
      setIsLoading(true);
      const discussions = getDiscussionsForContact(contact.userId);

      // Get the most recent discussion (active or pending)
      const latestDiscussion = discussions
        .filter(
          d =>
            d.status === DiscussionStatus.ACTIVE ||
            d.status === DiscussionStatus.PENDING ||
            d.status === DiscussionStatus.SEND_FAILED
        )
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];

      setDiscussion(latestDiscussion || null);
    } catch (error) {
      console.error('Failed to load discussion:', error);
    } finally {
      setIsLoading(false);
    }
  }, [contact.userId, getDiscussionsForContact]);

  useEffect(() => {
    loadDiscussion();
  }, [loadDiscussion]);

  return {
    discussion,
    isLoading,
    loadDiscussion,
  };
};
