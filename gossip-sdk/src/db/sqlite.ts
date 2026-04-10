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
import * as Comlink from 'comlink';
import { eq } from 'drizzle-orm';
import { drizzle, type SqliteRemoteDatabase } from 'drizzle-orm/sqlite-proxy';
import * as schema from './schema/index.js';
import { runMigrations } from './migrate.js';
import { execStatements } from './exec-utils.js';
import type { SecureStorageWorkerProxy } from './secure-storage-worker.js';
import type { SecureStorageNativePlugin } from './secure-storage-native.js';
export {
  SQL_NAMESPACE,
  SESSION_BLOB_NAMESPACE,
} from './secure-storage-worker.js';

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
      /**
       * URL of the secureStorage crypto WASM (single binary that bundles
       * SQLite + post-quantum crypto + the encrypted VFS).
       */
      secureStorageWasmUrl?: string;
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
  isSecureStorage: boolean;
  needsUnlock: boolean;
  drizzleDb: GossipDatabase | null;
  dbLock: Promise<unknown>;
  inTransaction: boolean;
  /** Comlink proxy for the secure-storage worker (web). */
  secureProxy: SecureStorageWorkerProxy | null;
  /** Capacitor plugin for native secure storage (iOS/Android). */
  nativePlugin: SecureStorageNativePlugin | null;
  useNativePlugin: boolean;
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
    isSecureStorage: false,
    needsUnlock: false,
    drizzleDb: null,
    dbLock: Promise.resolve(),
    inTransaction: false,
    secureProxy: null,
    nativePlugin: null,
    useNativePlugin: false,
  };
}

async function isNativePlatform(): Promise<boolean> {
  try {
    const { Capacitor } = await import('@capacitor/core');
    return Capacitor.isNativePlatform();
  } catch {
    return false;
  }
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

  private postToWorker(
    msg: Record<string, unknown>,
    transfer: Transferable[] = []
  ) {
    return new Promise<{ rows: unknown[][]; lastInsertRowId: number }>(
      (resolve, reject) => {
        const id = ++this.state.msgId;
        this.state.pending.set(id, {
          resolve: resolve as (v: unknown) => void,
          reject,
        });
        this.state.worker!.postMessage({ ...msg, id }, transfer);
      }
    );
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
    if (this.state.useNativePlugin && this.state.nativePlugin) {
      const safeParams = params.map(p =>
        p instanceof Uint8Array ? Array.from(p) : p
      );
      const result = await this.state.nativePlugin.execSql({
        sql,
        params: safeParams,
      });
      this.state.lastInsertRowIdCache = result.lastInsertRowId;
      return result.rows;
    }
    if (this.state.secureProxy) {
      const result = await this.state.secureProxy.exec(sql, params);
      this.state.lastInsertRowIdCache = result.lastInsertRowId;
      return result.rows as unknown[][];
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
          // Pre-fetch WASM in the main thread to avoid Safari's
          // chunked Transfer-Encoding bug in Worker fetch().
          let wasmBinary: ArrayBuffer | undefined;
          if (storage.wasmUrl) {
            const resp = await fetch(storage.wasmUrl);
            wasmBinary = await resp.arrayBuffer();
          }

          await this.postToWorker(
            { type: 'init', dbPath, useOPFS, wasmBinary, initSql: PRAGMAS },
            wasmBinary ? [wasmBinary] : []
          );
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
        this.state.isSecureStorage = true;

        if (await isNativePlatform()) {
          // ── Native path (iOS/Android) ──
          // Use the Capacitor plugin which calls Rust directly via UniFFI.
          // Falls back to the web worker path if the plugin isn't available
          // (e.g. Android before the native lib is cross-compiled).
          try {
            const { SecureStorageNative } =
              await import('./secure-storage-native.js');
            await SecureStorageNative.initSecureStorage({
              path: 'secure-storage',
              domain: storage.domain,
            });
            this.state.nativePlugin = SecureStorageNative;
            this.state.useNativePlugin = true;
            await SecureStorageNative.provisionStorage();
            const { unlocked } = await SecureStorageNative.isUnlocked();
            this.state.needsUnlock = !unlocked;
          } catch {
            // Plugin not implemented on this platform — fall through to
            // the web worker path below.
            console.warn(
              '[secureStorage] native plugin unavailable, falling back to WASM worker'
            );
          }
        }

        if (!this.state.useNativePlugin) {
          // ── Web path ──
          // Use the WASM worker via Comlink.
          this.state.worker = new Worker(
            new URL('./secure-storage-worker.ts', import.meta.url),
            { type: 'module' }
          );
          this.state.secureProxy = Comlink.wrap<SecureStorageWorkerProxy>(
            this.state.worker
          ) as unknown as SecureStorageWorkerProxy;

          try {
            const result = await this.state.secureProxy.init(
              storage.domain,
              storage.secureStorageWasmUrl
            );
            this.state.needsUnlock = result.needsUnlock;
          } catch (err) {
            this.state.secureProxy[Comlink.releaseProxy]();
            this.state.worker.terminate();
            this.state.worker = null;
            this.state.secureProxy = null;
            this.state.isSecureStorage = false;
            throw err;
          }
        }
        // Migrations and Drizzle are deferred until the session is unlocked.
        return;
      }
    }

    await runMigrations(
      (sql, params) => this.execRaw(sql, params),
      fn => this.withTransaction(fn)
    );

    this.state.drizzleDb = this.createDrizzleInstance();
  }

  // ─── Secure storage lifecycle ──────────────────────────────────

  /** Run migrations and create the Drizzle instance. */
  private async finalize(): Promise<void> {
    await runMigrations(
      (sql, params) => this.execRaw(sql, params),
      fn => this.withTransaction(fn)
    );
    this.state.drizzleDb = this.createDrizzleInstance();
  }

  private requireSecureProxy(): SecureStorageWorkerProxy {
    if (!this.state.secureProxy) {
      throw new Error('secure storage not initialized');
    }
    return this.state.secureProxy;
  }

  private requireNativePlugin(): SecureStorageNativePlugin {
    if (!this.state.nativePlugin) {
      throw new Error('secure storage native plugin not initialized');
    }
    return this.state.nativePlugin;
  }

  async secureStorageProvision(): Promise<void> {
    if (this.state.useNativePlugin) {
      await this.requireNativePlugin().provisionStorage();
    } else {
      await this.requireSecureProxy().provision();
    }
  }

  async secureStorageAllocate(slot: number, password: string): Promise<void> {
    const pwBytes = new TextEncoder().encode(password);
    if (this.state.useNativePlugin) {
      await this.requireNativePlugin().allocateSession({
        slot,
        password: Array.from(pwBytes),
      });
    } else {
      await this.requireSecureProxy().allocate(slot, pwBytes);
    }
    pwBytes.fill(0);
    this.state.needsUnlock = false;
    await this.finalize();
  }

  async secureStorageUnlock(password: string): Promise<boolean> {
    const pwBytes = new TextEncoder().encode(password);
    let ok: boolean;
    if (this.state.useNativePlugin) {
      const result = await this.requireNativePlugin().unlockSession({
        password: Array.from(pwBytes),
      });
      ok = result.unlocked;
    } else {
      ok = await this.requireSecureProxy().unlock(pwBytes);
    }
    pwBytes.fill(0);
    if (!ok) return false;
    this.state.needsUnlock = false;
    await this.finalize();
    return true;
  }

  async secureStorageLock(): Promise<void> {
    if (this.state.useNativePlugin) {
      await this.requireNativePlugin().lockSession();
    } else {
      await this.requireSecureProxy().lock();
    }
    this.state.drizzleDb = null;
    this.state.needsUnlock = true;
  }

  async secureStorageCoverTick(namespace?: number): Promise<void> {
    if (this.state.useNativePlugin) {
      await this.requireNativePlugin().coverTrafficTick();
    } else {
      await this.requireSecureProxy().cover(namespace);
    }
  }

  async secureStorageFlush(): Promise<void> {
    if (this.state.useNativePlugin) {
      await this.requireNativePlugin().flush();
    } else {
      await this.requireSecureProxy().flush();
    }
  }

  // ── Generic namespace data API ─────────────────────────────────

  /**
   * Write a blob to a secure-storage namespace stream. Each namespace is
   * an independent block stream cryptographically isolated from the SQLite
   * VFS data — see the Rust crate's `BlockStorage` trait for details.
   *
   * Throws if not on the secure-storage backend.
   */
  async secureStorageWriteNamespaceData(
    namespace: number,
    offset: number,
    data: Uint8Array
  ): Promise<void> {
    if (this.state.useNativePlugin) {
      // TODO: wire native namespace data when plugin exposes it
      return;
    }
    await this.requireSecureProxy().writeNamespaceData(namespace, offset, data);
  }

  /** Read `len` bytes from a namespace stream at `offset`. */
  async secureStorageReadNamespaceData(
    namespace: number,
    offset: number,
    len: number
  ): Promise<Uint8Array> {
    if (this.state.useNativePlugin) {
      // TODO: wire native namespace data when plugin exposes it
      return new Uint8Array(0);
    }
    return this.requireSecureProxy().readNamespaceData(namespace, offset, len);
  }

  /** Total bytes currently stored in a namespace stream (0 if empty). */
  async secureStorageNamespaceDataLength(namespace: number): Promise<number> {
    if (this.state.useNativePlugin) {
      return 0;
    }
    return this.requireSecureProxy().namespaceDataLength(namespace);
  }

  /** Truncate a namespace stream to length 0. */
  async secureStorageClearNamespace(namespace: number): Promise<void> {
    if (this.state.useNativePlugin) {
      return;
    }
    await this.requireSecureProxy().clearNamespace(namespace);
  }

  // ─── Public methods ────────────────────────────────────────────

  async getLastInsertRowId(): Promise<number> {
    if (
      this.state.useWorker ||
      this.state.secureProxy ||
      this.state.useNativePlugin
    ) {
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
    if (this.state.useNativePlugin && this.state.nativePlugin) {
      await this.state.nativePlugin.close();
    } else if (this.state.secureProxy && this.state.worker) {
      await this.state.secureProxy.close();
      this.state.secureProxy[Comlink.releaseProxy]();
      this.state.worker.terminate();
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

  /** Delete only the data belonging to a specific account. */
  async clearAccountData(userId: string): Promise<void> {
    await this.withTransaction(async () => {
      // Tables with ownerUserId
      await this.db
        .delete(schema.messages)
        .where(eq(schema.messages.ownerUserId, userId));
      await this.db
        .delete(schema.discussions)
        .where(eq(schema.discussions.ownerUserId, userId));
      await this.db
        .delete(schema.contacts)
        .where(eq(schema.contacts.ownerUserId, userId));
      // Profile table keyed by userId
      await this.db
        .delete(schema.userProfile)
        .where(eq(schema.userProfile.userId, userId));
      // Announcement cursor keyed by userId
      await this.db
        .delete(schema.announcementCursors)
        .where(eq(schema.announcementCursors.userId, userId));
      // Session-specific tables (no user column — safe to clear for current session)
      await this.db.delete(schema.pendingEncryptedMessages);
      await this.db.delete(schema.pendingAnnouncements);
      await this.db.delete(schema.activeSeekers);
    });
  }

  async clearConversationTables(): Promise<void> {
    await this.withTransaction(async () => {
      await this.db.delete(schema.messages);
      await this.db.delete(schema.discussions);
      await this.db.delete(schema.contacts);
    });
  }
}
