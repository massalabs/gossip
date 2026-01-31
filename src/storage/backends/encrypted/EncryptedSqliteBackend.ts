/**
 * EncryptedSqliteBackend - SQLite-based storage with plausible deniability.
 *
 * This backend provides:
 * - AES-256-SIV encryption for all data
 * - Argon2id key derivation
 * - Plausible deniability through fixed-size addressing blobs
 * - Works in both browser (Worker + OPFS) and Node.js (sync + filesystem)
 */

import type {
  IStorageBackend,
  BackendType,
  IRuntimeAdapter,
} from '../../interfaces';
import type {
  IContactRepository,
  IMessageRepository,
  IDiscussionRepository,
  IUserProfileRepository,
  IPendingMessageRepository,
  IPendingAnnouncementRepository,
  IActiveSeekerRepository,
} from '../../interfaces/repositories';

import { createRuntime, type CreateRuntimeOptions } from '../../runtime';
import { CREATE_TABLES_SQL } from '../../schema/sqlite';

import { EncryptedContactRepository } from './EncryptedContactRepository';
import { EncryptedMessageRepository } from './EncryptedMessageRepository';
import { EncryptedDiscussionRepository } from './EncryptedDiscussionRepository';
import { EncryptedUserProfileRepository } from './EncryptedUserProfileRepository';
import {
  EncryptedPendingMessageRepository,
  EncryptedPendingAnnouncementRepository,
  EncryptedActiveSeekerRepository,
} from './EncryptedPendingRepositories';

export interface EncryptedSqliteBackendOptions {
  /**
   * Runtime type override (auto-detected by default)
   */
  runtimeType?: 'browser-worker' | 'browser-sync' | 'node';

  /**
   * Database path for Node.js runtime
   */
  dbPath?: string;

  /**
   * Enable debug logging
   */
  debug?: boolean;
}

export class EncryptedSqliteBackend implements IStorageBackend {
  readonly type: BackendType = 'encrypted-sqlite';
  readonly name = 'Encrypted SQLite';

  private runtime: IRuntimeAdapter | null = null;
  private ready = false;
  private debug: boolean;
  private options: EncryptedSqliteBackendOptions;

  // Repositories
  private _contacts: EncryptedContactRepository | null = null;
  private _messages: EncryptedMessageRepository | null = null;
  private _discussions: EncryptedDiscussionRepository | null = null;
  private _userProfile: EncryptedUserProfileRepository | null = null;
  private _pendingMessages: EncryptedPendingMessageRepository | null = null;
  private _pendingAnnouncements: EncryptedPendingAnnouncementRepository | null =
    null;
  private _activeSeekers: EncryptedActiveSeekerRepository | null = null;

  constructor(options: EncryptedSqliteBackendOptions = {}) {
    this.options = options;
    this.debug = options.debug || false;
  }

  // ============ Lifecycle ============

  async initialize(): Promise<void> {
    if (this.ready) return;

    if (this.debug) {
      console.log('[EncryptedSqliteBackend] Initializing...');
    }

    // Create the runtime
    const runtimeOptions: CreateRuntimeOptions = {
      mode:
        this.options.runtimeType === 'browser-worker'
          ? 'worker'
          : this.options.runtimeType === 'browser-sync'
            ? 'sync'
            : 'auto',
      dbPath: this.options.dbPath,
      debug: this.debug,
    };

    this.runtime = await createRuntime(runtimeOptions);

    // Initialize repositories (they use the runtime for SQL execution)
    this._contacts = new EncryptedContactRepository(this.runtime);
    this._messages = new EncryptedMessageRepository(this.runtime);
    this._discussions = new EncryptedDiscussionRepository(this.runtime);
    this._userProfile = new EncryptedUserProfileRepository(this.runtime);
    this._pendingMessages = new EncryptedPendingMessageRepository(this.runtime);
    this._pendingAnnouncements = new EncryptedPendingAnnouncementRepository(
      this.runtime
    );
    this._activeSeekers = new EncryptedActiveSeekerRepository(this.runtime);

    this.ready = true;

    if (this.debug) {
      console.log('[EncryptedSqliteBackend] Ready (session not yet unlocked)');
    }
  }

  async close(): Promise<void> {
    if (this.debug) {
      console.log('[EncryptedSqliteBackend] Closing...');
    }

    if (this.runtime) {
      await this.runtime.dispose();
      this.runtime = null;
    }

    this.ready = false;
  }

  async deleteAll(): Promise<void> {
    if (this.debug) {
      console.log('[EncryptedSqliteBackend] Deleting all data...');
    }

    // Drop all tables
    const dropSql = `
      DROP TABLE IF EXISTS contacts;
      DROP TABLE IF EXISTS messages;
      DROP TABLE IF EXISTS userProfile;
      DROP TABLE IF EXISTS discussions;
      DROP TABLE IF EXISTS pendingEncryptedMessages;
      DROP TABLE IF EXISTS pendingAnnouncements;
      DROP TABLE IF EXISTS activeSeekers;
    `;

    await this.runtime!.execBatch(
      dropSql
        .split(';')
        .filter(s => s.trim())
        .map(sql => ({ sql }))
    );
  }

  isReady(): boolean {
    return this.ready;
  }

  // ============ Encryption ============

  isEncrypted(): boolean {
    return true;
  }

  async createSession(password: string): Promise<void> {
    this.ensureInitialized();

    if (this.debug) {
      console.log('[EncryptedSqliteBackend] Creating session...');
    }

    await this.runtime!.createSession(password);

    // Create tables after session is created
    await this.createTables();

    if (this.debug) {
      console.log(
        '[EncryptedSqliteBackend] Session created and tables initialized'
      );
    }
  }

  async unlockSession(password: string): Promise<boolean> {
    this.ensureInitialized();

    if (this.debug) {
      console.log('[EncryptedSqliteBackend] Unlocking session...');
    }

    const success = await this.runtime!.unlockSession(password);

    if (success) {
      // Ensure tables exist after unlock
      await this.createTables();

      if (this.debug) {
        console.log('[EncryptedSqliteBackend] Session unlocked');
      }
    } else {
      if (this.debug) {
        console.log('[EncryptedSqliteBackend] Invalid password');
      }
    }

    return success;
  }

  async lockSession(): Promise<void> {
    this.ensureInitialized();

    if (this.debug) {
      console.log('[EncryptedSqliteBackend] Locking session...');
    }

    await this.runtime!.lockSession();
  }

  isUnlocked(): boolean {
    return this.runtime?.isSessionUnlocked() || false;
  }

  async changePassword(
    oldPassword: string,
    newPassword: string
  ): Promise<boolean> {
    this.ensureInitialized();
    return await this.runtime!.changePassword(oldPassword, newPassword);
  }

  // ============ Repositories ============

  private ensureInitialized(): void {
    if (!this.runtime) {
      throw new Error(
        'EncryptedSqliteBackend not initialized. Call initialize() first.'
      );
    }
  }

  private ensureUnlocked(): void {
    this.ensureInitialized();
    if (!this.runtime!.isSessionUnlocked()) {
      throw new Error('Session is locked. Call unlockSession() first.');
    }
  }

  get contacts(): IContactRepository {
    this.ensureUnlocked();
    return this._contacts!;
  }

  get messages(): IMessageRepository {
    this.ensureUnlocked();
    return this._messages!;
  }

  get discussions(): IDiscussionRepository {
    this.ensureUnlocked();
    return this._discussions!;
  }

  get userProfile(): IUserProfileRepository {
    this.ensureUnlocked();
    return this._userProfile!;
  }

  get pendingMessages(): IPendingMessageRepository {
    this.ensureUnlocked();
    return this._pendingMessages!;
  }

  get pendingAnnouncements(): IPendingAnnouncementRepository {
    this.ensureUnlocked();
    return this._pendingAnnouncements!;
  }

  get activeSeekers(): IActiveSeekerRepository {
    this.ensureUnlocked();
    return this._activeSeekers!;
  }

  // ============ Internal ============

  private async createTables(): Promise<void> {
    // Split the CREATE_TABLES_SQL into individual statements
    const statements = CREATE_TABLES_SQL.split(';')
      .map(s => s.trim())
      .filter(s => s.length > 0)
      .map(sql => ({ sql: sql + ';' }));

    await this.runtime!.execBatch(statements);

    if (this.debug) {
      console.log('[EncryptedSqliteBackend] Tables created');
    }
  }

  /**
   * Get the underlying runtime adapter (for advanced usage)
   */
  getRuntime(): IRuntimeAdapter | null {
    return this.runtime;
  }
}
