import { logger } from '../utils/logger.ts';
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

        // Add a small delay to ensure database is ready
        await new Promise(resolve =>
          setTimeout(resolve, PROFILE_LOAD_DELAY_MS)
        );

        // Secure-storage: the SDK has no open session at boot, so any
        // profile query would throw "SDK not initialized". We decide
        // the initial route purely from `storageState`:
        //   - 'locked' → existing data, go to SecureLogin.
        //   - 'empty'  → fresh install, go to onboarding (create account).
        // Profile hydration happens later, after login/signup.
        const sdk = getSdk();
        if (sdk.isSecureStorage) {
          useAppStore
            .getState()
            .setIsInitialized(sdk.storageState === 'locked');
          return;
        }

        const state = useAccountStore.getState();
        const existingProfile =
          state.userProfile || (await getSdk().profiles.getMostRecent());

        if (existingProfile) {
          useAppStore.getState().setIsInitialized(true);
        } else {
          useAppStore.getState().setIsInitialized(false);
        }
      } catch (error) {
        logger.error('Error loading user profile from SQLite:', error);
        useAppStore.getState().setIsInitialized(false);
      } finally {
        setLoading(false);
      }
    };
    loadProfile();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
