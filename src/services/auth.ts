/**
 * Auth Service
 *
 * Handles storing and retrieving public keys by userId hash via the auth API.
 */

import { UserPublicKeys } from '../../gossip-sdk/src/assets/generated/wasm/gossip_wasm';
import { decodeUserId } from '../utils/userId';
import { encodeToBase64, decodeFromBase64 } from '../utils/base64';
import { IMessageProtocol } from '../api/messageProtocol/types';
import { restMessageProtocol } from '../api/messageProtocol';
import { db } from '../db';

export type PublicKeyResult =
  | { publicKey: UserPublicKeys; error?: never }
  | { publicKey?: never; error: string };

export class AuthService {
  constructor(public readonly messageProtocol: IMessageProtocol) {}

  /**
   * Fetch public key by userId
   * @param userId - Bech32-encoded userId (e.g., "gossip1...")
   */
  async fetchPublicKeyByUserId(userId: string): Promise<PublicKeyResult> {
    try {
      const base64PublicKey = await this.messageProtocol.fetchPublicKeyByUserId(
        decodeUserId(userId)
      );

      return {
        publicKey: UserPublicKeys.from_bytes(decodeFromBase64(base64PublicKey)),
      };
    } catch (err) {
      return {
        error: getPublicKeyErrorMessage(err),
      };
    }
  }

  /**
   * Ensure public key is published (check first, then publish if needed)
   * @param publicKeys - UserPublicKeys instance
   * @param userId - Bech32-encoded userId (e.g., "gossip1...")
   */
  async ensurePublicKeyPublished(
    publicKeys: UserPublicKeys,
    userId: string
  ): Promise<void> {
    const profile = await db.userProfile.get(userId);
    if (!profile) throw new Error('User profile not found');

    const lastPush = profile.lastPublicKeyPush;

    if (lastPush && !moreThanOneWeekAgo(lastPush)) {
      return;
    }

    await this.messageProtocol.postPublicKey(
      encodeToBase64(publicKeys.to_bytes())
    );

    await db.userProfile.update(userId, { lastPublicKeyPush: new Date() });
  }
}

const ONE_WEEK_IN_MILLIS = 7 * 24 * 60 * 60 * 1000;

function moreThanOneWeekAgo(date: Date): boolean {
  return Date.now() - date.getTime() >= ONE_WEEK_IN_MILLIS;
}

export const authService = new AuthService(restMessageProtocol);

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
