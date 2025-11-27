import { useState, useCallback, useEffect, useRef } from 'react';
import { Contact, Discussion, DiscussionStatus } from '../db';
import { useDiscussionStore } from '../stores/discussionStore';

interface UseDiscussionProps {
  contact: Contact;
}

export const useDiscussion = ({ contact }: UseDiscussionProps) => {
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
        .filter(
          d =>
            d.status === DiscussionStatus.ACTIVE ||
            d.status === DiscussionStatus.PENDING ||
            d.status === DiscussionStatus.SEND_FAILED
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
  }, [contact.userId, getDiscussionsForContact]);

  const initializeNewDiscussion = useCallback(async (): Promise<boolean> => {
    if (!contact.userId || isInitializing) return false;

    try {
      if (!isMountedRef.current) return false;
      setIsInitializing(true);

      console.log('Initializing new discussion with contact:', contact.userId);

      // Guard: we cannot initialize a discussion without the contact's public keys
      if (!contact.publicKeys || contact.publicKeys.length === 0) {
        throw new Error(
          'Contact is missing public keys. Cannot start a discussion yet.'
        );
      }

      // Initialize discussion using Contact object (matches current API)
      const result = await initializeDiscussion(contact);

      if (!isMountedRef.current) return false;

      // Reload discussions to get the new one
      await loadDiscussion();

      console.log('Discussion initialized:', result.discussionId);
      return true;
    } catch (error) {
      console.error('Failed to initialize discussion:', error);
      return false;
    } finally {
      if (isMountedRef.current) {
        setIsInitializing(false);
      }
    }
  }, [contact, isInitializing, loadDiscussion]);

  const ensureDiscussionExists = useCallback(async (): Promise<boolean> => {
    const result = await ensureDiscussionExistsUtil(contact, discussion);
    if (result && !discussion) {
      // Reload discussion if one was created
      await loadDiscussion();
    }
    return result;
  }, [contact, discussion, loadDiscussion]);

  useEffect(() => {
    loadDiscussion();
  }, [loadDiscussion]);

  return {
    discussion,
    isLoading,
    loadDiscussion,
  };
};
