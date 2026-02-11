/**
 * Session Module Implementation
 *
 * This file contains the real WASM implementation of the SessionModule
 * using SessionManagerWrapper and related WASM classes.
 */

import {
  SessionManagerWrapper,
  UserPublicKeys,
  UserSecretKeys,
  ReceiveMessageOutput,
  SendMessageOutput,
  SessionStatus,
  EncryptionKey,
  SessionConfig,
  AnnouncementResult,
  UserKeys,
} from './bindings';
import { encodeUserId } from '../utils/userId';

export class SessionModule {
  private sessionManager: SessionManagerWrapper | null = null;
  private onPersist?: () => Promise<void>; // Async callback for persistence
  public ourPk: UserPublicKeys;
  public ourSk: UserSecretKeys;
  public userId: Uint8Array;
  public userIdEncoded: string;

  constructor(
    userKeys: UserKeys,
    onPersist?: () => Promise<void>,
    config?: SessionConfig
  ) {
    this.ourPk = userKeys.public_keys();
    this.ourSk = userKeys.secret_keys();
    this.userId = this.ourPk.derive_id();
    this.userIdEncoded = encodeUserId(this.userId);

    const sessionConfig = config ?? SessionConfig.new_default();
    this.sessionManager = new SessionManagerWrapper(sessionConfig);
    this.onPersist = onPersist;
  }

  /**
   * Set the persistence callback
   */
  setOnPersist(callback: () => Promise<void>): void {
    this.onPersist = callback;
  }

  /**
   * Helper to trigger persistence after state changes.
   * Returns a promise that resolves when persistence is complete.
   * IMPORTANT: Callers should await this before sending data to network
   * to prevent state loss on app crash.
   */
  private async persistIfNeeded(): Promise<void> {
    if (this.onPersist) {
      await this.onPersist!();
    }
  }

  /**
   * Trigger persistence explicitly and wait for completion.
   * Use this when you need to ensure state is saved before proceeding.
   */
  async persist(): Promise<void> {
    await this.persistIfNeeded();
  }

  /**
   * Initialize session from an encrypted blob
   */
  load(encryptedSession: Uint8Array, encryptionKey: EncryptionKey): void {
    // Clean up existing session if any
    this.cleanup();

    try {
      this.sessionManager = SessionManagerWrapper.from_encrypted_blob(
        encryptedSession,
        encryptionKey
      );
    } catch (error) {
      const message =
        error instanceof Error ? error.message : JSON.stringify(error);
      throw new Error(
        `[SessionModule] Failed to load encrypted session: ${message}`
      );
    }
  }

  /**
   * Serialize session to an encrypted blob
   */
  toEncryptedBlob(key: EncryptionKey): Uint8Array {
    if (!this.sessionManager) {
      throw new Error('Session manager is not initialized');
    }

    return this.sessionManager.to_encrypted_blob(key);
  }

  cleanup(): void {
    this.sessionManager?.free();
    this.sessionManager = null;
  }

  /**
   * Establish an outgoing session with a peer via the underlying WASM wrapper
   * @param peerPk - The peer's public keys
   * @param userData - Optional user data to include in the announcement (defaults to empty array)
   * @returns The announcement bytes to publish
   */
  async establishOutgoingSession(
    peerPk: UserPublicKeys,
    userData?: Uint8Array
  ): Promise<Uint8Array> {
    if (!this.sessionManager) {
      throw new Error('Session manager is not initialized');
    }

    const userDataBytes = userData ?? new Uint8Array(0);
    const result = this.sessionManager.establish_outgoing_session(
      peerPk,
      this.ourPk,
      this.ourSk,
      userDataBytes
    );

    if (result.length === 0) {
      throw new Error(
        'Failed to establish outgoing session. Session manager returned empty announcement bytes.'
      );
    }

    await this.persistIfNeeded();
    return result;
  }

  /**
   * Feed an incoming announcement into the session manager
   * @returns AnnouncementResult containing the announcer's public keys, timestamp, and user data, or undefined if invalid
   */
  async feedIncomingAnnouncement(
    announcementBytes: Uint8Array
  ): Promise<AnnouncementResult | undefined> {
    if (!this.sessionManager) {
      throw new Error('Session manager is not initialized');
    }

    const result = this.sessionManager.feed_incoming_announcement(
      announcementBytes,
      this.ourPk,
      this.ourSk
    );

    if (result) {
      await this.persistIfNeeded();
    }
    return result;
  }

  /**
   * Get the list of message board read keys (seekers) to monitor
   */
  getMessageBoardReadKeys(): Array<Uint8Array> {
    if (!this.sessionManager) {
      throw new Error('Session manager is not initialized');
    }

    return this.sessionManager.get_message_board_read_keys();
  }

  /**
   * Process an incoming ciphertext from the message board
   */
  async feedIncomingMessageBoardRead(
    seeker: Uint8Array,
    ciphertext: Uint8Array
  ): Promise<ReceiveMessageOutput | undefined> {
    if (!this.sessionManager) {
      throw new Error('Session manager is not initialized');
    }

    const result = this.sessionManager.feed_incoming_message_board_read(
      seeker,
      ciphertext,
      this.ourSk
    );

    await this.persistIfNeeded();
    return result;
  }

  /**
   * Send a message to a peer.
   * IMPORTANT: This persists session state before returning.
   * The returned output should only be sent to network AFTER this resolves.
   */
  async sendMessage(
    peerId: Uint8Array,
    message: Uint8Array
  ): Promise<SendMessageOutput | undefined> {
    if (!this.sessionManager) {
      throw new Error('Session manager is not initialized');
    }

    const result = this.sessionManager.send_message(peerId, message);
    // CRITICAL: Persist session state BEFORE returning
    // This ensures state is saved before the encrypted message goes on the network
    await this.persistIfNeeded();
    return result;
  }

  /**
   * List all known peer IDs
   */
  peerList(): Array<Uint8Array> {
    if (!this.sessionManager) {
      throw new Error('Session manager is not initialized');
    }

    return this.sessionManager.peer_list();
  }

  /**
   * Get the session status for a peer
   */
  peerSessionStatus(peerId: Uint8Array): SessionStatus {
    if (!this.sessionManager) {
      throw new Error('Session manager is not initialized');
    }

    return this.sessionManager.peer_session_status(peerId);
  }

  /**
   * Discard a peer and all associated session state
   */
  async peerDiscard(peerId: Uint8Array): Promise<void> {
    if (!this.sessionManager) {
      throw new Error('Session manager is not initialized');
    }

    this.sessionManager.peer_discard(peerId);
    await this.persistIfNeeded();
  }

  /**
   * Refresh sessions, returning peer IDs that need keep-alive messages
   */
  async refresh(): Promise<Array<Uint8Array>> {
    if (!this.sessionManager) {
      throw new Error('Session manager is not initialized');
    }

    const result = this.sessionManager.refresh();
    await this.persistIfNeeded();
    return result;
  }
}

export function sessionStatusToString(status: SessionStatus): string {
  switch (status) {
    case SessionStatus.Active:
      return 'Active';
    case SessionStatus.UnknownPeer:
      return 'UnknownPeer';
    case SessionStatus.NoSession:
      return 'NoSession';
    case SessionStatus.PeerRequested:
      return 'PeerRequested';
    case SessionStatus.SelfRequested:
      return 'SelfRequested';
    case SessionStatus.Killed:
      return 'Killed';
    case SessionStatus.Saturated:
      return 'Saturated';
    default:
      throw new Error(`Unknown session status: ${status}`);
  }
}
