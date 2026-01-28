/**
 * DexieBackend - IndexedDB-based storage using Dexie.
 *
 * This wraps the existing db.ts implementation with the IStorageBackend interface.
 * No encryption at rest - data is stored in plain IndexedDB.
 *
 * Only works in browser environments.
 */

import type { IStorageBackend, BackendType } from '../../interfaces';
import type {
  IContactRepository,
  IMessageRepository,
  IDiscussionRepository,
  IUserProfileRepository,
  IPendingMessageRepository,
  IPendingAnnouncementRepository,
  IActiveSeekerRepository,
} from '../../interfaces/repositories';

import { DexieContactRepository } from './DexieContactRepository';
import { DexieMessageRepository } from './DexieMessageRepository';
import { DexieDiscussionRepository } from './DexieDiscussionRepository';
import { DexieUserProfileRepository } from './DexieUserProfileRepository';
import {
  DexiePendingMessageRepository,
  DexiePendingAnnouncementRepository,
  DexieActiveSeekerRepository,
} from './DexiePendingRepositories';
import { db, GossipDatabase } from '../../../db';

export interface DexieBackendOptions {
  /**
   * Use a specific database instance (defaults to the shared singleton)
   */
  database?: GossipDatabase;

  /**
   * Enable debug logging
   */
  debug?: boolean;
}

export class DexieBackend implements IStorageBackend {
  readonly type: BackendType = 'dexie';
  readonly name = 'Dexie IndexedDB';

  private database: GossipDatabase;
  private ready = false;
  private debug: boolean;

  // Repositories
  private _contacts: DexieContactRepository | null = null;
  private _messages: DexieMessageRepository | null = null;
  private _discussions: DexieDiscussionRepository | null = null;
  private _userProfile: DexieUserProfileRepository | null = null;
  private _pendingMessages: DexiePendingMessageRepository | null = null;
  private _pendingAnnouncements: DexiePendingAnnouncementRepository | null =
    null;
  private _activeSeekers: DexieActiveSeekerRepository | null = null;

  constructor(options: DexieBackendOptions = {}) {
    this.database = options.database || db;
    this.debug = options.debug || false;
  }

  // ============ Lifecycle ============

  async initialize(): Promise<void> {
    if (this.ready) return;

    if (this.debug) {
      console.log('[DexieBackend] Initializing...');
    }

    // Dexie auto-opens on first use, but we can explicitly open
    await this.database.open();

    // Initialize repositories
    this._contacts = new DexieContactRepository(this.database);
    this._messages = new DexieMessageRepository(this.database);
    this._discussions = new DexieDiscussionRepository(this.database);
    this._userProfile = new DexieUserProfileRepository(this.database);
    this._pendingMessages = new DexiePendingMessageRepository(this.database);
    this._pendingAnnouncements = new DexiePendingAnnouncementRepository(
      this.database
    );
    this._activeSeekers = new DexieActiveSeekerRepository(this.database);

    this.ready = true;

    if (this.debug) {
      console.log('[DexieBackend] Ready');
    }
  }

  async close(): Promise<void> {
    if (this.debug) {
      console.log('[DexieBackend] Closing...');
    }
    this.database.close();
    this.ready = false;
  }

  async deleteAll(): Promise<void> {
    if (this.debug) {
      console.log('[DexieBackend] Deleting all data...');
    }
    await this.database.deleteDb();
  }

  isReady(): boolean {
    return this.ready;
  }

  // ============ Encryption (not supported) ============

  isEncrypted(): boolean {
    return false;
  }

  // These methods are not implemented for Dexie (non-encrypted backend)
  // They're optional in the interface, so we don't need to throw

  // ============ Repositories ============

  private ensureReady(): void {
    if (!this.ready) {
      throw new Error('DexieBackend not initialized. Call initialize() first.');
    }
  }

  get contacts(): IContactRepository {
    this.ensureReady();
    return this._contacts!;
  }

  get messages(): IMessageRepository {
    this.ensureReady();
    return this._messages!;
  }

  get discussions(): IDiscussionRepository {
    this.ensureReady();
    return this._discussions!;
  }

  get userProfile(): IUserProfileRepository {
    this.ensureReady();
    return this._userProfile!;
  }

  get pendingMessages(): IPendingMessageRepository {
    this.ensureReady();
    return this._pendingMessages!;
  }

  get pendingAnnouncements(): IPendingAnnouncementRepository {
    this.ensureReady();
    return this._pendingAnnouncements!;
  }

  get activeSeekers(): IActiveSeekerRepository {
    this.ensureReady();
    return this._activeSeekers!;
  }

  /**
   * Get the underlying Dexie database (for advanced usage)
   */
  getDatabase(): GossipDatabase {
    return this.database;
  }
}
