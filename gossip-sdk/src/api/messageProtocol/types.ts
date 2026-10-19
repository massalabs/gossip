/**
 * Message Protocol Types and Interfaces
 *
 * Defines the core types and interfaces for message protocol operations.
 */

export type BulletinItem = {
  /**
   * Position on the bulletin the fetch cursor refers to. Absent for an
   * announcement that came from another transport (see
   * CompositeMessageProtocol): it must not move the cursor.
   */
  counter?: string;
  data: Uint8Array;
};

/**
 * What the transports can reach right now. `mesh-only` means messages still
 * move, but over a slow store-and-forward mesh where every byte counts.
 */
export type TransportConnectivity = 'internet' | 'mesh-only' | 'offline';

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
   * @param limit - Maximum number of announcements to fetch (default: 20)
   * @param cursor - Optional cursor (counter) to fetch announcements after this value
   */
  fetchAnnouncements(limit?: number, cursor?: string): Promise<BulletinItem[]>;

  /**
   * Fetch the latest bulletin counter from the API without downloading announcement data.
   */
  fetchBulletinCounter(): Promise<string>;

  /**
   * Change the current node provider
   * @param nodeUrl - The URL of the new node
   * @returns MessageProtocolResponse with the new node information
   */
  changeNode(nodeUrl?: string): Promise<MessageProtocolResponse>;

  /**
   * Seekers this client currently waits on, for transports that ask other
   * nodes for them instead of being polled (a mesh node puts them on its
   * wanted list). Called after every message fetch.
   */
  setWantedSeekers?(seekers: Uint8Array[]): Promise<void>;

  /** Current reachability; transports that omit it are assumed online. */
  getConnectivity?(): TransportConnectivity;

  /**
   * For transports that run several paths: which kinds of path took the last
   * send at `seeker` ('internet', 'mesh'), read once.
   */
  takeAcceptedBy?(seeker: Uint8Array): ('internet' | 'mesh')[] | undefined;
}
