/**
 * Storage backend interface - the main contract for storage implementations.
 *
 * Built-in implementations:
 * - DexieBackend: IndexedDB via Dexie (browser only, no encryption)
 * - EncryptedSqliteBackend: SQLite with plausible deniability (browser + Node)
 *
 * Users can inject custom implementations (Postgres, MongoDB, etc.)
 */

import type {
  IContactRepository,
  IMessageRepository,
  IDiscussionRepository,
  IUserProfileRepository,
  IPendingMessageRepository,
  IPendingAnnouncementRepository,
  IActiveSeekerRepository,
} from './repositories';

export type BackendType = 'encrypted-sqlite' | 'dexie' | 'custom';

export interface IStorageBackend {
  /**
   * Backend identifier
   */
  readonly type: BackendType | string;

  /**
   * Human-readable name
   */
  readonly name: string;

  // ============ Lifecycle ============

  /**
   * Initialize the backend (create tables, load WASM, etc.)
   */
  initialize(): Promise<void>;

  /**
   * Close the backend and release resources
   */
  close(): Promise<void>;

  /**
   * Delete all data
   */
  deleteAll(): Promise<void>;

  /**
   * Check if backend is initialized and ready
   */
  isReady(): boolean;

  // ============ Encryption (optional) ============

  /**
   * Whether this backend supports encryption
   */
  isEncrypted(): boolean;

  /**
   * Create a new encrypted session (first-time setup)
   * @throws if backend doesn't support encryption
   */
  createSession?(password: string): Promise<void>;

  /**
   * Unlock an existing encrypted session
   * @returns true if unlock succeeded, false if wrong password
   * @throws if backend doesn't support encryption
   */
  unlockSession?(password: string): Promise<boolean>;

  /**
   * Lock the session (clear decryption keys from memory)
   * @throws if backend doesn't support encryption
   */
  lockSession?(): Promise<void>;

  /**
   * Check if session is currently unlocked
   */
  isUnlocked?(): boolean;

  /**
   * Change the session password
   * @throws if backend doesn't support encryption
   */
  changePassword?(oldPassword: string, newPassword: string): Promise<boolean>;

  // ============ Repositories ============

  /**
   * Contact repository
   */
  readonly contacts: IContactRepository;

  /**
   * Message repository
   */
  readonly messages: IMessageRepository;

  /**
   * Discussion repository
   */
  readonly discussions: IDiscussionRepository;

  /**
   * User profile repository
   */
  readonly userProfile: IUserProfileRepository;

  /**
   * Pending encrypted messages repository
   */
  readonly pendingMessages: IPendingMessageRepository;

  /**
   * Pending announcements repository
   */
  readonly pendingAnnouncements: IPendingAnnouncementRepository;

  /**
   * Active seekers repository
   */
  readonly activeSeekers: IActiveSeekerRepository;
}

/**
 * Options for creating a storage backend
 */
export interface StorageBackendOptions {
  /**
   * Backend type to use
   */
  type: BackendType;

  /**
   * Password for encrypted backends
   */
  password?: string;

  /**
   * Runtime mode override (auto-detected by default)
   */
  runtimeMode?: 'worker' | 'sync' | 'auto';

  /**
   * Custom database path (for Node.js file-based backends)
   */
  dbPath?: string;

  /**
   * Enable debug logging
   */
  debug?: boolean;
}
