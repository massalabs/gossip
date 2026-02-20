/**
 * Auth Service
 *
 * Handles storing and retrieving public keys by userId hash via the auth API.
 */

import { UserPublicKeys } from '../wasm/bindings';
import { decodeUserId } from '../utils/userId';
import { encodeToBase64, decodeFromBase64 } from '../utils/base64';
import { IAuthProtocol } from '../api/authProtocol';

export class AuthService {
  constructor(public authProtocol: IAuthProtocol) {}

  /**
   * Fetch public key by userId
   * @param userId - Bech32-encoded userId (e.g., "gossip1...")
   */
  async fetchPublicKeyByUserId(userId: string): Promise<UserPublicKeys> {
    try {
      const base64PublicKey = await this.authProtocol.fetchPublicKeyByUserId(
        decodeUserId(userId)
      );

      return UserPublicKeys.from_bytes(decodeFromBase64(base64PublicKey));
    } catch (err) {
      throw new Error(getPublicKeyErrorMessage(err));
    }
  }

  /**
   * Ensure public key is published. Checks the server first, only publishes if not found.
   * @param publicKeys - UserPublicKeys instance
   * @param userId - Bech32-encoded userId (e.g., "gossip1...")
   */
  async ensurePublicKeyPublished(
    publicKeys: UserPublicKeys,
    userId: string
  ): Promise<void> {
    // Check if our key is already on the server
    try {
      await this.authProtocol.fetchPublicKeyByUserId(decodeUserId(userId));
      return; // Key exists on server, nothing to do
    } catch {
      // Key not found on server — publish it
    }

    await this.authProtocol.postPublicKey(
      encodeToBase64(publicKeys.to_bytes())
    );
  }
}

export const PUBLIC_KEY_NOT_FOUND_ERROR = 'Public key not found';
export const PUBLIC_KEY_NOT_FOUND_MESSAGE =
  'Contact public key not found. It may not be published yet.';
export const FAILED_TO_FETCH_ERROR = 'Failed to fetch';
export const FAILED_TO_FETCH_MESSAGE =
  'Failed to retrieve contact public key. Check your internet connection or try again later.';
export const FAILED_TO_RETRIEVE_CONTACT_PUBLIC_KEY_ERROR =
  'Failed to retrieve contact public key';

export function getPublicKeyErrorMessage(error: unknown): string {
  const errorMessage = error instanceof Error ? error.message : String(error);
  if (errorMessage.includes(PUBLIC_KEY_NOT_FOUND_ERROR)) {
    return PUBLIC_KEY_NOT_FOUND_MESSAGE;
  }

  if (errorMessage.includes(FAILED_TO_FETCH_ERROR)) {
    return FAILED_TO_FETCH_MESSAGE;
  }

  return `${FAILED_TO_RETRIEVE_CONTACT_PUBLIC_KEY_ERROR}. ${errorMessage}`;
}
