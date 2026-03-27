/**
 * SQLite initialization module for the Gossip SDK.
 *
 * Uses wa-sqlite (WASM) with Drizzle ORM's sqlite-proxy driver.
 * Four execution paths:
 *   - Browser/OPFS (opfsPath set): Web Worker + AccessHandlePoolVFS — fast, single-tab.
 *   - Browser/IDB (idbName set): Web Worker + IDBBatchAtomicVFS — multi-tab safe.
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
import type { SecureStorageNativePlugin } from './secure-storage-native.js';

// Lazy-loaded Capacitor references. These are only resolved when
// `secureStorage` is used on a native platform, so Node.js tests
// (which use `type: 'memory'`) never trigger the import.
let _nativePlugin: SecureStorageNativePlugin | null = null;

/** Load the native plugin module (async, first call only). */
async function ensureNativePlugin(): Promise<void> {
  if (!_nativePlugin) {
    const { SecureStorageNative } = await import('./secure-storage-native.js');
    _nativePlugin = SecureStorageNative;
  }
}

/**
 * Get the native plugin (sync). Must call ensureNativePlugin() first.
 *
 * IMPORTANT: Never `await` this return value directly — Capacitor plugin
 * proxies intercept `.then()` which triggers a native method call error.
 */
function getNativePlugin(): SecureStorageNativePlugin {
  return _nativePlugin!;
}

async function isNativePlatform(): Promise<boolean> {
  try {
    const { Capacitor } = await import('@capacitor/core');
    return Capacitor.isNativePlatform();
  } catch {
    return false;
  }
}

export type GossipDatabase = SqliteRemoteDatabase<typeof schema>;

/** Selects the SQLite storage backend. */
export type StorageConfig =
  | { type: 'opfs'; path: string; wasmUrl?: string }
  | { type: 'idb'; name: string; wasmUrl?: string }
  | { type: 'node-fs'; path: string }
  | { type: 'memory'; wasmBinary?: ArrayBuffer }
  | {
      type: 'secureStorage';
      domain: string;
      /** Encrypted storage backend. Omit to auto-detect (prefers opfs-wal). */
      backend?: 'idb' | 'opfs' | 'opfs-wal';
      wasmUrl?: string;
    };

export interface InitDbOptions {
  /** Storage backend selection. Defaults to in-memory. */
  storage?: StorageConfig;
}

// ---------------------------------------------------------------------------
// Internal state shape
// ---------------------------------------------------------------------------

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
  useNativePlugin: boolean;
  isSecureStorage: boolean;
  needsUnlock: boolean;
  drizzleDb: GossipDatabase | null;
  dbLock: Promise<unknown>;
  inTransaction: boolean;
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
    useNativePlugin: false,
    isSecureStorage: false,
    needsUnlock: false,
    drizzleDb: null,
    dbLock: Promise.resolve(),
    inTransaction: false,
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

  get isSecureStorage(): boolean {
    return this.state.isSecureStorage;
  }

  get needsUnlock(): boolean {
    return this.state.needsUnlock;
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
    if (this.state.useNativePlugin) {
      const plugin = getNativePlugin();
      // Convert Uint8Array params to plain number[] for Capacitor bridge.
      // Capacitor serializes Uint8Array as {"0":119,"1":211,...} (JSON object)
      // instead of a proper array, which breaks blob storage.
      const safeParams = params.map(p =>
        p instanceof Uint8Array ? Array.from(p) : p
      );
      const t0 = performance.now();
      const result = await plugin.execSql({ sql, params: safeParams });
      const dt = (performance.now() - t0) | 0;
      if (dt > 50) {
        console.log(`[NativePerf] execSql(${dt}ms): ${sql.slice(0, 60)}...`);
      }
      this.state.lastInsertRowIdCache = result.lastInsertRowId;
      return result.rows;
    }
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

      case 'secureStorage': {
        if (await isNativePlatform()) {
          // Native (iOS/Android): use Capacitor plugin → compiled Rust.
          // No worker needed — calls bridge directly to native code.
          await ensureNativePlugin();
          const plugin = getNativePlugin();
          const tInit = performance.now();
          await plugin.initSecureStorage({
            path: 'secure-storage',
            domain: storage.domain,
          });
          console.log(
            `[NativePerf] initSecureStorage: ${(performance.now() - tInit) | 0}ms`
          );
          this.state.useNativePlugin = true;

          const { unlocked } = await plugin.isUnlocked();
          if (unlocked) {
            this.state.needsUnlock = false;
          } else {
            // Idempotent: provisions if fresh, no-op if keypairs exist.
            const tProv = performance.now();
            const { fresh } = await plugin.provisionStorage();
            console.log(
              `[NativePerf] provisionStorage: ${(performance.now() - tProv) | 0}ms, fresh=${fresh}`
            );

            this.state.needsUnlock = !fresh;
          }
        } else {
          // Web: use WASM worker (existing path).
          this.state.worker = new Worker(
            new URL('./secure-storage-worker.ts', import.meta.url),
            { type: 'module' }
          );
          this.state.worker.onmessage = this.handleWorkerMessage;
          this.state.useWorker = true;

          try {
            const initResult = await this.postToWorker({
              type: 'init',
              domain: storage.domain,
              backend: storage.backend,
              wasmUrl: storage.wasmUrl,
            });
            if (initResult?.needsUnlock) {
              this.state.needsUnlock = true;
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
        this.state.isSecureStorage = true;
        // Don't run migrations or create drizzle yet — need unlock first.
        return;
      }
    }

    await runMigrations(
      (sql, params) => this.execRaw(sql, params),
      fn => this.withTransaction(fn)
    );

    this.state.drizzleDb = this.createDrizzleInstance();
  }

  // ─── Public methods ────────────────────────────────────────────

  async getLastInsertRowId(): Promise<number> {
    if (this.state.useNativePlugin || this.state.useWorker) {
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
    if (this.state.useNativePlugin) {
      const plugin = getNativePlugin();
      await plugin.close();
    } else if (this.state.useWorker && this.state.worker) {
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

  // ─── Secure storage lifecycle ──────────────────────────────────

  /** Provision all 5 session slots (secure storage only). */
  async secureStorageProvision(): Promise<void> {
    if (this.state.useNativePlugin) {
      const plugin = getNativePlugin();
      await plugin.provisionStorage();
      return;
    }
    await this.postToWorker({ type: 'provision' });
  }

  /** Allocate a session in `slot`, auto-unlock, open DB, run migrations. */
  async secureStorageAllocate(
    slot: number,
    password: string,
    _forceInit = false
  ): Promise<void> {
    const pwBytes = new TextEncoder().encode(password);
    if (this.state.useNativePlugin) {
      const plugin = getNativePlugin();
      const t0 = performance.now();
      await plugin.allocateSession({
        slot,
        password: Array.from(pwBytes),
      });
      console.log(
        `[NativePerf] allocateSession: ${(performance.now() - t0) | 0}ms`
      );
    } else {
      await this.postToWorker({
        type: 'allocate',
        slot,
        password: Array.from(pwBytes),
      });
    }
    pwBytes.fill(0);
    this.state.needsUnlock = false;
    await this.finalize();
  }

  /** Unlock a session by password, open DB, run migrations. Returns false if wrong password. */
  async secureStorageUnlock(password: string): Promise<boolean> {
    const pwBytes = new TextEncoder().encode(password);
    let ok: boolean;
    if (this.state.useNativePlugin) {
      const plugin = getNativePlugin();
      const t0 = performance.now();
      const result = await plugin.unlockSession({
        password: Array.from(pwBytes),
      });
      console.log(
        `[NativePerf] unlockSession: ${(performance.now() - t0) | 0}ms, unlocked=${result.unlocked}`
      );
      ok = result.unlocked;
    } else {
      const result = await this.postToWorker({
        type: 'unlock',
        password: Array.from(pwBytes),
      });
      ok = result.ok;
    }
    pwBytes.fill(0);
    if (!ok) return false;
    this.state.needsUnlock = false;
    await this.finalize();
    return true;
  }

  /** Lock the session: flush, close DB, zeroize keys. */
  async secureStorageLock(): Promise<void> {
    if (this.state.useNativePlugin) {
      const plugin = getNativePlugin();
      await plugin.lockSession();
    } else {
      await this.postToWorker({ type: 'lock' });
    }
    this.state.drizzleDb = null;
    this.state.needsUnlock = true;
  }

  /** Run one round of cover traffic (secure storage only). */
  async secureStorageCoverTick(): Promise<void> {
    if (this.state.useNativePlugin) {
      const plugin = getNativePlugin();
      await plugin.coverTrafficTick();
      return;
    }
    await this.postToWorker({ type: 'cover' });
  }

  /** Explicit flush to backing store (secure storage only). */
  async secureStorageFlush(): Promise<void> {
    if (this.state.useNativePlugin) {
      const plugin = getNativePlugin();
      await plugin.flush();
      return;
    }
    await this.postToWorker({ type: 'flush' });
  }

  /** Run migrations and create the Drizzle instance (called after allocate/unlock). */
  private async finalize(): Promise<void> {
    await runMigrations(
      (sql, params) => this.execRaw(sql, params),
      fn => this.withTransaction(fn)
    );
    this.state.drizzleDb = this.createDrizzleInstance();
  }

  async clearConversationTables(): Promise<void> {
    await this.withTransaction(async () => {
      await this.db.delete(schema.messages);
      await this.db.delete(schema.discussions);
      await this.db.delete(schema.contacts);
    });
  }
}
