import type { UserProfile } from '@massalabs/gossip-sdk';
import { useAccountStore } from '../accountStore';
import { getSdk } from '../sdkStore';

// Prefer the active profile in state; otherwise read the last logged in user from DB (by lastSeen)
export async function getActiveOrFirstProfile(): Promise<UserProfile | null> {
  const state = useAccountStore.getState();
  if (state.userProfile) return state.userProfile;

  return getSdk().profiles.getMostRecent();
}
