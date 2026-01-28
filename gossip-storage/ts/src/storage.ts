/**
 * Storage - Main entry point for gossip-storage
 *
 * Provides a unified API for encrypted storage with wa-sqlite integration.
 * Handles WASM loading, VFS registration, and session management.
 */

import type { FileSystem, FileId } from './filesystem.js';
import { PlausibleDeniableVFS } from './vfs.js';
import SQLiteESMFactory from 'wa-sqlite/dist/wa-sqlite.mjs';
import * as SQLite from 'wa-sqlite';

/**
 * Options for initializing Storage
 */
export interface StorageInitOptions {
  /** URL to gossip-storage WASM file (required for browser) */
  gossipWasmUrl?: string;
  /** URL to wa-sqlite WASM file (required for browser) */
  waSqliteWasmUrl?: string;
  /** Gossip WASM bytes for sync loading (Node.js) */
  gossipWasmBytes?: BufferSource;
  /** wa-sqlite WASM bytes for sync loading (Node.js) */
  waSqliteWasmBytes?: BufferSource;
  /** Database filename (default: 'session.db') */
  dbName?: string;
}

/**
 * Raw SQL execution result (ORM-compatible)
 */
export interface SqlResult {
  /** Column names */
  columns: string[];
  /** Raw row data as arrays */
  rows: unknown[][];
}

/**
 * Storage class - Full encrypted storage with SQLite integration
 *
 * Example usage (browser worker):
 * ```typescript
 * import gossipWasmUrl from '@gossip/storage/wasm?url';
 * import waSqliteWasmUrl from 'wa-sqlite/dist/wa-sqlite.wasm?url';
 *
 * const storage = new Storage(new OpfsFileSystem());
 * await storage.init({ gossipWasmUrl, waSqliteWasmUrl });
 *
 * await storage.createSession('password');
 * await storage.sql('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)');
 *
 * // Use with Drizzle ORM:
 * const db = drizzle(async (sql, params, method) => {
 *   const result = await storage.sql(sql);
 *   return { rows: result.rows };
 * });
 * ```
 */
export class Storage {
  private fs: FileSystem;
  private vfs: PlausibleDeniableVFS | null = null;
  private sqlite3: ReturnType<typeof SQLite.Factory> | null = null;
  private db: number | null = null;
  private dbName = 'session.db';
  private initialized = false;

  // WASM module functions (set after init)
  private wasm: {
    initStorage: () => void;
    createSession: (password: string) => boolean;
    unlockSession: (password: string) => boolean;
    lockSession: () => void;
    isSessionUnlocked: () => boolean;
    readData: (offset: bigint, len: number) => Uint8Array;
    writeData: (offset: bigint, data: Uint8Array) => boolean;
    flushData: () => boolean;
    getDataSize: () => bigint;
    getRootAddress: () => bigint;
    getRootLength: () => number;
    getWasmVersion: () => string;
  } | null = null;

  constructor(filesystem: FileSystem) {
    this.fs = filesystem;
  }

  /**
   * Initialize storage, WASM modules, and wa-sqlite.
   */
  async init(options: StorageInitOptions = {}): Promise<void> {
    if (this.initialized) {
      return;
    }

    this.dbName = options.dbName ?? 'session.db';

    // Step 1: Initialize filesystem if it has an initialize method
    if ('initialize' in this.fs && typeof this.fs.initialize === 'function') {
      await (this.fs as { initialize: () => Promise<void> }).initialize();
    }

    // Step 2: Register global callbacks for WASM
    this.registerCallbacks();

    // Step 3: Load gossip-storage WASM
    await this.loadGossipWasm(options);

    // Step 4: Initialize storage (creates 2MB addressing blob if needed)
    this.wasm!.initStorage();

    // Step 5: Load wa-sqlite
    await this.loadWaSqlite(options);

    // Step 6: Create and register VFS
    this.vfs = this.createVFSInternal();
    this.sqlite3!.vfs_register(this.vfs, true);

    this.initialized = true;
  }

  /**
   * Load gossip-storage WASM module
   */
  private async loadGossipWasm(options: StorageInitOptions): Promise<void> {
    const mod = await import('../generated/gossip_storage.js');

    if (options.gossipWasmBytes) {
      // Node.js: sync loading with bytes
      mod.initSync({ module: options.gossipWasmBytes });
    } else if (options.gossipWasmUrl) {
      // Browser: async loading with URL
      await mod.default(options.gossipWasmUrl);
    } else {
      // Try default init (may work in some environments)
      await mod.default();
    }

    this.wasm = {
      initStorage: mod.initStorage,
      createSession: mod.createSession,
      unlockSession: mod.unlockSession,
      lockSession: mod.lockSession,
      isSessionUnlocked: mod.isSessionUnlocked,
      readData: mod.readData,
      writeData: mod.writeData,
      flushData: mod.flushData,
      getDataSize: mod.getDataSize,
      getRootAddress: mod.getRootAddress,
      getRootLength: mod.getRootLength,
      getWasmVersion: mod.getWasmVersion,
    };
  }

  /**
   * Load wa-sqlite
   */
  private async loadWaSqlite(options: StorageInitOptions): Promise<void> {
    const factoryOptions: {
      locateFile?: (file: string) => string;
      wasmBinary?: BufferSource;
    } = {};

    if (options.waSqliteWasmBytes) {
      factoryOptions.wasmBinary = options.waSqliteWasmBytes;
    } else if (options.waSqliteWasmUrl) {
      factoryOptions.locateFile = (file: string) => {
        if (file.endsWith('.wasm')) return options.waSqliteWasmUrl!;
        return file;
      };
    }

    const module = await SQLiteESMFactory(factoryOptions);
    this.sqlite3 = SQLite.Factory(module);
  }

  /**
   * Register global callbacks for WASM to call.
   */
  private registerCallbacks(): void {
    const g = globalThis as Record<string, unknown>;

    g.storageRead = (
      fileId: number,
      offset: bigint,
      len: number
    ): Uint8Array => {
      return this.fs.read(fileId as FileId, Number(offset), len);
    };

    g.storageWrite = (
      fileId: number,
      offset: bigint,
      data: Uint8Array
    ): void => {
      this.fs.write(fileId as FileId, Number(offset), data);
    };

    g.storageGetSize = (fileId: number): bigint => {
      return BigInt(this.fs.getSize(fileId as FileId));
    };

    g.storageFlush = (fileId: number): void => {
      this.fs.flush(fileId as FileId);
    };
  }

  private ensureInitialized(): void {
    if (!this.initialized || !this.wasm) {
      throw new Error('Storage not initialized. Call init() first.');
    }
  }

  // ============================================================
  // Session Management
  // ============================================================

  /**
   * Create a new session with the given password.
   * Opens the database automatically.
   */
  async createSession(password: string): Promise<boolean> {
    this.ensureInitialized();

    const success = this.wasm!.createSession(password);
    if (!success) {
      return false;
    }

    // Reset VFS state for new session (file starts at size 0)
    if (this.vfs) {
      this.vfs.reset();
    }

    // Open database
    await this.openDatabase();
    return true;
  }

  /**
   * Unlock an existing session with the given password.
   * Restores file size from SQLite header and opens the database.
   */
  async unlockSession(password: string): Promise<boolean> {
    this.ensureInitialized();

    console.log('[Storage] unlockSession: calling WASM unlock...');
    const success = this.wasm!.unlockSession(password);
    if (!success) {
      console.warn('[Storage] unlockSession: WASM unlock failed');
      return false;
    }

    console.log(
      `[Storage] unlockSession: WASM unlock succeeded, getRootAddress=${this.wasm!.getRootAddress()}`
    );

    // Restore file size from SQLite header (critical for persistence)
    if (this.vfs) {
      console.log(
        '[Storage] unlockSession: restoring file size from header...'
      );
      const restored = this.vfs.restoreFileSizeFromHeader(this.dbName);
      if (!restored) {
        // Check if Rust thinks there was existing data
        const logicalSize = this.wasm!.getDataSize();
        if (logicalSize > 0n) {
          throw new Error(
            `SQLite header corrupted but storage reports ${logicalSize} bytes of data. ` +
              `This indicates data corruption.`
          );
        }
        // Otherwise it's a new session, size=0 is expected
        console.log(
          '[Storage] New session detected (no SQLite header yet), starting fresh'
        );
      }
    }

    // Open database
    console.log('[Storage] unlockSession: opening database...');
    await this.openDatabase();
    console.log('[Storage] unlockSession: database opened');
    return true;
  }

  /**
   * Lock the current session.
   * Closes the database and zeroizes keys.
   */
  async lockSession(): Promise<void> {
    this.ensureInitialized();

    // Close database first
    await this.closeDatabase();

    this.wasm!.lockSession();
  }

  /**
   * Check if a session is currently unlocked.
   */
  isUnlocked(): boolean {
    this.ensureInitialized();
    return this.wasm!.isSessionUnlocked();
  }

  // ============================================================
  // Database Operations
  // ============================================================

  private async openDatabase(): Promise<void> {
    if (this.db !== null) return;

    this.db = await this.sqlite3!.open_v2(
      this.dbName,
      SQLite.SQLITE_OPEN_CREATE | SQLite.SQLITE_OPEN_READWRITE,
      'PlausibleDeniableVFS'
    );

    // Use memory journal mode to avoid creating journal files on disk.
    // This is important because our VFS routes all writes through a single
    // storage backend - journal files would overwrite main database data.
    // Memory journaling is safe here because:
    // 1. We flush atomically via encrypted blocks
    // 2. Session lock guarantees all data is persisted
    // 3. We don't need crash recovery (storage is re-encrypted on lock)
    await this.sqlite3!.exec(this.db, 'PRAGMA journal_mode=MEMORY');
  }

  private async closeDatabase(): Promise<void> {
    if (this.db === null || !this.sqlite3) return;

    await this.sqlite3.close(this.db);
    this.db = null;
  }

  /**
   * Execute raw SQL and return raw results.
   * Compatible with ORMs like Drizzle, Kysely, etc.
   *
   * @throws Error if session not unlocked or database not open
   */
  async sql(query: string): Promise<SqlResult> {
    if (!this.isUnlocked()) {
      throw new Error('Session not unlocked');
    }
    if (this.db === null) {
      throw new Error('Database not open');
    }

    const rows: unknown[][] = [];
    let columns: string[] = [];

    await this.sqlite3!.exec(
      this.db,
      query,
      (row: unknown[], cols: string[]) => {
        if (cols && !columns.length) columns = cols;
        rows.push(row);
      }
    );

    return { columns, rows };
  }

  // ============================================================
  // Low-level Data Operations (for advanced usage)
  // ============================================================

  /**
   * Flush data to disk.
   */
  flushData(): boolean {
    this.ensureInitialized();
    return this.wasm!.flushData();
  }

  /**
   * Get data blob size.
   */
  getDataSize(): bigint {
    this.ensureInitialized();
    return this.wasm!.getDataSize();
  }

  /**
   * Get root block address.
   */
  getRootAddress(): bigint {
    this.ensureInitialized();
    return this.wasm!.getRootAddress();
  }

  /**
   * Get WASM version.
   */
  getWasmVersion(): string {
    this.ensureInitialized();
    return this.wasm!.getWasmVersion();
  }

  // ============================================================
  // VFS Access (for advanced usage)
  // ============================================================

  /**
   * Create a VFS instance (internal, no initialization check).
   */
  private createVFSInternal(): PlausibleDeniableVFS {
    const storageApi = {
      isSessionUnlocked: () => this.wasm!.isSessionUnlocked(),
      getRootAddress: () => this.wasm!.getRootAddress(),
      readData: (offset: bigint, len: number) =>
        this.wasm!.readData(offset, len),
      writeData: (offset: bigint, data: Uint8Array) =>
        this.wasm!.writeData(offset, data),
      flushData: () => this.wasm!.flushData(),
    };

    return new PlausibleDeniableVFS(storageApi);
  }

  /**
   * Create a VFS instance.
   * Exposed for advanced use cases.
   */
  createVFS(): PlausibleDeniableVFS {
    this.ensureInitialized();
    return this.createVFSInternal();
  }

  /**
   * Get VFS stats.
   */
  getVfsStats(): { readCount: number; writeCount: number } | null {
    return this.vfs?.getStats() ?? null;
  }

  // ============================================================
  // Lifecycle
  // ============================================================

  /**
   * Check if storage is initialized.
   */
  isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * Reinitialize storage (creates 2MB addressing blob).
   * Call this after filesystem reset to restore the storage files.
   */
  reinitializeStorage(): void {
    this.ensureInitialized();
    this.wasm!.initStorage();
    // Reset VFS state (file sizes, etc.)
    if (this.vfs) {
      this.vfs.reset();
    }
  }

  /**
   * Check if database is open.
   */
  isDatabaseOpen(): boolean {
    return this.db !== null;
  }

  /**
   * Get the underlying filesystem.
   */
  getFileSystem(): FileSystem {
    return this.fs;
  }

  /**
   * Close storage and cleanup resources.
   */
  async close(): Promise<void> {
    if (this.wasm?.isSessionUnlocked()) {
      await this.lockSession();
    }

    if (this.fs.close) {
      await this.fs.close();
    }

    // Clear global callbacks
    const g = globalThis as Record<string, unknown>;
    delete g.storageRead;
    delete g.storageWrite;
    delete g.storageGetSize;
    delete g.storageFlush;

    this.wasm = null;
    this.sqlite3 = null;
    this.vfs = null;
    this.initialized = false;
  }
}
