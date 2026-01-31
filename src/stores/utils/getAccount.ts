import { db, UserProfile } from '@massalabs/gossip-sdk';
import { useAccountStore } from '../accountStore';

// Prefer the active profile in state; otherwise read the last logged in user from DB (by lastSeen)
export async function getActiveOrFirstProfile(): Promise<UserProfile | null> {
  const state = useAccountStore.getState();
  if (state.userProfile) return state.userProfile;

  // Use Dexie query to efficiently get the profile with the most recent lastSeen
  return (await db.userProfile.orderBy('lastSeen').reverse().first()) || null;
}
