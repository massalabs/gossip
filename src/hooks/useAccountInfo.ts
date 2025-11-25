import { useEffect, useState } from 'react';
import { useAccountStore } from '../stores/accountStore';
import { useAppStore } from '../stores/appStore';
import { UserProfile } from '../db';

/**
 * Hook to load existing account info to show username in WelcomeBack when unauthenticated
 */
export function useAccountInfo() {
  const { userProfile } = useAccountStore();
  const { isInitialized } = useAppStore();
  const [existingAccountInfo, setExistingAccountInfo] =
    useState<UserProfile | null>(null);

  useEffect(() => {
    (async () => {
      try {
        if (isInitialized && !userProfile) {
          const info = await useAccountStore
            .getState()
            .getExistingAccountInfo();
          setExistingAccountInfo(info);
        } else if (userProfile) {
          // Clear stale data when user is authenticated
          setExistingAccountInfo(null);
        }
      } catch (_e) {
        setExistingAccountInfo(null);
      }
    })();
  }, [isInitialized, userProfile]);

  return existingAccountInfo;
}
