/**
 * SQLite initialization module for the Gossip SDK.
 *
 * Uses wa-sqlite (WASM) with Drizzle ORM's sqlite-proxy driver.
 * Five execution paths:
 *   - Browser/OPFS (opfsPath set): Web Worker + AccessHandlePoolVFS — fast, single-tab.
 *   - Browser/IDB (idbName set): Web Worker + IDBBatchAtomicVFS — multi-tab safe.
 *   - Browser/Secure storage: Web Worker + SecureStorageVFS — encrypted OPFS storage.
 *   - Node.js file (path set): In-process + NodeFsVFS — file persistence via node:fs.
 *   - In-memory (tests): :memory: in-process — no persistence, fast, isolated.
 *
 * Each GossipSdk instance owns a DatabaseConnection, allowing multiple
 * independent SDK instances in the same process.
 */

import SQLiteESMFactory from 'wa-sqlite/dist/wa-sqlite.mjs';
import * as SQLite from 'wa-sqlite';
import { drizzle, type SqliteRemoteDatabase } from 'drizzle-orm/sqlite-proxy';
import * as schema from './schema/index.js';
import { runMigrations } from './migrate.js';
import { execStatements } from './exec-utils.js';

export type GossipDatabase = SqliteRemoteDatabase<typeof schema>;

/** Selects the SQLite storage backend. */
export type StorageConfig =
  | { type: 'opfs'; path: string; wasmUrl?: string }
  | { type: 'idb'; name: string; wasmUrl?: string }
  | { type: 'node-fs'; path: string }
  | { type: 'memory'; wasmBinary?: ArrayBuffer }
  | {
      type: 'secureStorage';
      path: string;
      domain?: string;
      wasmUrl?: string;
      backend: 'opfs' | 'idb' | 'node-fs';
    };

export interface InitDbOptions {
  /** Storage backend selection. Defaults to in-memory. */
  storage?: StorageConfig;
}

// ---------------------------------------------------------------------------
// Internal state shape
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SecureStorageWasmModule = any;

interface DbState {
  worker: Worker | null;
  msgId: number;
  pending: Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >;
  lastInsertRowIdCache: number;
  sqlite3: ReturnType<typeof SQLite.Factory> | null;
  dbHandle: number | null;
  useWorker: boolean;
  drizzleDb: GossipDatabase | null;
  dbLock: Promise<unknown>;
  inTransaction: boolean;
  secureStorageWasm: SecureStorageWasmModule | null;
  secureStorageVfs: { flushDirtyPages(): void } | null;
  needsUnlock: boolean;
}

function createDefaultState(): DbState {
  return {
    worker: null,
    msgId: 0,
    pending: new Map(),
    lastInsertRowIdCache: 0,
    sqlite3: null,
    dbHandle: null,
    useWorker: false,
    drizzleDb: null,
    dbLock: Promise.resolve(),
    inTransaction: false,
    secureStorageWasm: null,
    secureStorageVfs: null,
    needsUnlock: false,
  };
}

/**
 * PRAGMAs for browser workers (IDB/OPFS/memory).
 *
 * Durability model: the VFS xSync is a no-op for both IDBBatchAtomicVFS
 * and AccessHandlePoolVFS — crash recovery relies on the storage backend's
 * flushAll() persisting dirty blocks to IDB/OPFS after each write operation.
 * journal_mode=MEMORY avoids writing a useless journal file, and
 * synchronous=OFF skips the no-op sync calls (verified for wa-sqlite's
 * IDBBatchAtomicVFS which flushes via its own batch mechanism, not xSync).
 */
const PRAGMAS = `
  PRAGMA journal_mode=MEMORY;
  PRAGMA synchronous=OFF;
  PRAGMA temp_store=MEMORY;
`;

/**
 * Additional PRAGMAs for the secure storage VFS, appended after PRAGMAS.
 *
 * page_size=8192 — largest power-of-2 that fits within a single secure storage
 *   block (PLAINTEXT_SIZE=15840), halving write amplification vs default 4096.
 *   Must be set before any tables are created (new DB) or followed by VACUUM
 *   (existing DB).
 *
 * cache_size=-8000 — 8 MB page cache. Secure storage decryption is expensive
 *   (PQ crypto per block), so a larger cache significantly reduces re-reads.
 *
 * secure_delete=ON — zeros freed pages before re-encryption, preventing
 *   recovery of deleted data from free-list pages by a session-key adversary.
 *
 * locking_mode=EXCLUSIVE — single-writer (one unlocked session), avoids
 *   lock/unlock overhead on every transaction.
 */
const PRAGMAS_SECURE_STORAGE = `
  PRAGMA page_size=8192;
  PRAGMA journal_mode=MEMORY;
  PRAGMA synchronous=OFF;
  PRAGMA temp_store=MEMORY;
  PRAGMA cache_size=-8000;
  PRAGMA secure_delete=ON;
  PRAGMA locking_mode=EXCLUSIVE;
`;

/** PRAGMAs for file-based persistence (Node.js). WAL gives crash recovery. */
const PRAGMAS_FILE = `
  PRAGMA journal_mode=WAL;
  PRAGMA temp_store=MEMORY;
`;

// ---------------------------------------------------------------------------
// DatabaseConnection — instance-scoped database connection
// ---------------------------------------------------------------------------

export class DatabaseConnection {
  private state: DbState;

  private constructor() {
    this.state = createDefaultState();
  }

  /**
   * Create and initialize a new database connection.
   */
  static async create(
    options: InitDbOptions = {}
  ): Promise<DatabaseConnection> {
    const conn = new DatabaseConnection();
    await conn.init(options);
    return conn;
  }

  /** The Drizzle ORM instance. Throws if not initialized. */
  get db(): GossipDatabase {
    if (!this.state.drizzleDb) {
      throw new Error('SQLite not initialized.');
    }
    return this.state.drizzleDb;
  }

  get isOpen(): boolean {
    return this.state.drizzleDb !== null;
  }

  /** True when secure storage has existing data that needs unlock before DB is usable. */
  get needsUnlock(): boolean {
    return this.state.needsUnlock;
  }

  // ─── Raw SQL execution ─────────────────────────────────────────

  private postToWorker(
    msg: Record<string, unknown>,
    transfer?: Transferable[]
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = ++this.state.msgId;
      this.state.pending.set(id, { resolve, reject });
      this.state.worker!.postMessage({ ...msg, id }, transfer ?? []);
    });
  }

  private handleWorkerMessage = (e: MessageEvent) => {
    const { id, type, ...rest } = e.data;
    const p = this.state.pending.get(id);
    if (!p) return;
    this.state.pending.delete(id);
    if (type === 'error') {
      p.reject(new Error(rest.message));
    } else {
      p.resolve(rest);
    }
  };

  private createDrizzleInstance(): GossipDatabase {
    return drizzle(
      async (sql, params, method) => {
        const rows = await this.execRaw(sql, params);
        if (method === 'get') {
          return { rows: rows[0] };
        }
        return { rows };
      },
      { schema }
    );
  }

  private async execRaw(
    sql: string,
    params: unknown[] = []
  ): Promise<unknown[][]> {
    if (this.state.inTransaction) {
      return this.execRawDirect(sql, params);
    }
    const prev = this.state.dbLock;
    let release!: () => void;
    this.state.dbLock = new Promise<void>(r => (release = r));
    await prev;
    try {
      return await this.execRawDirect(sql, params);
    } finally {
      release();
    }
  }

  private async execRawDirect(
    sql: string,
    params: unknown[] = []
  ): Promise<unknown[][]> {
    if (this.state.useWorker) {
      const result = await this.postToWorker({ type: 'exec', sql, params });
      this.state.lastInsertRowIdCache = result.lastInsertRowId;
      return result.rows;
    }
    return this.execRawInProcess(sql, params);
  }

  private async execRawInProcess(
    sql: string,
    params: unknown[] = []
  ): Promise<unknown[][]> {
    if (!this.state.sqlite3 || this.state.dbHandle === null) {
      throw new Error('SQLite not initialized');
    }
    const rows = await execStatements(
      this.state.sqlite3,
      this.state.dbHandle,
      sql,
      params
    );
    // Flush coalesced VFS writes after each SQL execution (Node.js path)
    this.state.secureStorageVfs?.flushDirtyPages();
    return rows;
  }

  // ─── Initialization ────────────────────────────────────────────

  private async init(options: InitDbOptions): Promise<void> {
    if (this.state.drizzleDb) return;

    const storage: StorageConfig = options.storage ?? { type: 'memory' };

    switch (storage.type) {
      case 'opfs':
      case 'idb': {
        const dbPath = storage.type === 'opfs' ? storage.path : storage.name;
        const useOPFS = storage.type === 'opfs';

        this.state.worker = new Worker(
          new URL('./sqlite-worker.ts', import.meta.url),
          { type: 'module' }
        );
        this.state.worker.onmessage = this.handleWorkerMessage;
        this.state.useWorker = true;

        try {
          await this.postToWorker({
            type: 'init',
            dbPath,
            useOPFS,
            wasmUrl: storage.wasmUrl,
            initSql: PRAGMAS,
          });
        } catch (err) {
          if (this.state.worker) {
            this.state.worker.terminate();
            this.state.worker = null;
          }
          this.state.useWorker = false;
          this.state.pending.clear();
          throw err;
        }
        break;
      }

      case 'node-fs': {
        const { NodeFsVFS } = await import('./node-fs-vfs.js');
        const { readFileSync } = await import('node:fs');
        const { dirname, resolve } = await import('node:path');
        const { createRequire } = await import('node:module');

        const require = createRequire(import.meta.url);
        const wasmDir = dirname(require.resolve('wa-sqlite/package.json'));
        const wasmBinary = readFileSync(
          resolve(wasmDir, 'dist/wa-sqlite.wasm')
        );

        const module = await SQLiteESMFactory({
          wasmBinary: wasmBinary.buffer.slice(
            wasmBinary.byteOffset,
            wasmBinary.byteOffset + wasmBinary.byteLength
          ),
        });
        this.state.sqlite3 = SQLite.Factory(module);
        // NodeFsVFS extends VFS.Base at runtime but wa-sqlite's TS
        // declarations use an opaque generic, so a cast is required.

        this.state.sqlite3.vfs_register(
          new NodeFsVFS(storage.path) as unknown as SQLiteVFS,
          true
        );
        this.state.dbHandle = await this.state.sqlite3.open_v2('gossip.db');
        this.state.useWorker = false;

        await this.state.sqlite3.exec(this.state.dbHandle, PRAGMAS_FILE);
        break;
      }

      case 'secureStorage': {
        if (storage.backend === 'node-fs') {
          await this.initSecureStorageNodeFs(storage);
        } else {
          await this.initSecureStorageWorker(storage);
        }
        break;
      }

      case 'memory': {
        const moduleArg: Record<string, unknown> = {};
        if (storage.wasmBinary) {
          moduleArg.wasmBinary = storage.wasmBinary;
        }

        const module = await SQLiteESMFactory(moduleArg);
        this.state.sqlite3 = SQLite.Factory(module);
        this.state.dbHandle = await this.state.sqlite3.open_v2(':memory:');
        this.state.useWorker = false;

        await this.state.sqlite3.exec(this.state.dbHandle, PRAGMAS);
        break;
      }
    }

    // Secure storage always defers SQLite open until allocate/unlock
    if (storage.type === 'secureStorage') return;

    await this.finalizeDatabaseInit();
  }

  /** Run migrations and create Drizzle instance. Called after init or after secure storage unlock. */
  private async finalizeDatabaseInit(): Promise<void> {
    await runMigrations(
      (sql, params) => this.execRaw(sql, params),
      fn => this.withTransaction(fn)
    );

    this.state.drizzleDb = this.createDrizzleInstance();
  }

  private async initSecureStorageWorker(
    storage: Extract<StorageConfig, { type: 'secureStorage' }>
  ): Promise<void> {
    this.state.worker = new Worker(
      new URL('./secure-storage-worker.ts', import.meta.url),
      { type: 'module' }
    );
    this.state.worker.onmessage = this.handleWorkerMessage;
    this.state.useWorker = true;

    try {
      const result = await this.postToWorker({
        type: 'init',
        dirPath: storage.path,
        domain: storage.domain,
        backend: storage.backend,
        wasmUrl: storage.wasmUrl,
        initSql: PRAGMAS_SECURE_STORAGE,
      });

      if (result.needsUnlock) {
        this.state.needsUnlock = true;
        console.log(
          '[DatabaseConnection] secure storage needs unlock — deferring SQLite'
        );
      }
    } catch (err) {
      if (this.state.worker) {
        this.state.worker.terminate();
        this.state.worker = null;
      }
      this.state.useWorker = false;
      this.state.pending.clear();
      throw err;
    }
  }

  private async initSecureStorageNodeFs(
    storage: Extract<StorageConfig, { type: 'secureStorage' }>
  ): Promise<void> {
    const { readFileSync } = await import('node:fs');
    const { dirname, resolve } = await import('node:path');
    const { createRequire } = await import('node:module');

    // Load wa-sqlite WASM binary
    const require = createRequire(import.meta.url);
    const wasmDir = dirname(require.resolve('wa-sqlite/package.json'));
    const wasmBinary = readFileSync(resolve(wasmDir, 'dist/wa-sqlite.wasm'));
    const module = await SQLiteESMFactory({
      wasmBinary: wasmBinary.buffer.slice(
        wasmBinary.byteOffset,
        wasmBinary.byteOffset + wasmBinary.byteLength
      ),
    });
    this.state.sqlite3 = SQLite.Factory(module);

    // Load secure storage WASM + register node:fs callbacks
    const { initSecureStorageNodeFs: initBcNodeFs } =
      await import('./secure-storage-node-fs.js');
    const bcWasm = await initBcNodeFs(storage.path, storage.domain);

    // Register VFS
    const { SecureStorageVFS } = await import('./secure-storage-vfs.js');
    const bcVfs = new SecureStorageVFS(bcWasm);
    this.state.sqlite3.vfs_register(bcVfs as unknown as SQLiteVFS, true);
    this.state.dbHandle = await this.state.sqlite3.open_v2('gossip.db');
    this.state.useWorker = false;
    this.state.secureStorageWasm = bcWasm;
    this.state.secureStorageVfs = bcVfs;

    await this.state.sqlite3.exec(this.state.dbHandle, PRAGMAS_SECURE_STORAGE);
  }

  // ─── Public methods ────────────────────────────────────────────

  async getLastInsertRowId(): Promise<number> {
    if (this.state.useWorker) {
      return this.state.lastInsertRowIdCache;
    }
    const rows = await this.execRaw('SELECT last_insert_rowid()');
    return (rows[0] as number[])[0];
  }

  async withTransaction<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.state.dbLock;
    let release!: () => void;
    this.state.dbLock = new Promise<void>(r => (release = r));
    await prev;

    try {
      await this.execRawDirect('BEGIN');
      this.state.inTransaction = true;
      try {
        const result = await fn();
        await this.execRawDirect('COMMIT');
        return result;
      } catch (e) {
        await this.execRawDirect('ROLLBACK');
        throw e;
      } finally {
        this.state.inTransaction = false;
      }
    } finally {
      release();
    }
  }

  async close(): Promise<void> {
    if (this.state.useWorker && this.state.worker) {
      await this.postToWorker({ type: 'close' });
      this.state.worker.terminate();
    } else if (this.state.dbHandle !== null && this.state.sqlite3) {
      await this.state.sqlite3.close(this.state.dbHandle);
    }
    this.state = createDefaultState();
  }

  async clearAllTables(): Promise<void> {
    await this.withTransaction(async () => {
      await this.db.delete(schema.messages);
      await this.db.delete(schema.discussions);
      await this.db.delete(schema.contacts);
      await this.db.delete(schema.userProfile);
      await this.db.delete(schema.pendingEncryptedMessages);
      await this.db.delete(schema.pendingAnnouncements);
      await this.db.delete(schema.activeSeekers);
      await this.db.delete(schema.announcementCursors);
    });
  }

  // ─── Secure storage operations ──────────────────────────────────

  private requireSecureStorage(): SecureStorageWasmModule {
    if (this.state.secureStorageWasm) return this.state.secureStorageWasm;
    throw new Error('Not a secure storage connection');
  }

  async secureStorageProvision(): Promise<void> {
    if (this.state.useWorker) {
      await this.postToWorker({ type: 'provision' });
    } else {
      this.requireSecureStorage().provisionStorage();
    }
  }

  async secureStorageAllocate(
    slot: number,
    password: string,
    forceInit = false
  ): Promise<void> {
    if (this.state.useWorker) {
      const pw = new TextEncoder().encode(password);
      await this.postToWorker({ type: 'allocate', slot, password: pw }, [
        pw.buffer,
      ]);
      // Worker closes and reopens SQLite on every allocate. A second allocate used to
      // skip finalizeDatabaseInit when drizzleDb already existed, leaving a fresh empty
      // file without schema → "no such table". Migrations are idempotent (see migrate.ts).
      await runMigrations(
        (sql, params) => this.execRaw(sql, params),
        fn => this.withTransaction(fn)
      );
      await this.flush();
      if (!this.state.drizzleDb || forceInit) {
        this.state.drizzleDb = this.createDrizzleInstance();
      }
    } else {
      this.requireSecureStorage().allocateSession(
        slot,
        new TextEncoder().encode(password)
      );
    }
    this.state.needsUnlock = false;
  }

  async secureStorageUnlock(password: string): Promise<boolean> {
    if (this.state.useWorker) {
      const pw = new TextEncoder().encode(password);
      const result = await this.postToWorker({ type: 'unlock', password: pw }, [
        pw.buffer,
      ]);
      if (result.unlocked) {
        // Same as allocate: worker reopened SQLite — ensure schema is present.
        await runMigrations(
          (sql, params) => this.execRaw(sql, params),
          fn => this.withTransaction(fn)
        );
        await this.flush();
        if (!this.state.drizzleDb) {
          this.state.drizzleDb = this.createDrizzleInstance();
        }
        this.state.needsUnlock = false;
      }
      return result.unlocked;
    }
    return this.requireSecureStorage().unlockSession(
      new TextEncoder().encode(password)
    );
  }

  /** Force-flush deferred VFS writes + storage persistence. */
  async flush(): Promise<void> {
    if (this.state.useWorker) {
      await this.postToWorker({ type: 'flush' });
    }
    // In-process path flushes synchronously in execRawInProcess
  }

  async secureStorageLock(): Promise<void> {
    if (this.state.useWorker) {
      await this.postToWorker({ type: 'lock' });
    } else {
      this.requireSecureStorage().lockSession();
    }
    // Session is locked — next loadAccount must unlock before querying
    this.state.needsUnlock = true;
  }

  async secureStorageCoverTick(): Promise<void> {
    if (this.state.useWorker) {
      await this.postToWorker({ type: 'cover' });
    } else {
      this.requireSecureStorage().coverTrafficTick();
    }
  }

  async clearConversationTables(): Promise<void> {
    await this.withTransaction(async () => {
      await this.db.delete(schema.messages);
      await this.db.delete(schema.discussions);
      await this.db.delete(schema.contacts);
    });
  }
}
