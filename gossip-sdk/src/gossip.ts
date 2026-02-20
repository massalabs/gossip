/**
 * GossipSdk - Singleton SDK with clean lifecycle API
 *
 * @example
 * ```typescript
 * import { gossipSdk } from '@massalabs/gossip-sdk';
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
  type Contact,
  type Discussion,
  type Message,
  MessageStatus,
} from './db';
import { toDiscussion, toSortedDiscussions } from './utils/discussions';
import { IMessageProtocol, createMessageProtocol } from './api/messageProtocol';
import { createAuthProtocol } from './api/authProtocol';
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
import {
  SessionStatus,
  SessionConfig,
} from './assets/generated/wasm/gossip_wasm';
import { EncryptionKey } from './wasm/encryption';
import {
  AnnouncementService,
  type AnnouncementReceptionResult,
} from './services/announcement';
import {
  DiscussionInitializationResult,
  DiscussionService,
} from './services/discussion';
import {
  MessageService,
  type MessageResult,
  type SendMessageResult,
  rowToMessage,
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
import { initDb } from './sqlite';
import {
  getMessageById as queryGetMessageById,
  getMessagesByOwnerAndContact,
  getMessagesByStatus,
  updateMessageById,
  getDiscussionsByOwner,
  getDiscussionByOwnerAndContact,
} from './queries';
import {
  getContacts,
  getContact,
  addContact,
  updateContactName,
  deleteContact,
} from './contacts';
import type { UserPublicKeys } from './wasm/bindings';
import {
  SdkEventEmitter,
  SdkEventType,
  type SdkEventHandlers,
} from './core/SdkEventEmitter';
import { SdkPolling } from './core/SdkPolling';
import { AnnouncementPayload } from './utils/announcementPayload';
import { Result } from './utils/type';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type { SdkEventHandlers };

export { SdkEventType };

export enum SdkStatus {
  UNINITIALIZED = 'uninitialized',
  INITIALIZED = 'initialized',
  SESSION_OPEN = 'session_open',
}

export interface GossipSdkInitOptions {
  /** Protocol API base URL (shorthand for config.protocol.baseUrl) */
  protocolBaseUrl?: string;
  /** SDK configuration (optional - uses defaults if not provided) */
  config?: DeepPartial<SdkConfig>;
  /** URL to wa-sqlite.wasm (for bundlers that rewrite asset paths) */
  wasmUrl?: string;
  /**
   * OPFS directory path for persistent SQLite storage.
   * When set, data persists across page reloads via OPFS.
   * When omitted, uses an in-memory database (data lost on reload).
   */
  opfsPath?: string;
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
  /** Custom session configuration (optional, uses defaults if not provided) */
  sessionConfig?: SessionConfig;
}

// ─────────────────────────────────────────────────────────────────────────────
// SDK State
// ─────────────────────────────────────────────────────────────────────────────

type SdkStateUninitialized = { status: SdkStatus.UNINITIALIZED };

type SdkStateInitialized = {
  status: SdkStatus.INITIALIZED;
  messageProtocol: IMessageProtocol;
  config: SdkConfig;
};

type SdkStateSessionOpen = {
  status: SdkStatus.SESSION_OPEN;
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

class GossipSdk {
  private state: SdkState = { status: SdkStatus.UNINITIALIZED };

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

  // ─────────────────────────────────────────────────────────────────
  // Lifecycle
  // ─────────────────────────────────────────────────────────────────

  /**
   * Initialize the SDK. Call once at app startup.
   */
  async init(options: GossipSdkInitOptions): Promise<void> {
    if (this.state.status !== SdkStatus.UNINITIALIZED) {
      console.warn('[GossipSdk] Already initialized');
      return;
    }

    console.log('[GossipSdk] Initializing SDK');

    // Merge config with defaults
    const config = mergeConfig(options.config);

    // Configure protocol URL (prefer explicit option, then config)
    const baseUrl = options.protocolBaseUrl ?? config.protocol.baseUrl;
    if (baseUrl) {
      setProtocolBaseUrl(baseUrl);
    }

    // Start WASM initialization
    startWasmInitialization();

    console.log('[GossipSdk] Initializing SQLite');
    // Initialize SQLite (idempotent — no-op if already initialized).
    await initDb({ wasmUrl: options.wasmUrl, opfsPath: options.opfsPath });

    console.log('[GossipSdk] SQLite initialized');
    // Create message protocol
    const messageProtocol = createMessageProtocol();

    // Create auth protocol + service (doesn't need session)
    this._auth = new AuthService(createAuthProtocol());

    this.state = {
      status: SdkStatus.INITIALIZED,
      messageProtocol,
      config,
    };
  }

  /**
   * Open a session (login).
   * Generates keys from mnemonic and initializes session.
   */
  async openSession(options: OpenSessionOptions): Promise<void> {
    if (this.state.status === SdkStatus.UNINITIALIZED) {
      throw new Error('SDK not initialized. Call init() first.');
    }

    if (this.state.status === SdkStatus.SESSION_OPEN) {
      throw new Error('Session already open. Call closeSession() first.');
    }

    // Validate session restore options - must have both or neither
    if (options.encryptedSession && !options.encryptionKey) {
      throw new Error(
        'encryptionKey is required when encryptedSession is provided.'
      );
    }
    if (options.encryptionKey && !options.encryptedSession) {
      console.warn(
        '[GossipSdk] encryptionKey provided without encryptedSession - key will be ignored'
      );
    }

    // Validate persistence options
    if (options.onPersist && !options.persistEncryptionKey) {
      throw new Error(
        'persistEncryptionKey is required when onPersist is provided.'
      );
    }
    if (options.persistEncryptionKey && !options.onPersist) {
      console.warn(
        '[GossipSdk] persistEncryptionKey provided without onPersist callback - key will be unused'
      );
    }

    const { messageProtocol } = this.state;

    // Ensure WASM is ready
    await ensureWasmInitialized();

    // Generate keys from mnemonic
    const userKeys = await generateUserKeys(options.mnemonic);

    // Create session with persistence callback
    // IMPORTANT: This callback is awaited by the session module before network sends
    const session = new SessionModule(
      userKeys,
      async () => {
        await this.handleSessionPersist();
      },
      options.sessionConfig
    );

    // Restore existing session state if provided
    if (options.encryptedSession && options.encryptionKey) {
      session.load(options.encryptedSession, options.encryptionKey);
    }

    // Get config from initialized state
    const { config } = this.state;

    // Create services with config (refreshService will be set after creation)
    this._announcement = new AnnouncementService(
      messageProtocol,
      session,
      this.eventEmitter,
      config
    );

    this._discussion = new DiscussionService(
      this._announcement,
      session,
      this.eventEmitter
    );

    this._message = new MessageService(
      messageProtocol,
      session,
      this.eventEmitter,
      config
    );

    this._refresh = new RefreshService(
      this._message,
      this._discussion,
      this._announcement,
      session,
      this.eventEmitter
    );

    // Publish gossip ID (public key) on messageProtocol so the user is discoverable
    await this._auth!.ensurePublicKeyPublished(
      session.ourPk,
      session.userIdEncoded
    );
    // Now set refreshService on services (circular dependency resolved via setter)
    this._discussion.setRefreshService(this._refresh);
    this._message.setRefreshService(this._refresh);
    this._announcement.setRefreshService(this._refresh);

    // Reset any messages stuck in SENDING status to WAITING_SESSION
    // This handles app crash/close during message send
    await this.resetStuckSendingMessages();

    // Update SDK state to reflect the newly opened session.
    this.state = {
      status: SdkStatus.SESSION_OPEN,
      messageProtocol,
      config,
      session,
      userKeys,
      persistEncryptionKey: options.persistEncryptionKey,
      onPersist: options.onPersist,
    };

    // Create cached service API wrappers
    this.createServiceAPIWrappers(session);

    // Auto-start polling if enabled in config
    if (config.polling.enabled) {
      this.startPolling();
    }
  }

  /**
   * Create cached service API wrappers.
   * Called once during openSession to avoid creating new objects on each getter access.
   */
  private createServiceAPIWrappers(session: SessionModule): void {
    this._messagesAPI = {
      get: async id => {
        const row = await queryGetMessageById(id);
        return row ? rowToMessage(row) : undefined;
      },
      getMessages: async contactUserId => {
        const state = this.requireSession();
        const rows = await getMessagesByOwnerAndContact(
          state.session.userIdEncoded,
          contactUserId
        );
        return rows.map(rowToMessage);
      },
      send: message =>
        this.messageQueues.enqueue(message.contactUserId, () =>
          this._message!.sendMessage(message)
        ),
      fetch: () => this._message!.fetchMessages(),
      findByMsgId: (messageId, ownerUserId, contactUserId) =>
        this._message!.findMessageByMsgId(
          messageId,
          ownerUserId,
          contactUserId
        ),
      markAsRead: id => this._message!.markAsRead(id),
    };

    this._discussionsAPI = {
      start: (contact, payload?: AnnouncementPayload) =>
        this._discussion!.initialize(contact, payload),
      accept: (discussion: Discussion) => this._discussion!.accept(discussion),
      renew: (contactUserId: string) =>
        this._discussion!.createSessionForContact(
          contactUserId,
          new Uint8Array(0)
        ),
      getStatus: (contactUserId: string): SessionStatus => {
        if (this.state.status !== SdkStatus.SESSION_OPEN)
          throw new Error('No session open. Call openSession() first.');
        return this.state.session.peerSessionStatus(
          decodeUserId(contactUserId)
        );
      },
      list: async ownerUserId => {
        const all = await getDiscussionsByOwner(ownerUserId);
        return toSortedDiscussions(all);
      },
      get: async (ownerUserId, contactUserId) => {
        const row = await getDiscussionByOwnerAndContact(
          ownerUserId,
          contactUserId
        );
        return row ? toDiscussion(row) : undefined;
      },
    };

    this._announcementsAPI = {
      fetch: () => this._announcement!.fetchAndProcessAnnouncements(),
      skipHistorical: () => this._announcement!.skipHistoricalAnnouncements(),
    };

    this._contactsAPI = {
      list: ownerUserId => getContacts(ownerUserId),
      get: (ownerUserId, contactUserId) =>
        getContact(ownerUserId, contactUserId),
      add: (ownerUserId, userId, name, publicKeys) =>
        addContact(ownerUserId, userId, name, publicKeys),
      updateName: (ownerUserId, contactUserId, newName) =>
        updateContactName(ownerUserId, contactUserId, newName),
      delete: (ownerUserId, contactUserId) =>
        deleteContact(ownerUserId, contactUserId, session),
    };
  }

  /**
   * Close the current session (logout).
   */
  async closeSession(): Promise<void> {
    if (this.state.status !== SdkStatus.SESSION_OPEN) {
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

    // Clear message queues
    this.messageQueues.clear();

    // Reset to initialized state
    this.state = {
      status: SdkStatus.INITIALIZED,
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
    return this.state.status === SdkStatus.SESSION_OPEN;
  }

  /** Whether SDK is initialized */
  get isInitialized(): boolean {
    return this.state.status !== SdkStatus.UNINITIALIZED;
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
    if (this.state.status !== SdkStatus.SESSION_OPEN) {
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

  /**
   * Update state for all discussions:
   * - Cleanup orphaned peers
   * - Refresh sessions and trigger create_session for lost sessions
   * - Send queued announcements
   * - Send queued messages and keep-alives
   */
  async updateState(): Promise<void> {
    this.requireSession();
    if (!this._refresh) {
      throw new Error('Refresh service not initialized');
    }
    await this._refresh.stateUpdate();
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
    if (this.state.status === SdkStatus.UNINITIALIZED) {
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
    if (this.state.status !== SdkStatus.SESSION_OPEN) {
      console.warn('[GossipSdk] Cannot start polling - no session open');
      return;
    }

    const { config } = this.state;

    this.pollingManager.start(
      config,
      {
        fetchMessages: async () => {
          await this._message?.fetchMessages();
        },
        fetchAnnouncements: async () => {
          await this._announcement?.fetchAndProcessAnnouncements();
        },
        handleSessionRefresh: async () => {
          await this.updateState();
        },
      },
      this.eventEmitter
    );
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
    if (this.state.status !== SdkStatus.SESSION_OPEN) {
      throw new Error('No session open. Call openSession() first.');
    }
    return this.state;
  }

  private async handleSessionPersist(): Promise<void> {
    if (this.state.status !== SdkStatus.SESSION_OPEN) return;

    const { onPersist, persistEncryptionKey, session } = this.state;
    if (!onPersist || !persistEncryptionKey) return;

    try {
      const blob = session.toEncryptedBlob(persistEncryptionKey);
      console.log(
        `[SessionPersist] Saving session blob (${blob.length} bytes)`
      );
      await onPersist(blob, persistEncryptionKey);
    } catch (error) {
      this.eventEmitter.emit(
        SdkEventType.ERROR,
        error instanceof Error ? error : new Error(String(error)),
        'session_persist'
      );
    }
  }

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
  private async resetStuckSendingMessages(): Promise<void> {
    try {
      const stuck = await getMessagesByStatus(MessageStatus.SENDING);

      for (const m of stuck) {
        await updateMessageById(m.id, {
          status: MessageStatus.WAITING_SESSION,
          encryptedMessage: null,
          seeker: null,
        });
      }

      if (stuck.length > 0) {
        console.log(
          `[GossipSdk] Reset ${stuck.length} stuck SENDING message(s) to WAITING_SESSION for auto-retry`
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
  /** Get a message by its ID */
  get(id: number): Promise<Message | undefined>;
  /** Get all messages for a contact */
  getMessages(contactUserId: string): Promise<Message[]>;
  /** Send a message */
  send(message: Omit<Message, 'id'>): Promise<SendMessageResult>;
  /** Fetch and decrypt messages from the protocol */
  fetch(): Promise<MessageResult>;
  /** Find a message by its messageId */
  findByMsgId(
    messageId: Uint8Array,
    ownerUserId: string,
    contactUserId?: string
  ): Promise<Message | undefined>;
  /** Mark a message as read */
  markAsRead(id: number): Promise<boolean>;
}

interface DiscussionServiceAPI {
  /** Start a new discussion with a contact */
  start(
    contact: Contact,
    payload?: AnnouncementPayload
  ): Promise<Result<DiscussionInitializationResult, Error>>;
  /** Accept an incoming discussion request */
  accept(discussion: Discussion): Promise<Result<Uint8Array, Error>>;
  /** Renew a broken discussion */
  renew(contactUserId: string): Promise<Result<Uint8Array, Error>>;
  /** Get the status of a discussion */
  getStatus(contactUserId: string): SessionStatus;
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
  /** Skip historical announcements for a new account. Call after profile creation. */
  skipHistorical(): Promise<void>;
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
export const gossipSdk = new GossipSdk();

// Also export the class for testing
export { GossipSdk };
