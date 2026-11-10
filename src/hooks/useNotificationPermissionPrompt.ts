import { useEffect } from 'react';
import { Capacitor } from '@capacitor/core';
import { notificationService } from '../services/notifications';
import { useDiscussionStore } from '../stores/discussionStore';

/**
 * Ask for the native notification permission once the user has a first
 * conversation, instead of at app launch before they have done anything.
 *
 * The OS only shows its dialog while the permission is undecided, so this is
 * a no-op once the user has answered. Web never prompts here: browsers need
 * a user gesture, which Settings → Notifications provides.
 */
export function useNotificationPermissionPrompt(): void {
  const hasDiscussion = useDiscussionStore(s => s.discussions.length > 0);

  useEffect(() => {
    if (!hasDiscussion || !Capacitor.isNativePlatform()) return;
    void notificationService.requestPermission();
  }, [hasDiscussion]);
}
