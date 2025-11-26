/**
 * Auth Service
 *
 * Handles storing and retrieving public keys by userId hash via the auth API.
 */

import { UserPublicKeys } from '../assets/generated/wasm/gossip_wasm';
import { decodeUserId } from '../utils/userId';
import { encodeToBase64, decodeFromBase64 } from '../utils/base64';
import { IMessageProtocol } from '../api/messageProtocol/types';
import { createMessageProtocol } from '../api/messageProtocol';
import { db } from '../db';

interface PublicKeyResult {
  success: boolean;
  publicKey?: UserPublicKeys;
  error?: string;
}

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

      if (!base64PublicKey) {
        return { success: false, error: 'Public key not found' };
      }

      return {
        success: true,
        publicKey: UserPublicKeys.from_bytes(decodeFromBase64(base64PublicKey)),
      };
    } catch (error) {
      return {
        success: false,
        error:
          error instanceof Error ? error.message : 'Failed to fetch public key',
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
  return Date.now() > date.getTime() + ONE_WEEK_IN_MILLIS;
}

export const authService = new AuthService(createMessageProtocol());
