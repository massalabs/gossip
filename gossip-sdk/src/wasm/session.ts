/**
 * Session Module Implementation
 *
 * This file contains the real WASM implementation of the SessionModule
 * using SessionManagerWrapper and related WASM classes.
 *
 * All Uint8Array values returned from WASM are funneled through `copyOut` /
 * `copyOutMany` so callers always get JS-owned buffers. Without this, a
 * subsequent WASM allocation that grows linear memory detaches the original
 * `wasm.memory.buffer` and any Uint8Array view sitting on top of it — leading
 * to "detached ArrayBuffer" failures on the next read.
 */

import {
  SessionManagerWrapper,
  UserPublicKeys,
  UserSecretKeys,
  SendMessageOutput,
  SessionStatus,
  EncryptionKey,
  SessionConfig,
  AnnouncementResult,
  UserKeys,
} from './bindings.js';
import { encodeUserId } from '../utils/userId.js';

const copyOut = (a: Uint8Array): Uint8Array => new Uint8Array(a);
const copyOutMany = (xs: Uint8Array[]): Uint8Array[] => xs.map(copyOut);

function freeWasm(value: { free(): void; __wbg_ptr?: number }): void {
  if (value.__wbg_ptr === undefined || value.__wbg_ptr !== 0) value.free();
}

export interface ReceivedMessage {
  message: Uint8Array;
  user_id: Uint8Array;
  timestamp: number;
  acknowledged_seekers: Uint8Array[];
  /** Older than the configured age, or than the previous message: delayed in transit. */
  stale: boolean;
}

/**
 * A session configuration, or a function building one. WASM consumes a
 * SessionConfig when it uses it, so only a function lets the module apply the
 * same limits again to a manager restored from a blob.
 */
export type SessionConfigSource = SessionConfig | (() => SessionConfig);

export class SessionModule {
  private sessionManager: SessionManagerWrapper | null = null;
  private onPersist?: () => Promise<void>; // Async callback for persistence
  private configFactory?: () => SessionConfig;
  public ourPk: UserPublicKeys;
  public ourSk: UserSecretKeys;
  public userId: Uint8Array;
  public userIdEncoded: string;

  constructor(
    userKeys: UserKeys,
    onPersist?: () => Promise<void>,
    config?: SessionConfigSource
  ) {
    let ourPk: UserPublicKeys | undefined;
    let ourSk: UserSecretKeys | undefined;
    let sessionManager: SessionManagerWrapper | undefined;
    try {
      ourPk = userKeys.public_keys();
      ourSk = userKeys.secret_keys();
      const userId = copyOut(ourPk.derive_id());
      const userIdEncoded = encodeUserId(userId);

      // SessionManagerWrapper consumes the SessionConfig WASM wrapper.
      // Without a factory, a caller-built config applies only to new managers.
      this.configFactory =
        typeof config === 'function'
          ? config
          : config
            ? undefined
            : () => SessionConfig.new_default();
      sessionManager = new SessionManagerWrapper(
        typeof config === 'object' ? config : this.configFactory!()
      );

      this.ourPk = ourPk;
      this.ourSk = ourSk;
      this.userId = userId;
      this.userIdEncoded = userIdEncoded;
      this.sessionManager = sessionManager;
      this.onPersist = onPersist;
    } catch (error) {
      sessionManager?.free();
      if (ourSk) freeWasm(ourSk);
      if (ourPk) freeWasm(ourPk);
      throw error;
    }
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
      // The blob carries the limits it was created with; apply the current ones.
      if (this.configFactory) {
        this.sessionManager.set_config(this.configFactory());
      }
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

    return copyOut(this.sessionManager.to_encrypted_blob(key));
  }

  cleanup(): void {
    this.sessionManager?.free();
    this.sessionManager = null;
  }

  /** Permanently release the session manager and this identity's key wrappers. */
  dispose(): void {
    this.cleanup();
    freeWasm(this.ourPk);
    freeWasm(this.ourSk);
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
    const result = copyOut(
      this.sessionManager.establish_outgoing_session(
        peerPk,
        this.ourPk,
        this.ourSk,
        userDataBytes
      )
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
   * Like establishOutgoingSession, also returning the board entry that carries
   * the announcement to a peer we already exchanged announcements with: post
   * it like a message so a transport that cannot download the whole
   * announcement board (a mesh) can still deliver it.
   */
  async establishOutgoingSessionAddressed(
    peerPk: UserPublicKeys,
    userData?: Uint8Array
  ): Promise<{
    announcement: Uint8Array;
    mailbox?: { seeker: Uint8Array; data: Uint8Array };
  }> {
    if (!this.sessionManager) {
      throw new Error('Session manager is not initialized');
    }

    const result = this.sessionManager.establish_outgoing_session_addressed(
      peerPk,
      this.ourPk,
      this.ourSk,
      userData ?? new Uint8Array(0)
    );
    const announcement = copyOut(result.announcement);
    const seeker = result.mailbox_seeker;
    const data = result.mailbox_data;
    result.free();

    if (announcement.length === 0) {
      throw new Error(
        'Failed to establish outgoing session. Session manager returned empty announcement bytes.'
      );
    }

    await this.persistIfNeeded();
    return {
      announcement,
      mailbox:
        seeker && data
          ? { seeker: copyOut(seeker), data: copyOut(data) }
          : undefined,
    };
  }

  /** Seekers where peers would post their next announcement to us. */
  getReannouncementMailboxKeys(): Array<Uint8Array> {
    if (!this.sessionManager) {
      throw new Error('Session manager is not initialized');
    }

    return copyOutMany(this.sessionManager.get_reannouncement_mailbox_keys());
  }

  /**
   * The announcement carried by an entry read at a re-announcement mailbox,
   * if it is signed by the mailbox key. Changes no state.
   */
  openReannouncementMailboxRead(
    seeker: Uint8Array,
    data: Uint8Array
  ): Uint8Array | undefined {
    if (!this.sessionManager) {
      throw new Error('Session manager is not initialized');
    }

    const opened = this.sessionManager.open_reannouncement_mailbox_read(
      seeker,
      data
    );
    return opened ? copyOut(opened) : undefined;
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

    return copyOutMany(this.sessionManager.get_message_board_read_keys());
  }

  /**
   * Seekers of the messages after the next one from each peer, for transports
   * that request messages ahead of time (a mesh node's wanted list). Messages
   * found there are read once getMessageBoardReadKeys() reaches their seeker.
   */
  getMessageBoardLookaheadKeys(): Array<Uint8Array> {
    if (!this.sessionManager) {
      throw new Error('Session manager is not initialized');
    }

    return copyOutMany(this.sessionManager.get_message_board_lookahead_keys());
  }

  /**
   * Process an incoming ciphertext from the message board
   */
  async feedIncomingMessageBoardRead(
    seeker: Uint8Array,
    ciphertext: Uint8Array
  ): Promise<ReceivedMessage | undefined> {
    if (!this.sessionManager) {
      throw new Error('Session manager is not initialized');
    }

    const result = this.sessionManager.feed_incoming_message_board_read(
      seeker,
      ciphertext,
      this.ourSk
    );
    if (!result) {
      return undefined;
    }

    // Snapshot before any further WASM activity (persistIfNeeded / scheduler
    // yields) can grow linear memory and detach views.
    const snapshot: ReceivedMessage = {
      message: copyOut(result.message),
      user_id: copyOut(result.user_id),
      timestamp: result.timestamp,
      acknowledged_seekers: copyOutMany(
        result.acknowledged_seekers as Uint8Array[]
      ),
      stale: result.stale,
    };
    result.free();

    await this.persistIfNeeded();
    return snapshot;
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

    return copyOutMany(this.sessionManager.peer_list());
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

    const result = copyOutMany(this.sessionManager.refresh());
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
