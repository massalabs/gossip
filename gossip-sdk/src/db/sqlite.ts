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
import { SESSION_COUNT } from './secure-storage-namespaces.js';
export {
  SQL_NAMESPACE,
  SESSION_BLOB_NAMESPACE,
  SESSION_COUNT,
} from './secure-storage-namespaces.js';

export type GossipDatabase = SqliteRemoteDatabase<typeof schema>;

/** Callback `tx` from `GossipDatabase.transaction()` — pass through query helpers for the same API as `db`. */
export type GossipSqliteTx = Parameters<
  Parameters<GossipDatabase['transaction']>[0]
>[0];

/**
 * Lifecycle of the secure-storage session, exposed as `Gossip.storageState`
 * and used by the SDK to gate queries / route the consumer to the right UX.
 *
 * - `'empty'`: decoy slots have been provisioned, but no real session exists.
 *   Next step: `secureStorageCreate(slot, password)` (signup flow).
 * - `'locked'`: a real session exists in storage but the encryption key is
 *   not in memory. Next step: `secureStorageUnlock(password)` (login flow).
 * - `'unlocked'`: session open, `queries`/`profiles` available.
 */
export type SecureStorageState = 'empty' | 'locked' | 'unlocked';

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
  /**
   * Lifecycle of the secure-storage session.
   * - 'empty': decoy slots provisioned, no real session yet (awaiting `secureStorageCreate`).
   * - 'locked': real session exists, encrypted, key not in memory (awaiting `secureStorageUnlock`).
   * - 'unlocked': session open in worker, queries available.
   * `null` when the connection isn't a secure-storage one.
   */
  storageState: SecureStorageState | null;
  drizzleDb: GossipDatabase | null;
  dbLock: Promise<unknown>;
  txScopeGuard: {
    run<T>(inTransaction: boolean, fn: () => Promise<T>): Promise<T>;
    getStore(): boolean;
  } | null;
  // Synchronous in-tx flag forwarded to `secureProxy.exec` so the
  // secure-storage worker can batch writes inside a tx. `txScopeGuard`
  // is Node-only (AsyncLocalStorage); this boolean covers the browser path.
  inTransaction: boolean;
  secureProxy: SecureStorageWorkerProxy | null;
  nativePlugin: SecureStorageNativePlugin | null;
  useNativePlugin: boolean;
}

interface TransactionContext {
  nextSavepointId: number;
  isActive: boolean;
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
    storageState: null,
    drizzleDb: null,
    dbLock: Promise.resolve(),
    txScopeGuard: null,
    inTransaction: false,
    secureProxy: null,
    nativePlugin: null,
    useNativePlugin: false,
  };
}

/**
 * Collect unique ArrayBuffers backing `Uint8Array` values inside a params
 * list so they can be transferred (not copied) across the Comlink worker
 * boundary. SharedArrayBuffer is excluded because it cannot be transferred.
 */
function collectTransferables(params: unknown[]): Transferable[] {
  const seen = new Set<ArrayBufferLike>();
  const out: Transferable[] = [];
  for (const p of params) {
    if (p instanceof Uint8Array) {
      const buf = p.buffer;
      if (
        typeof SharedArrayBuffer !== 'undefined' &&
        buf instanceof SharedArrayBuffer
      ) {
        continue;
      }
      if (!seen.has(buf)) {
        seen.add(buf);
        out.push(buf as ArrayBuffer);
      }
    }
  }
  return out;
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
  PRAGMA busy_timeout = 10000;
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

  get storageState(): SecureStorageState | null {
    return this.state.storageState;
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

  private createDrizzleInstance(
    isTx = false,
    txContext?: TransactionContext
  ): GossipDatabase {
    const drizzleDb = drizzle(
      async (sql, params, method) => {
        const rows = isTx
          ? await this.execRawDirect(sql, params)
          : await this.execRaw(sql, params);
        if (method === 'get') {
          return { rows: rows[0] };
        }
        return { rows };
      },
      { schema }
    );

    (
      drizzleDb as GossipDatabase & {
        transaction: <T>(fn: (tx: GossipSqliteTx) => Promise<T>) => Promise<T>;
      }
    ).transaction = async <T>(fn: (tx: GossipSqliteTx) => Promise<T>) => {
      if (txContext?.isActive) {
        return this.withSavepoint(txContext, fn);
      }
      return this.withTransaction(fn);
    };

    return drizzleDb;
  }

  private async execRaw(
    sql: string,
    params: unknown[] = []
  ): Promise<unknown[][]> {
    // Reject `undefined` bind params explicitly. JS coerces `undefined`
    // to SQL NULL by default, which silently masks programmer bugs:
    // `obj.usrname` (typo for `obj.username`) yields `undefined`, which
    // would write NULL instead of throwing. Drizzle ORM already
    // normalizes `undefined` -> `null` at its layer, so this guard only
    // fires for direct `execRaw` callers and forces them to pass `null`
    // explicitly when NULL is intentional.
    for (let i = 0; i < params.length; i++) {
      if (params[i] === undefined) {
        throw new Error(
          `execRaw: bind param at index ${i} is undefined; ` +
            `pass null explicitly if NULL is intended`
        );
      }
    }
    if (this.state.txScopeGuard?.getStore()) {
      throw new Error(
        'Detected root db query inside a transaction callback. Use the provided transaction (tx) instance instead of root db.'
      );
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
      // Transfer Uint8Array buffers across the Comlink boundary to avoid
      // a structured-clone copy of the whole params array on every call.
      // Mark `params` itself as the transfer carrier rather than the
      // whole `[sql, params, inTransaction]` tuple: that way the proxy
      // call below stays normally typed (no `as` cast over the tuple
      // shape, which would silently rot if `exec`'s signature changes).
      const transfers = collectTransferables(params);
      const execParams =
        transfers.length > 0 ? Comlink.transfer(params, transfers) : params;
      const result = await this.state.secureProxy.exec(
        sql,
        execParams,
        this.state.inTransaction
      );
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

    await this.initTxScopeGuard();

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
            // TODO: native plugin should expose `hasExistingData()` so we
            // can return 'empty' on a fresh install (currently conflated
            // with 'locked'). The web path distinguishes correctly.
            this.state.storageState = unlocked ? 'unlocked' : 'locked';
          } catch {
            // Plugin not implemented on this platform — unwind any partial
            // state and fall through to the web worker path below.
            this.state.nativePlugin = null;
            this.state.useNativePlugin = false;
            if (import.meta.env?.DEV) {
              console.warn(
                '[secureStorage] native plugin unavailable, falling back to WASM worker'
              );
            }
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
            this.state.storageState = result.hasExistingData
              ? 'locked'
              : 'empty';
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
      fn => {
        const txExecRaw = this.execRawDirect.bind(this);
        return this.withRawTransaction(() => fn(txExecRaw));
      }
    );

    this.state.drizzleDb = this.createDrizzleInstance();
  }

  // ─── Secure storage lifecycle ──────────────────────────────────

  /** Run migrations and create the Drizzle instance. */
  /**
   * Run migrations and instantiate the Drizzle handle. Must be called
   * AFTER the worker has opened its database. On the secure-storage
   * path that happens inside the worker's `create()` / `unlock()`
   * methods (they call `openDatabase()` before returning), so
   * `secureStorageCreate` / `secureStorageUnlock` can call `finalize()`
   * directly. A future refactor that delays `openDatabase()` outside
   * those methods must restore the precondition explicitly, otherwise
   * the first migration statement crashes the worker with an opaque
   * "database not open" error.
   */
  private async finalize(): Promise<void> {
    await runMigrations(
      (sql, params) => this.execRaw(sql, params),
      fn => {
        const txExecRaw = this.execRawDirect.bind(this);
        return this.withRawTransaction(() => fn(txExecRaw));
      }
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

  async secureStorageCreate(slot: number, password: string): Promise<void> {
    if (!Number.isInteger(slot) || slot < 0 || slot >= SESSION_COUNT) {
      throw new Error(
        `secureStorageCreate: slot must be an integer in [0, ${SESSION_COUNT - 1}], got ${slot}`
      );
    }
    if (password.length === 0) {
      throw new Error('secureStorageCreate: password cannot be empty');
    }
    // State-machine guard: reject create from 'unlocked'. Allowing it
    // would install a new session in the Rust core while the SQLite DB
    // is still open with the previous session's VFS state cached in
    // `app.files`, leading to mixed-state reads/writes after the next
    // `exec_sql`. Allowed from 'empty' (normal first-time flow) and
    // from 'locked' (wipe + recreate / dev silent reset). The Rust
    // core also defends against this via `close_database_and_clear_files`,
    // but rejecting at the API boundary surfaces a clearer error and
    // keeps the SDK contract honest.
    if (this.state.storageState === 'unlocked') {
      throw new Error(
        'secureStorageCreate: cannot create a new session while one is ' +
          'already unlocked. Call secureStorageLock() first.'
      );
    }
    const pwBytes = new TextEncoder().encode(password);
    try {
      if (this.state.useNativePlugin) {
        // Native plugin contract still uses `allocateSession` (matches
        // the Rust `allocate_session` name); only the SDK-facing verb
        // was renamed for clarity (create vs allocate).
        await this.requireNativePlugin().allocateSession({
          slot,
          password: Array.from(pwBytes),
        });
      } else {
        // Transfer the buffer so no intermediate copy lingers in the
        // MessagePort queue. After transfer, pwBytes is detached.
        await this.requireSecureProxy().create(
          slot,
          Comlink.transfer(pwBytes, [pwBytes.buffer])
        );
      }
    } finally {
      // Zero the plaintext password on every exit path, including when
      // the proxy throws before the buffer is marshalled. Detached
      // (post-transfer) buffers have byteLength 0 and fill() would
      // throw - the guard also covers the normal success case.
      if (pwBytes.byteLength > 0) {
        pwBytes.fill(0);
      }
    }
    this.state.storageState = 'unlocked';
    await this.finalize();
  }

  async secureStorageUnlock(password: string): Promise<boolean> {
    if (password.length === 0) {
      throw new Error('secureStorageUnlock: password cannot be empty');
    }
    // State-machine guard: unlock only makes sense from 'locked'.
    // 'empty' means no slot has been allocated yet (caller should
    // route to signup / `secureStorageCreate` instead). 'unlocked'
    // means the session is already open. Both throw with a clear
    // TS-side message instead of letting the WASM layer surface an
    // opaque "invalid parameter".
    if (this.state.storageState === 'empty') {
      throw new Error(
        'secureStorageUnlock: no session to unlock. ' +
          'Call secureStorageCreate(slot, password) first.'
      );
    }
    if (this.state.storageState === 'unlocked') {
      throw new Error(
        'secureStorageUnlock: secure storage is already unlocked.'
      );
    }
    const pwBytes = new TextEncoder().encode(password);
    let ok: boolean;
    try {
      if (this.state.useNativePlugin) {
        const result = await this.requireNativePlugin().unlockSession({
          password: Array.from(pwBytes),
        });
        ok = result.unlocked;
      } else {
        ok = await this.requireSecureProxy().unlock(
          Comlink.transfer(pwBytes, [pwBytes.buffer])
        );
      }
    } finally {
      // See secureStorageCreate above - zero on every exit path.
      if (pwBytes.byteLength > 0) {
        pwBytes.fill(0);
      }
    }
    if (!ok) return false;
    this.state.storageState = 'unlocked';
    await this.finalize();
    return true;
  }

  async secureStorageLock(): Promise<void> {
    // Flip user-visible state synchronously, before the worker await.
    // A concurrent `queries`/`profiles` access in the same event-loop
    // tick then sees `storageState === 'locked'` and throws the clean
    // locked-storage error, instead of racing past the now-stale check
    // and hitting an opaque "database not open" error from the worker
    // that is mid-lock.
    this.state.drizzleDb = null;
    this.state.storageState = 'locked';
    if (this.state.useNativePlugin) {
      await this.requireNativePlugin().lockSession();
    } else {
      await this.requireSecureProxy().lock();
    }
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
      throw new Error(
        'secureStorage namespace data API not implemented on native plugin'
      );
    }
    const proxy = this.requireSecureProxy();
    // Same pattern as `execRawDirect`: mark just the Uint8Array buffer
    // as transferable instead of the whole tuple, so the proxy call
    // stays normally typed.
    const transfers = collectTransferables([data]);
    const payload =
      transfers.length > 0 ? Comlink.transfer(data, transfers) : data;
    await proxy.writeNamespaceData(namespace, offset, payload);
  }

  /** Read `len` bytes from a namespace stream at `offset`. */
  async secureStorageReadNamespaceData(
    namespace: number,
    offset: number,
    len: number
  ): Promise<Uint8Array> {
    if (this.state.useNativePlugin) {
      throw new Error(
        'secureStorage namespace data API not implemented on native plugin'
      );
    }
    return this.requireSecureProxy().readNamespaceData(namespace, offset, len);
  }

  /** Total bytes currently stored in a namespace stream (0 if empty). */
  async secureStorageNamespaceDataLength(namespace: number): Promise<number> {
    if (this.state.useNativePlugin) {
      throw new Error(
        'secureStorage namespace data API not implemented on native plugin'
      );
    }
    return this.requireSecureProxy().namespaceDataLength(namespace);
  }

  /** Truncate a namespace stream to length 0. */
  async secureStorageClearNamespace(namespace: number): Promise<void> {
    if (this.state.useNativePlugin) {
      throw new Error(
        'secureStorage namespace data API not implemented on native plugin'
      );
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

  async withTransaction<T>(
    fn: (tx: GossipSqliteTx) => Promise<T>,
    behavior: 'deferred' | 'immediate' | 'exclusive' = 'immediate'
  ): Promise<T> {
    const txContext: TransactionContext = {
      nextSavepointId: 0,
      isActive: false,
    };
    const tx = this.createDrizzleInstance(
      true,
      txContext
    ) as unknown as GossipSqliteTx;
    return this.withRawTransaction(async () => {
      txContext.isActive = true;
      try {
        return await fn(tx);
      } finally {
        txContext.isActive = false;
      }
    }, behavior);
  }

  private async withRawTransaction<T>(
    fn: () => Promise<T>,
    behavior: 'deferred' | 'immediate' | 'exclusive' = 'immediate'
  ): Promise<T> {
    const prev = this.state.dbLock;
    let release!: () => void;
    this.state.dbLock = new Promise<void>(r => (release = r));
    await prev;

    try {
      await this.execRawDirect(`BEGIN ${behavior.toUpperCase()}`);
      this.state.inTransaction = true;
      try {
        const result = await this.runInTxScope(fn);
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

  private async withSavepoint<T>(
    txContext: TransactionContext,
    fn: (tx: GossipSqliteTx) => Promise<T>
  ): Promise<T> {
    const savepointName = `sp_${txContext.nextSavepointId++}`;
    const tx = this.createDrizzleInstance(
      true,
      txContext
    ) as unknown as GossipSqliteTx;

    await this.execRawDirect(`SAVEPOINT ${savepointName}`);
    try {
      const result = await fn(tx);
      await this.execRawDirect(`RELEASE SAVEPOINT ${savepointName}`);
      return result;
    } catch (e) {
      await this.execRawDirect(`ROLLBACK TO SAVEPOINT ${savepointName}`);
      await this.execRawDirect(`RELEASE SAVEPOINT ${savepointName}`);
      throw e;
    }
  }

  private async runInTxScope<T>(fn: () => Promise<T>): Promise<T> {
    const guard = this.state.txScopeGuard;
    if (!guard) {
      return fn();
    }
    return guard.run(true, fn);
  }

  private async initTxScopeGuard(): Promise<void> {
    // AsyncLocalStorage is Node-only. This guard is intentionally enabled only
    // in Node/test environments; browser/worker runtimes skip it gracefully.
    if (
      typeof process === 'undefined' ||
      typeof process.versions?.node !== 'string'
    ) {
      return;
    }

    try {
      const { AsyncLocalStorage } = await import('node:async_hooks');
      const guard = new AsyncLocalStorage<boolean>();
      this.state.txScopeGuard = {
        run: (inTransaction, fn) => guard.run(inTransaction, fn),
        getStore: () => guard.getStore() ?? false,
      };
    } catch {
      this.state.txScopeGuard = null;
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
    await this.withTransaction(async tx => {
      await tx.delete(schema.messages);
      await tx.delete(schema.discussions);
      await tx.delete(schema.contacts);
      await tx.delete(schema.userProfile);
      await tx.delete(schema.pendingEncryptedMessages);
      await tx.delete(schema.pendingAnnouncements);
      await tx.delete(schema.activeSeekers);
      await tx.delete(schema.announcementCursors);
    });
  }

  /** Delete only the data belonging to a specific account. */
  async clearAccountData(userId: string): Promise<void> {
    await this.withTransaction(async tx => {
      // Tables with ownerUserId
      await tx
        .delete(schema.messages)
        .where(eq(schema.messages.ownerUserId, userId));
      await tx
        .delete(schema.discussions)
        .where(eq(schema.discussions.ownerUserId, userId));
      await tx
        .delete(schema.contacts)
        .where(eq(schema.contacts.ownerUserId, userId));
      // Profile table keyed by userId
      await tx
        .delete(schema.userProfile)
        .where(eq(schema.userProfile.userId, userId));
      // Announcement cursor keyed by userId
      await tx
        .delete(schema.announcementCursors)
        .where(eq(schema.announcementCursors.userId, userId));
      // Session-specific tables (no user column — safe to clear for current session)
      await tx.delete(schema.pendingEncryptedMessages);
      await tx.delete(schema.pendingAnnouncements);
      await tx.delete(schema.activeSeekers);
    });
  }

  async clearConversationTables(): Promise<void> {
    await this.withTransaction(async tx => {
      await tx.delete(schema.messages);
      await tx.delete(schema.discussions);
      await tx.delete(schema.contacts);
    });
  }
}
