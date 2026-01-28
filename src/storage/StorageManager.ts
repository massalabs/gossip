/**
 * StorageManager - Orchestrates storage backend selection and access.
 *
 * Provides a unified interface for storage operations regardless of the
 * underlying backend (Dexie, EncryptedSqlite, custom).
 *
 * Usage:
 * ```typescript
 * // Option 1: Use built-in encrypted backend
 * const storage = await StorageManager.create({
 *   type: 'encrypted-sqlite',
 *   password: 'user-password'
 * });
 *
 * // Option 2: Inject custom backend
 * const storage = await StorageManager.create({
 *   backend: myCustomBackend
 * });
 *
 * // Access repositories
 * const contacts = await storage.contacts.getByOwner(userId);
 *
 * // Lock/unlock for encrypted backends
 * await storage.lock();
 * await storage.unlock('password');
 * ```
 */

import type {
  IStorageBackend,
  IStorageAdapter,
  BackendType,
  IContactRepository,
  IMessageRepository,
  IDiscussionRepository,
  IUserProfileRepository,
  IPendingMessageRepository,
  IPendingAnnouncementRepository,
  IActiveSeekerRepository,
} from './interfaces';
import {
  detectCapabilities,
  getBestRuntimeType,
  supportsEncryptedSqlite,
  supportsDexie,
} from './runtime/detect';

/**
 * Options for creating a StorageManager
 */
export interface StorageManagerOptions {
  /**
   * Use a built-in backend type
   */
  type?: BackendType;

  /**
   * Password for encrypted backends (required if type is 'encrypted-sqlite')
   */
  password?: string;

  /**
   * Inject a custom backend (takes precedence over type)
   */
  backend?: IStorageBackend;

  /**
   * Inject a custom adapter (SDK builds repositories on top)
   */
  adapter?: IStorageAdapter;

  /**
   * Runtime mode override for encrypted backend
   */
  runtimeMode?: 'worker' | 'sync' | 'auto';

  /**
   * Database path for file-based backends (Node.js)
   */
  dbPath?: string;

  /**
   * Enable debug logging
   */
  debug?: boolean;
}

/**
 * Storage state
 */
type StorageState =
  | 'uninitialized'
  | 'initializing'
  | 'ready'
  | 'locked'
  | 'error';

export class StorageManager {
  private backend: IStorageBackend | null = null;
  private state: StorageState = 'uninitialized';
  private initPromise: Promise<void> | null = null;
  private options: StorageManagerOptions;

  private constructor(options: StorageManagerOptions) {
    this.options = options;
  }

  /**
   * Create and initialize a StorageManager
   */
  static async create(options: StorageManagerOptions): Promise<StorageManager> {
    const manager = new StorageManager(options);
    await manager.initialize();
    return manager;
  }

  /**
   * Get the recommended storage options for the current environment
   */
  static getRecommendedOptions(): { type: BackendType; description: string } {
    const capabilities = detectCapabilities();

    if (supportsEncryptedSqlite()) {
      const runtimeType = getBestRuntimeType(capabilities);
      return {
        type: 'encrypted-sqlite',
        description: `Encrypted SQLite (${runtimeType})`,
      };
    }

    if (supportsDexie()) {
      return {
        type: 'dexie',
        description: 'Dexie IndexedDB (no encryption at rest)',
      };
    }

    return {
      type: 'custom',
      description: 'Custom backend required',
    };
  }

  /**
   * Initialize the storage backend
   */
  private async initialize(): Promise<void> {
    if (this.initPromise) {
      return this.initPromise;
    }

    if (this.state === 'ready') {
      return;
    }

    this.state = 'initializing';

    this.initPromise = (async () => {
      try {
        // Custom backend takes precedence
        if (this.options.backend) {
          this.backend = this.options.backend;
          await this.backend.initialize();
          this.state = 'ready';
          return;
        }

        // Custom adapter - build repositories on top
        if (this.options.adapter) {
          // TODO: Implement GenericSqlBackend that uses adapter
          throw new Error('Custom adapter injection not yet implemented');
        }

        // Built-in backend based on type
        const type = this.options.type || 'encrypted-sqlite';

        switch (type) {
          case 'encrypted-sqlite':
            await this.initializeEncryptedSqlite();
            break;

          case 'dexie':
            await this.initializeDexie();
            break;

          default:
            throw new Error(`Unknown backend type: ${type}`);
        }

        this.state = 'ready';
      } catch (error) {
        this.state = 'error';
        throw error;
      }
    })();

    return this.initPromise;
  }

  /**
   * Initialize the encrypted SQLite backend
   */
  private async initializeEncryptedSqlite(): Promise<void> {
    if (!supportsEncryptedSqlite()) {
      throw new Error(
        'Encrypted SQLite backend not supported in this environment'
      );
    }

    // Dynamically import to avoid bundling issues
    const { EncryptedSqliteBackend } =
      await import('./backends/encrypted/EncryptedSqliteBackend');

    const capabilities = detectCapabilities();
    const runtimeType = getBestRuntimeType(
      capabilities,
      this.options.runtimeMode
    );

    this.backend = new EncryptedSqliteBackend({
      runtimeType,
      dbPath: this.options.dbPath,
      debug: this.options.debug,
    });

    await this.backend.initialize();

    // Handle session creation/unlock
    if (this.options.password) {
      if (this.backend.isUnlocked?.()) {
        // Already unlocked
        return;
      }

      // Try to unlock existing session
      const unlocked = await this.backend.unlockSession?.(
        this.options.password
      );
      if (!unlocked) {
        // No existing session, create new one
        await this.backend.createSession?.(this.options.password);
      }
    }
  }

  /**
   * Initialize the Dexie backend
   */
  private async initializeDexie(): Promise<void> {
    if (!supportsDexie()) {
      throw new Error('Dexie backend not supported in this environment');
    }

    // Dynamically import to avoid bundling issues
    const { DexieBackend } = await import('./backends/dexie/DexieBackend');

    this.backend = new DexieBackend({
      debug: this.options.debug,
    });

    await this.backend.initialize();
  }

  // ============ State ============

  /**
   * Get current state
   */
  getState(): StorageState {
    return this.state;
  }

  /**
   * Check if ready
   */
  isReady(): boolean {
    return this.state === 'ready' && this.backend !== null;
  }

  /**
   * Get backend type
   */
  getBackendType(): string {
    return this.backend?.type || 'none';
  }

  /**
   * Get backend name
   */
  getBackendName(): string {
    return this.backend?.name || 'Not initialized';
  }

  // ============ Encryption ============

  /**
   * Check if current backend supports encryption
   */
  isEncrypted(): boolean {
    return this.backend?.isEncrypted() || false;
  }

  /**
   * Check if session is unlocked
   */
  isUnlocked(): boolean {
    if (!this.backend?.isEncrypted()) {
      return true; // Non-encrypted backends are always "unlocked"
    }
    return this.backend?.isUnlocked?.() || false;
  }

  /**
   * Lock the session (encrypted backends only)
   */
  async lock(): Promise<void> {
    this.ensureReady();
    if (!this.backend?.isEncrypted()) {
      throw new Error('Cannot lock non-encrypted backend');
    }
    await this.backend.lockSession?.();
    this.state = 'locked';
  }

  /**
   * Unlock the session (encrypted backends only)
   */
  async unlock(password: string): Promise<boolean> {
    if (!this.backend) {
      throw new Error('Backend not initialized');
    }
    if (!this.backend.isEncrypted()) {
      throw new Error('Cannot unlock non-encrypted backend');
    }

    const success = await this.backend.unlockSession?.(password);
    if (success) {
      this.state = 'ready';
    }
    return success || false;
  }

  /**
   * Change password (encrypted backends only)
   */
  async changePassword(
    oldPassword: string,
    newPassword: string
  ): Promise<boolean> {
    this.ensureReady();
    if (!this.backend?.isEncrypted()) {
      throw new Error('Cannot change password on non-encrypted backend');
    }
    return (
      (await this.backend.changePassword?.(oldPassword, newPassword)) || false
    );
  }

  // ============ Repositories ============

  private ensureReady(): void {
    if (!this.backend) {
      throw new Error('Storage not initialized. Call initialize() first.');
    }
    if (this.state === 'locked') {
      throw new Error('Storage is locked. Call unlock() first.');
    }
    if (this.state !== 'ready') {
      throw new Error(`Storage not ready. Current state: ${this.state}`);
    }
  }

  get contacts(): IContactRepository {
    this.ensureReady();
    return this.backend!.contacts;
  }

  get messages(): IMessageRepository {
    this.ensureReady();
    return this.backend!.messages;
  }

  get discussions(): IDiscussionRepository {
    this.ensureReady();
    return this.backend!.discussions;
  }

  get userProfile(): IUserProfileRepository {
    this.ensureReady();
    return this.backend!.userProfile;
  }

  get pendingMessages(): IPendingMessageRepository {
    this.ensureReady();
    return this.backend!.pendingMessages;
  }

  get pendingAnnouncements(): IPendingAnnouncementRepository {
    this.ensureReady();
    return this.backend!.pendingAnnouncements;
  }

  get activeSeekers(): IActiveSeekerRepository {
    this.ensureReady();
    return this.backend!.activeSeekers;
  }

  // ============ Lifecycle ============

  /**
   * Close the storage and release resources
   */
  async close(): Promise<void> {
    if (this.backend) {
      await this.backend.close();
      this.backend = null;
    }
    this.state = 'uninitialized';
    this.initPromise = null;
  }

  /**
   * Delete all data
   */
  async deleteAll(): Promise<void> {
    this.ensureReady();
    await this.backend!.deleteAll();
  }

  /**
   * Get the underlying backend (for advanced usage)
   */
  getBackend(): IStorageBackend | null {
    return this.backend;
  }
}
