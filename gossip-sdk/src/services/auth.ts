/**
 * Auth Service
 *
 * Handles storing and retrieving public keys by userId hash via the auth API.
 */

import { UserPublicKeys } from '../wasm/bindings.js';
import { decodeUserId } from '../utils/userId.js';
import { encodeToBase64, decodeFromBase64 } from '../utils/base64.js';
import { IAuthProtocol } from '../api/authProtocol.js';
import type { Queries } from '../db/queries/index.js';

export const PUBLIC_KEY_REPUBLISH_INTERVAL_MS = 24 * 60 * 60 * 1000;

export class AuthService {
  private publicationInFlight = new Map<string, Promise<number>>();

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
   * Publish public key to the server if not published in the last 24 hours.
   * @param publicKeys - UserPublicKeys instance
   * @param userId - Bech32-encoded userId
   * @param queries - Database queries
   */
  publishPublicKey(
    publicKeys: UserPublicKeys,
    userId: string,
    queries: Queries
  ): Promise<number> {
    // Snapshot before the first await so logout can deterministically dispose
    // the live WASM wrapper without racing an in-flight publication.
    return this.publishPublicKeyBytes(
      new Uint8Array(publicKeys.to_bytes()),
      userId,
      queries
    );
  }

  publishPublicKeyBytes(
    publicKeyBytes: Uint8Array,
    userId: string,
    queries: Queries
  ): Promise<number> {
    const existing = this.publicationInFlight.get(userId);
    if (existing) return existing;

    const publication = this.performPublicKeyPublication(
      publicKeyBytes,
      userId,
      queries
    ).finally(() => {
      if (this.publicationInFlight.get(userId) === publication) {
        this.publicationInFlight.delete(userId);
      }
    });
    this.publicationInFlight.set(userId, publication);
    return publication;
  }

  private async performPublicKeyPublication(
    publicKeyBytes: Uint8Array,
    userId: string,
    queries: Queries
  ): Promise<number> {
    const profile = await queries.userProfiles.getById(userId);
    if (profile?.lastPublicKeyPush) {
      const elapsed = Date.now() - profile.lastPublicKeyPush.getTime();
      if (elapsed < PUBLIC_KEY_REPUBLISH_INTERVAL_MS) {
        return PUBLIC_KEY_REPUBLISH_INTERVAL_MS - elapsed;
      }
    }

    await this.authProtocol.postPublicKey(encodeToBase64(publicKeyBytes));

    await queries.userProfiles.updateById(userId, {
      lastPublicKeyPush: new Date(),
    });
    return PUBLIC_KEY_REPUBLISH_INTERVAL_MS;
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
