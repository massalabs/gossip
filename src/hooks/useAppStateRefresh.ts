import { useCallback, useEffect } from 'react';
import { useAccountStore } from '../stores/accountStore';
import { defaultSyncConfig } from '../config/sync';
import { triggerManualSync } from '../services/messageSync';
import { useMessageStore } from '../stores/messageStore.tsx';
import { useDiscussionStore } from '../stores/discussionStore.tsx';

/**
 * Hook to refresh app state periodically when user is logged in
 * Refreshes announcements, messages, discussions, and contacts
 */
export function useAppStateRefresh() {
  const { userProfile, ourPk, ourSk, session } = useAccountStore();

  const initApp = useCallback(async () => {
    useMessageStore.getState().init();
    await useDiscussionStore.getState().init();
    triggerManualSync(ourPk, ourSk, session).catch(error => {
      console.error('Failed to sync messages on login:', error);
    });
  }, [ourPk, ourSk, session]);

  useEffect(() => {
    if (userProfile?.userId && ourPk && ourSk && session) {
      initApp();
      const refreshInterval = setInterval(() => {
        triggerManualSync(ourPk, ourSk, session).catch(error => {
          console.error('Failed to refresh app state periodically:', error);
        });
      }, defaultSyncConfig.activeSyncIntervalMs);

      // Cleanup interval when user logs out or component unmounts
      return () => {
        clearInterval(refreshInterval);
      };
    }
  }, [userProfile?.userId, ourPk, ourSk, session, initApp]);
}
