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

        // Secure-storage: if the backend is still locked at boot,
        // queries will throw. Skip the profile lookup in that case —
        // the presence of `needsUnlock=true` already tells us there is
        // existing data, so route the user to SecureLogin by flipping
        // `isInitialized=true`. The actual profile hydration happens
        // in accountStore.loadAccount once the user enters their
        // password.
        const sdk = getSdk();
        if (sdk.isSecureStorage && sdk.needsUnlock) {
          useAppStore.getState().setIsInitialized(true);
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
