import { useState, useCallback, useEffect, useRef } from 'react';
import { Contact, Discussion } from '../db';
import {
  initializeDiscussion,
  getDiscussionsForContact,
  ensureDiscussionExists as ensureDiscussionExistsUtil,
} from '../crypto/discussionInit';

interface UseDiscussionProps {
  contact: Contact;
}

export const useDiscussion = ({ contact }: UseDiscussionProps) => {
  const [discussion, setDiscussion] = useState<Discussion | null>(null);
  const [isInitializing, setIsInitializing] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const isMountedRef = useRef(true);

  useEffect(() => {
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const loadDiscussion = useCallback(async () => {
    if (!contact.userId) return;

    try {
      if (!isMountedRef.current) return;
      setIsLoading(true);

      const discussions = await getDiscussionsForContact(
        contact.ownerUserId,
        contact.userId
      );

      if (!isMountedRef.current) return;

      // Get the most recent discussion (active or pending)
      const latestDiscussion = discussions
        .filter(d => d.status === 'active' || d.status === 'pending')
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];

      setDiscussion(latestDiscussion || null);
    } catch (error) {
      console.error('Failed to load discussion:', error);
    } finally {
      if (isMountedRef.current) {
        setIsLoading(false);
      }
    }
  }, [contact.ownerUserId, contact.userId]);

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
    isInitializing,
    isLoading,
    loadDiscussion,
    initializeNewDiscussion,
    ensureDiscussionExists,
  };
};
