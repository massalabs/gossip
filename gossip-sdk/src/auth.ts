/**
 * Authentication & Public Keys SDK
 *
 * Functions for fetching and publishing public keys
 */

import { authService } from '../../src/services/auth';
import type { UserPublicKeys } from '../../src/assets/generated/wasm/gossip_wasm';
import type { PublicKeyResult } from '../../src/services/auth';

/**
 * Fetch public key by userId
 * @param userId - Bech32-encoded userId (e.g., "gossip1...")
 * @returns Result with public key or error
 */
export async function fetchPublicKeyByUserId(
  userId: string
): Promise<PublicKeyResult> {
  return await authService.fetchPublicKeyByUserId(userId);
}

/**
 * Ensure public key is published (check first, then publish if needed)
 * @param publicKeys - UserPublicKeys instance
 * @param userId - Bech32-encoded userId (e.g., "gossip1...")
 * @returns Promise that resolves when published
 */
export async function ensurePublicKeyPublished(
  publicKeys: UserPublicKeys,
  userId: string
): Promise<void> {
  return await authService.ensurePublicKeyPublished(publicKeys, userId);
}
