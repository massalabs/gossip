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

/** Options of a message fetch or send. */
export interface MessageRouting {
  /**
   * Only the mesh transports take part. For entries that must never reach an
   * internet node, such as addressed re-announcements; a transport without a
   * mesh must refuse the call rather than ignore the option.
   */
  meshOnly?: boolean;
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
  fetchMessages(
    seekers: Uint8Array[],
    routing?: MessageRouting
  ): Promise<EncryptedMessage[]>;

  /**
   * Send an encrypted message to the key-value store
   */
  sendMessage(
    message: EncryptedMessage,
    routing?: MessageRouting
  ): Promise<void>;

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
   * wanted list). Called after every message fetch. `localSeekers` are
   * waited on from the mesh only (lookahead and re-announcement mailbox
   * seekers): a mesh node floods them flagged local-only, so that no bridge
   * asks an internet node for them.
   */
  setWantedSeekers?(
    seekers: Uint8Array[],
    localSeekers?: Uint8Array[]
  ): Promise<void>;

  /**
   * Whether a mesh transport is on, so mesh-only traffic (lookahead seekers,
   * addressed re-announcements, `meshOnly` routing) has somewhere to go.
   * Transports that omit it have no mesh.
   */
  isMeshEnabled?(): boolean;

  /**
   * Bulletin cursors of the transports behind this one whose announcements
   * carry no counter the SDK stores (see CompositeMessageProtocol), so they
   * can be saved and restored across restarts.
   */
  exportSecondaryCursors?(): (string | undefined)[];
  importSecondaryCursors?(cursors: (string | undefined)[]): void;

  /** Current reachability; transports that omit it are assumed online. */
  getConnectivity?(): TransportConnectivity;

  /**
   * For transports that run several paths: which kinds of path took the last
   * send at `seeker` ('internet', 'mesh'), read once.
   */
  takeAcceptedBy?(seeker: Uint8Array): ('internet' | 'mesh')[] | undefined;
}
