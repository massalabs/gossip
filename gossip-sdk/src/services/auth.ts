/**
 * Auth Service
 *
 * Handles storing and retrieving public keys by userId hash via the auth API.
 */

import { UserPublicKeys } from '../wasm/bindings';
import { decodeUserId } from '../utils/userId';
import { encodeToBase64, decodeFromBase64 } from '../utils/base64';
import { IMessageProtocol } from '../api/messageProtocol/types';
import { getUserProfileField, updateUserProfileById } from '../queries';

export class AuthService {
  constructor(public messageProtocol: IMessageProtocol) {}

  /**
   * Fetch public key by userId
   * @param userId - Bech32-encoded userId (e.g., "gossip1...")
   */
  async fetchPublicKeyByUserId(userId: string): Promise<UserPublicKeys> {
    try {
      const base64PublicKey = await this.messageProtocol.fetchPublicKeyByUserId(
        decodeUserId(userId)
      );

      return UserPublicKeys.from_bytes(decodeFromBase64(base64PublicKey));
    } catch (err) {
      throw new Error(getPublicKeyErrorMessage(err));
    }
  }

  /**
   * Ensure public key is published (check first, then publish if needed).
   * If no user profile exists, the key is still published so the gossip ID is discoverable.
   * @param publicKeys - UserPublicKeys instance
   * @param userId - Bech32-encoded userId (e.g., "gossip1...")
   */
  async ensurePublicKeyPublished(
    publicKeys: UserPublicKeys,
    userId: string
  ): Promise<void> {
    const profile = await getUserProfileField(userId);

    if (profile) {
      const lastPush = profile.lastPublicKeyPush;
      if (lastPush && !moreThanOneWeekAgo(lastPush)) {
        return;
      }
    }

    await this.messageProtocol.postPublicKey(
      encodeToBase64(publicKeys.to_bytes())
    );

    if (profile) {
      await updateUserProfileById(userId, { lastPublicKeyPush: new Date() });
    }
  }
}

const ONE_WEEK_IN_MILLIS = 7 * 24 * 60 * 60 * 1000;

function moreThanOneWeekAgo(date: Date): boolean {
  return Date.now() - date.getTime() >= ONE_WEEK_IN_MILLIS;
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
