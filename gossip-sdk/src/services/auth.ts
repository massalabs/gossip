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
const PUBLIC_KEY_TIMESTAMP_RETRY_INTERVAL_MS = 60 * 1000;

export class AuthService {
  private publicationInFlight = new Map<string, Promise<number>>();
  private successfulPublicationTimes = new Map<string, number>();
  private pendingTimestampPersistence = new Map<string, number>();

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
  async publishPublicKey(
    publicKeys: UserPublicKeys,
    userId: string,
    queries: Queries
  ): Promise<void> {
    // Snapshot before the first await so logout can deterministically dispose
    // the live WASM wrapper without racing an in-flight publication. Preserve
    // the established Promise<void> API; only the scheduler consumes delay.
    await this.publishPublicKeyBytes(
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

  async persistPendingPublicationTimestamp(
    userId: string,
    queries: Queries
  ): Promise<boolean> {
    const pendingTimestamp = this.pendingTimestampPersistence.get(userId);
    if (pendingTimestamp === undefined) return false;

    const updated = await queries.userProfiles.updateLastPublicKeyPushMax(
      userId,
      new Date(pendingTimestamp)
    );
    if (
      updated &&
      this.pendingTimestampPersistence.get(userId) === pendingTimestamp
    ) {
      this.pendingTimestampPersistence.delete(userId);
    }
    return updated;
  }

  private async performPublicKeyPublication(
    publicKeyBytes: Uint8Array,
    userId: string,
    queries: Queries
  ): Promise<number> {
    const profile = await queries.userProfiles.getById(userId);
    const durablePublicationTime = profile?.lastPublicKeyPush?.getTime();
    const inMemoryPublicationTime = this.successfulPublicationTimes.get(userId);
    const lastPublicationTime = Math.max(
      durablePublicationTime ?? Number.NEGATIVE_INFINITY,
      inMemoryPublicationTime ?? Number.NEGATIVE_INFINITY
    );
    const now = Date.now();
    const elapsed = now - lastPublicationTime;

    if (elapsed < PUBLIC_KEY_REPUBLISH_INTERVAL_MS) {
      const pendingTimestamp = this.pendingTimestampPersistence.get(userId);
      if (pendingTimestamp !== undefined) {
        if (
          durablePublicationTime === undefined ||
          durablePublicationTime < pendingTimestamp
        ) {
          // Persist the actual confirmed POST time, not the later retry time.
          // This timestamp is local scheduling metadata and is never sent to
          // the auth server or Agraphon bulletin.
          const updated = await this.persistPendingPublicationTimestamp(
            userId,
            queries
          );
          if (!updated) return PUBLIC_KEY_TIMESTAMP_RETRY_INTERVAL_MS;
        } else if (
          this.pendingTimestampPersistence.get(userId) === pendingTimestamp
        ) {
          this.pendingTimestampPersistence.delete(userId);
        }
      }
      return PUBLIC_KEY_REPUBLISH_INTERVAL_MS - Math.max(0, elapsed);
    }

    await this.authProtocol.postPublicKey(encodeToBase64(publicKeyBytes));

    // Record confirmed server success before the fallible local timestamp
    // update. Timers and online events still invoke this method, but while the
    // marker is current they retry only persistence instead of POSTing again.
    const publishedAt = Date.now();
    this.successfulPublicationTimes.set(userId, publishedAt);
    this.pendingTimestampPersistence.set(userId, publishedAt);
    const updated = await this.persistPendingPublicationTimestamp(
      userId,
      queries
    );
    if (!updated) return PUBLIC_KEY_TIMESTAMP_RETRY_INTERVAL_MS;
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
