/**
 * SDK Utilities
 *
 * Helper functions for accessing stores and session
 */

import { useAccountStore } from '../../src/stores/accountStore';
import type { SessionModule } from '../../src/wasm';
import type {
  UserPublicKeys,
  UserSecretKeys,
} from '../../src/assets/generated/wasm/gossip_wasm';
import type { UserProfile } from '../../src/db';

/**
 * Get current session module from account store
 * @returns SessionModule or null if not loaded
 */
export function getSession(): SessionModule | null {
  const state = useAccountStore.getState();
  return state.session ?? null;
}

/**
 * Get current account state
 * @returns Account state object with userProfile, encryptionKey, ourPk, ourSk, session
 */
export function getAccount(): {
  userProfile: UserProfile | null;
  encryptionKey: Uint8Array | null;
  ourPk: UserPublicKeys | null;
  ourSk: UserSecretKeys | null;
  session: SessionModule | null;
} {
  const state = useAccountStore.getState();
  return {
    userProfile: state.userProfile,
    encryptionKey: state.encryptionKey,
    ourPk: state.ourPk ?? null,
    ourSk: state.ourSk ?? null,
    session: state.session,
  };
}

/**
 * Ensure account is loaded and initialized
 * @throws Error if account is not loaded
 */
export function ensureInitialized(): void {
  const state = useAccountStore.getState();
  if (!state.userProfile || !state.session || !state.ourPk || !state.ourSk) {
    throw new Error('Account not initialized. Please load an account first.');
  }
}

/**
 * Get current user ID
 * @returns User ID or null if not loaded
 */
export function getCurrentUserId(): string | null {
  const state = useAccountStore.getState();
  return state.userProfile?.userId ?? null;
}
