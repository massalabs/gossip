import { useEffect } from 'react';
import { useAccountStore } from '../stores/accountStore';
import { defaultSyncConfig } from '../config/sync';
import { triggerManualSync } from '../services/messageSync';

/**
 * Hook to refresh app state periodically when user is logged in
 * Refreshes announcements, messages, discussions, and contacts
 */
export function useAppStateRefresh() {
  const { userProfile, ourPk, ourSk, session } = useAccountStore();

  useEffect(() => {
    if (userProfile?.userId && ourPk && ourSk && session) {
      triggerManualSync(ourPk, ourSk, session).catch(error => {
        console.error('Failed to sync messages on login:', error);
      });

      const refreshInterval = setInterval(() => {
        if (process.env.NODE_ENV === 'development') {
          console.log('Triggering periodic app state sync');
        }
        triggerManualSync(ourPk, ourSk, session).catch(error => {
          console.error('Failed to refresh app state periodically:', error);
        });
      }, defaultSyncConfig.activeSyncIntervalMs);

      // Cleanup interval when user logs out or component unmounts
      return () => {
        clearInterval(refreshInterval);
        console.log('Periodic app state refresh interval cleared');
      };
    }
  }, [userProfile?.userId, ourPk, ourSk, session]);
}
