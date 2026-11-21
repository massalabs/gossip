import { useEffect } from 'react';
import { Capacitor } from '@capacitor/core';
import { SELF_CONTACT_ID } from '@massalabs/gossip-sdk';
import { notificationService } from '../services/notifications';
import { useDiscussionStore } from '../stores/discussionStore';

/**
 * Ask for the native notification permission once the user has a first
 * conversation with someone, instead of at app launch before they have done anything.
 *
 * The OS only shows its dialog while the permission is undecided, so this is
 * a no-op once the user has answered. Web never prompts here: browsers need
 * a user gesture, which Settings → Notifications provides.
 */
export function useNotificationPermissionPrompt(): void {
  // "My Notes" exists from the first second and is not a conversation with
  // anyone, so it must not count.
  const hasDiscussion = useDiscussionStore(s =>
    s.discussions.some(
      discussion => discussion.contactUserId !== SELF_CONTACT_ID
    )
  );

  useEffect(() => {
    if (!hasDiscussion || !Capacitor.isNativePlatform()) return;
    void notificationService.requestPermission();
  }, [hasDiscussion]);
}
