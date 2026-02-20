import { useEffect } from 'react';
import { useAccountStore } from '../stores/accountStore';
import { useAppStore } from '../stores/appStore';
import { getMostRecentUserProfile } from '@massalabs/gossip-sdk';

const PROFILE_LOAD_DELAY_MS = 100;

/**
 * Hook to load user profile from SQLite on app start
 */
export function useProfileLoader() {
  const { setLoading } = useAccountStore();

  useEffect(() => {
    const loadProfile = async () => {
      try {
        setLoading(true);

        // Add a small delay to ensure database is ready
        await new Promise(resolve =>
          setTimeout(resolve, PROFILE_LOAD_DELAY_MS)
        );

        const state = useAccountStore.getState();
        const existingProfile =
          state.userProfile || (await getMostRecentUserProfile());

        if (existingProfile) {
          // Profile exists - let DiscussionList handle the welcome flow
          useAppStore.getState().setIsInitialized(true);
        } else {
          // No profile exists - show onboarding
          useAppStore.getState().setIsInitialized(false);
        }
      } catch (error) {
        console.error('Error loading user profile from SQLite:', error);
        // On error, assume no profile exists
        useAppStore.getState().setIsInitialized(false);
      } finally {
        setLoading(false);
      }
    };
    loadProfile();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
