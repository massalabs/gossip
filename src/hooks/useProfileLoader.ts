import { logger } from '../utils/logger.ts';
import { useEffect } from 'react';
import { useAccountStore } from '../stores/accountStore';
import { useAppStore } from '../stores/appStore';
import { getSdk } from '../stores/sdkStore';

const PROFILE_LOAD_DELAY_MS = 100;

export function shouldInitializeSecureStorage(
  storageState: 'empty' | 'locked' | 'unlocked' | null,
  accountCreationAllowed: boolean
): boolean {
  return storageState === 'locked' && !accountCreationAllowed;
}

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

        // Secure-storage provisioning writes dummy slots even before an
        // account exists, so a later boot reports `locked` for both a real
        // account and a first-install flow that was cancelled or completely
        // rolled back. Preserve a dedicated first-install creation grant to
        // keep that dummy-only state reachable as onboarding. The grant starts
        // only from the backend's authoritative `empty` state and is revoked
        // after a complete account batch, so clearing unrelated app state can
        // never authorize overwriting unknown hidden slots.
        // Profile hydration still happens later, after login/signup.
        const sdk = getSdk();
        if (sdk.isSecureStorage) {
          const appState = useAppStore.getState();
          if (sdk.storageState === 'empty') {
            appState.setSecureAccountCreationAllowed(true);
          }
          appState.setIsInitialized(
            shouldInitializeSecureStorage(
              sdk.storageState,
              sdk.storageState === 'empty' ||
                appState.secureAccountCreationAllowed
            )
          );
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
