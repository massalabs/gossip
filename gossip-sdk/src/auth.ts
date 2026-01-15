/**
 * Authentication SDK
 *
 * Functions for authentication and public key management.
 *
 * @example
 * ```typescript
 * import { fetchPublicKeyByUserId, ensurePublicKeyPublished } from 'gossip-sdk';
 *
 * // Fetch a contact's public key
 * const result = await fetchPublicKeyByUserId('gossip1abc...');
 * if (result.publicKey) {
 *   console.log('Got public key');
 * }
 *
 * // Ensure our public key is published
 * await ensurePublicKeyPublished(ourPublicKeys, ourUserId);
 * ```
 */

import {
  authService,
  PublicKeyResult,
  PUBLIC_KEY_NOT_FOUND_ERROR,
  PUBLIC_KEY_NOT_FOUND_MESSAGE,
  FAILED_TO_FETCH_ERROR,
  FAILED_TO_FETCH_MESSAGE,
  FAILED_TO_RETRIEVE_CONTACT_PUBLIC_KEY_ERROR,
  getPublicKeyErrorMessage,
} from './services/auth';
import type { UserPublicKeys } from '@/assets/generated/wasm/gossip_wasm';

// Re-export types and constants
export type { PublicKeyResult };
export {
  PUBLIC_KEY_NOT_FOUND_ERROR,
  PUBLIC_KEY_NOT_FOUND_MESSAGE,
  FAILED_TO_FETCH_ERROR,
  FAILED_TO_FETCH_MESSAGE,
  FAILED_TO_RETRIEVE_CONTACT_PUBLIC_KEY_ERROR,
  getPublicKeyErrorMessage,
  authService,
};

/**
 * Fetch public key by userId from the auth API.
 *
 * @param userId - Bech32-encoded userId (e.g., "gossip1...")
 * @returns Result with publicKey or error message
 *
 * @example
 * ```typescript
 * const result = await fetchPublicKeyByUserId('gossip1abc...');
 * if (result.publicKey) {
 *   // Use the public key
 * } else {
 *   console.error('Error:', result.error);
 * }
 * ```
 */
export async function fetchPublicKeyByUserId(
  userId: string
): Promise<PublicKeyResult> {
  return await authService.fetchPublicKeyByUserId(userId);
}

/**
 * Ensure public key is published to the auth API.
 * Only publishes if not published in the last week.
 *
 * @param publicKeys - UserPublicKeys instance
 * @param userId - Bech32-encoded userId (e.g., "gossip1...")
 *
 * @example
 * ```typescript
 * await ensurePublicKeyPublished(session.ourPk, session.userIdEncoded);
 * ```
 */
export async function ensurePublicKeyPublished(
  publicKeys: UserPublicKeys,
  userId: string
): Promise<void> {
  return await authService.ensurePublicKeyPublished(publicKeys, userId);
}
