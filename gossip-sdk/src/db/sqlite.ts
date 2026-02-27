/**
 * SQLite initialization module for the Gossip SDK.
 *
 * Uses wa-sqlite (WASM) with Drizzle ORM's sqlite-proxy driver.
 * Five execution paths:
 *   - Browser/OPFS (opfsPath set): Web Worker + AccessHandlePoolVFS — fast, single-tab.
 *   - Browser/IDB (idbName set): Web Worker + IDBBatchAtomicVFS — multi-tab safe.
 *   - Browser/Bordercrypt: Web Worker + BordecryptVFS — encrypted OPFS storage.
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
      type: 'bordercrypt';
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
type BordercryptWasmModule = any;

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
  bordercryptWasm: BordercryptWasmModule | null;
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
    bordercryptWasm: null,
  };
}

/** PRAGMAs applied before migrations (in-memory / browser worker). */
const PRAGMAS = `
  PRAGMA journal_mode=MEMORY;
  PRAGMA temp_store=MEMORY;
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

  // ─── Raw SQL execution ─────────────────────────────────────────

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private postToWorker(msg: Record<string, unknown>): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = ++this.state.msgId;
      this.state.pending.set(id, { resolve, reject });
      this.state.worker!.postMessage({ ...msg, id });
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
    return execStatements(this.state.sqlite3, this.state.dbHandle, sql, params);
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

      case 'bordercrypt': {
        if (storage.backend === 'node-fs') {
          await this.initBordercryptNodeFs(storage);
        } else {
          await this.initBordercryptWorker(storage);
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

    await runMigrations(
      (sql, params) => this.execRaw(sql, params),
      fn => this.withTransaction(fn)
    );

    this.state.drizzleDb = this.createDrizzleInstance();
  }

  private async initBordercryptWorker(
    storage: Extract<StorageConfig, { type: 'bordercrypt' }>
  ): Promise<void> {
    this.state.worker = new Worker(
      new URL('./bordercrypt-worker.ts', import.meta.url),
      { type: 'module' }
    );
    this.state.worker.onmessage = this.handleWorkerMessage;
    this.state.useWorker = true;

    try {
      await this.postToWorker({
        type: 'init',
        dirPath: storage.path,
        domain: storage.domain,
        backend: storage.backend,
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
  }

  private async initBordercryptNodeFs(
    storage: Extract<StorageConfig, { type: 'bordercrypt' }>
  ): Promise<void> {
    const { readFileSync } = await import('node:fs');
    const { dirname, resolve } = await import('node:path');
    const { createRequire } = await import('node:module');

    // Load wa-sqlite WASM binary
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

    // Load bordercrypt WASM + register node:fs callbacks
    const { initBordercryptNodeFs: initBcNodeFs } = await import(
      './bordercrypt-node-fs.js'
    );
    const bcWasm = await initBcNodeFs(storage.path, storage.domain);

    // Register VFS
    const { BordecryptVFS } = await import('./bordercrypt-vfs.js');
    this.state.sqlite3.vfs_register(
      new BordecryptVFS(bcWasm) as unknown as SQLiteVFS,
      true
    );
    this.state.dbHandle = await this.state.sqlite3.open_v2('gossip.db');
    this.state.useWorker = false;
    this.state.bordercryptWasm = bcWasm;

    await this.state.sqlite3.exec(this.state.dbHandle, PRAGMAS);
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

  // ─── Bordercrypt operations ──────────────────────────────────

  private requireBordercrypt(): BordercryptWasmModule {
    if (this.state.bordercryptWasm) return this.state.bordercryptWasm;
    throw new Error('Not a bordercrypt connection');
  }

  async bordercryptProvision(): Promise<void> {
    if (this.state.useWorker) {
      await this.postToWorker({ type: 'provision' });
    } else {
      this.requireBordercrypt().provisionStorage();
    }
  }

  async bordercryptAllocate(slot: number, password: string): Promise<void> {
    if (this.state.useWorker) {
      await this.postToWorker({ type: 'allocate', slot, password });
    } else {
      this.requireBordercrypt().allocateSession(
        slot,
        new TextEncoder().encode(password)
      );
    }
  }

  async bordercryptUnlock(password: string): Promise<boolean> {
    if (this.state.useWorker) {
      const result = await this.postToWorker({ type: 'unlock', password });
      return result.unlocked;
    }
    return this.requireBordercrypt().unlockSession(
      new TextEncoder().encode(password)
    );
  }

  async bordercryptLock(): Promise<void> {
    if (this.state.useWorker) {
      await this.postToWorker({ type: 'lock' });
    } else {
      this.requireBordercrypt().lockSession();
    }
  }

  async bordercryptCoverTick(): Promise<void> {
    if (this.state.useWorker) {
      await this.postToWorker({ type: 'cover' });
    } else {
      this.requireBordercrypt().coverTrafficTick();
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
