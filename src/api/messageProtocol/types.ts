/**
 * Message Protocol Types and Interfaces
 */

export interface EncryptedMessage {
  seeker: Uint8Array;
  ciphertext: Uint8Array;
}

export interface MessageProtocolResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
}

/**
 * A bulletin item with its counter value
 */
export interface BulletinItem {
  counter: string; // String to support U256 bigint values
  data: Uint8Array;
}

/**
 * Response for paginated bulletin fetching
 */
export interface PaginatedAnnouncementsResponse {
  items: BulletinItem[];
  nextCursor: string | null;
  hasMore: boolean;
}

/**
 * Abstract interface for message protocol operations
 */
export interface IMessageProtocol {
  /**
   * Fetch encrypted messages for the provided set of seeker read keys
   */
  fetchMessages(seekers: Uint8Array[]): Promise<EncryptedMessage[]>;

  /**
   * Send an encrypted message to the key-value store
   */
  sendMessage(message: EncryptedMessage): Promise<void>;

  /**
   * Broadcast an outgoing session announcement produced by WASM.
   * Returns the bulletin counter provided by the API.
   */
  sendAnnouncement(announcement: Uint8Array): Promise<string>;

  /**
   * Fetch incoming discussion announcements from the bulletin storage.
   * Returns raw announcement bytes as provided by the API.
   * @deprecated Use fetchAnnouncementsFromCursor for paginated fetching
   */
  fetchAnnouncements(): Promise<Uint8Array[]>;

  /**
   * Fetch announcements starting from a specific cursor (counter).
   * Uses cursor-based pagination for efficient incremental fetching.
   * @param cursor - The bulletin counter to start fetching from (exclusive). Pass "1" or undefined for first fetch.
   * @param limit - Maximum number of bulletins to fetch per page (default: 100, max: 1000)
   * @returns Paginated response with announcements, next cursor, and hasMore flag
   */
  fetchAnnouncementsFromCursor(
    cursor?: string,
    limit?: number
  ): Promise<PaginatedAnnouncementsResponse>;

  /**
   * Fetch the current bulletin counter from the API.
   * Useful to check if there are new bulletins without fetching them all.
   * @returns The current bulletin counter as a string
   */
  fetchBulletinCounter(): Promise<string>;

  /**
   * Fetch public key by userId hash (base64 string)
   * @param userId - Decoded userId bytes
   * @returns Base64-encoded public keys
   */
  fetchPublicKeyByUserId(userId: Uint8Array): Promise<string>;

  /**
   * Store public key in the auth API
   * @param base64PublicKeys - Base64-encoded public keys
   * @returns The hash key (hex string) returned by the API
   */
  postPublicKey(base64PublicKeys: string): Promise<string>;

  /**
   * Change the current node provider
   * @param nodeUrl - The URL of the new node
   * @returns MessageProtocolResponse with the new node information
   */
  changeNode(nodeUrl?: string): Promise<MessageProtocolResponse>;
}
