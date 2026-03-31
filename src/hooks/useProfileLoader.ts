import { useEffect } from 'react';
import { useAccountStore } from '../stores/accountStore';
import { useAppStore } from '../stores/appStore';
import { getSdk } from '../stores/sdkStore';
import { useStorageMode } from './useStorageMode';

const PROFILE_LOAD_DELAY_MS = 100;

/**
 * Hook to load user profile from SQLite on app start
 */
export function useProfileLoader() {
  const { setLoading } = useAccountStore();
  const { dbReady, needsUnlock } = useStorageMode();

  useEffect(() => {
    const loadProfile = async () => {
      try {
        setLoading(true);

        // Once isInitialized is true (onboarding completed), never reset it to false.
        // Secure storage lock clears userProfile but onboarding is still done.
        const alreadyInitialized = useAppStore.getState().isInitialized;

        // Secure storage: DB isn't ready until allocate/unlock.
        if (!dbReady) {
          if (needsUnlock) {
            // Encrypted data on device → user must unlock → Login, not onboarding.
            useAppStore.getState().setIsInitialized(true);
          } else if (!alreadyInitialized) {
            // Empty storage AND never initialized → first open → onboarding.
            useAppStore.getState().setIsInitialized(false);
          }
          return;
        }

        // Add a small delay to ensure database is ready
        await new Promise(resolve =>
          setTimeout(resolve, PROFILE_LOAD_DELAY_MS)
        );

        const sdk = getSdk();
        const state = useAccountStore.getState();
        const existingProfile =
          state.userProfile || (await sdk.profiles.getMostRecent());

        if (existingProfile) {
          useAppStore.getState().setIsInitialized(true);
        } else if (!alreadyInitialized) {
          useAppStore.getState().setIsInitialized(false);
        }
      } catch (error) {
        console.error('Error loading user profile from SQLite:', error);
        if (!useAppStore.getState().isInitialized) {
          useAppStore.getState().setIsInitialized(false);
        }
      } finally {
        setLoading(false);
      }
    };
    loadProfile();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dbReady, needsUnlock]);
}
