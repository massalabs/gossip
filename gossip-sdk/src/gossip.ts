/**
 * GossipSdk - SDK with clean lifecycle API
 *
 * @example
 * ```typescript
 * import { gossipSdk } from '@massalabs/gossip-sdk';
 *
 * // Initialize once at app startup
 * await gossipSdk.init({
 *   protocolBaseUrl: 'https://api.example.com',
 *   storage: { type: 'idb', name: 'gossip-db' },
 * });
 *
 * // Open session (login)
 * await gossipSdk.openSession({
 *   mnemonic: 'word1 word2 ...',
 *   onPersist: async (blob) => { /* save to db *\/ },
 * });
 *
 * // Simplified API — ownerUserId and boilerplate handled internally
 * await gossipSdk.contacts.add(userId, 'Bob');           // fetches keys automatically
 * await gossipSdk.discussions.startByUserId(userId, 'Bob'); // add + start + send
 * await gossipSdk.messages.sendText(contactId, 'Hello!');   // build + send + flush
 * const contacts = await gossipSdk.contacts.list();       // ownerUserId inferred
 * const discussions = await gossipSdk.discussions.list();  // ownerUserId inferred
 *
 * // Full control API still available
 * await gossipSdk.messages.send(fullMessageObject);
 * await gossipSdk.discussions.start(contact, payload);
 * await gossipSdk.contacts.add(ownerUserId, userId, name, publicKeys);
 *
 * // Events
 * gossipSdk.on(SdkEventType.MESSAGE_RECEIVED, (msg) => { ... });
 * gossipSdk.on(SdkEventType.SESSION_REQUESTED, (discussion, contact) => { ... });
 *
 * // Logout
 * await gossipSdk.closeSession();
 * ```
 */
import {
  toDiscussion,
  toSortedDiscussions,
  updateDiscussionName,
  type UpdateDiscussionNameResult,
} from './utils/discussions';
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
  EncryptionKey,
  generateEncryptionKeyFromSeed,
} from './wasm/encryption';
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
  validateUsernameFormatAndAvailability,
  type ValidationResult,
} from './utils/validation';
import { QueueManager } from './utils/queue';
import { encodeUserId, decodeUserId } from './utils/userId';
import {
  type StorageConfig,
  type Contact,
  type Discussion,
  type Message,
  type UserProfile,
  MessageStatus,
  MessageType,
  MessageDirection,
} from './db';
import { DatabaseConnection } from './db/sqlite';
import { Queries, rowToUserProfile, userProfileToRow } from './db/queries';
import { addContact, updateContactName, deleteContact } from './utils/contacts';
import {
  type UserPublicKeys,
  type SessionConfig,
  SessionManagerWrapper,
  SessionStatus,
} from './wasm/bindings';
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
  /** SQLite storage backend. Defaults to in-memory. */
  storage?: StorageConfig;
}

export interface OpenSessionOptions {
  /** BIP39 mnemonic phrase */
  mnemonic: string;
  /** Existing encrypted session blob (for restoring session) */
  encryptedSession?: Uint8Array;
  /** Encryption key for decrypting session and storage. Will be created if not provided. */
  encryptionKey?: EncryptionKey;
  /** Callback when session state changes (for persistence) */
  onPersist?: (
    encryptedBlob: Uint8Array,
    encryptionKey: EncryptionKey
  ) => Promise<void>;
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
  encryptionKey?: EncryptionKey;
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

  // Database — each instance owns its own connection + query set
  private _conn: DatabaseConnection | null = null;
  private _queries: Queries | null = null;

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
  async init(options: GossipSdkInitOptions): Promise<GossipSdk> {
    if (this.state.status !== SdkStatus.UNINITIALIZED) {
      console.warn('[GossipSdk] Already initialized');
      return this;
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
    this._conn = await DatabaseConnection.create({ storage: options.storage });
    this._queries = new Queries(this._conn);

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

    return this;
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

    // Derive encryption key from mnemonic when not provided
    const encryptionKey =
      options.encryptionKey ??
      (await generateEncryptionKeyFromSeed(
        options.mnemonic,
        new Uint8Array(32).fill(0)
      ));

    const { messageProtocol } = this.state;

    // Ensure WASM is ready
    await ensureWasmInitialized();

    // Validate that encryptedSession can be decrypted with the provided key
    if (options.encryptedSession) {
      try {
        const sessionManager = SessionManagerWrapper.from_encrypted_blob(
          options.encryptedSession,
          encryptionKey
        );
        // We only create this wrapper for validation, free it immediately
        sessionManager.free();
      } catch {
        throw new Error(
          '[GossipSdk] Failed to load encrypted session. Please provide a valid encryptedSession and encryptionKey.'
        );
      }
    }

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
    if (options.encryptedSession) {
      session.load(options.encryptedSession, encryptionKey);
    }

    // Get config from initialized state
    const { config } = this.state;

    // Create services with config (refreshService will be set after creation)
    const queries = this._queries!;

    this._announcement = new AnnouncementService(
      messageProtocol,
      session,
      this.eventEmitter,
      config,
      queries
    );

    this._discussion = new DiscussionService(
      this._announcement,
      session,
      this.eventEmitter,
      queries
    );

    this._message = new MessageService(
      messageProtocol,
      session,
      this.eventEmitter,
      config,
      queries
    );

    this._refresh = new RefreshService(
      this._message,
      this._discussion,
      this._announcement,
      session,
      this.eventEmitter,
      queries
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
    await this.resetStuckSendingMessages(session.userIdEncoded);

    // Update SDK state to reflect the newly opened session.
    this.state = {
      status: SdkStatus.SESSION_OPEN,
      messageProtocol,
      config,
      session,
      userKeys,
      encryptionKey,
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
    const getOwner = () => this.requireSession().session.userIdEncoded;

    const q = this._queries!;

    this._messagesAPI = {
      get: async id => {
        const row = await q.messages.getById(id);
        return row ? rowToMessage(row) : undefined;
      },
      getMessages: async contactUserId => {
        const rows = await q.messages.getByOwnerAndContact(
          getOwner(),
          contactUserId
        );
        return rows.map(rowToMessage);
      },
      send: message =>
        this.messageQueues.enqueue(message.contactUserId, () =>
          this._message!.sendMessage(message)
        ),
      sendText: async (contactUserId, text, options) => {
        const message: Omit<Message, 'id'> = {
          ownerUserId: getOwner(),
          contactUserId,
          content: text,
          type: MessageType.TEXT,
          direction: MessageDirection.OUTGOING,
          status: MessageStatus.WAITING_SESSION,
          timestamp: new Date(),
          ...(options?.replyTo && { replyTo: options.replyTo }),
          ...(options?.metadata && { metadata: options.metadata }),
        };
        const result = await this.messageQueues.enqueue(contactUserId, () =>
          this._message!.sendMessage(message)
        );
        await this._refresh?.stateUpdate();
        return result;
      },
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
      start: async (contact, payload?) => {
        const result = await this._discussion!.initialize(contact, payload);
        if (result.success) await this._refresh?.stateUpdate();
        return result;
      },
      startByUserId: async (contactUserId, name, payload?) => {
        const pubKeys = await this._auth!.fetchPublicKeyByUserId(contactUserId);
        const owner = getOwner();
        const existing = await q.contacts.getByOwnerAndUser(
          owner,
          contactUserId
        );
        let contact: Contact;
        if (existing) {
          contact = existing;
        } else {
          const addResult = await addContact(
            owner,
            contactUserId,
            name,
            pubKeys,
            q
          );
          if (!addResult.success || !addResult.contact)
            return {
              success: false,
              error: new Error(addResult.error ?? 'Failed to add contact'),
            } as Result<DiscussionInitializationResult, Error>;
          contact = addResult.contact;
        }
        const result = await this._discussion!.initialize(contact, payload);
        if (result.success) await this._refresh?.stateUpdate();
        return result;
      },
      accept: async (discussion: Discussion) => {
        const result = await this._discussion!.accept(discussion);
        if (result.success) await this._refresh?.stateUpdate();
        return result;
      },
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
      list: async (ownerUserId?) => {
        const all = await q.discussions.getByOwner(ownerUserId ?? getOwner());
        return toSortedDiscussions(all);
      },
      get: async (ownerUserIdOrContactId: string, contactUserId?: string) => {
        const owner = contactUserId ? ownerUserIdOrContactId : getOwner();
        const contact = contactUserId ?? ownerUserIdOrContactId;
        const row = await q.discussions.getByOwnerAndContact(owner, contact);
        return row ? toDiscussion(row) : undefined;
      },
      updateName: (discussionId: number, name: string | undefined) =>
        updateDiscussionName(discussionId, name, q),
    };

    this._announcementsAPI = {
      fetch: () => this._announcement!.fetchAndProcessAnnouncements(),
      skipHistorical: () => this._announcement!.skipHistoricalAnnouncements(),
    };

    this._contactsAPI = {
      list: (ownerUserId?: string) =>
        q.contacts.getByOwner(ownerUserId ?? getOwner()),
      get: async (ownerUserIdOrContactId: string, contactUserId?: string) => {
        const owner = contactUserId ? ownerUserIdOrContactId : getOwner();
        const contact = contactUserId ?? ownerUserIdOrContactId;
        return (await q.contacts.getByOwnerAndUser(owner, contact)) ?? null;
      },
      add: async (
        ownerUserIdOrUserId: string,
        userIdOrName: string,
        nameOrPublicKeys?: string | UserPublicKeys,
        publicKeys?: UserPublicKeys
      ) => {
        if (typeof nameOrPublicKeys === 'string') {
          return addContact(
            ownerUserIdOrUserId,
            userIdOrName,
            nameOrPublicKeys,
            publicKeys!,
            q
          );
        }
        const userId = ownerUserIdOrUserId;
        const name = userIdOrName;
        const owner = getOwner();
        const pubKeys =
          nameOrPublicKeys ??
          (await this._auth!.fetchPublicKeyByUserId(userId));
        return addContact(owner, userId, name, pubKeys, q);
      },
      updateName: async (
        ownerUserIdOrContactId: string,
        contactUserIdOrName: string,
        newName?: string
      ) => {
        const owner = newName ? ownerUserIdOrContactId : getOwner();
        const contact = newName ? contactUserIdOrName : ownerUserIdOrContactId;
        const name = newName ?? contactUserIdOrName;
        return updateContactName(owner, contact, name, q);
      },
      delete: async (
        ownerUserIdOrContactId: string,
        contactUserId?: string
      ) => {
        const owner = contactUserId ? ownerUserIdOrContactId : getOwner();
        const contact = contactUserId ?? ownerUserIdOrContactId;
        return deleteContact(owner, contact, session, q);
      },
    };
  }

  /**
   * Close the current session (logout).
   * The database connection is kept open so a new session can be opened.
   * Call `destroy()` to release the database connection entirely.
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

  /**
   * Close the session and release the database connection.
   * After calling this, the instance cannot be reused — create a new one.
   */
  async destroy(): Promise<void> {
    await this.closeSession();
    this._queries = null;
    if (this._conn) {
      await this._conn.close();
      this._conn = null;
    }
    this.state = { status: SdkStatus.UNINITIALIZED };
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

  get queries(): Queries {
    if (!this._queries) {
      throw new Error('SDK not initialized. Call init() first.');
    }
    return this._queries;
  }

  /** Clear all database tables. */
  async clearAllTables(): Promise<void> {
    if (!this._conn) {
      throw new Error('SDK not initialized. Call init() first.');
    }
    await this._conn.clearAllTables();
  }

  /** Clear only conversation-related tables (messages, discussions, contacts). */
  async clearConversationTables(): Promise<void> {
    if (!this._conn) {
      throw new Error('SDK not initialized. Call init() first.');
    }
    await this._conn.clearConversationTables();
  }

  /**
   * Get encrypted session blob for persistence.
   * Throws if no session is open.
   */
  getEncryptedSession(): Uint8Array {
    const state = this.requireSession();
    if (!state.encryptionKey) {
      throw new Error('No encryption key found. Call openSession() first.');
    }
    return state.session.toEncryptedBlob(state.encryptionKey);
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

  /** User profile management (available after init, before session) */
  get profiles(): ProfilesAPI {
    const q = this.queries;
    return {
      get: async (userId: string) => {
        const row = await q.userProfiles.getById(userId);
        return row ? rowToUserProfile(row) : null;
      },
      getMostRecent: async () => {
        const row = await q.userProfiles.getMostRecent();
        return row ? rowToUserProfile(row) : null;
      },
      getAll: async () => {
        const rows = await q.userProfiles.getAll();
        return rows.map(rowToUserProfile);
      },
      getCount: () => q.userProfiles.getCount(),
      save: async (profile: UserProfile) => {
        await q.userProfiles.upsert(userProfileToRow(profile));
      },
      delete: (userId: string) => q.userProfiles.delete(userId),
      validateUsername: (username: string) =>
        validateUsernameFormatAndAvailability(username, q),
      isUsernameTaken: async (username: string, excludeUserId?: string) => {
        const match = excludeUserId
          ? await q.userProfiles.getByUsernameLowerExcluding(
              username,
              excludeUserId
            )
          : await q.userProfiles.getByUsernameLower(username);
        return !!match;
      },
      createOrUpdate: async (
        username: string,
        userId: string,
        security: UserProfile['security'],
        session: Uint8Array
      ): Promise<UserProfile> => {
        const existing = await q.userProfiles.getById(userId);
        if (existing) {
          const existingProfile = rowToUserProfile(existing);
          const mergedSecurity: UserProfile['security'] = {
            ...existingProfile.security,
            ...security,
            webauthn: security.webauthn ?? existingProfile.security.webauthn,
            encKeySalt:
              security.encKeySalt ?? existingProfile.security.encKeySalt,
            mnemonicBackup: security.mnemonicBackup,
          };
          const updatedProfile: UserProfile = {
            ...existingProfile,
            username: existingProfile.username || username,
            security: mergedSecurity,
            session,
            status: existingProfile.status ?? 'online',
            lastSeen: new Date(),
            updatedAt: new Date(),
          };
          await q.userProfiles.upsert(userProfileToRow(updatedProfile));
          return updatedProfile;
        }

        const newProfile: UserProfile = {
          userId,
          username,
          security,
          session,
          status: 'online',
          lastSeen: new Date(),
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        await q.userProfiles.upsert(userProfileToRow(newProfile));
        return newProfile;
      },
    };
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

  /** Utility functions (pure — no DB access) */
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

    const { onPersist, encryptionKey, session } = this.state;
    if (!onPersist || !encryptionKey) return;

    try {
      const blob = session.toEncryptedBlob(encryptionKey);
      console.log(
        `[SessionPersist] Saving session blob (${blob.length} bytes)`
      );
      await onPersist(blob, encryptionKey);
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
  private async resetStuckSendingMessages(ownerUserId: string): Promise<void> {
    try {
      const q = this._queries!;
      const stuck = await q.messages.getByStatus(
        ownerUserId,
        MessageStatus.SENDING
      );

      for (const m of stuck) {
        await q.messages.updateById(m.id, {
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

/** Options for the simplified sendText method */
export interface SendTextOptions {
  /** Reply to an existing message */
  replyTo?: { originalMsgId: Uint8Array };
  /** Arbitrary metadata to attach */
  metadata?: Record<string, unknown>;
}

interface MessageServiceAPI {
  /** Get a message by its ID */
  get(id: number): Promise<Message | undefined>;
  /** Get all messages for a contact */
  getMessages(contactUserId: string): Promise<Message[]>;
  /** Send a message (full control — you build the Message object) */
  send(message: Omit<Message, 'id'>): Promise<SendMessageResult>;
  /**
   * Send a text message (simplified).
   * Builds the Message internally, sends it, and triggers state update.
   *
   * @example
   * ```typescript
   * await sdk.messages.sendText(contactId, 'Hello!');
   * ```
   */
  sendText(
    contactUserId: string,
    text: string,
    options?: SendTextOptions
  ): Promise<SendMessageResult>;
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
  /**
   * Start a new discussion with a contact.
   * Automatically triggers state update to broadcast the announcement.
   */
  start(
    contact: Contact,
    payload?: AnnouncementPayload
  ): Promise<Result<DiscussionInitializationResult, Error>>;
  /**
   * Start a discussion by userId (simplified).
   * Fetches public keys from the server, adds the contact if needed,
   * starts the discussion, and triggers state update.
   *
   * @example
   * ```typescript
   * await sdk.discussions.startByUserId(contactId, 'Bob', { message: 'Hey!' });
   * ```
   */
  startByUserId(
    contactUserId: string,
    name: string,
    payload?: AnnouncementPayload
  ): Promise<Result<DiscussionInitializationResult, Error>>;
  /**
   * Accept an incoming discussion request.
   * Automatically triggers state update to broadcast the acceptance.
   */
  accept(discussion: Discussion): Promise<Result<Uint8Array, Error>>;
  /** Renew a broken discussion */
  renew(contactUserId: string): Promise<Result<Uint8Array, Error>>;
  /** Get the session status with a contact */
  getStatus(contactUserId: string): SessionStatus;
  /** List all discussions. ownerUserId defaults to the current user. */
  list(ownerUserId?: string): Promise<Discussion[]>;
  /**
   * Get a specific discussion.
   * Can be called as `get(contactUserId)` or `get(ownerUserId, contactUserId)`.
   */
  get(contactUserId: string): Promise<Discussion | undefined>;
  get(
    ownerUserId: string,
    contactUserId: string
  ): Promise<Discussion | undefined>;
  /** Update the custom name of a discussion. Pass undefined to clear. */
  updateName(
    discussionId: number,
    name: string | undefined
  ): Promise<UpdateDiscussionNameResult>;
}

interface AnnouncementServiceAPI {
  /** Fetch and process announcements from the protocol */
  fetch(): Promise<AnnouncementReceptionResult>;
  /** Skip historical announcements for a new account. Call after profile creation. */
  skipHistorical(): Promise<void>;
}

interface ContactsAPI {
  /** List all contacts. ownerUserId defaults to the current user. */
  list(ownerUserId?: string): Promise<Contact[]>;
  /**
   * Get a specific contact.
   * Can be called as `get(contactUserId)` or `get(ownerUserId, contactUserId)`.
   */
  get(contactUserId: string): Promise<Contact | null>;
  get(ownerUserId: string, contactUserId: string): Promise<Contact | null>;
  /**
   * Add a new contact.
   *
   * Simplified: `add(userId, name)` — fetches public keys from the server automatically.
   * Full control: `add(ownerUserId, userId, name, publicKeys)`.
   */
  add(
    userId: string,
    name: string
  ): Promise<{ success: boolean; error?: string; contact?: Contact }>;
  add(
    ownerUserId: string,
    userId: string,
    name: string,
    publicKeys: UserPublicKeys
  ): Promise<{ success: boolean; error?: string; contact?: Contact }>;
  /** Update a contact's name. Can be called as `updateName(contactUserId, newName)` or `updateName(ownerUserId, contactUserId, newName)`. */
  updateName(
    contactUserId: string,
    newName: string
  ): Promise<UpdateContactNameResult>;
  updateName(
    ownerUserId: string,
    contactUserId: string,
    newName: string
  ): Promise<UpdateContactNameResult>;
  /** Delete a contact. Can be called as `delete(contactUserId)` or `delete(ownerUserId, contactUserId)`. */
  delete(contactUserId: string): Promise<DeleteContactResult>;
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

interface ProfilesAPI {
  /** Get a user profile by ID. Returns null if not found. */
  get(userId: string): Promise<UserProfile | null>;
  /** Get the most recently active profile (by lastSeen). */
  getMostRecent(): Promise<UserProfile | null>;
  /** Get all user profiles. */
  getAll(): Promise<UserProfile[]>;
  /** Get the total number of profiles. */
  getCount(): Promise<number>;
  /** Save (upsert) a user profile. Handles domain-to-row conversion internally. */
  save(profile: UserProfile): Promise<void>;
  /** Delete a user profile by ID. */
  delete(userId: string): Promise<void>;
  /** Validate username format and check availability in one call. */
  validateUsername(username: string): Promise<ValidationResult>;
  /** Check if a username is already taken, optionally excluding a specific user. */
  isUsernameTaken(username: string, excludeUserId?: string): Promise<boolean>;
  /**
   * Create a new profile or update an existing one.
   * If a profile already exists for this userId, merges security fields and preserves existing username.
   */
  createOrUpdate(
    username: string,
    userId: string,
    security: UserProfile['security'],
    session: Uint8Array
  ): Promise<UserProfile>;
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
// Exports
// ─────────────────────────────────────────────────────────────────────────────

/** A convenience singleton for apps that only need one SDK instance. */
export const gossipSdk = new GossipSdk();

export { GossipSdk };
