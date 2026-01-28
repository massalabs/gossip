/**
 * GossipSdk - Singleton SDK with clean lifecycle API
 *
 * @example
 * ```typescript
 * import { gossipSdk } from 'gossip-sdk';
 *
 * // Initialize once at app startup
 * await gossipSdk.init({
 *   db,
 *   protocolBaseUrl: 'https://api.example.com',
 * });
 *
 * // Open session (login) - SDK handles keys/session internally
 * await gossipSdk.openSession({
 *   mnemonic: 'word1 word2 ...',
 *   onPersist: async (blob) => { /* save to db *\/ },
 * });
 *
 * // Or restore existing session
 * await gossipSdk.openSession({
 *   mnemonic: 'word1 word2 ...',
 *   encryptedSession: savedBlob,
 *   encryptionKey: key,
 *   onPersist: async (blob) => { /* save to db *\/ },
 * });
 *
 * // Use clean API
 * await gossipSdk.messages.send(contactId, 'Hello!');
 * await gossipSdk.discussions.start(contact);
 * const contacts = await gossipSdk.contacts.list(ownerUserId);
 *
 * // Events
 * gossipSdk.on('message', (msg) => { ... });
 * gossipSdk.on('discussionRequest', (discussion, contact) => { ... });
 *
 * // Logout
 * await gossipSdk.closeSession();
 * ```
 */

import {
  GossipDatabase,
  type Contact,
  type Discussion,
  type Message,
  type UserProfile,
  MessageStatus,
} from './db';
import { setDb } from './db';
import { IMessageProtocol, createMessageProtocol } from './api/messageProtocol';
import { setProtocolBaseUrl } from './config/protocol';
import {
  type SdkConfig,
  type DeepPartial,
  defaultSdkConfig,
  mergeConfig,
} from './config/sdk';
import { startWasmInitialization, ensureWasmInitialized } from './wasm/loader';
import { generateUserKeys, UserKeys } from './wasm/userKeys';
import { SessionModule } from './wasm/session';
import { EncryptionKey } from './wasm/encryption';
import {
  AnnouncementService,
  type AnnouncementReceptionResult,
} from './services/announcement';
import { DiscussionService } from './services/discussion';
import {
  MessageService,
  type MessageResult,
  type SendMessageResult,
} from './services/message';
import { RefreshService } from './services/refresh';
import { AuthService } from './services/auth';
import type {
  DeleteContactResult,
  UpdateContactNameResult,
} from './utils/contacts';
import {
  validateUserIdFormat,
  validateUsernameFormat,
  type ValidationResult,
} from './utils/validation';
import { QueueManager } from './utils/queue';
import { encodeUserId, decodeUserId } from './utils/userId';
import type { GossipSdkEvents } from './types/events';
import {
  getContacts,
  getContact,
  addContact,
  updateContactName,
  deleteContact,
} from './contacts';
import type { UserPublicKeys } from '#wasm';
import {
  SdkEventEmitter,
  type SdkEventType,
  type SdkEventHandlers,
} from './core/SdkEventEmitter';
import { SdkPolling } from './core/SdkPolling';

// Re-export event types
export type { SdkEventType, SdkEventHandlers };

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface GossipSdkInitOptions {
  /** Database instance */
  db: GossipDatabase;
  /** Protocol API base URL (shorthand for config.protocol.baseUrl) */
  protocolBaseUrl?: string;
  /** SDK configuration (optional - uses defaults if not provided) */
  config?: DeepPartial<SdkConfig>;
}

export interface OpenSessionOptions {
  /** BIP39 mnemonic phrase */
  mnemonic: string;
  /** Existing encrypted session blob (for restoring session) */
  encryptedSession?: Uint8Array;
  /** Encryption key for decrypting session */
  encryptionKey?: EncryptionKey;
  /** Callback when session state changes (for persistence) */
  onPersist?: (
    encryptedBlob: Uint8Array,
    encryptionKey: EncryptionKey
  ) => Promise<void>;
  /** Encryption key for persisting session (required if onPersist is provided) */
  persistEncryptionKey?: EncryptionKey;
}

// ─────────────────────────────────────────────────────────────────────────────
// SDK State
// ─────────────────────────────────────────────────────────────────────────────

type SdkStateUninitialized = { status: 'uninitialized' };

type SdkStateInitialized = {
  status: 'initialized';
  db: GossipDatabase;
  messageProtocol: IMessageProtocol;
  config: SdkConfig;
};

type SdkStateSessionOpen = {
  status: 'session_open';
  db: GossipDatabase;
  messageProtocol: IMessageProtocol;
  config: SdkConfig;
  session: SessionModule;
  userKeys: UserKeys;
  persistEncryptionKey?: EncryptionKey;
  onPersist?: (
    encryptedBlob: Uint8Array,
    encryptionKey: EncryptionKey
  ) => Promise<void>;
};

type SdkState =
  | SdkStateUninitialized
  | SdkStateInitialized
  | SdkStateSessionOpen;

// ─────────────────────────────────────────────────────────────────────────────
// SDK Class
// ─────────────────────────────────────────────────────────────────────────────

class GossipSdkImpl {
  private state: SdkState = { status: 'uninitialized' };

  // Core components
  private eventEmitter = new SdkEventEmitter();
  private pollingManager = new SdkPolling();
  private messageQueues = new QueueManager();

  // Services (created when session opens)
  private _auth: AuthService | null = null;
  private _announcement: AnnouncementService | null = null;
  private _discussion: DiscussionService | null = null;
  private _message: MessageService | null = null;
  private _refresh: RefreshService | null = null;

  // Cached service API wrappers (created in openSession)
  private _messagesAPI: MessageServiceAPI | null = null;
  private _discussionsAPI: DiscussionServiceAPI | null = null;
  private _announcementsAPI: AnnouncementServiceAPI | null = null;
  private _contactsAPI: ContactsAPI | null = null;
  private _refreshAPI: RefreshServiceAPI | null = null;

  // ─────────────────────────────────────────────────────────────────
  // Lifecycle
  // ─────────────────────────────────────────────────────────────────

  /**
   * Initialize the SDK. Call once at app startup.
   */
  async init(options: GossipSdkInitOptions): Promise<void> {
    if (this.state.status !== 'uninitialized') {
      console.warn('[GossipSdk] Already initialized');
      return;
    }

    // Merge config with defaults
    const config = mergeConfig(options.config);

    // Configure database
    setDb(options.db);

    // Configure protocol URL (prefer explicit option, then config)
    const baseUrl = options.protocolBaseUrl ?? config.protocol.baseUrl;
    if (baseUrl) {
      setProtocolBaseUrl(baseUrl);
    }

    // Start WASM initialization
    startWasmInitialization();

    // Create message protocol
    const messageProtocol = createMessageProtocol();

    // Create auth service (doesn't need session)
    this._auth = new AuthService(options.db, messageProtocol);

    this.state = {
      status: 'initialized',
      db: options.db,
      messageProtocol,
      config,
    };
  }

  /**
   * Open a session (login).
   * Generates keys from mnemonic and initializes session.
   */
  async openSession(options: OpenSessionOptions): Promise<void> {
    if (this.state.status === 'uninitialized') {
      throw new Error('SDK not initialized. Call init() first.');
    }

    if (this.state.status === 'session_open') {
      throw new Error('Session already open. Call closeSession() first.');
    }

    if (options.encryptedSession && !options.encryptionKey) {
      throw new Error(
        'encryptionKey is required when encryptedSession is provided.'
      );
    }

    if (options.onPersist && !options.persistEncryptionKey) {
      throw new Error(
        'persistEncryptionKey is required when onPersist is provided.'
      );
    }

    const { db, messageProtocol } = this.state;

    // Validate session restore options - must have both or neither
    if (options.encryptedSession && !options.encryptionKey) {
      throw new Error(
        'encryptedSession provided without encryptionKey. Session restore requires both.'
      );
    }
    if (options.encryptionKey && !options.encryptedSession) {
      console.warn(
        '[GossipSdk] encryptionKey provided without encryptedSession - key will be ignored'
      );
    }

    // Validate persistence options - warn if incomplete
    if (options.onPersist && !options.persistEncryptionKey) {
      console.warn(
        '[GossipSdk] onPersist provided without persistEncryptionKey - session will not be persisted'
      );
    }
    if (options.persistEncryptionKey && !options.onPersist) {
      console.warn(
        '[GossipSdk] persistEncryptionKey provided without onPersist callback - key will be unused'
      );
    }

    // Ensure WASM is ready
    await ensureWasmInitialized();

    // Generate keys from mnemonic
    const userKeys = await generateUserKeys(options.mnemonic);

    // Create session with persistence callback
    // IMPORTANT: This callback is awaited by the session module before network sends
    const session = new SessionModule(userKeys, async () => {
      await this.handleSessionPersist();
    });

    // Restore existing session state if provided
    if (options.encryptedSession && options.encryptionKey) {
      // Create a minimal profile-like object for load()
      const profileForLoad = {
        session: options.encryptedSession,
      } as UserProfile;
      session.load(profileForLoad, options.encryptionKey);
    }

    // Create event handlers that wire to our event system
    const serviceEvents: GossipSdkEvents = {
      onMessageReceived: (message: Message) => {
        this.eventEmitter.emit('message', message);
      },
      onMessageSent: (message: Message) => {
        this.eventEmitter.emit('messageSent', message);
      },
      onMessageFailed: (message: Message, error: Error) => {
        this.eventEmitter.emit('messageFailed', message, error);
      },
      onDiscussionRequest: (discussion: Discussion, contact: Contact) => {
        this.eventEmitter.emit('discussionRequest', discussion, contact);
      },
      onDiscussionStatusChanged: (discussion: Discussion) => {
        this.eventEmitter.emit('discussionStatusChanged', discussion);
      },
      onSessionBroken: (discussion: Discussion) => {
        this.eventEmitter.emit('sessionBroken', discussion);
      },
      onSessionRenewed: (discussion: Discussion) => {
        this.eventEmitter.emit('sessionRenewed', discussion);
      },
      onError: (error: Error, context: string) => {
        this.eventEmitter.emit('error', error, context);
      },
      // Auto-renewal: when session is lost, automatically renew it
      onSessionRenewalNeeded: (contactUserId: string) => {
        console.log('[GossipSdk] Session renewal needed for', contactUserId);
        this.handleSessionRenewal(contactUserId);
      },
      // Auto-accept: when peer sent us an announcement, accept/respond to establish session
      onSessionAcceptNeeded: (contactUserId: string) => {
        console.log('[GossipSdk] Session accept needed for', contactUserId);
        this.handleSessionAccept(contactUserId);
      },
      // Session became active: peer accepted our announcement, process waiting messages
      onSessionBecameActive: (contactUserId: string) => {
        console.log('[GossipSdk] Session became active for', contactUserId);
        this.handleSessionBecameActive(contactUserId);
      },
    };

    // Get config from initialized state
    const { config } = this.state;

    // Create services with config
    this._announcement = new AnnouncementService(
      db,
      messageProtocol,
      session,
      serviceEvents,
      config
    );
    this._discussion = new DiscussionService(
      db,
      this._announcement,
      session,
      serviceEvents
    );
    this._message = new MessageService(
      db,
      messageProtocol,
      session,
      this._discussion,
      serviceEvents,
      config
    );
    this._refresh = new RefreshService(
      db,
      this._message,
      session,
      serviceEvents
    );

    // Reset any messages stuck in SENDING status to FAILED
    // This handles app crash/close during message send
    await this.resetStuckSendingMessages(db);

    this.state = {
      status: 'session_open',
      db,
      messageProtocol,
      config,
      session,
      userKeys,
      persistEncryptionKey: options.persistEncryptionKey,
      onPersist: options.onPersist,
    };

    // Create cached service API wrappers
    this.createServiceAPIWrappers(db, session);

    // Auto-start polling if enabled in config
    if (config.polling.enabled) {
      this.startPolling();
    }
  }

  /**
   * Create cached service API wrappers.
   * Called once during openSession to avoid creating new objects on each getter access.
   */
  private createServiceAPIWrappers(
    db: GossipDatabase,
    session: SessionModule
  ): void {
    this._messagesAPI = {
      send: message =>
        this.messageQueues.enqueue(message.contactUserId, () =>
          this._message!.sendMessage(message)
        ),
      fetch: () => this._message!.fetchMessages(),
      resend: async messages => {
        const promises: Promise<void>[] = [];
        for (const [contactId, contactMessages] of messages.entries()) {
          const singleContactMap = new Map([[contactId, contactMessages]]);
          promises.push(
            this.messageQueues.enqueue(contactId, () =>
              this._message!.resendMessages(singleContactMap)
            )
          );
        }
        await Promise.all(promises);
      },
      findBySeeker: (seeker, ownerUserId) =>
        this._message!.findMessageBySeeker(seeker, ownerUserId),
    };

    this._discussionsAPI = {
      start: (contact, message) =>
        this._discussion!.initialize(contact, message),
      accept: discussion => this._discussion!.accept(discussion),
      renew: contactUserId => this._discussion!.renew(contactUserId),
      isStable: (ownerUserId, contactUserId) =>
        this._discussion!.isStableState(ownerUserId, contactUserId),
      list: ownerUserId => db.getDiscussionsByOwner(ownerUserId),
      get: (ownerUserId, contactUserId) =>
        db.getDiscussionByOwnerAndContact(ownerUserId, contactUserId),
    };

    this._announcementsAPI = {
      fetch: () => this._announcement!.fetchAndProcessAnnouncements(),
      resend: failedDiscussions =>
        this._announcement!.resendAnnouncements(failedDiscussions),
    };

    this._contactsAPI = {
      list: ownerUserId => getContacts(ownerUserId, db),
      get: (ownerUserId, contactUserId) =>
        getContact(ownerUserId, contactUserId, db),
      add: (ownerUserId, userId, name, publicKeys) =>
        addContact(ownerUserId, userId, name, publicKeys, db),
      updateName: (ownerUserId, contactUserId, newName) =>
        updateContactName(ownerUserId, contactUserId, newName, db),
      delete: (ownerUserId, contactUserId) =>
        deleteContact(ownerUserId, contactUserId, db, session),
    };

    this._refreshAPI = {
      handleSessionRefresh: activeDiscussions =>
        this._refresh!.handleSessionRefresh(activeDiscussions),
    };
  }

  /**
   * Close the current session (logout).
   */
  async closeSession(): Promise<void> {
    if (this.state.status !== 'session_open') {
      return;
    }

    // Stop polling first
    this.pollingManager.stop();

    // Cleanup session
    this.state.session.cleanup();

    // Clear services
    this._announcement = null;
    this._discussion = null;
    this._message = null;
    this._refresh = null;

    // Clear cached API wrappers
    this._messagesAPI = null;
    this._discussionsAPI = null;
    this._announcementsAPI = null;
    this._contactsAPI = null;
    this._refreshAPI = null;

    // Clear message queues
    this.messageQueues.clear();

    // Reset to initialized state
    this.state = {
      status: 'initialized',
      db: this.state.db,
      messageProtocol: this.state.messageProtocol,
      config: this.state.config,
    };
  }

  // ─────────────────────────────────────────────────────────────────
  // Session Info
  // ─────────────────────────────────────────────────────────────────

  /** Current user ID (encoded). Throws if no session is open. */
  get userId(): string {
    const state = this.requireSession();
    return state.session.userIdEncoded;
  }

  /** Current user ID (raw bytes). Throws if no session is open. */
  get userIdBytes(): Uint8Array {
    const state = this.requireSession();
    return state.session.userId;
  }

  /** User's public keys. Throws if no session is open. */
  get publicKeys(): UserPublicKeys {
    const state = this.requireSession();
    return state.session.ourPk;
  }

  /** Whether a session is currently open */
  get isSessionOpen(): boolean {
    return this.state.status === 'session_open';
  }

  /** Whether SDK is initialized */
  get isInitialized(): boolean {
    return this.state.status !== 'uninitialized';
  }

  /**
   * Get encrypted session blob for persistence.
   * Throws if no session is open.
   */
  getEncryptedSession(encryptionKey: EncryptionKey): Uint8Array {
    const state = this.requireSession();
    return state.session.toEncryptedBlob(encryptionKey);
  }

  /**
   * Configure session persistence after session is opened.
   * Use this when you need to set up persistence after account creation.
   *
   * @param encryptionKey - Key to encrypt session blob
   * @param onPersist - Callback to save encrypted session blob
   */
  configurePersistence(
    encryptionKey: EncryptionKey,
    onPersist: (
      encryptedBlob: Uint8Array,
      encryptionKey: EncryptionKey
    ) => Promise<void>
  ): void {
    if (this.state.status !== 'session_open') {
      throw new Error('No session open. Call openSession() first.');
    }

    // Update state with persistence config
    this.state = {
      ...this.state,
      persistEncryptionKey: encryptionKey,
      onPersist,
    };

    console.log('[GossipSdk] Session persistence configured');
  }

  // ─────────────────────────────────────────────────────────────────
  // Services (accessible only when session is open)
  // ─────────────────────────────────────────────────────────────────

  /** Auth service (available after init, before session) */
  get auth(): AuthService {
    if (!this._auth) {
      throw new Error('SDK not initialized');
    }
    return this._auth;
  }

  /** Message service */
  get messages(): MessageServiceAPI {
    this.requireSession();
    if (!this._messagesAPI) {
      throw new Error('Messages API not initialized');
    }
    return this._messagesAPI;
  }

  /** Discussion service */
  get discussions(): DiscussionServiceAPI {
    this.requireSession();
    if (!this._discussionsAPI) {
      throw new Error('Discussions API not initialized');
    }
    return this._discussionsAPI;
  }

  /** Announcement service */
  get announcements(): AnnouncementServiceAPI {
    this.requireSession();
    if (!this._announcementsAPI) {
      throw new Error('Announcements API not initialized');
    }
    return this._announcementsAPI;
  }

  /** Contact management */
  get contacts(): ContactsAPI {
    this.requireSession();
    if (!this._contactsAPI) {
      throw new Error('Contacts API not initialized');
    }
    return this._contactsAPI;
  }

  /** Refresh/sync service */
  get refresh(): RefreshServiceAPI {
    this.requireSession();
    if (!this._refreshAPI) {
      throw new Error('Refresh API not initialized');
    }
    return this._refreshAPI;
  }

  /** Utility functions */
  get utils(): SdkUtils {
    return {
      validateUserId: validateUserIdFormat,
      validateUsername: validateUsernameFormat,
      encodeUserId,
      decodeUserId,
    };
  }

  /** Current SDK configuration (read-only) */
  get config(): SdkConfig {
    if (this.state.status === 'uninitialized') {
      return defaultSdkConfig;
    }
    return this.state.config;
  }

  /** Polling control API */
  get polling(): PollingAPI {
    return {
      start: () => this.startPolling(),
      stop: () => this.pollingManager.stop(),
      isRunning: this.pollingManager.isRunning(),
    };
  }

  // ─────────────────────────────────────────────────────────────────
  // Polling
  // ─────────────────────────────────────────────────────────────────

  /**
   * Start polling for messages, announcements, and session refresh.
   * Uses intervals from config.polling.
   */
  private startPolling(): void {
    if (this.state.status !== 'session_open') {
      console.warn('[GossipSdk] Cannot start polling - no session open');
      return;
    }

    const { config, db, session } = this.state;

    this.pollingManager.start(config, {
      fetchMessages: async () => {
        await this._message?.fetchMessages();
      },
      fetchAnnouncements: async () => {
        await this._announcement?.fetchAndProcessAnnouncements();
      },
      handleSessionRefresh: async discussions => {
        await this._refresh?.handleSessionRefresh(discussions);
      },
      getActiveDiscussions: async () => {
        return db.getActiveDiscussionsByOwner(session.userIdEncoded);
      },
      onError: (error, context) => {
        this.eventEmitter.emit('error', error, context);
      },
    });
  }

  // ─────────────────────────────────────────────────────────────────
  // Events
  // ─────────────────────────────────────────────────────────────────

  /**
   * Register an event handler
   */
  on<K extends SdkEventType>(event: K, handler: SdkEventHandlers[K]): void {
    this.eventEmitter.on(event, handler);
  }

  /**
   * Remove an event handler
   */
  off<K extends SdkEventType>(event: K, handler: SdkEventHandlers[K]): void {
    this.eventEmitter.off(event, handler);
  }

  // ─────────────────────────────────────────────────────────────────
  // Private Helpers
  // ─────────────────────────────────────────────────────────────────

  private requireSession(): SdkStateSessionOpen {
    if (this.state.status !== 'session_open') {
      throw new Error('No session open. Call openSession() first.');
    }
    return this.state;
  }

  /**
   * Handle automatic session renewal when session is lost.
   * Called by onSessionRenewalNeeded event.
   */
  private async handleSessionRenewal(contactUserId: string): Promise<void> {
    if (this.state.status !== 'session_open') return;

    try {
      await this._discussion!.renew(contactUserId);
      console.log('[GossipSdk] Session renewed for', contactUserId);

      // After successful renewal, process any waiting messages
      const sentCount =
        await this._message!.processWaitingMessages(contactUserId);
      if (sentCount > 0) {
        console.log(
          `[GossipSdk] Sent ${sentCount} waiting messages after renewal`
        );
      }
    } catch (error) {
      console.error('[GossipSdk] Session renewal failed:', error);
      this.eventEmitter.emit(
        'error',
        error instanceof Error ? error : new Error(String(error)),
        'session_renewal'
      );
    }
  }

  /**
   * Handle automatic session accept when peer has sent us an announcement.
   * Called by onSessionAcceptNeeded event.
   * This is different from renewal - we respond to their session request.
   */
  private async handleSessionAccept(contactUserId: string): Promise<void> {
    if (this.state.status !== 'session_open') return;

    try {
      const ownerUserId = this.state.session.userIdEncoded;
      const discussion = await this.state.db.getDiscussionByOwnerAndContact(
        ownerUserId,
        contactUserId
      );

      if (!discussion) {
        console.warn(
          '[GossipSdk] No discussion found for accept, contactUserId:',
          contactUserId
        );
        return;
      }

      // Accept the discussion (sends our announcement back to establish session)
      await this._discussion!.accept(discussion);
      console.log('[GossipSdk] Session accepted for', contactUserId);

      // After successful accept, process any waiting messages
      const sentCount =
        await this._message!.processWaitingMessages(contactUserId);
      if (sentCount > 0) {
        console.log(
          `[GossipSdk] Sent ${sentCount} waiting messages after accept`
        );
      }
    } catch (error) {
      console.error('[GossipSdk] Session accept failed:', error);
      this.eventEmitter.emit(
        'error',
        error instanceof Error ? error : new Error(String(error)),
        'session_accept'
      );
    }
  }

  /**
   * Handle session becoming Active after peer accepts our announcement.
   * Called by onSessionBecameActive event.
   *
   * This is different from handleSessionAccept:
   * - handleSessionAccept: WE accept a session (peer initiated)
   * - handleSessionBecameActive: PEER accepts our session (we initiated)
   */
  private async handleSessionBecameActive(
    contactUserId: string
  ): Promise<void> {
    if (this.state.status !== 'session_open') return;

    try {
      // Process any messages that were queued as WAITING_SESSION
      const sentCount =
        await this._message!.processWaitingMessages(contactUserId);
      if (sentCount > 0) {
        console.log(
          `[GossipSdk] Sent ${sentCount} waiting messages after session became active`
        );
      }
    } catch (error) {
      console.error('[GossipSdk] Processing waiting messages failed:', error);
      this.eventEmitter.emit(
        'error',
        error instanceof Error ? error : new Error(String(error)),
        'session_became_active'
      );
    }
  }

  private async handleSessionPersist(): Promise<void> {
    if (this.state.status !== 'session_open') return;

    const { onPersist, persistEncryptionKey, session } = this.state;
    if (!onPersist || !persistEncryptionKey) return;

    try {
      const blob = session.toEncryptedBlob(persistEncryptionKey);
      console.log(
        `[SessionPersist] Saving session blob (${blob.length} bytes)`
      );
      await onPersist(blob, persistEncryptionKey);
    } catch (error) {
      console.error('[GossipSdk] Session persistence failed:', error);
    }
  }

  /**
   * Reset any messages stuck in SENDING status to FAILED.
   * This handles the case where the app crashed or was closed during message send.
   * Per spec: SENDING should never be persisted - if we find it on startup, it failed.
   */
  /**
   * Reset messages stuck in SENDING status to WAITING_SESSION.
   *
   * Per spec: SENDING is a transient state that should never be persisted.
   * If the app crashes/closes during a send, the message would be stuck forever.
   *
   * By resetting to WAITING_SESSION:
   * - Message will be re-encrypted with current session keys
   * - Message will be automatically sent when session is active
   * - No manual user intervention required
   *
   * We also clear encryptedMessage and seeker since they may be stale.
   */
  private async resetStuckSendingMessages(db: GossipDatabase): Promise<void> {
    try {
      const count = await db.messages
        .where('status')
        .equals(MessageStatus.SENDING)
        .modify({
          status: MessageStatus.WAITING_SESSION,
          encryptedMessage: undefined,
          seeker: undefined,
        });

      if (count > 0) {
        console.log(
          `[GossipSdk] Reset ${count} stuck SENDING message(s) to WAITING_SESSION for auto-retry`
        );
      }
    } catch (error) {
      console.error('[GossipSdk] Failed to reset stuck messages:', error);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Service API Types
// ─────────────────────────────────────────────────────────────────────────────

interface MessageServiceAPI {
  /** Send a message */
  send(message: Omit<Message, 'id'>): Promise<SendMessageResult>;
  /** Fetch and decrypt messages from the protocol */
  fetch(): Promise<MessageResult>;
  /** Resend failed messages */
  resend(messages: Map<string, Message[]>): Promise<void>;
  /** Find a message by its seeker */
  findBySeeker(
    seeker: Uint8Array,
    ownerUserId: string
  ): Promise<Message | undefined>;
}

interface DiscussionServiceAPI {
  /** Start a new discussion with a contact */
  start(
    contact: Contact,
    message?: string
  ): Promise<{ discussionId: number; announcement: Uint8Array }>;
  /** Accept an incoming discussion request */
  accept(discussion: Discussion): Promise<void>;
  /** Renew a broken discussion */
  renew(contactUserId: string): Promise<void>;
  /** Check if a discussion is in a stable state */
  isStable(ownerUserId: string, contactUserId: string): Promise<boolean>;
  /** List all discussions for the owner */
  list(ownerUserId: string): Promise<Discussion[]>;
  /** Get a specific discussion */
  get(
    ownerUserId: string,
    contactUserId: string
  ): Promise<Discussion | undefined>;
}

interface AnnouncementServiceAPI {
  /** Fetch and process announcements from the protocol */
  fetch(): Promise<AnnouncementReceptionResult>;
  /** Resend failed announcements */
  resend(failedDiscussions: Discussion[]): Promise<void>;
}

interface ContactsAPI {
  /** List all contacts for the owner */
  list(ownerUserId: string): Promise<Contact[]>;
  /** Get a specific contact */
  get(ownerUserId: string, contactUserId: string): Promise<Contact | null>;
  /** Add a new contact */
  add(
    ownerUserId: string,
    userId: string,
    name: string,
    publicKeys: UserPublicKeys
  ): Promise<{ success: boolean; error?: string; contact?: Contact }>;
  /** Update a contact's name */
  updateName(
    ownerUserId: string,
    contactUserId: string,
    newName: string
  ): Promise<UpdateContactNameResult>;
  /** Delete a contact and all related data */
  delete(
    ownerUserId: string,
    contactUserId: string
  ): Promise<DeleteContactResult>;
}

interface RefreshServiceAPI {
  /** Handle session refresh (keep-alive, broken sessions, etc.) */
  handleSessionRefresh(activeDiscussions: Discussion[]): Promise<void>;
}

interface SdkUtils {
  /** Validate a user ID format */
  validateUserId(userId: string): ValidationResult;
  /** Validate a username format */
  validateUsername(username: string): ValidationResult;
  /** Encode raw bytes to user ID string */
  encodeUserId(rawId: Uint8Array): string;
  /** Decode user ID string to raw bytes */
  decodeUserId(encodedId: string): Uint8Array;
}

interface PollingAPI {
  /** Start polling for messages, announcements, and session refresh */
  start(): void;
  /** Stop all polling */
  stop(): void;
  /** Whether polling is currently running */
  isRunning: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Singleton Export
// ─────────────────────────────────────────────────────────────────────────────

/** The singleton GossipSdk instance */
export const gossipSdk = new GossipSdkImpl();

// Also export the class for testing
export { GossipSdkImpl };
