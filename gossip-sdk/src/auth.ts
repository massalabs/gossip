/**
 * Authentication SDK
 *
 * Functions for authentication operations including public key management.
 *
 * @example
 * ```typescript
 * import { fetchPublicKeyByUserId } from 'gossip-sdk';
 *
 * const result = await fetchPublicKeyByUserId('gossip1...');
 * if (result.publicKey) {
 *   console.log('Found public key');
 * }
 * ```
 */

import { authService } from '@/services/auth';
import type { PublicKeyResult } from '@/services/auth';
import type { UserPublicKeys } from '@/assets/generated/wasm/gossip_wasm';

// Re-export the PublicKeyResult type for consumers
export type { PublicKeyResult };

/**
 * Fetch public key for a user by their userId.
 * The public key is retrieved from the server and can be used
 * to start a discussion with the user.
 *
 * @param userId - Bech32-encoded userId (e.g., "gossip1...")
 * @returns Result with either the public key or an error message
 *
 * @example
 * ```typescript
 * const result = await fetchPublicKeyByUserId('gossip1abc...');
 * if (result.publicKey) {
 *   // Use the public key to add a contact or start a discussion
 *   console.log('Public key found');
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
 * Ensure public key is published to the server.
 * This is called automatically when an account is loaded,
 * but can be called manually if needed.
 *
 * @param publicKeys - The user's public keys
 * @param userId - Bech32-encoded userId
 * @returns Promise that resolves when published
 *
 * @example
 * ```typescript
 * await ensurePublicKeyPublished(myPublicKeys, myUserId);
 * console.log('Public key published');
 * ```
 */
export async function ensurePublicKeyPublished(
  publicKeys: UserPublicKeys,
  userId: string
): Promise<void> {
  return await authService.ensurePublicKeyPublished(publicKeys, userId);
}
