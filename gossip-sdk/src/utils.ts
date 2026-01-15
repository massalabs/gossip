/**
 * SDK Utilities
 *
 * Helper functions for accessing stores, session, and common operations.
 *
 * @example
 * ```typescript
 * import { getSession, getCurrentUserId, ensureInitialized } from 'gossip-sdk';
 *
 * // Get current session
 * const session = getSession();
 *
 * // Get current user ID
 * const userId = getCurrentUserId();
 *
 * // Ensure account is loaded before operations
 * ensureInitialized();
 * ```
 */

import { useAccountStore } from '@/stores/accountStore';
import type { SessionModule, EncryptionKey } from './wasm';
import type {
  UserPublicKeys,
  UserSecretKeys,
} from '@/assets/generated/wasm/gossip_wasm';
import type { UserProfile } from './db';

/**
 * Get current session module from account store.
 * The session is required for most cryptographic operations.
 *
 * @returns SessionModule or null if not loaded
 *
 * @example
 * ```typescript
 * const session = getSession();
 * if (session) {
 *   // Can perform operations that require session
 * }
 * ```
 */
export function getSession(): SessionModule | null {
  const state = useAccountStore.getState();
  return state.session ?? null;
}

/**
 * Get current account state with all relevant fields.
 * Provides access to user profile, encryption key, and session.
 *
 * @returns Account state object
 *
 * @example
 * ```typescript
 * const account = getAccount();
 * if (account.session && account.userProfile) {
 *   console.log('Logged in as:', account.userProfile.username);
 * }
 * ```
 */
export function getAccount(): {
  userProfile: UserProfile | null;
  encryptionKey: EncryptionKey | null;
  session: SessionModule | null;
} {
  const state = useAccountStore.getState();
  return {
    userProfile: state.userProfile,
    encryptionKey: state.encryptionKey,
    session: state.session,
  };
}

/**
 * Get public and secret keys from current session.
 * Returns null values if session is not loaded.
 *
 * @returns Object with public and secret keys
 *
 * @example
 * ```typescript
 * const keys = getSessionKeys();
 * if (keys.ourPk && keys.ourSk) {
 *   // Use keys for cryptographic operations
 * }
 * ```
 */
export function getSessionKeys(): {
  ourPk: UserPublicKeys | null;
  ourSk: UserSecretKeys | null;
} {
  const state = useAccountStore.getState();
  const session = state.session;
  if (!session) {
    return { ourPk: null, ourSk: null };
  }
  return {
    ourPk: session.ourPk,
    ourSk: session.ourSk,
  };
}

/**
 * Ensure account is loaded and initialized.
 * Throws an error if account is not ready for operations.
 *
 * @throws Error if account is not loaded
 *
 * @example
 * ```typescript
 * try {
 *   ensureInitialized();
 *   // Safe to perform account operations
 * } catch (error) {
 *   console.error('Please login first');
 * }
 * ```
 */
export function ensureInitialized(): void {
  const state = useAccountStore.getState();
  if (!state.userProfile || !state.session) {
    throw new Error('Account not initialized. Please load an account first.');
  }
}

/**
 * Get current user ID.
 *
 * @returns User ID (Bech32-encoded) or null if not loaded
 *
 * @example
 * ```typescript
 * const userId = getCurrentUserId();
 * if (userId) {
 *   console.log('Current user:', userId);
 * }
 * ```
 */
export function getCurrentUserId(): string | null {
  const state = useAccountStore.getState();
  return state.userProfile?.userId ?? null;
}

/**
 * Check if an account is currently loaded.
 *
 * @returns True if account is loaded and session is available
 *
 * @example
 * ```typescript
 * if (isAccountLoaded()) {
 *   // User is logged in
 * } else {
 *   // Show login screen
 * }
 * ```
 */
export function isAccountLoaded(): boolean {
  const state = useAccountStore.getState();
  return !!(state.userProfile && state.session);
}

/**
 * Check if account store is in loading state.
 *
 * @returns True if account operations are in progress
 */
export function isAccountLoading(): boolean {
  const state = useAccountStore.getState();
  return state.isLoading;
}
