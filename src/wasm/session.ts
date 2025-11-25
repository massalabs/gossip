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
} from '../assets/generated/wasm/gossip_wasm';
import { UserProfile } from '../db';

export class SessionModule {
  private sessionManager: SessionManagerWrapper | null = null;
  private onPersist?: () => void; // Callback for automatic persistence

  constructor(onPersist?: () => void) {
    const sessionConfig = SessionConfig.new_default();
    this.sessionManager = new SessionManagerWrapper(sessionConfig);
    this.onPersist = onPersist;
  }

  /**
   * Set the persistence callback
   */
  setOnPersist(callback: () => void): void {
    this.onPersist = callback;
  }

  /**
   * Helper to trigger persistence after state changes
   */
  private persistIfNeeded(): void {
    if (this.onPersist) {
      this.onPersist();
    }
  }

  /**
   * Initialize session from an encrypted blob
   */
  load(profile: UserProfile, encryptionKey: EncryptionKey): void {
    // Clean up existing session if any
    this.cleanup();

    this.sessionManager = SessionManagerWrapper.from_encrypted_blob(
      profile.session,
      encryptionKey
    );
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
   * @param ourPk - Our public keys
   * @param ourSk - Our secret keys
   * @param userData - Optional user data to include in the announcement (defaults to empty array)
   * @returns The announcement bytes to publish
   */
  establishOutgoingSession(
    peerPk: UserPublicKeys,
    ourPk: UserPublicKeys,
    ourSk: UserSecretKeys,
    userData?: Uint8Array
  ): Uint8Array {
    if (!this.sessionManager) {
      throw new Error('Session manager is not initialized');
    }

    const userDataBytes = userData ?? new Uint8Array(0);
    const result = this.sessionManager.establish_outgoing_session(
      peerPk,
      ourPk,
      ourSk,
      userDataBytes
    );

    this.persistIfNeeded();
    return result;
  }

  /**
   * Feed an incoming announcement into the session manager
   * @returns AnnouncementResult containing the announcer's public keys, timestamp, and user data, or undefined if invalid
   */
  feedIncomingAnnouncement(
    announcementBytes: Uint8Array,
    ourPk: UserPublicKeys,
    ourSk: UserSecretKeys
  ): AnnouncementResult | undefined {
    if (!this.sessionManager) {
      throw new Error('Session manager is not initialized');
    }

    const result = this.sessionManager.feed_incoming_announcement(
      announcementBytes,
      ourPk,
      ourSk
    );

    if (result) {
      this.persistIfNeeded();
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
  feedIncomingMessageBoardRead(
    seeker: Uint8Array,
    ciphertext: Uint8Array,
    ourSk: UserSecretKeys
  ): ReceiveMessageOutput | undefined {
    if (!this.sessionManager) {
      throw new Error('Session manager is not initialized');
    }

    const result = this.sessionManager.feed_incoming_message_board_read(
      seeker,
      ciphertext,
      ourSk
    );

    this.persistIfNeeded();
    return result;
  }

  /**
   * Send a message to a peer
   */
  sendMessage(
    peerId: Uint8Array,
    message: Uint8Array
  ): SendMessageOutput | undefined {
    if (!this.sessionManager) {
      throw new Error('Session manager is not initialized');
    }

    const result = this.sessionManager.send_message(peerId, message);
    this.persistIfNeeded();
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
  peerDiscard(peerId: Uint8Array): void {
    if (!this.sessionManager) {
      throw new Error('Session manager is not initialized');
    }

    this.sessionManager.peer_discard(peerId);
    this.persistIfNeeded();
  }

  /**
   * Refresh sessions, returning peer IDs that need keep-alive messages
   */
  refresh(): Array<Uint8Array> {
    if (!this.sessionManager) {
      throw new Error('Session manager is not initialized');
    }

    const result = this.sessionManager.refresh();
    this.persistIfNeeded();
    return result;
  }
}
