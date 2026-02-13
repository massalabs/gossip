import {
  UserProfile,
  getMostRecentUserProfile,
  rowToUserProfile,
} from '@massalabs/gossip-sdk';
import { useAccountStore } from '../accountStore';

// Prefer the active profile in state; otherwise read the last logged in user from DB (by lastSeen)
export async function getActiveOrFirstProfile(): Promise<UserProfile | null> {
  const state = useAccountStore.getState();
  if (state.userProfile) return state.userProfile;

  const row = await getMostRecentUserProfile();
  if (!row) return null;

  return rowToUserProfile(row);
}
