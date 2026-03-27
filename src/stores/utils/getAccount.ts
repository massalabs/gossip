import type { UserProfile } from '@massalabs/gossip-sdk';
import { useAccountStore } from '../accountStore';
import { getSdk } from '../sdkStore';

// Prefer the active profile in state; otherwise read the last logged in user from DB (by lastSeen)
export async function getActiveOrFirstProfile(): Promise<UserProfile | null> {
  const state = useAccountStore.getState();
  if (state.userProfile) return state.userProfile;

  const sdk = getSdk();
  // DB not ready yet (secure storage locked) — can't query.
  if (!sdk.dbReady) return null;

  return sdk.profiles.getMostRecent();
}
