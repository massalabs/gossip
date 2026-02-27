import { useEffect } from 'react';
import { useAccountStore } from '../stores/accountStore';
import { useAppStore } from '../stores/appStore';
import { getSdk } from '../stores/sdkStore';

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

        const sdk = getSdk();

        // Bordercrypt: DB isn't ready until allocate/unlock.
        // Leave isInitialized as-is from localStorage:
        //   - First use: false → Onboarding
        //   - Returning user: true (persisted) → Login
        if (!sdk.dbReady) {
          return;
        }

        // Add a small delay to ensure database is ready
        await new Promise(resolve =>
          setTimeout(resolve, PROFILE_LOAD_DELAY_MS)
        );

        const state = useAccountStore.getState();
        const existingProfile =
          state.userProfile || (await sdk.profiles.getMostRecent());

        if (existingProfile) {
          useAppStore.getState().setIsInitialized(true);
        } else {
          useAppStore.getState().setIsInitialized(false);
        }
      } catch (error) {
        console.error('Error loading user profile from SQLite:', error);
        useAppStore.getState().setIsInitialized(false);
      } finally {
        setLoading(false);
      }
    };
    loadProfile();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
