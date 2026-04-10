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
 * // Service API — ownerUserId handled internally via session
 * await gossipSdk.contacts.add(userId, 'Bob');              // fetches keys automatically
 * await gossipSdk.discussions.startByUserId(userId, 'Bob'); // add + start + send
 * await gossipSdk.messages.sendText(contactId, 'Hello!');   // build + send + flush
 * const contacts = await gossipSdk.contacts.list();         // ownerUserId inferred
 * const discussions = await gossipSdk.discussions.list();   // ownerUserId inferred
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
  IMessageProtocol,
  createMessageProtocol,
} from './api/messageProtocol/index.js';
import { createAuthProtocol } from './api/authProtocol.js';
import { setProtocolBaseUrl } from './config/protocol.js';
import {
  type SdkConfig,
  type DeepPartial,
  defaultSdkConfig,
  mergeConfig,
} from './config/sdk.js';
import {
  startWasmInitialization,
  ensureWasmInitialized,
} from './wasm/loader.js';
import { generateUserKeys, UserKeys } from './wasm/userKeys.js';
import { SessionModule } from './wasm/session.js';
import {
  EncryptionKey,
  generateEncryptionKeyFromSeed,
} from './wasm/encryption.js';
import { AnnouncementService } from './services/announcement.js';
import { DiscussionService } from './services/discussion.js';
import { MessageService } from './services/message.js';
import { RefreshService } from './services/refresh.js';
import { AuthService } from './services/auth.js';
import { ProfileService } from './services/profile.js';
import { ContactService } from './services/contact.js';
import { SelfMessageService } from './services/selfMessage.js';
import {
  validateUserIdFormat,
  type ValidationResult,
} from './utils/validation.js';
import { QueueManager } from './utils/queue.js';
import { encodeUserId, decodeUserId } from './utils/userId.js';
import { type StorageConfig, MessageStatus } from './db/index.js';
import { DatabaseConnection, SESSION_BLOB_NAMESPACE } from './db/sqlite.js';
import { Queries } from './db/queries/index.js';
import {
  type UserPublicKeys,
  type SessionConfig,
  SessionManagerWrapper,
} from './wasm/bindings.js';
import {
  SdkEventEmitter,
  SdkEventType,
  type SdkEvents,
} from './core/SdkEventEmitter.js';
import { SdkPolling } from './core/SdkPolling.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

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

  // Services — profile is created at init(), others at openSession()
  private _auth: AuthService | null = null;
  private _profile: ProfileService | null = null;
  private _announcement: AnnouncementService | null = null;
  private _discussion: DiscussionService | null = null;
  private _message: MessageService | null = null;
  private _refresh: RefreshService | null = null;
  private _contact: ContactService | null = null;
  private _selfMessage: SelfMessageService | null = null;

  // ─── Session persist debouncer ──────────────────────────────────
  //
  // The SessionModule WASM calls our persist callback before every network
  // send. Each persist writes the (growing) session blob to userProfile via
  // the encrypted SQLite VFS, which costs 400-500 ms per call. Awaiting it
  // synchronously inside sendMessage adds ~1.4 s of latency per message.
  //
  // Instead, we coalesce: the callback returns immediately, marks the
  // state dirty, and schedules a flush 500 ms later. The latest blob
  // overrides any previous queued blob (debouncing), so a burst of N
  // sendMessage calls produces at most one persist per 500 ms window.
  //
  // `closeSession()` calls `flushSessionPersistSync()` to drain the
  // pending state synchronously before destroying the session, so we
  // never lose data on a graceful shutdown. On a crash, we lose at most
  // 500 ms of session state — recoverable via re-fetching announcements.
  private static readonly PERSIST_DEBOUNCE_MS = 500;
  private _persistDirty = false;
  private _persistInFlight = false;
  private _persistTimer: ReturnType<typeof setTimeout> | null = null;
  private _persistInFlightPromise: Promise<void> | null = null;

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

    // Defer queries/profile when the database needs an unlock first.
    if (this._conn.isOpen) {
      this._queries = new Queries(this._conn);
    }

    console.log('[GossipSdk] SQLite initialized');
    // Create message protocol
    const messageProtocol = createMessageProtocol();

    // Create services that don't need a session
    this._auth = new AuthService(createAuthProtocol());
    this._profile = this._queries ? new ProfileService(this._queries) : null;

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

    // Create session with persistence callback.
    //
    // The callback is awaited by the session module before each network
    // send. We coalesce persists into a 500 ms-debounced background flush
    // so the await resolves instantly: `handleSessionPersist` only marks
    // the state dirty and schedules the actual write. See the
    // `_persistDirty`/`flushPersist` machinery below and `closeSession`
    // for the synchronous drain.
    const session = new SessionModule(
      userKeys,
      async () => {
        this.handleSessionPersist();
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

    this._discussion.setMessageService(this._message);

    this._refresh = new RefreshService(
      this._message,
      this._discussion,
      this._announcement,
      session,
      this.eventEmitter,
      queries,
      this.config
    );

    this._selfMessage = new SelfMessageService(
      queries,
      session.userIdEncoded,
      encryptionKey
    );
    await this._selfMessage.ensureDiscussionExists();

    // Publish gossip ID (public key) on messageProtocol so the user is discoverable.
    // Non-blocking: login must succeed even when the API is unreachable.
    this._auth!.publishPublicKey(
      session.ourPk,
      session.userIdEncoded,
      queries
    ).catch(err => {
      this.eventEmitter.emit(SdkEventType.ERROR, {
        error: err instanceof Error ? err : new Error(String(err)),
        context: 'publishPublicKey',
      });
    });
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

    // Wire up cross-service dependencies
    this._contact = new ContactService(session, queries, this._auth!);
    this._message.setQueueManager(this.messageQueues);
    this._discussion.setAuthService(this._auth!);

    // Auto-start polling if enabled in config
    if (config.polling.enabled) {
      this.startPolling();
    }
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

    // Drain any pending session persist before tearing down state.
    // The debounced background flush may have queued writes that haven't
    // run yet; this guarantees durability on graceful shutdown.
    await this.flushSessionPersistSync();

    // Cleanup session
    this.state.session.cleanup();

    // Free the encryption key WASM object to zero its memory before dropping
    this.state.encryptionKey?.free();

    // Clear services
    this._announcement = null;
    this._discussion = null;
    this._message = null;
    this._refresh = null;
    this._contact = null;
    this._selfMessage = null;

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

  /** Delete only the data belonging to a specific account. */
  async clearAccountData(userId: string): Promise<void> {
    if (!this._conn) {
      throw new Error('SDK not initialized. Call init() first.');
    }
    await this._conn.clearAccountData(userId);
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
  // Secure storage
  // ─────────────────────────────────────────────────────────────────

  get isSecureStorage(): boolean {
    return this._conn?.isSecureStorage ?? false;
  }

  /** True when migrations have run and Drizzle is ready to query. */
  get dbReady(): boolean {
    return this._queries !== null;
  }

  get needsUnlock(): boolean {
    return this._conn?.needsUnlock ?? false;
  }

  private requireConn(): DatabaseConnection {
    if (!this._conn) {
      throw new Error('SDK not initialized. Call init() first.');
    }
    return this._conn;
  }

  async secureStorageProvision(): Promise<void> {
    await this.requireConn().secureStorageProvision();
  }

  async secureStorageAllocate(slot: number, password: string): Promise<void> {
    const conn = this.requireConn();
    await conn.secureStorageAllocate(slot, password);
    if (!this._queries) {
      this._queries = new Queries(conn);
      this._profile = new ProfileService(this._queries);
    }
  }

  async secureStorageUnlock(password: string): Promise<boolean> {
    const conn = this.requireConn();
    const ok = await conn.secureStorageUnlock(password);
    if (ok && !this._queries) {
      this._queries = new Queries(conn);
      this._profile = new ProfileService(this._queries);
    }
    return ok;
  }

  async secureStorageLock(): Promise<void> {
    await this.requireConn().secureStorageLock();
    this._queries = null;
    this._profile = null;
  }

  /** Force-flush dirty encrypted blocks to the backing store. */
  async flush(): Promise<void> {
    if (this._conn?.isSecureStorage) {
      await this._conn.secureStorageFlush();
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // Session blob persistence (secure-storage namespace fast path)
  // ─────────────────────────────────────────────────────────────────
  //
  // On the secureStorage backend, the session blob lives in its own
  // block-level namespace (SESSION_BLOB_NAMESPACE = 1) instead of being
  // stored as a column in the userProfile SQL row. This bypasses
  // SQLite/Drizzle/page-management on every persist and lets the blob
  // grow without inflating the SQL row size.
  //
  // On the wa-sqlite path these methods return null/undefined and
  // callers must continue to use `userProfile.session` round-tripping.

  /**
   * True when the SDK should route session blob persistence through
   * the secure-storage namespace API instead of the SQL profile row.
   */
  get usesSessionBlobNamespace(): boolean {
    return this._conn?.isSecureStorage ?? false;
  }

  /**
   * Persist the encrypted session blob into the secure-storage session
   * blob namespace. No-op on the wa-sqlite backend (caller is expected
   * to fall back to `profiles.save` with `session` set).
   *
   * The full blob replaces any previous content (write at offset 0 +
   * truncate the namespace if the new blob is shorter).
   */
  async persistSessionBlob(blob: Uint8Array): Promise<void> {
    const conn = this._conn;
    if (!conn?.isSecureStorage) return;
    const previousLen = await conn.secureStorageNamespaceDataLength(
      SESSION_BLOB_NAMESPACE
    );
    if (blob.length < previousLen) {
      // Shrink first so stale tail bytes don't survive in the namespace.
      await conn.secureStorageClearNamespace(SESSION_BLOB_NAMESPACE);
    }
    await conn.secureStorageWriteNamespaceData(SESSION_BLOB_NAMESPACE, 0, blob);
  }

  /**
   * Read the encrypted session blob from the secure-storage namespace.
   * Returns `null` on the wa-sqlite backend or when the namespace is empty.
   */
  async readSessionBlob(): Promise<Uint8Array | null> {
    const conn = this._conn;
    if (!conn?.isSecureStorage) return null;
    const len = await conn.secureStorageNamespaceDataLength(
      SESSION_BLOB_NAMESPACE
    );
    if (len === 0) return null;
    return conn.secureStorageReadNamespaceData(SESSION_BLOB_NAMESPACE, 0, len);
  }

  /** Truncate the session blob namespace (e.g. on account reset). */
  async clearSessionBlob(): Promise<void> {
    const conn = this._conn;
    if (!conn?.isSecureStorage) return;
    await conn.secureStorageClearNamespace(SESSION_BLOB_NAMESPACE);
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
  get profiles(): ProfileService {
    if (!this._profile) {
      throw new Error('SDK not initialized. Call init() first.');
    }
    return this._profile;
  }

  /** Message service */
  get messages(): MessageService {
    this.requireSession();
    if (!this._message) {
      throw new Error('Message service not initialized');
    }
    return this._message;
  }

  /** Discussion service */
  get discussions(): DiscussionService {
    this.requireSession();
    if (!this._discussion) {
      throw new Error('Discussion service not initialized');
    }
    return this._discussion;
  }

  /** Announcement service */
  get announcements(): AnnouncementService {
    this.requireSession();
    if (!this._announcement) {
      throw new Error('Announcement service not initialized');
    }
    return this._announcement;
  }

  /** Contact management */
  get contacts(): ContactService {
    this.requireSession();
    if (!this._contact) {
      throw new Error('Contact service not initialized');
    }
    return this._contact;
  }

  /** Self-message service */
  get selfMessages(): SelfMessageService {
    this.requireSession();
    if (!this._selfMessage) {
      throw new Error('Self-message service not initialized');
    }
    return this._selfMessage;
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
        refreshSessionsStatusEvent: async () => {
          await this._refresh?.refreshSessionsStatusEvent();
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
  on<K extends SdkEventType>(
    event: K,
    handler: (payload: SdkEvents[K]) => void
  ): void {
    this.eventEmitter.on(event, handler);
  }

  /**
   * Remove an event handler
   */
  off<K extends SdkEventType>(
    event: K,
    handler: (payload: SdkEvents[K]) => void
  ): void {
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

  /**
   * Mark the session state dirty and schedule a debounced background
   * flush. Returns synchronously — the caller (`SessionModule` callback)
   * does NOT wait for the actual persist to complete.
   *
   * Behaviour:
   *   * If a flush is already in flight, just mark dirty; the in-flight
   *     handler will reschedule itself when it completes.
   *   * If a timer is already pending, do nothing — the next tick will
   *     pick up the latest state.
   *   * Otherwise, arm a timer for `PERSIST_DEBOUNCE_MS` and return.
   */
  private handleSessionPersist(): void {
    if (this.state.status !== SdkStatus.SESSION_OPEN) return;

    // A/B test escape hatch: skip the entire pipeline if the debug flag
    // is set in the dev console. WARNING: if the app crashes/reloads
    // while this is on, the session state is lost.
    if (
      typeof globalThis !== 'undefined' &&
      (globalThis as { __DISABLE_SESSION_PERSIST?: boolean })
        .__DISABLE_SESSION_PERSIST
    ) {
      console.log('[SessionPersist] SKIPPED (debug flag)');
      return;
    }

    this._persistDirty = true;

    if (this._persistInFlight) return;
    if (this._persistTimer !== null) return;

    this._persistTimer = setTimeout(() => {
      this._persistTimer = null;
      void this.flushPersist();
    }, GossipSdk.PERSIST_DEBOUNCE_MS);
  }

  /**
   * Run a single persist cycle: snapshot the latest blob, write it
   * through `onPersist`, and reschedule another flush if more changes
   * arrived during the write.
   */
  private async flushPersist(): Promise<void> {
    if (this.state.status !== SdkStatus.SESSION_OPEN) return;
    if (!this._persistDirty) return;

    this._persistInFlight = true;
    this._persistDirty = false;

    const promise = (async () => {
      if (this.state.status !== SdkStatus.SESSION_OPEN) return;
      const { onPersist, encryptionKey, session } = this.state;
      if (!onPersist || !encryptionKey) return;

      try {
        const t0 = performance.now();
        const blob = session.toEncryptedBlob(encryptionKey);
        const tBlob = performance.now();
        await onPersist(blob, encryptionKey);
        const tDone = performance.now();
        console.log(
          `[SessionPersist] ${blob.length}B blob=${(tBlob - t0).toFixed(0)}ms write=${(tDone - tBlob).toFixed(0)}ms total=${(tDone - t0).toFixed(0)}ms (deferred)`
        );
      } catch (error) {
        // Re-mark dirty so the next tick retries.
        this._persistDirty = true;
        this.eventEmitter.emit(
          SdkEventType.ERROR,
          error instanceof Error ? error : new Error(String(error)),
          'session_persist'
        );
      }
    })();

    this._persistInFlightPromise = promise;
    await promise;
    this._persistInFlightPromise = null;
    this._persistInFlight = false;

    // If state changed during the flush, schedule another tick.
    if (
      this._persistDirty &&
      this._persistTimer === null &&
      this.state.status === SdkStatus.SESSION_OPEN
    ) {
      this._persistTimer = setTimeout(() => {
        this._persistTimer = null;
        void this.flushPersist();
      }, GossipSdk.PERSIST_DEBOUNCE_MS);
    }
  }

  /**
   * Drain any pending persist synchronously. Called by `closeSession`
   * before destroying session state to guarantee durability on graceful
   * shutdown. Cancels any pending timer, awaits the in-flight write
   * (if any), and runs one final synchronous flush if state is still
   * dirty.
   */
  private async flushSessionPersistSync(): Promise<void> {
    if (this._persistTimer !== null) {
      clearTimeout(this._persistTimer);
      this._persistTimer = null;
    }
    if (this._persistInFlightPromise) {
      await this._persistInFlightPromise;
    }
    if (this._persistDirty) {
      await this.flushPersist();
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

interface SdkUtils {
  /** Validate a user ID format */
  validateUserId(userId: string): ValidationResult;
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
// Exports
// ─────────────────────────────────────────────────────────────────────────────

/** A convenience singleton for apps that only need one SDK instance. */
export const gossipSdk = new GossipSdk();

export { GossipSdk, SdkEventType };
